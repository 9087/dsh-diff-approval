// The pending store: refresh, busy tracking, action outcomes, and reset.

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalListValue, PendingFileDiff } from '../src/types.ts'
import type { DiffApprovalPort } from '../src/client/port.ts'
import { createPendingDiffStore } from '../src/client/store.ts'

const S1 = 'session-1' as SessionId
const FILE: PendingFileDiff = {
  id: 'entry-1', sessionId: S1, path: '/repo/a.txt', kind: 'edit',
  oldText: 'a', newText: 'b', updatedAt: 10, missing: false, diverged: false,
}

type ListMock = ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>>
type ActionMock = ReturnType<typeof vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>>
type BlockActionMock = ReturnType<typeof vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>>

/** A port plus its mocks, so tests control the answers through local bindings. */
interface PortSeam {
  port: DiffApprovalPort
  list: ListMock
  keep: ActionMock
  revert: ActionMock
  blockKeep: BlockActionMock
  blockRevert: BlockActionMock
}

/** Build one seam whose answers the test controls through typed mocks. */
function port(overrides: Partial<Pick<PortSeam, 'list' | 'keep' | 'revert' | 'blockKeep' | 'blockRevert'>> = {}): PortSeam {
  const list = vi.fn<(sessionId: SessionId) => Promise<DiffApprovalListValue>>(async () => ({ files: [FILE] }))
  const keep = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'kept' }))
  const revert = vi.fn<(sessionId: SessionId, id: string) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'reverted' }))
  const blockKeep = vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'kept' }))
  const blockRevert = vi.fn<(sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<DiffApprovalActionValue>>(async () => ({ outcome: 'reverted' }))
  return {
    port: { list, keep, revert, blockKeep, blockRevert, ...overrides },
    list, keep, revert, blockKeep, blockRevert,
  }
}

describe('refresh', () => {
  it('starts unread and publishes the files after a read', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    expect(store.getSnapshot()).toEqual({ read: false, files: [], busy: new Set() })

    const seen = vi.fn()
    const off = store.subscribe(seen)
    await store.refresh(S1)
    expect(store.getSnapshot()).toEqual({ read: true, files: [FILE], busy: new Set(), failed: new Map() })
    expect(seen).toHaveBeenCalled()
    off()
  })

  it('publishes an empty view for an absent session without calling the port', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(undefined)
    expect(store.getSnapshot()).toEqual({ read: true, files: [], busy: new Set(), failed: new Map() })
    expect(seam.list).not.toHaveBeenCalled()
  })

  it('keeps the files it had when a read fails and says why', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)

    seam.list.mockRejectedValue(new Error('socket closed'))
    await store.refresh(S1)
    expect(store.getSnapshot()).toEqual({ read: true, files: [FILE], error: 'socket closed', busy: new Set(), failed: new Map() })
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
    expect(store.getSnapshot()).toEqual({ read: true, files: [], busy: new Set(), failed: new Map() })
  })

  it('reverts through the port and removes the entry', async () => {
    const seam = port()
    const store = createPendingDiffStore(seam.port)
    await store.refresh(S1)
    await store.revert(S1, FILE.id)
    expect(seam.revert).toHaveBeenCalledWith(S1, FILE.id)
    expect(store.getSnapshot().files).toEqual([])
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
    expect(store.getSnapshot()).toEqual({ read: false, files: [], busy: new Set() })
  })
})
