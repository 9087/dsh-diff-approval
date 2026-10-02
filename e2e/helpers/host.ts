/**
 * Host-process plumbing for the real-browser E2E: resolve a `dsh` executable, boot
 * `dsh web` against a throwaway `DSH_HOME`, seed the plugin's own storage, and tear
 * the process down again.
 *
 * Two rules this file exists to keep:
 *
 * - The store is read once and cached by the plugin host, so a fixture written after
 *   the host booted is a fixture the panel never sees. Every seed here happens
 *   BEFORE the process that reads it starts (see `bootstrapHome` / `seedPending`).
 * - Nothing here may end a process this file did not start. `stopHost` kills the
 *   exact child it spawned (and, only as a last resort, that child's own tree by PID).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Repository root (the package the profile links to). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Whether the phase timings are being printed at all.
 *
 * Read once, at module load, so one run cannot report some phases and swallow others.
 * OFF by default: a plain `pnpm run e2e` is meant to print Playwright's own result and
 * nothing else, and these lines are for comparing two runs of a measurement, not for
 * every run. `E2E_TIMING=1 pnpm run e2e` asks for them.
 */
const timingEnabled = process.env.E2E_TIMING === '1'

/**
 * Print how long one phase of this suite took, as one machine-readable line.
 *
 * Diagnostics, not assertions: a phase here is a boot, a teardown or a test body, and the
 * only thing this line is for is telling the phases apart when the file's wall clock is
 * read. It is deliberately a bare `console.log` — a reporter or a dependency would make
 * the measurement change the thing it measures — and it is silent unless asked for
 * (`E2E_TIMING=1`), so the default output stays Playwright's.
 *
 * @param label - the phase's name (stable, so two runs can be compared).
 * @param startedAt - `Date.now()` from before the phase.
 */
export function timing(label: string, startedAt: number): void {
  if (!timingEnabled) return
  console.log(`[e2e-timing] ${label} ${Date.now() - startedAt}`)
}

/**
 * Run one phase and print its duration whatever it did.
 *
 * @param label - the phase's name, as `timing` takes it.
 * @param work - the phase itself.
 * @returns whatever the phase returned; a throw is measured and then re-thrown.
 */
export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    return await work()
  } finally {
    timing(label, startedAt)
  }
}

/** A `dsh` invocation, split into the executable and the arguments that precede the command. */
export interface DshCommand {
  cmd: string
  prefix: string[]
  /** How this was found, for the report. */
  via: string
}

/**
 * Find the `dsh` CLI.
 *
 * Order: `DSH_BIN` (an explicit instruction always wins) → the `dsh` shim on `PATH`,
 * whose sibling `@deepseek-ai/dsh/lib/bin.js` is spawned directly with the current
 * Node (one process, so teardown is exact) → `npx --no-install @deepseek-ai/dsh`.
 * A machine with none of those is a machine this suite cannot run on: the caller
 * skips instead of failing (see `pending-keep.spec.ts`).
 */
export function resolveDsh(): DshCommand | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    if (/\.(js|mjs|cjs)$/i.test(explicit)) return { cmd: process.execPath, prefix: [explicit], via: 'DSH_BIN' }
    return { cmd: explicit, prefix: [], via: 'DSH_BIN' }
  }
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    const entry = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], via: `PATH shim in ${dir}` }
  }
  return undefined
}

/** One booted host: the child process, its base URL (with the browser token), and its log. */
export interface Host {
  proc: ChildProcess
  url: string
  port: number
  logFile: string
}

/**
 * A port nothing else is on, checked by actually binding it.
 *
 * A random number is not enough: Windows keeps whole ranges of ports reserved for
 * its own services, and a `listen` on one of those fails with `EACCES` — which is
 * what a run that happened to draw such a port reported as "dsh web exited with
 * code 1" instead of the test's own result. Binding and releasing each candidate is
 * what makes the answer a fact rather than a guess.
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000)
    if (await canBind(port)) return port
  }
  throw new Error('no bindable port found in 20000..50000 after 40 tries')
}

/** Whether this process can listen on one port right now (and can let it go again). */
async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const probe = createServer()
    probe.once('error', () => { settle(false) })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => { settle(true) })
    })
  })
}

