/**
 * Where the review panel was left, for this page's lifetime.
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

import type { Discussion } from './discussion.ts'

/** One session's remembered view: its last file, and how far down each file was. */
interface SessionView {
  /** The pending entry that was open when this session's panel last closed. */
  last?: string | undefined
  /** Entry id -> the code view's `scrollTop` when that file was last left. */
  offsets: Map<string, number>
}

const views = new Map<string, SessionView>()

/**
 * One session's comment threads, by pending entry id.
 *
 * A thread is not a preference and not the host's to keep: it is what this visit put on the
 * diff, and the panel unmounts whenever it is closed or its presentation changes (the
 * floating overlay and the docked tab are two mounts). Module state gives them one memory,
 * so the threads are still there when the panel comes back, and a page reload starts clean -
 * which is the lifetime the comments are supposed to have.
 */
const threads = new Map<string, Readonly<Record<string, readonly Discussion[]>>>()

/**
 * The comment threads a session's panel is holding.
 * @param sessionId - the session, if any.
 * @returns the threads by pending entry id; empty when there are none.
 */
export function rememberedDiscussions(
  sessionId: string | undefined,
): Readonly<Record<string, readonly Discussion[]>> {
  return sessionId === undefined ? {} : threads.get(sessionId) ?? {}
}

/**
 * Remember the comment threads a session's panel holds. Called on every change, so a mount
 * that appears later (another presentation, or the panel reopened) starts from them.
 * @param sessionId - the session the panel is reviewing; nothing is recorded without one.
 * @param byFile - the threads, by pending entry id.
 */
export function rememberDiscussions(
  sessionId: string | undefined,
  byFile: Readonly<Record<string, readonly Discussion[]>>,
): void {
  if (sessionId === undefined) return
  threads.set(sessionId, byFile)
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
  threads.clear()
}
