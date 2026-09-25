/**
 * Pending-diff observable store: the page's one reading of the host's pending
 * list. Refreshed on panel open, on an interval while the panel stays open,
 * and after each action; a successful action also removes its path locally so
 * the row leaves without waiting for the next poll.
 * @module dsh-diff-approval/client/store
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommentRecord, DiffApprovalAddValue, DiffApprovalBlockRange, DiffApprovalBrowseValue, DiffApprovalCommentAddValue, DiffApprovalCommentAskValue, DiffApprovalCommentRemoveValue, DiffApprovalOpenAction, DiffApprovalRefreshValue, VcsImportValue } from '../types.ts'
import type { PendingDiffSnapshot } from './slots.ts'
import type { CommentDraft, DiffApprovalPort } from './port.ts'

/** The observable the panel reads and the plugin body drives. */
export interface PendingDiffStore extends HostObservable<PendingDiffSnapshot> {
  /** Re-read one session's pending list (an absent session empties the view). */
  refresh: (sessionId: SessionId | undefined) => Promise<void>
  /** Keep one operation. `keepListed` leaves the resolved entry in the list. */
  keep: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** Revert one operation. `keepListed` leaves the resolved entry in the list. */
  revert: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** Keep one diff block, then refresh so the entry's diff reflects the accept. */
  blockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean) => Promise<void>
  /** Revert one diff block, then refresh so the entry's diff reflects the undo. */
  blockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean) => Promise<void>
  /** Undo the session's last keep/revert, then refresh; resolves to the affected entry id when it is still pending. */
  undo: (sessionId: SessionId) => Promise<string | undefined>
  /** Redo the session's last undone keep/revert, then refresh; resolves to the affected entry id when it is still pending. */
  redo: (sessionId: SessionId) => Promise<string | undefined>
  /** Import the workspace's local VCS changes as pending entries, then refresh. */
  importVcs: (sessionId: SessionId, includeUntracked: boolean) => Promise<VcsImportValue>
  /** Replace one entry's diff with the file's current local VCS change, then
   *  refresh; resolves to what the scan found. */
  refreshVcs: (sessionId: SessionId, id: string, includeUntracked: boolean) => Promise<DiffApprovalRefreshValue>
  /** List one workspace directory level for the add-path dialog. */
  browse: (sessionId: SessionId, path?: string) => Promise<DiffApprovalBrowseValue>
  /** Add one named path to the list, then refresh; resolves to what the scan did. */
  addPath: (sessionId: SessionId, path: string, includeUnchanged: boolean, exact?: boolean) => Promise<DiffApprovalAddValue>
  /** Open one file with its default application or reveal it in the folder. */
  open: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Keep every pending entry of one session in a single host call, then refresh. */
  keepAll: (sessionId: SessionId) => Promise<void>
  /** Revert every pending entry of one session in a single host call, then refresh. */
  revertAll: (sessionId: SessionId) => Promise<void>
  /** Inline one workspace image as a base64 data URI (empty when unreadable). */
  previewImage: (sessionId: SessionId, path: string) => Promise<string | undefined>
  /**
   * Write one annotation down, then refresh so the thread appears from the host's own
   * copy (the panel keeps no thread state of its own).
   */
  commentAdd: (sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>
  /** Drop one annotation, then refresh. */
  commentRemove: (sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>
  /** Ask one stored comment as its own turn, then refresh (the answer is derived on read). */
  commentAsk: (sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>
  /** Drop every local fact (used on connection reset). */
  reset: () => void
  /** Acknowledge a redo-cleared notice so the panel surfaces it only once. */
  clearRedoCleared: () => void
  /**
   * Acknowledge the last refused-undo notice, once the panel has said it. Without this
   * the field would sit there for the rest of the session and the same refusal later
   * would not be news; the panel says it and clears it in one step.
   */
  clearUndoNotice: () => void
}

/** An empty busy set reused as the snapshot's canonical absent value. */
const EMPTY_BUSY: ReadonlySet<string> = new Set()
/** An empty failure map reused as the snapshot's canonical absent value. */
const EMPTY_FAILED: ReadonlyMap<string, string> = new Map()
/** Empty comment state reused as the snapshot's canonical absent value. */
const NO_COMMENTS: readonly CommentRecord[] = []
const NO_ANSWERS: Readonly<Record<string, string>> = {}
/** No resolved comment lines reused as the snapshot's canonical absent value. */
const NO_COMMENT_LINES: Readonly<Record<string, { start: number; end: number }>> = {}
/** How long a failed keep/revert hint stays visible before it auto-clears. */
const FAILED_HINT_MS = 5000

/**
 * Create the store over the review-channel port.
 * @param port - the typed channel port.
 * @returns the observable store.
 */
export function createPendingDiffStore(port: DiffApprovalPort): PendingDiffStore {
  let snapshot: PendingDiffSnapshot = {
    read: false,
    files: [],
    comments: NO_COMMENTS as CommentRecord[],
    commentLines: NO_COMMENT_LINES,
    commentsRevision: 0,
    commentAnswers: NO_ANSWERS as Record<string, string>,
    busy: EMPTY_BUSY,
  }
  const listeners = new Set<() => void>()
  // Latched until the panel acknowledges it: a detected external change that
  // superseded the redo history must surface even when the panel is closed.
  let redoCleared = false
  /**
   * The read the store is currently waiting on, bumped by every refresh (and by `reset`).
   * A refresh captures it before the port call and compares it after: a response whose
   * epoch is no longer the current one is an answer to a request the store has already
   * moved past — an older poll of the same session, or a read of the session the reader
   * left — and publishing it would put stale files and comments under the current view.
   */
  let epoch = 0

  const publish = (next: PendingDiffSnapshot): void => {
    // Carry the latched flag so it survives an ordinary snapshot.
    let result = next
    if (redoCleared) result = { ...result, redoCleared: true }
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

  /**
   * Clear one entry's busy mark, now that its action is done.
   *
   * A completed action clears its OWN id — that is the only thing that ever removes one, and it
   * has to be said out loud here rather than left to a poll: the poll now CARRIES the in-flight
   * set through instead of publishing an empty one (see `refresh`), so an action that finished
   * and only then re-read the list would leave its row disabled for good.
   * @param id - the entry the action was about.
   */
  const clearBusy = (id: string): void => {
    if (!snapshot.busy.has(id)) return
    publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
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

  /**
   * Run a whole-file action whose entry STAYS listed (the panel chose "keep in
   * list"). The local list must not drop it optimistically — that made a kept
   * file blink out and come back on the next poll — so this takes the block
   * actions' shape instead: mark busy, run, then re-read so the entry's now-empty
   * diff shows at once.
   * @param id - the entry being acted on.
   * @param refresh - the store's refresh, awaited after a successful action.
   * @param action - the port call to run.
   */
  const withKeptEntry = async (id: string, refresh: () => Promise<void>, action: () => Promise<void>): Promise<void> => {
    const { error: _cleared, ...base } = snapshot
    publish({ ...base, failed: failedOf(snapshot), busy: new Set([...snapshot.busy, id]) })
    try {
      await action()
    } catch (error: unknown) {
      markFailed(id, error instanceof Error ? error.message : String(error))
      publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
      return
    }
    clearFailed(id)
    clearBusy(id)
    await refresh()
  }

  /**
   * Publish one refused/anything-to-say history message, or retract it with `undefined`.
   *
   * A notice that is already showing is not re-published for the same text: the panel
   * toasts on a change, and a held key would otherwise re-toast the same refusal. The
   * panel clears the field when it has said it (see the panel's own effect), so the
   * SAME refusal later is news again — which is what the reader of a repeated Ctrl+Z
   * needs, since a second press is a second attempt.
   * @param message - what to say, or undefined to retract.
   */
  const publishUndoNotice = (message: string | undefined): void => {
    if (snapshot.undoNotice === message) return
    publish({ ...snapshot, undoNotice: message })
  }

  /**
   * Run one undo/redo through the port and report what it did.
   *
   * The host answers a refused undo with the reason and no id; the panel has to be told
   * both halves, because "the file changed outside the review after the action; undo is
   * unavailable" is something only the host knows and only the reader can act on. A
   * successful one keeps today's behaviour: the affected entry's id when it is still
   * pending, so the panel can select it.
   * @param kind - which verb to run.
   * @param sessionId - the session whose history to move.
   * @param refresh - the store's own refresh, taken as a parameter for the same reason
   *   `withBusy` takes it: this helper is a closure, so `this` is not the returned store.
   * @returns the affected entry id, or undefined when the call was refused or touched nothing.
   */
  const runHistory = async (kind: 'undo' | 'redo', sessionId: SessionId, refresh: (sessionId: SessionId) => Promise<void>): Promise<string | undefined> => {
    try {
      const value = kind === 'undo' ? await port.undo(sessionId) : await port.redo(sessionId)
      publishUndoNotice(undefined)
      await refresh(sessionId)
      const id = value.id
      return id !== undefined && snapshot.files.some(file => file.id === id) ? id : undefined
    } catch (error: unknown) {
      publishUndoNotice(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh(sessionId) {
      // This read supersedes every read already in flight, whatever session it was for.
      const request = ++epoch
      if (sessionId === undefined) {
        publish({
          read: true,
          files: [],
          comments: NO_COMMENTS as CommentRecord[],
          commentLines: NO_COMMENT_LINES,
          commentsRevision: 0,
          commentAnswers: NO_ANSWERS as Record<string, string>,
          busy: EMPTY_BUSY,
          failed: failedOf(snapshot),
        })
        return
      }
      try {
        const {
          files, comments, commentLines, commentsRevision, commentAnswers,
          workspacePath, redoCleared: cleared, commentSkill, persistError, commentPersistError,
        } = await port.list(sessionId)
        // A newer read has already answered, so this one is about a view the store has left
        // (the next poll, or another session the reader switched to). It is dropped WHOLE:
        // neither its files/comments nor its redoCleared latch are published, and its busy
        // and failed bookkeeping is left exactly as the live snapshot has it — the newest
        // response carries both through, so a drop cannot clear a busy row mid-action. It
        // cannot strand `read: false` either: the refresh that made this one stale is the
        // one that resolves the loading state.
        if (request !== epoch) return
        if (cleared) redoCleared = true
        // Carry the failure markers through: a hint must survive the poll
        // (auto-clears on its own timer) rather than vanish a second later. The skill
        // capability rides the same way: a failed poll must not change the prompt shape.
        // The persist failure rides it too — only the host may retract it (a write that
        // worked), and a poll that never reached the host knows nothing about the disk.
        // The in-flight busy set rides it as well, and for the same reason: a keep or a
        // revert holds its id across its await (see `withBusy`), the poll is a second
        // slower than a slow action, and publishing an empty set here re-enabled the row
        // mid-flight — so a second click on it fired a second keep/revert for the entry
        // that was already being acted on. Nothing is lost by carrying it: an action
        // clears its own id when it finishes (success or failure), which is the only
        // thing that ever removes one.
        publish({
          read: true, files, comments, commentLines, commentsRevision, commentAnswers,
          workspacePath, commentSkill, persistError, commentPersistError, busy: snapshot.busy, failed: failedOf(snapshot),
        })
      } catch (error: unknown) {
        // A failure is dropped for the same reason a success is: a read that was already
        // superseded knows nothing about the view the store is on now, and its error would
        // swap the panel to a failure line for a session the reader has left.
        if (request !== epoch) return
        publish({
          read: true,
          files: snapshot.files,
          // A poll that failed still knows the comments it last read: the host owns
          // them, and blanking them here would empty every thread for one bad read.
          comments: snapshot.comments,
          // …and the lines it resolved them to, for the same reason: they are what the list pane
          // and the open cards are drawing right now, and a failed read knows nothing new.
          commentLines: snapshot.commentLines,
          commentsRevision: snapshot.commentsRevision,
          commentAnswers: snapshot.commentAnswers,
          workspacePath: snapshot.workspacePath,
          commentSkill: snapshot.commentSkill,
          persistError: snapshot.persistError,
          commentPersistError: snapshot.commentPersistError,
          error: error instanceof Error ? error.message : String(error),
          busy: snapshot.busy,
          failed: failedOf(snapshot),
        })
      }
    },
    keep(sessionId, id, keepListed) {
      if (keepListed === true) {
        return withKeptEntry(id, () => this.refresh(sessionId), async () => { await port.keep(sessionId, id, true) })
      }
      return withBusy(id, async () => { await port.keep(sessionId, id) })
    },
    revert(sessionId, id, keepListed) {
      if (keepListed === true) {
        return withKeptEntry(id, () => this.refresh(sessionId), async () => { await port.revert(sessionId, id, true) })
      }
      return withBusy(id, async () => { await port.revert(sessionId, id) })
    },
    // A block op keeps the entry: mark the file busy, run the port call, then
    // refresh so the entry's diff updates (the poll alone would lag a second).
    async blockKeep(sessionId, id, block, removeWhenResolved) {
      const { error: _cleared, ...base } = snapshot
      publish({ ...base, busy: new Set([...snapshot.busy, id]) })
      try {
        if (removeWhenResolved === undefined) await port.blockKeep(sessionId, id, block)
        else await port.blockKeep(sessionId, id, block, removeWhenResolved)
      } catch (error: unknown) {
        markFailed(id, error instanceof Error ? error.message : String(error))
        publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
        return
      }
      clearFailed(id)
      clearBusy(id)
      await this.refresh(sessionId)
    },
    async blockRevert(sessionId, id, block, removeWhenResolved) {
      const { error: _cleared, ...base } = snapshot
      publish({ ...base, busy: new Set([...snapshot.busy, id]) })
      try {
        if (removeWhenResolved === undefined) await port.blockRevert(sessionId, id, block)
        else await port.blockRevert(sessionId, id, block, removeWhenResolved)
      } catch (error: unknown) {
        markFailed(id, error instanceof Error ? error.message : String(error))
        publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
        return
      }
      clearFailed(id)
      clearBusy(id)
      await this.refresh(sessionId)
    },
    // Undo/redo restores a pending entry (undo) or removes one (redo); only an
    // id that is still pending after the refresh is worth selecting, so the
    // caller can switch to it. A refusal (the divergence guard, a lost file) is
    // PUBLISHED: the host answered with its reason, and the reader who pressed
    // Ctrl+Z has to be told, or the key press does nothing at all.
    async undo(sessionId) {
      return runHistory('undo', sessionId, (id) => this.refresh(id))
    },
    async redo(sessionId) {
      return runHistory('redo', sessionId, (id) => this.refresh(id))
    },
    async importVcs(sessionId, includeUntracked) {
      const value = await port.importVcs(sessionId, includeUntracked)
      await this.refresh(sessionId)
      return value
    },
    // A refresh replaces the entry's tracked diff in place, so the entry is
    // marked busy, the host call runs, and the list is re-read. A scan that found
    // nothing leaves the entry untouched (the panel reports the outcome).
    async refreshVcs(sessionId, id, includeUntracked) {
      const { error: _cleared, ...base } = snapshot
      publish({ ...base, busy: new Set([...snapshot.busy, id]) })
      try {
        const value = await port.refreshVcs(sessionId, id, includeUntracked)
        await this.refresh(sessionId)
        return value
      } finally {
        publish({ ...snapshot, busy: new Set([...snapshot.busy].filter(busy => busy !== id)) })
      }
    },
    // The add dialog's directory listing is a plain read: no busy marker (no
    // entry is involved) and no refresh (the list did not change).
    browse(sessionId, path) {
      return port.browse(sessionId, path)
    },
    // An add lands new entries (a directory can land many), so the list is
    // re-read afterwards; the panel reports what the scan did.
    async addPath(sessionId, path, includeUnchanged, exact) {
      const value = await port.addPath(sessionId, path, includeUnchanged, exact)
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
    async previewImage(sessionId, path) {
      try {
        const value = await port.previewImage(sessionId, path)
        return value.dataUri
      } catch {
        return undefined
      }
    },
    async keepAll(sessionId) {
      await port.keepAll(sessionId)
      await this.refresh(sessionId)
    },
    async revertAll(sessionId) {
      await port.revertAll(sessionId)
      await this.refresh(sessionId)
    },
    // A comment write is the host's from the moment it lands, so the panel re-reads
    // rather than keeping a local copy: that is what makes a second client of the same
    // session show the same thread.
    async commentAdd(sessionId, comment) {
      const value = await port.commentAdd(sessionId, comment)
      await this.refresh(sessionId)
      return value
    },
    async commentRemove(sessionId, id) {
      const value = await port.commentRemove(sessionId, id)
      await this.refresh(sessionId)
      return value
    },
    async commentAsk(sessionId, id, prompt, text) {
      const value = await port.commentAsk(sessionId, id, prompt, text)
      await this.refresh(sessionId)
      return value
    },
    reset() {
      // A reset leaves nothing in flight worth landing: bump the epoch so a read from the
      // connection that just died cannot republish its session over the dropped state.
      epoch += 1
      publish({
        read: false,
        files: [],
        comments: NO_COMMENTS as CommentRecord[],
        commentLines: NO_COMMENT_LINES,
        commentsRevision: 0,
        commentAnswers: NO_ANSWERS as Record<string, string>,
        busy: EMPTY_BUSY,
      })
    },
    clearRedoCleared() {
      redoCleared = false
      const { redoCleared: _omit, ...rest } = snapshot
      publish(rest)
    },
    clearUndoNotice() {
      publishUndoNotice(undefined)
    },
  }
}
