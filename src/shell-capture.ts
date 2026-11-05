/**
 * The shell boundary, host half: what one shell command changed in the repository, read against the
 * revision that command started from.
 *
 * A shell command is invisible to the capture seams the rest of this plugin uses. `tools/result` for
 * `bash` carries no file mutation — the command wrote what it wrote — and the VCS import answers "what
 * is not committed yet", which a `git commit` inside the same command empties. So a session that edits
 * with `sed -i`, a `python3 - <<'EOF'` block or `cat > f <<'EOF'`, then commits, leaves the review list
 * with nothing to show, and the commit itself is the last place the change exists.
 *
 * Recording the revision a command STARTED from, before it runs, is what makes the change recoverable
 * after the commit: the working tree is compared with a revision the command has already left behind,
 * so a commit moves `HEAD` but not the baseline. This module owns the two halves of that boundary —
 * which repositories a command can reach ({@link shellCaptureRoots}) and what changed in one of them
 * ({@link shellBoundaryChanges}) — and no plugin state. `index.ts` records the revision at
 * `tools/pre-execute`, keeps it beside the execution, and folds the answer at the settle.
 *
 * Only git is covered. svn and p4 have no cheap "diff against an arbitrary earlier revision" read in
 * this module's vocabulary, and the import keeps serving them with its last-commit semantics.
 *
 * @module dsh-diff-approval/shell-capture
 */

import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { detectVcsRoot, gitChangesSince, gitWorktrees } from './vcs.ts'
import type { ShellExecutorLike, VcsChange, VcsFileReader } from './vcs.ts'

/**
 * The tools whose arguments carry a command line that can mutate a working tree.
 *
 * Named, not discovered: a tool registry has no "this runs a shell" capability this plugin could ask
 * for, and the shipped shells are a closed, small set (`bash` and `pwsh` from the base tool bundles,
 * `terminal_send` from the terminal bundle). A deployment that adds a shell under another name keeps
 * the capture it had; the constant is the one place to add it.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'pwsh', 'terminal_send'])

/**
 * The tools whose settlement means an earlier background shell may have finished.
 *
 * A background `bash` result arrives when the job STARTS, so its boundary cannot be settled then; the
 * job tools are the points where the caller learns it is done (and the turn's own end is the last
 * resort, see `index.ts`).
 */
export const JOB_TOOL_NAMES: ReadonlySet<string> = new Set(['job_output', 'job_kill'])

/**
 * How far before the recorded start a file's modification time may sit and still count as written by
 * the command.
 *
 * The comparison is filesystem evidence, not a proof: a command is the process that writes the files,
 * and its writes carry a time at or after the pre-execute read. A small negative slack absorbs a coarse
 * filesystem clock or a host whose `Date.now()` and filesystem agree only to the second, without
 * letting an edit made well before the command in through.
 */
const CAPTURE_MTIME_SLACK_MS = 1_000

/**
 * The most files one boundary will record.
 *
 * A command can legitimately change a whole tree — a branch switch, a formatter over the repository —
 * and a review list of thousands of rows is not a review list the panel can open. The cap is a bound on
 * that flood; the log says it was reached, so a truncated boundary is a fact rather than a silent
 * shorter list.
 */
const MAX_BOUNDARY_PATHS = 500

/** What one command can reach, for the boundary that is about to be recorded. */
export interface ShellCaptureRootRequest {
  /** The session's workspace root: its repository is the primary checkout. */
  workspacePath: string
  /** The command line the tool was given, when its arguments carry one. */
  command?: string | undefined
  /**
   * The tool's own working directory, when it accepts one (`bash`'s `workdir`): a command can run
   * inside a linked worktree without ever naming it, so the directory is a root in its own right.
   */
  workdir?: string | undefined
  /**
   * Include every linked worktree, mentioned or not.
   *
   * A persistent terminal's current directory is not part of the arguments of a later `terminal_send`,
   * so its command cannot be attributed to a worktree by name; the caller includes them all rather than
   * guess.
   */
  allWorktrees?: boolean | undefined
  shell: ShellExecutorLike
  signal?: AbortSignal | undefined
}

/**
 * The git checkouts one shell command can reach.
 *
 * The session's workspace usually IS the checkout, but this plugin already lists edits made outside it
 * (a tool's display path is not fenced), and the working style this capture exists for runs commands in
 * a `git worktree` beside the repository. The repository names its own worktrees, so the list is read
 * from git rather than guessed from the command text; the text then decides which of them are worth a
 * revision read, keeping the per-command cost to the roots the command could plausibly touch.
 *
 * @param input - the workspace, the command and its working directory, and the shell executor.
 * @returns the checkouts to record, the workspace's own first.
 * @throws when the workspace's repository cannot be detected or a worktree listing fails; callers that
 *   can proceed with less catch and keep the plain workspace root.
 */
