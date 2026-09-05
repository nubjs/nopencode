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
import { dirname, join, resolve } from "node:path"
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
const TEXT_ASSET = /\.(txt|sql|prompt|md|css)$/
/**
 * The SSR build of solid-js and of its two subpath entries — see the redirect in
 * `resolve`. Each ships its client build beside `server.js` under a different
 * name, so the captured subpath names the replacement.
 */
const SOLID_SSR = /\/node_modules\/solid-js\/(?:(store|web)\/)?dist\/server\.js$/
const SOLID_CLIENT: Record<string, string> = { "": "solid.js", store: "store.js", web: "web.js" }
/** "universal" for OpenTUI, "dom" for the browser renderer — see the load hook. */
const SOLID_MODE = process.env["NUB_TEST_SOLID"]

/**
 * Path suffixes whose `export * as X from "…"` should become a mutable object.
 *
 * A module namespace is non-extensible with non-configurable properties, so
 * `spyOn(Npm, "add")` fails with "Cannot redefine property"; Bun relaxes the
 * rule for mocking and node does not. Rewriting the re-export into a Proxy over
 * an ordinary object fixes that, at the cost of the module no longer being a
 * real namespace.
 *
 * So it is opt-in and NAMED, not applied to the idiom at large: 389 modules in
 * this workspace use `export * as`, and exactly two are ever spied on. Turning
 * it on everywhere would trade 48 assertions for a semantic change in every
 * module the suite loads.
 */
const SPYABLE = (process.env["NUB_TEST_SPYABLE"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

/**
 * `export * as X from "spec"` -> a live, WRITABLE view of the same namespace.
 *
 * Reads fall through to the namespace, writes land on the proxy's own target, so
 * a spy shadows the export while every unspied name still tracks the module. The
 * target is an ordinary empty object rather than the namespace itself: a proxy
 * may not report a non-configurable target property as configurable, so wrapping
 * the namespace directly would throw the moment `spyOn` looked at it.
 *
 * Everything is lazy. At the point this runs the module is still evaluating, so
 * reading a binding eagerly would hit its temporal dead zone.
 *
 * The result is exported under an alias rather than as `export const X`, because
 * `export * as X` creates no LOCAL binding — and `packages/opencode/src/config/tui.ts`
 * re-exports itself as `TuiConfig` while also importing a different `TuiConfig`,
 * so a local const of that name is a redeclaration.
 */
function mutableNamespaces(source: string): string {
  return source.replace(/^export \* as (\w+) from ("[^"]+"|'[^']+')/gm, (_all, name, spec) => {
    const ns = `__ns_${name}`
    const overlay = `__ov_${name}`
    return (
      `import * as ${ns} from ${spec}\n` +
      `const ${overlay}: Record<string | symbol, unknown> = {}\n` +
      `const __exp_${name}: any = new Proxy(${overlay}, {\n` +
      `  get: (t, k, r) => (k in t ? Reflect.get(t, k, r) : (${ns} as any)[k]),\n` +
      `  has: (t, k) => k in t || k in ${ns},\n` +
      `  ownKeys: (t) => Array.from(new Set([...Reflect.ownKeys(t), ...Object.keys(${ns})])),\n` +
      `  getOwnPropertyDescriptor: (t, k) =>\n` +
      `    Reflect.getOwnPropertyDescriptor(t, k) ??\n` +
      `    (k in ${ns} ? { value: (${ns} as any)[k], writable: true, enumerable: true, configurable: true } : undefined),\n` +
      `})\n` +
      `export { __exp_${name} as ${name} }`
    )
  })
}

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

/**
 * Accept `path` as written, or with any extension a Bun-authored import can omit.
 *
 * Shared by the relative resolver and the tsconfig-paths one because both mean
 * the same thing by "this file": the extension sweep, then a directory's index.
 *
 * `exact` is off for relative imports, and that is load-bearing rather than an
 * optimisation. A path may arrive carrying a query — `./config.ts?channel=beta`
 * is how one suite asks for three independent instances of one module — and
 * accepting the bare file here would canonicalise the query away and hand all
 * three the same instance. Node keys on the full URL, so leaving those to it
 * keeps them distinct.
 */
function tryCandidates(path: string, exact = false): string | null {
  if (exact && existsSync(path) && statSync(path).isFile()) return canonical(path)
  for (const ext of CANDIDATES) {
    if (existsSync(path + ext)) return canonical(path + ext)
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const ext of CANDIDATES) {
      if (existsSync(`${path}/index${ext}`)) return canonical(`${path}/index${ext}`)
    }
  }
  return null
}

