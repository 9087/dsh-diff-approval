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
 * The shell packages whose own shipped code this plugin reads a contract out of, installed per release.
 *
 * The names come from the mounted seats (`src/client/index.ts`) and from the presses the panel routes
 * (`src/client/produced-diff.ts`); each package here is the one that declares that name in its entry
 * bundle, measured rather than assumed.
 */
const SHELL_PACKAGES = [
  CLIENT_PACKAGE,
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-deliverables',
]

/**
 * What this plugin reads out of a shell, and every name it accepts for each dependency.
 *
 * The rule is the icon rule, for the same reason: the plugin already tolerates an older spelling and a
 * newer one (its file-press selector unions three attributes, its session seat reads several fields),
 * so the contract is "a way to reach this still exists", not "this exact spelling exists". Each entry
 * is therefore checked by finding at least one of its names in the release's own code — and a shell
 * that renames a seat, or moves the marker on a list, fails here instead of silently taking the
 * plugin's UI apart in the reader's browser.
 *
 * NOT covered, and why: `settings.section` is a literal only in the settings-PAGE packages
 * (`dsh-client-ui-settings-general` and its siblings), which this plugin does not otherwise depend on
 * and would have to install per release just to grep one string. A rename there costs the settings tab,
 * which is what the browser smoke test is for.
 */
const SHELL_CONTRACTS = [
  {
    what: 'the footer seat the pending-changes entry mounts into',
    any: ['sidebar.footer.action'],
    in: ['@deepseek-ai/dsh-client-ui-sidebar'],
  },
  {
    what: 'the docked seat the panel mounts into',
    any: ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
    in: ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-deliverables'],
    // Measured, not guessed: the matrix is what said 0.1.5-alpha.1 is the first release carrying this seat.
    // Below it the seat does not exist, and this plugin's dock mount feature-detects exactly that — the
    // gate is here to catch the seat being RENAMED later, not to demand one a release never had.
    since: '0.1.5-alpha.1',
  },
  {
    what: 'the session-header seat the header entry mounts into',
    any: ['conversation.session.header.utilities'],
    in: ['@deepseek-ai/dsh-client-ui-conversation'],
  },
  {
    what: 'a file press that opens a file in the shell\'s own viewer',
    any: ['data-produced-files-row', 'data-presented-files-row', 'data-changed-files'],
    in: ['@deepseek-ai/dsh-client-ui-deliverables', '@deepseek-ai/dsh-client-ui-conversation'],
  },
  {
    what: 'the shell\'s own review-pane file picker, which this plugin leaves alone',
    any: ['data-review-file'],
    in: ['@deepseek-ai/dsh-client-ui-deliverables'],
    // Measured: 0.1.6-alpha.2 is the first release with this picker. Before it there is nothing for this
    // plugin to leave alone, so the contract is skipped rather than failed.
    since: '0.1.6-alpha.2',
  },
]

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

/** One name as regex source text, so a `$` in an identifier cannot become an anchor. */
const asPattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether ONE access to a package name is a CAPABILITY PROBE rather than an unconditional use.
 *
 * `dsh-icons.ts` asks `typeof primitives.ShortcutKeys === 'function'` to learn whether the running shell
 * can draw a shortcut as keycaps. That name is EXPECTED to be missing on hosts older than the primitives'
 * 0.1.7-rc.2, and the bundle works there by falling back to a glued label — but the extractor could not
 * see the guard, so the probe became a hard requirement and every earlier release failed for a name the
 * plugin only ever asks ABOUT. A probe is therefore collected separately and reported as satisfied or
 * absent, never demanded.
 *
 * The recognised shapes are the ones that mean "this may be missing": `typeof P.X` (how the bundle spells
 * it), a POSITIVE truthiness test (`if (P.X)`, `P.X && …`, `P.X || …`, `P.X ? …`), and `'X' in P` — that
 * last one collected in {@link clientNeeds}, since it has no property access to look at. A NEGATED test is
 * deliberately NOT recognised: `if (!P.X) throw …` asserts the name must be there, and treating it as
 * optional would let a genuinely required name through the gate.
 *
 * @param source - the text of `lib/client.js`.
 * @param at - the index the access starts at.
 * @param length - the access's length.
 * @returns whether this access is a probe.
 */
