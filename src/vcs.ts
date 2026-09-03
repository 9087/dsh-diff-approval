/**
 * Version-control integration, host half: detect which VCS (git/svn/p4)
 * encloses a workspace by walking up the directory tree, and enumerate the
 * workspace's LOCAL changes for import into the pending list. The workspace
 * is often a subdirectory of the VCS root, so the root is found by walking up
 * from the workspace path and the imported changes are filtered to files
 * inside the workspace. Commands run through the deployment's `ctx.shell`
 * executor (applying its sandbox/policy) with the VCS root as the working
 * directory.
 *
 * Scope of one import (mirrors the panel's preferences):
 * - modified files (git: working tree vs index — "仅未暂存"; svn: vs BASE;
 *   p4: opened edits), imported as `edit` (old = baseline, new = working);
 * - deleted files, imported as `edit` with an empty new side (revert restores);
 * - new/untracked files (git `??`, svn `?`, p4 not-yet-opened files), imported
 *   as `create` ONLY when the untracked preference is on. For p4 that means a
 *   full workspace scan (`p4 status`, which can be slow); with the preference
 *   off only already-opened files are read.
 * @module dsh-diff-approval/vcs
 */

import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** The version-control systems this integration knows. */
export type VcsKind = 'git' | 'svn' | 'p4'

/** A detected version-control root and its kind. */
export interface VcsRoot {
  kind: VcsKind
  /** The directory whose VCS marker was found (the repo/checkout/client root). */
  root: string
}

/** One change imported from the VCS, ready to become a pending entry. */
export interface VcsChange {
  /** Absolute path of the changed file (inside the workspace). */
  path: string
  kind: 'edit' | 'create'
  /** Baseline (pre-change) content; empty for a brand-new file. */
  oldText: string
  /** Working content; empty for a deleted file. */
  newText: string
}

/** The subset of `ctx.shell`'s executor this module calls (kept structural so
 * the module stays dependency-light and testable with a fake). */
export interface ShellExecutorLike {
  resolve(request: {
    command: string
    workdir?: string | undefined
    timeoutMs?: number | undefined
    signal?: AbortSignal | undefined
    /** Foreground stdout capture budget in bytes; absent uses the executor's cap. */
    stdoutMaxBytes?: number | undefined
  }): unknown
  run(spec: unknown): Promise<{ exitCode: number | null; stdout: { text: string }; stderr: { text: string } }>
}

/** Reads one file's working content; undefined when the file is absent. */
export type VcsFileReader = (absolutePath: string) => Promise<string | undefined>

/** Everything an import needs, in one call shape. */
export interface VcsImportInput {
  kind: VcsKind
  /** The VCS root found by {@link detectVcsRoot}. */
  root: string
  /** The session's workspace root; only changes under it are imported. */
  workspaceRoot: string
  /** Whether new/untracked files are imported (git `??`, svn `?`). */
  includeUntracked: boolean
  shell: ShellExecutorLike
  /** Reads working-file content (the host passes a node fs reader). */
  readText: VcsFileReader
  signal?: AbortSignal | undefined
}

/** Cap on one VCS command's runtime; scans (git status, svn status) can be slow
 * on large trees but must not hang the import. */
const VCS_COMMAND_TIMEOUT_MS = 60_000

/** Slack added to a blob's size when raising the per-command stdout budget
 * (`stdoutMaxBytes`), so a baseline blob is never truncated at the boundary. */
const GIT_BLOB_STDOUT_SLACK = 1024

/** Quote one argument for a POSIX-ish shell, so paths with spaces or special
 * characters survive interpolation into VCS command lines. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** POSIX path-inside check, case-insensitive on Windows. */
function isPathInside(absolutePath: string, root: string): boolean {
  const folded = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const path = folded(resolve(absolutePath))
  const base = folded(resolve(root))
  if (path === base) return true
  return path.startsWith(base + sep)
}

/** The VCS marker of one directory, or undefined when it holds none. */
function markerOf(directory: string): VcsKind | undefined {
  if (existsSync(resolve(directory, '.git'))) return 'git'
  if (existsSync(resolve(directory, '.svn'))) return 'svn'
  if (existsSync(resolve(directory, '.p4config')) || existsSync(resolve(directory, '.p4config.txt'))) return 'p4'
  return undefined
}

