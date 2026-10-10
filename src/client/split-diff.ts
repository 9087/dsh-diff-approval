/**
 * Side-by-side (split) diff model: the unified whole-file diff rows are
 * regrouped into line-aligned pairs for a two-column "before | current" view.
 * Pure derivation; the view owns rendering. A context row becomes a pair with
 * both sides, a deletion a left-only pair, an addition a right-only pair, and
 * an adjacent deletion/addition run is paired line-by-line into a single
 * replacement pair so the two columns line up.
 * @module dsh-diff-approval/client/split-diff
 */

import type { WholeFileDiffRow } from './whole-file-diff.ts'
import { alignChangedBlock } from './whole-file-diff.ts'
import { DEFAULT_SEARCH_OPTIONS, matchRangesOf } from './search.ts'
import type { SearchOptions } from './search.ts'

/** One side of a split pair: text plus its 1-based line number (absent on a pure add). */
export interface SplitSide {
  /** The side's source line content, without the terminating newline. */
  text: string
  /** 1-based line number on this side, or undefined. */
  line: number | undefined
}

/** One aligned left/right pair of the split view. */
export interface SplitPair {
  /** What the pair is: unchanged, deleted (left only), added (right only), or a replaced line. */
  kind: 'context' | 'del' | 'add' | 'replace'
  /** The old (left) side; absent on a pure addition. */
  left: SplitSide | undefined
  /** The new (right) side; absent on a pure deletion. */
  right: SplitSide | undefined
}

/** The derived split view: aligned pairs plus the row→pair index map. */
export interface SplitDiff {
  /** Aligned pairs in file order. */
  pairs: SplitPair[]
  /** Original whole-file row index → pair index, so block ranges keep working. */
  pairOfRow: ReadonlyMap<number, number>
}

/** One whole-file diff row → its visible left side text. */
function leftSideOf(row: WholeFileDiffRow): SplitSide | undefined {
  if (row.kind === 'add') return undefined
  return { text: row.text, line: row.oldLine }
}

/** One whole-file diff row → its visible right side text. */
function rightSideOf(row: WholeFileDiffRow): SplitSide | undefined {
  if (row.kind === 'del') return undefined
  return { text: row.text, line: row.newLine }
}

/**
 * Regroup the whole-file rows into aligned split pairs. By order, a deletion
 * run pairs line-by-line with a following addition run; with similarity
 * alignment, each deletion pairs with its most-similar addition (order
 * preserved, threshold-bounded) so a mixed insert/delete block does not force a
 * wrong line together. A stray deletion or addition stays a one-sided pair.
 *
 * THE ORDER OF THE RESULT IS PART OF THE CONTRACT: going down `pairs`, neither
 * column's line numbers ever go backwards. Alignment may therefore move a line
 * onto the row opposite it, but never past a line of its own side — an unpaired
 * line between two pairs is emitted where it belongs, not after them.
 * @param rows - the whole-file diff rows.
 * @param alignBySimilarity - align a change block by similarity instead of order.
 * @returns the split pairs plus the row→pair index map.
 */
