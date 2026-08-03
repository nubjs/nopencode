/**
 * Applies the Solid JSX transform ahead of the bundler, in place.
 *
 * Under Bun this is a bundler plugin: `script/build.ts` passes
 * `createSolidTransformPlugin()` to `Bun.build`, and its `onLoad` hook runs
 * `babel-preset-solid` over every `.jsx`/`.tsx` outside `node_modules`.
 * `nub compile` has no plugin hook, so the same Babel pass runs as a separate
 * step first. Same presets, same options, same file filter as
 * `@opentui/solid/scripts/solid-plugin.js`, so the bundler sees byte-identical
 * input either way.
 *
 * Solid's `generate: "universal"` output is a compile-to-renderer-ops pass, not
 * a `jsx()`-factory rewrite, so no `jsxImportSource` or oxc/SWC setting
 * substitutes for it. `@opentui/solid` does ship a `./jsx-runtime` that the
 * automatic runtime would reach, but it evaluates props eagerly — the TUI would
 * build and then render without reactivity.
 *
 * Idempotent: transformed output has no JSX and no type annotations left, so a
 * second pass is a no-op.
 */
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import ts from "@babel/preset-typescript"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const JSX = /\.[cm]?[jt]sx$/
const MODULE_NAME = "@opentui/solid"

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (JSX.test(entry.name)) yield full
  }
}

export async function transformTree(roots) {
  let count = 0
  for (const root of roots) {
    for await (const file of walk(root)) {
      const code = await readFile(file, "utf8")
      const out = await transformAsync(code, {
        filename: file,
        configFile: false,
        babelrc: false,
        presets: [[solid, { moduleName: MODULE_NAME, generate: "universal" }], [ts]],
      })
      if (out?.code) {
        await writeFile(file, out.code)
        count++
      }
    }
  }
  return count
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2)
  console.log(`Solid-transformed ${await transformTree(roots)} files`)
}
