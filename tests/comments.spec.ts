// CommentStore: per-session comment files, and the two guards that keep a comment
// from outliving the pending entry it hangs off.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CommentRecord } from '../src/types.ts'
import { CommentStore, commentsDirFor } from '../src/comments.ts'
import { removeTempDir } from './cleanup.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

/** One stored comment, with only the fields a test cares about overridden. */
function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: 'c1',
    sessionId: S1,
    entryId: '/repo/a.txt',
    path: '/repo/a.txt',
    anchor: { startLine: 3, endLine: 4 },
    quote: 'const a = 1',
    text: 'why is this here?',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const roots: string[] = []
let root = ''

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDir))
})

async function store(): Promise<CommentStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-comments-'))
  roots.push(root)
  return new CommentStore(root)
}

describe('commentsDirFor', () => {
  it('puts the plugin home\'s comments beside its workspaces, not inside them', () => {
    // The approved layout: the pending file lives in `<home>/diff-approval/workspaces`
    // and comments in `<home>/diff-approval/comments` — siblings, so a failed write on
    // one side cannot take the other with it.
    expect(commentsDirFor(join('C:', 'Users', 'u', '.dsh', 'diff-approval', 'workspaces')))
      .toBe(join('C:', 'Users', 'u', '.dsh', 'diff-approval', 'comments'))
  })

  it('keeps an arbitrary root\'s comments inside it, so two instances cannot share one file', () => {
    // A configured `storageDir` is a self-contained state directory. Its sibling would
    // be `dirname(root)`, which two instances pointed at sibling directories share —
    // and two instances writing one comment file is a leak, not a layout choice.
    expect(commentsDirFor(join(tmpdir(), 'instance-a'))).toBe(join(tmpdir(), 'instance-a', 'comments'))
  })
})

