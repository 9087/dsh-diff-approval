// CommentAsker: submitting a comment as its own turn through the session API, the
// inbox events that report what became of it, and the answer read back out of the
// session's own event log.

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CommentRecord } from '../src/types.ts'
import { CommentStore } from '../src/comments.ts'
import { CommentAsker, answerForRequest } from '../src/comment-ask.ts'
import { removeTempDir } from './cleanup.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

/**
 * One session-log event, as the read sees it. The logger stamps a `seq` and a `time` on
 * each event; the read keys off the TYPE, the turn number and the payload, so those are
 * the fields built here and the numbers only have to be ordered.
 */
function event(seq: number, type: string, data: Record<string, unknown>): unknown {
  return { type, seq, time: seq, data, surfaceOp: 'append' }
}

/** Opening a turn — the marker that says a turn exists before its message does. */
function turnStart(seq: number, turn: number): unknown {
  return event(seq, 'turn/start', { turn })
}

/** Closing a turn — the authority for "this question is over". */
function turnEnd(seq: number, turn: number): unknown {
  return event(seq, 'turn/end', { turn, reason: { kind: 'completed' } })
}

/** The prompt this plugin submitted, as the session logged it inside its claimed turn. */
function asked(turn: number, requestId: string, text = 'why is this here?'): unknown {
  return { type: 'user/message', seq: 100 + turn, time: 100 + turn, data: { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] } }
}

/** One assistant message of a turn. */
function assistant(turn: number, step: number, text: string): unknown {
  return { type: 'assistant/message', seq: 200 + turn * 10 + step, time: 0, data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

/** One tool result: role `user` too, which is what makes it a boundary trap. */
function toolResult(turn: number, step: number): unknown {
  return { type: 'tool/result', seq: 300 + turn * 10 + step, time: 0, data: { turn, step, message: { role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: 'ok' }] } } }
}

/**
 * A user-role message that no human wrote: a subagent report, a background-job notice, an
 * injected context. It is exactly what the live defect arrived as.
 */
function input(turn: number, kind: string): unknown {
  return { type: 'user/message', seq: 400 + turn, time: 0, data: { role: 'user', source: { kind }, content: [{ type: 'text', text: 'background report' }] } }
}

/** One stored comment. */
function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    id: 'c1',
    sessionId: S1,
    entryId: '/repo/a.txt',
    path: '/repo/a.txt',
    anchor: { startLine: 3, endLine: 4 },
    quote: 'const a = 1',
    text: 'why is this here?',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const roots: string[] = []
/** The last `store()`'s directory, for the tests that assert what reached the disk. */
let root = ''

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDir))
})

async function store(): Promise<CommentStore> {
  root = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-ask-'))
  roots.push(root)
  return new CommentStore(root)
}

