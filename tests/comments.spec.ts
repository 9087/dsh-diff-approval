// CommentStore: per-session comment files, and the two guards that keep a comment
// from outliving the pending entry it hangs off.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CommentRecord } from '../src/types.ts'
import { CommentStore, commentsDirFor } from '../src/comments.ts'
import type { CommentScope } from '../src/comments.ts'
import { removeTempDir } from './cleanup.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

/**
 * The scope one reader acts as. `list`, `remove` and `removeMany` take the caller's LINEAGE rule
 * (`CommentScope`); a test that is about one session's own file says `only(S1)`, and `all` is what a
 * lineage root passes when it reads the whole team's threads.
 */
const only = (...ids: readonly SessionId[]): CommentScope => (author) => ids.includes(author)
const all: CommentScope = () => true

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
    expect(second.list(only(S1))).toEqual([
      comment({ quoteContext: 'before\nafter', quoteLines: [{ old: 3, new: 3, kind: 'add' }] }),
    ])
  })

  it('keeps the mark an agent\'s own annotation carries', async () => {
    // `commentOf` is the only door a stored row comes back through, so a field it does not copy survives
    // exactly until the next host restart — and an agent's card came back drawn as the reader's own words
    // for exactly that reason, which is invisible until a reload.
    const first = await store()
    first.add(comment({ id: 'c-agent', author: 'agent' }))
    first.add(comment({ id: 'c-reader' }))
    await first.settled()
    const second = new CommentStore(root)
    await expect(second.loadAll()).resolves.toBe(2)
    expect(second.list(only(S1)).find(row => row.id === 'c-agent'))
      .toEqual(comment({ id: 'c-agent', author: 'agent' }))
    // The reader's own comments are written without it, and absent stays absent.
    const reader = second.list(only(S1)).find(row => row.id === 'c-reader')
    expect(reader).toEqual(comment({ id: 'c-reader' }))
    expect(reader).not.toHaveProperty('author')
  })

  it('keeps the CATEGORY an annotation was given, and leaves it absent when there was none', async () => {
    // The same door as `author` above, for the same reason: the panel draws a coloured dot from this
    // field, so a record whose category `commentOf` did not copy would lose its dot on the first host
    // restart while the annotation itself stayed — the reader's cue would vanish, not the card.
    const first = await store()
    first.add(comment({ id: 'c-classed', category: 'pass-1' }))
    first.add(comment({ id: 'c-plain' }))
    await first.settled()
    const second = new CommentStore(root)
    await expect(second.loadAll()).resolves.toBe(2)
    expect(second.list(only(S1)).find(row => row.id === 'c-classed')?.category).toBe('pass-1')
    // No class, no dot: the key must not come back as an empty string or a present-but-undefined field.
    const plain = second.list(only(S1)).find(row => row.id === 'c-plain')
    expect(plain).toEqual(comment({ id: 'c-plain' }))
    expect(plain).not.toHaveProperty('category')
  })

  it('keeps the category through a re-add, which is how an undo pair restores a thread', async () => {
    // A restore is an ordinary `add` of a snapshot record (see `mergeOf`), so a merge that dropped the
    // field would silently strip the dot from every thread the reader brings back with Ctrl+Z.
    const comments = await store()
    comments.add(comment({ id: 'c-undo', category: 'pass-3' }))
    comments.add(comment({ id: 'c-undo', category: 'pass-3' }))
    await comments.settled()
    const stored = comments.list(only(S1)).find(row => row.id === 'c-undo')
    expect(stored?.category).toBe('pass-3')
  })

  it('lights the dot for an agent\'s own annotation and for nothing the reader wrote', async () => {
    // Which direction a card came from is what decides whether its arrival is news: an agent's
    // annotation lands on code the reader was not looking at (see `annotate-tool.ts`), while the
    // reader's own comment is written in the card they just opened, so lighting that one would put a
    // dot on the very thing they are looking at.
    const comments = await store()
    comments.add(comment({ id: 'c-agent', unseen: true }))
    comments.add(comment({ id: 'c-reader' }))
    expect(comments.get('c-agent')?.unseen).toBe(true)
    expect(comments.get('c-reader')?.unseen).toBe(undefined)
  })

  it('lights a thread the first time an answer arrives, and not on the reads after it', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-1', 3, 'why?')
    // The turn has not written anything: no answer is not an answer.
    expect(comments.syncAnswers(S1, { 'req-1': { answer: undefined, turn: 3, ended: false } })).toBe(false)
    expect(comments.get('c1')?.unseen).toBe(undefined)

    // The answer lands. "New" is the DIFFERENCE from what the reader has already been told about —
    // the transcript hands back the same text on every read afterwards, so a plain "is there an
    // answer" test would leave the dot up for the rest of the session.
    expect(comments.syncAnswers(S1, { 'req-1': { answer: '因为它是守卫', turn: 3, ended: true } })).toBe(true)
    expect(comments.get('c1')).toMatchObject({ unseen: true, answerNow: { 'req-1': '因为它是守卫' } })
    expect(comments.syncAnswers(S1, { 'req-1': { answer: '因为它是守卫', turn: 3, ended: true } })).toBe(false)

    // A read that cannot reach the transcript answers nothing, and a question with no answer goes back
    // to ABSENT: a thread with nothing to say — or a log this process could not read — is not a change.
    expect(comments.syncAnswers(S1, {})).toBe(true)
    expect(comments.get('c1')).toMatchObject({ unseen: true, answerNow: {} })
  })

  it('lights a thread again when the same answer is rewritten, and only then', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-1', 3, 'why?')
    comments.syncAnswers(S1, { 'req-1': { answer: 'first', turn: 3, ended: true } })
    // The reader looks: the dot goes out and the answer they were shown becomes the baseline.
    expect(comments.markSeen('c1')).toBe(true)
    expect(comments.get('c1')?.unseen).toBe(undefined)
    expect(comments.get('c1')?.answerSeen).toEqual({ 'req-1': 'first' })

    // The same text again is not news…
    expect(comments.syncAnswers(S1, { 'req-1': { answer: 'first', turn: 3, ended: true } })).toBe(false)
    expect(comments.get('c1')?.unseen).toBe(undefined)
    // …and a rewritten answer is.
    expect(comments.syncAnswers(S1, { 'req-1': { answer: 'first, and then some', turn: 3, ended: true } })).toBe(true)
    expect(comments.get('c1')?.unseen).toBe(true)
  })

  it('remembers what the reader has seen across a restart instead of lighting it again', async () => {
    // The baseline is the reason the dot can be cleared at all: it is written to the comment file, so
    // the first read after a restart does not hand the reader the same answer as news.
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-1', 3, 'why?')
    comments.syncAnswers(S1, { 'req-1': { answer: 'because', turn: 3, ended: true } })
    comments.markSeen('c1')
    await comments.settled()

    const second = new CommentStore(root)
    await expect(second.loadAll()).resolves.toBe(1)
    expect(second.get('c1')?.answerSeen).toEqual({ 'req-1': 'because' })
    expect(second.syncAnswers(S1, { 'req-1': { answer: 'because', turn: 3, ended: true } })).toBe(false)
    expect(second.get('c1')?.unseen).toBe(undefined)
  })

  it('takes the dot down once, and only for the comment it was asked about', async () => {
    const comments = await store()
    comments.add(comment({ id: 'c-lit', unseen: true }))
    comments.add(comment({ id: 'c-quiet' }))
    const before = comments.commentsRevision()
    expect(comments.markSeen('c-lit')).toBe(true)
    expect(comments.get('c-lit')?.unseen).toBe(undefined)
    expect(comments.get('c-lit')).not.toHaveProperty('unseen')
    expect(comments.commentsRevision()).toBe(before + 1)
    // Nothing left to take down and nothing to record: a second request is not a second write.
    expect(comments.markSeen('c-lit')).toBe(false)
    expect(comments.commentsRevision()).toBe(before + 1)
    expect(comments.markSeen('c-gone')).toBe(false)
    // The untouched thread keeps whatever it had.
    expect(comments.get('c-quiet')?.unseen).toBe(undefined)
  })

  it('lets a restored snapshot put the content back without reviving the dot', async () => {
    // The undo/redo path is `addMany` — a snapshot of records put back verbatim — and a snapshot
    // restores CONTENT: whether the reader has looked at a thread is not content, so a stored `unseen`
    // must not raise a dot they already cleared (nor take down one a newer answer just raised).
    const comments = await store()
    comments.add(comment({ id: 'c1', unseen: true }))
    const snapshot = { ...comments.get('c1')! }
    comments.markSeen('c1')
    comments.addMany([snapshot])
    expect(comments.get('c1')?.unseen).toBe(undefined)

    // …and the live flag wins the other way too: a thread the reader has not looked at stays lit when
    // a snapshot that knows nothing about it is replayed.
    comments.add(comment({ id: 'c2', unseen: true }))
    const quiet = { ...comments.get('c2')!, unseen: undefined }
    delete (quiet as { unseen?: boolean }).unseen
    comments.addMany([quiet])
    expect(comments.get('c2')?.unseen).toBe(true)
  })

  it('keeps a comment file written before these flags existed loadable', async () => {
    // The compatibility promise the pending store makes, for the same reason: the file this version
    // reads is one an older version WROTE, and a loader that insisted on a field it added would drop
    // every thread of the workspace on the first start after the upgrade.
    await store()
    const legacy = comment({ id: 'c-old' })
    await writeFile(join(root, `${S1}.json`), JSON.stringify({ version: 1, comments: [legacy] }), 'utf8')
    const comments = new CommentStore(root)
    await expect(comments.loadAll()).resolves.toBe(1)
    expect(comments.list(only(S1))).toEqual([legacy])
    expect(comments.get('c-old')).not.toHaveProperty('unseen')
    expect(comments.get('c-old')).not.toHaveProperty('answerNow')
    // The older file is still writable, and reading it changed nothing on disk.
    comments.add(comment({ id: 'c-new' }))
    await comments.settled()
    await expect(readFile(join(root, `${S1}.json`), 'utf8')).resolves.toContain('c-old')
  })

  it('reads a teammate\'s legacy file, folds its answer from that seat\'s transcript, and removes it there', async () => {
    // What fanning the READ out is for: a thread already on disk under a teammate's own id stays readable
    // in the lineage, with no migration. Its question was asked before the asking session was recorded, so
    // its answer is looked for in the only session that could have asked it — the comment's own — and a
    // removal has to rewrite THAT file, or the next load brings the thread straight back.
    await store()
    const legacy = comment({
      id: 'c-legacy',
      sessionId: S2,
      asks: [{ requestId: 'req-legacy', text: 'why?' }],
    })
    await writeFile(join(root, `${S2}.json`), JSON.stringify({ version: 1, comments: [legacy] }), 'utf8')
    const comments = new CommentStore(root)
    await comments.loadAll()
    // Readable by a lineage that covers S2, and invisible to one that does not.
    expect(comments.list(all).map(row => row.id)).toEqual(['c-legacy'])
    expect(comments.list(only(S1))).toEqual([])
    // The answer is looked for where the question went: the author's own transcript.
    comments.syncAnswers(S2, { 'req-legacy': { answer: 'from S2', turn: 1, ended: false } })
    expect(comments.get('c-legacy')?.answerNow).toEqual({ 'req-legacy': 'from S2' })
    // …and the removal rewrites the file that holds it, not the caller's.
    expect(comments.remove(all, 'c-legacy')).toBe(true)
    await comments.settled()
    await expect(readFile(join(root, `${S2}.json`), 'utf8')).resolves.not.toContain('c-legacy')
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(all)).toEqual([])
  })

  it('keeps each session in its own file, and lists only that session', async () => {    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', sessionId: S2, entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(only(S1)).map(entry => entry.id)).toEqual(['c1'])
    expect(second.list(only(S2)).map(entry => entry.id)).toEqual(['c2'])
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
    expect(comments.list(only(S1)).map(entry => entry.id)).toEqual(['c9'])
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
    expect(second.list(only(S2)).map(entry => entry.id)).toEqual(['c2'])
    expect(second.list(only(S1))).toEqual([])
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
    expect(comments.list(only(S1)).map(entry => entry.id)).toEqual([stored.id])
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
    expect(comments.list(only(S1)).map(entry => entry.id)).toEqual([stored.id])
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
    expect(comments.list(only(S1)).map(entry => entry.id)).toEqual(['c3'])
    expect(comments.list(only(S2))).toEqual([])
    // The removal reaches the disk: a second client reading the file back must not
    // find what the first one deleted.
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')).toBeUndefined()
    expect(second.list(only(S1)).map(entry => entry.id)).toEqual(['c3'])
  })

  it('sweeps the orphans of entries that are not in the list at all, without erasing them', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    // The view filter: the entry set is the authority on what a read may be handed. It is NOT the authority
    // on what may be deleted — an entry missing from the list can be one whose add never reached the disk
    // (2026-10-06) — so this prune stays in memory and `removeForEntry` is what erases.
    expect(comments.retain(new Set(['/repo/b.txt']))).toBe(1)
    expect(comments.list(only(S1)).map(entry => entry.id)).toEqual(['c2'])
    await comments.settled()
    // A second client sees the same pruned view… and the swept comment is still on the disk, hidden: it
    // comes back if its entry does.
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(only(S1)).map(entry => entry.id)).toEqual(['c1', 'c2'])
  })

  it('HIDES the comments of an entry that was never persisted, and does not erase them', async () => {
    // THE DATA LOSS (2026-10-06, measured on the live host): the card is written the moment the agent
    // annotates, while the entry it hangs on reaches `pending.json` on a later flush (`foldBatch` now
    // awaits that write — see the index spec). A restart in between came back with a store that did not
    // hold the path, and the load-time sweep deleted the cards AND saved the deletion: three real
    // annotations were gone from the disk, not merely hidden. The load-time sweep is therefore a view
    // filter; only a removal that was asked for is written.
    const comments = await store()
    comments.add(comment({ id: 'c-orphan', entryId: '/repo/never-persisted.txt', path: '/repo/never-persisted.txt' }))
    await comments.settled()

    // The restart: a fresh store over the same directory, swept with the entries that DID reach the disk.
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(only(S1)).map(entry => entry.id)).toEqual(['c-orphan'])
    expect(second.retain(new Set(['/repo/known.txt']))).toBe(1)
    // The view is pruned — nothing may be handed out naming a file the list does not hold…
    expect(second.list(only(S1))).toEqual([])
    // …and the erase, if this sweep still wrote one, must have landed before the next store reads the file:
    // without this the third store could win the race and the case would pass against a destructive sweep.
    await second.settled()

    // …and a THIRD store still finds the card, because the sweep did not write the deletion. This is the
    // assertion that was false before: the card was on the disk and is still on it.
    const third = new CommentStore(root)
    await third.loadAll()
    expect(third.list(only(S1)).map(entry => entry.id)).toEqual(['c-orphan'])
    expect(third.get('c-orphan')).toBeDefined()
  })

  it('leaves everything alone when every entry is still listed', async () => {
    const comments = await store()
    comments.add(comment())
    expect(comments.retain(new Set(['/repo/a.txt']))).toBe(0)
    expect(comments.list(only(S1))).toHaveLength(1)
  })
})

