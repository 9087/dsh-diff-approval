// PendingDiffStore: globally-unique per-path folding, session-scoped list,
// hydration, removal.

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PendingDiffStore } from '../src/index.ts'
import type { PendingEntry } from '../src/types.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  const sessionId = overrides.sessionId ?? S1
  const base: PendingEntry = {
    id: '/repo/a.txt', sessionId: S1, path: '/repo/a.txt', earlierVersion: 'file',
    oldText: 'old', newText: 'new', updatedAt: 10, sessionIds: [S1],
  }
  const merged = { ...base, ...overrides }
  if (overrides.sessionId !== undefined && overrides.sessionIds === undefined) {
    merged.sessionIds = [overrides.sessionId as SessionId]
  }
  return merged
}

describe('PendingDiffStore.fold', () => {
  it('records the first operation of a path', () => {
    const store = new PendingDiffStore()
    expect(store.fold(entry())).toBe(true)
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({
      id: '/repo/a.txt', sessionId: S1, path: '/repo/a.txt', earlierVersion: 'file',
      oldText: 'old', newText: 'new', updatedAt: 10, sessionIds: [S1],
    }))
    expect(store.size).toBe(1)
  })

  it('extends the entry when the next operation continues the chain', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.fold(entry({ oldText: 'v2', newText: 'v3', updatedAt: 20 }))).toBe(true)
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({
      oldText: 'v1', newText: 'v3', updatedAt: 20,
    }))
    expect(store.size).toBe(1)
  })

  it('turns a created file that was edited again into a modification based on what it was created with', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ earlierVersion: 'none', oldText: '', newText: 'content', updatedAt: 10 }))
    store.fold(entry({ oldText: 'content', newText: 'content2', updatedAt: 20 }))
    // The reader is reviewing rounds of edits to a file that exists: the tag is 修改, the basis is the
    // content it was created with, and 回退 writes that back instead of deleting the file.
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({
      earlierVersion: 'file', oldText: 'content', newText: 'content2',
    }))
  })

  it('keeps a row that was already a modification a modification when an import calls its file new', () => {
    const store = new PendingDiffStore()
    // The row was admitted days ago as a modification of a file that exists…
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    // …and a later version-control import calls the same path new, because HEAD carries no version of it.
    // (The import's baseline moved from the index to HEAD on 2026-09-24 and shipped in 0.30.0, so every
    // file that is on disk but uncommitted came back as `create` from then on.)
    store.fold(entry({ earlierVersion: 'none', oldText: '', newText: 'v3', updatedAt: 20 }))
    // A creation cannot have an old side, so the row must not become 新增: it keeps its own basis. The old
    // rule produced exactly `{ earlierVersion: 'none', oldText: 'v1' }` here — measured in a real store, which held
    // three such rows (AGENTS.md 871 bytes of old side, and two documents) offering to DELETE the file.
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({
      earlierVersion: 'file', oldText: 'v1', newText: 'v3',
    }))
  })

  it('keeps a create while creations are the whole change', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ earlierVersion: 'none', oldText: '', newText: 'content', updatedAt: 10 }))
    store.fold(entry({ earlierVersion: 'none', oldText: '', newText: 'content2', updatedAt: 20 }))
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({ earlierVersion: 'none', oldText: '', newText: 'content2' }))
  })

  it('stops treating a creation as one once part of it has been kept', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ earlierVersion: 'none', oldText: '', newText: 'a\nb\n', updatedAt: 10 }))
    // A block keep accepts part of the file: the basis advances to what the reader kept, so there IS an
    // earlier version to restore and the whole-file action must become 回退 — not 删除, which would throw
    // away the part they just accepted. `earlierVersion` is the fact "this file did not exist before", and a
    // kept block makes that fact false.
    store.update('/repo/a.txt', { oldText: 'a\n' })
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({ earlierVersion: 'file', oldText: 'a\n' }))
  })

  it('keeps the earliest basis and takes the latest content even when the chain breaks', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.fold(entry({ oldText: 'external', newText: 'v3', updatedAt: 20 }))).toBe(true)
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({
      oldText: 'v1', newText: 'v3', updatedAt: 20,
    }))
    expect(store.size).toBe(1)
  })

  it('folds across sessions into one globally-unique entry', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ sessionId: S1, oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.fold(entry({ sessionId: S2, oldText: 'v2', newText: 'v3', updatedAt: 20 }))).toBe(true)
    const merged = store.get('/repo/a.txt')
    expect(merged?.newText).toBe('v3')
    expect(merged?.oldText).toBe('v1')
    expect(merged?.sessionIds).toEqual([S1, S2])
    // Both sessions see the one global entry.
    expect(store.list(S1).map(f => f.path)).toEqual(['/repo/a.txt'])
    expect(store.list(S2).map(f => f.path)).toEqual(['/repo/a.txt'])
    expect(store.size).toBe(1)
  })

  it('keeps the dot up while more changes arrive, and takes it down when the reader acts', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ unseen: true, oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    // A second agent capture: nothing has been looked at, so the dot stays up.
    store.fold(entry({ oldText: 'v2', newText: 'v3', updatedAt: 20 }))
    expect(store.get('/repo/a.txt')?.unseen).toBe(true)
    // A block keep / revert / refresh is the reader acting on the row: the dot goes out.
    store.update('/repo/a.txt', { oldText: 'v3' })
    expect(store.get('/repo/a.txt')?.unseen).toBe(false)
  })

  it('marks a path seen without touching its content, and only once', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ unseen: true, oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.markSeen('/repo/a.txt')).toBe(true)
    expect(store.get('/repo/a.txt')).toMatchObject({ unseen: false, oldText: 'v1', newText: 'v2' })
    expect(store.markSeen('/repo/a.txt')).toBe(false)
    expect(store.markSeen('/repo/absent.txt')).toBe(false)
  })

  it('lets an undo restore content without reviving the dot', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ unseen: true, oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    const content = { ...store.get('/repo/a.txt')! }
    store.markSeen('/repo/a.txt')
    // `unseen` is deliberately not part of a snapshot, and the live answer wins even when one carries it:
    // an undo restores CONTENT, and whether the reader has looked at a change is not content.
    store.restore({ ...content, unseen: true })
    expect(store.get('/repo/a.txt')).toMatchObject({ unseen: false, oldText: 'v1', newText: 'v2' })
  })

  it('lights the dot only when a capture says so', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    expect(store.get('/repo/a.txt')?.unseen).toBe(undefined)
    store.fold(entry({ unseen: true, oldText: 'v2', newText: 'v3', updatedAt: 20 }))
    expect(store.get('/repo/a.txt')?.unseen).toBe(true)
  })

  it('raises the dot again for a change nobody asked for', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    // The list read adopts a file an outside writer changed: `update` took the dot down as the reader's own
    // action, and the adoption is exactly what the dot is for.
    store.update('/repo/a.txt', { newText: 'v9' })
    expect(store.markUnseen('/repo/a.txt')).toBe(true)
    expect(store.get('/repo/a.txt')).toMatchObject({ unseen: true, newText: 'v9' })
    expect(store.markUnseen('/repo/a.txt')).toBe(false)
  })

  it('does not bring the dot back when an undo re-lists a removed entry', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ unseen: true, oldText: 'v1', newText: 'v2', updatedAt: 10 }))
    const snapshot = { ...store.get('/repo/a.txt')! }
    store.remove('/repo/a.txt')
    // An undo of a removal replays a snapshot with no live entry to consult, and a snapshot restores
    // CONTENT: re-listing the row must not raise a dot the reader never cleared.
    store.restore(snapshot)
    expect(store.get('/repo/a.txt')).toMatchObject({ oldText: 'v1', newText: 'v2' })
    expect(store.get('/repo/a.txt')?.unseen).not.toBe(true)
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
  it('scopes entries to the touching session and orders by the oldest capture first', () => {
    const store = new PendingDiffStore()
    store.fold(entry({ path: '/repo/b.txt', updatedAt: 30 }))
    store.fold(entry({ sessionId: S2, path: '/repo/c.txt', updatedAt: 20 }))
    store.fold(entry({ path: '/repo/a.txt', updatedAt: 10 }))
    expect(store.list(S1).map(file => file.path)).toEqual(['/repo/a.txt', '/repo/b.txt'])
    expect(store.list(S2).map(file => file.path)).toEqual(['/repo/c.txt'])
    expect(store.list(SessionId('empty'))).toEqual([])
  })
})

