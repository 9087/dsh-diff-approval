// @vitest-environment jsdom
// PendingPanel: badge, per-path grouping, per-operation rows, actions, jump
// navigation, live-state warnings, and the line-selection copy toolbar.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import { PendingPanel, frameInsets, makeMeasurer, wrapChipRows, MIN_LIST_WIDTH_PX } from '../src/client/PendingPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { lastPanelFile, panelFileOffset, rememberDiscussions, rememberedDiscussions, removalAskQuiet, resetPanelMemory } from '../src/client/panel-memory.ts'
import { diffLineHeight, navLeadRows, setCommentModeEnabled } from '../src/client/settings.ts'
import { DiffDockBody, SHOW_PANEL_EVENT } from '../src/client/dock.tsx'
import { DiffApprovalHeaderEntry } from '../src/client/header-entry.tsx'
import { DiffApprovalSettingsTab } from '../src/client/SettingsTab.tsx'
import { renderMarkdownPreview } from '../src/client/markdown-preview.ts'
import { highlightWindow } from '../src/client/highlight.ts'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'

// Spy (keeping the real renderer) so a test can prove the preview is not
// re-rendered while its pane scrolls.
vi.mock('../src/client/markdown-preview.ts', { spy: true })
// Spy (keeping the real tokenizer) so a test can prove highlighting is windowed:
// which line ranges the panel asks for, and that it never asks for a whole file.
vi.mock('../src/client/highlight.ts', { spy: true })

afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })
afterEach(() => { localStorage.clear() })
// The panel's view memory is module state that outlives a test (and is meant to
// outlive a close): each case starts from a page that has never opened it.
afterEach(resetPanelMemory)
// A test that plants the harness composer's input box owns it for its own test
// only: the panel focuses the first one it finds, so a leftover would silently
// redirect the next test's caret assertion.
afterEach(() => { for (const stale of document.querySelectorAll('[data-composer-input]')) stale.remove() })
// Comment mode is a preview that ships OFF (see `commentModeEnabled`). The commenting
// tests are about what the mode does once it is on, so the suite switches it on here; the
// default and the off-state behaviour are asserted on their own below.
beforeEach(() => { localStorage.setItem('diff-approval:comment-mode-preview', '1') })

beforeAll(() => {
  // jsdom has no scrolling; the jump effect centers rows through it.
  Element.prototype.scrollIntoView = () => {}
})

/** The full path the detail header is showing (it is an editable field). */
function shownPath(): string {
  return (document.querySelector('[data-diff-path-input]') as HTMLInputElement).value
}

/** The code view the panel is showing (the only one, while one instance is open). */
function codeBody(): HTMLElement {
  return document.querySelector('[data-diff-body]') as HTMLElement
}

/** Click one file's row in the file list, by the name it shows. */
function clickFileRow(name: string): void {
  const list = document.querySelector('[data-diff-approval-file-list]') as HTMLElement
  const row = [...list.querySelectorAll('button')].find(button => button.textContent?.includes(name))
  if (row === undefined) throw new Error(`no file row for ${name}`)
  fireEvent.click(row)
}

/**
 * jsdom has no layout, so a code view reports a zero-height box and a scrollTop
 * that cannot be set. Give every code view a 2000px scroll range in an 800px
 * viewport, with a real, writable scrollTop — what the panel's own programmatic
 * scrolls and the tests' simulated user scrolls both need.
 * @returns a restore function, for the test's `finally`.
 */
function stubCodeScroll(): () => void {
  const descriptors = {
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  }
  const stored = new WeakMap<Element, number>()
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return stored.get(this) ?? 0 },
    set(this: Element, value: number) { stored.set(this, value) },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) { return this.hasAttribute('data-diff-body') ? 2000 : 0 },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) { return this.hasAttribute('data-diff-body') ? 800 : 0 },
  })
  return () => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
      else Object.defineProperty(HTMLElement.prototype, name, descriptor)
    }
  }
}

const S1 = 'session-1' as SessionId
const FILE: PendingFileDiff = {
  id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
  oldText: 'a\n', newText: 'b\n', updatedAt: 10, missing: false, diverged: false,
  sessionIds: [S1],
}

function entry(overrides: Partial<PendingFileDiff>): PendingFileDiff {
  return {
    ...FILE, ...overrides,
    sessionIds: (overrides as Partial<{ sessionIds: SessionId[] }>).sessionIds
      ?? [overrides.sessionId ?? S1],
  }
}

type PanelProps = ComponentProps<typeof PendingPanel>

function panelProps(snapshot: PendingDiffSnapshot): PanelProps {
  return {
    wide: true,
    useSessions: (select: (state: { current: SessionId; byId: Record<string, { blank?: boolean }> }) => SessionId) =>
      select({ current: S1, byId: {} }),
    usePending: (select: (state: PendingDiffSnapshot) => PendingDiffSnapshot) => select(snapshot),
    onRefresh: vi.fn(),
    onKeep: vi.fn(async () => {}),
    onRevert: vi.fn(async () => {}),
    onBlockKeep: vi.fn(async () => {}),
    onBlockRevert: vi.fn(async () => {}),
    onOpen: vi.fn(async () => {}),
    onPreviewImage: vi.fn(async (_sessionId: SessionId, _path: string) => undefined),
    onPasteReference: vi.fn(),
    // The chat bridge, as the panel sees it: a send verb that works, and a
    // watcher the test drives to deliver an answer.
    onAskAgent: vi.fn(() => true),
    watchChat: vi.fn(() => () => {}),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onImportVcs: vi.fn(async () => ({ imported: 0, detected: false })),
    onRefreshVcs: vi.fn(async () => ({ outcome: 'refreshed' })),
    onBrowse: vi.fn(async () => ({ path: '', parent: undefined, entries: [], truncated: false })),
    onAddPath: vi.fn(async () => ({ outcome: 'added', added: 1, duplicates: 0 })),
    onKeepAll: vi.fn(async () => {}),
    onRevertAll: vi.fn(async () => {}),
    onAckRedoCleared: vi.fn(),
    collapseSidebar: vi.fn(),
    t: (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  } as unknown as PanelProps
}

describe('PendingPanel', () => {
  it('disables the pending button when no session is selected', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    props.useSessions = ((select: (state: { current: SessionId | undefined; byId: Record<string, { blank?: boolean }> }) => SessionId | undefined) =>
      select({ current: undefined, byId: {} })) as unknown as typeof props.useSessions
    const view = render(<PendingPanel {...props} />)
    const badge = document.querySelector('[data-diff-approval-badge]') as HTMLButtonElement
    expect(badge.disabled).toBe(true)
  })

  it('disables the pending button while the current session is blank (a new session being created)', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    props.useSessions = ((select: (state: { current: SessionId; byId: Record<string, { blank?: boolean }> }) => SessionId) =>
      select({ current: S1, byId: { [S1]: { blank: true } } })) as unknown as typeof props.useSessions
    const view = render(<PendingPanel {...props} />)
    const badge = document.querySelector('[data-diff-approval-badge]') as HTMLButtonElement
    expect(badge.disabled).toBe(true)
  })

  it('shows the pending count on the badge and refreshes when opened', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    const badge = screen.getByLabelText('panel.aria')
    expect(screen.getByText('1')).toBeDefined()

    fireEvent.click(badge)
    expect(props.onRefresh).toHaveBeenCalledWith(S1)
    expect(screen.getByText('panel.title')).toBeDefined()
    // No composer in jsdom: the panel keeps the fixed bottom offset.
    expect(document.querySelector('[data-diff-approval-panel]')!.style.bottom).toBe('128px')
  })

  it('opens the DSH settings dialog and switches to the plugin section', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The settings shell keeps its open state component-local, so the button
    // drives the real trigger and nav cell nodes. The test translator returns
    // the key, so the section label is 'settings.tabLabel'.
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'dialog')
    const triggerClick = vi.fn()
    trigger.addEventListener('click', triggerClick)
    document.body.appendChild(trigger)

    const navCell = document.createElement('button')
    navCell.textContent = 'settings.tabLabel'
    const navClick = vi.fn()
    navCell.addEventListener('click', navClick)
    document.body.appendChild(navCell)

    fireEvent.click(screen.getByLabelText('action.settings'))
    expect(triggerClick).toHaveBeenCalledTimes(1)
    // Handing off to settings also closes this panel.
    expect(screen.queryByText('panel.title')).toBeNull()
    // The nav-cell click happens on the next animation frame.
    await waitFor(() => { expect(navClick).toHaveBeenCalledTimes(1) })

    trigger.remove()
    navCell.remove()
  })

  it('measures the app around the conversation, resizer or not', () => {
    // The shell renders a column resizer only for an expanded column, so a
    // collapsed sidebar used to read as "nothing on that side": the panel then
    // sat over the 56px rail instead of beside it. The centre column's own box is
    // the measurement that holds either way.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scroll)
    scroll.getBoundingClientRect = () => ({
      left: 56, right: 800, width: 744, top: 96, bottom: 800, height: 704, x: 56, y: 96, toJSON: () => ({}),
    }) as DOMRect

    // No resizer and no frame marker: exactly the collapsed state.
    expect(document.querySelector('[data-side]')).toBeNull()
    expect(frameInsets()).toEqual({ top: 96, bottom: 0, left: 56, right: 400 })

    // With the app's view tabs above the conversation, that strip's top edge is
    // the boundary instead: the title row stays visible, the tabs are covered.
    const tabs = document.createElement('div')
    tabs.setAttribute('role', 'tablist')
    document.body.insertBefore(tabs, scroll)
    tabs.getBoundingClientRect = () => ({
      left: 56, right: 800, width: 744, top: 60, bottom: 96, height: 36, x: 56, y: 60, toJSON: () => ({}),
    }) as DOMRect
    expect(frameInsets().top).toBe(60)

    // Only the app's own strip counts. A tablist inside the right sidebar, one
    // inside this very panel, one that does not sit above the conversation (a
    // footer strip, or a strip the scroller precedes), and one that draws nothing
    // are all ignored. The app's own strip is taken away for that check, so a
    // candidate that wrongly counted would show its own top (2 or 4) instead of
    // falling back to the conversation body (96).
    tabs.remove()
    const strip = (parent: HTMLElement | null, after = false): HTMLElement => {
      const node = document.createElement('div')
      node.setAttribute('role', 'tablist')
      node.getBoundingClientRect = () => ({
        left: 0, right: 800, width: 800, top: 4, bottom: 40, height: 36, x: 0, y: 4, toJSON: () => ({}),
      }) as DOMRect
      if (parent === null) {
        if (after) scroll.after(node)
        else document.body.insertBefore(node, scroll)
      } else {
        parent.appendChild(node)
      }
      return node
    }
    const dockPane = document.createElement('div')
    dockPane.setAttribute('data-sidebar-right-panel', '')
    document.body.insertBefore(dockPane, scroll)
    const pluginPane = document.createElement('div')
    pluginPane.setAttribute('data-diff-approval-panel', '')
    document.body.insertBefore(pluginPane, scroll)
    const ignored = [strip(dockPane), strip(pluginPane), strip(null, true)]
    // A collapsed strip draws nothing: it cannot be the boundary either.
    const empty = strip(null)
    empty.getBoundingClientRect = () => ({
      left: 0, right: 0, width: 0, top: 2, bottom: 2, height: 0, x: 0, y: 2, toJSON: () => ({}),
    }) as DOMRect
    ignored.push(empty)
    expect(frameInsets().top).toBe(96)

    for (const node of ignored) node.remove()
    dockPane.remove()
    pluginPane.remove()
    scroll.remove()
  })

  it('sits above a docked composer seat (approval takeover included)', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scroll.appendChild(seat)
    document.body.appendChild(scroll)
    const rect = {
      top: 600, bottom: 800, height: 200, left: 0, right: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect
    seat.getBoundingClientRect = () => rect

    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // bottom = innerHeight - seatTop + gap = 800 - 600 + 12 = 212.
    expect(document.querySelector('[data-diff-approval-panel]')!.style.bottom).toBe('212px')
    scroll.remove()
  })

  it('prefers the harness-published composer height when present', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    scroll.style.setProperty('--dsh-composer-height', '150px')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scroll.appendChild(seat)
    document.body.appendChild(scroll)
    const rect = {
      top: 600, bottom: 800, height: 200, left: 0, right: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect
    seat.getBoundingClientRect = () => rect

    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Inherited height wins over the measured seat top: 150 + 12 = 162.
    expect(document.querySelector('[data-diff-approval-panel]')!.style.bottom).toBe('162px')
    scroll.remove()
  })

  it('keeps the fixed offset when the seat is not docked (hero)', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scroll.appendChild(seat)
    document.body.appendChild(scroll)
    // A centered hero seat: nowhere near the window bottom.
    const rect = {
      top: 400, bottom: 600, height: 200, left: 0, right: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect
    seat.getBoundingClientRect = () => rect

    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(document.querySelector('[data-diff-approval-panel]')!.style.bottom).toBe('128px')
    scroll.remove()
  })

  it('stays open when clicking outside the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeTruthy()

    // A working surface, not a popover: the ways out are the ✕, Escape, and the
    // quick-summon chord — never a stray press on the app behind it.
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('stays open when clicking inside the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const panel = document.querySelector('[data-diff-approval-panel]')!
    fireEvent.pointerDown(panel)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('stays open on the input card and on its seat gutter alike', () => {
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    seat.appendChild(card)
    document.body.appendChild(seat)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.pointerDown(card)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    fireEvent.pointerDown(seat)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    seat.remove()
  })

  it('stays open on the approval card and on its blank gutter alike', () => {
    const frame = document.createElement('div')
    frame.setAttribute('data-question-key', 'q-1')
    const card = document.createElement('section')
    frame.appendChild(card)
    document.body.appendChild(frame)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.pointerDown(card)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    fireEvent.pointerDown(frame)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    frame.remove()
  })

  it('stays open on the approval-key card and on its blank gutter alike', () => {
    const frame = document.createElement('div')
    frame.setAttribute('data-approval-key', 'approval-1')
    const card = document.createElement('section')
    frame.appendChild(card)
    document.body.appendChild(frame)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.pointerDown(card)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    fireEvent.pointerDown(frame)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    frame.remove()
  })

  it('closes via the header close button', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeTruthy()

    // The close button's name stays the action; its tooltip carries the two
    // chords (Escape, quick-summon). Focus shows the bubble without the hover delay.
    fireEvent.focus(document.querySelector('[data-diff-approval-close]') as HTMLElement)
    expect(screen.getByText('action.closeHint {"chord":"Ctrl+D"}')).toBeDefined()
    fireEvent.click(screen.getByLabelText('action.close'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('still toggles closed through the badge while open', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('collapses the sidebar when the modal opens (before opening)', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    expect(props.collapseSidebar).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(props.collapseSidebar).toHaveBeenCalledTimes(1)
  })

  it('shows only the current session files, not other sessions in the workspace', () => {
    const other = entry({ id: 'entry-other', sessionId: 'session-2' as SessionId, path: '/repo/other.txt' })
    const props = panelProps({ read: true, files: [other, FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('a.txt')).toBeDefined()
    expect(screen.queryByText('other.txt')).toBeNull()
    expect(screen.queryByText('panel.group.others')).toBeNull()
  })

  it('shows one row per file with its short name', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getAllByText('a.txt')).toHaveLength(1)
    expect(screen.getAllByText('b.txt')).toHaveLength(1)
  })

  it('keeps or reverts every current-session file in a single bulk call from the list footer', async () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The bulk footer drives one batched keep-all (not one call per file).
    fireEvent.click(screen.getByText('action.keepAll'))
    const keepAllMock = props.onKeepAll as unknown as { mock: { calls: unknown[][] } }
    await waitFor(() => { expect(keepAllMock.mock.calls).toHaveLength(1) })
    expect(keepAllMock.mock.calls[0]).toEqual([S1])
    expect(props.onKeep).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('action.revertAll'))
    const revertAllMock = props.onRevertAll as unknown as { mock: { calls: unknown[][] } }
    await waitFor(() => { expect(revertAllMock.mock.calls).toHaveLength(1) })
    expect(revertAllMock.mock.calls[0]).toEqual([S1])
    expect(props.onRevert).not.toHaveBeenCalled()
  })

  it('shows a keep/revert failure inline on the row and detail instead of hiding the list', () => {
    const props = panelProps({
      read: true,
      files: [FILE],
      busy: new Set(),
      failed: new Map([[FILE.id, 'revert failed: disk full']]),
    })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The list stays visible (no full error screen) and the row carries a tag.
    expect(document.querySelector('[data-diff-add]')).not.toBeNull()
    expect(screen.getByText('row.failed')).toBeDefined()

    // The detail banner under the action buttons shows the failure message.
    expect(screen.getByText('revert failed: disk full')).toBeDefined()
    expect(document.querySelector('[data-diff-action-error]')).not.toBeNull()
  })

  it('pops a toast when a keep/revert failure appears', async () => {
    const view = render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    // The file is auto-selected, so this re-click is a jump and (a single-block
    // file) toasts "only one block"; verify no FAILURE toast is up yet.
    expect(screen.queryByText('revert failed: disk full')).toBeNull()

    // A keep/revert fails: the snapshot gains the failure marker, which toasts
    // (the DSH Toast renders portaled into the body with role="alert").
    view.rerender(<PendingPanel {...panelProps({
      read: true,
      files: [FILE],
      busy: new Set(),
      failed: new Map([[FILE.id, 'revert failed: disk full']]),
    })} />)
    await waitFor(() => {
      // The re-click toast ("only one block") may already be up as another
      // alert; look for the FAILURE toast specifically.
      const alert = [...document.querySelectorAll('[role="alert"]')]
        .find(el => el.textContent?.includes('revert failed: disk full'))
      expect(alert).toBeDefined()
    })
  })

  it('says once that the pending state cannot be written to disk, and again only after the host retracts it', async () => {
    // The host attaches the failure to every list read, so the panel must not toast per
    // poll — but a reader who is never told finds the list gone after a restart with
    // nothing to explain it (issue #6). "Once" is therefore per distinct message, and
    // the host retracting the field (a write that worked) re-arms the marker.
    const t = vi.fn((key: string) => key)
    const withState = (snapshot: PendingDiffSnapshot): ReactNode => {
      const props = panelProps(snapshot)
      props.t = t as unknown as PanelProps['t']
      return <PendingPanel {...props} />
    }
    const said = (): number => t.mock.calls.filter(([key]) => key === 'panel.persistFailed').length
    const failing: PendingDiffSnapshot = {
      read: true, files: [FILE], busy: new Set(), persistError: 'ENOENT: no such file or directory',
    }

    const view = render(withState(failing))
    await waitFor(() => {
      const alert = [...document.querySelectorAll('[role="alert"]')]
        .find(el => el.textContent?.includes('panel.persistFailed'))
      expect(alert).toBeDefined()
    })
    expect(said()).toBe(1)

    // The same message arriving again — a fresh poll carrying the same failure — is the
    // same news, not a second one.
    view.rerender(withState({ ...failing }))
    await waitFor(() => expect(said()).toBe(1))

    // The disk recovers and the host drops the field; failing again afterwards is news.
    view.rerender(withState({ read: true, files: [FILE], busy: new Set() }))
    await waitFor(() => expect(said()).toBe(1))
    view.rerender(withState({ ...failing }))
    await waitFor(() => expect(said()).toBe(2))
  })

  it('always shows the short file name with the full path on hover, even when basenames collide', () => {
    const sibling = entry({ id: 'entry-dup', path: '/repo/sub/a.txt' })
    const props = panelProps({ read: true, files: [FILE, sibling], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Both rows show only the basename; the full path lives in a hover
    // tooltip and in the auto-selected detail's header.
    expect(screen.getAllByText('a.txt')).toHaveLength(2)
    expect(shownPath()).toBe(FILE.path)
    expect(screen.queryByText(sibling.path)).toBeNull()
  })

  it('tags a created file on its row and labels the whole-file button Delete, with no delete hint', () => {
    const created = entry({ id: 'entry-new', kind: 'create', oldText: '', newText: 'content', path: '/repo/new.txt' })
    const props = panelProps({ read: true, files: [created], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getByText('row.create')).toBeDefined()
    fireEvent.click(screen.getByText('new.txt'))
    // A newly-created file has nothing to "revert" to, so the whole-file action
    // is a delete, not a revert. No explanatory hint text is shown.
    expect(screen.getByText('action.delete')).toBeDefined()
    expect(screen.queryByText('panel.createHint')).toBeNull()
  })

  it('expands the whole-file diff and keeps through the owning session', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    expect(screen.getAllByText('a').length).toBeGreaterThan(0)
    expect(screen.getAllByText('b').length).toBeGreaterThan(0)

    // A whole-file keep prompts (the preference is on by default) before it
    // fires, so the file is never dropped from the list silently.
    fireEvent.click(screen.getByText('action.keep'))
    expect(document.querySelector('[data-diff-confirm-file]')).not.toBeNull()
    expect(props.onKeep).not.toHaveBeenCalled()

    fireEvent.click(document.querySelector('[data-diff-file-confirm-remove]') as HTMLButtonElement)
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id, false)
  })

  it('reverts through the owning session by id', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    fireEvent.click(screen.getByText('action.revert'))
    fireEvent.click(document.querySelector('[data-diff-file-confirm-remove]') as HTMLButtonElement)
    expect(props.onRevert).toHaveBeenCalledWith(FILE.sessionId, FILE.id, false)
  })

  it('keeps a whole-file action in the list when the prompt says so', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByText('action.keep'))
    expect(screen.getByText('panel.fileKeptAsk {"file":"a.txt"}')).toBeDefined()
    fireEvent.click(document.querySelector('[data-diff-file-confirm-keep]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-confirm-file]')).toBeNull()
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id, true)
  })

  it('asks its own question when reverting a whole file', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByText('action.revert'))
    expect(screen.getByText('panel.fileRevertedAsk {"file":"a.txt"}')).toBeDefined()
    fireEvent.click(document.querySelector('[data-diff-file-confirm-keep]') as HTMLButtonElement)
    expect(props.onRevert).toHaveBeenCalledWith(FILE.sessionId, FILE.id, true)
  })

  it('stops asking whether a file should leave the list, once the prompt is told to', () => {
    // Keeping or reverting a file asks whether the row should go, and a reader working through one
    // file's blocks answers that the same way every time. The box in the dialog is about the
    // questions STILL TO COME rather than the answer being given: the action runs as the button
    // says, and from then on the file stops asking — the row stays in the list, and the reader
    // takes it out by hand (the row's own 移出) when they are done with it.
    resetPanelMemory()
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByText('action.keep'))
    const box = document.querySelector('[data-diff-file-confirm-quiet]') as HTMLInputElement
    expect(box).not.toBeNull()
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    fireEvent.click(document.querySelector('[data-diff-file-confirm-keep]') as HTMLButtonElement)
    // The button the reader pressed is the answer to THIS question, box or no box.
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id, true)

    // The next keep on that file runs straight through — no dialog — and still leaves the row listed.
    fireEvent.click(screen.getByText('action.keep'))
    expect(document.querySelector('[data-diff-confirm-file]')).toBeNull()
    expect(props.onKeep).toHaveBeenCalledTimes(2)
    expect(props.onKeep).toHaveBeenLastCalledWith(FILE.sessionId, FILE.id, true)

    // It is the page's memory of THE SESSION's answer, not a preference of the panel's: quiet for
    // this session's file, nothing for another session's, and a fresh page asks all over again.
    expect(removalAskQuiet(S1, FILE.id)).toBe(true)
    expect(removalAskQuiet('another-session', FILE.id)).toBe(false)
    resetPanelMemory()
    expect(removalAskQuiet(S1, FILE.id)).toBe(false)
    fireEvent.click(screen.getByText('action.keep'))
    expect(document.querySelector('[data-diff-confirm-file]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-file-confirm-keep]') as HTMLButtonElement)
  })

  it('ends the selection when the press lands on a row it already covers', () => {
    // Clicking inside one's own highlight — or on the blank beside it on the same line — ends the
    // selection everywhere else. In the code view the browser keeps it there: the highlight is where
    // a drag that extends it would begin, and the blank beside it is chrome, which the browser never
    // clears a selection from. So the panel ends it itself, and the frame that acts on it goes too.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const start = rows[0]!.querySelector('[data-diff-code]')!.firstChild ?? rows[0]!
    const end = rows[1]!.querySelector('[data-diff-code]')!.firstChild ?? rows[1]!
    let collapsed = false
    const removeAllRanges = vi.fn(() => { collapsed = true })
    vi.spyOn(window, 'getSelection').mockReturnValue({
      get isCollapsed() { return collapsed },
      anchorNode: start,
      focusNode: end,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: start, startOffset: 0, endContainer: end, endOffset: 1 }),
      removeAllRanges,
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    const frame = (): HTMLElement | null => document.querySelector('[data-diff-selection-actions]')
    expect(frame()).not.toBeNull()

    // The frame is about the selection: a press on it must not drop it.
    fireEvent.mouseDown(frame() as HTMLElement)
    expect(removeAllRanges).not.toHaveBeenCalled()

    // The blank of a selected row is a press the panel ends the selection for — and the frame that
    // was acting on it goes with the selection.
    fireEvent.mouseDown(rows[1]!.querySelector('[data-diff-code]') as HTMLElement)
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(frame()).toBeNull()
  })

  it('runs a whole-file action straight through when the prompt is disabled', () => {
    localStorage.setItem('diff-approval:confirm-file-remove', '0')
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByText('action.keep'))
    expect(document.querySelector('[data-diff-confirm-file]')).toBeNull()
    // No `keepListed`: the host keeps its remove-the-file default.
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id)
  })

  it('offers 移出 instead of keep/revert once a file has nothing left to review', () => {
    // The file matches its baseline: there is nothing to accept and nothing to put back, so
    // the pair collapses into the one decision still open — whether it stays in the list.
    const settled = entry({ oldText: 'same\n', newText: 'same\n' })
    const props = panelProps({ read: true, files: [settled], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    expect(document.querySelector('[data-diff-remove]')).not.toBeNull()
    expect(screen.getByText('row.dismiss')).toBeDefined()
    expect(document.querySelector('[data-diff-keep]')).toBeNull()
    expect(document.querySelector('[data-diff-revert]')).toBeNull()

    // 移出 is a keep: the host folds the (identical) content and drops the entry, so the file
    // on disk is untouched.
    // No prompt on the way: a file with nothing left to review has nothing to ask about, so
    // the button answers `keepListed: false` (fold the content, drop the entry) itself.
    fireEvent.click(document.querySelector('[data-diff-remove]') as HTMLElement)
    expect(document.querySelector('[data-diff-confirm-file]')).toBeNull()
    expect(props.onKeep).toHaveBeenCalledWith(settled.sessionId, settled.id, false)
    expect(props.onRevert).not.toHaveBeenCalled()
  })

  it('disables the actions while an entry is busy', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set([FILE.id]) })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    // Busy keeps the buttons' labels (no flash), but still drops the clicks.
    expect(screen.getByText('action.keep')).toBeDefined()
    expect(screen.getByText('action.revert')).toBeDefined()
    fireEvent.click(screen.getByText('action.keep'))
    expect(props.onKeep).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('action.revert'))
    expect(props.onRevert).not.toHaveBeenCalled()
  })

  it('renders the empty, loading, and failed states', () => {
    const empty = render(<PendingPanel {...panelProps({ read: true, files: [], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // An already-empty list stays open with its note.
    expect(screen.getByText('panel.empty')).toBeDefined()
    empty.unmount()

    const loading = render(<PendingPanel {...panelProps({ read: false, files: [], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.loading')).toBeDefined()
    loading.unmount()

    const failed = render(<PendingPanel {...panelProps({ read: true, files: [], error: 'down', busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.readFailed {"message":"down"}')).toBeDefined()
    failed.unmount()
  })

  it('offers the import button in the empty state and reports when no VCS is found', async () => {
    const props = panelProps({ read: true, files: [], busy: new Set() })
    const importMock = props.onImportVcs as unknown as { mock: { calls: unknown[][] } }
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The empty note always offers the import button (no host probe until click).
    const button = document.querySelector('[data-diff-import-vcs]') as HTMLElement
    expect(button).not.toBeNull()

    // No VCS root: the note says so, and no refresh happened (nothing changed).
    fireEvent.click(button)
    await waitFor(() => { expect(importMock.mock.calls).toEqual([[S1, false]]) })
    expect(screen.getByText('panel.importNoVcs')).toBeDefined()
  })

  it('imports the workspace changes on click and refreshes the list', async () => {
    const props = panelProps({ read: true, files: [], busy: new Set() })
    ;(props.onImportVcs as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ imported: 2, detected: true })
    const importMock = props.onImportVcs as unknown as { mock: { calls: unknown[][] } }
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(document.querySelector('[data-diff-import-vcs]') as HTMLElement)
    await waitFor(() => {
      expect(importMock.mock.calls).toEqual([[S1, false]])
      expect(props.onRefresh).toHaveBeenCalled()
    })
    // Imported entries repopulate the list; no banner is needed.
    expect(screen.queryByText('panel.importNone')).toBeNull()
  })

  it('shows a toast when an import finds no changes to bring in', async () => {
    const props = panelProps({ read: true, files: [], busy: new Set() })
    ;(props.onImportVcs as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ imported: 0, detected: true })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(document.querySelector('[data-diff-import-vcs]') as HTMLElement)
    // The DSH Toast renders portaled into the body.
    await waitFor(() => { expect(screen.getByText('panel.importNone')).toBeDefined() })
  })

  it('offers one add button in both list states', async () => {
    // Empty list: the addition sits beside the import button.
    const empty = panelProps({ read: true, files: [], busy: new Set() })
    const emptyView = render(<PendingPanel {...empty} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-import-vcs]')).not.toBeNull()
    expect(document.querySelector('[data-diff-add]')).not.toBeNull()
    emptyView.unmount()

    // Populated list: it rides the bulk footer, past the two decisions, and the fold-away toggle is
    // the header row's own button.
    const populated = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...populated} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const footer = document.querySelector('[data-diff-add]')!.closest('div')!
    expect([...footer.querySelectorAll('button')].map(button => button.getAttribute('data-diff-add') !== null ? 'add' : button.getAttribute('data-diff-keep-all') !== null ? 'keep' : 'revert'))
      .toEqual(['keep', 'revert', 'add'])
    expect(footer.querySelector('[data-diff-file-list-float]')).toBeNull()
    expect(document.querySelector('[data-diff-file-list-float]')).not.toBeNull()
    // Add keeps its own mark and label — a third button in the decisions' row is read as a way in
    // rather than as another decision — and the row shares its width by content (`flex-basis: auto`),
    // so the longest label stays the widest button.
    expect(footer.querySelector('[data-diff-add]')?.textContent).toBe('panel.addPathGo')
    expect(footer.querySelector('[data-diff-add] svg')).not.toBeNull()
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    expect(/\.bulkActions \.action \{([^}]*)\}/.exec(css)?.[1] ?? '').toContain('flex: 1 1 auto')
    // A pixel of clearance at each side of the row (the strip's fill on the left, the toggle's 8px
    // of scroll-strip clearance plus one on the right); the strip stretches across what is left, and
    // the toggle is square at the strip's height (2px of pill padding plus the 22px tab).
    const head = /^\.listHead \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(head).toContain('margin: 8px 1px 2px 1px')
    expect(head).toContain('padding-right: 8px')
    expect(head).toContain('gap: 4px')
    expect(/^\.listTabs \{([^}]*)\}/m.exec(css)?.[1] ?? '').toContain('flex: 1 1 auto')
    const fold = /\.action\.addButton\.listFold \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(fold).toContain('width: 26px')
    expect(fold).toContain('height: 26px')
  })

  it('opens a row\'s actions on right-click, with the same pair its toolbar shows', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The browser's own menu is taken away for the press (the panel has better to offer).
    const row = screen.getByText('a.txt').closest('button') as HTMLElement
    expect(fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })).toBe(false)

    // A row with a diff offers exactly what the open file's toolbar offers…
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    expect(items.map(item => item.textContent)).toEqual(['action.keep', 'action.revert'])

    // …and the choice runs for that row's own file, without opening it.
    fireEvent.click(items[0]!)
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id)
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
  })

  it('offers 移出 from a row menu once that file has no diff left', () => {
    // The same condition the open file's toolbar uses: nothing to accept, nothing to put back,
    // so the only decision left is whether the row stays in the list.
    const settled = entry({ oldText: 'same\n', newText: 'same\n' })
    const props = panelProps({ read: true, files: [settled], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.contextMenu(screen.getByText('a.txt').closest('button') as HTMLElement, { clientX: 10, clientY: 12 })
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    expect(items.map(item => item.textContent)).toEqual(['row.dismiss'])

    fireEvent.click(items[0]!)
    expect(props.onKeep).toHaveBeenCalledWith(settled.sessionId, settled.id)
    expect(props.onRevert).not.toHaveBeenCalled()
  })

  it('scrolls only the rows: the header and the add button stay pinned', () => {
    // The tabs are a commenting affordance, so this is a panel with comment mode on.
    act(() => { setCommentModeEnabled(true) })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const scroller = document.querySelector('[data-diff-list-scroll]')
    expect(scroller).not.toBeNull()
    // The rows scroll with the scroller; the header (tabs and fold toggle) and the footer (the two
    // decisions and Add) do not.
    expect(scroller!.textContent).toContain('a.txt')
    expect(scroller!.querySelector('[data-diff-add]')).toBeNull()
    expect(document.querySelector('[data-diff-add]')!.closest('[data-diff-list-scroll]')).toBeNull()
    expect(scroller!.querySelector('[data-diff-list-tab]')).toBeNull()
    expect(document.querySelector('[data-diff-list-tab="pending"]')).not.toBeNull()
    expect(scroller!.querySelector('[data-diff-file-list-float]')).toBeNull()
    expect(document.querySelector('[data-diff-file-list-float]')).not.toBeNull()
    // Nothing to count yet: the comments tab says its name and carries no number at all.
    const tab = document.querySelector('[data-diff-list-tab="comments"]')
    expect(tab?.textContent).toBe('panel.tab.comments')
    expect(tab?.querySelector('[data-diff-list-count]')).toBeNull()
  })

  it('still lets a range be commented when the file has no change left', () => {
    // A file that matches its baseline again is all context rows — identical content diffs to every line,
    // never to an empty list — so there is nothing to keep or revert and no change block for a selection
    // to cover. The range still reads as the current file's lines, so the frame offers the comment alone:
    // keep and revert stay in the DOM with `hidden`, which is what takes them out of the layout.
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-same', path: '/repo/same.txt', oldText: 'one\ntwo\nthree\n', newText: 'one\ntwo\nthree\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('same.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(3)
    // Nothing to act on as a whole: no change block exists, so no block frame.
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()

    const cell = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const node = cell.firstChild ?? cell
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
      toString: () => 'two',
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    const comment = document.querySelector('[data-diff-selection-comment]') as HTMLElement | null
    expect(comment).not.toBeNull()
    expect(comment!.hasAttribute('hidden')).toBe(false)
    expect((document.querySelector('[data-diff-selection-keep]') as HTMLElement).hasAttribute('hidden')).toBe(true)
    expect((document.querySelector('[data-diff-selection-revert]') as HTMLElement).hasAttribute('hidden')).toBe(true)
    // …and no hairline: it separates the two groups, and only one of them is here.
    expect(document.querySelector('[data-diff-selection-divider]')).toBeNull()
  })

  it('takes a file\'s comments with it when the file leaves the list', () => {
    // A thread hangs on the rows of one file's diff. Keeping or reverting that file out of the list
    // leaves nothing for it to hang on, so its comments go with it — and the same path coming back
    // later in this visit starts with none.
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-kept', path: '/repo/kept.txt' })
    rememberDiscussions(S1, {
      [file.id]: [{
        id: 'd-kept',
        anchor: { start: 0, end: 0, startLine: 1, endLine: 1 },
        collapsed: false,
        draft: '',
        messages: [{ role: 'user', text: '这条会跟着文件一起消失' }],
      }],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    const view = render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-list-tab="comments"]')?.textContent).toBe('panel.tab.comments1')

    // An empty list that has not been READ says nothing: an unread panel — and a connection reset,
    // which publishes the same shape — must not be taken for "the reader finished with these files".
    view.rerender(<PendingPanel {...panelProps({ read: false, files: [], busy: new Set() })} />)
    expect(rememberedDiscussions(S1)[file.id]?.length).toBe(1)

    // The file leaves the list: its comments go with it, out of the memory and out of the tab (which
    // counts what it would show, so nothing left to show means no number beside its name).
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [], busy: new Set() })} />)
    expect(rememberedDiscussions(S1)[file.id]).toBeUndefined()
    expect(document.querySelector('[data-diff-list-tab="comments"] [data-diff-list-count]')).toBeNull()

    // The same path becoming pending again in this visit starts clean: the comments went with the
    // entry, so there is nothing left to re-hang on the new rows.
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    expect(document.querySelector('[data-diff-list-tab="comments"] [data-diff-list-count]')).toBeNull()
  })

  it('shows a heading instead of tabs while the pane has only one view', () => {
    // With comment mode off there are no comments to list, so the pane has one view and no switch to
    // offer: the tab row's place carries that view's own name. (The suite starts each test with the
    // mode on.)
    act(() => { setCommentModeEnabled(false) })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-list-tab]')).toBeNull()
    expect(document.querySelector('[data-diff-list-title]')?.textContent).toBe('panel.tab.pending')
    expect(document.querySelector('[data-diff-file-list-float]')).not.toBeNull()
    expect(document.querySelector('[data-diff-add]')).not.toBeNull()
  })

  it('keeps the list pane at least as wide as the footer it has to hold', () => {
    // The pane's three decisions (全部保留 / 全部回退 / 添加) are one row pinned to its bottom, and a
    // pane narrower than they need shrinks them until the labels wrap onto two lines — which is what
    // the drag floor exists to stop. Re-derived here from the CSS recipe and the REAL labels, so a
    // wider button, a bigger gap or a longer label cannot creep past the floor unnoticed.
    const sheet = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const rule = (name: string): string => new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(sheet)?.[1] ?? ''
    const paddingOf = (block: string): [number, number] => {
      const parts = (/padding:\s*([^;]+);/.exec(block)?.[1] ?? '').trim().split(/\s+/)
      const vertical = Number.parseFloat(parts[0] ?? '0')
      return [vertical, Number.parseFloat(parts[1] ?? parts[0] ?? '0')]
    }
    const action = rule('action')
    const [actionPadV, actionPadH] = paddingOf(action)
    const actionBorder = Number.parseFloat(/border:\s*([\d.]+)px/.exec(action)?.[1] ?? '0')
    const addPath = rule('addPath')
    const addIconAndGap = Number.parseFloat(/gap:\s*([\d.]+)px/.exec(addPath)?.[1] ?? '0') + 12
    const [, footerPadH] = paddingOf(rule('bulkActions'))
    const footerGap = Number.parseFloat(/gap:\s*([\d.]+)px/.exec(rule('bulkActions'))?.[1] ?? '0')
    const [, panePadH] = paddingOf(rule('fileList'))
    const paneBorder = Number.parseFloat(/border-right:\s*([\d.]+)px/.exec(rule('fileList'))?.[1] ?? '0')
    // One em per glyph: the labels are CJK, and the buttons' own text is a fixed 12px.
    const button = (text: string): number => [...text].length * 12 + 2 * actionPadH + 2 * actionBorder
    const needed = button(zh['action.keepAll'])
      + footerGap + button(zh['action.revertAll'])
      + footerGap + button(zh['panel.addPathGo']) + addIconAndGap
      + footerPadH + 2 * panePadH + paneBorder
    expect(actionPadV).toBeGreaterThan(0)
    expect(MIN_LIST_WIDTH_PX).toBeGreaterThanOrEqual(needed)
    // …and the pane opens there, rather than at a default that is under its own floor.
    expect(Number.parseFloat(/width:\s*([\d.]+)px/.exec(rule('fileList'))?.[1] ?? '0')).toBeGreaterThanOrEqual(needed)
  })

  it('lists the comments the open files carry in a second tab, and jumps to one', () => {
    // The list pane has two tabs: the pending files, and every comment the files in the list carry.
    // A comment is a block of rows in one file, so its item is the rows it hangs on, the first
    // sentence of what was asked, and — when the code under it has moved on — that it is outdated.
    // The item is a plain button rather than a selectable row: what it opens is the file, with the
    // comment landed on, so the item itself carries no selected state.
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-rows', path: '/repo/rows.txt', kind: 'create', oldText: '', newText: 'a\nb\nc\nd\ne\nf\ng\nh\n' })
    rememberDiscussions(S1, {
      [file.id]: [
        { id: 'd-eight', anchor: { start: 7, end: 7, startLine: 8, endLine: 8 }, collapsed: false, draft: '', lost: false, messages: [{ role: 'user', text: '这一行为什么要改？后面这句不该进标题。' }] },
        { id: 'd-lost', anchor: { start: 7, end: 7, startLine: 8, endLine: 8 }, collapsed: false, draft: '', lost: true, quote: 'const gone = 1', quoteLines: [{ old: 8, new: 8, side: 'add' }], messages: [{ role: 'user', text: '这段代码已经不在了' }] },
        { id: 'd-draft', anchor: { start: 7, end: 7, startLine: 8, endLine: 8 }, collapsed: false, draft: '还没发送的内容。后面的句子不算。', lost: false, messages: [] },
        { id: 'd-blank', anchor: { start: 7, end: 7, startLine: 8, endLine: 8 }, collapsed: false, draft: '', lost: false, messages: [] },
      ],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The pending list is what the pane opens on.
    expect(document.querySelector('[data-diff-list-tab="pending"]')?.getAttribute('aria-selected')).toBe('true')
    // Its sibling counts what it would show — the four threads above — as its own span, so the tab
    // row's gap is what spaces the label from the number.
    const tab = document.querySelector('[data-diff-list-tab="comments"]')
    expect(tab?.textContent).toBe('panel.tab.comments4')
    expect(tab?.querySelector('[data-diff-list-count]')?.textContent).toBe('4')
    fireEvent.click(document.querySelector('[data-diff-list-tab="comments"]') as HTMLElement)
    const items = [...document.querySelectorAll('[data-diff-comment-link]')] as HTMLElement[]
    expect(items.length).toBe(4)
    expect(items[0]!.querySelector('[data-diff-comment-label]')?.textContent).toContain(':8')
    expect(items[0]!.textContent).toContain('这一行为什么要改？')
    expect(items[0]!.textContent).not.toContain('后面这句')
    expect(items[0]!.querySelector('[data-diff-comment-lost]')).toBeNull()
    expect(items[1]!.querySelector('[data-diff-comment-lost]')).not.toBeNull()
    // A thread that has not been sent yet has no turn to quote: its draft is what the item shows, cut
    // at its own first full stop like any other title.
    expect(items[2]!.textContent).toContain('还没发送的内容。')
    expect(items[2]!.textContent).not.toContain('后面的句子')
    // …and a comment box placed and left empty has nothing to quote, so it says so instead of
    // listing as a blank line.
    expect(items[3]!.querySelector('[data-diff-comment-title]')?.textContent).toBe('panel.commentEmptyTitle')
    // Pocket's copy-file button is refused on these items, and so is its narrow-layout click guard:
    // that one swallows the press on any `button, a` whose text looks like a file path, so the item
    // is a control without being one of those elements.
    expect(items[0]!.getAttribute('data-mobile-nav-copy')).toBe('1')
    expect(items[0]!.querySelector('[data-mobile-nav="copy-file"]')).toBeNull()
    expect(items[0]!.matches('button, a')).toBe(false)
    expect(items[0]!.getAttribute('role')).toBe('button')
    // The items wear the file rows' own box, so the two lists' text shares a column.
    const sheet = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const comment = /^\.commentRow \{([^}]*)\}/m.exec(sheet)?.[1] ?? ''
    expect(comment).toContain('padding: 6px 8px')
    expect(comment).toContain('border-radius: 10px')
    expect(items[0]!.parentElement?.className).toBe(document.querySelector('[data-diff-comment-list]')?.firstElementChild?.className ?? '')

    // Clicking one lands on the comment the way a jump to a change block lands: the row is left the
    // configured lead rows below the code view's top edge. (The code view needs its scroll range:
    // jsdom has none, so the landing would clamp to zero.)
    const restore = stubCodeScroll()
    try {
      fireEvent.click(items[0]!)
      const body = document.querySelector('[data-diff-body]') as HTMLElement
      // A file created whole is one row a line, so the row the comment names is its line less one.
      expect(body.scrollTop).toBe((8 - 1 - navLeadRows()) * diffLineHeight())
    } finally {
      restore()
    }
  })

  it('ends a comment from the list, and takes its block with it', () => {
    // The list is not a read-only index: the one action a thread has (结束评论, the same row the
    // block's own ⋯ menu offers — see `discussionMenuItems`) is on the item's right-click, where the
    // file rows keep theirs. The threads belong to the file detail, which is one mount at a time, so
    // the list writes the page's memory instead of reaching into that state, and the detail reads it
    // back: the block has to go while the reader is still looking at the file.
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-end', path: '/repo/end.txt', kind: 'create', oldText: '', newText: 'a\nb\nc\nd\n' })
    rememberDiscussions(S1, {
      [file.id]: [
        { id: 'd-one', anchor: { start: 0, end: 0, startLine: 1, endLine: 1 }, collapsed: false, draft: '', lost: false, messages: [{ role: 'user', text: '第一处' }] },
        { id: 'd-two', anchor: { start: 1, end: 1, startLine: 2, endLine: 2 }, collapsed: false, draft: '', lost: false, messages: [{ role: 'user', text: '第二处' }] },
      ],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-list-tab="comments"]') as HTMLElement)
    // The file is the open one, so both threads are blocks on it, and the list holds both items.
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(2)
    const items = [...document.querySelectorAll('[data-diff-comment-link]')] as HTMLElement[]
    expect(items.map(item => item.getAttribute('data-diff-comment-link'))).toEqual(['d-one', 'd-two'])

    // The press opens the panel's own menu rather than the browser's, and it says what the block's
    // menu says: ending a comment is one action, whichever pane asks for it.
    expect(fireEvent.contextMenu(items[1]!, { clientX: 30, clientY: 40 })).toBe(false)
    const menu = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    expect(menu.map(item => item.textContent)).toEqual(['action.discussionEnd'])

    fireEvent.click(menu[0]!)
    // That one item goes, the thread leaves the page's memory, and the block left the open file with
    // it — the detail adopted the change instead of waiting for the file to be reopened.
    expect([...document.querySelectorAll('[data-diff-comment-link]')].map(item => item.getAttribute('data-diff-comment-link'))).toEqual(['d-one'])
    expect(rememberedDiscussions(S1)[file.id]?.map(entry => entry.id)).toEqual(['d-one'])
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(1)
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
  })

  it('adds the file a browse row names, and closes with a toast', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onBrowse as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      path: '/repo',
      entries: [
        { name: 'src', type: 'directory', path: '/repo/src' },
        { name: 'a.txt', type: 'file', path: '/repo/a.txt' },
      ],
      truncated: false,
    })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)

    // The root level loads once and renders as the tree's children, with the
    // file glyph on files and the folder glyph on directories.
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-select="/repo/a.txt"]')).not.toBeNull() })
    expect((props.onBrowse as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([[S1, undefined]])
    expect(document.querySelector('[data-diff-picker-row="/repo/a.txt"] [data-diff-file-icon]')).not.toBeNull()
    expect(document.querySelector('[data-diff-picker-row="/repo/src"] [data-diff-file-icon]')).toBeNull()

    // Selecting a row only fills the path box with the FULL path: nothing is
    // added by pointing.
    fireEvent.click(document.querySelector('[data-diff-picker-select="/repo/a.txt"]') as HTMLElement)
    const input = document.querySelector('[data-diff-picker-input]') as HTMLInputElement
    expect(input.value).toBe('/repo/a.txt')
    expect(document.querySelector('[data-diff-picker-row="/repo/a.txt"]')!.hasAttribute('data-selected')).toBe(true)
    expect(props.onAddPath).not.toHaveBeenCalled()

    // The button is the dialog's one action, with the box at its left, and a
    // landed add closes the dialog.
    const box = document.querySelector('[data-diff-picker-unchanged]') as HTMLInputElement
    expect(box.closest('div')).toBe(document.querySelector('[data-diff-picker-submit]')!.closest('div'))
    fireEvent.click(document.querySelector('[data-diff-picker-submit]') as HTMLElement)
    await waitFor(() => {
      expect((props.onAddPath as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([[S1, '/repo/a.txt', false]])
    })
    await waitFor(() => { expect(document.querySelector('[data-diff-path-picker]')).toBeNull() })
    expect(screen.getByText('panel.addDone {"count":1}')).toBeDefined()
    view.unmount()
  })

  it('expands directories lazily and keeps them open across a parent re-render', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    // The panel's face function takes (sessionId, path); the dialog's browse
    // target is the second argument.
    ;(props.onBrowse as unknown as { mockImplementation: (f: (sessionId: SessionId, path?: string) => Promise<unknown>) => void })
      .mockImplementation(async (_sessionId: SessionId, path?: string) => path === '/repo/src'
        ? { path: '/repo/src', entries: [{ name: 'a.ts', type: 'file', path: '/repo/src/a.ts' }], truncated: false }
        : { path: '/repo', entries: [{ name: 'src', type: 'directory', path: '/repo/src' }], truncated: false })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-toggle="/repo/src"]')).not.toBeNull() })

    // The caret opens the level (fetched on first open) without selecting it.
    fireEvent.click(document.querySelector('[data-diff-picker-toggle="/repo/src"]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-select="/repo/src/a.ts"]')).not.toBeNull() })
    expect((document.querySelector('[data-diff-picker-input]') as HTMLInputElement).value).toBe('')
    expect(document.querySelector('[data-diff-picker-row="/repo/src"]')!.hasAttribute('data-selected')).toBe(false)

    // A parent re-render hands the dialog fresh callbacks every poll: the tree
    // must keep its levels and expansion instead of bouncing back to the root.
    view.rerender(<PendingPanel {...props} />)
    expect(document.querySelector('[data-diff-picker-select="/repo/src/a.ts"]')).not.toBeNull()
    expect((props.onBrowse as unknown as { mock: { calls: unknown[][] } }).mock.calls)
      .toEqual([[S1, undefined], [S1, '/repo/src']])
  })

  it('keeps the dialog open and toasts when the path is already listed', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onAddPath as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      outcome: 'duplicate',
      added: 0,
      duplicates: 1,
    })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-input]')).not.toBeNull() })

    const input = document.querySelector('[data-diff-picker-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByText('panel.addDuplicate')).toBeDefined() })
    expect(document.querySelector('[data-diff-path-picker]')).not.toBeNull()
  })

  it('leaves no row highlighted once the path is edited by hand', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onBrowse as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      path: '/repo',
      entries: [{ name: 'a.txt', type: 'file', path: '/repo/a.txt' }],
      truncated: false,
    })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-select="/repo/a.txt"]')).not.toBeNull() })

    fireEvent.click(document.querySelector('[data-diff-picker-select="/repo/a.txt"]') as HTMLElement)
    expect(document.querySelector('[data-diff-picker-row="/repo/a.txt"]')!.hasAttribute('data-selected')).toBe(true)

    // A hand-typed path is no row's path, so the highlight clears — and the
    // typed path plus the box is what the button adds.
    const input = document.querySelector('[data-diff-picker-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'clean.txt' } })
    // Nothing in the tree matches the typed path: no row stays highlighted.
    expect(document.querySelector('[data-diff-picker-tree] [data-selected]')).toBeNull()
    expect((document.querySelector('[data-diff-picker-unchanged]') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(document.querySelector('[data-diff-picker-unchanged]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-picker-submit]') as HTMLElement)
    await waitFor(() => {
      expect((props.onAddPath as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([[S1, 'clean.txt', true]])
    })
  })

  it('closes the add dialog with Escape without closing the panel', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-picker-input]')).not.toBeNull() })

    fireEvent.keyDown(document.querySelector('[data-diff-picker-input]') as HTMLElement, { key: 'Escape' })
    await waitFor(() => { expect(document.querySelector('[data-diff-path-picker]')).toBeNull() })
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('drops the add dialog when the panel closes, so reopening starts clean', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-add]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-path-picker]')).not.toBeNull() })

    // Closing the panel closes its modal with it.
    fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-approval-panel]')).toBeNull() })

    // Reopening shows the list, not the dialog that was left behind.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    expect(document.querySelector('[data-diff-path-picker]')).toBeNull()
  })

  it('refreshes the open file from its toolbar button and reports the updated diff', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const refresh = props.onRefreshVcs as unknown as { mock: { calls: unknown[][] } }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(document.querySelector('[data-diff-refresh-vcs]') as HTMLElement)

    await waitFor(() => { expect(refresh.mock.calls.length).toBe(1) })
    expect(refresh.mock.calls[0]?.slice(0, 2)).toEqual([S1, FILE.id])
    await waitFor(() => { expect(screen.getByText('panel.refreshDone')).toBeDefined() })
  })

  it('leaves the code view where the reader scrolled it when the content changes', () => {
    // The file under review is edited again while it is open: the same pending entry, new text. The
    // reader is reading, not arriving, so the code view must stay where they scrolled it — and the
    // remembered place (a fresh showing resumes the offset it was left at) has nothing to say here.
    const before = entry({ id: 'entry-live', path: '/repo/live.txt', oldText: 'a\nb\nc\n', newText: 'A\nb\nC\n' })
    const view = render(<PendingPanel {...panelProps({ read: true, files: [before], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const restore = stubCodeScroll()
    try {
      const body = codeBody()
      body.scrollTop = 300
      fireEvent.scroll(body)
      expect(body.scrollTop).toBe(300)

      const after = entry({ id: 'entry-live', path: '/repo/live.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nD\n' })
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [after], busy: new Set() })} />)
      expect(codeBody().scrollTop).toBe(300)
    } finally {
      restore()
    }
  })

  it('keeps the reader place when the pending list blinks and the file stays open', () => {
    // A poll can report no pending files at all for a moment — the host re-capturing an entry while
    // it writes to the file — and the detail pane unmounts with the list. When the file comes back
    // with its new content the reader must be where they were, not wherever the file was first
    // landed: the file was open, and nothing about opening it has changed. The place rides the
    // page's memory (the same record a reopen resumes), which is why scrolling keeps it current.
    const before = entry({ id: 'entry-live', path: '/repo/live.txt', oldText: 'a\nb\nc\n', newText: 'A\nb\nC\n' })
    const view = render(<PendingPanel {...panelProps({ read: true, files: [before], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const restore = stubCodeScroll()
    try {
      const body = codeBody()
      body.scrollTop = 300
      fireEvent.scroll(body)
      expect(body.scrollTop).toBe(300)
      expect(panelFileOffset(S1, 'entry-live')).toBe(300)

      // The list blinks: the pane goes away, and the place has to survive it.
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [], busy: new Set() })} />)
      expect(panelFileOffset(S1, 'entry-live')).toBe(300)

      const after = entry({ id: 'entry-live', path: '/repo/live.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nD\n' })
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [after], busy: new Set() })} />)
      expect(codeBody().scrollTop).toBe(300)
    } finally {
      restore()
    }
  })

  it('disables the refresh button while the file is busy', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set([FILE.id]) })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const button = document.querySelector('[data-diff-refresh-vcs]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(props.onRefreshVcs).not.toHaveBeenCalled()
  })

  it('says why a refresh found nothing instead of blanking the diff', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onRefreshVcs as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ outcome: 'no-change' })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    fireEvent.click(document.querySelector('[data-diff-refresh-vcs]') as HTMLElement)

    // Untracked imports are off by default, so the message names that setting:
    // the entry was left exactly as it was.
    await waitFor(() => {
      expect(screen.getByText('panel.refreshNone panel.refreshUntrackedHint')).toBeDefined()
    })
  })

  it('reports a refresh that found no VCS at all', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onRefreshVcs as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ outcome: 'no-vcs' })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    fireEvent.click(document.querySelector('[data-diff-refresh-vcs]') as HTMLElement)

    await waitFor(() => { expect(screen.getByText('panel.importNoVcs')).toBeDefined() })
  })

  it('surfaces a failed refresh rather than silently doing nothing', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onRefreshVcs as unknown as { mockRejectedValueOnce: (e: unknown) => void })
      .mockRejectedValueOnce(new Error('nope'))
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    fireEvent.click(document.querySelector('[data-diff-refresh-vcs]') as HTMLElement)

    await waitFor(() => { expect(screen.getByText('panel.refreshFailed {"message":"nope"}')).toBeDefined() })
  })

  it('keeps an emptied list open instead of auto-closing', () => {
    const view = render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.title')).toBeDefined()

    view.rerender(<PendingPanel {...panelProps({ read: true, files: [], busy: new Set() })} />)
    // The emptied list stays open with its note — the panel does not auto-close.
    expect(screen.getByText('panel.empty')).toBeDefined()
    expect(screen.getByText('panel.title')).toBeDefined()
  })

  it('undoes a bulk keep-all after the list empties, through the open grace window', () => {
    vi.useFakeTimers()
    const first = panelProps({ read: true, files: [FILE], busy: new Set() })
    const second = panelProps({ read: true, files: [], busy: new Set() })
    const view = render(<PendingPanel {...first} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    view.rerender(<PendingPanel {...second} />)
    // The emptied list stays open, so the bulk decision is still undoable via
    // the panel-level Ctrl+Z handler (no file selected).
    expect(screen.getByText('panel.empty')).toBeDefined()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    const undoMock = second.onUndo as unknown as { mock: { calls: unknown[][] } }
    expect(undoMock.mock.calls).toEqual([[S1]])
    vi.useRealTimers()
  })

  it('shows the icon and the pending count as a bubble in the collapsed rail mode', () => {
    const rail = { ...panelProps({ read: true, files: [FILE], busy: new Set() }), wide: false }
    render(<PendingPanel {...rail} />)
    const badge = screen.getByLabelText('panel.aria')
    expect(badge.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('1')).toBeDefined()
    cleanup()

    const railEmpty = { ...panelProps({ read: true, files: [], busy: new Set() }), wide: false }
    render(<PendingPanel {...railEmpty} />)
    expect(screen.getByLabelText('panel.aria').querySelector('svg')).not.toBeNull()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('drags the folded card too, bounded by the box it floats in', async () => {
    // The folded list is the same list: its width is dragged by the same handler,
    // on the card's own right edge, and one state holds it — so the width set here
    // is the width the docked list takes when the window has room for it again.
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalRect = Element.prototype.getBoundingClientRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    // A 500px-wide code view: 12px inset on each side leaves the card a 476px
    // ceiling, well above the pane's own default width and below the 560px bound.
    const box = (top: number, width: number, height: number): DOMRect => ({
      left: 0, right: width, width, top, bottom: top + height, height, x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const detail = document.querySelector('[data-diff-detail]')
      if (this.hasAttribute('data-diff-body')) return box(36, 500, 364)
      if (detail !== null && (this === detail || this === detail.parentElement)) return box(0, 500, 400)
      return originalRect.call(this)
    }
    try {
      const props = panelProps({ read: true, files: [FILE], busy: new Set() })
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      // Wide window first: the docked divider is the one on screen, and no card.
      expect(document.querySelector('[data-diff-resize]')).not.toBeNull()
      expect(document.querySelector('[data-diff-float-resize]')).toBeNull()

      // Narrow now: the list moves into the card, which a fresh showing opens — and
      // the knob still folds it away and brings it back by hand.
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
        window.dispatchEvent(new Event('resize'))
      })
      const card = (): HTMLElement => document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      const handle = (): HTMLElement => document.querySelector('[data-diff-float-resize]') as HTMLElement
      const knob = (): HTMLElement => document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(card()).not.toBeNull()
      fireEvent.click(knob())
      // Folding it back draws the card into the knob's corner, so it outlives the press by
      // the length of that; the knob brings it straight back.
      expect(card()).not.toBeNull()
      await waitFor(() => { expect(card()).toBeNull() })
      fireEvent.click(knob())
      expect(card().style.width).toBe(`${MIN_LIST_WIDTH_PX}px`)
      // The grip is the card's right edge: a strip the card's own height, straddling
      // that edge, and outside the card node (the strip of scrollbar inside it stays
      // the scrollbar's). It is where the docked divider is on the docked list — the
      // edge the eye already reads as the end of the list, which is what a finger
      // reaches for.
      const cardRight = parseFloat(card().style.left) + parseFloat(card().style.width)
      expect(handle().closest('[data-diff-floating-file-list]')).toBeNull()
      expect(handle().style.height).toBe(card().style.height)
      const gripLeft = parseFloat(handle().style.left)
      const gripWidth = parseFloat(handle().style.width)
      expect(gripLeft + gripWidth).toBeGreaterThan(cardRight)
      expect(gripLeft).toBeLessThan(cardRight)
      expect(handle().style.top).toBe(card().style.top)

      // A touch drag: pointer events are what a finger produces — the synthetic
      // mousemove the handler used to wait for never arrives on a phone, which is
      // why the grip did nothing there.
      fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 1, pointerType: 'touch', isPrimary: true })
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 180, pointerId: 1 }))
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
      })
      expect(card().style.width).toBe(`${MIN_LIST_WIDTH_PX + 80}px`)

      // Past the box's right edge the drag stops at the box: the card keeps 12px
      // clear on each side rather than storing a width it cannot show.
      fireEvent.pointerDown(handle(), { button: 0, clientX: 100, pointerId: 2, pointerType: 'touch', isPrimary: true })
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, pointerId: 2 }))
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }))
      })
      expect(card().style.width).toBe('476px')

      // A drag that the browser takes over (`pointercancel`) ends there: moves
      // after it are ignored rather than dragging on.
      act(() => {
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, pointerId: 2 }))
      })
      expect(card().style.width).toBe('476px')

      // …and widening the window again hands the docked list the width just set.
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
        window.dispatchEvent(new Event('resize'))
      })
      const list = document.querySelector('[data-diff-approval-file-list]') as HTMLElement
      expect(list.style.width).toBe('476px')
    } finally {
      Element.prototype.getBoundingClientRect = originalRect
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('opens a floating list expanded, every time the panel opens', async () => {
    // The panel opens to show the list, not just the knob that reveals it. Folding it
    // away is the reader's move for that showing; the next open is a new showing.
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      const card = (): Element | null => document.querySelector('[data-diff-floating-file-list]')
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(card()).not.toBeNull()

      // Folded by hand: it is drawn into the corner first (the card is still mounted while
      // that plays), then it stays folded while the panel stays open…
      fireEvent.click(document.querySelector('[data-diff-file-list-toggle]') as HTMLElement)
      expect(card()).not.toBeNull()
      await waitFor(() => { expect(card()).toBeNull() })

      // …and the next open starts expanded again, without waiting for the knob.
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(card()).toBeNull()
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(card()).not.toBeNull()
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('opens a docked tab\'s floating list expanded once its width is known', () => {
    // A docked panel measures its own width a frame after it mounts, so the folded
    // mode is not known when the showing begins: the card opens as soon as it is,
    // rather than being missed for that whole showing.
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) { return this.hasAttribute('data-diff-approval-panel') ? 400 : 0 },
    })
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} docked dockHost={host} />)
      // 400 < 520 (the two-column floor): the list floats in this narrow column, open.
      expect(host.querySelector('[data-diff-approval-file-list]')).toBeNull()
      expect(host.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      host.remove()
    } finally {
      if (clientWidth !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
    }
  })

  it('keeps every effect\'s dependency array, and the box measure\'s in particular', () => {
    // React's "maximum update depth exceeded" names this pattern for a reason: a
    // `setState` from an effect with no dependency array, or one whose dependencies
    // change on every render. The folded list's box was measured by a
    // dependency-free layout effect, and dragging the docked panel's divider turned
    // it into a real loop — each commit scheduled another update until React gave up
    // and the panel's boundary closed the review mid-drag.
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.tsx'), 'utf8')
    expect(source).not.toMatch(/useLayoutEffect\(\(\) => \{\s*measureFloatBoxRef\.current\(\)\s*\}\)/)
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\s*measureFloatBoxRef\.current\(\)\s*\}, \[/)
  })

  it('keeps the file-list knob fully opaque, hovered or not', () => {
    // It is the only way back to the file list once the list has folded, so it does not
    // fade out when the pointer is elsewhere: no translucent rest state at all. The fill
    // is the panel's own surface in both states (the hover tint is layered over it — see
    // the test above), and the halo is what separates it from the code.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = (name: string): string => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(block('fileListKnob')).not.toContain('opacity:')
    expect(block('fileListKnob')).toContain('background: var(--dsw-alias-bg-base)')
    // Its outer glow is the heavier elevation token, not the floating chrome's own
    // `lv2`: the knob is the file list's only entry while the list is folded, and it
    // sits over the code, so it needs more halo to read as a control.
    expect(block('fileListKnob')).toContain('--dsw-elevation-prominent')
    // While the card is up it covers the knob, so the knob waits at zero; the moment it is
    // not open the knob comes in on its own animation — half a second of wait for the card
    // to leave, then 320ms of fade — with the halo riding along, since an element's own
    // opacity carries its shadow with it. An animation rather than a transition, so folding
    // and unfolding quickly cancels the fade instead of leaving it half-applied, and the
    // next fold plays it from the beginning again.
    expect(/\.fileListKnob:not\(\[data-open\]\) \{[^}]*animation: fileListKnobIn 320ms ease-in-out 500ms both/.test(css)).toBe(true)
    expect(/@keyframes fileListKnobIn \{\s*from \{\s*opacity: 0;\s*\}\s*to \{\s*opacity: 1;\s*\}\s*\}/.test(css)).toBe(true)
    expect(block('fileListKnob')).not.toContain('transition')
    expect(/\.fileListKnob\[data-open\] \{[^}]*opacity: 0/.test(css)).toBe(true)
  })

  it('animates the asking note\'s ellipsis one dot at a time', () => {
    // The note is the only thing moving while a turn runs, and three dots filling in sequence
    // say "still working" where one static glyph reads as a finished sentence. The dots are
    // spans rather than the `…` character precisely so each can carry its own delay, which is
    // what makes them a sequence — the stylesheet is the only place that lives.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    expect(/\.discussionDots > span \{[^}]*animation: discussionDot 1\.2s ease-in-out infinite/.test(css)).toBe(true)
    expect(/@keyframes discussionDot \{/.test(css)).toBe(true)
    expect(/\.discussionDots > span:nth-child\(2\) \{[^}]*animation-delay: 0\.15s/.test(css)).toBe(true)
    expect(/\.discussionDots > span:nth-child\(3\) \{[^}]*animation-delay: 0\.3s/.test(css)).toBe(true)
  })

  it('lays a quote of the code out on the file\'s own columns', () => {
    // A quote of the code no longer wears a box: it is laid out on the file's own columns, and
    // an unwrapped long line is clipped inside the quote instead of giving the thread's body a
    // horizontal scroll range (which is what dragged the block left in a narrow panel).
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    expect(/\.quoteNoWrap \.quoteText \{[^}]*white-space: pre;/.test(css)).toBe(true)
    expect(/\.quoteNoWrap \.quoteText \{[^}]*overflow: hidden;/.test(css)).toBe(true)
    expect(/\.quoteText \{[^}]*white-space: pre-wrap;/.test(css)).toBe(true)
    expect(/\.quoteLines \{[^}]*table-layout: fixed;/.test(css)).toBe(true)
    expect(/\.quoteLines \{[^}]*min-width: 0;/.test(css)).toBe(true)
  })

  it('keeps the panel\'s chrome out of a text selection, and its content in', () => {
    // Titles, buttons, hints, status lines and the list's metadata are labels, not things to copy
    // out, and a stray selection over them also wakes the browser's own selection UI. What IS
    // content stays selectable — the code, the rendered preview, the thread's own turns, the code
    // a comment quotes and the file paths (values a reader copies out by hand) — and every field
    // keeps its text, caret and selection included.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const root = /\.panel \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(root).toContain('user-select: none;')
    const content = css.slice(css.indexOf('.panel .code,')).split('}')[0] ?? ''
    for (const selector of ['.panel .code', '.panel .mdPreviewBody', '.panel .discussionUser', '.panel .discussionAnswer', '.panel .quoteText', '.panel .diffPath', '.panel .rowPath', '.panel input', '.panel textarea']) {
      expect(content).toContain(selector)
    }
    expect(content).toContain('user-select: text;')
    // Inside a thread, the diff surface's text beam is taken back — the code surface hands the
    // whole area the I-beam (see `.diffBody`) — and what a reader CAN select asks for the beam
    // again (the turns' prose and the quoted code), so the cursor agrees with the whitelist
    // instead of contradicting it; buttons carry their own pointer.
    expect(/\.discussion \{[^}]*cursor: default;/.test(css)).toBe(true)
    expect(/\.discussionUser \{[^}]*cursor: text;/.test(css)).toBe(true)
    expect(/\.discussionAnswer \{[^}]*cursor: text;/.test(css)).toBe(true)
    expect(/\.quoteText \{[^}]*cursor: text;/.test(css)).toBe(true)
    expect(/\.discussionInput \{[^}]*cursor: text;/.test(css)).toBe(true)
    // A path's own rule leaves both to the whitelist: one place lists what content is.
    expect(/\.diffPath \{[^}]*\}/.exec(css)?.[0] ?? '').not.toContain('user-select')
    expect(/\.rowPath \{[^}]*\}/.exec(css)?.[0] ?? '').not.toContain('user-select')
  })

  it('drops an outdated thread\'s button and bubble to the grey its rule already wears', () => {
    // An outdated block is kept for the reader, not for the code, so it gives up the two colours
    // that say otherwise: the brand blue of its 评论 button and the chat's bubble fill under the
    // reader's own turn. Both land on the same grey the block's rule went to.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const send = css.slice(css.indexOf('.discussion[data-lost] .discussionSend'))
    const sendRule = send.slice(0, send.indexOf('}'))
    expect(sendRule).toContain('background: var(--dsw-alias-label-secondary)')
    expect(sendRule).toContain('border-color: var(--dsw-alias-label-secondary)')
    // Hover and disabled are in the selector list: the button's own blue has rules for both, and a
    // grey button that turns blue under the pointer is worse than a blue one.
    expect(sendRule).toContain('.discussionSend:hover:not(:disabled)')
    expect(sendRule).toContain('.discussionSend:disabled')
    const bubble = css.slice(css.indexOf('.discussion[data-lost] .discussionUser'))
    expect(bubble.slice(0, bubble.indexOf('}'))).toContain('color-mix(in srgb, var(--dsw-alias-label-secondary)')
    // The header mark is gone with its key: one place says the thread is outdated, and it is the
    // label over the quote (and the block's own colour).
    expect(css).not.toContain('discussionOutdated')
  })

  it('folds the floating card away softly, toward the knob\'s corner', () => {
    // The card used to grow in on every open and vanish on the press. The entrance is gone
    // — pressing the knob puts the card there — and the exit is a gentle version of it: the
    // card gives up a few percent of its size toward the corner the knob sits in while it
    // fades, with nothing held back so neither half of it stands out. The panel holds it
    // mounted for exactly as long as that runs.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    // Comments stripped: this case asks what the rule DECLARES, and the prose around it
    // names the animations in passing.
    const block = (name: string): string => (new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(block('fileListFloat')).not.toContain('animation:')
    expect(css).not.toContain('@keyframes fileListGrow')
    expect(block('fileListFloatClosing')).toContain('fileListShrink 140ms')
    expect(block('fileListFloatClosing')).toContain('forwards')
    const shrink = /@keyframes fileListShrink \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    const frames = shrink.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(/from \{\s*opacity: 1;\s*transform: scale\(1\);\s*\}/.test(frames)).toBe(true)
    // Soft, not a collapse: a few percent, and no keyframe in between holding the fade back
    // (which is what made the earlier versions read as a lunge at the corner).
    const last = Number(/scale\(([\d.]+)\)/.exec(/to \{([^}]*)\}/.exec(frames)?.[1] ?? '')?.[1] ?? '0')
    expect(last).toBeGreaterThan(0.9)
    expect(last).toBeLessThan(1)
    expect(frames.match(/\d+% \{/g)).toBeNull()
    // The floating card has no glow of its own: the halo belongs to the knob that reveals
    // the list, and the fold shrinks toward that corner.
    expect(block('fileListFloat')).toContain('box-shadow: none')
    expect(block('fileListFloat')).toContain('transform-origin: top left')
    const panel = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.tsx'), 'utf8')
    expect(/const FILE_LIST_FOLD_MS = (\d+)/.exec(panel)?.[1]).toBe('140')
    // The heavier glow is the open-button's: while the list is up, the knob drops it, and
    // the button keeps it for the state it is actually seen in. Its fill stays the panel's
    // own neutral surface — no accent — and the glow is what marks it.
    const knob = block('fileListKnob')
    expect(knob).toContain('--dsw-elevation-prominent')
    expect(knob).toContain('background: var(--dsw-alias-bg-base)')
    expect(knob).not.toContain('business-primary')
    expect(/\.fileListKnob\[data-open\] \{[^}]*box-shadow: none/.test(css)).toBe(true)
    expect(panel).toContain('data-open={floatOpen || undefined}')
  })

  it('keeps the file-list row\'s name in step with its metadata', () => {
    // The row is a label among 11px metadata, so the code font at its own size made the
    // name the loudest thing in the list; it is a step down from that, and the row centres
    // the three things it holds rather than aligning them on the name's baseline (the tag's
    // padding above and below the text pulled it out of line).
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = (name: string): string => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(block('rowPath')).toContain('font-size: 12px')
    expect(block('rowPath')).toContain('line-height: 18px')
    expect(block('rowPath')).toContain('margin-left: 4px')
    // The row centres it: no pixel nudge of its own, which only pushed the name below the
    // metadata line it is meant to sit on.
    expect(block('rowPath')).not.toContain('top:')
    expect(block('rowPath')).not.toContain('position: relative')
    // A file name is a label, not code: it takes the app's own font rather than the code
    // block's monospace one.
    expect(block('rowPath')).not.toContain('--dsw-font-markdown-code-block')
    expect(block('rowHead')).toContain('align-items: center')
    expect(block('rowHead')).not.toContain('align-items: baseline')
    // Neither the name nor the counts carries a vertical offset: the row centres both, and a
    // shorter line box does not move the text inside it, so they already share a baseline. The
    // 1px nudges this row has carried before only pushed one of the two off that line.
    expect(block('rowMeta')).not.toContain('top:')
    expect(block('rowMeta')).not.toContain('position: relative')
  })

  it('keeps the folded list symmetric, on the scroller\'s own strip', () => {
    // The two lists hold the same rows, but their frames differ. The docked one carries an 8px
    // right padding — the same as its left — and the rows keep their 8px inside it, which lines
    // its rows, the heading's buttons and the bulk footer up at 16px. The floating card takes no
    // right padding at all, so its rows keep the same 8px and the card reads symmetric instead of
    // carrying 16px on one side and 8px on the other. The heading and the footer sit outside the
    // scroller and keep their own 8px, or they would come out flush against the border.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = (name: string): string => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const rightPadding = (name: string): string => /padding:\s*([^;]*);/.exec(block(name))?.[1]?.trim().split(/\s+/)[1] ?? ''
    expect(rightPadding('fileList')).toBe('8px')
    expect(rightPadding('fileListFloat')).toBe('0')
    expect(/padding:\s*8px 8px 0 0;/.test(block('bulkActions'))).toBe(true)
    expect(/padding-right:\s*8px;/.test(block('groupHead'))).toBe(true)
    // The rows' own inset is measured at runtime rather than declared, so nothing here may pin a
    // right padding on the scroller (see the test below).
    expect(block('listScroll')).not.toContain('padding')
    // Both dividers keep the gesture for themselves: without `touch-action: none`
    // the browser takes a finger drag as a page pan and cancels the pointer stream.
    expect(block('resizeHandle')).toContain('touch-action: none')
    expect(block('floatResizeHandle')).toContain('touch-action: none')
  })

  it('keeps the list\'s rows 8px in, whatever the platform reserves for a scrollbar', () => {
    // A classic bar is laid out in the card's own right band, so on a desktop the rows are already
    // 8px in; a platform that overlays its bars (a touch browser, macOS with "show scrollbars when
    // scrolling") reserves nothing, and the rows came out flush against the card. So the scroller
    // is padded with whatever is left of the 8px after the strip the platform actually reserved —
    // measured, not assumed. jsdom reserves nothing, so the padding is the whole 8px here.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const scroller = (): HTMLElement => document.querySelector('[data-diff-list-scroll]') as HTMLElement
    // A wide panel: the list is its own column, and its rows keep the same 8px there.
    expect(document.querySelector('[data-diff-approval-file-list]')).not.toBeNull()
    expect(scroller().style.paddingRight).toBe('8px')

    // Fold it for good: the card takes over, and the rows keep the very same inset.
    fireEvent.click(document.querySelector('[data-diff-file-list-float]') as HTMLElement)
    expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
    expect(scroller().style.paddingRight).toBe('8px')
  })

  it('reserves the scroll strip of a list that is not overflowing', () => {
    // `scrollbar-gutter: stable` is not honoured by every engine, and where it is
    // ignored — Safari before 18.2 styles this very 8px bar through the theme's
    // `::-webkit-scrollbar`, so it takes layout space all the same — a list short
    // enough to fit reserved no strip at all: the folded card's rows then sat flush
    // against its edge and the card read 8px narrower than the same card holding a
    // bar. Asking for the scrollbar is what reserves the strip in every engine.
    // Measured in a headless Chromium: three rows with `overflow-y: auto` + `stable`
    // gave an 8px strip, but with the property ignored (`auto`) 0px; `overflow-y:
    // scroll` gave 8px either way.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = (name: string): string => new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(block('listScroll')).toContain('overflow-y: scroll')
    // The add-path tree is the same scroll box one dialog over, and gets the same
    // treatment — but only vertically: a path too long for the box still asks for
    // the horizontal bar on its own.
    expect(block('tree')).toContain('overflow-y: scroll')
    expect(block('tree')).toContain('overflow-x: auto')
  })

  it('opens the panel\'s dialogs above anything it floats over the code view', () => {
    // The add-path dialog is opened from the folded file list, so its backdrop has
    // to clear the very card it was opened from (40) and that card's width grip
    // (41) — with the old layer 5 the dialog opened *underneath* the list, and the
    // same went for the confirm cards raised from a row in that list. The coverage
    // popover (50) is the last control that floats, so the dialogs clear it too;
    // only the status notice (60) and the chord's echo (80) stay above them.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const layer = (name: string): number => {
      const block = new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      return Number(/z-index:\s*(-?\d+)/.exec(block)?.[1] ?? Number.NaN)
    }
    expect(layer('confirmBackdrop')).toBeGreaterThan(layer('fileListFloat'))
    expect(layer('confirmBackdrop')).toBeGreaterThan(layer('floatResizeHandle'))
    expect(layer('confirmBackdrop')).toBeGreaterThan(layer('coverPopover'))
  })

  it('keeps what floats over the code view opaque while hovered', () => {
    // The file-list knob and the folded card's grip both sit over the code view. The
    // hover tint the app publishes is translucent — it belongs *over* a surface — so
    // painting it as the fill on its own lets the code read through the control while
    // the pointer is on it. Both layer it over an opaque surface instead.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    for (const name of ['fileListKnob', 'floatResizeHandle']) {
      // The `:hover` rule may share its block with `:focus-visible`.
      const hover = new RegExp(`\\.${name}:hover[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(hover, name).toContain('background-color: var(--dsw-alias-bg-base)')
      expect(hover, name).toContain('background-image: linear-gradient(')
    }
  })

  it('drops the path row\'s code surface when docked in the sidebar', () => {
    // Docked, the path row should read as part of the sidebar rather than as a band
    // of code surface above the diff: the card's code-block tint stays with the code,
    // and the row takes the panel's own background — which is what "transparent"
    // shows behind it, since the docked panel paints that surface over the pane.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const docked = /^\.panelDocked \.diffHeader \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(docked).toContain('background: var(--dsw-alias-bg-base)')
    // ...and only when docked: the floating card keeps one surface for header and code.
    const header = /^\.diffHeader \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(header).not.toContain('background')
  })

  it('separates the selection frame\'s two groups with a hairline', () => {
    // The frame holds keep/revert on the covered change blocks and the comment on
    // the range. The divider between them is a 1px rule stretched to the frame's
    // inner height rather than a fixed tall box, and the panel renders it only while
    // both groups are there (see the selection tests for that half).
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /^\.blockActionsDivider \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(block).toContain('width: 1px')
    expect(block).toContain('align-self: stretch')
    expect(block).toContain('background: var(--dsw-alias-border-l2)')
  })

  it('marks the commented rows in place, so the wash cannot trail the code', () => {
    // The wash rides the rows themselves: no overlay to place, so it scrolls with the code
    // in both axes with no script — the overlay this replaced had to be counter-translated
    // on every horizontal scroll and visibly trailed the text.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const tint = /^\.rowDiscussed \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(tint).toContain('background-image: linear-gradient')
    expect(tint).toContain('var(--dsw-alias-label-secondary) 14%')
    expect(css).not.toContain('.discussionBand')
  })

  it('keeps everything drawn over the code inside the code view', () => {
    // The discussion blocks, the selection band and its Keep/Revert frame, the
    // block flash, the search bar and the ruler all live in the non-scrolling
    // wrapper around the scroller, where their z-indexes used to escape to the
    // panel: a block hanging below the last visible rows drew straight over the
    // status bar and the path row. Three properties keep them where they belong —
    // the box clips them at the code view's edges, and `isolation` makes it the
    // stacking context those z-indexes are resolved in, so they can only rank
    // above the code. Each view that hosts such chrome needs all of it.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    for (const host of ['diffBodyWrap', 'splitRoot', 'mdPreviewWrap']) {
      const block = new RegExp(`^\\.${host} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
      expect(block, host).toContain('position: relative')
      expect(block, host).toContain('overflow: hidden')
      expect(block, host).toContain('isolation: isolate')
    }
  })

  it('fills what the user said with the chat\'s own bubble colour', () => {
    // A discussion reads as a small chat, so the user's turns carry the fill the
    // conversation's own bubbles use (`--dsw-specific-bubble`, the very token `ui-chat`'s
    // `.bubble` is painted with) — the token itself, not a mix of it: a bubble that is a
    // paler colour than the chat's is not the same bubble. The generic surface token this
    // started with reads as no fill at all inside the code view, which loses the "the user
    // is speaking" cue the bubble is there for.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /^\.discussionUser \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(block).toContain('background: var(--dsw-specific-bubble')
    expect(block).not.toContain('color-mix')
    // A rounded rectangle, at the panel's 8px: the bubble is the one soft shape in
    // the block, and the fill is what makes it read as "the user said this".
    expect(block).toContain('border-radius: 8px')
    // It hugs its text, sits on the RIGHT — the `auto` has to be the last of the
    // four margin values: the three-value shorthand would set the bottom margin
    // instead and leave the bubble on the left, which is where it was — and it is
    // capped at a share of the thread, so a long annotation wraps in its own column
    // instead of running the width of the block.
    expect(block).toMatch(/margin: calc\([^;]*\) auto;/)
    expect(block).toContain('width: fit-content')
    expect(block).toContain('max-width: 82%')
    // The thread carries the one side inset every turn starts from (mirrors
    // `DISCUSSION_BODY_INSET_PX` in the panel, which subtracts it before applying
    // the bubble's percentage), and no turn adds one of its own. `.discussionBody`
    // is declared twice (once with the header for the shared code font), so take
    // the rule that is the block's own box.
    const bodyRule = [...css.matchAll(/^\.discussionBody \{([^}]*)\}/gm)]
      .map(match => match[1] ?? '')
      .find(rule => rule.includes('overflow: hidden')) ?? ''
    expect(bodyRule).toContain('padding: 0 12px')
    // No vertical chrome either — a message is exactly its lines — so the whole
    // thread stays on the code's row grid (see the height test below), and the
    // transparent answer keeps no side inset of its own.
    const own = (name: string): string => new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
    // The bubble's fill is the text plus 0.2 of a row above and below, with 0.3 more
    // of a row as margin outside it: half a row per side, one whole row of height.
    // Horizontally it pads by half a row and carries no margin, so the fill stays
    // flush with the thread's right column and only the text is inset. The row is the
    // THREAD's own fixed 22px — prose, not code — so none of this follows the reader's
    // code line-height setting (mirrors `THREAD_ROW_PX` in the panel).
    expect(own('discussionUser')).toContain(
      'padding: calc(22px * 0.2) calc(22px * 0.5)',
    )
    expect(own('discussionUser')).toContain(
      'margin: calc(22px * 0.3) 0 calc(22px * 0.3) auto',
    )
    // The thread is a flex column so those margins cannot collapse into each other:
    // the row budget counts every one of them.
    expect(bodyRule).toContain('flex-direction: column')
    // The writing row is wider than the turns: a negative inline margin takes back
    // half of the thread's inset, so the field is not boxed in by the prose column.
    expect(own('discussionCompose')).toContain('margin: 0 -6px')
    expect(/padding: 0;\s/.test(own('discussionAnswer'))).toBe(true)
    expect(/padding: 0;\s/.test(own('discussionNote'))).toBe(true)
    // Nothing in the thread's prose reads the code's own variables: the whole point is that it
    // keeps its size while the code's line height and font scale move under it. The quote is the
    // exception — it IS code, and it follows both (see the outdated test).
    for (const name of ['discussionAnswer', 'discussionUser', 'discussionNote', 'discussionHead', 'discussionCompose', 'discussionInput']) {
      expect(own(name), name).not.toContain('--dsh-diff-line-height')
      expect(own(name), name).not.toContain('--dsh-diff-font-scale')
    }
    for (const name of ['quoteLines', 'quoteLine']) {
      expect(own(name), name).toContain('--dsh-diff-line-height')
    }
    // The quote pins the code's own face and base size, and the reader's scale rides the quote's
    // own rows: an unscaled `1em` would resolve against the thread's prose size instead, which is
    // the app's message text now (see below) rather than the code token's.
    expect(own('quoteLines')).toContain('font: var(--dsw-font-markdown-code-block)')
    expect(own('quoteLine')).toContain('--dsh-diff-font-scale')
    // The thread's own text IS the app's message text: the shorthand the chat's markdown body
    // wears, which is where the reader's content font size lives. The header keeps the code face
    // (its labels are a path and a range — references, not prose), and the probe span carries the
    // prose font for the canvas wrap (`threadFontOf`).
    const proseFont = /^\.discussionBody,\s*\n\.threadFontProbe \{([^}]*)\}/m.exec(css)?.[1] ?? ''
    expect(proseFont).toContain('font: var(--dsw-font-markdown-base)')
    expect(own('discussionHead')).toContain('font: var(--dsw-font-markdown-code-block)')
    // The probe shares the prose font with the body (one rule, two selectors) and adds a box that
    // cannot be seen or laid out — so it is read by the measurement and by nothing else.
    const probe = [...css.matchAll(/^\.threadFontProbe \{([^}]*)\}/gm)]
      .map(match => match[1] ?? '')
      .join('\n')
    expect(probe).toContain('position: absolute')
    expect(probe).toContain('width: 0')
    expect(probe).toContain('visibility: hidden')
    // The "older turns omitted" line is quieter than a status note: it is about the
    // thread's length, not about the turn, so it sits one label lighter.
    const noteColor = /color: ?([^;]+);/.exec(own('discussionNote'))?.[1]?.trim()
    const hiddenColor = /\.discussionNote\[data-diff-discussion-hidden\] \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(hiddenColor).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(hiddenColor).not.toContain(noteColor ?? 'never')
  })

  it('sizes the writing field and its button like the toolbar\'s own buttons', () => {
    // The field and 评论 should be one toolbar button tall — the same 26px chrome the
    // selection frame's 保留 uses — so the writing row does not read as a different
    // control family. That height is the `.action` recipe (vertical padding + line,
    // plus the 1px borders), and neither control is stretched to fill the row: the
    // leftover of the two-row area is the space they are centred in.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const rule = (name: string): string => new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
    const vertical = (block: string): string => /padding:\s*([^;]*);/.exec(block)?.[1]?.trim().split(/\s+/)[0] ?? ''
    const line = (block: string): string => /line-height:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? ''
    const action = rule('action')
    const input = rule('discussionInput')
    expect(action).not.toBe('')
    expect(vertical(input)).toBe(vertical(action))
    expect(line(input)).toBe(line(action))
    expect(input).toContain('box-sizing: border-box')
    expect(input).not.toContain('height: 100%')
    // The button reaches that height by itself: nothing stretches it to the row.
    expect(rule('discussionSend')).not.toContain('align-self: stretch')
    // ...and all three state the number outright, so nothing here depends on the recipe coming out
    // at 26px for one control and 27px for the other.
    expect(input).toContain('height: 26px')
    expect(rule('discussionSend')).toContain('height: 26px')
    // ...and the row is still exactly two THREAD rows (fixed, not the code's), with no padding
    // of its own, and the pair is bottom-aligned: the field and the button end where the block
    // does, so the row's slack reads as the gap under the last turn instead of a band under
    // the box.
    const compose = rule('discussionCompose')
    expect(compose).toContain('height: calc(22px * 2)')
    expect(compose).toContain('align-items: flex-end')
    // The pair stops a third of a row above the block's bottom edge, so the writing row does not
    // end on the controls' own edge — and the two rows of the band are unchanged (padding, not
    // margin), so the count the block reserved still matches what it draws.
    expect(compose).toContain('padding: 0 0 calc(22px * 0.3)')
    // The reserved rows can come out one row longer than the turns draw (the row count is
    // measured on canvas, with a character of slack). That spare row must not sit below the
    // field, so the block puts a spacer above the writing row and lets it take the air — capped
    // at exactly one row. An auto top margin on the row used to take ALL of it, so a block that
    // over-measured by more than the documented slack opened a hole between what the thread says
    // and where the reader writes; whatever is left over now stays under the writing row, at the
    // block's bottom edge.
    expect(compose).not.toContain('margin-top: auto')
    const slack = rule('discussionSlack')
    expect(slack).toContain('flex: 1 1 0')
    expect(slack).toContain('max-height: 22px')
    expect(slack).toContain('min-height: 0')
  })

  it('points a comment at the skill when the host can deliver it', () => {
    // With the capability the prompt is the marker, the question and a pointer: the rules
    // live in the skill (and in the summary its catalogue shows), so a long rule stops
    // riding every comment. Without it the same rules ride the message — which is why the
    // panel asks the host instead of guessing.
    const askPrompt = (snapshot: PendingDiffSnapshot): string => {
      const props = panelProps(snapshot)
      const view = render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('m.txt'))
      const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
      const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
      fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
      fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
      fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
      const prompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? ''
      view.unmount()
      return prompt
    }
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })

    const withSkill = askPrompt({ read: true, files: [multi], busy: new Set(), commentSkill: 'dsh-diff-approval-comment' })
    expect(withSkill.startsWith('discussion.marker (/repo/m.txt:4)\nwhy?')).toBe(true)
    // The stub translator returns the key plus its parameters, so the pointer shape is
    // recognisable — and the long rules are NOT in the message.
    expect(withSkill).toContain('discussion.promptRuleSkill {"skill":"dsh-diff-approval-comment"}')
    expect(withSkill.endsWith('discussion.promptRule')).toBe(false)

    // The second case asks on a fresh page: threads now outlive a mount (see the page's
    // memory), and what is under test here is the prompt's shape rather than persistence.
    resetPanelMemory()
    const withoutSkill = askPrompt({ read: true, files: [multi], busy: new Set() })
    expect(withoutSkill.endsWith('discussion.promptRule')).toBe(true)
    expect(withoutSkill).not.toContain('promptRuleSkill')
  })

  it('shows the return glyph on the comment button, so Enter is discoverable', () => {
    // Enter in the input sends the comment; the button that does the same click is
    // where that shortcut is announced. jsdom renders the markup but no stylesheet,
    // so the presence of the glyph is the assertion, and the module is read for the
    // flex row that keeps the label and the glyph on one line.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[0]!.querySelector('[data-diff-code]')?.firstChild ?? rows[0]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const send = document.querySelector('[data-diff-discussion-send]') as HTMLButtonElement
    expect(send.querySelector('svg')).not.toBeNull()
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /\.discussionSend \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('display: inline-flex')
    expect(block).toContain('white-space: nowrap')
  })

  it('pins a block sideways with a zero-width sticky box instead of a transform', () => {
    // The whole point of the row-mounted block: `sticky` holds the panel's left edge while
    // the code slides sideways, on the compositor, so no scroll event has to write a
    // transform. Zero-sized, or the `max-content` table would widen the diff to the
    // panel's width and the pin would have no slack left to move in.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const pin = /\.discussionPin \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(pin).toContain('position: sticky')
    expect(pin).toContain('left: 0')
    expect(pin).toContain('width: 0')
    expect(pin).toContain('height: 0')
    const row = /\.discussionRow \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(row).toContain('display: table-row')
    // The colour lives on the row, not on the block: the thread is a band across the code
    // (the surface the rows around it are painted on) rather than a panel laid over it.
    expect(row).toContain('background: var(--dsw-alias-bg-base)')
    // The block itself is absolute, so it fills the pin's own (zero-width) column: its
    // width comes from the render, and the previous row-offset/translate pair is gone.
    const block = /\.discussion \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('position: absolute')
    expect(block).toContain('top: 0')
    expect(block).toContain('left: 0')
    expect(block).toContain('background: transparent')
  })

  it('resizes the file list by dragging the divider within its bounds', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const list = document.querySelector('[data-diff-approval-file-list]') as HTMLElement
    const handle = document.querySelector('[data-diff-resize]') as HTMLElement
    // It opens at the floor: the width its bulk footer needs for three labels on one line.
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX}px`)

    // A mouse drag, which is the same pointer stream a mouse produces.
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1, pointerType: 'mouse', isPrimary: true })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 180, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    })
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX + 80}px`)

    // Clamped at both ends on an extreme drag.
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 2, pointerType: 'mouse', isPrimary: true })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, pointerId: 2 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    })
    expect(list.style.width).toBe('560px')

    // A secondary button (a right-click) does not start a drag.
    fireEvent.pointerDown(handle, { button: 2, clientX: 100, pointerId: 3 })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, pointerId: 3 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3 }))
    })
    expect(list.style.width).toBe('560px')

    // …and the floor it clamps to is the width the bulk footer's three labels need on one line, so
    // the footer can never be dragged into wrapping them.
    fireEvent.pointerDown(handle, { button: 0, clientX: 400, pointerId: 4, pointerType: 'mouse', isPrimary: true })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, pointerId: 4 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4 }))
    })
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX}px`)
  })

  it('applies one list width per animation frame while the divider is dragged', async () => {
    // A mouse reports far more often than the screen draws. Each event re-renders the list — and,
    // with wrap on, re-wraps the whole code view — so the events of one frame are folded into the
    // frame's own render, which takes the position the pointer ended the frame at.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const list = document.querySelector('[data-diff-approval-file-list]') as HTMLElement
    const handle = document.querySelector('[data-diff-resize]') as HTMLElement
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX}px`)
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1, pointerType: 'mouse', isPrimary: true })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 180, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 220, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 260, pointerId: 1 }))
    })
    // Three events, no frame yet: nothing has been rendered.
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX}px`)
    // Then the frame lands the last of them, not the first.
    await act(async () => { await new Promise(resolve => { requestAnimationFrame(() => { resolve(undefined) }) }) })
    expect(list.style.width).toBe(`${MIN_LIST_WIDTH_PX + 160}px`)
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })) })
  })

  it('re-measures the code box when the view mode changes', () => {
    // Leaving the split view mounts a fresh scroller. Its width is what wrapped line heights
    // are computed against, and it used to be measured only for the file, the wrap toggle
    // and the preview — so a wrap switched on while the split view was up measured no box at
    // all, and coming back to one column wrapped against the figure that was left (zero, for
    // a file opened in split mode): the setting was on and nothing wrapped.
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.tsx'), 'utf8')
    const marker = source.indexOf('setHScrollbarPx(Math.max(0, body.offsetHeight - body.clientHeight))')
    expect(marker).toBeGreaterThan(0)
    const tail = source.slice(marker, marker + 500)
    const deps = tail.slice(tail.indexOf('}, ['))
    expect(deps.slice(0, deps.indexOf(')'))).toContain('splitView')
  })

  it('keeps the code\'s own scroll from rubber-banding on a touch screen', () => {
    // The panel is a fixed overlay: a bounce at the code's edge reads as the whole panel (and
    // the rows under it) sliding. Every scroller that holds the code or a preview of it opts
    // out; the list, the dialogs and the panel's own states are chrome and keep the platform's
    // own feel. jsdom applies no stylesheet, so this reads the module the panel ships.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = (name: string): string => new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
    // The panel's own scrollers — the code's, and the preview's — have nothing behind them, so
    // they take no rubber-band at their edges.
    for (const name of ['diffBody', 'mdPreviewBody']) {
      expect(block(name), name).toContain('overscroll-behavior: none')
    }
    // A NESTED scroller may only opt out of the axis it actually scrolls, because the property
    // covers both: `none` on an axis with nothing to scroll swallows the wheel, and the scroller
    // around it never moves. The fenced code in a preview is x-only (it grows, it never scrolls
    // down); so is the split view's pinned strip.
    expect(/\.mdPreviewBody pre \{([^}]*)\}/.exec(css)?.[1] ?? '').toContain('overscroll-behavior-x: none')
    expect(/\.splitHScroll \{([^}]*)\}/.exec(css)?.[1] ?? '').toContain('overscroll-behavior-x: none')
    // The settings preview is a vertical scroller nested in the scrolling settings page: it keeps
    // the browser's own chaining, or the page stops scrolling under the pointer.
    expect(block('diffPreviewScroll')).not.toContain('overscroll-behavior')
    // The file list is chrome, not the code, and keeps the platform's own feel.
    expect(block('listScroll')).not.toContain('overscroll-behavior')
  })

  it('wears the label\'s clothes as an editable field, and scrolls itself', () => {
    // The header's path is an input: a field scrolls its own content to the caret, which is
    // exactly what this row's hand-rolled horizontal pan used to do — so the overflow and
    // hidden-scrollbar treatment is gone, and the field keeps the label's look (no box, no
    // fill, the app's font, the same inset). jsdom applies no stylesheet, so this reads the
    // module the panel ships.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /\.diffPath \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).not.toContain('overflow-x: auto')
    expect(block).not.toContain('scrollbar-width')
    expect(css).not.toMatch(/\.diffPath::-webkit-scrollbar/)
    // It looks like the label it replaced: no platform box, no fill, no ring — and the same
    // inherited family at the same line as the text that used to sit here.
    expect(block).toContain('appearance: none')
    expect(block).toContain('border: 0')
    expect(block).toContain('background: transparent')
    expect(block).toContain('font: inherit')
    expect(block).toContain('font-size: 12px')
    expect(block).toContain('line-height: 18px')
    expect(css).toMatch(/\.diffPath:focus \{\s*outline: none;?\s*\}/)
    // It reads the app's own font like the file list's rows do, rather than the code
    // block's monospace one: a path is a label wherever it shows up, inset off the edge
    // the same way.
    expect(block).not.toContain('--dsw-font-markdown-code-block')
    expect(block).toContain('margin-left: 4px')
    expect(block).toContain('top: 1px')
  })

  it('opens or reveals the selected file through the header icon buttons', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(screen.getByLabelText('action.openFile'))
    expect(props.onOpen).toHaveBeenCalledWith(FILE.sessionId, FILE.id, 'open')
    fireEvent.click(screen.getByLabelText('action.revealFile'))
    expect(props.onOpen).toHaveBeenCalledWith(FILE.sessionId, FILE.id, 'reveal')
  })

  it('opens the panel and selects the file from a produced-file open event', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    // The panel is closed before the event, so no diff is mounted yet.
    expect(document.querySelector('[data-diff-approval-diff]')).toBeNull()

    act(() => {
      window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/a.txt' } }))
    })
    await waitFor(() => { expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull() })
  })

  it('toasts when a produced-file open event names a file no longer pending', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)

    act(() => {
      window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/gone.ts' } }))
    })
    await waitFor(() => {
      expect(screen.getAllByText('panel.fileNotPending').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('records the docked tab\'s place as its tab closes', () => {
    // The docked panel's "close" is its tab closing, which unmounts this instance:
    // that closer has to remember the place like the overlay's ✕ does, even though
    // it runs as the panel's own tree is going away.
    const restore = stubCodeScroll()
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const view = render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} docked dockHost={host} />)
      codeBody().scrollTop = 320
      view.unmount()
      expect(lastPanelFile(S1)).toBe('entry-1')
      expect(panelFileOffset(S1, 'entry-1')).toBe(320)
      host.remove()
    } finally {
      restore()
    }
  })

  it('names a file for the docked tab as well, from a produced-file chip', () => {
    // The docked panel is its own mount: the chip's ask reaches it as an event, so
    // "查看差异" works wherever the panel is showing, not only in the overlay.
    const second = entry({ id: 'entry-b', path: '/repo/b.txt' })
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(<PendingPanel {...panelProps({ read: true, files: [FILE, second], busy: new Set() })} docked dockHost={host} />)
    expect((host.querySelector('[data-diff-path-input]') as HTMLInputElement).value).toBe('/repo/a.txt')

    act(() => {
      window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/b.txt' } }))
    })
    expect(lastPanelFile(S1)).toBe('entry-b')
    expect((host.querySelector('[data-diff-path-input]') as HTMLInputElement).value).toBe('/repo/b.txt')
    host.remove()
  })

  it('opens a path typed into the header field, adding that file to the list first', async () => {
    const added = entry({ id: 'entry-new', path: '/repo/new.txt', oldText: 'x\n', newText: 'y\n' })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onAddPath as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ outcome: 'added', added: 1, duplicates: 0, id: added.id })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const field = document.querySelector('[data-diff-path-input]') as HTMLInputElement
    expect(field.value).toBe(FILE.path)
    fireEvent.change(field, { target: { value: '/repo/new.txt' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    // One exact file, always including a clean one — the field is for opening a file, and a
    // file with no diff is still a file to review.
    await waitFor(() => {
      expect((props.onAddPath as unknown as { mock: { calls: unknown[][] } }).mock.calls)
        .toEqual([[S1, '/repo/new.txt', true, true]])
    })

    // The panel asks for the list at once: the id the host answered with is only selectable once
    // its own list holds it, and the field is a way to open a file now — not a poll from now.
    expect(props.onRefresh).toHaveBeenCalledWith(S1)

    // The entry shows up in the list a poll later; the field's file is selected then, and the
    // field shows that file's own path.
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [FILE, added], busy: new Set() })} />)
    await waitFor(() => { expect(shownPath()).toBe('/repo/new.txt') })
  })

  it('puts the shown path back when the typed one cannot be opened', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onAddPath as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ outcome: 'missing', added: 0, duplicates: 0 })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const field = document.querySelector('[data-diff-path-input]') as HTMLInputElement
    fireEvent.change(field, { target: { value: '/repo/nope.txt' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    // Nothing was added, so the field falls back to the file that is open, which stays open.
    await waitFor(() => { expect(shownPath()).toBe(FILE.path) })
    expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull()
  })

  it('keeps the header field\'s Escape to itself, so the review stays up', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const field = document.querySelector('[data-diff-path-input]') as HTMLInputElement
    fireEvent.change(field, { target: { value: '/repo/other.txt' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    // The draft goes and the shown path comes back; the panel's own Escape (which closes the
    // whole review) never sees the press.
    expect(shownPath()).toBe(FILE.path)
    expect(props.onAddPath).not.toHaveBeenCalled()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('auto-selects the first pending file and advances to the next after handling', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The first file opens automatically.
    expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull()
    expect(shownPath()).toBe('/repo/a.txt')

    // Handling it removes it; the next file takes its place.
    fireEvent.click(screen.getByText('action.keep'))
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [second], busy: new Set() })} />)
    expect(shownPath()).toBe('/repo/b.txt')
  })

  it('reopens on the file it was closed on, at the offset it was left', () => {
    // Closing the panel is not "done reviewing": the next open resumes the file
    // and the place. Both are remembered for this page's lifetime only.
    const restore = stubCodeScroll()
    try {
      const second = entry({ id: 'entry-b', path: '/repo/b.txt' })
      render(<PendingPanel {...panelProps({ read: true, files: [FILE, second], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      clickFileRow('b.txt')
      expect(shownPath()).toBe('/repo/b.txt')
      codeBody().scrollTop = 640

      fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)
      expect(document.querySelector('[data-diff-approval-diff]')).toBeNull()

      fireEvent.click(screen.getByLabelText('panel.aria'))
      // The same file, at the same offset — not the first change of the list's
      // first file, and not the first change of this one.
      expect(shownPath()).toBe('/repo/b.txt')
      expect(codeBody().scrollTop).toBe(640)
    } finally {
      restore()
    }
  })

  it('survives every state a produced-file chip can open it in', () => {
    // A crash inside a slot entry retires it for the rest of the page (the
    // renderer's boundary abdicates it), which shows up as "the panel will not
    // open until a refresh". So the chip's path is exercised through a boundary
    // that records instead of swallowing, across the states it can land in: a
    // file of another session, a file that is gone, a docked and a floating
    // instance at once, and the split and preview views.
    const caught: string[] = []
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false }
      static getDerivedStateFromError(error: unknown): { failed: boolean } {
        caught.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        return { failed: true }
      }
      override render(): ReactNode { return this.state.failed ? null : this.props.children }
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mine = entry({ id: 'entry-1', path: '/repo/a.txt' })
    const theirs = entry({ id: 'entry-other', path: '/repo/other.txt', sessionId: 'session-2' as SessionId })
    const gone = entry({ id: 'entry-gone', path: '/repo/gone.txt' })
    const props = () => panelProps({ read: true, files: [mine, theirs], busy: new Set() })

    render(<Boundary><PendingPanel {...props()} /></Boundary>)
    const openFile = (path: string): void => {
      act(() => {
        window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path } }))
      })
    }

    // Closed, floating: a pending file of this session opens the panel on it.
    openFile('/repo/a.txt')
    expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull()
    // The same file again (the chip re-click): still fine.
    openFile('/repo/a.txt')
    // A file only another session has pending: the panel still opens, on what it
    // can show, rather than throwing over a file it does not list.
    openFile('/repo/other.txt')
    // A file that is no longer pending at all: a toast, not a crash.
    openFile('/repo/gone.txt')
    act(() => {
      window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/gone.txt' } }))
    })
    expect(caught).toEqual([])

    // Docked and floating at once, with a file this session does not list.
    cleanup()
    render(<Boundary><PendingPanel {...props()} /></Boundary>)
    render(<Boundary><PendingPanel {...props()} docked dockHost={host} /></Boundary>)
    openFile('/repo/other.txt')
    openFile('/repo/a.txt')
    expect(caught).toEqual([])

    // Split view, then the Markdown preview, then a chip click in each.
    cleanup()
    localStorage.setItem('diff-approval:split-mode', '1')
    render(<Boundary><PendingPanel {...props()} /></Boundary>)
    openFile('/repo/a.txt')
    cleanup()
    localStorage.setItem('diff-approval:split-mode', '0')
    localStorage.setItem('diff-approval:md-preview', '1')
    render(<Boundary><PendingPanel {...panelProps({ read: true, files: [entry({ id: 'entry-md', path: '/repo/README.md', oldText: '# T\n', newText: '# T\n\nNew\n' })], busy: new Set() })} /></Boundary>)
    openFile('/repo/README.md')
    expect(caught).toEqual([])
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    host.remove()
  })

  it('lands the chip\'s jump on the file\'s first change, not where it was left', () => {
    // The chip's arrow says "show me this diff": it opens the file at its first
    // change, wherever the reader had left it — and clicking it again for the file
    // already open lands there again instead of doing nothing.
    const restore = stubCodeScroll()
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      codeBody().scrollTop = 640
      fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)
      // The reader's place is remembered by the close…
      expect(panelFileOffset(S1, 'entry-1')).toBe(640)

      // …and the chip ignores it: the file's first change is at the top.
      act(() => {
        window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/a.txt' } }))
      })
      expect(shownPath()).toBe('/repo/a.txt')
      expect(codeBody().scrollTop).toBe(0)
      // The stale place is gone — the jump was not a resume — and what the memory holds now is where
      // the jump left the reader: it is their position in the file, which is also what a pane that
      // mounts again resumes, so a jump is not undone by the next poll.
      expect(panelFileOffset(S1, 'entry-1')).toBe(0)

      // Scrolled away again, the same chip click lands on the first change again.
      codeBody().scrollTop = 500
      act(() => {
        window.dispatchEvent(new CustomEvent('diff-approval:open-file', { detail: { path: '/repo/a.txt' } }))
      })
      expect(codeBody().scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('hands the remembered place to the docked tab, which resumes it', () => {
    // The floating overlay and the docked tab are separate mounts of one panel:
    // the presentation switch must not lose the reader's place.
    const restore = stubCodeScroll()
    try {
      const second = entry({ id: 'entry-b', path: '/repo/b.txt' })
      const files = [FILE, second]
      render(<PendingPanel {...panelProps({ read: true, files, busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      clickFileRow('b.txt')
      codeBody().scrollTop = 480
      fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)

      const host = document.createElement('div')
      document.body.appendChild(host)
      render(<PendingPanel {...panelProps({ read: true, files, busy: new Set() })} docked dockHost={host} />)
      // The tab's body resumes the file — and selects one at all, which it never
      // used to do — and scrolls it to the remembered offset.
      expect((host.querySelector('[data-diff-path-input]') as HTMLInputElement).value).toBe('/repo/b.txt')
      expect(codeBody().scrollTop).toBe(480)
      host.remove()
    } finally {
      restore()
    }
  })

  it('lands a hand-picked file on its first change, not where it was left', () => {
    // The remembered offset is for reopening, not for browsing: a file the reader
    // picks from the list opens at its first change.
    const restore = stubCodeScroll()
    try {
      const second = entry({ id: 'entry-b', path: '/repo/b.txt' })
      const files = [FILE, second]
      render(<PendingPanel {...panelProps({ read: true, files, busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      // Give b.txt a remembered offset, then reopen onto it.
      clickFileRow('b.txt')
      codeBody().scrollTop = 640
      fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(codeBody().scrollTop).toBe(640)

      // Now pick the other file by hand: the file changed, so it opens at its
      // first change (a.txt's sits at the top) rather than at b.txt's offset.
      clickFileRow('a.txt')
      expect(shownPath()).toBe('/repo/a.txt')
      expect(codeBody().scrollTop).toBe(0)
    } finally {
      restore()
    }
  })

  it('cycles the pending files with Ctrl+Tab and Ctrl+Shift+Tab', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Auto-selects the first file (a.txt).
    expect(shownPath()).toBe('/repo/a.txt')

    // Ctrl+Tab advances to the next file (b.txt).
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true })
    expect(shownPath()).toBe('/repo/b.txt')

    // Ctrl+Shift+Tab returns to the previous file (a.txt).
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(shownPath()).toBe('/repo/a.txt')
  })

  it('toggles the panel with the quick-summon chord and closes with Escape', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)

    // Closed initially.
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()

    // Ctrl+D (the default chord) opens it.
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // Ctrl+D closes it again.
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()

    // Escape closes it too.
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('quick-summons even when focus is in an input or the composer', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()

    // Ctrl+D works with the cursor in a text input.
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'd', ctrlKey: true })
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    input.remove()

    // And with the cursor in the composer (a contenteditable surface).
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    document.body.appendChild(composer)
    fireEvent.keyDown(composer, { key: 'd', ctrlKey: true })
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    composer.remove()
  })

  it('cannot be deselected by clicking the selected row again', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(screen.getByText('a.txt'))
    expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull()
  })

  it('shows the per-file line change counts on each row', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt', oldText: 'x\n', newText: 'x\ny\nz\n' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getAllByText('row.added {"added":1}')).toHaveLength(1)
    expect(screen.getAllByText('row.removed {"removed":1}')).toHaveLength(1)
    expect(screen.getAllByText('row.added {"added":2}')).toHaveLength(1)
    expect(screen.getAllByText('row.removed {"removed":0}')).toHaveLength(1)
  })

  it('asks whether to remove a file when its last block is kept or reverted', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!)
    fireEvent.click(document.querySelector('[data-diff-block-keep]') as HTMLElement)

    // The single-block action prompts rather than resolving silently, and the
    // block RPC has not fired yet (its `removeWhenResolved` rides the choice).
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()
    expect(screen.getByText('panel.resolvedAsk {"file":"a.txt"}')).toBeDefined()
    expect(props.onBlockKeep).not.toHaveBeenCalled()

    // "Keep in list" runs the action without removing the file.
    fireEvent.click(document.querySelector('[data-diff-confirm-keep]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-confirm]')).toBeNull()
    expect(props.onBlockKeep).toHaveBeenCalledWith(S1, FILE.id, { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }, false)
  })

  it('removes the file when the confirm dialog is accepted', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!)
    fireEvent.click(document.querySelector('[data-diff-block-keep]') as HTMLElement)
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()

    fireEvent.click(document.querySelector('[data-diff-confirm-remove]') as HTMLButtonElement)
    expect(props.onBlockKeep).toHaveBeenCalledWith(S1, FILE.id, { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }, true)
    expect(document.querySelector('[data-diff-confirm]')).toBeNull()
  })

  it('runs a last-block action straight through for a file that is not to be asked about', () => {
    // The same box the whole-file dialog carries, on the dialog a block action raises: one answer
    // per file is enough, and the file keeps its row until the reader takes it out.
    resetPanelMemory()
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const block = { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!)
    fireEvent.click(document.querySelector('[data-diff-block-keep]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-confirm-quiet]') as HTMLInputElement)
    fireEvent.click(document.querySelector('[data-diff-confirm-keep]') as HTMLButtonElement)
    expect(props.onBlockKeep).toHaveBeenLastCalledWith(S1, FILE.id, block, false)

    // The same action on the same file again: no dialog, and the row is left in the list again.
    const again = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(again[0]!)
    fireEvent.click(document.querySelector('[data-diff-block-keep]') as HTMLElement)
    expect(document.querySelector('[data-diff-confirm]')).toBeNull()
    expect(props.onBlockKeep).toHaveBeenCalledTimes(2)
    expect(props.onBlockKeep).toHaveBeenLastCalledWith(S1, FILE.id, block, false)
    resetPanelMemory()
  })

  it('wraps to the first change when the last block is handled and others are still pending', async () => {
    // Handling a block takes it out of the diff, so the change that followed it slides into the slot it
    // held — which is why the panel focuses that same index afterwards. At the END of the diff there is no
    // such change: everything still pending is above the reader, so the walk wraps to the first one, the
    // same wrap the prev/next stepping does. Without it the focus pointed past the shorter diff and
    // nothing was focused, flashed or scrolled at all.
    const file = entry({ id: 'entry-wrap', path: '/repo/wrap.txt', oldText: 'a\nb\nc\nd\ne\nf\n', newText: 'A\nb\nC\nd\nE\nf\n' })
    // Keeping the last change adopts it into the baseline, which leaves the two above it pending.
    const after = entry({ id: 'entry-wrap', path: '/repo/wrap.txt', oldText: 'a\nb\nc\nd\nE\nf\n', newText: 'A\nb\nC\nd\nE\nf\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = { rerender: (_node: ReactNode): void => {} }
    props.onBlockKeep = vi.fn(async () => {
      // The host's rewrite lands while the action is still in flight — the order the store produces, since
      // it re-reads the list before its promise resolves. That is what makes the shorter diff a fact the
      // continuation can see.
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [after], busy: new Set() })} />)
    })
    const restore = stubCodeScroll()
    try {
      view.rerender = render(<PendingPanel {...props} />).rerender
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('wrap.txt'))

      // Three change blocks, and the reader acts on the last one.
      const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
      const lastChange = rows.find(row => (row.querySelector('[data-diff-code]')?.textContent ?? '') === 'E')
      expect(lastChange).toBeDefined()
      fireEvent.mouseEnter(lastChange!)
      const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
      expect(actions.querySelector('[data-diff-block-position]')?.textContent).toContain('3')
      // Parked further down the file, so landing on the FIRST change shows up in the scroll.
      codeBody().scrollTop = 200

      fireEvent.click(actions.querySelector('[data-diff-block-keep]') as HTMLElement)

      await waitFor(() => {
        expect(codeBody().scrollTop).toBe(0)
        expect(document.querySelector('[data-diff-block-flash]')).not.toBeNull()
      })
      // The flash frames the first change — its two rows, at the top of the file.
      const flash = document.querySelector('[data-diff-block-flash]') as HTMLElement
      expect(flash.style.top).toBe('0px')
      expect(flash.style.height).toBe(`${2 * diffLineHeight()}px`)
    } finally {
      restore()
    }
  })

  it('wraps to the first change in the side-by-side frame too', async () => {
    // The side-by-side view keeps its own copy of the post-action walk, so the wrap has to hold there as
    // well: the same three changes, the last one handled, the diff two blocks shorter afterwards.
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-wrap', path: '/repo/sw.txt', oldText: 'a\nb\nc\nd\ne\nf\n', newText: 'A\nb\nC\nd\nE\nf\n' })
    const after = entry({ id: 'entry-split-wrap', path: '/repo/sw.txt', oldText: 'a\nb\nc\nd\nE\nf\n', newText: 'A\nb\nC\nd\nE\nf\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = { rerender: (_node: ReactNode): void => {} }
    props.onBlockKeep = vi.fn(async () => {
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [after], busy: new Set() })} />)
    })
    view.rerender = render(<PendingPanel {...props} />).rerender
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('sw.txt'))

    const rows = [...document.querySelectorAll('[data-diff-split-row]')] as HTMLElement[]
    const lastChange = rows.find(row => (row.querySelector('[data-diff-code]')?.textContent ?? '') === 'E')
    expect(lastChange).toBeDefined()
    fireEvent.mouseEnter(lastChange!)
    const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(actions.querySelector('[data-diff-block-position]')?.textContent).toContain('3')
    const before = document.querySelector('[data-diff-block-flash]') as HTMLElement | null

    fireEvent.click(actions.querySelector('[data-diff-block-keep]') as HTMLElement)

    // Focused on the first change: the flash is drawn — out of range, none is drawn at all — and it has
    // moved up to the top of the file from the last change's frame.
    const beforeTop = Number.parseFloat(before?.style.top ?? '0')
    await waitFor(() => {
      const flash = document.querySelector('[data-diff-block-flash]') as HTMLElement | null
      expect(flash).not.toBeNull()
      expect(Number.parseFloat(flash!.style.top)).toBeLessThan(beforeTop === 0 ? 1 : beforeTop)
    })
    expect(Number.parseFloat((document.querySelector('[data-diff-block-flash]') as HTMLElement).style.top)).toBe(0)
  })

  it('marks changed lines on the scrollbar overview ruler in diff colors', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const ruler = document.querySelector('[data-diff-approval-ruler]') as HTMLElement
    expect(ruler).not.toBeNull()
    const markers = [...ruler.querySelectorAll('[data-diff-ruler-marker]')] as HTMLElement[]
    // 'a\n' -> 'b\n' is one deleted line then one added line: two markers,
    // each half of the file, tinted by its kind.
    expect(markers).toHaveLength(2)
    const [del, add] = markers
    expect(del.dataset.diffRulerMarker).toBe('del')
    expect(del.style.top).toBe('0%')
    expect(del.style.height).toBe('50%')
    expect(add.dataset.diffRulerMarker).toBe('add')
    expect(add.style.top).toBe('50%')
    expect(add.style.height).toBe('50%')
  })

  it('shows per-block keep/revert on hover and calls the block action with its line range', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // No block actions until a block is hovered.
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!) // del 'a' -> block 0 (old 1-1, new 1-1)

    const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(actions).not.toBeNull()
    const keep = actions.querySelector('[data-diff-block-keep]') as HTMLElement
    const revert = actions.querySelector('[data-diff-block-revert]') as HTMLElement
    expect(keep).not.toBeNull()
    expect(revert).not.toBeNull()
    // The frame names this block's position: block 1 of 2.
    const position = actions.querySelector('[data-diff-block-position]') as HTMLElement
    expect(position.textContent).toContain('1')
    expect(position.textContent).toContain('2')

    fireEvent.click(keep)
    const keepMock = props.onBlockKeep as unknown as { mock: { calls: unknown[][] } }
    expect(keepMock.mock.calls[0]).toEqual([S1, 'entry-blocks', { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }])

    fireEvent.click(revert)
    const revertMock = props.onBlockRevert as unknown as { mock: { calls: unknown[][] } }
    expect(revertMock.mock.calls[0]).toEqual([S1, 'entry-blocks', { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }])

    // Hovering context clears the floating actions.
    const contextRow = [...document.querySelectorAll('[data-diff-row]')]
      .find(row => row.getAttribute('data-diff-line') === 'context') as HTMLElement
    fireEvent.mouseEnter(contextRow)
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()
  })

  it('steps the hovered block frame to the next/previous diff block', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!) // block 0 (del 'a' -> line 1)

    const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(actions).not.toBeNull()
    const next = actions.querySelector('[data-diff-block-next]') as HTMLElement
    const prev = actions.querySelector('[data-diff-block-prev]') as HTMLElement
    expect(next).not.toBeNull()
    expect(prev).not.toBeNull()
    const position = actions.querySelector('[data-diff-block-position]') as HTMLElement
    expect(position.textContent).toContain('1')

    fireEvent.click(next)
    expect(position.textContent).toContain('2')

    fireEvent.click(prev)
    expect(position.textContent).toContain('1')
  })

  it('collapses the file list to a floating button below the sidebar breakpoint', async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      const file = entry({ id: 'entry-float', oldText: 'a\n', newText: 'b\n' })
      const props = panelProps({ read: true, files: [file], busy: new Set() })
      const view = render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))

      // 600 < 1024 (the sidebar auto-collapse breakpoint), so the file list
      // floats consistently with the sidebar, the card is open because the panel
      // just opened, and the knob is there to fold it away.
      expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
      const toggle = document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(toggle).not.toBeNull()

      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      // Folding it back draws the card into the corner — it is still mounted while that
      // plays — and the knob brings it back.
      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      await waitFor(() => { expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull() })

      // …and the knob brings it back.
      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      // Clicking a file row keeps the floating list open (so you can browse
      // more files); only clicking outside the card folds it back.
      const floatList = document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      const row = [...floatList.querySelectorAll('button')].find(button => button.textContent?.includes('a.txt'))
      expect(row).toBeDefined()
      fireEvent.click(row!)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      // Clicking outside the card (the code box) folds it back the same way.
      fireEvent.pointerDown(document.querySelector('[data-diff-approval-panel]') as HTMLElement)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      await waitFor(() => { expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull() })
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('lands the folded list on the file view the moment a file is picked', () => {
    // The folded list is placed from one measured box: the code view while a file
    // is open, the detail pane while none is. Opening the first file mounts the
    // diff's action row above the code view, so the box moves down by that row's
    // height — and the card and the knob have to move with it in the same commit.
    // They used to keep whatever box was measured last, which with a list that
    // arrived after the panel opened meant no box at all: the knob sat at the
    // panel's top-left and the card landed a toolbar lower once something finally
    // re-measured.
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalRect = Element.prototype.getBoundingClientRect
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    const box = (top: number, height: number): DOMRect => ({
      left: 0, right: 600, width: 600, top, bottom: top + height, height, x: 0, y: top, toJSON: () => ({}),
    }) as DOMRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const detail = document.querySelector('[data-diff-detail]')
      // The file's action row is 36px tall, and the code view starts under it.
      if (this.hasAttribute('data-diff-body')) return box(36, 364)
      if (detail !== null && (this === detail || this === detail.parentElement)) return box(0, 400)
      return originalRect.call(this)
    }
    try {
      // The panel opens on an empty list — the state it starts in while the agent
      // has not changed anything yet, and the state in which the list has no box.
      const props = panelProps({ read: true, files: [], busy: new Set() })
      const view = render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
      expect(document.querySelector('[data-diff-file-list-toggle]')).toBeNull()

      // A change lands: the list appears and the panel opens its first file.
      const first = entry({ id: 'entry-a', path: '/repo/a.txt' })
      const second = entry({ id: 'entry-b', path: '/repo/b.txt' })
      view.rerender(<PendingPanel {...panelProps({ read: true, files: [first, second], busy: new Set() })} />)
      expect(document.querySelector('[data-diff-body]')).not.toBeNull()

      // Both are on the code view at once: the knob at its top-left corner, and the
      // card — open, since the list arrived while the panel was showing — exactly
      // over the knob.
      const knob = (): HTMLElement => document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(knob().style.top).toBe('48px')
      expect(knob().style.left).toBe('12px')
      const card = (): HTMLElement => document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      expect(card().style.top).toBe('48px')
      expect(card().style.left).toBe(knob().style.left)
      expect(card().style.height).toBe('340px')
    } finally {
      Element.prototype.getBoundingClientRect = originalRect
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('takes the caret out of a composer the panel covers', () => {
    // The panel opening over a composer the caret is in would otherwise leave the
    // reader typing into a field they cannot see. jsdom lays nothing out, so the two
    // boxes the coverage is measured from are stubbed; the extra file is only there
    // to re-render the panel (a file *switch* would move the focus itself).
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.tabIndex = -1
    composer.getBoundingClientRect = () => ({
      left: 300, top: 700, width: 600, height: 90, right: 900, bottom: 790, x: 300, y: 700,
      toJSON: () => ({}),
    }) as DOMRect
    document.body.appendChild(composer)
    const panelBox = (bottom: number): DOMRect => ({
      left: 8, top: 8, width: 1184, height: bottom - 8, right: 1192, bottom, x: 8, y: 8,
      toJSON: () => ({}),
    }) as DOMRect
    const withFiles = (...paths: string[]): PanelProps => panelProps({
      read: true,
      files: paths.map((path, index) => entry({ id: `entry-${String(index)}`, path })),
      busy: new Set(),
    })
    try {
      const view = render(<PendingPanel {...withFiles('/repo/a.txt')} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement

      // The panel stops above the composer: the caret stays where the reader left it.
      panel.getBoundingClientRect = () => panelBox(600)
      composer.focus()
      view.rerender(<PendingPanel {...withFiles('/repo/a.txt', '/repo/b.txt')} />)
      expect(document.activeElement).toBe(composer)

      // The panel is over the composer now: the caret leaves it.
      panel.getBoundingClientRect = () => panelBox(792)
      view.rerender(<PendingPanel {...withFiles('/repo/a.txt', '/repo/b.txt', '/repo/c.txt')} />)
      expect(document.activeElement).not.toBe(composer)
    } finally {
      composer.remove()
    }
  })

  it('keeps the file-list knob outside the diff view, which can vanish', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))

      const knob = document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(knob).not.toBeNull()
      // It used to sit in the diff view's action row, which is not drawn while no
      // file is open — taking the switch for the folded list down with it. It now
      // hangs off the panel itself, so the detail's content cannot remove it.
      expect(knob.closest('[data-diff-toolbar]')).toBeNull()
      expect(knob.closest('[data-diff-detail]')).toBeNull()
      expect(knob.closest('[data-diff-approval-panel]')).not.toBeNull()

      // Its place is the floating card's own top-left corner — the same measured
      // box, the same inset — so the open list, which sits above the knob in
      // z-order, covers it exactly.
      const card = document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      expect(card).not.toBeNull()
      expect(parseFloat(knob.style.left)).toBe(parseFloat(card.style.left))
      expect(parseFloat(knob.style.top)).toBe(parseFloat(card.style.top))
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('keeps the list on screen when the switch beside Add folds it for good', async () => {
    // The switch says where the list lives, not whether it is there. Pressed while the card is up
    // (a narrow panel opens with it up), the card stays exactly where it is — only the stored
    // preference changes, so the next open starts folded too — and the knob is the gesture that
    // folds the card away.
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      localStorage.setItem('diff-approval:file-list-float', '0')
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      const card = (): Element | null => document.querySelector('[data-diff-floating-file-list]')
      expect(card()).not.toBeNull()

      fireEvent.click(document.querySelector('[data-diff-file-list-float]') as HTMLElement)
      // Still the list, still open, and now remembered as folded-for-good.
      expect(card()).not.toBeNull()
      expect(localStorage.getItem('diff-approval:file-list-float')).toBe('1')
      expect(document.querySelector('[data-diff-file-list-toggle]')).not.toBeNull()

      // The knob is what folds it away.
      fireEvent.click(document.querySelector('[data-diff-file-list-toggle]') as HTMLElement)
      await waitFor(() => { expect(card()).toBeNull() })
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('folds the file list for good from the switch beside Add, and remembers it', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const first = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // A wide window: the list sits beside the diff, and there is no knob.
    expect(document.querySelector('[data-diff-approval-file-list]')).not.toBeNull()
    expect(document.querySelector('[data-diff-file-list-toggle]')).toBeNull()

    const toggle = document.querySelector('[data-diff-file-list-float]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    // Folded for good — the column is gone and the list is the floating card, still on screen —
    // and stored, so the next open starts folded too.
    expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
    expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
    expect(localStorage.getItem('diff-approval:file-list-float')).toBe('1')
    // The knob folds the card away; the list is then carried by the knob alone.
    fireEvent.click(document.querySelector('[data-diff-file-list-toggle]') as HTMLElement)
    await waitFor(() => { expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull() })
    first.unmount()

    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
    // The switch lives with the list's other controls, so it is reached through the
    // card the panel opens with.
    expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-file-list-float]') as HTMLElement)
    expect(localStorage.getItem('diff-approval:file-list-float')).toBe('0')
    expect(document.querySelector('[data-diff-approval-file-list]')).not.toBeNull()
  })

  it('shows the floating file list when the panel opens in Markdown preview', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      localStorage.setItem('diff-approval:md-preview', '1')
      const file = entry({ id: 'entry-md-float', path: '/repo/README.md', oldText: '# T\n', newText: '# T\n\nNew\n' })
      const props = panelProps({ read: true, files: [file], busy: new Set() })
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))

      // The Markdown preview is showing (no source diff body), yet the floating
      // list still works on the narrow breakpoint — open, as a fresh showing has it.
      expect(document.querySelector('[data-diff-md-preview-body]')).not.toBeNull()
      expect(document.querySelector('[data-diff-body]')).toBeNull()
      expect(document.querySelector('[data-diff-file-list-toggle]')).not.toBeNull()
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('anchors the block frame to the block bottom and clamps it inside the viewport', () => {
    // Last row of the file is the changed row, so the frame would be pushed off the
    // viewport bottom unless clamped up to fit: with a 120px viewport and a 40px frame,
    // the clamp is `120 - 40 = 80`, and the frame (which starts at 86) is held there.
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 120 })
    try {
      const lastRowDiff = entry({ id: 'entry-last-row', oldText: 'a\nb\nc\n', newText: 'a\nb\nC\n' })
      const props = panelProps({ read: true, files: [lastRowDiff], busy: new Set() })
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('a.txt'))

      const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
      const last = rows[rows.length - 1]!
      fireEvent.mouseEnter(last)

      const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
      expect(actions).not.toBeNull()
      // The animation's clamp, evaluated at scroll 0 — the fallback jsdom exercises.
      expect(actions.style.top).toBe('80px')
    } finally {
      if (clientHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
      else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
    }
  })

  it('moves the focus between contiguous change blocks', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    // Opening the panel auto-selects the first file (block 0 focused).
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // Mock a scrollable 6-row body in a 4-row viewport so the block-jump
    // recenter can actually move scrollTop (jsdom measures 0 otherwise).
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })

    const focusedLines = () => [...document.querySelectorAll('[data-diff-focused]')]
    // Block 0: the first change (del a / add A), both lines highlighted.
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('a')

    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('c')

    fireEvent.click(screen.getByLabelText('action.prevDiff'))
    expect(focusedLines()[0]!.textContent).toContain('a')

    // From the last block, the first next is at the wrap boundary: it toasts
    // the hint and stays; the next click wraps back to the first.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(screen.getAllByText('panel.blockAtEnd').length).toBeGreaterThanOrEqual(1)
    expect(focusedLines()[0]!.textContent).toContain('c')
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('jumps between change blocks with Ctrl+Up / Ctrl+Down while the panel is focused', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Opening the panel auto-selects the file and focuses the diff body.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    expect(document.activeElement).toBe(body)
    // Mock a scrollable body so the jump recenter moves scrollTop and the
    // navigation re-anchors to it.
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })

    const focusedLines = () => [...document.querySelectorAll('[data-diff-focused]')]
    expect(focusedLines()[0]!.textContent).toContain('a')

    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('c')

    fireEvent.keyDown(body, { key: 'ArrowUp', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('at the boundary a keyboard jump toasts and needs one more press to wrap', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })
    const focusedLines = () => [...document.querySelectorAll('[data-diff-focused]')]

    // Jump to the last block (block 1, 'c').
    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('c')

    // At the last block a further Ctrl+Down toasts and does NOT wrap.
    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(screen.getAllByText('panel.blockAtEnd').length).toBeGreaterThanOrEqual(1)
    expect(focusedLines()[0]!.textContent).toContain('c')

    // The next Ctrl+Down wraps to the first block.
    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('at the boundary a toolbar click toasts and needs one more click to wrap', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })
    const focusedLines = () => [...document.querySelectorAll('[data-diff-focused]')]

    // Jump to the last block (block 1, 'c') with the toolbar next button.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()[0]!.textContent).toContain('c')

    // At the last block a further next click toasts and does NOT wrap.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(screen.getAllByText('panel.blockAtEnd').length).toBeGreaterThanOrEqual(1)
    expect(focusedLines()[0]!.textContent).toContain('c')

    // The next click wraps to the first block.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('toasts "only one block" when there is a single block', () => {
    const oneBlock = entry({ id: 'entry-one', oldText: 'a\nb\n', newText: 'A\nb\n' })
    const props = panelProps({ read: true, files: [oneBlock], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 3 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 2 * 22 })

    // Ctrl+Down with a single block toasts "only one block" (nothing to wrap to).
    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(screen.getAllByText('panel.blockSingle').length).toBeGreaterThanOrEqual(1)
  })

  it('flashes the focused block on open and on every block switch', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Opening the file flashes the initially focused block 0 (rows 0-1).
    const first = document.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(first).not.toBeNull()
    expect(first.style.top).toBe('0px')
    expect(first.style.height).toBe('44px')

    // Jumping to block 1 remounts the flash over it: the del 'c' / add 'C'
    // pair at rows 3-4 -> top 66px, height 44px.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const second = document.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(second.style.top).toBe('66px')
    expect(second.style.height).toBe('44px')
  })

  it('re-flashes the same block when a single-block file re-jumps onto it', () => {
    const single = entry({ id: 'entry-single', oldText: 'a\nb\nc\n', newText: 'A\nb\nc\n' })
    const props = panelProps({ read: true, files: [single], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const flash = () => document.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(flash()).not.toBeNull()

    // NextDiff wraps to the only block: the overlay must remount (new node)
    // so the fade-out replays even though the block did not move.
    const before = flash()
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(flash()).not.toBeNull()
    expect(flash()).not.toBe(before)
  })

  it('sizes a tall block flash to the block height (clipped by the scroller)', () => {
    // One contiguous block spanning the whole diff (24 rows, 528px). The flash
    // uses content coordinates and spans the whole block; the scroller's
    // overflow clips it to the viewport.
    const tall = entry({ id: 'entry-tall', oldText: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n', newText: 'A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL\n' })
    const props = panelProps({ read: true, files: [tall], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const flash = document.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(flash).not.toBeNull()
    expect(flash.style.height).toBe('528px')
  })

  it('keeps the flash off the overview ruler, reserving its width when no scrollbar is present', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement

    // No vertical scrollbar (offset == client): the ruler's 4px is reserved,
    // so the flash stops short of it. The clientHeight change forces the
    // re-render that recomputes the width.
    Object.defineProperty(body, 'clientWidth', { value: 200, configurable: true })
    Object.defineProperty(body, 'offsetWidth', { value: 200, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true })
    fireEvent.scroll(body)
    expect(document.querySelector('[data-diff-block-flash]')!.style.width).toBe('196px')

    // With a scrollbar (offset > client), clientWidth already ends at it.
    Object.defineProperty(body, 'offsetWidth', { value: 208, configurable: true })
    Object.defineProperty(body, 'clientHeight', { value: 120, configurable: true })
    fireEvent.scroll(body)
    expect(document.querySelector('[data-diff-block-flash]')!.style.width).toBe('200px')
  })

  it('re-clicking the already-open file jumps to the next diff block', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    // Opening the panel auto-selects the first file with block 0 focused.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // Mock a scrollable body so the jump recenter can move scrollTop.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })

    const focusedLines = () => [...document.querySelectorAll('[data-diff-focused]')]
    // Block 0 (del a / add A) is focused after the file is opened.
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('a')

    // Clicking the file's row again must not reselect (it is already open);
    // it jumps to the next diff block instead (c / C).
    fireEvent.click(screen.getByText('a.txt'))
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('c')

    // Now at the last block: the next re-click is at the wrap boundary, so it
    // toasts the hint and stays on the last block (same as the toolbar/keyboard).
    fireEvent.click(screen.getByText('a.txt'))
    expect(screen.getAllByText('panel.blockAtEnd').length).toBeGreaterThanOrEqual(1)
    expect(focusedLines()[0]!.textContent).toContain('c')

    // The following re-click wraps around to the first block.
    fireEvent.click(screen.getByText('a.txt'))
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('searches the diff: counts hits, highlights them, and jumps between matches', () => {
    const file = entry({ id: 'entry-search', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // No search UI or highlights until the bar is opened.
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelectorAll('[data-diff-search]')).toHaveLength(0)

    fireEvent.click(screen.getByLabelText('action.search'))
    expect(document.querySelector('[data-diff-searchbar]')).not.toBeNull()

    // Query 'a' matches 'bar' (context row 1) and 'baz' (del row 2); the
    // other rows 'foo'/'qux' have no 'a'.
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a' } })

    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('1/2')
    expect(document.querySelectorAll('[data-diff-search="hit"]')).toHaveLength(1)
    const firstCurrent = document.querySelector('[data-diff-search="current"]') as HTMLElement
    expect(firstCurrent.textContent).toContain('bar')

    // The matched substring is highlighted, not the whole line: each match span
    // holds exactly the query 'a', the current row's match is marked 'current'
    // (stronger), and the other hit row's match is 'hit'.
    const marks = [...document.querySelectorAll('[data-diff-search-match]')] as HTMLElement[]
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) expect(mark.textContent).toBe('a')
    expect(document.querySelector('[data-diff-search="current"] [data-diff-search-match="current"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-search="hit"] [data-diff-search-match="hit"]')).not.toBeNull()

    // Next match moves to 'baz' and the count advances.
    fireEvent.click(document.querySelector('[data-diff-search-next]') as HTMLElement)
    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('2/2')
    const secondCurrent = document.querySelector('[data-diff-search="current"]') as HTMLElement
    expect(secondCurrent.textContent).toContain('baz')

    // Closing the bar clears the query and the highlights.
    fireEvent.click(document.querySelector('[data-diff-search-close]') as HTMLElement)
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelectorAll('[data-diff-search]')).toHaveLength(0)
  })

  it('narrows the search to an exact case without retyping', () => {
    const file = entry({ id: 'entry-search-case', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const caseToggle = () => document.querySelector('[data-diff-search-case]') as HTMLButtonElement
    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'A' } })

    // Case-insensitive by default: the 'a' in 'bar' and 'baz' both match.
    expect(caseToggle().getAttribute('aria-pressed')).toBe('false')
    expect(count()).toBe('1/2')

    // Turning the toggle on re-runs the same query without retyping it.
    fireEvent.click(caseToggle())
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')
    expect(count()).toBe('0/0')
    expect(localStorage.getItem('diff-approval:search-case')).toBe('1')

    fireEvent.click(caseToggle())
    expect(count()).toBe('1/2')
  })

  it('narrows the search to whole words without retyping', () => {
    const file = entry({ id: 'entry-search-word', oldText: 'bar\nbartender\nbaz\n', newText: 'bar\nbartender\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const wordToggle = () => document.querySelector('[data-diff-search-word]') as HTMLButtonElement
    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'bar' } })

    // 'bar' and the 'bar' inside 'bartender' both match as substrings.
    expect(count()).toBe('1/2')

    fireEvent.click(wordToggle())
    expect(wordToggle().getAttribute('aria-pressed')).toBe('true')
    // Only the standalone word survives.
    expect(count()).toBe('1/1')
    expect(localStorage.getItem('diff-approval:search-word')).toBe('1')
  })

  it('toggles the search narrowing from the keyboard, like the editor chords', () => {
    const file = entry({ id: 'entry-search-keys', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const input = () => document.querySelector('[data-diff-search-input]') as HTMLInputElement
    const caseToggle = () => document.querySelector('[data-diff-search-case]') as HTMLButtonElement
    const wordToggle = () => document.querySelector('[data-diff-search-word]') as HTMLButtonElement
    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(input(), { target: { value: 'A' } })
    expect(count()).toBe('1/2')

    // Alt+C / Alt+W are the chords VS Code's find widget uses; they apply while
    // the caret is in the query box.
    fireEvent.keyDown(input(), { key: 'c', altKey: true })
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')
    expect(count()).toBe('0/0')

    fireEvent.keyDown(input(), { key: 'c', altKey: true })
    expect(caseToggle().getAttribute('aria-pressed')).toBe('false')

    fireEvent.keyDown(input(), { key: 'w', altKey: true })
    expect(wordToggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves the chords alone unless the caret is in the query box', () => {
    const file = entry({ id: 'entry-search-keys-blur', oldText: 'foo\nbar\n', newText: 'foo\nbaz\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const input = () => document.querySelector('[data-diff-search-input]') as HTMLInputElement
    const caseToggle = () => document.querySelector('[data-diff-search-case]') as HTMLButtonElement
    const wordToggle = () => document.querySelector('[data-diff-search-word]') as HTMLButtonElement

    // The bar is open, but the chord came from somewhere else (the composer, for
    // one): it must stay free for whoever actually has the focus.
    fireEvent.keyDown(document.body, { key: 'c', altKey: true })
    fireEvent.keyDown(document.body, { key: 'w', altKey: true })
    expect(caseToggle().getAttribute('aria-pressed')).toBe('false')
    expect(wordToggle().getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem('diff-approval:search-case')).toBeNull()
    expect(localStorage.getItem('diff-approval:search-word')).toBeNull()

    // A bar button is not the query box either…
    fireEvent.keyDown(caseToggle(), { key: 'c', altKey: true })
    expect(caseToggle().getAttribute('aria-pressed')).toBe('false')

    // …but clicking one hands the focus straight back to the box, so the chords
    // keep working without a second click into the box.
    fireEvent.click(wordToggle())
    expect(wordToggle().getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'c', altKey: true })
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves the narrowing chords alone while the search bar is closed', () => {
    const file = entry({ id: 'entry-search-keys-closed', oldText: 'foo\nbar\n', newText: 'foo\nbaz\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // No bar open: the chord must not flip a hidden option.
    fireEvent.keyDown(document.body, { key: 'c', altKey: true })
    expect(localStorage.getItem('diff-approval:search-case')).toBeNull()
  })

  it('offers the same search narrowing in the split view', () => {
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-search', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'A' } })
    // The split bar carries its own toggles over its own pair matching.
    expect(count()).toBe('1/2')
    fireEvent.click(document.querySelector('[data-diff-search-case]') as HTMLButtonElement)
    expect(count()).toBe('0/0')
    expect(localStorage.getItem('diff-approval:search-case')).toBe('1')

    // The chord reaches the split bar too (it owns its own state) — but only
    // from that bar's own query box.
    fireEvent.keyDown(document.body, { key: 'c', altKey: true })
    expect(count()).toBe('0/0')
    fireEvent.keyDown(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { key: 'c', altKey: true })
    expect(count()).toBe('1/2')
    expect(localStorage.getItem('diff-approval:search-case')).toBe('0')
  })

  it('scopes the split view\'s step chords to its box and its Esc to the bar', () => {
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-f3', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const input = () => document.querySelector('[data-diff-search-input]') as HTMLInputElement
    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(input(), { target: { value: 'A' } })
    expect(count()).toBe('1/2')

    // The split bar does not own F3 from outside its box either.
    fireEvent.keyDown(document.body, { key: 'F3' })
    expect(count()).toBe('1/2')
    fireEvent.keyDown(input(), { key: 'F3' })
    expect(count()).toBe('2/2')

    // Esc belongs to the bar for a press from inside the panel, so the split
    // column does not swallow it into the panel's own Esc.
    fireEvent.keyDown(document.querySelector('[data-diff-body]') as HTMLElement, { key: 'Escape' })
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('opens the other view\'s search bar on the stored narrowing state', () => {
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-search-sync', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    const caseToggle = () => document.querySelector('[data-diff-search-case]') as HTMLButtonElement
    const count = () => document.querySelector('[data-diff-search-count]')!.textContent
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'A' } })
    expect(count()).toBe('1/2')
    fireEvent.click(caseToggle())
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')

    // Back to the unified view, whose bar seeded its state before the split
    // toggle: it has to re-read the stored preference when it opens.
    fireEvent.click(document.querySelector('[data-diff-search-close]') as HTMLElement)
    fireEvent.click(screen.getByLabelText('action.viewUnified'))
    fireEvent.click(screen.getByLabelText('action.search'))
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'A' } })
    expect(count()).toBe('0/0')
    // The pref survives the reopen, not just the view switch.
    fireEvent.click(document.querySelector('[data-diff-search-close]') as HTMLElement)
    fireEvent.click(screen.getByLabelText('action.search'))
    expect(caseToggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('names the configured chords in the tooltips', () => {
    const file = entry({ id: 'entry-search-hint', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))
    // A query enables the step buttons, which are disabled (and so unfocusable)
    // on an empty search.
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, { target: { value: 'foo' } })

    // An icon-only control is read by focusing it; the chord is appended from the
    // binding the user has (Alt+C / Alt+W are VS Code's find-widget chords).
    const hintOf = (selector: string): string => {
      act(() => { (document.querySelector(selector) as HTMLElement).focus() })
      return screen.getByRole('tooltip').textContent ?? ''
    }
    expect(hintOf('[data-diff-search-case]')).toBe('action.matchCase (Alt+C)')
    expect(hintOf('[data-diff-search-word]')).toBe('action.matchWholeWord (Alt+W)')
    expect(hintOf('[data-diff-search-next]')).toBe('action.nextDiff (F3)')
    expect(hintOf('[data-diff-search-toggle]')).toBe('action.search (Ctrl+F)')
    // Arrow chords render as arrows, not as the stored `Ctrl+ArrowUp`.
    expect(hintOf('[data-diff-prev]')).toBe('action.prevDiff (Ctrl+↑)')
  })

  it('follows a rebound chord in the tooltip', () => {
    localStorage.setItem('diff-approval:key:matchCase', 'Ctrl+Shift+K')
    const file = entry({ id: 'entry-search-hint-rebound', oldText: 'foo\nbar\n', newText: 'foo\nbaz\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    act(() => { (document.querySelector('[data-diff-search-case]') as HTMLElement).focus() })
    expect(screen.getByRole('tooltip').textContent).toBe('action.matchCase (Ctrl+Shift+K)')
  })

  it('starts the first search from the current scroll position, wrapping to the top', () => {
    const file = entry({ id: 'entry-search-scroll', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByLabelText('action.search'))

    // 'a' matches 'bar' (row 1) and 'baz' (row 2). Scroll so the top visible row
    // is row 2, so the first search lands on 'baz' — not the top match 'bar'.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    body.scrollTop = 2 * 22
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a' } })

    const current = document.querySelector('[data-diff-search="current"]') as HTMLElement
    expect(current.textContent).toContain('baz')
  })

  it('Ctrl+F auto-fills the query from the selected text and lands on that occurrence first', () => {
    // 'data' appears in row 0 and row 2 (both context) so the auto-filled query
    // has two matches; selecting row 2 must make IT the first (current) result,
    // not the earlier row 0.
    const file = entry({ id: 'entry-search-select', oldText: 'data\nother\ndata\nend\n', newText: 'data\nother\ndata\nend!\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code2 = rows[2]!.querySelector('[data-diff-code]') ?? rows[2]!
    const codeNode = code2.firstChild ?? code2
    const selection = {
      isCollapsed: false,
      anchorNode: codeNode,
      focusNode: codeNode,
      rangeCount: 1,
      toString: () => 'data',
      getRangeAt: () => ({
        startContainer: codeNode,
        startOffset: 0,
        endContainer: codeNode,
        endOffset: 4,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // Ctrl+F opens the bar, auto-fills the selected text, and lands on the
    // selected occurrence (row 2) instead of the earlier one (row 0).
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(document.querySelector('[data-diff-searchbar]')).not.toBeNull()
    expect((document.querySelector('[data-diff-search-input]') as HTMLInputElement).value).toBe('data')
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('hit')
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')

    // A repeated Ctrl+F while the bar is already open must NOT re-run the
    // first-search anchoring (which would recenter an earlier match); it keeps
    // the current match and just refocuses the box.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('hit')
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')
  })

  it('consumes the opening selection: later query edits anchor from the current highlight', () => {
    const file = entry({ id: 'entry-search-consume', oldText: 'data\nother\ndata\nend\n', newText: 'data\nother\ndata\nend!\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code2 = rows[2]!.querySelector('[data-diff-code]') ?? rows[2]!
    const codeNode = code2.firstChild ?? code2
    const selection = {
      isCollapsed: false,
      anchorNode: codeNode,
      focusNode: codeNode,
      rangeCount: 1,
      toString: () => 'data',
      getRangeAt: () => ({
        startContainer: codeNode,
        startOffset: 0,
        endContainer: codeNode,
        endOffset: 4,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // Open over the selected row 2 → the first result is that row.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')

    // Move the highlight to the earlier 'data' (row 0) with "previous".
    fireEvent.click(document.querySelector('[data-diff-search-prev]') as HTMLElement)
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')

    // Re-editing the query must anchor from the CURRENT highlight (row 0), not
    // the consumed opening selection (row 2): if the stale selection were still
    // honored, this would jump back to row 2.
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'data' } })
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('hit')
  })

  it('records the cursor from a selection made while the bar is open (query unchanged), and the next search consumes it', () => {
    const file = entry({ id: 'entry-search-cursor', oldText: 'data\nother\ndata\nend\n', newText: 'data\nother\ndata\nend!\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Open the search bar with no selection → empty query.
    fireEvent.click(screen.getByLabelText('action.search'))
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    expect(input.value).toBe('')

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code2 = rows[2]!.querySelector('[data-diff-code]') ?? rows[2]!
    const codeNode = code2.firstChild ?? code2
    const selection = {
      isCollapsed: false,
      anchorNode: codeNode,
      focusNode: codeNode,
      rangeCount: 1,
      toString: () => 'data',
      getRangeAt: () => ({
        startContainer: codeNode,
        startOffset: 0,
        endContainer: codeNode,
        endOffset: 4,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // Recording the cursor does NOT touch the query (a mature find box keeps the
    // query); it only sets where the next search starts.
    expect(input.value).toBe('')

    // The next search anchors from the recorded cursor (row 2): typing 'data'
    // lands on the selected occurrence, not the earlier row 0.
    fireEvent.change(input, { target: { value: 'data' } })
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('hit')
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')
  })

  it('Escape in the search input closes only the search bar; a second Escape closes the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // Open the search bar and leave focus in its input.
    fireEvent.click(screen.getByLabelText('action.search'))
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    expect(input).not.toBeNull()

    // Escape in the input closes the search bar only — the panel stays open.
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // A second Escape (focus no longer on a text input) closes the panel.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('a selection made while the bar is open anchors find-next to the selected occurrence', () => {
    const file = entry({ id: 'entry-search-next-cursor', oldText: 'data\nother\ndata\nend\n', newText: 'data\nother\ndata\nend!\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Search a query with two matches; without a cursor the first result is the
    // viewport-top match (row 0).
    fireEvent.click(screen.getByLabelText('action.search'))
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'data' } })
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')

    // Select row 2 while the bar is open → records the cursor.
    const code2 = rows[2]!.querySelector('[data-diff-code]') ?? rows[2]!
    const codeNode = code2.firstChild ?? code2
    const selection = {
      isCollapsed: false,
      anchorNode: codeNode,
      focusNode: codeNode,
      rangeCount: 1,
      toString: () => 'data',
      getRangeAt: () => ({
        startContainer: codeNode,
        startOffset: 0,
        endContainer: codeNode,
        endOffset: 4,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // find-next anchors to the selected occurrence (row 2), not the earlier row 0.
    fireEvent.click(document.querySelector('[data-diff-search-next]') as HTMLElement)
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('hit')
  })

  it('F3 / Shift+F3 step the search only from the query box', () => {
    const file = entry({ id: 'entry-search-f3', oldText: 'data\nother\ndata\nend\n', newText: 'data\nother\ndata\nend!\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(screen.getByLabelText('action.search'))
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'data' } })
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    // Without a cursor the first result is the viewport-top match (row 0).
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')

    // F3 from outside the box (the composer, say) is the browser's to keep: the
    // open bar does not make the panel the owner of the key.
    fireEvent.keyDown(document.body, { key: 'F3' })
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')

    // F3 in the box → the next match (row 2).
    fireEvent.keyDown(input, { key: 'F3' })
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('current')
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('hit')

    // Shift+F3 → back to the previous match (row 0).
    fireEvent.keyDown(input, { key: 'F3', shiftKey: true })
    expect(rows[0]!.getAttribute('data-diff-search')).toBe('current')
    expect(rows[2]!.getAttribute('data-diff-search')).toBe('hit')
  })

  it('Escape from a search-bar button closes the bar, not the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByLabelText('action.search'))
    // Tab can land on a bar button even though a click hands the focus back, so
    // Esc has to belong to the whole bar rather than to its query box.
    const caseToggle = document.querySelector('[data-diff-search-case]') as HTMLButtonElement
    act(() => { caseToggle.focus() })
    fireEvent.keyDown(caseToggle, { key: 'Escape' })
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('closes an open bar with Escape from inside the panel, keeping the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByLabelText('action.search'))
    // Anywhere inside the panel — the diff body included, which is where the
    // focus actually sits after a panel interaction — the bar is the innermost
    // dismissible: one press closes it and leaves the panel standing.
    fireEvent.keyDown(document.querySelector('[data-diff-body]') as HTMLElement, { key: 'Escape' })
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // A second press from the same focus has only the panel left to dismiss.
    fireEvent.keyDown(document.querySelector('[data-diff-body]') as HTMLElement, { key: 'Escape' })
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('dismisses the panel with Escape from a text field outside it', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(screen.getByLabelText('action.search'))
    // A text field outside the panel stands in for the composer: the bar is not
    // its to take, and the panel puts itself away — which takes the open bar with
    // it, since the panel body unmounts. The composer keeps its own Esc too: the
    // panel does not swallow the key, it only acts on it.
    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    try {
      fireEvent.keyDown(composer, { key: 'Escape' })
      expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
      expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    } finally {
      composer.remove()
    }
  })

  it('dismisses the panel with Escape from the composer even with no bar open', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const composer = document.createElement('textarea')
    document.body.appendChild(composer)
    try {
      fireEvent.keyDown(composer, { key: 'Escape' })
      expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    } finally {
      composer.remove()
    }
  })

  it('undoes with Ctrl+Z and redoes with Ctrl+Y globally, but not in text inputs', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const undoMock = props.onUndo as unknown as { mock: { calls: unknown[][] } }
    const redoMock = props.onRedo as unknown as { mock: { calls: unknown[][] } }

    // Global: works from the diff body regardless of where focus sits.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    fireEvent.keyDown(body, { key: 'z', ctrlKey: true })
    expect(undoMock.mock.calls).toEqual([[S1]])
    fireEvent.keyDown(body, { key: 'y', ctrlKey: true })
    expect(redoMock.mock.calls).toEqual([[S1]])

    // Text inputs (the composer) keep their own Ctrl+Z / Ctrl+Y editing.
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
    expect(undoMock.mock.calls).toHaveLength(1)
    input.remove()
  })

  it('selects the file an undo affected and flashes its diff', async () => {
    const other = entry({ id: 'entry-2', path: '/repo/b.txt', oldText: 'x\n', newText: 'y\n' })
    const props = panelProps({ read: true, files: [FILE, other], busy: new Set() })
    ;(props.onUndo as unknown as { mockResolvedValueOnce: (value: string) => void })
      .mockResolvedValueOnce('entry-2')
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    // The detail pane shows a.txt; the other file's path is not open yet.
    expect(screen.queryByText('/repo/b.txt')).toBeNull()

    // Undo resolves to another file's id: the panel switches to it and its
    // diff mounts, flashing the first change block.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    fireEvent.keyDown(body, { key: 'z', ctrlKey: true })
    await waitFor(() => { expect(shownPath()).toBe('/repo/b.txt') })
    expect(document.querySelector('[data-diff-block-flash]')).not.toBeNull()
  })

  it('re-flashes the open file when an undo affects it', async () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    ;(props.onUndo as unknown as { mockResolvedValueOnce: (value: string) => void })
      .mockResolvedValueOnce(FILE.id)
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const flashBefore = document.querySelector('[data-diff-block-flash]')
    expect(flashBefore).not.toBeNull()

    // Undo resolves to the open file's id: the panel re-keys the flash so the
    // highlight box replays on the undone diff (a new overlay node).
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    fireEvent.keyDown(body, { key: 'z', ctrlKey: true })
    await waitFor(() => {
      expect(document.querySelector('[data-diff-block-flash]')).not.toBe(flashBefore)
    })
  })

  it('opens the search bar with Ctrl+F even when focus is outside the panel', () => {
    const file = entry({ id: 'entry-search', oldText: 'foo\nbar\n', newText: 'foo\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()

    // Ctrl+F with the focus on the page body (not inside the panel) still
    // opens the search bar instead of the browser's native find.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(document.querySelector('[data-diff-searchbar]')).not.toBeNull()
  })

  it('re-centers the sole block on every jump when it is the only one', () => {
    // A fully-rewritten file is one contiguous change block (every row is a
    // change), so `count === 1` and jumping never changes the focus.
    const single = entry({ id: 'entry-single', oldText: 'a\nb\nc\nd\ne\n', newText: 'A\nB\nC\nD\nE\n' })
    const props = panelProps({ read: true, files: [single], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // Give the scroller a fake viewport and intercept scrollTop so the
    // re-center on each jump is observable.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    let scrollTop = 0
    let sets = 0
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; sets++ },
    })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 220 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 10 * 22 })

    // Push the sole block out of view; with one block the focus never changes,
    // yet each click must scroll it back to its centered position (row 0).
    scrollTop = 88
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(sets).toBeGreaterThanOrEqual(1)
    expect(scrollTop).toBe(0)

    scrollTop = 88
    fireEvent.click(screen.getByLabelText('action.prevDiff'))
    expect(sets).toBeGreaterThanOrEqual(2)
    expect(scrollTop).toBe(0)
  })

  it('skips blocks scrolled above the viewport anchor when jumping to the next one', () => {
    const threeBlocks = entry({
      id: 'entry-three',
      oldText: 'a\nb\nc\nd\ne\nf\n',
      newText: 'A\nb\nC\nd\nE\nf\n',
    })
    const props = panelProps({ read: true, files: [threeBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // Blocks 0 and 1 start at rows 0 and 3 (offsets 0/66px); block 2 starts at
    // row 6 (132px). Scroll so the first two sit above the navigation anchor
    // (viewport top + 2 lead rows = 88px): the next jump must land on the third.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    body.scrollTop = 2 * 22
    fireEvent.scroll(body)

    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const focused = document.querySelector('[data-diff-focused]')
    expect(focused).not.toBeNull()
    expect(focused!.textContent).toContain('e')
  })

  it('re-anchors block navigation to the current scroll, not the last focused block', () => {
    const threeBlocks = entry({
      id: 'entry-scroll-anchor',
      oldText: 'a\nb\nc\nd\ne\nf\n',
      newText: 'A\nb\nC\nd\nE\nf\n',
    })
    const props = panelProps({ read: true, files: [threeBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement

    // Scroll near block 2, then next focuses it.
    body.scrollTop = 2 * 22
    fireEvent.scroll(body)
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const focused = () => document.querySelector('[data-diff-focused]')!
    expect(focused().textContent).toContain('e')

    // Scroll back to the top: prev must now be relative to the top anchor, so
    // it steps to the block above the first — wrapping to the last from the
    // re-anchored position — not the stale previously-focused block 2.
    body.scrollTop = 0
    fireEvent.scroll(body)
    fireEvent.click(screen.getByLabelText('action.prevDiff'))
    // At the top, the reference block is block 0, so prev is at the wrap
    // boundary: it toasts the hint and stays; the next prev wraps to the last.
    expect(screen.getAllByText('panel.blockAtStart').length).toBeGreaterThanOrEqual(1)
    expect(focused().textContent).toContain('a')
    fireEvent.click(screen.getByLabelText('action.prevDiff'))
    expect(focused().textContent).toContain('e')
  })

  it('absorbs a sub-pixel anchor boundary so the next block is not stuck', () => {
    const threeBlocks = entry({
      id: 'entry-tolerance',
      oldText: 'a\nb\nc\nd\ne\nf\n',
      newText: 'A\nb\nC\nd\nE\nf\n',
    })
    const props = panelProps({ read: true, files: [threeBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement

    // Block 1 starts at 66px. Put the anchor (scrollTop + 2 rows = 44px) just
    // below it (scrollTop 21.5 -> anchor 65.5), so without a tolerance block 1
    // would count as "above" and the next jump would fall back onto it. The
    // tolerance must keep it as the reference and advance past it to block 2.
    body.scrollTop = 21.5
    fireEvent.scroll(body)
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const focused = document.querySelector('[data-diff-focused]')
    expect(focused).not.toBeNull()
    expect(focused!.textContent).toContain('e')
  })

  it('reaches the last block and wraps instead of sticking at the bottom', () => {
    const threeBlocks = entry({
      id: 'entry-bottom-wrap',
      oldText: 'a\nb\nc\nd\ne\nf\n',
      newText: 'A\nb\nC\nd\nE\nf\n',
    })
    const props = panelProps({ read: true, files: [threeBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    // Fake a small viewport so the last block clamps to the bottom when recentered.
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 6 * 22 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 4 * 22 })

    // Scroll to the max (maxScroll = 6*22 - 4*22 = 44): the scroller is pinned to
    // the bottom, so the current diff stays on the LAST block (block 2) rather than
    // being pulled back to the anchor block (block 1) — that is what the re-anchor
    // off-by-one fix does.
    body.scrollTop = 2 * 22
    fireEvent.scroll(body)
    const focused = () => document.querySelector('[data-diff-focused]')!

    // Pinned at the bottom, the current block is the last one (block 2).
    expect(focused().textContent).toContain('e')

    // The press at the last block is at the wrap boundary: it toasts the hint
    // and stays on block 2; the next press wraps to the first (block 0).
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(screen.getAllByText('panel.blockAtEnd').length).toBeGreaterThanOrEqual(1)
    expect(focused().textContent).toContain('e')
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    // Block 0's focused content is the removed side of row 0 ('a'); the old block
    // 2 ('e') must be gone, proving the wrap happened rather than a stick.
    expect(focused().textContent).toContain('a')
    expect(focused().textContent).not.toContain('e')
  })

  it('renders only a viewport window of rows for a large file', () => {
    const big = entry({ id: 'entry-big', oldText: 'a\n'.repeat(2000), newText: 'A\n'.repeat(2000) })
    const props = panelProps({ read: true, files: [big], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const body = document.querySelector('[data-diff-body]') as HTMLElement
    // Fake a 440px viewport (20 rows) and let the scroller report it.
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 440 })
    fireEvent.scroll(body)

    const rendered = document.querySelectorAll('[data-diff-row]').length
    // 20 visible + overscan, far fewer than the whole 4000-row file.
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
  })

  it('tokenizes only a bounded window of a large file, leaving the rest plain', async () => {
    // A long TypeScript file with one change on its first line: the rows below are
    // context, so a row past the window cap of 400 lines is plainly not tokenized
    // (and the text is still there — a viewer never trades content for color).
    const source = `${Array.from({ length: 900 }, (_, index) => `const v${index} = ${index}`).join('\n')}\n`
    const big = entry({
      id: 'entry-window', path: '/repo/a.ts',
      oldText: source, newText: source.replace('const v0 = 0', 'const v0 = 1000'),
    })
    const props = panelProps({ read: true, files: [big], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.ts'))

    await waitFor(() => { expect(vi.mocked(highlightWindow).mock.calls.length).toBeGreaterThan(0) })
    const spans = vi.mocked(highlightWindow).mock.calls.map(call => ({ from: call[2], to: call[3] }))
    // Bounded, and nowhere near the 900-line file.
    for (const span of spans) expect(span.to - span.from).toBeLessThanOrEqual(400)
    expect(spans.some(span => span.from <= 5)).toBe(true)

    // The rows the window did not reach render as plain text: no token spans.
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const far = rows[700]!
    const farCode = far.querySelector('[data-diff-code]') ?? far
    expect(farCode.textContent).toMatch(/^const v\d+ = \d+$/)
    expect(farCode.querySelectorAll('span').length).toBe(0)
    // A row inside the window is highlighted.
    const near = rows[2]!
    const nearCode = near.querySelector('[data-diff-code]') ?? near
    expect(nearCode.querySelectorAll('span').length).toBeGreaterThan(0)
  })

  it('highlights the window a jump lands on, and reuses it when nudging nearby', async () => {
    const big = entry({
      id: 'entry-window-end', path: '/repo/a.ts',
      oldText: 'const a = 1\n'.repeat(900), newText: 'const a = 2\n'.repeat(900),
    })
    const props = panelProps({ read: true, files: [big], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.ts'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 440 })

    // Scroll to the end: the pass that follows must cover the tail window only,
    // never the file above it.
    vi.mocked(highlightWindow).mockClear()
    body.scrollTop = 1800 * 22 - 440
    fireEvent.scroll(body)
    const tail = (): number[][] => vi.mocked(highlightWindow).mock.calls
      .map(call => [call[2], call[3]])
      .filter(([from]) => (from ?? 0) > 500)
    await waitFor(() => { expect(tail().length).toBeGreaterThan(0) })

    // A few rows of scroll stay inside the highlighted margin, so nothing is
    // re-tokenized (the store keeps what it has already done).
    const before = tail().length
    body.scrollTop = 1800 * 22 - 440 - 3 * 22
    fireEvent.scroll(body)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(tail().length).toBe(before)
  })

  it('warns on the row when a tracked file is gone and explains when expanded', () => {
    const gone = entry({ missing: true })
    const props = panelProps({ read: true, files: [gone], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getByText('panel.missing')).toBeDefined()
    fireEvent.click(screen.getByText('a.txt'))
    expect(screen.getByText('panel.missingHint')).toBeDefined()
  })

  it('defers a redo-cleared notice until the panel is open, then dismisses it', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set(), redoCleared: true })
    const view = render(<PendingPanel {...props} />)

    // Deferred while closed: no notice, and the latch is not acked.
    expect(document.querySelector('[data-diff-approval-notice]')).toBeNull()
    expect(props.onAckRedoCleared).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('panel.aria'))
    // Opening surfaces the latched notice once and acks it.
    expect(screen.getByText('panel.externalChanged')).toBeDefined()
    expect(props.onAckRedoCleared).toHaveBeenCalledTimes(1)

    fireEvent.click(document.querySelector('[data-diff-notice-dismiss]') as HTMLElement)
    expect(document.querySelector('[data-diff-approval-notice]')).toBeNull()
  })

  it('moves the panel edge by edge as the coverage switches are flipped', () => {
    // A centre column with real insets: a 56px rail on the left, a 400px right
    // sidebar, and a 60px header above (the values the shell reports).
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scroll)
    scroll.getBoundingClientRect = () => ({
      left: 56, right: 800, width: 744, top: 60, bottom: 800, height: 740, x: 56, y: 60, toJSON: () => ({}),
    }) as DOMRect
    try {
      const props = panelProps({ read: true, files: [FILE], busy: new Set() })
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))

      const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement
      const presentation = document.querySelector('[data-diff-approval-presentation]') as HTMLElement
      expect(presentation).not.toBeNull()
      // The close button sits to the right of the presentation control.
      const close = document.querySelector('[data-diff-approval-close]') as HTMLElement
      expect(close.compareDocumentPosition(presentation) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
      // The default coverage is the header and both sidebars, not the composer: the
      // panel stops at the measured composer offset, and its other edges sit against
      // the window.
      expect(panel.style.top).toBe('8px')
      expect(panel.style.bottom).toBe('128px')
      expect(panel.style.left).toBe('8px')
      expect(panel.style.right).toBe('8px')

      /** Open the coverage popover, which stays up for the next switch. */
      const popover = (): HTMLElement => {
        const trigger = document.querySelector('[data-diff-approval-cover]') as HTMLElement
        expect(trigger).not.toBeNull()
        if (document.querySelector('[data-diff-approval-cover-popover]') === null) fireEvent.click(trigger)
        const list = document.querySelector('[data-diff-approval-cover-popover]')
        expect(list).not.toBeNull()
        return list as HTMLElement
      }
      /** Flip one coverage switch; the popover stays open across switches. */
      const toggle = (key: string): void => {
        popover()
        fireEvent.click(document.querySelector(`[data-diff-approval-cover-switch="${key}"]`) as HTMLElement)
      }
      // Covering the composer pins the panel to the window's bottom edge…
      toggle('composer')
      expect(panel.style.bottom).toBe('8px')
      expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":true,"left":true,"right":true,"composer":true}')
      // …and the switch is a toggle: flipping it back restores the composer offset.
      toggle('composer')
      expect(panel.style.bottom).toBe('128px')

      // Not covering the header starts the panel at the conversation's own top
      // edge (the view tabs' when there are any) — no gap, or a strip of those
      // tabs would poke out above it…
      toggle('top')
      expect(panel.style.top).toBe('60px')
      // …while the sides keep a gap from the rail they leave visible.
      toggle('left')
      expect(panel.style.left).toBe('64px')
      toggle('right')
      expect(panel.style.right).toBe('408px')
      expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":false,"left":false,"right":false,"composer":false}')
    } finally {
      scroll.remove()
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
      if (originalHeight !== undefined) Object.defineProperty(window, 'innerHeight', originalHeight)
      else delete (window as { innerHeight?: unknown }).innerHeight
    }
  })

  it('offers the coverage switches as one row, each showing its own state', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)

    const popover = document.querySelector('[data-diff-approval-cover-popover]') as HTMLElement
    expect(popover).not.toBeNull()
    const switches = [...popover.querySelectorAll('[data-diff-approval-cover-switch]')] as HTMLElement[]
    // One row: left, top, right, bottom.
    expect(switches.map(node => node.dataset.diffApprovalCoverSwitch)).toEqual(['left', 'top', 'right', 'composer'])
    for (const node of switches) {
      // A glyph button with its own label — the tooltip's source.
      expect(node.querySelector('svg')).not.toBeNull()
      expect(node.getAttribute('aria-label')).toMatch(/^cover\./)
    }
    // The default coverage is the header and both sidebars, not the composer.
    expect(switches.map(node => node.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'false'])

    // Escape closes the popover alone: the panel stays up for the next switch.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('[data-diff-approval-cover-popover]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // As does a press outside it — including on the mode switch beside it, which
    // stops its own presses from bubbling (the dock chip's tab-drag guard): the
    // popover takes the press in the capture phase so it still hears it.
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    expect(document.querySelector('[data-diff-approval-cover-popover]')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[data-diff-approval-cover-popover]')).toBeNull()

    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    fireEvent.pointerDown(document.querySelector('[data-diff-approval-presentation]') as HTMLElement)
    expect(document.querySelector('[data-diff-approval-cover-popover]')).toBeNull()
  })

  it('names both ways out on the close button, with the chord the user bound', () => {
    // The panel closes with Escape and with the quick-summon chord, so the tooltip
    // names both — and names the chord as bound, arrow keys as glyphs.
    localStorage.setItem('diff-approval:quick-summon-key', 'Ctrl+ArrowUp')
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.focus(document.querySelector('[data-diff-approval-close]') as HTMLElement)
    expect(screen.getByText('action.closeHint {"chord":"Ctrl+↑"}')).toBeDefined()
  })

  it('falls back to Escape alone when the summon chord is unbound', () => {
    // A user who unbound the chord (recording, then pressing elsewhere) has one
    // way out, not a hint naming a chord that does nothing.
    localStorage.setItem('diff-approval:quick-summon-key', '')
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    const tooltips = (): string[] => screen.getAllByRole('tooltip').map(node => node.textContent ?? '')

    // The footer entry names itself rather than showing an empty parenthetical.
    fireEvent.focus(screen.getByLabelText('panel.aria'))
    expect(tooltips()).toContain('panel.aria')
    expect(tooltips().some(text => text.includes('summonHint'))).toBe(false)

    // The close button names Escape and nothing else: no chord is advertised.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.focus(document.querySelector('[data-diff-approval-close]') as HTMLElement)
    expect(tooltips()).toContain('action.closeHintEsc')
    expect(tooltips().some(text => text.startsWith('action.closeHint '))).toBe(false)
  })

  it('advertises the bound chord on the footer entry, not the default', () => {
    localStorage.setItem('diff-approval:quick-summon-key', 'Alt+P')
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)

    // The footer entry: what it opens, plus the chord that does the same — read
    // from the stored binding, so a rebind in Settings shows up here.
    fireEvent.focus(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('action.summonHint {"chord":"Alt+P"}')).toBeDefined()
  })

  it('toggles each coverage edge from its own chord, and yields inside text fields', () => {
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement
    expect(panel.style.bottom).toBe('128px')

    // The composer edge has its own chord…
    fireEvent.keyDown(document.body, { key: 'ArrowDown', ctrlKey: true, shiftKey: true })
    expect(panel.style.bottom).toBe('8px')
    // …and each sidebar edge flips only itself.
    fireEvent.keyDown(document.body, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":true,"left":false,"right":true,"composer":true}')
    fireEvent.keyDown(document.body, { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":true,"left":false,"right":false,"composer":true}')
    // The header above has one too (no measured header in this bare DOM, so the
    // edge lands at 0 — the geometry case above covers the real numbers).
    fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(panel.style.top).toBe('0px')
    expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":false,"left":false,"right":false,"composer":true}')

    // The chat composer keeps them: that is where the caret usually is when the
    // panel's edges need rearranging.
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.contentEditable = 'true'
    document.body.appendChild(composer)
    fireEvent.keyDown(composer, { key: 'ArrowDown', ctrlKey: true, shiftKey: true })
    expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":false,"left":false,"right":false,"composer":false}')

    // Every other text field keeps Ctrl+Shift+Arrow for word-wise selection.
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    fireEvent.keyDown(field, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":false,"left":false,"right":false,"composer":false}')
  })

  it('echoes a chord flip on screen, without making it pressable', () => {
    vi.useFakeTimers()
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      expect(document.querySelector('[data-diff-approval-cover-notice]')).toBeNull()

      fireEvent.keyDown(document.body, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
      const notice = document.querySelector('[data-diff-approval-cover-notice]') as HTMLElement
      expect(notice).not.toBeNull()
      // The same row of glyphs the popover shows, all of them, in its order…
      const glyphs = [...notice.querySelectorAll('[data-diff-approval-cover-notice-glyph]')] as HTMLElement[]
      expect(glyphs.map(node => node.dataset.diffApprovalCoverNoticeGlyph)).toEqual(['left', 'top', 'right', 'composer'])
      // …with the edge that just changed marked, and its new state shown.
      expect(glyphs[0]!.hasAttribute('data-changed')).toBe(true)
      expect(glyphs[0]!.hasAttribute('data-on')).toBe(false)
      // Nothing in it is a control.
      expect(notice.querySelector('button')).toBeNull()

      // It clears itself: a report that stayed would need dismissing.
      act(() => { vi.advanceTimersByTime(1300) })
      expect(document.querySelector('[data-diff-approval-cover-notice]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the echo to the chords: clicking a switch reports itself in place', () => {
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="composer"]') as HTMLElement)
    expect(document.querySelector('[data-diff-approval-cover-notice]')).toBeNull()
  })

  it('closes the docked panel from the quick-summon chord', () => {
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.tabIndex = -1
    document.body.appendChild(composer)
    const closeDock = vi.fn()
    const props = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      closeDock,
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: true }),
    }
    render(<PendingPanel {...props} />)
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
    // The chord closed the dock tab (the chip published its close) instead of
    // opening a second copy of the panel in the overlay — and handed the caret
    // back to the composer, exactly as the floating close does.
    expect(closeDock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })

  it('hands the caret back to the composer when the panel is closed, not when clicked away', () => {
    // The chat composer's editable box, as the harness marks it.
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.tabIndex = -1
    document.body.appendChild(composer)

    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)

    // Closing with the ✕ is a "done reviewing, back to typing" move.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    document.body.focus()
    fireEvent.click(document.querySelector('[data-diff-approval-close]') as HTMLElement)
    expect(document.activeElement).toBe(composer)

    // As is Escape, and the quick-summon chord.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    document.body.focus()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.activeElement).toBe(composer)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    document.body.focus()
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
    expect(document.activeElement).toBe(composer)
  })

  it('covers the edges instead of squeezing the panel away on a small window', () => {
    // A phone-sized window: the sidebar's column is most of the width, so leaving
    // it uncovered would compute a panel with no room left — and an invisible
    // panel is worse than a covered sidebar.
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scroll)
    scroll.getBoundingClientRect = () => ({
      left: 280, right: 390, width: 110, top: 60, bottom: 640, height: 580, x: 280, y: 60, toJSON: () => ({}),
    }) as DOMRect
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement

      // Uncovering the left sidebar would leave 288 … 382 — a sliver — so the edge
      // stays covered and the panel keeps the window. The preference is still
      // stored: the floor overrules the geometry, not the user's choice.
      fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
      fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="left"]') as HTMLElement)
      expect(localStorage.getItem('diff-approval:float-cover')).toBe('{"top":true,"left":false,"right":true,"composer":false}')
      expect(panel.style.left).toBe('8px')
      expect(panel.style.right).toBe('8px')
    } finally {
      scroll.remove()
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
      if (originalHeight !== undefined) Object.defineProperty(window, 'innerHeight', originalHeight)
      else delete (window as { innerHeight?: unknown }).innerHeight
    }
  })

  it('covers the composer instead of squeezing the panel on a short window', () => {
    // The height floor's own case: a window just tall enough for the composer to
    // leave a band too thin to draw in. The uncovered composer is the stored
    // preference, and it stays stored — the geometry loses, not the choice.
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    const scroll = document.createElement('div')
    scroll.setAttribute('data-conversation-scroll', '')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scroll.appendChild(seat)
    document.body.appendChild(scroll)
    seat.getBoundingClientRect = () => ({
      top: 200, bottom: 300, height: 100, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect

    try {
      render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement

      // Composer uncovered by default: 300 - 8 - (300 - 200 + 12) = 180, too thin,
      // so the composer edge is covered after all and the panel keeps its height.
      expect(localStorage.getItem('diff-approval:float-cover')).toBeNull()
      expect(panel.style.bottom).toBe('8px')
      expect(panel.style.top).toBe('8px')
    } finally {
      scroll.remove()
      if (originalHeight !== undefined) Object.defineProperty(window, 'innerHeight', originalHeight)
      else delete (window as { innerHeight?: unknown }).innerHeight
    }
  })

  it('follows a flip made in the panel, not only the other way round', () => {
    // The two surfaces are separate mounts sharing the stored cover. The settings
    // rows learned about a flip by subscribing, so a stale switch cannot sit there
    // showing the opposite of what the panel now does.
    const panel = render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const settingsProps = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...settingsProps} />)
    fireEvent.click(document.querySelector('[data-diff-cover-toggle]') as HTMLButtonElement)
    const row = (edge: string): HTMLElement => document.querySelector(`[data-diff-cover-${edge}]`) as HTMLElement
    expect(row('left').getAttribute('aria-checked')).toBe('true')
    expect(row('composer').getAttribute('aria-checked')).toBe('false')

    // Flip both in the panel's own popover.
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="left"]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="composer"]') as HTMLElement)

    expect(row('left').getAttribute('aria-checked')).toBe('false')
    expect(row('composer').getAttribute('aria-checked')).toBe('true')
    panel.unmount()
  })

  it('advertises each coverage switch\'s own chord, as bound', () => {
    // The panel has four rebindable coverage chords, so the buttons that flip the
    // same switches name them — read at render time, like every other hint.
    localStorage.setItem('diff-approval:key:coverLeft', 'Alt+L')
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)

    const label = (edge: string): string =>
      (document.querySelector(`[data-diff-approval-cover-switch="${edge}"]`) as HTMLElement).getAttribute('aria-label') ?? ''
    expect(label('left')).toBe('cover.left (Alt+L)')
    expect(label('top')).toBe('cover.top (Ctrl+Shift+↑)')
    expect(label('right')).toBe('cover.right (Ctrl+Shift+→)')
    expect(label('composer')).toBe('cover.composer (Ctrl+Shift+↓)')
  })

  it('tells the search bar\'s close button that Escape closes it', () => {
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-search-toggle]') as HTMLElement)

    // The bar is the innermost dismissible, so Esc closes it rather than the panel.
    fireEvent.focus(document.querySelector('[data-diff-search-close]') as HTMLElement)
    expect(screen.getAllByText('action.closeHintEsc').length).toBeGreaterThan(0)
  })

  it('lays a sidebar-colored backdrop over the seam only when everything is covered', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Both sidebars is the plain floating panel: no backdrop.
    expect(document.querySelector('[data-diff-cover-backdrop]')).toBeNull()

    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="composer"]') as HTMLElement)
    const backdrop = document.querySelector('[data-diff-cover-backdrop]') as HTMLElement
    expect(backdrop).not.toBeNull()

    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="left"]') as HTMLElement)
    expect(document.querySelector('[data-diff-cover-backdrop]')).toBeNull()
  })

  it('shows the selection reference in the status bar when text is selected', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBeGreaterThan(1)
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 1,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // The status bar shows the line-range reference once lines are selected.
    // No workspace is known, so the reference carries the absolute path. The
    // button displays the reference without the token-wrapping parentheses
    // (the copied/pasted payload keeps them).
    expect(document.querySelector('[data-diff-status-bar]')).not.toBeNull()
    expect(screen.getByText('/repo/a.txt:1')).toBeDefined()
    expect(document.querySelector('[data-diff-copy]')).not.toBeNull()
  })

  it('uses a workspace-relative reference when the file is inside the workspace', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set(), workspacePath: '/repo' })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 1,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // Inside the workspace the reference drops the root and stays relative.
    expect(screen.getByText('a.txt:1')).toBeDefined()
  })

  it('shows the reference when a selection starts in the line-number gutter', () => {
    // The reported drag-right-to-left bug: the selection boundary lands on the
    // left line-number cell, so rowRangeOf measured it against an empty code
    // cell (0 >= 0), skipped the row, and hid the copy-reference toolbar. The
    // gutter boundary must now measure against the line's own code text.
    const file = entry({ id: 'entry-ctx', oldText: 'a\nb\n', newText: 'a\nB\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const row0 = rows[0]!
    const gutter0 = row0.children[0] ?? row0 // the left line-number cell
    const code0 = row0.querySelector('[data-diff-code]') ?? row0
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: gutter0.firstChild ?? gutter0,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: gutter0.firstChild ?? gutter0,
        startOffset: 0,
        endContainer: code0.firstChild ?? code0,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // The gutter-start selection still yields a copyable reference for the row.
    expect(document.querySelector('[data-diff-status-bar]')).not.toBeNull()
    expect(screen.getByText('/repo/a.txt:1')).toBeDefined()
  })

  it('shows a keep/revert frame for a selection spanning multiple blocks', async () => {
    // 'a\nb\nc\nd\n' -> 'A\nb\nC\nd\n' has two change blocks (lines 1 and 3).
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(6)
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code5 = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const startNode = code0.firstChild ?? code0
    const endNode = code5.firstChild ?? code5
    const selection = {
      isCollapsed: false,
      anchorNode: startNode,
      focusNode: endNode,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: startNode,
        startOffset: 0,
        endContainer: endNode,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // The multi-block selection frame shows, with only keep/revert (no block
    // number and no prev/next).
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    expect(document.querySelector('[data-diff-selection-actions] [data-diff-block-position]')).toBeNull()
    expect(document.querySelector('[data-diff-selection-actions] [data-diff-block-prev]')).toBeNull()
    expect(document.querySelector('[data-diff-selection-actions] [data-diff-block-next]')).toBeNull()

    // Keep applies the combined range in a single call, but since this covers
    // the file's last change it must prompt for remove-or-keep first.
    fireEvent.click(document.querySelector('[data-diff-selection-keep]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()
    expect(props.onBlockKeep).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('[data-diff-confirm-remove]') as HTMLButtonElement)
    expect(props.onBlockKeep).toHaveBeenCalledWith(S1, 'entry-multi', { oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 3 }, true)

    // The operated blocks leave the diff, so the selection is cleared and the
    // multi-block frame hides — the old row-range must not linger offset.
    await act(async () => {})
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()
    expect(document.querySelector('[data-diff-copy]')).toBeNull()
  })

  it('holds back the browser\'s selection menu on its own surface, and nowhere else', () => {
    // Edge floats a mini menu (copy / search / define) over a text selection once the mouse is
    // released. It is browser chrome, so the panel cannot style it — but it waits on the
    // release's default action, and the panel takes that action away for releases inside its own
    // surface. Selection itself is untouched, which is why this is done rather than making the
    // text unselectable. `fireEvent` reports false when an event's default was prevented.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // Over the code, and over the panel's own chrome (the file list): prevented.
    expect(fireEvent.mouseUp(document.querySelector('[data-diff-code]') as HTMLElement)).toBe(false)
    expect(fireEvent.mouseUp(document.querySelector('[data-diff-approval-file-list]') as HTMLElement)).toBe(false)

    // A field the reader selects text in keeps the browser's own UI.
    fireEvent.click(screen.getByLabelText('action.search'))
    expect(fireEvent.mouseUp(document.querySelector('[data-diff-search-input]') as HTMLElement)).toBe(true)

    // Outside the panel is the app's DOM, not ours to change.
    expect(fireEvent.mouseUp(document.body)).toBe(true)
  })

  it('comments on a selection that covers no change block', async () => {
    // 'a\nb\nc\nd\n' -> 'A\nb\nC\nd\n' renders six rows; row 5 is unchanged
    // context, so a selection over it covers no change block. Keep/revert must
    // disappear (nothing to keep) while commenting stays available, and the block
    // it creates has to reserve whole rows so the rows below it are pushed down.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(6)
    const code = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const node = code.firstChild ?? code
    const selection = {
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      // The toolbar's comment action consumes the selection, so the double must
      // support the verb a real Selection does.
      removeAllRanges: () => {},
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    const frame = document.querySelector('[data-diff-selection-actions]')
    expect(frame).not.toBeNull()
    expect((document.querySelector('[data-diff-selection-keep]') as HTMLButtonElement).hidden).toBe(true)
    expect((document.querySelector('[data-diff-selection-revert]') as HTMLButtonElement).hidden).toBe(true)
    // Nothing to keep, so the frame holds one group: no divider with nothing on its
    // left, which would read as a broken frame.
    expect(document.querySelector('[data-diff-selection-divider]')).toBeNull()

    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    // The commented rows are washed with the discussion's band, and the block
    // hangs below them: three rows open (an integer multiple of the 22px code
    // row), one row folded. The live selection is consumed by the block, so the
    // toolbar goes with it and only the band marks the rows.
    expect(document.querySelector('[data-diff-discussion-band]')).not.toBeNull()
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(block).not.toBeNull()
    expect(block.style.height).toBe('66px')
    // The rows the block reserves are in the DOM, which is what pushes the code
    // after it down instead of letting the block float over it.
    const space = document.querySelector('[data-diff-discussion-space]') as HTMLElement
    expect(space).not.toBeNull()
    expect(space.style.height).toBe('66px')
    expect(document.querySelector('[data-diff-discussion-range]')?.textContent).toBe('/repo/m.txt:4')
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()

    // The user asked to comment, so the caret is already in the new block's input.
    expect(document.activeElement).toBe(document.querySelector('[data-diff-discussion-input]'))

    // A selection that merely TOUCHES the commented rows offers no second
    // comment either: those rows already belong to that annotation.
    const overlapping = {
      isCollapsed: false,
      anchorNode: (rows[4]!.querySelector('[data-diff-code]') ?? rows[4]!).firstChild ?? rows[4]!,
      focusNode: (rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!).firstChild ?? rows[5]!,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: (rows[4]!.querySelector('[data-diff-code]') ?? rows[4]!).firstChild ?? rows[4]!,
        startOffset: 0,
        endContainer: (rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!).firstChild ?? rows[5]!,
        endOffset: 1,
      }),
      removeAllRanges: () => {},
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(overlapping)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()

    // Enter in the input sends the comment, like the composer's own field.
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    expect(props.onPasteReference).not.toHaveBeenCalled()
    // The prompt carries the marker and the range, so the answer can be matched
    // back to this block even while the session is doing other things.
    const asked = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]
    expect(asked?.[0]).toBe('session-1')
    expect(asked?.[1].startsWith('discussion.marker (/repo/m.txt:4)\nwhy?')).toBe(true)
    // The block stays open and says it is thinking, with no compose row left.
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-input]')).toBeNull()

    // The answer arrives through the watcher: it lands in the block, on the file
    // the question was about, and the block grows to hold its wrapped lines. The
    // prompt is in the transcript by then - that is what marks the turn as ours.
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
    expect(listener).toBeDefined()
    const prompt = { kind: 'user', text: asked?.[1] ?? '' }
    act(() => {
      listener!({ running: true, nodes: [prompt], partial: 'the answer', error: undefined })
    })
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('the answer')
    // …and while it is still being written the block says so, right under the text that has
    // arrived: the note that said 思考中 is drawn only until the first token lands, so without this
    // line the block would look finished while the rest of the answer is still coming.
    const writing = document.querySelector('[data-diff-discussion-answering]')
    expect(writing?.textContent).toContain('discussion.answering')
    expect(document.querySelector('[data-diff-discussion-asking]')).toBeNull()
    expect(writing?.previousElementSibling).toBe(document.querySelector('[data-diff-discussion-reply]'))
    // The line is a thread row of its own, and the block reserves it: the header, the question's
    // bubble (a line and its chrome), the streamed answer, and the line that says more is coming.
    const streamingBlock = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(streamingBlock.style.height).toBe('110px')
    act(() => {
      listener!({ running: false, nodes: [prompt, { kind: 'assistant', text: 'the final answer' }], partial: '', error: undefined })
    })
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('the final answer')
    expect(document.querySelector('[data-diff-discussion-answering]')).toBeNull()
    // The line's row comes off with it, and the writing row (two rows) returns for a follow-up —
    // which is one row more than the line cost.
    expect(Number.parseFloat(streamingBlock.style.height)).toBe(132)
    // The answer settled into the thread, so the compose row is back for a
    // follow-up: the conversation continues instead of ending with one answer.
    expect(document.querySelector('[data-diff-discussion-user]')?.textContent).toBe('why?')
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'and then?' } })
    fireEvent.click(document.querySelector('[data-diff-discussion-send]') as HTMLButtonElement)
    expect(document.querySelectorAll('[data-diff-discussion-user]').length).toBe(2)
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()
    expect((props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls.length).toBe(2)

    // The block can be finished from its overflow menu; its rows leave the
    // height table with it, and the same rows become commentable once more.
    fireEvent.click(document.querySelector('[data-diff-discussion-menu]') as HTMLButtonElement)
    // The stub translator returns the key, so the menu item is found by its key.
    fireEvent.click(screen.getByText('action.discussionEnd'))
    expect(document.querySelector('[data-diff-discussion]')).toBeNull()
    expect(document.querySelector('[data-diff-discussion-band]')).toBeNull()
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(document.querySelector('[data-diff-selection-comment]')).not.toBeNull()
  })

  it('refuses a second question while the session is still answering the first', async () => {
    // One ask at a time. An answer is read out of the session's transcript by matching the prompt
    // it answers, and only one of those is tracked at a time (see `pendingAskRef`): a second block
    // asking while the first waits took that bookkeeping over, and the first answer could settle
    // into the wrong thread. The second writing row stays usable and says so with its button.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const select = (index: number): void => {
      const node = rows[index]!.querySelector('[data-diff-code]')?.firstChild ?? rows[index]!
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
    }
    const asked = (): number => (props.onAskAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls.length

    // The first comment goes out: the session is answering it now.
    select(0)
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()
    expect(asked()).toBe(1)

    // A second comment on another row: its writing row opens, and its button refuses.
    select(1)
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const send = document.querySelector('[data-diff-discussion-send]') as HTMLButtonElement
    expect(send).not.toBeNull()
    expect(send.disabled).toBe(true)
    const input = document.querySelector('[data-diff-discussion-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'and this one?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(asked()).toBe(1)
    // …and the draft is still there for when the answer lands.
    expect((document.querySelector('[data-diff-discussion-input]') as HTMLInputElement).value).toBe('and this one?')
  })

  it('keeps the selection when a real press lands on the frame that acts on it', () => {
    // The frame's 评论 button comments on the selection, so a press on it must leave the selection
    // standing. (A press in a browser is mousedown AND click: firing only the click is what let a
    // blanket "press on chrome drops the selection" break the button without any test noticing.)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const cell = rows[1]!.querySelector('[data-diff-code]') as HTMLElement
    const node = cell.firstChild ?? cell
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: node,
      focusNode: node,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges,
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    const comment = document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement
    expect(comment).not.toBeNull()
    fireEvent.mouseDown(comment)
    expect(removeAllRanges).not.toHaveBeenCalled()
    fireEvent.click(comment)
    expect(document.querySelector('[data-diff-discussion]')).not.toBeNull()
  })

  it('drops a text selection when a press lands on the panel\'s chrome', () => {
    // The panel's chrome is `user-select: none`, and a press on such an area is one the browser
    // does NOT clear the selection for: the highlight stayed up, and the selection frame with it,
    // over a gesture that plainly ended. Content keeps its selection; chrome drops it.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const cell = rows[1]!.querySelector('[data-diff-code]') as HTMLElement
    const node = cell.firstChild ?? cell
    const removeAllRanges = vi.fn()
    let cleared = false
    vi.spyOn(window, 'getSelection').mockReturnValue({
      get isCollapsed() { return cleared },
      get rangeCount() { return cleared ? 0 : 1 },
      anchorNode: node,
      focusNode: node,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => { cleared = true; removeAllRanges() },
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()

    // A press on the toolbar — chrome — drops the selection, and the frame with it.
    fireEvent.mouseDown(document.querySelector('[data-diff-toolbar]') as HTMLElement)
    expect(removeAllRanges).toHaveBeenCalled()
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()

    // A press on the code keeps it: that is where a selection is made.
    removeAllRanges.mockClear()
    fireEvent.mouseDown(cell)
    expect(removeAllRanges).not.toHaveBeenCalled()
  })

  it('marks a comment outdated when the code it was about is gone, and takes it back when it returns', async () => {
    // A comment stores the lines it was written about. When a later rebuild of the diff
    // no longer holds them, the thread is not silently re-hung on whatever took their
    // place: it says it is outdated, shows that code, and stops taking input — those rows
    // are not annotated any more, so there is no current line to write about.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    // 'a\n' -> 'b\n': the comment goes on the added row, so the line it quotes is
    // new-file line 1, and that is what the block must keep showing it was about.
    const node = rows[1]!.querySelector('[data-diff-code]')?.firstChild ?? rows[1]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-discussion]')?.hasAttribute('data-lost')).toBe(false)
    expect(document.querySelector('[data-diff-discussion-band]')).not.toBeNull()

    // The quote is a window onto the file's columns, so it pans with the code. jsdom does no
    // layout, so the body's horizontal offset is wired by hand here — before the rewrite, so the
    // very first render that draws a quote draws it under code that is already sideways.
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    let bodyOffset = 0
    Object.defineProperty(body, 'scrollLeft', { get: () => bodyOffset, set: (value: number) => { bodyOffset = value } })
    bodyOffset = 37

    // The file is rewritten under the comment: the line numbers are still in the model,
    // but they hold other code and the quote is nowhere to be found. The props are held in a
    // variable because the panel renders with THEM from here on: the ask below lands on this
    // object's mocks, not on the first render's.
    const rewritten = panelProps({ read: true, files: [entry({ oldText: 'x\n', newText: 'y\n' })], busy: new Set() })
    view.rerender(<PendingPanel {...rewritten} />)
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(block.hasAttribute('data-lost')).toBe(true)
    // Nothing in the header says it: the header keeps to the position the thread names — path and
    // lines — and the state is carried by the block's own colour and by the label over the quote.
    expect(document.querySelector('[data-diff-discussion-range]')?.parentElement?.textContent)
      .toBe(document.querySelector('[data-diff-discussion-range]')?.textContent)
    // No row is washed any more: the rows under those numbers are not the commented code,
    // so a band there would claim them for a thread that says it no longer matches.
    expect(document.querySelector('[data-diff-discussion-band]')).toBeNull()
    // What the comment was about keeps it readable now that the rows have moved on, laid out
    // the way the file lays its own rows out: the numbers in the file's two gutters, the code
    // in the column beside them, one row each.
    // …and the label in front of it is what says the block is outdated.
    expect(document.querySelector('[data-diff-discussion-quote-label]')?.textContent).toBe('discussion.outdatedQuote')
    const quote = document.querySelector('[data-diff-discussion-quote]') as HTMLElement
    expect(quote.textContent).toBe('1b')
    // The added line the comment was made on has no old-side number, exactly as in the file.
    expect([...quote.querySelectorAll('[data-diff-quote-gutter]')].map(cell => cell.textContent)).toEqual(['', '1'])
    // It stays where it last matched, so the range label is still the original one, and it
    // reserves what it draws: the quote label and the quoted code row, then the two compose
    // rows under the header.
    expect(document.querySelector('[data-diff-discussion-range]')?.textContent).toBe('/repo/a.txt:1')
    expect(block.style.height).toBe('110px')
    expect((block.closest('[data-diff-discussion-space]') as HTMLElement).style.height).toBe('110px')
    // The one spare row the block may have reserved is taken by a spacer of its own, and it sits
    // directly above the writing row rather than anywhere else in the thread (see
    // `.discussionSlack`): it is the only child that may carry air, and it is capped at a row.
    const slack = block.querySelector('[data-diff-discussion-slack]') as HTMLElement
    expect(slack).not.toBeNull()
    expect(block.contains(slack)).toBe(true)
    expect(slack.nextElementSibling?.querySelector('[data-diff-discussion-input]')).not.toBeNull()

    // The quote was drawn while the code was already sideways, and shows the same columns.
    const quoteText = (): HTMLElement => document.querySelector('[data-diff-quote-text]') as HTMLElement
    expect(quoteText().scrollLeft).toBe(37)
    // From then on the two travel together: a scroll of the code is written straight into the
    // quote, so the columns under the numbers never drift.
    bodyOffset = 64
    fireEvent.scroll(body)
    expect(quoteText().scrollLeft).toBe(64)

    // The quoted line is CODE, so its row is the code's row, not the thread's: with a 30px code
    // line height the block is 22 (header) + 22 (quote label) + 30 (quoted line) + 44 (the two
    // writing rows) — the thread's own prose is what stays on 22px.
    localStorage.setItem('diff-approval:diff-line-height', '30')
    view.rerender(<PendingPanel {...rewritten} />)
    expect((document.querySelector('[data-diff-discussion]') as HTMLElement).style.height).toBe('118px')
    localStorage.removeItem('diff-approval:diff-line-height')
    view.rerender(<PendingPanel {...rewritten} />)
    expect((document.querySelector('[data-diff-discussion]') as HTMLElement).style.height).toBe('110px')

    // The writing row stays in place and keeps taking input: a thread is a conversation, and the
    // code it was about is quoted right above this row, so a reply still has something to be about.
    const input = document.querySelector('[data-diff-discussion-input]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.disabled).toBe(false)
    expect(input.placeholder).toBe('discussion.placeholder')
    expect((document.querySelector('[data-diff-discussion-send]') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'and now?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // What it asks about is the lines the thread was WRITTEN about — the ones the quote shows —
    // and not whatever those numbers hold now.
    const asked = (rewritten.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]
    expect(asked?.[1]).toContain('/repo/a.txt:1')
    expect(asked?.[1]).toContain('and now?')

    // The code comes back (a keep restores the lines), and the mark is derived rather
    // than sticky: it clears instead of condemning the thread for one rebuild — the rows it
    // is about are washed again.
    view.rerender(<PendingPanel {...props} />)
    expect(document.querySelector('[data-diff-discussion]')?.hasAttribute('data-lost')).toBe(false)
    expect(document.querySelector('[data-diff-discussion-band]')).not.toBeNull()
  })

  it('keeps a thread live across a file switch, over a line that was changed', async () => {
    // A changed line is two rows — the one removed and the one that replaced it — with a single
    // new-file number between them, so the thread's quote covers more rows than its anchor spans
    // lines. Reading that row count off the line span condemned the thread on the first rebuild,
    // and switching files IS a rebuild: away and back has to leave the comment exactly as it was.
    const changed = entry({ id: 'entry-changed', path: '/repo/changed.txt', oldText: 'const old = 1\nkeep\n', newText: 'const next = 2\nkeep\n' })
    const other = entry({ id: 'entry-other', path: '/repo/other.txt', oldText: 'x\n', newText: 'y\n' })
    const props = panelProps({ read: true, files: [changed, other], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('changed.txt'))

    // The removed row and the added one, selected together.
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const from = rows[0]!.querySelector('[data-diff-code]')?.firstChild ?? rows[0]!
    const to = rows[1]!.querySelector('[data-diff-code]')?.firstChild ?? rows[1]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: from,
      focusNode: to,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: from, startOffset: 0, endContainer: to, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-discussion-band]')).not.toBeNull()

    // Away to another file…
    fireEvent.click(screen.getByText('other.txt'))
    expect(document.querySelector('[data-diff-discussion]')).toBeNull()
    // …and back: the same thread, still on the rows it was written about.
    fireEvent.click(screen.getByText('changed.txt'))
    expect(document.querySelector('[data-diff-discussion]')?.hasAttribute('data-lost')).toBe(false)
    expect(document.querySelector('[data-diff-discussion-band]')).not.toBeNull()
  })

  it('marks an outdated thread with a grey range rule and a hatch', () => {
    // A thread's left rule is the mark of "this belongs to those rows" — an outdated thread is
    // still hung on the lines it names, so the rule stays — but its code has moved on, and the rule
    // is where that reads: it gives the blue up for the grey, in the same 3px the live state wears,
    // box and every column in the thread are where they were. Behind the turns the block takes a
    // diagonal hatch; the quote sits on its own flat wash on top, so the code the reader came back
    // for is still the easiest thing in the block to read.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /\.discussion\[data-lost\] \{([^}]*)\}/.exec(css)?.[1] ?? ''
    // The live rule carries the brand's colour; the outdated state is what greys it.
    expect(block).toContain('border-left-color: var(--dsw-alias-label-secondary)')
    const live = /\.discussion \{([^}]*)\}/.exec(css)?.[1] ?? ''
    // The token the thread's 评论 button is filled with (see `.actionPrimary`), so the rule and
    // the button are the same blue by construction.
    expect(live).toContain('border-left: 3px solid var(--dsw-alias-state-business-primary)')
    expect(block).not.toContain('border-left-width')
    expect(block).not.toContain('padding-left')
    expect(block).toContain('repeating-linear-gradient(135deg')
    // Thin, equal-width stripes: 4px of ink and 4px of gap, an 8px period — hatching rather than
    // a tint with seams.
    expect(block).toContain('--dsw-alias-interactive-bg-hover) 0 4px')
    expect(block).toContain('transparent 4px 8px')
    // The hatch has to span the box, not just the padding box: an image resolved over the padding
    // box alone would leave the strip the rule occupies filled by tiling it, which breaks the
    // pattern's phase right where the left rule is.
    expect(block).toContain('background-origin: border-box')
    // The quote's own wash: a tint of the surface, mixed down, so the quoted lines read as code
    // without a box being drawn around them.
    const quote = /\.quoteLines \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(quote).toContain('color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 55%, transparent)')
    expect(quote).not.toContain('repeating-linear-gradient')
    // The quote keeps the base table's geometry: its code sits on the columns the file's own rows
    // sit on, and its wash and green/red reach the rule that frames the block.
    expect(/\.discussion\[data-lost\] \.quoteLines/.test(css)).toBe(false)
  })

  it('pins the code view\'s line numbers while the code slides sideways', () => {
    // The numbers are what says which lines these are, so a horizontal scroll must not take them
    // away — the quote's own numbers already hold still, and the file's now do too. The cells stick
    // to the panel's left edge over an opaque surface, and a changed row's tint travels with them.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const pinned = /\.line > \.gutter \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(pinned).toContain('position: sticky')
    expect(pinned).toContain('left: 0')
    // Both columns hold, one gutter along from each other.
    const second = /\.line > \.gutter \+ \.gutter \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(second).toContain('left: 44px')
    // The code view's own surface, and the two washes a row can wear: without them the pinned
    // column reads as a different shade beside its own row.
    expect(pinned).toContain('background-color: var(--dsw-alias-markdown-code-block)')
    expect(pinned).toContain('--diff-row-tint')
    expect(pinned).toContain('--diff-row-wash')
    const discussed = /\.rowDiscussed \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(discussed).toContain('--diff-row-wash: color-mix(')
    expect(discussed).toContain('background-image: linear-gradient(var(--diff-row-wash)')
    // `sticky` needs the table not to collapse: a collapsed table cannot pin a cell.
    expect(/\.lines \{[^}]*\}/.exec(css)?.[0] ?? '').not.toContain('border-collapse')
    for (const name of ['add', 'del']) {
      const rule = new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
      expect(rule, name).toContain('--diff-row-tint: color-mix(')
      expect(rule, name).toContain('background-color: var(--diff-row-tint)')
    }
  })

  it('gives the quote the file\'s own horizontal range, so its pan cannot clamp early', () => {
    // The quote pans with the code (see the outdated test): dragging the code sideways writes the
    // same offset into the quote. That only works while the quote's own scroller is at least as
    // wide as the file's widest line — otherwise the pan clamps the moment the quote runs out of
    // its own characters, and the quoted columns sit out of alignment for the rest of the range.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const rule = /\.quoteNoWrap \.quoteText::after \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('width: calc(var(--dsh-diff-quote-width, 0px) + 100%)')
    expect(rule).toContain('display: inline-block')
    // The panel hands it the same measure the code table is pinned to.
    const file = entry({ path: '/repo/a.txt', oldText: 'a\n', newText: 'aaaaaaaaaaaaaa\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    expect(Number.parseInt(body.style.getPropertyValue('--dsh-diff-quote-width'), 10)).toBeGreaterThanOrEqual(14)
  })

  it('highlights an outdated comment\'s quote with the language the file is read in', async () => {
    // The quote is code, and it sits a few rows under code that IS coloured: rendered plain it
    // reads as a different kind of thing. It takes the same highlighter and the same language,
    // and the same two gutter columns the file itself uses.
    const file = entry({ path: '/repo/a.ts', oldText: 'const before = 1\n', newText: 'const after = 2\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.ts'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[1]!.querySelector('[data-diff-code]')?.firstChild ?? rows[1]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    // Rewritten, so the quote no longer matches anything and the thread goes outdated.
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [entry({ path: '/repo/a.ts', oldText: 'let x = 3\n', newText: 'let y = 4\n' })], busy: new Set() })} />)
    const quote = document.querySelector('[data-diff-discussion-quote]') as HTMLElement
    expect(quote.textContent).toContain('const after = 2')
    expect([...quote.querySelectorAll('[data-diff-quote-gutter]')].map(cell => cell.textContent)).toEqual(['', '1'])
    // Shiki's colours ride inline styles (the theme's `--shiki-*` custom properties), which is
    // how the code rows are coloured too.
    expect(quote.querySelector('span[style*="--shiki-"]')).not.toBeNull()
    // The quoted row keeps the colour the file gave it: the row this thread was made on is an
    // added line, so the quote says so — a quote of added and removed lines that renders as plain
    // code loses exactly what the reader was looking at.
    expect(quote.querySelector('[data-diff-quote-kind]')?.getAttribute('data-diff-quote-kind')).toBe('add')
  })

  it('washes a quoted row with the file\'s green and red, a step fainter than the file itself', () => {
    // The quote takes the diff's own colours (`.add` / `.del`), so a theme change cannot leave it
    // behind — but at a lower strength than the rows under review: a quote is a memory of the code,
    // shown for what it was rather than as the change being read. jsdom applies no stylesheet, so
    // this reads the module the panel ships.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const rule = (name: string): string => new RegExp(`^\\.${name} \\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''
    const strength = (block: string): number => Number(/(\d+)%, transparent/.exec(block)?.[1] ?? '0')
    // Visible, and quieter than the file's own rows.
    expect(strength(rule('quoteAdd'))).toBeGreaterThan(0)
    expect(strength(rule('quoteDel'))).toBeGreaterThan(0)
    expect(strength(rule('quoteAdd'))).toBeLessThan(strength(rule('add')))
    expect(strength(rule('quoteDel'))).toBeLessThan(strength(rule('del')))
    expect(rule('quoteAdd')).toContain('--dsh-diff-add-color')
    expect(rule('quoteDel')).toContain('--dsh-diff-del-color')
  })

  it('stacks two comments that end up on the same row instead of overlapping them', async () => {
    // Every block reserves rows of its own in the row stream, and the heights of several blocks
    // hanging off one row add up — so two comments that land on the same row (here: both of their
    // ranges vanish when the file is rewritten, and both anchors clamp to the same row) are two
    // rows, one under the other, in the order they were made. Nothing overlaps.
    const file = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const comment = (row: number): void => {
      const line = ([...document.querySelectorAll('[data-diff-row]')] as HTMLElement[])[row]!
      const node = line.querySelector('[data-diff-code]')?.firstChild ?? line
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
      fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    }
    // Two ranges that do not touch: the '+A' row and the '+C' row.
    comment(1)
    comment(4)
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(2)

    // Rewritten down to two rows, so neither range is in the model any more: the '+A' thread
    // keeps the row it last matched (row 1), the '+C' one is put back where its range used to be
    // — which is the same row here — and both hang off it.
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'x\n', newText: 'y\n' })], busy: new Set() })} />)
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(2)
    expect([...document.querySelectorAll('[data-diff-discussion][data-lost]')].length).toBe(2)
    // The original ranges are still what the headers say, so the two are still told apart.
    expect([...document.querySelectorAll('[data-diff-discussion-range]')].map(node => node.textContent))
      .toEqual(['/repo/m.txt:1', '/repo/m.txt:3'])

    const spaces = [...document.querySelectorAll('[data-diff-discussion-space]')] as HTMLElement[]
    expect(spaces.map(space => space.style.height)).toEqual(['110px', '110px'])
    // Both hang in the row stream right below the row they clamp to, one after the other.
    const order = [...document.querySelectorAll('[data-diff-row], [data-diff-discussion-space]')]
      .map(node => node.hasAttribute('data-diff-discussion-space') ? 'space' : node.getAttribute('data-diff-row'))
    expect(order).toEqual(['0', '1', 'space', 'space'])
  })

  it('wraps an outdated comment\'s quote only when the code view wraps', async () => {
    // The quote is the file's own code, so it follows the wrap switch: with it off a long
    // quoted line stays one line (and one row of the block), with it on the cell wraps.
    const long = 'const value = compute(alpha, beta, gamma, delta, epsilon, zeta)'
    const file = entry({ path: '/repo/w.ts', oldText: `${long}\n`, newText: 'const other = 1\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('w.ts'))

    // Comment on the removed row, so the quote is that whole long line.
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[0]!.querySelector('[data-diff-code]')?.firstChild ?? rows[0]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    view.rerender(<PendingPanel {...panelProps({ read: true, files: [entry({ path: '/repo/w.ts', oldText: 'let x = 1\n', newText: 'let y = 2\n' })], busy: new Set() })} />)
    const quote = document.querySelector('[data-diff-discussion-quote]') as HTMLElement
    expect(quote.textContent).toContain(long)
    // The removed line's number is the old side's, the second gutter stays empty.
    expect([...quote.querySelectorAll('[data-diff-quote-gutter]')].map(cell => cell.textContent)).toEqual(['1', ''])
    const cell = quote.querySelector('[data-diff-quote-text]') as HTMLElement
    // Wrap is off by default: one line, one row, however long.
    expect(getComputedStyle(cell).whiteSpace).toBe('pre')

    fireEvent.click(document.querySelector('[data-diff-wrap]') as HTMLElement)
    expect(getComputedStyle(cell).whiteSpace).toBe('pre-wrap')
    // And the block's reserved height follows the same switch (jsdom measures no glyphs, so
    // the wrapped count is one either way — what this pins is that the row still counts).
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(block.style.height).toBe('110px')
  })

  it('matches a comment answer to the prompt that asked, not to the session tail', async () => {
    // A session is often busy with the user's own turn when a comment is sent. The
    // comment is queued behind it, and the text streaming there belongs to that
    // other turn: putting it in the block would attribute someone else's words to
    // the annotation. The marker the prompt starts with is what keeps them apart.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
    const otherUser = { kind: 'user', text: 'unrelated question' }
    const otherAnswer = { kind: 'assistant', text: 'other answer' }
    act(() => { listener!({ running: true, nodes: [otherUser], partial: 'other partial', error: undefined }) })

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const node = code.firstChild ?? code
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1]

    // Nothing in the transcript is ours yet, so the block says it is waiting
    // instead of borrowing the running turn's partial text.
    act(() => { listener!({ running: true, nodes: [otherUser], partial: 'other partial', error: undefined }) })
    expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.queued')
    // The ellipsis after it is three dots of its own, so they can fill in one at a time.
    expect(document.querySelectorAll('[data-diff-discussion-dots] span').length).toBe(3)
    expect(document.querySelector('[data-diff-discussion-reply]')).toBeNull()

    // With the prompt in the transcript, the answer that follows it is ours — and it is still
    // being written: the note it replaced is gone, and the line under the streamed text says so
    // instead, so the block never looks finished while words are still coming.
    act(() => {
      listener!({ running: true, nodes: [otherUser, otherAnswer, { kind: 'user', text: prompt }], partial: 'our answer', error: undefined })
    })
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('our answer')
    expect(document.querySelector('[data-diff-discussion-asking]')).toBeNull()
    expect(document.querySelector('[data-diff-discussion-answering]')?.textContent).toContain('discussion.answering')

    act(() => {
      listener!({
        running: false,
        nodes: [otherUser, otherAnswer, { kind: 'user', text: prompt }, { kind: 'assistant', text: 'final answer' }],
        partial: '',
        error: undefined,
      })
    })
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('final answer')
    expect(document.querySelector('[data-diff-discussion-answering]')).toBeNull()
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
  })

  it('draws a turn\'s inline code and bold, and never the markers', () => {
    // The thread is prose laid out on the code rows, so it knows exactly two pieces of inline
    // Markdown: \`code\` and **bold**. Both are drawn with their markers gone, and the row
    // measurement reads that same text — reserving room for a marker would leave a hole.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const node = code.firstChild ?? code
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, {
      target: { value: 'is \`x\` **right**?' },
    })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1]
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
    act(() => {
      listener!({
        running: false,
        nodes: [{ kind: 'user', text: prompt }, { kind: 'assistant', text: 'use \`x\` **always**' }],
        partial: '',
        error: undefined,
      })
    })

    // The question in the thread: a code chip and a bold run, and the text without markers.
    const turn = document.querySelector('[data-diff-discussion-user]') as HTMLElement
    expect(turn.querySelector('code')?.textContent).toBe('x')
    expect(turn.querySelector('strong')?.textContent).toBe('right')
    expect(turn.textContent).toBe('is x right?')
    // The answer is drawn the same way, which is what makes a reply readable as markup as well.
    const answer = document.querySelector('[data-diff-discussion-reply]') as HTMLElement
    expect(answer.querySelector('code')?.textContent).toBe('x')
    expect(answer.querySelector('strong')?.textContent).toBe('always')
    expect(answer.textContent).toBe('use x always')

    // Both pieces have to be *visible*, which is a stylesheet question jsdom cannot answer: the
    // chip is the chat's own inline code (box, face, fill and hairline all declared the way the
    // shell's markdown declares them), and bold is the browser's own. The fill must not be a
    // surface step: in the light theme `bg-layer-2` resolves to the same step as `bg-base`, which
    // is why it read as nothing.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const chip = /\.discussionCode \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(chip).toContain('--dsw-alias-markdown-inline-code')
    expect(chip).not.toContain('--dsw-alias-bg-layer-2')
    // The chat's own inline code, declaration for declaration: an inline-flex box, the code face at
    // 0.875 of the prose size, its 6px radius, its 0 5px padding and its 0.5px hairline.
    expect(chip).toContain('display: inline-flex')
    expect(chip).toContain('align-items: center')
    expect(chip).toContain('box-sizing: border-box')
    expect(chip).toContain('font: var(--dsw-font-markdown-code)')
    expect(chip).toContain('font-family: var(--ds-font-family-code)')
    expect(chip).toContain('font-size: 0.875em')
    expect(chip).toContain('border-radius: 6px')
    expect(chip).toContain('border: 0.5px solid var(--dsw-alias-border-l1)')
    expect(chip).not.toContain('box-shadow: inset')
    // Side padding only (the panel mirrors it as `DISCUSSION_CODE_PADDING_PX`, and the hairline as
    // `DISCUSSION_CODE_BORDER_PX`): a taller line box would leave the thread's own row.
    expect(chip).toContain('padding: 0 5px')
    expect(chip).not.toMatch(/padding: [^;]*px [^;]*px [^;]*px/)
    // The probe the panel measures the thread's prose font from is really rendered.
    expect(document.querySelector('[data-diff-thread-font]')).not.toBeNull()
    const bold = /\.discussionBody strong \{([^}]*)\}/.exec(css)?.[1] ?? ''
    // The browser's own bold and nothing drawn on top of it: the stroke that used to help it tell
    // read as a smudge at the thread's size.
    expect(bold).toContain('font-weight: 700')
    expect(bold).not.toContain('text-stroke')
  })

  it('draws the block\'s two edges, over the code\'s pinned line numbers', () => {
    // A thread is a band lying on the code: the row it begins at and the row it ends at are what
    // say so, so both are drawn — a hairline above and one below, in the rule's own grey. They are
    // inset lines rather than borders (adjacent borders mitre, and the 3px rule against a 1px line
    // is a slant at both corners), and the pin that holds the block carries a stacking level of its
    // own: the pinned line-number columns paint above a row's background, and would cut the top and
    // bottom edges of the block out of their columns if the block did not outrank them.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const block = /\.discussion \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(block).toContain('inset 0 1px 0 0')
    expect(block).toContain('inset 0 -1px 0 0')
    // The right edge closes the band at the panel's edge; the left one is the rule itself.
    expect(block).toContain('inset -1px 0 0 0')
    expect(block).not.toContain('border-top')
    expect(block).not.toContain('border-bottom')
    // Grey, and a tint of the surface rather than a palette step, so it reads on either theme.
    expect(block).toContain('--dsw-alias-label-secondary')
    const gutter = /\.line > \.gutter \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const pin = /\.discussionPin \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const zOf = (rule: string): number => Number(/z-index: (-?\d+)/.exec(rule)?.[1] ?? '0')
    expect(zOf(gutter)).toBe(1)
    expect(zOf(pin)).toBeGreaterThan(zOf(gutter))
  })

  it('keeps a thread on its own row whatever the code\'s line height is set to', () => {
    // The comment box is prose, not code: it keeps the size the default settings show, so a
    // thread reads the same in a 10px code row as in a 36px one. The block still reserves whole
    // rows — of its own — and the diff's height table takes that exact pixel height.
    localStorage.setItem('diff-approval:diff-line-height', '30')
    localStorage.setItem('diff-approval:diff-font-scale', '150')
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    // The code's own grid did move: the variables the code rows read are the new ones.
    const diff = document.querySelector('[data-diff-approval-diff]') as HTMLElement
    expect(diff.style.getPropertyValue('--dsh-diff-line-height')).toBe('30px')
    expect(diff.style.getPropertyValue('--dsh-diff-font-scale')).toBe('1.5')

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const node = code.firstChild ?? code
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    // A fresh thread is its header plus the two-row writing row: three rows of the thread's own
    // 22px, which is what the code row's 30px would have made 90px.
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    const space = block.closest('[data-diff-discussion-space]') as HTMLElement
    expect(space.style.height).toBe('66px')
    expect(block.style.height).toBe('66px')
  })

  it('keeps as many rounds of a thread as the settings ask for', () => {
    // The round count is a preference: with one round, a thread that has been through two keeps
    // only the newest, and says how many turns it left out. (Two rounds — the default — is what
    // the other thread tests exercise.)
    localStorage.setItem('diff-approval:discussion-rounds', '1')
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code = rows[5]!.querySelector('[data-diff-code]') ?? rows[5]!
    const node = code.firstChild ?? code
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    // Round one, and round two, each question followed by its answer.
    const ask = (question: string): string => {
      const input = document.querySelector('[data-diff-discussion-input]') as HTMLInputElement
      fireEvent.change(input, { target: { value: question } })
      fireEvent.keyDown(input, { key: 'Enter' })
      return (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)?.[1] ?? ''
    }
    const first = ask('why?')
    act(() => {
      listener!({ running: false, nodes: [{ kind: 'user', text: first }, { kind: 'assistant', text: 'one' }], partial: '', error: undefined })
    })
    const second = ask('and then?')
    act(() => {
      listener!({
        running: false,
        nodes: [
          { kind: 'user', text: first }, { kind: 'assistant', text: 'one' },
          { kind: 'user', text: second }, { kind: 'assistant', text: 'two' },
        ],
        partial: '',
        error: undefined,
      })
    })

    // One round kept: the second question and its answer, and the two older turns are counted out.
    expect(document.querySelectorAll('[data-diff-discussion-user]').length).toBe(1)
    expect(document.querySelectorAll('[data-diff-discussion-user]')[0]?.textContent).toBe('and then?')
    expect(document.querySelectorAll('[data-diff-discussion-reply]').length).toBe(1)
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('two')
    expect(document.querySelector('[data-diff-discussion-hidden]')?.textContent).toBe('discussion.hidden {"count":2}')
  })

  it('carries its threads, and a waiting question, across a remount', () => {
    // The panel unmounts whenever it is closed or its presentation changes, and the page's
    // memory is what brings the threads back. A question still waiting for its answer has to
    // come with them, or the answer that arrives afterwards has nowhere to land.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    const first = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = {
      kind: 'user',
      text: (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)?.[1] ?? '',
    }
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()

    // Closed and reopened: a fresh mount, holding what the page remembered.
    first.unmount()
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    expect(document.querySelector('[data-diff-discussion-user]')?.textContent).toBe('why?')
    // Still waiting, so still no writing row.
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-input]')).toBeNull()

    // The answer arrives after the remount and still finds its block.
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } })
      .mock.calls.at(-1)?.[1]
    act(() => {
      listener!({ running: false, nodes: [prompt, { kind: 'assistant', text: 'because' }], partial: '', error: undefined, queued: [] })
    })
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('because')
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
  })

  it('waits only while the session still holds the queued question', () => {
    // "Queued" has to mean something: the session's own queue (or its local submission
    // echo) must still name our prompt. Once neither holds it and it never became a
    // turn — a stopped turn that dropped the queue, say — the block hands the writing
    // row back, after a grace so a round-trip gap cannot take it back early.
    vi.useFakeTimers()
    try {
      const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
      const props = panelProps({ read: true, files: [multi], busy: new Set() })
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('m.txt'))
      const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
      act(() => { listener!({ running: true, nodes: [], partial: '', error: undefined, queued: [] }) })

      const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
      const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
      fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
      fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
      fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
      const prompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? ''

      act(() => { listener!({ running: true, nodes: [], partial: '', error: undefined, queued: [prompt] }) })
      expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.queued')

      // The session has taken it (the queue no longer names it) and is writing: the block
      // must stop saying it is queued. This is the phase where nothing has streamed yet and
      // the answer is being thought about.
      act(() => { listener!({ running: true, nodes: [], partial: '', error: undefined, queued: [] }) })
      expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.thinking')

      // Same once the prompt is in the transcript with the turn still running, and still
      // nothing written.
      act(() => {
        listener!({ running: true, nodes: [{ kind: 'user', text: prompt }], partial: '', error: undefined, queued: [] })
      })
      expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.thinking')

      // The session has let it go and no turn took it. The row comes back only once
      // the grace has passed - a submission echo and the host's queue row are a round
      // trip apart, so the first idle notification is not proof.
      act(() => { listener!({ running: false, nodes: [], partial: '', error: undefined, queued: [] }) })
      expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.queued')
      act(() => { vi.advanceTimersByTime(5000) })
      expect(document.querySelector('[data-diff-discussion-asking]')).toBeNull()
      expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
      expect(document.querySelector('[data-diff-discussion-user]')?.textContent).toBe('why?')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never lets an older comment\'s answer into a new question on the same rows', () => {
    // Follow-ups ARE comments on the same rows, so their marker line is identical —
    // and the words can be too ("再试一次"). Matching by the tail of the transcript
    // therefore handed the block the PREVIOUS answer, which the real one then replaced
    // when it arrived. The search now starts at our own baseline, so nothing that was
    // already in the transcript when we sent can be taken for the prompt we wait on.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const type = (value: string): void => {
      fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value } })
      fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    }
    const calls = (): [string, string][] => (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls
    const lastReply = (): string | undefined =>
      [...document.querySelectorAll('[data-diff-discussion-reply]')].at(-1)?.textContent ?? undefined

    // First turn settles: its prompt and answer are the transcript's tail from now on.
    type('why?')
    const firstPrompt = calls()[0]?.[1] ?? ''
    act(() => {
      listener!({
        running: false,
        nodes: [{ kind: 'user', text: firstPrompt }, { kind: 'assistant', text: 'previous answer' }],
        partial: '',
        error: undefined,
      })
    })
    expect(lastReply()).toBe('previous answer')

    // Second turn asks the SAME words on the SAME rows while the session is busy. Its
    // prompt is queued, so the transcript still ends with the previous turn: the block
    // must wait, and the streaming text of the running turn must not touch it.
    type('why?')
    act(() => {
      listener!({
        running: true,
        nodes: [{ kind: 'user', text: firstPrompt }, { kind: 'assistant', text: 'previous answer' }],
        partial: 'previous answer streaming',
        error: undefined,
        queued: [calls()[1]?.[1] ?? ''],
      })
    })
    expect(document.querySelector('[data-diff-discussion-asking]')?.textContent).toContain('discussion.queued')
    expect(lastReply()).toBe('previous answer')

    // Our own prompt is in the transcript: from here the answer is ours.
    const secondPrompt = { kind: 'user', text: calls()[1]?.[1] ?? '' }
    act(() => {
      listener!({
        running: true,
        nodes: [{ kind: 'user', text: firstPrompt }, { kind: 'assistant', text: 'previous answer' }, secondPrompt],
        partial: 'our answer',
        error: undefined,
        queued: [],
      })
    })
    expect(lastReply()).toBe('our answer')

    act(() => {
      listener!({
        running: false,
        nodes: [
          { kind: 'user', text: firstPrompt },
          { kind: 'assistant', text: 'previous answer' },
          secondPrompt,
          { kind: 'assistant', text: 'our answer' },
        ],
        partial: '',
        error: undefined,
        queued: [],
      })
    })
    expect(document.querySelectorAll('[data-diff-discussion-user]').length).toBe(2)
    expect(lastReply()).toBe('our answer')
  })

  it('closes a stopped comment instead of taking the next turn\'s answer', () => {
    // Pressing Stop while a comment is being answered used to leave the block waiting: the
    // turn was frozen with nothing written, the pending ask stayed armed, and the NEXT
    // turn's answer then settled into the comment. Two things fix it — a turn's own
    // segment (nothing after the next human message belongs to this question) and the
    // frozen node that ends the wait.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = { kind: 'user', text: (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? '' }
    const lastReply = (): string | undefined =>
      [...document.querySelectorAll('[data-diff-discussion-reply]')].at(-1)?.textContent ?? undefined

    // The turn runs, then the user stops it: the runtime freezes it with nothing written.
    act(() => { listener!({ running: true, nodes: [prompt], partial: '', error: undefined, queued: [] }) })
    expect(document.querySelector('[data-diff-discussion-asking]')).not.toBeNull()
    const frozen = { kind: 'assistant', text: '', interrupted: true }
    act(() => { listener!({ running: false, nodes: [prompt, frozen], partial: '', error: undefined, queued: [] }) })
    expect(document.querySelector('[data-diff-discussion-stopped]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-asking]')).toBeNull()
    // The writing row is back, and the question is still there to ask again.
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-user]')?.textContent).toBe('why?')

    // A later turn - the user's own next message - must not land in this block.
    const nextUser = { kind: 'user', text: 'another question' }
    act(() => {
      listener!({ running: true, nodes: [prompt, frozen, nextUser], partial: 'the new answer', error: undefined, queued: [] })
    })
    expect(lastReply()).toBeUndefined()
    act(() => {
      listener!({
        running: false,
        nodes: [prompt, frozen, nextUser, { kind: 'assistant', text: 'the new answer' }],
        partial: '',
        error: undefined,
        queued: [],
      })
    })
    expect(lastReply()).toBeUndefined()
    expect(document.querySelector('[data-diff-discussion-stopped]')).not.toBeNull()
  })

  it('keeps the partial an interrupted turn had written, and says it was stopped', () => {
    // Stop after some text arrived: that text is what the user was reading, so it stays as
    // the answer — but it is marked stopped, and the writing row comes back.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = { kind: 'user', text: (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? '' }

    act(() => {
      listener!({
        running: false,
        nodes: [prompt, { kind: 'assistant', text: 'half an answer', interrupted: true }],
        partial: '',
        error: undefined,
        queued: [],
      })
    })
    expect([...document.querySelectorAll('[data-diff-discussion-reply]')].at(-1)?.textContent).toBe('half an answer')
    expect(document.querySelector('[data-diff-discussion-stopped]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-input]')).not.toBeNull()
  })

  it('hands the caret back when the compose row returns, unless the user moved on', async () => {
    // Sending hides the compose row while the turn runs, so the caret has nowhere
    // to be. It belongs in the input the moment that row is back — a conversation
    // is typed turn after turn — but not if the user has clicked or typed
    // elsewhere in the meantime: then the caret is where they put it.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)

    const type = (value: string): void => {
      fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value } })
      fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    }
    type('why?')
    expect(document.querySelector('[data-diff-discussion-input]')).toBeNull()
    const prompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? ''
    act(() => {
      listener!({ running: false, nodes: [{ kind: 'user', text: prompt }, { kind: 'assistant', text: 'first answer' }], partial: '', error: undefined })
    })
    expect(document.activeElement).toBe(document.querySelector('[data-diff-discussion-input]'))

    // Second turn: this time the user clicks away while the answer runs. Its prompt
    // carries the second question, which is what tells the two turns apart.
    type('and then?')
    const secondPrompt = (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[1]?.[1] ?? ''
    act(() => { document.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    act(() => {
      listener!({
        running: false,
        nodes: [
          { kind: 'user', text: prompt },
          { kind: 'assistant', text: 'first answer' },
          { kind: 'user', text: secondPrompt },
          { kind: 'assistant', text: 'second answer' },
        ],
        partial: '',
        error: undefined,
      })
    })
    const input = document.querySelector('[data-diff-discussion-input]')
    expect(input).not.toBeNull()
    expect(document.activeElement).not.toBe(input)
  })

  it('scrolls with the code from a wheel over a discussion block', () => {
    // A block is painted INSIDE the scroller, in content coordinates, so the wheel
    // over it is the browser's own business — that is what makes it scroll with the
    // code instead of trailing it by a frame. The chrome that still floats in the
    // non-scrolling wrapper (the action frames, the search bar) has no scroller
    // under it at all, so its wheel is forwarded by hand.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const body = document.querySelector('[data-diff-body]') as HTMLElement
    let scrolled = 0
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      // Clamped, the way a real box behaves at either end of its range.
      set: (value: number) => { scrolled = Math.max(0, Math.min(2000, value)) },
    })

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    // Inside the scroller: the browser scrolls it with the code, no JS placement.
    expect(block.closest('[data-diff-body]')).toBe(body)
    // ...and inside a row of the code's own stream, under the zero-width pin, which
    // is what keeps a wheel over the block scrolling the box natively.
    expect(block.closest('[data-diff-discussion-space]')).not.toBeNull()

    const wheel = (target: Element, init: WheelEventInit): WheelEvent => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(event)
      return event
    }

    // The bar floats over the code in the wrapper, so its wheel is ours.
    fireEvent.click(screen.getByLabelText('action.search'))
    const searchBar = document.querySelector('[data-diff-searchbar]') as HTMLElement
    expect(wheel(searchBar, { deltaY: 100 }).defaultPrevented).toBe(true)
    expect(scrolled).toBe(100)

    // Line-mode deltas (Firefox) arrive in whole rows, not pixels.
    wheel(searchBar, { deltaY: 1, deltaMode: 1 })
    expect(scrolled).toBe(122)

    scrolled = 2000
    expect(wheel(searchBar, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(scrolled).toBe(2000)

    // A wheel over the code or over a block scrolls the box natively: forwarding it
    // here too would move twice as far as the user asked for.
    scrolled = 500
    expect(wheel(body, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(wheel(block, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(scrolled).toBe(500)
  })

  it('offers no comment at all until comment mode is switched on', () => {
    // Comment mode ships OFF (it is a preview, see `commentModeEnabled`): no comment button
    // and no chord behind it - and, for a range whose only action would have been the
    // comment, no frame at all. Keep/revert over change blocks is untouched.
    localStorage.removeItem('diff-approval:comment-mode-preview')
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 0 })

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const kindOf = (row: HTMLElement): string => row.querySelector('[data-diff-code]')?.getAttribute('data-diff-code-line') ?? ''
    const select = (from: HTMLElement, to: HTMLElement = from): void => {
      const node = (row: HTMLElement): Node => (row.querySelector('[data-diff-code]') ?? row).firstChild ?? row
      const startNode = node(from)
      const endNode = node(to)
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: startNode,
        focusNode: endNode,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: startNode, startOffset: 0, endContainer: endNode, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
    }

    select(rows.find(row => kindOf(row) === 'context')!)
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()
    expect(document.querySelector('[data-diff-selection-comment]')).toBeNull()
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(true)
    expect(document.querySelector('[data-diff-discussion]')).toBeNull()

    // A range over the whole of a change block still offers keep/revert: the mode withholds
    // the comment half of the frame, not the frame.
    const changed = rows.find(row => kindOf(row) === 'add' || kindOf(row) === 'del')!
    select(changed, rows[rows.indexOf(changed) + 1]!)
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    expect(document.querySelector('[data-diff-selection-comment]')).toBeNull()
    expect(document.querySelector('[data-diff-selection-divider]')).toBeNull()
    expect((document.querySelector('[data-diff-selection-keep]') as HTMLButtonElement).hidden).toBe(false)

    // Switching it on in Settings (a different mount) reaches the open panel at once.
    act(() => { setCommentModeEnabled(true) })
    expect(document.querySelector('[data-diff-selection-comment]')).not.toBeNull()
    expect(document.querySelector('[data-diff-selection-divider]')).not.toBeNull()
  })

  it('comments on the selection from the keyboard, for as long as the button is up', () => {
    // The chord is bound to the affordance: it works exactly while the comment button is
    // on screen, so it can never start a comment the user had no way to click - and it
    // takes Ctrl+K from the browser only then.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 0 })

    // No selection, so no button: the key belongs to the browser.
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(document.querySelector('[data-diff-discussion]')).toBeNull()

    const selectRows = (from: HTMLElement, to: HTMLElement = from): void => {
      const node = (row: HTMLElement): Node => (row.querySelector('[data-diff-code]') ?? row).firstChild ?? row
      const startNode = node(from)
      const endNode = node(to)
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: startNode,
        focusNode: endNode,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: startNode, startOffset: 0, endContainer: endNode, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
    }
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const kindOf = (row: HTMLElement): string => row.querySelector('[data-diff-code]')?.getAttribute('data-diff-code-line') ?? ''
    const changed = rows.find(row => kindOf(row) === 'add' || kindOf(row) === 'del')
    const free = rows.find(row => row !== changed && kindOf(row) === 'context')
    expect(changed).toBeDefined()
    expect(free).toBeDefined()
    selectRows(changed!)
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()

    // The chord does what the button does: the block appears, the caret lands in its
    // input, and the frame leaves with the selection it acted on.
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    const input = document.querySelector('[data-diff-discussion-input]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()

    // With the frame back up, a chord typed into a text field stays the field's: not
    // prevented, and no second comment.
    selectRows(free!)
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    expect(fireEvent.keyDown(input, { key: 'k', ctrlKey: true })).toBe(true)
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(1)

    // The chord follows a rebind, like every other action's: the handler reads the
    // binding when the key arrives, so no re-registration is needed for it to take.
    localStorage.setItem('diff-approval:key:addComment', 'Ctrl+J')
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(1)
    fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true })
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(2)

    // A selection over the whole of the discussed change block (a removed line and the
    // added one it replaces) still offers keep/revert, so the frame is up - but with no
    // comment to offer. The chord is the browser's there: the event is left alone, which
    // fireEvent reports as true only when nothing called preventDefault.
    selectRows(changed!, rows[rows.indexOf(changed!) + 1]!)
    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    expect(fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true })).toBe(true)
    expect(document.querySelectorAll('[data-diff-discussion]').length).toBe(2)
  })

  it('prints the comment chord on the button, live from the binding', () => {
    // The frame cannot carry a tooltip: it is moved by a scroll-driven transform, and a
    // transformed element is the containing block for the kit's fixed-position bubble. The
    // chord rides on the label instead - read where the button renders, so a rebind shows on
    // the next selection, and left out entirely when the action has been unbound.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    render(<PendingPanel {...panelProps({ read: true, files: [multi], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 0 })

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const select = (row: HTMLElement): void => {
      const node = (row.querySelector('[data-diff-code]') ?? row).firstChild ?? row
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
    }
    const chord = (): HTMLElement | null => document.querySelector('[data-diff-selection-comment-chord]')

    select(rows[0]!)
    expect(chord()?.textContent).toBe('Ctrl+K')

    // A rebind is picked up where the button renders.
    localStorage.setItem('diff-approval:key:addComment', 'Ctrl+J')
    select(rows[1]!)
    expect(chord()?.textContent).toBe('Ctrl+J')

    // Unbound: the hint is dropped, not left blank.
    localStorage.setItem('diff-approval:key:addComment', '')
    select(rows[2]!)
    expect(document.querySelector('[data-diff-selection-comment]')).not.toBeNull()
    expect(chord()).toBeNull()

    // It reads as a hint about the button rather than as part of its name.
    const css = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.module.css'), 'utf8')
    const hint = /\.actionChord \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(hint).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(hint).toContain('font-size: 11px')
  })

  it('hangs a block in a row of its own, with neither axis placed by script', () => {
    // A block used to be painted in the scroller's CONTENT coordinates: the vertical
    // half was then the browser's, but the sideways half had to be re-written from the
    // scroll event, which is what made it trail the code by a frame. It is now a ROW in
    // the code's stream, under a zero-width sticky pin, so both axes are the browser's
    // and the scroll path writes nothing at all.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))

    const body = document.querySelector('[data-diff-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 0 })
    Object.defineProperty(body, 'scrollLeft', { configurable: true, value: 0 })

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    // The annotated rows carry the wash THEMSELVES, so there is no overlay for the panel
    // to place: it scrolls with the code in both axes with no script at all.
    const banded = [...document.querySelectorAll('[data-diff-discussion-band]')]
    expect(banded).toEqual([rows[5]])
    expect(rows[5]!.closest('[data-diff-body]')).toBe(body)

    // The block's own row sits immediately after the row it annotates, and carries the
    // whole reservation (a header plus the compose area: three code rows).
    const space = block.closest('[data-diff-discussion-space]') as HTMLElement
    expect(space).not.toBeNull()
    expect(space.previousElementSibling).toBe(rows[5])
    expect(space.style.height).toBe(`${3 * 22}px`)
    expect(space.closest('[data-diff-body]')).toBe(body)

    // Nothing about the block's position is written from JS: no content-coordinate
    // `top`, no counter-translation, only the width (the pin has none to inherit).
    expect(block.style.top).toBe('')
    expect(block.style.transform).toBe('')
    expect(block.style.width).not.toBe('')

    // Scrolling does not touch the block's own styles at all, in either direction.
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 220 })
    fireEvent.scroll(body)
    expect(block.style.top).toBe('')
    expect(block.style.transform).toBe('')

    Object.defineProperty(body, 'scrollLeft', { configurable: true, value: 120 })
    fireEvent.scroll(body)
    expect(block.style.transform).toBe('')
    expect(block.style.top).toBe('')
    // The wash needs no transform either: it moved with its row.
    expect(rows[5]!.style.transform).toBe('')
  })

  it('keeps a thread on the code row grid', () => {
    // A block is a whole number of code rows: one header, one row per line the
    // thread shows, two for the compose area. The turns used to carry vertical
    // chrome of their own (a bubble's padding, a paragraph's bottom margin), which
    // left a gap between the question and its answer and put every line below the
    // first a few pixels off the code's 22px grid.
    const multi = entry({ id: 'entry-multi', path: '/repo/m.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [multi], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('m.txt'))
    const listener = (props.watchChat as unknown as { mock: { calls: [string, (view: unknown) => void][] } }).mock.calls[0]?.[1]

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const node = rows[5]!.querySelector('[data-diff-code]')?.firstChild ?? rows[5]!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const block = (): HTMLElement => document.querySelector('[data-diff-discussion]') as HTMLElement
    const space = (): HTMLElement => document.querySelector('[data-diff-discussion-space]') as HTMLElement
    // An empty block: the header plus the two compose rows.
    expect(block().style.height).toBe('66px')

    fireEvent.change(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { target: { value: 'why?' } })
    fireEvent.keyDown(document.querySelector('[data-diff-discussion-input]') as HTMLInputElement, { key: 'Enter' })
    const prompt = { kind: 'user', text: (props.onAskAgent as unknown as { mock: { calls: [string, string][] } }).mock.calls[0]?.[1] ?? '' }
    act(() => {
      // jsdom measures no glyphs, so a message's rows are its line count — plus the
      // bubble's own half-row padding twice, which is what the user's turn adds. The
      // blank line is the other point: it is the agent's paragraph gap, and it must
      // cost neither a row nor a line in the render, since a blank line in a thread
      // reads as a gap in the code it annotates. The prompt is in the transcript, which
      // is what makes the answer ours.
      listener!({ running: false, nodes: [prompt, { kind: 'assistant', text: 'first answer\n\nsecond line' }], partial: '', error: undefined })
    })
    // 1 header + (1 line of question + its 1 row of bubble padding) + 2 rows of
    // answer + 2 compose rows, and the reservation the rows after it are pushed by
    // says the same.
    expect(block().style.height).toBe('154px')
    expect(space().style.height).toBe('154px')
    expect(document.querySelector('[data-diff-discussion-reply]')?.textContent).toBe('first answer\nsecond line')
  })

  /**
   * The acceptance test for the runaway the live panel hit.
   *
   * The block's height is corrected to what it draws, and the measurement used to take the slack with it:
   * `.discussionSlack` is the placeholder that fills whatever height the block was reserved and did not
   * spend, so counting it measured the reservation that had just been written — the correction feeding on
   * its own output. At a whole-row height that becomes a loop, because the browser snaps the paint to the
   * pixel grid: the same block comes back 88.0004 one pass and 87.9996 the next, `ceil` reads those as
   * five rows and four, and every flip is a state write from a layout effect. React counts nested updates
   * and gives up at fifty — minified #185, "panel crashed".
   *
   * This stages that layout — three rows of content, the slack filling the leftover, the paint snapping —
   * and requires both halves of the reader-visible failure to be gone: no endless updating, and a
   * reservation that settles on the rows the content needs rather than on a figure the loop left behind.
   * Without the correction's two measures (the slack taken out of the figure, and the one-pixel band
   * before the row rounding) this test is red, with React's "Maximum update depth exceeded".
   */
  it('does not let a self-referential measurement run away', async () => {
    const CONTENT_PX = 66
    const ROW_PX = 22
    const file = entry({ id: 'entry-runaway', path: '/repo/runaway.txt', oldText: 'a\n', newText: 'b\n' })
    rememberDiscussions(S1, {
      [file.id]: [{
        id: 'd-runaway',
        anchor: { start: 1, end: 1, startLine: 2, endLine: 2 },
        collapsed: false,
        draft: '',
        messages: [{ role: 'user', text: 'why?' }],
      }],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('runaway.txt'))

    const card = document.querySelector('[data-diff-discussion]') as HTMLElement
    const body = card.children[1] as HTMLElement
    const last = body.lastElementChild as HTMLElement
    const slack = body.querySelector('[data-diff-discussion-slack]') as HTMLElement
    const space = card.closest('[data-diff-discussion-space]') as HTMLElement
    expect(slack).not.toBeNull()
    const rect = (top: number, bottom: number): DOMRect =>
      ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    // The leftover the reservation has, which the slack fills up to its one row.
    const slackHeight = (): number =>
      Math.max(0, Math.min((Number.parseFloat(space.style.height) || 0) - CONTENT_PX, ROW_PX))
    // The paint is snapped to the pixel grid, so a whole-row figure comes back a hair above or below it.
    let pass = 0
    const jitter = (): number => (pass++ % 2 === 0 ? 0.0004 : -0.0004)
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => rect(0, 0))
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 0))
    vi.spyOn(slack, 'getBoundingClientRect').mockImplementation(() => rect(0, slackHeight()))
    vi.spyOn(last, 'getBoundingClientRect').mockImplementation(() => rect(0, CONTENT_PX + slackHeight() + jitter()))
    const errors: string[] = []
    const quiet = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    try {
      // Let the correction run: a frame for the width to settle, then whatever passes it takes.
      await new Promise((resolve) => { window.setTimeout(resolve, 500) })
      // 1. It did not update itself to death.
      expect(errors.filter(message => message.includes('Maximum update depth'))).toEqual([])
      // 2. It settled on what the content needs — three rows of thread plus the header row — instead of a
      //    figure the loop left behind.
      expect(space.style.height).toBe('88px')
      // 3. And the panel is still the panel.
      expect(document.querySelector('[data-diff-discussion]')).not.toBeNull()
    } finally {
      quiet.mockRestore()
    }
  })

  it('shows the selection frame for a single covered block too', async () => {
    // 'a\n' -> 'b\n' has one block (both rows).
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(2)
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 0,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    // Both groups are there (keep/revert over the covered block, comment on the
    // range), so the hairline between them is too.
    expect(document.querySelector('[data-diff-selection-divider]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-selection-keep]') as HTMLButtonElement)
    // A single covered block is the file's last change: the action prompts for
    // remove-or-keep instead of firing the block RPC directly.
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()
    expect(props.onBlockKeep).not.toHaveBeenCalled()

    // The operated block leaves the diff, so the selection is cleared too.
    await waitFor(() => {
      expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()
    })
  })

  it('clears the selection after reverting a covered block too', async () => {
    // Revert goes through the same handleSelectionAction as keep, but confirm it
    // also clears the stale row-range selection once the block leaves the diff.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(2)
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 0,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-selection-revert]') as HTMLButtonElement)
    // Single block: the revert prompts for remove-or-keep rather than firing.
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()
    expect(props.onBlockRevert).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()
    })
  })

  it('prompts for remove-or-keep when a bulk selection resolves the file\'s last block', async () => {
    // Two change blocks ('a'->'A' and 'c'->'C'); selecting the whole file covers
    // both, so the bulk keep resolves the file's last block and must prompt.
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\n', newText: 'A\nb\nC\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // The two rows the selection runs between: the first change block's code cell and the last
    // one's. A row with no code cell of its own falls back to the row, so both ends always have a
    // node to hang the range on.
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const codeLast = rows[rows.length - 1]!.querySelector('[data-diff-code]') ?? rows[rows.length - 1]!
    // jsdom never makes a selection out of a drag, so one is spelled out here: a range from the
    // first block's text to the last block's, which is what "the whole file is selected" looks like
    // to the panel — it reads the rows the two boundary nodes sit in (`selectionFrame`). Only the
    // parts the panel asks about are here, hence the cast. The offsets matter: the panel drops a
    // partial line when a boundary sits at that line's end or before its start, so these are the
    // ends of the two lines, one character in.
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: codeLast.firstChild ?? codeLast,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 0,
        endContainer: codeLast.firstChild ?? codeLast,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    expect(document.querySelector('[data-diff-selection-actions]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-selection-keep]') as HTMLButtonElement)
    // Covers the file's last change too: must prompt, not fire the block RPC.
    expect(document.querySelector('[data-diff-confirm]')).not.toBeNull()
    expect(props.onBlockKeep).not.toHaveBeenCalled()
  })

  it('does not offer a reference for a selection of only removed lines', () => {
    // 'a\nb\n' -> 'b\n' removes line 1; the removed row has no current-file
    // number, so selecting it alone must not produce a copyable reference.
    const removed = entry({ id: 'entry-removed', oldText: 'a\nb\n', newText: 'b\n' })
    const props = panelProps({ read: true, files: [removed], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code0.firstChild ?? code0,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 0,
        endContainer: code0.firstChild ?? code0,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    expect(document.querySelector('[data-diff-copy]')).toBeNull()
  })

  it('renders the copy-reference control as a non-button span to dodge the mobile file-guard', () => {
    // dsh-pocket's mobile bridge hijacks any <button>/<a> whose text looks like
    // a file path (its fileGuard looksLikeFilePath matches a `path/file.ext`
    // substring anywhere in the text). A copy reference is `(path:line)` and
    // would false-positive, so the plugin renders this control as a role=button
    // span and opts it out via the data-mobile-nav-copy marker. Assert both so
    // a future refactor back to <button> does not silently reintroduce the bug.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 1,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    const copy = document.querySelector('[data-diff-copy]') as HTMLElement
    expect(copy).not.toBeNull()
    expect(copy.tagName.toLowerCase()).toBe('span')
    expect(copy.getAttribute('role')).toBe('button')
    expect(copy.getAttribute('tabindex')).toBe('0')
    expect(copy.getAttribute('data-mobile-nav-copy')).toBe('1')
    // Must not be a native button/a, or dsh-pocket's file guard scans it.
    expect(copy.matches('button, a')).toBe(false)
  })

  it('copies the reference with Ctrl+L', async () => {
    // Auto-paste off: the reference is copied to the clipboard (with a toast).
    localStorage.setItem('diff-approval:paste-on-copy', '0')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBeGreaterThan(1)
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 1,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    expect(screen.getByText('/repo/a.txt:1')).toBeDefined()

    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('(/repo/a.txt:1)') })
    // The status bar button and the toast both carry the copied label.
    await vi.waitFor(() => { expect(screen.getAllByText('action.copied').length).toBeGreaterThanOrEqual(1) })
  })

  it('copies the reference on Enter from the role=button span', async () => {
    // The copy-reference control is a non-native role=button span (to dodge
    // dsh-pocket's mobile file guard), so it must keep keyboard activation:
    // Enter (and Space) should copy, not just pointer click.
    localStorage.setItem('diff-approval:paste-on-copy', '0')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    selectFirstRows(view)

    const copy = document.querySelector('[data-diff-copy]') as HTMLElement
    expect(copy).not.toBeNull()
    fireEvent.keyDown(copy, { key: 'Enter' })
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('(/repo/a.txt:1)') })
  })

  /** Select the first two diff rows so a reference becomes copyable. */
  function selectFirstRows(view: ReturnType<typeof render>): void {
    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const code1 = rows[1]!.querySelector('[data-diff-code]') ?? rows[1]!
    const selection = {
      isCollapsed: false,
      anchorNode: code0.firstChild ?? code0,
      focusNode: code1.firstChild ?? code1,
      rangeCount: 1,
      getRangeAt: () => ({
        startContainer: code0.firstChild ?? code0,
        startOffset: 1,
        endContainer: code1.firstChild ?? code1,
        endOffset: 1,
      }),
    } as unknown as Selection
    vi.spyOn(window, 'getSelection').mockReturnValue(selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
  }

  it('pastes the copied reference into the composer when auto-paste is on', async () => {
    // Auto-paste on: the reference is pasted into the composer and NOT copied
    // to the clipboard (no toast).
    localStorage.setItem('diff-approval:paste-on-copy', '1')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    selectFirstRows(view)

    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    // The paste runs in the same async continuation, so wait for it rather than
    // reading the mock immediately.
    const pasteMock = props.onPasteReference as unknown as { mock: { calls: unknown[][] } }
    await vi.waitFor(() => { expect(pasteMock.mock.calls).toEqual([[S1, '(/repo/a.txt:1)']]) })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('skips auto-paste when the DSH Settings toggle is turned off', async () => {
    // Simulate the preference being off in DSH Settings → the plugin's tab.
    localStorage.setItem('diff-approval:paste-on-copy', '0')
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    selectFirstRows(view)
    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('(/repo/a.txt:1)') })
    const pasteMock = props.onPasteReference as unknown as { mock: { calls: unknown[][] } }
    expect(pasteMock.mock.calls).toHaveLength(0)
  })

  it('the DSH Settings tab toggles the auto-paste preference in localStorage', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    // The row lives in the comments group — it is about the message being written, not about how
    // the diff is drawn — and that group opens folded.
    fireEvent.click(document.querySelector('[data-diff-comment-toggle]') as HTMLButtonElement)
    // Re-query the switch each time: re-rendering can replace the node.
    const toggle = () => document.querySelector('[data-diff-paste-on-copy-select]') as HTMLButtonElement
    expect(toggle()).not.toBeNull()
    // On by default.
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:paste-on-copy')).toBe('0')
    expect(toggle().getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:paste-on-copy')).toBe('1')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('the DSH Settings tab toggles the import-untracked preference in localStorage', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    const toggle = () => document.querySelector('[data-diff-import-untracked-select]') as HTMLButtonElement
    expect(toggle()).not.toBeNull()
    // Off by default: the full untracked scan is opt-in.
    expect(toggle().getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:import-untracked')).toBe('1')
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:import-untracked')).toBe('0')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('the DSH Settings tab toggles the whole-file remove prompt in localStorage', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    const toggle = () => document.querySelector('[data-diff-confirm-file-remove-select]') as HTMLButtonElement
    expect(toggle()).not.toBeNull()
    // On by default: a whole-file action asks before dropping the file.
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:confirm-file-remove')).toBe('0')
    expect(toggle().getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle())
    expect(localStorage.getItem('diff-approval:confirm-file-remove')).toBe('1')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('the DSH Settings tab steps the block-jump lead rows and clamps to the bounds', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    // The row lives in the diff-view group, which opens folded.
    fireEvent.click(document.querySelector('[data-diff-view-toggle]') as HTMLButtonElement)
    const value = () => document.querySelector('[data-diff-nav-lead-rows]') as HTMLElement
    // The page now has several stepper rows (font size, line height, lead rows);
    // target the ± buttons of the lead-rows row specifically.
    const up = () => (value() as HTMLElement & { parentElement: HTMLElement }).parentElement.querySelector('[data-diff-stepper-up]') as HTMLButtonElement
    const down = () => (value() as HTMLElement & { parentElement: HTMLElement }).parentElement.querySelector('[data-diff-stepper-down]') as HTMLButtonElement
    expect(value().textContent).toBe('2')

    // Step up to 3 and persist.
    fireEvent.click(up())
    expect(value().textContent).toBe('3')
    expect(localStorage.getItem('diff-approval:nav-lead-rows')).toBe('3')

    // Step down back to 2.
    fireEvent.click(down())
    expect(value().textContent).toBe('2')
    expect(localStorage.getItem('diff-approval:nav-lead-rows')).toBe('2')

    // Clamp at 0 (the min): the down button disables.
    for (let i = 0; i < 5; i++) fireEvent.click(down())
    expect(value().textContent).toBe('0')
    expect(down().disabled).toBe(true)

    // Clamp at 10 (the max): the up button disables.
    fireEvent.click(up())
    for (let i = 0; i < 15; i++) fireEvent.click(up())
    expect(value().textContent).toBe('10')
    expect(up().disabled).toBe(true)
  })

  it('the DSH Settings tab sets how many rounds a comment keeps', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    // The row lives in the comments group, which opens folded.
    fireEvent.click(document.querySelector('[data-diff-comment-toggle]') as HTMLButtonElement)
    // The group holds the mode, the rounds and the auto-paste switch together.
    expect(document.querySelector('[data-diff-paste-on-copy-select]')).not.toBeNull()
    const value = () => document.querySelector('[data-diff-discussion-rounds]') as HTMLElement
    // Several stepper rows share the page; target this row's own ± buttons.
    const up = () => (value() as HTMLElement & { parentElement: HTMLElement }).parentElement.querySelector('[data-diff-stepper-up]') as HTMLButtonElement
    const down = () => (value() as HTMLElement & { parentElement: HTMLElement }).parentElement.querySelector('[data-diff-stepper-down]') as HTMLButtonElement
    // Two rounds is the default: one question and the answer to it, twice.
    expect(value().textContent).toBe('2')

    fireEvent.click(up())
    expect(value().textContent).toBe('3')
    expect(localStorage.getItem('diff-approval:discussion-rounds')).toBe('3')

    // The floor is one round: something has to be visible, so the down button disables there.
    for (let i = 0; i < 5; i++) fireEvent.click(down())
    expect(value().textContent).toBe('1')
    expect(down().disabled).toBe(true)
    expect(localStorage.getItem('diff-approval:discussion-rounds')).toBe('1')

    // The ceiling is ten: a thread may not swamp the diff it annotates.
    for (let i = 0; i < 15; i++) fireEvent.click(up())
    expect(value().textContent).toBe('10')
    expect(up().disabled).toBe(true)
    expect(localStorage.getItem('diff-approval:discussion-rounds')).toBe('10')
  })

  it('the DSH Settings tab exposes a collapsed keybindings group that persists chords', () => {
    // Reset any stored chords so the defaults apply.
    localStorage.removeItem('diff-approval:key:jumpDown')
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)

    // The group is collapsed by default: no per-action recorder rows yet.
    expect(document.querySelector('[data-diff-key-jumpdown]')).toBeNull()

    // Expand the group.
    fireEvent.click(document.querySelector('[data-diff-keybindings-toggle]') as HTMLButtonElement)
    const rec = document.querySelector('[data-diff-key-jumpdown]') as HTMLButtonElement
    expect(rec).not.toBeNull()
    expect(rec.textContent).toContain('Ctrl+ArrowDown')

    // Record a new chord for the jump-down action; it persists to localStorage.
    fireEvent.click(rec)
    fireEvent.keyDown(rec, { key: 'k', ctrlKey: true })
    expect(localStorage.getItem('diff-approval:key:jumpDown')).toBe('Ctrl+K')
    // The row re-renders with the new chord.
    expect((document.querySelector('[data-diff-key-jumpdown]') as HTMLButtonElement).textContent).toContain('Ctrl+K')

    // Collapse again.
    fireEvent.click(document.querySelector('[data-diff-keybindings-toggle]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-key-jumpdown]')).toBeNull()
  })

  it('the shortcut rows carry no chevron, and reset to their default', () => {
    localStorage.removeItem('diff-approval:key:jumpDown')
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    fireEvent.click(document.querySelector('[data-diff-keybindings-toggle]') as HTMLButtonElement)

    const recorder = (): HTMLButtonElement => document.querySelector('[data-diff-key-jumpdown]') as HTMLButtonElement
    const reset = (): HTMLButtonElement => document.querySelector('[data-reset="data-diff-key-jumpdown"]') as HTMLButtonElement
    // The control is the chord itself: there is no menu behind it, so no chevron.
    expect(recorder().querySelector('svg')).toBeNull()
    // Reset starts disabled: the row is already at its default.
    expect(reset()).not.toBeNull()
    expect(reset().disabled).toBe(true)
    // The attribute names the row is addressed by are lowercase: a capital in an
    // attribute name is legal but React drops it, so a camelCase action must not
    // reach the DOM as `data-diff-key-jumpDown`.
    expect(reset().getAttribute('data-reset')).toBe('data-diff-key-jumpdown')
    expect(recorder().getAttributeNames().every(name => name === name.toLowerCase())).toBe(true)

    fireEvent.click(recorder())
    fireEvent.keyDown(recorder(), { key: 'k', ctrlKey: true })
    expect(localStorage.getItem('diff-approval:key:jumpDown')).toBe('Ctrl+K')
    expect(reset().disabled).toBe(false)

    fireEvent.click(reset())
    expect(localStorage.getItem('diff-approval:key:jumpDown')).toBe('Ctrl+ArrowDown')
    expect(recorder().textContent).toContain('Ctrl+ArrowDown')
    expect(reset().disabled).toBe(true)
  })

  it('unbinds a shortcut when the recording is dismissed by a press elsewhere', () => {
    localStorage.removeItem('diff-approval:key:jumpDown')
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    fireEvent.click(document.querySelector('[data-diff-keybindings-toggle]') as HTMLButtonElement)

    const recorder = document.querySelector('[data-diff-key-jumpdown]') as HTMLButtonElement
    fireEvent.click(recorder)
    expect(recorder.textContent).toBe('panel.recordShortcut')

    // A press anywhere else is the answer "no shortcut", not a cancel: the row
    // shows it and the store holds it.
    fireEvent.pointerDown(document.body)
    expect(localStorage.getItem('diff-approval:key:jumpDown')).toBe('')
    expect((document.querySelector('[data-diff-key-jumpdown]') as HTMLButtonElement).textContent).toBe('panel.shortcutNone')
  })

  it('the DSH Settings tab carries the coverage switches in a group of their own', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)

    // Collapsed like the other groups: the rows appear once it is expanded.
    expect(document.querySelector('[data-diff-cover-left]')).toBeNull()
    fireEvent.click(document.querySelector('[data-diff-cover-toggle]') as HTMLButtonElement)

    // The same four edges the panel's popover offers, in the same order, each a
    // switch showing its own state.
    const edges = ['left', 'top', 'right', 'composer']
    const switches = edges.map(edge => document.querySelector(`[data-diff-cover-${edge}]`) as HTMLElement)
    for (const node of switches) expect(node).not.toBeNull()
    for (const node of switches) expect(node.getAttribute('role')).toBe('switch')
    // left, top, right on; composer off — the floating default.
    expect(switches.map(node => node.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false'])

    // Flipping one stores it, exactly as the panel's own popover does.
    fireEvent.click(switches[3]!)
    expect(JSON.parse(localStorage.getItem('diff-approval:float-cover') ?? '{}')).toEqual({ top: true, left: true, right: true, composer: true })
  })

  it('lets the settings group move the open panel, a separate mount', () => {
    // Both surfaces mounted, as in the app: the floating panel and the Settings
    // section. They share the stored cover, so a flip in one reaches the other.
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement
    expect(panel.style.bottom).toBe('128px')

    const settingsProps = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...settingsProps} />)
    fireEvent.click(document.querySelector('[data-diff-cover-toggle]') as HTMLButtonElement)
    fireEvent.click(document.querySelector('[data-diff-cover-composer]') as HTMLElement)

    // The open panel followed the switch: no reopen, no refresh.
    expect(panel.style.bottom).toBe('8px')
  })

  it('the DSH Settings tab carries a recorder row per coverage edge', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)
    fireEvent.click(document.querySelector('[data-diff-keybindings-toggle]') as HTMLButtonElement)

    // The four switches are rebindable like every other action, and each row
    // shows the default the panel actually applies.
    const defaults: Record<string, string> = {
      coverleft: 'Ctrl+Shift+ArrowLeft',
      covercomposer: 'Ctrl+Shift+ArrowDown',
      coverright: 'Ctrl+Shift+ArrowRight',
      covertop: 'Ctrl+Shift+ArrowUp',
    }
    for (const [attribute, chord] of Object.entries(defaults)) {
      const row = document.querySelector(`[data-diff-key-${attribute}]`) as HTMLButtonElement
      expect(row).not.toBeNull()
      expect(row.textContent).toContain(chord)
    }
  })

  it('the DSH Settings tab exposes a folded diff-view group with editable appearance', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)

    // Folded on open, like the keybindings and cover groups: the group is the longest one, and
    // the switches a reader reaches for while reviewing are on the panel's own toolbar.
    expect(document.querySelector('[data-diff-view-preview]')).toBeNull()
    expect(document.querySelector('[data-diff-font-size]')).toBeNull()

    // Expanding it brings the live preview and the font/line-height/color and layout rows in.
    fireEvent.click(document.querySelector('[data-diff-view-toggle]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-view-preview]')).not.toBeNull()
    expect(document.querySelector('[data-diff-font-size]')).not.toBeNull()
    expect(document.querySelector('[data-diff-line-height]')).not.toBeNull()
    expect(document.querySelector('[data-diff-add-color]')).not.toBeNull()
    expect(document.querySelector('[data-diff-del-color]')).not.toBeNull()
    expect(document.querySelector('[data-diff-tab-width-select]')).not.toBeNull()
    expect(document.querySelector('[data-diff-split-mode-select]')).not.toBeNull()
    // The auto-paste switch is not here: it belongs to the comments group, which is about writing.
    expect(document.querySelector('[data-diff-paste-on-copy-select]')).toBeNull()

    // Opening a color trigger shows the HSV dial; typing an RGB value and
    // committing persists to localStorage.
    fireEvent.click(document.querySelector('[data-diff-add-color]') as HTMLElement)
    const addInput = document.querySelector('[data-diff-color-input]') as HTMLInputElement
    fireEvent.change(addInput, { target: { value: 'rgb(17, 34, 51)' } })
    fireEvent.blur(addInput)
    expect(localStorage.getItem('diff-approval:diff-add-color')).toBe('#112233')

    fireEvent.click(document.querySelector('[data-diff-del-color]') as HTMLElement)
    const delInput = document.querySelector('[data-diff-color-input]') as HTMLInputElement
    fireEvent.change(delInput, { target: { value: '#aa0055' } })
    fireEvent.blur(delInput)
    expect(localStorage.getItem('diff-approval:diff-del-color')).toBe('#aa0055')

    // Collapse the group: the controls hide — the live preview included, so the
    // card's own margins cannot leave a gap under a collapsed header.
    fireEvent.click(document.querySelector('[data-diff-view-toggle]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-font-size]')).toBeNull()
    expect(document.querySelector('[data-diff-view-preview]')).toBeNull()
  })

  it('lets the status bar pick the highlight language', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const trigger = document.querySelector('[data-diff-lang]') as HTMLElement
    expect(trigger).not.toBeNull()
    fireEvent.click(trigger)
    const typescript = screen.getByText('TypeScript')
    fireEvent.click(typescript)
    expect(trigger.textContent).toContain('TypeScript')
  })

  it('keeps the panel open when a portaled language item is picked', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    fireEvent.click(document.querySelector('[data-diff-lang]') as HTMLElement)
    const item = screen.getByText('TypeScript')
    // The menu is portaled into body, so picking an item is a pointerdown
    // outside the panel element: it must not read as a click outside the panel.
    fireEvent.pointerDown(item)
    fireEvent.click(item)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    expect(document.querySelector('[data-diff-lang]')!.textContent).toContain('TypeScript')
  })

  it('remembers a hand-picked language per file suffix and forgets it on auto', () => {
    const file = entry({ id: 'entry-lang-md', path: '/repo/README.md', oldText: '# A\n', newText: '# B\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))

    fireEvent.click(document.querySelector('[data-diff-lang]') as HTMLElement)
    fireEvent.click(screen.getByText('TypeScript'))
    expect(localStorage.getItem('diff-approval:lang-by-suffix')).toBe('{"md":"typescript"}')

    // A fresh panel on the same suffix comes up with the remembered choice…
    view.unmount()
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    expect(document.querySelector('[data-diff-lang]')!.textContent).toContain('TypeScript')

    // …and picking auto forgets it again.
    fireEvent.click(document.querySelector('[data-diff-lang]') as HTMLElement)
    fireEvent.click(screen.getByText('action.langAuto'))
    expect(localStorage.getItem('diff-approval:lang-by-suffix')).toBe('{}')
  })

  it('lists only curated highlight languages, conventionally cased and sorted', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const trigger = document.querySelector('[data-diff-lang]') as HTMLElement
    fireEvent.click(trigger)

    const items = [...document.querySelectorAll('[role="menuitem"]')]
      .map(item => item.textContent?.trim())
      .filter(Boolean)
    // First entry is the auto-detect action; the rest are the explicit grammar list.
    expect(items[0]).toBe('action.langAuto')
    const languages = items.slice(1)
    expect(languages).toEqual([
      'C', 'C++', 'C#', 'CSS', 'Go', 'HTML', 'INI', 'Java', 'JSON', 'Lua',
      'Markdown', 'Python', 'Ruby', 'Rust', 'SCSS', 'Shell', 'SQL', 'TOML',
      'TypeScript', 'XML', 'YAML',
    ])
  })

  it('toggles the per-language auto-wrap switch and persists it', () => {
    const htmlFile = entry({ id: 'entry-wrap', path: '/repo/index.html', oldText: '<div>\n', newText: '<span>\n' })
    const props = panelProps({ read: true, files: [htmlFile], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('index.html'))

    const wrap = document.querySelector('[data-diff-wrap]') as HTMLElement
    expect(wrap).not.toBeNull()
    // Default off.
    expect(wrap.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('diff-approval:wrap:html')).toBe('1')

    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    expect(localStorage.getItem('diff-approval:wrap:html')).toBe('0')
  })

  it('shows no intra-line chips in the single-column view', () => {
    // Intra-line highlighting is split-view only: in single column a modified
    // plain (`.txt`) line keeps its text without any per-span chips.
    const intra = entry({ id: 'entry-intra', path: '/repo/intra.txt', oldText: 'foo bar\n', newText: 'foo baz\n' })
    const props = panelProps({ read: true, files: [intra], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('intra.txt'))

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    expect(rows.length).toBe(2)
    const delRow = rows.find(r => r.dataset.diffLine === 'del')!
    const addRow = rows.find(r => r.dataset.diffLine === 'add')!
    const delCode = delRow.querySelector('[data-diff-code]') ?? delRow
    const addCode = addRow.querySelector('[data-diff-code]') ?? addRow
    expect(delCode.textContent).toBe('foo bar')
    expect(addCode.textContent).toBe('foo baz')
    // No grammar and no intra-line chips: the code cells stay plain text nodes.
    expect(delCode.querySelectorAll('span').length).toBe(0)
    expect(addCode.querySelectorAll('span').length).toBe(0)
  })

  it('renders intra-line chips on a highlighted markdown line in the split view', () => {
    // Split view keeps the highlight + intra-line merge path; a `.md` file is
    // syntax-highlighted (grammar present), so both columns show chip spans.
    localStorage.setItem('diff-approval:split-mode', '1')
    const head = '- **Block navigation & decisions**: jump between change blocks with `Ctrl+↑/↓` '
    const file = entry({
      id: 'entry-md-intra', path: '/repo/README.md',
      oldText: head + 'OLD\n', newText: head + 'NEW\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))

    const leftCode = document.querySelector('[data-diff-split-row][data-diff-split-side="left"] [data-diff-code]')
    const rightCode = document.querySelector('[data-diff-split-row][data-diff-split-side="right"] [data-diff-code]')
    expect(leftCode?.textContent).toContain('- **Block navigation & decisions**: jump between change blocks')
    expect(rightCode?.textContent).toContain('- **Block navigation & decisions**: jump between change blocks')
    expect(leftCode?.querySelectorAll('span').length ?? 0).toBeGreaterThanOrEqual(2)
    expect(rightCode?.querySelectorAll('span').length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('renders intra-line chips in both columns of the split view', () => {
    localStorage.setItem('diff-approval:split-mode', '1')
    const intra = entry({ id: 'entry-split-intra', path: '/repo/split.txt', oldText: 'foo bar\n', newText: 'foo baz\n' })
    const props = panelProps({ read: true, files: [intra], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('split.txt'))

    const leftCode = document.querySelector('[data-diff-split-row][data-diff-split-side="left"] [data-diff-code]')
    const rightCode = document.querySelector('[data-diff-split-row][data-diff-split-side="right"] [data-diff-code]')
    expect(leftCode?.textContent).toBe('foo bar')
    expect(rightCode?.textContent).toBe('foo baz')
    // Both columns clip into chip spans (shared prefix + changed tail).
    expect(leftCode?.querySelectorAll('span').length ?? 0).toBeGreaterThanOrEqual(2)
    expect(rightCode?.querySelectorAll('span').length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('comments on a selection in the side-by-side view, and draws the thread over both halves', () => {
    // A two-column selection names a pair range and ONE column. Only the right (new) column is
    // offered: a thread is anchored to new-file lines — what survives a rebuild — so the left
    // column's old code has nothing to anchor to. The card is drawn over both halves (they are
    // separate clipped scrollers, so it cannot live inside either) while each half reserves its rows,
    // which is what keeps the pairs below aligned.
    localStorage.setItem('diff-approval:split-mode', '1')
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-split-comment', path: '/repo/comment.txt', oldText: 'a\nb\n', newText: 'a\nB\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('comment.txt'))

    const select = (element: HTMLElement): void => {
      const node = element.firstChild ?? element
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
    }
    const rowsOf = (side: 'left' | 'right'): HTMLElement[] => (
      [...document.querySelectorAll(`[data-diff-split-row][data-diff-split-side="${side}"] [data-diff-code]`)] as HTMLElement[]
    )

    // The left column is the old file: it offers no comment at all.
    select(rowsOf('left')[rowsOf('left').length - 1]!)
    expect(document.querySelector('[data-diff-selection-actions]')).toBeNull()

    // The added line, on the right: the last right row (the first is the context line the pair
    // shares, which is not this file's change).
    const code = rowsOf('right')[rowsOf('right').length - 1]!
    expect(code.textContent).toContain('B')
    select(code)
    expect(document.querySelector('[data-diff-selection-comment]')).not.toBeNull()

    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(block).not.toBeNull()
    // Over both halves, not inside one of them…
    expect(block.closest('[data-diff-split-discussions]')).not.toBeNull()
    expect(block.closest('[data-diff-split-side]')).toBeNull()
    // …and its reference names the added line the right column showed.
    expect(block.querySelector('[data-diff-discussion-range]')?.textContent).toBe('/repo/comment.txt:2')
    // Both halves reserved its rows, so the pair below starts on the same pixel in each.
    expect(document.querySelectorAll('[data-diff-discussion-space]').length).toBe(2)
    // The wash belongs to the pair, not to a half of it: the commented line is an addition, so the old
    // side has no row there at all — and the band is drawn across both halves, the empty one included.
    expect(document.querySelectorAll('[data-diff-split-row][data-diff-discussion-band]').length).toBe(2)
    // The card is laid out to the rows the panel measured for the thread: a box sized to the compose
    // fallback would clip the thread's own turns (which is how an answer could go missing here).
    expect(Number.parseFloat(block.style.height)).toBeGreaterThan(2 * 22)
  })

  it('reads a selection that crossed the divider as the column it began in', () => {
    // Only a selection the panel did not drive itself can have its two ends in different halves: a
    // keyboard selection onto the neighbouring column, or a touch press. It is read as the range of the
    // column it began in, over the pairs both ends name.
    localStorage.setItem('diff-approval:split-mode', '1')
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-split-sides', path: '/repo/sides.txt', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' })
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('sides.txt'))

    const rowsOf = (side: 'left' | 'right'): HTMLElement[] => (
      [...document.querySelectorAll(`[data-diff-split-row][data-diff-split-side="${side}"]`)] as HTMLElement[]
    )
    // A backwards selection: it began in the right column's first row and was dragged into the left
    // column, so the anchor's side is the new one while the range starts at the left column's node.
    const anchorNode = rowsOf('right')[0]!.querySelector('[data-diff-code]')!.firstChild!
    const startNode = rowsOf('left')[0]!.querySelector('[data-diff-code]')!.firstChild!
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode,
      anchorOffset: 0,
      focusNode: startNode,
      getRangeAt: () => ({ startContainer: startNode, startOffset: 0, endContainer: anchorNode, endOffset: 1 }),
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // Which the panel offers a comment for, as a range of the new file — the column it began in.
    expect(document.querySelector('[data-diff-selection-comment]')).not.toBeNull()
  })

  it('seals the page while a touch press is held in a column', () => {
    // Touch cannot be driven by the panel, so the other column is made unselectable instead: a class on
    // `body` (see `.splitSealed`), with the pressed column's side opened again.
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-seal', path: '/repo/seal.txt', oldText: 'a\nb\n', newText: 'a\nB\n' })
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('seal.txt'))

    const row = document.querySelector('[data-diff-split-row][data-diff-split-side="left"]') as HTMLElement
    expect(document.body.className).not.toContain('splitSealed')

    fireEvent.pointerDown(row)
    expect(document.body.className).toContain('splitSealed')
    expect(document.body.className).toContain('splitSealedLeft')

    fireEvent.pointerUp(document)
    expect(document.body.className).not.toContain('splitSealed')
  })

  it('drives a mouse drag in the column it began in, past the divider', async () => {
    // The press is the panel's own drag: the browser's default — which would run on into the other
    // column — is prevented, and the position comes from the pointer, computed inside the pressed
    // column's own rows (see the split view's drag).
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-drive', path: '/repo/drive.txt', oldText: 'a\nb\n', newText: 'a\nB\n' })
    const originalCaret = (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint
    const range = document.createRange()
    const asked: Array<{ x: number; y: number }> = []
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: (x: number, y: number): Range => {
        asked.push({ x, y })
        return range
      },
    })
    try {
      render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('drive.txt'))

      // jsdom lays nothing out, so the rows the drag picks between are given boxes here: one row of 22
      // pixels per index, each with its code cell inset from the row's left edge.
      const rows = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="left"]')] as HTMLElement[]
      const boxOf = (index: number): DOMRect => ({
        x: 0,
        y: index * 22,
        left: 0,
        top: index * 22,
        right: 400,
        bottom: index * 22 + 22,
        width: 400,
        height: 22,
        toJSON: () => ({}),
      }) as DOMRect
      rows.forEach((row, index) => {
        vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(boxOf(index))
        const cell = row.querySelector('[data-diff-code]') as HTMLElement
        vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ ...boxOf(index), left: 20, right: 400, width: 380 })
      })
      const code = rows[0]!.querySelector('[data-diff-code]') as HTMLElement
      const scroller = document.querySelector('[data-diff-body]') as HTMLElement
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ ...boxOf(0), bottom: 200, height: 200 })
      range.setStart(code.firstChild as Text, 0)
      const at = range.startContainer
      const setBaseAndExtent = vi.fn()
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: true,
        rangeCount: 0,
        setBaseAndExtent,
      } as unknown as Selection)

      // A plain press (the first of its click) with nothing held: exactly what the drag takes over.
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 5 })
      Object.defineProperty(press, 'detail', { value: 1 })
      code.dispatchEvent(press)
      expect(press.defaultPrevented).toBe(true)
      expect(setBaseAndExtent).toHaveBeenCalledTimes(1)
      const call = setBaseAndExtent.mock.calls[0] as unknown[]
      // The anchor is the position the press names, and the extent the position the pointer names —
      // both taken inside the pressed column's code, which is what keeps the drag there.
      expect(call[0]).toBe(at)
      expect(call[2]).toBe(at)

      // Dragged past the divider into the other column: the point asked about is still inside the
      // pressed column's code cell, so the selection cannot follow the pointer across — and the move
      // does move the selection (a pass that only ever scrolled would leave it where the press put it).
      const move = new Event('pointermove', { bubbles: true }) as Event & { clientX: number; clientY: number }
      move.clientX = 700
      move.clientY = 5
      document.dispatchEvent(move)
      await act(async () => { await new Promise(resolve => { requestAnimationFrame(() => { resolve(undefined) }) }) })
      expect(asked.length).toBeGreaterThan(1)
      expect(asked[asked.length - 1]!.x).toBeLessThanOrEqual(400)
      expect(setBaseAndExtent.mock.calls.length).toBeGreaterThan(1)
    } finally {
      if (originalCaret === undefined) delete (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint
      else Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: originalCaret })
    }
  })

  it('quotes an outdated thread of the side-by-side view in both columns, each panning with its own', () => {
    // A selection in this view covers both halves, so the quote of a thread whose code has moved on is
    // drawn in both: one row per aligned pair, in the columns the file itself shows. Each half then
    // pans with its own column's strip — the quote is drawn in the card over both halves, so nothing
    // else would move it along with its own code.
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-quote', path: '/repo/quote.txt', oldText: 'a\nb\n', newText: 'a\nB\n' })
    rememberDiscussions(S1, {
      [file.id]: [{
        id: 'd-split-lost',
        anchor: { start: 1, end: 1, startLine: 2, endLine: 2 },
        collapsed: false,
        draft: '',
        lost: true,
        quote: 'const gone = 1',
        quoteLines: [{ old: undefined, new: 2, kind: 'add' }],
        messages: [{ role: 'user', text: '这行为什么改了？' }],
      }],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('quote.txt'))

    const quote = document.querySelector('[data-diff-discussion-quote]') as HTMLElement
    expect(quote).not.toBeNull()
    // The block still says why the code below it is a quote at all.
    expect(document.querySelector('[data-diff-discussion-quote-label]')?.textContent).toBe('discussion.outdatedQuote')
    // One row for the pair, drawn in both halves: the quoted line was an addition, so the old half has
    // no number and no text of its own.
    const left = quote.querySelector('[data-diff-quote-side="left"]') as HTMLElement
    const right = quote.querySelector('[data-diff-quote-side="right"]') as HTMLElement
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    expect(left.querySelectorAll('[data-diff-quote-pair]').length).toBe(1)
    expect(right.querySelectorAll('[data-diff-quote-pair]').length).toBe(1)
    expect(right.textContent).toContain('const gone = 1')
    expect(left.textContent).not.toContain('const gone = 1')
    expect(left.querySelector('[data-diff-quote-gutter]')?.textContent).toBe('')
    expect(right.querySelector('[data-diff-quote-gutter]')?.textContent).toBe('2')

    // Each half follows its own strip, and only its own.
    const leftText = left.querySelector('[data-diff-quote-text]') as HTMLElement
    const rightText = right.querySelector('[data-diff-quote-text]') as HTMLElement
    const leftStrip = document.querySelector('[data-diff-hscroll="left"]') as HTMLElement
    leftStrip.scrollLeft = 40
    fireEvent.scroll(leftStrip)
    expect(leftText.scrollLeft).toBe(40)
    expect(rightText.scrollLeft).toBe(0)

    const rightStrip = document.querySelector('[data-diff-hscroll="right"]') as HTMLElement
    rightStrip.scrollLeft = 12
    fireEvent.scroll(rightStrip)
    expect(rightText.scrollLeft).toBe(12)
    expect(leftText.scrollLeft).toBe(40)
  })

  it('marks a side-by-side comment outdated by the same rule the one-column view uses', () => {
    // The outdated decision is made from the model, not from the view: a file rewritten under a
    // side-by-side comment leaves that comment outdated exactly as it would in one column, with the
    // same label over the same quote.
    localStorage.setItem('diff-approval:split-mode', '1')
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-split-outdated', path: '/repo/outdated.txt', oldText: 'a\n', newText: 'b\n' })
    const view = render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('outdated.txt'))

    // The comment goes on the added line, which the split view shows in its right column.
    const rows = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="right"]')] as HTMLElement[]
    const row = rows[rows.length - 1]!
    const node = row.querySelector('[data-diff-code]')?.firstChild ?? row
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      anchorNode: node,
      focusNode: node,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
      removeAllRanges: () => {},
    } as unknown as Selection)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })
    fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-discussion]')?.hasAttribute('data-lost')).toBe(false)

    // The file is rewritten under it: the numbers are still in the model but the quoted line is
    // nowhere, which is what marks the thread outdated.
    const rewritten = entry({ id: 'entry-split-outdated', path: '/repo/outdated.txt', oldText: 'x\n', newText: 'y\n' })
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [rewritten], busy: new Set() })} />)
    const block = document.querySelector('[data-diff-discussion]') as HTMLElement
    expect(block.hasAttribute('data-lost')).toBe(true)
    expect(document.querySelector('[data-diff-discussion-quote-label]')?.textContent).toBe('discussion.outdatedQuote')
    // And its quote is still the two columns this view draws.
    expect(document.querySelector('[data-diff-discussion-quote] [data-diff-quote-side="left"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-discussion-quote] [data-diff-quote-side="right"]')).not.toBeNull()
  })

  it('lands a comment jump on the split view\'s own scroller', () => {
    // The comments list's jump is shared by both views, so it has to reach whichever one is up. The
    // split view owns its own scroller (the single-column one is not mounted at all), and it lands the
    // row at the pair that row is in, leaving the same lead rows above it as every other jump.
    localStorage.setItem('diff-approval:split-mode', '1')
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-split-jump', path: '/repo/jump.txt', kind: 'create', oldText: '', newText: 'a\nb\nc\nd\ne\nf\ng\nh\n' })
    rememberDiscussions(S1, {
      [file.id]: [
        { id: 'd-split-jump', anchor: { start: 7, end: 7, startLine: 8, endLine: 8 }, collapsed: false, draft: '', lost: false, messages: [{ role: 'user', text: '这一行' }] },
      ],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('jump.txt'))
    expect(document.querySelector('[data-diff-split-row]')).not.toBeNull()

    fireEvent.click(document.querySelector('[data-diff-list-tab="comments"]') as HTMLElement)
    const item = document.querySelector('[data-diff-comment-link]') as HTMLElement
    expect(item).not.toBeNull()

    const restore = stubCodeScroll()
    try {
      fireEvent.click(item)
      const body = document.querySelector('[data-diff-body]') as HTMLElement
      // One row a line here too (nothing wraps in jsdom), so the pair the comment names is its line less
      // one, and the lead rows above it are the configured ones.
      expect(body.scrollTop).toBe((8 - 1 - navLeadRows()) * diffLineHeight())
    } finally {
      restore()
    }
  })

  it('lands an outdated comment on its own box, not on the rows its numbers name', () => {
    // The code an outdated comment was written about is gone, so the row its numbers point at says
    // nothing: the jump goes to the thread's box instead, which hangs under the pair its range ends in —
    // one row lower than the landing a live comment's row gets.
    localStorage.setItem('diff-approval:split-mode', '1')
    act(() => { setCommentModeEnabled(true) })
    const file = entry({ id: 'entry-split-card', path: '/repo/card.txt', kind: 'create', oldText: '', newText: 'a\nb\nc\nd\ne\nf\ng\nh\n' })
    rememberDiscussions(S1, {
      [file.id]: [{
        id: 'd-split-card',
        anchor: { start: 7, end: 7, startLine: 8, endLine: 8 },
        collapsed: false,
        draft: '',
        lost: true,
        quote: 'const gone = 1',
        quoteLines: [{ old: undefined, new: 8, kind: 'add' }],
        messages: [{ role: 'user', text: '这一行' }],
      }],
    } as unknown as Parameters<typeof rememberDiscussions>[1])
    render(<PendingPanel {...panelProps({ read: true, files: [file], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('card.txt'))
    fireEvent.click(document.querySelector('[data-diff-list-tab="comments"]') as HTMLElement)

    const item = document.querySelector('[data-diff-comment-link]') as HTMLElement
    expect(item).not.toBeNull()
    const restore = stubCodeScroll()
    try {
      fireEvent.click(item)
      const body = document.querySelector('[data-diff-body]') as HTMLElement
      expect(body.scrollTop).toBe((8 - navLeadRows()) * diffLineHeight())
    } finally {
      restore()
    }
  })

  it('row-aligns a similarity-matched del/add pair in the split view', () => {
    // The split view always aligns by similarity: the deletion "old line A"
    // pairs with its most-similar addition "modified old line A", so both sit
    // on the same pair index (same Y row); the unrelated addition is a separate
    // row.
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-align', path: '/repo/sa.txt', oldText: 'old line A\n', newText: 'brand new unrelated\nmodified old line A\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('sa.txt'))

    const left = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="left"]')] as HTMLElement[]
    const right = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="right"]')] as HTMLElement[]
    const leftText = (el: HTMLElement) => el.querySelector('[data-diff-code]')?.textContent ?? ''
    const rightText = (el: HTMLElement) => el.querySelector('[data-diff-code]')?.textContent ?? ''
    const leftPair = left.map(el => Number(el.dataset.diffSplitIndex))
    const rightPair = right.map(el => Number(el.dataset.diffSplitIndex))
    // The matched pair shares one pair index (same Y) in both columns.
    const matchIdx = left.findIndex(el => leftText(el) === 'old line A')
    expect(matchIdx).toBeGreaterThanOrEqual(0)
    expect(rightText(right[leftPair[matchIdx]!])).toBe('modified old line A')
    expect(leftPair).toEqual(rightPair)
  })

  it('leaves a dissimilar del/add split row unaligned with no intra-line chips', () => {
    // Similarity alignment keeps an unrelated pair apart (separate del-only /
    // add-only rows), and neither side carries intra-line chips.
    localStorage.setItem('diff-approval:split-mode', '1')
    const rewrite = entry({ id: 'entry-rewrite', path: '/repo/rewrite.txt', oldText: 'hello world here\n', newText: 'completely different text now\n' })
    const props = panelProps({ read: true, files: [rewrite], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('rewrite.txt'))

    const leftCode = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="left"] [data-diff-code]')]
      .find(el => (el.textContent ?? '') !== '')
    const rightCode = [...document.querySelectorAll('[data-diff-split-row][data-diff-split-side="right"] [data-diff-code]')]
      .find(el => (el.textContent ?? '') !== '')
    expect(leftCode?.textContent).toBe('hello world here')
    expect(rightCode?.textContent).toBe('completely different text now')
    // No grammar, no intra-line chips: plain text nodes.
    expect(leftCode?.querySelectorAll('span').length ?? 0).toBe(0)
    expect(rightCode?.querySelectorAll('span').length ?? 0).toBe(0)
  })

  it('surfaces the block approval frame when hovering a similarity-aligned pair', () => {
    // One contiguous change block, but similarity re-orders its del/add pairing:
    // del0 'alpha' pairs with add1 'alpha modified' (peaks similarity), leaving
    // del1 'beta' del-only and add0 'gamma' add-only. The block's whole pair range
    // spans those three pairs, but deriving it from the first/last row collapses it
    // to one pair, so hovering the del-only/add-only pairs would not surface the
    // frame. The block index must come from the block's own rows' pair indices.
    localStorage.setItem('diff-approval:split-mode', '1')
    const file = entry({ id: 'entry-split-reorder', path: '/repo/reorder.txt', oldText: 'alpha\nbeta\n', newText: 'gamma\nalpha modified\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('reorder.txt'))

    const rows = [...document.querySelectorAll('[data-diff-split-row]')] as HTMLElement[]
    const delOnly = rows.find(row => (row.querySelector('[data-diff-code]')?.textContent ?? '') === 'beta')
    expect(delOnly).toBeDefined()
    fireEvent.mouseEnter(delOnly!)
    expect(document.querySelector('[data-diff-block-actions]')).not.toBeNull()
  })

  it('steps the split block approval frame and wraps straight back to the first block', () => {
    localStorage.setItem('diff-approval:split-mode', '1')
    const twoBlocks = entry({ id: 'entry-split-steps', path: '/repo/ss.txt', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('ss.txt'))

    const rows = [...document.querySelectorAll('[data-diff-split-row]')] as HTMLElement[]
    // Hover block 0's left row (del 'a').
    const block0Left = rows.find(row => (row.querySelector('[data-diff-code]')?.textContent ?? '') === 'a')
    expect(block0Left).toBeDefined()
    fireEvent.mouseEnter(block0Left!)

    const actions = document.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(actions).not.toBeNull()
    const position = actions.querySelector('[data-diff-block-position]') as HTMLElement
    const next = actions.querySelector('[data-diff-block-next]') as HTMLElement
    const prev = actions.querySelector('[data-diff-block-prev]') as HTMLElement
    expect(position.textContent).toContain('1')

    // Next steps the frame (and focus) to block 1.
    fireEvent.click(next)
    expect(position.textContent).toContain('2')

    // One more next wraps straight back to the first, exactly like the
    // single-column frame — no boundary toast pin, no second press needed.
    fireEvent.click(next)
    expect(position.textContent).toContain('1')

    // Prev mirrors it: from the first block it wraps straight to the last...
    fireEvent.click(prev)
    expect(position.textContent).toContain('2')
    // ...and again returns to the first, with no first-block toast pin either.
    fireEvent.click(prev)
    expect(position.textContent).toContain('1')
  })

  it('toggles the single-column / side-by-side view from the header toolbar', () => {
    localStorage.setItem('diff-approval:split-mode', '0')
    const file = entry({ id: 'entry-toggle-view', path: '/repo/tl.txt', oldText: 'a\n', newText: 'b\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('tl.txt'))

    // Starts in the single-column (unified) view: no split horizontal-scroll strip.
    expect(document.querySelector('[data-diff-hscroll]')).toBeNull()

    // Toggle to the side-by-side (split) view.
    fireEvent.click(screen.getByLabelText('action.viewSplit'))
    expect(document.querySelector('[data-diff-hscroll="left"]')).not.toBeNull()
    expect(document.querySelector('[data-diff-split-row]')).not.toBeNull()
    expect(localStorage.getItem('diff-approval:split-mode')).toBe('1')

    // Toggle back to single-column.
    fireEvent.click(screen.getByLabelText('action.viewUnified'))
    expect(document.querySelector('[data-diff-hscroll]')).toBeNull()
    expect(localStorage.getItem('diff-approval:split-mode')).toBe('0')
  })

  it('offers a rendered Markdown preview that toggles for a Markdown file', () => {
    const file = entry({ id: 'entry-md', path: '/repo/README.md', oldText: '# Title\nOld line\n', newText: '# Title\nNew line\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))

    const toggle = document.querySelector('[data-diff-md-preview]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    // Starts on the source-line diff.
    expect(document.querySelector('[data-diff-md-preview-body]')).toBeNull()

    // Toggle to the rendered Markdown preview: single-column by default.
    fireEvent.click(toggle)
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.dataset.diffMdMode).toBe('single')
    expect(body.querySelector('.mdBlock, .mdAdd')).not.toBeNull()
    // Single-column mirrors the source unified diff: whole-block tint only,
    // no word-level highlight.
    expect(body.querySelector('.mdWordDel')).toBeNull()
    expect(body.querySelector('.mdWordAdd')).toBeNull()
    // The preview shows the diff ruler beside the scrollbar (both layouts do).
    expect(document.querySelector('[data-diff-approval-ruler]')).not.toBeNull()
    expect(document.querySelector('[data-diff-ruler-marker]')).not.toBeNull()
    // The language dropdown and word-wrap toggle are source-diff only.
    expect(document.querySelector('[data-diff-lang]')).toBeNull()
    expect(document.querySelector('[data-diff-wrap]')).toBeNull()

    // The existing view toggle drives the before/after double-column layout.
    fireEvent.click(document.querySelector('[data-diff-toggle-view]') as HTMLButtonElement)
    const dbl = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    expect(dbl.dataset.diffMdMode).toBe('double')
    expect(dbl.querySelectorAll('.mdDouble, .mdDoubleCol').length).toBeGreaterThan(0)
    // Deleted lines render in the before column, added lines in the after column.
    expect(dbl.querySelectorAll('.mdDoubleCol .mdDel').length).toBeGreaterThan(0)
    expect(dbl.querySelectorAll('.mdDoubleCol .mdAdd').length).toBeGreaterThan(0)
    // Word-level highlights survive in each column.
    expect(dbl.querySelectorAll('.mdDoubleCol .mdWordDel').length).toBeGreaterThan(0)
    expect(dbl.querySelectorAll('.mdDoubleCol .mdWordAdd').length).toBeGreaterThan(0)
    // The ruler is measured in both preview layouts: the double column's rows are
    // aligned, so their cells share the vertical extent a marker is placed by.
    expect(document.querySelector('[data-diff-approval-ruler]')).not.toBeNull()
    expect(document.querySelector('[data-diff-ruler-marker]')).not.toBeNull()

    // Toggle back to the source diff.
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLButtonElement)
    expect(document.querySelector('[data-diff-md-preview-body]')).toBeNull()
    // The source diff renders again (its virtualization re-measures the fresh
    // body after the preview took over it, so the rows are not blank until a
    // scroll). The view toggle left split view on, so either row type is fine.
    expect(document.querySelectorAll('[data-diff-row], [data-diff-split-row]').length).toBeGreaterThan(0)
  })

  it('does not offer the Markdown preview toggle for a non-Markdown file', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    expect(document.querySelector('[data-diff-md-preview]')).toBeNull()
  })

  it('starts in the Markdown preview when the setting is enabled', () => {
    localStorage.setItem('diff-approval:md-preview', '1')
    const file = entry({ id: 'entry-md', path: '/repo/README.md', oldText: '# T\n', newText: '# T\n\nNew\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    expect(document.querySelector('[data-diff-md-preview-body]')).not.toBeNull()
  })

  it('shows source code (not the Markdown preview) for a non-Markdown file even when the preview setting is on', () => {
    localStorage.setItem('diff-approval:md-preview', '1')
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    expect(document.querySelector('[data-diff-md-preview-body]')).toBeNull()
    expect(document.querySelector('[data-diff-body]')).not.toBeNull()
    // The preference is stored, but no preview is showing: the source view keeps
    // its own controls (language and wrap are hidden only by an ACTIVE preview).
    expect(document.querySelector('[data-diff-lang]')).not.toBeNull()
    expect(document.querySelector('[data-diff-wrap]')).not.toBeNull()
  })

  it('keeps/reverts one change block from the Markdown preview', async () => {
    // Two change blocks separated by context, so block indices are meaningful.
    const file = entry({
      id: 'entry-md-blocks',
      path: '/repo/README.md',
      oldText: '# T\nold one\nsame\nold two\n',
      newText: '# T\nnew one\nsame\nnew two\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    // Every changed run is tagged with its source block index; context is not.
    expect(document.querySelectorAll('[data-md-block="0"]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-md-block="1"]').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-md-block]').length).toBe(
      document.querySelectorAll('.mdAdd, .mdDel').length,
    )

    // Hovering the second block shows the same frame the source view shows.
    fireEvent.mouseOver(document.querySelector('[data-md-block="1"]') as HTMLElement)
    const frame = document.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(frame).not.toBeNull()
    expect(frame.querySelector('[data-diff-block-position]')!.textContent)
      .toBe('panel.blockPosition {"current":2,"total":2}')
    // Its offsets are ours: right of the content (the preview content is centred
    // under a max width, so the pane edge would strand the frame in the margin),
    // and at the block's bottom edge (jsdom reports every rect as 0, so that is
    // 0 here; the inset is the constant the placement adds).
    expect(document.querySelector('[data-diff-md-preview-content]')).not.toBeNull()
    expect(frame.style.right).toBe('8px')
    expect(frame.style.top).toBe('0px')

    // Keep runs on that block's source range (old 4-4 / new 4-4): the third
    // line is context, so the block is the fourth line on both sides.
    fireEvent.click(frame!.querySelector('[data-diff-block-keep]') as HTMLElement)
    await waitFor(() => {
      expect((props.onBlockKeep as unknown as { mock: { calls: unknown[][] } }).mock.calls)
        .toEqual([[S1, 'entry-md-blocks', { oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 4 }]])
    })
  })

  it('applies a keep to every block a preview selection covers', async () => {
    const file = entry({
      id: 'entry-md-select',
      path: '/repo/README.md',
      oldText: '# T\nold one\nold two\n',
      newText: '# T\nnew one\nnew two\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    // Two blocks (a del run and its add run each), so the range spans old 2-3 /
    // new 2-3 and resolves the whole file.
    const blocks = [...document.querySelectorAll('[data-md-block="0"]')]
    expect(blocks.length).toBe(2)
    const range = document.createRange()
    range.setStartBefore(blocks[0]!)
    range.setEndAfter(blocks[blocks.length - 1]!)
    const selection = window.getSelection()
    expect(selection).not.toBeNull()
    selection!.removeAllRanges()
    selection!.addRange(range)
    act(() => { document.dispatchEvent(new Event('selectionchange')) })

    // The selection frame replaces the hover frame and carries the combined range.
    const frame = document.querySelector('[data-diff-selection-actions]')
    expect(frame).not.toBeNull()
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()
    fireEvent.click(frame!.querySelector('[data-diff-selection-keep]') as HTMLElement)

    // Covering every block resolves the file, so the panel asks about removing it
    // (the same prompt the source view routes a whole-file block action through).
    await waitFor(() => { expect(document.querySelector('[data-diff-confirm]')).not.toBeNull() })
    fireEvent.click(document.querySelector('[data-diff-confirm-remove]') as HTMLElement)
    await waitFor(() => {
      expect((props.onBlockKeep as unknown as { mock: { calls: unknown[][] } }).mock.calls)
        .toEqual([[S1, 'entry-md-select', { oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 3 }, true]])
    })
  })

  it('tags the double-column preview too, and drops the hover frame on leaving', () => {
    const file = entry({
      id: 'entry-md-double',
      path: '/repo/README.md',
      oldText: '# T\nold one\n',
      newText: '# T\nnew one\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)
    // The view toggle drives the double-column layout, which tags both cells of
    // the aligned change row with the same block.
    fireEvent.click(document.querySelector('[data-diff-toggle-view]') as HTMLElement)
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    expect(body.dataset.diffMdMode).toBe('double')
    expect(document.querySelectorAll('[data-md-block="0"]').length).toBe(2)

    fireEvent.mouseOver(document.querySelector('[data-md-block="0"]') as HTMLElement)
    expect(document.querySelector('[data-diff-block-actions]')).not.toBeNull()
    fireEvent.mouseLeave(document.querySelector('[data-md-preview-wrap]') ?? body.parentElement as HTMLElement)
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()
  })

  it('drops the preview frame over context and keeps it over the frame itself', () => {
    const file = entry({ id: 'entry-md-hover', path: '/repo/README.md', oldText: '# T\nold\n', newText: '# T\nnew\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    fireEvent.mouseOver(document.querySelector('[data-md-block="0"]') as HTMLElement)
    expect(document.querySelector('[data-diff-block-actions]')).not.toBeNull()

    // A context block (the unchanged heading) clears it, exactly like hovering an
    // unchanged line in the code view.
    fireEvent.mouseOver(document.querySelector('.mdBlock:not([data-md-block])') as HTMLElement)
    expect(document.querySelector('[data-diff-block-actions]')).toBeNull()

    // Moving onto the frame's own buttons keeps it, so it stays clickable.
    fireEvent.mouseOver(document.querySelector('[data-md-block="0"]') as HTMLElement)
    const frame = document.querySelector('[data-diff-block-actions]') as HTMLElement
    fireEvent.mouseOver(frame)
    expect(document.querySelector('[data-diff-block-actions]')).not.toBeNull()
  })

  it('re-places the preview frame as the pane scrolls', async () => {
    const file = entry({ id: 'entry-md-scroll', path: '/repo/README.md', oldText: '# T\nold\n', newText: '# T\nnew\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    // jsdom has no layout: give the pane and its block rects that move with the
    // scroll, so the placement has something real to re-measure.
    let scrolled = 0
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    const rect = (top: number, bottom: number): DOMRect =>
      ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 })
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 300))
    const block = document.querySelector('[data-md-block="0"]') as HTMLElement
    vi.spyOn(block, 'getBoundingClientRect').mockImplementation(() => rect(100 - scrolled, 160 - scrolled))

    fireEvent.mouseOver(block)
    const frame = (): HTMLElement | null => document.querySelector('[data-diff-block-actions]')
    await waitFor(() => { expect(frame()?.style.top).toBe('158px') })

    // The pane scrolls: the block moves up under the pointer and the frame follows
    // it in the same event — imperatively, with no re-render (re-rendering the
    // markdown per scroll event is what made tracking feel laggy).
    const markdownRenders = vi.mocked(renderMarkdownPreview).mock.calls.length
    body.scrollTop = 40
    fireEvent.scroll(body)
    expect(frame()?.style.top).toBe('118px')
    expect(vi.mocked(renderMarkdownPreview).mock.calls.length).toBe(markdownRenders)

    // A block whose bottom edge sits past the pane's bottom keeps its frame inside,
    // pinned to the pane's bottom edge — the code view's clamp (300 − 40).
    vi.spyOn(block, 'getBoundingClientRect').mockImplementation(() => rect(360, 420))
    fireEvent.mouseOver(document.querySelector('.mdBlock:not([data-md-block])') as HTMLElement)
    expect(frame()).toBeNull()
    fireEvent.mouseOver(block)
    await waitFor(() => { expect(frame()?.style.top).toBe('260px') })
  })

  it('jumps between preview blocks from the toolbar, the chord and the file list', () => {
    // Two change blocks separated by context, so block indices are meaningful.
    const file = entry({
      id: 'entry-md-jump',
      path: '/repo/README.md',
      oldText: '# T\nold one\nsame\nold two\n',
      newText: '# T\nnew one\nsame\nnew two\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // Opening the first row selects it AND, because the panel had it selected
    // already, counts as a re-click: the focus starts on the second block.
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    // jsdom has no layout: give the preview pane a real scroll range and the two
    // blocks their content offsets, so the jump's scroll write is observable. The
    // block rects move with the scroll (a fixed rect would drift by `scrollTop` on
    // every later jump, exactly as it would in a browser).
    let scrolled = 0
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 })
    const rect = (top: number, bottom: number, left = 0, right = 400): DOMRect =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 300))
    // Every element of a block, not just the first: a change renders its deleted
    // and added runs as separate elements (two columns in double mode), and the
    // flash outlines the group's whole extent.
    for (const [index, top] of [[0, 200], [1, 600]] as const) {
      for (const element of document.querySelectorAll(`[data-md-block="${index}"]`)) {
        vi.spyOn(element as HTMLElement, 'getBoundingClientRect')
          // The tinted block is narrower than the pane: that width is what the
          // outline has to enclose.
          .mockImplementation(() => rect(top - scrolled, top + 60 - scrolled, 24, 376))
      }
    }
    const flash = (): HTMLElement | null => document.querySelector('[data-diff-block-flash]')
    // The flash box is in the pane's coordinates: `top` follows the scroll, the
    // height covers the block's rendered extent clamped into the pane, and the
    // insets are the tinted block's own edges (so the outline encloses the whole
    // background-diff area, not just the text).
    const box = (): { top: number; height: number; left: number; right: number } => ({
      top: Number.parseFloat(flash()!.style.top),
      height: Number.parseFloat(flash()!.style.height),
      left: Number.parseFloat(flash()!.style.left),
      right: Number.parseFloat(flash()!.style.right),
    })

    // The toolbar's prev brings the first block into view: its top edge lands two
    // code rows below the pane's top (the code view's lead), and the landed block
    // gets the code view's own flash outline — the preview has no focus rows, so
    // that outline is the "you are here".
    fireEvent.click(document.querySelector('[data-diff-prev]') as HTMLElement)
    expect(scrolled).toBe(200 - 2 * 22)
    expect(box()).toEqual({ top: 44, height: 60, left: 24, right: 24 })

    // The toolbar's next walks forward the same way (block 1 spans content
    // 600-660, so it lands at the same place in the pane).
    fireEvent.click(document.querySelector('[data-diff-next]') as HTMLElement)
    expect(scrolled).toBe(600 - 2 * 22)
    expect(box()).toEqual({ top: 44, height: 60, left: 24, right: 24 })

    // The chord is the same jump.
    fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true })
    expect(scrolled).toBe(200 - 2 * 22)
    expect(box()).toEqual({ top: 44, height: 60, left: 24, right: 24 })

    // Re-clicking the open file in the list is the same gesture: its jump signal
    // used to move nothing at all while the preview was showing.
    fireEvent.click(screen.getByText('README.md'))
    expect(scrolled).toBe(600 - 2 * 22)
    expect(box()).toEqual({ top: 44, height: 60, left: 24, right: 24 })

    // The outline is a transient cue, not a marker that waits for the pointer:
    // hovering context in the preview must not take it away (that is what the
    // hover frame does, which is why a jump does not use one).
    fireEvent.mouseOver(document.querySelector('.mdBlock:not([data-md-block])') as HTMLElement)
    expect(flash()).not.toBeNull()
  })

  it('jumps and flashes in the double-column preview too', () => {
    // The double-column preview is this component's own rendering, NOT the split
    // view — but the jump used to be routed to the split view whenever
    // `splitView` was on, so in this mode prev/next (and with them the flash) did
    // nothing at all.
    const file = entry({
      id: 'entry-md-jump-double',
      path: '/repo/README.md',
      oldText: '# T\nkeep one\nkeep two\nkeep three\nkeep four\nkeep five\n',
      newText: '# T edited\nkeep one\nkeep two\nkeep four\nkeep five\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-toggle-view]') as HTMLElement)
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    expect(body.dataset.diffMdMode).toBe('double')
    // Both changes render on both sides, one element per column.
    expect(document.querySelectorAll('[data-md-block="0"]').length).toBe(2)
    expect(document.querySelectorAll('[data-md-block="1"]').length).toBe(2)
    expect(document.querySelector('[data-diff-split]')).toBeNull()

    let scrolled = 0
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 })
    const rect = (top: number, bottom: number, left: number, right: number): DOMRect =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 300, 0, 800))
    // Each aligned row spans both columns (40..760) while its tinted cells are the
    // two inner columns.
    const columns = [[40, 380], [420, 760]] as const
    for (const [index, contentTop] of [[0, 200], [1, 400]] as const) {
      const elements = [...document.querySelectorAll(`[data-md-block="${index}"]`)] as HTMLElement[]
      const row = elements[0]!.closest('.mdDoubleRow') as HTMLElement
      expect(row).not.toBeNull()
      vi.spyOn(row, 'getBoundingClientRect')
        .mockImplementation(() => rect(contentTop - scrolled, contentTop + 60 - scrolled, 40, 760))
      for (const element of elements) {
        const cell = element.closest('.mdDoubleCol') as HTMLElement
        const column = [...cell.parentElement!.children].indexOf(cell)
        const [left, right] = column === 0 ? columns[0]! : columns[1]!
        vi.spyOn(element, 'getBoundingClientRect')
          .mockImplementation(() => rect(contentTop - scrolled, contentTop + 60 - scrolled, left, right))
      }
    }
    const flashBox = (): { top: number; height: number; left: number; right: number } => {
      const flash = document.querySelector('[data-diff-block-flash]') as HTMLElement
      return {
        top: Number.parseFloat(flash.style.top),
        height: Number.parseFloat(flash.style.height),
        left: Number.parseFloat(flash.style.left),
        right: Number.parseFloat(flash.style.right),
      }
    }

    // Opening the row was a re-click (the panel had it selected), so the focus
    // starts on the second block: step back to the first one.
    fireEvent.click(document.querySelector('[data-diff-prev]') as HTMLElement)
    expect(scrolled).toBe(200 - 2 * 22)
    expect(flashBox()).toEqual({ top: 44, height: 60, left: 40, right: 40 })

    // Forward again, through the chord this time.
    fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })
    expect(scrolled).toBe(400 - 2 * 22)
    expect(flashBox()).toEqual({ top: 44, height: 60, left: 40, right: 40 })

    // Search works here too, and its chords are this bar's: the split view (which
    // owns its own bar and chords in the code view) is not mounted under the
    // preview, so the guarded routes must fall through to the preview's bar.
    fireEvent.click(screen.getByLabelText('action.search'))
    const input = document.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'keep two' } })
    const hits = [...document.querySelectorAll('[data-diff-search-match]')] as HTMLElement[]
    expect(hits.length).toBe(2)
    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('1/2')
    fireEvent.keyDown(input, { key: 'F3' })
    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('2/2')
    expect(hits[1]!.getAttribute('data-diff-search-match')).toBe('current')
    fireEvent.keyDown(input, { key: 'c', altKey: true })
    expect(document.querySelector('[data-diff-search-case]')!.getAttribute('data-on')).toBe('')
  })

  it('outlines the full row when a double-column change sits on one side only', () => {
    // A pure addition: the after column has the tinted cell, the before column is
    // empty, and the outline still spans the aligned row rather than half of it.
    const file = entry({
      id: 'entry-md-flash-onesided',
      path: '/repo/README.md',
      oldText: '# T\nkeep one\n',
      newText: '# T\nkeep one\nadded line\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-toggle-view]') as HTMLElement)
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    expect(body.dataset.diffMdMode).toBe('double')
    const elements = [...document.querySelectorAll('[data-md-block="0"]')] as HTMLElement[]
    expect(elements.length).toBe(1)
    // That one cell is the after column, so a tint-only box would be the right half.
    const cell = elements[0]!.closest('.mdDoubleCol') as HTMLElement
    expect([...cell.parentElement!.children].indexOf(cell)).toBe(2)

    let scrolled = 0
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 })
    const rect = (top: number, bottom: number, left: number, right: number): DOMRect =>
      ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 300, 0, 800))
    vi.spyOn(elements[0]!.closest('.mdDoubleRow') as HTMLElement, 'getBoundingClientRect')
      .mockImplementation(() => rect(200 - scrolled, 260 - scrolled, 40, 760))
    vi.spyOn(elements[0]!, 'getBoundingClientRect')
      .mockImplementation(() => rect(200 - scrolled, 260 - scrolled, 420, 760))

    // The frame's own step button is a jump like any other: it flashes the block it
    // lands on (here the only one, so it wraps onto itself).
    fireEvent.mouseOver(elements[0]!)
    fireEvent.click(document.querySelector('[data-diff-block-next]') as HTMLElement)
    const flash = document.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(flash).not.toBeNull()
    expect({
      top: Number.parseFloat(flash.style.top),
      height: Number.parseFloat(flash.style.height),
      left: Number.parseFloat(flash.style.left),
      right: Number.parseFloat(flash.style.right),
    }).toEqual({ top: 44, height: 60, left: 40, right: 40 })
  })

  it('highlights and steps search matches in the rendered preview', () => {
    const file = entry({
      id: 'entry-md-search',
      path: '/repo/README.md',
      oldText: '# T\nalpha one\nshared tail\n',
      newText: '# T\nbeta one\nshared tail\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)

    // The preview mounts the search bar itself now (it used to be mounted nowhere,
    // so the toolbar's button did nothing visible in this view).
    fireEvent.click(screen.getByLabelText('action.search'))
    expect(document.querySelector('[data-diff-searchbar]')).not.toBeNull()

    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, {
      target: { value: 'one' },
    })
    const hits = (): HTMLElement[] => [...document.querySelectorAll('[data-diff-search-match]')] as HTMLElement[]
    // Both sides of the change are rendered, so the query is found twice — and the
    // count is the preview's own, since rendered Markdown has no rows to count.
    expect(hits().length).toBe(2)
    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('1/2')
    expect(hits()[0]!.getAttribute('data-diff-search-match')).toBe('current')
    expect(hits()[1]!.getAttribute('data-diff-search-match')).toBe('hit')

    // Stepping moves the current occurrence without re-wrapping the query.
    fireEvent.click(document.querySelector('[data-diff-search-next]') as HTMLElement)
    expect(document.querySelector('[data-diff-search-count]')!.textContent).toBe('2/2')
    expect(hits()[1]!.getAttribute('data-diff-search-match')).toBe('current')
    expect(hits()[0]!.getAttribute('data-diff-search-match')).toBe('hit')

    // Escape closes the preview's bar and leaves the panel standing, exactly as it
    // does in the code view.
    fireEvent.keyDown(document.querySelector('[data-diff-md-preview-body]') as HTMLElement, { key: 'Escape' })
    expect(document.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    // Closing clears the query, so its marks go with it.
    expect(hits().length).toBe(0)
  })

  it('scrolls the preview to a search match that is out of view', () => {
    const file = entry({
      id: 'entry-md-search-scroll',
      path: '/repo/README.md',
      oldText: '# T\nalpha one\nshared tail\n',
      newText: '# T\nbeta one\nshared tail\n',
    })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('README.md'))
    fireEvent.click(document.querySelector('[data-diff-md-preview]') as HTMLElement)
    fireEvent.click(screen.getByLabelText('action.search'))
    fireEvent.change(document.querySelector('[data-diff-search-input]') as HTMLInputElement, {
      target: { value: 'one' },
    })
    const hits = [...document.querySelectorAll('[data-diff-search-match]')] as HTMLElement[]
    expect(hits.length).toBe(2)

    // jsdom has no layout: give the pane a scroll range and put both matches below
    // its viewport, so the step has something real to move.
    let scrolled = 0
    const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (value: number) => { scrolled = value },
    })
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 1000 })
    const rect = (top: number, bottom: number): DOMRect =>
      ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => rect(0, 100))
    hits.forEach((hit, index) => {
      vi.spyOn(hit, 'getBoundingClientRect').mockImplementation(() => rect(300 + index * 40, 320 + index * 40))
    })

    // The second match sits below the fold: it lands at the pane's bottom edge,
    // which is the code view's rule for a match under the viewport. (A match
    // already inside the viewport is left where it is, as there too.)
    fireEvent.click(document.querySelector('[data-diff-search-next]') as HTMLElement)
    expect(scrolled).toBe(360 - 100)
  })

  it('restores the remembered coverage from the footer entry', () => {
    // The retired fullscreen state — everything covered — restores as the floating
    // panel with every switch on, and the popover writes them back.
    localStorage.setItem('diff-approval:presentation', 'fullscreen')
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(document.querySelector('[data-diff-cover-backdrop]')).not.toBeNull()
    expect(panel.style.bottom).toBe('8px')

    // Turning the composer switch off is the old floating panel, and it sticks.
    fireEvent.click(document.querySelector('[data-diff-approval-cover]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-diff-approval-cover-switch="composer"]') as HTMLElement)
    expect(document.querySelector('[data-diff-cover-backdrop]')).toBeNull()
    expect(panel.style.bottom).toBe('128px')
    expect(JSON.parse(localStorage.getItem('diff-approval:float-cover') ?? '{}')).toEqual({ top: true, left: true, right: true, composer: false })
  })

  it('hands the footer entry to the dock when that is the remembered presentation', () => {
    localStorage.setItem('diff-approval:presentation', 'dock')
    const onOpenDock = vi.fn()
    const props = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock,
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
    }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(onOpenDock).toHaveBeenCalledTimes(1)
    // The panel lives in the sidebar's tab there: nothing floats in the overlay.
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('opens the overlay when the remembered dock cannot take the panel at all', () => {
    // The reported failure: "dock" is remembered from a page where the sidebar
    // existed, and a page load that never found the sidebar's services used to
    // swallow every open — the footer badge, the header entry, the chord and the
    // produced-file chips all did nothing, and the switch back to floating lives
    // *inside* the panel, so only a reload could reach the review again.
    localStorage.setItem('diff-approval:presentation', 'dock')
    // The real dock face is `sidebar?.openTab(...)`: with no sidebar attached it
    // accepts the call and does nothing — it does not throw.
    const onOpenDock = vi.fn()
    const props = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock,
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: false, open: false }),
    }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    expect(screen.getByText('panel.title')).toBeDefined()
    // Nothing was asked of a sidebar that cannot answer, and the remembered
    // presentation is left alone: the next open with a working sidebar docks.
    expect(onOpenDock).not.toHaveBeenCalled()
    expect(localStorage.getItem('diff-approval:presentation')).toBe('dock')
  })

  it('opens the overlay when an available dock never actually comes up', () => {
    // A sidebar that accepts the ask and never brings the tab up (a tab type that
    // never registered, a controller gone stale) must not swallow the click
    // either: after the grace the overlay steps in.
    vi.useFakeTimers()
    try {
      localStorage.setItem('diff-approval:presentation', 'dock')
      const onOpenDock = vi.fn()
      const props = {
        ...panelProps({ read: true, files: [FILE], busy: new Set() }),
        onOpenDock,
        useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
      }
      render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      // Asked, and nothing yet: the tab body mounts a frame or two later.
      expect(onOpenDock).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
      act(() => { vi.advanceTimersByTime(500) })
      // It never came up, so the review opens as the overlay.
      expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the overlay on the first click when a docked tab hands the panel back', () => {
    // The chip's "floating" row: the presentation is stored as float, the tab is
    // closed, and the overlay is asked to open — all in one tick, while the dock
    // still reports "showing" until that tab's body unmounts. The one-place rule
    // must not read that overlap as "the dock has it" and shut the overlay again,
    // which made the switch need a second click.
    localStorage.setItem('diff-approval:presentation', 'float')
    let dockState: { available: boolean; open: boolean } = { available: true, open: true }
    const props = () => ({
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock: vi.fn(),
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select(dockState),
    })
    const view = render(<PendingPanel {...props()} />)
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()

    act(() => { window.dispatchEvent(new CustomEvent(SHOW_PANEL_EVENT)) })
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    // …and it stays open as the dock reports itself gone.
    dockState = { available: true, open: false }
    view.rerender(<PendingPanel {...props()} />)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('steps the overlay aside once the docked tab is really showing', () => {
    // One panel, one place: a hand-off that lands late (or the fallback above)
    // must not leave a second copy of the review on screen.
    let dockState: { available: boolean; open: boolean } = { available: true, open: false }
    const props = () => ({
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock: vi.fn(),
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select(dockState),
    })
    const view = render(<PendingPanel {...props()} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()

    dockState = { available: true, open: true }
    view.rerender(<PendingPanel {...props()} />)
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('falls back to the floating panel for a remembered dock in a build without one', () => {
    localStorage.setItem('diff-approval:presentation', 'dock')
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('renders docked as the sidebar tab body with no header of its own', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} docked dockHost={host} />)

    // The content is inside the host the tab body owns, marked docked, with no
    // composer anchoring (the tab owns the size) and no footer badge.
    const panel = host.querySelector('[data-diff-approval-panel]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.dataset.diffDocked).toBe('')
    expect(panel.style.bottom).toBe('')
    expect(document.querySelector('[data-diff-approval-badge]')).toBeNull()
    // The tab above it IS the frame: its chip carries the title, the count, the
    // mode switch, and the kit's own close button, so a header here would only
    // repeat them and cost the list its height. None of its controls exist.
    expect(panel.querySelector('[data-diff-approval-presentation]')).toBeNull()
    expect(panel.querySelector('[data-diff-approval-close]')).toBeNull()
    expect(panel.querySelector('[data-diff-approval-settings]')).toBeNull()
    expect(panel.textContent).not.toContain('panel.title')
    // The tab body holds the panel and nothing else. The footer seat's own layer
    // (42px plus margins) used to be rendered here too, which pushed the tab
    // content past its own height: the sidebar body then scrolled, showing a
    // blank strip under the panel.
    expect(host.querySelector('[data-diff-approval-layer]')).toBeNull()
    expect(panel.parentElement).toBe(host)
  })

  it('remembers the dock when the panel renders as the tab body', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} docked dockHost={host} />)
    // Being the tab's body is the dock presentation: the footer entry will bring
    // the panel back here instead of floating it.
    expect(localStorage.getItem('diff-approval:presentation')).toBe('dock')
  })

  it('reports the tab body\'s own visibility to the dock state', () => {
    const onDockShowing = vi.fn()
    const close = vi.fn()
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    // The controller publishes no observable, so "docked and in view" can only
    // come from the body the tab framework draws.
    const bodyProps = {
      ...props,
      useTabInfo: () => ({ tab: { visible: true, actions: { close } } }),
      onDockShowing,
    } as unknown as Parameters<typeof DiffDockBody>[0]
    const view = render(<DiffDockBody {...bodyProps} />)
    expect(onDockShowing).toHaveBeenCalledWith(true)
    view.unmount()
    expect(onDockShowing).toHaveBeenLastCalledWith(false)
  })

  it('says so when the sidebar is mounted but cannot take the panel yet', () => {
    // The controller throws when no seat is bound to a session: a handoff that
    // fails must not look like a click that did nothing.
    const onOpenDock = vi.fn(() => { throw new Error('no seat bound') }) as unknown as () => void
    const props = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock,
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
    }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-approval-presentation]') as HTMLElement)
    fireEvent.click(screen.getByText('action.presentationDock'))
    expect(screen.getByText(/panel\.dockFailed/)).not.toBeNull()
    // Nothing docked, so nothing is remembered as docked either.
    expect(localStorage.getItem('diff-approval:presentation')).not.toBe('dock')
  })

  it('falls back to the overlay when the remembered dock cannot open', () => {
    localStorage.setItem('diff-approval:presentation', 'dock')
    const onOpenDock = vi.fn(() => { throw new Error('no seat bound') }) as unknown as () => void
    const props = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock,
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
    }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(onOpenDock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('offers the dock choice in the presentation menu only with a sidebar', () => {
    // The menu names the three states and checks the current one; "dock" is only
    // offered where there is a right sidebar to dock into.
    const withDock = {
      ...panelProps({ read: true, files: [FILE], busy: new Set() }),
      onOpenDock: vi.fn(),
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
    }
    const first = render(<PendingPanel {...withDock} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(document.querySelector('[data-diff-approval-presentation]') as HTMLElement)
    fireEvent.click(screen.getByText('action.presentationDock'))
    // The overlay steps aside for the tab, and the choice is remembered.
    expect(withDock.onOpenDock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('diff-approval:presentation')).toBe('dock')
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    first.unmount()

  })

  it('still lists the dock choice without a sidebar, and says why it cannot', () => {
    const withoutDock = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...withoutDock} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-diff-approval-presentation]') as HTMLElement)
    // A missing feature is worth a sentence, not a vanishing menu row.
    const item = (label: string): HTMLElement => (screen.getAllByText(label)
      .find(candidate => candidate.closest('[data-diff-approval-panel]') === null)
      ?? screen.getAllByText(label).at(-1)!) as HTMLElement
    expect(item('action.presentationFloat')).toBeDefined()
    fireEvent.click(item('action.presentationDock'))
    expect(screen.getByText('panel.dockUnavailable')).toBeDefined()
    // Still floating: nothing moved.
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('names the two presentations, and keeps the current one checked', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(document.querySelector('[data-diff-approval-presentation]') as HTMLElement)
    // Two rows, no third state: "fullscreen" is a coverage combination now, not a
    // presentation of its own.
    const rows = [...document.querySelectorAll('[role="menuitem"]')]
    expect(rows).toHaveLength(2)
    expect(screen.getByText('action.presentationFloat')).not.toBeNull()
    expect(screen.getByText('action.presentationDock')).not.toBeNull()
    expect(screen.queryByText('action.presentationFullscreen')).toBeNull()
    // The floating row is the checked one: the kit's menu draws the check as a
    // second glyph in the row, beside the row's own icon.
    expect(rows[0]!.querySelectorAll('svg')).toHaveLength(2)
    expect(rows[1]!.querySelectorAll('svg')).toHaveLength(1)
    fireEvent.click(screen.getByText('action.presentationDock'))
    expect(screen.getByText('panel.dockUnavailable')).toBeDefined()
  })

  it('shows the presentation as an icon, and leads every menu row with its own mark', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const trigger = document.querySelector('[data-diff-approval-presentation]') as HTMLElement
    // The state's mark plus the menu chevron — and still no words: the name
    // travels in the tooltip and the accessible label instead of the button.
    expect(trigger.textContent).toBe('')
    expect(trigger.querySelectorAll('svg')).toHaveLength(2)
    expect(trigger.getAttribute('aria-label')).toContain('action.presentationCurrent')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')

    fireEvent.click(trigger)
    const rows = [...document.querySelectorAll('[role="menuitem"]')]
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.querySelector('svg')).not.toBeNull()
    // The dock row mirrors the app's own right-sidebar mark.
    const dockMark = rows[1]!.querySelector('svg')
    expect(dockMark?.getAttribute('class')).toContain('mirrored')
  })

  it('is driven by the Session header entry, the second mount of the same action', () => {
    // Both entries mounted, as in the app: the footer's (which owns the overlay's
    // open state) and the header's. One action, so a press on either opens and
    // closes the same panel, and the header button follows along.
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    const entry = (): HTMLButtonElement => document.querySelector('[data-diff-approval-header-entry]') as HTMLButtonElement
    render(<DiffApprovalHeaderEntry {...({
      t: (key: string) => key,
      usePending: (select: (snapshot: PendingDiffSnapshot) => unknown) => select({ files: [FILE] } as unknown as PendingDiffSnapshot),
      useDock: (select: (state: { available: boolean; open: boolean }) => unknown) => select({ available: true, open: false }),
    } as unknown as ComponentProps<typeof DiffApprovalHeaderEntry>)} />)
    const panel = (): Element | null => document.querySelector('[data-diff-approval-panel]')

    expect(entry().dataset.diffApprovalHeaderEntry).toBe('1')
    expect(panel()).toBeNull()

    // One press opens; the entry learns it through the state event.
    fireEvent.click(entry())
    expect(panel()).not.toBeNull()
    expect(entry().hasAttribute('data-active')).toBe(true)

    // The next closes, exactly as the footer badge would.
    fireEvent.click(entry())
    expect(panel()).toBeNull()
    expect(entry().hasAttribute('data-active')).toBe(false)
  })

  it('shows the overlay when the docked tab hands the panel back', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    // Coverage is seeded when the panel mounts (the floating instance owns it), so
    // an all-on cover has to be there before the footer entry renders.
    localStorage.setItem('diff-approval:presentation', 'float')
    localStorage.setItem('diff-approval:float-cover', '{"left":true,"right":true,"composer":true}')
    // Both instances mounted, as in the app: the footer's (closed) and the docked
    // tab's. Leaving the dock is the chip's move, and it reaches the footer
    // instance — a separate mount — as an event.
    const footer = render(<PendingPanel {...props} />)
    render(<PendingPanel {...props} docked dockHost={host} />)
    expect(document.querySelector('[data-diff-approval-panel]:not([data-diff-docked])')).toBeNull()

    act(() => { window.dispatchEvent(new CustomEvent(SHOW_PANEL_EVENT)) })
    expect(document.querySelector('[data-diff-approval-panel]:not([data-diff-docked])')).not.toBeNull()
    expect(document.querySelector('[data-diff-cover-backdrop]')).not.toBeNull()
    footer.unmount()
  })

  it('keeps a docked panel standing through an outside press and Escape', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} docked dockHost={host} />)
    const panel = (): Element | null => host.querySelector('[data-diff-approval-panel]')
    expect(panel()).not.toBeNull()
    // A tab is not a popover: a press on the app outside it — the editor, the
    // chat, or the sidebar's own blank space — and Esc both leave it standing.
    // Taking it out of the dock belongs to the tab chrome (its chip's mode
    // switch, and the kit's own close button).
    fireEvent.pointerDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(panel()).not.toBeNull()
  })

  it('asks the canvas once per distinct character, not once per character drawn', () => {
    // The wrap walks a line character by character and sums the advances, so a file asks the
    // canvas for the same handful of widths tens of thousands of times — and with wrap on, that
    // pass runs again on every frame of a resize drag. A character's advance is a property of the
    // font, so the measurer answers from its own table after the first ask.
    const asked: string[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (text: string) => {
        asked.push(text)
        return { width: text.length * 7 }
      },
    } as never)
    const measure = makeMeasurer('13px monospace')
    expect(measure).toBeDefined()
    const lines = ['const a = 1', 'const b = 2', 'const c = 3']
    for (const line of lines) for (const character of line) measure?.(character)
    const distinct = new Set(lines.join('')).size
    expect(asked.length).toBe(distinct)
    expect(asked.length).toBeLessThan(lines.join('').length)
    // Anything longer than one character goes straight through: the wrap's asks are the ones worth
    // keeping, and caching whole lines would hold the file in memory.
    measure?.('const')
    expect(asked.at(-1)).toBe('const')
  })

  it('keeps two measurers measuring in their own fonts', async () => {
    // Every measurer shares the panel's one canvas, and its font is the canvas's own state — so a
    // measurer that set its font once, when it was created, left whichever measurer came next
    // asking in the wrong face. Two are alive at the same time in a thread: its prose, and the
    // inline-code chips, drawn in the code face at a share of the prose size. The wrapped row count
    // came out a line off in whichever direction the wrong face is wider — a gap under the turns, or
    // a clipped writing row.
    //
    // The canvas is made once and kept for the panel's lifetime, so this asks for a fresh copy of
    // the module: another test has already filled its cache with a canvas of its own.
    const context = {
      font: '10px sans-serif',
      measureText: (text: string) => ({ width: text.length * Number.parseFloat(context.font) }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.resetModules()
    const { makeMeasurer: fresh } = await import('../src/client/PendingPanel.tsx')
    const prose = fresh('12px prose')
    const chip = fresh('9px chip')
    expect(prose?.('abc')).toBe(36)
    expect(chip?.('abc')).toBe(27)
    // …and back again: the prose measurer is still the prose measurer.
    expect(prose?.('abc')).toBe(36)
    // The per-character cache is the measurer's own, so an ask the other one warmed is still that
    // measurer's own width.
    expect(prose?.('a')).toBe(12)
    expect(chip?.('a')).toBe(9)
    expect(prose?.('a')).toBe(12)
  })

  it('wraps a turn with its inline-code chips as boxes, not as text', () => {
    // A turn's chip is an inline-flex box (the chat's own inline code — see `.discussionCode`), so
    // the browser never puts half of one at the end of a line: the box moves over whole and the
    // text after it starts after the box. A character walk measures the chip's text as ordinary
    // text and reserves the wrong number of rows on exactly the lines that carry one — and a row
    // too few is a clipped last line, which is why this walks chips itself.
    const width = (text: string): number => text.length * 10
    const chip = (text: string): number => width(text) + 12 // 2 × (5px padding + the 1px hairline)
    // Ten characters are exactly the room, so the prose alone is one row — but the chip's box is
    // 21px and does not fit in what is left of that row, and an inline-flex box moves over whole.
    expect(wrapChipRows('12345678 `a`', 100, width, chip, 80)).toBe(2)
    // The chip's own text is not the measure: the same characters with the markers off are one row.
    expect(wrapChipRows('12345678 a', 100, width, chip, 80)).toBe(1)
    // A chip that does fit where the line has got to stays there — box, padding and hairline and
    // all — and the prose after it follows it on the same row.
    expect(wrapChipRows('12 `ab` 34', 100, width, chip, 80)).toBe(1)
    // The prose after a chip that moved over wraps in the room the box left, which is a row of its
    // own once the box and its tail no longer fit together.
    expect(wrapChipRows('12345678 `abcd` 9999', 100, width, chip, 80)).toBe(3)
  })

  it('measures a turn from the text it draws, markers and all', () => {
    // A chip's box is only visible to the row model if the model is handed the text WITH its
    // markers: `discussionRuns` is what finds a chip, and text with the markers stripped has none
    // left to find. Handing it the stripped text — which is what the panel used to do — measured
    // every chip as ordinary prose: no padding, no hairline, the prose face instead of the code
    // one, and nothing to say it cannot be broken across two lines. A line ending in a chip then
    // reserved a row less than it drew, which pushed the writing row out of the bottom of the
    // block — and the block clips what it did not reserve.
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'PendingPanel.tsx'), 'utf8')
    expect(source).toContain('messageRowsOf(discussionText(message), message.role)')
    expect(source).not.toContain('discussionPlainText')
  })

  // PERF-SWEEP-START A measurement harness, not an assertion: it prints what the panel's hot paths
  // cost and is skipped unless asked for — `PERF=1 pnpm exec vitest run
  // tests/pending-panel.client.spec.tsx -t "PERF sweep"`. jsdom has no layout, so the browser-only
  // half of the cost (layout and paint) is not in these numbers: read them as the JS work, and
  // compare them with each other rather than against a frame budget.
  it.skipIf(process.env.PERF !== '1')('PERF sweep', async () => {
    const ms = (label: string, runs: number, fn: () => void): void => {
      fn()
      const t0 = performance.now()
      for (let i = 0; i < runs; i++) fn()
      console.log(`PERF ${label}: ${((performance.now() - t0) / runs).toFixed(2)}ms/run x${runs}`)
    }
    const whole = await import('../src/client/whole-file-diff.ts')
    const highlight = await import('../src/client/highlight.ts')
    const discussion = await import('../src/client/discussion.ts')
    const panel = await import('../src/client/PendingPanel.tsx')

    const build = (every: number): [string, string] => {
      const oldLines: string[] = []
      const newLines: string[] = []
      for (let i = 0; i < 2000; i++) {
        const line = `const value${i} = compute(${i}, 'a longer argument here')`
        oldLines.push(line)
        newLines.push(i % every === 0 ? `const changed${i} = compute(${i}, 'a longer argument here')` : line)
      }
      return [`${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`]
    }
    const [old5, new5] = build(20)
    const [oldAll, newAll] = build(1)
    const diff = whole.computeWholeFileDiff(old5, new5)
    ms('computeWholeFileDiff 2000 lines, 5% changed', 5, () => { whole.computeWholeFileDiff(old5, new5) })
    ms('computeWholeFileDiff 2000 lines, all changed', 5, () => { whole.computeWholeFileDiff(oldAll, newAll) })
    ms('changeBlocksOf', 20, () => { whole.changeBlocksOf(diff) })
    ms('computeIntraLineDiff (split view)', 5, () => { whole.computeIntraLineDiff(diff.rows, true) })
    const newLines = new5.split('\n')
    ms('highlightWindow 200 lines', 5, () => { highlight.highlightWindow(newLines, 'typescript', 0, 200) })
    const measure = (text: string): number => text.length * 7.2
    ms('wrapInto x2000 rows (the wrap model)', 5, () => {
      for (const line of newLines) panel.wrapInto(line, 800, measure, 4 * measure(' '))
    })
    const model = {
      lineOf: (row: number) => diff.rows[row]?.newLine ?? diff.rows[row]?.oldLine,
      textOf: (row: number) => diff.rows[row]?.text ?? '',
      rowCount: diff.rows.length,
    }
    const threads = Array.from({ length: 50 }, (_, i) => ({
      id: `d${i}`,
      anchor: { start: i * 10, end: i * 10 + 3, startLine: 100 + i, endLine: 103 + i },
      quote: 'a quote that is nowhere in this model\nnor this one',
      messages: [], draft: '', collapsed: false,
    }))
    ms('remapDiscussion x50, quote not found (per block)', 10, () => {
      for (const thread of threads) discussion.remapDiscussion(thread as never, model.lineOf, model.textOf, model.rowCount)
    })
    ms('remapDiscussions x50, quote not found (one pass)', 10, () => {
      discussion.remapDiscussions(threads as never, model.lineOf, model.textOf, model.rowCount)
    })
    ms('discussionRuns + plainText x200 turns', 5, () => {
      for (let i = 0; i < 200; i++) {
        discussion.discussionPlainText(`turn ${i} with \`code\` and **bold** and more words to walk`)
      }
    })
    const messages = Array.from({ length: 200 }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', text: `turn ${i}` }))
    ms('discussionRounds over 200 turns', 20, () => { discussion.discussionRounds(messages, 2, () => 1) })

    // The panel itself: mount with a 2000-line file, scroll it, and type in a comment.
    const big = entry({ id: 'entry-perf', path: '/repo/perf.txt', oldText: old5, newText: new5 })
    const restore = stubCodeScroll()
    try {
      const props = panelProps({ read: true, files: [big], busy: new Set() })
      let t0 = performance.now()
      const view = render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))
      fireEvent.click(screen.getByText('perf.txt'))
      console.log(`PERF open a 2000-line file (mount + first render): ${(performance.now() - t0).toFixed(1)}ms`)

      const body = codeBody()
      t0 = performance.now()
      for (let i = 1; i <= 20; i++) {
        body.scrollTop = i * 100
        fireEvent.scroll(body)
      }
      console.log(`PERF 20 scroll re-renders: ${((performance.now() - t0) / 20).toFixed(2)}ms/scroll`)

      // A comment on the first rows, then typing in it: every keystroke re-renders and
      // re-measures the thread against the whole 2000-row height table.
      const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
      const node = rows[1]!.querySelector('[data-diff-code]')?.firstChild ?? rows[1]!
      vi.spyOn(window, 'getSelection').mockReturnValue({
        isCollapsed: false,
        anchorNode: node,
        focusNode: node,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: 1 }),
        removeAllRanges: () => {},
      } as unknown as Selection)
      act(() => { document.dispatchEvent(new Event('selectionchange')) })
      t0 = performance.now()
      fireEvent.click(document.querySelector('[data-diff-selection-comment]') as HTMLButtonElement)
      console.log(`PERF create a comment block: ${(performance.now() - t0).toFixed(1)}ms`)
      const input = document.querySelector('[data-diff-discussion-input]') as HTMLInputElement
      t0 = performance.now()
      for (let i = 1; i <= 10; i++) fireEvent.change(input, { target: { value: 'x'.repeat(i * 4) } })
      console.log(`PERF 10 keystrokes in the comment box: ${((performance.now() - t0) / 10).toFixed(2)}ms/keystroke`)
      t0 = performance.now()
      fireEvent.keyDown(input, { key: 'Enter' })
      console.log(`PERF send a comment: ${(performance.now() - t0).toFixed(1)}ms`)

      // The windowed highlight, from the panel's side: a jump into the middle of the file.
      t0 = performance.now()
      body.scrollTop = 40 * 22
      fireEvent.scroll(body)
      await vi.waitFor(() => { expect(document.querySelector('[data-diff-code]')).not.toBeNull() })
      console.log(`PERF scroll into a fresh window (highlight included): ${(performance.now() - t0).toFixed(1)}ms`)
      view.unmount()
    } finally {
      restore()
    }
  })
  // PERF-SWEEP-END

})
