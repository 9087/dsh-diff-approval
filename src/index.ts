/**
 * Pending-edit review, host half. Captures every successful `edit` and `write`
 * tool result (an unscoped `tools/result` listener receives per-session tool
 * executions because scoped emissions route through the shared root hook
 * table) and every `str_replace_editor` mutation (whose result carries only a
 * success message, so its pre-write basis is snapshotted at the
 * `fs/edit-intent` / `fs/write-intent` seams and paired with the settle),
 * folds each operation into its file's entry in the
 * {@link PendingDiffStore} (one entry per path), serves the `/diff-approval`
 * connection RPC channel (list/keep/revert/open), and applies a revert by
 * writing the entry's `oldText` back through `ctx.fs` (a created file's
 * revert removes it, and a tracked file that has since disappeared is
 * restored by its revert). `open` launches the file with its default
 * application or reveals it in the file manager.
 *
 * Mount this row in any profile's `cordis.patch.yml`:
 *
 * ```yaml
 * - insert:
 *     - id: diff-approval
 *       name: 'dsh-diff-approval'
 *       # Optional: relocate durable pending state (defaults to
 *       # <dshHome>/diff-approval/workspaces).
 *       # config:
 *       #   storageDir: ~/.dsh/diff-approval/workspaces
 * ```
 *
 * Pending entries persist per (workspace, session) so an unhandled operation
 * survives a harness restart; the list endpoint hydrates the whole workspace
 * and merges every registered session's entries, so a fresh session after a
 * restart still reports the earlier sessions' pending changes, live-verified
 * exactly as it is mid-session.
 *
 * @module dsh-diff-approval
 */

import { readFile, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
// Type-only: brings the `ctx.fs` Context merge into this program.
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: brings the `ctx.workspaceRegistry` Context merge into this program.
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { PendingDiffStore } from './pending.ts'
import { PendingPersistence, defaultStorageDir } from './persist.ts'
import { defaultOpenPath } from './open.ts'
import type { OpenAction } from './open.ts'
import { detectVcsRoot, listVcsChanges } from './vcs.ts'
import type { VcsChange, VcsImportInput, ShellExecutorLike } from './vcs.ts'
import type {
  DiffApprovalActionValue, DiffApprovalAddOutcome, DiffApprovalAddValue, DiffApprovalBlockTarget, DiffApprovalBrowseEntry, DiffApprovalBrowseValue,
  DiffApprovalBulkValue, DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, DiffApprovalPreviewImageValue, DiffApprovalRefreshValue,
  PendingEntry, PendingEntryKind, PendingFileDiff, VcsImportValue,
} from './types.ts'

export type {
  DiffApprovalActionOutcome, DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalBlockTarget,
  DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, DiffApprovalRefreshOutcome, DiffApprovalRefreshValue,
  PendingEntry, PendingEntryKind, PendingFileDiff,
} from './types.ts'
export { PendingDiffStore } from './pending.ts'
export { PendingPersistence, defaultStorageDir } from './persist.ts'
export { defaultOpenPath } from './open.ts'

/** Stable Cordis plugin name. */
export const name = 'diff-approval'

/**
 * Services required before the review surface activates. `webServer` rides with
 * `connection` (both come from the web bundle), and is named explicitly because
 * the channel's owner context must be able to resolve it — see
 * `ConnectionServiceSurface`.
 */
export const inject = ['fs', 'connection', 'webServer', 'workspaceRegistry', 'sessions']

/** The connection RPC channel this plugin serves. */
export const DIFF_APPROVAL_CHANNEL = '/diff-approval'

/**
 * Plugin configuration overridable from the profile's `cordis.patch.yml`.
 */
export interface DiffApprovalConfig {
  /**
   * Root directory for durable pending state, defaulting to
   * `<dshHome>/diff-approval/workspaces`. Must be a non-empty string when set;
   * `~` prefixes expand to the OS home.
   */
  storageDir?: string
  /**
   * Launcher for the `open` endpoint, defaulting to the platform commands.
   * Injectable for tests; receives the backend execution-world path.
   */
  openPath?: (path: string, action: DiffApprovalOpenAction) => Promise<void>
}

/** One tool result's fields this plugin consumes, narrowed from the tool's JSON value. */
interface OperationOutcome {
  path: string
  kind: PendingEntryKind
  oldText: string
  newText: string
}

/**
 * Structural stand-in for the harness's `SandboxExecutionPolicy` (type-only;
 * avoids a hard dependency on `@deepseek-ai/dsh-sandbox`). `sessionId` is
 * intentionally omitted: the plugin's published `dsh-session` and the
 * harness's local one are distinct branded types, and the containment fence
 * only needs `mode` + `workspaceRoot`. A Revert write must carry the session's
 * workspace root, or the sandbox fences it against `process.cwd()` and denies
 * it.
 */
interface SandboxExecutionPolicyLike {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

/** One restorable snapshot of an entry plus its file, for undo/redo. */
interface DiffApprovalUndoState {
  /** Entry id (survives even when the entry is absent, so redo can remove it). */
  id: string
  /** The entry's path (for file writes even when the entry is absent). */
  path: string
  /** The store entry to restore (undefined = the entry is absent). */
  entry: PendingEntry | undefined
  /** The file content to write on restore (undefined = leave the file untouched).
   * This is the exact bytes the action wrote (already line-ending adjusted), so
   * restore writes it verbatim and reproduces the action independent of the
   * current line-ending-sensitivity setting. */
  fileText: string | undefined
  /** A batch of entries restored/removed together (one VCS import). Each item's
   * `entry` decides restore vs remove; present only on the import's pair. */
  batch?: readonly DiffApprovalUndoState[] | undefined
}

/** Before/after pair pushed on each undoable keep/revert action. */
interface DiffApprovalUndoPair {
  sessionId: SessionId
  before: DiffApprovalUndoState
  after: DiffApprovalUndoState
}

/** The dominant line ending of `text`: CRLF when `\r\n` meets or beats lone
 * `\n`, else LF; a text with no line breaks falls back to LF.
 * @param text - the content to inspect.
 * @returns the dominant line-ending sequence.
 */
function detectEol(text: string): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) { crlf++; i++ }
    } else if (c === 10) {
      lf++
    }
  }
  if (crlf === 0 && lf === 0) return '\n'
  return crlf >= lf ? '\r\n' : '\n'
}

/** Normalize any line ending (`\r\n`, `\r`) to `\n`. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Whether two contents are equal ignoring line endings and a trailing-newline
 *  difference — the same tolerance the whole-file diff uses, so a file that the
 *  diff view shows as "no pending diff" is treated as fully resolved here too. */
function contentEqual(a: string, b: string): boolean {
  return contentLinesOf(normalizeEol(a)).join('\n') === contentLinesOf(normalizeEol(b)).join('\n')
}

/** Re-encode `text`'s line endings to `eol` (its content is unchanged). */
function reencodeEol(text: string, eol: '\r\n' | '\n'): string {
  const normalized = normalizeEol(text)
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

/**
 * Narrow a successful `edit` result value to an operation outcome. The edit
 * tool's output schema declares exactly `{ path, before, after }`; anything
 * else is another tool's value or malformed data, which this recorder skips.
 * @param value - the successful result's JSON value.
 * @returns the outcome, or `undefined` when the value is not an edit outcome.
 */
function editOutcomeOf(value: unknown): OperationOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { path, before, after } = value as Record<string, unknown>
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof before !== 'string' || typeof after !== 'string') return undefined
  return { path, kind: 'edit', oldText: before, newText: after }
}

