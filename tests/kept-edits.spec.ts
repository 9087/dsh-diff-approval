// The reader's own edits: the unified diff an agent is handed, and the durable queue it waits in.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  KeptEditQueue,
  MAX_KEPT_EDIT_DIFF_CHARS,
  boundedDiff,
  keptEditsDirFor,
  renderKeptEdits,
  unifiedDiffFor,
} from '../src/kept-edits.ts'
import { removeTempDir } from './cleanup.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDir))
})

/** A fresh directory for one case's queue files. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kept-edits-'))
  tempDirs.push(dir)
  return dir
}

describe('unifiedDiffFor', () => {
  it('renders a standard unified diff for one file', () => {
    const diff = unifiedDiffFor('src/x.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n')
    expect(diff).toBe([
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '+four',
    ].join('\n'))
  })

  it('returns nothing for identical content, so a keep that changed nothing appends nothing', () => {
    expect(unifiedDiffFor('src/x.ts', 'same\n', 'same\n')).toBe('')
  })

  it('carries the no-trailing-newline marker where a unified diff expects it', () => {
    const diff = unifiedDiffFor('src/x.ts', 'one\ntwo\n', 'one\nTWO')
    expect(diff).toContain('\\ No newline at end of file')
  })

  it('renders a creation and an emptied file as hunks against zero lines', () => {
    expect(unifiedDiffFor('src/new.ts', '', 'line\n')).toContain('@@ -1,0 +1,1 @@')
    expect(unifiedDiffFor('src/gone.ts', 'line\n', '')).toContain('@@ -1,1 +1,0 @@')
  })
})

describe('boundedDiff', () => {
  it('keeps a diff that fits exactly as it is', () => {
    const diff = unifiedDiffFor('src/x.ts', 'a\n', 'b\n')
    expect(boundedDiff(diff)).toBe(diff)
  })

  it('cuts an over-long diff on a line boundary and says how much is left out', () => {
    // Twice the budget in whole lines, so the cut has something substantial to leave out.
    const huge = Array.from({ length: Math.ceil((MAX_KEPT_EDIT_DIFF_CHARS * 2) / 8) }, (_, index) => `+line ${index}`).join('\n')
    const bounded = boundedDiff(huge)
    expect(bounded.length).toBeLessThan(huge.length)
    expect(bounded).toContain('is omitted; read the file for the full change.')
    // The cut lands after a newline: the marker is its own line, never glued onto a hunk's own line.
    expect(bounded.split('\n').at(-1)).toMatch(/^… the rest of this diff \(\d+ more characters\)/)
  })
})

describe('renderKeptEdits', () => {
  it('leads with what the block is, then one headed section per file', () => {
    const text = renderKeptEdits([
      { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'old\n', userText: 'new\n', diff: '--- a/a.ts\n+++ b/a.ts', at: 1 },
      { path: '/ws/b.ts', displayPath: 'dir/b.ts', agentText: '', userText: 'x\n', diff: '--- a/dir/b.ts\n+++ b/dir/b.ts', at: 2 },
    ])
    expect(text).toContain('The user edited and kept the pending change(s) below')
    expect(text).toContain('### a.ts\n--- a/a.ts\n+++ b/a.ts')
    expect(text).toContain('### dir/b.ts\n--- a/dir/b.ts\n+++ b/dir/b.ts')
    // One file's section never runs into the next one's.
    expect(text.indexOf('### a.ts')).toBeLessThan(text.indexOf('### dir/b.ts'))
  })

  it('renders nothing at all when nothing is queued', () => {
    expect(renderKeptEdits([])).toBe('')
  })
})

describe('keptEditsDirFor', () => {
  it('sits beside the pending store and the comments under the plugin home', () => {
    expect(keptEditsDirFor('/home/u/.dsh/diff-approval/workspaces')).toBe('/home/u/.dsh/diff-approval/kept-edits')
  })

  it('stays inside a state directory that is itself the root', () => {
    expect(keptEditsDirFor('/tmp/state')).toBe('/tmp/state/kept-edits')
  })
})

describe('KeptEditQueue', () => {
  it('queues one file and renders its diff for that session\'s agent alone', async () => {
    const queue = new KeptEditQueue(await tempDir())
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    expect(queue.textFor(S1)).toContain('+user')
    expect(queue.textFor(S1)).toContain('-agent')
    // Another session's assembly is told nothing: the queue is that session's own conversation.
    expect(queue.textFor(S2)).toBe('')
  })

  it('keeps the FIRST baseline on a second keep, so the diff stays cumulative', async () => {
    const queue = new KeptEditQueue(await tempDir())
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'first\n' })
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'first\n', userText: 'second\n' })
    const text = queue.textFor(S1)
    // Against what the AGENT wrote, not against the reader's own previous draft.
    expect(text).toContain('-agent')
    expect(text).toContain('+second')
    expect(text).not.toContain('-first')
    expect(text).not.toContain('+first')
    // One path is one section: a second keep replaces it rather than queueing beside it.
    expect(text.match(/### /g)).toHaveLength(1)
  })

  it('queues several files, and drops only the one a revert took back', async () => {
    const queue = new KeptEditQueue(await tempDir())
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'a0\n', userText: 'a1\n' })
    await queue.keep(S1, { path: '/ws/b.ts', displayPath: 'b.ts', agentText: 'b0\n', userText: 'b1\n' })
    expect(queue.textFor(S1).match(/### /g)).toHaveLength(2)
    expect(queue.withdraw('/ws/a.ts')).toBe(true)
    expect(queue.textFor(S1)).not.toContain('a.ts')
    expect(queue.textFor(S1)).toContain('b.ts')
    // Nothing is queued for a path that was never kept, so a revert of it finds nothing to drop.
    expect(queue.withdraw('/ws/c.ts')).toBe(false)
  })

  it('consumes the queue at the model request, so the snapshot can return to its baseline', async () => {
    const queue = new KeptEditQueue(await tempDir())
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    expect(queue.textFor(S1)).not.toBe('')
    await queue.markDelivered(S1)
    expect(queue.textFor(S1)).toBe('')
    // A session with nothing queued is not written again by a request that carries nothing.
    await queue.markDelivered(S1)
    expect(queue.textFor(S1)).toBe('')
  })

  it('survives a restart: the next queue reads what the last one wrote', async () => {
    const dir = await tempDir()
    const first = new KeptEditQueue(dir)
    await first.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    await first.settled()
    const file = join(dir, `${encodeURIComponent(String(S1))}.json`)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; records: { displayPath: string }[] }
    expect(stored.version).toBe(1)
    expect(stored.records[0]?.displayPath).toBe('a.ts')

    // A new process (a restarted host) reads the same directory before the agent's first call.
    const second = new KeptEditQueue(dir)
    expect(await second.loadAll()).toBe(1)
    expect(second.textFor(S1)).toContain('+user')
    expect(second.textFor(S1)).toContain('### a.ts')
  })

  it('reads one session\'s file on demand, for a queue that was never preloaded', async () => {
    const dir = await tempDir()
    const first = new KeptEditQueue(dir)
    await first.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    await first.settled()

    const second = new KeptEditQueue(dir)
    await second.ensureLoaded(S1)
    expect(second.recordsOf(S1)).toHaveLength(1)
  })

  it('keeps a good queue when another session\'s file is unreadable, and names the file', async () => {
    const dir = await tempDir()
    const good = new KeptEditQueue(dir)
    await good.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    await good.settled()
    await writeFile(join(dir, `${encodeURIComponent(String(S2))}.json`), '{ not json', 'utf8')
    const skipped = vi.fn()
    const queue = new KeptEditQueue(dir, { onLoadSkipped: skipped })
    expect(await queue.loadAll()).toBe(1)
    expect(skipped).toHaveBeenCalledTimes(1)
    expect(queue.textFor(S1)).toContain('+user')
  })

  it('reports a write it could not make, so the reader is not left believing the agent was told', async () => {
    // A directory where the queue file's parent should be: every write fails, and the seam says so.
    const dir = await tempDir()
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    const reports: (string | undefined)[] = []
    const queue = new KeptEditQueue(blocked, { onPersistError: message => { reports.push(message) } })
    await queue.keep(S1, { path: '/ws/a.ts', displayPath: 'a.ts', agentText: 'agent\n', userText: 'user\n' })
    await queue.settled()
    expect(reports.some(message => message !== undefined && message.includes('blocked'))).toBe(true)
    // The keep itself is in memory either way: the panel's answer is about the file, not the queue.
    expect(queue.textFor(S1)).toContain('+user')
  })
})
