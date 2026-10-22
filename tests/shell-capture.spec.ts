// The shell boundary's two halves, against a REAL git repository.
//
// The property is the one the rest of the plugin's capture seams cannot provide: a command that writes
// files through the shell and then commits them must still produce changes, and a change that was
// already uncommitted BEFORE the command must not be attributed to it. The second half is what keeps a
// boundary from re-listing work the reader already reviewed, so both are pinned here with the real
// filesystem timestamps the filter actually reads.
//
// Skipped where git is not installed: the suite has no business requiring a VCS on the machine.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shellBoundaryChanges, shellCaptureRoots } from '../src/shell-capture.ts'
import type { ShellExecutorLike, VcsChange } from '../src/vcs.ts'

/** Whether this machine has git at all. */
const hasGit = spawnSync('git', ['--version']).status === 0

/** The command interpreter the deployment's shell executor uses, per platform. */
const INTERPRETER = process.platform === 'win32'
  ? { file: 'powershell.exe', head: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
  : { file: '/bin/sh', head: ['-c'] }

/** A shell executor over the real thing, as the module uses it. */
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

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Run one git command in the fixture repository, with an identity, so no global config is needed. */
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

/** Run one shell command in the fixture repository, the way the model's tool would. */
function sh(root: string, command: string): void {
  execFileSync(INTERPRETER.file, [...INTERPRETER.head, command], { cwd: root, encoding: 'utf8' })
}

/** The module's reader, over the real filesystem: unreadable as absent, exactly as the plugin wires it. */
const readText = (path: string): Promise<string | undefined> => readFile(path, 'utf8').catch(() => undefined)

/** A checkout one commit deep: `kept.txt`, `other.txt`. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-shell-capture-'))
  dirs.push(root)
  git(root, 'init', '-q')
  await writeFile(join(root, 'kept.txt'), 'kept\n')
  await writeFile(join(root, 'other.txt'), 'other\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'baseline')
  return root
}

/** A linked worktree of `root`, as a session's shell would find it under a temporary directory. */
function worktreeOf(root: string): string {
  const worktree = join(tmpdir(), `dsh-shell-capture-wt-${randomUUID()}`)
  dirs.push(worktree)
  git(root, 'worktree', 'add', '-q', '--detach', worktree)
  return worktree
}

/** The change one boundary reports at one fixture path. */
function changeAt(changes: readonly VcsChange[], root: string, name: string): VcsChange | undefined {
  return changes.find(change => change.path === resolve(root, name))
}

describe.skipIf(!hasGit)('what one command is evidenced to have changed', () => {
  it('records a file the command wrote and then committed, against its pre-command revision', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    const startedAt = Date.now()
    sh(root, 'printf "KEPT\\n" > kept.txt && git add -A '
      + '&& git -c user.email=test@example.com -c user.name=Test commit -qm change')
    const changes = await shellBoundaryChanges({ root, base, startedAt, shell: realShell(), readText })
    expect(changeAt(changes, root, 'kept.txt')).toEqual({
      path: resolve(root, 'kept.txt'),
      earlierVersion: 'file',
      oldText: 'kept\n',
      newText: 'KEPT\n',
    })
    // The committed state is what `git status` reports as clean; the boundary is the only source left.
    expect(git(root, 'status', '--porcelain').trim()).toBe('')
  })

  it('leaves a change that was already uncommitted before the command alone', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    // A change the session had made earlier — not this command's to claim. Its time is put well before
    // the boundary so the test does not depend on how long the fixture took to get here.
    await writeFile(join(root, 'other.txt'), 'other, edited earlier\n')
    const earlier = new Date(Date.now() - 60_000)
    await utimes(join(root, 'other.txt'), earlier, earlier)
    const startedAt = Date.now()
    sh(root, 'printf "fresh\\n" > new.txt')
    const changes = await shellBoundaryChanges({ root, base, startedAt, shell: realShell(), readText })
    expect(changeAt(changes, root, 'new.txt')).toBeDefined()
    expect(changeAt(changes, root, 'other.txt')).toBeUndefined()
  })

  it('keeps a deletion whatever its time, because there is no file left to test', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    // A file removed well after the baseline but before the boundary: it has no working-tree timestamp,
    // and a deletion is always a change the review can act on.
    sh(root, 'rm other.txt')
    const startedAt = Date.now()
    const changes = await shellBoundaryChanges({ root, base, startedAt, shell: realShell(), readText })
    expect(changeAt(changes, root, 'other.txt')).toEqual({
      path: resolve(root, 'other.txt'),
      earlierVersion: 'file',
      oldText: 'other\n',
      newText: '',
    })
  })
})

describe.skipIf(!hasGit)('the checkouts one command can reach', () => {
  it('records the workspace checkout and the linked worktree the command names', async () => {
    const root = await repo()
    const worktree = worktreeOf(root)
    const shell = realShell()
    const roots = await shellCaptureRoots({
      workspacePath: root,
      command: `cd ${worktree} && printf 'x\\n' > kept.txt`,
      shell,
    })
    expect(roots[0]).toBe(root)
    expect(roots).toContain(realpathSync.native(worktree))
  })

  it('keeps the command from paying for worktrees it does not name', async () => {
    const root = await repo()
    worktreeOf(root)
    const roots = await shellCaptureRoots({ workspacePath: root, command: 'git status', shell: realShell() })
    expect(roots).toEqual([root])
  })

  it('includes every linked worktree when the caller cannot attribute the command', async () => {
    const root = await repo()
    const worktree = worktreeOf(root)
    const roots = await shellCaptureRoots({ workspacePath: root, command: undefined, allWorktrees: true, shell: realShell() })
    expect(roots).toContain(realpathSync.native(worktree))
  })

  it('follows the command into its own working directory', async () => {
    const root = await repo()
    const worktree = worktreeOf(root)
    const roots = await shellCaptureRoots({ workspacePath: root, workdir: worktree, shell: realShell() })
    // The workdir root is the one `detectVcsRoot` walked to from the path as given; on a macOS `/var`
    // temporary root that is the lexical spelling, not git's `/private/var` one.
    expect(roots.length).toBe(2)
  })

  it('answers nothing outside a git workspace', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-shell-capture-plain-'))
    dirs.push(plain)
    expect(await shellCaptureRoots({ workspacePath: plain, command: 'ls', shell: realShell() })).toEqual([])
  })
})
