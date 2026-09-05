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
 *
 * The walk has to be layout-agnostic because the platform packages are
 * optionalDependencies of `@opentui/core` that nothing in this repo links
 * directly, and every package manager parks those somewhere different:
 *
 *   npm      node_modules/@opentui/core-darwin-arm64          (hoisted)
 *   bun      node_modules/.bun/<pkg>@<hash>/node_modules/...  (isolated store)
 *   nub/pnpm node_modules/.store/<pkg>@<hash>/node_modules/... (isolated store)
 *
 * Rather than enumerate store names, resolve `@opentui/core` — which IS linked —
 * and walk up from its real path collecting every `node_modules` ancestor. In an
 * isolated store the platform package is a SIBLING inside the same private
 * node_modules, which no amount of looking *inside* the package will find.
 */
export function packageDir(name) {
  const roots = [path.join(dir, "node_modules"), path.join(repo, "node_modules")]

  const core = path.join(dir, "node_modules/@opentui/core")
  if (existsSync(core)) {
    let cursor = realpathSync(core)
    while (cursor !== path.dirname(cursor)) {
      if (path.basename(cursor) === "node_modules") roots.push(cursor)
      cursor = path.dirname(cursor)
    }
  }

  for (const root of roots) {
    const candidate = path.join(root, name)
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate)
  }

  // A package nothing links and that no walk reaches: scan the store directly.
  // Both stores name their entries `<flat-name>@<version>`, so one scan serves.
  for (const store of [path.join(repo, "node_modules/.bun"), path.join(repo, "node_modules/.store")]) {
    if (!existsSync(store)) continue
    const flat = name.replace("/", "+")
    for (const entry of readdirSync(store)) {
      if (entry !== flat && !entry.startsWith(`${flat}@`)) continue
      const candidate = path.join(store, entry, "node_modules", name)
      if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate)
    }
  }

  throw new Error(`cannot locate ${name}; looked under:\n  ${roots.join("\n  ")}`)
}

const NATIVE_FILE = { darwin: "libopentui.dylib", linux: "libopentui.so", win32: "opentui.dll" }

/** Parse `darwin-arm64` / `linux-x64-musl` / `win32-x64` into an OpenTUI target. */
export function parseTarget(triple) {
  const m = /^(darwin|linux|win32)-(arm64|x64)(?:-(musl))?$/.exec(triple)
  if (!m) throw new Error(`unsupported --platform: ${triple}`)
  const [, platform, arch, libc] = m
  if (libc && platform !== "linux") throw new Error(`musl is linux-only, got ${triple}`)
  return { platform, arch, libc }
}

export async function stage(target = path.join(dir, "otui-assets"), triple) {
  // The TARGET's native library, not the build host's. Staging by
  // process.platform would put a .dylib in a linux binary and the TUI would fail
  // on the machine it shipped to, with the build reporting success.
  const { platform, arch, libc } = triple
    ? parseTarget(triple)
    : { platform: process.platform, arch: process.arch, libc: undefined }
  const nativePkg = `@opentui/core-${platform}-${arch}${libc === "musl" ? "-musl" : ""}`
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
  return { target, count: required.length, pkg: nativePkg }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { target, count, pkg } = await stage(undefined, process.argv[2])
  console.log(`Staged ${count} OpenTUI assets for ${pkg} into ${target}`)
}
