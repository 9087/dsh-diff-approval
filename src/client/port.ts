/**
 * Connection-channel port: narrows `ctx.connection.rpc.call` to this
 * package's business verbs and validates the wire values it receives. The
 * host half owns the channel; this module is the browser's one caller.
 * @module dsh-diff-approval/client/port
 */

import type { ClientConnectionRpc, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalActionValue, PendingFileDiff } from '../types.ts'

/** The channel the host half registers and this port calls. */
export const DIFF_APPROVAL_CHANNEL = '/diff-approval'

/** This package's business verbs over the review channel. */
export interface DiffApprovalPort {
  /** Read one session's pending entries, oldest capture first. */
  list(sessionId: SessionId): Promise<PendingFileDiff[]>
  /** Keep one operation. */
  keep(sessionId: SessionId, id: string): Promise<DiffApprovalActionValue>
  /** Revert one operation. */
  revert(sessionId: SessionId, id: string): Promise<DiffApprovalActionValue>
}

/** Build the port over one generic RPC caller.
 * @param rpc - the connection's channel caller.
 * @returns the typed port.
 */
export function createDiffApprovalPort(rpc: ClientConnectionRpc): DiffApprovalPort {
  return {
    async list(sessionId) {
      return filesOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'list', { sessionId }))
    },
    async keep(sessionId, id) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'keep', { sessionId, id }))
    },
    async revert(sessionId, id) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'revert', { sessionId, id }))
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
function filesOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): PendingFileDiff[] {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('list returned a malformed value')
  }
  const rows = (value as Record<string, unknown>).files
  if (!Array.isArray(rows)) throw new Error('list returned a malformed value')
  const files: PendingFileDiff[] = []
  for (const row of rows) {
    const file = pendingFileOf(row)
    if (file !== undefined) files.push(file)
  }
  return files
}

/** Narrow one action endpoint's value; a malformed wire value is an action failure. */
function actionOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalActionValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the action returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'kept' && outcome !== 'reverted' && outcome !== 'missing') {
    throw new Error('the action returned a malformed outcome')
  }
  return { outcome }
}
