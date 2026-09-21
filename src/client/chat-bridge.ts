/**
 * The panel's one connection to the session's chat: send one prompt, and watch
 * the transcript so a discussion can show its answer where it was asked.
 *
 * Everything here is deliberately defensive. The surfaces it uses (the scoped
 * `conversation` input face, the `sessions` binding, the `chat` view target) are
 * public types but not plugin-documented API, so a build that lacks one reports
 * "unavailable" and the caller falls back to the composer route it already had.
 *
 * @module dsh-diff-approval/client/chat-bridge
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** One human-visible transcript node, reduced to what a discussion shows. */
export interface ChatNodeView {
  /** `user`, `assistant`, or the node's own kind for anything else. */
  kind: string
  /** The node's text blocks joined; empty for nodes that carry no prose. */
  text: string
  /**
   * The runtime froze this assistant node when the turn was stopped (`interrupted` on
   * the durable node). A stopped turn leaves one of these, often with no text, which is
   * how a caller can tell "the answer was cut off" from "the answer is still coming".
   * Only ever set when true.
   */
  interrupted?: boolean
}

/** What a discussion needs to know about the session's chat right now. */
export interface ChatView {
  /** A turn is running for this session. */
  running: boolean
  /** The durable transcript, in order. */
  nodes: readonly ChatNodeView[]
  /** The in-flight assistant text, or '' when nothing is streaming. */
  partial: string
  /** The session's recorded prompt error, when there is one. */
  error: string | undefined
  /**
   * The prompts the session is still holding — its inbox queue plus the local
   * submission echoes that have not become durable yet — or `undefined` on a build
   * that does not publish them. A prompt that is not in the transcript is either one
   * of these (still waiting) or gone (dropped with a stopped turn); without the
   * evidence a caller can only keep waiting.
   */
  queued: readonly string[] | undefined
}

/** The session chat as the panel uses it. */
export interface ChatBridge {
  /**
   * Send one prompt into the session as a real turn.
   * @param sessionId - the session to prompt.
   * @param text - the prompt text, sent verbatim.
   * @returns whether the send verb was available (false means "not sent").
   */
  ask: (sessionId: SessionId, text: string) => boolean
  /**
   * Watch the session's transcript and turn state.
   * @param sessionId - the session to watch.
   * @param listener - called with the current view, then on every change.
   * @returns the unsubscribe function.
   */
  watch: (sessionId: SessionId, listener: (view: ChatView) => void) => () => void
}

/**
 * A block that carries prose. The two vocabularies differ and both are live: the UI's
 * `AssistantBlock` tags a text block with `kind`, while the durable `ContentBlock[]` a
 * USER message carries — the very shape the comment's own prompt is stored in — tags
 * it with `type`. A reader that knew only `kind` therefore saw every user message as
 * empty, which is what left a queued comment waiting for a prompt it could never
 * recognise. Read both.
 */
interface TextBlock {
  kind?: unknown
  type?: unknown
  text?: unknown
}

/** Join the text blocks of one message body. */
function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is TextBlock => typeof block === 'object' && block !== null
      && ((block as TextBlock).kind === 'text' || (block as TextBlock).type === 'text'))
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(text => text !== '')
    .join('\n')
    .trim()
}

/** The node kinds that carry a message the human sent. */
const HUMAN_KINDS = new Set(['user', 'steering'])

/** Reduce the durable transcript to the nodes a discussion reads. */
function nodesOf(nodes: unknown): ChatNodeView[] {
  if (!Array.isArray(nodes)) return []
  const views: ChatNodeView[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const record = node as { kind?: unknown; blocks?: unknown; content?: unknown; interrupted?: unknown }
    const kind = typeof record.kind === 'string' ? record.kind : 'unknown'
    // A prompt sent WHILE a turn is running is admitted from the next-step inbox and
    // lands as `steering`, not `user` — "a human message admitted while a turn was
    // running" (records.d.ts). Both are the human speaking, and both carry the prompt
    // in `content`, so a comment sent mid-turn is found by the same matcher.
    if (kind === 'assistant') {
      views.push(record.interrupted === true
        ? { kind, text: textOf(record.blocks), interrupted: true }
        : { kind, text: textOf(record.blocks) })
    } else if (HUMAN_KINDS.has(kind)) views.push({ kind: 'user', text: textOf(record.content) })
  }
  return views
}

/**
 * The prompts the session is still holding, from the two places that know: its inbox
 * queue (`QueuedMessage[]`, whose `text` is the prompt) and the local submission
 * echoes (`pendingSubmissions`, dropped only once the durable message is observed).
 * `undefined` when the snapshot does not publish a queue at all, so a caller can tell
 * "nothing is waiting" from "this build cannot say".
 *
 * @param session - the session-state snapshot, or undefined.
 * @returns the waiting prompt texts, or undefined on a build that cannot say.
 */
