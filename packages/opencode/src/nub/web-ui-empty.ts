/**
 * Stands in for `opencode-web-ui.gen.ts`, the module `script/build.ts` generates
 * on the fly and injects as a virtual in-memory file. `nub compile` builds from
 * real files, so the map is a real module; an empty one means the server serves
 * the web UI from upstream instead of from the binary, which is exactly what
 * `--skip-embed-web-ui` already does under Bun.
 */
export default {} as Record<string, string>
