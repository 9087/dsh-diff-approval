// The VCS import, verified against a REAL git checkout.
//
// The stub-shell specs pin the shape of what this module does with git's answer; this one pins that
// the answer is what git actually writes, and that the baseline it is read against is the last
// commit. That is the whole point of the imported list — "what is not committed yet" — so the two
// cases that used to be invisible (a change already staged, and a file that is new but already
// added) are asserted here on real repository state, and so is the empty answer that follows a
// commit.
//
// Skipped where git is not installed: the suite has no business requiring a VCS on the machine.
//
// One case reaches the checkout through a directory link (a junction on Windows, a symlink
// elsewhere): the workspace a session declares is the link, git reports the file's path under the
// link, and the two only agree once both sides are resolved to their real path.

import { execFileSync, spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listVcsChanges } from '../src/vcs.ts'
import type { ShellExecutorLike, VcsChange } from '../src/vcs.ts'

/** Whether this machine has git at all. */
const hasGit = spawnSync('git', ['--version']).status === 0

/** The command interpreter the deployment's shell executor uses, per platform: the harness runs
 * PowerShell on Windows and a POSIX shell elsewhere, and the module's commands are quoted for
 * exactly those (single quotes are literal in both). */
const INTERPRETER = process.platform === 'win32'
  ? { file: 'powershell.exe', head: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
  : { file: '/bin/sh', head: ['-c'] }

/**
 * A shell executor over the real thing, as the module uses it: one command string plus a working
 * directory. It records what it ran, so a test can assert the read-only command set.
 * @returns the executor and its log.
 */
function realShell(): ShellExecutorLike & { commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    resolve: (request: unknown) => request,
    run: async (spec: unknown) => {
      const { command, workdir, stdoutMaxBytes } = spec as { command: string; workdir?: string; stdoutMaxBytes?: number }
      commands.push(command)
      const result = spawnSync(INTERPRETER.file, [...INTERPRETER.head, command], {
        cwd: workdir,
        encoding: 'utf8',
        maxBuffer: (stdoutMaxBytes ?? 8 * 1024 * 1024) + 1024,
      })
      return { exitCode: result.status, stdout: { text: result.stdout ?? '' }, stderr: { text: result.stderr ?? '' } }
    },
  }
}

/** Run one git command in the fixture repository (setup, not the module under test). */
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

/** What one scan of a fixture repository reports. The workspace root defaults to the repository
 * root; a link case passes the link's spelling so the two sides of the scope check disagree. */
async function scan(
  root: string,
  includeUntracked: boolean,
  workspaceRoot: string = root,
): Promise<{ changes: VcsChange[]; commands: string[] }> {
  const shell = realShell()
  const changes = await listVcsChanges({
    kind: 'git',
    root,
    workspaceRoot,
    includeUntracked,
    shell,
    readText: (path) => readFile(path, 'utf8').catch(() => undefined),
    signal: undefined,
  })
  return { changes, commands: shell.commands }
}

/** One import with the given roots, for the cases that need a `scope` or a workspace root that is
 * not the repository root. */
async function scanWith(input: {
  root: string
  workspaceRoot: string
  scope?: string
}): Promise<{ changes: VcsChange[]; commands: string[] }> {
  const shell = realShell()
  const changes = await listVcsChanges({
    kind: 'git',
    root: input.root,
    workspaceRoot: input.workspaceRoot,
    includeUntracked: false,
    scope: input.scope,
    shell,
    readText: (path) => readFile(path, 'utf8').catch(() => undefined),
    signal: undefined,
  })
  return { changes, commands: shell.commands }
}

/** The one change a scan reported for `name`, by file name. */
function changeFor(changes: readonly VcsChange[], name: string): VcsChange | undefined {
  return changes.find(change => change.path.endsWith(name))
}

