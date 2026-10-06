/**
 * Where the review panel was left, and what the reader has typed but not sent, for
 * this page's lifetime.
 *
 * Closing the panel is not "done reviewing": reopening it should put the reader
 * back on the file they were in, at the offset they were at. That is a fact about
 * this visit rather than a stored preference, so it lives in module state — which
 * also gives the two mounts that show the panel (the floating overlay and the
 * docked tab) one shared memory, so switching presentation does not lose the
 * place, and a reload starts clean.
 *
 * Keyed by session: two sessions have their own pending lists, and one session's
 * panel must not resume another's file.
 *
 * @module dsh-diff-approval/client/panel-memory
 */

import type { Discussion, DiscussionQuoteLine } from './discussion.ts'

/** One session's remembered view: its last file, and how far down each file was. */
interface SessionView {
  /** The pending entry that was open when this session's panel last closed. */
  last?: string | undefined
  /** Entry id -> the code view's `scrollTop` when that file was last left. */
  offsets: Map<string, number>
}

const views = new Map<string, SessionView>()

/**
 * What the panel keeps about one thread that is NOT the host's to keep: what the reader is
 * typing, whether the block is folded, and the body height the panel last measured for it.
 *
 * A thread itself is the host's record now (see `pending.comments`), so nothing here may
 * hold a turn: the panel renders the snapshot, and this only remembers the page-local
 * presentation of it. That split is what makes a poll harmless — a poll replaces the
 * snapshot, and a draft typed a moment ago is not in it, so keeping the draft here is what
 * stops the poll from clearing the field under the reader's hands.
 */
export interface ThreadLocal {
  /** What the reader has typed into the compose row (not sent yet). */
  draft: string
  /** Folded to the one-row header. */
  collapsed: boolean
  /**
   * The last send of this thread was refused (no live agent, or the ask itself failed). It is a
   * page-local fact because nothing was stored: the host has no question to record, so the block
   * could only say so from here. Cleared by the next send.
   */
  failed?: boolean | undefined
  /**
   * How many rows the block's body was last measured to occupy, or absent before the first
   * measurement. The reservation follows the drawing rather than the other way round (see
   * the panel's read-back), and it is kept here so a mount that comes back draws the thread
   * at the size it was already measured at instead of reserving the model's estimate again.
   */
  bodyRows?: number | undefined
}

/** Nothing is known about a thread until the reader types or folds it. */
const NO_THREAD_STATE: Readonly<Record<string, ThreadLocal>> = {}

/**
 * One session's page-local thread state, by comment id.
 *
 * Written on every change and read back by a mount that appears later (the other
 * presentation, or the panel reopened), so a draft survives both a poll and a remount.
 * The record is republished only when it actually changes, so a mount that reads it back
 * keeps the identity it adopted and does not re-adopt an equal object on every render.
 */
const localThreads = new Map<string, Readonly<Record<string, ThreadLocal>>>()

/**
 * The page-local thread state a session's panel is holding.
 * @param sessionId - the session, if any.
 * @returns the state by comment id; empty when there is none.
 */
export function rememberedThreads(sessionId: string | undefined): Readonly<Record<string, ThreadLocal>> {
  return sessionId === undefined ? NO_THREAD_STATE : localThreads.get(sessionId) ?? NO_THREAD_STATE
}

/**
 * Remember one session's page-local thread state. Called on every change, so a mount that
 * appears later starts from it.
 * @param sessionId - the session the panel is reviewing; nothing is recorded without one.
 * @param threads - the state by comment id.
 */
export function rememberThreads(
  sessionId: string | undefined,
  threads: Readonly<Record<string, ThreadLocal>>,
): void {
  if (sessionId === undefined) return
  // The same object back is not a change: republishing it would only hand every reader a new
  // record to adopt for nothing (and the panel writes this on every render that measures).
  if (localThreads.get(sessionId) === threads) return
  localThreads.set(sessionId, threads)
}

/**
 * A block the reader has PLACED on a file's lines but has not written down yet.
 *
 * It has no host record (see `sendDiscussion`), so nothing else on this page holds it: without this
 * the reader's complaint was right — placing a comment, typing a first thought and closing the panel
 * threw the whole block away, because only the words were remembered and a comment id to hang them
 * under does not exist until the block is sent. Everything a mount needs to draw the block again is
 * here: the entry it was placed on, the lines, the quote it was placed against, and the words.
 */
