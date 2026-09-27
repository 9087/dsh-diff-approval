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

import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** The frames a session id can arrive in: the id itself, or a row that carries one. */
interface SessionCarrier {
  [key: string]: unknown
}

/** What the header entry last saw the app showing; the root-scoped mounts read it. */
let published: SessionId | undefined

/**
 * Publish the session the header entry is showing.
 * @param id - the id, or `undefined` when the shell named none.
 */
export function publishSessionId(id: SessionId | undefined): void {
  published = id
}

/** The session the header entry last showed, or `undefined` when it never named one. */
export function publishedSessionId(): SessionId | undefined {
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
 * The session this mount is about: the slot prop the shell composed, else the store's own selected
 * session, else what the header entry published (see the module doc).
 * @param propSessionId - `sessionId` from the composed slot props, when the shell sends one.
 * @param storeSelected - the store's selected session, when its shape names one.
 * @returns the id, or `undefined` when nothing here knows one.
 */
export function sessionIdFor(
  propSessionId: SessionId | undefined,
  storeSelected: SessionId | undefined,
): SessionId | undefined {
  return propSessionId ?? storeSelected ?? publishedSessionId()
}
