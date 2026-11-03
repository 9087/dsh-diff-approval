// computeWholeFileDiff: whole-file rows, change marking, and terminator rules.

import { describe, expect, it } from 'vitest'
import { blockRangesOf, computeWholeFileDiff, normalizeChangeRuns, pairRangeOf, pairsRangeOf } from '../src/client/whole-file-diff.ts'
import type { WholeFileDiffRow } from '../src/client/whole-file-diff.ts'

describe('normalizeChangeRuns', () => {
  it('groups a per-line interleaved change run into del-block then add-block', () => {
    const rows: WholeFileDiffRow[] = [
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'old2', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'new2', oldLine: undefined, newLine: 2 },
      { kind: 'del', text: 'old3', oldLine: 3, newLine: undefined },
      { kind: 'add', text: 'new3', oldLine: undefined, newLine: 3 },
      { kind: 'context', text: 'b', oldLine: 4, newLine: 4 },
    ]
    normalizeChangeRuns(rows)
    expect(rows.map(r => r.kind)).toEqual(['context', 'del', 'del', 'add', 'add', 'context'])
    // Line numbers are preserved on each row (dels sequential, adds sequential).
    expect(rows[1]!.text).toBe('old2')
    expect(rows[1]!.oldLine).toBe(2)
    expect(rows[3]!.text).toBe('new2')
    expect(rows[3]!.newLine).toBe(2)
    expect(rows[4]!.text).toBe('new3')
    expect(rows[4]!.newLine).toBe(3)
  })

  it('leaves an already-grouped run unchanged', () => {
    const rows: WholeFileDiffRow[] = [
      { kind: 'del', text: 'x', oldLine: 1, newLine: undefined },
      { kind: 'del', text: 'y', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'X', oldLine: undefined, newLine: 1 },
      { kind: 'add', text: 'Y', oldLine: undefined, newLine: 2 },
    ]
    normalizeChangeRuns(rows)
    expect(rows.map(r => r.kind)).toEqual(['del', 'del', 'add', 'add'])
  })
})

