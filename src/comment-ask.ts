/**
 * Asking the session's agent about one comment, and reading the answer back out of
 * the transcript.
 *
 * The submission goes through the host's own session API (`ctx.sessionController`),
 * which is the one path that already knows how to admit a prompt: it mints the
 * message, persists it, and — the reason this module needs no identity of its own —
 * stores the request id the caller supplies on the exact user message it accepts
 * (`source.rpcId`). That id is the join key between a comment and its message, and it
 * makes a retried submission the same submission rather than a second one.
 *
 * The answer is never stored: `answers()` derives it from the session's own derived
 * message history on every read, so the transcript stays the single source of truth
 * for what the agent said. The agent is asked with `mode: 'queue'`, so a comment is
 * its own turn ("one ordinary message of its own turn") — two comments asked at the
 * same time are two turns, not one turn two blocks have to share.
 *
 * @module dsh-diff-approval/src/comment-ask
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DiffApprovalCommentAskValue, CommentRecord } from './types.ts'
import { askTranscript } from './comments.ts'
import type { CommentScope, CommentStore } from './comments.ts'

/** The one verb this plugin uses from the host's session business API. */
interface SessionControllerSurface {
  prompt?: (request: PromptRequest, signal?: AbortSignal) => Promise<unknown>
}

/** One prompt submission, narrowed to the fields this plugin fills. */
interface PromptRequest {
  /** Identity persisted on the accepted user message (and its idempotency key). */
  requestId: string
  sessionId: SessionId
  /** `queue` opens the comment's own turn; `steer` would join whatever is running. */
  mode: 'queue'
  content: { type: 'text'; text: string }[]
}

/** An agent-scoped context, narrowed to the listener registration this plugin needs. */
interface AgentContextSurface {
  on?: (name: string, handler: (payload: InboxPayload) => void) => unknown
}

/** A live agent, narrowed to the context its inbox events arrive on. */
interface AgentSurface {
  ctx?: AgentContextSurface
}

/** The agent registry service, narrowed to the lookup. */
interface AgentsSurface {
  get?: (id: SessionId) => AgentSurface | undefined
}

/** What an inbox event carries that this plugin reads. */
interface InboxPayload {
  message?: { source?: { rpcId?: unknown } } | undefined
  turn?: unknown
}

/** One derived transcript message, narrowed to what answering a comment needs. */
interface DerivedMessage {
  role?: unknown
  content?: unknown
  source?: { kind?: unknown; rpcId?: unknown } | undefined
}

/**
 * One entry of the session's event log, narrowed to what answering a comment reads.
 *
 * The log is where the turn numbers live: `deriveMessages` hands back messages with no
 * attribution at all, and an answer belongs to the turn that claimed the question, not
 * to "everything up to the next message a human happened to write".
 */
interface LogEvent {
  type?: unknown
  data?: LogData | undefined
}

/** One event's payload, as the by-type reads below see it. */
interface LogData {
  /** The turn a message or boundary belongs to (`turn/start`, `user/message`, …). */
  turn?: unknown
  /** `assistant/message` carries its assembled message here rather than flat. */
  message?: DerivedMessage | undefined
  /** `user/message` IS the message, so role/content/source sit on the payload. */
  role?: unknown
  content?: unknown
  source?: { kind?: unknown; rpcId?: unknown } | undefined
}

/** A session, narrowed to the reads this module uses. */
interface SessionSurface {
  /**
   * The session's event log, in sequence order. Read through this rather than
   * `deriveMessages()` because only the log carries the turn each message belongs to
   * (see `answerForRequest`).
   */
  snapshotEvents?: () => readonly LogEvent[]
}

/**
 * What one question's transcript read found.
 *
 * `ended` is the turn's own end, not a verdict about the answer: whether an answer exists
 * is what `answer` says. Keeping the two apart is what lets the panel show a stopped note
 * for a turn that ended with nothing while a turn that ended AFTER writing keeps showing
 * its answer.
 */
