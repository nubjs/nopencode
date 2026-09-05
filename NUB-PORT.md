# NopenCode: opencode built with `nub compile`

NopenCode is a port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

Builds and runs on **darwin-arm64**, **darwin-x64**, **linux-x64**, **linux-arm64**, **linux-arm64-musl** and **win32-x64**, with the TUI rendering on every one. That is the embed shape; `--smol` is verified with its TUI on darwin-x64 and linux-arm64, and the other four are untried in that shape rather than known good.

Verified from a foreign working directory, with the runtime cache cleared and a fresh `HOME`, and separately with this source tree moved away entirely:

| | |
| --- | --- |
| `--version`, `--help`, `models`, `agent list`, `providers list`, four `--help` surfaces | **byte-identical to the Bun build**, 9/9 |
| TUI | renders on both platforms, and responds to input — `esc` dismisses dialogs, typed text echoes, `ctrl+p` opens the command palette |
| Backend | `serve` listens, `/doc` and `/session` return 200, a POSTed session persists and reads back stamped `"version":"0.0.0-nub"` |
| linux-x64 | cross-compiled from macOS, run in `debian:bookworm-slim` with **no Node on the machine** — needs `libatomic1`, see below |
| linux-arm64 | cross-compiled from macOS, run in `debian:bookworm-slim` at native speed under Docker on the arm64 host, again with no Node on the machine — needs `libatomic1` too |
| darwin-x64 | cross-compiled from arm64 macOS, run under Rosetta — commands correct straight away, TUI correct once the binary used its own Node rather than the host's (see below) |
| linux-arm64-musl | cross-compiled from macOS, run in `alpine:3.20` under Docker at native arm64 speed with no Node — needs `libgcc` rather than `libatomic1` |
| win32-x64 | cross-compiled from macOS, run on native AMD64 Windows Server 2022 — every command matches, TUI renders. ~4 s warm startup there, see below |
| `--smol` | 21.6 MB, provisions its own Node on a machine that has none: 14 s first run, 2 s after. Needs `curl` or `wget` on the box — a slim image has neither, and nub says so rather than failing obscurely |
| A model response | **not verified.** No usable credential on the test machine: the same prompt fails identically on this binary, the Bun build, and a stock installed opencode (`Token refresh failed: 401`). |

The TUI row above has not been reproducible on the development machine since 2026-09-04. A binary built there that day starts, loads its config, and then exits with `Error: Unexpected error / An error occurred in Effect.tryPromise` before drawing a frame — from a clean working directory, under a fresh `HOME`, with `OPENCODE_PURE=1`, and with network reachable. It reproduces on a binary compiled from this branch's base commit, so it is not something the test migration introduced, and it reproduces with both the released `nub` and one built from `main`, so it is not a single `nub` build either. `--version`, `models` and `serve` are all correct on the same binary — `serve` bootstraps the same instance the TUI does and reaches `opencode server listening`. Pointing `OPENCODE_DB` at a fresh file does not change it either. With `--print-logs --log-level DEBUG` the log ends at the formatter service's `init` and then `disposing instance`, with no error line of its own. Unresolved; the cause is not yet known.

### Measured against the Bun build

darwin-arm64, hyperfine, 12 warm runs and 3 cold with the cache wiped between. Host was moderately loaded (~8 on 10 cores), so treat the absolutes as indicative and the ratios as the result.

| | startup, warm | startup, cold | on disk | `gzip -9` |
| --- | --- | --- | --- | --- |
| Bun | **363 ms** | **392 ms** | 101.6 MB | **33.6 MB** |
| nub, embed | 772 ms | 4.90 s | 45.3 MB | 44.4 MB |
| nub, `--smol` | 822 ms | 3.20 s | **18.3 MB** | **17.4 MB** |

**Bun is about 2.1x faster to start, and smaller to ship.** Its binary *is* the runtime; nub's launcher spawns Node as a child, paying two process starts plus Node's own init, and on a first run also pays extraction.

The on-disk column is the misleading one and should never be quoted alone: nub's binary barely compresses because the embedded Node is already zstd-19, while Bun's compresses 3x because it is stored uncompressed. What you actually ship is the compressed size, and there Bun wins — 33.6 MB against 44.4 MB. `--smol` is the only shape that beats it, at 17.4 MB, because it carries no runtime at all.

### musl needs `OPENTUI_LIBC` set explicitly

Only musl surfaced this, and it failed hard rather than subtly: the TUI died with `Missing OpenTUI asset "@opentui/core-linux-arm64/libopentui.so"` — the **glibc** package's key — on a musl binary that had the musl library staged beside it.

OpenTUI does no run-time musl detection. It reads `OPENTUI_LIBC` from the environment and otherwise assumes glibc, so a musl build asks for the wrong package name and cannot find the library it shipped with. `src/nub/otui-asset-root.ts` now sets it from `OPENCODE_LIBC`, which the build already defines from the target triple. The glibc builds are untouched — the assignment is guarded on `OPENCODE_LIBC === "musl"` — and were re-run afterwards to confirm it.

