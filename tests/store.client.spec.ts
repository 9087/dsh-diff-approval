// The pending store: refresh, busy tracking, action outcomes, and reset.

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalCommentAddValue, DiffApprovalCommentAskValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue, DiffApprovalListValue, DiffApprovalRefreshValue, PendingFileDiff } from '../src/types.ts'
import type { CommentDraft, DiffApprovalPort } from '../src/client/port.ts'
import { createPendingDiffStore } from '../src/client/store.ts'

const S1 = 'session-1' as SessionId
const FILE: PendingFileDiff = {
  id: 'entry-1', sessionId: S1, path: '/repo/a.txt', earlierVersion: 'file',
  oldText: 'a', newText: 'b', updatedAt: 10, missing: false, diverged: false,
}

type ListMock = ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>>
type ActionMock = ReturnType<typeof vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>>
type BlockActionMock = ReturnType<typeof vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>>

/**
 * One list answer, with the comment state every read carries. This suite is about
 * entries, so the comment fields are empty unless a test says otherwise.
 */
function listValue(fields: Partial<DiffApprovalListValue> = {}): DiffApprovalListValue {
  return { files: [], comments: [], commentLines: {}, commentsRevision: 0, commentAnswers: {}, ...fields }
}

/** The empty comment state, as it appears in a published snapshot. */
const NO_COMMENTS = { comments: [], commentLines: {}, commentsRevision: 0, commentAnswers: {} }

