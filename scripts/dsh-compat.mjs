// Compatibility matrix: boot the built plugin against the REAL published
// releases of @deepseek-ai/dsh-client-connection.
//
// This is deliberately NOT part of `pnpm test`: it installs packages from the
// registry, so it is slow and needs the network. Run it on demand:
//
//   pnpm run compat                 # every release inside the declared peer range
//   pnpm run compat -- --all        # every published release, including older ones
//   pnpm run compat -- --recent 6   # the newest 6 releases
//   pnpm run compat -- --versions 0.1.2-rc.1,0.1.5-rc.1
//
// Each release is installed into its own isolated directory under `.compat/`
// (git-ignored and reused between runs), so releases never resolve against each
// other and a re-run only installs what is missing. The plugin is the real build
// from `lib/`, so run `pnpm run build` first.

import { exec, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runNode = promisify(execFile)
const runShell = promisify(exec)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const compatRoot = join(projectRoot, '.compat')
const pluginLib = join(projectRoot, 'lib', 'index.js')
const bootScript = join(here, 'dsh-compat-boot.mjs')

/**
 * Run npm. `npm` is a `.cmd` shim on Windows, which needs a shell, so the command
 * is assembled as a string with each argument quoted.
 * @param args - npm arguments.
 * @param cwd - working directory.
 * @returns the captured stdout.
 */
function runNpm(args, cwd) {
  const quote = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const command = ['npm', ...args].map(quote).join(' ')
  return runShell(command, { cwd, maxBuffer: 32 * 1024 * 1024 })
}

/** The floor declared by this plugin's peer range (`>=0.1.0-rc.5`). */
const PEER_FLOOR = '0.1.0-rc.5'
/** Cordis to install alongside; satisfies every release's peer range seen so far. */
const CORDIS = '^4.0.2'

function parseVersion(value) {
  const [core = '', pre = ''] = value.split('-')
  const nums = core.split('.').map(part => Number.parseInt(part, 10) || 0)
  return { nums: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre: pre === '' ? [] : pre.split('.') }
}

/** Compare two versions, treating a prerelease as lower than its release. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    if (ln && rn) return Number(l) < Number(r) ? -1 : 1
    if (ln !== rn) return ln ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

/** Every published release, oldest first. */
async function publishedVersions() {
  const { stdout } = await runNpm(['view', '@deepseek-ai/dsh-client-connection', 'versions', '--json'], projectRoot)
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(value => typeof value === 'string')
}

function parseArgs(argv) {
  const options = { all: false, recent: 0, versions: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') options.all = true
    else if (arg === '--recent') options.recent = Number.parseInt(argv[++i] ?? '0', 10) || 0
    else if (arg === '--versions') options.versions = (argv[++i] ?? '').split(',').map(v => v.trim()).filter(Boolean)
  }
  return options
}

/** Install one release into its isolated directory; reuse an existing install. */
async function ensureInstalled(version) {
  const dir = join(compatRoot, version)
  const installedManifest = join(dir, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'package.json')
  if (existsSync(installedManifest)) {
    const manifest = JSON.parse(await readFile(installedManifest, 'utf8'))
    if (manifest.version === version) return { dir }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-compat-${version}`, private: true, type: 'module' }, null, 2)}\n`)
  try {
    await runNpm([
      'install', '--no-audit', '--no-fund', '--silent',
      `@deepseek-ai/cordis@${CORDIS}`,
      `@deepseek-ai/dsh-client-connection@${version}`,
    ], dir)
    return { dir }
  } catch (error) {
    return { dir, installError: (error.stderr || error.message || String(error)).trim().split('\n').slice(-4).join(' ').slice(0, 400) }
  }
}

/** Boot the plugin against one installed release. */
async function probe(version, dir) {
  const storageDir = join(dir, 'storage')
  await mkdir(storageDir, { recursive: true })
  try {
    const { stdout } = await runNode(process.execPath, [bootScript, dir, pluginLib, storageDir], {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024,
    })
    const line = stdout.split('\n').reverse().find(entry => entry.startsWith('__COMPAT__'))
    if (line === undefined) return { ok: false, detail: 'no result line from the boot probe' }
    return { ok: true, result: JSON.parse(line.slice('__COMPAT__'.length)) }
  } catch (error) {
    const detail = (error.stdout || error.stderr || error.message || String(error)).trim().split('\n').slice(-3).join(' ').slice(0, 400)
    return { ok: false, detail }
  }
}

const options = parseArgs(process.argv.slice(2))

if (!existsSync(pluginLib)) {
  console.error(`compat: ${pluginLib} is missing — run \`pnpm run build\` first.`)
  process.exit(1)
}

const all = await publishedVersions()
let targets
if (options.versions.length > 0) targets = options.versions
else if (options.all) targets = all
else targets = all.filter(version => compareVersions(version, PEER_FLOOR) >= 0)
if (options.recent > 0) targets = targets.slice(-options.recent)

const skipped = options.all ? [] : all.filter(version => compareVersions(version, PEER_FLOOR) < 0)

console.log(`compat: ${targets.length} release(s) in scope, plugin build ${pluginLib}`)
console.log(`compat: peer floor ${PEER_FLOOR}${skipped.length > 0 ? `, ${skipped.length} older release(s) skipped (use --all)` : ''}`)
console.log('')

const rows = []
let failed = 0
let inScope = 0
let outOfScopeFailures = 0
for (const version of targets) {
  // Releases below the declared peer floor are reported for information only —
  // they may predate services this plugin injects (0.0.1 renamed `httpServer` to
  // `webServer`), so they must not gate the run.
  const supported = compareVersions(version, PEER_FLOOR) >= 0
  if (supported) inScope += 1
  const note = supported ? '' : '  (out of range)'
  const installed = await ensureInstalled(version)
  if (installed.installError !== undefined) {
    rows.push({ version, status: 'INSTALL FAILED', detail: installed.installError })
    if (supported) failed += 1
    else outOfScopeFailures += 1
    console.log(`  ${version.padEnd(14)} INSTALL FAILED  ${installed.installError}${note}`)
    continue
  }
  const probed = await probe(version, installed.dir)
  if (!probed.ok) {
    rows.push({ version, status: 'PROBE FAILED', detail: probed.detail })
    if (supported) failed += 1
    else outOfScopeFailures += 1
    console.log(`  ${version.padEnd(14)} PROBE FAILED    ${probed.detail}${note}`)
    continue
  }
  const { activated, mounted, error, routes } = probed.result
  if (activated && mounted) {
    rows.push({ version, status: 'ok', routes })
    console.log(`  ${version.padEnd(14)} ok              channel mounted (routes: ${(routes ?? []).join(', ')})${note}`)
  } else {
    if (supported) failed += 1
    else outOfScopeFailures += 1
    rows.push({ version, status: 'FAIL', detail: error })
    console.log(`  ${version.padEnd(14)} FAIL            ${error ?? 'plugin activated but the channel was not mounted'}${note}`)
  }
}

console.log('')
console.log(`compat: ${inScope - failed}/${inScope} supported release(s) OK`)
if (outOfScopeFailures > 0) {
  console.log(`compat: ${outOfScopeFailures} release(s) below the peer floor ${PEER_FLOOR} did not mount (out of range, not gating)`)
}
if (skipped.length > 0) console.log(`compat: skipped below the declared floor: ${skipped.join(', ')}`)
process.exit(failed === 0 ? 0 : 1)
