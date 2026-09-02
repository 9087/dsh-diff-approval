// computeSideBySideDiff: align whole-file rows into left/right pairs.

import { describe, expect, it } from 'vitest'
import { computeSideBySideDiff, searchPairs } from '../src/client/split-diff.ts'
import type { WholeFileDiffRow } from '../src/client/whole-file-diff.ts'

function row(kind: WholeFileDiffRow['kind'], text: string, oldLine: number | undefined, newLine: number | undefined): WholeFileDiffRow {
  return { kind, text, oldLine, newLine }
}

describe('computeSideBySideDiff', () => {
  it('pairs a replaced line as a single left+right pair', () => {
    const { pairs } = computeSideBySideDiff([
      row('context', 'a', 1, 1),
      row('del', 'b', 2, undefined),
      row('add', 'B', undefined, 2),
      row('context', 'c', 3, 3),
    ])
    expect(pairs).toEqual([
      { kind: 'context', left: { text: 'a', line: 1 }, right: { text: 'a', line: 1 } },
      { kind: 'replace', left: { text: 'b', line: 2 }, right: { text: 'B', line: 2 } },
      { kind: 'context', left: { text: 'c', line: 3 }, right: { text: 'c', line: 3 } },
    ])
  })

  it('keeps a pure addition as a right-only pair and a pure deletion as a left-only pair', () => {
    const added = computeSideBySideDiff([
      row('context', 'a', 1, 1),
      row('add', 'b', undefined, 2),
    ])
    expect(added.pairs[1]).toEqual({ kind: 'add', left: undefined, right: { text: 'b', line: 2 } })

    const removed = computeSideBySideDiff([
      row('context', 'a', 1, 1),
      row('del', 'b', 2, undefined),
    ])
    expect(removed.pairs[1]).toEqual({ kind: 'del', left: { text: 'b', line: 2 }, right: undefined })
  })

  it('maps every original row to its pair index (blocks keep working)', () => {
    const rows = [
      row('context', 'a', 1, 1),
      row('del', 'b', 2, undefined),
      row('add', 'B', undefined, 2),
      row('del', 'c', 3, undefined),
      row('add', 'C', undefined, 3),
    ]
    const { pairOfRow } = computeSideBySideDiff(rows)
    // a -> pair 0; del b + add B -> pair 1; del c + add C -> pair 2.
    expect(pairOfRow.get(0)).toBe(0)
    expect(pairOfRow.get(1)).toBe(1)
    expect(pairOfRow.get(2)).toBe(1)
    expect(pairOfRow.get(3)).toBe(2)
    expect(pairOfRow.get(4)).toBe(2)
  })

  it('pairs deletions with additions in order, leaving the excess as one-sided pairs', () => {
    // Two deletions then one addition ("b", "c" -> "C"): the first deletion pairs
    // with the addition, the second deletion is left unmatched.
    const { pairs } = computeSideBySideDiff([
      row('context', 'a', 1, 1),
      row('del', 'b', 2, undefined),
      row('del', 'c', 3, undefined),
      row('add', 'C', undefined, 2),
    ])
    expect(pairs[1]).toEqual({ kind: 'replace', left: { text: 'b', line: 2 }, right: { text: 'C', line: 2 } })
    expect(pairs[2]).toEqual({ kind: 'del', left: { text: 'c', line: 3 }, right: undefined })
  })

  it('keeps by-order pairing by default (similarity alignment is opt-in)', () => {
    const rows = [
      row('del', 'old line A', 1, undefined),
      row('add', 'brand new unrelated', undefined, 1),
      row('add', 'modified old line A', undefined, 2),
    ]
    const { pairs } = computeSideBySideDiff(rows)
    // Default (align=false): the first deletion pairs with the first addition.
    expect(pairs[0]).toEqual({ kind: 'replace', left: { text: 'old line A', line: 1 }, right: { text: 'brand new unrelated', line: 1 } })
    expect(pairs[1]).toEqual({ kind: 'add', left: undefined, right: { text: 'modified old line A', line: 2 } })
  })

  it('aligns a 1-del/2-add block by content similarity, not order', () => {
    const rows = [
      row('del', 'old line A', 1, undefined),
      row('add', 'brand new unrelated', undefined, 1),
      row('add', 'modified old line A', undefined, 2),
    ]
    const { pairs } = computeSideBySideDiff(rows, true)
    // The deletion pairs with its most-similar addition; the unrelated addition
    // stays a right-only (inserted) pair.
    expect(pairs).toEqual([
      { kind: 'replace', left: { text: 'old line A', line: 1 }, right: { text: 'modified old line A', line: 2 } },
      { kind: 'add', left: undefined, right: { text: 'brand new unrelated', line: 1 } },
    ])
  })

  it('leaves a deletion and both additions unaligned when nothing matches', () => {
    const rows = [
      row('del', 'old line A', 1, undefined),
      row('add', 'totally unrelated one', undefined, 1),
      row('add', 'totally unrelated two', undefined, 2),
    ]
    const { pairs } = computeSideBySideDiff(rows, true)
    // Nothing clears the similarity threshold, so the block is three one-sided
    // pairs — the red row does not force-align to a green row.
    expect(pairs).toEqual([
      { kind: 'del', left: { text: 'old line A', line: 1 }, right: undefined },
      { kind: 'add', left: undefined, right: { text: 'totally unrelated one', line: 1 } },
      { kind: 'add', left: undefined, right: { text: 'totally unrelated two', line: 2 } },
    ])
  })
})

describe('searchPairs', () => {
  const pairs = computeSideBySideDiff([
    row('context', 'hello world', 1, 1),
    row('del', 'goodbye', 2, undefined),
    row('add', 'HELLO there', undefined, 2),
    row('context', 'nothing here', 3, 3),
  ]).pairs

  it('matches a query on either side, case-insensitively', () => {
    expect(searchPairs(pairs, 'hello')).toEqual([0, 1])
    expect(searchPairs(pairs, 'THERE')).toEqual([1])
  })

  it('counts a pair once even when both sides match', () => {
    expect(searchPairs(pairs, 'e')).toEqual([0, 1, 2])
  })

  it('matches nothing for an empty query or a miss', () => {
    expect(searchPairs(pairs, '')).toEqual([])
    expect(searchPairs(pairs, 'zzzz')).toEqual([])
  })
})
