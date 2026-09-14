import { describe, expect, it, vi } from 'vitest'
import { createChatBridge } from '../src/client/chat-bridge.ts'
import type { ChatView } from '../src/client/chat-bridge.ts'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

const SID = 'session-1' as SessionId

/**
 * A client context whose session scope exposes one conversation service.
 * @param conversation - the service verbs to expose.
 * @param session - the session-state snapshot the bridge reads.
 * @param chat - the chat view's snapshot to publish, when the test reads the transcript.
 * @returns a context-shaped double.
 */
function contextWith(conversation: unknown, session: Record<string, unknown> = { running: false }, chat?: unknown): ClientContext {
  const actx = { get: (name: string) => (name === 'conversation' ? conversation : undefined) }
  const sessions = {
    scope: () => actx,
    binding: () => ({ session: { getSnapshot: () => session } }),
  }
  const uiConversation = chat === undefined ? undefined : {
    binding: () => ({ target: (name: string) => (name === 'chat' ? { getSnapshot: () => chat } : undefined) }),
  }
  return {
    get: (name: string) => (name === 'sessions' ? sessions : name === 'uiConversation' ? uiConversation : undefined),
  } as unknown as ClientContext
}

describe('the session chat bridge', () => {
  it('sends through `send` without ever touching the composer draft', () => {
    // The composer belongs to the user: driving a question through it would
    // replace whatever they were typing, so the draft-free verb wins when it exists.
    const send = vi.fn(async () => {})
    const setDraft = vi.fn()
    const submit = vi.fn()
    const bridge = createChatBridge(contextWith({ send, input: { for: () => ({ setDraft, submit }) } }))
    expect(bridge.ask(SID, 'hello')).toBe(true)
    expect(send).toHaveBeenCalledWith('hello')
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('restores the user\'s draft when it has to go through the composer', async () => {
    vi.useFakeTimers()
    try {
      const setDraft = vi.fn()
      const submit = vi.fn()
      const state = { getSnapshot: () => ({ draft: 'half-written question' }) }
      const bridge = createChatBridge(contextWith({ input: { for: () => ({ setDraft, submit, state }) } }))
      expect(bridge.ask(SID, 'the prompt')).toBe(true)
      expect(setDraft).toHaveBeenCalledWith('the prompt')
      expect(submit).toHaveBeenCalledWith('queue')
      // The prompt leaves the composer first; the user's own text comes back after.
      await vi.runAllTimersAsync()
      expect(setDraft).toHaveBeenLastCalledWith('half-written question')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads a user message\'s text out of the durable block vocabulary', () => {
    // The transcript tags the two bodies differently and both are live: an assistant
    // node carries `AssistantBlock[]` (`kind: 'text'`), while a USER node carries the
    // durable `ContentBlock[]` (`type: 'text'`) — the shape a comment's own prompt is
    // stored in. A reader that knew only `kind` saw every user message as empty, so a
    // queued comment could never recognise the prompt it was waiting for.
    const chat = {
      legacy: {
        nodes: [
          { kind: 'user', content: [{ type: 'text', text: '[评论] (a.ts:1-2)\nwhy?' }] },
          // A prompt sent WHILE a turn is running lands as `steering`, not `user`.
          { kind: 'steering', content: [{ type: 'text', text: 'sent mid-turn' }] },
          { kind: 'assistant', blocks: [{ kind: 'reasoning', text: 'hmm' }, { kind: 'text', text: 'an answer' }] },
          // A turn stopped by the user: the runtime freezes what it had, often nothing.
          { kind: 'assistant', blocks: [], interrupted: true },
        ],
        partial: { blocks: [{ kind: 'text', text: 'streaming' }] },
      },
    }
    const bridge = createChatBridge(contextWith({}, { running: false }, chat))
    const seen: ChatView[] = []
    bridge.watch(SID, (view) => { seen.push(view) })
    expect(seen.at(-1)).toMatchObject({
      running: false,
      partial: 'streaming',
      nodes: [
        { kind: 'user', text: '[评论] (a.ts:1-2)\nwhy?' },
        // The steering message is the human too: it is how a prompt sent while a turn
        // was running reaches the transcript, so a comment sent mid-turn is found.
        { kind: 'user', text: 'sent mid-turn' },
        { kind: 'assistant', text: 'an answer' },
        // The frozen node a Stop press leaves: no text, marked interrupted, which is how
        // the panel tells "cut off" from "still coming".
        { kind: 'assistant', text: '', interrupted: true },
      ],
    })
  })

  it('reports what the session is still holding, and says so when it cannot', () => {
    // A prompt that is not in the transcript is either still waiting (the inbox queue,
    // or a local submission echo that has not become durable yet) or gone. The panel
    // needs to tell those apart, so the bridge reports the waiting texts - and
    // `undefined`, never an empty list, on a build whose snapshot has no queue at all.
    const chat = { legacy: { nodes: [] } }
    const withQueue = createChatBridge(contextWith({}, {
      running: true,
      queue: [{ id: 'm1', messageId: 'm1', placement: 'queued', content: [], preview: 'preview only', text: 'queued prompt' }],
      pendingSubmissions: [{ requestId: 'r1', text: 'echoed prompt' }],
    }, chat))
    const seen: ChatView[] = []
    withQueue.watch(SID, (view) => { seen.push(view) })
    expect(seen.at(-1)?.queued).toEqual(['queued prompt', 'echoed prompt'])

    const withoutQueue = createChatBridge(contextWith({}, { running: true }, chat))
    const other: ChatView[] = []
    withoutQueue.watch(SID, (view) => { other.push(view) })
    expect(other.at(-1)?.queued).toBeUndefined()
  })

  it('reports unavailability rather than throwing', () => {
    const bridge = createChatBridge(contextWith({}))
    expect(bridge.ask(SID, 'hello')).toBe(false)
  })
})