/** A port plus its mocks, so tests control the answers through local bindings. */
interface PortSeam {
  port: DiffApprovalPort
  list: ListMock
  keep: ActionMock
  revert: ActionMock
  blockKeep: BlockActionMock
  blockRevert: BlockActionMock
  undo: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<DiffApprovalActionValue>>>
  redo: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<DiffApprovalActionValue>>>
  refreshVcs: ReturnType<typeof vi.fn<(sessionId: SessionId, id: string, includeUntracked: boolean) => Promise<DiffApprovalRefreshValue>>>
  commentAdd: ReturnType<typeof vi.fn<(sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>>>
  commentRemove: ReturnType<typeof vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>>>
  commentRemoveMany: ReturnType<typeof vi.fn<(sessionId: SessionId, ids: readonly string[]) => Promise<DiffApprovalCommentRemoveManyValue>>>
  commentAsk: ReturnType<typeof vi.fn<(sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>>>
  markSeen: ReturnType<typeof vi.fn<(sessionId: SessionId, id: string) => Promise<void>>>
  commentSeen: ReturnType<typeof vi.fn<(sessionId: SessionId, id: string) => Promise<void>>>
}

/** Build one seam whose answers the test controls through typed mocks. */
function port(overrides: Partial<Pick<PortSeam, 'list' | 'keep' | 'revert' | 'blockKeep' | 'blockRevert' | 'undo' | 'redo' | 'refreshVcs'>> = {}): PortSeam {
  const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(async () => listValue({ files: [FILE] }))
  const keep = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'kept' }))
  const revert = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'reverted' }))
  const blockKeep = vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'kept' }))
  const blockRevert = vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'reverted' }))
  const undo = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'undone', id: FILE.id }))
  const redo = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'redone', id: FILE.id }))
  const refreshVcs = vi.fn<(sessionId: SessionId, id: string, includeUntracked: boolean) => Promise<DiffApprovalRefreshValue>>(async () => ({ outcome: 'refreshed' }))
  const commentAdd = vi.fn<(sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>>(async () => ({ outcome: 'added' }))
  const commentRemove = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>>(async () => ({ outcome: 'removed' }))
  const commentRemoveMany = vi.fn<(sessionId: SessionId, ids: readonly string[]) => Promise<DiffApprovalCommentRemoveManyValue>>(async (_sessionId, ids) => ({ removed: ids.length }))
  const commentAsk = vi.fn<(sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>>(async () => ({ outcome: 'asked', requestId: 'req-1' }))
  const markSeen = vi.fn<(sessionId: SessionId, id: string) => Promise<void>>(async () => {})
  const commentSeen = vi.fn<(sessionId: SessionId, id: string) => Promise<void>>(async () => {})
  return {
    // `...overrides` LAST in BOTH objects: a test's own answer must win. Spreading the defaults after it
    // silently replaced the caller's `list` (and every other mock) with the canned one here, so a test
    // that staged a bespoke answer was handed the default and could not tell — and the store under test
    // received the canned one too.
    port: { list, keep, revert, blockKeep, blockRevert, undo, redo, refreshVcs, commentAdd, commentRemove, commentRemoveMany, commentAsk, markSeen, commentSeen, ...overrides },
    list, keep, revert, blockKeep, blockRevert, undo, redo, refreshVcs, commentAdd, commentRemove, commentRemoveMany, commentAsk, markSeen, commentSeen, ...overrides,
  }
}

describe('refresh', () => {
  it('starts unread and publishes the files after a read', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    expect(store.getSnapshot()).toEqual({ read: false, files: [], ...NO_COMMENTS, busy: new Set() })

    const seen = vi.fn()
    const off = store.subscribe(seen)
    await store.refresh(S1)
    expect(store.getSnapshot()).toEqual({ read: true, files: [FILE], ...NO_COMMENTS, busy: new Set(), failed: new Map() })
    expect(seen).toHaveBeenCalled()
    off()
  })

  it('publishes an empty view for an absent session without calling the port', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(undefined)
    expect(store.getSnapshot()).toEqual({ read: true, files: [], ...NO_COMMENTS, busy: new Set(), failed: new Map() })
    expect(seam.list).not.toHaveBeenCalled()
  })

  it('carries the host\'s persist failure into the snapshot, and keeps it through a failed poll', async () => {
    const seam = port()
    seam.list.mockResolvedValue(listValue({ files: [FILE], persistError: 'ENOSPC: no space left on device' }))
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    expect(store.getSnapshot().persistError).toBe('ENOSPC: no space left on device')

    // A poll that never reached the host knows nothing about the disk, so it must not
    // answer "writes work now" — only the host retracts this field, by leaving it out
    // once a write succeeds.
    seam.list.mockRejectedValue(new Error('socket closed'))
    await store.refresh(S1)
    expect(store.getSnapshot().persistError).toBe('ENOSPC: no space left on device')

    seam.list.mockResolvedValue(listValue({ files: [FILE] }))
    await store.refresh(S1)
    expect(store.getSnapshot().persistError).toBeUndefined()
  })

  it('keeps the files it had when a read fails and says why', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    seam.list.mockRejectedValue(new Error('socket closed'))
    await store.refresh(S1)
    expect(store.getSnapshot()).toEqual({ read: true, files: [FILE], ...NO_COMMENTS, error: 'socket closed', busy: new Set(), failed: new Map() })
  })
})

