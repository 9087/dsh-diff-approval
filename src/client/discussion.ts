/**
 * Discussions attached to a diff row range: how many rows a block reserves in
 * the row stream, and which actions the selection frame offers for a selection.
 *
 * Pure derivation so both rules are unit-testable without the panel — the panel
 * itself only maps these answers onto rows and markup.
 *
 * @module dsh-diff-approval/client/discussion
 */

/** One row range in the current diff model (inclusive, 0-based row indices). */
export interface DiscussionAnchor {
  /** First row of the range, in the model this block is currently drawn against. */
  start: number
  /** Last row of the range. */
  end: number
  /** First new-file line the annotation was made on (survives model changes). */
  startLine: number
  /** Last new-file line of the annotation. */
  endLine: number
}

/** One turn of a discussion: what the user said, or what the agent answered. */
export interface DiscussionMessage {
  /** Who spoke. */
  role: 'user' | 'assistant'
  /** The message text as it is rendered. */
  text: string
}

/** One discussion bound to a row range. */
export interface Discussion {
  /** Stable identity for keys and toggles. */
  id: string
  /** The rows the block sits below. */
  anchor: DiscussionAnchor
  /**
   * The thread so far: the annotation first, then answers and follow-ups in the
   * order they happened. A discussion is a conversation, not one question.
   */
  messages: readonly DiscussionMessage[]
  /** What the user is typing into the compose row (not sent yet). */
  draft: string
  /** Folded to the one-row header. */
  collapsed: boolean
  /**
   * No line of the anchor exists in the file any more (the code was changed or
   * removed under it). The block stays where it last matched, cannot be commented
   * on again, and is the user's to delete.
   */
  lost?: boolean
  /** The answer being streamed for the question in flight. */
  reply?: string
  /** The turn for the last question is running. */
  asking?: boolean
  /**
   * The question is sent but still behind another turn of the session, so nothing
   * streamed yet belongs to this discussion. The block says it is waiting instead
   * of showing the other turn's answer.
   */
  queued?: boolean
  /** The answer failed (the session recorded a prompt error). */
  failed?: boolean
  /**
   * The turn for the last question was stopped before it wrote an answer. The block
   * says so and offers the writing row again, instead of waiting on a turn that is over.
   */
  stopped?: boolean
  /**
   * How many rows the block's body occupies, measured by the caller from what it
   * actually renders (the thread plus the compose row). It is what keeps a
   * discussion block's height an exact multiple of the code row.
   */
  bodyRows?: number
  /** How many older messages the row cap left out of the render. */
  hidden?: number
}

/** Rows a folded block occupies: its header line. */
export const DISCUSSION_HEADER_ROWS = 1

/** Rows the compose area occupies: 0.3 + 1.4 + 0.3 of a code row. */
export const DISCUSSION_COMPOSE_ROWS = 2

/** The most rows an answer may take before it would swamp the diff it annotates. */
export const DISCUSSION_MAX_BODY_ROWS = 12

/**
 * The newest turns that fit a size budget, and how many older ones were left out.
 * A thread grows without bound, so the block shows its tail and says what it is
 * hiding rather than clipping silently; the hidden note costs one row of the
 * budget itself. Sizes are in whatever unit the caller budgets in (the panel uses
 * code rows, fractions included, and rounds the total up once).
 *
 * @param messages - the whole thread, oldest first.
 * @param sizeOf - the size one message needs when rendered (text plus its chrome).
 * @param capRows - the body budget.
 * @returns the messages to render, the count left out, and the size they need.
 */
export function discussionTail(
  messages: readonly DiscussionMessage[],
  sizeOf: (message: DiscussionMessage) => number,
  capRows: number,
): { messages: readonly DiscussionMessage[]; hidden: number; rows: number } {
  let rows = 0
  let keep = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const size = Math.max(1, sizeOf(messages[index]!))
    const reserve = index > 0 ? 1 : 0
    if (keep > 0 && rows + size + reserve > capRows) break
    rows += size
    keep += 1
  }
  const hidden = messages.length - keep
  return {
    messages: messages.slice(hidden),
    hidden,
    rows: rows + (hidden > 0 ? 1 : 0),
  }
}

/**
 * An answer with its blank lines dropped.
 *
 * The thread is plain text laid out in code rows, so a blank line between two
 * paragraphs costs a whole row of height and reads as a gap in the code it
 * annotates. The prompt asks the agent not to write them; this is what makes a
 * stray one harmless, and both the render and the row measurement run the answer
 * through it so the two can never disagree about how tall a turn is. What the user
 * typed is shown exactly as typed.
 *
 * @param text - the answer text.
 * @returns the same text without empty (or whitespace-only) lines.
 */
export function stripBlankLines(text: string): string {
  const kept = text.split('\n').filter(line => line.trim() !== '')
  return kept.join('\n')
}

/**
 * The text of one turn as the thread shows it: an answer loses its blank lines, a
 * first-person turn keeps every one of them.
 *
 * @param message - the turn to render.
 * @returns the text to lay out and to render.
 */
export function discussionText(message: DiscussionMessage): string {
  return message.role === 'assistant' ? stripBlankLines(message.text) : message.text
}

/**
 * How many rows a block reserves, so the diff's height table stays exact.
 * @param discussion - the discussion to measure.
 * @returns the row count the block contributes.
 */
