// Reference remap sync: baseline tracking and composer-draft rewriting.

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalListValue, PendingFileDiff } from '../src/types.ts'
import type { DiffApprovalPort } from '../src/client/port.ts'
import { createPendingDiffStore } from '../src/client/store.ts'
import { attachReferenceRemap } from '../src/client/remap-sync.ts'

const S1 = 'session-1' as SessionId

function entry(newText: string): PendingFileDiff {
  return {
    id: 'entry-1', sessionId: S1, path: '/repo/a.txt', earlierVersion: 'file',
    oldText: 'a\nb\n', newText, updatedAt: 10, missing: false, diverged: false,
  }
}

function portOf(list: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>>): DiffApprovalPort {
  const action = vi.fn(async () => ({ outcome: 'kept' }))
  return {
    list,
    keep: action, revert: action, blockKeep: action, blockRevert: action,
    undo: vi.fn(async () => ({ outcome: 'undone' })),
    redo: vi.fn(async () => ({ outcome: 'redone' })),
    importVcs: vi.fn(async () => ({ imported: 0, detected: false })),
    open: vi.fn(async () => ({ outcome: 'opened' })),
  } as unknown as DiffApprovalPort
}

describe('attachReferenceRemap', () => {
  it('remaps the composer draft when a file content changes', async () => {
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    let draft = '看 (a.txt:1)'
    const writeDraft = vi.fn((text: string) => { draft = text })
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft, readQueue: () => [], writeQueue: () => {} })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    // A line is inserted above, so (a.txt:1) -> (a.txt:2).
    list.mockResolvedValue({ files: [entry('x\na\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).toHaveBeenCalledWith('看 (a.txt:2)')
    expect(draft).toBe('看 (a.txt:2)')
  })

  it('marks an expired reference when the referenced line is removed', async () => {
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    let draft = '(a.txt:2)'
    const writeDraft = vi.fn((text: string) => { draft = text })
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft, readQueue: () => [], writeQueue: () => {} })

    list.mockResolvedValue({ files: [entry('a\nb\nc\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    // Line 2 is removed, so the reference expires.
    list.mockResolvedValue({ files: [entry('a\nc\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).toHaveBeenCalledWith('(a.txt:LINE_MISSING)')
    expect(draft).toBe('(a.txt:LINE_MISSING)')
  })

  it('does not write when nothing referenced the changed file', async () => {
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    const writeDraft = vi.fn()
    attachReferenceRemap({ store, readDraft: () => '只有普通文字', writeDraft, readQueue: () => [], writeQueue: () => {} })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    list.mockResolvedValue({ files: [entry('x\na\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).not.toHaveBeenCalled()
  })

  it('remaps references inside queued messages, preserving other blocks', async () => {
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    const queue: { id: string; content: readonly { type: string; text?: string }[] }[] = [
      { id: 'q1', content: [{ type: 'text', text: '改 (a.txt:1)' }, { type: 'image' }] },
      { id: 'q2', content: [{ type: 'text', text: '无引用' }] },
    ]
    const writeQueue = vi.fn()
    attachReferenceRemap({
      store,
      readDraft: () => undefined,
      writeDraft: () => {},
      readQueue: () => queue,
      writeQueue,
    })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    // Insert a line above: (a.txt:1) -> (a.txt:2) in q1 only; q2 is untouched.
    list.mockResolvedValue({ files: [entry('x\na\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeQueue).toHaveBeenCalledTimes(1)
    expect(writeQueue).toHaveBeenCalledWith('q1', [{ type: 'text', text: '改 (a.txt:2)' }, { type: 'image' }])
  })

  it('does not remap on a trailing-newline-only drift', async () => {
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    let draft = '(a.txt:2)'
    const writeDraft = vi.fn((text: string) => { draft = text })
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft, readQueue: () => [], writeQueue: () => {} })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    // Same content, trailing newline stripped: not a real change.
    list.mockResolvedValue({ files: [entry('a\nb')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).not.toHaveBeenCalled()
    expect(draft).toBe('(a.txt:2)')
  })

  it('uses only the newest entry when the list carries duplicate path entries', async () => {
    // Successive folds keep the earliest id but advance newText, so the list can
    // carry a stale and a fresh entry for one path. The panel renders only the
    // newest, and a reference targets it — iterating both would remap the
    // reference against the stale content and expire it.
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    let draft = '(a.txt:3)'
    const writeDraft = vi.fn((text: string) => { draft = text })
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft, readQueue: () => [], writeQueue: () => {} })

    const newer = { ...entry('a\nb\nc\nd\n'), id: 'entry-newer', updatedAt: 20 }
    const older = { ...entry('a\nb\n'), id: 'entry-older', updatedAt: 10 }
    list.mockResolvedValue({ files: [older, newer], workspacePath: '/repo' })
    await store.refresh(S1)

    // The stale 2-line entry must not be treated as a change: the reference (made
    // against the newest 4-line content) stays untouched.
    expect(writeDraft).not.toHaveBeenCalled()
    expect(draft).toBe('(a.txt:3)')
  })

  it('keeps the draft baselines when ANOTHER session is polled in between', async () => {
    // The dock tab and the header poll two different sessions about once a second. The sync used to be
    // given "the session some mount refreshed last", which the other seat moved on every poll: the
    // baselines were dropped before the file's own change ever arrived, so a changed file was only
    // re-seeded and never remapped — a silently dead feature. Following the SHOWN session leaves the
    // baselines in place across the other session's polls.
    const S2 = 'session-2' as SessionId
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))
    const entryB = { ...entry('b\nb2\n'), id: 'entry-b', sessionId: S2, path: '/repo/b.txt' }

    let draft = '(a.txt:1)'
    const writeDraft = vi.fn((text: string) => { draft = text })
    attachReferenceRemap({
      store,
      readDraft: () => draft,
      writeDraft,
      readQueue: () => [],
      writeQueue: () => {},
      sessionId: () => S1,
    })

    // Seed both sessions, then let the OTHER one be polled last: it is the page-wide pointer, but not
    // the one this composer belongs to.
    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)
    list.mockResolvedValue({ files: [entryB], workspacePath: '/repo' })
    await store.refresh(S2)

    // A's own file really changes now. With the pointer followed instead of the shown session, the
    // poll above had already cleared the baseline and this reads as a first observation: nothing written.
    list.mockResolvedValue({ files: [entry('x\na\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).toHaveBeenCalledWith('(a.txt:2)')
    expect(draft).toBe('(a.txt:2)')
  })

  it('resolves the composer reference against the SHOWN session\u2019s workspace', async () => {
    // `remapFile` runs after a whole-file revert, whose entry has left the list. It passed the page-wide
    // snapshot's workspace, so with another session read last the reference was resolved against the
    // wrong root and the auto-link silently did nothing. It takes the named session's own view now.
    const S2 = 'session-2' as SessionId
    const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>()
    const store = createPendingDiffStore(portOf(list))

    let draft = 'See (a.txt:1) please'
    const writeDraft = vi.fn((text: string) => { draft = text })
    const remap = attachReferenceRemap({
      store,
      readDraft: () => draft,
      writeDraft,
      readQueue: () => [],
      writeQueue: () => {},
      sessionId: () => S1,
    })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo-a' })
    await store.refresh(S1)
    // The other session was read last: it owns the page-wide read now.
    list.mockResolvedValue({ files: [], workspacePath: '/other-root' })
    await store.refresh(S2)
    expect(store.getSnapshot().workspacePath).toBe('/other-root')

    // The revert is A's, so the reference resolves to `a.txt` under A's root. With the page-wide
    // workspace, the path would not match `a.txt` at all and nothing would be written.
    remap.remapFile(S1, '/repo-a/a.txt', 'a\nb\n', 'x\na\nb\n')

    expect(writeDraft).toHaveBeenCalledWith('See (a.txt:2) please')
    expect(draft).toBe('See (a.txt:2) please')
  })
})
