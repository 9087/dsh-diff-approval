// The shared rule: where a comment's quote sits in a file's current content. Both halves of the
// plugin import it (the host resolves the list's figures with it, the browser half's row-level
// re-anchor applies the same bound to its rows), so its behaviour is pinned here on its own, in
// lines, with the two real cases the report turned on.

import { describe, expect, it } from 'vitest'
import { REANCHOR_MAX_LINES, commentFileLines, resolveCommentLines } from '../src/comment-lines.ts'
import type { CommentLineSource } from '../src/comment-lines.ts'

/** The `UPROPERTY(...)` line above a field: one line of the context a record keeps. */
const UPROPERTY = '\tUPROPERTY(EditAnywhere, Category = "S")'
/** The declaration the comment was written on. */
const FIELD = '\tFString WidgetPath;'

/**
 * The record both real cases have the shape of: a one-line quote, written on line 382, with the
 * ±1 context the panel records — the line above, the quote, the line below.
 */
const RECORD: CommentLineSource = {
  anchor: { startLine: 382, endLine: 382 },
  quote: FIELD,
  quoteContext: `${UPROPERTY}\n${FIELD}\n`,
}

/**
 * A file of numbered lines with the declaration's neighbourhood planted at `fieldLine`.
 *
 * The neighbourhood is the one the record's context describes — the `UPROPERTY` line, the field, the
 * blank line under it — so a file built this way matches the record wherever it is planted, and the
 * only thing separating one planting from another is the DISTANCE from the stored line.
 *
 * @param fieldLine - the line the field reads on.
 * @param total - how many lines the file has (defaults to a length that holds every case here).
 * @returns the file's content.
 */
function fieldFileAt(fieldLine: number, total = 500): string {
  const lines = Array.from({ length: total }, (_, index) => `line-${index + 1}`)
  lines[fieldLine - 2] = UPROPERTY
  lines[fieldLine - 1] = FIELD
  lines[fieldLine] = ''
  return `${lines.join('\n')}\n`
}

describe('where a comment\'s quote sits now', () => {
  it('leaves a comment whose stored line still reads its quote exactly where it is', () => {
    // The ordinary case, and the one every edit above the comment leaves behind: nothing to search
    // for, and nothing here may change that.
    expect(resolveCommentLines(fieldFileAt(382), RECORD)).toEqual({ start: 382, end: 382 })
  })

  it('follows the quoted declaration when the lines above it were deleted (the report\'s comment A)', () => {
    // Comment A, with the real geometry: written on 382, and four lines deleted above it since — so
    // the very same declaration now reads on 378. Four lines is a move, and the list, the chip and
    // the jump all have to name 378.
    expect(resolveCommentLines(fieldFileAt(378), RECORD)).toEqual({ start: 378, end: 378 })
    // The stored range is returned untouched for a quote still on its own line, and the figure the
    // caller falls back to (record.anchor) is what the record keeps — this rule never rewrites it.
    expect(RECORD.anchor).toEqual({ startLine: 382, endLine: 382 })
  })

  it('refuses a look-alike far below the stored line (the report\'s comment B)', () => {
    // Comment B, staged as content: the comment's own declaration was deleted — the `UPROPERTY` line
    // above it is still there, the field under it is not — and an identically-shaped declaration sits
    // 74 lines further down. The two places read the same through the ±1 context the record kept, so
    // nothing in the record itself can tell them apart; what DID differ is the doc comment one line
    // further up (line 376 against line 450), which the record never kept.
    const lines = Array.from({ length: 458 }, (_, index) => `line-${index + 1}`)
    lines[375] = '/** Object path of the property. */'
    lines[376] = UPROPERTY
    lines[377] = '\tFString PropertyName;' // line 378: the field the comment quoted is GONE
    lines[378] = ''
    lines[449] = '/** Object path of the widget. */'
    lines[450] = UPROPERTY
    lines[451] = FIELD // line 452: the look-alike
    lines[452] = ''
    const content = `${lines.join('\n')}\n`
    const file = commentFileLines(content)
    expect(file).toHaveLength(458)

    // The geometry the whole case turns on, asserted rather than assumed.
    expect(file[377]).not.toBe(FIELD)
    // The look-alike's ±1 window reads exactly like the recorded context, at line 452…
    expect([file[450], file[451], file[452]].join('\n')).toBe(RECORD.quoteContext)
    // …and the doc lines the two places apart are one line above that window, where the record cannot
    // see them: this is why the context alone was never going to separate the two declarations.
    expect(file[375]).not.toBe(file[449])
    // The stored context does not read at the stored place any more — that is why step 2 falls through.
    expect([file[376], file[377], file[378]].join('\n')).not.toBe(RECORD.quoteContext)

    // So the declaration the comment was written on is gone, and the far one is NOT taken for it:
    // the rule answers "nowhere", the caller keeps the record's own line, and the thread reads as
    // outdated. 74 lines away, the same-looking field belongs to another part of the file.
    expect(resolveCommentLines(content, RECORD)).toBeUndefined()
  })

  it('takes a match exactly at the limit, and refuses one line past it', () => {
    // The bound is a distance from the stored line, and it is INCLUSIVE: at the limit the code is
    // taken to have moved; one line past it, and it is another place in the file. Both directions are
    // pinned, because a re-anchor may as easily be pulled up the file as pushed down it.
    //
    // What is asserted about the VALUE is only what the two real cases bracket: four lines must stay
    // inside the bound and seventy-four must stay outside it. Any bound in that interval separates
    // them; the exact number (see `REANCHOR_MAX_LINES`) is a readability choice, not a fact.
    expect(REANCHOR_MAX_LINES).toBeGreaterThan(4)
    expect(REANCHOR_MAX_LINES).toBeLessThan(74)

    const above = 382 - REANCHOR_MAX_LINES
    expect(resolveCommentLines(fieldFileAt(above), RECORD)).toEqual({ start: above, end: above })
    expect(resolveCommentLines(fieldFileAt(above - 1), RECORD)).toBeUndefined()

    const below = 382 + REANCHOR_MAX_LINES
    expect(resolveCommentLines(fieldFileAt(below), RECORD)).toEqual({ start: below, end: below })
    expect(resolveCommentLines(fieldFileAt(below + 1), RECORD)).toBeUndefined()
  })

  it('keeps following the nearest occurrence of a quote that repeats inside the bound', () => {
    // The distance bound is an ADDITION to the nearest-occurrence rule, not a replacement for it: two
    // copies inside reach still resolve to the closer one, which is where the reader last saw the
    // code — and an equal distance still keeps the earlier, the first window an ascending scan meets.
    const planted = (at: readonly number[]): string => {
      const lines = Array.from({ length: 500 }, (_, index) => `line-${index + 1}`)
      for (const line of at) {
        lines[line - 2] = UPROPERTY
        lines[line - 1] = FIELD
        lines[line] = ''
      }
      return `${lines.join('\n')}\n`
    }
    // Six lines below the stored line against eight above it: the nearer copy wins.
    expect(resolveCommentLines(planted([374, 388]), RECORD)).toEqual({ start: 388, end: 388 })
    // Eight either side: a tie, and the earlier occurrence is the answer.
    expect(resolveCommentLines(planted([374, 390]), RECORD)).toEqual({ start: 374, end: 374 })
    // Both copies out of reach is the same answer as none at all (42 and 78 lines away): the comment
    // reads as outdated rather than being carried off to whichever look-alike the file happens to hold.
    expect(resolveCommentLines(planted([340, 460]), RECORD)).toBeUndefined()
  })
})
