import { createRequire } from "node:module"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

// `node:ffi` in place of `bun:ffi`. Node 26 gates the module behind
// `--experimental-ffi`, which a `nub compile` binary passes on its own (and it
// silences the ExperimentalWarning). Loaded lazily, and only on Windows, so the
// other platforms never touch the module.
const require = createRequire(import.meta.url)

// The slice of node:ffi this file calls. @types/node 24 predates the module,
// so the shape is declared here rather than imported.
type NodeFfi = {
  dlopen(
    path: string,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ): { functions: Record<string, (...args: any[]) => any> }
  getRawPointer(source: ArrayBuffer | ArrayBufferView): bigint
}

type Kernel32 = {
  GetStdHandle: (handle: number) => bigint
  GetConsoleMode: (handle: bigint, mode: bigint) => number
  SetConsoleMode: (handle: bigint, mode: number) => number
  FlushConsoleInputBuffer: (handle: bigint) => number
}

const kernel = () => {
  const ffi = require("node:ffi") as NodeFfi
  const { functions } = ffi.dlopen("kernel32.dll", {
    GetStdHandle: { arguments: ["i32"], return: "pointer" },
    GetConsoleMode: { arguments: ["pointer", "pointer"], return: "i32" },
    SetConsoleMode: { arguments: ["pointer", "u32"], return: "i32" },
    FlushConsoleInputBuffer: { arguments: ["pointer"], return: "i32" },
  })
  return { symbols: functions as unknown as Kernel32, ptr: ffi.getRawPointer }
}

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, k32!.ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, k32!.ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, k32!.ptr(buf)) === 0) return
    const mode = buf[0]!
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ReadStream["setRawMode"] | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
