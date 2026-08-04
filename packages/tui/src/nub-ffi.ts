/**
 * Stand-in for `bun:ffi`, which has no Node equivalent that is usable here.
 *
 * The only consumer is `terminal-win32.ts`, whose every entry point returns
 * early unless `process.platform === "win32"` and which already treats a failed
 * `dlopen` as "no console guard" — so on every non-Windows target this module is
 * unreachable and the stub is exact.
 *
 * WINDOWS IS A REAL GAP, not a graceful degradation to ignore: the Ctrl+C guard
 * that keeps ENABLE_PROCESSED_INPUT cleared silently stops working, so Ctrl+C
 * reverts to a CTRL_C_EVENT instead of stdin input. Closing it needs one of:
 * `node:ffi` (Node 26 has it behind `--experimental-ffi`, so it also needs a way
 * to bake that flag into the compiled binary), or a small N-API addon calling
 * GetStdHandle/GetConsoleMode/SetConsoleMode directly.
 *
 * The signatures mirror `bun:ffi` rather than returning `never`, so callers keep
 * type-checking against the shape they were written for.
 */
const UNAVAILABLE = "FFI is unavailable in this build"

export function dlopen<const T extends Record<string, unknown>>(
  _library: string,
  _symbols: T,
): { symbols: Record<keyof T, (...args: any[]) => any>; close(): void } {
  throw new Error(UNAVAILABLE)
}

export function ptr(_view: ArrayBufferView | ArrayBuffer): number {
  throw new Error(UNAVAILABLE)
}
