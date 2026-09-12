// @vitest-environment jsdom
// The right sidebar as a host: the dock adapter, its optional registration, and
// the tab chip's count.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { attachDiffDock, createDockState, DiffDockTitle, DIFF_DOCK_ID, DIFF_DOCK_KIND, SHOW_PANEL_EVENT } from '../src/client/dock.tsx'
import type { DockHostContext } from '../src/client/dock.tsx'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'

afterEach(cleanup)
afterEach(() => { localStorage.clear() })

/** A stand-in for the sidebar's navigation face: the tabs it was asked to open.
 *
 *  Deliberately strict about its surface. The shipped controller
 *  (`ctx.sidebarRight`) has `openTab`/`openResource`/`active`/`isExpanded`/… and
 *  **no observable at all** — an earlier version of this fake grew a `subscribe`
 *  the real service never had, so the whole feature passed here and threw in the
 *  browser. Any property the plug-in reaches for that the controller does not
 *  publish therefore fails loudly in every test instead of only in the field. */
function fakeSidebar() {
  const opened: { kind: string; revealIfOpened?: boolean }[] = []
  const face = new Proxy({
    openTab(kind: string, options?: { revealIfOpened?: boolean }) {
      opened.push({ kind, ...(options ?? {}) })
    },
  }, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop, target)
      throw new Error(`ctx.sidebarRight has no "${String(prop)}" — the controller publishes openTab/openResource/active/isExpanded/toggleExpanded/focus/split/float/dock and nothing else`)
    },
  })
  return { opened, face }
}

/** A stand-in for the client context: optional lookup over a service table the
 *  test can fill later (the sidebar often attaches after this plugin), and an
 *  effect that records cleanup the way the fiber does. */
function fakeContext(services: Record<string, unknown> = {}) {
  const effects: string[] = []
  const stops: (() => void)[] = []
  // `slots` is always present in a real runtime — this plugin declares it — so
  // the diagnostic probe reads "ok" for it while the sidebar's own services are
  // missing. The seat is absent here because no sidebar plugin is loaded.
  const table: Record<string, unknown> = { slots: { spec: () => undefined }, ...services }
  return {
    services: table,
    effects,
    ctx: {
      get: (name: string) => table[name],
      effect: (callback: () => unknown, label: string) => {
        effects.push(label)
        const dispose = callback()
        if (typeof dispose === 'function') stops.push(dispose as () => void)
      },
    },
  }
}

describe('createDockState', () => {
  it('exists before the sidebar does, and flips to available when it attaches', () => {
    const sidebar = fakeSidebar()
    const dock = createDockState()
    // The footer entry is seated once, so the observable must exist from apply
    // time — an unattached state reads as "no right sidebar in this build".
    expect(dock.face.hooks.dock.getSnapshot()).toEqual({ available: false, open: false })
    const seen: unknown[] = []
    dock.face.hooks.dock.subscribe(() => { seen.push(dock.face.hooks.dock.getSnapshot()) })
    const detach = dock.attach(sidebar.face as never)
    expect(seen).toEqual([{ available: true, open: false }])
    expect(dock.face.hooks.dock.getSnapshot()).toEqual({ available: true, open: false })
    // Revealing before any sidebar is attached is a no-op, never a crash.
    dock.face.open()
    expect(sidebar.opened).toEqual([{ kind: DIFF_DOCK_KIND, revealIfOpened: true }])
    detach()
    expect(seen.at(-1)).toEqual({ available: false, open: false })
  })

  it('reports the tab body\'s own visibility, and notifies when it changes', () => {
    const sidebar = fakeSidebar()
    const dock = createDockState()
    const detach = dock.attach(sidebar.face as never)
    const seen: boolean[] = []
    const unsubscribe = dock.face.hooks.dock.subscribe(() => {
      seen.push(dock.face.hooks.dock.getSnapshot().open)
    })
    // The controller has no observable, so this comes from the docked body: it is
    // the only thing that knows whether the tab is really on screen.
    expect(dock.face.hooks.dock.getSnapshot().open).toBe(false)
    dock.face.setShowing(true)
    expect(seen).toEqual([true])
    // Repeating the same report is not a notification.
    dock.face.setShowing(true)
    expect(seen).toEqual([true])
    dock.face.setShowing(false)
    expect(seen).toEqual([true, false])
    // Detaching drops the sidebar and the visibility with it.
    dock.face.setShowing(true)
    expect(seen).toEqual([true, false, true])
    detach()
    expect(dock.face.hooks.dock.getSnapshot()).toEqual({ available: false, open: false })
    unsubscribe()
  })
})

