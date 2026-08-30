/**
 * Connection-channel port: narrows `ctx.connection.rpc.call` to this
 * package's business verbs and validates the wire values it receives. The
 * host half owns the channel; this module is the browser's one caller.
 * @module dsh-diff-approval/client/port
 */

import type { ClientConnectionRpc, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, PendingFileDiff, VcsImportValue,
} from '../types.ts'

/** The channel the host half registers and this port calls. */
export const DIFF_APPROVAL_CHANNEL = '/diff-approval'

/** This package's business verbs over the review channel. */
export interface DiffApprovalPort {
  /** Read one session's pending entries (plus its workspace root), oldest capture first. */
  list(sessionId: SessionId): Promise<DiffApprovalListValue>
  /** Keep one operation. */
  keep(sessionId: SessionId, id: string): Promise<DiffApprovalActionValue>
  /** Revert one operation. */
  revert(sessionId: SessionId, id: string): Promise<DiffApprovalActionValue>
  /** Keep one diff block (accept its change into the tracked baseline). */
  blockKeep(sessionId: SessionId, id: string, block: DiffApprovalBlockRange): Promise<DiffApprovalActionValue>
  /** Revert one diff block (restore its old lines in the file). */
  blockRevert(sessionId: SessionId, id: string, block: DiffApprovalBlockRange): Promise<DiffApprovalActionValue>
  /** Undo the session's last keep/revert (restore the before state). */
  undo(sessionId: SessionId): Promise<DiffApprovalActionValue>
  /** Redo the session's last undone keep/revert (re-apply the after state). */
  redo(sessionId: SessionId): Promise<DiffApprovalActionValue>
  /** Import the workspace's local VCS changes as pending entries. */
  importVcs(sessionId: SessionId, includeUntracked: boolean): Promise<VcsImportValue>
  /** Open one file with its default application or reveal it in the folder. */
  open(sessionId: SessionId, id: string, action: DiffApprovalOpenAction): Promise<DiffApprovalOpenValue>
}

/** Build the port over one generic RPC caller.
 * @param rpc - the connection's channel caller.
 * @returns the typed port.
 */
export function createDiffApprovalPort(rpc: ClientConnectionRpc): DiffApprovalPort {
  return {
    async list(sessionId) {
      return listValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'list', { sessionId }))
    },
    async keep(sessionId, id) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'keep', { sessionId, id }))
    },
    async revert(sessionId, id) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'revert', { sessionId, id }))
    },
    async blockKeep(sessionId, id, block) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'block-keep', { sessionId, id, block }))
    },
    async blockRevert(sessionId, id, block) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'block-revert', { sessionId, id, block }))
    },
    async undo(sessionId) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'undo', { sessionId }))
    },
    async redo(sessionId) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'redo', { sessionId }))
    },
    async importVcs(sessionId, includeUntracked) {
      return importValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'vcs-import', { sessionId, includeUntracked }))
    },
    async open(sessionId, id, action) {
      return openOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'open', { sessionId, id, action }))
    },
  }
}

/** Narrow one pending entry from the wire; malformed rows are skipped. */
function pendingFileOf(value: unknown): PendingFileDiff | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { id, sessionId, path, kind, oldText, newText, updatedAt, missing, diverged } = value as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (kind !== 'edit' && kind !== 'create') return undefined
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (typeof updatedAt !== 'number') return undefined
  return {
    id,
    sessionId: sessionId as SessionId,
    path,
    kind,
    oldText,
    newText,
    updatedAt,
    // An absent flag keeps older hosts listable; the flags are host truth.
    missing: missing === true,
    diverged: diverged === true,
  }
}

/** Narrow the list endpoint's value; a malformed wire value is a read failure. */
function listValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalListValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('list returned a malformed value')
  }
  const rows = (value as Record<string, unknown>).files
  if (!Array.isArray(rows)) throw new Error('list returned a malformed value')
  const workspace = (value as Record<string, unknown>).workspacePath
  const workspacePath = typeof workspace === 'string' && workspace.length > 0 ? workspace : undefined
  const files: PendingFileDiff[] = []
  for (const row of rows) {
    const file = pendingFileOf(row)
    if (file !== undefined) files.push(file)
  }
  const redoCleared = (value as Record<string, unknown>).redoCleared
  return redoCleared === true ? { files, workspacePath, redoCleared: true } : { files, workspacePath }
}

/** Narrow one action endpoint's value; a malformed wire value is an action failure. */
function actionOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalActionValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the action returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'kept' && outcome !== 'reverted' && outcome !== 'missing'
    && outcome !== 'undone' && outcome !== 'redone' && outcome !== 'nothing') {
    throw new Error('the action returned a malformed outcome')
  }
  const id = (value as Record<string, unknown>).id
  const entryId = typeof id === 'string' && id.length > 0 ? id : undefined
  const resolved = (value as Record<string, unknown>).resolved
  return resolved === true ? { outcome, id: entryId, resolved: true } : { outcome, id: entryId }
}

/** Narrow the vcs-import endpoint's value; a malformed wire value is a failure. */
function importValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): VcsImportValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the import returned a malformed value')
  const imported = (value as Record<string, unknown>).imported
  const detected = (value as Record<string, unknown>).detected
  if (typeof imported !== 'number' || typeof detected !== 'boolean') {
    throw new Error('the import returned a malformed value')
  }
  return { imported, detected }
}

/** Narrow the open endpoint's value; a malformed wire value is an open failure. */
function openOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalOpenValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the action returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'opened' && outcome !== 'missing') {
    throw new Error('the action returned a malformed outcome')
  }
  return { outcome }
}