function queuedOf(session: Record<string, unknown> | undefined): readonly string[] | undefined {
  const queue = session?.queue
  if (!Array.isArray(queue)) return undefined
  const pending = Array.isArray(session?.pendingSubmissions) ? session.pendingSubmissions : []
  const texts: string[] = []
  for (const entry of [...queue, ...pending]) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { text?: unknown; preview?: unknown }
    const text = typeof record.text === 'string' && record.text !== ''
      ? record.text
      : (typeof record.preview === 'string' ? record.preview : '')
    if (text !== '') texts.push(text)
  }
  return texts
}

/** Whether two node lists say the same thing (the transcript is rebuilt on every read). */
function sameNodes(left: readonly ChatNodeView[], right: readonly ChatNodeView[]): boolean {
  return left.length === right.length && left.every((node, index) => {
    const other = right[index]!
    return node.kind === other.kind && node.text === other.text && node.interrupted === other.interrupted
  })
}

/** Whether two waiting-prompt lists say the same thing. */
function sameQueued(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.length === right.length && left.every((text, index) => text === right[index]))
}

/** Whether a freshly read view says anything the consumer has not already been told. */
function sameView(left: ChatView | undefined, right: ChatView): boolean {
  return left !== undefined
    && left.running === right.running
    && left.partial === right.partial
    && left.error === right.error
    && sameQueued(left.queued, right.queued)
    && sameNodes(left.nodes, right.nodes)
}

/**
 * How often a watched session's turn state is re-read, in ms.
 *
 * The transcript arrives by subscription, but `running` and the queue are read from the session
 * snapshot, which the chat target does not publish: a turn that ends without another transcript change
 * (the answer already written, nothing more to say) left the consumer holding `running: true` — which is
 * how a comment sat at "答复中" long after its session was done. The panel cannot ask for a re-read, so
 * the bridge does. What a tick costs is a snapshot read and the node walk behind it; what it must NOT
 * cost is a delivery, and `sameView` is what stops one (see `watch`).
 */
const TURN_STATE_REFRESH_MS = 1000

/**
 * Build the bridge over the client context. Every verb takes the session it
 * addresses, so one bridge serves whichever session the panel is showing.
 * @param ctx - the plugin's client context.
 * @returns the bridge (its verbs report unavailability instead of throwing).
 */
