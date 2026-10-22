// What a shell command changed, read against the revision it started from.
//
// The fixture is a REAL git repository, and every change is made the way a shell command makes it — a
// process writing files, then `git add` / `git commit` — because the property under test is exactly the
// one a stubbed shell cannot prove: after the commit, `git status` and `git diff HEAD` are empty while
// the change is still on disk, and it is the comparison with the pre-command revision that keeps it
// visible. A stub could only replay an invented answer to that comparison.
//
// Skipped where git is not installed: the suite has no business requiring a VCS on the machine.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitChangesSince, gitHeadRevision, gitWorktrees } from '../src/vcs.ts'
import type { ShellExecutorLike, VcsChange } from '../src/vcs.ts'

/** Whether this machine has git at all. */
const hasGit = spawnSync('git', ['--version']).status === 0

/** The command interpreter the deployment's shell executor uses, per platform: the harness runs
 * PowerShell on Windows and a POSIX shell elsewhere. */
const INTERPRETER = process.platform === 'win32'
  ? { file: 'powershell.exe', head: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
  : { file: '/bin/sh', head: ['-c'] }

/** A shell executor over the real thing, as the module uses it. */
function realShell(): ShellExecutorLike {
  return {
    resolve: (request: unknown) => request,
    run: async (spec: unknown) => {
      const { command, workdir, stdoutMaxBytes } = spec as { command: string; workdir?: string; stdoutMaxBytes?: number }
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

/** Run one command through the platform interpreter, in the fixture repository. */
function sh(root: string, command: string): void {
  execFileSync(INTERPRETER.file, [...INTERPRETER.head, command], { cwd: root, encoding: 'utf8' })
}

/** A commit one fixture repository starts from: three files, so a change, a creation and a deletion can
 *  each be told from the ones that did not move. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vcs-since-'))
  dirs.push(root)
  git(root, 'init', '-q')
  await writeFile(join(root, 'a.txt'), 'one\n')
  await writeFile(join(root, 'b.txt'), 'two\n')
  await writeFile(join(root, 'doomed.txt'), 'gone\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'baseline')
  return root
}

/** The change at one fixture path, named the way the fixture names it. */
function changeAt(changes: readonly VcsChange[], root: string, name: string): VcsChange | undefined {
  return changes.find(change => change.path === resolve(root, name))
}

/** The module's reader, over the real filesystem: unreadable as absent, exactly as the plugin wires it. */
const readText = (path: string): Promise<string | undefined> => readFile(path, 'utf8').catch(() => undefined)

describe.skipIf(!hasGit)('a change committed after the baseline is still a change', () => {
  it('reports the shell edit and the creation the command committed', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    // The command shape the capture exists for: write through the shell, then commit, in one go.
    sh(root, 'printf "ONE\\n" > a.txt && printf "new\\n" > c.txt && git add -A '
      + '&& git -c user.email=test@example.com -c user.name=Test commit -qm change')
    // The import's two sources see nothing: this is the whole reason the boundary keeps its own revision.
    expect(git(root, 'status', '--porcelain').trim()).toBe('')
    const changes = await gitChangesSince({ root, base, shell: realShell(), readText, signal: undefined })
    expect(changeAt(changes, root, 'a.txt')).toEqual({
      path: resolve(root, 'a.txt'),
      earlierVersion: 'file',
      oldText: 'one\n',
      newText: 'ONE\n',
    })
    expect(changeAt(changes, root, 'c.txt')).toEqual({
      path: resolve(root, 'c.txt'),
      earlierVersion: 'none',
      oldText: '',
      newText: 'new\n',
    })
    // Files the command did not touch are not part of its change.
    expect(changeAt(changes, root, 'b.txt')).toBeUndefined()
  })

  it('reports a rename as the old path deleting and the new path creating', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    sh(root, 'git mv a.txt renamed.txt && git -c user.email=test@example.com -c user.name=Test commit -qm rename')
    const changes = await gitChangesSince({ root, base, shell: realShell(), readText, signal: undefined })
    expect(changeAt(changes, root, 'a.txt')).toEqual({
      path: resolve(root, 'a.txt'),
      earlierVersion: 'file',
      oldText: 'one\n',
      newText: '',
    })
    expect(changeAt(changes, root, 'renamed.txt')).toEqual({
      path: resolve(root, 'renamed.txt'),
      earlierVersion: 'none',
      oldText: '',
      newText: 'one\n',
    })
  })

  it('reports a deletion with an empty new side', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    sh(root, 'rm doomed.txt && git -c user.email=test@example.com -c user.name=Test commit -qam delete')
    const changes = await gitChangesSince({ root, base, shell: realShell(), readText, signal: undefined })
    expect(changeAt(changes, root, 'doomed.txt')).toEqual({
      path: resolve(root, 'doomed.txt'),
      earlierVersion: 'file',
      oldText: 'gone\n',
      newText: '',
    })
  })

  it('includes an untracked file `git diff` cannot see', async () => {
    const root = await repo()
    const base = git(root, 'rev-parse', 'HEAD').trim()
    await writeFile(join(root, 'untracked.txt'), 'fresh\n')
    const changes = await gitChangesSince({ root, base, shell: realShell(), readText, signal: undefined })
    expect(changeAt(changes, root, 'untracked.txt')).toEqual({
      path: resolve(root, 'untracked.txt'),
      earlierVersion: 'none',
      oldText: '',
      newText: 'fresh\n',
    })
  })

  it('throws rather than answering a partial list when git does not know the baseline', async () => {
    const root = await repo()
    await expect(gitChangesSince({
      root,
      base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      shell: realShell(),
      readText,
      signal: undefined,
    })).rejects.toThrow(/could not read|command failed/)
  })
})

describe.skipIf(!hasGit)('the worktrees one checkout holds', () => {
  it('lists the checkout and a linked worktree, and answers each one its own HEAD', async () => {
    const root = await repo()
    const worktree = join(tmpdir(), `dsh-vcs-wt-${randomUUID()}`)
    dirs.push(resolve(worktree))
    git(root, 'worktree', 'add', '-q', '--detach', worktree)
    const roots = await gitWorktrees(root, realShell(), undefined)
    // git prints the working tree's REAL spelling (`/private/var/...` for a `/var` temporary root), so
    // the fixture compares the same way.
    expect(roots).toContain(realpathSync.native(root))
    expect(roots).toContain(realpathSync.native(worktree))
    const mainHead = await gitHeadRevision(root, realShell(), undefined)
    const worktreeHead = await gitHeadRevision(worktree, realShell(), undefined)
    expect(mainHead).toBe(git(root, 'rev-parse', 'HEAD').trim())
    expect(worktreeHead).toBe(mainHead)
  })

  it('answers no revision for an unborn HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vcs-unborn-'))
    dirs.push(root)
    git(root, 'init', '-q')
    expect(await gitHeadRevision(root, realShell(), undefined)).toBeUndefined()
    expect(await gitWorktrees(root, realShell(), undefined)).toEqual([realpathSync.native(root)])
  })
})
