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
    id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
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
})