/**
 * Parse a tsconfig, which is JSONC.
 *
 * Comment stripping has to be string-aware rather than a regex: every tsconfig
 * here opens with a `"$schema": "https://…"` whose `//` a naive strip would eat,
 * taking the rest of the line — and the file — with it.
 */
function parseJsonc(text: string): unknown {
  let out = ""
  const commas: number[] = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const d = text[i + 1]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && d === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    if (c === ",") commas.push(out.length)
    out += c
  }
  // Trailing commas, dropped only at the recorded positions — a comma inside a
  // string is never a candidate, so no path value can be corrupted by this.
  let cleaned = ""
  let cursor = 0
  for (const at of commas) {
    let j = at + 1
    while (j < out.length && /\s/.test(out[j]!)) j++
    if (out[j] !== "}" && out[j] !== "]") continue
    cleaned += out.slice(cursor, at)
    cursor = at + 1
  }
  return JSON.parse(cleaned + out.slice(cursor))
}

type PathMap = { base: string; paths: Record<string, string[]> }
const TSCONFIG_PATHS = new Map<string, PathMap | null>()

/**
 * The `compilerOptions.paths` map governing a file, or null.
 *
 * Bun applies tsconfig path aliases; Node has no notion of them, which is what
 * `@/config` and `~/util` fail on — node reports them as a missing PACKAGE,
 * since `@/config` is a well-formed scoped name. Six tsconfigs in this workspace
 * declare a map, and the packages behind them are most of the suite.
 *
 * Nearest config wins and the walk stops there, matching how tsc is actually
 * invoked: one config governs a project. The `extends` chain is not chased —
 * every map here is declared locally, and a base config that added one would
 * apply to packages that never opted in.
 *
 * Targets resolve against the config's own directory, which is what TypeScript
 * does when `baseUrl` is absent (allowed since 4.1, and none of these set one).
 */
function nearestPaths(fromDir: string): PathMap | null {
  const cached = TSCONFIG_PATHS.get(fromDir)
  if (cached !== undefined) return cached
  let found: PathMap | null = null
  let dir = fromDir
  while (dir !== dirname(dir)) {
    const file = join(dir, "tsconfig.json")
    if (existsSync(file)) {
      try {
        const config = parseJsonc(readFileSync(file, "utf8")) as {
          compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string }
        }
        const paths = config.compilerOptions?.paths
        // A config with no map still ENDS the walk: it is this project's config,
        // and an ancestor's aliases are not in scope for it.
        if (paths) found = { base: resolve(dir, config.compilerOptions?.baseUrl ?? "."), paths }
      } catch {
        // A config we cannot read is not a resolution error — leave the
        // specifier to node and let it report the honest failure.
      }
      break
    }
    dir = dirname(dir)
  }
  TSCONFIG_PATHS.set(fromDir, found)
  return found
}

function resolveTsconfigPaths(specifier: string, parentURL: string | undefined): string | null {
  if (!parentURL?.startsWith("file:")) return null
  const map = nearestPaths(dirname(fileURLToPath(parentURL)))
  if (!map) return null

  // TypeScript's own precedence: an exact key beats a wildcard, and among
  // wildcards the longest literal prefix wins.
  let best: { targets: string[]; captured: string } | null = null
  let bestPrefix = -1
  for (const [key, targets] of Object.entries(map.paths)) {
    const star = key.indexOf("*")
    if (star === -1) {
      if (key === specifier) {
        best = { targets, captured: "" }
        break
      }
      continue
    }
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
    if (specifier.length < prefix.length + suffix.length || prefix.length <= bestPrefix) continue
    bestPrefix = prefix.length
    best = { targets, captured: specifier.slice(prefix.length, specifier.length - suffix.length) }
  }
  if (!best) return null

  for (const target of best.targets) {
    const hit = tryCandidates(resolve(map.base, target.replace("*", best.captured)), true)
    if (hit) return hit
  }
  return null
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

  // A directory import means its index file, as under Bun and CommonJS.
  return tryCandidates(fileURLToPath(new URL(specifier, parentURL)))
}

/**
 * The same two `import.meta` Bun-isms the esbuild pass defines, as a babel
 * plugin — because the Solid branch returns before that pass ever runs, so a
 * `.tsx` file read `import.meta.env.VITE_*` off `undefined` while the `.ts`
 * beside it worked. A plugin rather than a second esbuild pass: babel has
 * already written an inline sourcemap, and esbuild's transform API cannot chain
 * one, so a second pass would trade the stack traces for the substitution.
 */
