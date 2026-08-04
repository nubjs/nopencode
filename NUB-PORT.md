# Building opencode with `nub compile`

A port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

Builds and runs, TUI included. The binary is **42.8 MB**, against **106.5 MB** for the Bun build of the same tree.

Verified from a foreign working directory, with the runtime cache cleared and a fresh `HOME`: `--version`, `--help`, `models`, `agent list` and `providers list` all produce **byte-identical output to the Bun build**, and the TUI renders — prompt, model line, keybinds, status bar.

## Running it

```sh
# One-time: a modern node-gyp, if the host's is old.
bun install

# The Solid JSX transform. In place — `git checkout` to undo.
node script/nub-solid-transform.mjs ./src ../tui/src

# The build. NUB points at a nub built with `--features compile`.
curl -sSL https://models.dev/api.json -o /tmp/oc-models.json
mkdir -p dist-nub
NUB=/path/to/nub node script/build-nub.mjs
```

`NO_MINIFY=1` and `OUT=<path>` are honoured.

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