/**
 * Find the VCS enclosing `start` by walking up the directory tree: the first
 * directory (deepest) holding a marker wins, with git > svn > p4 when several
 * markers share one directory. Stops at the filesystem root.
 * @param start - the workspace directory to start from.
 * @returns the detected root, or undefined when no VCS marker is found.
 */
export function detectVcsRoot(start: string): VcsRoot | undefined {
  let directory = resolve(start)
  for (;;) {
    const kind = markerOf(directory)
    if (kind !== undefined) return { kind, root: directory }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Run one command through the shell executor; a non-zero exit throws. */
async function runShell(
  shell: ShellExecutorLike,
  command: string,
  workdir: string,
  signal: AbortSignal | undefined,
  stdoutMaxBytes?: number,
): Promise<string> {
  const spec = shell.resolve({ command, workdir, timeoutMs: VCS_COMMAND_TIMEOUT_MS, signal, stdoutMaxBytes })
  const result = await shell.run(spec)
  if (result.exitCode !== 0) {
    const detail = (result.stderr.text || result.stdout.text).trim()
    throw new Error(`command failed (exit ${String(result.exitCode)}): ${detail || command}`)
  }
  return result.stdout.text
}

/** Parse `git status --porcelain=v1 -z` output into (XY, repo-relative path)
 * records. Rename/copy records carry a trailing destination field, which is
 * consumed and skipped. */
function parseGitPorcelainZ(output: string): { xy: string; rel: string }[] {
  const records: { xy: string; rel: string }[] = []
  let index = 0
  while (index < output.length) {
    const end = output.indexOf('\0', index)
    if (end === -1) break
    const field = output.slice(index, end)
    index = end + 1
    if (field.length < 3) continue
    const xy = field.slice(0, 2)
    const rel = field.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') {
      // The destination follows as its own NUL field; not imported.
      const destEnd = output.indexOf('\0', index)
      if (destEnd === -1) break
      index = destEnd + 1
      continue
    }
    records.push({ xy, rel })
  }
  return records
}

/** Enumerate the workspace's local changes in a git checkout. */
async function gitChanges(input: VcsImportInput): Promise<VcsChange[]> {
  const { root, workspaceRoot, includeUntracked, shell, readText, signal } = input
  const stdout = await runShell(
    shell,
    'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all',
    root,
    signal,
  )
  const changes: VcsChange[] = []
  for (const { xy, rel } of parseGitPorcelainZ(stdout)) {
    const absolute = resolve(root, rel)
    if (!isPathInside(absolute, workspaceRoot)) continue
    if (xy === '??') {
      if (!includeUntracked) continue
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, kind: 'create', oldText: '', newText })
      continue
    }
    // The second column is the worktree status: import only unstaged changes
    // (the "仅未暂存" baseline). Staged-only rows (second column blank) are
    // left alone.
    const worktree = xy[1] ?? ' '
    if (worktree !== 'M' && worktree !== 'D') continue
    // Baseline = the index (stage 0) content, i.e. what `git diff` compares
    // against. It is read straight off `git show :0:` with a per-call stdout
    // budget (`stdoutMaxBytes`) large enough for the blob, so the executor does
    // not truncate a large blob — read-only, no temp-file write, so it works
    // even where the sandbox denies a write to the repo root.
    let oldText = ''
    try {
      let size = 0
      try {
        size = Number.parseInt((await runShell(shell, `git cat-file -s :0:${shq(rel)}`, root, signal)).trim(), 10)
      } catch {
        size = 0
      }
      if (Number.isFinite(size) && size > 0) {
        oldText = await runShell(shell, `git show :0:${shq(rel)}`, root, signal, size + GIT_BLOB_STDOUT_SLACK)
      }
    } catch {
      oldText = ''
    }
    const newText = worktree === 'D' ? '' : (await readText(absolute) ?? '')
    if (oldText === '' && newText === '') continue
    changes.push({ path: absolute, kind: 'edit', oldText, newText })
  }
  return changes
}

