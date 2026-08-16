// PendingDiffStore: per-path folding, session scoping, hydration, removal.

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PendingDiffStore } from '../src/index.ts'
import type { PendingEntry } from '../src/types.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
    oldText: 'old', newText: 'new', updatedAt: 10, ...overrides,
  }
}

describe('PendingDiffStore.fold', () => {
  it('records the first operation of a path', () => {
    const store = new PendingDiffStore()
    expect(store.fold(entry())).toBe(true)
    expect(store.get(S1, 'entry-1')).toEqual({
      id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
      oldText: 'old', newText: 'new', updatedAt: 10,
    })
    expect(store.size).toBe(1)
  })

  it('extends the entry when the next operation continues the chain', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.fold(entry({ oldText: 'v2', newText: 'v3', updatedAt: 20 }))).toBe(true)
    expect(store.get(S1, 'entry-1')).toEqual({
      id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
      oldText: 'v1', newText: 'v3', updatedAt: 20,
    })
    expect(store.size).toBe(1)
  })

  it('keeps a create kind when later edits extend a created file', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ kind: 'create', oldText: '', newText: 'content', updatedAt: 10 }))
    store.fold(entry({ oldText: 'content', newText: 'content2', updatedAt: 20 }))
    expect(store.get(S1, 'entry-1')).toEqual(expect.objectContaining({ kind: 'create', newText: 'content2' }) as object)
  })

  it('keeps the earliest basis and takes the latest content even when the chain breaks', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.fold(entry({ oldText: 'external', newText: 'v3', updatedAt: 20 }))).toBe(true)
    expect(store.get(S1, 'entry-1')).toEqual({
      id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
      oldText: 'v1', newText: 'v3', updatedAt: 20,
    })
    expect(store.size).toBe(1)
  })

  it('folds nothing for a no-op or an unchanged extension', () => {
    const store = new PendingDiffStore()
    expect(store.fold(entry({ oldText: 'same', newText: 'same' }))).toBe(false)
    store.fold(entry({ oldText: 'v1', newText: 'v2' }))
    expect(store.fold(entry({ oldText: 'v2', newText: 'v2' }))).toBe(false)
    expect(store.size).toBe(1)
  })
})

describe('PendingDiffStore.list', () => {
  it('scopes entries to one session and orders by the oldest capture first', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ id: 'e1', path: '/repo/b.txt', updatedAt: 30 }))
    store.fold(entry({ id: 'e2', sessionId: S2, path: '/repo/c.txt', updatedAt: 20 }))
    store.fold(entry({ id: 'e3', path: '/repo/a.txt', updatedAt: 10 }))
    expect(store.list(S1).map(file => file.id)).toEqual(['e3', 'e1'])
    expect(store.list(S2).map(file => file.id)).toEqual(['e2'])
    expect(store.list(SessionId('empty'))).toEqual([])
  })
})

describe('PendingDiffStore.remove', () => {
  it('removes only the named entry and clears its path index', () => {
    const store = new PendingDiffStore()
    store.fold(entry())
    store.fold(entry({ id: 'entry-2', path: '/repo/b.txt' }))
    expect(store.remove(S1, 'entry-1')).toBe(true)
    expect(store.remove(S1, 'entry-1')).toBe(false)
    expect(store.get(S1, 'entry-2')).toBeDefined()
    // A fresh operation to the removed path starts a new entry.
    expect(store.fold(entry({ oldText: 'x', newText: 'y' }))).toBe(true)
    expect(store.get(S1, 'entry-1')?.oldText).toBe('x')
  })

  it('treats the same id under another session as a separate entry', () => {
    const store = new PendingDiffStore()
    store.fold(entry())
    store.fold(entry({ sessionId: S2, newText: 'other' }))
    store.remove(S1, 'entry-1')
    expect(store.get(S2, 'entry-1')?.newText).toBe('other')
  })
})

describe('PendingDiffStore.hydrate', () => {
  it('folds persisted entries per path, oldest first', () => {
    const store = new PendingDiffStore()
    store.hydrate(S1, [
      entry({ id: 'a', oldText: 'v1', newText: 'v2', updatedAt: 10 }),
      entry({ id: 'b', oldText: 'v2', newText: 'v3', updatedAt: 20 }),
    ])
    expect(store.size).toBe(1)
    expect(store.get(S1, 'a')).toEqual(expect.objectContaining({ oldText: 'v1', newText: 'v3' }) as object)
  })

  it('keeps a live entry over a persisted one for the same path', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'live-old', newText: 'live-new' }))
    store.hydrate(S1, [entry({ oldText: 'stale-old', newText: 'stale-new' })])
    expect(store.get(S1, 'entry-1')?.newText).toBe('live-new')
  })

  it('rebrands merged entries to the calling session', () => {
    const store = new PendingDiffStore()
    store.hydrate(S2, [entry()])
    expect(store.get(S2, 'entry-1')?.sessionId).toBe(S2)
    expect(store.get(S1, 'entry-1')).toBeUndefined()
  })
})
