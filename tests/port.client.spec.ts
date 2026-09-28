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
          commentsRevision: 7,
          comments: [
            {
              id: 'c1', sessionId: 'session-1', entryId: 'e1', path: '/repo/a.txt',
              anchor: { startLine: 3, endLine: 4 }, quote: 'a', text: 'why?',
              createdAt: 11, updatedAt: 12, asks: [{ requestId: 'req-1', text: 'why?', turn: 2 }],
            },
            { id: 'c2' },
          ],
          // A blank answer is dropped rather than shown as an empty bubble.
          commentAnswers: { 'req-1': 'because it guards the edge', 'req-2': '' },
          // The lines the host resolved each comment to. Narrowed row by row: only a pair of real
          // numbers is a figure, and a caller handed nothing falls back to the record's anchor.
          commentLines: {
            c1: { start: 4, end: 5 },
            c2: { start: '4', end: 5 },
            c3: { start: 4 },
            c4: null,
          },
          files: [
            {
              id: 'e1', sessionId: 'session-1', path: '/repo/a.txt', earlierVersion: 'file',
              oldText: 'a', newText: 'b', updatedAt: 10, missing: true, diverged: false,
            },
            { sessionId: 'session-1', path: 42 },
            {
              id: 'e2', sessionId: 'session-1', path: '/repo/c.txt', earlierVersion: 'none',
              oldText: '', newText: 'c', updatedAt: 20,
            },
            {
              // A host built before the rename still answers with `kind`. Host and client ship together,
              // but a tab can hold the previous client bundle for a moment, and reading only the new name
              // would blank the list for that moment.
              id: 'e3', sessionId: 'session-1', path: '/repo/d.txt', kind: 'create',
              oldText: '', newText: 'd', updatedAt: 30,
            },
          ],
        },
      },
    })
    const port = createDiffApprovalPort(seam.rpc)
    await expect(port.list(S1)).resolves.toEqual({
      workspacePath: '/repo',
      commentsRevision: 7,
      comments: [
        {
          id: 'c1', sessionId: 'session-1', entryId: 'e1', path: '/repo/a.txt',
          anchor: { startLine: 3, endLine: 4 }, quote: 'a', text: 'why?',
          // The question's own words ride the record: the panel draws them as the follow-up's turn.
          createdAt: 11, updatedAt: 12, asks: [{ requestId: 'req-1', text: 'why?', turn: 2 }],
        },
      ],
      commentAnswers: { 'req-1': 'because it guards the edge' },
      commentLines: { c1: { start: 4, end: 5 } },
      files: [
        {
          id: 'e1', sessionId: 'session-1', path: '/repo/a.txt', earlierVersion: 'file',
          oldText: 'a', newText: 'b', updatedAt: 10, missing: true, diverged: false,
          sessionIds: ['session-1'],
        },
        {
          id: 'e2', sessionId: 'session-1', path: '/repo/c.txt', earlierVersion: 'none',
          oldText: '', newText: 'c', updatedAt: 20, missing: false, diverged: false,
          sessionIds: ['session-1'],
        },
        {
          id: 'e3', sessionId: 'session-1', path: '/repo/d.txt', earlierVersion: 'none',
          oldText: '', newText: 'd', updatedAt: 30, missing: false, diverged: false,
          sessionIds: ['session-1'],
        },
      ],
    })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'list', { sessionId: 'session-1' })
  })

  it('keeps the mark an agent-authored annotation carries', async () => {
    // This is the panel's own door for every comment record — the host has another (`commentOf` in
    // `src/comments.ts`) — so a field this one does not copy is a field the card cannot be drawn from. An
    // agent's annotation came through here without its mark and was drawn as the reader's own words, in the
    // reader's bubble; both doors have a test now, because either one dropping it looks the same on screen.
    const seam = fakeRpc({
      list: {
        ok: true,
        value: {
          commentsRevision: 1,
          comments: [
            {
              id: 'c-agent', sessionId: 'session-1', entryId: 'e1', path: '/repo/a.txt',
              anchor: { startLine: 3, endLine: 3 }, quote: 'a', text: '1. 入口在这里。',
              createdAt: 11, updatedAt: 12, author: 'agent',
            },
            {
              id: 'c-reader', sessionId: 'session-1', entryId: 'e1', path: '/repo/a.txt',
              anchor: { startLine: 4, endLine: 4 }, quote: 'b', text: '这一行是什么？',
              createdAt: 13, updatedAt: 14,
            },
          ],
          files: [],
        },
      },
    })
    const read = await createDiffApprovalPort(seam.rpc).list(S1)
    expect(read.comments.map(comment => [comment.id, comment.author])).toEqual([
      ['c-agent', 'agent'],
      ['c-reader', undefined],
    ])
    // Absent stays absent: the reader's own comments carry no mark at all.
    expect(read.comments[1]).not.toHaveProperty('author')
  })

  it('omits workspacePath when the host sends none', async () => {
    const seam = fakeRpc({ list: { ok: true, value: { files: [] } } })
    // The comments ride the same read, so a host that sends none reads as "no comments
    // yet" rather than leaving the panel with fields it has to guess at.
    await expect(createDiffApprovalPort(seam.rpc).list(S1))
      .resolves.toEqual({ workspacePath: undefined, files: [], comments: [], commentLines: {}, commentsRevision: 0, commentAnswers: {} })
  })

  it('passes the host\'s skill capability through', async () => {
    // The value is narrowed field by field, so a new host field reaches the panel only
    // once it is read here — and the comment prompt's shape depends on this one.
    const seam = fakeRpc({ list: { ok: true, value: { files: [], commentSkill: 'dsh-diff-approval-comment' } } })
    await expect(createDiffApprovalPort(seam.rpc).list(S1))
      .resolves.toMatchObject({ commentSkill: 'dsh-diff-approval-comment' })

    // Malformed is treated as absent, like every other field.
    const bad = fakeRpc({ list: { ok: true, value: { files: [], commentSkill: 42 } } })
    await expect(createDiffApprovalPort(bad.rpc).list(S1))
      .resolves.toMatchObject({ commentSkill: undefined })
  })

  it("passes the host's persist failure through", async () => {
    // Narrowed field by field like the skill above: the host can only tell the reader that the
    // pending state is not reaching the disk through this value (issue #6).
    const seam = fakeRpc({ list: { ok: true, value: { files: [], persistError: 'ENOENT: no such file' } } })
    await expect(createDiffApprovalPort(seam.rpc).list(S1))
      .resolves.toMatchObject({ persistError: 'ENOENT: no such file' })

    // Malformed — and the host's own empty string — read as absent, not as a failure.
    const bad = fakeRpc({ list: { ok: true, value: { files: [], persistError: '' } } })
    await expect(createDiffApprovalPort(bad.rpc).list(S1))
      .resolves.toMatchObject({ persistError: undefined })
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
})