const importMetaBunisms = {
  visitor: {
    MemberExpression(nodePath: any) {
      const node = nodePath.node
      if (node.object?.type !== "MetaProperty" || node.computed) return
      if (node.property?.name === "dir") node.property.name = "dirname"
      else if (node.property?.name === "env") nodePath.replaceWithSourceString("process.env")
    },
  },
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
    // The one specifier whose node arm is a thrown error rather than an
    // implementation. Aliased the same way `script/build-nub.mjs` aliases it for
    // the compiled binary, because otherwise importing it kills the file.
    if (specifier === "@opentui/solid/runtime-plugin-support/configure") {
      return { url: new URL("./opentui-runtime-plugin-noop.ts", import.meta.url).href, shortCircuit: true }
    }

    // Before node_modules, which is the precedence tsc and Bun both use: an
    // alias is meant to shadow a package of the same name, not lose to one.
    if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":")) {
      const aliased = resolveTsconfigPaths(specifier, context.parentURL)
      if (aliased) return { url: aliased, shortCircuit: true }
    }
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
      const ssr = SOLID_SSR.exec(resolved.url)
      if (ssr) {
        return { ...resolved, url: resolved.url.replace(/server\.js$/, SOLID_CLIENT[ssr[1] ?? ""]!) }
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
    // as text. `.css` rides along: every stylesheet here is a bare side-effect
    // import that a component pulls in for the bundler, so the text is unread and
    // only the module existing matters. `.wasm` is deliberately NOT here: it is
    // bytes, not a string, and a wrong guess would be worse than the honest error.
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

    // `.jsx` is ours only when a Solid mode is on. Under `--conditions=solid`
    // the Solid libraries resolve to their untransformed source — that is the
    // whole point of the condition — so the consumer is expected to compile it.
    if (!TS.test(pathname) && !(SOLID_MODE && pathname.endsWith(".jsx"))) return nextLoad(url, context)
    // Read the file DIRECTLY rather than delegating. Calling `nextLoad` here —
    // even just to get the source — re-enters the loader and the process wedges:
    // a single 38-import barrel never finished in 15 minutes, with the event loop
    // blocked hard enough that a timer set for 60s never fired. With this hook
    // removed the same import fails in under a second, which is what localised it.
    const path = fileURLToPath(url)
    let source = readFileSync(path, "utf8")
    if (SPYABLE.some((suffix) => path.endsWith(suffix))) source = mutableNamespaces(source)

    // SolidJS JSX is a compile-to-renderer-ops pass, not a `jsx()` factory
    // rewrite, so esbuild cannot produce it — no jsxImportSource or jsx setting
    // substitutes. Bun does it with a plugin whose node entry deliberately throws
    // ("@opentui/solid/preload is Bun-only"), so a suite whose JSX is Solid needs
    // this or it cannot run on node at all.
    //
    // Opt-in per suite via NUB_TEST_SOLID, because the two renderers need
    // different output and applying either to non-Solid JSX would produce wrong
    // code rather than an error. `universal` drives OpenTUI's renderer for the
    // TUI; `dom` is the browser renderer the app uses, and it is the only mode
    // that also compiles node_modules — a DOM Solid library ships JSX source
    // under the `solid` export condition precisely so its consumer compiles it.
    if (SOLID_MODE && /\.[jt]sx$/.test(path) && (SOLID_MODE === "dom" || !path.includes("node_modules"))) {
      const out = babelTransformSync(source, {
        filename: path,
        configFile: false,
        babelrc: false,
        sourceMaps: "inline",
        plugins: [importMetaBunisms],
        presets: [
          SOLID_MODE === "universal" ? [solidPreset, { moduleName: "@opentui/solid", generate: "universal" }] : [solidPreset],
          ...(path.endsWith(".tsx") ? [[tsPreset, { isTSX: true, allExtensions: true }] as const] : []),
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
      // Two Bun-isms node does not have. `import.meta.dir` is node's `dirname`,
      // and the suite's own bun test preload uses it, so without it the preload
      // cannot even load. `import.meta.env` is Bun's alias for `process.env`,
      // which is also what Vite's app code reads for its VITE_* build settings.
      define: { "import.meta.dir": "import.meta.dirname", "import.meta.env": "process.env" },
    })
    return { format: "module", source: code, shortCircuit: true }
  },
})