function isCapabilityProbe(source, at, length) {
  const before = source.slice(Math.max(0, at - 24), at)
  const after = source.slice(at + length, at + length + 8)
  if (/typeof\s*\(?\s*$/.test(before)) return true
  if (/(?:if|while)\s*\(\s*$/.test(before)) return true
  return /^\s*\)?\s*(?:&&|\|\||\?)/.test(after)
}

/**
 * Whether EVERY time the bundle touches `alias.<name>` is a probe.
 *
 * "Every", not "any": a name that is probed AND also used unconditionally stays required, because the
 * unconditional use is the one that has to exist in the shell.
 *
 * @param source - the text of `lib/client.js`.
 * @param alias - the local name the bundle requires the package into.
 * @param name - the property name.
 * @returns whether every access is a probe.
 */
function everyAccessIsProbe(source, alias, name) {
  const access = new RegExp(`${asPattern(alias)}\\.${asPattern(name)}\\b`, 'g')
  const found = [...source.matchAll(access)]
  // No property access at all: a name the bundle only ever names as a string is not probed this way.
  if (found.length === 0) return false
  return found.every(match => isCapabilityProbe(source, match.index, match[0].length))
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
 * unconditionally, so it must be there exactly — UNLESS every access to it is a capability probe
 * (`typeof P.X`, a positive truthiness test, or `'X' in P`), in which case it is reported as present or
 * absent and never demanded (see {@link isCapabilityProbe}).
 *
 * @param source - the text of `lib/client.js`.
 * @returns `{ required, glyphs, optional }`: names that must all exist, glyph stems with their
 *   candidates, and the names the bundle only ever asks about.
 */
function clientNeeds(source) {
  const required = new Set()
  const optional = new Set()
  const shellNames = new Set()
  const alias = /([A-Za-z_$][\w$]*)\s*=\s*require\("@deepseek-ai\/dsh-client-ui-primitives"\)/.exec(source)
  if (alias !== null) {
    for (const match of source.matchAll(new RegExp(`${alias[1]}\\.([A-Za-z_$][\\w$]*)`, 'g'))) shellNames.add(match[1])
    // `'Name' in alias` asks the same capability question with a string, so it never shows up as a
    // property access: collected here, as the probe it is.
    for (const match of source.matchAll(new RegExp(`['"]([A-Za-z_$][\\w$]*)['"]\\s+in\\s+${alias[1]}\\b`, 'g'))) {
      optional.add(match[1])
    }
  }
  // Names the shim asks for at RUN time are string literals, not property accesses. Only these two
  // sources count, because the bundle also contains names of the plugin's own: the shim re-exports
  // `IconFolderOpen16 = IconFolderOpenOutline16` for its callers, and reading that as a name to ask the
  // shell for reported a glyph no shell has ever had (measured: 0.1.7 exports
  // `IconFolderOpenOutlineMedium`, which the same file names a line later).
  for (const match of source.matchAll(/['"](Icon[A-Za-z0-9_]*)['"]/g)) shellNames.add(match[1])
  const glyphs = new Map()
  for (const name of shellNames) {
    if (optional.has(name)) continue
    // Probed everywhere it is touched: an optional capability, reported but never required.
    if (alias !== null && everyAccessIsProbe(source, alias[1], name)) {
      optional.add(name)
      continue
    }
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
  return {
    required: [...required],
    glyphs: [...glyphs].map(([stem, names]) => ({ stem, names: [...names] })),
    optional: [...optional],
  }
}

/**
 * A self-check of {@link clientNeeds}, run before the matrix.
 *
 * The extractor is the one part of this gate that can be wrong quietly, and it has been twice: reading
 * every `Icon…` word in the bundle made a glyph out of the plugin's OWN alias (`dsh-icons.ts` re-exports
 * `IconFolderOpen16 = IconFolderOpenOutline16` for PathPicker), so the gate demanded a name no shell has
 * ever had; and reading a capability probe as an unconditional use turned `typeof primitives.ShortcutKeys`
 * into a hard requirement, failing every release before 0.1.7-rc.2 for a name the plugin only asks ABOUT.
 * This pins the shapes the bundle really contains — a property access on the package, a quoted run-time
 * name, a local alias, a `typeof` probe, a positive truthiness test, an `'X' in P` test, and a name that
 * is probed AND used — and refuses to run the matrix when the reading of any of them changes.
 *
 * @throws when the extractor reads a name the bundle never asks a shell for, or demands one it only probes.
 */
function selfCheckClientNeeds() {
  const source = [
    'let primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
    'let LegacyFolderOpen = primitives.IconFolderOpenOutline16;',
    'let IconFolderOpen16 = LegacyFolderOpen;',
    'let Menu = primitives.Menu;',
    'const asked = "IconFolderOpenOutlineMedium";',
    // A capability probe is expected to be missing on older shells, so it must NOT become a requirement…
    'const canDraw = typeof primitives.ShortcutKeys === "function";',
    // …and neither must the same question asked as a truthiness test or with a string. Each shape gets
    // its OWN name: sharing one would let a rule that stopped working hide behind another that still did.
    'if (primitives.Tooltip) { use(); }',
    'const hasPopover = "Popover" in primitives;',
    // …while a name that is probed AND also used unconditionally stays required: the use is what must exist.
    'const hasMenu = typeof primitives.Menu === "function";',
  ].join('\n')
  const read = clientNeeds(source)
  const stems = read.glyphs.map(entry => entry.stem)
  const names = read.glyphs.find(entry => entry.stem === 'IconFolderOpenOutline')?.names.slice().sort() ?? []
  const optional = read.optional.slice().sort().join(',')
  const ok = read.required.length === 1 && read.required[0] === 'Menu'
    && stems.length === 1 && stems[0] === 'IconFolderOpenOutline'
    && names.join(',') === 'IconFolderOpenOutline16,IconFolderOpenOutlineMedium'
    && optional === 'Popover,ShortcutKeys,Tooltip'
  if (!ok) {
    throw new Error(
      `client-needs self-check failed: read glyphs ${JSON.stringify(read.glyphs)}, required `
      + `${JSON.stringify(read.required)} and probes ${JSON.stringify(read.optional)} from a bundle that asks `
      + 'for IconFolderOpenOutline16, IconFolderOpenOutlineMedium and Menu, probes ShortcutKeys (typeof), '
      + 'Tooltip (truthiness) and Popover (`in`), and probes but also USES Menu — a name the plugin defines '
      + 'itself is not a name to ask a shell for, and a name it only probes about is not one to demand.',
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

/**
 * Install the shell packages this plugin reads contracts out of, into one release's directory.
 *
 * A package that is not published at this version is collected rather than treated as a failure: the
 * deliverables package only exists from 0.1.6, and a release that predates a seat has nothing to check
 * there. Installs are cached by directory, so a re-run pays only for what is missing.
 *
 * @param version - the release.
 * @param dir - that release's isolated directory.
 * @returns the packages that could not be installed.
 */
async function ensureShellInstalled(version, dir) {
  const absent = []
  for (const name of SHELL_PACKAGES) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) continue
    try {
      await runNpm(['install', '--no-audit', '--no-fund', '--silent', `${name}@${version}`], dir)
    } catch {
      absent.push(name)
    }
  }
  return { absent }
}

/**
 * The shipped code of one release's shell packages, per package.
 *
 * Only the two files a browser loads first (`lib/client.js`, `lib/index.js`): these packages also ship
 * lazy chunks (`client.pdf.js` and its siblings, megabytes of vendored viewer code), while the seats and
 * the list markers this check looks for live in the entry bundle.
 *
 * @param dir - that release's isolated directory.
 * @returns a map of package name to entry-bundle text, for the packages that are installed.
 */
async function shellSourcesOf(dir) {
  const sources = new Map()
  for (const name of SHELL_PACKAGES) {
    const parts = []
    for (const file of ['client.js', 'index.js']) {
      const path = join(dir, 'node_modules', name, 'lib', file)
      if (existsSync(path)) parts.push(await readFile(path, 'utf8'))
    }
    if (parts.length > 0) sources.set(name, parts.join('\n'))
  }
  return sources
}

/**
 * Check one release's shell against every contract this plugin reads out of it.
 *
 * A contract is enforced only where one of the packages it could live in is installed; one of its names
 * must then appear in one of them. That keeps a release predating a package from failing because the
 * package is absent (the deliverables package starts at 0.1.6) while a release that HAS the package and
 * has renamed what this plugin reads out of it still fails. How many contracts were skipped that way is
 * reported, because a check that quietly skipped is not evidence.
 *
 * @param sources - {@link shellSourcesOf}'s map.
 * @returns `{ ok, detail }`, naming what is missing rather than only that something is.
 */
function checkContracts(sources, version) {
  const broken = []
  let checked = 0
  let skipped = 0
  for (const contract of SHELL_CONTRACTS) {
    // A contract with a floor is about a surface some releases never carried: this plugin feature-detects
    // the absence (its dock mount stands down, its picker exclusion simply never matches), so BELOW the
    // floor there is nothing to be compatible with. Above it, a missing name is exactly the rename this
    // gate exists to catch — the floor is not a licence to drop a name quietly.
    if (contract.since !== undefined && compareVersions(version, contract.since) < 0) {
      skipped += 1
      continue
    }
    const usable = contract.in.filter(name => sources.has(name))
    if (usable.length === 0) {
      skipped += 1
      continue
    }
    checked += 1
    if (!contract.any.some(name => usable.some(pkg => sources.get(pkg).includes(name)))) broken.push(contract)
  }
  const note = skipped > 0 ? `, ${skipped} skipped` : ''
  if (broken.length === 0) return { ok: true, detail: `${checked} contract(s)${note}` }
  return { ok: false, detail: `${broken.map(contract => `no ${contract.what}`).join('; ')}${note}` }
}

/**
 * Check one release's client half: the names the plugin's bundle asks for, and the contracts it reads
 * out of the shell's own code.
 *
 * @param version - the release.
 * @param dir - that release's isolated directory.
 * @param needs - the result of {@link clientNeeds}.
 * @returns `{ ok, detail, missing }`.
 */
async function checkClient(version, dir, needs) {
  const installed = await ensureShellInstalled(version, dir)
  const packageDir = join(dir, 'node_modules', CLIENT_PACKAGE)
  if (!existsSync(join(packageDir, 'package.json'))) {
    return { ok: false, detail: `${CLIENT_PACKAGE} could not be installed: ${installed.absent.join(', ')}` }
  }
  const exports = await exportedNames(packageDir)
  if (exports.size === 0) return { ok: false, detail: 'the release\'s type declarations named no exports' }
  const missing = needs.required.filter(name => !exports.has(name))
  const undrawable = needs.glyphs.filter(glyph => !glyph.names.some(name => exports.has(name)))
  const names = [
    missing.length > 0 ? `no export named ${missing.join(', ')}` : '',
    undrawable.length > 0 ? `no name at all for ${undrawable.map(glyph => glyph.stem).join(', ')}` : '',
  ].filter(Boolean).join('; ')
  if (names !== '') return { ok: false, detail: names, missing: [...missing, ...undrawable.map(glyph => glyph.stem)] }
  // A probed name is reported, never demanded: it is absent by design on the hosts this plugin supports
  // both sides of (see `isCapabilityProbe`), so the run says which way each probe answered and moves on.
  const probes = needs.optional.length === 0 ? '' : `, probes: ${needs.optional
    .map(name => `${name} ${exports.has(name) ? 'present' : 'absent (fallback)'}`)
    .join(', ')}`
  const contracts = checkContracts(await shellSourcesOf(dir), version)
  if (!contracts.ok) return { ok: false, detail: `contract: ${contracts.detail}` }
  return {
    ok: true,
    detail: `${needs.glyphs.length} glyph(s), ${needs.required.length} name(s)${probes}, ${contracts.detail}`,
  }
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
if (needs.optional.length > 0) {
  console.log(`compat: plus ${needs.optional.length} probed name(s) — optional by design, reported per release: ${needs.optional.join(', ')}`)
}
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
