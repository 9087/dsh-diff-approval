/**
 * Discussions attached to a diff row range: how many rows a block reserves in
 * the row stream, and which actions the selection frame offers for a selection.
 *
 * Pure derivation so both rules are unit-testable without the panel — the panel
 * itself only maps these answers onto rows and markup.
 *
 * @module dsh-diff-approval/client/discussion
 */

// The distance a re-anchor may travel, shared with the host half's own resolution of the same
// comment: one bound for both, so the figure the list shows and the place this half draws the card
// cannot come from two different rules (see `comment-lines.ts`).
import { reanchorWithinLimit } from '../comment-lines.ts'
// The record's own gutter pair, which is the shape a frame read off a stored comment arrives in: the
// same fields this module's `DiscussionQuoteLine` carries, from the half that keeps them.
import type { CommentQuoteLine } from '../types.ts'

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
  /**
   * Which side of the change the row was on when the thread quoted it: an added line, a removed
   * one, or context. Kept so the quote can wear the diff's own green/red washes — the reader
   * recognised those rows by their colour, and a quote that renders them as plain code loses the
   * thing they were looking at. Absent on a thread quoted before this was recorded, which then
   * simply draws no wash.
   */
  kind?: 'add' | 'del' | 'context'
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
   * The quoted rows with one row of context on each side, as they read when the thread was created.
   *
   * The fingerprint a later rebuild matches the thread against. `quote` alone is too weak to say
   * whether the code is still there: a comment on a common line — a closing brace, a blank line —
   * found that line somewhere else in the file, followed it, and stayed live however thoroughly the
   * code under its numbers had been rewritten. The context is what tells a genuine move from that
   * coincidence. Absent on threads recorded before it was kept, which then falls back to matching
   * the quote alone.
   */
  quoteContext?: string
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
  /** The turn for the last question is running. */
  asking?: boolean
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
   * discussion block's height an exact multiple of the thread's own row — which is fixed, not
   * the code's (see `THREAD_ROW_PX`): a thread is prose and keeps its size whatever the reader
   * sets the code's line height to.
   */
  bodyRows?: number
  /**
   * The wrap setting `bodyRows` was counted with, carried by the caller so the quote the
   * block draws reads the very value its rows were reserved from. Set together with
   * `bodyRows` and never on its own; an outdated block reserves the quote's rows in code
   * rows scaled to the thread's grid (see `layoutDiscussion`), and a quote that wrapped
   * while its rows were counted unwrapped — or the other way round — leaves the block
   * exactly as tall as the difference, air that the bottom-anchored writing row shows as
   * a hole in the middle of the thread.
   */
  quoteWrap?: boolean
  /** How many older messages the row cap left out of the render. */
  hidden?: number
  /**
   * Something the reader has not looked at yet arrived in this thread — an agent's own annotation, or
   * an answer to one of its questions — so the card wears the dot. Host truth, carried through from
   * the stored record (see `CommentRecord.unseen`): the block draws it and the card's own visibility
   * is what asks the host to take it down.
   */
  unseen?: boolean
}

/** Rows a folded block occupies: its header line. */
export const DISCUSSION_HEADER_ROWS = 1

/** Rows the compose area occupies: 0.3 + 1.4 + 0.3 of the thread's own row. */
export const DISCUSSION_COMPOSE_ROWS = 2

/**
 * The newest rounds of a thread, and how many older turns were left out.
 *
 * A thread grows without bound, so the block shows its tail and says what it is hiding. The unit
 * is the round rather than a row budget: a block keeps the last `rounds` questions and
 * everything said after them, however long those turns are (the count is a preference). That is possible
 * because the block reserves exactly what it draws (see `discussionRows`), so a long answer is
 * shown in full instead of being sliced — the row budget this replaces existed to stop an old
 * thread from swamping the diff, and a round cap does that without ever cutting a turn in half.
 *
 * @param messages - the whole thread, oldest first.
 * @param rounds - how many rounds to keep (at least one: something has to be visible).
 * @param sizeOf - the size one message needs when rendered (text plus its chrome).
 * @returns the messages to render, the count left out, and the size they need.
 */