describe.skipIf(!hasGit)('the git import, against a real checkout', () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  /** A repository at `base` with one committed file (`a.txt` = "base\n"). */
  async function repo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vcs-git-'))
    dirs.push(root)
    git(root, 'init', '--quiet')
    await writeFile(join(root, 'a.txt'), 'base\n')
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'base')
    return root
  }

  /**
   * A directory link at a fresh temp path pointing at `target`: a junction on Windows (no admin
   * needed), a symlink elsewhere. A platform that refuses the link is reported rather than
   * silently skipped, so a case that never ran cannot read as a case that passed.
   * @param target - the directory the link resolves to.
   * @returns the link's path, or the failure that stopped it.
   */
  function dirLink(target: string): { path: string } | { failure: string } {
    const link = join(tmpdir(), `dsh-vcs-git-link-${Math.random().toString(36).slice(2)}`)
    try {
      if (process.platform === 'win32') symlinkSync(target, link, 'junction')
      else symlinkSync(target, link, 'dir')
      dirs.push(link)
      return { path: link }
    } catch (error) {
      return { failure: `fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(link)}, '${process.platform === 'win32' ? 'junction' : 'dir'}') failed: ${String(error)}` }
    }
  }

  it('reads a change the reader already staged, against the last commit', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'staged\n')
    git(root, 'add', 'a.txt')

    const { changes } = await scan(root, false)
    const change = changeFor(changes, 'a.txt')
    // The index holds "staged" and HEAD holds "base": the review item is the difference between
    // them, which is exactly what the reader has not committed yet.
    expect(change).toMatchObject({ kind: 'edit', oldText: 'base\n', newText: 'staged\n' })
  })

  it('reads the whole uncommitted change when part of it is staged and part is not', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'staged\n')
    git(root, 'add', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'staged and more\n')

    const { changes } = await scan(root, false)
    // Not just the part after the `add`: against the last commit the two halves are one change.
    expect(changeFor(changes, 'a.txt')).toMatchObject({ oldText: 'base\n', newText: 'staged and more\n' })
  })

  it('reads a new file that is already added, with no untracked preference', async () => {
    const root = await repo()
    await writeFile(join(root, 'new.txt'), 'fresh\n')
    git(root, 'add', 'new.txt')

    const { changes } = await scan(root, false)
    // `A ` rather than `??`: the VCS knows this file, it is simply not committed yet. Its revert
    // means "remove the file", which is why it lands as a create.
    expect(changeFor(changes, 'new.txt')).toMatchObject({ kind: 'create', oldText: '', newText: 'fresh\n' })
  })

  it('reads a staged deletion as an edit whose new side is empty', async () => {
    const root = await repo()
    git(root, 'rm', '--quiet', 'a.txt')

    const { changes } = await scan(root, false)
    expect(changeFor(changes, 'a.txt')).toMatchObject({ kind: 'edit', oldText: 'base\n', newText: '' })
  })

  it('gates a file the VCS has never seen behind the untracked preference', async () => {
    const root = await repo()
    await writeFile(join(root, 'u.txt'), 'untracked\n')

    expect(changeFor((await scan(root, false)).changes, 'u.txt')).toBeUndefined()
    expect(changeFor((await scan(root, true)).changes, 'u.txt'))
      .toMatchObject({ kind: 'create', oldText: '', newText: 'untracked\n' })
  })

  it('reports nothing once the work is committed', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'committed\n')
    await writeFile(join(root, 'new.txt'), 'fresh\n')
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'work')

    // The list answers "what is not committed yet", so a clean checkout answers nothing at all —
    // this is the state the review could not previously distinguish from "no unstaged change".
    const { changes, commands } = await scan(root, true)
    expect(changes).toEqual([])
    // …read through `git status` and the baseline at HEAD, never a write of any kind.
    expect(commands.some(command => command.startsWith('git -c status.renames=false status'))).toBe(true)
    expect(commands.every(command => command.startsWith('git '))).toBe(true)
    for (const forbidden of ['add', 'commit', 'checkout', 'reset', 'stash', 'checkout-index']) {
      expect(commands.some(command => command.includes(`${forbidden} `))).toBe(false)
    }
  })

  // A session's workspace root is whatever path the session was opened on, and that path may be a
  // link to the checkout (a symlinked home on Linux/macOS, a junction on Windows, a mapped or
  // container path). The VCS then answers with the file's path spelled through the link — git for
  // Windows resolves a junction itself, git on Linux/macOS does not — and a comparison that
  // resolves both sides lexically puts the two spellings of one file in different places, so the
  // import comes back empty: no error, nothing to review.
  //
  // The timeout is raised for the two link cases only. Each one spawns git several times through
  // PowerShell, which on this machine costs 3–30 s a case — past the suite's 20 s canary — and a
  // case that loses that race reads as a failure of the code rather than of a loaded machine.
  it('imports the change when the workspace is reached through a directory link', { timeout: 120_000 }, async () => {
    const target = await repo()
    await writeFile(join(target, 'a.txt'), 'via-link\n')
    const link = dirLink(target)
    if ('failure' in link) {
      it.skip(`directory link unavailable on this platform: ${link.failure}`)
      return
    }

    // The checkout the VCS root was found in is the link's target; the workspace the session
    // declared is the link. Both spell the same file, and only resolving them makes that visible.
    const { changes } = await scan(target, false, link.path)
    expect(changeFor(changes, 'a.txt')).toMatchObject({ kind: 'edit', oldText: 'base\n', newText: 'via-link\n' })
    // Exactly one row: the link and its target are one directory tree, not two.
    expect(changes.filter(change => change.path.endsWith('a.txt')).length).toBe(1)

    // The negative half: resolving real paths must not widen the scope either. An unrelated
    // checkout reached through its own link is no more in scope than it was before — the link that
    // IS the workspace does not make its target's neighbours visible.
    const outside = await repo()
    await writeFile(join(outside, 'a.txt'), 'outside\n')
    const stranger = dirLink(outside)
    if ('failure' in stranger) {
      it.skip(`directory link unavailable on this platform: ${stranger.failure}`)
      return
    }
    const { changes: narrowed } = await scan(target, false, stranger.path)
    expect(narrowed).toEqual([])

    // A scope that does not exist under its own spelling still resolves: `link\a.txt` is not a path
    // on disk, so its real form comes from resolving the deepest existing ancestor (the link, i.e.
    // the target) and re-appending `a.txt`. The change is the row that scope names.
    const { changes: planned } = await scanWith({
      root: target,
      workspaceRoot: link.path,
      scope: join(link.path, 'a.txt'),
    })
    expect(changeFor(planned, 'a.txt')).toMatchObject({ newText: 'via-link\n' })
  })

  // The negative half of the same question: a scope cannot contain a change. A link that points at
  // a checkout OUTSIDE the workspace resolves to a real modified file, and the scan must still
  // import nothing — resolving paths may decide "inside", it may never invent membership.
  it('does not import a change whose link points outside the workspace', { timeout: 120_000 }, async () => {
    const outside = await repo()
    await writeFile(join(outside, 'a.txt'), 'outside\n')
    const link = dirLink(outside)
    if ('failure' in link) {
      it.skip(`directory link unavailable on this platform: ${link.failure}`)
      return
    }

    const workspace = await repo()
    await writeFile(join(workspace, 'a.txt'), 'ws-changed\n')

    // The scope is the link, whose real target is another checkout: the file it names is real and
    // modified, and still out of this workspace's reach.
    const shell = realShell()
    const viaLink = await listVcsChanges({
      kind: 'git',
      root: workspace,
      workspaceRoot: workspace,
      includeUntracked: false,
      scope: link.path,
      shell,
      readText: (path) => readFile(path, 'utf8').catch(() => undefined),
      signal: undefined,
    })
    expect(viaLink).toEqual([])

    // …and the target's own spelling of that same outside file is no more in scope than the link's.
    const viaTarget = await listVcsChanges({
      kind: 'git',
      root: workspace,
      workspaceRoot: workspace,
      includeUntracked: false,
      scope: outside,
      shell,
      readText: (path) => readFile(path, 'utf8').catch(() => undefined),
      signal: undefined,
    })
    expect(viaTarget).toEqual([])

    // The control: with the workspace itself in scope the change is there, so the two empties above
    // are the scope rejecting an outside path and not a scan that found nothing at all.
    const { changes } = await scan(workspace, false)
    expect(changeFor(changes, 'a.txt')).toMatchObject({ newText: 'ws-changed\n' })
  })
})
