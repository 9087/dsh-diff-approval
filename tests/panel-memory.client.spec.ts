// The panel's view memory: which file a session's panel was showing, and how far
// down each file it was left. Module state for the page's lifetime, which is what
// makes the floating overlay and the docked tab agree.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENTS_CHANGED_EVENT, forgetDiscussionsNotIn, lastPanelFile, panelFileOffset, rememberDiscussions,
  rememberedDiscussions, rememberPanelView, resetPanelMemory,
} from '../src/client/panel-memory.ts'
import type { Discussion } from '../src/client/discussion.ts'

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

describe('comment threads', () => {
  const thread = (id: string): Discussion => ({
    id, anchor: { start: 0, end: 0, startLine: 1, endLine: 1 }, collapsed: false, draft: '',
    messages: [{ role: 'user', text: id }],
  })

  it('drops the threads of the files a list no longer holds, and keeps the rest', () => {
    rememberDiscussions('s1', { a: [thread('in-a')], b: [thread('in-b')] })
    forgetDiscussionsNotIn('s1', ['b'])
    expect(Object.keys(rememberedDiscussions('s1'))).toEqual(['b'])
    expect(rememberedDiscussions('s1').b?.[0]?.id).toBe('in-b')
  })

  it('leaves other sessions, and a page with no session, alone', () => {
    rememberDiscussions('s1', { a: [thread('in-a')] })
    rememberDiscussions('s2', { a: [thread('in-s2')] })
    forgetDiscussionsNotIn('s1', [])
    forgetDiscussionsNotIn(undefined, [])
    expect(rememberedDiscussions('s1')).toEqual({})
    // The other session's list is its own: an empty list in one says nothing about the other.
    expect(rememberedDiscussions('s2').a?.[0]?.id).toBe('in-s2')
  })

  it('publishes nothing when every file is still listed', () => {
    // The panel asks on every poll, and the file list is a fresh array each time: an equal-but-new
    // record would make both panes adopt it again on every poll for no change at all.
    rememberDiscussions('s1', { a: [thread('in-a')] })
    const before = rememberedDiscussions('s1')
    const seen = vi.fn()
    window.addEventListener(COMMENTS_CHANGED_EVENT, seen)
    try {
      forgetDiscussionsNotIn('s1', ['a'])
      expect(rememberedDiscussions('s1')).toBe(before)
      expect(seen).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(COMMENTS_CHANGED_EVENT, seen)
    }
  })
})