export async function shellCaptureRoots(input: ShellCaptureRootRequest): Promise<string[]> {
  const detected = detectVcsRoot(input.workspacePath)
  if (detected === undefined || detected.kind !== 'git') return []
  const roots = [detected.root]
  // Deduplicated by REAL path: git prints a resolved spelling (`/private/tmp/...` for a `/tmp` link)
  // while the session's own workspace path need not be resolved, and one checkout recorded twice would
  // pay two revision reads and settle the same command twice.
  const seen = new Set([realPathOf(detected.root)])
  for (const worktree of await gitWorktrees(detected.root, input.shell, input.signal)) {
    const key = realPathOf(worktree)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(worktree)
  }
  // A `workdir` names a checkout the command runs inside, whether or not the command text does.
  let workdirRoot: string | undefined
  if (input.workdir !== undefined && input.workdir.length > 0) {
    const target = /^([A-Za-z]:[\\/]|[\\/])/.test(input.workdir)
      ? input.workdir
      : `${input.workspacePath}/${input.workdir}`
    const detectedWorkdir = detectVcsRoot(target)
    if (detectedWorkdir !== undefined && detectedWorkdir.kind === 'git') {
      workdirRoot = detectedWorkdir.root
      const key = realPathOf(workdirRoot)
      if (!seen.has(key)) {
        seen.add(key)
        roots.push(workdirRoot)
      }
    }
  }
  if (input.allWorktrees === true || roots.length === 1) return roots
  const mentioned = `${input.command ?? ''}\n${input.workdir ?? ''}`
  return roots.filter(root => root === detected.root || root === workdirRoot || mentions(root, mentioned))
}

/**
 * One directory's real spelling, for identity: the filesystem's answer when it has one (the same
 * directory reached through a link is the same checkout), and the lexical path when the filesystem
 * cannot say — a directory that does not exist yet is still compared by the spelling it was given.
 * @param directory - the absolute directory path.
 * @returns the path's real form, or its resolved spelling when no real form is available.
 */
function realPathOf(directory: string): string {
  try {
    return realpathSync.native(directory)
  } catch {
    return resolve(directory)
  }
}

/**
 * Whether one path's directory name appears in the text a caller passed.
 *
 * Deliberately loose — a command that names `/tmp/export` names its directory — and deliberately one
 * directional: a false positive costs one revision read, a false negative costs the capture of that
 * worktree, and the cheap mistake is the one to keep.
 * @param root - the checkout's absolute path.
 * @param text - the command line (and working directory) the tool was given.
 * @returns whether the checkout may be the one the command means.
 */
function mentions(root: string, text: string): boolean {
  const name = basename(root)
  if (name.length === 0) return false
  return process.platform === 'win32'
    ? text.toLowerCase().includes(name.toLowerCase())
    : text.includes(name)
}

/** One checkout's changes for the boundary being settled. */
export interface ShellBoundaryChangesRequest {
  /** The checkout the command ran against. */
  root: string
  /** The revision the command started from, recorded before it ran. */
  base: string
  /** `Date.now()` at which the revision was recorded: the cut-off for "did this command write it?". */
  startedAt: number
  shell: ShellExecutorLike
  readText: VcsFileReader
  signal?: AbortSignal | undefined
  /** Where a truncation or a skipped change may be reported, when the caller has somewhere to put it. */
  log?: ((message: string) => void) | undefined
}

/**
 * What one command changed in one checkout, as pending-list changes.
 *
 * The revision comparison ({@link gitChangesSince}) says which paths differ from where the command
 * started; the modification time says which of those the COMMAND wrote, as opposed to a change the
 * session had already left uncommitted before it. That second half is what keeps a boundary from
 * re-listing work the reader already reviewed: a commit command writes no file, so everything it
 * merely commits keeps an older time and stays out.
 *
 * Deletions are kept whatever their time: a deleted path has no file left to test, and a deletion is
 * always a change of content the review can act on.
 *
 * @param input - the checkout, its pre-command revision, and the deployment's shell executor.
 * @returns the changes the command is evidenced to have made, bounded by {@link MAX_BOUNDARY_PATHS}.
 * @throws when the revision comparison fails; the caller logs the failure and captures nothing.
 */
export async function shellBoundaryChanges(input: ShellBoundaryChangesRequest): Promise<VcsChange[]> {
  const changes = await gitChangesSince({
    root: input.root,
    base: input.base,
    shell: input.shell,
    readText: input.readText,
    signal: input.signal,
  })
  const touched: VcsChange[] = []
  for (const change of changes) {
    // A deletion leaves nothing to stat; it is evidence of the command by itself.
    if (change.earlierVersion === 'file' && change.newText === '') {
      touched.push(change)
      continue
    }
    if (await writtenSince(change.path, input.startedAt - CAPTURE_MTIME_SLACK_MS)) touched.push(change)
  }
  if (touched.length > MAX_BOUNDARY_PATHS) {
    input.log?.(`shell boundary in ${input.root}: ${touched.length} changed files, recording the first ${MAX_BOUNDARY_PATHS}`)
    touched.length = MAX_BOUNDARY_PATHS
  }
  return touched
}

/**
 * Whether one file was written at or after a moment.
 *
 * A missing or unreadable time is answered `false`: the path is then either gone — which a deletion
 * record already covers — or unreadable, and a review row about a file the plugin cannot see is not one
 * the boundary should invent.
 * @param absolutePath - the path to stat.
 * @param since - the earliest modification time that counts, in epoch milliseconds.
 * @returns whether the file carries a modification time at or after `since`.
 */
async function writtenSince(absolutePath: string, since: number): Promise<boolean> {
  try {
    return (await stat(absolutePath)).mtimeMs >= since
  } catch {
    return false
  }
}
