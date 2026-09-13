// The panel's view memory: which file a session's panel was showing, and how far
// down each file it was left. Module state for the page's lifetime, which is what
// makes the floating overlay and the docked tab agree.

import { afterEach, describe, expect, it } from 'vitest'
import { lastPanelFile, panelFileOffset, rememberPanelView, resetPanelMemory } from '../src/client/panel-memory.ts'

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
