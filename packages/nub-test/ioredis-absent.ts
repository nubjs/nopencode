/**
 * Stands in for `ioredis` when the install did not provide it.
 *
 * `@effect/platform-node` declares ioredis as a NON-optional peer dependency and
 * imports it at module scope from `NodeRedis.js`. bun installs a missing
 * non-optional peer; nub does not. So the identical source tree links under a
 * `bun install` and fails under a `nub install` — measured at 48 test files, and
 * every module-not-found in that run named this one package.
 *
 * Nothing in opencode constructs a Redis client. `NodeRedis.js` is only reached
 * because a barrel re-exports it, so the import has to succeed and the client
 * never has to work. `script/build-nub.mjs` reaches the same conclusion for the
 * compiled binary with `--external ioredis`.
 *
 * The resolver installs this ONLY after node's own resolution has failed, so a
 * tree carrying the real package keeps it and nothing here is reachable.
 * Constructing the client throws rather than returning a dead object, because a
 * silently inert Redis would turn a real assertion into a passing one.
 */

const absent = (): never => {
  throw new Error(
    "ioredis is not installed. @effect/platform-node declares it as a peer dependency; " +
      "install it if this code path is genuinely needed.",
  )
}

export class Redis {
  constructor(..._args: unknown[]) {
    absent()
  }
}

export class Cluster {
  constructor(..._args: unknown[]) {
    absent()
  }
}

export default Redis