musl also needs a different system library than glibc does: `libgcc` (`apk add libgcc`) rather than `libatomic1`. nub's diagnostic names the right one for the distro in both cases.

### Windows

Cross-compiled from an arm64 Mac and verified on native AMD64 Windows Server 2022: `--version`, `--help` (56 lines, identical to the other two platforms), `models`, `agent list`, `providers list` all correct, and the TUI renders. The cache lands at `%USERPROFILE%\.cache\nub`.

Two caveats worth carrying:

- **Startup is ~3 s warm** there against 772 ms on macOS. Root-caused below — it is neither Defender nor disk.
- **The launcher was linked with `x86_64-pc-windows-gnu`**, because that is what `cargo-zigbuild` can produce from macOS. The release pipeline uses `x86_64-pc-windows-msvc`. It worked, but a gnu-linked launcher is a different CRT and should not be assumed equivalent for shipping.

The Ctrl-C console guard in `terminal-win32.ts` now goes through `node:ffi`. Its kernel32 calls were exercised on a clean Windows Server 2022 box from a `nub compile` binary cross-built on macOS: `dlopen("kernel32.dll")`, `GetConsoleMode` on the console input handle (`0x1f7`), `SetConsoleMode` clearing `ENABLE_PROCESSED_INPUT` (`0x1f6`), restore, and `FlushConsoleInputBuffer` all returned success. The guard inside the TUI itself was not driven interactively there — an SSH session has no TTY stdin, so the guard's own early return takes over. Two things that box also showed: the v0.8.3 launcher imports `VCRUNTIME140.dll` and dies with `STATUS_DLL_NOT_FOUND` on a machine without the VC++ redistributable (nub `main` already links the CRT statically), and a launcher older than the `nub` that compiled the payload refuses it (`compiled payload format version 3 is unsupported`).

## Suggestion: `--target 26` means a different Node in each shape

The bare major resolves to **26.6.0** when the Node is embedded and **26.0.0** under `--smol`. Same flag, same command line, two runtimes six patch releases apart.

That is enough to break an app silently. On 26.0.0 this TUI cannot bring up OpenTUI's native backend and dies with `OpenTUI native FFI is not available for this runtime yet`; on 26.6.0 it renders. Nothing in the build output suggests the two shapes differ — each prints the version it chose, but only side by side does the mismatch show. Pinning `--target 26.6.0` makes `--smol` work, which is what `script/build-nub.mjs` now does by default.

A major-only target reasonably means "the newest 26 you can get". Whatever the rule is, both shapes should apply the same one, since the shape flag is about where the runtime comes from and not which runtime it is.

## Suggestion: an embed binary adopts a host Node of the wrong architecture

Found by running the darwin-x64 build on an arm64 Mac under Rosetta, which is not an exotic setup — an x64 build is the fallback download, and Apple Silicon users run one whenever a native arm64 build is unavailable.

The TUI died with `Missing OpenTUI asset "@opentui/core-darwin-arm64/libopentui.dylib"` — the **arm64** package — from an x86_64 binary that had staged the x64 one. The binary's own commands worked, so the mismatch only surfaced where a platform-specific file had to be found.

The cause is that the embed shape prefers a Node already on the machine over extracting its own, and here the host Node was arm64 while the launcher process was x86_64. `process.arch` then reported `arm64`, so every path the app computes from it named a package the binary never shipped. Confirmed by control: with `env -i` and no Node on `PATH`, the same binary extracted its own Node — verified `Mach-O 64-bit executable x86_64` — and the TUI rendered correctly.

Adopting a host Node is a good optimisation, and skipping a ~100 MB extraction is worth real effort. The suggestion is only that the adopted Node has to match the triple the binary was **built** for, not merely the machine it landed on. Otherwise `process.arch` and `process.platform` disagree with the build, and every asset, native addon and platform-conditional path an app derives from them points somewhere that does not exist. An app hitting this sees a missing-file error naming a package it never depended on, which is a hard failure to trace back to the launcher.

## Suggestion: the warm-start check is O(payload), and it dominates startup

Worth raising because it is invisible on a small binary and severe on a large one. Measured on Windows, median of five runs each:

| | median |
| --- | --- |
| system `node -e 0` | 55 ms |
| the **extracted** `node -e 0` | 67 ms |
| that node running the extracted app directly (`node --require <bootstrap> <entry> --version`) | 1277 ms |
| the compiled executable | 3052 ms |

So Node is fine — the extracted copy is 12 ms slower than the system one — the app's own module graph costs ~1210 ms, and **the launcher adds ~1775 ms on top before Node even starts**.

