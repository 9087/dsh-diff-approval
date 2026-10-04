/**
 * Pending-diff observable store: the page's one reading of the host's pending
 * list. Refreshed on panel open, on an interval while the panel stays open,
 * and after each action; a successful action also removes its path locally so
 * the row leaves without waiting for the next poll.
 * @module dsh-diff-approval/client/store
 */

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommentRecord, DiffApprovalAddValue, DiffApprovalBlockRange, DiffApprovalBrowseValue, DiffApprovalCommentAddValue, DiffApprovalCommentAskValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue, DiffApprovalOpenAction, DiffApprovalRefreshValue, VcsImportValue } from '../types.ts'
import type { PendingDiffSnapshot } from './slots.ts'
import type { CommentDraft, DiffApprovalPort } from './port.ts'

/** The observable the panel reads and the plugin body drives. */
export interface PendingDiffStore extends HostObservable<PendingDiffSnapshot> {
  /**
   * One session's own view of the pending list.
   *
   * The page runs several mounts of the panel at once — the footer entry, the Session header entry and
   * the docked tab — and they can be about DIFFERENT sessions (the reader is in one, while the docked
   * tab was opened from another). One page-wide snapshot made every badge read whichever session's read
   * landed last, which is the cross-talk the reader reported: a badge showing another session's count,
   * and a session with a real list showing zero. So each session's read publishes only into its own
   * slot, and every consumer takes its own slot, by the session it is actually about.
   *
   * A session that has never been read answers an unread empty view — never another session's list.
   * `sessionId === undefined` answers the most recently published view — exactly what
   * {@link PendingDiffStore.getSnapshot} answers — because that is what a caller with no session of its
   * own (a whole-page concern) is asking for.
   * @param sessionId - the session whose view to read.
   * @returns that session's snapshot, identity-stable until it is next published.
   */
  viewFor: (sessionId: SessionId | undefined) => PendingDiffSnapshot
  /**
   * Every session's view this page is HOLDING, one per session it has read.
   *
   * This is the reader a press needs (see `produced-diff.ts`): a shell press names a file and asks whether
   * ANY session this page has read holds it, and the press cannot wait for a poll. The slots are where the
   * fresh paths live — the light read's `paths` and the last full read's `files` — so answering from the
   * slots is what keeps a file edited since the last full read from being a press nothing recognises.
   * @returns the held views; a session never read contributes nothing (it has no slot).
   */
  views: () => readonly PendingDiffSnapshot[]
  /** Re-read one session's pending list (an absent session empties the view). */
  refresh: (sessionId: SessionId | undefined) => Promise<void>
  /**
   * Ask how many rows this session has, THE LIGHT WAY: one number, no file content.
   *
   * This is what a seat polls while it is showing nothing but its badge. It publishes into the same
   * per-session slot as `refresh` — as `count`, never as `files` — so a badge keeps reading the view it
   * already subscribes to, and it deliberately does NOT set `read` (a count is not a list: a session
   * whose list has never been read stays unread, and its list stays empty rather than looking loaded).
   *
   * Failure keeps the LAST GOOD number: a count that failed knows nothing, and showing 0 or a blank
   * badge for a list that may well be full is worse than showing the previous figure. A host that
   * predates the endpoint (`unknown endpoint "list-count"`) is detected here ONCE and then this call
   * degrades to `refresh`, which is exactly the old behaviour at exactly the old cost — one full read
   * per tick — and an absent session has no count to ask for, so it returns without a call.
   */
  refreshCount: (sessionId: SessionId | undefined) => Promise<void>
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
  /**
   * The reader is looking at this file now: its row's unseen dot goes out. Deliberately NOT followed by a
   * re-read — see the note at the implementation.
   */
  markSeen: (sessionId: SessionId, id: string) => Promise<void>
  /** Open one file with its default application or reveal it in the folder. */
  open: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Keep every pending entry of one session in a single host call, then refresh. */
  keepAll: (sessionId: SessionId) => Promise<void>
  /** Revert every pending entry of one session in a single host call, then refresh. */
  revertAll: (sessionId: SessionId) => Promise<void>
  /**
   * Keep a pick of entries, then refresh once. The host makes the whole pick ONE undo step, so this is
   * one action to the reader in every sense: one request, one read back, one Ctrl+Z.
   */
  keepMany: (sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined) => Promise<void>
  /**
   * Revert a pick of entries, then refresh once. Its undo restores what the host could snapshot: a file
   * the agent created is DELETED with no undo at all, so the panel asks before a pick that would do it.
   */
  revertMany: (sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined) => Promise<void>
  /** Inline one workspace image as a base64 data URI (empty when unreadable). */
  previewImage: (sessionId: SessionId, path: string) => Promise<string | undefined>
  /**
   * Write one annotation down, then refresh so the thread appears from the host's own
   * copy (the panel keeps no thread state of its own).
   */
  commentAdd: (sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>
  /** Drop one annotation, then refresh. */
  commentRemove: (sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>
  /**
   * Drop several annotations in ONE host call, then refresh once.
   *
   * One refresh is the difference a batch makes here: a loop of `commentRemove` re-reads (and
   * re-renders) the whole session between every comment, so the list visibly dismantles itself one
   * item at a time while the reader asked for one action.
   */
  commentRemoveMany: (sessionId: SessionId, ids: readonly string[]) => Promise<DiffApprovalCommentRemoveManyValue>
  /** Ask one stored comment as its own turn, then refresh (the answer is derived on read). */
  commentAsk: (sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>
  /** The reader is looking at a comment: its card's dot goes out, then the list is re-read. */
  commentSeen: (sessionId: SessionId, id: string) => Promise<void>
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

/** A fresh, never-read view: what a session with nothing published yet answers (and what `reset` leaves). */
function emptyView(): PendingDiffSnapshot {
  return {
    read: false,
    files: [],
    comments: NO_COMMENTS as CommentRecord[],
    commentLines: NO_COMMENT_LINES,
    commentsRevision: 0,
    commentAnswers: NO_ANSWERS as Record<string, string>,
    busy: EMPTY_BUSY,
  }
}

/**
 * One view with the redo-cleared latch taken off it, for the acknowledgement.
 * @param view - the view to strip.
 * @returns the same view without `redoCleared` (identity-stable when it never had it).
 */
function stripRedoCleared(view: PendingDiffSnapshot): PendingDiffSnapshot {
  if (view.redoCleared !== true) return view
  const { redoCleared: _omit, ...rest } = view
  return rest
}

/**
 * One session's slot: its published view, and the read it is currently waiting on.
 *
 * The epoch is PER SESSION. That is the point of the whole arrangement: two seats polling two
 * sessions are not competing reads of one view, so neither can supersede the other and the drop
 * rule below only ever drops an older answer to the SAME session's question.
 */
interface SessionView {
  /** The session's own published snapshot; identity-stable until it is next published. */
  view: PendingDiffSnapshot
  /** Bumped by every read of this session; an answer whose epoch has moved on is stale. */
  epoch: number
  /**
   * The read this session is waiting on right now, or `undefined` when none is running.
   *
   * The poll is a one-second interval and a read on a slow link outlasts several of them, so without this
   * the ticks STACK: each one starts another request, the transport never drains, and the reader queues
   * behind their own polls asking the same question — which is what made the count badge take tens of
   * seconds to appear after a page load. A tick that arrives while a read is in flight does not start one.
   */
  inFlight?: Promise<void> | undefined
  /** Set by a tick that arrived during a read, so exactly one trailing read runs when it settles. */
  queued?: boolean | undefined
  /**
   * Bumped by every COUNT read of this session; a count answer whose epoch has moved on is stale.
   *
   * Separate from `epoch` on purpose: the two reads are independent questions about the same session, and
   * sharing one counter would make a count tick drop a list read that is still in flight (and vice versa).
   */
  countEpoch: number
  /** The count read this session is waiting on, with the same folding rule as `inFlight`. */
  countInFlight?: Promise<void> | undefined
  /** Set by a count tick that arrived during a count read, so exactly one trailing count read runs. */
  countQueued?: boolean | undefined
}

/**
 * Create the store over the review-channel port.
 * @param port - the typed channel port.
 * @returns the observable store.
 */
export function createPendingDiffStore(port: DiffApprovalPort): PendingDiffStore {
  /**
   * The page-wide view published WITHOUT a session (`refresh(undefined)`, a page-wide failure marker or
   * notice), and the answer for the whole-page readers only while nothing has been pointed at yet. The
   * moment a session is read it becomes `pointed` and this is no longer what a page-wide read answers —
   * see `newestView`, which is the one place the two are resolved. It is NOT the shared state two
   * sessions used to fight over: every session keeps its own slot in `views` below.
   */
  let snapshot: PendingDiffSnapshot = emptyView()
  /** One slot per session, created on that session's first read. */
  const views = new Map<SessionId, SessionView>()
  /**
   * The session the whole-page readers are pointed at: the newest session to be read or acted on.
   *
   * {@link PendingDiffStore.getSnapshot} and `viewFor(undefined)` answer this session's view — the two
   * spellings are ONE answer (see `newestView`). That is the honest reading for a caller with no session
   * of its own — the produced-file chip's "is this file pending", the reference remap's "what does this
   * session's draft refer to", a seat whose shell names no session — and it is the OLD page-wide
   * behaviour, now scoped: the session's own slot follows the reads that name it, and no other session's
   * read can move it. A seat that knows its session must use `viewFor(sessionId)` instead of relying on
   * this.
   */
  let pointed: SessionId | undefined
  const listeners = new Set<() => void>()
  // Latched until the panel acknowledges it: a detected external change that
  // superseded the redo history must surface even when the panel is closed.
  let redoCleared = false
  /**
   * Set when this host answered the light count with `unknown endpoint "list-count"`.
   *
   * That is what a host built before the endpoint says, and it is a fact about the HOST, not about one
   * session or one tick: once seen, every later count tick goes straight to `refresh` instead of paying a
   * doomed round trip first. The fallback is therefore exactly the read a page had before the count
   * existed, at exactly its cost. Cleared by `reset`, because a reconnection may reach a host that HAS the
   * endpoint (an upgraded process), and the cost of being wrong is one wasted request rather than a badge
   * that stops using the light read for the rest of the page's life.
   */
  let countUnsupported = false

  const failedOf = (value: PendingDiffSnapshot): ReadonlyMap<string, string> => value.failed ?? EMPTY_FAILED

  /** The slot for one session, created (unread, unrelated to any other session) on first use. */
  const slotOf = (sessionId: SessionId): SessionView => {
    const existing = views.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionView = { view: emptyView(), epoch: 0, countEpoch: 0 }
    views.set(sessionId, created)
    return created
  }

  /**
   * Publish one session's new view: only that session's slot changes, and only the readers of that
   * session see a different list. Every listener is still told, because a listener is a React
   * subscription that has to re-read its OWN slot to notice, and it cannot know which slot moved.
   * @param sessionId - the session the view belongs to (`undefined`: the page-wide reader only).
   * @param next - the session's new snapshot.
   * @param keepError - carry the session's current error through, which is what a publish that knows
   *   nothing about the last read has to do (a busy mark, a notice, a failure marker). A publish that
   *   DID read the host — a success — leaves this false, so the previous failure is retracted: only a
   *   successful read may say the list is readable again, exactly as only the host may retract a
   *   persist failure. A failure publish carries its own `error` in `next` and passes false too, so it
   *   replaces the message rather than being overwritten by the old one.
   */
  const publishView = (sessionId: SessionId | undefined, next: PendingDiffSnapshot, keepError = false): void => {
    // A publish that did not read the host carries the session's current error through; one that did
    // leaves `next`'s own answer — its message on a failure, and NOTHING on a success, because an absent
    // `error` is the only way to say the list is readable again.
    const alive = viewOf(sessionId)
    const merged = keepError
      ? { ...next, ...(alive.error === undefined ? {} : { error: alive.error }) }
      : next
    const result = redoCleared ? { ...merged, redoCleared: true } : merged
    if (sessionId === undefined) snapshot = result
    else slotOf(sessionId).view = result
    // WAKE EVERY SUBSCRIBER, whichever slot moved.
    //
    // Telling every listener (below) is only half of it: a React seat subscribes through
    // `getSnapshot()`, and `useSyncExternalStore` re-renders only when that value changes IDENTITY. So a
    // publish that left `getSnapshot()`'s own object alone notified listeners that then compared two equal
    // objects and drew nothing — which is how a shut panel asked the host for a count, received it, and
    // kept showing 0, and how a badge for one session could sit frozen while another session's slot moved.
    // The fix is to re-stamp whatever `getSnapshot()` ANSWERS with a copy: the object's contents — and so
    // its answer — are untouched, and every listener is handed a new identity and re-reads its own slot
    // the way `useSessionView` says it does.
    //
    // Only when this publish did not already replace that object: `snapshot` when nothing is pointed at,
    // the pointed session's view otherwise.
    if (pointed === undefined) {
      if (sessionId !== undefined) snapshot = { ...snapshot }
    } else if (sessionId !== pointed) {
      slotOf(pointed).view = { ...slotOf(pointed).view }
    }
    for (const listener of [...listeners]) listener()
  }

  /**
   * The page-wide answer: the newest published view, for the readers with no session of their own.
   *
   * This is the ONE spelling of "no session of mine": `getSnapshot` and `viewFor(undefined)` both resolve
   * here, so the two can never disagree — and neither is a slot that a session read never writes, which
   * is what made a seat with no `sessionId` render a permanently empty badge. Before any session has
   * been read it is the unread empty view, so nothing is invented for a page that has read nothing.
   */
  const newestView = (): PendingDiffSnapshot => pointed === undefined ? snapshot : slotOf(pointed).view

  /** The view one action should act on: the session's own slot, or the page-wide newest view. */
  const viewOf = (sessionId: SessionId | undefined): PendingDiffSnapshot =>
    sessionId === undefined ? newestView() : slotOf(sessionId).view

  /** Record one entry's failed keep/revert with its message; auto-clears after a few seconds. */
  const markFailed = (sessionId: SessionId | undefined, id: string, message: string): void => {
    const before = viewOf(sessionId)
    publishView(sessionId, { ...before, failed: new Map([...failedOf(before), [id, message]]) }, true)
    window.setTimeout(() => {
      // Re-check at fire time: the marker may have been cleared or replaced.
      const now = viewOf(sessionId)
      if (failedOf(now).get(id) !== message) return
      const next = new Map(failedOf(now))
      next.delete(id)
      publishView(sessionId, { ...now, failed: next }, true)
    }, FAILED_HINT_MS)
  }

  /** Drop one entry's failure marker after a successful retry. */
  const clearFailed = (sessionId: SessionId | undefined, id: string): void => {
    const before = viewOf(sessionId)
    if (!failedOf(before).has(id)) return
    const next = new Map(failedOf(before))
    next.delete(id)
    publishView(sessionId, { ...before, failed: next }, true)
  }

  /**
   * Clear one entry's busy mark, now that its action is done.
   *
   * A completed action clears its OWN id — that is the only thing that ever removes one, and it
   * has to be said out loud here rather than left to a poll: the poll now CARRIES the in-flight
   * set through instead of publishing an empty one (see `refresh`), so an action that finished
   * and only then re-read the list would leave its row disabled for good.
   * @param sessionId - the session whose view the action belongs to.
   * @param id - the entry the action was about.
   */
  const clearBusy = (sessionId: SessionId | undefined, id: string): void => {
    const before = viewOf(sessionId)
    if (!before.busy.has(id)) return
    publishView(sessionId, { ...before, busy: new Set([...before.busy].filter(busy => busy !== id)) }, true)
  }

  const withBusy = async (sessionId: SessionId | undefined, id: string, action: () => Promise<void>): Promise<void> => {
    const before = viewOf(sessionId)
    const { error: _cleared, ...base } = before
    publishView(sessionId, { ...base, failed: failedOf(before), busy: new Set([...before.busy, id]) }, true)
    try {
      await action()
    } catch (error: unknown) {
      // A failed decision keeps the entry and surfaces inline; it must not
      // swap the whole panel to the error screen.
      markFailed(sessionId, id, error instanceof Error ? error.message : String(error))
      const live = viewOf(sessionId)
      publishView(sessionId, {
        ...live,
        busy: new Set([...live.busy].filter(busy => busy !== id)),
      }, true)
      return
    }
    clearFailed(sessionId, id)
    const live = viewOf(sessionId)
    publishView(sessionId, {
      ...live,
      files: live.files.filter(file => file.id !== id),
      busy: new Set([...live.busy].filter(busy => busy !== id)),
    }, true)
  }

  /**
   * Run a whole-file action whose entry STAYS listed (the panel chose "keep in
   * list"). The local list must not drop it optimistically — that made a kept
   * file blink out and come back on the next poll — so this takes the block
   * actions' shape instead: mark busy, run, then re-read so the entry's now-empty
   * diff shows at once.
   * @param sessionId - the session whose view the action belongs to.
   * @param id - the entry being acted on.
   * @param refresh - the store's refresh, awaited after a successful action.
   * @param action - the port call to run.
   */
  const withKeptEntry = async (sessionId: SessionId, id: string, refresh: () => Promise<void>, action: () => Promise<void>): Promise<void> => {
    const before = viewOf(sessionId)
    const { error: _cleared, ...base } = before
    publishView(sessionId, { ...base, failed: failedOf(before), busy: new Set([...before.busy, id]) }, true)
    try {
      await action()
    } catch (error: unknown) {
      markFailed(sessionId, id, error instanceof Error ? error.message : String(error))
      const live = viewOf(sessionId)
      publishView(sessionId, { ...live, busy: new Set([...live.busy].filter(busy => busy !== id)) }, true)
      return
    }
    clearFailed(sessionId, id)
    clearBusy(sessionId, id)
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
   * @param sessionId - the session whose view the notice belongs to.
   * @param message - what to say, or undefined to retract.
   */
  const publishUndoNotice = (sessionId: SessionId | undefined, message: string | undefined): void => {
    const before = viewOf(sessionId)
    if (before.undoNotice === message) return
    publishView(sessionId, { ...before, undoNotice: message }, true)
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
      publishUndoNotice(sessionId, undefined)
      await refresh(sessionId)
      const id = value.id
      // Is the entry still pending in THIS session's view? The reader's view is the session's own slot,
      // never whatever another seat's read last left in the page-wide snapshot.
      return id !== undefined && viewOf(sessionId).files.some(file => file.id === id) ? id : undefined
    } catch (error: unknown) {
      publishUndoNotice(sessionId, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  const store: PendingDiffStore = {
    getSnapshot: () => viewOf(pointed),
    viewFor: (sessionId) => viewOf(sessionId),
    // One view per session this page has read, in the order the slots were first created. The page-wide
    // `snapshot` is not among them when a session is pointed at (that IS one of these slots); before
    // anything is pointed at it is the unread empty view, which holds no path either way.
    views: () => [...views.values()].map(slot => slot.view),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async refresh(sessionId) {
      // The whole-page readers follow the newest session asked about (see `pointed`).
      pointed = sessionId
      // An absent session has no list to read: its own view is emptied, and no other session's view is
      // touched (the page-wide reader is the only one that follows this slot).
      if (sessionId === undefined) {
        publishView(undefined, { ...emptyView(), read: true, failed: failedOf(snapshot) })
        return
      }
      const slot = slotOf(sessionId)
      // AT MOST ONE READ IN FLIGHT for this session (see `SessionView.inFlight`). A tick that arrives while
      // one is running does not start a second request — that is what let the queue grow without bound on a
      // slow link — it records that a fresher answer is wanted and hands back the read already running.
      if (slot.inFlight !== undefined) {
        slot.queued = true
        return slot.inFlight
      }
      let release!: () => void
      slot.inFlight = new Promise<void>(resolve => { release = resolve })
      // Runs on EVERY way out of the read below, the two stale exits included, so the guard can never be
      // left latched and strand the session with no further reads. A tick folded into this read starts
      // exactly one more when it settles: the read in flight may predate an action (keep, revert, comment)
      // and can only publish the state that came before it, so dropping that tick outright would leave the
      // action invisible until the next interval.
      const finish = (): void => {
        slot.inFlight = undefined
        release()
        if (slot.queued === true) {
          slot.queued = undefined
          void store.refresh(sessionId)
        }
      }
      // Bumped BEFORE the await: an answer whose epoch has moved on is stale. With one read per session at
      // a time, the only thing that can move it now is `reset`, which is exactly when a landing read must
      // not republish over the dropped state.
      const request = ++slot.epoch
      try {
        const {
          files, comments, commentLines, commentsRevision, commentAnswers,
          workspacePath, redoCleared: cleared, commentSkill, persistError, commentPersistError,
        } = await port.list(sessionId)
        // A newer read of this session has already answered, so this one is stale (the next poll) and is
        // dropped WHOLE: neither its files/comments nor its redoCleared latch are published, and its busy
        // and failed bookkeeping is left exactly as the session's live view has it — the newer response
        // carries both through, so a drop cannot clear a busy row mid-action. It cannot strand
        // `read: false` either: the refresh that made this one stale is the one that resolves it.
        if (request !== slot.epoch) { finish(); return }
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
        publishView(sessionId, {
          read: true, files, comments, commentLines, commentsRevision, commentAnswers,
          workspacePath, commentSkill, persistError, commentPersistError,
          // The session's OWN live bookkeeping, not the page-wide reader's: the busy and failed sets are
          // this view's, and a poll for B carrying A's would re-enable or flag A's rows.
          busy: slot.view.busy, failed: failedOf(slot.view),
        })
      } catch (error: unknown) {
        // A read that failed knows nothing new, so it must NOT blank the session's list: the reader is
        // shown the files, comments and lines this session already had, plus the reason. Only the error
        // field changes. A stale failure is still dropped whole — it is about a question this session has
        // already answered.
        if (request !== slot.epoch) { finish(); return }
        const live = slot.view
        publishView(sessionId, {
          ...live,
          read: true,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // The read is over, whichever branch it took: let the next tick start one, and run the single
      // trailing read if any tick was folded into this one.
      finish()
    },
    async refreshCount(sessionId) {
      // No session, no count to ask about: the page-wide readers follow whichever session was last read,
      // and there is nothing here to name. (A count is not a list, so it never publishes an empty view the
      // way `refresh(undefined)` does.)
      if (sessionId === undefined) return
      // NOTE, because it was tried and reverted: a count read must NOT point the whole-page readers at its
      // session. Doing that made a tick for session A move the page-wide answer away from session B while
      // B's own panel was on screen, so the same press worked one second and not the next. What a count
      // read owes its subscribers instead is the wake in `publishView` — a new identity on the object
      // `getSnapshot()` answers, whatever it answers — and it gives that from any slot.
      const slot = slotOf(sessionId)
      // AT MOST ONE COUNT IN FLIGHT, folded exactly like the full read (see `SessionView.inFlight`): a tick
      // that lands during a count records that a fresher number is wanted and hands back the one running.
      if (slot.countInFlight !== undefined) {
        slot.countQueued = true
        return slot.countInFlight
      }
      // A host that has already told us it has no such endpoint: do the read it DOES have rather than
      // paying for a doomed request first. `refresh` has its own per-session guard, so several ticks
      // arriving here fold into one full read.
      if (countUnsupported) {
        await store.refresh(sessionId)
        return
      }
      let release!: () => void
      slot.countInFlight = new Promise<void>(resolve => { release = resolve })
      // Runs on every way out, the stale exits included, so the guard can never latch and strand the badge.
      const finish = (): void => {
        slot.countInFlight = undefined
        release()
        if (slot.countQueued === true) {
          slot.countQueued = undefined
          void store.refreshCount(sessionId)
        }
      }
      const request = ++slot.countEpoch
      try {
        const { count } = await port.listCount(sessionId)
        if (request !== slot.countEpoch) { finish(); return }
        // The number rides the session's OWN view, so every badge subscribed to that slot re-renders and no
        // other session's view moves. `read` is deliberately left as it was: a count is not a list, and a
        // session whose list was never read must not look like one that was.
        publishView(sessionId, { ...slot.view, count })
      } catch (error: unknown) {
        if (request !== slot.countEpoch) { finish(); return }
        // A count that failed knows nothing, so the last good number stays — never 0, never blank, which
        // is what a badge that blanked on one flaky tick would show. The one failure that is not a
        // failure of the question is an OLD HOST: it has no endpoint to answer, so from here on the tick
        // does the full read instead (today's behaviour, today's cost) and this stays latched.
        if ((error instanceof Error ? error.message : String(error)).includes('unknown endpoint')) {
          countUnsupported = true
          await store.refresh(sessionId)
        }
      }
      finish()
    },
    keep(sessionId, id, keepListed) {
      if (keepListed === true) {
        return withKeptEntry(sessionId, id, () => this.refresh(sessionId), async () => { await port.keep(sessionId, id, true) })
      }
      return withBusy(sessionId, id, async () => { await port.keep(sessionId, id) })
    },
    revert(sessionId, id, keepListed) {
      if (keepListed === true) {
        return withKeptEntry(sessionId, id, () => this.refresh(sessionId), async () => { await port.revert(sessionId, id, true) })
      }
      return withBusy(sessionId, id, async () => { await port.revert(sessionId, id) })
    },
    // A block op keeps the entry: mark the file busy, run the port call, then
    // refresh so the entry's diff updates (the poll alone would lag a second).
    async blockKeep(sessionId, id, block, removeWhenResolved) {
      const before = viewOf(sessionId)
      const { error: _cleared, ...base } = before
      publishView(sessionId, { ...base, busy: new Set([...before.busy, id]) }, true)
      try {
        if (removeWhenResolved === undefined) await port.blockKeep(sessionId, id, block)
        else await port.blockKeep(sessionId, id, block, removeWhenResolved)
      } catch (error: unknown) {
        markFailed(sessionId, id, error instanceof Error ? error.message : String(error))
        const live = viewOf(sessionId)
        publishView(sessionId, { ...live, busy: new Set([...live.busy].filter(busy => busy !== id)) }, true)
        return
      }
      clearFailed(sessionId, id)
      clearBusy(sessionId, id)
      await this.refresh(sessionId)
    },
    async blockRevert(sessionId, id, block, removeWhenResolved) {
      const before = viewOf(sessionId)
      const { error: _cleared, ...base } = before
      publishView(sessionId, { ...base, busy: new Set([...before.busy, id]) }, true)
      try {
        if (removeWhenResolved === undefined) await port.blockRevert(sessionId, id, block)
        else await port.blockRevert(sessionId, id, block, removeWhenResolved)
      } catch (error: unknown) {
        markFailed(sessionId, id, error instanceof Error ? error.message : String(error))
        const live = viewOf(sessionId)
        publishView(sessionId, { ...live, busy: new Set([...live.busy].filter(busy => busy !== id)) })
        return
      }
      clearFailed(sessionId, id)
      clearBusy(sessionId, id)
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
      const before = viewOf(sessionId)
      const { error: _cleared, ...base } = before
      publishView(sessionId, { ...base, busy: new Set([...before.busy, id]) }, true)
      try {
        const value = await port.refreshVcs(sessionId, id, includeUntracked)
        await this.refresh(sessionId)
        return value
      } finally {
        const live = viewOf(sessionId)
        publishView(sessionId, { ...live, busy: new Set([...live.busy].filter(busy => busy !== id)) }, true)
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
    // The reader has this file in front of them: the host takes the row's dot down. Deliberately NOT
    // followed by a re-read, unlike `addPath` — there is nothing to learn. A file on screen wears no dot
    // anyway (the row draws it only when it is not the selected one), and the next poll carries the
    // cleared flag for the list the reader goes back to. The re-read that used to be here was a refresh
    // per report: it published a NEW `files` array, which re-armed the panel's "the shown row is still
    // unseen" effect, which reported the same path again — a list read, a render and a fresh report as
    // fast as the host could answer. Nothing depended on it, and a mark the host did not take is simply
    // reported again on the next publish, because the flag is still true.
    async markSeen(sessionId, id) {
      await port.markSeen(sessionId, id)
    },
    async open(sessionId, id, action) {
      try {
        await port.open(sessionId, id, action)
      } catch (error: unknown) {
        // The failure belongs to the session that asked, so it lands on that session's view alone.
        const live = viewOf(sessionId)
        publishView(sessionId, {
          ...live,
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
    async keepMany(sessionId, ids, keepListed) {
      await port.keepMany(sessionId, ids, keepListed)
      await this.refresh(sessionId)
    },
    async revertMany(sessionId, ids, keepListed) {
      await port.revertMany(sessionId, ids, keepListed)
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
    async commentRemoveMany(sessionId, ids) {
      const value = await port.commentRemoveMany(sessionId, ids)
      await this.refresh(sessionId)
      return value
    },
    async commentAsk(sessionId, id, prompt, text) {
      const value = await port.commentAsk(sessionId, id, prompt, text)
      await this.refresh(sessionId)
      return value
    },
    // The reader has this card in front of them: the host takes the dot down, and the list is re-read
    // so the card comes back without it. Unlike the file row, whose dot a selected row does not draw at
    // all, a card's dot is drawn from the snapshot and has no local hiding, so the read is what takes it
    // off the screen — and it is safe here: a card reports its one look once (see `useSeenOnView`).
    async commentSeen(sessionId, id) {
      await port.commentSeen(sessionId, id)
      await this.refresh(sessionId)
    },
    reset() {
      // A reset leaves nothing in flight worth landing: every session's epoch is bumped so a read from
      // the connection that just died cannot republish its session over the dropped state, and every
      // slot — the page-wide reader included — goes back to an unread empty view.
      for (const slot of views.values()) {
        // Bump past any read still in flight, and forget a folded tick: a read that lands after this must
        // not republish, and a read this slot asked for on its own must not run against a dead connection.
        slot.epoch += 1
        slot.queued = undefined
        // The count read is its own question with its own guard, so it is dropped the same way.
        slot.countEpoch += 1
        slot.countQueued = undefined
        slot.view = emptyView()
      }
      snapshot = emptyView()
      pointed = undefined
      // A reconnection may reach a host that HAS the light endpoint (an upgraded process), so the old
      // host's verdict is not carried across the connection that made it.
      countUnsupported = false
      for (const listener of [...listeners]) listener()
    },
    clearRedoCleared() {
      redoCleared = false
      // The latch is page-wide (a write to disk is a fact about this browser, not about one session),
      // so it comes off every view that carries it.
      snapshot = stripRedoCleared(snapshot)
      for (const slot of views.values()) slot.view = stripRedoCleared(slot.view)
      for (const listener of [...listeners]) listener()
    },
    clearUndoNotice() {
      publishUndoNotice(undefined, undefined)
    },
  }
  return store
}
