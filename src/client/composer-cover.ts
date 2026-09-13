/**
 * Pasting a copied reference into the composer, and where the caret goes.
 *
 * The reference lands in the draft whatever the panel is doing. The caret is a
 * different question: the review panel can be over the composer, and moving the
 * focus into a field the reader cannot see would take their next keystrokes with it.
 * So the focus is asked for only when the composer is really visible.
 *
 * @module dsh-diff-approval/client/composer-cover
 */

/** The panel's own element, whichever way it is being presented. */
const PANEL_SELECTOR = '[data-diff-approval-panel]'
/** The composer's parts, most specific first: the editable input itself, its card,
 *  and the seat that hosts them (the seat stays mounted through a takeover). */
const COMPOSER_PART_SELECTORS = ['[data-composer-input]', '[data-composer-card]', '[data-composer-seat]']
/** The composer's own editable box: a contenteditable div, not a `<textarea>`. */
const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
/**
 * How much of the composer the panel has to cover before the composer counts as
 * hidden, as a fraction of the composer's own area. Plain intersection is too eager
 * — a box that grazes the composer's edge by a pixel is not covering it, and the
 * caret belongs there as much as ever — while demanding near-total coverage would
 * miss the real cases (a covered composer edge, the short-window floor, a fullscreen
 * docked pane) where the composer ends up *entirely* inside the panel's box. Half is
 * the line between the two: more of it hidden than not.
 */
const COMPOSER_COVERED_RATIO = 0.5

/**
 * Whether the review panel is covering the chat composer as it stands right now.
 *
 * Measured, not inferred from the presentation, because the cases do not line up one
 * per mode:
 * - floating with the composer edge left uncovered, the panel stops above the
 *   composer — except when the window is too short for the panel's own minimum
 *   height, and then it covers every edge, the composer's included (the phone case);
 * - floating over an undocked ("hero") composer, the panel spans the conversation
 *   and the composer sits inside it;
 * - docked in the right sidebar, the composer is normally in the conversation column
 *   beside the pane and stays visible — but a fullscreen sidebar spans the window,
 *   and the panel inside it spans the window too.
 * Whatever a layout does next, an overlap is an overlap, so this measures the two
 * boxes and the fraction of the composer they share.
 * @returns whether the panel covers more than {@link COMPOSER_COVERED_RATIO} of the
 *   composer.
 */
export function composerCoveredByPanel(): boolean {
  if (typeof document === 'undefined') return false
  const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR)
  if (panel === null) return false
  let composer: HTMLElement | null = null
  for (const selector of COMPOSER_PART_SELECTORS) {
    composer = document.querySelector<HTMLElement>(selector)
    if (composer !== null) break
  }
  if (composer === null) return false
  const p = panel.getBoundingClientRect()
  const c = composer.getBoundingClientRect()
  // A box with no size is not on screen — a panel that has not been laid out, a
  // composer inside a hidden tab: nothing is covered by it.
  if (p.width <= 0 || p.height <= 0 || c.width <= 0 || c.height <= 0) return false
  const overlapWidth = Math.min(p.right, c.right) - Math.max(p.left, c.left)
  const overlapHeight = Math.min(p.bottom, c.bottom) - Math.max(p.top, c.top)
  if (overlapWidth <= 0 || overlapHeight <= 0) return false
  return (overlapWidth * overlapHeight) / (c.width * c.height) > COMPOSER_COVERED_RATIO
}

/** Everything the composer is made of, for "is the caret in the composer?". */
const COMPOSER_SCOPE_SELECTOR = '[data-composer-input],[data-composer-card]'

/**
 * Take the caret out of the composer when it is holding it.
 *
 * Declining to *move* the caret there is not enough on its own: the chord works with
 * the caret wherever it is, and the caret is usually in the composer — someone who
 * was typing, then selected a few lines in the diff with the mouse (a selection does
 * not move the focus), would have the reference pasted into a composer they cannot
 * see and their next keystrokes land in it. So a hidden composer loses the caret.
 */
export function leaveComposerCaret(): void {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (active.closest(COMPOSER_SCOPE_SELECTOR) === null) return
  active.blur()
}

/**
 * Append a copied reference to the composer's draft, and leave the caret there only
 * when the composer is not behind the panel.
 * @param appendDraft - writes the reference into the addressed session's draft.
 * @param reference - the copied `(file:line)` reference.
 */
export function pasteReferenceIntoComposer(appendDraft: (reference: string) => void, reference: string): void {
  appendDraft(reference)
  if (composerCoveredByPanel()) {
    leaveComposerCaret()
    return
  }
  document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus()
}
