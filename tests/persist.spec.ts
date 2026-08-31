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

function entry(sessionId: SessionId, path: string, updatedAt = 1, kind: 'edit' | 'create' = 'edit'): PendingEntry {
  return { id: path, sessionId, path, kind, oldText: 'old', newText: 'new', updatedAt, sessionIds: [sessionId] }
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

  it('round-trips saved entries, oldest capture first', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/b.txt', 2), entry(S1, '/repo/a.txt', 1)])
    const { entries, migratedLegacy } = await store.loadAll()
    expect(entries).toEqual([entry(S1, '/repo/a.txt', 1), entry(S1, '/repo/b.txt', 2)])
    expect(migratedLegacy).toBe(false)
  })

  it('round-trips a creation entry with its kind', async () => {
    const store = await persistence()
    await store.save([entry(S1, '/repo/new.txt', 1, 'create')])
    const { entries } = await store.loadAll()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('create')
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