describe('mutations', () => {
  it('removes through the SCOPE, and refuses an author outside it', async () => {
    // The guard is the caller's LINEAGE rule (`CommentScope`), not "the caller's own session": a seat of
    // one lineage removes a thread any seat of it wrote, and a session outside the lineage is refused
    // exactly as it was before. That is what makes the threads of a merged view actionable.
    const comments = await store()
    comments.add(comment())
    expect(comments.remove(only(S2), 'c1')).toBe(false)
    expect(comments.list(only(S1))).toHaveLength(1)
    // The same comment, removed by a scope that covers its author.
    expect(comments.remove(all, 'c1')).toBe(true)
    expect(comments.list(all)).toEqual([])
  })

  it('removes a lineage\'s batch from EVERY file that holds one, not from the caller\'s alone', async () => {
    // A batch can name threads written by several seats of one lineage. Routing them all to the caller's
    // file would leave the real files holding records the store no longer has — and the next load would
    // resurrect every one of them.
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c3', sessionId: S2 }))
    await comments.settled()
    expect(comments.removeMany(only(S1, S2), ['c1', 'c3'])).toEqual(['c1', 'c3'])
    expect(comments.list(all)).toEqual([])
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(all)).toEqual([])
  })

  it('folds each transcript\'s answers without erasing the other transcript\'s', async () => {
    // ONE thread, TWO transcripts: the annotation was written by S1, so a question asked before the asking
    // session was recorded has no `sessionId` and folds under S1 (`askTranscript`'s fallback), while a
    // follow-up asked from S2 records S2. Each fold owns only its own transcript's questions — replacing
    // the map wholesale would make the reader watch one answer appear and then vanish on the next poll.
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-legacy', 5, 'why?')
    comments.recordAsk(S2, 'c1', 'req-other', 5, 'and then?')
    comments.syncAnswers(S1, { 'req-legacy': { answer: 'from S1', turn: 5, ended: false } })
    expect(comments.get('c1')?.answerNow).toEqual({ 'req-legacy': 'from S1' })
    comments.syncAnswers(S2, { 'req-other': { answer: 'from S2', turn: 5, ended: false } })
    expect(comments.get('c1')?.answerNow).toEqual({ 'req-legacy': 'from S1', 'req-other': 'from S2' })
    // A later, unchanged read of S1 leaves S2's answer exactly where it was.
    comments.syncAnswers(S1, { 'req-legacy': { answer: 'from S1', turn: 5, ended: false } })
    expect(comments.get('c1')?.answerNow).toEqual({ 'req-legacy': 'from S1', 'req-other': 'from S2' })

    // A turn number is unique only WITHIN one transcript, and both questions recorded turn 5: the end
    // reported for S2's turn 5 must mark S2's question and leave S1's alone (and the other way round).
    expect(comments.markTurnEnded(S2, 5)).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-legacy', sessionId: S1, text: 'why?', turn: 5 },
      { requestId: 'req-other', sessionId: S2, text: 'and then?', turn: 5, ended: true },
    ])
    expect(comments.markTurnEnded(S1, 5)).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-legacy', sessionId: S1, text: 'why?', turn: 5, ended: true },
      { requestId: 'req-other', sessionId: S2, text: 'and then?', turn: 5, ended: true },
    ])
  })

  it('drops a batch in one write, and names only what it dropped', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2' }))
    comments.add(comment({ id: 'c3', sessionId: S2 }))
    const before = comments.commentsRevision()

    // The ids it can act on are dropped; the ones it cannot are not errors. Another session's comment
    // and a comment that is already gone are both "not there to drop", and a repeated id names one.
    expect(comments.removeMany(only(S1), ['c1', 'gone', 'c3', 'c1'])).toEqual(['c1'])
    // ONE revision for the whole batch, which is what one write means: a loop of `remove` calls would
    // have bumped it per comment — and written the session's file per comment.
    expect(comments.commentsRevision()).toBe(before + 1)
    expect(comments.list(only(S1)).map(row => row.id)).toEqual(['c2'])
    expect(comments.list(only(S2)).map(row => row.id)).toEqual(['c3'])

    // A batch that matches nothing does not rewrite the file at all.
    expect(comments.removeMany(only(S1), ['gone', 'c3'])).toEqual([])
    expect(comments.commentsRevision()).toBe(before + 1)

    // The survivors are what the last write left on the disk, not just in memory.
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.list(only(S1)).map(row => row.id)).toEqual(['c2'])
    expect(second.list(only(S2)).map(row => row.id)).toEqual(['c3'])
  })

  it('writes a batch of additions in one save per session, and one revision for the batch', async () => {
    const comments = await store()
    const before = comments.commentsRevision()
    const stored = comments.addMany([
      comment(),
      comment({ id: 'c2' }),
      comment({ id: 'c3', sessionId: S2, entryId: '/repo/b.txt', path: '/repo/b.txt' }),
    ])
    // Index-aligned with the input, which is what makes the batch `add` per record: a caller that
    // needs what was STORED (the merged record, not the one it handed over) reads it here rather
    // than `get`-ing each id back and racing a later change.
    expect(stored.map(record => record.id)).toEqual(['c1', 'c2', 'c3'])
    // ONE revision for the batch, which is what one write per session means (the same reading the
    // `removeMany` test above takes): a loop of `add` calls would have bumped it once per record.
    expect(comments.commentsRevision()).toBe(before + 1)

    // A batch that carries nothing does not rewrite anything, exactly as a removal that matches nothing.
    expect(comments.addMany([])).toEqual([])
    expect(comments.commentsRevision()).toBe(before + 1)

    // Each affected session's own file holds its own records — the saves the one revision stands for.
    await comments.settled()
    const second = new CommentStore(root)
    await expect(second.loadAll()).resolves.toBe(3)
    expect(second.list(only(S1)).map(record => record.id)).toEqual(['c1', 'c2'])
    expect(second.list(only(S2)).map(record => record.id)).toEqual(['c3'])
  })

  it('merges a rewritten record exactly as a single add does', async () => {
    const comments = await store()
    // The same history driven through the two doors: written once, asked in, then written again. A
    // batch is meant to be `add` per record without the N writes, so what it stores has to be what
    // `add` stores — field for field, including the identity a rewrite must not lose.
    comments.add(comment({ id: 'single' }))
    comments.addMany([comment({ id: 'batch' })])
    comments.recordAsk(S1, 'single', 'req-7', 3, 'why?')
    comments.recordAsk(S1, 'batch', 'req-7', 3, 'why?')

    const viaAdd = comments.add(comment({ id: 'single', text: 'why, though?', createdAt: 99, updatedAt: 99 }))
    const viaBatch = comments.addMany([comment({ id: 'batch', text: 'why, though?', createdAt: 99, updatedAt: 99 })])[0]!
    expect(viaAdd.createdAt).toBe(1)
    // Only the ids differ, so projecting one onto the other is the whole comparison.
    expect({ ...viaBatch, id: viaAdd.id }).toEqual(viaAdd)
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
    expect(again.asks).toEqual([{ requestId: 'req-7', sessionId: S1, text: 'why?', turn: 3 }])
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')).toMatchObject({ text: 'why, though?', asks: [{ requestId: 'req-7', text: 'why?', turn: 3 }] })
  })

  it('fills in the turn a claim reported, and marks a dropped submission', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-7', undefined, 'why?')
    expect(comments.get('c1')?.asks).toEqual([{ requestId: 'req-7', sessionId: S1, text: 'why?' }])
    // A follow-up appends rather than replacing: a thread is a conversation, and each
    // question carries its own turn, its own words and its own answer.
    comments.recordAsk(S1, 'c1', 'req-9', undefined, 'and then?')
    expect(comments.get('c1')?.asks?.map(ask => ask.requestId)).toEqual(['req-7', 'req-9'])
    // The inbox claimed the first one: the turn is the fact the panel may state instead
    // of guessing whether two questions shared an answer. Writing the turn down must not
    // write over the question's own words — they ride the same record.
    expect(comments.recordTurnForRequest('req-7', 3)).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-7', sessionId: S1, text: 'why?', turn: 3 },
      { requestId: 'req-9', sessionId: S1, text: 'and then?' },
    ])
    // A repeat of the same turn is not a change.
    expect(comments.recordTurnForRequest('req-7', 3)).toBe(0)
    // Discarded before any turn took it: nothing is coming, so the reader is told.
    expect(comments.markDroppedForRequest('req-9')).toBe(1)
    expect(comments.get('c1')?.asks).toEqual([
      { requestId: 'req-7', sessionId: S1, text: 'why?', turn: 3 },
      { requestId: 'req-9', sessionId: S1, text: 'and then?', dropped: true },
    ])
    expect(comments.markDroppedForRequest('req-9')).toBe(0)
    // A request id nothing carries touches nothing.
    expect(comments.recordTurnForRequest('req-other', 9)).toBe(0)
    await comments.settled()
    const second = new CommentStore(root)
    await second.loadAll()
    expect(second.get('c1')?.asks).toEqual([
      { requestId: 'req-7', sessionId: S1, text: 'why?', turn: 3 },
      { requestId: 'req-9', sessionId: S1, text: 'and then?', dropped: true },
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
      { requestId: 'req-7', sessionId: S1, text: 'why?', turn: 3, ended: true },
      { requestId: 'req-9', sessionId: S1, text: 'and then?', turn: 4 },
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
    comments.remove(only(S1), 'c1')
    expect(comments.commentsRevision()).toBeGreaterThan(added)
    // A no-op change is not a change: nothing moved, so nothing is reported.
    const quiet = comments.commentsRevision()
    comments.remove(only(S1), 'c1')
    comments.retain(new Set(['/repo/a.txt']))
    expect(comments.commentsRevision()).toBe(quiet)
  })
})
