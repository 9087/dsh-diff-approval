/**
 * Where a comment's quote sits in a file's CURRENT content: the rule that turns the lines a comment
 * was WRITTEN on into the lines it is about now.
 *
 * Pure and free of both Node and the DOM, so the two halves of the plugin import the very same rule:
 * the host resolves each comment against the entry content it hangs off and ships the figures on the
 * list read, and the browser half draws them. The panel's own row-level re-anchor
 * (`src/client/discussion.ts`) is this same rule seen through the diff's rows — with one row per
 * line, a removed line among them, and the quote's context taken from the rows — and it stays the
 * browser's business: where a card is DRAWN is a layout fact. What a reader is TOLD (the list's
 * label, the card's own chip, the jump's target line) comes from here, once, so two panes cannot
 * name two lines for one comment.
 *
 * The two models can disagree in one situation, and it is worth knowing which: the host has the
 * file's own lines, while the client's rows also carry the lines this file DELETED. A quote whose
 * recorded `quoteContext` was captured across a deleted row therefore matches a context window the
 * host cannot reproduce, and the host answers `undefined` where the client would re-anchor. The
 * caller then falls back to `record.anchor` — the line the comment was written on — which is what an
 * outdated thread shows anyway: the number stays honest rather than drifting.
 *
 * What the two may NOT disagree about is how far a match is allowed to be from the stored line: a
 * look-alike elsewhere in the file is refused by both, through the one bound they share
 * (`REANCHOR_MAX_LINES`), so the list's figure, the card's chip and the card's place cannot name two
 * different lines for one comment.
 * @module dsh-diff-approval/comment-lines
 */

/** The new-file lines one comment's quote settles on now (1-based, inclusive). */
export interface CommentLineRange {
  /** First new-file line the quote occupies in this content. */
  start: number
  /** Last one. A one-line quote has `end === start`. */
  end: number
}

/**
 * The record fields resolution reads: everything a re-anchor needs and nothing else.
 *
 * Structurally satisfied by `CommentRecord`, so a caller passes the record itself. The reader's own
 * words, the questions asked and the timestamps play no part in where the code is.
 */
export interface CommentLineSource {
  /** The lines the annotation was made on, as new-file numbers. */
  anchor: { startLine: number; endLine: number }
  /** The anchored lines as they read when the comment was written. */
  quote: string
  /**
   * `quote` with one line of context on each side, as it read then, when the record kept one. It is
   * what tells a genuine move of the quoted code from another line elsewhere in the file that
   * happens to read the same — without it a comment on a blank line or a closing brace followed that
   * line wherever it appeared.
   */
  quoteContext?: string | undefined
}

/**
 * One file's content lines, numbered exactly as the diff numbers them.
 *
 * Both line endings are normalized first (`\r\n` and a lone `\r` become `\n`), and a single trailing
 * newline is a line TERMINATOR rather than an extra empty line — the same convention the browser
 * half's whole-file diff splits on (its `contentLines`), so line 1 here is the line the diff calls
 * line 1 and the two cannot drift by a trailing newline.
 *
 * @param text - the file's content.
 * @returns its lines, without the terminating newline; an empty file has none.
 */
export function commentFileLines(text: string): string[] {
  const body = text.replace(/\r\n?/g, '\n')
  if (body === '') return []
  return (body.endsWith('\n') ? body.slice(0, -1) : body).split('\n')
}

/**
 * How far a comment's quoted code may sit from the line the comment was written on and still count as
 * that code having MOVED, in lines.
 *
 * A comment is re-anchored by its quote, and a quote is not unique: two declarations in one file can
 * read exactly alike. The recorded context tells such places apart only as far as it reaches — one
 * line each side — which two identically-shaped fields (`UPROPERTY` line, field, blank line) defeat
 * completely. Distance is the other half of the answer, and the half that does not depend on what the
 * record happened to keep: this code MOVING is a shift of a few lines, the insert or delete directly
 * above it that every edit produces, while a match tens or hundreds of lines away is another place in
 * the file that reads the same. The report's two cases bracket the number: the same declaration moved
 * four lines when four lines above it were deleted, and a declaration that had been DELETED matched an
 * identically-shaped one 74 lines below. Thirty keeps the first and refuses the second.
 *
 * Thirty is a screenful of code rather than a fact about the code: farther than that the reader is
 * looking at another part of the file, and following it is a teleport rather than a correction — the
 * comment ends up shown against code it was never written about, which is the bug this bound fixes.
 * Any bound between the two real cases separates them; this one leaves a genuine shift of a
 * function-sized block room to be followed, and nothing more.
 *
 * Both halves compare against this one number: the host in the file's own lines, the browser half in
 * the rows of its diff model (a row is a line, or a line the file no longer has). A row distance is
 * never smaller than the line distance it stands for, so a match the browser half refuses is one the
 * host refused too, and the two panes cannot name a line the other will not draw.
 */