export function createChatBridge(ctx: ClientContext): ChatBridge {
  const scoped = (sessionId: SessionId): { actx: ClientContext; binding: {
    session?: {
      getSnapshot?: () => unknown
      /** The session face IS an observable snapshot (`SessionFace`), so its store can be subscribed. */
      subscribe?: (listener: () => void) => () => void
    }
    eventSource?: unknown
  } | undefined } | undefined => {
    try {
      const sessions = ctx.get('sessions') as {
        scope?: (id: SessionId) => ClientContext | undefined
        binding?: (id: SessionId) => {
          session?: {
            getSnapshot?: () => unknown
            subscribe?: (listener: () => void) => () => void
          }
        } | undefined
      } | undefined
      const actx = sessions?.scope?.(sessionId)
      if (actx === undefined) return undefined
      return { actx, binding: sessions?.binding?.(sessionId) }
    } catch {
      return undefined
    }
  }
  /**
   * Subscribe to the session LIST store — the one observable the host documents as carrying a session's
   * `running` state (`SessionSummary.running`, fed by the controller's running-state change).
   * @param listener - called on every list-store change.
   * @returns the unsubscribe, or undefined on a build without the store.
   */
  const watchList = (listener: () => void): (() => void) | undefined => {
    try {
      const sessions = ctx.get('sessions') as {
        list?: { subscribe?: (fn: () => void) => () => void }
      } | undefined
      const stop = sessions?.list?.subscribe?.(listener)
      return typeof stop === 'function' ? stop : undefined
    } catch {
      return undefined
    }
  }
  const ask = (sessionId: SessionId, text: string): boolean => {
    const target = scoped(sessionId)
    if (target === undefined) return false
    try {
      const conversation = target.actx.get('conversation') as {
        send?: unknown
        input?: { for?: (actx: ClientContext) => {
          setDraft?: unknown
          submit?: unknown
          state?: { getSnapshot?: () => unknown }
        } }
      } | undefined
      // `send` posts the prompt straight into the session and never touches the
      // composer draft, so it is the path that cannot clobber what the user was
      // typing. Failures land in the session's `promptError`, which `watch` reads.
      if (typeof conversation?.send === 'function') {
        void Promise.resolve((conversation.send as (value: string) => unknown)(text)).catch(() => {})
        return true
      }
      const input = conversation?.input?.for?.(target.actx)
      if (typeof input?.setDraft !== 'function' || typeof input.submit !== 'function') return false
      const previous = (() => {
        try {
          const state = input.state?.getSnapshot?.() as { draft?: unknown } | undefined
          return typeof state?.draft === 'string' ? state.draft : ''
        } catch {
          return ''
        }
      })()
      ;(input.setDraft as (value: string) => void)(text)
      ;(input.submit as (mode?: string) => void)('queue')
      // Hand the composer back: our prompt has been admitted by now, and taking
      // over what the user had typed there is not ours to do.
      if (previous !== '') {
        window.setTimeout(() => {
          try {
            ;(input.setDraft as (value: string) => void)(previous)
          } catch {
            // A composer that refuses the restore keeps the prompt text; nothing else fails.
          }
        }, 0)
      }
      return true
    } catch {
      return false
    }
  }
  const currentView = (sessionId: SessionId): ChatView => {
    const target = scoped(sessionId)
    if (target === undefined) return { running: false, nodes: [], partial: '', error: undefined, queued: undefined }
    const session = (() => {
      try {
        const snapshot = target.binding?.session?.getSnapshot?.()
        return typeof snapshot === 'object' && snapshot !== null ? snapshot as Record<string, unknown> : undefined
      } catch {
        return undefined
      }
    })()
    const chat = (() => {
      try {
        const uiConversation = ctx.get('uiConversation') as {
          binding?: (id: SessionId) => { target?: (name: string) => { getSnapshot?: () => unknown } | undefined } | undefined
        } | undefined
        const value = uiConversation?.binding?.(sessionId)?.target?.('chat')?.getSnapshot?.()
        return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
      } catch {
        return undefined
      }
    })()
    const legacy = (chat?.legacy ?? {}) as { nodes?: unknown; partial?: unknown }
    const partial = (() => {
      const value = legacy.partial as { blocks?: unknown } | null | undefined
      return value == null ? '' : textOf(value.blocks)
    })()
    const error = session?.promptError
    return {
      running: session?.running === true,
      nodes: nodesOf(legacy.nodes),
      partial,
      error: error == null ? undefined : String(error),
      queued: queuedOf(session),
    }
  }
  const watch = (sessionId: SessionId, listener: (view: ChatView) => void): (() => void) => {
    const target = scoped(sessionId)
    if (target === undefined) {
      listener(currentView(sessionId))
      return () => {}
    }
    const unsubscribes: (() => void)[] = []
    // Only a CHANGE is delivered, whoever asked. A transcript that was rebuilt into equal nodes, or the
    // session store reporting something this view does not read, would otherwise hand the panel a fresh
    // object: a React re-render, and — for a block that is waiting — a state write that travels on into the
    // page's comment memory. Equal reads are dropped here instead.
    let delivered: ChatView | undefined
    const notify = (): void => {
      const view = currentView(sessionId)
      if (sameView(delivered, view)) return
      delivered = view
      listener(view)
    }
    // The turn state first: `running` and the queue are NOT published through the chat target, they are the
    // session's own snapshot — and that snapshot is an observable (`SessionFace`), so its store reports the
    // turn ENDING quietly, which is the report that was missing (a comment sat at "答复中" long after its
    // session was done). The list store carries the same running state (`SessionSummary.running`), so it is
    // subscribed too: whichever of the two the host actually publishes through, one of them fires.
    try {
      const stopSession = target.binding?.session?.subscribe?.(notify)
      if (typeof stopSession === 'function') unsubscribes.push(stopSession)
    } catch {
      // A session face without a store falls through to the other two below.
    }
    const stopList = watchList(notify)
    if (stopList !== undefined) unsubscribes.push(stopList)
    try {
      const uiConversation = ctx.get('uiConversation') as {
        binding?: (id: SessionId) => { target?: (name: string) => { subscribe?: (fn: () => void) => () => void } | undefined } | undefined
      } | undefined
      // Subscribing is what activates a conversation view target: a bare read
      // returns empty data by contract, which is why this bridge always watches.
      const stop = uiConversation?.binding?.(sessionId)?.target?.('chat')?.subscribe?.(notify)
      if (typeof stop === 'function') unsubscribes.push(stop)
    } catch {
      // A build without the target falls back to the initial snapshot below.
    }
    notify()
    // A reconcile tick, for a build that exposed NEITHER store above: the panel cannot ask for a re-read,
    // and an unreported turn-end is a stuck block. It is the fallback, not the design — with a
    // subscription in place a change arrives as it happens and no timer is installed (see the test).
    const refresh = unsubscribes.length > 0 ? undefined : window.setInterval(notify, TURN_STATE_REFRESH_MS)
    return () => {
      for (const stop of unsubscribes) stop()
      if (refresh !== undefined) window.clearInterval(refresh)
    }
  }
  return { ask, watch }
}
