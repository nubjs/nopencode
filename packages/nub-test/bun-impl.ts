/**
 * The Bun side of `@opencode-ai/nub-test`.
 *
 * Selected by the `bun` export condition in package.json, so the SAME rewritten
 * test files run under both runners. This is what keeps the Bun baseline
 * reproducible after the migration — without it, rewriting the imports destroys
 * the control the whole comparison depends on.
 *
 * Bun already provides every matcher this suite uses, so this is a pass-through.
 */
export * from "bun:test"
