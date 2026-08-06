/**
 * The two resolver/loader gaps between Bun and stock Node, for the test runner.
 *
 * Registered together because a suite hits both on the first import and fixing
 * only one just moves the error. Measured on `packages/core`, whose Bun baseline
 * is 1080 passing tests across 142 files:
 *
 *   node --test alone .................. 23 pass  (139 × ERR_MODULE_NOT_FOUND)
 *   + resolve hook ..................... 71 pass  (112 × ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)
 *   + load hook ........................ see below
 *
 * 1. EXTENSIONLESS IMPORTS. Bun resolves `./agent` to `./agent.ts`; Node's ESM
 *    resolver requires the extension and no longer has a flag for it.
 * 2. NON-ERASABLE TYPESCRIPT. Node strips types but refuses syntax that needs
 *    real compilation — "TypeScript parameter property is not supported in
 *    strip-only mode". esbuild compiles it.
 *
 * `module.registerHooks` is synchronous and in-thread, so this needs no loader
 * worker — which matters, because nub's own preload (which would also solve both)
 * deadlocks under `node --test`, where every file runs in a child process.
 */
import { registerHooks } from "node:module"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { transformSync } from "esbuild"
import { transformSync as babelTransformSync } from "@babel/core"
import solidPreset from "babel-preset-solid"
import tsPreset from "@babel/preset-typescript"
// Installs the `Bun` global as a side effect. Imported here so a test file needs
// no change: the same --import that fixes resolution also provides the global.
import "./bun-global.ts"

/** Tried in order, matching what a Bun-authored relative import can mean. */
const CANDIDATES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
const TS = /\.[cm]?tsx?$/
const TEXT_ASSET = /\.(txt|sql|prompt|md)$/
/** solid-js's and solid-js/store's SSR builds — see the redirect in `resolve`. */
const SOLID_SSR = /\/node_modules\/solid-js\/(store\/)?dist\/server\.js$/
const SOLID_STORE = /\/solid-js\/store\/dist\/server\.js$/

/**
 * Resolve symlinks before handing a URL back.
 *
 * Node keys its module cache on the resolved URL, so two spellings of one file
 * become two module instances. Under a workspace store that is not academic:
 * `effect-sqlite/driver.ts` was instantiated 252 times and the resolver spun at
 * ~425 calls/sec forever, loading nothing new — a cycle that could never close
 * because each traversal minted a fresh URL. Canonicalising makes one file one
 * module, which is what closes it.
 */
function canonical(path: string): string {
  return pathToFileURL(realpathSync(path)).href
}