The obvious culprits are ruled out. Defender exclusions on the executable and the cache changed nothing (2973 ms with, 3000 ms without). Reading the entire 98.6 MB extracted `node.exe` off that disk takes 78 ms. A full stat-walk of the 5164-file extracted app tree takes 363 ms.

The same shape holds on macOS, which is what makes it a property of the design rather than of Windows. Ten runs each under hyperfine on the arm64 Mac: `node -e 0` 34.9 ms, that node running the extracted app directly 424.9 ms, the compiled executable 906.6 ms. So the app costs ~390 ms and **the launcher adds ~482 ms** — more than half the total, for the same 124 MB payload. Windows pays 1775 ms for the identical work; it is the same overhead against a slower disk and CPU.

The cost is `app_cache_is_ready` in `crates/nub-launcher/src/main.rs`, which runs on every warm launch. It builds a map holding the **full decompressed bytes of every app file** (`app_bytes`, which zstd-decodes each one when the payload is compressed), then walks the extracted tree and byte-compares every file against that map. For this binary that is ~124 MB decompressed and ~124 MB read and compared, on every single invocation. The work scales with payload size rather than staying constant, which is why a 124 MB app pays ~1.8 s and a small one pays nothing noticeable. It is also part of why the warm numbers trail Bun's on macOS, where Bun does no equivalent check.

The completion marker already proves a publication finished; the expensive part is proving the tree still matches afterwards. A digest written once at publish time and checked once at launch, or a manifest of `(path, size, mtime)`, would give the same tamper-evidence at O(files) instead of O(bytes). If full byte verification is deliberate, making it opt-in past some payload size would keep the guarantee where it is cheap and drop ~1.8 s where it is not.

### Shipping to a slim container

The embedded Node links a few system libraries. On `debian:bookworm-slim` the binary stops with a precise diagnostic:

```
nub: the embedded Node cannot start: it needs libatomic.so.1, which is not installed.
  Debian or Ubuntu:  apt-get install libatomic1
  Alpine:            apk add libatomic
```

`node:*-slim` images already carry it; bare `debian:*-slim` and `alpine` do not.

## Running it

Two halves: a `nub` that has the compile verb, and this tree.

### 1. A nub that can compile

`nub compile` is behind an off-by-default cargo feature, and it needs a `nub-launcher` for the target sitting beside the binary — a released nub carries neither, and without the launcher the build stops with a 404 fetching it.

```sh
git clone git@github.com:nubjs/nub.git && cd nub
git checkout compile-spike

scripts/rust-build.sh build -p nub-cli --profile fast --features compile
( cd crates/nub-launcher && cargo build --release )

NUB_TARGET=$(scripts/rust-build.sh --print-target)/fast
cp crates/nub-launcher/target/release/nub-launcher \
   "$NUB_TARGET/nub-launcher-$(node -p '(process.platform==="win32"?"win32":process.platform)+"-"+process.arch')"
export NUB="$NUB_TARGET/nub"
```

### 2. This tree

```sh
git clone git@github.com:nubjs/nopencode.git && cd nopencode
git checkout nub-compile
nub install                       # bun install also works

cd packages/opencode
curl -sSL https://models.dev/api.json -o /tmp/oc-models.json
mkdir -p dist-nub

node script/nub-solid-transform.mjs ./src ../tui/src   # in place — see below
node script/build-nub.mjs                              # stages assets, then compiles

# undo the transform — only the transformed files, so any uncommitted
# change to the build scripts survives
git -C ../.. diff --name-only | grep -E '\.(tsx|jsx)$' | tr '\n' '\0' \
  | (cd ../.. && xargs -0 git checkout --)
```

The Solid transform rewrites `.tsx` in place, exactly as the Bun build's `onLoad` plugin rewrites it in memory. Its output is never committed — undo it after building, or build in a throwaway checkout.

`OPENCODE_MODELS_JSON`, `OUT` and `NO_MINIFY=1` are honoured by `script/build-nub.mjs`. It resolves packages by walking the workspace's own `node_modules` rather than reading a store path, so it builds the same from a `bun install` tree, a `nub install` tree or an npm one.

### 3. Run it

```sh
./dist-nub/opencode --version     # 0.0.0-nub
./dist-nub/opencode               # the TUI
./dist-nub/opencode run "…"       # non-interactive, needs a signed-in provider
```

The binary is self-contained — no Node, no `node_modules`, nothing to install. On first run it unpacks itself under `${XDG_CACHE_HOME:-$HOME/.cache}/nub/compile-app/<hash>`, which takes a second or two; later runs are immediate. That cache grows by one full extraction per rebuild and nothing evicts it, so `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/nub/compile-app"` when it gets large.

### Installing with nub

`nub install` completes, applies all 16 patches, and produces a tree the build compiles from. Getting there took four fixes, and three of them were defects in this repo that bun's leniency had been hiding rather than anything nub lacked.

