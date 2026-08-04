# Building opencode with `nub compile`

A port of opencode from a `bun build --compile` executable to a `nub compile` one, on top of upstream v1.18.11 (`e917c12`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. Run it before building and `git checkout` afterwards, or build in a throwaway checkout.

## Status

Builds and runs. The binary is **42.8 MB**, against **106.5 MB** for the Bun build of the same tree.

Verified from a foreign working directory, with the runtime cache cleared and a fresh `HOME`:

| | |
| --- | --- |
| `--version` | `0.0.0-nub` |
| `--help` | full logo and command list, 56 lines |
| `models` | 104 models |
| `agent list` | full agent config, matches the Bun build |
| `providers` | same usage output and exit 1 as the Bun build |
| **TUI** (`opencode` with no args) | **does not start** — see below |

The TUI still exits 13 on an unsettled top-level await. Everything else works.

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
| `patches/@opentui%2Fcore@0.4.5.patch` | opentui's FFI backend loads lazily and synchronously instead of at top level |

Everything else opencode already had: `@opentui/core`, `@opentui/solid`, `#sqlite`, `#pty` and `#fff` all ship working `node` conditions, so choosing the `node` condition is the whole fix for them.

## Top-level await is the thing to avoid

Every hard failure in this port came from the same place, and it is worth understanding before changing anything here.

A bundler cannot keep ESM's evaluation semantics for an async module graph. Rolldown (and esbuild, which ships a byte-identical helper) turns each module into a lazy initializer and emits `await init_dependency()` at the head of each one. Real ESM evaluates a cycle as a single strongly connected component and never has a module wait on itself; the linearized form does exactly that. So **one top-level `await` anywhere marks every importer async, and the first import cycle among them hangs the program before `main` with no error at all** — just exit 13 and silence.

Three fixes here are that, and nothing else:

- `packages/core/src/database/migration.gen.ts` — upstream `await`s a `Promise.all` of 38 dynamic imports. Static imports are equivalent and drop the await. Also worth it on its own: 38 fewer lazily-loaded chunks.
- `packages/core/src/global.ts` — `await`ed seven `mkdir`s. `mkdirSync` is equivalent, and this module has 52 importers.
- `patches/@opentui%2Fcore@0.4.5.patch` — `var backend2 = await loadBackend2()`. Made lazy and synchronous through `createRequire`, which is what the same file's *other* FFI backend loader already does.

The TUI is still blocked on this. After those three, no source-level top-level await remains, but the whole `packages/tui` subgraph still comes out as async initializers and deadlocks on a cycle among them.

## Two things that need a flag `nub compile` does not have

- **`--experimental-ffi`.** `@opentui/core`'s Node backend is `require("node:ffi")`, which Node 26 gates behind that flag; the package's own error text says so. The TUI cannot start without it. Bun bakes flags in with `compile.execArgv`; `nub compile` has no equivalent, so today the only lever is `NODE_OPTIONS=--experimental-ffi` in the environment.
- **`--use-system-ca`.** Baked in by the Bun build. Node has the same flag since v23.8, and the same problem baking it in.
