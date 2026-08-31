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
 * and never becomes a row. Both sides are line-ending normalized (`\r\n?` →
 * `\n`) first, so a repo baseline stored with one EOL and a worktree with
 * another never show as a whole-file delete+add — the diff is about approved
 * content, not line-ending noise.
 * @param oldText - the file content before the pending change.
 * @param newText - the file content after the pending change.
 * @returns the complete row list with totals.
 */
/**
 * Normalize content for equality: line endings → `\n`, and a single trailing
 * newline is a terminator rather than a line. The result is the line bodies
 * joined by `\n` with no trailing newline, so representation-only differences
 * (EOL style, trailing-newline presence) compare equal.
 * @param text - the content to normalize.
 * @returns the normalized line bodies.
 */
export function contentKey(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
}

export function computeWholeFileDiff(oldText: string, newText: string): WholeFileDiff {
  const oldNorm = oldText.replace(/\r\n?/g, '\n')
  const newNorm = newText.replace(/\r\n?/g, '\n')
  // Identical content — possibly differing only by EOL style (normalized above)
  // or by the trailing newline (a terminator, not a line) — still shows every
  // line as context, never a spurious delete+add of the last line.
  if (contentKey(oldNorm) === contentKey(newNorm)) {
    const rows: WholeFileDiffRow[] = contentLines(oldNorm).map((text, index) => ({
      kind: 'context', text, oldLine: index + 1, newLine: index + 1,
    }))
    return { rows, removed: 0, added: 0 }
  }
  const oldLines = contentLines(oldNorm)
  const newLines = contentLines(newNorm)
  const context = Math.max(1, oldLines.length, newLines.length)
  const patch = structuredPatch('', '', oldNorm, newNorm, undefined, undefined, { context })
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
