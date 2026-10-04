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
import { createPendingDiffStore } from '../src/client/store.ts'
import type { PendingDiffStore } from '../src/client/store.ts'
import { publishSessionId, publishedSessionId, usePublishedSessionId } from '../src/client/session-seat.ts'
import type { DiffApprovalPort } from '../src/client/port.ts'
import type { PendingFileDiff } from '../src/types.ts'

afterEach(cleanup)
afterEach(() => { localStorage.clear() })
afterEach(() => { act(() => { publishSessionId(undefined) }) })

/** One pending row good enough for the store: identity and text are all it reads. */
function row(id: string, session: string): PendingFileDiff {
  return {
    id, sessionId: session, sessionIds: [session], path: `${id}.txt`,
    oldText: '', newText: `${id}\n`, updatedAt: 1,
  } as unknown as PendingFileDiff
}

/** A store over a port whose per-session list is fixed. */
async function storeOf(bySession: Record<string, PendingFileDiff[]>): Promise<PendingDiffStore> {
  const store = createPendingDiffStore({
    async list(sessionId: string): Promise<unknown> {
      return {
        files: bySession[sessionId] ?? [], comments: [], commentLines: {},
        commentsRevision: 0, commentAnswers: {}, workspacePath: `/repo-${sessionId}`,
      }
    },
  } as unknown as DiffApprovalPort)
  for (const sessionId of Object.keys(bySession)) await store.refresh(sessionId as never)
  return store
}

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
    // The bubble names what it opens and carries the chord. jsdom runs against primitives 0.1.0-rc.6 —
    // older than 0.1.7-rc.2, where the shell learned to draw a shortcut as keycaps — so the bubble takes
    // `chords.ts`'s fallback and spells the chord the way this plugin did before that release (arrows as
    // glyphs). The chord is on the anchor as `aria-keyshortcuts` on every host; the keycap rendering is
    // covered by `e2e/tooltip-shortcuts.spec.ts`, against the real host.
    expect(screen.getByRole('tooltip').textContent).toBe('action.summonHint {"chord":"Ctrl+↑"}')
    expect(button().getAttribute('aria-keyshortcuts')).toBe('Control+ArrowUp')
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

/**
 * The entry's PER-SESSION count, which the page-wide `entryProps` above cannot stage: a seat that
 * knows its session reads that session's own view (`pendingView`), and a seat whose shell names no
 * session must fall back to the page's newest view rather than to a permanently empty slot.
 */
