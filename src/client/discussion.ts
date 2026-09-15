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

/**
 * The gutter pair of one quoted line: the numbers the file showed beside it.
 *
 * Kept per line with the quote so an outdated thread can put the code back on the file's own
 * columns — the numbers are what the reader navigates by, and the two sides of a hunk do not
 * simply count up from the range's first line, so they cannot be derived from the anchor.
 */
export interface DiscussionQuoteLine {
  /** Old-file number, `undefined` on a row the old side does not have (an added line). */
  old: number | undefined
  /** New-file number — the second gutter — `undefined` on a removed line. */
  new: number | undefined
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
   * The anchored lines as they read when the thread was created.
   *
   * The line numbers are what a rebuild moves; this is what says whether they still hold the
   * code the comment was written about. When they do not, the thread is re-anchored on the
   * quote (see `remapDiscussion`), and when even that finds nothing the block is marked
   * outdated and the quote is what the reader is shown to know what it had been about.
   */
  quote?: string
  /**
   * The gutter numbers of `quote`'s lines, in the same order, so an outdated block can lay the
   * quote out exactly as the file lays code out. See `DiscussionQuoteLine`.
   */
  quoteLines?: readonly DiscussionQuoteLine[]
  /**
   * The anchor no longer holds the code the thread was written about — the lines were edited
   * under it, or they are gone from the file. The block stays where it last matched, says so,
   * keeps its quote and its turns, and owns no rows: it is read-only (nothing current to write
   * about), it washes no lines, and a new annotation may take the rows under it. Removal is the
   * user's call. The mark is derived from the current model, so the lines coming back with their
   * quote clears it.
   */
  lost?: boolean
  /** The answer being streamed for the question in flight. */
  reply?: string
  /**
   * Where the session's transcript stood when the last question was sent — its node count.
   *
   * Kept with the block rather than only in the panel's refs, so a question still waiting
   * for its answer can be picked up again after the panel is closed and reopened: the search
   * for our own prompt starts here, which is what keeps an older, identical-looking prompt
   * from being mistaken for it.
   */
  baseline?: number
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

/**
 * The body budget for the turns a block shows: how many rows of older turns it is worth
 * carrying before the diff it annotates is swamped. It is spent in WHOLE turns — see
 * `discussionTail` — so a single turn that needs more than this is shown in full rather
 * than sliced in half (which is what a hard cap on the body's row count did).
 */
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
  // The body is taken as measured. It is already the sum of whole turns (the tail drops
  // older ones entirely), so clamping it here would only make the box shorter than the text
  // inside it — which the block clips, leaving the last turn cut off mid-paragraph.
  const body = Math.max(1, discussion.bodyRows ?? DISCUSSION_COMPOSE_ROWS)
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
 * An outdated thread owns no rows: the code under its numbers is no longer what the
 * comment was written about, so it cannot hold the range against a new annotation of the
 * code that is there now. Nothing marks those rows for it either (see the panel's band),
 * which is the same rule seen from the other side: a thread that no longer matches is
 * kept for its quote and its turns, not for its position.
 *
 * @param discussions - the blocks currently attached to this file.
 * @param anchor - the candidate range.
 * @returns the overlapping discussion, or `undefined`.
 */
export function discussionOverlapping(
  discussions: readonly Discussion[],
  anchor: { start: number; end: number },
): Discussion | undefined {
  return discussions.find(entry => entry.lost !== true
    && entry.anchor.start <= anchor.end && anchor.start <= entry.anchor.end)
}

/**
 * The same thread, marked as no longer sitting on the code it was written about.
 *
 * Overdue for nothing but the mark: the anchor, the quote and the turns all stay, so the
 * reader can still see what the comment meant. What goes is the writing row and the ownership
 * of the rows — there is no current code for an answer to be about.
 *
 * @param discussion - the block to mark.
 * @returns the marked block (the same object when it already carried the mark).
 */
function markOutdated(discussion: Discussion): Discussion {
  return discussion.lost === true ? discussion : { ...discussion, lost: true }
}

/**
 * The same thread with the outdated mark cleared, once the code it names holds its quote
 * again (a revert followed by a keep brings the lines back).
 *
 * @param discussion - the block to clear.
 * @returns the cleared block (the same object when it carried no mark).
 */
function clearOutdated(discussion: Discussion): Discussion {
  if (discussion.lost !== true) return discussion
  const next: Discussion = { ...discussion }
  delete next.lost
  return next
}

/**
 * Re-anchor one discussion against the current rows.
 *
 * The anchor's new-file line numbers are what a rebuild moves; the quote the thread carries
 * is what says whether they still hold the code the comment was written about. When they do
 * not — the lines were edited under it, or the hunk moved — the quote is looked for elsewhere
 * in the model and the thread follows it, nearest occurrence first when the same code shows up
 * more than once. When nothing matches, the block keeps the rows it last matched and is marked
 * outdated: it says so and keeps its quote for the reader, rather than being silently moved
 * onto whatever took those lines. Only when the whole range is gone from the model does the
 * block move, and then by line number, back to where the range used to be (see `gone`). The mark
 * is derived, not sticky — the lines coming back with their quote clears it (GitHub recomputes
 * `isOutdated` the same way).
 *
 * @param discussion - the block to re-anchor.
 * @param lineOf - the new-file line number of a row, or `undefined` for a row that has none.
 * @param textOf - the text of a row, for the quote comparison.
 * @param rowCount - how many rows the current model has.
 * @returns the re-anchored discussion (the same object when nothing moved).
 */
export function remapDiscussion(
  discussion: Discussion,
  lineOf: (row: number) => number | undefined,
  textOf: (row: number) => string,
  rowCount: number,
): Discussion {
  const { startLine, endLine } = discussion.anchor
  let start = -1
  let end = -1
  // The last row that still reads before the range: where a block whose whole range is gone
  // belongs (see `gone`).
  let before = -1
  for (let row = 0; row < rowCount; row++) {
    const line = lineOf(row)
    if (line === undefined) continue
    if (line < startLine) {
      before = row
      continue
    }
    if (line > endLine) continue
    if (start === -1) start = row
    end = row
  }
  const quote = discussion.quote
  const span = Math.max(0, endLine - startLine)
  const textAt = (row: number): string => {
    const parts: string[] = []
    for (let index = row; index <= row + span; index++) {
      parts.push(index < rowCount ? textOf(index) : '')
    }
    return parts.join('\n')
  }
  /**
   * The block with no row of its range left in the model: marked outdated, and hung where the
   * range used to be — just below the last row that still reads before its first line.
   *
   * The row index it last matched is not used for that: it is a row index, so every edit above
   * the block shifts what it points at, and the panel clamps it to the file's last row once the
   * file is shorter than it — which is how a comment ends up at the bottom of the file with
   * nothing to do with where it was written. The line numbers stay exactly as they were: they are
   * the original position, and the header keeps showing them.
   *
   * @returns the block, marked and re-hung (the same object when it was already there).
   */
  const gone = (): Discussion => {
    const row = Math.max(0, before)
    if (discussion.lost === true && discussion.anchor.start === row && discussion.anchor.end === row) return discussion
    return markOutdated({ ...discussion, anchor: { ...discussion.anchor, start: row, end: row } })
  }
  // Nothing to check against, or the numbers still hold what the comment was about: the line
  // numbers are the answer, and that is the ordinary case (an edit above the block).
  if (quote === undefined || quote === '' || (start !== -1 && textAt(start) === quote)) {
    if (start === -1) return gone()
    if (start === discussion.anchor.start && end === discussion.anchor.end) return clearOutdated(discussion)
    return clearOutdated({ ...discussion, anchor: { ...discussion.anchor, start, end } })
  }
  // They do not hold it: follow the quote instead. Where the same code appears more than once
  // the nearest occurrence wins, since that is where the reader last saw it.
  let found = -1
  for (let row = 0; row + span < rowCount; row++) {
    if (textAt(row) !== quote) continue
    if (found === -1 || Math.abs(row - start) < Math.abs(found - start)) found = row
  }
  if (found === -1) return start === -1 ? gone() : markOutdated(discussion)
  return clearOutdated({
    ...discussion,
    anchor: {
      ...discussion.anchor,
      start: found,
      end: found + span,
      startLine: lineOf(found) ?? startLine,
      endLine: lineOf(found + span) ?? endLine,
    },
  })
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
