/**
 * Points OpenTUI at the assets staged inside the compiled binary.
 *
 * OpenTUI resolves its native library, tree-sitter parser worker and grammar
 * files through `import()` calls whose specifiers it builds at run time — which
 * a bundler cannot follow, and which a compiled binary has no `node_modules` to
 * satisfy. `OTUI_ASSET_ROOT` is the package's own escape hatch: an absolute
 * directory it consults first, keyed `<package>/<file>`.
 *
 * `script/stage-otui-assets.mjs` builds that directory and `--include` embeds it
 * beside the compiled entry, so `import.meta.dirname` here IS the extraction
 * directory. Must be imported before anything touches OpenTUI, which is why it
 * sits at the top of both compiled roots.
 *
 * Set by the user, an existing value wins — someone pointing at their own build
 * of the native library is doing so deliberately.
 */
import { existsSync } from "node:fs"
import path from "node:path"

if (!process.env.OTUI_ASSET_ROOT) {
  // Walked, not joined: `--include` keeps an embedded path's source-tree layout,
  // so including a sibling of `src/` re-roots the extraction one level up and the
  // entry lands in `<extraction>/src/`. Which level holds the staged directory
  // therefore depends on what else the binary embeds.
  let base = import.meta.dirname
  for (let up = 0; up < 4; up++) {
    const staged = path.join(base, "otui-assets")
    if (existsSync(staged)) {
      process.env.OTUI_ASSET_ROOT = staged
      break
    }
    const parent = path.dirname(base)
    if (parent === base) break
    base = parent
  }
}

export {}