export function discussionRounds(
  messages: readonly DiscussionMessage[],
  rounds: number,
  sizeOf: (message: DiscussionMessage) => number,
): { messages: readonly DiscussionMessage[]; hidden: number; rows: number } {
  // Walk back to the question that opens the oldest kept round: everything before it goes, and
  // the answers that follow a question belong to it.
  const keep = Math.max(1, Math.floor(rounds))
  let questions = 0
  let start = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== 'user') continue
    questions += 1
    if (questions === keep) {
      start = index
      break
    }
  }
  const kept = messages.slice(start)
  let shown = kept
  let hidden = start
  // The head of a thread that does not OPEN with a question is not a question at all: it is the annotation
  // an agent-placed card starts with (see `discussionOfRecord`, where `record.author` decides the first
  // turn's role). It is the head of the FIRST round, so trimming older rounds must never slice it away —
  // exactly as a reader's own annotation survives by BEING the first question. What sat between it and the
  // kept rounds is what the hidden count says.
  const head = messages[0]
  if (start > 0 && head !== undefined && head.role !== 'user') {
    shown = [head, ...kept]
    hidden = start - 1
  }
  const rows = shown.reduce((total, message) => total + Math.max(1, sizeOf(message)), 0)
  // The note that says what is hidden is a row of the body itself.
  return { messages: shown, hidden, rows: rows + (hidden > 0 ? 1 : 0) }
}

/** One run of a turn's prose, after its inline Markdown is read. */
export interface DiscussionRun {
  /** A literal run, inline `code`, or **strong** emphasis. */
  kind: 'text' | 'code' | 'strong'
  /** What the run draws: for `code` and `strong`, the text with its markers gone. */
  text: string
}

/**
 * Read one turn's inline Markdown: `code` and **strong**.
 *
 * Deliberately tiny. The thread is laid out on the diff's own row grid — one line box per code
 * row — so nothing here may become a block: no headings, lists, quotes or fenced code. A marker
 * with no partner, or one spanning a line break, is left exactly as typed, and so is everything
 * this does not know about.
 *
 * @param text - the turn's text.
 * @returns its runs, in order.
 */
