#!/usr/bin/env node
/**
 * Check a release that has ALREADY been pushed: the two things a successful `release-it` does not prove.
 *
 * `release-it` bumps the version, commits, tags and pushes. What it cannot see is whether this
 * repository's own workflows then agreed — they run on GitHub, not here — and whether the registry
 * really received the artifact the tag names. Both have been wrong here, and both were found late:
 *
 *   - v0.30.0 was tagged and pushed with a FAILING suite. A case asserted a Windows-only path, so it was
 *     green on the machine that wrote it and red on Linux; CI is the only place that can see that. The
 *     tag reached GitHub and nothing reached npm: the Release workflow died in `pnpm test`, before
 *     `npm publish`.
 *   - v0.30.1 then LOOKED absent from the registry for ten minutes. It was not. The reads were served
 *     from a cache upstream of this machine, which `npm --prefer-online` and an empty cache directory
 *     both failed to defeat. Hence the shape of this script: it trusts only what it asks for itself,
 *     and it cross-checks the answer against the tarball it downloads and hash-checks.
 *
 * Usage:
 *   node scripts/verify-release.mjs [version] [--no-github]
 *
 * Defaults to the version in package.json; `--no-github` skips the workflow half (for a machine that
 * cannot reach the GitHub API) and says so in the output rather than silently passing. Exits non-zero
 * if any check fails, so it can gate a release — `pnpm run release` runs it after `release-it` — and be
 * re-run on its own as `pnpm run verify:release`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = Number(process.env.VERIFY_RELEASE_TIMEOUT_MS ?? 10 * 60 * 1000)
const POLL_MS = Number(process.env.VERIFY_RELEASE_POLL_MS ?? 15_000)
const USER_AGENT = 'dsh-diff-approval-verify-release'

const results = []
const record = (name, ok, detail) => { results.push({ name, ok, detail }); return ok }
const pass = (name, detail) => record(name, true, detail)
const fail = (name, detail) => record(name, false, detail)
const skip = (name, detail) => record(name, null, detail)

/** The first couple of lines a command said, for a failure that explains itself. */
function reason(error) {
  const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? String(error)}`
  return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2).join(' | ').slice(0, 300)
}

/** Run `git` — a real executable, so no shell is involved on any platform. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Run `npm`.
 *
 * Windows ships npm as a `.cmd`, which Node refuses to spawn directly without a shell, so there the
 * command line is built by hand — the arguments are fixed by this file, and the only variable part is a
 * temp directory path.
 */
function npm(args, options = {}) {
  const spawn = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }
  if (process.platform === 'win32') {
    const line = ['npm', ...args].map(quote).join(' ')
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], spawn)
  }
  return execFileSync('npm', args, spawn)
}

/** Quote one argument for `cmd.exe`, which re-parses the command line npm is reached through. */
function quote(value) {
  return /[\s"^&|<>]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/** The value of an option given as `--name value` or `--name=value`. */
function option(name, argv) {
  const inline = argv.find(argument => argument.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/** `git+https://github.com/owner/repo.git` → `owner/repo`. */
function slugOf(url) {
  const match = /github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?].*)?$/.exec(url ?? '')
  if (match === null) throw new Error(`cannot read a GitHub repository out of ${JSON.stringify(url)}`)
  return `${match[1]}/${match[2]}`
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wait until every check run for `sha` has concluded, so the answer is about a finished CI rather than
 * an absent one.
 *
 * @returns the runs it last saw, and whether it ran out of time waiting for them.
 */
async function checkRuns(slug, sha) {
  const url = `https://api.github.com/repos/${slug}/commits/${sha}/check-runs`
  const deadline = Date.now() + TIMEOUT_MS
  let seen = []
  for (;;) {
    const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT } })
      .catch(error => ({ status: 0, statusText: String(error), ok: false, json: async () => ({}) }))
    if (response.status === 403 || response.status === 429) {
      throw new Error(`the GitHub API refused the request (${response.status} ${response.statusText})`)
    }
    if (response.ok) {
      seen = (await response.json()).check_runs ?? []
      if (seen.length > 0 && seen.every(run => run.status === 'completed')) return { runs: seen, timedOut: false }
    } else if (response.status !== 0) {
      throw new Error(`the GitHub API answered ${response.status} ${response.statusText}`)
    }
    if (Date.now() >= deadline) return { runs: seen, timedOut: true }
    await sleep(POLL_MS)
  }
}