| What refused | Why | Fix |
| --- | --- | --- |
| `File '@tsconfig/bun/tsconfig.json' not found` | nub reads the project's tsconfig before installing, and an `extends` that points into `node_modules` cannot resolve before the first install has run | `tsconfig.base.json` in the repo, extended by relative path |
| `ERR_NUB_UNUSED_PATCH: @ff-labs/fff-bun@0.9.3` | the dependency is declared at 0.9.4, so the patch key stopped matching. bun ships it **unpatched** and says nothing — verified in the install tree: `createRequire` still present, the patch's `FFF_LIBC` absent | re-keyed to 0.9.4, where the patched region is byte-identical |
| `ERR_NUB_UNUSED_PATCH: @standard-community/standard-openapi@0.2.9` | a non-optional peer of `hono-openapi` that bun auto-installs and nub does not, so the patch matched no installed package | declared explicitly beside `hono-openapi` |
| `failed to apply patch … could not apply hunk 10` for `@silvia-odwyer/photon-node@0.3.4` | the last hunk's three context lines each carried one extra leading space, describing content the file does not have. `git apply --check` rejects it too; bun trims and applies it anyway | context corrected. The patched file is byte-identical to the copy bun produces |

Two differences between the two package managers are worth carrying rather than fixing:

- **nub does not auto-install non-optional peer dependencies; bun does.** Both `@standard-community/standard-openapi` and `ioredis` reached the graph only that way. The first is genuinely used, so it is now declared; the second is reached only through `@effect/platform-node`'s `NodeRedis.js`, which nothing here imports, so the build passes `--external ioredis` rather than installing a redis client into the binary.
- **Native build scripts need a modern `node-gyp` on `PATH`.** `tree-sitter-powershell` fails under node-gyp 3.8.0, which is Python-2 only. Both package managers fail identically on a machine carrying an old global copy, so this is not a nub difference.

### Cross-compiling

`PLATFORM` moves the whole build — the target triple, the staged OpenTUI native library, and the libc defines. It needs the other platforms' packages present, which is what opencode's own build does before its 12-target matrix:

```sh
bun install --os="*" --cpu="*" @opentui/core@0.4.5
bun install --os="*" --cpu="*" @parcel/watcher@2.5.1

PLATFORM=linux-x64 OUT=$PWD/dist-nub/opencode-linux-x64 node script/build-nub.mjs
SMOL=1 PLATFORM=linux-x64 OUT=$PWD/dist-nub/opencode-smol-linux node script/build-nub.mjs
```

`nub compile` needs a launcher for the target beside the `nub` binary. Cross-build one with the zig linker — 49 s for linux-x64 from an arm64 Mac:

```sh
rustup target add x86_64-unknown-linux-gnu
( cd crates/nub-launcher && cargo zigbuild --release --target x86_64-unknown-linux-gnu )
cp crates/nub-launcher/target/x86_64-unknown-linux-gnu/release/nub-launcher "$NUB_TARGET/nub-launcher-linux-x64"
```

## A suggestion for `nub compile`: a source-transform seam

This is the one thing the port needed that `nub compile` cannot express, and it is not opencode-specific — any app whose source is a compile-to-runtime dialect (Solid, Svelte, Vue SFC) has the same shape.

Bun's build takes `plugins: [createSolidTransformPlugin()]`: an `onLoad` hook that rewrites `.tsx` **in memory**. `nub compile` has no hook, so this port runs the identical Babel pass over the working tree **in place** and reverts it afterwards. It works and the output is byte-identical, but mutating a source tree as a build step is a bad seam — and it bit me, since `git checkout -- .` also discards any uncommitted edit to the build scripts themselves.

A mirrored workspace is not a workaround. Measured, on this repo:

- Symlinking each package's `node_modules` into a mirror **builds cleanly and produces a broken TUI** — the workspace links resolve back out to the untransformed originals. Silent wrong answer, the worst outcome.
- Copying those `node_modules` instead keeps workspace links inside the mirror, but then `tsconfig` resolution fails (`@tsconfig/node22` not found).

An isolated (bun/pnpm) layout is too entangled to relocate. Two options, cheapest first:

1. **An overlay directory.** `--overlay <dir>`: during load, a file present at the same relative path under the overlay is read instead of the real one. The user runs whatever transform they like into the overlay; nothing mutates their tree. This is a load-hook redirect and needs no JS bridge.
2. **A real transform hook.** `--transform <module>`, with nub hosting the user's module in the Node it already ships and calling it per module, mirroring esbuild/Rolldown `onLoad`. More faithful to Bun, considerably more machinery — an async IPC hop in the middle of the bundle.

Option 1 solves the demonstrated problem; option 2 solves the general one.

## How each Bun build feature maps