export function discussionRows(discussion: Discussion): number {
  if (discussion.collapsed) return DISCUSSION_HEADER_ROWS
  const body = Math.max(1, Math.min(discussion.bodyRows ?? DISCUSSION_COMPOSE_ROWS, DISCUSSION_MAX_BODY_ROWS))
  return DISCUSSION_HEADER_ROWS + body
}

/**
 * Extra rows to add to each diff row's height: the block hangs below its range's
 * last row, so a block's rows belong to that row's entry in the height table.
 * Several blocks on one row sum up.
 *
 * @param discussions - the blocks currently attached to this file.
 * @param rowCount - how many rows the diff has (clamps a stale anchor).
 * @returns a map from row index to the rows added below it.
 */
export function discussionRowExtras(
  discussions: readonly Discussion[],
  rowCount: number,
): Map<number, number> {
  const extras = new Map<number, number>()
  for (const discussion of discussions) {
    const last = Math.max(0, Math.min(discussion.anchor.end, Math.max(0, rowCount - 1)))
    extras.set(last, (extras.get(last) ?? 0) + discussionRows(discussion))
  }
  return extras
}

/**
 * Where each block sits relative to the row it hangs below: which row owns it,
 * and how many block rows are already reserved under that row. Blocks sharing a
 * row stack in insertion order, so their reserved rows never overlap.
 *
 * @param discussions - the blocks currently attached to this file.
 * @param rowCount - how many rows the diff has (clamps a stale anchor).
 * @returns a map from discussion id to its placement.
 */
export function discussionPlacements(
  discussions: readonly Discussion[],
  rowCount: number,
): Map<string, { row: number; belowRows: number }> {
  const placements = new Map<string, { row: number; belowRows: number }>()
  const used = new Map<number, number>()
  for (const discussion of discussions) {
    const row = Math.max(0, Math.min(discussion.anchor.end, Math.max(0, rowCount - 1)))
    const belowRows = used.get(row) ?? 0
    used.set(row, belowRows + discussionRows(discussion))
    placements.set(discussion.id, { row, belowRows })
  }
  return placements
}

/**
 * The discussion attached to exactly this range, if there is one.
 *
 * @param discussions - the blocks currently attached to this file.
 * @param anchor - the range to look up.
 * @returns the matching discussion, or `undefined`.
 */
export function discussionOnRange(
  discussions: readonly Discussion[],
  anchor: { start: number; end: number },
): Discussion | undefined {
  return discussions.find(entry => entry.anchor.start === anchor.start && entry.anchor.end === anchor.end)
}

/**
 * The discussion that already covers any part of this range. A row belongs to one
 * annotation at most, so a selection that touches an existing block offers no
 * second one - otherwise two blocks would describe the same line.
 *
 * @param discussions - the blocks currently attached to this file.
 * @param anchor - the candidate range.
 * @returns the overlapping discussion, or `undefined`.
 */
export function discussionOverlapping(
  discussions: readonly Discussion[],
  anchor: { start: number; end: number },
): Discussion | undefined {
  return discussions.find(entry => entry.anchor.start <= anchor.end && anchor.start <= entry.anchor.end)
}

/**
 * Re-anchor one discussion against the current rows: the rows whose new-file line
 * falls inside the annotation's line range. When no line matches any more, the
 * block keeps the rows it last matched and is marked lost, so it stays where the
 * user last saw it and can only be deleted.
 *
 * @param discussion - the block to re-anchor.
 * @param lineOf - the new-file line number of a row, or `undefined` for a row that has none.
 * @param rowCount - how many rows the current model has.
 * @returns the re-anchored discussion (the same object when nothing moved).
 */
export function remapDiscussion(
  discussion: Discussion,
  lineOf: (row: number) => number | undefined,
  rowCount: number,
): Discussion {
  if (discussion.lost === true) return discussion
  let start = -1
  let end = -1
  for (let row = 0; row < rowCount; row++) {
    const line = lineOf(row)
    if (line === undefined || line < discussion.anchor.startLine || line > discussion.anchor.endLine) continue
    if (start === -1) start = row
    end = row
  }
  if (start === -1) {
    // Nothing of the annotation is in the file any more: keep the last rows, stop
    // offering the compose action, and leave removal to the user.
    return { ...discussion, lost: true }
  }
  if (start === discussion.anchor.start && end === discussion.anchor.end) return discussion
  return { ...discussion, anchor: { ...discussion.anchor, start, end } }
}

/** What the selection frame shows for the current selection. */
export interface SelectionFrameActions {
  /** Whether keep/revert apply (the selection fully covers change blocks). */
  keepRevert: boolean
  /** Whether a new discussion may be started on this range. */
  comment: boolean
  /** Whether the frame renders at all (no visible action means no frame). */
  visible: boolean
}

/**
 * Decide the selection frame's contents.
 *
 * Keep/revert needs covered change blocks; commenting needs a range that has no
 * discussion yet. A frame with neither would be an empty floating box, so it is
 * not rendered at all.
 *
 * @param options - whether change blocks are covered, and whether this range already has a discussion.
 * @returns the three flags the caller branches on.
 */
export function selectionFrame(options: { coversBlocks: boolean; hasDiscussion: boolean }): SelectionFrameActions {
  const keepRevert = options.coversBlocks
  const comment = !options.hasDiscussion
  return { keepRevert, comment, visible: keepRevert || comment }
}
