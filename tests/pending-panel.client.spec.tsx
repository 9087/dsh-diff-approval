// @vitest-environment jsdom
// PendingPanel: badge, per-path grouping, per-operation rows, actions, jump
// navigation, live-state warnings, and the line-selection copy toolbar.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import { PendingPanel } from '../src/client/PendingPanel.tsx'
import { DiffApprovalSettingsTab } from '../src/client/SettingsTab.tsx'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'

afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })
afterEach(() => { localStorage.clear() })

beforeAll(() => {
  // jsdom has no scrolling; the jump effect centers rows through it.
  Element.prototype.scrollIntoView = () => {}
})

const S1 = 'session-1' as SessionId
const FILE: PendingFileDiff = {
  id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
  oldText: 'a\n', newText: 'b\n', updatedAt: 10, missing: false, diverged: false,
}

function entry(overrides: Partial<PendingFileDiff>): PendingFileDiff {
  return { ...FILE, ...overrides }
}

type PanelProps = ComponentProps<typeof PendingPanel>

function panelProps(snapshot: PendingDiffSnapshot): PanelProps {
  return {
    wide: true,
    useSessions: (select: (state: { current: SessionId }) => SessionId) => select({ current: S1 }),
    usePending: (select: (state: PendingDiffSnapshot) => PendingDiffSnapshot) => select(snapshot),
    onRefresh: vi.fn(),
    onKeep: vi.fn(async () => {}),
    onRevert: vi.fn(async () => {}),
    onBlockKeep: vi.fn(async () => {}),
    onBlockRevert: vi.fn(async () => {}),
    onOpen: vi.fn(async () => {}),
    onPasteReference: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    t: (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  } as unknown as PanelProps
}

describe('PendingPanel', () => {
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

  it('closes when clicking outside the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
  })

  it('stays open when clicking inside the panel', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const panel = document.querySelector('[data-diff-approval-panel]')!
    fireEvent.pointerDown(panel)
    expect(document.querySelector('[data-diff-approval-panel]')).not.toBeNull()
  })

  it('stays open on the input card but closes on its seat gutter', () => {
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
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    seat.remove()
  })

  it('stays open on the approval card but closes on its blank gutter', () => {
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
    expect(document.querySelector('[data-diff-approval-panel]')).toBeNull()
    frame.remove()
  })

  it('closes via the header close button', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(document.querySelector('[data-diff-approval-panel]')).toBeTruthy()

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

  it('keeps or reverts every current-session file from the list footer', async () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(screen.getByText('action.keepAll'))
    const keepMock = props.onKeep as unknown as { mock: { calls: unknown[][] } }
    await waitFor(() => { expect(keepMock.mock.calls).toHaveLength(2) })
    expect(keepMock.mock.calls.map(call => call[1])).toEqual([FILE.id, 'entry-2'])

    fireEvent.click(screen.getByText('action.revertAll'))
    const revertMock = props.onRevert as unknown as { mock: { calls: unknown[][] } }
    await waitFor(() => { expect(revertMock.mock.calls).toHaveLength(2) })
    expect(revertMock.mock.calls.map(call => call[1])).toEqual([FILE.id, 'entry-2'])
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

  it('tags a created file on its row and shows the revert hint when expanded', () => {
    const created = entry({ id: 'entry-new', kind: 'create', oldText: '', newText: 'content', path: '/repo/new.txt' })
    const props = panelProps({ read: true, files: [created], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getByText('row.create')).toBeDefined()
    fireEvent.click(screen.getByText('new.txt'))
    expect(screen.getByText('panel.createHint')).toBeDefined()
  })

  it('expands the whole-file diff and keeps through the owning session', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    expect(screen.getAllByText('a').length).toBeGreaterThan(0)
    expect(screen.getAllByText('b').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('action.keep'))
    expect(props.onKeep).toHaveBeenCalledWith(FILE.sessionId, FILE.id)
  })

  it('reverts through the owning session by id', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    fireEvent.click(screen.getByText('action.revert'))
    expect(props.onRevert).toHaveBeenCalledWith(FILE.sessionId, FILE.id)
  })

  it('disables the actions while an entry is busy', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set([FILE.id]) })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    expect(screen.getAllByText('action.busy')).toHaveLength(2)
    fireEvent.click(screen.getAllByText('action.busy')[0]!)
    expect(props.onKeep).not.toHaveBeenCalled()
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

  it('closes the panel once a non-empty list empties through handling', () => {
    const view = render(<PendingPanel {...panelProps({ read: true, files: [FILE], busy: new Set() })} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.title')).toBeDefined()

    view.rerender(<PendingPanel {...panelProps({ read: true, files: [], busy: new Set() })} />)
    expect(screen.queryByText('panel.title')).toBeNull()

    // Reopening an empty list stays open.
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.empty')).toBeDefined()
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

  it('auto-selects the first pending file and advances to the next after handling', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // The first file opens automatically.
    expect(view.container.querySelector('[data-diff-approval-diff]')).not.toBeNull()
    expect(screen.getByText('/repo/a.txt')).toBeDefined()

    // Handling it removes it; the next file takes its place.
    fireEvent.click(screen.getByText('action.keep'))
    view.rerender(<PendingPanel {...panelProps({ read: true, files: [second], busy: new Set() })} />)
    expect(screen.getByText('/repo/b.txt')).toBeDefined()
  })

  it('cannot be deselected by clicking the selected row again', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    fireEvent.click(screen.getByText('a.txt'))
    expect(view.container.querySelector('[data-diff-approval-diff]')).not.toBeNull()
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

  it('marks changed lines on the scrollbar overview ruler in diff colors', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const ruler = view.container.querySelector('[data-diff-approval-ruler]') as HTMLElement
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
    expect(view.container.querySelector('[data-diff-block-actions]')).toBeNull()
    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    fireEvent.mouseEnter(rows[0]!) // del 'a' -> block 0 (old 1-1, new 1-1)

    const actions = view.container.querySelector('[data-diff-block-actions]') as HTMLElement
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
    const contextRow = [...view.container.querySelectorAll('[data-diff-row]')]
      .find(row => row.getAttribute('data-diff-line') === 'context') as HTMLElement
    fireEvent.mouseEnter(contextRow)
    expect(view.container.querySelector('[data-diff-block-actions]')).toBeNull()
  })

  it('anchors the block frame to the block bottom and pads the diff bottom when the block is the last row', () => {
    // Last row of the file is the changed row, so the floating frame would be
    // clipped unless the diff bottom is padded to fit it.
    const lastRowDiff = entry({ id: 'entry-last-row', oldText: 'a\nb\nc\n', newText: 'a\nb\nC\n' })
    const props = panelProps({ read: true, files: [lastRowDiff], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
    const last = rows[rows.length - 1]!
    fireEvent.mouseEnter(last)

    const actions = view.container.querySelector('[data-diff-block-actions]') as HTMLElement
    expect(actions).not.toBeNull()
    // Frame's top edge sits at the block's bottom edge: one row below the
    // block's last row. The del 'c' + add 'C' rows are the last two of the 4
    // rendered rows, so the block's last row is 3 -> (3 + 1) * 22.
    expect(actions.style.top).toBe('88px')

    // The bottom pad spacer fills the frame height so it is not clipped.
    const pad = [...view.container.querySelectorAll('[aria-hidden="true"]')]
      .find(el => (el as HTMLElement).style.height === '40px')
    expect(pad).toBeDefined()
  })

  it('moves the focus between contiguous change blocks', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    // Opening the panel auto-selects the first file (block 0 focused).
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const focusedLines = () => [...view.container.querySelectorAll('[data-diff-focused]')]
    // Block 0: the first change (del a / add A), both lines highlighted.
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('a')

    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('c')

    fireEvent.click(screen.getByLabelText('action.prevDiff'))
    expect(focusedLines()[0]!.textContent).toContain('a')

    // From the last block, next wraps back to the first.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('jumps between change blocks with Ctrl+Up / Ctrl+Down while the panel is focused', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Opening the panel auto-selects the file and focuses the diff body.
    const body = view.container.querySelector('[data-diff-body]') as HTMLElement
    expect(document.activeElement).toBe(body)

    const focusedLines = () => [...view.container.querySelectorAll('[data-diff-focused]')]
    expect(focusedLines()[0]!.textContent).toContain('a')

    fireEvent.keyDown(body, { key: 'ArrowDown', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('c')

    fireEvent.keyDown(body, { key: 'ArrowUp', ctrlKey: true })
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('flashes the focused block on open and on every block switch', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // Opening the file flashes the initially focused block 0 (rows 0-1).
    const first = view.container.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(first).not.toBeNull()
    expect(first.style.top).toBe('0px')
    expect(first.style.height).toBe('44px')

    // Jumping to block 1 remounts the flash over it: the del 'c' / add 'C'
    // pair at rows 3-4 -> top 66px, height 44px.
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const second = view.container.querySelector('[data-diff-block-flash]') as HTMLElement
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

    const flash = () => view.container.querySelector('[data-diff-block-flash]') as HTMLElement
    expect(flash()).not.toBeNull()

    // NextDiff wraps to the only block: the overlay must remount (new node)
    // so the fade-out replays even though the block did not move.
    const before = flash()
    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    expect(flash()).not.toBeNull()
    expect(flash()).not.toBe(before)
  })

  it('re-clicking the already-open file jumps to the next diff block', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    // Opening the panel auto-selects the first file with block 0 focused.
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const focusedLines = () => [...view.container.querySelectorAll('[data-diff-focused]')]
    // Block 0 (del a / add A) is focused after the file is opened.
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('a')

    // Clicking the file's row again must not reselect (it is already open);
    // it jumps to the next diff block instead (c / C).
    fireEvent.click(screen.getByText('a.txt'))
    expect(focusedLines()).toHaveLength(2)
    expect(focusedLines()[0]!.textContent).toContain('c')

    // And again wraps around to the first block.
    fireEvent.click(screen.getByText('a.txt'))
    expect(focusedLines()[0]!.textContent).toContain('a')
  })

  it('searches the diff: counts hits, highlights them, and jumps between matches', () => {
    const file = entry({ id: 'entry-search', oldText: 'foo\nbar\nbaz\n', newText: 'foo\nbar\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    // No search UI or highlights until the bar is opened.
    expect(view.container.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(view.container.querySelectorAll('[data-diff-search]')).toHaveLength(0)

    fireEvent.click(screen.getByLabelText('action.search'))
    expect(view.container.querySelector('[data-diff-searchbar]')).not.toBeNull()

    // Query 'a' matches 'bar' (context row 1) and 'baz' (del row 2); the
    // other rows 'foo'/'qux' have no 'a'.
    const input = view.container.querySelector('[data-diff-search-input]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'a' } })

    expect(view.container.querySelector('[data-diff-search-count]')!.textContent).toBe('1/2')
    expect(view.container.querySelectorAll('[data-diff-search="hit"]')).toHaveLength(1)
    const firstCurrent = view.container.querySelector('[data-diff-search="current"]') as HTMLElement
    expect(firstCurrent.textContent).toContain('bar')

    // Next match moves to 'baz' and the count advances.
    fireEvent.click(view.container.querySelector('[data-diff-search-next]') as HTMLElement)
    expect(view.container.querySelector('[data-diff-search-count]')!.textContent).toBe('2/2')
    const secondCurrent = view.container.querySelector('[data-diff-search="current"]') as HTMLElement
    expect(secondCurrent.textContent).toContain('baz')

    // Closing the bar clears the query and the highlights.
    fireEvent.click(view.container.querySelector('[data-diff-search-close]') as HTMLElement)
    expect(view.container.querySelector('[data-diff-searchbar]')).toBeNull()
    expect(view.container.querySelectorAll('[data-diff-search]')).toHaveLength(0)
  })

  it('undoes with Ctrl+Z and redoes with Ctrl+Y globally, but not in text inputs', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const undoMock = props.onUndo as unknown as { mock: { calls: unknown[][] } }
    const redoMock = props.onRedo as unknown as { mock: { calls: unknown[][] } }

    // Global: works from the diff body regardless of where focus sits.
    const body = view.container.querySelector('[data-diff-body]') as HTMLElement
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

  it('opens the search bar with Ctrl+F even when focus is outside the panel', () => {
    const file = entry({ id: 'entry-search', oldText: 'foo\nbar\n', newText: 'foo\nqux\n' })
    const props = panelProps({ read: true, files: [file], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(view.container.querySelector('[data-diff-searchbar]')).toBeNull()

    // Ctrl+F with the focus on the page body (not inside the panel) still
    // opens the search bar instead of the browser's native find.
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true })
    expect(view.container.querySelector('[data-diff-searchbar]')).not.toBeNull()
  })

  it('re-centers the sole block on every jump when it is the only one', () => {
    const single = entry({ id: 'entry-single', oldText: 'a\nb\nc\nd\ne\n', newText: 'A\nb\nc\nd\nE\n' })
    const props = panelProps({ read: true, files: [single], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // Give the scroller a fake viewport and intercept scrollTop so the
    // re-center on each jump is observable.
    const body = view.container.querySelector('[data-diff-body]') as HTMLElement
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

  it('skips blocks scrolled above the viewport when jumping to the next one', () => {
    const threeBlocks = entry({
      id: 'entry-three',
      oldText: 'a\nb\nc\nd\ne\nf\n',
      newText: 'A\nb\nC\nd\nE\nf\n',
    })
    const props = panelProps({ read: true, files: [threeBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    // Blocks 0 and 1 start at rows 0 and 3 (top 0/66px); block 2 starts at
    // row 6 (132px). Scroll past the first two so the next jump must land on
    // the third instead of the ones scrolled out above.
    const body = view.container.querySelector('[data-diff-body]') as HTMLElement
    body.scrollTop = 6 * 22

    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const focused = view.container.querySelector('[data-diff-focused]')
    expect(focused).not.toBeNull()
    expect(focused!.textContent).toContain('e')
  })

  it('renders only a viewport window of rows for a large file', () => {
    const big = entry({ id: 'entry-big', oldText: 'a\n'.repeat(2000), newText: 'A\n'.repeat(2000) })
    const props = panelProps({ read: true, files: [big], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const body = view.container.querySelector('[data-diff-body]') as HTMLElement
    // Fake a 440px viewport (20 rows) and let the scroller report it.
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 440 })
    fireEvent.scroll(body)

    const rendered = view.container.querySelectorAll('[data-diff-row]').length
    // 20 visible + overscan, far fewer than the whole 4000-row file.
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
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

  it('pins the panel to the window edge when expanded and restores on a second click', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    const panel = view.container.querySelector('[data-diff-approval-panel]') as HTMLElement
    const expand = view.container.querySelector('[data-diff-approval-expand]') as HTMLElement
    expect(expand).not.toBeNull()
    // The close button sits to the right of the expand button.
    const close = view.container.querySelector('[data-diff-approval-close]') as HTMLElement
    expect(close.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // Default bottom is the fallback composer offset.
    expect(panel.style.bottom).toBe('128px')

    fireEvent.click(expand)
    // Expanded pins to the window edge, keeping the 8px inset of the other edges.
    expect(panel.style.bottom).toBe('8px')
    expect(expand.getAttribute('aria-label')).toBe('action.exitFullscreen')

    fireEvent.click(expand)
    expect(panel.style.bottom).toBe('128px')
    expect(expand.getAttribute('aria-label')).toBe('action.expand')

    // Expanded is a persistent state: closing and reopening keeps it.
    fireEvent.click(expand)
    fireEvent.click(screen.getByLabelText('action.close'))
    fireEvent.click(screen.getByLabelText('panel.aria'))
    const reopened = view.container.querySelector('[data-diff-approval-panel]') as HTMLElement
    expect(reopened.style.bottom).toBe('8px')
  })

  it('shows the selection reference in the status bar when text is selected', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
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
    // No workspace is known, so the reference carries the absolute path.
    expect(view.container.querySelector('[data-diff-status-bar]')).not.toBeNull()
    expect(screen.getByText('/repo/a.txt:1')).toBeDefined()
    expect(view.container.querySelector('[data-diff-copy]')).not.toBeNull()
  })

  it('uses a workspace-relative reference when the file is inside the workspace', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set(), workspacePath: '/repo' })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
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

  it('does not offer a reference for a selection of only removed lines', () => {
    // 'a\nb\n' -> 'b\n' removes line 1; the removed row has no current-file
    // number, so selecting it alone must not produce a copyable reference.
    const removed = entry({ id: 'entry-removed', oldText: 'a\nb\n', newText: 'b\n' })
    const props = panelProps({ read: true, files: [removed], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
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

    expect(view.container.querySelector('[data-diff-copy]')).toBeNull()
  })

  it('copies the reference with Ctrl+L', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
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
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('/repo/a.txt:1') })
    await vi.waitFor(() => { expect(screen.getByText('action.copied')).toBeDefined() })
  })

  /** Select the first two diff rows so a reference becomes copyable. */
  function selectFirstRows(view: ReturnType<typeof render>): void {
    const rows = [...view.container.querySelectorAll('[data-diff-row]')] as HTMLElement[]
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
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))
    selectFirstRows(view)

    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('/repo/a.txt:1') })
    // The paste runs in the same async continuation after the clipboard write
    // settles, so wait for it rather than reading the mock immediately.
    const pasteMock = props.onPasteReference as unknown as { mock: { calls: unknown[][] } }
    await vi.waitFor(() => { expect(pasteMock.mock.calls).toEqual([[S1, '/repo/a.txt:1']]) })
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
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith('/repo/a.txt:1') })
    const pasteMock = props.onPasteReference as unknown as { mock: { calls: unknown[][] } }
    expect(pasteMock.mock.calls).toHaveLength(0)
  })

  it('the DSH Settings tab toggles the auto-paste preference in localStorage', () => {
    const props = { t: (key: string) => key } as unknown as ComponentProps<typeof DiffApprovalSettingsTab>
    const view = render(<DiffApprovalSettingsTab {...props} />)
    const toggle = view.container.querySelector('[data-diff-paste-on-copy]') as HTMLInputElement
    expect(toggle).not.toBeNull()
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(false)
    expect(localStorage.getItem('diff-approval:paste-on-copy')).toBe('0')

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(localStorage.getItem('diff-approval:paste-on-copy')).toBe('1')
  })

  it('lets the status bar pick the highlight language', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const trigger = view.container.querySelector('[data-diff-lang]') as HTMLElement
    expect(trigger).not.toBeNull()
    fireEvent.click(trigger)
    const typescript = screen.getByText('TypeScript')
    fireEvent.click(typescript)
    expect(trigger.textContent).toContain('TypeScript')
  })

  it('lists only curated highlight languages, conventionally cased and sorted', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const trigger = view.container.querySelector('[data-diff-lang]') as HTMLElement
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
})