describe('answerForRequest', () => {
  it('answers nothing for a request the log does not hold', () => {
    const log = [turnStart(0, 1), assistant(1, 0, 'hello'), turnEnd(9, 1)]
    expect(answerForRequest(log as never, 'req-1')).toEqual({ answer: undefined, turn: undefined, ended: false })
  })

  it('takes the last assistant text of the claiming turn, across a tool result', () => {
    // A turn of several steps writes several assistant messages and a tool-result
    // message between them — role `user` as well, so a position-based boundary would
    // stop at the tool result and a comment with a tool call behind it would look
    // unanswered. The turn number is what bounds it.
    const log = [
      turnStart(0, 1), asked(1, 'req-1'), assistant(1, 0, 'looking'), toolResult(1, 1),
      assistant(1, 1, 'it is a guard'), turnEnd(9, 1),
    ]
    expect(answerForRequest(log as never, 'req-1')).toEqual({ answer: 'it is a guard', turn: 1, ended: true })
  })

  it('never lets a later unrelated input extend the answer', () => {
    // The live defect: a comment's answer was correct, then got REPLACED by the
    // assistant text that answered a later notice. The notice is role `user` with a
    // source that is not `user`, so the old "walk to the next human message" rule read
    // straight through it and adopted the next turn's answer as this comment's.
    const log = [
      turnStart(0, 1), asked(1, 'req-1'), assistant(1, 0, 'the first answer'), turnEnd(2, 1),
      turnStart(3, 2), input(2, 'subagent'), assistant(2, 0, 'the report I was asked for'), turnEnd(9, 2),
    ]
    const read = answerForRequest(log as never, 'req-1')
    expect(read.answer).toBe('the first answer')
    expect(read.turn).toBe(1)
    expect(read.answer).not.toContain('report')
  })

  it('gives two questions in one thread their own turns', () => {
    // Two comments asked at the same time are two turns, not one turn two blocks share
    // (`mode: 'queue'`): each question's answer is its own turn's, in its own order.
    const log = [
      turnStart(0, 1), asked(1, 'req-1'), assistant(1, 0, 'the first answer'), turnEnd(2, 1),
      turnStart(3, 2), asked(2, 'req-2'), assistant(2, 0, 'the second answer'), turnEnd(9, 2),
    ]
    expect(answerForRequest(log as never, 'req-1').answer).toBe('the first answer')
    expect(answerForRequest(log as never, 'req-2').answer).toBe('the second answer')
  })

  it('reports a question whose turn ended with no assistant text as over, not as waiting', () => {
    const log = [turnStart(0, 7), asked(7, 'req-1'), turnEnd(9, 7)]
    expect(answerForRequest(log as never, 'req-1')).toEqual({ answer: undefined, turn: 7, ended: true })
    // …and a turn that is still running is NOT over: the block keeps waiting, which is
    // the whole difference the reader sees.
    expect(answerForRequest([turnStart(0, 7), asked(7, 'req-1')] as never, 'req-1')).toEqual({ answer: undefined, turn: 7, ended: false })
  })

  it('still answers nothing while the turn has written no text', () => {
    const noText = [turnStart(0, 1), asked(1, 'req-1')]
    expect(answerForRequest(noText as never, 'req-1').answer).toBeUndefined()
    const empty = [turnStart(0, 1), asked(1, 'req-1'), assistant(1, 0, '')]
    expect(answerForRequest(empty as never, 'req-1').answer).toBeUndefined()
  })

  it('reads a turn this log window does not open', () => {
    // A window that starts mid-session has the message but not its `turn/start`; the
    // answer must still be the message's own turn's, and its end is still readable.
    const log = [asked(4, 'req-1'), assistant(4, 0, 'late answer'), turnEnd(9, 4)]
    expect(answerForRequest(log as never, 'req-1')).toEqual({ answer: 'late answer', turn: 4, ended: true })
  })
})

