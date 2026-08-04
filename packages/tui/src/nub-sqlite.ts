/**
 * The slice of `bun:sqlite` the Zed integration uses, on `node:sqlite`.
 *
 * Shapes differ in three places and nowhere else that matters here: the
 * constructor option is `readOnly` rather than `readonly`, statements come from
 * `prepare()` rather than `query()`, and `node:sqlite` returns plain rows the
 * same way. Named `$param` keys pass through unchanged.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite"

export class Database {
  private db: DatabaseSync

  constructor(filename: string, options?: { readonly?: boolean }) {
    this.db = new DatabaseSync(filename, { readOnly: options?.readonly ?? false })
  }

  query(sql: string): StatementSync {
    return this.db.prepare(sql)
  }

  close() {
    this.db.close()
  }
}