export interface PlacedThread {
  /**
   * The block's page-local id, minted when it was placed. The comment's own id is minted when the
   * block is written (see `sendDiscussion`), and this is only ever the name of an unsent block.
   */
  id: string
  /** The pending entry whose rows it was placed on. */
  fileId: string
  /**
   * The rows it was made on, plus the new-file lines that survive a rebuild. The lines are what a
   * mount re-anchors from (see `remapDiscussions`); the row indices are the placement's own hint,
   * stale the moment the model moves.
   */
  anchor: Discussion['anchor']
  /** The anchored lines as they read when it was placed (the re-anchor fingerprint). */
  quote: string
  /** `quote` with one line of context on each side, as it read then. */
  quoteContext?: string | undefined
  /** The gutter numbers of `quote`'s lines, in the same order. */
  quoteLines?: readonly DiscussionQuoteLine[] | undefined
  /** What the reader had typed into it. */
  draft: string
}

/** No blocks are placed until the reader places one. */
const NO_PLACED: readonly PlacedThread[] = []

/**
 * One session's placed-but-unsent blocks, oldest placement first.
 *
 * Kept with the rest of the page's memory — a poll cannot disturb it (it is not in the snapshot) and
 * a reload starts clean, which is the lifetime a comment that was never sent is supposed to have.
 */
const placedThreads = new Map<string, readonly PlacedThread[]>()

/**
 * The placed-but-unsent blocks a session's panel is holding.
 * @param sessionId - the session, if any.
 * @returns the blocks, oldest placement first; empty when there are none.
 */
export function rememberedPlacedThreads(sessionId: string | undefined): readonly PlacedThread[] {
  return sessionId === undefined ? NO_PLACED : placedThreads.get(sessionId) ?? NO_PLACED
}

/**
 * Whether two placements say the same thing.
 *
 * The panel republishes this on every render that touches its own state — a keystroke, a fold, the
 * measurement writing a body height down — so an equal-but-new list must be recognised: storing it
 * would hand every reader of this memory a new array to adopt for no change at all, which is exactly
 * what the identity discipline above exists to prevent.
 *
 * @param a - the placements held now.
 * @param b - the placements the panel just built.
 * @returns true when they are the same placements with the same words.
 */
function samePlaced(a: readonly PlacedThread[], b: readonly PlacedThread[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!
    const right = b[index]!
    if (left.id !== right.id || left.fileId !== right.fileId || left.draft !== right.draft) return false
    if (left.anchor.start !== right.anchor.start || left.anchor.end !== right.anchor.end) return false
    if (left.anchor.startLine !== right.anchor.startLine || left.anchor.endLine !== right.anchor.endLine) return false
    if (left.quote !== right.quote || left.quoteContext !== right.quoteContext) return false
    if (left.quoteLines?.length !== right.quoteLines?.length) return false
    if (left.quoteLines !== undefined && right.quoteLines !== undefined) {
      for (let line = 0; line < left.quoteLines.length; line++) {
        const one = left.quoteLines[line]!
        const other = right.quoteLines[line]!
        if (one.old !== other.old || one.new !== other.new || one.kind !== other.kind) return false
      }
    }
  }
  return true
}

/**
 * Remember one session's placed-but-unsent blocks. Called on every change, so a mount that comes
 * back draws them again on the same lines with the same words.
 *
 * A list that says the same thing as the one held is not stored: the caller rebuilds it per render,
 * and only a real change (a placement, a draft, a block written or discarded) may republish it.
 *
 * @param sessionId - the session the panel is reviewing; nothing is recorded without one.
 * @param threads - the placements, oldest first.
 */
export function rememberPlacedThreads(sessionId: string | undefined, threads: readonly PlacedThread[]): void {
  if (sessionId === undefined) return
  const before = placedThreads.get(sessionId)
  if (before === threads) return
  if (before !== undefined && samePlaced(before, threads)) return
  placedThreads.set(sessionId, threads)
}

/**
 * Drop every placed block whose file the list no longer holds.
 *
 * A placement is a block of rows in ONE file's diff, so a file the reader has kept or
 * reverted out of the list leaves nothing for its block to hang on: it goes with the file,
 * exactly as the comments on those rows do (the host drops those; see `comments.ts`). The
 * entry ids ARE paths, so a path that comes back later is the same id again — without this
 * the placement was resurrected onto a file the reader had already dealt with, and
 * `discussionOverlapping` went on refusing a fresh comment on those very rows because a
 * block that is not on screen still counted as theirs.
 *
 * Nothing is published when nothing is dropped, so a poll that changes no file is not a
 * change to the page's memory (see the identity discipline in `rememberPlacedThreads`).
 *
 * @param sessionId - the session the panel is reviewing; nothing is dropped without one.
 * @param listed - the pending entry ids the list is holding.
 */
export function forgetPlacedThreadsNotIn(sessionId: string | undefined, listed: readonly string[]): void {
  if (sessionId === undefined) return
  const before = placedThreads.get(sessionId)
  if (before === undefined) return
  const held = new Set(listed)
  const kept = before.filter(thread => held.has(thread.fileId))
  if (kept.length === before.length) return
  placedThreads.set(sessionId, kept)
}

