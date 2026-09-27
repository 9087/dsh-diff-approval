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
const pluginClientLib = join(projectRoot, 'lib', 'client.js')
const bootScript = join(here, 'dsh-compat-boot.mjs')

/**
 * The one DSH package this plugin's CLIENT half imports at runtime.
 *
 * Every other `@deepseek-ai/...` the client names is an `import type`, which is erased before the
 * browser ever sees it and therefore cannot break a shell. This one is a value import, so the release
 * has to actually export what the client asks for. That is not hypothetical: 0.1.7 renamed the whole
 * icon set (`…Outline16` → `…OutlineMedium`), every name this plugin used vanished, and a shell whose
 * import hands back `undefined` where a component belongs dies with React error #130 — the panel did
 * exactly that, and `pnpm run compat` was 22/22 green through the whole incident because it only ever
 * booted the HOST half.
 */
const CLIENT_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'
/** The size words a shell has used as an icon name's tail (`16`/`14` before 0.1.7, `Medium`/`Regular` after). */
const ICON_SIZE_WORDS = ['16', '14', 'Medium', 'Regular', 'Small', 'Large']

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
  const skillsManifest = join(dir, 'node_modules', '@deepseek-ai', 'dsh-skill', 'package.json')
  if (existsSync(installedManifest) && existsSync(skillsManifest)) {
    const manifest = JSON.parse(await readFile(installedManifest, 'utf8'))
    if (manifest.version === version) return { dir }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-compat-${version}`, private: true, type: 'module' }, null, 2)}\n`)
  try {
    // The skill registry rides along: the comment rules are registered as a RUNTIME skill,
    // so the probe has to load the release's real registry to prove that works there. A
    // release without the package still boots (the plugin feature-detects it).
    await runNpm([
      'install', '--no-audit', '--no-fund', '--silent',
      `@deepseek-ai/cordis@${CORDIS}`,
      `@deepseek-ai/dsh-client-connection@${version}`,
      `@deepseek-ai/dsh-skill@${version}`,
    ], dir)
    return { dir }
  } catch (error) {
    const detail = (error.stderr || error.message || String(error)).trim().split('\n').slice(-4).join(' ').slice(0, 400)
    // Without the skill package the run can still be meaningful: retry with just the
    // connection release, and let the boot probe report `skills: 'absent'`.
    try {
      await runNpm([
        'install', '--no-audit', '--no-fund', '--silent',
        `@deepseek-ai/cordis@${CORDIS}`,
        `@deepseek-ai/dsh-client-connection@${version}`,
      ], dir)
      return { dir, skillsAbsent: detail }
    } catch (retryError) {
      return { dir, installError: (retryError.stderr || retryError.message || String(retryError)).trim().split('\n').slice(-4).join(' ').slice(0, 400) }
    }
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

/**
 * What the built client asks the primitives package for, read off `lib/client.js` itself.
 *
 * Reading the BUILD rather than the sources is deliberate: what has to exist in a shell is what the
 * bundle reaches for at run time, after every `import type` is gone and after the bundler has decided
 * what is external. The bundle is CommonJS, so the package arrives as
 * `x = require("@deepseek-ai/dsh-client-ui-primitives")` and its names as `x.Name`.
 *
 * Glyphs are separated from the rest because the client treats them differently: `dsh-icons.ts`
 * resolves a glyph at run time from a list of names and draws nothing when a shell offers none, so a
 * glyph needs at least ONE of its candidate names — not a specific one. Everything else is used
 * unconditionally, so it must be there exactly.
 *
 * @param source - the text of `lib/client.js`.
 * @returns `{ required, glyphs }`: names that must all exist, and glyph stems with their candidates.
 */
function clientNeeds(source) {
  const required = new Set()
  const shellNames = new Set()
  const alias = /([A-Za-z_$][\w$]*)\s*=\s*require\("@deepseek-ai\/dsh-client-ui-primitives"\)/.exec(source)
  if (alias !== null) {
    for (const match of source.matchAll(new RegExp(`${alias[1]}\\.([A-Za-z_$][\\w$]*)`, 'g'))) shellNames.add(match[1])
  }
  // Names the shim asks for at RUN time are string literals, not property accesses. Only these two
  // sources count, because the bundle also contains names of the plugin's own: the shim re-exports
  // `IconFolderOpen16 = IconFolderOpenOutline16` for its callers, and reading that as a name to ask the
  // shell for reported a glyph no shell has ever had (measured: 0.1.7 exports
  // `IconFolderOpenOutlineMedium`, which the same file names a line later).
  for (const match of source.matchAll(/['"](Icon[A-Za-z0-9_]*)['"]/g)) shellNames.add(match[1])
  const glyphs = new Map()
  for (const name of shellNames) {
    const size = ICON_SIZE_WORDS.find(word => name.endsWith(word))
    // A name with no size word is not a glyph candidate: it is used unconditionally and must exist.
    if (size === undefined) {
      required.add(name)
      continue
    }
    const stem = name.slice(0, -size.length)
    if (!glyphs.has(stem)) glyphs.set(stem, new Set())
    glyphs.get(stem).add(name)
  }
  return { required: [...required], glyphs: [...glyphs].map(([stem, names]) => ({ stem, names: [...names] })) }
}

/**
 * A self-check of {@link clientNeeds}, run before the matrix.
 *
 * The extractor is the one part of this gate that can be wrong quietly, and it was: reading every
 * `Icon…` word in the bundle made a glyph out of the plugin's OWN alias — `dsh-icons.ts` re-exports
 * `IconFolderOpen16 = IconFolderOpenOutline16` for PathPicker — so the gate demanded a name no shell
 * has ever had and failed 0.1.7 for the wrong reason. This pins the three shapes the bundle really
 * contains (a property access on the package, a quoted run-time name, and a local alias) and refuses
 * to run the matrix when the reading of them changes.
 *
 * @throws when the extractor reads a name the bundle never asks a shell for.
 */
function selfCheckClientNeeds() {
  const source = [
    'let primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
    'let LegacyFolderOpen = primitives.IconFolderOpenOutline16;',
    'let IconFolderOpen16 = LegacyFolderOpen;',
    'let Menu = primitives.Menu;',
    'const asked = "IconFolderOpenOutlineMedium";',
  ].join('\n')
  const read = clientNeeds(source)
  const stems = read.glyphs.map(entry => entry.stem)
  const names = read.glyphs.find(entry => entry.stem === 'IconFolderOpenOutline')?.names.slice().sort() ?? []
  const ok = read.required.length === 1 && read.required[0] === 'Menu'
    && stems.length === 1 && stems[0] === 'IconFolderOpenOutline'
    && names.join(',') === 'IconFolderOpenOutline16,IconFolderOpenOutlineMedium'
  if (!ok) {
    throw new Error(
      `client-needs self-check failed: read glyphs ${JSON.stringify(read.glyphs)} and required `
      + `${JSON.stringify(read.required)} from a bundle that asks for IconFolderOpenOutline16, `
      + 'IconFolderOpenOutlineMedium and Menu — a name the plugin defines itself is not a name to ask a shell for.',
    )
  }
}

/**
 * Every name a release's primitives package exports, from its own type declarations.
 *
 * `package.json` points `types` at `lib/types/index.d.ts`, and that file both names exports (`export {
 * Menu, MenuItemButton }`) and re-exports whole modules (`export * from './icons/index.tsx'`), so the
 * star exports are followed by turning the source path into its declaration path. A name that cannot
 * be resolved this way is reported by the caller as an unreadable package rather than silently passing.
 *
 * @param packageDir - the installed release's package directory.
 * @returns the exported names.
 */
async function exportedNames(packageDir) {
  const names = new Set()
  const queue = [join(packageDir, 'lib', 'types', 'index.d.ts')]
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/export (?:declare )?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(match[1])
    }
    for (const match of text.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
      for (const entry of match[1].split(',')) {
        const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
      }
    }
    for (const match of text.matchAll(/export \* from '([^']+)'/g)) {
      queue.push(join(dirname(file), match[1].replace(/\.tsx?$/, '.d.ts')))
    }
  }
  return names
}

/** Install the client-side package for one release into that release's isolated directory. */
async function ensureClientInstalled(version, dir) {
  if (existsSync(join(dir, 'node_modules', CLIENT_PACKAGE, 'package.json'))) return {}
  try {
    await runNpm(['install', '--no-audit', '--no-fund', '--silent', `${CLIENT_PACKAGE}@${version}`], dir)
    return {}
  } catch (error) {
    const detail = (error.stderr || error.message || String(error)).trim().split('\n').slice(-3).join(' ').slice(0, 300)
    return { clientInstallError: detail }
  }
}

/**
 * Check one release's client-side package against what the built client asks of it.
 *
 * @param version - the release.
 * @param dir - that release's isolated directory.
 * @param needs - the result of {@link clientNeeds}.
 * @returns `{ ok, detail, missing }`.
 */
async function checkClient(version, dir, needs) {
  const installed = await ensureClientInstalled(version, dir)
  if (installed.clientInstallError !== undefined) return { ok: false, detail: installed.clientInstallError }
  const packageDir = join(dir, 'node_modules', CLIENT_PACKAGE)
  const exports = await exportedNames(packageDir)
  if (exports.size === 0) return { ok: false, detail: 'the release\'s type declarations named no exports' }
  const missing = needs.required.filter(name => !exports.has(name))
  const undrawable = needs.glyphs.filter(glyph => !glyph.names.some(name => exports.has(name)))
  if (missing.length === 0 && undrawable.length === 0) {
    return { ok: true, detail: `${needs.glyphs.length} glyph(s), ${needs.required.length} name(s)` }
  }
  const detail = [
    missing.length > 0 ? `no export named ${missing.join(', ')}` : '',
    undrawable.length > 0 ? `no name at all for ${undrawable.map(glyph => glyph.stem).join(', ')}` : '',
  ].filter(Boolean).join('; ')
  return { ok: false, detail, missing: [...missing, ...undrawable.map(glyph => glyph.stem)] }
}

/** Every published release of the client package, or an empty array when it cannot be read. */
async function publishedClientVersions() {
  try {
    const { stdout } = await runNpm(['view', CLIENT_PACKAGE, 'versions', '--json'], projectRoot)
    const parsed = JSON.parse(stdout)
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(value => typeof value === 'string')
  } catch {
    return []
  }
}

const options = parseArgs(process.argv.slice(2))

if (!existsSync(pluginLib)) {
  console.error(`compat: ${pluginLib} is missing — run \`pnpm run build\` first.`)
  process.exit(1)
}
if (!existsSync(pluginClientLib)) {
  console.error(`compat: ${pluginClientLib} is missing — run \`pnpm run build\` first.`)
  process.exit(1)
}

// What the client half needs, read once off the build under test. The reader is checked before it is
// trusted, so a wrong reading fails the run instead of failing some release for the wrong reason.
try {
  selfCheckClientNeeds()
} catch (error) {
  console.error(`compat: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const needs = clientNeeds(await readFile(pluginClientLib, 'utf8'))
const clientVersions = await publishedClientVersions()

const all = await publishedVersions()
let targets
if (options.versions.length > 0) targets = options.versions
else if (options.all) targets = all
else targets = all.filter(version => compareVersions(version, PEER_FLOOR) >= 0)
if (options.recent > 0) targets = targets.slice(-options.recent)

const skipped = options.all ? [] : all.filter(version => compareVersions(version, PEER_FLOOR) < 0)

console.log(`compat: ${targets.length} release(s) in scope, plugin build ${pluginLib}`)
console.log(`compat: client needs ${needs.glyphs.length} glyph(s) and ${needs.required.length} unconditional name(s) from ${CLIENT_PACKAGE} (reader self-checked)`)
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
  const { activated, mounted, error, routes, skills, skillBody } = probed.result
  // The client check runs for every release that published the package, whether or not the host half
  // mounted: "the shell renamed what we import" and "the host service moved" are different failures,
  // and a run that stops at the first one would hide the second until the first was fixed.
  const client = clientVersions.includes(version)
    ? await checkClient(version, installed.dir, needs)
    : { ok: true, detail: `${CLIENT_PACKAGE} is not published at this version (not checked)` }
  const mountedNote = `channel mounted (routes: ${(routes ?? []).join(', ')}`
    + `${(skills ?? []).length > 0 ? `, skill: ${skills.join(', ')}${skillBody === true ? ' (body loaded)' : ' (NO BODY)'}` : ', no skill registry'}`
    + `, client: ${client.detail})`
  if (activated && mounted && client.ok) {
    rows.push({ version, status: 'ok', routes, skills, skillBody, client: client.detail })
    console.log(`  ${version.padEnd(14)} ok              ${mountedNote}${note}`)
  } else {
    if (supported) failed += 1
    else outOfScopeFailures += 1
    const detail = activated && mounted
      ? `client: ${client.detail}`
      : (error ?? 'plugin activated but the channel was not mounted')
    rows.push({ version, status: 'FAIL', detail })
    console.log(`  ${version.padEnd(14)} FAIL            ${detail}${note}`)
  }
}

console.log('')
console.log(`compat: ${inScope - failed}/${inScope} supported release(s) OK`)
if (outOfScopeFailures > 0) {
  console.log(`compat: ${outOfScopeFailures} release(s) below the peer floor ${PEER_FLOOR} did not mount (out of range, not gating)`)
}
if (skipped.length > 0) console.log(`compat: skipped below the declared floor: ${skipped.join(', ')}`)
process.exit(failed === 0 ? 0 : 1)