function resolveExtensionless(specifier: string, parentURL: string | undefined): string | null {
  if (!specifier.startsWith(".") || !parentURL) return null

  // TypeScript's NodeNext convention: source says `./plugin.js`, disk holds
  // `plugin.ts`. Bun resolves that natively; Node looks for the .js and fails.
  // Only remap when the written file is genuinely absent and the TS sibling is
  // there, so a real .js next to a .ts still wins.
  const js = /\.([cm]?)js(x?)$/.exec(specifier)
  if (js) {
    const asTs = specifier.replace(/\.([cm]?)js(x?)$/, `.$1ts$2`)
    const tsPath = fileURLToPath(new URL(asTs, parentURL))
    if (!existsSync(fileURLToPath(new URL(specifier, parentURL))) && existsSync(tsPath)) {
      return canonical(tsPath)
    }
    return null
  }
  if (/\.[cm]?[jt]sx?$/.test(specifier)) return null

  const base = new URL(specifier, parentURL)
  const path = fileURLToPath(base)

  for (const ext of CANDIDATES) {
    if (existsSync(path + ext)) return canonical(path + ext)
  }
  // A directory import means its index file, as under Bun and CommonJS.
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const ext of CANDIDATES) {
      if (existsSync(`${path}/index${ext}`)) return canonical(`${path}/index${ext}`)
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `import { $ } from "bun"` — the module, distinct from the `Bun` global.
    // 44 files use it, essentially all for the shell API.
    if (specifier === "bun") {
      return { url: new URL("./bun-module.ts", import.meta.url).href, shortCircuit: true }
    }
    // `bun:sqlite` needs a real shim, not a rename: the suite imports `{ Database }`
    // and node:sqlite exports `DatabaseSync`, plus the options and method names
    // differ. See bun-sqlite.ts.
    if (specifier === "bun:sqlite") {
      return { url: new URL("./bun-sqlite.ts", import.meta.url).href, shortCircuit: true }
    }
    const found = resolveExtensionless(specifier, context.parentURL)
    if (found) return { url: found, shortCircuit: true }
    try {
      const resolved = nextResolve(specifier, context)
      // Solid's exports map sends every non-browser runtime to its SSR build —
      // node and Bun resolve `solid-js` identically, both to `dist/server.js`,
      // which throws "getContextId cannot be used under non-hydrating context"
      // as soon as a component mounts. A TUI is a client renderer, so redirect
      // to the client build the way OpenTUI's own Bun plugin does.
      //
      // In RESOLVE, not by swapping the file's contents at the SSR url: the two
      // entries of `@opentui/solid` disagree about the specifier — the Bun one
      // imports `solid-js`, the node one `solid-js/dist/solid.js` — so a content
      // swap leaves node with TWO module instances of solid, app code on one and
      // the renderer on the other. Solid's context registry is per-instance, so
      // the symptom is a bare "No renderer found". Rewriting the url merges them.
      //
      // Narrower than `--conditions=browser`, which would redirect every other
      // package that branches on `browser` too.
      if (SOLID_SSR.test(resolved.url)) {
        return { ...resolved, url: resolved.url.replace(/server\.js$/, SOLID_STORE.test(resolved.url) ? "store.js" : "solid.js") }
      }
      return resolved
    } catch (err: any) {
      // A BARE specifier can be extensionless too — a package subpath like
      // `@parcel/watcher/wrapper`, which Bun resolves and Node does not. Retrying
      // with an extension is only reached once Node has genuinely failed, so it
      // costs nothing on the normal path and never masks a different error.
      if (err?.code !== "ERR_MODULE_NOT_FOUND" || /\.[cm]?[jt]sx?$/.test(specifier)) throw err
      for (const ext of [...CANDIDATES, ...CANDIDATES.map((e) => `/index${e}`)]) {
        try {
          const candidate = nextResolve(specifier + ext, context)
          // An exports wildcard will happily map `.js` onto a path that does not
          // exist, so resolution succeeding is not enough — check the file is real
          // before accepting it, or the failure just moves to load time.
          if (candidate.url.startsWith("file:") && !existsSync(fileURLToPath(candidate.url))) continue
          return candidate
        } catch {}
      }
      throw err
    }
  },

  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context)
    const pathname = new URL(url).pathname


    // Bun imports text assets as a default-exported string. Node has no loader
    // for them, so the suite dies on `Unknown file extension ".txt"`. Measured in
    // the source: .txt(36) .sql(10) .prompt(3) .md(1) — prompts and SQL, all read
    // as text. `.wasm` is deliberately NOT here: it is bytes, not a string, and a
    // wrong guess would be worse than the honest error.
    if (TEXT_ASSET.test(pathname)) {
      const text = readFileSync(fileURLToPath(url), "utf8")
      return {
        format: "module",
        source: `export default ${JSON.stringify(text)}`,
        shortCircuit: true,
      }
    }

    // Bun's `with { type: "file" }` yields the asset's absolute PATH as the
    // default export, not its contents — the TUI imports three .mp3 files that
    // way and passes the path to a player. Node has no such attribute, so it
    // reaches the extension check and dies on `Unknown file extension ".mp3"`.
    // Keyed on the ATTRIBUTE rather than the extension: it is what the author
    // wrote, so an asset type nobody declared still fails honestly.
    if ((context as { importAttributes?: { type?: string } }).importAttributes?.type === "file") {
      return {
        format: "module",
        source: `export default ${JSON.stringify(fileURLToPath(url))}`,
        shortCircuit: true,
      }
    }

    if (!TS.test(pathname)) return nextLoad(url, context)
    // Read the file DIRECTLY rather than delegating. Calling `nextLoad` here —
    // even just to get the source — re-enters the loader and the process wedges:
    // a single 38-import barrel never finished in 15 minutes, with the event loop
    // blocked hard enough that a timer set for 60s never fired. With this hook
    // removed the same import fails in under a second, which is what localised it.
    const path = fileURLToPath(url)
    const source = readFileSync(path, "utf8")

    // SolidJS JSX is a compile-to-renderer-ops pass, not a `jsx()` factory
    // rewrite, so esbuild cannot produce it — no jsxImportSource or jsx setting
    // substitutes. Bun does it with a plugin whose node entry deliberately throws
    // ("@opentui/solid/preload is Bun-only"), so a suite whose JSX is Solid needs
    // this or it cannot run on node at all.
    //
    // Opt-in via NUB_TEST_SOLID because applying it to non-Solid JSX would
    // silently produce wrong output rather than an error.
    if (process.env.NUB_TEST_SOLID && /\.[jt]sx$/.test(path) && !path.includes("node_modules")) {
      const out = babelTransformSync(source, {
        filename: path,
        configFile: false,
        babelrc: false,
        sourceMaps: "inline",
        presets: [
          [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }],
          [tsPreset, { isTSX: true, allExtensions: true }],
        ],
      })
      return { format: "module", source: out?.code ?? source, shortCircuit: true }
    }

    const { code } = transformSync(source, {
      loader: path.endsWith("x") ? "tsx" : "ts",
      format: "esm",
      target: "node22",
      sourcefile: path,
      sourcemap: "inline",
      // `import.meta.dir` is Bun-only; node spells it `dirname`. The suite's own
      // bun test preload uses it, so without this the preload cannot even load.
      define: { "import.meta.dir": "import.meta.dirname" },
    })
    return { format: "module", source: code, shortCircuit: true }
  },
})
