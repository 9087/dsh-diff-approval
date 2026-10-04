/**
 * Which session the review is about, as every shell of this plugin has offered it.
 *
 * 0.1.7 changed how a client learns the selected session. Its session-list store carries
 * `{ ids, byId, phase, projectionsBySession }` — there is no `current` any more — and the shell's own
 * components take the id from their composed SLOT PROPS instead (`const { sessionId, useSessions } =
 * props`, then `useSessions(s => s.byId[sessionId]?.blank)`; measured in `dsh-client-ui-conversation`
 * and `dsh-client-ui-agent-preset`). Older shells put it in the store as `state.current`.
 *
 * The seats differ, and that is the whole reason this module exists: the Session HEADER seat is
 * session-scoped and is handed `sessionId`; the sidebar FOOTER seat — where this panel's own badge
 * lives — is rendered `renderSlot('sidebar.footer.action', { wide })` and is handed nothing else. So
 * the header publishes what it is showing, the footer reads it, and the store is the third fallback
 * (`current` on the shells that have it). Every reader here is total: an unknown shape answers
 * "nothing known" rather than throwing, and no field that is absent is taken for a value.
 *
 * @module dsh-diff-approval/client/session-seat
 */

import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** The frames a session id can arrive in: the id itself, or a row that carries one. */
interface SessionCarrier {
  [key: string]: unknown
}

/** What the header entry last saw the app showing; the root-scoped mounts read it. */
let published: SessionId | undefined
/** Bumped whenever `published` changes, so the hook below re-renders its readers. */
let publishedRevision = 0
const publishedListeners = new Set<() => void>()

/**
 * Publish the session the header entry is showing. Call it from an EFFECT, never during render.
 *
 * Writing this during the header's render was the cross-talk's other half: the value a render read
 * depended on whether another component had already rendered, so two mounts could disagree about which
 * session was showing — and, in concurrent rendering, a discarded render could publish a session that
 * was never committed. From an effect the value only ever describes a committed render.
 * @param id - the id, or `undefined` when the shell named none.
 */
export function publishSessionId(id: SessionId | undefined): void {
  if (published === id) return
  published = id
  publishedRevision += 1
  for (const listener of [...publishedListeners]) listener()
}

/** The session the header entry last showed, or `undefined` when it never named one. */
export function publishedSessionId(): SessionId | undefined {
  return published
}

/**
 * The published session as a React value: the root-scoped mounts (the sidebar footer's badge) have no
 * session prop, so this is how they follow the one the Session header is showing.
 *
 * It subscribes rather than reading the module global at render time, because the write now happens in
 * an effect: a reader that only read the global would keep whatever the value was on its first render
 * and never notice the reader switching sessions.
 * @returns the session the header entry is showing, or `undefined`.
 */
export function usePublishedSessionId(): SessionId | undefined {
  const [, setRevision] = useState(publishedRevision)
  useEffect(() => {
    // Re-read on subscribe: the value may have been published between this render and the effect.
    setRevision(publishedRevision)
    const listener = (): void => { setRevision(publishedRevision) }
    publishedListeners.add(listener)
    return () => { publishedListeners.delete(listener) }
  }, [])
  return published
}

/**
 * The selected session a shell's session-list state names, by every field the shells have used.
 * @param state - the store state handed to the selector.
 * @returns the id, or `undefined` when this shape names none.
 */
export function selectedSessionOf(state: unknown): SessionId | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const fields = state as SessionCarrier
  for (const key of ['current', 'currentId', 'selected', 'selectedId', 'sessionId']) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return value as SessionId
  }
  return undefined
}

/**
 * Whether one session row is BLANK — a freshly created session with nothing in it yet, which has
 * nothing to review and leaves this plugin's entry inert exactly like no session at all.
 *
 * `byId[id].blank` is the row's own flag and has kept its name across the shells; a store that
 * carries `blank` on the STATE (with the id beside it) is read too. An absent flag is not blank: a
 * shape this plugin does not recognise must not disable the panel.
 *
 * @param state - the store state handed to the selector.
 * @param id - the session the answer is about; `undefined` answers false.
 * @returns true only when the shell says that session is blank.
 */
export function sessionIsBlank(state: unknown, id: SessionId | undefined): boolean {
  if (id === undefined || typeof state !== 'object' || state === null) return false
  const fields = state as SessionCarrier & { byId?: Record<string, SessionCarrier | undefined> }
  const row = fields.byId?.[id]
  if (row !== undefined && typeof row === 'object' && row.blank === true) return true
  // The store's own `blank` belongs to the session it also names; it is only this session's answer
  // when the two agree, so a stale or shared flag cannot blank out the wrong session.
  if (fields.blank === true && selectedSessionOf(state) === id) return true
  return false
}

/**
 * Whether a seat has NO reviewable session: it cannot name one at all, or the shell says the one it names
 * is blank (a brand-new session with nothing said in it yet).
 *
 * The two halves are ONE question and must be asked of the SAME id — the id the seat would read its view
 * for. Splitting them is what this helper exists to stop: a seat that drew its view for the published
 * session while testing `sessionIsBlank` against a different (absent) id stayed enabled on a blank session
 * and drew the previous session's list — from another workspace as readily as from its own, because nothing
 * in this client compares workspaces.
 *
 * @param state - the session-list state handed to the selector.
 * @param id - the session this seat would read its view for.
 * @returns true when there is nothing to review.
 */
export function unreviewableSession(state: unknown, id: SessionId | undefined): boolean {
  return id === undefined || sessionIsBlank(state, id)
}

/**
 * The session the PAGE is showing, resolved the way a whole-page reader has to resolve it: the
 * session-list store's own selection first, else what the Session header entry published.
 *
 * `readSessionsSelection` is supplied by the plugin body (it owns the `sessions` service), and may
 * return `undefined` for a shell whose state names none — 0.1.7's store carries no selected session and
 * hands the id to its own session-scoped seats instead, which is why the published id is read here too
 * (`publishSessionId` runs from the header entry's effect). This is a plain read for non-React code: the
 * component that publishes it reads the SUBSCRIBED value ({@link usePublishedSessionId}).
 *
 * It is deliberately NOT every session anyone has read: the page-wide readers here (the reference remap,
 * which rewrites the visible composer's draft) mean the session the reader is looking at, and taking the
 * newest session some other mount polled would address a composer that is not on screen.
 *
 * @param readSessionsSelection - the store's own selected session, when its shape names one.
 * @returns the id, or `undefined` when nothing on this page names a session.
 */
export function shownSessionId(readSessionsSelection: () => SessionId | undefined): SessionId | undefined {
  return readSessionsSelection() ?? publishedSessionId()
}
