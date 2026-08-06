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
  describe as nodeDescribe,
  it,
  mock as nodeMock,
} from "node:test"
import { expect as jestExpect } from "expect"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname } from "node:path"

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

/**
 * Bun's snapshot store, read-only.
 *
 * A `.snap` file is a CommonJS module of `exports[\`<full test name> <n>\`] = \`…\`;`
 * — Jest's format, which Bun writes verbatim. Evaluating it is what un-escapes the
 * template literals, so the values come back exactly as pretty-format wrote them.
 *
 * Keyed on the full name (enclosing describes + the test name) and a per-name
 * counter, so a test calling it twice reads `… 1` then `… 2` — matching how Bun
 * assigns them, which is the only way the committed keys line up.
 */
const snapshotCounts = new Map<string, number>()
let snapshotStore: Map<string, string> | undefined
let currentTestName = ""
let suitePath: string[] = []

const snapshotKey = () => currentTestName
const nextSnapshotIndex = () => {
  const n = (snapshotCounts.get(currentTestName) ?? 0) + 1
  snapshotCounts.set(currentTestName, n)
  return n
}

/** node:test runs one file per process, so argv names the file under test. */
function snapshotPath(): string {
  const file = process.argv[1] ?? ""
  return `${dirname(file)}/__snapshots__/${basename(file)}.snap`
}

function loadSnapshots(): Map<string, string> {
  if (snapshotStore) return snapshotStore
  snapshotStore = new Map()
  const path = snapshotPath()
  if (!existsSync(path)) return snapshotStore
  const exported: Record<string, string> = {}
  new Function("exports", readFileSync(path, "utf8"))(exported)
  for (const [k, v] of Object.entries(exported)) {
    // Bun brackets every value with newlines inside the template literal.
    snapshotStore.set(k, v.replace(/^\n/, "").replace(/\n$/, ""))
  }
  return snapshotStore
}

/**
 * pretty-format's output for the values this suite snapshots. A string is
 * printed inside double quotes with NO inner escaping — verified against the
 * committed files, which contain unescaped `"` in the payload.
 *
 * Anything else throws rather than guessing at pretty-format's object layout,
 * which would produce a confident mismatch instead of an honest gap.
 */
function serializeSnapshot(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  throw new Error(`toMatchSnapshot on the node:test shim supports strings only, got ${typeof value}`)
}

const pass = (received: unknown, expected: string, ok: boolean) => ({
  pass: ok,
  message: () => `expected ${JSON.stringify(received)} ${ok ? "not " : ""}to be ${expected}`,
})

jestExpect.extend({
  toMatchSnapshot(received: unknown) {
    const key = `${snapshotKey()} ${nextSnapshotIndex()}`
    const store = loadSnapshots()
    const expected = store.get(key)
    if (expected === undefined) {
      // Deliberately does NOT write. Bun records a missing snapshot and passes;
      // here the committed file IS the oracle — the whole point is to check node
      // renders what Bun recorded, and a shim that writes its own answer would
      // pass no matter what it rendered.
      return { pass: false, message: () => `no committed snapshot for ${JSON.stringify(key)} in ${snapshotPath()}` }
    }
    const actual = serializeSnapshot(received)
    return {
      pass: actual === expected,
      message: () => `snapshot ${JSON.stringify(key)} did not match\n\nexpected:\n${expected}\n\nreceived:\n${actual}`,
    }
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

/**
 * `describe` is wrapped only to record the suite path for snapshot keys. Bun
 * keys a snapshot on the FULL name — enclosing describes plus the test name —
 * so without this every key is short by its prefix and nothing matches.
 *
 * The callback runs at REGISTRATION and synchronously, so a push/pop stack is
 * correct here even for nested suites; the path is captured per test as it
 * registers, not read at run time when the stack is long since unwound.
 */
function describeWrapper(name: string, fn?: () => void) {
  return (nodeDescribe as any)(name, () => {
    suitePath.push(name)
    try {
      return fn?.()
    } finally {
      suitePath.pop()
    }
  })
}
export const describe = Object.assign(describeWrapper, {
  only: (nodeDescribe as any).only,
  skip: (nodeDescribe as any).skip,
  todo: (nodeDescribe as any).todo,
})

export { it, beforeEach, afterEach, expect }

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
  const body = named([...suitePath, name].join(" "), fn)
  return options ? (it as any)(name, options, body) : (it as any)(name, body)
}

/**
 * Publish the running test's full name so `toMatchSnapshot` can key on it.
 * Set inside the test body rather than at registration because registration
 * order is not run order, and restored after so a failure cannot leak a stale
 * name into the next test's key.
 */
function named(fullName: string, fn: any) {
  if (typeof fn !== "function") return fn
  return function (this: any, ...args: any[]) {
    const previous = currentTestName
    currentTestName = fullName
    try {
      const out = fn.apply(this, args)
      if (out && typeof out.finally === "function") {
        return out.finally(() => {
          currentTestName = previous
        })
      }
      return out
    } finally {
      if (!fn.constructor || fn.constructor.name !== "AsyncFunction") currentTestName = previous
    }
  }
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

mock.module = (specifier: string, factory?: () => any) => {
  const nodeModuleMock = (nodeMock as unknown as { module?: Function }).module
  if (typeof nodeModuleMock !== "function") {
    throw new Error(
      `mock.module(${JSON.stringify(specifier)}) needs node's ` +
        `--experimental-test-module-mocks flag, which is not enabled`,
    )
  }
  // Bun's factory returns the replacement module object; node wants named
  // exports and the default separated, so unpack rather than pass it through.
  const replacement = factory?.() ?? {}
  const { default: defaultExport, ...namedExports } = replacement
  return (nodeMock as any).module(specifier, {
    namedExports,
    ...(defaultExport === undefined ? {} : { defaultExport }),
  })
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
