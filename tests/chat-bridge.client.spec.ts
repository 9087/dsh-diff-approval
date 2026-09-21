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

  it('reconciles a quietly ended turn on its own when the build exposes no store to subscribe', () => {
    // The fallback: a build whose chat target has no store and whose session face and list store are
    // absent. Nothing can report the turn ending, and the panel cannot ask for a re-read, so the bridge
    // reconciles by itself (see `TURN_STATE_REFRESH_MS`). With a store to subscribe, there is no timer —
    // see the next test.
    vi.useFakeTimers()
    try {
      const session: Record<string, unknown> = { running: true, queue: [] }
      const chat = { legacy: { nodes: [] } }
      const actx = { get: () => undefined }
      const sessions = { scope: () => actx, binding: () => ({ session: { getSnapshot: () => session } }) }
      const uiConversation = {
        binding: () => ({ target: (name: string) => (name === 'chat' ? { getSnapshot: () => chat } : undefined) }),
      }
      const ctx = {
        get: (name: string) => (name === 'sessions' ? sessions : name === 'uiConversation' ? uiConversation : undefined),
      } as unknown as ClientContext
      const seen: ChatView[] = []
      const stop = createChatBridge(ctx).watch(SID, (view) => { seen.push(view) })
      expect(seen.at(-1)?.running).toBe(true)

      // The turn ends and the transcript has nothing more to say, so no notification arrives.
      session.running = false
      expect(seen.at(-1)?.running).toBe(true)
      // …and the bridge looks again on its own, which is what hands the block its answer.
      vi.advanceTimersByTime(2000)
      expect(seen.at(-1)?.running).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers nothing when a re-read says the same thing', () => {
    // Every read rebuilds the transcript into fresh node objects, and the stores can report changes this
    // view does not read: without this gate the panel would be handed a new view for nothing — a React
    // re-render, and, for a block that is waiting, a state write that travels on into the page's comment
    // memory. Same content, no delivery; a real change still arrives.
    const session: Record<string, unknown> = { running: false, queue: [] }
    const chat = { legacy: { nodes: [{ kind: 'assistant', blocks: [{ kind: 'text', text: 'first' }] }] } }
    let ping: (() => void) | undefined
    const actx = { get: () => undefined }
    const sessions = { scope: () => actx, binding: () => ({ session: { getSnapshot: () => session } }) }
    const uiConversation = {
      binding: () => ({
        target: (name: string) => (name === 'chat'
          ? { getSnapshot: () => chat, subscribe: (fn: () => void) => { ping = fn; return () => { ping = undefined } } }
          : undefined),
      }),
    }
    const ctx = {
      get: (name: string) => (name === 'sessions' ? sessions : name === 'uiConversation' ? uiConversation : undefined),
    } as unknown as ClientContext
    const seen: ChatView[] = []
    const stop = createChatBridge(ctx).watch(SID, (view) => { seen.push(view) })
    expect(seen).toHaveLength(1)

    // Ten reports that say the same thing: the transcript is rebuilt every time and nothing moved.
    for (let index = 0; index < 10; index++) ping?.()
    expect(seen).toHaveLength(1)

    // A real change still arrives.
    chat.legacy.nodes = [
      { kind: 'assistant', blocks: [{ kind: 'text', text: 'first' }] },
      { kind: 'assistant', blocks: [{ kind: 'text', text: 'second' }] },
    ]
    ping?.()
    expect(seen).toHaveLength(2)
    expect(seen.at(-1)?.nodes.at(-1)?.text).toBe('second')
    stop()
  })

  it('reports a quietly ended turn through the session store, with no timer', () => {
    // The session face IS an observable snapshot (`SessionFace = ISession & ObservableSnapshot<…>`), so the
    // store behind the very snapshot `currentView` reads can be subscribed — and that is where a turn
    // ENDING is published. With a subscription in place no reconcile timer is installed at all: a change
    // that nobody announces is not picked up (that is the point), while the store's own report lands at
    // once.
    vi.useFakeTimers()
    try {
      const session: Record<string, unknown> = { running: true, queue: [] }
      let notifySession: (() => void) | undefined
      const actx = { get: () => undefined }
      const sessions = {
        scope: () => actx,
        binding: () => ({
          session: {
            getSnapshot: () => session,
            subscribe: (fn: () => void) => { notifySession = fn; return () => { notifySession = undefined } },
          },
        }),
      }
      const ctx = { get: (name: string) => (name === 'sessions' ? sessions : undefined) } as unknown as ClientContext
      const seen: ChatView[] = []
      const stop = createChatBridge(ctx).watch(SID, (view) => { seen.push(view) })
      expect(seen.at(-1)?.running).toBe(true)

      // The turn ends and the store says so: no timer is needed, and none would help.
      session.running = false
      notifySession?.()
      expect(seen.at(-1)?.running).toBe(false)

      // A change nobody announces is NOT polled for: there is no tick behind a working subscription.
      session.running = true
      vi.advanceTimersByTime(10 * 1000)
      expect(seen.at(-1)?.running).toBe(false)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unavailability rather than throwing', () => {
    const bridge = createChatBridge(contextWith({}))
    expect(bridge.ask(SID, 'hello')).toBe(false)
  })
})
