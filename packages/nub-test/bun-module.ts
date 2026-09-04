/**
 * The `bun` module — what `import { $ } from "bun"` gets on stock Node.
 *
 * Loaded before the esbuild transform (same bootstrapping constraint as
 * `bun-global.ts`), so it stays inside node's strip-only TypeScript subset.
 *
 * Surface scoped to what the suite calls, counted across 44 importing files:
 * `.cwd()` 157, `.quiet()` 18, `.text()` 7, `.nothrow()` 7 — plus awaiting the
 * result directly. Anything else is absent rather than approximated.
 */
import { spawn } from "node:child_process"

export { pathToFileURL } from "node:url"

type ShellResult = { exitCode: number; stdout: string; stderr: string; text: () => string }

/**
 * Bun's `$` interpolates values as SINGLE shell words, not raw text — that is what
 * makes `$\`git -C ${dir} status\`` safe when `dir` contains spaces. Reproducing
 * that quoting matters: splicing raw would silently change the command whenever a
 * test used a temp path with a space in it.
 */
function quote(value: unknown): string {
  const s = String(value)
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

class Shell {
  command: string
  options: { cwd?: string; quiet: boolean; nothrow: boolean }

  constructor(command: string) {
    this.command = command
    this.options = { quiet: false, nothrow: false }
  }

  cwd(dir: string): Shell {
    this.options.cwd = dir
    return this
  }

  quiet(): Shell {
    this.options.quiet = true
    return this
  }

  nothrow(): Shell {
    this.options.nothrow = true
    return this
  }

  run(): Promise<ShellResult> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(this.command, {
        shell: true,
        cwd: this.options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => {
        stdout += d
        if (!this.options.quiet) process.stdout.write(d)
      })
      child.stderr.on("data", (d) => {
        stderr += d
        if (!this.options.quiet) process.stderr.write(d)
      })
      child.on("error", rejectRun)
      child.on("close", (code) => {
        const exitCode = code ?? 0
        if (exitCode !== 0 && !this.options.nothrow) {
          const err = new Error(`Command failed with exit code ${exitCode}: ${this.command}\n${stderr}`)
          ;(err as any).exitCode = exitCode
          ;(err as any).stderr = stderr
          ;(err as any).stdout = stdout
          rejectRun(err)
          return
        }
        resolveRun({ exitCode, stdout, stderr, text: () => stdout })
      })
    })
  }

  /** Awaiting the shell runs it — Bun's `$` is a thenable, not a plain builder. */
  then(onOk?: (v: ShellResult) => unknown, onErr?: (e: unknown) => unknown) {
    return this.run().then(onOk, onErr)
  }

  catch(onErr?: (e: unknown) => unknown) {
    return this.run().catch(onErr)
  }

  async text(): Promise<string> {
    const r = await this.quiet().run()
    return r.stdout
  }
}

export function $(strings: TemplateStringsArray, ...values: unknown[]): Shell {
  let command = strings[0] ?? ""
  for (let i = 0; i < values.length; i++) {
    command += quote(values[i]) + (strings[i + 1] ?? "")
  }
  return new Shell(command)
}