describe('block keep/revert', () => {
  const block = { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }

  it('routes block-keep and passes the block range through', async () => {
    const seam = fakeRpc({ 'block-keep': { ok: true, value: { outcome: 'kept' } } })
    await expect(createDiffApprovalPort(seam.rpc).blockKeep(S1, 'e1', block)).resolves.toEqual({ outcome: 'kept' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'block-keep', { sessionId: 'session-1', id: 'e1', block })
  })

  it('routes block-revert and passes the block range through', async () => {
    const seam = fakeRpc({ 'block-revert': { ok: true, value: { outcome: 'reverted' } } })
    await expect(createDiffApprovalPort(seam.rpc).blockRevert(S1, 'e1', block)).resolves.toEqual({ outcome: 'reverted' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'block-revert', { sessionId: 'session-1', id: 'e1', block })
  })

  it('passes the resolved flag through', async () => {
    const seam = fakeRpc({ 'block-keep': { ok: true, value: { outcome: 'kept', resolved: true } } })
    await expect(createDiffApprovalPort(seam.rpc).blockKeep(S1, 'e1', block)).resolves.toEqual({ outcome: 'kept', resolved: true })
  })

  it('folds a transport error into a rejection', async () => {
    const seam = fakeRpc({ 'block-keep': { ok: false, error: { code: 'internal', message: 'down', details: {} } } })
    await expect(createDiffApprovalPort(seam.rpc).blockKeep(S1, 'e1', block)).rejects.toThrow('internal: down')
  })

  it('rejects a malformed open outcome', async () => {
    const seam = fakeRpc({ open: { ok: true, value: { outcome: 'maybe' } } })
    await expect(createDiffApprovalPort(seam.rpc).open(S1, 'e1', 'open')).rejects.toThrow('malformed outcome')
  })
})

describe('comments', () => {
  const draft = {
    id: 'c1',
    entryId: 'entry-1',
    anchor: { startLine: 3, endLine: 4 },
    quote: 'const a = 1',
    quoteContext: 'before\nconst a = 1\nafter',
    quoteLines: [{ old: 3, new: 3, kind: 'context' as const }],
    text: 'why is this here?',
  }

  it('posts one annotation and narrows the stored record', async () => {
    const seam = fakeRpc({
      'comment-add': {
        ok: true,
        value: {
          outcome: 'added',
          comment: {
            id: 'c1', sessionId: 'session-1', entryId: 'entry-1', path: '/repo/a.txt',
            anchor: { startLine: 3, endLine: 4 }, quote: 'const a = 1', text: 'why is this here?',
            createdAt: 1, updatedAt: 2,
          },
        },
      },
    })
    await expect(createDiffApprovalPort(seam.rpc).commentAdd(S1, draft)).resolves.toEqual({
      outcome: 'added',
      comment: {
        id: 'c1', sessionId: 'session-1', entryId: 'entry-1', path: '/repo/a.txt',
        anchor: { startLine: 3, endLine: 4 }, quote: 'const a = 1', text: 'why is this here?',
        createdAt: 1, updatedAt: 2,
      },
    })
    // The display path is the host's to fill: the entry the comment hangs off is its
    // authority on what the file is called.
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'comment-add', { sessionId: 'session-1', ...draft })
  })

  it('reports a refused write rather than inventing a stored comment', async () => {
    // The entry left the list between the panel's read and its write.
    const seam = fakeRpc({ 'comment-add': { ok: true, value: { outcome: 'missing' } } })
    await expect(createDiffApprovalPort(seam.rpc).commentAdd(S1, draft)).resolves.toEqual({ outcome: 'missing' })
    // An `added` that carries no record is a broken host, not an empty comment.
    const broken = fakeRpc({ 'comment-add': { ok: true, value: { outcome: 'added' } } })
    await expect(createDiffApprovalPort(broken.rpc).commentAdd(S1, draft)).rejects.toThrow('malformed value')
  })

  it('removes one annotation', async () => {
    const seam = fakeRpc({ 'comment-remove': { ok: true, value: { outcome: 'removed' } } })
    await expect(createDiffApprovalPort(seam.rpc).commentRemove(S1, 'c1')).resolves.toEqual({ outcome: 'removed' })
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'comment-remove', { sessionId: 'session-1', id: 'c1' })
  })

  it('removes a batch of annotations in one request, and copies the ids onto the wire', async () => {
    const seam = fakeRpc({ 'comment-remove-many': { ok: true, value: { removed: 2 } } })
    const picked = new Set(['c1', 'c2'])
    await expect(createDiffApprovalPort(seam.rpc).commentRemoveMany(S1, picked)).resolves.toEqual({ removed: 2 })
    // One call, both ids — the whole point of the batch. The set is copied onto the wire, so a mutation
    // of the caller's set afterwards cannot reach the request that was sent.
    picked.add('c9')
    await createDiffApprovalPort(seam.rpc).commentRemoveMany(S1, ['c3'])
    expect(seam.call).toHaveBeenNthCalledWith(1, '/diff-approval', 'comment-remove-many',
      { sessionId: 'session-1', ids: ['c1', 'c2'] })
    expect(seam.call).toHaveBeenNthCalledWith(2, '/diff-approval', 'comment-remove-many',
      { sessionId: 'session-1', ids: ['c3'] })
    // A count that is not a count is a broken host, not a batch that dropped nothing.
    const broken = fakeRpc({ 'comment-remove-many': { ok: true, value: { removed: 'two' } } })
    await expect(createDiffApprovalPort(broken.rpc).commentRemoveMany(S1, ['c1']))
      .rejects.toThrow('malformed count')
  })

  it('keeps a pick of files in one request, with the list flag only when it was asked for', async () => {
    const seam = fakeRpc({ 'keep-many': { ok: true, value: { affected: 2 } } })
    await expect(createDiffApprovalPort(seam.rpc).keepMany(S1, ['e1', 'e2'], undefined))
      .resolves.toEqual({ affected: 2 })
    await createDiffApprovalPort(seam.rpc).keepMany(S1, ['e3'], true)
    // One call for the pick — the whole point — and `keepListed` is left off the wire when it was not
    // asked for, so a host cannot read an absent decision as a false one.
    expect(seam.call).toHaveBeenNthCalledWith(1, '/diff-approval', 'keep-many',
      { sessionId: 'session-1', ids: ['e1', 'e2'] })
    expect(seam.call).toHaveBeenNthCalledWith(2, '/diff-approval', 'keep-many',
      { sessionId: 'session-1', ids: ['e3'], keepListed: true })
    // A malformed count is a broken host, not a pick that affected nothing.
    const broken = fakeRpc({ 'keep-many': { ok: true, value: { affected: 'two' } } })
    await expect(createDiffApprovalPort(broken.rpc).keepMany(S1, ['e1'], undefined))
      .rejects.toThrow('malformed')
    // The revert half of the pick rides the same shape, on its own endpoint.
    const reverting = fakeRpc({ 'revert-many': { ok: true, value: { affected: 1 } } })
    await expect(createDiffApprovalPort(reverting.rpc).revertMany(S1, ['e9'], true))
      .resolves.toEqual({ affected: 1 })
    expect(reverting.call).toHaveBeenCalledWith('/diff-approval', 'revert-many',
      { sessionId: 'session-1', ids: ['e9'], keepListed: true })
  })

  it('asks one comment and narrows what became of it', async () => {
    const seam = fakeRpc({ 'comment-ask': { ok: true, value: { outcome: 'asked', requestId: 'req-1' } } })
    await expect(createDiffApprovalPort(seam.rpc).commentAsk(S1, 'c1', 'the prompt', 'why?'))
      .resolves.toEqual({ outcome: 'asked', requestId: 'req-1' })
    // Both strings cross the wire: the prompt is what the agent is asked, the words are what the
    // thread draws.
    expect(seam.call).toHaveBeenCalledWith('/diff-approval', 'comment-ask', {
      sessionId: 'session-1', id: 'c1', prompt: 'the prompt', text: 'why?',
    })

    // A host with no live agent says so, and a failure carries the reason.
    const noAgent = fakeRpc({ 'comment-ask': { ok: true, value: { outcome: 'no-agent' } } })
    await expect(createDiffApprovalPort(noAgent.rpc).commentAsk(S1, 'c1', 'p', 'w')).resolves.toEqual({ outcome: 'no-agent' })
    const failed = fakeRpc({ 'comment-ask': { ok: true, value: { outcome: 'failed', message: 'no live agent' } } })
    await expect(createDiffApprovalPort(failed.rpc).commentAsk(S1, 'c1', 'p', 'w'))
      .resolves.toEqual({ outcome: 'failed', message: 'no live agent' })
  })

  it('rejects a malformed ask outcome', async () => {
    const seam = fakeRpc({ 'comment-ask': { ok: true, value: { outcome: 'perhaps' } } })
    await expect(createDiffApprovalPort(seam.rpc).commentAsk(S1, 'c1', 'p', 'w')).rejects.toThrow('malformed outcome')
  })
})
