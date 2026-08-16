/**
 * Pending-diff observable store: the page's one reading of the host's pending
 * list. Refreshed on panel open, on an interval while the panel stays open,
 * and after each action; a successful action also removes its path locally so
 * the row leaves without waiting for the next poll.
 * @module dsh-diff-approval/client/store
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
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
  /** Drop every local fact (used on connection reset). */
  reset: () => void
}

/** An empty busy set reused as the snapshot's canonical absent value. */
const EMPTY_BUSY: ReadonlySet<string> = new Set()

/**
 * Create the store over the review-channel port.
 * @param port - the typed channel port.
 * @returns the observable store.
 */
export function createPendingDiffStore(port: DiffApprovalPort): PendingDiffStore {
  let snapshot: PendingDiffSnapshot = { read: false, files: [], busy: EMPTY_BUSY }
  const listeners = new Set<() => void>()

  const publish = (next: PendingDiffSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const withBusy = async (id: string, action: () => Promise<void>): Promise<void> => {
    const { error: _cleared, ...base } = snapshot
    publish({ ...base, busy: new Set([...snapshot.busy, id]) })
    try {
      await action()
    } catch (error: unknown) {
      publish({
        ...snapshot,
        error: error instanceof Error ? error.message : String(error),
        busy: new Set([...snapshot.busy].filter(busy => busy !== id)),
      })
      return
    }
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
        publish({ read: true, files: [], busy: EMPTY_BUSY })
        return
      }
      try {
        const files = await port.list(sessionId)
        publish({ read: true, files, busy: EMPTY_BUSY })
      } catch (error: unknown) {
        publish({
          read: true,
          files: snapshot.files,
          error: error instanceof Error ? error.message : String(error),
          busy: snapshot.busy,
        })
      }
    },
    keep(sessionId, id) {
      return withBusy(id, async () => { await port.keep(sessionId, id) })
    },
    revert(sessionId, id) {
      return withBusy(id, async () => { await port.revert(sessionId, id) })
    },
    reset() {
      publish({ read: false, files: [], busy: EMPTY_BUSY })
    },
  }
}