describe('computeWholeFileDiff', () => {
  it('renders every line of both sides with changed lines marked', () => {
    const diff = computeWholeFileDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'B', oldLine: undefined, newLine: 2 },
      { kind: 'context', text: 'c', oldLine: 3, newLine: 3 },
    ])
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
  })

  it('marks a pure addition and a pure deletion', () => {
    const added = computeWholeFileDiff('a\n', 'a\nb\n')
    expect(added.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'add', text: 'b', oldLine: undefined, newLine: 2 },
    ])
    expect(added.added).toBe(1)
    expect(added.removed).toBe(0)

    const removed = computeWholeFileDiff('a\nb\n', 'a\n')
    expect(removed.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2, newLine: undefined },
    ])
    expect(removed.removed).toBe(1)
  })

  it('treats a single trailing newline as a terminator, not an empty line', () => {
    const diff = computeWholeFileDiff('old\n', 'new\n')
    expect(diff.rows).toEqual([
      { kind: 'del', text: 'old', oldLine: 1, newLine: undefined },
      { kind: 'add', text: 'new', oldLine: undefined, newLine: 1 },
    ])
  })

  it('handles empty sides', () => {
    expect(computeWholeFileDiff('', 'x\n').rows)
      .toEqual([{ kind: 'add', text: 'x', oldLine: undefined, newLine: 1 }])
    expect(computeWholeFileDiff('x\n', '').rows)
      .toEqual([{ kind: 'del', text: 'x', oldLine: 1, newLine: undefined }])
    expect(computeWholeFileDiff('', '').rows).toEqual([])
  })

  it('renders identical sides as context rows (a fully-resolved file)', () => {
    const diff = computeWholeFileDiff('a\nb\n', 'a\nb\n')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'b', oldLine: 2, newLine: 2 },
    ])
    expect(diff.removed).toBe(0)
    expect(diff.added).toBe(0)
  })

  it('drops the no-newline patch marker', () => {
    const diff = computeWholeFileDiff('x', 'x\ny')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'x', oldLine: 1, newLine: 1 },
      { kind: 'add', text: 'y', oldLine: undefined, newLine: 2 },
    ])
    // The un-changed first line is context now (the previous full-file Myers
    // wrongly showed it as a del+add across the no-trailing-newline boundary).
    expect(diff.removed).toBe(0)
    expect(diff.added).toBe(1)
  })

  it('normalizes line endings, so a CRLF/LF difference is not a whole-file change', () => {
    // Baseline stored LF, worktree CRLF, a single line changed (the Bug 1 case).
    const diff = computeWholeFileDiff('l1\nl2\nl3\n', 'l1\r\nl2\r\nL3\r\n')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'l1', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'l2', oldLine: 2, newLine: 2 },
      { kind: 'del', text: 'l3', oldLine: 3, newLine: undefined },
      { kind: 'add', text: 'L3', oldLine: undefined, newLine: 3 },
    ])
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
  })

  it('treats a trailing-newline-only difference as identical content', () => {
    const diff = computeWholeFileDiff('a\nb\n', 'a\nb')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'b', oldLine: 2, newLine: 2 },
    ])
    expect(diff.removed).toBe(0)
    expect(diff.added).toBe(0)
  })

  it('keeps a blank line inside a changed middle, so both sides add up and ranges stay true', () => {
    // The reader's bug: a removed comment followed by an added blank line. The middle used to be diffed as a
    // JOINED string, and an empty line at the edge of that string reads as "no line" — so the new side lost
    // a row, the following line numbers shifted, and identical lines showed as an unrelated del+add. Every
    // line of both sides must appear exactly once (here 4 old and 4 new lines), and the change block must
    // own exactly the removed line and the added blank one.
    const diff = computeWholeFileDiff(
      'function f()\r\n-- 注释\r\n\r\n    self:CloseSelf()\r\n',
      'function f()\n\n\n    self:CloseSelf()\n',
    )
    expect(diff.rows.map(row => `${row.kind}:${String(row.oldLine)}:${String(row.newLine)}`)).toEqual([
      'context:1:1',
      'del:2:undefined',
      'add:undefined:2',
      'context:3:3',
      'context:4:4',
    ])
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
    expect(blockRangesOf(diff.rows, { start: 1, end: 2 }))
      .toEqual({ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 })
  })

  it('keeps a final blank line, so the last unchanged line is not shown as a del+add', () => {
    // The reader's screenshot: the last line is `end` on both sides, but the new side also ends with a BLANK
    // line (its second terminating newline). Diffed as a joined string that blank line read as "no line", so
    // the new string ended with a newline the old one lacked — and the identical `end` line came out as a
    // delete plus an add. The row list has to carry the blank line itself.
    const oldText = '--- 确认按钮：关闭面板\nfunction f()\n    self:CloseSelf()\nend\n'
    const newText = '    self:CloseSelf()\nend\n\n'
    const diff = computeWholeFileDiff(oldText, newText)
    expect(diff.rows.map(row => `${row.kind}:${String(row.oldLine)}:${String(row.newLine)}:${JSON.stringify(row.text)}`)).toEqual([
      'del:1:undefined:"--- 确认按钮：关闭面板"',
      'del:2:undefined:"function f()"',
      'context:3:1:"    self:CloseSelf()"',
      'context:4:2:"end"',
      'add:undefined:3:""',
    ])
    expect(diff.removed).toBe(2)
    expect(diff.added).toBe(1)
  })

  it('carries a blank line added in the MIDDLE of a change — not just at EOF', () => {
    // The reader remembers no blank line because the bug never drew one: a blank line added when one comment
    // line was removed, in the middle of the file, is the LAST line of the changed middle (the lines after
    // it are unchanged context). Joined into a string it vanished, so the change looked like a pure deletion,
    // the new-side line numbers skipped a number, and keeping it left the blank line pending.
    const oldText = 'function f()\n    self:CloseSelf()\n-- 注释\nend\nkeep\n'
    const newText = 'function f()\n    self:CloseSelf()\n\nend\nkeep\n'
    const diff = computeWholeFileDiff(oldText, newText)
    expect(diff.rows.map(row => `${row.kind}:${String(row.oldLine)}:${String(row.newLine)}:${JSON.stringify(row.text)}`)).toEqual([
      'context:1:1:"function f()"',
      'context:2:2:"    self:CloseSelf()"',
      'del:3:undefined:"-- 注释"',
      'add:undefined:3:""',
      'context:4:4:"end"',
      'context:5:5:"keep"',
    ])
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
    expect(blockRangesOf(diff.rows, { start: 2, end: 3 }))
      .toEqual({ oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 })
  })
})

