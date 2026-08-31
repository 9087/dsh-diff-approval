/**
 * Reference labels for the selection toolbar: a workspace-relative path (or
 * the absolute path when the file is outside the workspace) plus a 1-based
 * line range. Pure derivation so the display rule is unit-testable without
 * the panel.
 * @module dsh-diff-approval/client/reference
 */

import { computeWholeFileDiff } from './whole-file-diff.ts'

/** The marker that replaces a reference's line number when its lines are gone. */
export const LINE_MISSING_LABEL = 'LINE_MISSING'

/**
 * Last path segment of a file path, any separator style.
 * @param path - the path to shorten.
 * @returns the segment after the final separator.
 */
export function basenameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * The path embedded in a copied reference: workspace-relative (forward
 * slashes) when the file lives inside the current workspace, the absolute
 * path otherwise. A bare file name is never enough — a reference must resolve
 * to exactly one file.
 * @param path - the selected file's path.
 * @param workspacePath - the current workspace root, or `undefined`.
 * @returns the reference path.
 */
export function referencePathOf(path: string, workspacePath: string | undefined): string {
  if (workspacePath === undefined || workspacePath.length === 0) return path
  const normalized = path.replaceAll('\\', '/')
  const root = workspacePath.replaceAll('\\', '/')
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (normalized.length > prefix.length
    && normalized.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    return normalized.slice(prefix.length)
  }
  return path
}

/**
 * Format one line range as a reference suffix: a single line number, or the
 * inclusive range when the selection spans more than one line.
 * @param start - first selected line number.
 * @param end - last selected line number (at least `start`).
 * @returns the range label.
 */
export function lineRangeLabel(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`
}

/**
 * Build the clipboard text for a selected line range, wrapped in parentheses so
 * the reference reads as one unambiguous token (and can be matched precisely).
 * @param path - the selected file's path.
 * @param workspacePath - the current workspace root, or `undefined`.
 * @param start - first selected line number.
 * @param end - last selected line number.
 * @returns the `(path:range)` reference text.
 */
export function referenceOf(path: string, workspacePath: string | undefined, start: number, end: number): string {
  return `(${referencePathOf(path, workspacePath)}:${lineRangeLabel(start, end)})`
}

/**
 * Map one referenced line range from `oldContent` coordinates to `newContent`
 * coordinates. Lines that survive (unchanged context) map to their new line
 * numbers, and a line whose content changed in place (a delete replaced by an
 * add at the same logical position) maps to that position's new line — its text
 * changed, but the line is not gone. Only a line that is genuinely removed
 * (a delete with no replacement) is omitted. The surviving lines' min/max span
 * is returned; when every line in the range is gone, returns `undefined` (the
 * reference is expired).
 * @param oldContent - the file content the reference was made against.
 * @param newContent - the file content now.
 * @param start - first referenced line (1-based, inclusive).
 * @param end - last referenced line (1-based, inclusive).
 * @returns the surviving range, or `undefined` when nothing survives.
 */
export function remapReferenceRange(
  oldContent: string,
  newContent: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const diff = computeWholeFileDiff(oldContent, newContent)
  const oldToNew = new Map<number, number>()
  // A line whose content changed in place is still the same logical line, so it
  // must not expire. Pair each deleted line with the added line that replaces it
  // (a delete run immediately followed by an add, before the next context/del),
  // and map old -> new. A line that is truly removed (a delete with no
  // replacement) stays unmapped and becomes LINE_MISSING.
  let pendingDeletes: number[] = []
  for (const row of diff.rows) {
    if (row.kind === 'context') {
      if (row.oldLine !== undefined && row.newLine !== undefined) oldToNew.set(row.oldLine, row.newLine)
      pendingDeletes = []
    } else if (row.kind === 'del' && row.oldLine !== undefined) {
      pendingDeletes.push(row.oldLine)
    } else if (row.kind === 'add' && row.newLine !== undefined) {
      const replaced = pendingDeletes.shift()
      if (replaced !== undefined) oldToNew.set(replaced, row.newLine)
      pendingDeletes = []
    }
  }
  let min = Infinity
  let max = -Infinity
  for (let line = start; line <= end; line++) {
    const next = oldToNew.get(line)
    if (next === undefined) continue
    min = Math.min(min, next)
    max = Math.max(max, next)
  }
  if (min === Infinity) return undefined
  return { start: min, end: max }
}

/**
 * Rewrite every `(referencePath:line)` / `(referencePath:start-end)` occurrence
 * in `text`, remapping each range from `oldContent` to `newContent`. A range
 * whose lines all survived (unchanged context or an in-place edit) becomes the
 * new range; one whose lines were all genuinely removed becomes
 * `(referencePath:LINE_MISSING)`.
 * @param text - the free text (composer draft, queued message) to rewrite.
 * @param referencePath - the file's reference path (workspace-relative or absolute).
 * @param oldContent - the file content the references were made against.
 * @param newContent - the file content now.
 * @returns the rewritten text.
 */
export function remapReferences(
  text: string,
  referencePath: string,
  oldContent: string,
  newContent: string,
): string {
  const escaped = referencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`\\(${escaped}:(\\d+)(?:-(\\d+))?\\)`, 'g')
  return text.replace(regex, (_whole, startText: string, endText: string | undefined) => {
    const start = Number(startText)
    const end = endText === undefined ? start : Number(endText)
    const mapped = remapReferenceRange(oldContent, newContent, start, end)
    if (mapped === undefined) return `(${referencePath}:${LINE_MISSING_LABEL})`
    return `(${referencePath}:${lineRangeLabel(mapped.start, mapped.end)})`
  })
}
