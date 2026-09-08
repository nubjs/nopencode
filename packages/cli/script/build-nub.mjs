/**
 * Builds the CLI into a standalone executable with `nub compile`, on stock Node.
 *
 * `script/build.ts` does this with `Bun.build` plus four bundler plugins. Nub
 * has no plugin hook, so the same work happens as explicit steps here: the
 * Solid transform runs ahead of the bundler, the assets Bun would discover
 * through its virtual filesystem are staged and embedded with `--include`, the
 * web UI archive is written to a real module and aliased onto the specifier
 * their plugin served, and the Solid runtime is aliased past its `node` export
 * condition.
 *
 * Everything here runs on stock Node, including the vite build behind the web
 * UI archive. Bun is not invoked at any point; where the workspace happens to
 * have been installed by it, only the resulting directory layout is read.
 *
 * The transform edits `.tsx` in place, so the tree is always restored before
 * this exits. Transformed files must never be committed.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildAppArchive, writeArchiveModule } from "./nub-app-archive.mjs"
import { NATIVE, nativePackage } from "./nub-native-packages.mjs"

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(cli, "../..")
const nub = process.env.NUB_BIN ?? "nub"
const out = process.env.OUT ?? path.join(cli, "dist-nub", "opencode")

const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: "inherit" })

/**
 * The REAL directory a dependency's files live in, never a link to it.
 *
 * `--include` embeds a path byte for byte and does not follow a link out of the
 * tree, so a staged copy has to start from the real one. Where that is depends
 * on who installed: bun keeps one copy per version under `node_modules/.bun`
 * and links to it, while a plain hoisted layout puts the files at
 * `node_modules/<name>` directly. Trying the store first and falling back means
 * the build does not require bun to have done the install.
 */
const realPackageDir = (name) => {
  const store = path.join(root, "node_modules", ".bun")
  if (existsSync(store)) {
    const hit = readdirSync(store).find((dir) => dir.startsWith(`${name.replace("/", "+")}@`))
    if (hit !== undefined) return path.join(store, hit, "node_modules", name)
  }
  const hoisted = path.join(root, "node_modules", name)
  if (existsSync(hoisted)) return realpathSync(hoisted)
  throw new Error(`not installed: ${name}`)
}

/**
 * Assets the app reaches through a specifier it builds at run time. Bun's
 * compiler discovers these and embeds them; a bundler cannot see them at all,
 * so each one is named here. The list mirrors `script/node-assets.ts`, which is
 * where their own Node target solves the same problem.
 */
const staged = [
  ["@opencode-ai/ui", path.join(root, "packages/ui"), ["package.json", "src/assets/audio"]],
  ["tree-sitter-bash", realPackageDir("tree-sitter-bash")],
  ["tree-sitter-powershell", realPackageDir("tree-sitter-powershell")],
  ...Object.keys(NATIVE).map((name) => {
    const resolved = nativePackage(name)
    return [resolved, realPackageDir(resolved)]
  }),
]

for (const [name, source, subset] of staged) {
  const dest = path.join(cli, "node_modules", name)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(path.dirname(dest), { recursive: true })
  if (subset === undefined) cpSync(source, dest, { recursive: true, dereference: true })
  else
    for (const entry of subset) {
      mkdirSync(path.dirname(path.join(dest, entry)), { recursive: true })
      cpSync(path.join(source, entry), path.join(dest, entry), { recursive: true, dereference: true })
    }
}

const solid = realPackageDir("solid-js")
mkdirSync(path.dirname(out), { recursive: true })

// Their bundler plugin serves this specifier from memory; nub has no plugin
// hook, so the archive is written to a real module and aliased onto it. Set
// SKIP_WEB_UI=1 to embed an empty asset map instead, which is what their
// --skip-web-ui does.
const appAssets = writeArchiveModule(
  path.join(cli, "dist-nub/app-assets.mjs"),
  await buildAppArchive(root, { skipBuild: process.env.SKIP_WEB_UI === "1" }),
)

// Restoring the whole source tree afterwards would discard any other edit in
// it, so the transform reports exactly which files it wrote and only those come
// back. It cost a real fix once — a source change made during a build was
// reverted by the build's own cleanup, with nothing to say so.
const transformed = execFileSync(
  "node",
  [path.join(cli, "script/nub-solid-transform.mjs"), root, "packages/tui/src", "packages/cli/src"],
  { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
)
  .split("\n")
  .filter(Boolean)

try {
  run(
    nub,
    [
      "compile",
      "src/index.ts",
      "--out",
      out,
      "--target",
      "26.6.0",
      "--alias",
      `virtual:opencode-app-assets=${appAssets}`,
      // Solid's `node` export condition points at its SERVER build, which has no
      // reactive context — the TUI renders its first frame and then throws
      // "Theme context must be used within a context provider". Their bun plugin
      // rewrites the same two specifiers (`resolveNodeSolidRuntimeImport`).
      "--alias",
      `solid-js=${path.join(solid, "dist/solid.js")}`,
      "--alias",
      `solid-js/store=${path.join(solid, "store/dist/store.js")}`,
      // @opentui/core is redundant here and kept deliberately: compile's own
      // detection already ships it unbundled because it declares 8 per-platform
      // binary packages, so a build without this line produces the same 316
      // chunks, the same staged layout and the same timings. It stays as the
      // belt-and-braces for a future version that drops the napi-rs layout and
      // would otherwise be bundled silently. web-tree-sitter is NOT redundant —
      // nothing detects it, and the build reports it as "you asked for it".
      "--unbundled",
      "@opentui/core",
      "--unbundled",
      "web-tree-sitter",
      ...staged.flatMap(([name]) => ["--include", `node_modules/${name}`]),
      // Only the .wasm is reached at run time; the grammars also ship C sources
      // and prebuilt binaries worth 18 MB that nothing here loads.
      "--exclude",
      "node_modules/tree-sitter-*/src/**",
      "--exclude",
      "node_modules/tree-sitter-*/prebuilds/**",
      // Matches the execArgv their bun build bakes in (script/build.ts): the
      // --user-agent flag there is bun's own and has no Node equivalent, so
      // --no-warnings is the whole difference. It also subsumes the narrower
      // --disable-warning=ExperimentalWarning this used to pass, which existed
      // for the --experimental-* flags the artifact needs.
      "--node-options",
      "--use-system-ca --no-warnings",
      "--external",
      "node-gyp",
      "--allow-dynamic-import",
    ],
    cli,
  )
} finally {
  if (transformed.length > 0) run("git", ["checkout", "--", ...transformed], root)
}

if (!existsSync(out)) throw new Error(`nub compile produced no binary at ${out}`)
console.log(`\nbuilt ${out}`)
