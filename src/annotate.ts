/**
 * One agent-authored annotation on a pending file's own lines: the rule, and every refusal.
 *
 * A reader can annotate a diff by selecting rows and typing in the card's compose row. This module is
 * the same act, asked for by the AGENT instead: it turns "annotate lines 120-128 of this file with
 * this note" into the very record the panel's own `comment-add` writes, so an agent's annotation is a
 * comment like any other — stored by the host, drawn as a card in the reader's panel, answerable from
 * the card, and quoted with the rule both halves already share (`resolveCommentLines`).
 *
 * Three things are deliberately NOT the caller's problem, because a tool the agent calls has to be
 * answerable in one call and honest about why it refused:
 *
 * - The QUOTE is read from the file the host holds, never from the caller. An agent quotes what it
 *   believes those lines say (optionally as a guard, see `AnnotationRequest.quote`); the record's
 *   `quote`/`quoteContext` are the bytes the entry actually has, which is what keeps the card anchored
 *   by the same rule as every other comment when the file moves on.
 * - OVERLAP is checked against what the reader can SEE. A comment that no longer resolves to any line
 *   (`resolveCommentLines` is `undefined`) is outdated and owns no rows, exactly as the panel's own
 *   selection rule treats it, so those lines are free to annotate; one that does resolve blocks the
 *   annotation and the refusal names it, because two cards hanging off the same lines cannot be told
 *   apart in the panel.
 * - The RECORD is built here, including the `author` mark the panel reads to draw the first turn as
 *   the agent's rather than the reader's (`CommentRecord.author`).
 *
 * @module dsh-diff-approval/src/annotate
 */

import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { commentFileLines, resolveCommentLines } from './comment-lines.ts'
import type { CommentRecord, PendingEntry } from './types.ts'

/**
 * The most lines one annotation may name.
 *
 * An annotation is a card that hangs under the lines it names, and its quote is drawn inside the card:
 * past a screenful the reader is looking at a card that is bigger than the code around it, which is
 * the opposite of what annotating a few lines is for. A call-chain tour is many cards of a few lines
 * each, not one card over the whole function — the refusal says so, so the caller can split it.
 */
export const MAX_ANNOTATION_LINES = 60

/**
 * The most characters one annotation's note may carry.
 *
 * The card lays its text out one row per line and reserves exactly that many rows in the diff, so an
 * essay in a card pushes the code it is about off the screen. Anything longer belongs in the agent's
 * own reply to the user, which is not measured in code rows.
 */
export const MAX_ANNOTATION_CHARS = 1000

/** What the agent asked for, once the tool layer has resolved which pending entry it means. */
export interface AnnotationRequest {
  /** The session the annotation belongs to, i.e. the one whose panel will draw it. */
  sessionId: SessionId
  /** The pending entry to annotate: the file as the panel is showing it. */
  entry: PendingEntry
  /**
   * The first line to annotate, 1-based, counted in the file AS IT READS NOW — the numbers an editor
   * shows for the file on disk, which is also what the card's own header will name.
   */
  startLine: number
  /** The last line, inclusive. Absent means the one line `startLine` names. */
  endLine?: number | undefined
  /** The annotation itself: the card's first turn, written by the agent. */
  note: string
  /**
   * Optional guard: the text the caller believes those lines read, newline-joined.
   *
   * The caller read the file at some point and the file may have changed since. Given, it is compared
   * with the lines the entry has NOW, and a mismatch is refused with the text that is actually there —
   * which is the difference between an annotation of the code the agent meant and one pinned to
   * whatever moved into those numbers.
   */
  quote?: string | undefined
  /** The record's id. Defaults to a fresh uuid; injectable so a retry can reuse one. */
  id?: string | undefined
  /** The record's timestamps. Defaults to now; injectable for tests. */
  now?: number | undefined
}

/** Why an annotation was refused, in the words the calling agent is handed. */
export type AnnotationRefusal =
  /** The note was empty (after trimming): there is nothing for the card to say. */
  | { outcome: 'empty-note' }
  /** The note is longer than {@link MAX_ANNOTATION_CHARS}. */
  | { outcome: 'note-too-long'; limit: number; length: number }
  /** The range is backwards or names more lines than {@link MAX_ANNOTATION_LINES}. */
  | { outcome: 'range-too-wide'; limit: number; lines: number }
  /** The range is not inside the file at all. */
  | { outcome: 'out-of-range'; lines: number; startLine: number; endLine: number }
  /** The caller's `quote` guard did not match the lines that are there now. */
  | { outcome: 'quote-mismatch'; actual: string }
  /** Another comment already covers those lines, and the refusal says which. */
  | { outcome: 'already-annotated'; comment: CommentRecord; start: number; end: number }

/** What one annotation request produced. */
export type AnnotationResult =
  | { outcome: 'annotated'; comment: CommentRecord }
  | AnnotationRefusal

