// @vitest-environment jsdom
// PendingPanel: badge, per-path grouping, per-operation rows, actions, jump
// navigation, live-state warnings, and the line-selection copy toolbar.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import { PendingPanel } from '../src/client/PendingPanel.tsx'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'

afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })

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
    onOpen: vi.fn(async () => {}),
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

  it('groups the current session first and other sessions below', () => {
    const other = entry({ id: 'entry-other', sessionId: 'session-2' as SessionId, path: '/repo/other.txt' })
    const props = panelProps({ read: true, files: [other, FILE], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    expect(screen.getByText('panel.group.current')).toBeDefined()
    expect(screen.getByText('panel.group.others')).toBeDefined()
    expect(screen.getByText('a.txt')).toBeDefined()
    expect(screen.getByText('other.txt')).toBeDefined()
  })

  it('shows one row per file with its short name', () => {
    const second = entry({ id: 'entry-2', path: '/repo/b.txt' })
    const props = panelProps({ read: true, files: [FILE, second], busy: new Set() })
    render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))

    expect(screen.getAllByText('a.txt')).toHaveLength(1)
    expect(screen.getAllByText('b.txt')).toHaveLength(1)
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

  it('moves the focus between contiguous change blocks', () => {
    const twoBlocks = entry({ id: 'entry-blocks', oldText: 'a\nb\nc\nd\n', newText: 'A\nb\nC\nd\n' })
    const props = panelProps({ read: true, files: [twoBlocks], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

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

    // Blocks 0 and 1 sit above the viewport top; block 2 is at it.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const text = this.textContent ?? ''
      if (this.hasAttribute('data-diff-line') && (text.includes('a') || text.includes('c'))) {
        return { top: -200, bottom: -100, left: 0, right: 0, width: 0, height: 22, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })

    fireEvent.click(screen.getByLabelText('action.nextDiff'))
    const focused = view.container.querySelector('[data-diff-focused]')
    expect(focused).not.toBeNull()
    expect(focused!.textContent).toContain('e')
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

  it('opens a copy toolbar after a line drag selection', () => {
    const props = panelProps({ read: true, files: [FILE], busy: new Set() })
    const view = render(<PendingPanel {...props} />)
    fireEvent.click(screen.getByLabelText('panel.aria'))
    fireEvent.click(screen.getByText('a.txt'))

    const firstLine = view.container.querySelector('[data-diff-line]')
    if (firstLine === null) throw new Error('no diff line rendered')
    fireEvent.mouseDown(firstLine)
    fireEvent.mouseUp(view.container.querySelector('[data-diff-approval-diff]')!)

    const toolbar = view.container.querySelector('[data-diff-selection-toolbar]')
    expect(toolbar).not.toBeNull()
    const copy = view.container.querySelector('[data-diff-copy]')
    expect(copy).not.toBeNull()
    fireEvent.click(copy!)
    expect(screen.getByText('action.copyRange')).toBeDefined()
  })
})
