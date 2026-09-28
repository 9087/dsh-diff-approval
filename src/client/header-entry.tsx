/**
 * The pending-changes entry in the Session header.
 *
 * The sidebar footer's badge is only where the sidebar is: with the sidebar
 * collapsed to its rail, or hidden on a narrow window, the review has no entry.
 * The Session header's right-aligned utilities hold the app's own per-session
 * controls — "open in app" and the more-actions button the session-log export
 * lives behind — and are visible whatever the sidebar does. This seats the same
 * action there: one compact button carrying the pending count.
 *
 * The header entry is a *second mount* of one action, not a second panel: the
 * click travels to the mount that owns the open state ({@link TOGGLE_PANEL_EVENT})
 * and the visibility comes back ({@link PANEL_STATE_EVENT}), because the two sit
 * in different slot trees and neither owns the other. That is also why a press is
 * exactly the footer badge's press: a docked panel's tab is revealed, and still
 * closed by the chip on its own tab rather than from here.
 *
 * @module dsh-diff-approval/client/header-entry
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconListPenOutline16, Tooltip } from './dsh-icons.ts'
import { publishSessionId, selectedSessionOf, sessionIsBlank } from './session-seat.ts'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingDiffSnapshot, PendingViewHooks } from './slots.ts'
import type { DockSnapshot, PanelStateDetail } from './dock.tsx'
import { PANEL_STATE_EVENT, TOGGLE_PANEL_EVENT } from './dock.tsx'
import { summonHint } from './chords.ts'
import css from './PendingPanel.module.css'

/** What the header entry reads from this plugin's own face: the two observables, and the per-session
 *  view reader (`pendingView`) that keeps its count on ITS session. Everything else it needs (the
 *  button's own click) goes through the window events, so the entry never holds a copy of the panel's
 *  state. */
export interface HeaderEntryFace extends PendingViewHooks {
  hooks: {
    /** Live pending-diff snapshot: the fallback count for a face with no per-session reader. */
    pending: HostObservable<PendingDiffSnapshot>
    /** The dock's state, absent in a build without a right sidebar. */
    dock?: HostObservable<DockSnapshot>
  }
}

/** The framework session-list seats this entry reads, as far as it reads them.
 *  Both are optional so the entry still renders where a host provides neither. */
export interface HeaderEntrySeat {
  /** The selected session and its rows; the entry is inert without one. */
  useSessions?: ((select: (state: HeaderEntrySessions) => boolean) => boolean) | undefined
  /**
   * The session this seat is about, composed by the shell.
   *
   * This is where 0.1.7 hands it over: the session-list store it gives `useSessions` carries
   * `{ ids, byId, phase, projectionsBySession }` and no selected session at all, while the shell's
   * own session-scoped seats take the id from their props and ask the store about that row
   * (`useSessions(s => s.byId[sessionId]?.blank)`). Older shells put `current` in the store, which is
   * why both are read (see `session-seat.ts`).
   */
  sessionId?: SessionId | undefined
}

/** The slice of the session list this entry reads: whichever of these a shell carries. */
export interface HeaderEntrySessions {
  /** The session the app is showing, on the shells that keep it here (0.1.5 and earlier). */
  current?: SessionId | undefined
  /** Known sessions by id, for the blank-session check. */
  byId?: Record<string, { blank?: boolean } | undefined> | undefined
  /** A blank flag carried by the STATE itself on the shells that place it there. */
  blank?: boolean | undefined
  /** Every other field a shell may carry: this plugin reads none of them, and a shape it does not
   *  know must not disable the entry (see `session-seat.ts`). */
  [field: string]: unknown
}

/** Full props of the header entry: the injected face's hooks bound as
 *  `usePending`/`useDock`, the framework seats, and the locale `t`. */
export type DiffApprovalHeaderEntryProps =
  InjectFace<HeaderEntryFace> & HeaderEntrySeat & PropsLocale<'diff-approval'>

/**
 * Render the Session header's pending-changes button.
 * @param props - the bound hooks, the session seat, and the translator.
 * @returns the icon button, with the pending count while there is one.
 */
export function DiffApprovalHeaderEntry({ usePending, useSessions, useDock, pendingView, sessionId, t }: DiffApprovalHeaderEntryProps): ReactNode {
  // This session's own count, never another session's: the page-wide snapshot is only the fallback for a
  // face with no per-session reader. The `usePending` call is also the subscription that re-renders this
  // button whenever anything publishes, so the count tracks the list without a second store hook.
  const pageWide = usePending(snapshot => snapshot) as PendingDiffSnapshot
  const count = pendingView === undefined
    ? pageWide.files.length
    : pendingView(sessionId, view => view.files.length)
  // Whether the panel is showing *dock-side* is observable here; whether it is
  // showing as the overlay comes back as an event, from the mount that owns it.
  const dockShowing = useDock?.((state: DockSnapshot) => state.open) === true
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onState = (event: Event): void => {
      setOpen((event as CustomEvent<PanelStateDetail>).detail?.open === true)
    }
    window.addEventListener(PANEL_STATE_EVENT, onState)
    return () => { window.removeEventListener(PANEL_STATE_EVENT, onState) }
  }, [])
  // No reviewable session (none selected, or a freshly created blank one): the
  // same rule the footer entry applies, so the two are never differently enabled. A host that offers
  // no session seat at all is not a host without a session: the entry stays usable there, as it always
  // did (the seat is the framework's, and demanding it would take the header cluster down).
  const noSession = useSessions === undefined
    ? false
    : useSessions(state => {
        const id = sessionId ?? selectedSessionOf(state)
        return id === undefined || sessionIsBlank(state, id)
      })
  // This seat is session-scoped and is the one mount the shell tells; the footer mounts are handed no
  // id at all on 0.1.7 (`renderSlot('sidebar.footer.action', { wide })`), so what is shown here is
  // published for them. A shell that keeps the selection in the store needs no bridge: the footer
  // reads that itself (see `session-seat.ts`).
  //
  // From an EFFECT, never during render: the published value has to describe a committed render. A
  // render-phase write let two mounts disagree about which session was showing (the value a render saw
  // depended on whether the other had already rendered), which is what put one session's list under
  // another's badge.
  useEffect(() => { publishSessionId(sessionId) }, [sessionId])
  const active = open || dockShowing
  return (
    <Tooltip label={summonHint(t)} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.headerEntry}
        data-diff-approval-header-entry={count}
        data-active={active ? '' : undefined}
        aria-label={t('panel.aria')}
        aria-expanded={active}
        disabled={noSession}
        onClick={() => { window.dispatchEvent(new CustomEvent(TOGGLE_PANEL_EVENT)) }}
      >
        <IconListPenOutline16 size={16} />
        {count > 0 && <span className={css.headerEntryCount}>{count}</span>}
      </button>
    </Tooltip>
  )
}
