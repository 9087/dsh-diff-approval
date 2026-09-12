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
import { IconListPenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingDiffSnapshot } from './slots.ts'
import type { DockSnapshot, PanelStateDetail } from './dock.tsx'
import { PANEL_STATE_EVENT, TOGGLE_PANEL_EVENT } from './dock.tsx'
import { summonHint } from './chords.ts'
import css from './PendingPanel.module.css'

/** What the header entry reads from this plugin's own face: the two observables.
 *  Everything else it needs (the button's own click) goes through the window
 *  events, so the entry never holds a copy of the panel's state. */
export interface HeaderEntryFace {
  hooks: {
    /** Live pending-diff snapshot: the count on the button. */
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
}

/** The slice of the session list this entry reads. */
export interface HeaderEntrySessions {
  /** The session the app is showing. */
  current?: SessionId | undefined
  /** Known sessions by id, for the blank-session check. */
  byId: Record<string, { blank?: boolean } | undefined>
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
export function DiffApprovalHeaderEntry({ usePending, useSessions, useDock, t }: DiffApprovalHeaderEntryProps): ReactNode {
  const count = usePending(snapshot => snapshot.files.length)
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
  // same rule the footer entry applies, so the two are never differently enabled.
  const noSession = useSessions === undefined
    ? false
    : useSessions(state => state.current === undefined || (state.byId[state.current]?.blank ?? false))
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
