/**
 * Builds the embedded web UI archive, on stock Node.
 *
 * `script/app-assets.ts` does this with `Bun.$` and `Bun.file`, and hands the
 * result to a bundler plugin that serves `virtual:opencode-app-assets`. Nub has
 * no plugin hook, so the archive is written to a real module here and aliased
 * onto that specifier instead. The encoding is theirs byte for byte — brotli
 * quality 11 over the sorted JSON map, base64 — because `app-assets.ts` decodes
 * it at run time and would reject anything else.
 *
 * The vite build it drives is plain Node already; only the wrapper needed bun.
 */
import { execFileSync } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { brotliCompressSync, constants } from "node:zlib"

const isText = (key) => key === "_headers" || /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/.test(key)

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(current, entry.name)
      return entry.isDirectory() ? collectFiles(root, target) : [path.relative(root, target)]
    }),
  )
  return nested.flat()
}

export async function buildAppArchive(root, { skipBuild = false, channel = "dev" } = {}) {
  // Theirs returns an empty archive rather than a stale one, and `load` reads a
  // zero-length archive as "not embedded" — so skipping degrades to a TUI with
  // no web UI instead of one serving whatever was last built.
  if (skipBuild) return compress({})
  const app = path.join(root, "packages/app")
  execFileSync(path.join(app, "node_modules/.bin/vite"), ["build"], {
    cwd: app,
    stdio: "inherit",
    env: { ...process.env, OPENCODE_CHANNEL: channel },
  })
  const dist = path.join(app, "dist")
  const keys = (await collectFiles(dist))
    .map((key) => key.replaceAll(path.sep, "/"))
    .filter((key) => !key.endsWith(".map"))
    .toSorted()
  const assets = Object.fromEntries(
    await Promise.all(
      keys.map(async (key) => {
        const body = await readFile(path.join(dist, key))
        const encoding = isText(key) ? "utf8" : "base64"
        return [key, { encoding, content: body.toString(encoding) }]
      }),
    ),
  )
  return compress(assets)
}

function compress(assets) {
  return brotliCompressSync(JSON.stringify(assets), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString("base64")
}

/** Writes the archive as a module the bundler can be pointed at. */
export function writeArchiveModule(target, archive) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `export default ${JSON.stringify(archive)}\n`)
  return target
}

if (import.meta.filename === process.argv[1]) {
  const [root, target, ...rest] = process.argv.slice(2)
  const archive = await buildAppArchive(root, { skipBuild: rest.includes("--skip-build") })
  writeArchiveModule(target, archive)
  console.log(`app archive: ${(archive.length / 1e6).toFixed(1)} MB base64 -> ${target}`)
}