describe('refresh epochs', () => {
  it('keeps the newer snapshot when an older read resolves after it', async () => {
    // Two polls of one session can overlap — a slow host and a poll interval that does not
    // wait for the last one. The first request is older by construction, so when its answer
    // lands last it must not put the files it read back over the newer view.
    const releases: ((value: DiffApprovalListValue) => void)[] = []
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(
        () => new Promise((resolve) => { releases.push(resolve) }),
      ),
    })
    const store = createPendingDiffStore(seam.port)
    const older = store.refresh(S1)
    const newer = store.refresh(S1)
    expect(releases).toHaveLength(2)

    const NEWER: PendingFileDiff = { ...FILE, newText: 'newer' }
    releases[1]!(listValue({ files: [NEWER] }))
    await newer
    expect(store.getSnapshot().files).toEqual([NEWER])

    releases[0]!(listValue({ files: [FILE] }))
    await older
    expect(store.getSnapshot().files).toEqual([NEWER])
  })

  it('drops a read of the session the reader left instead of publishing it under the new one', async () => {
    // The reader switched sessions: A's read was still in flight when B's answered. A's
    // answer names A's files and A's comments, and publishing it would draw them as B's.
    const S2 = 'session-2' as SessionId
    const FILE_B: PendingFileDiff = { ...FILE, id: 'entry-2', sessionId: S2, path: '/repo/b.txt' }
    const A_COMMENT = {
      id: 'c1', sessionId: S1, entryId: FILE.id, path: FILE.path,
      anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why?', createdAt: 1, updatedAt: 2,
    }
    let releaseA: ((value: DiffApprovalListValue) => void) | undefined
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>((sessionId) => (
        sessionId === S1
          ? new Promise((resolve) => { releaseA = resolve })
          : Promise.resolve(listValue({ files: [FILE_B] }))
      )),
    })
    const store = createPendingDiffStore(seam.port)
    const readingA = store.refresh(S1)
    await store.refresh(S2)
    expect(store.getSnapshot().files).toEqual([FILE_B])

    releaseA?.(listValue({ files: [FILE], comments: [A_COMMENT] }))
    await readingA
    expect(store.getSnapshot().files).toEqual([FILE_B])
    expect(store.getSnapshot().comments).toEqual([])
    // The dropped read changes nothing at all: B's answer is what resolved `read` (a stale
    // drop cannot leave the panel loading), and the live busy/failed bookkeeping stays the
    // newest response's to carry.
    expect(store.getSnapshot().read).toBe(true)
    expect(store.getSnapshot().busy).toEqual(new Set())
  })
})

describe('one view per session', () => {
  const S2 = 'session-2' as SessionId
  const FILE_B: PendingFileDiff = { ...FILE, id: 'entry-2', sessionId: S2, path: '/repo/b.txt' }

  it('holds both sessions\' views at once, and shows the newest read as the page-wide one', async () => {
    // The reporter's bug, in the store: a badge for A showed B's list because there was ONE snapshot
    // and two seats polling into it. Each session keeps its own slot now, so both are live and neither
    // read can move the other's list.
    let releaseB: ((value: DiffApprovalListValue) => void) | undefined
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>((sessionId) => (
        sessionId === S2
          ? new Promise((resolve) => { releaseB = resolve })
          : Promise.resolve(listValue({ files: [FILE] }))
      )),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    // B's read is in flight. A's consumer is unaffected: it reads A's slot, whose count is A's own.
    const readingB = store.refresh(S2)
    expect(store.viewFor(S1).files).toEqual([FILE])
    expect(store.viewFor(S1).files.length).toBe(1)

    releaseB?.(listValue({ files: [FILE_B] }))
    await readingB
    // Both are live, side by side, and the page-wide reader follows the newest read (B).
    expect(store.viewFor(S1).files).toEqual([FILE])
    expect(store.viewFor(S2).files).toEqual([FILE_B])
    expect(store.getSnapshot().files).toEqual([FILE_B])
  })

  it('a read for B does not change what an A consumer sees', async () => {
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(async (sessionId) => (
        sessionId === S1 ? listValue({ files: [FILE], workspacePath: '/repo-a' }) : listValue({ files: [FILE_B], workspacePath: '/repo-b' })
      )),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    const beforeA = store.viewFor(S1)

    await store.refresh(S2)
    // A's view is the same object it was, with the same files, the same count and A's own workspace.
    expect(store.viewFor(S1)).toBe(beforeA)
    expect(store.viewFor(S1).files).toEqual([FILE])
    expect(store.viewFor(S1).files.length).toBe(1)
    expect(store.viewFor(S1).workspacePath).toBe('/repo-a')
    expect(store.viewFor(S2).files).toEqual([FILE_B])
  })

  it('answers an unread empty view for a session that has never been read, never another session\'s list', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    const untouched = store.viewFor(S2)
    expect(untouched.read).toBe(false)
    expect(untouched.files).toEqual([])
  })

  it('answers the newest read for viewFor(undefined), exactly what getSnapshot answers', async () => {
    // The two spellings of "no session of mine" are documented as one answer, and a seat whose shell
    // names no session reads through this one: `viewFor(undefined)` used to return a module-level slot
    // that a session read never writes, so the header entry rendered a DEAD badge (count 0) for a
    // session whose list was right there, while `getSnapshot()` answered it correctly.
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(async (sessionId) => (
        sessionId === S1 ? listValue({ files: [FILE] }) : listValue({ files: [FILE_B] })
      )),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    expect(store.viewFor(undefined)).toBe(store.getSnapshot())
    expect(store.viewFor(undefined).files).toEqual([FILE])

    await store.refresh(S2)
    expect(store.viewFor(undefined)).toBe(store.getSnapshot())
    expect(store.viewFor(undefined).files).toEqual([FILE_B])
    // …and an unread session is still its own empty view, never the page-wide answer.
    expect(store.viewFor('session-3' as SessionId).files).toEqual([])
  })

  it('keeps a session\'s own list when its read fails', async () => {
    // A failed poll knows nothing new. It must not blank the session's list — neither as empty nor as a
    // fresh snapshot — so the reader keeps the files, and the reason, that this session already had.
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(async (sessionId) => (
        sessionId === S1 ? listValue({ files: [FILE] }) : listValue({ files: [FILE_B] })
      )),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.refresh(S2)
    expect(seam.list.mock.calls).toEqual([[S1], [S2]])
    seam.list.mockRejectedValue(new Error('socket closed'))
    await store.refresh(S2)
    // B keeps B's list and says why; A is untouched by B's failure.
    expect(store.viewFor(S2).files).toEqual([FILE_B])
    expect(store.viewFor(S2).error).toBe('socket closed')
    expect(store.viewFor(S2).read).toBe(true)
    expect(store.viewFor(S1).files).toEqual([FILE])
    expect(store.viewFor(S1).error).toBeUndefined()
  })

  it('drops only the failed session\'s error when that session reads again', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    seam.list.mockRejectedValueOnce(new Error('socket closed'))
    await store.refresh(S1)
    expect(store.viewFor(S1).error).toBe('socket closed')
    seam.list.mockResolvedValue(listValue({ files: [FILE] }))
    await store.refresh(S1)
    expect(store.viewFor(S1).error).toBeUndefined()
    expect(store.viewFor(S1).files).toEqual([FILE])
  })
})

