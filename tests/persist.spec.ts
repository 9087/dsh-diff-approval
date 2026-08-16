// PendingPersistence: durable workspace files under a storage root.

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
  return { id: `${path}:${updatedAt}`, sessionId, path, kind, oldText: 'old', newText: 'new', updatedAt }
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

describe('load', () => {
  it('reads an absent workspace file as empty', async () => {
    await expect((await persistence()).load('workspace-1', String(S1))).resolves.toEqual([])
  })

  it('round-trips saved entries, oldest capture first', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/b.txt', 2), entry(S1, '/repo/a.txt', 1)])
    await expect(store.load('workspace-1', String(S1))).resolves.toEqual([
      entry(S1, '/repo/a.txt', 1),
      entry(S1, '/repo/b.txt', 2),
    ])
  })

  it('round-trips a creation entry with its kind', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/new.txt', 1, 'create')])
    const loaded = await store.load('workspace-1', String(S1))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.kind).toBe('create')
  })

  it('skips malformed rows inside an otherwise valid file', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/a.txt')])
    const file = join(root, 'workspace-1.json')
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { sessions: Record<string, unknown[]> }
    parsed.sessions[String(S1)]!.push({ path: 42 })
    await writeFile(file, JSON.stringify(parsed), 'utf8')
    await expect(store.load('workspace-1', String(S1))).resolves.toEqual([entry(S1, '/repo/a.txt')])
  })

  it('throws on a corrupt file and on an unsupported version', async () => {
    const store = await persistence()
    const file = join(root, 'workspace-1.json')
    await writeFile(file, '{not json', 'utf8')
    await expect(store.load('workspace-1', String(S1))).rejects.toThrow(/not valid JSON/)
    await writeFile(file, JSON.stringify({ version: 99, sessions: {} }), 'utf8')
    await expect(store.load('workspace-1', String(S1))).rejects.toThrow(/version/)
  })

  it('rejects the previous on-disk format', async () => {
    const store = await persistence()
    const file = join(root, 'workspace-1.json')
    await writeFile(file, JSON.stringify({ version: 1, sessions: {} }), 'utf8')
    await expect(store.load('workspace-1', String(S1))).rejects.toThrow(/version/)
  })
})

describe('save', () => {
  it('preserves sibling sessions when replacing one session', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/a.txt')])
    await store.save('workspace-1', String(S2), [entry(S2, '/repo/b.txt')])
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/a.txt', 9), entry(S1, '/repo/c.txt', 10)])
    await expect(store.load('workspace-1', String(S1))).resolves.toEqual([
      entry(S1, '/repo/a.txt', 9),
      entry(S1, '/repo/c.txt', 10),
    ])
    await expect(store.load('workspace-1', String(S2))).resolves.toEqual([entry(S2, '/repo/b.txt')])
  })

  it('drops the file when the last session empties', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/a.txt')])
    await store.save('workspace-1', String(S1), [])
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('removes one emptied session but keeps the sibling', async () => {
    const store = await persistence()
    await store.save('workspace-1', String(S1), [entry(S1, '/repo/a.txt')])
    await store.save('workspace-1', String(S2), [entry(S2, '/repo/b.txt')])
    await store.save('workspace-1', String(S1), [])
    await expect(store.load('workspace-1', String(S1))).resolves.toEqual([])
    await expect(store.load('workspace-1', String(S2))).resolves.toEqual([entry(S2, '/repo/b.txt')])
  })
})
