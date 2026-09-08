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

## Five defects, the first four hidden behind each other

The TUI started and never painted. Fixing one exposed the next, so they are worth recording in order. The fifth is different in kind: it never stopped anything from painting, which is why it survived four rounds of getting the TUI working.

1. **Cross-package assets reached through a computed specifier.** `` `@opencode-ai/ui/audio/${name}` `` and `tree-sitter-bash/tree-sitter-bash.wasm`. Nub auto-unbundles a package whose `.node` addon it can see, and got six on its own, but not these: the `require.resolve` lives in one package and the asset in another, so nothing static connects them. Each is named in `staged` and travels via `--include`.
2. **The server subprocess exited 1, silently.** Same class — `tree-sitter-bash.wasm` again, this time in the server rather than the TUI. Only visible by running `serve --service` directly and reading its exit code.
3. **`solid-js` resolved to its SSR build.** Its `exports` map sends the `node` condition to `./dist/server.js`, which has no reactive context: the TUI renders one frame, then throws `Theme context must be used within a context provider` inside an `Effect.tryPromise`. Two `--alias` entries rewrite it, matching their `resolveNodeSolidRuntimeImport`.
4. **The Solid JSX transform never ran at all.** 136 files (134 tui, 2 cli). Solid's `generate: "universal"` output compiles to renderer ops rather than a `jsx()` factory, so no `jsxImportSource` or oxc setting substitutes for it.
5. **`Bun` is not defined, on every TUI start.** Shipped code still calls `Bun.file` (4), `Bun.sleep` (3) and `Bun.write` (1). The one that fires every time is `MigrationOverlay`, whose `onMount` opens with `await Bun.sleep(1_000)` — the overlay mounts unconditionally, so its data-migration poll loop died on every run behind an unhandled rejection nobody sees, while the rest of the TUI painted normally. `src/nub/bun-shim.ts` fills the global in when it is absent, so a `bun build` of the same source is untouched.

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

## Status

Built and run on **darwin-arm64**. Every check below is from a clean box — no other opencode process running, one stable HOME per binary, runs serialized.

| | |
| --- | --- |
| `--version`, `models` | match the Bun build; `models` returns rc=0 with no rows on an unconfigured HOME, as theirs does |
| TUI | paints, ~500 ms to first frame with the service already up, measured through a pty that answers capability queries |
| Web UI | served from the embedded archive: `/` returns the vite `index.html` and its hashed 511 KB entry chunk resolves |
| Backend | `serve --service` starts, listens, bootstraps 46 migrations |
| Binary | 55.7 MB with the web UI, 48.4 MB without |

### First paint, against the Bun build

**Measure this through a pty that answers the terminal's capability queries.** OpenTUI opens with the usual negotiation — OSC 10/11 colour queries, DA1, cursor-position report, DECRQM, XTGETTCAP, Kitty graphics and keyboard queries — and waits for the replies. A pty that answers nothing makes it wait out its own timeout, which adds roughly a second to both arms and compresses the ratio to about a third of its real size.

The two binaries also use different service ports — theirs `channel=beta` on 49374, this one `channel=local` on 49375 — so a fair cold run has to clear both between rounds. Clearing one leaves that arm's service warm and produces a ratio several times too large in the other direction.

Twelve alternating rounds with both services warm, on a host under heavy build load. `min` and `p25` are the statistics to read: the medians here move by a factor of three with load, and inverted the ordering of two arms in one 7-round run and restored it in the next.

| | min | p25 | median |
| --- | --- | --- | --- |
| this build | 504 ms | 548 ms | 612 ms |
| Bun build | 156 ms | 202 ms | 223 ms |

Cold is paid once per boot, warm on every invocation after. The gap is a roughly fixed cost rather than a multiplier that grows with the work — the same overhead is far larger in relative terms on a bare `--version`, where the workload is nothing.

### One flag from their `execArgv` is not carried: `--use-system-ca`

Their build bakes `--user-agent`, `--use-system-ca` and `--no-warnings` into `execArgv` (`script/build.ts`). This build carries `--no-warnings` and drops `--use-system-ca`, because on Node the flag is not close to free.

Node's macOS reader (`src/crypto/crypto_context.cc`, `ReadMacOSKeychainCertificates`) asks for every certificate in every keychain — `SecItemCopyMatching` with `kSecMatchLimitAll` over `kSecClassCertificate`, not just the roots — and then calls `IsCertificateTrustValid` on each one, which builds an SSL policy and runs a full `SecTrustEvaluateWithError`. That is one `trustd` XPC round trip per certificate, and trust evaluation may attempt AIA/OCSP/CRL fetches, so part of the cost is network. The same mechanism has been reported elsewhere at 8.5–9.8 s on corporate-managed Macs ([anthropics/claude-code#53660](https://github.com/anthropics/claude-code/issues/53660)).

Measured here on node v26.7.0, one binary, `--version`, min of 7:

| | min |
| --- | --- |
| without `--use-system-ca` | 657 ms |
| with `--use-system-ca` | 2892 ms |

The cost is lazy — a hello-world with the flag is 39 ms against 39 ms without — so it lands on the first read of the trust store rather than at startup. That is why it stayed hidden until the whole graph was measured. It also appears to be charged per secure context rather than cached once.

The capability is not lost. `NODE_USE_SYSTEM_CA=1` turns it back on for a single run, which is what anyone behind an enterprise CA needs.

### Testing this app: one HOME, one run at a time

The managed service listens on a fixed port, while the registration file that finds it lives under `HOME`. A fresh `mktemp -d` HOME per run therefore does not isolate anything — each run finds no registration, starts its own service, and collides with the one a previous run left behind. Concurrent runs collide the same way.

The failure is silent from the caller: it polls for 120 s and reports `Timed out waiting for the background service to start`. The real cause, `EADDRINUSE`, appears only in the service's own log under `HOME/.local/share/opencode/log`. Read that log before diagnosing anything about service startup.
