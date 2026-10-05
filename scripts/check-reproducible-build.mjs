// Is the built client bundle a function of the source? Build it, build it again, compare the bytes.
//
// WHY THIS EXISTS. The client bundle used to differ between two builds of identical sources: the
// emitted CSS-module class map carried lightningcss's iteration order (fixed in `build/css-class-map.ts`,
// and pinned by `tests/build.client.spec.ts`). That fix is a property of ONE function; this check is a
// property of the WHOLE pipeline. Without it, any other per-run byte — a banner, a salt, a Set order,
// a step that stops routing through `cssClassMap` — would pass every gate in the repository while
// quietly making `lib/client.js` uncomparable, which is exactly what a release or cache check assumes
// it can do.
//
// THREE PROPERTIES IT KEEPS ON PURPOSE:
// 1. It builds TWICE itself and deletes the artifacts before EACH build, so both digests come from an
//    artifact some build of this run wrote. A build that exits 0 without writing cannot be mistaken
//    for a reproducible one — the missing file is an error, not a pass.
// 2. It resolves the repository from its own location, so it does not matter which directory it is run
//    from (a CI `working-directory`, a `pnpm --prefix`, a subdirectory).
// 3. It never trusts what `lib/` already held, so it can be run at any moment; a stale artifact would
//    otherwise read as drift on the first build and look like a regression.
//
// Usage: node scripts/check-reproducible-build.mjs

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, relative } from 'node:path'

/** The repository root, from this file's own location rather than the process cwd. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The artifacts whose bytes must be reproducible: what a browser loads first, plus the host half. */
const ARTIFACTS = ['lib/client.js', 'lib/client.js.map', 'lib/index.js'].map((relative) => resolve(ROOT, relative))

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Remove each artifact, build, and require every one of them back: a no-op build fails here. */
const snapshot = () => {
  for (const path of ARTIFACTS) rmSync(path, { force: true })
  // One command string rather than an args array: with `shell: true` Node deprecates the array form
  // (DEP0190), and this is the same invocation CI runs, on both shells.
  const result = spawnSync('pnpm run build', { cwd: ROOT, stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    console.error(`reproducible build: \`pnpm run build\` exited ${String(result.status)}`)
    process.exit(2)
  }
  const missing = ARTIFACTS.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error('reproducible build: the build reported success but did not write:')
    for (const path of missing) console.error(`  ${path}`)
    process.exit(2)
  }
  return new Map(ARTIFACTS.map((path) => [path, digest(path)]))
}

const first = snapshot()
const second = snapshot()

const drifted = ARTIFACTS.filter((path) => first.get(path) !== second.get(path))
if (drifted.length > 0) {
  console.error('reproducible build: the SAME SOURCE produced DIFFERENT bytes — the bundle is not a function of the source')
  for (const path of drifted) {
    console.error(`  ${path}`)
    console.error(`    first build:  ${first.get(path)}`)
    console.error(`    second build: ${second.get(path)}`)
  }
  console.error('Find the per-run value (a map or Set iteration order, a timestamp, a salt) and make it deterministic.')
  process.exit(1)
}

console.log(`reproducible build: ${ARTIFACTS.length} artifacts identical across two builds`)
for (const path of ARTIFACTS) console.log(`  ${relative(ROOT, path)}  ${second.get(path).slice(0, 16)}`)