| `Bun.build` | `nub compile` |
| --- | --- |
| `conditions: ["bun", "node"]` | the default set — `bun` is deliberately not added, which is what selects opencode's existing `node` siblings for `#sqlite`, `#pty`, `#fff` and both opentui packages |
| `plugins: [createSolidTransformPlugin()]` | `script/nub-solid-transform.mjs`, run before the build |
| `external: ["node-gyp"]` | `--external node-gyp` |
| `define: { … }` | `--define`, and `--define-file` for the models.dev payload |
| `files: { … }` in-memory modules | real files, reached with `--alias` |
| `entrypoints: [main, tuiWorker, …]` | one entry; the TUI worker is found from a literal `new Worker(new URL(…, import.meta.url))` |
| `compile.execArgv` | `--node-options` |
| `minify`, `splitting`, `format: "esm"` | defaults |

## Source changes, and why each one is needed

| File | Change |
| --- | --- |
| `packages/opencode/src/nub/bun-compat.ts` | new — installs the `Bun` global over Node builtins. Only the five members the shipped graph calls: `stringWidth`, `file`, `write`, `stdin`, `hash`. Imported first from both compiled roots. |
| `packages/opencode/src/nub/web-ui-empty.ts` | new — stands in for `opencode-web-ui.gen.ts`, the module `script/build.ts` generates and injects as a virtual file. Equivalent to upstream's own `--skip-embed-web-ui`. |
| `packages/tui/src/editor-zed.ts` | `bun:sqlite` → `node:sqlite`: `DatabaseSync`, `prepare()`, `readOnly`. |
| `packages/tui/src/terminal-win32.ts` | `bun:ffi` → `node:ffi`, loaded lazily and only on Windows. Same four kernel32 calls; `node:ffi` spells a signature `{ arguments, return }` and hands back `functions`, and a buffer becomes a pointer through `getRawPointer`. The build bakes `--experimental-ffi` in (below). |
| `packages/tui/src/{component/dialog-status.tsx, component/prompt/autocomplete.tsx}`, `packages/opencode/src/cli/cmd/run/footer.prompt.tsx` | `fileURLToPath` / `pathToFileURL` from `"bun"` → `"node:url"` |
| `packages/opencode/src/cli/cmd/tui.ts` | the worker specifier moves inline into the `new Worker(...)` call — a specifier that reaches the constructor through a variable is invisible to the build, which would ship the worker entry untranspiled, as data. The worker's type import also becomes `import type`: the inline `import { type rpc }` form leaves a real import, so the worker body runs on the main thread and throws `onmessage is not defined`. |
| `packages/opencode/src/index.ts`, `src/cli/tui/worker.ts` | import the `Bun`-global shim first |
| `packages/opencode/package.json` | `string-width` (what `Bun.stringWidth` becomes); `babel-preset-solid` + `@babel/preset-typescript` for the transform |
| `packages/core/src/database/migration.gen.ts` | 38 dynamic imports behind a top-level `await Promise.all` become static imports |
| `packages/core/src/global.ts` | `await`ed `mkdir`s become `mkdirSync` |
| `patches/@opentui%2Fcore@0.4.5.patch` | opentui's FFI backend and native-library path both resolve lazily and synchronously instead of at top level |
| `packages/opencode/script/stage-otui-assets.mjs` | new — stages the 13 files OpenTUI locates at run time into one `OTUI_ASSET_ROOT`-keyed directory |
| `packages/opencode/src/nub/otui-asset-root.ts` | new — points `OTUI_ASSET_ROOT` at that directory inside the binary, before OpenTUI loads |
| `packages/opencode/src/nub/runtime-plugin-support-noop.ts` | new — stands in for the Bun-only TUI plugin host, whose Node arm throws on import |

Everything else opencode already had: `@opentui/core`, `@opentui/solid`, `#sqlite`, `#pty` and `#fff` all ship working `node` conditions, so choosing the `node` condition is the whole fix for them.

## Top-level await is the thing to avoid

Every hard failure in this port came from the same place, and it is worth understanding before changing anything here.

A bundler cannot keep ESM's evaluation semantics for an async module graph. Rolldown (and esbuild, which ships a byte-identical helper) turns each module into a lazy initializer and emits `await init_dependency()` at the head of each one. Real ESM evaluates a cycle as a single strongly connected component and never has a module wait on itself; the linearized form does exactly that. So **one top-level `await` anywhere marks every importer async, and the first import cycle among them hangs the program before `main` with no error at all** — just exit 13 and silence.

Four fixes here are that, and nothing else:

| Where | What |
| --- | --- |
| `packages/core/src/database/migration.gen.ts` | 38 dynamic imports behind `await Promise.all` become static imports. Also drops 38 lazily-loaded chunks. |
| `packages/core/src/global.ts` | seven awaited `mkdir`s become `mkdirSync`. 52 modules import this one. |
| `patches/@opentui%2Fcore@0.4.5.patch` | two awaits: the FFI backend, and `targetLibPath = await resolveNativeLibraryPath()`. Both now resolve lazily and synchronously. The second one is what made the entire TUI subgraph async. |