/**
 * Start `dsh web` with a private home and wait until it prints its URL.
 * @param dsh - the resolved CLI.
 * @param home - the throwaway `DSH_HOME` (all user data lands under it).
 * @param workspace - the host's working directory (the session's workspace root).
 * @param logFile - where the child's stdout+stderr go. A FILE, not a pipe: the output
 *   is what the URL is parsed from, and it is also the post-mortem when a boot fails.
 */
export async function startHost(dsh: DshCommand, home: string, workspace: string, logFile: string): Promise<Host> {
  const port = await freePort()
  const fd = openSync(logFile, 'a')
  const proc = spawn(
    dsh.cmd,
    [...dsh.prefix, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    { cwd: workspace, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', fd, fd], windowsHide: true },
  )
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dsh web exited with code ${proc.exitCode}:\n${tail(logFile)}`)
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const match = pattern.exec(text)
    if (match !== null) return { proc, url: match[0], port, logFile }
    await sleep(400)
  }
  await stopHost(proc)
  throw new Error(`dsh web never printed a URL within 120s:\n${tail(logFile)}`)
}

/** The last few lines of a log, for an error message that says what actually happened. */
export function tail(file: string): string {
  if (!existsSync(file)) return '(no log)'
  return readFileSync(file, 'utf8').split('\n').slice(-25).join('\n')
}

/**
 * End exactly one host process — the one this file started.
 *
 * `kill()` first; if that child has not exited in a few seconds its OWN tree is
 * terminated by PID (`taskkill /T`), which is still only the process this suite
 * spawned. Never a name, never a port, never a PID from anywhere else.
 */
export async function stopHost(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>(settle => proc.once('exit', () => settle()))
  proc.kill()
  const settled = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (settled || proc.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolveKill => {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('exit', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    await Promise.race([exited, sleep(3000)])
  }
}

/** A prepared throwaway home plus the workspace the sessions live in. */
export interface Fixture {
  home: string
  workspace: string
  logFile: string
  /** Remove the whole temporary home. */
  cleanup(): void
}

/** Create the temporary home/workspace pair this suite owns. */
export function makeFixture(tag: string): Fixture {
  const home = join(tmpdir(), `dsh-diff-approval-e2e-${tag}-${randomUUID().slice(0, 8)}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // Pin the UI language, so the panel's own labels are the ones the tests click on, and
  // give the host a credential so the first-run "add an API key" modal never opens: it is
  // a modal over a mask, and a modal the browser cannot dismiss makes every later click
  // land on the mask instead of on the panel. The key is a placeholder — the seeded turn
  // is allowed to fail on authentication, the tests only need it to have started.
  writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-real-key\n')
  return {
    home,
    workspace,
    logFile: join(home, 'host.log'),
    cleanup: () => { rmSync(home, { recursive: true, force: true }) },
  }
}

/**
 * First boot on a fresh `DSH_HOME`, then make this plugin part of that profile.
 *
 * `dsh web` creates `<home>/profiles/web` on its first run with only the base
 * bundles, so the plugin is added to it exactly the way a user's profile carries it:
 * an entry in `dsh.profile.bundles` plus a `node_modules/dsh-diff-approval` link back
 * to this checkout. The workspace registry is seeded too, so the GUI has a workspace
 * to open a session in without a native directory picker (which no browser can drive).
 *
 * @returns the workspace id written into the registry.
 */
export async function bootstrapHome(dsh: DshCommand, fixture: Fixture): Promise<string> {
  const first = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
  await stopHost(first.proc)

  const profile = join(fixture.home, 'profiles', 'web')
  if (!existsSync(join(profile, 'package.json'))) {
    throw new Error(`dsh web did not create a profile at ${profile}:\n${tail(fixture.logFile)}`)
  }
  const packageFile = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  if (!manifest.dsh.profile.bundles.includes('dsh-diff-approval')) manifest.dsh.profile.bundles.push('dsh-diff-approval')
  manifest.dependencies['dsh-diff-approval'] = `file:${repoRoot}`
  writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`)

  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const link = join(profile, 'node_modules', 'dsh-diff-approval')
  if (!existsSync(link)) symlinkSync(repoRoot, link, 'junction')

  const workspaceId = randomUUID()
  const registryFile = join(fixture.home, 'storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    global: { workspaceIds: string[] }
    tables: { workspaces: Record<string, unknown> }
  }
  registry.global.workspaceIds = [workspaceId]
  registry.tables.workspaces = {
    [workspaceId]: {
      path: fixture.workspace,
      title: basename(fixture.workspace),
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  return workspaceId
}

/** Remember one session as the workspace's own (what a real open/close would have written). */
export function claimSession(fixture: Fixture, workspaceId: string, sessionId: string): void {
  const registryFile = join(fixture.home, 'storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    tables: { workspaces: Record<string, { sessionIds: string[] }> }
  }
  const workspace = registry.tables.workspaces[workspaceId]
  if (workspace === undefined) throw new Error(`workspace ${workspaceId} left the registry`)
  if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
}

/** One fixture file: the content on disk is `newText`, so the diff is real and unadopted. */
export interface SeededFile {
  name: string
  oldText: string
  newText: string
  /**
   * Owner and lineage for THIS row, when it is not the seeding session's own — a row recorded by a CHILD
   * session whose `parentSessionId` is the session the panel will show, which is what the host's merged
   * view is for. The host reads the lineage an entry RECORDED before it asks the session registry, so a
   * seeded link is enough: no live child session has to exist for its row to reach the parent's list.
   * Absent — the default — writes today's flat row, exactly as a build before the lineage field did.
   */
  owner?: {
    /** The child session the row is recorded under. */
    sessionId: string
    /** The session in that child's lineage that should see the row — the fixture's own session. */
    parentSessionId: string
    /** The header's own classification; `'subagent'` is what makes the link walkable. */
    origin?: string
    /** How deep below its root the child was delegated. */
    delegationDepth?: number
    /**
     * Further sessions to name in `sessionIds` alongside the owner — how a SHARED row is written: one the
     * listing session touched itself AND a child in its lineage touched too. The owner stays the first writer,
     * exactly as the host's own union does.
     */
    alsoSessions?: readonly string[] | undefined
  } | undefined
}

/** Write the files, the pending store and (optionally) one comment per named file. */
export function seedPending(
  fixture: Fixture,
  sessionId: string,
  files: readonly SeededFile[],
  commentOn: readonly string[],
): { entries: { id: string; path: string }[]; comments: { id: string; entryId: string }[] } {
  const entries: Record<string, unknown>[] = []
  const comments: Record<string, unknown>[] = []
  for (const file of files) {
    const path = join(fixture.workspace, file.name)
    writeFileSync(path, file.newText)
    const owner = file.owner?.sessionId ?? sessionId
    entries.push({
      id: path,
      path,
      earlierVersion: 'file',
      oldText: file.oldText,
      newText: file.newText,
      updatedAt: Date.now(),
      sessionId: owner,
      // `alsoSessions` is how a SHARED row is written: the listing session named as a co-owner, which is what
      // makes the host answer "this session touched it too" instead of "merged in".
      sessionIds: [owner, ...(file.owner?.alsoSessions ?? [])],
      // No `lineage` key at all for an ordinary row: that is what a store written before the field looks
      // like, and the loader's tolerance for it is worth keeping exercised by every other spec here.
      ...(file.owner === undefined ? {} : {
        lineage: {
          parentSessionId: file.owner.parentSessionId,
          origin: file.owner.origin ?? 'subagent',
          delegationDepth: file.owner.delegationDepth ?? 1,
        },
      }),
    })
    if (!commentOn.includes(file.name)) continue
    // The quote is the file's own last line, which is what makes the comment placeable
    // in the current content: the panel draws an unplaceable thread from its anchor instead.
    const quote = file.newText.trimEnd().split('\n').at(-1) ?? file.newText
    comments.push({
      id: `comment-${file.name}`,
      sessionId,
      entryId: path,
      path,
      anchor: { startLine: 2, endLine: 2 },
      quote,
      text: `review note for ${file.name}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  const pendingDir = join(fixture.home, 'diff-approval', 'workspaces')
  mkdirSync(pendingDir, { recursive: true })
  writeFileSync(join(pendingDir, 'pending.json'), `${JSON.stringify({ version: 3, entries }, null, 2)}\n`)
  const commentsDir = join(fixture.home, 'diff-approval', 'comments')
  mkdirSync(commentsDir, { recursive: true })
  writeFileSync(
    join(commentsDir, `${encodeURIComponent(sessionId)}.json`),
    `${JSON.stringify({ version: 1, comments }, null, 2)}\n`,
  )
  return {
    entries: entries.map(entry => ({ id: entry.id as string, path: entry.path as string })),
    comments: comments.map(comment => ({ id: comment.id as string, entryId: comment.entryId as string })),
  }
}

/**
 * Watch the session directory until a session exists there, or give up.
 *
 * This is the disk half of "which session did the GUI just create": the host writes
 * `<home>/sessions/<workspace-slug>/<sessionId>/session.v3.jsonl.zstd`, so the log
 * appearing IS the fact, independent of any response the browser happened to see. It
 * polls because the write is the host's own doing and there is no event to subscribe to
 * on this side of the process boundary.
 *
 * @param home - the throwaway `DSH_HOME` to watch.
 * @param deadline - `Date.now()` after which the wait ends.
 * @returns the session id, or undefined if nothing appeared in time.
 */
export async function waitForSessionOnDisk(home: string, deadline: number): Promise<string | undefined> {
  for (;;) {
    const id = newestSessionId(home)
    if (id !== undefined) return id
    if (Date.now() >= deadline) return undefined
    await sleep(200)
  }
}

/**
 * The most recently written session on this home, from the session directory itself.
 *
 * The fallback for a GUI whose `session/create` response the test never saw: the host
 * writes `<home>/sessions/<workspace-slug>/<sessionId>/session.v3.jsonl.zstd`, so the
 * newest log is the session the seed message just landed in.
 */
/**
 * The log file inside one session directory, by name, whatever the shell calls it this release.
 *
 * It has been `session.v3.jsonl.zstd`, and requiring exactly that name made this harness report "the
 * host never wrote a session log" for a session directory that was sitting there with a log in it —
 * 0.1.7 renamed the file. `session.` is the one part that has not changed, and the directory's own
 * shape is checked by the caller.
 *
 * @param dir - one session directory.
 * @returns the log's file name, or undefined when this directory holds no session log.
 */
function sessionLogOf(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('session.')) return name
  }
  return undefined
}

