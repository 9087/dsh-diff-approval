// PendingPersistence: a single global file plus legacy per-workspace migration.

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PendingEntry } from '../src/types.ts'
import { PendingPersistence } from '../src/persist.ts'
import { removeTempDir } from './cleanup.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

function entry(sessionId: SessionId, path: string, updatedAt = 1, earlierVersion: 'file' | 'none' = 'file'): PendingEntry {
  return { id: path, sessionId, path, earlierVersion, oldText: 'old', newText: 'new', updatedAt, sessionIds: [sessionId] }
}

/**
 * One raw v3 row, exactly as a build that predates the `lineage` field left it in the file.
 *
 * Deliberately not built from {@link entry}: a round trip through this package's own types would write
 * the field the case is about, and the point is what a file on disk WITHOUT it does.
 */
function rawRow(path: string): Record<string, unknown> {
  return {
    id: path, path, earlierVersion: 'file', oldText: 'old', newText: 'new', updatedAt: 1,
    sessionId: 'session-1', sessionIds: ['session-1'],
  }
}

let root = ''
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDir))
})

async function persistence(): Promise<PendingPersistence> {
  root = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-persist-'))
  roots.push(root)
  return new PendingPersistence(root)
}

describe('loadAll', () => {
  it('reads an absent store file as empty', async () => {
    await expect((await persistence()).loadAll()).resolves.toEqual({ entries: [], migratedLegacy: false })
  })

  it('creates the storage directory on a path spelled with the platform separators', async () => {
    // The Windows storage root is `C:\Users\<user>\.dsh\diff-approval\workspaces` — no forward slash
    // anywhere. A helper that scanned for the last `/` answered `.`, the mkdir before every write became
    // a no-op and the write itself threw ENOENT, so no pending change was ever persisted there and the
    // list was empty again after a restart (issue #6). `node:path` knows this machine's separators; the
    // root here does not exist yet, which is the case that tells the two apart.
    await persistence()
    const store = new PendingPersistence(join(root, 'workspaces'))
    await store.save([entry(S1, '/repo/a.txt')])
    await expect(readFile(join(root, 'workspaces', 'pending.json'), 'utf8')).resolves.toContain('/repo/a.txt')
    await expect(store.loadAll()).resolves.toMatchObject({ entries: [entry(S1, '/repo/a.txt')] })
  })

  it('round-trips saved entries, oldest capture first', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/b.txt', 2), entry(S1, '/repo/a.txt', 1)])
    const { entries, migratedLegacy } = await store.loadAll()
    expect(entries).toEqual([entry(S1, '/repo/a.txt', 1), entry(S1, '/repo/b.txt', 2)])
    expect(migratedLegacy).toBe(false)
  })

  it('round-trips an entry with no earlier version', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/new.txt', 1, 'none')])
    const { entries } = await store.loadAll()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.earlierVersion).toBe('none')
  })

  it('loads a store written before the field was renamed', async () => {
    // Reading only the new spelling would drop every row of an existing list on the first start after an
    // upgrade — silently, because a rejected row is skipped rather than reported. A real store on this
    // machine held 252 rows in the old spelling, so this is the difference between the reader's whole
    // review and an empty panel.
    const store = await persistence()
    await writeFile(join(root, 'pending.json'), JSON.stringify({
      version: 3,
      entries: [
        {
          id: '/repo/a.txt', sessionId: 'session-1', path: '/repo/a.txt', kind: 'edit',
          oldText: 'old', newText: 'new', updatedAt: 1, sessionIds: ['session-1'],
        },
        {
          id: '/repo/b.txt', sessionId: 'session-1', path: '/repo/b.txt', kind: 'create',
          oldText: '', newText: 'fresh', updatedAt: 2, sessionIds: ['session-1'],
        },
      ],
    }), 'utf8')

    const { entries } = await store.loadAll()
    expect(entries.map(saved => [saved.path, saved.earlierVersion]))
      .toEqual([['/repo/a.txt', 'file'], ['/repo/b.txt', 'none']])
  })

  it('skips malformed rows inside an otherwise valid global file', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/a.txt')])
    const file = join(root, 'pending.json')
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries: unknown[] }
    parsed.entries.push({ path: 42 })
    await writeFile(file, JSON.stringify(parsed), 'utf8')
    const { entries } = await store.loadAll()
    expect(entries).toEqual([entry(S1, '/repo/a.txt', 1)])
  })

  it('throws on a corrupt file and on an unsupported version', async () => {
    const store = await persistence()
    const file = join(root, 'pending.json')
    await writeFile(file, '{not json', 'utf8')
    await expect(store.loadAll()).rejects.toThrow(/not valid JSON/)
    await writeFile(file, JSON.stringify({ version: 99, entries: [] }), 'utf8')
    await expect(store.loadAll()).rejects.toThrow(/version/)
  })

  it('migrates legacy per-workspace files into the global store', async () => {
    const store = await persistence()
    const legacyFile = join(root, 'workspace-1.json')
    await writeFile(legacyFile, JSON.stringify({
      version: 2,
      sessions: { [String(S1)]: [entry(S1, '/repo/a.txt', 1)] },
    }), 'utf8')
    const { entries, migratedLegacy } = await store.loadAll()
    expect(migratedLegacy).toBe(true)
    expect(entries).toEqual([entry(S1, '/repo/a.txt', 1)])
    // A save finalizes the migration: the global file exists, legacy is gone.
    await store.save(entries)
    expect(await readdir(root)).toEqual(['pending.json'])
  })
})

