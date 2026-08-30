// Scope-addressed conversation access wiring: draft write, queue read filter,
// and queue edit mutation against a faithful fake of the DSH service.

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { conversationAccess, resolveConversation } from '../src/client/conversation-access.ts'

const S1 = 'session-1' as SessionId

interface FakeQueueMessage {
  id: string
  placement: 'queued' | 'steering' | 'context'
  content: readonly { type: string; text?: string }[]
}

function makeHarness(options?: {
  sessionId?: () => SessionId | undefined
  scopeMissing?: boolean
  conversationMissing?: boolean
}) {
  const setDraft = vi.fn()
  const updateQueue = vi.fn(async () => {})
  const queue: FakeQueueMessage[] = [
    { id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'hi (a.txt:1)' }] },
    { id: 'q2', placement: 'steering', content: [{ type: 'text', text: 'steer' }] },
    { id: 'q3', placement: 'queued', content: [{ type: 'text', text: 'yo' }, { type: 'image' }] },
  ]
  const input = { for: () => ({ setDraft, state: { getSnapshot: () => ({ queue }) } }) }
  const conversation = { input, updateQueue }

  const actx = {
    get: (name: string) => (name === 'conversation' ? (options?.conversationMissing ? undefined : conversation) : undefined),
  } as unknown as ClientContext
  const sessions = { scope: (_id: SessionId) => (options?.scopeMissing ? undefined : actx) }
  const ctx = {
    get: (name: string) => (name === 'sessions' ? sessions : undefined),
  } as unknown as ClientContext

  const access = conversationAccess(ctx, options?.sessionId ?? (() => S1))
  return { access, ctx, actx, conversation, setDraft, updateQueue, queue }
}

describe('resolveConversation', () => {
  it('resolves the scoped conversation when a session is current', () => {
    const { ctx, actx, conversation } = makeHarness()
    const resolved = resolveConversation(ctx, S1)
    expect(resolved?.actx).toBe(actx)
    expect(resolved?.conversation).toBe(conversation)
  })

  it('returns undefined without a session id', () => {
    const { ctx } = makeHarness()
    expect(resolveConversation(ctx, undefined)).toBeUndefined()
  })

  it('returns undefined when the session has no scope', () => {
    const { ctx } = makeHarness({ scopeMissing: true })
    expect(resolveConversation(ctx, S1)).toBeUndefined()
  })

  it('returns undefined when the conversation service is absent (no throw)', () => {
    const { ctx } = makeHarness({ conversationMissing: true })
    expect(resolveConversation(ctx, S1)).toBeUndefined()
  })
})

describe('conversationAccess', () => {
  it('writes the draft through the input facade', () => {
    const { access, setDraft } = makeHarness()
    access.writeDraft('新的草稿')
    expect(setDraft).toHaveBeenCalledWith('新的草稿')
  })

  it('reads only queued rows (steering excluded)', () => {
    const { access, queue } = makeHarness()
    expect(access.readQueue()).toEqual([queue[0], queue[2]])
  })

  it('applies an edit mutation to a queued message id', () => {
    const { access, updateQueue } = makeHarness()
    access.writeQueue('q1', [{ type: 'text', text: '改 (a.txt:2)' }])
    expect(updateQueue).toHaveBeenCalledWith('q1', { kind: 'edit', content: [{ type: 'text', text: '改 (a.txt:2)' }] })
  })

  it('no-ops without a current session', () => {
    const { access, setDraft, updateQueue } = makeHarness({ sessionId: () => undefined })
    access.writeDraft('草稿')
    access.writeQueue('q1', [{ type: 'text', text: 'x' }])
    expect(setDraft).not.toHaveBeenCalled()
    expect(updateQueue).not.toHaveBeenCalled()
    expect(access.readQueue()).toEqual([])
  })

  it('no-ops (without throwing) when the scope or conversation is missing', () => {
    for (const opts of [{ scopeMissing: true }, { conversationMissing: true }] as const) {
      const { access, setDraft, updateQueue } = makeHarness(opts)
      expect(() => access.writeDraft('草稿')).not.toThrow()
      expect(() => access.writeQueue('q1', [{ type: 'text', text: 'x' }])).not.toThrow()
      expect(access.readQueue()).toEqual([])
      expect(setDraft).not.toHaveBeenCalled()
      expect(updateQueue).not.toHaveBeenCalled()
    }
  })
})
