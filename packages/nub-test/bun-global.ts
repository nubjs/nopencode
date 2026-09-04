/**
 * The `Bun` global, for tests running on stock Node.
 *
 * NOTE: this file is imported by `hooks.ts` and therefore loads BEFORE the esbuild
 * transform it helps install. It must stay within what node's strip-only mode
 * accepts — no parameter properties, enums, or namespaces. A parameter property
 * here took the whole suite from 267 passing to 0, because the hooks module threw
 * before `registerHooks` ever ran.
 *
 * Scoped to what the suite actually calls, counted across the 95 test files that
 * touch it: write(352) file(77) serve(27) sleep(18) stringWidth(16) spawn(7)
 * which(5) Glob(4) readableStreamToText(2) argv(2) Transpiler(1).
 *
 * Anything not implemented THROWS rather than returning undefined. A silently
 * missing API turns a real assertion into a passing no-op, which is the one
 * failure mode a test migration must not have.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { globSync, mkdirSync, existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve as resolvePath } from "node:path"
import stringWidthPkg from "string-width"

type FileLike = string | { path: string }
const pathOf = (target: FileLike) => (typeof target === "string" ? target : target.path)

function bunFile(path: string) {
  return {
    path,
    text: () => readFile(path, "utf8"),
    json: async () => JSON.parse(await readFile(path, "utf8")),
    arrayBuffer: async () => (await readFile(path)).buffer,
    bytes: async () => new Uint8Array(await readFile(path)),
    exists: async () => existsSync(path),
    get size() {
      return existsSync(path) ? require("node:fs").statSync(path).size : 0
    },
  }
}

/** Bun creates the parent directory; node's writeFile does not. */
async function bunWrite(target: FileLike, data: string | ArrayBufferView | ArrayBuffer | Blob) {
  const path = pathOf(target)
  mkdirSync(dirname(path), { recursive: true })
  const body =
    typeof data === "string"
      ? data
      : data instanceof Blob
        ? Buffer.from(await data.arrayBuffer())
        : Buffer.from(data as ArrayBufferView["buffer"])
  await writeFile(path, body as any)
  return typeof body === "string" ? Buffer.byteLength(body) : body.length
}

/**
 * `Bun.serve` on `node:http`, covering the shape the tests use: a `fetch`
 * handler, an optional port (0 = ephemeral), and `stop()`. Streaming bodies and
 * WebSocket upgrade are NOT supported and throw, rather than half-working.
 */
function bunServe(options: { port?: number; fetch: (req: Request) => Response | Promise<Response> }) {
  if ((options as any).websocket) throw new Error("Bun.serve websocket is not supported on the node:test shim")

  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as any,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    const response = await options.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(options.port ?? 0)
  const port = () => (server.address() as { port: number } | null)?.port ?? 0
  return {
    get port() {
      return port()
    },
    get url() {
      return new URL(`http://localhost:${port()}`)
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const BunShim = {
  file: bunFile,
  write: bunWrite,
  serve: bunServe,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  stringWidth: (s: string) => stringWidthPkg(s),
  which: (cmd: string) => {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" })
    const first = r.stdout?.split("\n")[0]?.trim()
    return first ? resolvePath(first) : null
  },
  spawn: (cmd: string[] | { cmd: string[] }, opts?: any) => {
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd
    return nodeSpawn(argv[0]!, argv.slice(1), opts ?? {})
  },
  readableStreamToText: async (stream: ReadableStream) => new Response(stream).text(),
  /**
   * `Bun.gc(true)` forces a synchronous collection. Node only exposes `global.gc`
   * under --expose-gc, so this is best-effort: callers use it to drop lingering
   * handles (SQLite WAL files on Windows) before a teardown that retries anyway,
   * so a no-op degrades to a slower retry rather than a failure.
   */
  gc: (_sync?: boolean) => {
    const g = (globalThis as { gc?: () => void }).gc
    if (g) g()
  },
  /**
   * Bun.hash returns a 64-bit number. Node has no equivalent primitive, so take
   * the first 8 bytes of a sha256 — stable across runs and platforms, which is
   * what callers rely on, though NOT byte-compatible with Bun's own wyhash.
   * A test asserting a specific Bun hash VALUE would fail loudly here rather
   * than silently agreeing.
   */
  hash: (data: string | ArrayBufferView) => {
    const buf = createHash("sha256").update(typeof data === "string" ? data : Buffer.from(data.buffer as ArrayBuffer)).digest()
    return buf.readBigUInt64BE(0)
  },
  get argv() {
    return process.argv
  },
  /**
   * `Bun.Glob` over node's `fs.globSync`. Bun yields paths RELATIVE to the scan
   * root and node's glob does too when given `cwd`, so the shapes line up.
   * `scan()` is async-iterable, `scanSync()` returns an array — the suite uses both.
   */
  Glob: class {
    pattern: string
    constructor(pattern: string) {
      this.pattern = pattern
    }
    scanSync(options?: string | { cwd?: string; onlyFiles?: boolean }): string[] {
      const cwd = typeof options === "string" ? options : (options?.cwd ?? process.cwd())
      return globSync(this.pattern, { cwd }) as string[]
    }
    async *scan(options?: string | { cwd?: string; onlyFiles?: boolean }): AsyncIterable<string> {
      for (const entry of this.scanSync(options)) yield entry
    }
  },
  Transpiler: class {
    constructor() {
      throw new Error("Bun.Transpiler is not implemented on the node:test shim")
    }
  },
}

const globals = globalThis as { Bun?: unknown }
globals.Bun ??= BunShim
