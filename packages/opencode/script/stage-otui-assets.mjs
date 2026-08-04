/**
 * Stages the files OpenTUI locates at run time into one directory, keyed exactly
 * as `OTUI_ASSET_ROOT` expects.
 *
 * OpenTUI finds its native library with `await import("@opentui/core-<plat>-<arch>")`
 * — a specifier built from `process.platform`/`process.arch`, so no bundler can
 * see it, and an await no bundler can remove. `OTUI_ASSET_ROOT` is the package's
 * own escape hatch: set it, and every asset resolves by path arithmetic instead,
 * with no import and no await.
 *
 * It is ALL OR NOTHING — with the root set, a missing asset throws rather than
 * falling back — so this stages the whole set: the platform dylib, the
 * tree-sitter parser worker, every bundled grammar and query file, and
 * web-tree-sitter's wasm.
 */
import { cp, mkdir, rm, access } from "node:fs/promises"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.resolve(dir, "../..")

/** Locate a package's directory on disk.
 *
 * Not `require.resolve`: `@opentui/core` and the platform packages both declare
 * an `exports` map with no `./package.json` entry, so the resolver refuses the
 * one path that would tell us where they live. Their layout is not in question
 * — walk to it.
 */
function packageDir(name) {
  const seen = []
  const bases = [path.join(dir, "node_modules"), path.join(repo, "node_modules")]
  const core = path.join(dir, "node_modules/@opentui/core")
  if (existsSync(core)) bases.splice(1, 0, path.join(realpathSync(core), "node_modules"))
  for (const base of bases) {
    const candidate = path.join(base, name)
    seen.push(candidate)
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate)
  }
  // bun's isolated store, for a package nothing links directly.
  const store = path.join(repo, "node_modules/.bun")
  if (existsSync(store)) {
    const flat = name.replace("/", "+")
    for (const entry of readdirSync(store)) {
      if (entry !== flat && !entry.startsWith(`${flat}@`)) continue
      const candidate = path.join(store, entry, "node_modules", name)
      if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate)
    }
  }
  throw new Error(`cannot locate ${name}; looked in:\n  ${seen.join("\n  ")}\n  ${store}/*`)
}

const NATIVE_FILE = { darwin: "libopentui.dylib", linux: "libopentui.so", win32: "opentui.dll" }

export async function stage(target = path.join(dir, "otui-assets")) {
  const platform = process.platform
  const arch = process.arch
  const nativePkg = `@opentui/core-${platform}-${arch}`
  const nativeFile = NATIVE_FILE[platform]
  if (!nativeFile) throw new Error(`unsupported platform ${platform}`)

  await rm(target, { recursive: true, force: true })
  await mkdir(path.join(target, nativePkg), { recursive: true })
  await mkdir(path.join(target, "@opentui/core"), { recursive: true })
  await mkdir(path.join(target, "web-tree-sitter"), { recursive: true })

  const core = packageDir("@opentui/core")
  const native = packageDir(nativePkg)
  const treeSitter = packageDir("web-tree-sitter")

  await cp(path.join(native, nativeFile), path.join(target, nativePkg, nativeFile))
  await cp(path.join(core, "parser.worker.js"), path.join(target, "@opentui/core/parser.worker.js"))
  await cp(path.join(core, "assets"), path.join(target, "@opentui/core/assets"), { recursive: true })
  await cp(path.join(treeSitter, "tree-sitter.wasm"), path.join(target, "web-tree-sitter/tree-sitter.wasm"))

  // The root refuses a missing asset at run time rather than falling back, so
  // check the whole set here instead of finding out inside a rendered frame.
  const required = [
    `${nativePkg}/${nativeFile}`,
    "@opentui/core/parser.worker.js",
    "web-tree-sitter/tree-sitter.wasm",
    ...["javascript", "typescript", "markdown", "markdown_inline", "zig"].flatMap((ft) => [
      `@opentui/core/assets/${ft}/highlights.scm`,
      `@opentui/core/assets/${ft}/tree-sitter-${ft}.wasm`,
    ]),
  ]
  for (const key of required) await access(path.join(target, key))
  return { target, count: required.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { target, count } = await stage()
  console.log(`Staged ${count} OpenTUI assets into ${target}`)
}
