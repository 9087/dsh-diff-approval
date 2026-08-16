/**
 * Whole-file diff model for the pending review viewer: one unified row list
 * over the complete old and new contents, so the viewer renders the entire
 * file with changed lines marked and unchanged lines as context. Pure
 * derivation; the panel owns rendering. The `diff` package is browser-safe.
 * @module dsh-diff-approval/client/whole-file-diff
 */

import { structuredPatch } from 'diff'

/** One rendered body line of the whole-file view. */
export interface WholeFileDiffRow {
  /** `context` lines are unchanged, `del`/`add` mark the removed/added sides. */
  kind: 'context' | 'del' | 'add'
  /** The line's text, without the terminating newline. */
  text: string
  /** 1-based line number on the old side; absent on `add` lines. */
  oldLine: number | undefined
  /** 1-based line number on the new side; absent on `del` lines. */
  newLine: number | undefined
}

/** The derived view: a flat row list plus the +/- totals. */
export interface WholeFileDiff {
  /** Body rows in file order; every line of both sides appears once. */
  rows: WholeFileDiffRow[]
  /** Number of removed lines. */
  removed: number
  /** Number of added lines. */
  added: number
}

/**
 * Compute the whole-file view between two contents. The context budget is the
 * side lengths, so every hunk covers the file and unchanged lines survive as
 * context rows; the `\ No newline at end of file` patch marker is annotation
 * and never becomes a row.
 * @param oldText - the file content before the pending change.
 * @param newText - the file content after the pending change.
 * @returns the complete row list with totals.
 */
export function computeWholeFileDiff(oldText: string, newText: string): WholeFileDiff {
  const oldLines = contentLines(oldText)
  const newLines = contentLines(newText)
  const context = Math.max(1, oldLines.length, newLines.length)
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context })
  const rows: WholeFileDiffRow[] = []
  let removed = 0
  let added = 0
  let oldLine = 0
  let newLine = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('-')) {
        oldLine++
        rows.push({ kind: 'del', text: line.slice(1), oldLine, newLine: undefined })
        removed++
      } else if (line.startsWith('+')) {
        newLine++
        rows.push({ kind: 'add', text: line.slice(1), oldLine: undefined, newLine })
        added++
      } else {
        oldLine++
        newLine++
        rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      }
    }
  }
  return { rows, removed, added }
}

/**
 * Split a side's text into its content lines, with the diff card's terminator
 * rule: empty text is zero lines, and a single trailing newline is a line
 * terminator rather than an extra empty line.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}
