# Building opencode with `nub compile`

A port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

Builds and runs on **darwin-arm64**, **darwin-x64**, **linux-x64**, **linux-arm64**, **linux-arm64-musl** and **win32-x64**, TUI included, in both the default embed shape and `--smol`.

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
| `--smol` | 21.8 MB, provisions its own Node on a machine that has none: 14 s first run, 2 s after |
| A model response | **not verified.** No usable credential on the test machine: the same prompt fails identically on this binary, the Bun build, and a stock installed opencode (`Token refresh failed: 401`). |

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

`packages/tui/src/nub-ffi.ts` is a throwing stub, so the Windows Ctrl-C console guard is absent — untested, and it would need `node:ffi` behind `--experimental-ffi` or a small addon.

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
git clone git@github.com:nubjs/opencode.git && cd opencode
git checkout nub-compile
bun install                       # nub install also works; see the note below

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

`OPENCODE_MODELS_JSON`, `OUT` and `NO_MINIFY=1` are honoured by `script/build-nub.mjs`.

### 3. Run it

```sh
./dist-nub/opencode --version     # 0.0.0-nub
./dist-nub/opencode               # the TUI
./dist-nub/opencode run "…"       # non-interactive, needs a signed-in provider
```

The binary is self-contained — no Node, no `node_modules`, nothing to install. On first run it unpacks itself under `${XDG_CACHE_HOME:-$HOME/.cache}/nub/compile-app/<hash>`, which takes a second or two; later runs are immediate. That cache grows by one full extraction per rebuild and nothing evicts it, so `rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/nub/compile-app"` when it gets large.

Installing dependencies with `nub install` instead of `bun install` needs two `patchedDependencies` entries in the root `package.json` corrected first — `@ff-labs/fff-bun@0.9.3` and `@standard-community/standard-openapi@0.2.9` are pinned to versions no longer resolved, which nub refuses and bun tolerates.

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
| `compile.execArgv` | **no equivalent** — see below |
| `minify`, `splitting`, `format: "esm"` | defaults |

## Source changes, and why each one is needed

| File | Change |
| --- | --- |
| `packages/opencode/src/nub/bun-compat.ts` | new — installs the `Bun` global over Node builtins. Only the five members the shipped graph calls: `stringWidth`, `file`, `write`, `stdin`, `hash`. Imported first from both compiled roots. |
| `packages/opencode/src/nub/web-ui-empty.ts` | new — stands in for `opencode-web-ui.gen.ts`, the module `script/build.ts` generates and injects as a virtual file. Equivalent to upstream's own `--skip-embed-web-ui`. |
| `packages/tui/src/nub-sqlite.ts` | new — the slice of `bun:sqlite` `editor-zed.ts` uses, on `node:sqlite`. |
| `packages/tui/src/nub-ffi.ts` | new — stands in for `bun:ffi`. Exact on non-Windows, where every call site is platform-guarded; a real gap on Windows, documented in the file. |
| `packages/tui/src/{component/dialog-status.tsx, component/prompt/autocomplete.tsx}`, `packages/opencode/src/cli/cmd/run/footer.prompt.tsx` | `fileURLToPath` / `pathToFileURL` from `"bun"` → `"node:url"` |
| `packages/tui/src/editor-zed.ts` | `bun:sqlite` → the shim above |
| `packages/tui/src/terminal-win32.ts` | `bun:ffi` → the shim above |
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

## Two things that need a flag `nub compile` does not have

- **`--experimental-ffi`.** `@opentui/core` has a `node:ffi` backend that Node 26 gates behind this flag. The TUI renders *without* it — that path degrades to `createUnsupportedBackend` and the render library loads through the staged asset root instead — so it is not required today. It would be needed by anything that reaches the FFI struct helpers. Bun bakes flags in with `compile.execArgv`; `nub compile` has no equivalent, so the only lever is `NODE_OPTIONS` in the environment.
- **`--use-system-ca`.** Baked in by the Bun build. Node has the same flag since v23.8, and the same problem baking it in.
