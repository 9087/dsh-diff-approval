/**
 * Pending-diff observable store: the page's one reading of the host's pending
 * list. Refreshed on panel open, on an interval while the panel stays open,
 * and after each action; a successful action also removes its path locally so
 * the row leaves without waiting for the next poll.
 * @module dsh-diff-approval/client/store
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalOpenAction, VcsImportValue } from '../types.ts'
import type { PendingDiffSnapshot } from './slots.ts'
import type { DiffApprovalPort } from './port.ts'

/** The observable the panel reads and the plugin body drives. */
export interface PendingDiffStore extends HostObservable<PendingDiffSnapshot> {
  /** Re-read one session's pending list (an absent session empties the view). */
  refresh: (sessionId: SessionId | undefined) => Promise<void>
  /** Keep one operation. */
  keep: (sessionId: SessionId, id: string) => Promise<void>
  /** Revert one operation. */
  revert: (sessionId: SessionId, id: string) => Promise<void>
  /** Keep one diff block, then refresh so the entry's diff reflects the accept. */
  blockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  /** Revert one diff block, then refresh so the entry's diff reflects the undo. */
  blockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  /** Undo the session's last keep/revert, then refresh; resolves to the affected entry id when it is still pending. */
  undo: (sessionId: SessionId) => Promise<string | undefined>
  /** Redo the session's last undone keep/revert, then refresh; resolves to the affected entry id when it is still pending. */
  redo: (sessionId: SessionId) => Promise<string | undefined>
  /** Import the workspace's local VCS changes as pending entries, then refresh. */
  importVcs: (sessionId: SessionId, includeUntracked: boolean) => Promise<VcsImportValue>
  /** Open one file with its default application or reveal it in the folder. */
  open: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Drop every local fact (used on connection reset). */
  reset: () => void
  /** Acknowledge a redo-cleared notice so the panel surfaces it only once. */
  clearRedoCleared: () => void
  /** Acknowledge the just-resolved prompt so it is only surfaced once. */
  clearJustResolved: () => void
}

/** An empty busy set reused as the snapshot's canonical absent value. */
const EMPTY_BUSY: ReadonlySet<string> = new Set()
/** An empty failure map reused as the snapshot's canonical absent value. */
const EMPTY_FAILED: ReadonlyMap<string, string> = new Map()
/** How long a failed keep/revert hint stays visible before it auto-clears. */
const FAILED_HINT_MS = 5000

/**
 * Create the store over the review-channel port.
 * @param port - the typed channel port.
 * @returns the observable store.
 */
