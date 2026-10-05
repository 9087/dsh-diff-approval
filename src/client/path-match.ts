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
 * The directory a file path lives in, as the path was spelled.
 *
 * @param p - the file's own path.
 * @returns the directory, or undefined when the path names no directory (empty, or a bare file name).
 */
export function directoryOfPath(p: string | undefined): string | undefined {
  if (p === undefined) return undefined
  const norm = normalizeDiffPath(p)
  if (norm === '') return undefined
  const cut = norm.lastIndexOf('/')
  // No separator at all: a bare name has no directory of its own, and the caller's fallback (the
  // workspace root) is the only honest base for it.
  if (cut < 0) return undefined
  return cut === 0 ? '/' : norm.slice(0, cut)
}

/** Rebuild a joined path with `.`/`..`/empty segments resolved (a `..` above the root is clamped). */
function normalizeSegments(value: string): string {
  const drive = /^([A-Za-z]:)\//.exec(value)?.[1]
  const absolute = drive !== undefined || value.startsWith('/')
  const rest = drive !== undefined ? value.slice(drive.length + 1) : value.replace(/^\/+/, '')
  const out: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Above the root there is nothing to leave: the segment is dropped rather than kept as `..`.
      out.pop()
      continue
    }
    out.push(segment)
  }
  const body = out.join('/')
  if (drive !== undefined) return `${drive}/${body}`
  return absolute ? `/${body}` : body
}

/**
 * The absolute path a Markdown link names, resolved the way Markdown means it: against the directory of
 * the file the preview is showing.
 *
 * A link in a document is relative to THAT DOCUMENT — `../src/foo.ts` in `docs/a.md` is `src/foo.ts` at the
 * workspace root, not `../src/foo.ts` of the page's own URL — which is why the base is the previewed file's
 * own directory and not the workspace root. The href is percent-decoded, its `#line`/`?query` suffix is
 * dropped, `.`/`..` are resolved, and both separators are accepted. An href that is already absolute
 * (drive letter or a leading slash) needs no base.
 *
 * Exported so the panel's preview click and its tests share one implementation and cannot disagree about
 * what a link points at.
 *
 * @param baseDirectory - the directory of the file being previewed, or the workspace root when that file's
 *   own path is unknown.
 * @param href - the anchor's href, as written in the Markdown.
 * @returns the absolute path, or undefined when it cannot be named (an empty href, or a relative href with
 *   no base to resolve against).
 */
export function resolveMarkdownHref(baseDirectory: string | undefined, href: string): string | undefined {
  let text = (href.split('#')[0] ?? '').split('?')[0]?.trim() ?? ''
  if (text === '') return undefined
  try {
    // A malformed escape is taken as written rather than dropping the link.
    text = decodeURIComponent(text)
  } catch {
    // keep the raw text
  }
  const norm = text.replaceAll('\\', '/')
  if (/^[A-Za-z]:\//.test(norm) || norm.startsWith('/')) return normalizeSegments(norm)
  if (baseDirectory === undefined || baseDirectory === '') return undefined
  return normalizeSegments(`${normalizeDiffPath(baseDirectory)}/${norm}`)
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