async function main() {
  const root = process.cwd()
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const argv = process.argv.slice(2)
  const withGithub = !argv.includes('--no-github')
  // Positional arguments only: `--registry <url>` must not be mistaken for a version.
  const positional = argv.filter((argument, index) => !argument.startsWith('-') && argv[index - 1] !== '--registry')
  const version = positional[0] ?? pkg.version

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`verify-release: ${JSON.stringify(version)} is not a version to verify`)
    process.exitCode = 1
    return
  }

  const tag = `v${version}`
  let tagCommit = ''
  try {
    tagCommit = git(['rev-parse', `${tag}^{commit}`], root)
  } catch (error) {
    fail(`the local tag ${tag} names a commit`, reason(error))
    report(pkg.name, version, tag, tagCommit, '')
    return
  }

  // The OFFICIAL registry by default, never whatever `npm config` answers: a user-level config can
  // shadow this repository's own `.npmrc`, and a mirror is a different truth source. Measured on the
  // machine this was written on — `npm config get registry` answered the long-dead
  // `http://registry.npm.taobao.org` while the repo pins npmjs. `--registry <url>` overrides.
  const registry = option('--registry', argv) ?? process.env.VERIFY_RELEASE_REGISTRY ?? 'https://registry.npmjs.org/'
  const configured = npm(['config', 'get', 'registry']).trim()
  if (configured.replace(/\/+$/, '') !== registry.replace(/\/+$/, '')) {
    console.log(`verify-release: note — npm's configured registry is ${configured}; these checks used ${registry}`)
  }
  const slug = slugOf(pkg.repository?.url)

  // ── The half only GitHub can answer: did the workflows for this commit agree? ──────────────────────
  if (withGithub) {
    try {
      const { runs, timedOut } = await checkRuns(slug, tagCommit)
      const names = runs.map(run => `${run.name}=${run.conclusion ?? run.status}`).join(', ')
      if (runs.length === 0) fail('GitHub: a workflow ran for this commit', 'no check run was ever created')
      else if (timedOut) fail('GitHub: every workflow for this commit concluded', `still running after ${TIMEOUT_MS / 1000}s: ${names}`)
      else if (runs.some(run => run.conclusion !== 'success')) fail('GitHub: every workflow for this commit is green', names)
      else pass(`GitHub: ${runs.length} workflow(s) green`, names)
    } catch (error) {
      fail('GitHub: the workflows could be read', reason(error))
    }
  } else {
    skip('GitHub: the workflows are green', '--no-github: nothing was asked, nothing is known')
  }

  // ── The registry half: is the artifact on npm the one this tag names? ─────────────────────────────
  const fields = ['version', 'gitHead', 'dist.integrity', 'dist.fileCount', 'dist.unpackedSize', 'dist.tarball']
  let manifest = undefined
  try {
    manifest = JSON.parse(npm(['view', `${pkg.name}@${version}`, ...fields, '--json', '--registry', registry]))
    pass(`registry: ${pkg.name}@${version} is published`, `${manifest['dist.unpackedSize']} bytes, ${manifest['dist.tarball']}`)
  } catch (error) {
    fail(`registry: ${pkg.name}@${version} is published`, reason(error))
  }

  if (manifest !== undefined) {
    // The load-bearing one: a tarball published from a DIFFERENT commit is not the release that was tagged.
    if (manifest.gitHead === tagCommit) pass('registry: the artifact came from the tagged commit', `gitHead ${tagCommit.slice(0, 10)}`)
    else fail('registry: the artifact came from the tagged commit', `gitHead ${manifest.gitHead ?? '(none)'} != tag ${tagCommit.slice(0, 10)}`)

    try {
      const latest = JSON.parse(npm(['view', pkg.name, 'dist-tags', '--json', '--registry', registry])).latest
      // A prerelease is published without moving `latest`, which is why only a stable version must be it.
      if (latest === version || version.includes('-')) pass('registry: dist-tags', `latest=${latest}`)
      else fail('registry: dist-tags', `latest=${latest}, not ${version}`)
    } catch (error) {
      fail('registry: dist-tags could be read', reason(error))
    }

    const work = mkdtempSync(join(tmpdir(), 'dsh-verify-release-'))
    try {
      const packed = JSON.parse(npm(['pack', `${pkg.name}@${version}`, '--json', '--pack-destination', work, '--registry', registry]))
      const tarball = packed[0] ?? {}
      const files = (tarball.files ?? []).map(file => file.path)

      if (tarball.integrity === manifest['dist.integrity']) pass('tarball: integrity matches the registry', String(tarball.integrity).slice(0, 24))
      else fail('tarball: integrity matches the registry', `${tarball.integrity} != ${manifest['dist.integrity']}`)

      if (tarball.entryCount === manifest['dist.fileCount']) pass('tarball: every entry is there', `${tarball.entryCount} entries`)
      else fail('tarball: every entry is there', `${tarball.entryCount} entries != dist.fileCount ${manifest['dist.fileCount']}`)

      // Derived from the package's own manifest, so a renamed entry point fails here instead of at load.
      // The manifest writes `./lib/client.js` while npm reports `lib/client.js`, so both sides lose the
      // `./` — without that this check failed on a package that was perfectly fine.
      const normalize = entry => entry.replace(/^\.\//, '')
      const loads = [pkg.main, pkg.exports?.['./client']?.default, pkg.dsh?.bundle?.patch]
        .filter(entry => typeof entry === 'string')
        .map(normalize)
      const missing = loads.filter(entry => !files.some(file => normalize(file) === entry))
      if (missing.length === 0) pass('tarball: the files the plugin loads are in it', loads.join(', '))
      else fail('tarball: the files the plugin loads are in it', `missing: ${missing.join(', ')}`)

      if (files.some(file => /(^|\/)fonts\/manifest\.json$/.test(file))) pass('tarball: the font manifest ships')
      else fail('tarball: the font manifest ships', 'no fonts/manifest.json among the entries')

      // The only check that proves the artifact RUNS: install it into an empty project and import it.
      const project = join(work, 'smoke')
      mkdirSync(project)
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'verify-release-smoke', private: true, type: 'module' }))
      npm(['install', `${pkg.name}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry],
        { cwd: project, timeout: 5 * 60 * 1000 })
      const importScript = `import(${JSON.stringify(pkg.name)}).then(m => { const n = Object.keys(m);`
        + ` if (n.length === 0) { console.error('the module exported nothing'); process.exit(1) } console.log(n.length) })`
        + `.catch(e => { console.error(e?.message ?? String(e)); process.exit(1) })`
      const exported = execFileSync(process.execPath, ['-e', importScript], { cwd: project, encoding: 'utf8' }).trim()
      if (Number(exported) > 0) pass('artifact: installs into a clean project and imports', `${exported} export(s)`)
      else fail('artifact: installs into a clean project and imports', 'the import reported no exports')
    } catch (error) {
      fail('artifact: the published tarball could be inspected and run', reason(error))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  } else {
    skip('tarball: the artifact matches the tag', 'nothing is published, so there is no artifact to check')
  }

  report(pkg.name, version, tag, tagCommit, registry)
}

/** Print every check, and set the exit code from them. */
function report(name, version, tag, tagCommit, registry) {
  console.log(`verify-release: ${name}@${version}  (tag ${tag}${tagCommit === '' ? '' : ` -> ${tagCommit.slice(0, 10)}`}${registry === '' ? '' : `, registry ${registry}`})`)
  for (const result of results) {
    const mark = result.ok === true ? 'PASS' : result.ok === false ? 'FAIL' : 'SKIP'
    console.log(`  ${mark}  ${result.name}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
  }
  const passed = results.filter(result => result.ok === true).length
  const failed = results.filter(result => result.ok === false).length
  console.log(`verify-release: ${passed}/${results.length} check(s) passed${failed === 0 ? '' : `, ${failed} FAILED`}`)
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