export function newestSessionId(home: string): string | undefined {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  let best: { id: string; at: number } | undefined
  for (const bucket of readdirSync(root)) {
    const bucketDir = join(root, bucket)
    for (const candidate of readdirSync(bucketDir)) {
      // The LOG is what identifies a session directory, not the shape of its name: shells have named
      // them both `session-<uuid>` and a bare `<uuid>` (0.1.7 writes the bare form, and a real home
      // carries both shapes), so requiring the prefix skipped every session on the newer shell and
      // reported "the host never wrote a session log" while the log was sitting right there.
      const dir = join(bucketDir, candidate)
      const log = sessionLogOf(dir)
      if (log === undefined) continue
      const at = statSync(join(dir, log)).mtimeMs
      if (best === undefined || at > best.at) best = { id: candidate, at }
    }
  }
  return best?.id
}

/** Everything currently under the seedable directories, for a post-mortem in a failure message. */
export function describeHome(home: string): string {
  const parts: string[] = []
  for (const dir of ['diff-approval/workspaces', 'diff-approval/comments', 'storages']) {
    const full = join(home, ...dir.split('/'))
    parts.push(`${dir}: ${existsSync(full) ? readdirSync(full).join(', ') : '(missing)'}`)
  }
  // The session tree itself, because a run that could not name a session has to say what the host did
  // write: the bucket name and the id shape are the shell's, and both have changed under this harness.
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) parts.push('sessions: (missing)')
  else {
    const listed: string[] = []
    for (const bucket of readdirSync(sessions)) {
      const ids = readdirSync(join(sessions, bucket)).slice(0, 6).map(id => {
        const log = sessionLogOf(join(sessions, bucket, id))
        return log === undefined ? `${id}(no log)` : `${id}(${log})`
      })
      listed.push(`${bucket}: ${ids.length === 0 ? '(empty)' : ids.join(', ')}`)
    }
    parts.push(`sessions: ${listed.join(' | ') || '(empty)'}`)
  }
  return parts.join('\n')
}