/**
 * Narrow a successful `write` result value to an operation outcome. The write
 * tool's output schema declares `{ path, operation, before, after }`;
 * `operation: 'create'` becomes a `create` entry (revert removes the file),
 * `operation: 'update'` becomes an `edit` entry. An update whose `before` is
 * null carried no contextual basis, so it is skipped rather than tracked as
 * an un-revertable overwrite.
 * @param value - the successful result's JSON value.
 * @returns the outcome, or `undefined` when the value is not a trackable write.
 */
function writeOutcomeOf(value: unknown): OperationOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { path, operation, before, after } = value as Record<string, unknown>
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (operation !== 'create' && operation !== 'update') return undefined
  if (typeof after !== 'string') return undefined
  if (operation === 'create') return { path, kind: 'create', oldText: '', newText: after }
  if (typeof before !== 'string') return undefined
  return { path, kind: 'edit', oldText: before, newText: after }
}

/** Human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Directories one browse level hides: VCS/build noise a review list never wants.
 *  The path box can still reach them by typing the path outright. */
const BROWSE_HIDDEN_NAMES = new Set(['.git', 'node_modules'])

/** Cap on one browse level's children: the panel renders a list, not a dump of a
 *  huge directory, and it reports `truncated` rather than silently cutting. */
const BROWSE_ENTRY_CAP = 500

/** Cap on the files one no-change walk reads: ticking the box on a directory
 *  asks for "everything under here", which must not mean reading a whole tree
 *  (every file's text) inside one call. */
const ADD_UNCHANGED_CAP = 300

/**
 * One absolute path as a workspace-relative path with `/` separators, or
 * `undefined` when it lies outside the root. `''` is the root itself.
 * @param root - the workspace root.
 * @param absolute - the path to express relative to it.
 * @returns the relative path, or undefined when outside.
 */
function workspaceRelativeOf(root: string, absolute: string): string | undefined {
  const rel = relative(resolve(root), resolve(absolute))
  if (rel === '') return ''
  // A different Windows drive comes back absolute; a sibling comes back as `..`.
  if (isAbsolute(rel)) return undefined
  const parts = rel.split(/[\\/]/)
  if (parts[0] === '..') return undefined
  return parts.join('/')
}

/**
 * Resolve one caller-supplied path against the workspace root. A relative path
 * is taken as workspace-relative; an absolute one must still land inside.
 * @param root - the workspace root.
 * @param input - the caller's path (absolute or workspace-relative).
 * @returns the absolute path, or undefined when it escapes the workspace.
 */
function resolveInsideWorkspace(root: string, input: string): string | undefined {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input)
  return workspaceRelativeOf(root, absolute) === undefined ? undefined : absolute
}

/** The workspace-relative parent of a relative directory path (`''` at the root). */

/** Fold one path for comparison: absolute, `/`-separated, case-folded on Windows.
 *  Entries are keyed by the path spelling their capture carried (a tool's display
 *  path or a scan's absolute one), so an equality test has to normalize first. */
