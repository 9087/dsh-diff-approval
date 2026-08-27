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
 * Regroup the whole-file rows into aligned split pairs, pairing a deletion run
 * with a following addition run line-by-line (so a replaced line is one pair),
 * and leaving a stray deletion or addition as a one-sided pair.
 * @param rows - the whole-file diff rows.
 * @returns the split pairs plus the row→pair index map.
 */
export function computeSideBySideDiff(rows: readonly WholeFileDiffRow[]): SplitDiff {
  const pairs: SplitPair[] = []
  const pairOfRow = new Map<number, number>()
  const pendingDel: { index: number; row: WholeFileDiffRow }[] = []
  const push = (pair: SplitPair, rows: readonly number[]): void => {
    const index = pairs.length
    pairs.push(pair)
    for (const r of rows) pairOfRow.set(r, index)
  }
  const flushPending = (): void => {
    for (const { index, row } of pendingDel) {
      push({ kind: 'del', left: leftSideOf(row), right: undefined }, [index])
    }
    pendingDel.length = 0
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (row.kind === 'context') {
      flushPending()
      push({ kind: 'context', left: leftSideOf(row), right: rightSideOf(row) }, [i])
    } else if (row.kind === 'del') {
      pendingDel.push({ index: i, row })
    } else {
      // add: pair with the oldest pending deletion (1:1) when available.
      const del = pendingDel.shift()
      if (del !== undefined) {
        push({ kind: 'replace', left: leftSideOf(del.row), right: rightSideOf(row) }, [del.index, i])
      } else {
        push({ kind: 'add', left: undefined, right: rightSideOf(row) }, [i])
      }
    }
  }
  flushPending()
  return { pairs, pairOfRow }
}

/**
 * Pair indices whose left or right text contains the query (case-insensitive).
 * A pair counts once however many times the query appears, so split search
 * highlights the whole pair on both columns and a single "current" pair is
 * stepped through — not each individual left/right occurrence.
 * @param pairs - the split pairs.
 * @param query - the query text; an empty query matches nothing.
 * @returns matching pair indices, in file order.
 */
export function searchPairs(pairs: readonly SplitPair[], query: string): number[] {
  if (query === '') return []
  const lower = query.toLowerCase()
  const matches: number[] = []
  for (let index = 0; index < pairs.length; index++) {
    const p = pairs[index]
    if (p === undefined) continue
    if (p.left !== undefined && p.left.text.toLowerCase().includes(lower)) matches.push(index)
    else if (p.right !== undefined && p.right.text.toLowerCase().includes(lower)) matches.push(index)
  }
  return matches
}
