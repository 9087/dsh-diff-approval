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

import { execFileSync, spawnSync } from 'node:child_process'
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

/** What one scan of a fixture repository reports. */
async function scan(
  root: string,
  includeUntracked: boolean,
): Promise<{ changes: VcsChange[]; commands: string[] }> {
  const shell = realShell()
  const changes = await listVcsChanges({
    kind: 'git',
    root,
    workspaceRoot: root,
    includeUntracked,
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
})