describe('DiffApprovalHeaderEntry per-session count', () => {
  /** The face as the plugin builds it: the real store's two readers bound to the framework hooks. */
  function faceFor(store: PendingDiffStore): Pick<DiffApprovalHeaderEntryProps, 'usePending' | 'pendingView'> {
    return {
      usePending: (<T,>(select: (view: PendingDiffSnapshot) => T): T => select(store.getSnapshot())) as never,
      pendingView: ((sessionId: string | undefined, select: (view: PendingDiffSnapshot) => unknown) =>
        select(store.viewFor(sessionId as never))) as never,
    }
  }

  /**
   * `useSessions` as the slot framework binds it: the hook hands the session-list state to the
   * selector and returns the selector's answer (the framework preserves it — it does not coerce it),
   * while the component's declared selector is a boolean one. This fake states that contract.
   */
  function sessionsState(state: unknown): (select: (value: unknown) => boolean) => boolean {
    return (select) => select(state)
  }

  it('reads 0 when the shell names no session, rather than the page\u2019s newest list', async () => {
    // The reader's rule: a seat with nothing to review says nothing. The page-wide list is still there —
    // `viewFor(undefined)` answers the newest read, pinned in `store.client.spec.ts` for the whole-page
    // readers the remap follows — but a SEAT is not a whole-page reader, and one wearing another session's
    // number is what the reader reported (a brand-new blank session showing a pending count). With no
    // workspace comparison anywhere in this client that number can even be another workspace's.
    const store = await storeOf({ a: [row('a1', 'a')], b: [row('b1', 'b'), row('b2', 'b'), row('b3', 'b')] })
    render(<DiffApprovalHeaderEntry t={(key: string) => key} {...faceFor(store)} useSessions={sessionsState({ current: null, byId: {} }) as never} />)
    expect(button().disabled).toBe(true)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('0')
  })

  it('counts its own session when the shell hands one over, never the one that read last', async () => {
    const store = await storeOf({ a: [row('a1', 'a')], b: [row('b1', 'b'), row('b2', 'b'), row('b3', 'b')] })
    render(<DiffApprovalHeaderEntry t={(key: string) => key} {...faceFor(store)} sessionId={'a' as never} />)
    // A was read (one file) while the page-wide newest is B (three): the count is A's, and it stays A's.
    expect(button().dataset.diffApprovalHeaderEntry).toBe('1')
  })

  it('answers a session that has never been read with its own empty view, not the page-wide list', async () => {
    const store = await storeOf({ a: [row('a1', 'a')], b: [row('b1', 'b'), row('b2', 'b'), row('b3', 'b')] })
    render(<DiffApprovalHeaderEntry t={(key: string) => key} {...faceFor(store)} sessionId={'unread' as never} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('0')
    expect(button().disabled).toBe(false)
  })

  it('reads 0 while the shell\u2019s blank session keeps the button inert', async () => {
    // One session, one answer: a blank session has nothing to review, so the button is inert AND its
    // number is 0. This used to keep the page's newest count beside an inert button — two sources for one
    // seat, which is what let a brand-new blank session show a pending count.
    const store = await storeOf({ a: [row('a1', 'a')], b: [row('b1', 'b'), row('b2', 'b'), row('b3', 'b')] })
    render(
      <DiffApprovalHeaderEntry
        t={(key: string) => key}
        {...faceFor(store)}
        useSessions={sessionsState({ current: 'blank-one', byId: { 'blank-one': { blank: true } } }) as never}
      />,
    )
    expect(button().disabled).toBe(true)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('0')
  })

  it('publishes the session the shell composed, so a root-scoped seat follows that same one', async () => {
    // The footer/dock seats handed no session id read what this seat published (`usePublishedSessionId`,
    // see `session-seat.ts`), so what it publishes has to be the session it is about.
    const store = await storeOf({ a: [row('a1', 'a'), row('a2', 'a')], b: [row('b1', 'b')] })
    render(
      <DiffApprovalHeaderEntry
        t={(key: string) => key}
        {...faceFor(store)}
        sessionId={'b' as never}
        useSessions={sessionsState({ current: 'b', byId: {} }) as never}
      />,
    )
    expect(button().dataset.diffApprovalHeaderEntry).toBe('1')
    // `publishedSessionId()` is the plain read of the same module state the hook subscribes to.
    expect(publishedSessionId()).toBe('b')
    expect(store.viewFor(publishedSessionId() as never).files).toHaveLength(1)
  })

  it('carries the light count when the session has one, and the list\'s own length when it does not', () => {
    // No count yet (a page that just loaded, or a host built before the endpoint): the entry shows the
    // length of the list the read carried — unchanged behaviour.
    const first = render(<DiffApprovalHeaderEntry {...entryProps({ count: 3 })} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('3')
    first.unmount()

    // A count has landed (published by the store on the session's own view): THAT is the number, even
    // though the last full read carried two rows. This is what keeps an entry live while the panel is
    // shut, when nothing is reading the list at all.
    const pageWide = entryProps()
    pageWide.usePending = ((select: (snapshot: PendingDiffSnapshot) => unknown) =>
      select({ files: [{}, {}], count: 9 } as unknown as PendingDiffSnapshot)) as never
    render(<DiffApprovalHeaderEntry {...pageWide} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('9')
    cleanup()

    // …and the same rule on the PER-SESSION branch, which is the one a session-scoped seat uses.
    const perSession = entryProps()
    perSession.pendingView = ((_sessionId: string | undefined, select: (view: PendingDiffSnapshot) => unknown) =>
      select({ files: [{}], count: 4 } as unknown as PendingDiffSnapshot)) as never
    render(<DiffApprovalHeaderEntry {...perSession} sessionId={'a' as never} />)
    expect(button().dataset.diffApprovalHeaderEntry).toBe('4')
  })
})
