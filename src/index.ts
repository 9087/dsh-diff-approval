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

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
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
import type {
  DiffApprovalActionValue, DiffApprovalBlockTarget, DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue,
  PendingEntry, PendingEntryKind, PendingFileDiff,
} from './types.ts'

export type {
  DiffApprovalActionOutcome, DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalBlockTarget,
  DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, PendingEntry, PendingEntryKind, PendingFileDiff,
} from './types.ts'
export { PendingDiffStore } from './pending.ts'
export { PendingPersistence, defaultStorageDir } from './persist.ts'
export { defaultOpenPath } from './open.ts'

/** Stable Cordis plugin name. */
export const name = 'diff-approval'

/** Services required before the review surface activates. */
export const inject = ['fs', 'connection', 'workspaceRegistry']

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
 * Build one channel error in the closed RPC error vocabulary. `internal` is
 * the catch-all: business misses ride the success branch as `outcome: 'missing'`.
 * @param message - the handler-side description.
 * @returns the error branch.
 */
function rpcError(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
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
  /** Sessions seen per workspace, so the list can merge a workspace's sessions. */
  const sessionsByWorkspace = new Map<string, Set<string>>()
  /** Workspace ids whose persisted state has been hydrated into the store. */
  const loadedWorkspaces = new Set<string>()
  const loadingWorkspaces = new Map<string, Promise<void>>()

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
    const entry: PendingEntry = {
      id: randomUUID(),
      sessionId,
      path: basis.target.displayPath,
      kind: basis.kind,
      oldText: basis.before,
      newText: after,
      updatedAt: Date.now(),
    }
    await ensureLoaded(sessionId)
    if (store.fold(entry)) await persistSession(sessionId)
  }

  /**
   * Read one path's live state: present content, an unresolvable (missing)
   * path, or a resolved-but-unreadable file.
   * @param path - backend display path to probe through `ctx.fs`.
   * @returns the live state.
   */
  async function liveStateOf(path: string): Promise<
    { present: true; content: string } | { present: false; kind: 'missing' | 'unreadable' }
  > {
    let target
    try {
      target = await ctx.fs.resolve(path, {})
    } catch {
      // Resolution is how this seam reports a gone path; absence is a state,
      // not a fault, so the missing branch answers.
      return { present: false, kind: 'missing' }
    }
    try {
      return { present: true, content: await ctx.fs.readText(target, undefined) }
    } catch {
      // Resolved but unreadable: the content cannot be verified, which the
      // panel reports as divergence — the safe reading.
      return { present: false, kind: 'unreadable' }
    }
  }

  /**
   * Attach the live file state to each listed entry. Reading runs once per
   * path (the panel polls once a second and the review set stays small).
   * @param entries - the store's entries for one session.
   * @returns entries with `missing` and `diverged` set from the live file.
   */
  async function listWithState(entries: readonly PendingEntry[]): Promise<PendingFileDiff[]> {
    const byPath = new Map<string, PendingEntry[]>()
    for (const entry of entries) {
      const group = byPath.get(entry.path)
      if (group === undefined) byPath.set(entry.path, [entry])
      else group.push(entry)
    }
    const listed: PendingFileDiff[] = []
    for (const group of byPath.values()) {
      const newest = group[group.length - 1]
      if (newest === undefined) continue
      const live = await liveStateOf(newest.path)
      const state = live.present
        ? { missing: false, diverged: live.content !== newest.newText }
        : { missing: live.kind === 'missing', diverged: live.kind === 'unreadable' }
      for (const entry of group) listed.push({ ...entry, ...state })
    }
    return listed
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
   * Record one session in its workspace's account. Every path that touches a
   * session registers it, so the list merges all of a workspace's sessions'
   * entries — a fresh session after restart still sees the workspace's
   * persisted pending changes.
   * @param sessionId - the session to register.
   * @returns the owning workspace, or `undefined` when none accounts it.
   */
  function registerSession(sessionId: SessionId): Workspace | undefined {
    const workspace = workspaceOf(sessionId)
    if (workspace === undefined) return undefined
    const key = String(workspace.id)
    const sessions = sessionsByWorkspace.get(key)
    if (sessions === undefined) sessionsByWorkspace.set(key, new Set([String(sessionId)]))
    else sessions.add(String(sessionId))
    return workspace
  }

  /**
   * Merge one workspace's persisted entries into the store, once per
   * workspace. Hydration is workspace-scoped: after a restart the current
   * session has a fresh id while the persisted entries live under their
   * original session ids in the same workspace file, so the whole workspace
   * is loaded and every persisted session is accounted. Concurrent callers
   * share the in-flight load, and folds arriving while the load runs stay
   * safe: `hydrate` never overwrites a live entry.
   * @param workspace - the workspace whose persisted state to merge.
   * @returns resolution after the workspace's persisted state is merged (or skipped).
   */
  function ensureWorkspaceLoaded(workspace: Workspace): Promise<void> {
    const key = String(workspace.id)
    if (loadedWorkspaces.has(key)) return Promise.resolve()
    const pending = loadingWorkspaces.get(key)
    if (pending !== undefined) return pending
    const task = (async () => {
      try {
        const persisted = await persistence.loadWorkspace(key)
        const bySession = new Map<string, PendingEntry[]>()
        for (const entry of persisted) {
          const sessionKey = String(entry.sessionId)
          const group = bySession.get(sessionKey)
          if (group === undefined) bySession.set(sessionKey, [entry])
          else group.push(entry)
        }
        for (const [sessionKey, entries] of bySession) {
          const sessions = sessionsByWorkspace.get(key) ?? new Set<string>()
          sessions.add(sessionKey)
          sessionsByWorkspace.set(key, sessions)
          store.hydrate(SessionId(sessionKey), entries)
        }
      } catch (error: unknown) {
        ctx.logger.warn(`diff-approval: loading persisted state for workspace ${key} failed: ${errorMessage(error)}`)
      }
      loadedWorkspaces.add(key)
      loadingWorkspaces.delete(key)
    })()
    loadingWorkspaces.set(key, task)
    return task
  }

  /**
   * Merge the session's workspace's persisted state into the store (a session
   * with no workspace is the memory-only edge and has nothing to load).
   * @param sessionId - the session to hydrate for.
   * @returns resolution after the workspace's persisted state is merged.
   */
  function ensureLoaded(sessionId: SessionId): Promise<void> {
    const workspace = registerSession(sessionId)
    if (workspace === undefined) return Promise.resolve()
    return ensureWorkspaceLoaded(workspace)
  }

  /**
   * All entries visible to one session: every registered session of its
   * workspace, merged oldest capture first. This is what makes an unhandled
   * change survive a restart — the new session lists the workspace's whole
   * pending set, its own live folds plus the earlier sessions' persisted
   * entries.
   * @param sessionId - the viewing session.
   * @returns the merged entries; a session with no workspace lists only itself.
   */
  async function workspaceEntries(sessionId: SessionId): Promise<PendingEntry[]> {
    await ensureLoaded(sessionId)
    const workspace = workspaceOf(sessionId)
    if (workspace === undefined) return store.list(sessionId)
    const sessions = sessionsByWorkspace.get(String(workspace.id))
    if (sessions === undefined) return store.list(sessionId)
    const entries: PendingEntry[] = []
    for (const sessionKey of sessions) entries.push(...store.list(SessionId(sessionKey)))
    return entries.sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /**
   * Mirror one session's entries to disk. A write fault logs a warning and
   * leaves the in-memory view intact: the review flow must not break on a
   * storage fault, and the next successful mutation rewrites the whole file.
   * @param sessionId - the session whose complete entry list to save.
   * @returns resolution after the write settles (successful or logged).
   */
  async function persistSession(sessionId: SessionId): Promise<void> {
    await ensureLoaded(sessionId)
    const workspace = workspaceOf(sessionId)
    if (workspace === undefined) return
    try {
      await persistence.save(String(workspace.id), String(sessionId), store.list(sessionId))
    } catch (error: unknown) {
      ctx.logger.warn(`diff-approval: persisting session ${String(sessionId)} failed: ${errorMessage(error)}`)
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
    const entry: PendingEntry = { id: randomUUID(), sessionId, ...outcome, updatedAt: Date.now() }
    void (async () => {
      await ensureLoaded(sessionId)
      if (store.fold(entry)) await persistSession(sessionId)
    })()
  })

  const handle: ConnectionRpcHandler = async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    switch (endpoint) {
      case 'list': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const files = await listWithState(await workspaceEntries(sessionId))
        const value: DiffApprovalListValue = { files, workspacePath: workspaceOf(sessionId)?.path }
        return { ok: true, value }
      }
      case 'keep': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded(target.sessionId)
        const removed = store.remove(target.sessionId, target.id)
        if (removed) await persistSession(target.sessionId)
        const value: DiffApprovalActionValue = { outcome: removed ? 'kept' : 'missing' }
        return { ok: true, value }
      }
      case 'revert': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded(target.sessionId)
        const entry = store.get(target.sessionId, target.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        try {
          const resolved = await ctx.fs.resolve(entry.path, { signal })
          if (entry.kind === 'create') {
            // The fs seam has no delete; `processPath` exists to hand a path
            // to OS-level code, so the revert of a created file removes it
            // through the backend's own execution-world path.
            await rm(ctx.fs.processPath(resolved), { force: true })
          } else {
            await ctx.fs.writeText(resolved, entry.oldText, undefined, signal)
          }
        } catch (error: unknown) {
          return rpcError(`revert failed: ${errorMessage(error)}`)
        }
        store.remove(target.sessionId, target.id)
        await persistSession(target.sessionId)
        const value: DiffApprovalActionValue = { outcome: 'reverted' }
        return { ok: true, value }
      }
      case 'block-keep': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded(blockTarget.sessionId)
        const entry = store.get(blockTarget.sessionId, blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Accept this block: fold its new side into the tracked baseline so
        // the entry's diff no longer shows it. The file already holds the
        // accepted content, so nothing is written.
        const accepted = contentRangeOf(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd)
        const updatedOld = replaceContentLines(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd, accepted)
        if (updatedOld === entry.newText) store.remove(blockTarget.sessionId, blockTarget.id)
        else store.update(blockTarget.sessionId, blockTarget.id, { oldText: updatedOld })
        await persistSession(blockTarget.sessionId)
        const kept: DiffApprovalActionValue = { outcome: 'kept' }
        return { ok: true, value: kept }
      }
      case 'block-revert': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded(blockTarget.sessionId)
        const entry = store.get(blockTarget.sessionId, blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Undo this block: restore its old side into the new text and write
        // the file back. A created file that reverts to empty is removed like
        // the whole-file revert.
        const restored = contentRangeOf(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd)
        const updatedNew = replaceContentLines(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd, restored)
        try {
          const resolved = await ctx.fs.resolve(entry.path, { signal })
          if (entry.kind === 'create' && updatedNew === '') {
            await rm(ctx.fs.processPath(resolved), { force: true })
          } else {
            await ctx.fs.writeText(resolved, updatedNew, undefined, signal)
          }
        } catch (error: unknown) {
          return rpcError(`block revert failed: ${errorMessage(error)}`)
        }
        if (updatedNew === entry.oldText) store.remove(blockTarget.sessionId, blockTarget.id)
        else store.update(blockTarget.sessionId, blockTarget.id, { newText: updatedNew })
        await persistSession(blockTarget.sessionId)
        const reverted: DiffApprovalActionValue = { outcome: 'reverted' }
        return { ok: true, value: reverted }
      }
      case 'open': {
        const target = openTargetOf(payload)
        if (target === undefined) return rpcError('sessionId, id, and action must be valid')
        await ensureLoaded(target.sessionId)
        const entry = store.get(target.sessionId, target.id)
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
      default:
        return rpcError(`unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  }

  ctx.effect(
    () => ctx.connection.rpc.handle(DIFF_APPROVAL_CHANNEL, handle, { authority: 'trusted-host' }),
    'diff-approval: review channel',
  )

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
  return { ...target, block: { oldStart, oldEnd, newStart, newEnd } as DiffApprovalBlockTarget['block'] }
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

/** Narrow a wire payload to one open target: the keep/revert pair plus the action. */
function openTargetOf(payload: unknown): { sessionId: SessionId; id: string; action: OpenAction } | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  const action = (payload as Record<string, unknown>).action
  if (action !== 'open' && action !== 'reveal') return undefined
  return { ...target, action }
}