describe('save', () => {
  it('replaces the whole global entry set', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/a.txt')])
    await store.save([entry(S1, '/repo/a.txt', 1), entry(S2, '/repo/b.txt', 2)])
    const { entries } = await store.loadAll()
    expect(entries).toEqual([entry(S1, '/repo/a.txt', 1), entry(S2, '/repo/b.txt', 2)])
  })

  it('writes an empty entry set durably', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/a.txt')])
    await store.save([])
    const { entries } = await store.loadAll()
    expect(entries).toEqual([])
  })
})

describe('the optional lineage field', () => {
  it('loads a record written before entries carried a lineage, and saves it back without one', async () => {
    // The field is additive: a file from a build that never wrote it must load as an entry that simply has
    // no lineage, stay usable, and be written back the same way. Nothing may gain a guessed parent, and the
    // version stays 3 — this is not a schema change, it is an extra optional key.
    const store = await persistence()
    await writeFile(join(root, 'pending.json'), JSON.stringify({ version: 3, entries: [rawRow('/repo/old.txt')] }), 'utf8')
    const { entries } = await store.loadAll()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('/repo/old.txt')
    expect(entries[0]!.lineage).toBeUndefined()
    await store.save(entries)
    const rewritten = JSON.parse(await readFile(join(root, 'pending.json'), 'utf8')) as { entries: Record<string, unknown>[] }
    expect(rewritten.entries[0]).not.toHaveProperty('lineage')
    expect((await store.loadAll()).entries).toHaveLength(1)
  })

  it('round-trips the lineage a captured entry recorded', async () => {
    const store = await persistence()
    await store.save([{
      ...entry(S1, '/repo/child.txt'),
      lineage: { parentSessionId: SessionId('session-root'), origin: 'subagent', delegationDepth: 1, cwd: '/repo' },
    }])
    const { entries } = await store.loadAll()
    expect(entries[0]!.lineage).toEqual({
      parentSessionId: 'session-root', origin: 'subagent', delegationDepth: 1, cwd: '/repo',
    })
  })

  it('keeps only the parts a row actually carries, and none at all when it carries nothing usable', async () => {
    // "Not known" has ONE spelling on disk: a row whose parts are all missing or the wrong shape loads with
    // no lineage rather than an empty object, so a reader cannot mistake a truncated row for a full one.
    const store = await persistence()
    await writeFile(join(root, 'pending.json'), JSON.stringify({
      version: 3,
      entries: [
        { ...rawRow('/repo/empty.txt'), lineage: {} },
        { ...rawRow('/repo/wrong.txt'), lineage: { parentSessionId: '', delegationDepth: 'one', cwd: 7, origin: 1 } },
        { ...rawRow('/repo/partial.txt'), lineage: { cwd: '/repo' } },
      ],
    }), 'utf8')
    const { entries } = await store.loadAll()
    const byPath = new Map(entries.map(loaded => [loaded.path, loaded]))
    expect(byPath.get('/repo/empty.txt')!.lineage).toBeUndefined()
    expect(byPath.get('/repo/wrong.txt')!.lineage).toBeUndefined()
    // The one part that IS usable is kept, and the parts that are not are simply absent — never invented.
    expect(byPath.get('/repo/partial.txt')!.lineage?.cwd).toBe('/repo')
    expect(byPath.get('/repo/partial.txt')!.lineage?.parentSessionId).toBeUndefined()
    expect(byPath.get('/repo/partial.txt')!.lineage?.origin).toBeUndefined()
    expect(byPath.get('/repo/partial.txt')!.lineage?.delegationDepth).toBeUndefined()
  })
})