describe('seen', () => {
  it('tells the host the row was seen and does NOT re-read the list', async () => {
    // Clearing a dot is not a reason to read anything. The file on screen draws no dot anyway (its row
    // renders one only while it is not the selected one), and the next poll carries the cleared flag for
    // the list the reader goes back to. The re-read this used to do was a refresh per report: it published
    // a NEW `files` array, which re-armed the panel's "the shown row is still unseen" effect, which
    // reported the same path again — a list read, a render and another report as fast as the host could
    // answer, with the badge flapping between whatever two sessions' reads answered with.
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    expect(seam.list).toHaveBeenCalledTimes(1)

    const published = vi.fn()
    const off = store.subscribe(published)
    await store.markSeen(S1, FILE.id)
    expect(seam.markSeen).toHaveBeenCalledWith(S1, FILE.id)
    // No read, and no publish at all: the mark changes nothing the panel is drawing.
    expect(seam.list).toHaveBeenCalledTimes(1)
    expect(published).not.toHaveBeenCalled()
    expect(store.getSnapshot().files).toEqual([FILE])
    off()
  })

  it('does not let a read of the session the reader left land on the current view', async () => {
    // The reader switched A → B and has since been shown one of B's files. A's read was issued before the
    // switch and answers LAST, so publishing it would put A's rows under B's badge — the flip the reader
    // saw. Nothing done in between may reopen that door, which is why the mark is exercised here too: it
    // used to refresh, and a refresh issued from the session the reader is on is exactly what let the two
    // lists take turns.
    const S2 = 'session-2' as SessionId
    const FILE_B: PendingFileDiff = { ...FILE, id: 'entry-2', sessionId: S2, path: '/repo/b.txt' }
    let releaseA: ((value: DiffApprovalListValue) => void) | undefined
    const seam = port({
      list: vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>((sessionId) => (
        sessionId === S1
          ? new Promise((resolve) => { releaseA = resolve })
          : Promise.resolve(listValue({ files: [FILE_B] }))
      )),
    })
    const store = createPendingDiffStore(seam.port)
    const readingA = store.refresh(S1)
    await store.refresh(S2)
    await store.markSeen(S2, FILE_B.id)
    expect(store.getSnapshot().files).toEqual([FILE_B])

    // A's answer now lands, after the switch and after the mark.
    releaseA?.(listValue({ files: [FILE] }))
    await readingA
    expect(store.getSnapshot().files).toEqual([FILE_B])
  })
})

