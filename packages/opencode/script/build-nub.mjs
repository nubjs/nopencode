/**
 * Builds the opencode CLI as a `nub compile` standalone executable.
 *
 * The Bun equivalent is `script/build.ts` (`Bun.build` with a `compile` block).
 * The mapping, flag for flag:
 *
 *   Bun                          nub compile
 *   ---------------------------  ---------------------------------------------
 *   conditions: ["bun","node"]   (default set; `bun` deliberately NOT added)
 *   plugins: [solidPlugin]       script/nub-solid-transform.mjs, run first
 *   external: ["node-gyp"]       --external node-gyp
 *   define: {...}                --define / --define-file
 *   files: { virtual modules }   real files + --alias
 *   entrypoints: [main, worker]  the worker is a literal `new Worker(new URL())`
 *   minify: true                 default
 *   compile.execArgv             --node-options
 *
 * Run the Solid transform before this script; it is a separate step so a rebuild
 * does not re-walk the tree.
 */
import { spawnSync } from "node:child_process"
import { packageDir, stage as stageOtuiAssets } from "./stage-otui-assets.mjs"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.resolve(dir, "../..")

const NUB = process.env.NUB ?? "nub"
const MODELS = process.env.OPENCODE_MODELS_JSON ?? "/tmp/oc-models.json"
const OUT = process.env.OUT ?? path.join(dir, "dist-nub/opencode")

const version = process.env.OPENCODE_VERSION ?? "0.0.0-nub"
// PLATFORM selects the target triple; unset means this machine. Everything
// downstream — the staged OpenTUI native library, the libc defines — follows it
// rather than the build host, or a cross-build ships the wrong machine code and
// only fails when someone runs it.
const platform = process.env.PLATFORM ?? `${process.platform}-${process.arch}`
const [targetOs, , targetLibc] = platform.split("-")

/**
 * Resolve a package directory whatever laid out node_modules.
 *
 * Shared with the asset staging rather than duplicated, because the two used to
 * disagree: this one read `node_modules/.bun` directly, so the build worked
 * after `bun install` and failed after `nub install` — which links packages into
 * each workspace member and keeps its store somewhere else entirely.
 */
const pkg = (name, subpath = "") => path.join(packageDir(name), subpath)

const solid = pkg("solid-js")

const args = [
  "compile",
  "src/index.ts",
  "--out",
  OUT,
  // A full version, not the bare major. `--target 26` resolves to a different
  // patch in each shape — 26.6.0 embedded, 26.0.0 under --smol — and the TUI
  // needs the newer one: on 26.0.0 OpenTUI cannot bring up its native backend
  // and dies with "OpenTUI native FFI is not available for this runtime yet".
  "--target",
  process.env.NODE_TARGET ?? "26.6.0",
  ...(process.env.PLATFORM ? ["--platform", platform] : []),
  ...(process.env.SMOL ? ["--smol"] : []),

  // node-gyp is only reached by a build-time codepath in a dependency.
  "--external",
  "node-gyp",

  // solid-js maps the `node` condition to its SSR build (dist/server.js), which
  // has no reactive runtime. Bun's build patches this in the plugin's onLoad;
  // here the two entry points are aliased to the client builds directly. Doing
  // it with `--conditions browser` would also work but flips every other
  // dependency's browser arm on at the same time.
  "--alias",
  `solid-js=${path.join(solid, "dist/solid.js")}`,
  "--alias",
  `solid-js/store=${path.join(solid, "store/dist/store.js")}`,

  // Bun injects this module through its in-memory `files:` map. It only exists
  // when the web UI is embedded, and the consumer already catches its absence.
  "--alias",
  `opencode-web-ui.gen.ts=${path.join(dir, "src/nub/web-ui-empty.ts")}`,

  // @opentui/solid's runtime plugin host is Bun-only and its node arm throws at
  // module scope, so the import itself is fatal. See the stub for what is lost.
  "--alias",
  `@opentui/solid/runtime-plugin-support/configure=${path.join(dir, "src/nub/runtime-plugin-support-noop.ts")}`,

  // opentui locates its native library, tree-sitter grammars and parser worker
  // through paths it computes at run time, so it has to keep its installed
  // layout rather than be flattened into the bundle.
  "--unbundled",
  "@opentui/core",
  "--unbundled",
  "web-tree-sitter",

  // opencode's plugin system, provider loader and config loader all import a
  // path the user supplies at run time. Refusing those is the default; this app
  // genuinely needs them.
  ...(process.env.NO_MINIFY ? ["--no-minify"] : []),
  ...(process.env.EXTRA_UNBUNDLED ? process.env.EXTRA_UNBUNDLED.split(",").flatMap((p) => ["--unbundled", p]) : []),
  // The staged OpenTUI asset root (see script/stage-otui-assets.mjs).
  "--include",
  "otui-assets",

  "--allow-dynamic-import",

  "--define",
  `OPENCODE_VERSION='${version}'`,
  "--define",
  `OPENCODE_CHANNEL='dev'`,
  "--define",
  `OPENCODE_LIBC='${targetOs === "linux" ? (targetLibc === "musl" ? "musl" : "glibc") : ""}'`,
  "--define",
  `FFF_LIBC='${targetLibc === "musl" ? "musl" : "gnu"}'`,
  "--define-file",
  `OPENCODE_MODELS_DEV=${MODELS}`,
]

const staged = await stageOtuiAssets(path.join(dir, "otui-assets"), platform)
console.log(`Staged ${staged.count} OpenTUI assets for ${staged.pkg}`)

if (!existsSync(MODELS)) throw new Error(`missing models snapshot: ${MODELS} (curl https://models.dev/api.json)`)

console.log(`${NUB} ${args.join(" ")}`)
const result = spawnSync(NUB, args, { cwd: dir, stdio: "inherit" })
process.exit(result.status ?? 1)
