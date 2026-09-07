# Building opencode v2 with `nub compile`

A port of the v2 CLI from a `bun build --compile` executable to a `nub compile` one, on stock Node, on top of `beta` (`7a4ad68`).

The branch carries only hand-written source. The Solid JSX transform is a **build step** — `script/nub-solid-transform.mjs` rewrites `.tsx` in place, the same way the Bun build's `onLoad` plugin rewrites it in memory — so its output is never committed. `script/build-nub.mjs` runs it and restores the tree in a `finally`.

Nothing in the build invokes bun. Where the workspace happens to have been installed by bun, only the resulting directory layout under `node_modules/.bun` is read, and a plain hoisted `node_modules` works too.

## What their build does, and where each piece went

`script/build.ts` is `Bun.build` plus five plugins. Nub has no plugin hook, so each one became an explicit step.

| Their plugin | Here |
| --- | --- |
| `solidPlugin` (`onLoad` JSX transform) | `script/nub-solid-transform.mjs`, run before the bundler. Calls `@opentui/solid`'s own `transformSolidSource`, so the bundler sees what their plugin would have produced. |
| `appAssetsPlugin` (serves `virtual:opencode-app-assets` from memory) | `script/nub-app-archive.mjs` writes the archive to a real module; `--alias` points the specifier at it. |
| `parcelWatcherPlugin`, `opencodePtyPlugin` (native binaries) | `--include` of the staged per-platform packages. |
| `simulationGraphPlugin` (a build-time assertion) | Not ported. It verifies a module-graph property of their build and has no bearing on the artifact. |
| Bun's virtual filesystem (discovers file imports automatically) | Each asset named explicitly in `staged`. A bundler cannot see a specifier built at run time. |

## Four defects, each hidden behind the previous

The TUI started and never painted. Fixing one exposed the next, so they are worth recording in order.

1. **Cross-package assets reached through a computed specifier.** `` `@opencode-ai/ui/audio/${name}` `` and `tree-sitter-bash/tree-sitter-bash.wasm`. Nub auto-unbundles a package whose `.node` addon it can see, and got six on its own, but not these: the `require.resolve` lives in one package and the asset in another, so nothing static connects them. Each is named in `staged` and travels via `--include`.
2. **The server subprocess exited 1, silently.** Same class — `tree-sitter-bash.wasm` again, this time in the server rather than the TUI. Only visible by running `serve --service` directly and reading its exit code.
3. **`solid-js` resolved to its SSR build.** Its `exports` map sends the `node` condition to `./dist/server.js`, which has no reactive context: the TUI renders one frame, then throws `Theme context must be used within a context provider` inside an `Effect.tryPromise`. Two `--alias` entries rewrite it, matching their `resolveNodeSolidRuntimeImport`.
4. **The Solid JSX transform never ran at all.** 136 files (134 tui, 2 cli). Solid's `generate: "universal"` output compiles to renderer ops rather than a `jsx()` factory, so no `jsxImportSource` or oxc setting substitutes for it.

## Running it

```sh
# a nub that can compile
scripts/rust-build.sh build -p nub-cli --profile fast --features compile

# the port; builds the web UI with vite, then the binary
NUB_BIN=/path/to/target/fast/nub node packages/cli/script/build-nub.mjs

# without the web UI (empty archive; the TUI starts without it)
SKIP_WEB_UI=1 NUB_BIN=... node packages/cli/script/build-nub.mjs
```

The transform edits the tree in place. `build-nub.mjs` restores it in a `finally`, but if you interrupt it, `git checkout -- packages/tui/src packages/cli/src` before committing anything.

## Platform coverage

`script/nub-native-packages.mjs` derives each native package from `process.platform`/`process.arch`, plus a libc probe for Linux. The four families disagree on how to spell the suffix — the libc token is `glibc`/`musl` for `@parcel/watcher`, `gnu`/`musl` for `@ff-labs/fff-bin` and `@yuuang/ffi-rs`, absent for `@lydell/node-pty`, and only `ffi-rs` tags Windows `-msvc`.

Every one of the 32 name combinations resolves against an installed workspace, checked against the store listing and confirmed to reject four plausible-but-wrong spellings. **Only darwin-arm64 has actually been built and run.** The naming is verified; the builds are not.

## Top-level await is the thing to avoid

No top-level await anywhere in the compiled graph. Rolldown lowers each import edge into its own `await`, which is correct for a DAG and wrong inside a cycle — a cycle deadlocks with `Detected unsettled top-level await` and nothing else. `nub compile` now guards re-entrant async initializers itself, but the constraint on authored source stands.

Bun has a related but distinct rule worth knowing, because it looks like the same constraint and is not: `bun build --bytecode` flips the default output format to CommonJS, and CommonJS cannot carry top-level await. Passing `--format=esm` explicitly keeps ESM *and* still applies bytecode. Their `build.ts` sets both, which is why their build compiles a graph full of top-level await while a naive `--bytecode` on the same source does not.