## OpenTUI's runtime-resolved assets

OpenTUI finds its native library with `await import("@opentui/core-<platform>-<arch>")` — a specifier built from `process.platform`/`process.arch`, invisible to any bundler, and it locates the tree-sitter parser worker and grammar files the same way. `OTUI_ASSET_ROOT` is the package's own escape hatch: an absolute directory it consults first, keyed `<package>/<file>`.

`script/stage-otui-assets.mjs` builds that directory, `--include` embeds it, and `src/nub/otui-asset-root.ts` points the env var at it before anything touches OpenTUI. It is **all or nothing** — with the root set, a missing asset throws rather than falling back — so the staging script verifies all 13 assets are present rather than letting it fail inside a rendered frame.

Two things this replaced: a `require()` of the platform package fails, because its `exports` map declares only `import` and `types`; and `--unbundled @opentui/core-<platform>-<arch>` silently shipped nothing, because the package lives in Bun's isolated store and is not resolvable from the entry's directory.

## The Bun-only plugin host

`@opentui/solid/runtime-plugin-support/configure` registers a `bun.plugin` hook so a TUI plugin loaded at run time resolves `@opentui/solid` and `solid-js` to the host's module instances. Its Node arm throws at module scope, so even importing it is fatal. The nub build aliases it to `src/nub/runtime-plugin-support-noop.ts`; opencode's source is untouched and the Bun build keeps the real thing.

Consequence: the TUI runs, and third-party TUI plugins that import the Solid/OpenTUI runtime do not get the host's instances. Every built-in plugin is bundled and unaffected.

## Node flags

A compiled binary already runs Node with `--experimental-ffi` (nub injects it on 26.1+, with `--disable-warning=ExperimentalWarning`), so `node:ffi` needs nothing from this build — verified by printing `process.execArgv` from a binary compiled with no `--node-options`. `@opentui/core`'s own `node:ffi` backend gets the flag the same way.

`--node-options` is the `compile.execArgv` equivalent for anything else. `--use-system-ca`, which the Bun build bakes in, is not passed yet; Node has the flag since v23.8.

## Running the test suite on Node

The suite is written against `bun:test`. `packages/nub-test` runs it on stock Node instead, and `bun test` is gone — every package's `test` script is a `node --test` invocation, and the shim's `bun` export condition, which had kept Bun's runner working as a control, went with it. `nub run test:all` runs every package in series and tallies.

Every package, on one machine, measured the same way on both sides: Bun at the commit this branch starts from, running each package's own pre-migration `test` script; Node at this branch's head, through `nub run test:all`.

| package | Bun | Node |
| --- | --- | --- |
| opencode | 3184 / 5 / 17 skipped | 3095 / 105 / 17 skipped |
| core | 1080 / 0 | 1066 / 8 |
| app (test:unit) | 693 / 1 | 684 / 2 |
| llm | 298 / 0 / 30 skipped | 298 / 0 / 30 skipped |
| codemode | 263 / 0 | 263 / 0 |
| tui | 168 / 5 / 1 skipped | 187 / 3 / 1 skipped |
| session-ui | 76 / 0 | 76 / 0 |
| desktop | 70 / 1 | 70 / 1 |
| httpapi-codegen | 66 / 0 | 65 / 1 |
| app (test:browser) | 41 / 0 | 41 / 0 |
| http-recorder | 33 / 0 | 33 / 0 |
| enterprise | 1 / 17 | 0 / 17 |
| client | 15 / 1 | 15 / 1 |
| schema | 13 / 2 | 13 / 2 |
| console-core | 14 / 0 | 14 / 0 |
| ui | 9 / 0 | 9 / 0 |
| console-app | 5 / 2 | 5 / 2 |
| effect-drizzle-sqlite | 7 / 0 | 7 / 0 |
| stats-core | 7 / 0 | 7 / 0 |
| sdk-next | 1 / 4 | 1 / 4 |
| cli | 3 / 0 | 3 / 0 |
| protocol | 2 / 0 | 2 / 0 |
| sdk | 1 / 0 | 1 / 0 |
| **total** | **6050 / 38 / 48 skipped** | **5955 / 146 / 48 skipped** |

Read the Bun column as the target rather than as a pass mark: 38 of its own tests fail, and `cli`, `enterprise`, `protocol` and `stats-core` had no `test` script at all before this branch, so their files were unrunnable rather than passing. `tui` is the one package ahead of Bun.

Seventeen of the twenty-three rows match Bun exactly and one is ahead of it. The gap is concentrated in `opencode` and `core`:

- **`opencode` is a long tail, not one cause.** The remaining failures are spread across the MCP, LSP, provider, subprocess and tool suites: a handful of CLI-subprocess runs that exit 1, three recorded-interaction replays that consume fewer interactions than they recorded, and singleton assertion mismatches. No single fix moves more than a few.
- **`packages/enterprise`** fails on both runners — Bun 1/17, Node 0/17 — and had no `test` script at all before this branch.
- **`core`'s residue** is eight tests in five files: a migration guard, a filesystem read, three `.npmrc` registry cases, one npm reify, and two file-lock tests that turn on process contention.
- **`import-boundaries.test.ts`** in `packages/client` and `packages/sdk-next` spawns `[process.execPath, "build", …]`, which is `bun build` under Bun and `node build` here. Both packages fail the same number of tests on both runners, so the totals line up, but under Node those failures are the spawn rather than the boundary the test is about.
- **A partial `mock.module` factory**, described above, accounts for one of `packages/app`'s two.
- **`packages/tui`** is the one package ahead of Bun. Its three failures are `ERR_WORKER_INVALID_EXEC_ARGV`: `node --test` hands a child a long `execArgv`, and a `new Worker(…)` that inherits it is rejected. Bun's runner passes nothing comparable.

Three flags every script carries:

- **`--test-force-exit`.** Several suites finish every test and then sit forever on a handle nothing closes; bun exits regardless. It is post-run rather than a hang — `core/test/npm.test.ts` prints all three of its suite summaries and then never returns.
- **`--test-timeout=30000`.** bun's own default is a 5-second per-test timeout, so the Bun numbers above were already bounded. Node's default is Infinity, which turns one wedged test into a suite that never returns.
- **`--test-reporter=dot`**, the nearest thing to bun's `--only-failures`.

`bun test` also reads `bunfig.toml`, and three packages declare a `[test] preload` there. `packages/app`'s `happydom.ts` becomes a second `--import`; `packages/core` and `packages/opencode` each preload a `test/preload.ts` and get the same treatment. Those two matter more than they look: both set `OPENCODE_DB=":memory:"`, without which `Database.path()` falls through to `~/.local/share/opencode/opencode-<channel>.db` and every test in the process shares one on-disk database with every test before it. `packages/opencode`'s also redirects the XDG directories at a per-pid temporary directory, points `OPENCODE_MODELS_PATH` at a fixture, clears the provider API-key variables and calls `initProjectors()`.

`packages/tui` and `packages/cli` preload `@opentui/solid/preload`, which is the one bunfig entry with no Node equivalent: under the `node` export condition it resolves to a module whose entire body throws `is Bun-only`. Its Bun arm installs the Solid transform plugin, which is what `NUB_TEST_SOLID` already does in the resolver hooks, so neither script imports it.

`tui` additionally stages the OpenTUI assets first and points `OTUI_ASSET_ROOT` at them; without that, OpenTUI resolves its native library by importing `@opentui/core-<platform>-<arch>`, whose exports map declares no main, and every renderer test dies with `No "exports" main defined`. The compiled binary solves the same problem the same way. `packages/app` splits into two runs because its halves need different export conditions — `--conditions=solid` for `src`, `--conditions=browser` for `test-browser` — and happy-dom moves from bun's `--preload` to a second `--import`.

What the shim has to bridge, beyond renaming `beforeAll` to `before`:

- **Extensionless and NodeNext imports.** Bun resolves `./agent` to `./agent.ts`, and `./plugin.js` to `plugin.ts`. Node does neither.
- **tsconfig `paths`.** Six packages alias `@/*` or `~/*` to their own `src`. Bun applies the map; Node has no notion of one and reports `@/config` as a missing *package*, since it is a well-formed scoped name. This was the single largest gap — most of `packages/opencode` and `packages/app` could not load a file without it.
- **Vite's `import.meta.env`**, which Bun provides as an alias for `process.env`, and `.css` side-effect imports.
- **Non-erasable TypeScript.** Node strips types but refuses parameter properties and enums, so the load hook compiles with esbuild.
- **Symlink canonicalisation.** Node keys its module cache on the resolved URL, so two spellings of one file are two modules. Under the workspace store one driver was instantiated 252 times and the resolver never terminated.
- **SolidJS JSX**, a compile-to-renderer-ops pass rather than a `jsx()` factory rewrite — no esbuild setting produces it. Two renderers need two outputs, so `NUB_TEST_SOLID` names one: `universal` for OpenTUI, `dom` for the browser. Only `dom` compiles `node_modules`, because a DOM Solid library ships JSX source under the `solid` export condition precisely so its consumer compiles it — under `--conditions=solid`, `@kobalte/core`, `@solidjs/router` and `solid-sonner` all arrive as `.jsx`.
- **`solid-js` resolving to its SSR build**, for the root package and for the `store` and `web` subpaths alike. Both runtimes resolve it identically; OpenTUI's Bun plugin swaps in the client build, and the shim redirects to it in `resolve` so app code and the renderer share one module instance.
- **`mock.module` resolution.** `node:test` resolves a bare specifier against the immediate caller, which through the shim's wrapper is the shim itself — so mocking `@opentui/core` from a tui test failed naming a dependency of `packages/nub-test`. The shim resolves first and hands node an absolute URL. That has to go through `import.meta.resolve`, since the registered hooks apply to it and `createRequire` would return `solid-js`'s CJS entry and mock a second copy — a silent no-op rather than an error.
- **Bun's own APIs** — the `Bun` global, `bun:sqlite`, the `$` shell, `with { type: "file" }` assets, and snapshots read from Bun's committed `.snap` files.
- **`@opentui/solid/runtime-plugin-support/configure`**, whose `node` arm is a thrown error rather than an implementation, so importing it killed seven files outright. The resolver aliases it to a no-op that returns false — the same answer `script/build-nub.mjs` arranges for the compiled binary.
- **`spyOn` on a module namespace.** `export * as Npm from "./npm"` yields an object that is non-extensible with non-configurable properties, so `defineProperty` fails where Bun relaxes the rule for mocking. `NUB_TEST_SPYABLE` names the modules whose re-export the load hook rewrites into a Proxy over an ordinary object: reads fall through to the namespace, writes shadow it. It is opt-in and named rather than universal because 389 modules here use that idiom and exactly two are ever spied on.