describe('loadAll', () => {
  it('reads an absent directory as empty', async () => {
    await expect((await store()).loadAll()).resolves.toBe(0)
  })

  it('round-trips a comment through its session file', async () => {
    const first = await store()
    first.add(comment({ quoteContext: 'before\nafter', quoteLines: [{ old: 3, new: 3, kind: 'add' }] }))
    await first.settled()
    const second = new CommentStore(root)
    await expect(second.loadAll()).resolves.toBe(1)
    expect(second.list(S1)).toEqual([
      comment({ quoteContext: 'before\nafter', quoteLines: [{ old: 3, new: 3, kind: 'add' }] }),
    ])
  })

  it('keeps each session in its own file, and lists only that session', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', sessionId: S2, entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(S1).map(entry => entry.id)).toEqual(['c1'])
    expect(second.list(S2).map(entry => entry.id)).toEqual(['c2'])
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('/repo/a.txt')
    await expect(readFile(join(root, `${S2}.json`), 'utf8')).resolves.toContain('/repo/b.txt')
  })

  it('skips a malformed row instead of failing the load', async () => {
    await store()
    await writeFile(join(root, `${S1}.json`), JSON.stringify({
      version: 1,
      comments: [{ id: 'broken' }, comment({ id: 'c9' })],
    }), 'utf8')
    const comments = new CommentStore(root)
    await expect(comments.loadAll()).resolves.toBe(1)
    expect(comments.list(S1).map(entry => entry.id)).toEqual(['c9'])
  })

  it('keeps every other session\'s comments when one file is unreadable', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', sessionId: S2, entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    await comments.settled()
    // A file whose bytes are not JSON at all — the shape a torn write or a hand edit
    // leaves behind. It costs its own session's comments and nothing else.
    await writeFile(join(root, `${S1}.json`), '{ not json', 'utf8')
    const warnings: string[] = []
    const second = new CommentStore(root, { onLoadSkipped: file => warnings.push(file) })
    await expect(second.loadAll()).resolves.toBe(1)
    expect(second.list(S2).map(entry => entry.id)).toEqual(['c2'])
    expect(second.list(S1)).toEqual([])
    // The bad file is named, and it is not silently dropped from the disk: it is moved
    // aside, so the store can write a fresh file for that session without the next save
    // being what destroys the unreadable bytes.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${S1}.json`)
    await expect(readFile(join(root, `${S1}.json.corrupt`), 'utf8')).resolves.toBe('{ not json')
    // The good session's file is untouched by the skip, and a later save for the bad
    // session writes a fresh file rather than emptying the good one.
    second.add(comment({ id: 'c9', text: 'written after the skip' }))
    await second.settled()
    await expect(readFile(join(root, `${S2}.json`), 'utf8')).resolves.toContain('c2')
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('c9')
  })

  it('loads nothing, reports the file, and stays writable when the only file is corrupt', async () => {
    await store()
    await writeFile(join(root, `${S1}.json`), 'not a comment file at all', 'utf8')
    const warnings: string[] = []
    const comments = new CommentStore(root, { onLoadSkipped: file => warnings.push(file) })
    await expect(comments.loadAll()).resolves.toBe(0)
    expect(warnings).toHaveLength(1)
    // Writable: a fresh annotation for that session still lands on the disk, which is
    // what "empty but writable" means when the file it could not read is out of the way.
    comments.add(comment({ id: 'c9' }))
    await comments.settled()
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('c9')
  })

  it('names the files a load skipped, so the caller can report what went missing', async () => {
    await store()
    await writeFile(join(root, `${S1}.json`), JSON.stringify({ version: 99, comments: [] }), 'utf8')
    const comments = new CommentStore(root)
    await expect(comments.loadAll()).resolves.toBe(0)
    expect(comments.skippedFiles()).toEqual([join(root, `${S1}.json`)])
  })

  it('refuses to write a session whose unreadable file could not be moved aside', async () => {
    await store()
    const file = join(root, `${S1}.json`)
    // The file that cannot be read… and the quarantine cannot happen either: a non-empty
    // directory already holds the name it would be moved to, so the rename fails
    // (EPERM on Windows, EISDIR/ENOTEMPTY elsewhere). Those bytes are the only copy of
    // that session's threads, and "skipped but still writable" would mean the next save
    // in that session TRUNCATES them — the skip would be what destroyed the comments.
    await writeFile(file, '{ not json', 'utf8')
    await mkdir(`${file}.corrupt`, { recursive: true })
    await writeFile(join(`${file}.corrupt`, 'in the way'), 'x', 'utf8')

    const warnings: string[] = []
    const comments = new CommentStore(root, { onLoadSkipped: skipped => warnings.push(skipped) })
    await expect(comments.loadAll()).resolves.toBe(0)
    expect(warnings).toEqual([file])
    expect(comments.skippedFiles()).toEqual([file])

    const stored = comments.add(comment())
    await comments.settled()
    // The annotation is still usable in memory, and the reader is told it is only there…
    expect(comments.list(S1).map(entry => entry.id)).toEqual([stored.id])
    expect(String(comments.persistError())).toContain(`${S1}.json`)
    // …while the bytes the load could not read are still on the disk, untouched.
    await expect(readFile(file, 'utf8')).resolves.toBe('{ not json')
  })
})

