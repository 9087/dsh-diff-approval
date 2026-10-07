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
 * - modified files, imported as `edit` (old = baseline, new = working). The GIT baseline is the
 *   last commit, not the index: this list answers "what is not committed yet", so a change the
 *   reader already `git add`ed is as much a review item as one they have not — staging is a step
 *   towards a commit, not a decision this panel records (`git diff HEAD` semantics). svn compares
 *   against BASE and p4 against `#have`, which are their "last commit" already;
 * - deleted files, imported as `edit` with an empty new side (revert restores);
 * - new/untracked files, imported as `create` ONLY when the untracked preference is on: git `??`
 *   (never added), svn unversioned, p4 not-yet-opened. For p4 that means a full workspace scan
 *   (`p4 status`, which can be slow); with the preference off only already-opened files are read.
 *   A file that is new but already under version control (git `A`, svn `added`) needs no
 *   preference: it is an uncommitted change like any other.
 * @module dsh-diff-approval/vcs
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

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
  /** Whether an earlier version of the file exists: `'file'` restores it, `'none'` deletes the file. */
  earlierVersion: 'file' | 'none'
  /** Baseline (pre-change) content; empty for a brand-new file. */
  oldText: string
  /** Working content; empty for a deleted file. */
  newText: string
}

/**
 * The subset of `ctx.shell`'s executor this module calls — for BOTH eras of that seam.
 *
 * Kept structural so the module stays dependency-light and testable with a fake, and both eras are here
 * because the seam changed under this plugin. Up to 0.1.6 the executor was `resolve(request)` +
 * `run(spec)`, and 0.1.7 replaced `run` with `execute(spec)`, which resolves to a PROCESS HANDLE whose
 * foreground projection is `result()` (measured in `@deepseek-ai/dsh-shell`: `abstract resolve`,
 * `abstract execute`, `ShellExecution.result(): Promise<ShellRunResult>`). On 0.1.7 the old shape failed
 * with `shell.run is not a function` — the whole text the import button could show — so both are
 * accepted, and an executor offering neither is reported by the methods it does have.
 */
export interface ShellExecutorLike {
  /** 0.1.7: apply the implementation's defaults and caps before execution. */
  resolve?(request: ShellExecRequestLike): unknown
  /** 0.1.7: prepare and spawn; the returned handle carries `result()`. */
  execute?(spec: unknown): Promise<ShellExecutionLike>
  /** Up to 0.1.6: resolve and run in one call. */
  run?(spec: unknown): Promise<ShellRunResultLike>
}

/** One command, as the seam's request takes it (`workdir`/`timeoutMs` are required only on the spec). */
interface ShellExecRequestLike {
  command: string
  workdir: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** Foreground stdout capture budget in bytes; absent uses the executor's cap. */
  stdoutMaxBytes?: number | undefined
}

/** 0.1.7's execution handle, reduced to the part this module reads. */
interface ShellExecutionLike {
  result?: (() => Promise<ShellRunResultLike>) | undefined
}

/** The outcome this module reads, in the shape both eras report it. */
interface ShellRunResultLike {
  exitCode: number | null
  stdout: { text: string }
  stderr: { text: string }
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
  /**
   * Restrict the scan to one absolute path (a file, or a directory's subtree).
   * Absent scans the whole workspace, which is what an import does; the review
   * panel's per-file refresh passes the file so a large tree is not rescanned.
   */
  scope?: string | undefined
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

/** Resolve one path to its real (link-followed) form. A path that is not on disk yet — a file git
 * still reports as untracked, or a scope below a directory that does not exist — has no real path
 * of its own, so the deepest ancestor that does exist is resolved and the rest re-appended:
 * `resolve()` collapses the `..`/`.` segments of that tail. When nothing on the way resolves, the
 * lexical path is what is left and the comparison falls back to the purely lexical one. */
function realpathOrSelf(absolutePath: string): string {  const path = resolve(absolutePath)
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    const resolvedParent = realpathOrSelf(parent)
    // No ancestor resolved either: climbing on would only replay the same misses.
    if (resolvedParent === parent) return path
    return resolve(resolvedParent, path.slice(parent.length + 1))
  }
}

