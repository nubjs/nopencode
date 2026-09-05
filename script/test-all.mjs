/**
 * Run every package's `node --test` suite and tally the result.
 *
 * The per-package `test` scripts are the source of truth — this only discovers
 * them, runs them in series, and counts. Series rather than parallel because
 * node:test already forks one process per FILE, so running packages
 * concurrently just oversubscribes the box and makes timing-sensitive tests
 * flake.
 *
 * The `dot` reporter the scripts use prints failures but no totals, so the run
 * here swaps in `spec` and reads node's own `ℹ pass` / `ℹ fail` lines. Counting
 * anything else — dots, checkmarks — would be a second implementation of the
 * runner's bookkeeping and would disagree with it eventually.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { globSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const only = process.argv.slice(2)

const patterns = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces.packages
const dirs = patterns
  .flatMap((p) => globSync(p, { cwd: root }))
  .filter((d) => existsSync(join(root, d, "package.json")))
  .sort()

const targets = []
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))
  // Every script that drives node's runner, not just the one called `test` —
  // packages/app splits its suite into `test:unit` and `test:browser` under
  // different export conditions, and a `test` that only chains them has no
  // `--test` of its own. A package still on another runner is skipped rather
  // than reported as zero, which would read as "migrated and empty".
  // `playwright` scripts are excluded: they drive a real browser and belong to
  // a separate gate, so counting them here would mix two runners' totals.
  const runners = Object.entries(pkg.scripts ?? {}).filter(
    ([, v]) => v.includes("--test ") && !v.includes("playwright"),
  )
  if (!runners.length) continue
  if (only.length && !only.some((o) => dir.includes(o) || pkg.name === o)) continue
  for (const [key, script] of runners) {
    if (key.endsWith(":watch")) continue
    targets.push({ dir, name: runners.length > 1 ? `${pkg.name} (${key})` : (pkg.name ?? dir), script })
  }
}

const rows = []
let failed = 0
for (const t of targets) {
  const command = t.script.replace("--test-reporter=dot", "--test-reporter=spec")
  process.stderr.write(`\n### ${t.name}\n`)
  const started = Date.now()
  // A wall-clock cap per PACKAGE on top of node's per-TEST --test-timeout: a
  // file that wedges during its import graph never registers a test, so there is
  // nothing for the per-test timeout to fire on.
  const out = spawnSync(command, { cwd: join(root, t.dir), shell: true, encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 512 * 1024 * 1024 })
  const text = (out.stdout ?? "") + (out.stderr ?? "")
  const count = (key) => {
    // Every child process prints its own summary block; sum them.
    let total = 0
    for (const m of text.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gm"))) total += Number(m[1])
    return total
  }
  const row = {
    name: t.name,
    pass: count("pass"),
    fail: count("fail"),
    skip: count("skipped"),
    seconds: Math.round((Date.now() - started) / 1000),
    status: out.status,
  }
  rows.push(row)
  if (row.fail > 0 || out.status !== 0) {
    failed++
    process.stderr.write(text.split("\n").filter((l) => /^(not ok|✖|Error|✘)/.test(l)).slice(0, 40).join("\n") + "\n")
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log("\n| package | pass | fail | skip | seconds |")
console.log("| --- | --- | --- | --- | --- |")
for (const r of rows) console.log(`| ${pad(r.name, 28)} | ${r.pass} | ${r.fail} | ${r.skip} | ${r.seconds} |`)
const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
console.log(`| **total** | **${sum("pass")}** | **${sum("fail")}** | **${sum("skip")}** | **${sum("seconds")}** |`)
process.exit(failed ? 1 : 0)