describe('actions', () => {
  it('marks an entry busy while keep runs, then removes it', async () => {
    let release: ((value: DiffApprovalActionValue) => void) | undefined
    const seam = port({
      keep: vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(
        () => new Promise((resolve) => { release = resolve }),
      ),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    const settled = store.keep(S1, FILE.id)
    expect(store.getSnapshot().busy).toEqual(new Set([FILE.id]))
    release?.({ outcome: 'kept' })
    await settled
    expect(store.getSnapshot()).toEqual({ read: true, files: [], ...NO_COMMENTS, busy: new Set(), failed: new Map() })
  })

  it('reverts through the port and removes the entry', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.revert(S1, FILE.id)
    expect(seam.revert).toHaveBeenCalledWith(S1, FILE.id)
    expect(store.getSnapshot().files).toEqual([])
  })

  it('keeps a slow action\'s entry busy across a poll that resolves in between', async () => {
    // The panel polls every second, and a keep or a revert holds its id busy across its own await
    // (see `withBusy`). Publishing an empty busy set on the poll re-enabled the row mid-flight, so a
    // second click on it fired a second keep for the entry already being kept — which is the whole
    // read of `onKeep` the panel guards on.
    let release: ((value: DiffApprovalActionValue) => void) | undefined
    const kept = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(
      () => new Promise((resolve) => { release = resolve }),
    )
    const seam = port({ keep: kept })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    const settled = store.keep(S1, FILE.id)
    expect(store.getSnapshot().busy).toEqual(new Set([FILE.id]))
    expect(kept).toHaveBeenCalledTimes(1)

    // A poll lands while the keep is still in flight. The host still lists the entry — the keep has
    // not reached it — and the row must stay disabled, so the second press the reader makes cannot
    // become a second keep of the same entry.
    await store.refresh(S1)
    expect(store.getSnapshot().files).toEqual([FILE])
    expect(store.getSnapshot().busy).toEqual(new Set([FILE.id]))

    // The action finishing is the only thing that clears it.
    release?.({ outcome: 'kept' })
    await settled
    expect(store.getSnapshot().busy).toEqual(new Set())
    expect(kept).toHaveBeenCalledTimes(1)
  })

  it('never drops a kept entry locally, and re-reads it so its diff updates at once', async () => {
    // "Keep in list" leaves the entry pending in the host. Dropping it locally
    // would make the row blink out and reappear on the next poll, so the kept
    // path marks it busy, runs the call, and re-reads instead.
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    let release: ((value: DiffApprovalActionValue) => void) | undefined
    seam.keep.mockImplementation(async () => new Promise<DiffApprovalActionValue>((resolve) => { release = resolve }))

    const settled = store.keep(S1, FILE.id, true)
    expect(store.getSnapshot().busy).toEqual(new Set([FILE.id]))
    // Still listed while the action is in flight.
    expect(store.getSnapshot().files).toEqual([FILE])

    release?.({ outcome: 'kept', resolved: true })
    await settled
    expect(seam.keep).toHaveBeenCalledWith(S1, FILE.id, true)
    expect(store.getSnapshot().files).toEqual([FILE])
    expect(store.getSnapshot().busy).toEqual(new Set())
    // The entry is still there: the local list was never emptied.
    expect(seam.list).toHaveBeenCalledTimes(2)
  })

  it('leaves a kept-but-failed entry listed and marked', async () => {
    const failing = vi.fn(async () => { throw new Error('busy elsewhere') })
    const seam = port({ revert: failing })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.revert(S1, FILE.id, true)
    expect(failing).toHaveBeenCalledWith(S1, FILE.id, true)
    expect(store.getSnapshot().files).toEqual([FILE])
    expect(store.getSnapshot().failed?.get(FILE.id)).toBe('busy elsewhere')
  })

  it('refreshes one entry through the port and re-reads the list', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    const value = await store.refreshVcs(S1, FILE.id, false)
    expect(value).toEqual({ outcome: 'refreshed' })
    expect(seam.refreshVcs).toHaveBeenCalledWith(S1, FILE.id, false)
    // The entry's diff changed, so the list is re-read rather than edited locally.
    expect(seam.list).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().busy).toEqual(new Set())
  })

  it('clears the busy mark even when a refresh fails', async () => {
    const failing = vi.fn(async () => { throw new Error('no shell') })
    const seam = port({ refreshVcs: failing as unknown as PortSeam['refreshVcs'] })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await expect(store.refreshVcs(S1, FILE.id, false)).rejects.toThrow('no shell')
    expect(store.getSnapshot().busy).toEqual(new Set())
    expect(store.getSnapshot().files).toEqual([FILE])
  })

  it('keeps the file and marks it failed when an action fails, without a read error', async () => {
    const seam = port({ keep: vi.fn(async () => { throw new Error('busy elsewhere') }) })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.keep(S1, FILE.id)
    expect(store.getSnapshot().files).toEqual([FILE])
    expect(store.getSnapshot().failed?.get(FILE.id)).toBe('busy elsewhere')
    expect(store.getSnapshot().error).toBeUndefined()
    expect(store.getSnapshot().busy).toEqual(new Set())
  })

  it('reports a non-Error rejection without inventing a message', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario.
    const seam = port({ revert: vi.fn(() => Promise.reject('nope')) })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.revert(S1, FILE.id)
    expect(store.getSnapshot().failed?.get(FILE.id)).toBe('nope')
  })
})

