/**
 * Point OpenTUI at the staged asset directory before any test imports it.
 *
 * Without this, OpenTUI resolves its native library by importing
 * `@opentui/core-<platform>-<arch>`, and that package's `exports` map declares
 * no main — so every renderer test dies with `No "exports" main defined`. The
 * compiled binary has the same problem and solves it the same way
 * (`src/nub/otui-asset-root.ts`); this is the test-time equivalent.
 *
 * An absolute path, because OTUI_ASSET_ROOT is consulted as one — and computed
 * from this file rather than the shell, so the test script needs no path
 * arithmetic and works from any cwd.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
process.env["OTUI_ASSET_ROOT"] ??= path.resolve(here, "../otui-assets")
