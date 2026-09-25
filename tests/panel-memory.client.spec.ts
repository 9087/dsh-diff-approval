// The panel's view memory: which file a session's panel was showing, how far down each file
// it was left, and the page-local state of its comment threads (the draft, the fold, the
// measured body) — including a block that has been placed but not written down yet. Module
// state for the page's lifetime, which is what makes the floating overlay and the docked
// tab agree.

import { afterEach, describe, expect, it } from 'vitest'
import type { PlacedThread } from '../src/client/panel-memory.ts'
import {
  forgetPlacedThreadsNotIn, lastPanelFile, panelFileOffset, rememberPanelView, rememberPlacedThreads, rememberThreads,
  rememberedPlacedThreads, rememberedThreads, resetPanelMemory,
} from '../src/client/panel-memory.ts'

afterEach(resetPanelMemory)

describe('panel memory', () => {
  it('remembers the last file and keeps every file\'s own offset', () => {
    rememberPanelView('s1', { fileId: 'a', scrollTop: 120 })
    expect(lastPanelFile('s1')).toBe('a')
    expect(panelFileOffset('s1', 'a')).toBe(120)

    // The newest close names the last file; the earlier file keeps its place, so
    // going back to it — by reopening on it or by naming it — resumes it.
    rememberPanelView('s1', { fileId: 'b', scrollTop: 8 })
    expect(lastPanelFile('s1')).toBe('b')
    expect(panelFileOffset('s1', 'a')).toBe(120)
    expect(panelFileOffset('s1', 'b')).toBe(8)
  })

  it('names a file without an offset as "no remembered place for it"', () => {
    // What the produced-file chip does: it asks for the file, so the panel lands
    // on that file's first change and any remembered place for it is stale.
    rememberPanelView('s1', { fileId: 'a', scrollTop: 120 })
    rememberPanelView('s1', { fileId: 'a' })
    expect(lastPanelFile('s1')).toBe('a')
    expect(panelFileOffset('s1', 'a')).toBeUndefined()
  })

  it('keeps sessions apart', () => {
    rememberPanelView('s1', { fileId: 'a', scrollTop: 120 })
    // Another session has its own pending list: it must not resume this one's file.
    expect(lastPanelFile('s2')).toBeUndefined()
    expect(panelFileOffset('s2', 'a')).toBeUndefined()
  })

  it('records nothing without a session, and reports nothing it never saw', () => {
    rememberPanelView(undefined, { fileId: 'a', scrollTop: 1 })
    expect(lastPanelFile(undefined)).toBeUndefined()
    expect(panelFileOffset('s1', 'never-seen')).toBeUndefined()
  })

  it('forgets everything on reset', () => {
    rememberPanelView('s1', { fileId: 'a', scrollTop: 120 })
    resetPanelMemory()
    expect(lastPanelFile('s1')).toBeUndefined()
    expect(panelFileOffset('s1', 'a')).toBeUndefined()
  })
})

describe('comment thread state', () => {
  it('keeps the draft, the fold and the measured body by comment id', () => {
    // What the page keeps about a thread is not the thread — that is the host's record, read from
    // the snapshot — but the part of it that is nobody else's business: what the reader is typing,
    // whether they folded the block, and the body height the panel last measured for it.
    expect(rememberedThreads('s1')).toEqual({})
    rememberThreads('s1', { c1: { draft: 'half a thought', collapsed: true, bodyRows: 4 } })
    expect(rememberedThreads('s1').c1).toEqual({ draft: 'half a thought', collapsed: true, bodyRows: 4 })
  })

  it('leaves other sessions, and a page with no session, alone', () => {
    rememberThreads('s1', { c1: { draft: 'mine', collapsed: false } })
    rememberThreads('s2', { c1: { draft: 'theirs', collapsed: false } })
    rememberThreads(undefined, { c1: { draft: 'nobody', collapsed: false } })
    expect(rememberedThreads('s1').c1?.draft).toBe('mine')
    // The other session's state is its own: the same comment id in another session is another copy.
    expect(rememberedThreads('s2').c1?.draft).toBe('theirs')
    // …and a page with no session has nowhere to put it.
    expect(rememberedThreads(undefined)).toEqual({})
  })

  it('hands the same record back when nothing changed, and forgets everything on reset', () => {
    const state = { c1: { draft: 'mine', collapsed: false } }
    rememberThreads('s1', state)
    // The panel writes this on every render that measures, so the same record must come back as the
    // very object it stored: a fresh equal one would have every reader re-adopt it for no change.
    rememberThreads('s1', state)
    expect(rememberedThreads('s1')).toBe(state)
    resetPanelMemory()
    expect(rememberedThreads('s1')).toEqual({})
  })
})

