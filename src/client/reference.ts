/**
 * Reference labels for the selection toolbar: a workspace-relative path (or
 * the absolute path when the file is outside the workspace) plus a 1-based
 * line range. Pure derivation so the display rule is unit-testable without
 * the panel.
 * @module dsh-diff-approval/client/reference
 */

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
 * Build the clipboard text for a selected line range.
 * @param path - the selected file's path.
 * @param workspacePath - the current workspace root, or `undefined`.
 * @param start - first selected line number.
 * @param end - last selected line number.
 * @returns the `path:range` reference text.
 */
export function referenceOf(path: string, workspacePath: string | undefined, start: number, end: number): string {
  return `${referencePathOf(path, workspacePath)}:${lineRangeLabel(start, end)}`
}