export function computeSideBySideDiff(
  rows: readonly WholeFileDiffRow[],
  alignBySimilarity = false,
): SplitDiff {
  const pairs: SplitPair[] = []
  const pairOfRow = new Map<number, number>()
  const push = (pair: SplitPair, pairRows: readonly number[]): void => {
    const index = pairs.length
    pairs.push(pair)
    for (const r of pairRows) pairOfRow.set(r, index)
  }
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (row.kind === 'context') {
      push({ kind: 'context', left: leftSideOf(row), right: rightSideOf(row) }, [i])
      i++
      continue
    }
    const delRows: { index: number; row: WholeFileDiffRow }[] = []
    const addRows: { index: number; row: WholeFileDiffRow }[] = []
    if (row.kind === 'del') {
      while (i < rows.length && rows[i]!.kind === 'del') { delRows.push({ index: i, row: rows[i]! }); i++ }
    }
    while (i < rows.length && rows[i]!.kind === 'add') { addRows.push({ index: i, row: rows[i]! }); i++ }
    const alignment = alignChangedBlock(
      delRows.map(d => ({ index: d.index, text: d.row.text })),
      addRows.map(a => ({ index: a.index, text: a.row.text })),
      alignBySimilarity,
    )
    // THE THREE GROUPS ARE MERGED IN FILE ORDER, not printed one after another. The alignment itself is
    // order-preserving (its DP matches ascending del indices with ascending add indices), but emitting every
    // pair and only then the unpaired sides reorders a column whenever an unpaired line sits BETWEEN two
    // pairs: `del d1 d2` + `add a1 a2 a3`, aligned (d1,a2) (d2,a3) with a1 left over, drew the right column
    // as 11, 12, 10 — a line shown under the line number ABOVE its own (reported 2026-10-10). The rule this
    // view holds, and the reason the alignment is allowed to move a line at all: going down the pairs,
    // NEITHER column's line numbers ever go backwards. Alignment is only considered where it keeps that.
    const partnerOfDel = new Map<number, number>()
    const partnerOfAdd = new Map<number, number>()
    for (const p of alignment.pairs) {
      partnerOfDel.set(p.delIndex, p.addIndex)
      partnerOfAdd.set(p.addIndex, p.delIndex)
    }
    const delAt = new Map(delRows.map(d => [d.index, d.row]))
    const addAt = new Map(addRows.map(a => [a.index, a.row]))
    let d = 0
    let a = 0
    while (d < delRows.length || a < addRows.length) {
      const delIndex = delRows[d]?.index
      const addIndex = addRows[a]?.index
      const delRow = delIndex === undefined ? undefined : delAt.get(delIndex)
      const addRow = addIndex === undefined ? undefined : addAt.get(addIndex)
      if (delIndex !== undefined && addIndex !== undefined && partnerOfDel.get(delIndex) === addIndex) {
        push({ kind: 'replace', left: leftSideOf(delRow!), right: rightSideOf(addRow!) }, [delIndex, addIndex])
        d++
        a++
        continue
      }
      // An UNPAIRED row may go out now: it has no partner waiting below it, so sending it cannot move its
      // own column backwards. A PAIRED row must wait for its partner, and the pointer on the other side is
      // then on an unpaired row — an order-preserving matching cannot cross, so if this del's partner were
      // above the add pointer, that add row's own partner would have to be above this del row, which the
      // pair already emitted. At least one branch below therefore always applies.
      if (delIndex !== undefined && delRow !== undefined && !partnerOfDel.has(delIndex)) {
        push({ kind: 'del', left: leftSideOf(delRow), right: undefined }, [delIndex])
        d++
        continue
      }
      if (addIndex !== undefined && addRow !== undefined && !partnerOfAdd.has(addIndex)) {
        push({ kind: 'add', left: undefined, right: rightSideOf(addRow) }, [addIndex])
        a++
        continue
      }
      // Unreachable for an order-preserving alignment. Pairing the two rows the pointers stand on is the
      // conservative way out: it consumes both, keeps every row mapped, and stays monotone — rather than
      // marking a row that IS paired as one-sided, which would lose its partner.
      if (delRow !== undefined && addRow !== undefined) {
        push({ kind: 'replace', left: leftSideOf(delRow), right: rightSideOf(addRow) }, [delIndex!, addIndex!])
        d++
        a++
      } else if (delRow !== undefined) {
        push({ kind: 'del', left: leftSideOf(delRow), right: undefined }, [delIndex!])
        d++
      } else if (addRow !== undefined) {
        push({ kind: 'add', left: undefined, right: rightSideOf(addRow) }, [addIndex!])
        a++
      }
    }
  }
  return { pairs, pairOfRow }
}

/**
 * Pair indices whose left or right text matches the query. A pair counts once
 * however many times the query appears, so split search highlights the whole pair
 * on both columns and a single "current" pair is stepped through — not each
 * individual left/right occurrence.
 * @param pairs - the split pairs.
 * @param query - the query text; an empty query matches nothing.
 * @param options - case and whole-word narrowing.
 * @returns matching pair indices, in file order.
 */
export function searchPairs(
  pairs: readonly SplitPair[],
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): number[] {
  if (query === '') return []
  const matches: number[] = []
  for (let index = 0; index < pairs.length; index++) {
    const p = pairs[index]
    if (p === undefined) continue
    // The same matcher the rows highlight with, so the tally cannot disagree.
    if (p.left !== undefined && matchRangesOf(p.left.text, query, options).length > 0) matches.push(index)
    else if (p.right !== undefined && matchRangesOf(p.right.text, query, options).length > 0) matches.push(index)
  }
  return matches
}
