/**
 * `bun:test` on top of `node:test`, so the suite runs on a stock Node.
 *
 * Only the surface the suite actually imports is provided, measured across the
 * 636 files that import `bun:test`: expect, describe, test, afterEach, mock,
 * spyOn, beforeEach, beforeAll, afterAll, it, vi, setSystemTime. Nothing here is
 * speculative — an export nobody imports is an export nobody can check.
 *
 * The runner half is a rename (`beforeAll` is node's `before`, `afterAll` its
 * `after`). The two that are NOT renames are `expect` and the mocking surface,
 * and both are documented where they are defined.
 */
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock as nodeMock,
} from "node:test"
import { expect as jestExpect } from "expect"

/**
 * Bun's `expect` carries matchers Jest's does not. Counted across the suite:
 * toBeTrue(25) toStartWith(17) toBeFunction(17) toBeFalse(9) toInclude(8)
 * toBeNumber(3), plus the siblings they travel with. Without these the failure
 * reads "toBeTrue is not a function", which looks like a shim bug rather than a
 * missing matcher.
 *
 * Everything else the suite uses — toBeUndefined, toBeDefined, toBeGreaterThan,
 * toBeInstanceOf, toBeNull, toBeTruthy, toBeCloseTo — Jest already provides.
 */
declare module "expect" {
  interface Matchers<R> {
    toBeTrue(): R
    toBeFalse(): R
    toBeString(): R
    toBeNumber(): R
    toBeBoolean(): R
    toBeFunction(): R
    toBeArray(): R
    toBeNil(): R
    toBeEmpty(): R
    toStartWith(expected: string): R
    toEndWith(expected: string): R
    toInclude(expected: unknown): R
    toBeOneOf(expected: unknown[]): R
    /** Bun's accepts any shape; Jest's is narrowed to records. Widen it back. */
    toMatchObject(expected: unknown): R
    /** Bun-only; unsupported here and throws rather than silently passing. */
    toMatchSnapshot(hint?: string): R
  }
}

const pass = (received: unknown, expected: string, ok: boolean) => ({
  pass: ok,
  message: () => `expected ${JSON.stringify(received)} ${ok ? "not " : ""}to be ${expected}`,
})

jestExpect.extend({
  toMatchSnapshot: () => {
    throw new Error(
      "toMatchSnapshot is not supported on the node:test shim — bun's snapshot " +
        "store has no node:test equivalent. Assert on the value directly.",
    )
  },
  toBeTrue: (r: unknown) => pass(r, "true", r === true),
  toBeFalse: (r: unknown) => pass(r, "false", r === false),
  toBeString: (r: unknown) => pass(r, "a string", typeof r === "string"),
  toBeNumber: (r: unknown) => pass(r, "a number", typeof r === "number" && !Number.isNaN(r)),
  toBeBoolean: (r: unknown) => pass(r, "a boolean", typeof r === "boolean"),
  toBeFunction: (r: unknown) => pass(r, "a function", typeof r === "function"),
  toBeArray: (r: unknown) => pass(r, "an array", Array.isArray(r)),
  toBeNil: (r: unknown) => pass(r, "null or undefined", r === null || r === undefined),
  toBeEmpty: (r: any) => pass(r, "empty", r == null || r.length === 0 || Object.keys(r).length === 0),
  toStartWith: (r: unknown, e: string) => pass(r, `starting with ${e}`, typeof r === "string" && r.startsWith(e)),
  toEndWith: (r: unknown, e: string) => pass(r, `ending with ${e}`, typeof r === "string" && r.endsWith(e)),
  toInclude: (r: unknown, e: unknown) =>
    pass(r, `including ${JSON.stringify(e)}`, Array.isArray(r) ? r.includes(e) : typeof r === "string" && r.includes(String(e))),
  toBeOneOf: (r: unknown, e: unknown[]) => pass(r, `one of ${JSON.stringify(e)}`, e.includes(r)),
})

/**
 * Bun's `expect(value, message)` accepts a custom failure message as a second
 * argument; Jest's takes one. Callers pass it to explain WHY an assertion should
 * hold — dropping it silently would keep the tests passing but make every failure
 * less legible, so it is prepended to the matcher's own message.
 */
const expect = Object.assign(
  (received: unknown, message?: string) => {
    if (message === undefined) return jestExpect(received)
    const matchers = jestExpect(received)
    return new Proxy(matchers, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          try {
            return (value as Function).apply(target, args)
          } catch (err: any) {
            if (err?.message) err.message = `${message}\n\n${err.message}`
            throw err
          }
        }
      },
    })
  },
  jestExpect,
) as typeof jestExpect & ((received: unknown, message?: string) => ReturnType<typeof jestExpect>)

export { describe, it, beforeEach, afterEach, expect }

/** Helper files import this type alongside `test`; node's shape is compatible. */
export type TestOptions = { timeout?: number; skip?: boolean | string; only?: boolean; todo?: boolean | string }

/** `bun:test` names these for the whole file; `node:test` scopes them per suite. */
export const beforeAll = before
export const afterAll = after