/**
 * Whether two line ranges share a line. Ranges are inclusive on both ends, which is how the panel's own
 * selection rule reads them (`discussionOverlapping`).
 *
 * @param aStart - first line of one range.
 * @param aEnd - last line of one range.
 * @param bStart - first line of the other range.
 * @param bEnd - last line of the other range.
 * @returns whether they overlap.
 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/**
 * The quote, the context fingerprint and the gutter numbers a range of a file's own lines produces.
 *
 * The shape mirrors what the panel records when the reader annotates rows: the quote is the named lines
 * newline-joined, the context is one line each side of them (as far as the file reaches, which is how
 * the client's own `contextAt` clamps at the ends), and the gutter numbers are the new-file numbers of
 * the quoted lines.
 *
 * The old-file side is deliberately absent, and so is the add/del/context marker: the host holds the
 * file's current text, not a diff, so it cannot say which of those lines the change added and which it
 * left alone. Absent is the honest answer — the panel draws such a quote with the numbers it has and
 * no wash, exactly as it does for a thread recorded before those fields existed.
 *
 * @param lines - the file's lines, as `commentFileLines` splits them.
 * @param startLine - first quoted line, 1-based.
 * @param endLine - last quoted line, 1-based and inclusive.
 * @returns the record's quote fields.
 */
export function annotationQuote(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): Pick<CommentRecord, 'quote' | 'quoteContext' | 'quoteLines'> {
  const quoted = lines.slice(startLine - 1, endLine)
  const before = startLine > 1 ? lines[startLine - 2] : undefined
  const after = endLine < lines.length ? lines[endLine] : undefined
  const context = [before, ...quoted, after].filter((line): line is string => line !== undefined)
  return {
    quote: quoted.join('\n'),
    quoteContext: context.join('\n'),
    quoteLines: quoted.map((_line, index) => ({ new: startLine + index })),
  }
}

/**
 * Turn one annotation request into the record the panel draws, or say why it cannot be made.
 *
 * The order of the checks is the order a caller can act on them: what it asked for (note, range), then
 * whether the code it means is still there (`quote`), then whether the reader already has a card on
 * those lines. Nothing is written here — the caller hands the record to the comment store — so this is
 * a pure function of the entry, the stored comments and the request, and it can be tested as one.
 *
 * @param request - what to annotate and with what words.
 * @param existing - every comment the store holds for this entry.
 * @returns the record to store, or the refusal to hand back.
 */
export function annotateLines(
  request: AnnotationRequest,
  existing: readonly CommentRecord[],
): AnnotationResult {
  const note = request.note.trim()
  if (note === '') return { outcome: 'empty-note' }
  if (note.length > MAX_ANNOTATION_CHARS) {
    return { outcome: 'note-too-long', limit: MAX_ANNOTATION_CHARS, length: note.length }
  }
  const start = Math.trunc(request.startLine)
  const end = Math.trunc(request.endLine ?? request.startLine)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { outcome: 'range-too-wide', limit: MAX_ANNOTATION_LINES, lines: 0 }
  }
  if (end - start + 1 > MAX_ANNOTATION_LINES) {
    return { outcome: 'range-too-wide', limit: MAX_ANNOTATION_LINES, lines: end - start + 1 }
  }
  const lines = commentFileLines(request.entry.newText)
  if (start < 1 || end > lines.length) {
    return { outcome: 'out-of-range', lines: lines.length, startLine: start, endLine: end }
  }
  const quoted = lines.slice(start - 1, end).join('\n')
  if (request.quote !== undefined && request.quote.trim() !== '' && request.quote !== quoted) {
    return { outcome: 'quote-mismatch', actual: quoted }
  }
  // What the reader can SEE: a comment that no longer resolves is outdated and owns no rows, so the
  // code standing there now is free to annotate — the same rule the panel applies to a selection.
  for (const comment of existing) {
    if (comment.entryId !== request.entry.id) continue
    const range = resolveCommentLines(request.entry.newText, comment)
    if (range === undefined) continue
    if (!overlaps(start, end, range.start, range.end)) continue
    return { outcome: 'already-annotated', comment, start: range.start, end: range.end }
  }
  const now = request.now ?? Date.now()
  const record: CommentRecord = {
    id: request.id ?? randomUUID(),
    sessionId: request.sessionId,
    entryId: request.entry.id,
    path: request.entry.path,
    anchor: { startLine: start, endLine: end },
    // The note is the annotation, whole: a flow's step number is part of the agent's own words (see the
    // annotating skill), not something this layer adds on its behalf.
    text: note,
    createdAt: now,
    updatedAt: now,
    author: 'agent',
    ...annotationQuote(lines, start, end),
  }
  return { outcome: 'annotated', comment: record }
}

/**
 * The one line a refusal is summarised with, for the caller's own log: the outcome and what it says.
 *
 * The agent is handed a full sentence by the tool layer (see `annotate-tool.ts`), which is where the
 * wording lives because that is what a model reads. This is for the plugin's logger.
 *
 * @param refusal - the refusal to name.
 * @returns the outcome, plus the numbers that make two of the same kind tellable apart.
 */
export function refusalSummary(refusal: AnnotationRefusal): string {
  switch (refusal.outcome) {
    case 'already-annotated':
      return `already-annotated(${refusal.comment.id} ${refusal.start}-${refusal.end})`
    case 'out-of-range':
      return `out-of-range(${refusal.startLine}-${refusal.endLine} of ${refusal.lines})`
    case 'quote-mismatch':
      return 'quote-mismatch'
    case 'range-too-wide':
      return `range-too-wide(${refusal.lines} lines)`
    case 'note-too-long':
      return `note-too-long(${refusal.length} chars)`
    default:
      return refusal.outcome
  }
}
