/**
 * Load the bundled code font and put the diff's code on its grid.
 *
 * The face is dual-width: one CJK glyph is exactly twice one Latin glyph, so
 * code and Chinese comments share a character grid. The shell's own code font
 * cannot do that — it resolves hanzi to a proportional face (`"PingFang SC"`,
 * `"Microsoft YaHei"`), so a comment that starts in column 40 of the code ends
 * somewhere else entirely on Windows and Android, where the browser has no
 * monospaced CJK face at all.
 *
 * The rule is one selector wide: **the code column only**, `.lines`. Comment
 * bubbles, the file list and the panel's chrome keep the shell's font stack; the
 * code is where the grid is the point.
 *
 * **Off until asked for.** The slices are tens of kilobytes for ordinary text
 * and up to ~120 KB for a rare character, which is traffic the reader pays for,
 * so the Settings switch is the gate and its description says so. Off is not
 * just "no rule": nothing is fetched at all, so the default panel is byte-for-
 * byte and pixel-for-pixel what it was before this existed. A browser fetches a
 * `@font-face` only when a rule uses it, which is what keeps an enabled pure-
 * ASCII file down to the one Latin slice.
 *
 * The face's own `calt` stays on, so `->` and `=>` draw as the arrows JetBrains
 * Mono already draws everywhere else in this UI. The upstream project also
 * builds a no-ligature variant (`…-NL-…`) if that ever stops being wanted; it
 * would mean re-slicing, not a CSS override, because `calt` is what carries the
 * arrows.
 *
 * @module dsh-diff-approval/client/code-font
 */

import { FONT_FACES, FONT_FAMILY, FONT_ROUTE, FONT_STACK } from '../font-slices.ts'
import panelCss from './PendingPanel.module.css'
import { CODE_FONT_CHANGED_EVENT, codeFontEnabled } from './settings.ts'

/** The style element this module owns, marked so it is never injected twice. */
const STYLE_MARKER = 'data-diff-approval-code-font'

/** The manifest path, resolved against the document's own origin. */
const MANIFEST_URL = `${FONT_ROUTE}/manifest.json`

/**
 * The class the panel puts on the code table, read from the stylesheet module
 * that defines it.
 *
 * A literal `.lines` selector is a no-op: the build prefixes every class in that
 * module (`Ay7oXG_lines`), so a rule naming the source name matches no element
 * and the font silently never applies. The module's own export is the one value
 * that cannot drift from what the panel renders.
 */
const CODE_TABLE_CLASS = panelCss.lines ?? ''

/** One slice as the manifest lists it. */
interface ListedSlice {
  readonly file: string
  readonly unicodeRange: string
  readonly weight: number
}

/**
 * The `@font-face` rules for every slice of every weight, followed by the one
 * rule that uses them: the code column.
 *
 * `font-display: swap` rather than `block`: the code is readable in the system
 * font immediately, and swapping when the slices land only changes the column
 * width, never the row height that the virtual window and the jump math are
 * built on.
 *
 * @param slices - the manifest's slice list.
 * @param codeClass - the class the code table carries, defaulting to the one the
 *   panel's stylesheet exports. It is a parameter so a test can pin the emitted
 *   selector without importing the panel.
 */
export function codeFontCss(slices: readonly ListedSlice[], codeClass: string = CODE_TABLE_CLASS): string {
  const rules: string[] = []
  for (const face of FONT_FACES) {
    for (const slice of slices) {
      if (slice.weight !== face.weight) continue
      if (slice.file.indexOf(`${face.name}-`) !== 0) continue
      rules.push(
        `@font-face{font-family:"${FONT_FAMILY}";` +
        `src:url("${FONT_ROUTE}/${slice.file}") format("woff2");` +
        `font-weight:${face.weight};font-style:normal;font-display:swap;` +
        `unicode-range:${slice.unicodeRange}}`,
      )
    }
  }
  // One rule, one selector: the diff's code table. Comment bubbles, the file
  // list and the panel's chrome are outside it and keep the shell's stack,
  // which keeps the change to the place where the grid is the point. An empty
  // class means the stylesheet module stopped exporting `lines`, and a rule
  // written without one would match nothing: emit none, and let the test that
  // pins the export fail instead of the font doing nothing in silence.
  if (codeClass !== '') rules.push(`.${codeClass}{font-family:${FONT_STACK}}`)
  return rules.join('\n')
}

