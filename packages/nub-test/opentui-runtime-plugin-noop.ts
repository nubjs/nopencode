/**
 * Stands in for `@opentui/solid/runtime-plugin-support/configure` under
 * `node --test`.
 *
 * That entrypoint's `node` arm throws at module scope, so importing it is fatal
 * — seven `packages/opencode` test files failed to load at all before this. Its
 * Bun arm registers a `bun.plugin` hook so a TUI plugin loaded at run time
 * resolves `@opentui/solid` and `solid-js` to the HOST's instances.
 *
 * Returning false is the same answer the compiled binary gives: the build
 * aliases the specifier to `packages/opencode/src/nub/runtime-plugin-support-noop.ts`,
 * whose comment carries the full reasoning. This copy exists because the shim
 * cannot reach into a package it does not depend on.
 */
export function ensureRuntimePluginSupport(_options?: { additional?: Record<string, unknown> }): boolean {
  return false
}
