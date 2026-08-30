/**
 * Scope-addressed access to the session's composer draft and pending queue.
 * Extracted from the plugin entry so the wiring (not just the remap math) is
 * unit-testable against a faithful fake of the DSH conversation service.
 * @module dsh-diff-approval/client/conversation-access
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** One queued message's minimal shape read from the session input state. */
export interface QueueMessageView {
  id: string
  placement: 'queued' | 'steering' | 'context'
  content: readonly { type: string; text?: string }[]
}

/** The conversation service slice the reference remap addresses through a session scope. */
export interface ConversationFace {
  input: {
    for(actx: ClientContext): {
      setDraft(text: string): void
      state: { getSnapshot(): { queue: readonly QueueMessageView[] } }
    }
  }
  updateQueue(itemId: string, action: { kind: 'edit'; content: readonly { type: string; text?: string }[] }): Promise<void>
}

/**
 * Resolve the current session's scoped conversation face. The scoped context
 * (`sessions.scope(id)`) carries no `conversation` inject of its own, so reading
 * it as a property (`actx.conversation`) trips Cordis's inject check and throws
 * `cannot get property "conversation" without inject`. `actx.get('conversation')`
 * bypasses that check yet still returns the traceable bound to `actx`, so its
 * verbs (e.g. `updateQueue`) resolve the right session scope.
 */
export function resolveConversation(ctx: ClientContext, sessionId: SessionId | undefined): {
  actx: ClientContext
  conversation: ConversationFace
} | undefined {
  if (sessionId === undefined) return undefined
  const sessions = ctx.get('sessions') as { scope(id: SessionId): ClientContext | undefined } | undefined
  const actx = sessions?.scope(sessionId)
  if (actx === undefined) return undefined
  const conversation = actx.get('conversation') as ConversationFace | undefined
  if (conversation?.input === undefined) return undefined
  return { actx, conversation }
}

/** Draft/queue verbs bound to the current session, resolved lazily per call. */
export interface ConversationAccess {
  /** Write the current session's composer draft. */
  writeDraft: (text: string) => void
  /** Read the current session's still-queued messages (queued placement only). */
  readQueue: () => readonly QueueMessageView[]
  /** Apply an edit mutation to one queued message's full content. */
  writeQueue: (itemId: string, content: readonly { type: string; text?: string }[]) => void
}

/**
 * Build the per-call-resolved draft/queue accessor. `sessionId` is a function
 * so the accessor always addresses the *current* session, even though it is
 * handed to the remap sync once.
 */
export function conversationAccess(ctx: ClientContext, sessionId: () => SessionId | undefined): ConversationAccess {
  return {
    writeDraft: (text) => {
      const scoped = resolveConversation(ctx, sessionId())
      if (scoped === undefined) return
      scoped.conversation.input.for(scoped.actx).setDraft(text)
    },
    readQueue: () => {
      const scoped = resolveConversation(ctx, sessionId())
      if (scoped === undefined) return []
      // Only queued rows accept queue mutations (steering/context do not).
      return scoped.conversation.input.for(scoped.actx).state.getSnapshot().queue
        .filter((item) => item.placement === 'queued')
    },
    writeQueue: (itemId, content) => {
      const scoped = resolveConversation(ctx, sessionId())
      if (scoped === undefined) return
      void scoped.conversation.updateQueue(itemId, { kind: 'edit', content })
    },
  }
}