export const REANCHOR_MAX_LINES = 30

/**
 * Whether a match that far from where the comment was written is that code having moved.
 *
 * The rule the two halves share, so neither can widen or narrow the bound on its own (see
 * `REANCHOR_MAX_LINES` for the number and for what it separates). The bound is inclusive: at exactly
 * the limit the code is taken to have moved.
 *
 * @param stored - the line (the host's content) or row (the browser half's model) the comment names.
 * @param found - the line or row the quote was found on.
 * @returns whether that match is close enough to be the same code.
 */
export function reanchorWithinLimit(stored: number, found: number): boolean {
  return Math.abs(found - stored) <= REANCHOR_MAX_LINES
}

/**
 * Where one comment's quote sits in a file's current content, or `undefined` when it is nowhere.
 *
 * The rule, in the order it is applied — the same order the browser half's `remapDiscussion` applies
 * it in, so the same file and the same record produce the same number in both halves:
 *
 * 1. The lines the comment names have to exist in this file at all. When even the anchor's first
 *    line is past the end, nothing here can be re-anchored: `undefined`.
 * 2. The anchor's own line still reads the quote: the comment has not moved. The stored range is the
 *    answer, `endLine` included — a range whose quote covers a different number of lines (a removed
 *    row was quoted among them) still belongs to the reader's own numbers.
 * 3. Otherwise the quote is followed: every window of as many lines as the quote has is compared to
 *    it, the recorded context has to agree where the record carries one, and the occurrence CLOSEST
 *    to the stored anchor wins — that is where the reader last saw the code. An equal distance keeps
 *    the earlier occurrence, which is the first window an ascending scan meets.
 * 4. The occurrence also has to be NEAR the stored anchor (see `REANCHOR_MAX_LINES`): a window
 *    farther than that from the line the comment was written on is not this code having moved but
 *    another place in the file that reads the same — however exactly its recorded context agrees.
 * 5. Nothing matched: `undefined`. The caller falls back to `record.anchor`, the line the comment was
 *    written on — the same answer the code view gives an outdated thread.
 *
 * @param text - the entry's current content (the file as it reads now).
 * @param comment - the stored comment's anchor and quote.
 * @returns the new-file line range the quote occupies now, or `undefined` when it is gone.
 */
export function resolveCommentLines(text: string, comment: CommentLineSource): CommentLineRange | undefined {
  const lines = commentFileLines(text)
  const quote = comment.quote
  // How many LINES the quote covers — one window line each, exactly as it was captured. The anchor's
  // numbers are not that count: a range holding a removed row spans fewer new-file numbers than it
  // has lines.
  const span = quote.split('\n').length - 1
  const { startLine, endLine } = comment.anchor
  /** The `span + 1` lines from `row` on, joined as the quote is; past the end reads as empty lines. */
  const windowAt = (row: number): string => {
    const parts: string[] = []
    for (let index = row; index <= row + span; index++) parts.push(index < lines.length ? lines[index]! : '')
    return parts.join('\n')
  }
  /** That window with one line of context on each side, as far as the file has them. */
  const contextAt = (row: number): string => {
    const parts: string[] = []
    for (let index = Math.max(0, row - 1); index <= Math.min(lines.length - 1, row + span + 1); index++) {
      parts.push(lines[index]!)
    }
    return parts.join('\n')
  }
  // Nothing to hold on to: every line the comment names is past the end of this file.
  if (!(startLine >= 1 && startLine <= lines.length)) return undefined
  const row = startLine - 1
  if (windowAt(row) === quote) return { start: startLine, end: endLine }
  const fingerprint = comment.quoteContext
  let found = -1
  for (let index = 0; index + span < lines.length; index++) {
    if (windowAt(index) !== quote) continue
    if (fingerprint !== undefined && contextAt(index) !== fingerprint) continue
    // Near enough to be THIS code having moved (see `REANCHOR_MAX_LINES`): however exactly a window
    // elsewhere in the file reads, a match that far away is another declaration, not this one.
    if (!reanchorWithinLimit(startLine, index + 1)) continue
    if (found === -1 || Math.abs(index - row) < Math.abs(found - row)) found = index
  }
  if (found === -1) return undefined
  return { start: found + 1, end: found + span + 1 }
}
