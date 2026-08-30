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
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft })

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
    attachReferenceRemap({ store, readDraft: () => draft, writeDraft })

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
    attachReferenceRemap({ store, readDraft: () => '只有普通文字', writeDraft })

    list.mockResolvedValue({ files: [entry('a\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    list.mockResolvedValue({ files: [entry('x\na\nb\n')], workspacePath: '/repo' })
    await store.refresh(S1)

    expect(writeDraft).not.toHaveBeenCalled()
  })
})
