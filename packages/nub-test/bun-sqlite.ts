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
    return wrapStatement(super.prepare(sql))
  }

  /**
   * Bun exposes this on the Database; node exposes `setReadBigInts` on the
   * STATEMENT. Record the preference and apply it to statements as they are made.
   */
  safeIntegers(enabled = true) {
    ;(this as any).__safeIntegers = enabled
    return this
  }
}

/** `each()` is Bun-only; node statements iterate via `all()`. */
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
  return stmt
}

export { DatabaseSync, StatementSync, constants } from "node:sqlite"
export default Database
