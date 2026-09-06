/**
 * Applies the Solid JSX transform ahead of the bundler, in place.
 *
 * Under Bun this is a bundler plugin: `script/build.ts` passes
 * `createSolidTransformPlugin()` to `Bun.build`, whose `onLoad` hook runs over
 * every `.jsx`/`.tsx` outside `node_modules`. Nub has no plugin hook, so the
 * same pass runs as a separate step — calling `@opentui/solid`'s OWN
 * `transformSolidSource` rather than reimplementing it, so the bundler sees
 * what Bun's plugin would have produced.
 *
 * Solid's `generate: "universal"` output compiles to renderer ops rather than a
 * `jsx()` factory, so no `jsxImportSource` or oxc setting substitutes for it.
 * `@opentui/solid` does ship a `./jsx-runtime`, but it evaluates props eagerly:
 * the TUI would build and then render without reactivity.
 *
 * Idempotent — transformed output has no JSX left, so a second pass is a no-op.
 * The edits are in place, so the caller restores the tree afterwards.
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const JSX = /\.[cm]?[jt]sx$/

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (JSX.test(entry.name)) yield full
  }
}

export async function transformTree(root, roots) {
  // Resolved rather than imported by specifier: the package exports the plugin,
  // not this internal module. It resolves from the package that depends on it —
  // a bun workspace links dependencies per package, not at the root.
  const { createRequire } = await import("node:module")
  const require = createRequire(path.join(root, "packages/tui/package.json"))
  // Anchored on `./bun-plugin`, which the package DOES export and which sits in
  // the same directory. `./package.json` is not in its exports map.
  const entry = require.resolve("@opentui/solid/bun-plugin")
  const module = path.join(path.dirname(entry), "solid-transform.js")
  const { transformSolidSource, resolveNodeSolidRuntimeImport } = await import(pathToFileURL(module).href)

  let count = 0
  for (const dir of roots) {
    for await (const file of walk(path.join(root, dir))) {
      const code = await readFile(file, "utf8")
      const out = await transformSolidSource(code, {
        filename: file,
        moduleName: "@opentui/solid",
        resolvePath: resolveNodeSolidRuntimeImport,
      })
      if (out && out !== code) {
        await writeFile(file, out)
        count++
      }
    }
  }
  return count
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, ...roots] = process.argv.slice(2)
  console.log(`Solid-transformed ${await transformTree(root, roots)} files`)
}
