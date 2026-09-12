// @vitest-environment jsdom
// PendingPanel: badge, per-path grouping, per-operation rows, actions, jump
// navigation, live-state warnings, and the line-selection copy toolbar.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import { PendingPanel, frameInsets } from '../src/client/PendingPanel.tsx'
import { DiffDockBody, SHOW_PANEL_EVENT } from '../src/client/dock.tsx'
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
// A test that plants the harness composer's input box owns it for its own test
// only: the panel focuses the first one it finds, so a leftover would silently
// redirect the next test's caret assertion.
afterEach(() => { for (const stale of document.querySelectorAll('[data-composer-input]')) stale.remove() })

beforeAll(() => {
  // jsdom has no scrolling; the jump effect centers rows through it.
  Element.prototype.scrollIntoView = () => {}
})

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
    expect(screen.getByText('panel.group.current')).toBeDefined()
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
    expect(screen.getByText('panel.group.current')).toBeDefined()
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

  it('always shows the short file name with the full path on hover, even when basenames collide', () => {
    const sibling = entry({ id: 'entry-dup', path: '/repo/sub/a.txt' })
    const props = panelProps({ read: true, files: [FILE, sibling], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Both rows show only the basename; the full path lives in a hover
    // tooltip and in the auto-selected detail's header.
    expect(screen.getAllByText('a.txt')).toHaveLength(2)
    expect(screen.getAllByText(FILE.path).length).toBeGreaterThan(0)
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

    // Populated list: it rides the "current session" heading.
    const populated = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...populated} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const head = document.querySelector('[data-diff-add]')!.closest('div')!
    expect(head.textContent).toContain('panel.group.current')
  })

  it('scrolls only the rows: the heading and its add button stay pinned', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const scroller = document.querySelector('[data-diff-list-scroll]')
    expect(scroller).not.toBeNull()
    // The rows scroll with the scroller; the heading (and the add button) do not.
    expect(scroller!.textContent).toContain('a.txt')
    expect(scroller!.querySelector('[data-diff-add]')).toBeNull()
    expect(scroller!.textContent).not.toContain('panel.group.current')
    expect(document.querySelector('[data-diff-add]')!.closest('[data-diff-list-scroll]')).toBeNull()
    // …and the heading is still rendered above it.
    expect(document.querySelector('[data-diff-approval-panel]')!.textContent).toContain('panel.group.current')
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

  it('resizes the file list by dragging the divider within its bounds', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const list = document.querySelector('[data-diff-approval-file-list]') as HTMLElement
    const handle = document.querySelector('[data-diff-resize]') as HTMLElement
    expect(list.style.width).toBe('240px')

    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(list.style.width).toBe('320px')

    // Clamped at both ends on an extreme drag.
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1200 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
    expect(list.style.width).toBe('560px')
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

  it('auto-selects the first pending file and advances to the next after handling', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The first file opens automatically.
    expect(document.querySelector('[data-diff-approval-diff]')).not.toBeNull()
    expect(screen.getByText('/repo/a.txt')).toBeDefined()

    // Handling it removes it; the next file takes its place.
    fireEvent.click(screen.getByText('action.keep'))
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [second], busy: new Set() })} />)
    expect(screen.getByText('/repo/b.txt')).toBeDefined()
  })

  it('cycles the pending files with Ctrl+Tab and Ctrl+Shift+Tab', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Auto-selects the first file (a.txt).
    expect(screen.getByText('/repo/a.txt')).toBeDefined()

    // Ctrl+Tab advances to the next file (b.txt).
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true })
    expect(screen.getByText('/repo/b.txt')).toBeDefined()

    // Ctrl+Shift+Tab returns to the previous file (a.txt).
    fireEvent.keyDown(document.body, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(screen.getByText('/repo/a.txt')).toBeDefined()
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

  it('collapses the file list to a floating button below the sidebar breakpoint', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    try {
      const file = entry({ id: 'entry-float', oldText: 'a\n', newText: 'b\n' })
      const props = panelProps({ read: true, files: [file], busy: new Set() })
      const view = render(<PendingPanel {...props} />)
      fireEvent.click(screen.getByLabelText('panel.aria'))

      // 600 < 1024 (the sidebar auto-collapse breakpoint), so the file list
      // floats consistently with the sidebar and the toggle appears.
      expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
      const toggle = document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(toggle).not.toBeNull()

      expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull()
      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()

      // Folding it back removes the card at once: only the opening is animated.
      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull()

      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      // Clicking a file row keeps the floating list open (so you can browse
      // more files); only clicking outside the card folds it back.
      const floatList = document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      const row = [...floatList.querySelectorAll('button')].find(button => button.textContent?.includes('a.txt'))
      expect(row).toBeDefined()
      fireEvent.click(row!)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
      // Clicking outside the card (the code box) folds it back at once.
      fireEvent.pointerDown(document.querySelector('[data-diff-approval-panel]') as HTMLElement)
      expect(document.querySelector('[data-diff-floating-file-list]')).toBeNull()
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
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
      // box, the same inset — so opening the list, which sits above the knob in
      // z-order, covers it exactly.
      fireEvent.click(knob)
      const card = document.querySelector('[data-diff-floating-file-list]') as HTMLElement
      expect(card).not.toBeNull()
      expect(parseFloat(knob.style.left)).toBe(parseFloat(card.style.left))
      expect(parseFloat(knob.style.top)).toBe(parseFloat(card.style.top))
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('folds the file list for good from the switch beside Add, and remembers it', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const first = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    // A wide window: the list sits beside the diff, and there is no knob.
    expect(document.querySelector('[data-diff-approval-file-list]')).not.toBeNull()
    expect(document.querySelector('[data-diff-file-list-toggle]')).toBeNull()

    const toggle = document.querySelector('[data-diff-file-list-float]') as HTMLElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    // Folded for good, with the knob that opens the floating card…
    expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
    expect(document.querySelector('[data-diff-file-list-toggle]')).not.toBeNull()
    // …and stored, so the next open starts folded too.
    expect(localStorage.getItem('diff-approval:file-list-float')).toBe('1')
    first.unmount()

    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-file-list]')).toBeNull()
    // The switch lives with the list's other controls, so it is reached by
    // opening the floating card the knob shows.
    fireEvent.click(document.querySelector('[data-diff-file-list-toggle]') as HTMLElement)
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
      // list still works on the narrow breakpoint.
      expect(document.querySelector('[data-diff-md-preview-body]')).not.toBeNull()
      expect(document.querySelector('[data-diff-body]')).toBeNull()
      const toggle = document.querySelector('[data-diff-file-list-toggle]') as HTMLElement
      expect(toggle).not.toBeNull()
      fireEvent.click(toggle)
      expect(document.querySelector('[data-diff-floating-file-list]')).not.toBeNull()
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      else delete (window as { innerWidth?: unknown }).innerWidth
    }
  })

  it('anchors the block frame to the block bottom and clamps it inside the viewport', () => {
    // Last row of the file is the changed row, so the floating frame would be
    // pushed off the viewport bottom unless clamped up to fit. The frame lives
    // in the non-scrolling wrapper (viewport coordinates), so its `top` is the
    // block-bottom offset minus scrollTop, clamped to the viewport bottom.
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
      // 4 rows = 88px content; the block's last row is the content bottom, so
      // the frame cannot sit below it. With a 120px viewport and a 40px frame,
      // it clamps up to `120 - 40 = 80px` so its own bottom stays on-screen.
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
    await waitFor(() => { expect(screen.getByText('/repo/b.txt')).toBeDefined() })
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

    const rows = [...document.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const code0 = rows[0]!.querySelector('[data-diff-code]') ?? rows[0]!
    const codeLast = rows[rows.length - 1]!.querySelector('[data-diff-code]') ?? rows[rows.length - 1]!
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

  it('the DSH Settings tab exposes an expanded diff-view group with editable appearance', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    render(<DiffApprovalSettingsTab {...props} />)

    // The diff-view group is expanded by default: a live preview plus the
    // font/line-height/color and the moved layout rows are all visible.
    expect(document.querySelector('[data-diff-view-preview]')).not.toBeNull()
    expect(document.querySelector('[data-diff-font-size]')).not.toBeNull()
    expect(document.querySelector('[data-diff-line-height]')).not.toBeNull()
    expect(document.querySelector('[data-diff-add-color]')).not.toBeNull()
    expect(document.querySelector('[data-diff-del-color]')).not.toBeNull()
    expect(document.querySelector('[data-diff-tab-width-select]')).not.toBeNull()
    expect(document.querySelector('[data-diff-split-mode-select]')).not.toBeNull()
    expect(document.querySelector('[data-diff-paste-on-copy-select]')).not.toBeNull()

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
    const props = { ...panelProps({ read: true, files: [FILE], busy: new Set() }), onOpenDock }
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(onOpenDock).toHaveBeenCalledTimes(1)
    // The panel lives in the sidebar's tab there: nothing floats in the overlay.
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
    render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} onOpenDock={onOpenDock} />)
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

})
