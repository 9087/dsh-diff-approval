/**
 * Route a produced-file chip's own click.
 *
 * The harness's `ProducedFiles` component renders each produced file as a `<button>` chip inside
 * `[data-produced-files-row]`, with the full path riding the chip's `title`. The plugin wants a
 * second way to open a file it is already reviewing — in the review panel — but it must not take
 * the harness's own open away from anyone else, and it must not touch the harness component. So
 * this module watches for a click on those chips and answers ONE narrow case:
 *
 *   the chip names a file the panel currently holds → the click is the panel's, and becomes a menu
 *   (「默认方式打开」 / 「在审批面板中查看」, see `CHIP_MENU_EVENT`);
 *   anything else → the click is left entirely alone and DSH does whatever it always did.
 *
 * The first menu row must open the file exactly the way DSH does — and what that is, is the
 * harness's business, not this plugin's — so it is not re-implemented here: `replayChipClick`
 * presses the same chip again, with the interceptor standing down for that one press. A press DSH
 * keeps keeps its modifiers too: a Ctrl/Cmd/Shift/Alt-click and a middle click never reach the
 * bridge, so a modifier gesture the harness grows later cannot be swallowed by this plugin.
 */

/** Window event dispatched when a pending file's chip is pressed; the panel listens for it. */
export const CHIP_MENU_EVENT = 'diff-approval:chip-menu'

/** Window event dispatched by the panel to open a file in the panel; PendingPanel listens for it. */
export const OPEN_FILE_EVENT = 'diff-approval:open-file'

/** The produced-file chip selector (the container row itself is not needed). */
const CHIP_SELECTOR = '[data-produced-files-row] button'

/** What a chip press tells the panel: which file, and where the chip is (the menu hangs under it). */
export interface ProducedChipMenuDetail {
  /** The path the pressed chip names. */
  path: string
  /** The chip's own box, in viewport coordinates. */
  x: number
  y: number
}

/** What the bridge needs from the host to decide, and to report. */
export interface ProducedChipBridge {
  /**
   * Whether the panel holds this file right now. Called synchronously on every chip press, because
   * the decision it answers is whether the press is prevented — there is no second chance at it.
   */
  isPending: (path: string) => boolean
  /** A chip of a pending file was pressed: open the menu the press asked for. */
  onMenu: (detail: ProducedChipMenuDetail) => void
}

/** Read the produced-file path from a chip (`title` carries the full path). */
function producedPathOf(chip: Element): string | undefined {
  const path = chip.getAttribute('title')?.trim()
  return path === undefined || path === '' ? undefined : path
}

/** The chip whose press `replayChipClick` is replaying, if any: its press is DSH's, not the menu's. */
let replaying: Element | null = null

/**
 * Press a produced-file chip again — DSH's own open, run the only way this plugin can run it
 * faithfully, with the bridge standing down for that press (see the file's own doc).
 *
 * @param path - the file the chip names.
 * @returns whether a chip naming it was found to press.
 */
export function replayChipClick(path: string): boolean {
  const chip = [...document.querySelectorAll<HTMLElement>(CHIP_SELECTOR)]
    .find(candidate => producedPathOf(candidate) === path)
  if (chip === undefined) return false
  replaying = chip
  try {
    chip.click()
  } finally {
    replaying = null
  }
  return true
}

/**
 * Start routing produced-file chip presses.
 *
 * @param bridge - the host's decision (is the file pending) and where to report a press that is.
 * @returns a cleanup that stops routing.
 */
export function startProducedChipMenu(bridge: ProducedChipBridge): () => void {
  const onClick = (event: MouseEvent): void => {
    // A modifier press is not this bridge's: it is a gesture the harness may give its own meaning,
    // and the plugin has no menu to offer it (see the file's own doc).
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    const chip = target.closest(CHIP_SELECTOR)
    if (chip === null || chip === replaying) return
    const path = producedPathOf(chip)
    // Not a file the panel holds: DSH's press, untouched.
    if (path === undefined || !bridge.isPending(path)) return
    // The review panel's press: DSH must not also act on it, or the reader would get both the
    // harness's open and the menu. Captured on the document so no handler between here and the
    // chip sees it either.
    event.preventDefault()
    event.stopImmediatePropagation()
    const rect = chip.getBoundingClientRect()
    bridge.onMenu({ path, x: rect.left, y: rect.bottom })
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}