export function createPendingDiffStore(port: DiffApprovalPort): PendingDiffStore {
  let snapshot: PendingDiffSnapshot = { read: false, files: [], busy: EMPTY_BUSY }
  const listeners = new Set<() => void>()
  // Latched until the panel acknowledges it: a detected external change that
  // superseded the redo history must surface even when the panel is closed.
  let redoCleared = false
  // Latched file id whose last block just resolved; the panel acknowledges it
  // (remove-or-keep) to clear the latch.
  let justResolved: string | undefined

  const publish = (next: PendingDiffSnapshot): void => {
    // Carry the latched flags so they survive an ordinary snapshot; a normal
    // publish is byte-for-byte the shape older consumers expect.
    let result = next
    if (redoCleared) result = { ...result, redoCleared: true }
    if (justResolved !== undefined) result = { ...result, justResolved }
    snapshot = result
    for (const listener of [...listeners]) listener()
  }

  const failedOf = (value: PendingDiffSnapshot): ReadonlyMap<string, string> => value.failed ?? EMPTY_FAILED

  /** Record one entry's failed keep/revert with its message; auto-clears after a few seconds. */
  const markFailed = (id: string, message: string): void => {
    publish({ ...snapshot, failed: new Map([...failedOf(snapshot), [id, message]]) })
    window.setTimeout(() => {
      // Re-check at fire time: the marker may have been cleared or replaced.
      if (failedOf(snapshot).get(id) !== message) return
      const next = new Map(failedOf(snapshot))
      next.delete(id)
      publish({ ...snapshot, failed: next })
    }, FAILED_HINT_MS)
  }

  /** Drop one entry's failure marker after a successful retry. */
  const clearFailed = (id: string): void => {
    if (!failedOf(snapshot).has(id)) return
    const next = new Map(failedOf(snapshot))
    next.delete(id)
    publish({ ...snapshot, failed: next })
  }

  const withBusy = async (id: string, action: () => Promise<void>): Promise<void> => {
    const { error: _cleared, ...base } = snapshot
    publish({ ...base, failed: failedOf(snapshot), busy: new Set([...snapshot.busy, id]) })
    try {
      await action()
    } catch (error: unknown) {
      // A failed decision keeps the entry and surfaces inline; it must not
      // swap the whole panel to the error screen.
      markFailed(id, error instanceof Error ? error.message : String(error))
      publish({
        ...snapshot,
        busy: new Set([...snapshot.busy].filter(busy => busy !== id)),
      })
      return
    }
    clearFailed(id)
    publish({
      ...snapshot,
      files: snapshot.files.filter(file => file.id !== id),
      busy: new Set([...snapshot.busy].filter(busy => busy !== id)),
    })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh(sessionId) {
      if (sessionId === undefined) {
        publish({ read: true, files: [], busy: EMPTY_BUSY, failed: failedOf(snapshot) })
        return
      }
      try {
        const { files, workspacePath, redoCleared: cleared } = await port.list(sessionId)
        if (cleared) redoCleared = true
        // Carry the failure markers through: a hint must survive the poll
        // (auto-clears on its own timer) rather than vanish a second later.
        publish({ read: true, files, workspacePath, busy: EMPTY_BUSY, failed: failedOf(snapshot) })
      } catch (error: unknown) {
        publish({
          read: true,
          files: snapshot.files,
          workspacePath: snapshot.workspacePath,
          error: error instanceof Error ? error.message : String(error),
          busy: snapshot.busy,
          failed: failedOf(snapshot),
        })
      }
    },
    keep(sessionId, id) {
      return withBusy(id, async () => { await port.keep(sessionId, id) })
    },
    revert(sessionId, id) {
      return withBusy(id, async () => { await port.revert(sessionId, id) })
    },
    // A block op keeps the entry: mark the file busy, run the port call, then
    // refresh so the entry's diff updates (the poll alone would lag a second).
    // When the port reports the last block resolved, latch `justResolved` so
    // the panel prompts once (remove-or-keep) — the entry itself stays listed.
    async blockKeep(sessionId, id, block) {
      const { error: _cleared, ...base } = snapshot
      publish({ ...base, busy: new Set([...snapshot.busy, id]) })
      let value: DiffApprovalActionValue
      try {
        value = await port.blockKeep(sessionId, id, block)
      } catch (error: unknown) {
        markFailed(id, error instanceof Error ? error.message : String(error))
        publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
        return
      }
      clearFailed(id)
      if (value.resolved === true) justResolved = id
      await this.refresh(sessionId)
    },
    async blockRevert(sessionId, id, block) {
      const { error: _cleared, ...base } = snapshot
      publish({ ...base, busy: new Set([...snapshot.busy, id]) })
      let value: DiffApprovalActionValue
      try {
        value = await port.blockRevert(sessionId, id, block)
      } catch (error: unknown) {
        markFailed(id, error instanceof Error ? error.message : String(error))
        publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
        return
      }
      clearFailed(id)
      if (value.resolved === true) justResolved = id
      await this.refresh(sessionId)
    },
    // Undo/redo restores a pending entry (undo) or removes one (redo); only an
    // id that is still pending after the refresh is worth selecting, so the
    // caller can switch to it. A failure (divergence guard, lost file) stays
    // silent on the list and resolves to undefined.
    async undo(sessionId) {
      try {
        const value = await port.undo(sessionId)
        await this.refresh(sessionId)
        const id = value.id
        return id !== undefined && snapshot.files.some(file => file.id === id) ? id : undefined
      } catch {
        return undefined
      }
    },
    async redo(sessionId) {
      try {
        const value = await port.redo(sessionId)
        await this.refresh(sessionId)
        const id = value.id
        return id !== undefined && snapshot.files.some(file => file.id === id) ? id : undefined
      } catch {
        return undefined
      }
    },
    async importVcs(sessionId, includeUntracked) {
      const value = await port.importVcs(sessionId, includeUntracked)
      await this.refresh(sessionId)
      return value
    },
    async open(sessionId, id, action) {
      try {
        await port.open(sessionId, id, action)
      } catch (error: unknown) {
        publish({
          ...snapshot,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    reset() {
      justResolved = undefined
      publish({ read: false, files: [], busy: EMPTY_BUSY })
    },
    clearRedoCleared() {
      redoCleared = false
      const { redoCleared: _omit, ...rest } = snapshot
      publish(rest)
    },
    clearJustResolved() {
      justResolved = undefined
      const { justResolved: _omit, ...rest } = snapshot
      publish(rest)
    },
  }
}