export interface AskRead {
  /** The claiming turn's last assistant text, or `undefined` while it has written none. */
  answer: string | undefined
  /**
   * The turn that claimed the question, as the transcript itself attributes it. The inbox
   * claim records the same number (`agent/inbox/claimed`); this is the read that does not
   * depend on having been subscribed at the time.
   */
  turn: number | undefined
  /** The claiming turn is over (`turn/end` in the log), whatever it did or did not write. */
  ended: boolean
}

/** Nothing was found: no message of ours, so no turn and no end. */
const NO_READ: AskRead = { answer: undefined, turn: undefined, ended: false }

/**
 * One request's already-read transcripts, keyed by the session read.
 *
 * `undefined` is cached as a value (hence `has`, not a truthy check): a session whose log cannot be
 * read must not be asked for again within the same read, or a folded-over lineage would pay for the
 * same failure once per transcript.
 */
export type TranscriptCache = Map<SessionId, readonly LogEvent[] | undefined>

/** The prompt text a message holds, or '' when it carries none. */
function textOf(message: DerivedMessage): string {
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

/** The request id one message was submitted under, when it has one. */
function requestOf(message: DerivedMessage): string | undefined {
  const rpcId = message.source?.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId : undefined
}

/** The message one `user/message` or `assistant/message` event carries, or undefined. */
function messageOf(event: LogEvent): DerivedMessage | undefined {
  const data = event.data
  if (data === undefined) return undefined
  // `assistant/message` nests its message under `data.message`; `user/message` IS the
  // message, projected verbatim onto the log (`deriveEventMessage` passes `event.data`
  // straight through), so `role` and `source` sit on the payload itself.
  return event.type === 'assistant/message' ? data.message : { role: data.role, content: data.content, source: data.source }
}

/** The turn number one event attributes itself to, or `undefined` when the type has none. */
function turnOf(event: LogEvent): number | undefined {
  // `in` and not `!== undefined`: the log's JSON contract makes every payload with a `turn`
  // key carry a number (and only those types declare the key), so a key present at all is
  // the attribution — while a key absent means the type does not attribute itself.
  const turn = event.data !== undefined && 'turn' in event.data ? event.data.turn : undefined
  return typeof turn === 'number' ? turn : undefined
}

/**
 * The answer to one submitted comment, read from the session's own event log.
 *
 * Our prompt and the turn that ran because of it are one thing. The submission carries a
 * request id on its `user/message` (`source.rpcId`), and `turn/start` is the bracket the
 * log puts around a turn, so the question's own turn IS the window: the assistant
 * messages of that turn are the answer, and `turn/end` for it is where the question is
 * over. Nothing between the two belongs to anyone else.
 *
 * That is what keeps a later input from stealing the answer. A session log has
 * user-role messages no human wrote — a subagent report, a background-job notice, an
 * injected context — and under the old "walk to the next human message, take the last
 * assistant text" rule any of them let the span run on into the NEXT turn's answer, so a
 * comment that had been answered was silently replaced by whatever the agent later said
 * about something else entirely. A tool-result message (role `user` as well) has the
 * same problem for the opposite reason: it is a boundary trap that would end a segment
 * mid-turn and make a question with a tool call behind it look unanswered. Bound by the
 * turn, both read correctly: the tool result is inside it, and the later input is not.
 *
 * @param events - the session's event log, in sequence order.
 * @param requestId - the request id the comment was submitted under.
 * @returns the claiming turn, its answer text, and whether the turn is over.
 */
export function answerForRequest(events: readonly LogEvent[], requestId: string): AskRead {
  let askedAt = -1
  let open: number | undefined
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined || event.type === undefined) continue
    // One pass, carrying the open turn: a `turn/start` opens it, `turn/end` closes it, and
    // a `user/message` belongs to whichever turn is open where it sits. That is the
    // bracketing the loop writes, and it is the only attribution a `user/message`
    // payload carries — it has no turn field of its own.
    if (event.type === 'turn/start') {
      open = turnOf(event)
      continue
    }
    if (event.type === 'turn/end') {
      if (open !== undefined && turnOf(event) === open) open = undefined
      continue
    }
    if (event.type !== 'user/message') continue
    const message = messageOf(event)
    if (message === undefined || requestOf(message) !== requestId) continue
    askedAt = index
    // Walking back for the bracketing `turn/start` is what attributes the question when
    // the read is over a WINDOW — a restored or paged log whose first event is already
    // inside the turn, so nothing before the message opened it here.
    let turn = turnOf(event) ?? open
    for (let back = index; turn === undefined && back >= 0; back--) {
      const earlier = events[back]
      if (earlier?.type === 'turn/start') turn = turnOf(earlier)
    }
    return readTurn(events, askedAt, turn)
  }
  return NO_READ
}

