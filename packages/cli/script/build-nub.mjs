/**
 * Builds the CLI into a standalone executable with `nub compile`, on stock Node.
 *
 * `script/build.ts` does this with `Bun.build` plus four bundler plugins. Nub
 * has no plugin hook, so the same work happens as explicit steps here: the
 * Solid transform runs ahead of the bundler, the assets Bun would discover
 * through its virtual filesystem are staged and embedded with `--include`, and
 * the Solid runtime is aliased past its `node` export condition.
 *
 * The transform edits `.tsx` in place, so the tree is always restored before
 * this exits. Transformed files must never be committed.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(cli, "../..")
const nub = process.env.NUB_BIN ?? "nub"
const out = process.env.OUT ?? path.join(cli, "dist-nub", "opencode")

const run = (file, args, cwd) => execFileSync(file, args, { cwd, stdio: "inherit" })
const bunStore = (name) => {
  // The workspace installs through bun, which keeps one real copy per version
  // under `.bun` and links to it. `--include` embeds a path byte for byte and
  // does not follow a link out of the tree, so the real copy is staged in.
  const base = path.join(root, "node_modules", ".bun")
  const dirs = execFileSync("ls", [base], { encoding: "utf8" }).split("\n")
  const hit = dirs.find((dir) => dir.startsWith(`${name.replace("/", "+")}@`))
  if (hit === undefined) throw new Error(`not installed: ${name}`)
  return path.join(base, hit, "node_modules", name)
}

/**
 * Assets the app reaches through a specifier it builds at run time. Bun's
 * compiler discovers these and embeds them; a bundler cannot see them at all,
 * so each one is named here. The list mirrors `script/node-assets.ts`, which is
 * where their own Node target solves the same problem.
 */
const staged = [
  ["@opencode-ai/ui", path.join(root, "packages/ui"), ["package.json", "src/assets/audio"]],
  ["tree-sitter-bash", bunStore("tree-sitter-bash")],
  ["tree-sitter-powershell", bunStore("tree-sitter-powershell")],
  ["@parcel/watcher-darwin-arm64", bunStore("@parcel/watcher-darwin-arm64")],
  ["@lydell/node-pty-darwin-arm64", bunStore("@lydell/node-pty-darwin-arm64")],
  ["@ff-labs/fff-bin-darwin-arm64", bunStore("@ff-labs/fff-bin-darwin-arm64")],
  ["@yuuang/ffi-rs-darwin-arm64", bunStore("@yuuang/ffi-rs-darwin-arm64")],
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

const solid = bunStore("solid-js")
mkdirSync(path.dirname(out), { recursive: true })

run("node", [path.join(cli, "script/nub-solid-transform.mjs"), root, "packages/tui/src", "packages/cli/src"], root)
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
      // Only their vite build can produce the embedded web UI. `load` treats a
      // zero-length archive as "not embedded" and falls through, so the TUI
      // starts without it rather than failing on it.
      "--alias",
      `virtual:opencode-app-assets=${path.join(cli, "src/nub/app-assets-empty.ts")}`,
      // Solid's `node` export condition points at its SERVER build, which has no
      // reactive context — the TUI renders its first frame and then throws
      // "Theme context must be used within a context provider". Their bun plugin
      // rewrites the same two specifiers (`resolveNodeSolidRuntimeImport`).
      "--alias",
      `solid-js=${path.join(solid, "dist/solid.js")}`,
      "--alias",
      `solid-js/store=${path.join(solid, "store/dist/store.js")}`,
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
      "--node-options",
      "--use-system-ca --disable-warning=ExperimentalWarning",
      "--external",
      "node-gyp",
      "--allow-dynamic-import",
    ],
    cli,
  )
} finally {
  run("git", ["checkout", "--", "packages/tui/src", "packages/cli/src"], root)
}

if (!existsSync(out)) throw new Error(`nub compile produced no binary at ${out}`)
console.log(`\nbuilt ${out}`)