A member that is present but unimplemented throws, because a silently missing API turns a real assertion into a passing no-op — the one failure mode a migration like this must not have. That covers what is in the shim, not everything Bun has: the polyfill is an ordinary object, so a member nobody added reads as `undefined`.

One difference the shim does not bridge, and deliberately: a PARTIAL `mock.module` factory. Bun replaces the module and leaves a name the factory omitted as `undefined`; Node builds a synthetic module with exactly the factory's keys, so a third module that statically imports the omitted name fails to link. Filling the gaps would mean discovering the real module's export list synchronously, which `mock.module` has no way to do — and guessing it wrong would mock the wrong thing silently. One test file relies on the permissive reading.

### The dependencies this added

`expect@29.7.0` and `pretty-format@29.7.0`, both Jest's, as dependencies of the shim. `pretty-format` is `expect`'s own transitive dependency at the same version, so naming it adds nothing to the install; it is what renders an object snapshot, and Bun writes Jest's snapshot format verbatim. Everything else the shim needs was already in the tree.

It is there because of what the suite asserts with, counted across all test files: `toEqual` 3404 times, `toMatchObject` 678, and the asymmetric matchers `expect.objectContaining` 126, `expect.any` 37, `expect.stringContaining` 23, `expect.arrayContaining` 18, `expect.stringMatching` 8. A hand-written deep-equality engine that is subtly wrong does not fail — it passes, on both sides of a comparison it should have rejected, which is the failure mode this whole migration exists to avoid. `node:assert` has no asymmetric-matcher equivalent to build on.

The Bun-only matchers Jest lacks (`toBeTrue`, `toStartWith`, `toBeFunction`, and their siblings) are ~30 lines of `expect.extend` in the shim rather than another package.

## What still touches Bun

Counted against the merge of `nub-compile` and `dev`:

| | before | after |
| --- | --- | --- |
| files importing `bun:test` | 396 | **0** |
| package.json scripts invoking `bun` or `bunx` | 63 | 24 |
| packages depending on `@types/bun` | 28 | 20 |
| packages depending on `@tsconfig/bun` | 17 | **0** |
| other `bun:*` imports | 3 | 3 |

What is left, and why each stays:

- **The `Bun` global**, through `packages/opencode/src/nub/bun-compat.ts`. 32 call sites in the compiled graph outside the shim itself, 25 of them `Bun.stringWidth`. Rewriting each to a direct import would churn upstream source for no behavioural gain — the polyfill is the sanctioned mechanism.
- **`sqlite.bun.ts`, `pty.bun.ts`, `fff.bun.ts`** — the `bun` arms of opencode's own conditional exports. The nub build selects the `node` siblings; upstream keeps both.
- **24 package.json scripts**, and they are the ones whose body calls a Bun API: `Bun.build` in the per-package build scripts, `Bun.spawn` / `Bun.Glob` in the repo tooling. Those ARE the Bun build path, which `script/build-nub.mjs` replaces rather than reimplements, so pointing them at nub would break them for nothing. `bun sst shell` stays too, since it wraps a second command in an SST environment.
- **`@types/bun` in 20 packages** that still name `Bun` somewhere. One of those names is type-only: `packages/opencode/src/session/message-v2.ts` imports `type { SystemError } from "bun"`, which is erased at build time and reaches no runtime.
- **17 test files importing `{ $ } from "bun"`** for the shell API. Those run on Node: the shim's resolve hook points the `bun` specifier at its own `bun-module.ts`.
- **`bun.lock` and `packageManager: bun@1.3.14`.** `nub install` installs from the tree as it stands and leaves `bun.lock` byte-unchanged, writing no lockfile of its own, so the two package managers share the one file.