describe('blockRangesOf', () => {
  it('derives a range from any row range, so a partial selection splices only its own lines', () => {
    // 'a\n' -> 'a\nb\nc\nd\n': context 'a' (row 0), then three added lines (rows 1..3). Taking rows
    // 1..2 names new lines 2..3 and no old line at all, so the old side is the empty range at the
    // insertion point after the row above (old 2..1): keeping it ADDS b and c after line 1, and the
    // block's third line is left pending.
    const diff = computeWholeFileDiff('a\n', 'a\nb\nc\nd\n')
    expect(blockRangesOf(diff.rows, { start: 1, end: 2 }))
      .toEqual({ oldStart: 2, oldEnd: 1, newStart: 2, newEnd: 3 })
    // One removed line alone: old line 2 goes back at new 2..1 — the same insertion shape, the other
    // way round.
    const removed = computeWholeFileDiff('a\nb\nc\nd\n', 'a\nd\n')
    expect(blockRangesOf(removed.rows, { start: 1, end: 1 }))
      .toEqual({ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 1 })
    // A context row names the same line on both sides, which is why a selection that spans context
    // re-writes those lines unchanged rather than acting on them.
    expect(blockRangesOf(diff.rows, { start: 0, end: 0 }))
      .toEqual({ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 })
  })

  it('takes only the new side of a replacement pair', () => {
    // The shape a row range takes inside a replacement pair — del 'a' (row 0, old 1) over add 'A' (row 1,
    // new 1): the added row alone names new line 1 and no old line, so its old side is the empty range at
    // the insertion point after old line 1. The side-by-side view no longer relies on that shape (it feeds
    // whole pairs to `pairRangeOf`, below), but a partial selection in the code view reads exactly these
    // rows, and keep there folds the addition in without taking 'a' out.
    const diff = computeWholeFileDiff('a\n', 'A\n')
    expect(blockRangesOf(diff.rows, { start: 1, end: 1 }))
      .toEqual({ oldStart: 2, oldEnd: 1, newStart: 1, newEnd: 1 })
    expect(blockRangesOf(diff.rows, { start: 0, end: 1 }))
      .toEqual({ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 })
  })
})

describe('pairRangeOf', () => {
  /** Three removals then three additions between context lines: the shape a change run takes once
   *  `normalizeChangeRuns` has grouped it. */
  const runRows = (): WholeFileDiffRow[] => [
    { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
    { kind: 'del', text: 'd1', oldLine: 2, newLine: undefined },
    { kind: 'del', text: 'd2', oldLine: 3, newLine: undefined },
    { kind: 'del', text: 'd3', oldLine: 4, newLine: undefined },
    { kind: 'add', text: 'a1', oldLine: undefined, newLine: 2 },
    { kind: 'add', text: 'a2', oldLine: undefined, newLine: 3 },
    { kind: 'add', text: 'a3', oldLine: undefined, newLine: 4 },
    { kind: 'context', text: 'b', oldLine: 5, newLine: 5 },
  ]

  it('reads a pair as one old line against one new line', () => {
    // del d2 (row 2, old 3) paired with add a2 (row 5, new 3): both sides, so the replacement is whole.
    expect(pairRangeOf(runRows(), { old: 2, new: 5 }))
      .toEqual({ oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 })
  })

  it('gives a side the pair does not have the line its run ends at', () => {
    const rows = runRows()
    // An unpaired removal: nothing arrives in its place, and it goes back after the lines that replaced
    // its neighbours (new 5, the run's last new line plus one) — never at the top of the file.
    expect(pairRangeOf(rows, { old: 2 })).toEqual({ oldStart: 3, oldEnd: 3, newStart: 5, newEnd: 4 })
    // An unpaired addition: its old side is after the run's removals (old 5).
    expect(pairRangeOf(rows, { new: 4 })).toEqual({ oldStart: 5, oldEnd: 4, newStart: 2, newEnd: 2 })
  })

  it('keeps a removals-only row range off the top of the file', () => {
    // The rule `blockRangesOf` used to miss: it read the row immediately above the range, and a run lists
    // all its removals first, so that row has no new-file line and the insertion point came out as new
    // 1..0 — a revert of a mid-run selection would have written the lines at the top of the file.
    expect(blockRangesOf(runRows(), { start: 2, end: 3 }))
      .toEqual({ oldStart: 3, oldEnd: 4, newStart: 5, newEnd: 4 })
  })

  it('covers whole-block pairs with one range', () => {
    // The pairs a similarity alignment makes for a reversed run: d1<->a3, d2<->a2, d3<->a1. Together they
    // are the whole change region, so one range does it: one host call and one undo step, the range a
    // whole-block action would send.
    expect(pairsRangeOf(runRows(), [{ old: 1, new: 6 }, { old: 2, new: 5 }, { old: 3, new: 4 }]))
      .toEqual([{ oldStart: 2, oldEnd: 4, newStart: 2, newEnd: 4 }])
  })

  it('sends one range per pair, bottom-up, when a change sits between them', () => {
    // The same reversed alignment with only the first two pairs selected: rows 3 (d3) and 4 (a1) — the
    // third pair — lie inside their span, so a single range would act on lines the reader never selected.
    // The pair nearer the bottom of the file goes first, so the splice above it cannot move its lines.
    expect(pairsRangeOf(runRows(), [{ old: 1, new: 6 }, { old: 2, new: 5 }]))
      .toEqual([
        { oldStart: 2, oldEnd: 2, newStart: 4, newEnd: 4 },
        { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 },
      ])
  })

  it('drops context pairs and a selection that touches no change', () => {
    const rows = runRows()
    // A context pair names the same line on both sides, so there is nothing to keep or revert.
    expect(pairsRangeOf(rows, [{ old: 0, new: 0 }])).toEqual([])
    expect(pairsRangeOf(rows, [])).toEqual([])
  })
})
