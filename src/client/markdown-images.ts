/**
 * Post-render local-image resolver for the Markdown preview. The preview body
 * is rendered with `innerHTML` from the file's Markdown, so a local `<img
 * src="details/foo.png">` stays a relative path that a browser cannot load on its
 * own (the document's base URL is the DSH shell, not the file's folder). This
 * pass rewrites those srcs to inline base64 data URIs through the host RPC,
 * leaving absolute URLs and already-inlined data URIs untouched.
 *
 * Security: only the host reads the file, and the host confines reads to the
 * session's workspace (see the `preview-image` endpoint). This module only
 * computes the path to ask for — it never reads a file itself.
 * @module dsh-diff-approval/client/markdown-images
 */

/** A Markdown image reference that is already absolute (a URL scheme, a
 * protocol-relative `//`, or a fragment) never needs inlining. */
function isExternalSrc(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)
}

/**
 * Resolve a Markdown image `src` to the backend path the host should read.
 * A leading-slash reference is treated as workspace-root-relative (prefixed with
 * the workspace root); anything else is relative to the Markdown file's folder.
 * @param src - the image reference from the rendered `<img>`.
 * @param markdownPath - the Markdown file's backend path.
 * @param workspacePath - the session's workspace root, when known.
 * @returns the backend path to read, or `undefined` when it cannot be derived.
 */
function resolveImageRef(src: string, markdownPath: string, workspacePath: string | undefined): string | undefined {
  if (isExternalSrc(src)) return undefined
  if (src.startsWith('/')) {
    // Workspace-root-relative: drop a duplicate leading slash on the root.
    const root = workspacePath ?? ''
    return root.length > 0 ? `${root.replace(/\/+$/, '')}${src}` : src
  }
  // Relative to the file's directory.
  const dir = markdownPath.slice(0, Math.max(markdownPath.lastIndexOf('/'), markdownPath.lastIndexOf('\\')) + 1)
  return `${dir}${src}`
}

/** The MIME extension of a data URI, or `''` when the src was already inlined. */
function dataUriOf(src: string): string | undefined {
  if (!src.startsWith('data:')) return undefined
  const comma = src.indexOf(',')
  return comma < 0 ? undefined : src
}

/**
 * Resolve every local `<img src>` in a rendered Markdown preview to an inline
 * data URI. Absolute URLs, fragments, and already-inlined data URIs are left as
 * written; a reference the host cannot read keeps its original src.
 * @param container - the preview body element (recently rendered).
 * @param markdownPath - the Markdown file's backend path (for relative references).
 * @param workspacePath - the session's workspace root, when known.
 * @param resolveImage - the host call: maps a backend path to a data URI.
 * @returns resolution once every image has been considered.
 */
export async function resolvePreviewImages(
  container: HTMLElement,
  markdownPath: string,
  workspacePath: string | undefined,
  resolveImage: (path: string) => Promise<string | undefined>,
): Promise<void> {
  for (const img of Array.from(container.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src')
    if (src === null || src === '') continue
    if (isExternalSrc(src) || dataUriOf(src) !== undefined) continue
    const candidate = resolveImageRef(src, markdownPath, workspacePath)
    if (candidate === undefined) continue
    try {
      const dataUri = await resolveImage(candidate)
      if (typeof dataUri === 'string' && dataUri.length > 0) img.setAttribute('src', dataUri)
    } catch {
      // A host error leaves the image unresolved rather than breaking the render.
    }
  }
}