/** The manifest, read once per page: the slices it lists never change under us. */
let manifestPromise: Promise<readonly ListedSlice[] | undefined> | undefined

/** Whether the one "the switch is on but the host serves no slices" line was written. */
let reportedMissing = false

/** Fetch (or reuse) the slice list. Undefined when the host serves no slices. */
function fetchSlices(): Promise<readonly ListedSlice[] | undefined> {
  manifestPromise ??= (async () => {
    try {
      const response = await fetch(MANIFEST_URL, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const manifest = (await response.json()) as { slices?: ListedSlice[] }
      const slices = manifest.slices ?? []
      if (slices.length === 0) throw new Error('the manifest lists no slices')
      return slices
    } catch (error) {
      // Off is the default and silent by design; on is not. A reader who turned
      // the switch on and sees the system font has a deployment problem — the
      // host bundle has no `assets/fonts` beside it — and nothing else in the
      // panel would ever say so. The failure is not cached either, so flipping
      // the switch again retries (a host that was reinstalled mid-page starts
      // serving without a reload).
      manifestPromise = undefined
      if (!reportedMissing) {
        reportedMissing = true
        console.warn(`diff-approval: the bundled code font is unavailable (${MANIFEST_URL})`, error)
      }
      return undefined
    }
  })()
  return manifestPromise
}

/** The style element this module owns, once it has been injected. */
function styleElement(): HTMLStyleElement | null {
  return document.head.querySelector<HTMLStyleElement>(`style[${STYLE_MARKER}]`)
}

/**
 * Drop the cached slice list and the injected rules.
 *
 * The manifest is read once per page on purpose — it never changes under a live
 * client — so this exists for tests, which need each case to start from the
 * same empty state. Nothing in the app calls it.
 */
export function resetCodeFontForTests(): void {
  manifestPromise = undefined
  reportedMissing = false
  styleElement()?.remove()
}

/**
 * Install the rules, or take them out again, to match the preference.
 *
 * Off is the default and costs nothing at all: no manifest request, no
 * `@font-face`, no rule — the panel renders exactly as it did before the font
 * existed. On is where the slices are fetched, and only as the code actually
 * needs them.
 *
 * @param live - whether the caller is still attached, consulted again after the
 *   manifest await: a detached client must not install a font nobody owns.
 */
async function apply(live: () => boolean): Promise<void> {
  if (!codeFontEnabled()) {
    styleElement()?.remove()
    return
  }
  if (styleElement() !== null) return
  const slices = await fetchSlices()
  if (slices === undefined || !live() || !codeFontEnabled() || styleElement() !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_MARKER, '')
  style.textContent = codeFontCss(slices)
  document.head.appendChild(style)
}

/**
 * Follow the preference for as long as the client lives: apply it now, and again
 * whenever the Settings switch flips. A host without the slices (a source
 * checkout that never ran the font build, or an install that arrived without
 * `assets/`) keeps the system stack, and says so once on the console: the
 * switch is on, so silence would read as "the font does nothing".
 *
 * @returns a disposer that stops following and removes the injected rules.
 */
export function attachCodeFont(): () => void {
  if (typeof document === 'undefined' || typeof fetch !== 'function') return () => {}
  let attached = true
  // Every run carries the attachment that asked for it, so a run whose
  // attachment has since been disposed cannot install rules — including the run
  // that is still sitting on the manifest response when the disposer fires.
  let generation = 0
  const run = (mine: number): void => { void apply(() => attached && generation === mine) }
  run(generation)
  const onChange = (): void => { if (attached) run(generation) }
  window.addEventListener(CODE_FONT_CHANGED_EVENT, onChange)
  return () => {
    attached = false
    generation += 1
    window.removeEventListener(CODE_FONT_CHANGED_EVENT, onChange)
    styleElement()?.remove()
  }
}
