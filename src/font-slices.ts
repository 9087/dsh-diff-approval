/**
 * The bundled code font: what the panel asks for, and where the files live.
 *
 * One CJK glyph is exactly twice one Latin glyph in this face, which is what
 * puts code and Chinese comments on the same character grid. No system stack can
 * do that: the shell's code font resolves hanzi to a proportional face
 * (`"PingFang SC"`, `"Microsoft YaHei"`), so comments drift out of column on
 * Windows and Android.
 *
 * Both halves need the same names — the host serves the files under
 * {@link FONT_ROUTE}, the client asks for {@link FONT_FAMILY} — so they live
 * here rather than being written twice.
 *
 * @module dsh-diff-approval/font-slices
 */

/**
 * The family the client declares and asks for.
 *
 * It names the actual face — this is JetBrains Maple Mono, subset and sliced by
 * this plugin — and carries the project suffix so it cannot collide with a copy
 * of the upstream font installed on the reader's machine. That collision would
 * be silent and one-sided: a locally installed font wins over a webfont of the
 * same name, so the slices would never be fetched and the bytes on screen would
 * be someone else's build. The trailing marker also keeps the upstream names out
 * of a user-visible primary name, which is what the OFL asks of a modified
 * version (Maple Mono declares `Maple Mono` as a Reserved Font Name).
 */
export const FONT_FAMILY = 'JetBrains Maple Mono for DSH'

/**
 * The URL prefix the host mounts. The client resolves it against the document's
 * own origin, so a tunnel or a non-default port needs no configuration.
 */
export const FONT_ROUTE = '/dsh-diff-approval/fonts'

/** One weight of the face. Both are the same subset, so the ranges are shared. */
export interface FontFace {
  /** File-name infix: `regular-hanzi-000.woff2`. */
  readonly name: string
  /** The weight the CSS declares; the slice files are per weight. */
  readonly weight: number
}

/** Regular carries the code; the Semibold only backs emphasised text. */
export const FONT_FACES: readonly FontFace[] = [
  { name: 'regular', weight: 400 },
  { name: 'semibold', weight: 600 },
]

/**
 * The code font stack. The bundled family comes first so its 2:1 grid wins,
 * and the previous stack stays behind it for anything the slices do not cover —
 * Korean, CJK Ext-A/B, and the handful of codepoints this face leaves unmapped.
 */
export const FONT_STACK = [
  `"${FONT_FAMILY}"`,
  '"SF Mono"',
  '"JetBrains Mono"',
  '"Fira Code"',
  'Consolas',
  '"Liberation Mono"',
  'Menlo',
  'Courier',
  '"PingFang SC"',
  '"Microsoft YaHei"',
].join(', ')

/** One slice file as the manifest records it. */
export interface FontSlice {
  readonly file: string
  readonly bytes: number
  readonly unicodeRange: string
  readonly kind: 'latin' | 'punctuation' | 'symbols' | 'cjk-punctuation' | 'hanzi'
  readonly weight: number
}

/** Where the generated slices and their manifest live, relative to `lib/`. */
export const FONT_ASSET_DIR = '../assets/fonts'