describe('attachDiffDock', () => {
  it('registers the tab type once the sidebar services are present', () => {
    const registrations: Record<string, unknown>[] = []
    const sidebar = fakeSidebar()
    const host = fakeContext({
      sidebarRight: sidebar.face,
      sidebarRightTabs: { register: (definition: Record<string, unknown>) => { registrations.push(definition); return () => {} } },
    })
    const attached: unknown[] = []
    attachDiffDock(host.ctx as unknown as DockHostContext, { title: () => 'T', guideDescription: () => 'D' }, (given) => {
      attached.push(given)
      return () => {}
    })

    // Found on the first look: no timer needed, the live sidebar is handed over and
    // the type (with its guide entry) is registered once.
    expect(attached).toHaveLength(1)
    expect(registrations).toHaveLength(1)
    const definition = registrations[0]!
    expect(definition.id).toBe(DIFF_DOCK_ID)
    expect(definition.kind).toBe(DIFF_DOCK_KIND)
    expect((definition.title as (address: string) => string)('')).toBe('T')
    expect((definition.guide as { description?: () => string }[])[0]!.description?.()).toBe('D')
    expect(host.effects).toEqual([
      'diff-approval: dock lookup',
      'diff-approval: dock sidebar',
      'diff-approval: right-sidebar tab type',
    ])
  })

  it('waits for a sidebar that attaches later, then stops looking', () => {
    vi.useFakeTimers()
    const registrations: Record<string, unknown>[] = []
    const sidebar = fakeSidebar()
    const host = fakeContext()
    const attached: unknown[] = []
    attachDiffDock(host.ctx as unknown as DockHostContext, { title: () => 'T', guideDescription: () => 'D' }, (given) => {
      attached.push(given)
      return () => {}
    })
    // Nothing attached yet — but the missing half is already reported, because
    // the user may ask for the dock within seconds of the page loading, and the
    // sandbox withholds cordis's dynamic inject, so the lookup keeps trying
    // instead of giving up on the boot order.
    expect(attached).toEqual([undefined])
    vi.advanceTimersByTime(500)
    expect(attached).toEqual([undefined])
    host.services.sidebarRight = sidebar.face
    host.services.sidebarRightTabs = { register: (definition: Record<string, unknown>) => { registrations.push(definition); return () => {} } }
    vi.advanceTimersByTime(200)
    expect(attached).toHaveLength(2)
    expect(attached[1]).toBe(sidebar.face)
    expect(registrations).toHaveLength(1)
    // Found: the timer is done, so later ticks change nothing.
    vi.advanceTimersByTime(5000)
    expect(attached).toHaveLength(2)
    expect(registrations).toHaveLength(1)
    vi.useRealTimers()
  })

  it('reports the missing half once, and then the give-up, not forty times', () => {
    vi.useFakeTimers()
    const host = fakeContext()
    const attach = vi.fn()
    attachDiffDock(host.ctx as unknown as DockHostContext, { title: () => 'T', guideDescription: () => 'D' }, attach)
    // The first look already says which service is missing, so clicking the dock
    // entry early shows the same diagnosis the give-up would have shown.
    expect(attach).toHaveBeenCalledTimes(1)
    const early = String(attach.mock.calls[0]![1])
    // Most decisive first, so a truncated toast still says which half is missing…
    expect(early.startsWith('sidebarRight=missing sidebarRightTabs=missing')).toBe(true)
    // …and the probe distinguishes "nothing is reachable" from "only the sidebar
    // is unreachable": the services this plugin already uses read through the
    // same lookup, and the tab seat is asked separately.
    expect(early).toContain('slots=ok')
    expect(early).toContain('seat(sidebar.right.pane.tab)=')
    vi.advanceTimersByTime(3000)
    // Still the same shape: no repeated reporting while the poll runs.
    expect(attach).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('gives up on a sidebar that never appears, reporting what it saw', () => {
    vi.useFakeTimers()
    const host = fakeContext()
    const attach = vi.fn()
    attachDiffDock(host.ctx as unknown as DockHostContext, { title: () => 'T', guideDescription: () => 'D' }, attach)
    vi.advanceTimersByTime(20_000)
    // It stops polling — and says why, so "no dock" can be diagnosed from the UI
    // instead of silently missing a menu row.
    expect(vi.getTimerCount()).toBe(0)
    // Two reports: the immediate "what I see" and the give-up that says polling
    // stopped. Everything in between was deduplicated.
    expect(attach).toHaveBeenCalledTimes(2)
    const [firstSidebar, firstReason] = attach.mock.calls[0]!
    expect(firstSidebar).toBeUndefined()
    expect(String(firstReason)).toContain('sidebarRight=missing')
    expect(String(firstReason)).toContain('sidebarRightTabs=missing')
    const [sidebar, reason] = attach.mock.calls[1]!
    expect(sidebar).toBeUndefined()
    expect(String(reason)).toContain('no right sidebar after 100 looks')
    expect(String(reason)).toContain('sidebarRight=missing')
    expect(String(reason)).toContain('sidebarRightTabs=missing')
    vi.useRealTimers()
  })
})

describe('DiffDockTitle', () => {
  /** The chip as the seat draws it: our face plus the framework's tab hook.
   *  Rendered as a component (not called as one) because it uses hooks. */
  const chipProps = (count: number, close: () => void = () => {}) => ({
    t: (key: string) => key,
    usePending: ((select: (snapshot: PendingDiffSnapshot) => unknown) =>
      select({ files: new Array(count).fill({}) } as PendingDiffSnapshot)) as never,
    useTabInfo: () => ({ tab: { visible: true, actions: { close } } }),
  } as never)
  const renderChip = (count: number, close: () => void = () => {}) => render(
    <DiffDockTitle {...chipProps(count, close)} />,
  )

  it('shows the pending count beside the title', () => {
    renderChip(3)
    expect(screen.getByText('panel.title · 3')).not.toBeNull()
  })

  it('shows the bare title when nothing is pending', () => {
    renderChip(0)
    expect(screen.getByText('panel.title')).not.toBeNull()
  })

  it('carries the mode switch, and handing the panel back closes this tab', () => {
    const close = vi.fn()
    const shown: string[] = []
    const onShow = (): void => { shown.push('shown') }
    window.addEventListener(SHOW_PANEL_EVENT, onShow)
    renderChip(1, close)

    // The docked panel draws no header, so this chip is where it is told to
    // leave: the mark is the state, and the menu names the three of them.
    const trigger = document.querySelector('[data-diff-approval-presentation]') as HTMLElement
    expect(trigger.getAttribute('data-diff-approval-presentation-host')).toBe('chip')
    expect(trigger.getAttribute('aria-label')).toBe('action.presentationCurrent')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('action.presentationFloat'))

    // Remembered for the footer entry, the tab closed, and the (separate) footer
    // instance asked to show the overlay.
    expect(localStorage.getItem('diff-approval:presentation')).toBe('float')
    expect(close).toHaveBeenCalledTimes(1)
    expect(shown).toEqual(['shown'])
    window.removeEventListener(SHOW_PANEL_EVENT, onShow)
  })

  it('keeps menu presses to itself, so the tab it sits in never sees them', () => {
    // The list is portaled to `document.body`, but React events bubble up the
    // React tree: without this boundary a press on a row reaches the chip's own
    // `role="tab"`, whose pointerdown starts a tab drag and cancels the press's
    // click — the menu opened and no row could ever be picked.
    const close = vi.fn()
    const tabSaw = vi.fn()
    render(
      <div role="tab" onPointerDown={tabSaw} onClick={tabSaw} onContextMenu={tabSaw}>
        <DiffDockTitle {...chipProps(1, close)} />
      </div>,
    )
    const trigger = document.querySelector('[data-diff-approval-presentation]') as HTMLElement
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('action.presentationFloat'))
    expect(tabSaw).not.toHaveBeenCalled()
    // …and the choice still reached the panel: remembered, tab closed, overlay asked for.
    expect(localStorage.getItem('diff-approval:presentation')).toBe('float')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('publishes its own close for the chord, and takes it back when it goes', () => {
    const close = vi.fn()
    const published: ((() => void) | undefined)[] = []
    const view = render(
      <DiffDockTitle {...chipProps(1, close)} onDockClose={(fn) => { published.push(fn) }} />,
    )
    // Registered while the tab exists: this is what a chord closes the dock with,
    // since the tab is the only thing that knows how to close itself.
    expect(published).toHaveLength(1)
    const registered = published[0]
    expect(typeof registered).toBe('function')
    registered?.()
    expect(close).toHaveBeenCalledTimes(1)
    // Withdrawn on unmount, so nothing tries to close a tab that is gone.
    view.unmount()
    expect(published.at(-1)).toBeUndefined()
  })

  it('sits after the title, shaped like the kit\'s close button, and lists only the modes', () => {
    renderChip(2)
    const chip = document.querySelector('[data-diff-approval-chip]') as HTMLElement
    const trigger = chip.querySelector('[data-diff-approval-presentation]') as HTMLElement
    // Right-hand tab chrome, next to the kit's close button rather than in front
    // of the title.
    const label = screen.getByText('panel.title · 2')
    expect(label.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trigger.querySelectorAll('svg')).toHaveLength(2)

    fireEvent.click(trigger)
    // The two presentations, and nothing else: a docked panel needs neither a
    // settings row nor a third state.
    const rows = [...document.querySelectorAll('[role="menuitem"]')]
    expect(rows).toHaveLength(2)
    expect(screen.getByText('action.presentationDock')).not.toBeNull()
    expect(screen.queryByText('action.settings')).toBeNull()
  })
})