export function discussionRuns(text: string): DiscussionRun[] {
  const runs: DiscussionRun[] = []
  let literal = ''
  const flush = (): void => {
    if (literal === '') return
    runs.push({ kind: 'text', text: literal })
    literal = ''
  }
  for (let index = 0; index < text.length; index++) {
    const rest = text.slice(index)
    const code = /^`([^`\n]+)`/.exec(rest)
    const strong = code === null ? /^\*\*([^*\n]+)\*\*/.exec(rest) : null
    if (code !== null) {
      flush()
      runs.push({ kind: 'code', text: code[1]! })
      index += code[0].length - 1
      continue
    }
    if (strong !== null) {
      flush()
      runs.push({ kind: 'strong', text: strong[1]! })
      index += strong[0].length - 1
      continue
    }
    literal += text[index]!
  }
  flush()
  return runs
}

/**
 * A turn's text with its inline markers gone: what the runs draw, character for character.
 *
 * The row measurement uses this, so the rows a block reserves and the text it draws agree. The
 * markers are not drawn, and counting them would reserve room for characters nobody sees — which
 * is exactly the kind of whole-row slack that leaves a blank row in the block.
 *
 * @param text - the turn's text.
 * @returns the same text without its `code` and **strong** markers.
 */
export function discussionPlainText(text: string): string {
  return discussionRuns(text).map(run => run.text).join('')
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
 * Where each block's own box starts, in rows, measured from the BASE of the stack it hangs in.
 *
 * Several blocks can end on one row, and then they are drawn one below the other under it, in the
 * order they are held: `discussionRowExtras` charges the row the sum of them all, and the row stream
 * (and the split view's card layer) draws one reserving box per block, in that same order. So the
 * first block of a stack starts at the base, the second one box down, and so on — and a jump that
 * names a block has to add that many boxes to the base, or it lands the top of the stack whatever
 * block the reader asked for.
 *
 * Nothing is reordered here and no height changes: this is a reading of the drawing order the views
 * already use, keyed by block id so a jump can ask for the box it was sent for.
 *
 * @param discussions - the blocks currently attached to this file, in the order they are drawn.
 * @param anchorOf - the row the block hangs under, clamped exactly as the caller's row stream clamps
 *   it (its own height table and its own idea of the last row are what the base below is measured in).
 * @returns a map from block id to the block's own start, in whole rows below its stack's base.
 */
export function discussionStackOffsets(
  discussions: readonly Discussion[],
  anchorOf: (discussion: Discussion) => number,
): Map<string, number> {
  const offsets = new Map<string, number>()
  const stacked = new Map<number, number>()
  for (const discussion of discussions) {
    const at = anchorOf(discussion)
    const below = stacked.get(at) ?? 0
    offsets.set(discussion.id, below)
    stacked.set(at, below + discussionRows(discussion))
  }
  return offsets
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
 * more than once. A match farther from the stored rows than `REANCHOR_MAX_LINES` is not that code
 * having moved but another place in the file that happens to read the same — a look-alike
 * declaration, which the recorded ±1 context cannot tell apart — so it is refused and the block is
 * marked outdated instead. That is the one bound the host half applies in lines as well, so the
 * figure the list ships and the place this half draws the card cannot come from two rules. When
 * nothing matches, the block keeps the rows it last matched and is marked
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
  hasNewLine: (row: number) => boolean = () => true,
): Discussion {
  return remapOne(discussion, lineOf, textOf, rowCount, windowCache(textOf, rowCount), hasNewLine)
}

/**
 * Re-anchor a whole file's blocks in one pass.
 *
 * Each block is re-anchored exactly as `remapDiscussion` does it — same rules, same identities,
 * same "nothing moved, same object back" contract — but the row windows every quote is looked up
 * in are joined ONCE for the whole list. A rebuild (a keep, an edit, a switched file) runs this
 * over every block a file has, and joining the rows per block is what made the pass cost grow with
 * the number of comments on a long file.
 *
 * @param discussions - the blocks to re-anchor.
 * @param lineOf - the new-file line number of a row, or `undefined` for a row that has none.
 * @param textOf - the text of a row, for the quote comparison.
 * @param rowCount - how many rows the current model has.
 * @returns the re-anchored blocks, in the order they came in.
 */
export function remapDiscussions(
  discussions: readonly Discussion[],
  lineOf: (row: number) => number | undefined,
  textOf: (row: number) => string,
  rowCount: number,
  hasNewLine: (row: number) => boolean = () => true,
): readonly Discussion[] {
  const windows = windowCache(textOf, rowCount)
  return discussions.map(discussion => remapOne(discussion, lineOf, textOf, rowCount, windows, hasNewLine))
}

/** Every row window of one span, indexed by its text, in one pass over the rows. */
function windowIndex(textOf: (row: number) => string, rowCount: number, span: number): Map<string, number[]> {
  const byText = new Map<string, number[]>()
  for (let row = 0; row + span < rowCount; row++) {
    const parts: string[] = []
    for (let index = row; index <= row + span; index++) parts.push(index < rowCount ? textOf(index) : '')
    const text = parts.join('\n')
    const rows = byText.get(text)
    if (rows === undefined) byText.set(text, [row])
    else rows.push(row)
  }
  return byText
}

/** One window index per span, built the first time a span is asked for. */
function windowCache(textOf: (row: number) => string, rowCount: number): (span: number) => Map<string, number[]> {
  const cache = new Map<number, Map<string, number[]>>()
  return (span) => {
    let index = cache.get(span)
    if (index === undefined) {
      index = windowIndex(textOf, rowCount, span)
      cache.set(span, index)
    }
    return index
  }
}

/** The body both entry points share: one block, with the row windows read through `windows`. */
function remapOne(
  discussion: Discussion,
  lineOf: (row: number) => number | undefined,
  textOf: (row: number) => string,
  rowCount: number,
  windows: (span: number) => Map<string, number[]>,
  hasNewLine: (row: number) => boolean,
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
  // How many ROWS the quote covers: one line per row, exactly as it was captured. The anchor's
  // line numbers are not that count — a removed row has no new-file number of its own, so a range
  // holding one spans fewer numbers than it does rows, and a span read off them compared a
  // one-row window against a two-row quote: every comment over a changed line looked outdated the
  // first time anything rebuilt the rows (a file switch, a keep, an edit above it).
  const span = Math.max(0, (quote ?? '').split('\n').length - 1)
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
  /** The block live again on `row`..`row + span` (the same object when it was already there). */
  const live = (row: number, last: number): Discussion => (
    row === discussion.anchor.start && last === discussion.anchor.end
      ? clearOutdated(discussion)
      : clearOutdated({ ...discussion, anchor: { ...discussion.anchor, start: row, end: last } })
  )
  /**
   * The window's text with one line of context on each side, in the current model.
   *
   * Compared against the context the thread recorded when it was made (see `quoteContext`): that is
   * what tells a genuine move of the quoted code from another line elsewhere in the file that happens
   * to read the same.
   */
  const contextAt = (row: number): string => {
    const parts: string[] = []
    for (let index = Math.max(0, row - 1); index <= Math.min(rowCount - 1, row + span + 1); index++) {
      parts.push(textOf(index))
    }
    return parts.join('\n')
  }
  // A thread from before quotes were kept has nothing to compare against: its numbers are all there is.
  if (quote === undefined) {
    if (start === -1) return gone()
    return live(start, end)
  }
  /**
   * Whether the window at `row` is code the file still HAS, in some part.
   *
   * A window that survives only among the pending deletions has no new-file line at all: it is the
   * copy the diff is offering to take away, not the lines the file reads now. Both places that accept
   * a window have to ask this (the shortcut below and the search under it), because matching a deleted
   * copy is what leaves a comment looking current after the very lines it was written on are gone.
   *
   * @param row - the first row of the window.
   * @returns whether any row of it is code the file still has.
   */
  const windowIsCurrent = (row: number): boolean => {
    for (let index = row; index <= row + span; index++) if (hasNewLine(index)) return true
    return false
  }
  /**
   * Whether the thread was written ON a row the diff was REMOVING, rather than on code that has since
   * been deleted.
   *
   * The two look identical in the row stream — a comment on a deletion and a comment whose own line was
   * deleted later both hold a row with no new-file line — and the record is the only thing that tells
   * them apart: `quoteLines` keeps the side each quoted row was on when the reader wrote (see
   * `DiscussionQuoteLine`). A quotation of a removed row is an annotation of the change the reader is
   * being asked to review, and it stays live for as long as that deletion is in front of them; a comment
   * whose quoted line was CONTEXT when it was written and reads as a deletion now lost its code to a
   * later edit, which is exactly what the outdated mark is for.
   */
  const writtenOnRemoval = discussion.quoteLines?.some(line => line.kind === 'del') === true
  // The numbers still hold the quoted window AND that window is code the file still has — or the reader
  // wrote the comment on the removal itself: the ordinary case, the one an edit above the block leaves
  // behind, and the annotation of a change being reviewed. An empty window is compared the same way —
  // those lines were blank, and "blank there" is what says they still are.
  //
  // The middle condition is not decoration. The anchor's line numbers match BOTH sides of a change — a
  // deleted row still carries its old-file number — and the row stream puts the deletion first, so a
  // comment whose own line was deleted takes `start` on that deletion, which reads exactly like the
  // quote it took away. Taking it for "the numbers still hold" is what kept such a card looking current
  // — no outdated note, none of the grey, its quote never shown — while the host, which resolves against
  // the file's own lines and has no deletions to match against, had already answered that it cannot
  // place the quote at all. The two halves of one panel disagreed about one comment.
  if (start !== -1 && textAt(start) === quote && (windowIsCurrent(start) || writtenOnRemoval)) {
    // The frame is the QUOTED WINDOW, and only that: one row per quoted line, so the last row is
    // `start + span`. Taking the last row the range's numbers happened to reach instead is what drew
    // a band over rows the reader never picked — a removal below the frame carries an OLD number that
    // can fall inside the frame's new-file range, and the band then stretched down to it.
    return live(start, start + span)
  }
  // They do not hold it: follow the quote instead. Where the same code appears more than once the
  // nearest occurrence wins, since that is where the reader last saw it — the windows are already
  // joined, so this is a lookup rather than a scan. The recorded context has to agree as well wherever
  // the thread carries one, so that a line reading the same somewhere else is not taken for the code
  // the comment was about.
  if (start !== -1) {
    const fingerprint = discussion.quoteContext
    let found = -1
    for (const row of windows(span).get(quote) ?? []) {
      // The window has to be code the file still has, in some part: a copy that survives only among the
      // pending deletions is the one the diff is offering to take away, not the lines the comment is
      // about (see `windowIsCurrent`). Following it is what left a comment live after the code it named
      // had been moved to another place in the file and rewritten there — the old copy still read
      // exactly like the quote.
      if (!windowIsCurrent(row)) continue
      if (fingerprint !== undefined && contextAt(row) !== fingerprint) continue
      // …and it has to be NEAR the rows the comment names (see `REANCHOR_MAX_LINES` in the shared
      // rule). Another declaration that reads the same, tens or hundreds of rows away, is another
      // place in the file: following it is what drew a card far below the line its own item named.
      // The distance is counted in ROWS — this half's own unit — and a row distance is never smaller
      // than the new-file distance it stands for, so nothing the host refused can be taken here.
      if (!reanchorWithinLimit(start, row)) continue
      if (found === -1 || Math.abs(row - start) < Math.abs(found - start)) found = row
    }
    if (found !== -1) {
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
  }
  // The quote is nowhere: the thread is outdated. It hangs by the LINES it names, taken in this model,
  // rather than by the row index it last matched — that index is a row index, so every insert or delete
  // above the block shifts what it points at, and an outdated thread drifted down the file one rebuild
  // at a time instead of staying beside the lines its header still shows.
  if (start === -1) return gone()
  return markOutdated({ ...discussion, anchor: { ...discussion.anchor, start, end } })
}

/**
 * The frame the reader drew, as a block of quoted lines for the question to carry.
 *
 * A reference is one number, and one number cannot say what the comment is about: a reader annotating
 * a DELETED line produced `a.txt:2`, and the agent read line 2 of the file — which is another line
 * entirely, because a removed line has no number in the file as it reads now (its `2` is the old
 * file's). This block says what the number cannot: every row of the frame, in order, with the side it
 * was on (`-` removed, `+` added, a space for context) and the number THAT side's file gave it.
 *
 * `quote` and `quoteLines` are what the record already holds — one entry per frame row, in row order —
 * so nothing new is recorded for this: the question is built from the same snapshot the re-anchor uses.
 * A record from before `quoteLines` was kept (or one the agent annotated, which names current lines
 * only) has the text alone, and the block is that text with no numbers rather than a made-up side.
 *
 * @param quote - the anchored lines as they read when the comment was written.
 * @param quoteLines - their gutter numbers and sides, in the same order.
 * @returns the block, or `''` when there is nothing to show.
 */
export function quotedFrame(
  quote: string | undefined,
  quoteLines: readonly DiscussionQuoteLine[] | undefined,
): string {
  if (quote === undefined || quote === '') return ''
  const lines = quote.split('\n')
  if (quoteLines === undefined || quoteLines.length !== lines.length) return lines.join('\n')
  return lines
    .map((text, index) => {
      const row = quoteLines[index]!
      const marker = row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : ' '
      // The removed rows are the OLD file's (a `del` row has no new-file line), and every other row is
      // the current file's: each number is read from the side its own marker names.
      const number = row.kind === 'del' ? row.old ?? row.new : row.new ?? row.old
      return number === undefined ? `${marker} ${text}` : `${marker} ${number}  ${text}`
    })
    .join('\n')
}

/**
 * Whether a frame's numbers all come from the OLD file.
 *
 * A frame of removed rows alone names no line the file still has, so the numbers its record carries
 * (`anchor`, and the line a jump is handed) are the old file's. Everything that would otherwise
 * present them as current lines asks this first: the label a card and a list item wear, and the
 * landing a jump to that comment makes. A record that kept no sides answers false — what it holds is
 * read exactly as it always was.
 *
 * @param quoteLines - the frame's gutter numbers and sides, when the record kept them.
 * @returns true when the frame holds at least one row and none of them has a new-file line.
 */
export function frameNamesNoCurrentLine(
  quoteLines: readonly DiscussionQuoteLine[] | readonly CommentQuoteLine[] | undefined,
): boolean {
  return quoteLines !== undefined
    && quoteLines.length > 0
    && quoteLines.every(line => line.new === undefined)
}

/**
 * Whether a frame covers a line the file no longer has.
 *
 * The one thing a frame can hide behind its numbers: `anchor` is documented as new-file lines, but a
 * frame of removed rows alone has none of those, so the numbers it carries are the old file's. A
 * caller that must not present them as current lines asks this.
 *
 * @param quoteLines - the frame's gutter numbers and sides, when the record kept them.
 * @returns true when at least one row of the frame is a removed line.
 */
export function frameCoversRemovedRow(quoteLines: readonly DiscussionQuoteLine[] | undefined): boolean {
  return quoteLines?.some(line => line.kind === 'del') === true
}

/** What the selection frame shows for the current selection. */
export interface SelectionFrameActions {
  /** Whether keep/revert apply (the selection touches a change, whole block or part of one). */
  keepRevert: boolean
  /** Whether a new discussion may be started on this range. */
  comment: boolean
  /** Whether the frame renders at all (no visible action means no frame). */
  visible: boolean
}

/**
 * Decide the selection frame's contents.
 *
 * Keep/revert needs the selection to touch a change; commenting needs a range that has no
 * discussion yet. A frame with neither would be an empty floating box, so it is
 * not rendered at all.
 *
 * @param options - whether the selection touches a change, and whether this range already has a discussion.
 * @returns the three flags the caller branches on.
 */
export function selectionFrame(options: { coversBlocks: boolean; hasDiscussion: boolean }): SelectionFrameActions {
  const keepRevert = options.coversBlocks
  const comment = !options.hasDiscussion
  return { keepRevert, comment, visible: keepRevert || comment }
}
