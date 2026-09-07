/**
 * The `Bun` global, for the parts of the app that still call it on Node.
 *
 * Three APIs survive in shipped code — `Bun.file`, `Bun.sleep`, `Bun.write` —
 * and every one of them throws `Bun is not defined` under Node. The one that
 * matters is `MigrationOverlay`, whose `onMount` opens with `await
 * Bun.sleep(1_000)`: the overlay mounts on every TUI start, so its poll loop
 * died on every run of the Node build, silently, behind an unhandled rejection.
 *
 * Real Bun always wins — this only fills the global in when it is absent, so a
 * `bun build` of the same source is untouched.
 *
 * `size` is the reason this is a class rather than an object literal. Bun's
 * `BunFile` exposes it synchronously off a lazy stat, and `readFileBounded`
 * reads it before deciding whether to load the file at all; a promise there
 * would change that check's meaning. `slice` has to stay lazy for the same
 * reason — the bound exists so an oversized attachment is never fully read.
 */
import { open, readFile, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"

class NubFile {
  constructor(
    private readonly path: string,
    private readonly start = 0,
    private readonly end?: number,
  ) {}

  /** Bun reports 0 for a file that is not there rather than throwing. */
  get size() {
    let total: number
    try {
      total = statSync(this.path).size
    } catch {
      return 0
    }
    return Math.max(0, Math.min(this.end ?? total, total) - this.start)
  }

  exists() {
    return readFile(this.path, { flag: "r" }).then(
      () => true,
      () => false,
    )
  }

  /** Offsets are relative to this view, matching `Blob.prototype.slice`. */
  slice(start = 0, end?: number) {
    const from = this.start + start
    return new NubFile(this.path, from, end === undefined ? this.end : this.start + end)
  }

  async bytes(): Promise<Buffer> {
    if (this.start === 0 && this.end === undefined) return readFile(this.path)
    const length = this.size
    if (length === 0) return Buffer.alloc(0)
    const handle = await open(this.path, "r")
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, this.start)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async arrayBuffer() {
    const bytes = await this.bytes()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  async text() {
    return (await this.bytes()).toString("utf8")
  }

  async json() {
    return JSON.parse(await this.text())
  }

  async write(data: string | ArrayBufferView | ArrayBuffer) {
    return writeBytes(this.path, data)
  }
}

async function writeBytes(target: string, data: string | ArrayBufferView | ArrayBuffer) {
  const body =
    typeof data === "string"
      ? data
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data)
  await writeFile(target, body)
  return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  Object.defineProperty(globalThis, "Bun", {
    configurable: true,
    value: {
      file: (path: string | URL) => new NubFile(path instanceof URL ? path.pathname : path),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      write: (target: string | NubFile, data: string | ArrayBufferView | ArrayBuffer) =>
        target instanceof NubFile ? target.write(data) : writeBytes(target, data),
    },
  })
}
