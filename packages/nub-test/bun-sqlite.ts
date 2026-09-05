/**
 * `bun:sqlite` on top of `node:sqlite`.
 *
 * Mapping the specifier straight to `node:sqlite` fails: the suite imports
 * `{ Database }` and node exports `DatabaseSync`, so the import throws "does not
 * provide an export named 'Database'". The names are not the only difference —
 * hence this file rather than a rename.
 *
 * Loaded before the esbuild transform, so it stays inside node's strip-only
 * TypeScript subset.
 */
import { DatabaseSync } from "node:sqlite"

/**
 * SQLite primary result codes, by number.
 *
 * Bun puts the mnemonic on the thrown error's `code`; node puts a generic
 * `ERR_SQLITE_ERROR` there and the number on `errcode`. Consumers key on the
 * mnemonic — `@effect/sql` decides `LockTimeoutError` vs `UnknownError` by
 * matching `SQLITE_BUSY` — so an unmapped error is not a crash but a wrong
 * classification, which is worse.
 *
 * Only the primary codes: an extended code carries the primary one in its low
 * byte, which is what every consumer here matches on.
 */
const SQLITE_CODES: Record<number, string> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
}

/** Run `fn`, restamping any sqlite error with the mnemonic Bun would have used. */
function withBunErrorCodes<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err: any) {
    if (err?.code === "ERR_SQLITE_ERROR" && typeof err.errcode === "number") {
      const mnemonic = SQLITE_CODES[err.errcode & 0xff]
      if (mnemonic) err.code = mnemonic
    }
    throw err
  }
}

/**
 * Bun's `Database` differs from `DatabaseSync` in the corners this suite touches:
 *
 * - options: Bun takes `{ readonly }`, node takes `{ readOnly }`
 * - `query()` / `prepare()`: Bun has both, node only `prepare()`
 * - `.run()`/`.get()`/`.all()` live on the statement in both, so those pass through
 *
 * Anything not bridged is inherited from DatabaseSync unchanged, so an unsupported
 * call fails as a missing method rather than silently doing nothing.
 */
export class Database extends DatabaseSync {
  constructor(path?: string, options?: { readonly?: boolean; create?: boolean; strict?: boolean }) {
    // Passing `undefined` is NOT the same as omitting: node:sqlite throws
    // "The options argument must be an object" when it is present-but-undefined.
    if (options?.readonly === undefined) super(path ?? ":memory:")
    else super(path ?? ":memory:", { readOnly: options.readonly })
  }

  /** Bun's alias for `prepare`, plus the statement extras Bun adds. */
  query(sql: string) {
    return wrapStatement(this.prepare(sql))
  }

  prepare(sql: string) {
    return wrapStatement(withBunErrorCodes(() => super.prepare(sql)))
  }

  /**
   * Bun exposes this on the Database; node exposes `setReadBigInts` on the
   * STATEMENT. Record the preference and apply it to statements as they are made.
   */
  safeIntegers(enabled = true) {
    ;(this as any).__safeIntegers = enabled
    return this
  }

  /**
   * Bun runs a one-off statement straight off the Database; node has only
   * `exec`, which takes no parameters and returns nothing. `@effect/sql-sqlite-bun`
   * opens every connection with `db.run("PRAGMA journal_mode = WAL;")`, so
   * without this the client fails before any query reaches it.
   */
  run(sql: string, ...params: unknown[]) {
    return this.prepare(sql).run(...params)
  }

  exec(sql: string) {
    return withBunErrorCodes(() => super.exec(sql))
  }
}

/** `each()` and `values()` are Bun-only; node spells both differently. */
function wrapStatement(stmt: any) {
  if (stmt.__wrapped) return stmt
  stmt.__wrapped = true
  stmt.each = function (...args: unknown[]) {
    return this.all(...args)
  }
  stmt.safeIntegers = function (enabled = true) {
    this.setReadBigInts(enabled)
    return this
  }
  for (const name of ["all", "get", "run", "iterate"] as const) {
    const original = stmt[name].bind(stmt)
    stmt[name] = (...args: unknown[]) => withBunErrorCodes(() => original(...args))
  }
  // Rows as positional arrays rather than objects. Node has the same capability
  // as a MODE on the statement, so flip it for the one call and put it back —
  // a statement is reused, and leaving it latched would silently change the
  // shape returned by a later `all()`.
  stmt.values = function (...args: unknown[]) {
    this.setReturnArrays(true)
    try {
      return this.all(...args)
    } finally {
      this.setReturnArrays(false)
    }
  }
  return stmt
}

export { DatabaseSync, StatementSync, constants } from "node:sqlite"
export default Database