/**
 * The sessions this page has been told to stop asking about, for this visit.
 *
 * Keeping or reverting a file asks whether the row should leave the list, and a reader working through
 * one session's files answers that the same way every time — the answer is about the WORK, not about
 * one file. The dialog's 不移出/keep-and-stop-asking button is that whole answer, and it covers every
 * file in the session from then on. What it records is a fact about this visit rather than a
 * preference — it is not the host's to keep, and a reload starts clean, exactly like the thread state
 * above.
 */
const quietSessions = new Set<string>()

/**
 * Whether the reader asked not to be asked again about rows leaving THIS session's list.
 * @param sessionId - the session the panel is reviewing; nothing is quiet without one.
 * @returns true when the action should run without the question.
 */
export function removalAskQuiet(sessionId: string | undefined): boolean {
  return sessionId !== undefined && quietSessions.has(sessionId)
}

/**
 * Stop asking whether rows should leave the list, for the rest of this page: the whole session, every
 * file in it.
 * @param sessionId - the session the panel is reviewing; nothing is recorded without one.
 */
export function quietenRemovalAsk(sessionId: string | undefined): void {
  if (sessionId === undefined) return
  quietSessions.add(sessionId)
}

/**
 * "Which release the reader has already said 知道了 to", for THIS page.
 *
 * A VERSION rather than a boolean, for the reason the notice exists: it is there to tell the reader about a
 * release they have not seen, so dismissing one must not hide the NEXT one — a newer release shows again even
 * within the same page.
 *
 * And page-local, exactly like the quiet answer above, because the reader changed their mind about being
 * remembered: the notice comes back on the next client lifetime, while this page keeps it out of the way. It
 * is a fact about this visit, not a preference — nothing here is the host's to keep.
 */
let dismissedUpdate = ''

/**
 * Window event a dismissal dispatches, so every mounted seat hears it.
 *
 * The notice's chip lives in the open file's status bar, and the panel that draws it can be mounted more than
 * once (the footer seat and the right sidebar's docked tab are separate mounts): the state above is the fact,
 * and this event is how the OTHER mount learns about it NOW rather than at its next mount. One state, one
 * event — so whichever seat is on screen cannot disagree about whether the reader has said "got it".
 */
export const UPDATE_DISMISSED_EVENT = 'diff-approval:update-dismissed'

/**
 * The release whose notice the reader dismissed on this page.
 * @returns the dismissed version, or `''` when none has been dismissed here.
 */
export function dismissedUpdateVersion(): string {
  return dismissedUpdate
}

/**
 * Remember that the reader dismissed the notice for one version on this page, and tell the other mounts.
 * @param version - the version that notice was about.
 */
export function dismissUpdate(version: string): void {
  dismissedUpdate = version
  window.dispatchEvent(new CustomEvent(UPDATE_DISMISSED_EVENT, { detail: version }))
}

/** This session's record, created on first use. */
function viewOf(sessionId: string): SessionView {
  let view = views.get(sessionId)
  if (view === undefined) {
    view = { offsets: new Map() }
    views.set(sessionId, view)
  }
  return view
}

/**
 * Remember that a session's panel was left showing one file, and where in it.
 * @param sessionId - the session the panel was reviewing; nothing is recorded
 *   without one.
 * @param view - the pending entry that was open, and the code view's scrollTop.
 *   An absent offset *forgets* any remembered place for that file, which is what
 *   a caller that is about to open it at its first change wants: a mount that only
 *   appears afterwards then lands there too, instead of on a stale offset.
 */
export function rememberPanelView(
  sessionId: string | undefined,
  view: { fileId: string; scrollTop?: number | undefined },
): void {
  if (sessionId === undefined) return
  const record = viewOf(sessionId)
  record.last = view.fileId
  if (view.scrollTop === undefined) record.offsets.delete(view.fileId)
  else record.offsets.set(view.fileId, view.scrollTop)
}

/**
 * The file a session's panel was last showing.
 * @param sessionId - the session, if any.
 * @returns the pending entry id, or undefined when that session's panel has never
 *   closed on a file.
 */
export function lastPanelFile(sessionId: string | undefined): string | undefined {
  return sessionId === undefined ? undefined : views.get(sessionId)?.last
}

/**
 * How far down one file was left, when it has been left before.
 * @param sessionId - the session, if any.
 * @param fileId - the pending entry id.
 * @returns the remembered scrollTop, or undefined when there is none.
 */
export function panelFileOffset(sessionId: string | undefined, fileId: string): number | undefined {
  return sessionId === undefined ? undefined : views.get(sessionId)?.offsets.get(fileId)
}

/**
 * Forget every session's record. A page reload does this by itself; a test calls
 * it to start from a clean page rather than inheriting the previous case's place.
 */
export function resetPanelMemory(): void {
  views.clear()
  localThreads.clear()
  placedThreads.clear()
  quietSessions.clear()
  dismissedUpdate = ''
}
