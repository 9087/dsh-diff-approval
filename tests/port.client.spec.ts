// The channel port: endpoint selection, wire narrowing, and failure folding.

import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { createDiffApprovalPort } from '../src/client/port.ts'

const S1 = 'session-1' as SessionId

function fakeRpc(answers: Readonly<Record<string, RpcResult<unknown>>>) {
  const call = vi.fn(async (_channel: string, endpoint: string, _payload: unknown) => {
    const answer = answers[endpoint]
    if (answer === undefined) throw new Error(`unexpected endpoint ${endpoint}`)
    return answer
  })
  return { rpc: { call } as unknown as ClientConnectionRpc, call }
}

describe('list', () => {
  it('narrows the wire value and skips malformed rows', async () => {
    const seam = fakeRpc({
      list: {
        ok: true,
        value: {
          workspacePath: '/repo',
          files: [
            {
              id: 'e1', sessionId: 'session-1', path: '/repo/a.txt', kind: 'edit',
              oldText: 'a', newText: 'b', updatedAt: 10, missing: true, diverged: false,
            },
            { sessionId: 'session-1', path: 42 },
            {
              id: 'e2', sessionId: 'session-1', path: '/repo/c.txt', kind: 'create',
              oldText: '', newText: 'c', updatedAt: 20,
            },
          ],
        },
      },
    })
    const port = createDiffApprovalPort(seam.rpc)
    await expect(port.list(S1)).resolves.toEqual({
      workspacePath: '/repo',
      files: [
        {
          id: 'e1', sessionId: 'session-1', path: '/repo/a.txt', kind: 'edit',
          oldText: 'a', newText: 'b', updatedAt: 10, missing: true, diverged: false,
        },
        {
          id: 'e2', sessionId: 'session-1', path: '/repo/c.txt', kind: 'create',
          oldText: '', newText: 'c', updatedAt: 20, missing: false, diverged: false,
        },
      ],
    })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'list', { sessionId: 'session-1' })
  })

  it('omits workspacePath when the host sends none', async () => {
    const seam = fakeRpc({ list: { ok: true, value: { files: [] } } })
    await expect(createDiffApprovalPort(seam.rpc).list(S1)).resolves.toEqual({ workspacePath: undefined, files: [] })
  })

  it('folds a transport error into a rejection', async () => {
    const seam = fakeRpc({
      list: { ok: false, error: { code: 'internal', message: 'down', details: {} } },
    })
    await expect(createDiffApprovalPort(seam.rpc).list(S1)).rejects.toThrow('internal: down')
  })

  it('rejects a malformed list value', async () => {
    const seam = fakeRpc({ list: { ok: true, value: { files: 'nope' } } })
    await expect(createDiffApprovalPort(seam.rpc).list(S1)).rejects.toThrow('malformed value')
  })
})

describe('keep and revert', () => {
  it('narrows each action outcome and validates it', async () => {
    const seam = fakeRpc({
      keep: { ok: true, value: { outcome: 'kept' } },
      revert: { ok: true, value: { outcome: 'reverted' } },
    })
    const port = createDiffApprovalPort(seam.rpc)
    await expect(port.keep(S1, 'e1')).resolves.toEqual({ outcome: 'kept' })
    await expect(port.revert(S1, 'e2')).resolves.toEqual({ outcome: 'reverted' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'keep', { sessionId: 'session-1', id: 'e1' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'revert', { sessionId: 'session-1', id: 'e2' })
  })

  it('rejects a malformed outcome', async () => {
    const seam = fakeRpc({ keep: { ok: true, value: { outcome: 'maybe' } } })
    await expect(createDiffApprovalPort(seam.rpc).keep(S1, '/repo/a.txt')).rejects.toThrow('malformed outcome')
  })

  it('folds an action transport error into a rejection', async () => {
    const seam = fakeRpc({
      revert: { ok: false, error: { code: 'internal', message: 'busy', details: {} } },
    })
    await expect(createDiffApprovalPort(seam.rpc).revert(S1, '/repo/a.txt')).rejects.toThrow('internal: busy')
  })
})

describe('open', () => {
  it('narrows the open outcome and passes the action through', async () => {
    const seam = fakeRpc({
      open: { ok: true, value: { outcome: 'opened' } },
    })
    await expect(createDiffApprovalPort(seam.rpc).open(S1, 'e1', 'reveal')).resolves.toEqual({ outcome: 'opened' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'open', { sessionId: 'session-1', id: 'e1', action: 'reveal' })
  })

  it('accepts the missing outcome', async () => {
    const seam = fakeRpc({ open: { ok: true, value: { outcome: 'missing' } } })
    await expect(createDiffApprovalPort(seam.rpc).open(S1, 'none', 'open')).resolves.toEqual({ outcome: 'missing' })
  })

  it('rejects a malformed open outcome', async () => {
    const seam = fakeRpc({ open: { ok: true, value: { outcome: 'maybe' } } })
    await expect(createDiffApprovalPort(seam.rpc).open(S1, 'e1', 'open')).rejects.toThrow('malformed outcome')
  })
})
