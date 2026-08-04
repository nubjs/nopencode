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
 *   compile.execArgv             (no equivalent — see NODE_OPTIONS note below)
 *
 * Run the Solid transform before this script; it is a separate step so a rebuild
 * does not re-walk the tree.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.resolve(dir, "../..")
const modules = path.join(repo, "node_modules/.bun")

const NUB = process.env.NUB ?? "nub"
const MODELS = process.env.OPENCODE_MODELS_JSON ?? "/tmp/oc-models.json"
const OUT = process.env.OUT ?? path.join(dir, "dist-nub/opencode")

const version = process.env.OPENCODE_VERSION ?? "0.0.0-nub"
const platform = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`

/** Resolve a package inside bun's isolated store, whose dirs carry a content hash. */
function pkg(name, subpath = "") {
  const flat = name.replace("/", "+")
  const hit = readdirSync(modules).find((d) => d === flat || d.startsWith(`${flat}@`))
  if (!hit) throw new Error(`not installed: ${name}`)
  return path.join(modules, hit, "node_modules", name, subpath)
}

const solid = pkg("solid-js")

const args = [
  "compile",
  "src/index.ts",
  "--out",
  OUT,
  "--target",
  process.env.NODE_TARGET ?? "26",

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

  // opentui locates its native library, tree-sitter grammars and parser worker
  // through paths it computes at run time, so it has to keep its installed
  // layout rather than be flattened into the bundle.
  "--unbundled",
  "@opentui/core",
  "--unbundled",
  `@opentui/core-${platform}`,
  "--unbundled",
  "web-tree-sitter",

  // opencode's plugin system, provider loader and config loader all import a
  // path the user supplies at run time. Refusing those is the default; this app
  // genuinely needs them.
  ...(process.env.NO_MINIFY ? ["--no-minify"] : []),
  ...(process.env.EXTRA_UNBUNDLED ? process.env.EXTRA_UNBUNDLED.split(",").flatMap((p) => ["--unbundled", p]) : []),
  "--allow-dynamic-import",

  "--define",
  `OPENCODE_VERSION='${version}'`,
  "--define",
  `OPENCODE_CHANNEL='dev'`,
  "--define",
  `OPENCODE_LIBC=''`,
  "--define",
  `FFF_LIBC='gnu'`,
  "--define-file",
  `OPENCODE_MODELS_DEV=${MODELS}`,
]

if (!existsSync(MODELS)) throw new Error(`missing models snapshot: ${MODELS} (curl https://models.dev/api.json)`)

console.log(`${NUB} ${args.join(" ")}`)
const result = spawnSync(NUB, args, { cwd: dir, stdio: "inherit" })
process.exit(result.status ?? 1)
