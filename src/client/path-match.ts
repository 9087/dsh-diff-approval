/**
 * Path comparison for the review's own references: is the path a press named the same file as one the
 * pending list holds?
 *
 * Its own module because three places ask it and they must not disagree — the panel's jump to a file, the
 * plugin's produced-file press bridge, and the store's "does the page hold this path" reader — while the
 * panel itself is a React component module that a data-layer reader should not have to import.
 *
 * @module dsh-diff-approval/client/path-match
 */

/** Normalize a path for comparison: forward slashes, no trailing slash. */
export function normalizeDiffPath(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '')
}

/**
 * Whether a produced-file chip path and a pending file path refer to the same file, tolerant of separator
 * style (\\ vs /) and of a workspace-relative vs absolute form. `chipPath` is typically the harness's
 * workspace-relative forward-slash path; `filePath` is the host's absolute native-separator path. Matching
 * is case-insensitive so a Windows drive/segment case difference does not miss the file the user clicked.
 * @param chipPath - the path a press (or a reference) named.
 * @param filePath - the path the pending list holds.
 * @param workspacePath - the session's workspace root, when it is known.
 * @returns whether the two name one file.
 */
export function diffPathsMatch(chipPath: string, filePath: string, workspacePath: string | undefined): boolean {
  const toAbsolute = (p: string): string => {
    const norm = normalizeDiffPath(p)
    // Already absolute on this platform (drive letter or a leading /).
    if (/^[A-Za-z]:\//.test(norm) || norm.startsWith('/')) return norm
    // Workspace-relative: resolve against the workspace root when it is known.
    if (workspacePath !== undefined && workspacePath !== '') {
      return `${normalizeDiffPath(workspacePath).replace(/\/+$/, '')}/${norm}`
    }
    return norm
  }
  const absolute = toAbsolute(chipPath).toLowerCase()
  const file = toAbsolute(filePath).toLowerCase()
  if (absolute === file) return true
  // Fallback (no usable workspace root): the relative chip path as a normalized
  // suffix of the absolute pending path.
  const rel = normalizeDiffPath(chipPath).toLowerCase()
  return file.endsWith(`/${rel}`) || file === rel
}
