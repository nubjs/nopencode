# Building opencode with `nub compile`

A port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

The build **succeeds** and produces a 42.8 MB binary (bun's is 106.5 MB). The binary does **not yet run**: it hits a `nub compile` chunking defect that is tracked on nub's side, not here. See [What blocks it](#what-blocks-it).

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
| `packages/opencode/src/cli/cmd/tui.ts` | the worker specifier moves inline into the `new Worker(...)` call. A specifier that reaches the constructor through a variable is invisible to the build, which would ship the worker entry untranspiled, as data. |
| `packages/opencode/src/index.ts`, `src/cli/tui/worker.ts` | import the `Bun`-global shim first |
| `packages/opencode/package.json` | `string-width` (what `Bun.stringWidth` becomes); `babel-preset-solid` + `@babel/preset-typescript` for the transform |

Everything else opencode already had: `@opentui/core`, `@opentui/solid`, `#sqlite`, `#pty` and `#fff` all ship working `node` conditions, so choosing the `node` condition is the whole fix for them.

## Two things that need a flag `nub compile` does not have

- **`--experimental-ffi`.** `@opentui/core`'s Node backend is `require("node:ffi")`, which Node 26 gates behind that flag; the package's own error text says so. The TUI cannot start without it. Bun bakes flags in with `compile.execArgv`; `nub compile` has no equivalent, so today the only lever is `NODE_OPTIONS=--experimental-ffi` in the environment.
- **`--use-system-ca`.** Baked in by the Bun build. Node has the same flag since v23.8, and the same problem baking it in.

## What blocks it

`nub compile` splits its output into several chunks, and in a graph this size two of them import each other. ESM runs one side of a cycle to completion while the other is partway through its own body, so a binding the first side needs is still `undefined`. It shows up three ways here — an eager `export default require_pkg()` throwing `require_pkg is not a function`, the same against a CommonJS module that requires ESM, and an unsettled top-level await (exit 13) once the TUI worker adds a second bundled root. Working around one package with `--unbundled` just moves it to the next one.

The bun build of the same tree, from the same `node_modules`, runs fine — so this is nub's, not opencode's.
