/**
 * The Bun runtime surface opencode reaches for through the `Bun` global, backed
 * by Node builtins. Imported first from every compiled root (the CLI entry and
 * the TUI worker) so the global exists before any module body runs.
 *
 * Only what the shipped graph actually calls is here — `stringWidth`, `file`,
 * `write`, `stdin`, `hash`. A missing member is better as a TypeError at the
 * call site than as a plausible wrong answer from a guessed implementation.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import stringWidth from "string-width"

function toPath(input: string | URL): string {
  return input instanceof URL ? input.pathname : input
}

const BunFile = (filePath: string | URL) => {
  const resolved = toPath(filePath)
  return {
    async text() {
      return readFile(resolved, "utf8")
    },
    async json() {
      return JSON.parse(await readFile(resolved, "utf8"))
    },
    async arrayBuffer() {
      const buf = await readFile(resolved)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    },
    async bytes() {
      return new Uint8Array(await readFile(resolved))
    },
  }
}

/** Bun.write creates the parent directory; node:fs does not. */
async function write(destination: string | URL, content: string | Uint8Array | ArrayBuffer) {
  const resolved = toPath(destination)
  await mkdir(path.dirname(resolved), { recursive: true })
  const body = content instanceof ArrayBuffer ? new Uint8Array(content) : content
  await writeFile(resolved, body)
  return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Bun.hash is wyhash returning a 64-bit value. Callers here only need a stable
 * short key for a cache directory name, so any stable 64-bit digest serves; the
 * value differs from Bun's, which changes only the directory name.
 */
function hash(input: string | Uint8Array): bigint {
  const digest = createHash("sha256").update(input).digest()
  return digest.readBigUInt64BE(0)
}

const BunShim = {
  stringWidth,
  file: BunFile,
  write,
  hash,
  get stdin() {
    return { text: readStdin }
  },
}

// Assigned through a cast rather than a `declare global`. Redeclaring the global
// would replace @types/bun's ambient `Bun` with this partial shape for the whole
// workspace, so every build script that legitimately uses the full Bun API under
// Bun — Bun.build, Bun.env, Bun.spawn, Bun.Glob — would stop type-checking.
const globals = globalThis as { Bun?: unknown }
globals.Bun ??= BunShim

export {}
