/**
 * Inject a "查看差异" button beside each DSH produced-file chip.
 *
 * The harness's `ProducedFiles` component renders each produced file as a
 * `<button>` chip inside `[data-produced-files-row]`; the full path rides the
 * chip's `title`. This plugin wants a quick "view this file's diff" affordance
 * there, but the plugin should not have to touch the harness component. So this
 * module watches the DOM for those chips (via a MutationObserver, the same
 * bridge the dsh-pocket mobile fork uses to inject its 复制 buttons) and injects
 * a small button after each one. Clicking it dispatches a window event that the
 * diff-approval panel listens for (see PendingPanel), which opens the panel and
 * selects the file when it is still pending, or toasts otherwise.
 *
 * The injected button is intentionally self-contained (inline styles + a fixed
 * label) so it needs no stylesheet and no harness change.
 */

/** Window event dispatched by the injected button; PendingPanel listens for it. */
export const OPEN_FILE_EVENT = 'diff-approval:open-file'

/** Marker set on a produced-file chip once its diff button has been injected. */
const INJECTED_ATTR = 'data-diff-approval-produced-diff'

/** Marker set on the injected "查看差异" button itself (so cleanup can find it). */
const BUTTON_ATTR = 'data-diff-approval-produced-diff-btn'

/** The produced-file chip selector (the container row itself is not needed). */
const CHIP_SELECTOR = '[data-produced-files-row] button'

/** Read the produced-file path from a chip (`title` carries the full path). */
function producedPathOf(chip: HTMLElement): string | undefined {
  const path = chip.getAttribute('title')?.trim()
  return path === undefined || path === '' ? undefined : path
}

/** Inline layout styles matching the file chip's measured values: the chip is
 * 22px tall / 6px radius / 0 8px inline padding on the `--dsw-alias-bg-base`
 * surface. `color` is inlined (the chip's gray text) so the icon is always right;
 * `background` (rest + a deeper hover) stays in the injected <style> rule.
 * `display` is set separately (see inject) to mirror the chip's visibility. */
function buttonStyle(): Partial<CSSStyleDeclaration> {
  return {
    flex: 'none',
    marginLeft: '-4px',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    height: '22px',
    padding: '0 6px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)',
  }
}

/** The DSH "open / jump" icon (IconRightUpOutline16): a diagonal arrow pointing
 *  top-right, i.e. the classic "navigate to / open" affordance — a clean, already
 *  theme-consistent glyph to use instead of hand-drawing +/-. 16×16 matches the
 *  harness's own action glyph; `currentColor` rides the chip's gray text. */
const DIFF_ICON_SVG =
  '<svg width="7" height="7" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="color:var(--dsw-alias-label-secondary)">' +
  '<path d="M13.588429 5.147807C13.588429 4.739638 13.587271 4.403003 13.582013 4.118684L1.703098 15.99968L0.85155 15.148178L0 14.294485L11.878915 2.413442C11.594721 2.408199 11.257569 2.409154 10.849776 2.409154H2.400594V0.000001H10.849776C11.644471 0.000001 12.338899 -0.001059 12.901622 0.059909C13.486363 0.123352 14.071136 0.265493 14.598303 0.648292C14.886598 0.857751 15.141981 1.110984 15.351433 1.399281C15.734578 1.926807 15.876362 2.512925 15.939743 3.098105C16.000775 3.660718 15.99968 4.353347 15.99968 5.147807V13.599133H13.588429V5.147807Z" fill="currentColor"/>' +
  '</svg>'

/**
 * Start injecting diff buttons into the produced-files row.
 * @param label - localized "查看差异" text, used as the icon button's accessible
 *   name + hover title (the button renders only an icon).
 * @param openPath - called with a produced-file path when its injected button is
 *   clicked; the diff-approval panel decides whether that file is still pending.
 * @returns a cleanup that disconnects the observer and removes injected buttons.
 */
