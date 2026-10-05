/**
 * The colour a comment's CATEGORY is drawn as: one round dot per class of annotation.
 *
 * An agent annotating several passes over the same review (a call-chain walk, then the findings, then a
 * second round of questions) can pass the same `category` id for every annotation of one kind and a
 * different id for the next — and the reader then sees at a glance which class each comment belongs to,
 * without reading a word. The id itself is opaque here: this module never parses it, only hashes it.
 *
 * The mapping is a plain hash into a fixed palette, so it is the SAME colour on any host and after any
 * reload, with nothing persisted beyond the id the record already carries. Two ids can collide on one
 * colour — 12 buckets cannot promise otherwise — which is why the reader also gets the id in words
 * (`title`/`aria-label`): colour is a fast cue, never the only one.
 *
 * @module dsh-diff-approval/src/client/category-color
 */

/**
 * The twelve colours, in the order the hash indexes them — and THE ORDER IS PART OF THE CONTRACT, because
 * the index is the bucket (see `categoryColorIndex`).
 *
 * The SET was chosen by CIEDE2000, not by eye and not by hue angle: it is a coordinate-ascent result over
 * twelve colour families, and its MINIMUM pairwise ΔE00 is **18.82** — owned by the light blue and the grey
 * — with every entry between L* 42 and 70, so each reads as a mark on the panel's light and dark surfaces
 * alike. An earlier palette looked well spaced on the hue wheel and was not: indigo `#6E56CF` against
 * purple `#8E4EC6` sat 20° apart at the same lightness and chroma — ΔE00 **6.94** on a 3px mark — and a
 * near-duplicate green `#57a751` would have passed a hue-angle floor at ΔE00 2.65.
 *
 * THE ORDER was then solved for SEPARATELY (2026-10-06), because the set's spacing says nothing about the
 * spacing of NEIGHBOURING buckets: the array used to be a hue ramp, so two categories whose hashes landed
 * on adjacent indices — 2 times out of 12, which is the reader's own pair at indices 7 and 8 — differed by
 * as little as ΔE00 19.28. The sequence below is the bottleneck Hamiltonian path over those same twelve
 * colours: the order that MAXIMISES the MINIMUM ΔE00 over the eleven consecutive pairs, proved optimal by
 * a DP over (mask, last) in the scratch script that chose it. Its consecutive minimum is **32.7475** — the
 * full value is 32.74748843826888, which is why the test's floor is 32.7474 and not the rounded figure —
 * owned by the grey and the red, against 19.2835 for the shipped order, and the set itself is byte-identical,
 * so the whole-palette floor above is still 18.82. `tests/category-color.client.spec.ts` asserts BOTH numbers
 * (whole-set and consecutive) plus the L* band, so a thirteenth colour or a reshuffle fails a test rather
 * than shipping.
 *
 * Two categories can still collide EXACTLY — twelve buckets cannot promise otherwise, and `alpha`/`beta` in
 * the spec do — so the promise this order keeps is "adjacent buckets differ a lot", never "different ids
 * always differ"; colour is a fast cue, and the id in the mark's own `title`/`aria-label` is the exact one.
 */
export const CATEGORY_COLORS = [
  '#7F888E', // grey
  '#C33D41', // red
  '#6A5CA4', // indigo
  '#7AAB83', // sage
  '#B8A3CA', // lavender
  '#1D6F66', // dark teal
  '#DC54B9', // magenta
  '#80A5EB', // light blue
  '#8D711B', // bronze
  '#13A9BF', // cyan
  '#577F11', // olive
  '#C19784', // tan
] as const

/**
 * Which palette entry a category id maps to: FNV-1a (32-bit) over the id's UTF-16 code units, mod 12.
 *
 * FNV-1a because it is four lines, has no dependencies, and spreads uuid-shaped ids (the reader's own
 * suggestion: "passing a uuid per call") well enough that a handful of categories rarely collide. It is
 * pinned by a test with a fixed id, so changing the hash is a visible decision rather than a silent
 * recolouring of every existing annotation.
 *
 * @param category - the category id, as it was stored (already trimmed and capped by the tool rule).
 * @returns the index into {@link CATEGORY_COLORS}, 0..11.
 */
export function categoryColorIndex(category: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < category.length; index += 1) {
    hash ^= category.charCodeAt(index)
    // `Math.imul` keeps the multiply in 32-bit space; `>>> 0` keeps the running value unsigned the way
    // FNV-1a is defined, so the result does not depend on the engine's number handling.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % CATEGORY_COLORS.length
}

/**
 * The colour one category is drawn as.
 *
 * @param category - the category id.
 * @returns a `#RRGGBB` string from {@link CATEGORY_COLORS}.
 */
export function categoryColor(category: string): string {
  return CATEGORY_COLORS[categoryColorIndex(category)] ?? CATEGORY_COLORS[0]
}