describe('placed-but-unsent blocks', () => {
  /** One placement, with the fields a test does not care about filled in. */
  const placed = (overrides: Partial<PlacedThread> & { id: string }): PlacedThread => ({
    fileId: 'entry-a',
    anchor: { start: 0, end: 0, startLine: 1, endLine: 1 },
    quote: 'a',
    draft: '',
    ...overrides,
  })

  it('remembers where a block was placed and what was typed into it', () => {
    // A placed block has no host record and no comment id, so this is the only thing that can bring
    // it back: the entry, the lines, the quote it was made against, and the reader's words.
    expect(rememberedPlacedThreads('s1')).toEqual([])
    const block = placed({ id: 'draft-1', draft: 'half a thought', anchor: { start: 5, end: 5, startLine: 4, endLine: 4 } })
    rememberPlacedThreads('s1', [block])
    expect(rememberedPlacedThreads('s1')).toEqual([block])
    // Placement order is the list's order: a later block appends.
    const second = placed({ id: 'draft-2', draft: 'and this one', anchor: { start: 1, end: 1, startLine: 2, endLine: 2 } })
    rememberPlacedThreads('s1', [block, second])
    expect(rememberedPlacedThreads('s1').map(entry => entry.id)).toEqual(['draft-1', 'draft-2'])
  })

  it('leaves other sessions, and a page with no session, alone', () => {
    rememberPlacedThreads('s1', [placed({ id: 'draft-1', draft: 'mine' })])
    rememberPlacedThreads('s2', [placed({ id: 'draft-1', draft: 'theirs' })])
    rememberPlacedThreads(undefined, [placed({ id: 'draft-1', draft: 'nobody' })])
    expect(rememberedPlacedThreads('s1')[0]?.draft).toBe('mine')
    expect(rememberedPlacedThreads('s2')[0]?.draft).toBe('theirs')
    expect(rememberedPlacedThreads(undefined)).toEqual([])
  })

  it('keeps the record it holds when an equal-but-new list arrives, and lets a real change through', () => {
    // The panel rebuilds this list on every render that touches its state — a keystroke, a fold, a
    // measurement — and an equal list must not be stored again: a reader that read it back would
    // adopt a new array for no change at all.
    const before = [placed({ id: 'draft-1', draft: 'mine' })]
    rememberPlacedThreads('s1', before)
    rememberPlacedThreads('s1', [placed({ id: 'draft-1', draft: 'mine' })])
    expect(rememberedPlacedThreads('s1')).toBe(before)

    // A word of the draft is a change (it is what the block draws), and so is writing it down.
    const typed = [placed({ id: 'draft-1', draft: 'mine, still' })]
    rememberPlacedThreads('s1', typed)
    expect(rememberedPlacedThreads('s1')).toBe(typed)
    rememberPlacedThreads('s1', [])
    expect(rememberedPlacedThreads('s1')).toEqual([])

    resetPanelMemory()
    expect(rememberedPlacedThreads('s1')).toEqual([])
  })

  it('drops the placements of a file the list no longer holds, and keeps the ones it does', () => {
    // A placement is a block of rows in ONE file's diff, so a file the reader kept or reverted out
    // of the list leaves nothing for it to hang on. Leaving it in the memory was worse than dead
    // weight: entry ids ARE paths, so the same path coming back drew the block again on a file that
    // had already been dealt with, and the block went on refusing a fresh comment on those rows.
    const onA = placed({ id: 'draft-a', fileId: 'entry-a' })
    const onB = placed({ id: 'draft-b', fileId: 'entry-b' })
    rememberPlacedThreads('s1', [onA, onB])

    // The poll still lists both: nothing goes.
    forgetPlacedThreadsNotIn('s1', ['entry-a', 'entry-b'])
    expect(rememberedPlacedThreads('s1')).toEqual([onA, onB])

    // A leaves the list — kept or reverted, it is the same to the page — and its block goes.
    forgetPlacedThreadsNotIn('s1', ['entry-b'])
    expect(rememberedPlacedThreads('s1').map(thread => thread.id)).toEqual(['draft-b'])

    // The same path becoming pending again does NOT bring the block back: the placement is gone,
    // so those rows are free for a new comment.
    forgetPlacedThreadsNotIn('s1', ['entry-a', 'entry-b'])
    expect(rememberedPlacedThreads('s1').map(thread => thread.id)).toEqual(['draft-b'])
  })

  it('leaves other sessions, and a page with no session, alone when it drops a placement', () => {
    rememberPlacedThreads('s1', [placed({ id: 'draft-1', fileId: 'entry-a' })])
    rememberPlacedThreads('s2', [placed({ id: 'draft-2', fileId: 'entry-a' })])
    forgetPlacedThreadsNotIn('s1', [])
    expect(rememberedPlacedThreads('s1')).toEqual([])
    // The other session's panel has its own list, and this one's poll says nothing about it.
    expect(rememberedPlacedThreads('s2').map(thread => thread.id)).toEqual(['draft-2'])
    // A page with no session has no record to drop, and dropping is not an error.
    forgetPlacedThreadsNotIn(undefined, [])
    expect(rememberedPlacedThreads(undefined)).toEqual([])
  })
})
