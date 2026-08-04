/**
 * Stands in for `@opentui/solid/runtime-plugin-support/configure`, which is
 * Bun-only — its `node` arm throws at module scope, so even importing it is
 * fatal. Aliased in by `script/build-nub.mjs`; opencode's own source is
 * untouched and the Bun build keeps the real thing.
 *
 * What it does under Bun: registers a `bun.plugin` hook so a TUI plugin loaded
 * at run time resolves `@opentui/solid`, `solid-js` and friends to the HOST's
 * module instances rather than its own copies. There is no Node equivalent —
 * `module.registerHooks` could redirect the specifiers, but the host instances
 * it must hand back only exist inside the compiled bundle, and a compiled binary
 * has no `node_modules` for a plugin to resolve against in the first place.
 *
 * The consequence, stated plainly: the TUI runs, and third-party TUI plugins
 * that import the Solid/OpenTUI runtime do not get the host's instances. Every
 * built-in plugin is bundled and unaffected.
 */
export function ensureRuntimePluginSupport(_options?: { additional?: Record<string, unknown> }): boolean {
  return false
}
