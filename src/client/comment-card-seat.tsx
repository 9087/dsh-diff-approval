/**
 * The session-scoped seat that publishes the shown conversation to the comment-card bridge.
 *
 * It renders nothing: the shell hands every session-scope slot component `sessionId` and `useChat`, and
 * the published snapshot is what lets the DOM side join a rendered trigger card's node key back to the
 * comment it delivered. Both props are read defensively, so a shell that hands only one of them still
 * leaves the other facts intact.
 *
 * @module dsh-diff-approval/client/comment-card-seat
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { publishCommentCards, withdrawCommentCards } from './comment-card.ts'

/** The chat snapshot selector hook, merged onto session-scope slots by ui-chat. */
type ChatSelector = <Selected>(selector: (snapshot: unknown) => Selected) => Selected

/** Props the shell injects into a session-scoped seat. */
export interface CommentCardSeatProps {
  /** The session this seat's page is showing. */
  sessionId?: unknown
  /** The chat snapshot selector, when this shell merges it onto session-scope slots. */
  useChat?: unknown
}

/** A hook stand-in for a shell that does not hand this seat the chat snapshot. */
const noChat: ChatSelector = <Selected,>(selector: (snapshot: unknown) => Selected): Selected => selector(undefined)

/**
 * Publish the shown conversation's snapshot for the comment-card titles.
 * @param props - the shell-injected session id and chat hook.
 * @returns null; this seat is invisible by design.
 */
export function CommentCardSeat(props: CommentCardSeatProps): ReactNode {
  const useChat: ChatSelector = typeof props.useChat === 'function'
    ? props.useChat as ChatSelector
    : noChat
  // Subscribing to the whole snapshot is deliberate: the card map is rebuilt whenever any node changes,
  // which is exactly when a newly delivered comment's card can appear.
  const snapshot = useChat((value: unknown) => value)
  useEffect(() => {
    publishCommentCards(snapshot)
    return () => { withdrawCommentCards() }
  }, [snapshot])
  return null
}