function pathIdentity(absolute: string): string {
  const unified = resolve(absolute).split(/[\\/]/).join('/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** Narrow a tool-execution-shaped value to its name, call id, and agent. */
function actorOf(value: unknown): { name: unknown; callId: unknown; agent: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { name, callId, agent } = value as Record<string, unknown>
  return { name, callId, agent }
}

/** Narrow an agent-shaped value to its session id. */
function sessionOfAgent(agent: unknown): SessionId | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? SessionId(id) : undefined
}

/**
 * The MIME type for an image path by its lowercased extension. An unknown or
 * non-image extension falls back to the generic binary type, which browsers
 * still render when the bytes decode; the common Markdown image formats are
 * covered so a preview inlines as the right content type.
 * @param path - the image's OS path.
 * @returns the MIME type.
 */
function imageMimeOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

/**
 * Build one channel error in the closed RPC error vocabulary. `internal` is
 * the catch-all: business misses ride the success branch as `outcome: 'missing'`.
 * @param message - the handler-side description.
 * @returns the error branch.
 */
function rpcError(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * The slice of the Host connection service this plugin mounts its channel with.
 *
 * `rpc.handle` is the published surface, but it hardcodes the *service's* own
 * context as the registration owner, and the method it delegates to reads
 * `owner.webServer` from that context. dsh-client-connection moved `webServer`
 * out of that plugin's `inject` into a nested scope, so `handle` throws
 * `cannot get property "webServer" without inject` there and takes the whole
 * plugin tree down at boot. Declaring `webServer` on the *caller* does not help:
 * the owner is the provider's context, so `handle` fails no matter what this
 * plugin injects. `register` takes the owner as a parameter, so naming our own
 * `webServer`-injecting context restores the documented intent — "channel
 * registrations belong to the caller fiber" — and mounts regardless. Upstream
 * report: https://github.com/deepseek-ai/deepseek-harness/discussions/5926 ;
 * drop this once `connection`'s own inject lists `webServer` again. The
 * published types mark `register` private, hence this local declaration.
 */
interface ConnectionServiceSurface {
  /** Published channel registry, kept as the fallback path. */
  readonly rpc: {
    handle: (
      channel: string,
      handler: ConnectionRpcHandler,
      options?: { readonly authority: 'trusted-host' | 'loopback' },
    ) => () => Promise<void>
  }
  /**
   * Mount one channel for an explicit owner; absent on some builds. The trailing
   * options carry the channel's trust policy: releases in the 0.1.0 line read
   * `options.authority` unconditionally, so it must be passed.
   */
  register?: (
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options?: { readonly authority: 'trusted-host' | 'loopback' },
  ) => () => Promise<void>
}

/**
 * Mount the pending-edit review surface.
 * @param ctx - Cordis context carrying the filesystem, connection, and workspace registry services.
 * @param config - optional plugin configuration (`storageDir` relocates durable state).
 */
export function apply(ctx: Context, config?: DiffApprovalConfig): void {
  const storageDir = config?.storageDir
  if (storageDir !== undefined && (typeof storageDir !== 'string' || storageDir.trim().length === 0)) {
    throw new Error('diff-approval: storageDir must be a non-empty string')
  }
  const store = new PendingDiffStore()
  const persistence = new PendingPersistence(resolve(expandHomePath(storageDir ?? defaultStorageDir())))
  const launchPath = config?.openPath ?? defaultOpenPath
  /** Hydrate the globally-unique store once from the single persistence file. */
  let loadPromise: Promise<void> | undefined
  const ensureLoaded = (): Promise<void> => {
    loadPromise ??= (async () => {
      try {
        const { entries, migratedLegacy } = await persistence.loadAll()
        if (entries.length > 0) store.hydrate(entries)
        // A legacy per-workspace layout: fold once, then drop the old files.
        if (migratedLegacy) await persistence.save(store.all())
      } catch (error: unknown) {
        ctx.logger.warn(`diff-approval: loading persisted state failed: ${errorMessage(error)}`)
      }
    })()
    return loadPromise
  }

  /** Pre-write bases captured at the intent seams, keyed by the tool call id. */
  const editorIntents = new Map<string, IntentBasis>()

  /**
   * Snapshot one str_replace_editor mutation's basis at its intent seam. A
   * `create` has an empty basis; an edit reads the pre-write content. Any
   * failure tracks nothing — the settle-side pairing then sees no basis.
   * @param target - the resolved target about to be written.
   * @param actor - the tool execution running the mutation.
   * @param kind - whether the mutation creates or edits the file.
   */
  async function stashEditorIntent(target: FsTarget, actor: object | undefined, kind: PendingEntryKind): Promise<void> {
    const shaped = actorOf(actor)
    if (shaped === undefined || shaped.name !== 'str_replace_editor') return
    if (typeof shaped.callId !== 'string') return
    const sessionId = sessionOfAgent(shaped.agent)
    if (sessionId === undefined) return
    if (kind === 'create') {
      editorIntents.set(shaped.callId, { target, kind, before: '', sessionId })
      return
    }
    try {
      const before = await ctx.fs.readText(target, undefined) ?? ''
      editorIntents.set(shaped.callId, { target, kind, before, sessionId })
    } catch {
      // Unreadable at intent time: no trustworthy basis to revert to.
    }
  }

  /**
   * Fold one str_replace_editor mutation into its file's entry. The tool's
   * result carries only a success message, so the settle reads the post-write
   * content and pairs it with the basis snapshotted at the intent seam.
   * @param exec - the settled str_replace_editor execution.
   * @param result - its outcome.
   */
  async function captureEditorMutation(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    const basis = editorIntents.get(exec.callId)
    editorIntents.delete(exec.callId)
    if (basis === undefined || basis.sessionId === undefined || result.isError) return
    const argumentsValue = exec.arguments
    const command = typeof argumentsValue === 'object' && argumentsValue !== null
      ? (argumentsValue as Record<string, unknown>).command : undefined
    const mutates = basis.kind === 'create'
      ? command === 'create'
      : command === 'str_replace' || command === 'insert'
    if (!mutates) return
    let after: string
    try {
      after = await ctx.fs.readText(basis.target, undefined) ?? ''
    } catch {
      return
    }
    if (basis.kind === 'edit' && after === basis.before) return
    const sessionId = basis.sessionId
    const path = basis.target.displayPath
    const entry: PendingEntry = {
      id: path,
      sessionId,
      path,
      kind: basis.kind,
      oldText: basis.before,
      newText: after,
      updatedAt: Date.now(),
      sessionIds: [sessionId],
    }
    await ensureLoaded()
    if (store.fold(entry)) persistSession()
  }

  /** One observation of a tracked path's live file. Existence is decided solely
   * by `stat` (`undefined` means the target is absent); a present-but-unreadable
   * file is `unavailable` so the panel can disable its operations. */
  type LiveFileState =
    | { kind: 'present'; content: string }
    | { kind: 'deleted' }
    | { kind: 'unavailable' }

  /** The stable `FsError.code`, when the thrown value carries one. */
  function fsErrorCodeOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }

  /**
   * Read one path's live state. The only existence test is `stat`: it returns
   * `undefined` for an absent target (gone), so a deleted file never falls into
   * the unreadable bucket. A file that exists but cannot be read is `unavailable`.
   * @param path - backend display path to probe through `ctx.fs`.
   * @returns the live state.
   */
  async function liveStateOf(path: string): Promise<LiveFileState> {
    let target
    try {
      target = await ctx.fs.resolve(path, {})
    } catch (error) {
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
    let info
    try {
      info = await ctx.fs.stat(target, undefined)
    } catch (error) {
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
    if (info === undefined) return { kind: 'deleted' }
    try {
      return { kind: 'present', content: await ctx.fs.readText(target, undefined) }
    } catch (error) {
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
  }

  /**
   * Attach the live file state to each listed entry. Reading runs once per
   * path (the panel polls once a second and the review set stays small).
   * @param entries - the store's entries for one session.
   * @returns entries with `missing` and `diverged` set from the live file.
   */
  /** Drop every undo/redo pair that belongs to a removed file, so the LIFO
   * queue stays traversable without ever trying to restore an unreadable file. */
  function purgeForEntry(path: string): void {
    const clean = (stack: DiffApprovalUndoPair[]): void => {
      const kept = stack.filter(pair => {
        const batch = pair.before.batch ?? pair.after.batch
        if (batch !== undefined) return !batch.some(item => item.path === path)
        return pair.before.path !== path && pair.after.path !== path
      })
      stack.length = 0
      stack.push(...kept)
    }
    clean(undoStack)
    clean(redoStack)
  }

  /**
   * Settle each listed entry against its live file. Existence is decided by the
   * live state alone: a deleted file leaves the list as an undoable checkpoint
   * (Ctrl+Z recreates it and restores the entry), an unavailable one leaves the
   * list and has its undo/redo records dropped, and externally changed content
   * is adopted as the new baseline with its own checkpoint.
   * @param sessionId - the session being listed (its session-scoped view).
   * @returns the listed entries plus whether an external change cleared redo.
   */
  async function listWithState(
    sessionId: SessionId,
  ): Promise<{ files: PendingFileDiff[]; redoCleared: boolean }> {
    const listed: PendingFileDiff[] = []
    let redoCleared = false
    for (const entry of store.list(sessionId)) {
      const live = await liveStateOf(entry.path)
      if (live.kind === 'deleted') {
        // The file is gone: remove it from the list, keeping an undoable
        // checkpoint that recreates the file (its tracked content) and restores
        // the entry to the list.
        store.remove(entry.path)
        pushUndo(sessionId,
          { id: entry.path, path: entry.path, entry, fileText: entry.newText },
          { id: entry.path, path: entry.path, entry: undefined, fileText: undefined })
        persistSession()
        continue
      }
      if (live.kind === 'unavailable') {
        // Present but unreadable: no operation is safe, so drop the entry and
        // purge its undo/redo records so the LIFO queue stays traversable.
        store.remove(entry.path)
        purgeForEntry(entry.path)
        persistSession()
        continue
      }
      // Present. A file changed outside the tracked operations (another tool,
      // an editor, a second process) is adopted as the new baseline so the
      // panel tracks the file as it is now; the entry keeps its pre-change
      // `oldText`, and the adoption itself is a fresh undo checkpoint.
      const content = live.content as string | undefined
      let adopted = entry.newText
      const hasContent = typeof content === 'string'
      if (hasContent && content !== entry.newText) {
        adopted = content
        const beforeText = entry.newText
        const redoWasPresent = redoStack.length > 0
        store.update(entry.path, { newText: content })
        pushUndo(sessionId,
          { id: entry.path, path: entry.path, entry, fileText: beforeText },
          { id: entry.path, path: entry.path, entry: { ...entry, newText: content, updatedAt: Date.now() }, fileText: content })
        persistSession()
        if (redoWasPresent) redoCleared = true
      }
      const state = { missing: false, diverged: hasContent ? content !== adopted : true }
      listed.push({ ...entry, newText: adopted, ...state })
    }
    return { files: listed, redoCleared }
  }

  /**
   * Fold a batch of entries into one session's list as a single undoable action.
   * Nothing touches the files, so the batch is undone by restoring each affected
   * path's pre-fold entry (or removing it when the path was not listed), which is
   * what the import and the hand-add path both want.
   * @param sessionId - the session whose list gains the entries.
   * @param entries - the entries to fold, in capture order.
   * @param admitNoDiff - also admit entries that carry no diff at all (the
   *        guard-free insert), which is how a hand-added clean path is listed.
   * @returns how many entries landed; 0 leaves the store, persistence, and the
   *          undo queue untouched.
   */
  async function foldBatch(sessionId: SessionId, entries: readonly PendingEntry[], admitNoDiff = false): Promise<number> {
    await ensureLoaded()
    const before = new Map(store.list(sessionId).map(entry => [entry.path, entry]))
    let folded = 0
    const changedPaths: string[] = []
    for (const entry of entries) {
      const applied = entry.oldText === entry.newText
        ? admitNoDiff && store.insert(entry)
        : store.fold(entry)
      if (applied) {
        folded += 1
        changedPaths.push(entry.path)
      }
    }
    if (folded === 0) return 0
    persistSession(true)
    const after = new Map(store.list(sessionId).map(entry => [entry.path, entry]))
    const batchBefore: DiffApprovalUndoState[] = []
    const batchAfter: DiffApprovalUndoState[] = []
    for (const path of changedPaths) {
      const final = after.get(path)
      if (final === undefined) continue
      const pre = before.get(path)
      batchAfter.push({ id: final.id, path, entry: final, fileText: undefined })
      batchBefore.push({ id: final.id, path, entry: pre, fileText: undefined })
    }
    if (batchBefore.length > 0) {
      pushUndo(sessionId,
        { id: batchBefore[0]!.id, path: batchBefore[0]!.path, entry: undefined, fileText: undefined, batch: batchBefore },
        { id: batchAfter[0]!.id, path: batchAfter[0]!.path, entry: undefined, fileText: undefined, batch: batchAfter },
      )
    }
    return folded
  }

  /**
   * One path's text, or `undefined` when it is absent or not readable as text
   * (a binary, an unreadable permission). An empty file reads as `''`, which is
   * a value: a listed entry may carry no content at all.
   * @param absolute - the path to read.
   * @param signal - caller lifetime.
   * @returns the text, or undefined.
   */
  async function readTextOrNone(absolute: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await ctx.fs.readText(await ctx.fs.resolve(absolute, { signal }), signal)
    } catch {
      return undefined
    }
  }

  /**
   * Every regular file under one directory, with its text. Breadth-first in the
   * backend's name order, hiding the browse's noise names, skipping whatever is
   * not readable as text, and stopping at {@link ADD_UNCHANGED_CAP} files so
   * "include paths with no change" cannot read an unbounded tree in one call.
   * Symlinked directories are followed once, so a cycle ends rather than loops.
   * @param root - the resolved directory target to walk.
   * @param rootAbsolute - that directory's absolute path.
   * @param signal - caller lifetime.
   * @returns the files found and whether the cap cut the walk short.
   */
  async function collectFilesUnder(
    root: FsTarget,
    rootAbsolute: string,
    signal: AbortSignal,
  ): Promise<{ files: { path: string; content: string | undefined }[]; truncated: boolean }> {
    const files: { path: string; content: string | undefined }[] = []
    const visited = new Set<string>()
    // A backend always names its targets, but the guard must not treat two
    // unnamed ones as the same directory.
    if (typeof root.targetKey === 'string' && root.targetKey !== '') visited.add(root.targetKey)
    const queue: { absolute: string; target: FsTarget }[] = [{ absolute: rootAbsolute, target: root }]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      let children
      try {
        children = await ctx.fs.listDir(current.target, signal)
      } catch {
        // An unreadable subdirectory is skipped, not fatal to the whole add.
        continue
      }
      for (const child of children) {
        if (BROWSE_HIDDEN_NAMES.has(child.name)) continue
        const absolute = resolve(current.absolute, child.name)
        if (child.type === 'directory') {
          const key = child.target.targetKey
          if (typeof key === 'string' && key !== '') {
            if (visited.has(key)) continue
            visited.add(key)
          }
          queue.push({ absolute, target: child.target })
          continue
        }
        if (child.type !== 'file') continue
        if (files.length >= ADD_UNCHANGED_CAP) return { files, truncated: true }
        files.push({ path: absolute, content: await readTextOrNone(absolute, signal) })
      }
    }
    return { files, truncated: false }
  }

  /**
   * The workspace whose session account holds `sessionId`. Web sessions are
   * attached to a workspace at creation, so an unowned session is the
   * memory-only edge (its entries never persist).
   * @param sessionId - the session to locate.
   * @returns the owning workspace, or `undefined` when none accounts it.
   */
  function workspaceOf(sessionId: SessionId): Workspace | undefined {
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (workspace.sessionIds.includes(sessionId)) return workspace
    }
    return undefined
  }

  /**
   * Resolve the file-sandbox policy for one session's Revert write, or
   * undefined when no confining backend is mounted. A live session carries
   * its workspace root through `ctx.sessions`; a persisted entry from a
   * session not live in this process falls back to the session's workspace
   * path (else the deployment default). Without this the sandbox fences the
   * write against the process cwd and denies it with "file access denied
   * under workspace-write mode".
   */
  function sandboxPolicyOf(sessionId: SessionId): SandboxExecutionPolicyLike | undefined {
    const policy = ctx.get('sandboxPolicy') as
      | { resolve(request?: { session?: Session }): SandboxExecutionPolicyLike; defaultMode: SandboxExecutionPolicyLike['mode'] }
      | undefined
    if (policy === undefined) return undefined
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) return policy.resolve({ session })
    const workspace = workspaceOf(sessionId)
    return workspace === undefined
      ? policy.resolve({})
      : { mode: policy.defaultMode, workspaceRoot: workspace.path }
  }

  /**
   * Write a Revert through `ctx.fs`, carrying the session's sandbox policy
   * only when a confining backend is mounted (so the plain 4-arg call shape is
   * preserved for the unsandboxed composition).
   * @param target - the resolved target to write.
   * @param content - the restored file content.
   * @param sessionId - the entry's session, for the per-session policy.
   * @param signal - aborts before atomic publication takes effect.
   * @returns the write outcome.
   */
  async function writeRevert(target: FsTarget, content: string, sessionId: SessionId, signal: AbortSignal): Promise<unknown> {
    const policy = sandboxPolicyOf(sessionId)
    return policy === undefined
      ? ctx.fs.writeText(target, content, undefined, signal)
      : ctx.fs.writeText(target, content, undefined, signal, policy)
  }

  /**
   * Revert one entry's file back to its baseline (the shared per-entry logic
   * behind both the single `revert` endpoint and the bulk `revert-all`). A
   * created file's revert deletes it (not undoable: the file is gone), an edit
   * writes the baseline back and yields the before/after undo snapshot.
   * @param entry - the entry to revert.
   * @param sessionId - the entry's session (for the per-session write policy).
   * @param signal - aborts before atomic publication takes effect.
   * @returns the undo snapshot, or `undefined` when the revert is not undoable.
   */
  async function revertEntryContent(entry: PendingEntry, sessionId: SessionId, signal: AbortSignal): Promise<{ before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined> {
    const resolved = await ctx.fs.resolve(entry.path, { signal })
    if (entry.kind === 'create') {
      await rm(ctx.fs.processPath(resolved), { force: true })
      return undefined
    }
    const preWrite = await ctx.fs.readText(resolved, undefined) ?? entry.newText
    const content = reencodeEol(entry.oldText, detectEol(entry.newText))
    await writeRevert(resolved, content, sessionId, signal)
    return {
      before: { id: entry.id, path: entry.path, entry, fileText: preWrite },
      after: { id: entry.id, path: entry.path, entry: undefined, fileText: content },
    }
  }

  // Per-session undo/redo stacks, in memory only (lost on restart). Every
  // undoable keep/revert/block action pushes its before/after pair; undo
  // restores `before`, redo re-applies `after`. Actions that delete a file
  // (revert of a created file, block-revert to empty) are not pushed.
  // Global undo/redo: a single LIFO stack across every file, because entries are
  // globally unique per path. A fresh action invalidates the whole redo history.
  const undoStack: DiffApprovalUndoPair[] = []
  const redoStack: DiffApprovalUndoPair[] = []

  function pushUndo(sessionId: SessionId, before: DiffApprovalUndoState, after: DiffApprovalUndoState): void {
    undoStack.push({ sessionId, before, after })
    redoStack.length = 0
  }

  /**
   * Restore one snapshot (the before/after side of an undo pair). File writes
   * carry the session sandbox policy; a divergence guard refuses to overwrite
   * a file an outside writer has since changed. The store change is applied
   * only after the write succeeds, keeping the restore all-or-nothing.
   * @param sessionId - the owning session.
   * @param state - the snapshot to restore.
   * @param expectedFile - the other side's file content, checked before a write.
   * @param signal - aborts before atomic publication takes effect.
   */
  async function restoreState(
    sessionId: SessionId,
    state: DiffApprovalUndoState,
    expectedFile: DiffApprovalUndoState | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.fileText !== undefined) {
      const resolved = await ctx.fs.resolve(state.path, { signal })
      if (expectedFile?.fileText !== undefined) {
        const current = await ctx.fs.readText(resolved, undefined)
        if (current !== expectedFile.fileText) {
          throw new Error('the file changed outside the review after the action; undo is unavailable')
        }
      }
      // The snapshot is the exact bytes the action wrote (line-endings already
      // adjusted), so restore writes it verbatim — reproducing the action
      // regardless of the current line-ending-sensitivity setting.
      await writeRevert(resolved, state.fileText, sessionId, signal)
    }
    if (state.batch !== undefined) {
      // A batch (one VCS import) touches no files: each item restores its entry
      // or removes it by path, exactly reversing the import.
      for (const item of state.batch) {
        if (item.entry !== undefined) store.restore(item.entry)
        else store.remove(item.path)
      }
      return
    }
    if (state.entry !== undefined) store.restore(state.entry)
    else store.remove(state.path)
  }

  /**
   * Mirror the whole (globally-unique) entry set to disk. A write fault logs a
   * warning and leaves the in-memory view intact: the review flow must not
   * break on a storage fault, and the next successful mutation rewrites the
   * file.
   * @returns resolution after the write settles (successful or logged).
   */
  // Persistence writes are throttled: coalesce to at most one durable write per
  // PERSIST_THROTTLE_MS. A write runs immediately when the store has been idle
  // longer than the window (write-through for a single change), so a lone
  // capture persists without delay; a burst of agent captures coalesces to one
  // write per window instead of one per event — the fix for the I/O/CPU storm.
  // User actions (keep/revert/undo/redo) pass `force` so their outcome is
  // durable immediately, not left in a throttled window.
  const PERSIST_THROTTLE_MS = 1000
  let persistDirty = false
  let persistScheduled = false
  let lastPersistAt = 0
  let persistTimer: ReturnType<typeof setTimeout> | undefined

  /** Actually write the (dirty) store to disk; one coalesced write. */
  async function flushPersist(): Promise<void> {
    if (!persistDirty) return
    persistDirty = false
    lastPersistAt = Date.now()
    try {
      await ensureLoaded()
      await persistence.save(store.all())
    } catch (error: unknown) {
      ctx.logger.warn(`diff-approval: persisting pending changes failed: ${errorMessage(error)}`)
    }
  }

  /** Mark the store dirty and schedule one throttled, coalesced write. Pass
   * `force` to write immediately (user actions need durable, immediate results). */
  function persistSession(force = false): void {
    persistDirty = true
    if (force) {
      if (persistScheduled) { clearTimeout(persistTimer); persistScheduled = false }
      void flushPersist()
      return
    }
    if (persistScheduled) return
    const delay = PERSIST_THROTTLE_MS - (Date.now() - lastPersistAt)
    if (delay <= 0) {
      void flushPersist()
    } else {
      persistScheduled = true
      persistTimer = setTimeout(() => {
        persistScheduled = false
        void flushPersist()
      }, delay)
      // Do not hold the process open just for this timer.
      persistTimer.unref?.()
    }
  }

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (exec.name === 'str_replace_editor') {
      void captureEditorMutation(exec, result)
      return
    }
    if (result.isError || exec.agent === undefined) return
    const outcome = exec.name === 'edit' ? editOutcomeOf(result.value) : exec.name === 'write' ? writeOutcomeOf(result.value) : undefined
    if (outcome === undefined || outcome.oldText === outcome.newText) return
    const sessionId = exec.agent.id
    const entry: PendingEntry = { id: outcome.path, sessionId, ...outcome, updatedAt: Date.now(), sessionIds: [sessionId] }
    // Fold synchronously so the very next list sees the capture; persistence
    // (hydration + save) rides the same turn asynchronously.
    if (store.fold(entry)) persistSession()
  })

  const handle: ConnectionRpcHandler = async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    switch (endpoint) {
      case 'list': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        const { files, redoCleared } = await listWithState(sessionId)
        const value: DiffApprovalListValue = { files, workspacePath: workspaceOf(sessionId)?.path, redoCleared: redoCleared || undefined }
        return { ok: true, value }
      }
      case 'keep': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        // Remove synchronously: once the user acts, the entry must be gone for
        // any concurrent list. (The store is hydrated by the time an action
        // runs, since the panel lists first.)
        let entry = store.get(target.id)
        if (entry === undefined) {
          await ensureLoaded()
          entry = store.get(target.id)
          if (entry === undefined) {
            const value: DiffApprovalActionValue = { outcome: 'missing' }
            return { ok: true, value }
          }
        }
        // The file already holds the accepted content, so nothing is written:
        // folding `newText` into the baseline clears the diff. The panel asks
        // whether to also drop the resolved entry, and rides the answer here.
        if ((payload as Record<string, unknown>).keepListed === true) {
          store.update(target.id, { oldText: entry.newText })
          const afterEntry: PendingEntry = { ...entry, oldText: entry.newText, updatedAt: Date.now() }
          pushUndo(target.sessionId,
            { id: entry.path, path: entry.path, entry, fileText: undefined },
            { id: entry.path, path: entry.path, entry: afterEntry, fileText: undefined })
          persistSession(true)
          const value: DiffApprovalActionValue = { outcome: 'kept', resolved: true }
          return { ok: true, value }
        }
        store.remove(target.id)
        pushUndo(target.sessionId,
          { id: entry.path, path: entry.path, entry, fileText: undefined },
          { id: entry.path, path: entry.path, entry: undefined, fileText: undefined })
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'kept' }
        return { ok: true, value }
      }
      case 'revert': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        let entry = store.get(target.id)
        if (entry === undefined) {
          await ensureLoaded()
          entry = store.get(target.id)
          if (entry === undefined) {
            const value: DiffApprovalActionValue = { outcome: 'missing' }
            return { ok: true, value }
          }
        }
        // A revert that deletes a created file is not undoable (the file is
        // gone); a revert that writes keeps a snapshot for Ctrl+Z.
        let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
        try {
          undo = await revertEntryContent(entry, target.sessionId, signal)
        } catch (error: unknown) {
          return rpcError(`revert failed: ${errorMessage(error)}`)
        }
        // The file now holds its old content; folding that into `newText` clears
        // the diff while the entry stays listed (the panel asked to keep it).
        // A deleted created file folds to empty, exactly as a block revert that
        // empties one does.
        if ((payload as Record<string, unknown>).keepListed === true) {
          const content = undo?.after.fileText ?? ''
          store.update(target.id, { newText: content })
          const afterEntry: PendingEntry = { ...entry, newText: content, updatedAt: Date.now() }
          if (undo !== undefined) {
            pushUndo(target.sessionId,
              { id: entry.path, path: entry.path, entry, fileText: undo.before.fileText },
              { id: entry.path, path: entry.path, entry: afterEntry, fileText: content })
          }
          persistSession(true)
          const value: DiffApprovalActionValue = { outcome: 'reverted', resolved: true }
          return { ok: true, value }
        }
        store.remove(target.id)
        if (undo !== undefined) pushUndo(target.sessionId, undo.before, undo.after)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'reverted' }
        return { ok: true, value }
      }
      case 'keep-all': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        const entries = store.list(sessionId)
        const before: DiffApprovalUndoState[] = []
        const after: DiffApprovalUndoState[] = []
        for (const entry of entries) {
          before.push({ id: entry.id, path: entry.path, entry, fileText: undefined })
          after.push({ id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          store.remove(entry.id)
        }
        if (before.length > 0) {
          pushUndo(sessionId,
            { id: before[0]!.id, path: before[0]!.path, entry: undefined, fileText: undefined, batch: before },
            { id: after[0]!.id, path: after[0]!.path, entry: undefined, fileText: undefined, batch: after })
        }
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected: before.length }
        return { ok: true, value }
      }
      case 'revert-all': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        const entries = store.list(sessionId)
        const batchBefore: DiffApprovalUndoState[] = []
        const batchAfter: DiffApprovalUndoState[] = []
        for (const entry of entries) {
          let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
          try {
            undo = await revertEntryContent(entry, sessionId, signal)
          } catch {
            // An unreadable file is left listed (the caller sees it as a failed
            // entry) rather than silently dropped; stop the bulk here.
            return rpcError(`revert-all failed for ${entry.path}`)
          }
          if (undo !== undefined) { batchBefore.push(undo.before); batchAfter.push(undo.after) }
          store.remove(entry.id)
        }
        if (batchBefore.length > 0) {
          pushUndo(sessionId,
            { id: batchBefore[0]!.id, path: batchBefore[0]!.path, entry: undefined, fileText: undefined, batch: batchBefore },
            { id: batchAfter[0]!.id, path: batchAfter[0]!.path, entry: undefined, fileText: undefined, batch: batchAfter })
        }
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected: entries.length }
        return { ok: true, value }
      }
      case 'block-keep': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded()
        const entry = store.get(blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Accept this block: fold its new side into the tracked baseline so
        // the entry's diff no longer shows it. The file already holds the
        // accepted content, so nothing is written. When this clears the file's
        // last change and the caller asked to remove it, the entry leaves the
        // list now (the panel's prompt rides this same request); otherwise it
        // stays listed with no pending diff, removed by a later keep/revert.
        const accepted = contentRangeOf(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd)
        const updatedOld = replaceContentLines(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd, accepted)
        store.update(blockTarget.id, { oldText: updatedOld })
        const afterEntry: PendingEntry = { ...entry, oldText: updatedOld, updatedAt: Date.now() }
        pushUndo(blockTarget.sessionId,
          { id: entry.id, path: entry.path, entry, fileText: undefined },
          { id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined })
        persistSession()
        const fullyResolved = contentEqual(updatedOld, entry.newText)
        if (fullyResolved && blockTarget.removeWhenResolved === true) {
          store.remove(blockTarget.id)
          pushUndo(blockTarget.sessionId,
            { id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined },
            { id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          persistSession(true)
        }
        const kept: DiffApprovalActionValue = fullyResolved ? { outcome: 'kept', resolved: true } : { outcome: 'kept' }
        return { ok: true, value: kept }
      }
      case 'block-revert': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded()
        const entry = store.get(blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Undo this block: restore its old side into the new text and write
        // the file back. The entry stays even when now fully reverted
        // (newText === oldText): the file stays listed with no pending diff.
        const restored = contentRangeOf(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd)
        const updatedNew = replaceContentLines(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd, restored)
        // Write the file in the entry's current EOL (uniform), and keep the
        // store's newText in step with the bytes actually written, so a later
        // read never sees a line-ending-only drift.
        const content = reencodeEol(updatedNew, detectEol(entry.newText))
        store.update(blockTarget.id, { newText: content })
        const afterEntry: PendingEntry = { ...entry, newText: content, updatedAt: Date.now() }
        // A block-revert that empties a created file deletes it and is not
        // undoable; one that writes keeps a snapshot for Ctrl+Z.
        let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
        try {
          const target = await ctx.fs.resolve(entry.path, { signal })
          if (entry.kind === 'create' && content === '') {
            await rm(ctx.fs.processPath(target), { force: true })
          } else {
            const preWrite = await ctx.fs.readText(target, undefined) ?? entry.newText
            await writeRevert(target, content, blockTarget.sessionId, signal)
            undo = {
              before: { id: entry.id, path: entry.path, entry, fileText: preWrite },
              after: { id: entry.id, path: entry.path, entry: afterEntry, fileText: content },
            }
          }
        } catch (error: unknown) {
          return rpcError(`block revert failed: ${errorMessage(error)}`)
        }
        if (undo !== undefined) pushUndo(blockTarget.sessionId, undo.before, undo.after)
        persistSession()
        const fullyResolved = contentEqual(updatedNew, entry.oldText)
        if (fullyResolved && blockTarget.removeWhenResolved === true) {
          store.remove(blockTarget.id)
          pushUndo(blockTarget.sessionId,
            { id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined },
            { id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          persistSession(true)
        }
        const reverted: DiffApprovalActionValue = fullyResolved ? { outcome: 'reverted', resolved: true } : { outcome: 'reverted' }
        return { ok: true, value: reverted }
      }
      case 'undo': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const pair = undoStack.pop()
        if (pair === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'nothing' }
          return { ok: true, value }
        }
        try {
          await restoreState(sessionId, pair.before, pair.after, signal)
        } catch (error: unknown) {
          // Keep the pair on the stack so a later, still-valid undo works.
          undoStack.push(pair)
          return rpcError(`undo failed: ${errorMessage(error)}`)
        }
        redoStack.push(pair)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'undone', id: pair.after.id }
        return { ok: true, value }
      }
      case 'redo': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const pair = redoStack.pop()
        if (pair === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'nothing' }
          return { ok: true, value }
        }
        try {
          await restoreState(sessionId, pair.after, pair.before, signal)
        } catch (error: unknown) {
          redoStack.push(pair)
          return rpcError(`redo failed: ${errorMessage(error)}`)
        }
        undoStack.push(pair)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'redone', id: pair.after.id }
        return { ok: true, value }
      }
      case 'vcs-import': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const workspace = workspaceOf(sessionId)
        if (workspace === undefined) return rpcError('import unavailable: the session has no workspace')
        // Detection lives inside the import: the button is the only trigger, so
        // a workspace outside any git/svn/p4 checkout answers with no VCS found
        // rather than needing a separate probe.
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) return { ok: true, value: { imported: 0, detected: false } }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('import unavailable: the deployment has no shell executor')
        const includeUntracked = (payload as Record<string, unknown>).includeUntracked === true
        const input: VcsImportInput = {
          kind: root.kind,
          root: root.root,
          workspaceRoot: workspace.path,
          includeUntracked,
          shell,
          readText: (path) => readFile(path, 'utf8').catch(() => undefined),
          signal,
        }
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges(input)
        } catch (error: unknown) {
          return rpcError(`import failed: ${errorMessage(error)}`)
        }
        const imported = await foldBatch(sessionId, changes.map(change => ({
          id: change.path,
          sessionId,
          path: change.path,
          kind: change.kind,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: Date.now(),
          sessionIds: [sessionId],
        })))
        const value: VcsImportValue = { imported, detected: true }
        return { ok: true, value }
      }
      case 'vcs-refresh': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded()
        const entry = store.get(target.id)
        if (entry === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        const workspace = workspaceOf(target.sessionId)
        if (workspace === undefined) return rpcError('refresh unavailable: the session has no workspace')
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'no-vcs' }
          return { ok: true, value }
        }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('refresh unavailable: the deployment has no shell executor')
        // Scope the scan to this one file: a full workspace sweep would make a
        // per-file refresh as slow as an import on a large tree.
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges({
            kind: root.kind,
            root: root.root,
            workspaceRoot: workspace.path,
            includeUntracked: (payload as Record<string, unknown>).includeUntracked === true,
            scope: entry.path,
            shell,
            readText: (path) => readFile(path, 'utf8').catch(() => undefined),
            signal,
          })
        } catch (error: unknown) {
          return rpcError(`refresh failed: ${errorMessage(error)}`)
        }
        const change = changes.find(candidate => pathIdentity(candidate.path) === pathIdentity(entry.path))
        // Nothing to replace it with: leave the entry exactly as the review found
        // it and let the panel say so. Silently blanking the diff here would
        // discard a review in progress over a scan that simply saw no change
        // (an untracked new file, for instance, when untracked imports are off).
        if (change === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'no-change' }
          return { ok: true, value }
        }
        if (change.kind === entry.kind && change.oldText === entry.oldText && change.newText === entry.newText) {
          const value: DiffApprovalRefreshValue = { outcome: 'unchanged' }
          return { ok: true, value }
        }
        const refreshed: PendingEntry = {
          ...entry,
          kind: change.kind,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: Date.now(),
        }
        store.restore(refreshed)
        // The refresh is undoable as one action: the entry's tracked diff moves
        // from what the review captured to what the VCS reports now.
        pushUndo(target.sessionId,
          { id: entry.path, path: entry.path, entry, fileText: undefined },
          { id: entry.path, path: entry.path, entry: refreshed, fileText: undefined })
        persistSession(true)
        const value: DiffApprovalRefreshValue = { outcome: 'refreshed' }
        return { ok: true, value }
      }
      case 'list-path': {
        // One directory level for the panel's add-path browser. The level is
        // addressed the way `add-path` is (workspace-relative, `''` for the
        // root) so the browser and the add agree on what a row means.
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const workspace = workspaceOf(sessionId)
        if (workspace === undefined) return rpcError('browse unavailable: the session has no workspace')
        const requested = pathFieldOf(payload) ?? ''
        const absolute = resolveInsideWorkspace(workspace.path, requested)
        if (absolute === undefined) return rpcError('browse failed: the path is outside the workspace')
        let children
        try {
          const target = await ctx.fs.resolve(absolute, { signal })
          const info = await ctx.fs.stat(target, signal)
          if (info === undefined || info.type !== 'directory') return rpcError('browse failed: not a directory')
          children = await ctx.fs.listDir(target, signal)
        } catch (error: unknown) {
          return rpcError(`browse failed: ${errorMessage(error)}`)
        }
        const entries: DiffApprovalBrowseEntry[] = []
        for (const child of children) {
          if (BROWSE_HIDDEN_NAMES.has(child.name)) continue
          const childAbsolute = resolve(absolute, child.name)
          // Confine the level to the workspace: a symlink pointing out of it must
          // not become a row the caller can add.
          if (workspaceRelativeOf(workspace.path, childAbsolute) === undefined) continue
          entries.push({
            name: child.name,
            type: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
            path: childAbsolute,
            size: child.type === 'file' ? child.size : undefined,
          })
        }
        // Directories first, then files, each name-sorted, so the browser reads
        // like a file manager instead of the backend's own order.
        entries.sort((left, right) => {
          const rank = (value: DiffApprovalBrowseEntry): number => value.type === 'directory' ? 0 : 1
          const byKind = rank(left) - rank(right)
          return byKind !== 0 ? byKind : left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        })
        const truncated = entries.length > BROWSE_ENTRY_CAP
        const value: DiffApprovalBrowseValue = {
          path: absolute,
          entries: truncated ? entries.slice(0, BROWSE_ENTRY_CAP) : entries,
          truncated,
        }
        return { ok: true, value }
      }
      case 'add-path': {
        // Add one path the user named by hand. The path is scanned the way an
        // import scans, restricted to that one file or directory subtree, so a
        // directory add is recursive by construction and a single file never
        // sweeps the workspace.
        const target = addTargetOf(payload)
        if (target === undefined) return rpcError('sessionId and path must be non-empty strings')
        const workspace = workspaceOf(target.sessionId)
        if (workspace === undefined) return rpcError('add unavailable: the session has no workspace')
        const absolute = resolveInsideWorkspace(workspace.path, target.path)
        if (absolute === undefined) {
          const value: DiffApprovalAddValue = { outcome: 'outside', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        await ensureLoaded()
        // The kind comes from `stat`, not from a read: a directory and an
        // unreadable binary file both fail `readText`, and only one of them is a
        // subtree to scan.
        let info
        try {
          const target = await ctx.fs.resolve(absolute, { signal })
          info = await ctx.fs.stat(target, signal)
        } catch (error: unknown) {
          return rpcError(`add failed: ${errorMessage(error)}`)
        }
        if (info === undefined || info.type === 'other') {
          const value: DiffApprovalAddValue = { outcome: 'missing', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        const isDirectory = info.type === 'directory'
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) {
          const value: DiffApprovalAddValue = { outcome: 'no-vcs', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('add unavailable: the deployment has no shell executor')
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges({
            kind: root.kind,
            root: root.root,
            workspaceRoot: workspace.path,
            // Naming the path is the user's opt-in: a new file it points at is
            // wanted even while the workspace-wide import leaves untracked files
            // alone (that preference exists to bound a whole-tree scan).
            includeUntracked: true,
            scope: absolute,
            shell,
            readText: (path) => readFile(path, 'utf8').catch(() => undefined),
            signal,
          })
        } catch (error: unknown) {
          const value: DiffApprovalAddValue = { outcome: 'failed', added: 0, duplicates: 0, message: errorMessage(error) }
          return { ok: true, value }
        }
        const now = Date.now()
        const candidates: PendingEntry[] = changes.map(change => ({
          id: change.path,
          sessionId: target.sessionId,
          path: change.path,
          kind: change.kind,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: now,
          sessionIds: [target.sessionId],
        }))
        // Ticking "include paths with no change" asks for the paths the scan did
        // not report: the named file itself, or every regular file under the named
        // directory. Each lands as a zero-diff entry — the state a file reaches
        // once every block is kept — and is undoable with the rest of the batch.
        let truncated = false
        if (target.includeUnchanged) {
          const scanned = new Set(candidates.map(entry => pathIdentity(entry.path)))
          const found = isDirectory
            ? await collectFilesUnder(await ctx.fs.resolve(absolute, { signal }), absolute, signal)
            : { files: [{ path: absolute, content: await readTextOrNone(absolute, signal) }], truncated: false }
          truncated = found.truncated
          for (const file of found.files) {
            if (file.content === undefined) continue
            if (scanned.has(pathIdentity(file.path))) continue
            scanned.add(pathIdentity(file.path))
            candidates.push({
              id: file.path,
              sessionId: target.sessionId,
              path: file.path,
              kind: 'edit',
              oldText: file.content,
              newText: file.content,
              updatedAt: now,
              sessionIds: [target.sessionId],
            })
          }
        }
        // Already-listed paths are left exactly as they are: the panel toasts
        // that the path is in the list rather than silently re-baselining a
        // review that is already in progress.
        const listed = new Set(store.list(target.sessionId).map(entry => pathIdentity(entry.path)))
        const fresh = candidates.filter(entry => !listed.has(pathIdentity(entry.path)))
        const duplicates = candidates.length - fresh.length
        const added = await foldBatch(target.sessionId, fresh, true)
        const outcome: DiffApprovalAddOutcome = added > 0
          ? 'added'
          : duplicates > 0
            ? 'duplicate'
            // A single file that is simply clean is `unchanged` (the caller may
            // tick the box and add it anyway); a directory that contributed
            // nothing had nothing to contribute.
            : isDirectory ? 'empty' : 'unchanged'
        const value: DiffApprovalAddValue = truncated ? { outcome, added, duplicates, truncated } : { outcome, added, duplicates }
        return { ok: true, value }
      }
      case 'open': {
        const target = openTargetOf(payload)
        if (target === undefined) return rpcError('sessionId, id, and action must be valid')
        await ensureLoaded()
        const entry = store.get(target.id)
        if (entry === undefined) {
          const value: DiffApprovalOpenValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        try {
          const resolved = await ctx.fs.resolve(entry.path, { signal })
          await launchPath(ctx.fs.processPath(resolved), target.action)
        } catch (error: unknown) {
          return rpcError(`${target.action} failed: ${errorMessage(error)}`)
        }
        const value: DiffApprovalOpenValue = { outcome: 'opened' }
        return { ok: true, value }
      }
      case 'preview-image': {
        const image = previewImageTargetOf(payload)
        if (image === undefined) return rpcError('sessionId and path must be valid')
        await ensureLoaded()
        // Inline one workspace image for the Markdown preview. Reads are confined
        // to the session's workspace: a reference that resolves outside it (a
        // `..` escape, an absolute path elsewhere, or a different workspace) is
        // refused, and an absent/unreadable file answers with no data URI.
        const workspace = workspaceOf(image.sessionId)
        if (workspace === undefined) return rpcError('image unavailable: the session has no workspace')
        let dataUri: string | undefined
        try {
          const target = await ctx.fs.resolve(image.path, { signal })
          const workspaceTarget = await ctx.fs.resolve(workspace.path, {})
          const osPath = ctx.fs.processPath(target)
          const workspaceOs = ctx.fs.processPath(workspaceTarget)
          const inside = relative(workspaceOs, osPath)
          if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
            const bytes = await readFile(osPath)
            if (bytes.length > 0) dataUri = `data:${imageMimeOf(osPath)};base64,${bytes.toString('base64')}`
          }
        } catch {
          // Unresolvable, outside the workspace, or unreadable: leave it undefined.
        }
        const value: DiffApprovalPreviewImageValue = { dataUri }
        return { ok: true, value }
      }
      default:
        return rpcError(`unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  }

  // Mount the review channel. `register` is preferred so the registration owner
  // is this plugin's own context — the one that injects `webServer` (see
  // `ConnectionServiceSurface`). `rpc.handle` stays as the fallback for a build
  // that no longer exposes `register`. The trust policy rides along because the
  // 0.1.0 line reads it from the options argument.
  ctx.effect(() => {
    const service = ctx.connection as unknown as ConnectionServiceSurface
    return typeof service.register === 'function'
      ? service.register(ctx, DIFF_APPROVAL_CHANNEL, handle, { authority: 'trusted-host' })
      : service.rpc.handle(DIFF_APPROVAL_CHANNEL, handle, { authority: 'trusted-host' })
  }, 'diff-approval: review channel')

  // Observe the mutation intent seams without owning the decision: capture
  // the pre-write basis, then hand the chain on untouched so policy plugins
  // and the tool's default remain in charge. `prepend` matters: the harness
  // policy occupies these single-slot waterfalls and never calls `next()`, so
  // a later-registered listener would never run.
  ctx.effect(() => ctx.on('fs/edit-intent', async (target, actor, next) => {
    await stashEditorIntent(target, actor, 'edit')
    return next()
  }, { prepend: true }), 'diff-approval: str_replace_editor edit basis')
  ctx.effect(() => ctx.on('fs/write-intent', async (target, actor, next) => {
    await stashEditorIntent(target, actor, 'create')
    return next()
  }, { prepend: true }), 'diff-approval: str_replace_editor create basis')
}

/** One mutation's basis captured at its intent seam. */
interface IntentBasis {
  target: FsTarget
  kind: PendingEntryKind
  before: string
  sessionId: SessionId | undefined
}

/** Narrow a wire payload's `sessionId` field to a branded session id. */
function sessionOf(payload: unknown): SessionId | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as Record<string, unknown>).sessionId
  return typeof value === 'string' && value.length > 0 ? SessionId(value) : undefined
}

/** The content lines of `text`, matching the diff's line numbering (a single
    trailing newline is a terminator, not an extra empty line). */
function contentLinesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Rebuild text from content lines, keeping `original`'s trailing-newline convention. */
function fromContentLines(original: string, lines: string[]): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (original.endsWith('\n') ? '\n' : '')
}

/** The content lines [start..end] (1-based inclusive) of `text`; empty when start > end. */
function contentRangeOf(text: string, start: number, end: number): string[] {
  if (start > end) return []
  return contentLinesOf(text).slice(start - 1, end)
}

/**
 * Replace the content lines [start..end] (1-based) of `text` with `replacement`
 * lines. An empty range (`start > end`) inserts before line `start`. Out-of-range
 * bounds clamp; the trailing-newline convention of `text` is preserved.
 */
function replaceContentLines(text: string, start: number, end: number, replacement: string[]): string {
  const lines = contentLinesOf(text)
  const count = lines.length
  if (start > end) {
    const at = Math.min(Math.max(start, 1), count + 1)
    return fromContentLines(text, [...lines.slice(0, at - 1), ...replacement, ...lines.slice(at - 1)])
  }
  const s = Math.min(Math.max(start, 1), count + 1)
  const e = Math.min(Math.max(end, 1), count)
  if (s > e) return text
  return fromContentLines(text, [...lines.slice(0, s - 1), ...replacement, ...lines.slice(e)])
}

/** Narrow a wire payload to one block keep/revert target. */
function blockTargetOf(payload: unknown): DiffApprovalBlockTarget | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const block = (payload as Record<string, unknown>).block
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return undefined
  const { oldStart, oldEnd, newStart, newEnd } = block as Record<string, unknown>
  const numbers = [oldStart, oldEnd, newStart, newEnd]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined
  const removeWhenResolved = (payload as Record<string, unknown>).removeWhenResolved
  return {
    ...target,
    block: { oldStart, oldEnd, newStart, newEnd } as DiffApprovalBlockTarget['block'],
    removeWhenResolved: typeof removeWhenResolved === 'boolean' ? removeWhenResolved : undefined,
  }
}

/** Narrow a wire payload to one keep/revert target. */
function targetOf(payload: unknown): { sessionId: SessionId; id: string } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const id = (payload as Record<string, unknown>).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  return { sessionId, id }
}

/** Narrow a wire payload to one preview-image target. */
function previewImageTargetOf(payload: unknown): { sessionId: SessionId; path: string } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const path = (payload as Record<string, unknown>).path
  if (typeof path !== 'string' || path.length === 0) return undefined
  return { sessionId, path }
}

/** One payload's optional `path` field; absent (or not a string) is undefined. */
function pathFieldOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const path = (payload as Record<string, unknown>).path
  return typeof path === 'string' ? path : undefined
}

/** Narrow a wire payload to one hand-added path. */
function addTargetOf(payload: unknown): { sessionId: SessionId; path: string; includeUnchanged: boolean } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  const path = pathFieldOf(payload)?.trim()
  if (path === undefined || path === '') return undefined
  return { sessionId, path, includeUnchanged: (payload as Record<string, unknown>).includeUnchanged === true }
}

/** Narrow a wire payload to one open target: the keep/revert pair plus the action. */
function openTargetOf(payload: unknown): { sessionId: SessionId; id: string; action: OpenAction } | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  const action = (payload as Record<string, unknown>).action
  if (action !== 'open' && action !== 'reveal') return undefined
  return { ...target, action }
}