/** Unescape the XML entities `svn status --xml` writes into paths. */
function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Enumerate the workspace's local changes in an svn working copy. */
async function svnChanges(input: VcsImportInput): Promise<VcsChange[]> {
  const { root, workspaceRoot, includeUntracked, shell, readText, signal } = input
  const stdout = await runShell(shell, 'svn status --xml', root, signal)
  const changes: VcsChange[] = []
  const entryPattern = /<entry[^>]*path="([^"]*)"[^>]*>\s*<wc-status[^>]*item="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(stdout)) !== null) {
    const rel = xmlUnescape(match[1]!)
    const item = match[2]!
    const absolute = resolve(root, rel)
    if (!isPathInside(absolute, workspaceRoot)) continue
    if (item === 'modified' || item === 'deleted') {
      let oldText = ''
      try {
        oldText = await runShell(shell, `svn cat -r BASE ${shq(rel)}`, root, signal)
      } catch {
        oldText = ''
      }
      const newText = item === 'deleted' ? '' : (await readText(absolute) ?? '')
      if (oldText === '' && newText === '') continue
      changes.push({ path: absolute, kind: 'edit', oldText, newText })
    } else if (item === 'added') {
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, kind: 'create', oldText: '', newText })
    } else if (item === 'unversioned' && includeUntracked) {
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, kind: 'create', oldText: '', newText })
    }
  }
  return changes
}

/** One changed-file line from `p4 opened`/`p4 status`: the depot path and the
 * action. The action keyword is found anywhere on the line, so both the
 * `- edit`/`- add` and the `opened for edit`/`opened for add` wordings parse. */
function p4ChangeOf(line: string): { depot: string; action: string } | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const depot = trimmed.split(/\s+/, 1)[0]
  if (depot === undefined || !depot.startsWith('//')) return undefined
  const action = /(move\/delete|move\/add|delete|integrate|branch|add|edit)/.exec(trimmed)?.[1] ?? 'edit'
  return { depot: depot.replace(/#.*$/, ''), action }
}

/** Enumerate the workspace's locally changed files in a p4 client. With the
 * untracked preference on a full workspace scan (`p4 status`) catches files
 * not yet opened for add; off keeps to already-opened files (`p4 opened`) so
 * the scan — which can be slow — is skipped. */
async function p4Changes(input: VcsImportInput): Promise<VcsChange[]> {
  const { root, workspaceRoot, includeUntracked, shell, readText, signal } = input
  const command = includeUntracked ? 'p4 status' : 'p4 opened'
  const stdout = await runShell(shell, command, root, signal)
  const changes: VcsChange[] = []
  for (const line of stdout.split('\n')) {
    const opened = p4ChangeOf(line)
    if (opened === undefined) continue
    // Map the depot path to its absolute local path (third `p4 where` column).
    const where = await runShell(shell, `p4 where ${shq(opened.depot)}`, root, signal)
    const local = where.trim().split(/\s+/).pop()
    if (local === undefined || local.length === 0) continue
    const absolute = resolve(local)
    if (!isPathInside(absolute, workspaceRoot)) continue
    const deleted = opened.action === 'delete' || opened.action === 'move/delete'
    const created = opened.action === 'add' || opened.action === 'move/add'
    const newText = deleted ? '' : (await readText(absolute) ?? '')
    let oldText = ''
    if (!created) {
      try {
        oldText = await runShell(shell, `p4 print -q ${shq(opened.depot)}#have`, root, signal)
      } catch {
        oldText = ''
      }
    }
    if (oldText === '' && newText === '') continue
    changes.push({ path: absolute, kind: created ? 'create' : 'edit', oldText, newText })
  }
  return changes
}

/**
 * Enumerate the workspace's local changes for one VCS. Runs the VCS read-only
 * commands and returns one {@link VcsChange} per changed file inside the
 * workspace.
 * @param input - the VCS, its root, the workspace root, and the reading tools.
 * @returns the changes; an absent/unusable VCS surfaces as a thrown error.
 */
export async function listVcsChanges(input: VcsImportInput): Promise<VcsChange[]> {
  switch (input.kind) {
    case 'git': return gitChanges(input)
    case 'svn': return svnChanges(input)
    case 'p4': return p4Changes(input)
  }
}