describe('block actions', () => {
  const BLOCK = { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }

  it('keeps a block, passes the range, and refreshes afterwards', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    expect(seam.list).toHaveBeenCalledTimes(1)

    await store.blockKeep(S1, FILE.id, BLOCK)
    expect(seam.blockKeep).toHaveBeenCalledWith(S1, FILE.id, BLOCK)
    // The entry stays; a refresh pulls its updated diff.
    expect(seam.list).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().files).toEqual([FILE])
    expect(store.getSnapshot().busy).toEqual(new Set())
  })

  it('marks the file busy while a block revert runs and clears it', async () => {
    let release: ((value: DiffApprovalActionValue) => void) | undefined
    const seam = port({
      blockRevert: vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>(
        () => new Promise((resolve) => { release = resolve }),
      ),
    })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    const settled = store.blockRevert(S1, FILE.id, BLOCK)
    expect(store.getSnapshot().busy).toEqual(new Set([FILE.id]))
    release?.({ outcome: 'reverted' })
    await settled
    expect(store.getSnapshot().busy).toEqual(new Set())
  })

  it('marks the file failed when a block action fails, without a read error', async () => {
    const seam = port({ blockKeep: vi.fn(async () => { throw new Error('block busy') }) })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.blockKeep(S1, FILE.id, BLOCK)
    expect(store.getSnapshot().failed?.get(FILE.id)).toBe('block busy')
    expect(store.getSnapshot().error).toBeUndefined()
    expect(store.getSnapshot().busy).toEqual(new Set())
  })

  it('passes removeWhenResolved through to the port when the caller asks to remove', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    await store.blockKeep(S1, FILE.id, BLOCK, true)
    expect(seam.blockKeep).toHaveBeenCalledWith(S1, FILE.id, BLOCK, true)
    // A default (no flag) block action still runs the port with just 3 args.
    await store.blockRevert(S1, FILE.id, BLOCK)
    expect(seam.blockRevert).toHaveBeenCalledWith(S1, FILE.id, BLOCK)
  })
})

