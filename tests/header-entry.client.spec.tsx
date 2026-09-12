// @vitest-environment jsdom
// The Session header's entry: the count it carries, the toggle it dispatches, and
// the visibility it follows back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DiffApprovalHeaderEntry } from '../src/client/header-entry.tsx'
import type { DiffApprovalHeaderEntryProps } from '../src/client/header-entry.tsx'
import { PANEL_STATE_EVENT, TOGGLE_PANEL_EVENT } from '../src/client/dock.tsx'
import type { DockSnapshot } from '../src/client/dock.tsx'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'

afterEach(cleanup)
afterEach(() => { localStorage.clear() })

/** The entry as the header's utilities seat draws it: our face's hooks bound, the
 *  session seat, and the translator. */
function entryProps(options: {
  count?: number
  dock?: DockSnapshot | undefined
  sessions?: { current?: string | undefined; byId: Record<string, { blank?: boolean } | undefined> } | undefined
} = {}): DiffApprovalHeaderEntryProps {
  const count = options.count ?? 0
  const props: Record<string, unknown> = {
    t: (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`,
    usePending: (select: (snapshot: PendingDiffSnapshot) => unknown) =>
      select({ files: new Array(count).fill({}) } as unknown as PendingDiffSnapshot),
  }
  if (options.dock !== undefined) {
    props.useDock = (select: (state: DockSnapshot) => unknown) => select(options.dock as DockSnapshot)
  }
  if (options.sessions !== undefined) {
    const sessions = options.sessions
    props.useSessions = (select: (state: typeof sessions) => boolean) => select(sessions)
  }
  return props as unknown as DiffApprovalHeaderEntryProps
}

const button = (): HTMLButtonElement => document.querySelector('[data-diff-approval-header-entry]') as HTMLButtonElement

describe('DiffApprovalHeaderEntry', () => {
  it('carries the pending count, and nothing when the list is empty', () => {
    const view = render(<DiffApprovalHeaderEntry {...entryProps({ count: 0 })} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('0')
    // No pip at zero: the button is the icon alone, the size of its neighbours.
    expect(button().querySelector('span')).toBeNull()

    view.unmount()
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 12 })} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('12')
    expect(screen.getByText('12')).not.toBeNull()
  })

  it('advertises the panel and the chord that summons it', () => {
    localStorage.setItem('diff-approval:quick-summon-key', 'Ctrl+ArrowUp')
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 1 })} />)
    fireEvent.focus(button())
    // The same hint the footer entry shows, chord spelled as bound (arrows are
    // glyphs), read at render time rather than baked into the copy.
    expect(screen.getByText('action.summonHint {"chord":"Ctrl+↑"}')).not.toBeNull()
  })

  it('asks the panel to toggle when it is pressed, rather than holding a copy of its state', () => {
    const toggles = vi.fn()
    window.addEventListener(TOGGLE_PANEL_EVENT, toggles)
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 2 })} />)
    fireEvent.click(button())
    expect(toggles).toHaveBeenCalledTimes(1)
    window.removeEventListener(TOGGLE_PANEL_EVENT, toggles)
  })

  it('lights up while the floating panel is open, and dims when it closes', () => {
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 1 })} />)
    expect(button().hasAttribute('data-active')).toBe(false)
    expect(button().getAttribute('aria-expanded')).toBe('false')

    act(() => {
      window.dispatchEvent(new CustomEvent(PANEL_STATE_EVENT, { detail: { open: true } }))
    })
    expect(button().hasAttribute('data-active')).toBe(true)
    expect(button().getAttribute('aria-expanded')).toBe('true')

    act(() => {
      window.dispatchEvent(new CustomEvent(PANEL_STATE_EVENT, { detail: { open: false } }))
    })
    expect(button().hasAttribute('data-active')).toBe(false)
  })

  it('lights up for a docked panel too, without any overlay state', () => {
    // The panel showing in the right sidebar is the dock observable's business;
    // the two readings are one "it is open" for this button.
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 1, dock: { available: true, open: true, reason: undefined } })} />)
    expect(button().hasAttribute('data-active')).toBe(true)
  })

  it('is inert without a reviewable session, and live with one', () => {
    const view = render(<DiffApprovalHeaderEntry {...entryProps({ sessions: { current: undefined, byId: {} } })} />)
    expect(button().disabled).toBe(true)

    view.unmount()
    render(<DiffApprovalHeaderEntry {...entryProps({ sessions: { current: 'session-1', byId: { 'session-1': { blank: true } } } })} />)
    // A freshly created blank session has nothing to review yet, exactly as the
    // footer entry's badge has it.
    expect(button().disabled).toBe(true)

    cleanup()
    render(<DiffApprovalHeaderEntry {...entryProps({ sessions: { current: 'session-1', byId: {} } })} />)
    expect(button().disabled).toBe(false)
  })

  it('stays usable where the host publishes no session seat at all', () => {
    // The seat is part of the framework kit; an entry that demands it would take
    // the whole header cluster down on a build that stopped providing it.
    render(<DiffApprovalHeaderEntry {...entryProps({ count: 1 })} />)
    expect(button().disabled).toBe(false)
  })
})