export function startProducedDiffInjection(
  label: string,
  openPath: (path: string) => void,
): () => void {
  // A :hover tint cannot come from inline styles (inline out-ranks any
  // stylesheet rule), so install a rule for the injected controls. The icon rides
  // the file-chip link blue so the button carries a color; hovering adds the
  // DSH interaction tint as the background.
  let ownedStyleEl: HTMLStyleElement | null = null
  if (document.querySelector('style[data-diff-approval-produced-diff]') === null) {
    ownedStyleEl = document.createElement('style')
    ownedStyleEl.setAttribute('data-diff-approval-produced-diff', '')
    ownedStyleEl.textContent =
      `[${BUTTON_ATTR}]{background:rgba(38, 49, 72, 0.06);}` +
      `[${BUTTON_ATTR}]:hover{background:rgba(38, 49, 72, 0.14);}`
    document.head.appendChild(ownedStyleEl)
  }

  const inject = (): void => {
    // Snapshot the chips; the loop below mutates the DOM (inserting buttons),
    // which we must not re-scan in the same pass.
    const chips = [...document.querySelectorAll<HTMLElement>(CHIP_SELECTOR)]
    for (const chip of chips) {
      const path = producedPathOf(chip)
      if (path === undefined) continue
      // A span (role=button) is used on purpose: the row's chips are <button>
      // and its narrow-screen container queries hide `.file:nth-of-type(n)` by
      // counting buttons, so a real <button> sibling would shift that count and
      // make the harness hide the wrong file. The span stays out of `:nth-of-type`.
      if (chip.getAttribute(INJECTED_ATTR) === '1') continue
      // Dedupe by path: a React re-render can hand the row a fresh chip element
      // (losing INJECTED_ATTR) while a button for that path is already present,
      // which would otherwise inject a second button after the one chip.
      const already = [...document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`)]
        .some(btn => btn.getAttribute('data-path') === path)
      if (already) {
        chip.setAttribute(INJECTED_ATTR, '1')
        continue
      }
      chip.setAttribute(INJECTED_ATTR, '1')
      const btn = document.createElement('span')
      btn.setAttribute('role', 'button')
      btn.setAttribute('tabindex', '0')
      btn.setAttribute(BUTTON_ATTR, '1')
      btn.setAttribute('data-path', path)
      // The tooltip names the exact file the diff is for.
      btn.setAttribute('aria-label', `${label}: ${path}`)
      btn.setAttribute('title', `${label}: ${path}`)
      Object.assign(btn.style, buttonStyle())
      btn.innerHTML = DIFF_ICON_SVG
      btn.addEventListener('click', (event) => {
        // Don't let the injected button bubble into a parent row handler.
        event.preventDefault()
        event.stopImmediatePropagation()
        openPath(path)
      })
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openPath(path)
        }
      })
      chip.insertAdjacentElement('afterend', btn)
    }
    // Ensure the button is always rendered: a React re-render can shift/remove
    // the chip, and aggressively hiding (a previous "keep it beside a hidden
    // chip" guess) turned out to hide the button even when the chip is visible,
    // which read as "the button is gone". Keep it simple and always show it.
    for (const btn of document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`)) {
      btn.style.display = 'inline-flex'
    }
  }

  inject()
  // React re-renders the produced-files row as turns settle, so keep watching;
  // each new chip carries no marker and gets its own button.
  const observer = new MutationObserver(() => inject())
  observer.observe(document.body, { childList: true, subtree: true })
  // The container-query hiding is CSS-driven (no DOM mutation fires), so watch
  // the window size and re-mirror visibility on resize.
  const onResize = (): void => inject()
  window.addEventListener('resize', onResize)

  return () => {
    observer.disconnect()
    window.removeEventListener('resize', onResize)
    document.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`).forEach((el) => el.remove())
    if (ownedStyleEl !== null) ownedStyleEl.remove()
  }
}