describe('a comment write that fails', () => {
  it('reports the failure, keeps the comment in memory, and retracts the report after a good save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-comments-'))
    roots.push(dir)
    // A root that cannot be created: a plain FILE holds the name the comment directory
    // would take, so every write under it fails with ENOTDIR.
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    const errors: string[] = []
    const comments = new CommentStore(blocked, { onPersistError: message => errors.push(message) })
    const stored = comments.add(comment())
    await comments.settled()
    // The annotation is in memory and usable: the list read the panel draws from still
    // shows it. That much was true before the fix too — the difference is that the
    // failure is now recorded rather than swallowed.
    expect(comments.list(S1).map(entry => entry.id)).toEqual([stored.id])
    expect(errors).toHaveLength(1)
    expect(comments.persistError()).toBe(errors[0])

    // A second failing write says the same thing once, not twice.
    comments.add(comment({ id: 'c2' }))
    await comments.settled()
    expect(errors).toHaveLength(1)

    // The disk works again: the next successful save retracts the report, exactly the
    // way the pending half retracts its own on a write that works.
    await rm(blocked, { force: true })
    root = blocked
    comments.add(comment({ id: 'c3' }))
    await comments.settled()
    expect(comments.persistError()).toBeUndefined()
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('c3')
  })

  it('keeps one session\'s failure reported while another session\'s write works', async () => {
    const comments = await store()
    // S1's file name is held by a non-empty directory, so the atomic rename onto it fails
    // while S2 — the same root, a different file — writes normally. One broken session and
    // one healthy one is the ordinary shape (a locked file, a full disk quota).
    await mkdir(join(root, `${S1}.json`), { recursive: true })
    await writeFile(join(root, `${S1}.json`, 'keep'), 'x', 'utf8')
    const errors: (string | undefined)[] = []
    const second = new CommentStore(root, { onPersistError: message => errors.push(message) })
    second.add(comment())
    await second.settled()
    expect(String(second.persistError())).toContain(`${S1}.json`)

    // The other session's write works. That must not retract S1's report: the reader
    // would then be told the threads are safe while S1's live in memory only — exactly
    // the "a failure that looks like a success" trap, one session over.
    second.add(comment({ id: 'c2', sessionId: S2, entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    await second.settled()
    await expect(readFile(join(root, `${S2}.json`), 'utf8')).resolves.toContain('c2')
    expect(String(second.persistError())).toContain(`${S1}.json`)
    expect(errors).toHaveLength(1)

    // S1's own path works again: its own success is what retracts its report.
    await rm(join(root, `${S1}.json`), { recursive: true, force: true })
    second.add(comment({ id: 'c3' }))
    await second.settled()
    expect(second.persistError()).toBeUndefined()
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('c3')
  })
})

describe('the two guards against a comment outliving its entry', () => {
  it('drops every comment of the entry that left, and only that entry', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', sessionId: S2 }))
    comments.add(comment({ id: 'c3', entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    expect(comments.removeForEntry('/repo/a.txt')).toBe(2)
    expect(comments.list(S1).map(entry => entry.id)).toEqual(['c3'])
    expect(comments.list(S2)).toEqual([])
    // The removal reaches the disk: a second client reading the file back must not
    // find what the first one deleted.
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')).toBeUndefined()
    expect(second.list(S1).map(entry => entry.id)).toEqual(['c3'])
  })

  it('sweeps the orphans of entries that are not in the list at all', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    // The backstop for a crash between the entry's removal and the comments': the
    // entry set is the authority on what may still have comments.
    expect(comments.retain(new Set(['/repo/b.txt']))).toBe(1)
    expect(comments.list(S1).map(entry => entry.id)).toEqual(['c2'])
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(S1).map(entry => entry.id)).toEqual(['c2'])
  })

  it('leaves everything alone when every entry is still listed', async () => {
    const comments = await store()
    comments.add(comment())
    expect(comments.retain(new Set(['/repo/a.txt']))).toBe(0)
    expect(comments.list(S1)).toHaveLength(1)
  })
})

describe('mutations', () => {
  it('refuses to remove a comment through another session', async () => {
    const comments = await store()
    comments.add(comment())
    expect(comments.remove(S2, 'c1')).toBe(false)
    expect(comments.list(S1)).toHaveLength(1)
    expect(comments.remove(S1, 'c1')).toBe(true)
    expect(comments.list(S1)).toEqual([])
  })

  it('records the questions asked in a thread, with their own words, and never an answer', async () => {
    const comments = await store()
    comments.add(comment())
    expect(comments.recordAsk(S1, 'c1', 'req-7', 4, 'why?')).toBe(true)
    expect(comments.get('c1')).toMatchObject({ asks: [{ requestId: 'req-7', text: 'why?', turn: 4 }] })
    // An ask for a comment that is not there changes nothing (a removed entry's
    // comment can lose the race, and the answer then has nowhere to land).
    expect(comments.recordAsk(S1, 'gone', 'req-8', 5, 'anyone?')).toBe(false)
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    // The words survive the file, which is the point of keeping them: the transcript holds the
    // prompt that WRAPS them, so a follow-up's question exists nowhere else.
    expect(second.get('c1')).toMatchObject({ asks: [{ requestId: 'req-7', text: 'why?', turn: 4 }] })
  })

  it('keeps a thread\'s questions when its annotation is written again', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-7', 3, 'why?')
    // A retried write — a dropped response, or a second client sending the id it was
    // handed — is the SAME comment. Keeping the question is what lets its answer still
    // be matched back to this thread instead of the retry erasing the identity.
    const again = comments.add(comment({ text: 'why, though?', createdAt: 99, updatedAt: 99 }))
    expect(again.text).toBe('why, though?')
    // `createdAt` orders a list read, so a rewrite does not reorder the thread.
    expect(again.createdAt).toBe(1)
    expect(again.asks).toEqual([{ requestId: 'req-7', text: 'why?', turn: 3 }])
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')).toMatchObject({ text: 'why, though?', asks: [{ requestId: 'req-7', text: 'why?', turn: 3 }] })
  })

  it('fills in the turn a claim reported, and marks a dropped submission', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-7', undefined, 'why?')
    expect(comments.get('c1')?.asks).toEqual([{ requestId: 'req-7', text: 'why?' }])
    // A follow-up appends rather than replacing: a thread is a conversation, and each
    // question carries its own turn, its own words and its own answer.
    comments.recordAsk(S1, 'c1', 'req-9', undefined, 'and then?')
    expect(comments.get('c1')?.asks?.map(ask => ask.requestId)).toEqual(['req-7', 'req-9'])
    // The inbox claimed the first one: the turn is the fact the panel may state instead
    // of guessing whether two questions shared an answer. Writing the turn down must not
    // write over the question's own words — they ride the same record.
    expect(comments.recordTurnForRequest(S1, 'req-7', 3)).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-7', text: 'why?', turn: 3 },
      { requestId: 'req-9', text: 'and then?' },
    ])
    // A repeat of the same turn is not a change.
    expect(comments.recordTurnForRequest(S1, 'req-7', 3)).toBe(0)
    // Discarded before any turn took it: nothing is coming, so the reader is told.
    expect(comments.markDroppedForRequest(S1, 'req-9')).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-7', text: 'why?', turn: 3 },
      { requestId: 'req-9', text: 'and then?', dropped: true },
    ])
    expect(comments.markDroppedForRequest(S1, 'req-9')).toBe(0)
    // A request id nothing carries touches nothing.
    expect(comments.recordTurnForRequest(S1, 'req-other', 9)).toBe(0)
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')?.asks).toEqual([
      { requestId: 'req-7', text: 'why?', turn: 3 },
      { requestId: 'req-9', text: 'and then?', dropped: true },
    ])
  })

  it('stops the questions of a turn that ended, and only that turn', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-7', 3, 'why?')
    comments.recordAsk(S1, 'c1', 'req-9', 4, 'and then?')
    // The turn stopped: its question is over, so the panel may say the answer was cut
    // off instead of waiting on a turn that ended. The other question is untouched.
    expect(comments.markTurnEnded(S1, 3)).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-7', text: 'why?', turn: 3, ended: true },
      { requestId: 'req-9', text: 'and then?', turn: 4 },
    ])
    // A repeat changes nothing, and a turn nothing was claimed by touches nothing.
    expect(comments.markTurnEnded(S1, 3)).toBe(0)
    expect(comments.markTurnEnded(S1, 9)).toBe(0)
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')?.asks?.[0]).toMatchObject({ text: 'why?', turn: 3, ended: true })
  })

  it('bumps the revision on every change, which is how a poll tells "re-read"', async () => {
    const comments = await store()
    const start = comments.commentsRevision()
    comments.add(comment())
    const added = comments.commentsRevision()
    expect(added).toBeGreaterThan(start)
    comments.remove(S1, 'c1')
    expect(comments.commentsRevision()).toBeGreaterThan(added)
    // A no-op change is not a change: nothing moved, so nothing is reported.
    const quiet = comments.commentsRevision()
    comments.remove(S1, 'c1')
    comments.retain(new Set(['/repo/a.txt']))
    expect(comments.commentsRevision()).toBe(quiet)
  })
})