/**
 * The answer the turn named by one question produced.
 *
 * Reads forward from the question: its turn's assistant messages are the answer, and that
 * turn's own `turn/end` is where the question is over. A question the bracketing above
 * could not attribute takes its turn from the FIRST message after it that names one — the
 * log is append-only and a question is followed by its own turn's step, so that is the
 * question's turn; it is what keeps a window whose `turn/start` is outside it readable.
 *
 * @param events - the session's event log, in sequence order.
 * @param askedAt - index of the question's own `user/message`.
 * @param turn - the turn the log attributed the question to, or undefined when it could not.
 * @returns the answer, the turn, and whether the turn is over.
 */
function readTurn(events: readonly LogEvent[], askedAt: number, turn: number | undefined): AskRead {
  let claimed = turn
  let answer: string | undefined
  for (let index = askedAt + 1; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    const eventTurn = turnOf(event)
    if (claimed === undefined && eventTurn !== undefined) claimed = eventTurn
    // Only a boundary that names OUR turn ends it. With no attribution at all there is no
    // bound: the read follows the log rather than stopping on the first boundary it meets.
    const mine = claimed === undefined || eventTurn === undefined || eventTurn === claimed
    if (event.type === 'turn/end' && mine) {
      // The turn is over; nothing after it belongs to this question, and the last
      // assistant text of the turn — or its absence — is the final word.
      return { answer, turn: claimed, ended: true }
    }
    if (event.type !== 'assistant/message' || !mine) continue
    const message = messageOf(event)
    const text = message === undefined ? '' : textOf(message)
    if (text !== '') answer = text
  }
  return { answer, turn: claimed, ended: false }
}

/**
 * Read every question one session has asked, keyed by its request id.
 * @param events - the session's event log, in sequence order.
 * @param requestIds - the questions' request ids.
 * @returns the read per request id; a question the log holds nothing for reads as nothing.
 */
function answersIn(events: readonly LogEvent[], requestIds: readonly string[]): Record<string, AskRead> {
  const reads: Record<string, AskRead> = {}
  for (const requestId of requestIds) reads[requestId] = answerForRequest(events, requestId)
  return reads
}

/**
 * Submits comments as turns of their session, and reads their answers back.
 *
 * One instance serves every session: the store is the state, and the per-agent
 * subscription is registered on first use and lives with the agent's own context.
 */
export class CommentAsker {
  /**
   * The agent each session's inbox events are subscribed on, keyed by session id, with
   * the disposers that release those subscriptions.
   *
   * Keyed by AGENT IDENTITY, not merely "this session id was watched once": a
   * resumed or re-created agent for the same session id is a different object
   * whose listeners live on its OWN context, so a session-id set would consider
   * the new agent already watched and never subscribe to it — leaving `turn`
   * undefined forever, `agent/turn-stopping` never arriving, and the panel stuck
   * on "replying" with no way out (the defect this map replaces). The disposers are
   * what keeps a replacement from leaking a second set of handlers per event.
   */
  private readonly watched = new Map<string, { agent: AgentSurface; detach: readonly (() => void)[] }>()

  /**
   * @param ctx - the plugin's host context (its `sessionController` and `agents` are asked for lazily).
   * @param comments - the comment store the ask is recorded in.
   */
  constructor(private readonly ctx: Context, private readonly comments: CommentStore) {}