describe('PendingDiffStore.remove', () => {
  it('removes only the named path', () => {
    const store = new PendingDiffStore()
    store.fold(entry())
    store.fold(entry({ path: '/repo/b.txt' }))
    expect(store.remove('/repo/a.txt')).toBe(true)
    expect(store.remove('/repo/a.txt')).toBe(false)
    expect(store.get('/repo/b.txt')).toBeDefined()
    // A fresh operation to the removed path starts a new entry.
    expect(store.fold(entry({ oldText: 'x', newText: 'y' }))).toBe(true)
    expect(store.get('/repo/a.txt')?.oldText).toBe('x')
  })
})

describe('PendingDiffStore.hydrate', () => {
  it('folds persisted entries per path, oldest first', () => {
    const store = new PendingDiffStore()
    store.hydrate([
      entry({ oldText: 'v1', newText: 'v2', updatedAt: 10 }),
      entry({ oldText: 'v2', newText: 'v3', updatedAt: 20 }),
    ])
    expect(store.size).toBe(1)
    expect(store.get('/repo/a.txt')).toEqual(expect.objectContaining({ oldText: 'v1', newText: 'v3' }))
  })

  it('keeps a newer live fold over a stale hydrate for the same path', () => {
    const store = new PendingDiffStore()
    store.hydrate([entry({ oldText: 'stale-old', newText: 'stale-new', updatedAt: 10 })])
    store.fold(entry({ oldText: 'live-old', newText: 'live-new', updatedAt: 20 }))
    expect(store.get('/repo/a.txt')?.newText).toBe('live-new')
  })

  it('preserves every touching session across hydration', () => {
    const store = new PendingDiffStore()
    store.hydrate([entry({ sessionId: S2, newText: 'b' }), entry({ sessionId: S1, oldText: 'x', newText: 'y' })])
    expect(store.list(S1).map(f => f.path)).toEqual(['/repo/a.txt'])
    expect(store.list(S2).map(f => f.path)).toEqual(['/repo/a.txt'])
    expect(store.get('/repo/a.txt')?.sessionIds).toEqual([S2, S1])
  })
})
