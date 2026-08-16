/**
 * Reference labels for the selection toolbar: a file name plus a 1-based line
 * range, using the short name when unambiguous and the full path otherwise.
 * Pure derivation so the display rule is unit-testable without the panel.
 * @module dsh-diff-approval/client/reference
 */

import type { PendingFileDiff } from '../types.ts'

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
 * The path shown in a copied reference: the short name when no other listed
 * file shares it, the full path otherwise.
 * @param path - the selected file's path.
 * @param files - every currently listed pending file.
 * @returns the display path for a copied reference.
 */
export function copyDisplayPath(path: string, files: readonly PendingFileDiff[]): string {
  const base = basenameOf(path)
  const duplicated = files.some((file) => file.path !== path && basenameOf(file.path) === base)
  return duplicated ? path : base
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
 * @param files - every currently listed pending file.
 * @param start - first selected line number.
 * @param end - last selected line number.
 * @returns the `path:range` reference text.
 */
export function referenceOf(path: string, files: readonly PendingFileDiff[], start: number, end: number): string {
  return `${copyDisplayPath(path, files)}:${lineRangeLabel(start, end)}`
}