  /**
   * Ask one stored comment as its own turn.
   *
   * The request id is recorded BEFORE the submission leaves, so a claim event that
   * arrives while the submission is still in flight already finds its comment. A
   * submission that rejects is marked dropped rather than left looking pending.
   *
   * @param sessionId - the session the question is asked FROM: the prompt goes into it, so its
   *   transcript is where the answer will appear.
   * @param commentId - the comment to ask.
   * @param prompt - the prompt text to send verbatim.
   * @param text - the reader's own words, which the prompt wraps: the thread keeps these.
   * @param signal - aborts the submission.
   * @param inScope - which comment authors the caller's lineage covers, so a thread another seat
   *   wrote can be asked from this one.
   * @returns what the request did.
   */
  async ask(
    sessionId: SessionId,
    commentId: string,
    prompt: string,
    text: string,
    signal: AbortSignal,
    inScope: CommentScope,
  ): Promise<DiffApprovalCommentAskValue> {
    const comment = this.comments.get(commentId)
    // Scoped, not "mine": a thread of any seat in this lineage can be asked, and the guard that used to
    // require the comment's own session would refuse the ask the moment the panel showed a merged row.
    if (comment === undefined || !inScope(comment.sessionId)) return { outcome: 'missing' }
    const controller = this.ctx.get('sessionController') as SessionControllerSurface | undefined
    if (typeof controller?.prompt !== 'function') {
      // Silence here is what made the first live failure undiagnosable: the panel says
      // "the question failed" and nothing anywhere says why. A deployment missing the
      // session API is a fact about the host, and it belongs in the host's log.
      this.ctx.logger.warn('diff-approval: no sessionController.prompt in this host, so a comment cannot be asked')
      return { outcome: 'no-agent' }
    }
    if (this.agentOf(sessionId) === undefined) {
      this.ctx.logger.warn(`diff-approval: no live agent for session ${String(sessionId)}, so a comment cannot be asked`)
      return { outcome: 'no-agent' }
    }
    this.watch(sessionId)
    const requestId = randomUUID()
    this.comments.recordAsk(sessionId, commentId, requestId, undefined, text)
    try {
      await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, signal)
      return { outcome: 'asked', requestId }
    } catch (error: unknown) {
      // The session never took it, so the reader is told now instead of waiting on a
      // turn that will not come. The host rejects a prompt with its own error objects
      // (`session/model-unavailable`, `session/agent-busy`, …), which are not
      // necessarily `Error` instances here — the message is taken from whatever shape
      // arrived rather than turned into "[object Object]".
      const reason = rejectionText(error)
      // Logged as well as returned: the panel shows one line of copy, and a live
      // failure whose only trace is that copy cannot be diagnosed from the host side.
      this.ctx.logger.warn(`diff-approval: asking a comment failed: ${reason}`)
      this.comments.markDroppedForRequest(requestId)
      return { outcome: 'failed', message: reason }
    }
  }

  /**
   * One scope's questions, grouped by THE TRANSCRIPT each was submitted into.
   *
   * A lineage's threads may hold questions asked from several seats, and an answer lives in the
   * transcript of the session that was asked — so the read is per transcript, not per thread. Grouping
   * here (rather than reading each thread separately) is what keeps a poll to ONE log walk per
   * transcript, however many threads asked there.
   *
   * The legacy case is why `askTranscript` exists: a question asked before the asking session was
   * recorded has only the comment's own session to go on, which is where it went.
   * @param visible - the comments this read may see (already scoped by the caller).
   * @returns the request ids per transcript; empty when nothing was ever asked.
   */
  answerGroups(visible: readonly CommentRecord[]): Map<SessionId, string[]> {
    const groups = new Map<SessionId, string[]>()
    for (const comment of visible) {
      for (const ask of comment.asks ?? []) {
        const transcript = askTranscript(ask, comment)
        const ids = groups.get(transcript)
        if (ids === undefined) groups.set(transcript, [ask.requestId])
        else ids.push(ask.requestId)
      }
    }
    return groups
  }

  /**
   * Every question submitted into ONE transcript and what it says about them, keyed by the
   * question's request id (which is what `CommentAsk` records and what a client matches
   * against). Derived from that session's event log on every call and never stored: the log
   * is the one source of truth for what the agent said, so a stored copy could only ever
   * disagree with it.
   * @param sessionId - the transcript to read.
   * @param requestIds - the questions that were submitted into it.
   * @param cache - this request's already-read logs, so the answer fold and the turn-end read
   *   below share ONE walk of a log that can hold >100k events.
   * @returns the read per question; empty when the session holds no questions.
   */
  answersFor(
    sessionId: SessionId,
    requestIds: readonly string[],
    cache?: TranscriptCache,
  ): Record<string, AskRead> {
    // The poll is also what re-arms the watcher. An agent replaced while a question is
    // still pending changes identity under us, and this read — which the panel makes on
    // every list poll — is the moment to move the subscriptions to the live agent (see
    // `watch`). Without it the claim and the turn's end arrive on an agent nobody is
    // listening to, and the thread waits on a turn that is already over.
    this.watch(sessionId)
    if (requestIds.length === 0) return {}
    const events = this.sessionEvents(sessionId, cache)
    if (events === undefined) return {}
    return answersIn(events, requestIds)
  }

  /**
   * The turns the session's log shows as over, for the questions it holds.
   *
   * `agent/turn-stopping` already reports a turn's end live, and that is what usually
   * writes `ended` down (see `markTurnEnded`). Reading it out of the log as well is what
   * makes the flag survive a session this process did not watch end — a resumed session,
   * a client that connected afterwards, a deployment whose agent events cannot be
   * subscribed at all — because `turn/end` is durable and the event is not.
   *
   * @param sessionId - the transcript whose turns to check.
   * @param cache - this request's already-read logs (see `answersFor`).
   * @returns the turns the log closed, or empty when the log cannot be read.
   */
  endedTurns(sessionId: SessionId, cache?: TranscriptCache): number[] {
    const events = this.sessionEvents(sessionId, cache)
    if (events === undefined) return []
    const turns: number[] = []
    for (const event of events) {
      if (event?.type !== 'turn/end') continue
      const turn = turnOf(event)
      if (turn !== undefined) turns.push(turn)
    }
    return turns
  }

  /**
   * One session's event log, as the reads above take it.
   *
   * `snapshotEvents()` and not `deriveMessages()`: the derived history is a list of
   * messages with no turn attribution, and the turn is the whole point of the answer read
   * (see `answerForRequest`). The event log is the session's append-only source of truth
   * and `snapshotEvents` hands back a frozen, sequence-ordered copy of it, so walking it
   * is a plain read that cannot disturb the session.
   *
   * The cache is per REQUEST, not per session: one list read asks this twice for every transcript
   * (the answer fold and the turn-end read), and the copy is the expensive part of a long session's
   * log. `has` rather than a truthy check, so "cannot be read" is cached as such instead of being
   * asked again.
   * @param sessionId - the session to read.
   * @param cache - this request's already-read logs, when the caller is doing several reads.
   * @returns its events, or undefined when no live session can be read.
   */
  private sessionEvents(sessionId: SessionId, cache?: TranscriptCache): readonly LogEvent[] | undefined {
    if (cache !== undefined && cache.has(sessionId)) return cache.get(sessionId)
    // A read that cannot reach the log answers nothing rather than failing: the list
    // read this rides on is the panel's whole view of the session.
    let events: readonly LogEvent[] | undefined
    try {
      const session = this.ctx.sessions.get(sessionId) as SessionSurface | undefined
      events = session?.snapshotEvents?.()
    } catch {
      events = undefined
    }
    cache?.set(sessionId, events)
    return events
  }

  /** The live agent for one session, or `undefined` when this host drives none. */
  private agentOf(sessionId: SessionId): AgentSurface | undefined {
    try {
      const agents = this.ctx.get('agents') as AgentsSurface | undefined
      return agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Subscribe to one agent's inbox, once per LIVE agent, moving to a replacement agent
   * when the session's agent changes under us.
   *
   * The listeners live on the agent's own context, so they go away with the agent
   * and never outlive it — which is exactly why the dedup has to be per agent and
   * not per session: a session whose agent was re-created (a resume, a restart, a
   * rebuilt agent for the same id) has nothing listening on the new one, and every
   * event this module depends on would silently stop arriving. The remembered
   * agent is compared by identity, so a different object re-subscribes and a
   * disposed one's stale entry cannot block it. What the replaced agent held is
   * released first, so re-arming is not a leak: one set of handlers per live agent,
   * not one more per identity change.
   *
   * Called on every ask AND on every poll read (`answersFor`), because the agent can be
   * replaced while a question is still pending — the case where nothing asks again.
   * @param sessionId - the session whose agent to watch.
   */
  private watch(sessionId: SessionId): void {
    const key = String(sessionId)
    const agent = this.agentOf(sessionId)
    const on = agent?.ctx?.on
    if (agent === undefined || typeof on !== 'function') return
    const watching = this.watched.get(key)
    if (watching?.agent === agent) return
    if (watching !== undefined) {
      // The agent this session was watched on is no longer the live one, so what it held
      // is released rather than left attached beside the new subscriptions.
      this.watched.delete(key)
      for (const off of watching.detach) {
        try {
          off()
        } catch {
          // An agent that is already gone has nothing left to release.
        }
      }
    }
    const detach: (() => void)[] = []
    /** Attach one listener, keeping the disposer when the context offers one. */
    const listen = (name: string, handler: (payload: InboxPayload) => void): void => {
      const handle: unknown = on.call(agent.ctx, name, handler)
      if (typeof handle === 'function') detach.push(handle as () => void)
    }
    try {
      listen('agent/inbox/claimed', (payload) => {
        const requestId = requestIdOf(payload)
        if (requestId === undefined) return
        const turn = typeof payload.turn === 'number' ? payload.turn : undefined
        if (turn === undefined) return
        // Keyed by request id alone: the claim is about a question, and that question may have been
        // asked from ANOTHER seat's panel (its `sessionId` on the ask says which transcript it went to).
        this.comments.recordTurnForRequest(requestId, turn)
      })
      listen('agent/inbox/discarded', (payload) => {
        const requestId = requestIdOf(payload)
        if (requestId !== undefined) this.comments.markDroppedForRequest(requestId)
      })
      // The turn is over. Its number is the only handle the event carries, so the
      // questions the inbox claimed for it are the ones marked: a question with no
      // answer and a finished turn was cut off, and the panel can say so instead of
      // showing a block that waits on a turn which ended. The transcript is still what
      // decides the answer, so a turn that stopped after writing one keeps showing it.
      listen('agent/turn-stopping', (payload) => {
        const turn = payload.turn
        if (typeof turn === 'number') this.comments.markTurnEnded(sessionId, turn)
      })
      this.watched.set(key, { agent, detach })
    } catch (error: unknown) {
      // A build whose agent events cannot be subscribed still answers comments: the
      // ask, the transcript read, and the answer all work without the turn number.
      // Nothing half-attached is kept, so the next call retries from a clean slate.
      for (const off of detach) {
        try {
          off()
        } catch {
          // Nothing was attached far enough to need releasing.
        }
      }
      this.ctx.logger.warn(`diff-approval: watching the comment inbox failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The request id one inbox event names, when it names our kind of message. */
function requestIdOf(payload: InboxPayload): string | undefined {
  const rpcId = payload.message?.source?.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId : undefined
}

/**
 * The human text of one rejection.
 *
 * A prompt is refused by the host's session API with its own error objects — a
 * `RemoteError` carrying a code and a message, or a plain thrown value. Reading
 * `message` off whatever arrived keeps the panel's failure line meaningful
 * (`session/model-unavailable`, `session/agent-busy`, …) instead of printing
 * "[object Object]" for the shapes that are not `Error` instances.
 *
 * @param error - the thrown value.
 * @returns its message, or its string form when it carries none.
 */
function rejectionText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return String(error)
}