/** What a revision has to say about one path: its content, or that the path has no version at all.
 * A FAILED read is neither: it throws (see {@link readVcsBaseline}). */
export type VcsBaseline =
  /** The baseline carries this path; `text` is its content there. */
  | { state: 'file'; text: string }
  /** The baseline has no version of this path (a creation — there is nothing to restore). */
  | { state: 'none' }

/** The `workspaceRoot`/`scope` pair with both sides resolved ONCE per scan, so the per-path side of
 * the comparison is the only `realpath` a scan pays per changed file. The roots are the same two
 * paths for every row of a scan; the changed file is not. */
interface ScanRoots {
  /** Both sides of the scope check, in real form. */
  real: { workspace: string; scope: string | undefined }
}

/** Resolve the workspace root and the scope once, for {@link inScanScope} to reuse per row. */
function realRoots(workspaceRoot: string, scope: string | undefined): ScanRoots {
  return {
    real: {
      workspace: realpathOrSelf(workspaceRoot),
      scope: scope === undefined ? undefined : realpathOrSelf(scope),
    },
  }
}

/** The prefix test itself, on two already-absolute and already-resolved paths: case-insensitive on
 * Windows, separator-aware so a sibling sharing a name prefix (`/w/repo-x` vs `/w/repo`) is not
 * read as inside. On Windows `/` and `\` name the same separator, so both are folded to `sep`. */