describe('reset', () => {
  it('drops every local fact', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    store.reset()
    expect(store.getSnapshot()).toEqual({ read: false, files: [], ...NO_COMMENTS, busy: new Set() })
  })
})

describe('undo/redo', () => {
  it('surfaces a refused undo instead of swallowing it', async () => {
    const seam = port()
    seam.undo.mockRejectedValue(new Error('undo failed: the file changed outside the review after the action; undo is unavailable'))
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    await expect(store.undo(S1)).resolves.toBeUndefined()
    // The reader pressed Ctrl+Z and the host refused. Before this the refusal was thrown
    // away here, so nothing at all happened on screen.
    expect(store.getSnapshot().undoNotice).toContain('the file changed outside the review')
  })

  it('says a session has nothing to undo, and keeps the panel on its list', async () => {
    const seam = port()
    seam.undo.mockResolvedValue({ outcome: 'nothing' })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await expect(store.undo(S1)).resolves.toBeUndefined()
    // Nothing was refused — there was simply nothing on this session's stack — so the
    // list stays as it is and no failure line is published on its account.
    expect(store.getSnapshot().error).toBeUndefined()
    expect(store.getSnapshot().files).toEqual([FILE])
  })

  it('selects the affected entry after a successful undo', async () => {
    const seam = port()
    seam.undo.mockResolvedValue({ outcome: 'undone', id: FILE.id })
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await expect(store.undo(S1)).resolves.toBe(FILE.id)
    expect(seam.list).toHaveBeenCalledWith(S1)
  })
})

describe('comments', () => {
  it('writes one annotation through the port and re-reads', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    const draft: CommentDraft = {
      id: 'c1', entryId: FILE.id, anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why?',
    }
    await expect(store.commentAdd(S1, draft)).resolves.toEqual({ outcome: 'added' })
    expect(seam.commentAdd).toHaveBeenCalledWith(S1, draft)
    // The thread lives on the host from the moment it is written, so the panel re-reads
    // rather than keeping a local copy — that is what makes a second client of the same
    // session show the same thread.
    expect(seam.list).toHaveBeenCalledWith(S1)
  })

  it('asks one comment and re-reads, so the derived answer is what shows', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await expect(store.commentAsk(S1, 'c1', 'the prompt', 'why?')).resolves.toEqual({ outcome: 'asked', requestId: 'req-1' })
    // Both strings go through: the prompt is what the agent is asked, the words are what the
    // thread shows.
    expect(seam.commentAsk).toHaveBeenCalledWith(S1, 'c1', 'the prompt', 'why?')
    expect(seam.list).toHaveBeenCalledWith(S1)
  })

  it('removes one comment and re-reads', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await expect(store.commentRemove(S1, 'c1')).resolves.toEqual({ outcome: 'removed' })
    expect(seam.commentRemove).toHaveBeenCalledWith(S1, 'c1')
    expect(seam.list).toHaveBeenCalledWith(S1)
  })

  it('carries the host\'s comments, their answers and their resolved lines into the snapshot', async () => {
    const seam = port()
    const comment = {
      id: 'c1', sessionId: S1, entryId: FILE.id, path: FILE.path,
      anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why?',
      createdAt: 1, updatedAt: 2, asks: [{ requestId: 'req-1' }],
    }
    seam.list.mockResolvedValue(listValue({
      files: [FILE], comments: [comment], commentsRevision: 3, commentAnswers: { 'req-1': 'because' },
      // The lines the HOST resolved the quote to: the panel draws these, not the record's anchor.
      commentLines: { c1: { start: 4, end: 5 } },
    }))
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    expect(store.getSnapshot()).toMatchObject({
      comments: [comment], commentsRevision: 3, commentAnswers: { 'req-1': 'because' },
      commentLines: { c1: { start: 4, end: 5 } },
    })
  })
})