/**
 * `test` and `it` are the same function in both runners, except that Bun adds
 * `.each` for table-driven tests and node:test does not. `.each(rows)(name, fn)`
 * registers one test per row, interpolating `%s`/`%d`/`%i` in the name the way
 * Bun and Jest do.
 */
function each<T extends readonly unknown[]>(
  rows: readonly T[],
): (name: string, fn: (...row: T) => unknown) => void
function each<T>(rows: readonly T[]): (name: string, fn: (row: T) => unknown) => void
function each(rows: readonly any[]) {
  return (name: string, fn: (...row: any[]) => unknown) => {
    for (const row of rows) {
      const args = Array.isArray(row) ? row : [row]
      let i = 0
      const title = name.replace(/%[sdifj%]/g, (m) => (m === "%%" ? "%" : String(args[i++])))
      ;(it as any)(title === name ? `${name} (${JSON.stringify(row)})` : title, () => fn(...args))
    }
  }
}

function runner(name: string, a?: any, b?: any) {
  // Bun calls test(name, fn, timeoutOrOptions); node:test wants
  // it(name, options, fn). Normalise so both call shapes work.
  const fn = typeof a === "function" ? a : b
  const opts = typeof a === "function" ? b : a
  const options = typeof opts === "number" ? { timeout: opts } : opts
  return options ? (it as any)(name, options, fn) : (it as any)(name, fn)
}

const variant = (kind: "only" | "skip" | "todo") => (name: string, a?: any, b?: any) => {
  const fn = typeof a === "function" ? a : b
  const opts = typeof a === "function" ? b : a
  const options = typeof opts === "number" ? { timeout: opts } : opts
  const target = (it as any)[kind]
  return options ? target(name, options, fn) : target(name, fn)
}

export const test = Object.assign(runner, {
  each,
  only: variant("only"),
  skip: variant("skip"),
  todo: variant("todo"),
}) as typeof runner & {
  each: typeof each
  only: typeof runner
  skip: typeof runner
  todo: typeof runner
}

/**
 * `mock(fn)` returns a callable spy carrying `.mock.calls`.
 *
 * `node:test`'s `mock.fn` already produces that shape, but its call records
 * expose `arguments` where Jest and Bun expose the array directly — so
 * `.mock.calls[0][0]` is the first ARG under bun and the whole record under
 * node. The suite reads the Bun shape in 28 files, so present that.
 */
type MockFn = ((...args: any[]) => any) & {
  mock: { calls: any[][]; results: any[] }
  mockClear: () => void
  mockReset: () => void
  mockImplementation: (impl: (...args: any[]) => any) => MockFn
  mockResolvedValue: (value: any) => MockFn
  mockReturnValue: (value: any) => MockFn
}

function wrap(inner: any): MockFn {
  // A DELEGATING wrapper, not a mutated one. `node:test`'s mock function is a
  // Proxy whose trap serves `.mock`, so `defineProperty` on it silently fails to
  // shadow anything and callers keep seeing node's raw call records. Owning the
  // outer function is the only way to present the Bun shape.
  const ctx = inner.mock
  const fn = function (this: any, ...args: any[]) {
    return inner.apply(this, args)
  } as unknown as MockFn
  Object.defineProperty(fn, "mock", {
    configurable: true,
    get: () => ({
      calls: ctx.calls.map((c: any) => c.arguments),
      results: ctx.calls.map((c: any) => c.result),
    }),
  })
  fn.mockClear = () => ctx.resetCalls()
  fn.mockReset = () => ctx.restore()
  fn.mockImplementation = (impl) => {
    ctx.mockImplementation(impl)
    return fn
  }
  fn.mockReturnValue = (value) => fn.mockImplementation(() => value)
  fn.mockResolvedValue = (value) => fn.mockImplementation(async () => value)
  return fn
}

export function mock(impl?: (...args: any[]) => any): MockFn {
  return wrap(nodeMock.fn(impl ?? (() => undefined)))
}

/** `mock.module` has no `node:test` equivalent; fail loudly rather than no-op. */
/** Bun spells it `restore`; node:test spells it `restoreAll`. */
mock.restore = () => nodeMock.restoreAll()

mock.module = (specifier: string, _factory?: () => unknown) => {
  throw new Error(
    `mock.module(${JSON.stringify(specifier)}) is not supported on node:test — ` +
      `use a dependency-injection seam, or node's module mocking behind ` +
      `--experimental-test-module-mocks`,
  )
}

export function spyOn<T extends object>(object: T, method: keyof T): MockFn {
  return wrap(nodeMock.method(object as any, method as any))
}

/** Vitest-style alias; two files import it. */
export const vi = {
  fn: mock,
  spyOn,
  useFakeTimers: () => nodeMock.timers.enable(),
  useRealTimers: () => nodeMock.timers.reset(),
}

/** `setSystemTime` maps onto node's timer mocking, which must be enabled first. */
export function setSystemTime(now?: Date | number) {
  if (now === undefined) {
    nodeMock.timers.reset()
    return
  }
  nodeMock.timers.enable({ apis: ["Date"], now: typeof now === "number" ? now : now.getTime() })
}