function isLexicallyInside(absolutePath: string, root: string): boolean {
  const fold = (value: string): string => {
    const unified = sep === '\\' ? value.replace(/\//g, sep) : value
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }
  const path = fold(absolutePath)
  const base = fold(root)
  if (path === base) return true
  return path.startsWith(base + sep)
}

/** Path-inside check on real paths, case-insensitive on Windows. Both sides are put in their real
 * (link-followed) form first: a workspace reached through a symlink, a Windows junction or a mapped
 * path is the same directory as its target, and comparing the two spellings lexically reads one
 * file as two unrelated paths — which silently drops every imported change. The lexical check is
 * still the answer when neither side resolves (nothing exists to follow). */
function isPathInside(absolutePath: string, root: string): boolean {
  const path = resolve(absolutePath)
  const base = resolve(root)
  const realPath = realpathOrSelf(path)
  const realRoot = realpathOrSelf(base)
  // Neither side had a link to follow: the lexical comparison already is the real one.
  if (realPath === path && realRoot === base) return isLexicallyInside(path, base)
  return isLexicallyInside(realPath, realRoot)
}

/**
 * Whether one changed path belongs to the scan: inside the workspace, and inside
 * the narrowed `scope` when the caller set one.
 * @param absolutePath - the changed file's absolute path.
 * @param roots - the workspace root and scope, resolved once per scan by {@link realRoots}.
 * @returns whether the change is in scope.
 */
function inScanScope(absolutePath: string, roots: ScanRoots): boolean {
  if (!isPathInside(absolutePath, roots.real.workspace)) return false
  return roots.real.scope === undefined || isPathInside(absolutePath, roots.real.scope)
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
  const request: ShellExecRequestLike = { command, workdir, timeoutMs: VCS_COMMAND_TIMEOUT_MS, signal, stdoutMaxBytes }
  const result = await runThrough(shell, request)
  if (result.exitCode !== 0) {
    const detail = (result.stderr.text || result.stdout.text).trim()
    throw new Error(`command failed (exit ${String(result.exitCode)}): ${detail || command}`)
  }
  return result.stdout.text
}

/**
 * One command, through whichever era of the shell seam is loaded.
 *
 * @param shell - the deployment's shell service.
 * @param request - the command, its workdir, deadline and capture budget.
 * @returns the run's exit code and collected streams.
 * @throws when the service offers neither entry point, naming the methods it does offer — the alternative
 *   is the message that brought this code here, `shell.run is not a function`, which says nothing about
 *   what the seam became.
 */
async function runThrough(shell: ShellExecutorLike, request: ShellExecRequestLike): Promise<ShellRunResultLike> {
  if (typeof shell.execute === 'function') {
    const spec = typeof shell.resolve === 'function' ? shell.resolve(request) : request
    const handle = await shell.execute(spec)
    // The handle IS the process; `result()` is its foreground projection. Awaiting the handle alone
    // yields the process, not its exit status (see `ShellExecution extends ShellProcess`).
    if (handle !== null && typeof handle.result === 'function') return await handle.result()
    throw new Error('the shell executor returned a handle with no result(); the seam changed again')
  }
  if (typeof shell.run === 'function') {
    // The earlier era resolved first, so it keeps doing so: `run` is documented to take a SPEC there.
    return await shell.run(typeof shell.resolve === 'function' ? shell.resolve(request) : request)
  }
  // Own properties, then the class chain — but never `Object.prototype`, whose methods are on every
  // object and would bury the two or three names that actually say what this service is.
  const names = new Set<string>()
  for (let node: object | null = shell; node !== null && node !== Object.prototype; node = Object.getPrototypeOf(node) as object | null) {
    for (const name of Object.getOwnPropertyNames(node)) names.add(name)
  }
  const offered = [...names]
    .filter(name => name !== 'constructor' && typeof (shell as unknown as Record<string, unknown>)[name] === 'function')
  throw new Error(`the shell service offers neither execute() nor run() (it has: ${offered.join(', ') || 'no methods'})`)
}

/** Parse `git status --porcelain=v1 -z` output into (XY, repo-relative path)
 * records. In `-z` a rename/copy record is `XY <to>\0<from>\0`: the record's own
 * field holds the path that exists in the worktree, and the ORIGIN follows as its
 * own NUL field, which is consumed and skipped. (`orig -> dest` is the non-`-z`
 * spelling; verified against git: `git mv a.txt b.txt` gives `R  b.txt\0a.txt\0`.)
 * The status command below turns rename detection off, so this branch is a fallback
 * for a caller that enables it. */
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

/** The status command both the import and the per-file refresh read. Rename detection is off, so
 * a rename reads as its two halves (a delete and an add) rather than a row the review cannot
 * express. */
const GIT_STATUS_COMMAND = 'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all'

/** The message a failed command carries; `runShell` puts the command's own stderr into it. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * git's wording for a path a revision does not carry, and ONLY that.
 *
 * Measured against git 2.x: `path 'x' does not exist in 'HEAD'`, and `Not a valid object name
 * HEAD:x` when HEAD is unborn (a repository with no commits yet — there every file is genuinely
 * new). A failure that is none of these — a corrupt object, a refused spawn, a timeout — is not
 * absence, and must never be read as one.
 */
const ABSENT_AT_REVISION = /does not exist in|exists on disk, but not in|not a valid object name|invalid object name|unknown revision|bad revision/i

/** What a revision has to say about one path: its content, or that it does not carry the path. */
type GitBaseline = { found: true; text: string } | { found: false }

/**
 * Read one file's content at a revision (`<rev>:<path>`), and say so when that revision has no such
 * path.
 *
 * The two answers must stay distinguishable. Absence is what makes a file a creation, and a
 * creation's revert DELETES the file — so reading a FAILED read as absence offers to delete a file
 * that is committed and fine. Only git's own words decide (see {@link ABSENT_AT_REVISION}); anything
 * else is thrown with the path named, because a reader can act on that and cannot act on a guess.
 *
 * The blob is read straight off `git show` with a per-call stdout budget raised to the blob's own
 * size the way `git cat-file -s` reports it, so the executor cannot truncate a large baseline.
 * Read-only, no temp-file write, so it works even where the sandbox denies a write to the repo
 * root.
 * @param root - the repository root (the command's working directory).
 * @param revision - the revision to read, e.g. `HEAD`.
 * @param rel - the repository-relative path.
 * @param shell - the deployment's shell executor.
 * @param signal - the caller's abort signal.
 * @returns the file's content at that revision, or `{ found: false }` when it has none.
 * @throws when the read failed for any reason other than absence.
 */
async function readGitBlob(
  root: string,
  revision: string,
  rel: string,
  shell: ShellExecutorLike,
  signal: AbortSignal | undefined,
): Promise<GitBaseline> {
  try {
    const reported = Number.parseInt((await runShell(shell, `git cat-file -s ${revision}:${shq(rel)}`, root, signal)).trim(), 10)
    const size = Number.isFinite(reported) ? reported : 0
    return { found: true, text: await runShell(shell, `git show ${revision}:${shq(rel)}`, root, signal, size + GIT_BLOB_STDOUT_SLACK) }
  } catch (error) {
    if (ABSENT_AT_REVISION.test(errorMessage(error))) return { found: false }
    throw new Error(`could not read ${rel} at ${revision}: ${errorMessage(error)}`)
  }
}

/** Enumerate the workspace's local changes in a git checkout. */
async function gitChanges(input: VcsImportInput): Promise<VcsChange[]> {
  const { root, workspaceRoot, includeUntracked, scope, shell, readText, signal } = input
  // Resolved once here, not once per row: the roots do not change while one scan runs.
  const roots = realRoots(workspaceRoot, scope)
  const stdout = await runShell(shell, GIT_STATUS_COMMAND, root, signal)
  const changes: VcsChange[] = []
  for (const { xy, rel } of parseGitPorcelainZ(stdout)) {
    const absolute = resolve(root, rel)
    if (!inScanScope(absolute, roots)) continue
    if (xy === '??') {
      if (!includeUntracked) continue
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, earlierVersion: 'none', oldText: '', newText })
      continue
    }
    // The baseline is the LAST COMMIT, not the index. Both columns of the status row are read
    // together: `M ` is a change the reader already staged and ` M` one they have not, and against
    // HEAD the two are the same kind of thing — work that is not committed yet, which is what this
    // list is for (`git diff HEAD` semantics). Reading the index instead would silently drop
    // every staged change from the review (see the module docs).
    const baseline = await readGitBlob(root, 'HEAD', rel, shell, signal)
    const worktree = xy[1] ?? ' '
    const oldText = baseline.found ? baseline.text : ''
    const newText = worktree === 'D' ? '' : (await readText(absolute) ?? '')
    if (oldText === '' && newText === '') continue
    // `earlierVersion: 'none'` means ONE thing here: the last commit carries no version of this path, so
    // there is nothing to restore and the row's action is a delete rather than a revert. It is not a
    // reader-facing label — the panel shows no 新增 tag — so it must not be decided by the status column,
    // which says how the reader filed the change, not whether an earlier version exists. A baseline that
    // could not be READ never reaches this line: it threw (see readGitBlob), because a failed read is not
    // "no earlier version", and reading it as one offers to delete a file that is committed and fine.
    changes.push({ path: absolute, earlierVersion: baseline.found ? 'file' : 'none', oldText, newText })
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
  const { root, workspaceRoot, includeUntracked, scope, shell, readText, signal } = input
  const roots = realRoots(workspaceRoot, scope)
  const stdout = await runShell(shell, 'svn status --xml', root, signal)
  const changes: VcsChange[] = []
  const entryPattern = /<entry[^>]*path="([^"]*)"[^>]*>\s*<wc-status[^>]*item="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(stdout)) !== null) {
    const rel = xmlUnescape(match[1]!)
    const item = match[2]!
    const absolute = resolve(root, rel)
    if (!inScanScope(absolute, roots)) continue
    if (item === 'modified' || item === 'deleted') {
      // BASE carries this path — it is versioned, and modified or deleted in the worktree — so a
      // failure here is a failure, not a missing baseline. Reading it as one would hand the panel an
      // empty old side, and a revert would then empty a file that is fine, or recreate a deleted one
      // as empty: the same conflation the git side refuses above.
      let oldText: string
      try {
        oldText = await runShell(shell, `svn cat -r BASE ${shq(rel)}`, root, signal)
      } catch (error) {
        throw new Error(`could not read ${rel} at BASE: ${errorMessage(error)}`)
      }
      const newText = item === 'deleted' ? '' : (await readText(absolute) ?? '')
      if (oldText === '' && newText === '') continue
      changes.push({ path: absolute, earlierVersion: 'file', oldText, newText })
    } else if (item === 'added') {
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, earlierVersion: 'none', oldText: '', newText })
    } else if (item === 'unversioned' && includeUntracked) {
      const newText = await readText(absolute) ?? ''
      changes.push({ path: absolute, earlierVersion: 'none', oldText: '', newText })
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
  const { root, workspaceRoot, includeUntracked, scope, shell, readText, signal } = input
  const command = includeUntracked ? 'p4 status' : 'p4 opened'
  const roots = realRoots(workspaceRoot, scope)
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
    if (!inScanScope(absolute, roots)) continue
    const deleted = opened.action === 'delete' || opened.action === 'move/delete'
    const created = opened.action === 'add' || opened.action === 'move/add'
    const newText = deleted ? '' : (await readText(absolute) ?? '')
    let oldText = ''
    if (!created) {
      // `#have` is the revision this workspace already carries, so a file that is open for edit (or
      // delete) has one. A failure here is therefore a failure, not a missing baseline — and reading it
      // as one would hand the panel an empty old side whose revert empties the file. Same conflation the
      // git and svn branches above refuse.
      try {
        oldText = await runShell(shell, `p4 print -q ${shq(opened.depot)}#have`, root, signal)
      } catch (error) {
        throw new Error(`could not read ${opened.depot}#have: ${errorMessage(error)}`)
      }
    }
    if (oldText === '' && newText === '') continue
    changes.push({ path: absolute, earlierVersion: created ? 'none' : 'file', oldText, newText })
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

/**
 * Read one file's BASELINE content — the version every branch above reads to build a change's
 * `oldText`: git's last commit (`HEAD`, when the scan could not see the change), svn's `BASE`, p4's
 * `#have`. The commands are the same ones those branches run, so a caller that needs one file's
 * pre-change content outside a scan (the per-file refresh's "was this committed?" check) does not
 * invent a second way to ask the same question — or a second set of failure modes to reason about.
 *
 * The two answers stay distinguishable, exactly as they do in a scan: a baseline that carries no
 * version of the path is {@link VcsBaseline} `none` (git is the only branch that can report it,
 * through {@link readGitBlob}'s own absence pattern), while a read that FAILED — a refused command,
 * a timeout, a missing client — throws, because "could not read" is not "there is nothing there".
 *
 * @param kind - the VCS to read.
 * @param root - the repository/checkout/client root, as {@link detectVcsRoot} found it.
 * @param absolutePath - the file's absolute path (inside the root's tree).
 * @param shell - the deployment's shell executor.
 * @param signal - the caller's abort signal.
 * @returns the baseline content, or `none` when the baseline has no version of the path.
 * @throws when the baseline read failed for any other reason.
 */
export async function readVcsBaseline(
  kind: VcsKind,
  root: string,
  absolutePath: string,
  shell: ShellExecutorLike,
  signal: AbortSignal | undefined,
): Promise<VcsBaseline> {
  switch (kind) {
    case 'git': {
      // The repo-relative path, spelled the way {@link gitChanges} spells it: `relative` answers
      // with the platform's separator, while git names a path with `/` — a `\` reaches it as an
      // escape character, and the baseline then reads as absent for a file that is committed.
      const rel = relative(root, resolve(absolutePath)).split(sep).join('/')
      const blob = await readGitBlob(root, 'HEAD', rel, shell, signal)
      return blob.found ? { state: 'file', text: blob.text } : { state: 'none' }
    }
    case 'svn': {
      try {
        return { state: 'file', text: await runShell(shell, `svn cat -r BASE ${shq(absolutePath)}`, root, signal) }
      } catch (error) {
        throw new Error(`could not read ${absolutePath} at BASE: ${errorMessage(error)}`)
      }
    }
    case 'p4': {
      try {
        return { state: 'file', text: await runShell(shell, `p4 print -q ${shq(absolutePath)}#have`, root, signal) }
      } catch (error) {
        throw new Error(`could not read ${absolutePath}#have: ${errorMessage(error)}`)
      }
    }
  }
}
