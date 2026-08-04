# Building opencode with `nub compile`

A port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

Builds and runs, TUI included. The binary is **47.5 MB**, against **106.5 MB** for the Bun build of the same tree. It carries its own Node — nothing to install on the machine that runs it.

Verified from a foreign working directory, with the runtime cache cleared, a fresh `HOME`, and separately with this source tree moved away entirely:

| | |
| --- | --- |
| `--version`, `--help`, `models`, `agent list`, `providers list`, four `--help` surfaces | **byte-identical output to the Bun build**, 9/9 |
| TUI | renders, and responds to input — `esc` dismisses dialogs, typed text echoes into the prompt, `ctrl+p` opens the command palette |
| Backend | `serve` listens, `/doc` and `/session` return 200, and a POSTed session persists and reads back stamped `"version":"0.0.0-nub"` — so SQLite opened and all 38 migrations ran |
| A model response | **not verified here.** No usable credential on the test machine: the same prompt fails identically on this binary, the Bun build, and a stock installed opencode (`Token refresh failed: 401`), so it is the expired token, not the port. |

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

cd ../.. && git checkout -- . && cd packages/opencode   # undo the transform
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