describe('CommentAsker', () => {
  interface Setup {
    controller?: boolean
    agent?: boolean
    events?: readonly unknown[]
    prompt?: () => Promise<unknown>
  }

  /** A context carrying only what the asker reads, with its listeners kept for the test. */
  function fakeContext(setup: Setup = {}): {
    ctx: Context
    handlers: Map<string, (payload: unknown) => void>
    calls: { requestId: string; sessionId: SessionId; mode: string; content: unknown }[]
  } {
    const handlers = new Map<string, (payload: unknown) => void>()
    const calls: { requestId: string; sessionId: SessionId; mode: string; content: unknown }[] = []
    const agentCtx = {
      on: (name: string, handler: (payload: unknown) => void) => {
        handlers.set(name, handler)
        return () => {}
      },
    }
    const ctx = {
      get: (name: string) => {
        if (name === 'sessionController') {
          return setup.controller === false ? {} : {
            prompt: (request: { requestId: string; sessionId: SessionId; mode: string; content: unknown }) => {
              calls.push(request)
              return setup.prompt?.() ?? Promise.resolve({ accepted: true })
            },
          }
        }
        if (name === 'agents') return { get: () => (setup.agent === false ? undefined : { ctx: agentCtx }) }
        return undefined
      },
      sessions: {
        get: (id: SessionId) => (setup.events === undefined || id !== S1
          ? undefined
          : { snapshotEvents: () => setup.events }),
      },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    return { ctx, handlers, calls }
  }

  it('refuses a comment that is not in that session', async () => {
    const comments = await store()
    comments.add(comment())
    const { ctx, calls } = fakeContext()
    const asker = new CommentAsker(ctx, comments)
    await expect(asker.ask(S2, 'c1', 'prompt', 'why?', new AbortController().signal)).resolves.toEqual({ outcome: 'missing' })
    await expect(asker.ask(S1, 'nope', 'prompt', 'why?', new AbortController().signal)).resolves.toEqual({ outcome: 'missing' })
    expect(calls).toEqual([])
  })

  it('refuses when this host drives no agent, or has no prompt verb', async () => {
    const comments = await store()
    comments.add(comment())
    const noAgent = fakeContext({ agent: false })
    await expect(new CommentAsker(noAgent.ctx, comments).ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal))
      .resolves.toEqual({ outcome: 'no-agent' })
    expect(noAgent.calls).toEqual([])
    const noController = fakeContext({ controller: false })
    await expect(new CommentAsker(noController.ctx, comments).ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal))
      .resolves.toEqual({ outcome: 'no-agent' })
  })

  it('asks as one queued text turn, and records the request it minted', async () => {
    const comments = await store()
    comments.add(comment())
    const { ctx, calls } = fakeContext()
    const answer = await new CommentAsker(ctx, comments).ask(S1, 'c1', 'the prompt', 'why?', new AbortController().signal)
    expect(answer.outcome).toBe('asked')
    // One text block, in the mode that opens the comment's OWN turn: two comments
    // asked at once are two turns, not one turn two blocks have to share.
    expect(calls).toEqual([{
      requestId: answer.requestId,
      sessionId: S1,
      mode: 'queue',
      content: [{ type: 'text', text: 'the prompt' }],
    }])
    // The identity is on the record before the answer exists, so a client can see
    // which transcript message belongs to this comment — and the reader's own words
    // ride it, because the prompt around them is not what the thread shows.
    expect(comments.get('c1')?.asks?.map(ask => ask.requestId)).toEqual([answer.requestId])
    expect(comments.get('c1')?.asks?.[0]?.text).toBe('why?')
  })

  it('marks the submission dropped when the session refuses it', async () => {
    const comments = await store()
    comments.add(comment())
    const { ctx } = fakeContext({ prompt: () => Promise.reject(new Error('no live agent')) })
    await expect(new CommentAsker(ctx, comments).ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal))
      .resolves.toEqual({ outcome: 'failed', message: 'no live agent' })
    // Nothing is coming, so the reader is told rather than left waiting.
    expect(comments.get('c1')?.asks?.[0]?.dropped).toBe(true)
  })

  it('says why a rejection failed, whatever shape it arrives in', async () => {
    const comments = await store()
    comments.add(comment())
    // The session API refuses a prompt with its own error object — a code and a message,
    // not necessarily an `Error` instance in this realm. The reader still gets the
    // reason instead of "[object Object]".
    const { ctx } = fakeContext({
      prompt: () => Promise.reject({ code: 'session/model-unavailable', message: 'no adapter serves provider "x"' }),
    })
    await expect(new CommentAsker(ctx, comments).ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal))
      .resolves.toEqual({ outcome: 'failed', message: 'no adapter serves provider "x"' })
  })

  it('records the turn an inbox claim reports, and a discard as dropped', async () => {
    const comments = await store()
    comments.add(comment())
    const { ctx, handlers, calls } = fakeContext()
    const asker = new CommentAsker(ctx, comments)
    const answer = await asker.ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal)
    expect(handlers.has('agent/inbox/claimed')).toBe(true)
    expect(calls[0]?.requestId).toBe(answer.requestId)

    handlers.get('agent/inbox/claimed')?.({ message: { source: { rpcId: answer.requestId } }, turn: 3 })
    expect(comments.get('c1')?.asks?.[0]?.turn).toBe(3)
    // Another turn's claim is not ours.
    handlers.get('agent/inbox/claimed')?.({ message: { source: { rpcId: 'someone-else' } }, turn: 4 })
    expect(comments.get('c1')?.asks?.[0]?.turn).toBe(3)
    // The claim wrote the turn down beside the question, not over it.
    expect(comments.get('c1')?.asks?.[0]?.text).toBe('why?')

    handlers.get('agent/inbox/discarded')?.({ message: { source: { rpcId: answer.requestId } } })
    expect(comments.get('c1')?.asks?.[0]?.dropped).toBe(true)
    expect(comments.get('c1')?.asks?.[0]?.text).toBe('why?')
  })

  it('marks the questions of a stopped turn as over', async () => {
    const comments = await store()
    comments.add(comment())
    const { ctx, handlers, calls } = fakeContext()
    const asker = new CommentAsker(ctx, comments)
    const answer = await asker.ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal)
    expect(handlers.has('agent/turn-stopping')).toBe(true)
    handlers.get('agent/inbox/claimed')?.({ message: { source: { rpcId: answer.requestId } }, turn: 5 })
    handlers.get('agent/turn-stopping')?.({ turn: 5 })
    // Claimed and then cut off: the question is over, and the panel may say so. Whether
    // an answer exists is still the transcript's business — this only says the turn
    // stopped, so a turn that wrote its answer keeps showing it.
    expect(comments.get('c1')?.asks?.[0]).toMatchObject({ text: 'why?', turn: 5, ended: true })
    // The event carries no request id, so a turn nothing was claimed by is inert.
    handlers.get('agent/turn-stopping')?.({ turn: 99 })
    expect(comments.get('c1')?.asks).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('derives each comment\'s answer from the transcript, and stores none of it', async () => {
    const comments = await store()
    comments.add(comment())
    comments.add(comment({ id: 'c2', entryId: '/repo/b.txt', path: '/repo/b.txt' }))
    comments.add(comment({ id: 'c3', entryId: '/repo/c.txt', path: '/repo/c.txt' }))
    const log = [
      turnStart(0, 1), asked(1, 'req-1'), assistant(1, 0, 'the first answer'), turnEnd(2, 1),
      turnStart(3, 2), asked(2, 'req-3'), assistant(2, 0, 'the third answer'), turnEnd(9, 2),
    ]
    const { ctx } = fakeContext({ events: log })
    const asker = new CommentAsker(ctx, comments)
    comments.recordAsk(S1, 'c1', 'req-1', undefined, 'why?')
    comments.recordAsk(S1, 'c2', 'req-2', undefined, 'and this one?')
    comments.recordAsk(S1, 'c3', 'req-3', undefined, 'and the third?')
    const reads = asker.answers(S1)
    expect(reads['req-1']).toEqual({ answer: 'the first answer', turn: 1, ended: true })
    expect(reads['req-3']).toEqual({ answer: 'the third answer', turn: 2, ended: true })
    // A question the log holds no message for is not answered at all — and is not over
    // either: nothing has claimed it, so the block keeps waiting rather than saying the
    // turn was cut off.
    expect(reads['req-2']).toEqual({ answer: undefined, turn: undefined, ended: false })
    // Stored nowhere: the record carries the request identity, and what reached the
    // disk holds no answer text at all — the transcript is the only place it lives.
    expect(comments.get('c1')).not.toHaveProperty('answer')
    await comments.settled()
    const raw = await readFile(join(root, `${S1}.json`), 'utf8')
    expect(raw).toContain('req-1')
    expect(raw).not.toContain('the first answer')
  })

  it('answers nothing when the session is gone', async () => {
    const comments = await store()
    comments.add(comment())
    comments.recordAsk(S1, 'c1', 'req-1', undefined, 'why?')
    const { ctx } = fakeContext()
    expect(new CommentAsker(ctx, comments).answers(S1)).toEqual({})
  })

  it('re-subscribes after the session\'s agent is recreated, and records the new turn', async () => {
    // A restart: the SAME session id gets a NEW agent object (the message lives on
    // disk, so the harness builds a fresh agent for it). The old subscription went
    // away with the old agent's context, so a dedup keyed by session id would leave
    // the new agent unwatched — no claim, no turn, and a panel stuck on "replying".
    const comments = await store()
    comments.add(comment({ id: 'c1' }))
    const inboxes: ((payload: unknown) => void)[][] = []
    /** One agent-shaped object: `ctx.on` files its handlers in the newest inbox. */
    const agentFor = (): { ctx: { on: (name: string, handler: (payload: unknown) => void) => () => void } } => ({
      ctx: {
        on: (_name: string, handler: (payload: unknown) => void) => {
          inboxes.at(-1)?.push(handler)
          return () => {}
        },
      },
    })
    let live = agentFor()
    inboxes.push([])
    const ctx = {
      get: (name: string) => {
        if (name === 'sessionController') return { prompt: async () => ({ accepted: true }) }
        if (name === 'agents') return { get: () => live }
        return undefined
      },
      sessions: { get: () => undefined },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    const asker = new CommentAsker(ctx, comments)
    const first = await asker.ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal)
    expect(inboxes[0]).toHaveLength(3)

    // The agent is recreated for the same session id; a second ask must subscribe to
    // the NEW agent rather than trust the old (now disposed) entry.
    live = agentFor()
    inboxes.push([])
    comments.add(comment({ id: 'c2', text: 'and this one?' }))
    const second = await asker.ask(S1, 'c2', 'prompt', 'and this one?', new AbortController().signal)
    expect(inboxes[1]).toHaveLength(3)

    // The claim for the new question reaches it through the NEW subscription.
    inboxes[1]![0]!({ message: { source: { rpcId: second.requestId } }, turn: 9 })
    expect(comments.get('c2')?.asks?.[0]?.turn).toBe(9)
    // The old subscription is not what delivered it, and the first question's own
    // claim still worked while that agent was live.
    inboxes[0]![0]!({ message: { source: { rpcId: first.requestId } }, turn: 3 })
    expect(comments.get('c1')?.asks?.[0]?.turn).toBe(3)
    // The turn-stopping event of the new agent marks the new question over.
    inboxes[1]![2]!({ turn: 9 })
    expect(comments.get('c2')?.asks?.[0]?.ended).toBe(true)
  })

  it('re-arms the watcher on the next poll after the agent is replaced, and releases the dead one', async () => {
    // The other half of the same defect: the agent is replaced while a question is still
    // pending and NOTHING asks again. The panel's next list read is the only moment the
    // watcher can move to the new agent; a watcher that only re-arms on a new ask leaves
    // this question's claim — and its turn-stopping event — arriving with nobody listening,
    // so the thread waits on a turn that is already over.
    const comments = await store()
    comments.add(comment({ id: 'c1' }))
    const inboxes: ((payload: unknown) => void)[][] = []
    /** The agent generation each returned disposer belonged to. */
    const detached: number[] = []
    let generation = -1
    /** One agent-shaped object whose `on` files handlers in the newest inbox. */
    const agentFor = (): { ctx: { on: (name: string, handler: (payload: unknown) => void) => () => void } } => {
      generation += 1
      const mine = generation
      return {
        ctx: {
          on: (_name: string, handler: (payload: unknown) => void) => {
            inboxes.at(-1)?.push(handler)
            return () => { detached.push(mine) }
          },
        },
      }
    }
    let live = agentFor()
    inboxes.push([])
    const ctx = {
      get: (name: string) => {
        if (name === 'sessionController') return { prompt: async () => ({ accepted: true }) }
        if (name === 'agents') return { get: () => live }
        return undefined
      },
      sessions: { get: () => undefined },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    const asker = new CommentAsker(ctx, comments)
    const answer = await asker.ask(S1, 'c1', 'prompt', 'why?', new AbortController().signal)
    expect(inboxes[0]).toHaveLength(3)

    // A restart builds a new agent for the same session id; the question is still pending.
    live = agentFor()
    inboxes.push([])
    asker.answers(S1)
    expect(inboxes[1]).toHaveLength(3)
    inboxes[1]![0]!({ message: { source: { rpcId: answer.requestId } }, turn: 8 })
    expect(comments.get('c1')?.asks?.[0]?.turn).toBe(8)
    // The claim wrote the turn down beside the question, not over it.
    expect(comments.get('c1')?.asks?.[0]?.text).toBe('why?')
    // The dead agent's three listeners were released, so re-arming is not a leak: one
    // disposer per subscription it took.
    expect(detached).toEqual([0, 0, 0])
  })
})
