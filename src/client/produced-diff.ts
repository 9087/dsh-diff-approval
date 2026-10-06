/**
 * Route a file press's own click.
 *
 * The harness draws several presses that answer by opening a file in a viewer of its OWN, and this
 * module takes over exactly those — and only for a file the review panel is already holding — so the
 * reader gets both ways of opening it instead of one fixed behaviour:
 *
 *   `[data-produced-files-row] button`    0.1.5's produced-file card       `title` = the path
 *   `[data-presented-files-row] button`   0.1.7's presented-file card      `title` = the path
 *   `[data-changed-files] button`         0.1.7's changed-files row        `aria-describedby` = the path
 *   `button[title]`                       a message's file LINK (0.1.7)    `title` = the path
 *   `button[data-ref-chip]`               a `@file` chip in a message      `title` = the token
 *   `a[href]`                             any other link naming a file     `href`  = the path
 *
 * Everything else is left entirely alone: a link to a URL, an in-page anchor, a chip naming something
 * that is not a file, a file LINK whose file this panel does not hold, a modified press (Ctrl/Cmd/Shift/
 * Alt, or a middle click — gestures the harness may give its own meaning later), and any press inside this
 * plugin's own surface, whose buttons carry paths too and belong to the panel that is already showing
 * the file. A file-list ROW is the one press taken over whether or not the panel holds its file (see
 * `ROW_SELECTOR`); "we do not hold it" then decides what the menu offers, not whether it appears.
 *
 * The name of the module (and of the event it raises) dates from when the produced-file card was the
 * only press of this kind; `data-presented-files-row` is that same list under 0.1.7's name for it.
 */

import type { PendingDiffSnapshot } from './slots.ts'
import { diffPathsMatch } from './path-match.ts'

/** Window event dispatched when a pending file's press is taken over; the panel listens for it. */
export const CHIP_MENU_EVENT = 'diff-approval:chip-menu'
/**
 * Whether the page HOLDS this path — the `held` label a press carries into the menu.
 *
 * It is a LABEL now, not a gate: every file-list row's press becomes the menu regardless, and `held` only
 * decides whether "在审批面板中查看" opens the row directly or adds it first (see `PendingPanel`). It is
 * answered from the views the page is holding, i.e. from the last FULL read of each session: while every
 * surface is shut nothing re-reads the list, so a row edited since then is labelled not-held. That is
 * acceptable rather than hidden: the add answers the truth (a path already listed comes back `duplicate` and
 * selects the same entry), so the item still opens the file — one request later. What the label must not do
 * is claim a row exists that does not: `false` errs towards adding, never towards acting on nothing.
 * @param views - the views this page is holding, one per session it has read (see `PendingDiffStore.views`).
 * @param path - the path a press named.
 * @returns whether any held view holds it.
 */
export function panelHolds(views: readonly PendingDiffSnapshot[], path: string): boolean {
  return views.some(view =>
    view.files.some(file => diffPathsMatch(path, file.path, view.workspacePath)))
}

/** Window event dispatched by the panel to open a file in the panel; PendingPanel listens for it. */
export const OPEN_FILE_EVENT = 'diff-approval:open-file'

/**
 * The presses that open a file in the shell's own viewer, one per shape measured in a shell.
 *
 * ONE FAMILY, ONE RULE: every press this list matches becomes this menu, whether or not the review list
 * holds the file. A row of a file list (`[data-produced-files-row]`, `[data-presented-files-row]`,
 * `[data-changed-files]`) is a file the session changed, and a file link written in a message
 * (`button[title]`, an `@file` chip, an `a[href]`) is a file the reader pointed at — in both cases the
 * reader aimed at a file, and "the review list does not hold it (yet)" is a thing the menu ANSWERS by
 * offering to add it rather than a reason to leave the press to the shell and show nothing. This is the
 * reader's bug: a link whose change had been settled away popped no menu at all.
 *
 * What decides that a press is not ours at all is `pressPathOf`'s own filter (`looksLikePath`): a URL, an
 * in-page anchor, a `mailto:` and every other non-file spelling never reaches this list's decision, so an
 * ordinary web link is still the shell's. `held` is a LABEL the menu carries, never a gate on the press.
 *
 * A press this list misses is not a crash — it is one menu the reader does not get.
 */
const PRESS_SELECTOR = [
  '[data-produced-files-row] button',
  '[data-presented-files-row] button',
  '[data-changed-files] button',
  'button[title]',
  'button[data-ref-chip]',
  'a[href]',
].join(', ')

/**
 * A shell press that looks like one of the above and is NOT one: the review pane's file picker.
 *
 * `button[data-review-file]` carries the file's path in `title` exactly like a file link does, but its
 * press does not open anything — it switches which file the shell's own review pane is showing
 * (`onClick: () => setMenuOpen(…)`, measured in `dsh-client-ui-deliverables`). Taking that press over
 * would leave the reader unable to change files inside the shell's review view, which is not a menu
 * anyone asked for.
 */
const SHELL_PICKER_SELECTOR = '[data-review-file]'

/**
 * This plugin's own surfaces, as the markers they render (`data-diff-approval-*`).
 *
 * A press inside one of them is the panel's: the panel's own rows and buttons carry file paths, and
 * routing those here would take a click away from the surface that is already showing the file — and
 * away from the panel's own "查看差异" bridge, which is the same idea expressed a different way.
 */
const OWN_SURFACE_SELECTOR = [
  '[data-diff-approval-panel]',
  '[data-diff-approval-dock]',
  '[data-diff-approval-chip]',
  '[data-diff-approval-badge]',
  '[data-diff-approval-header-entry]',
  '[data-diff-approval-settings]',
].join(', ')

/** What a press tells the panel: which file, where the press was (the menu hangs under it), and whether
 *  the review list already holds that file. */
export interface ProducedChipMenuDetail {
  /** The path the pressed element names. */
  path: string
  /** The pressed element's own box, in viewport coordinates. */
  x: number
  y: number
  /**
   * Whether the review list holds this path right now.
   *
   * It decides what the menu's items DO, never whether the menu appears: a row press always becomes the
   * menu, and "not held" is what makes "在审批面板中查看" add the path first (see `PendingPanel`). It is
   * also what a future item that NEEDS a listed entry has to gate on — pressing keep or revert for a file
   * the host is not holding would simply fail.
   */
  held: boolean
  /**
   * The session the press belongs to, when its own surface says so.
   *
   * WITHOUT THIS the panel can only ask the session IT is showing to add the path, and the host resolves that
   * path against that session's workspace: a press in session A's transcript while the panel is still bound
   * to session B answers `outside` ("路径不在当前工作区内") — measured, and it was the reader's bug: the first
   * press refused and the second worked, because by then the panel had followed the shell's selection.
   *
   * Read from the ANCESTORS of the pressed element only (see `sessionOfPress`), and `undefined` when none of
   * them names a session. That is the honest half: the panel then asks its own session and, if the host
   * refuses, says so with the wording that names what was checked rather than blaming the path.
   */
  sessionId?: string | undefined
}

/** What the bridge needs from the host to decide, and to report. */
export interface ProducedChipBridge {
  /**
   * Whether the review list holds this path right now.
   *
   * A LABEL, not a gate: it rides every press this bridge takes over (a file-list row and a message's file
   * link alike) and decides only what the menu's items DO — see `held` above. It is called synchronously on
   * every press because that is when the menu is raised, and there is no second chance at a press.
   */
  isPending: (path: string) => boolean
  /** A pending file's press was taken over: open the menu the press asked for. */
  onMenu: (detail: ProducedChipMenuDetail) => void
  /**
   * Whether this plugin's file menu is MOUNTED at all — the reader's setting, read at press time.
   *
   * `false` leaves every press exactly as DSH has it: no menu, no `preventDefault`, not even a path lookup,
   * so the plugin's presence is indistinguishable from it never having loaded. It is read per press rather
   * than latched, because the setting can be switched while the page is open.
   *
   * ABSENT means enabled: a host, or a test, that offers no setting keeps the behaviour this bridge has
   * always had.
   */
  enabled?: (() => boolean) | undefined
}

/** Everything before a `#line` or `?query` suffix: what a path is compared as. */
function stripSuffix(value: string): string {
  return value.split('#')[0]?.split('?')[0]?.trim() ?? value
}

/**
 * The file a reference token names.
 *
 * A `@file` chip carries the token as the reader wrote it — `@"path with spaces/x.ts"`, `@a/b.ts#L4` —
 * so the marker, the quotes and any line suffix come off before it is compared with a stored path.
 *
 * @param text - the token text.
 * @returns the path it names.
 */
function pathOfReference(text: string): string {
  return stripSuffix(text.replace(/^@/, '').replace(/^"|"$/g, '').trim())
}

/**
 * Whether this text names a file, rather than a URL, an in-page anchor or a plain label.
 *
 * A shell tooltip lives in `title` too, so "the element has a title" is not enough: a URL scheme is not
 * a file (a Windows drive letter is), and a label with neither a separator nor an extension is a label.
 * This is a filter, not a decision — `isPending` is what decides — so it errs towards letting a press
 * through untouched rather than towards taking one over.
 *
 * @param value - the candidate text.
 * @returns whether it could name a file.
 */
function looksLikePath(value: string): boolean {
  if (value === '' || value.startsWith('#') || value.startsWith('?')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return false
  return /\.[A-Za-z0-9]{1,8}$/.test(value) || value.includes('/') || value.includes('\\')
}

/**
 * The path a press names, or undefined when it names no file.
 *
 * @param press - the element the reader pressed.
 * @returns the path, as the shell spelled it (the panel matches it against its own spelling).
 */
function pressPathOf(press: Element): string | undefined {
  const title = press.getAttribute('title')?.trim()
  if (title !== undefined) {
    const path = pathOfReference(title)
    if (looksLikePath(path)) return path
  }
  // A row can carry its path in a description instead of a `title`: 0.1.7's changed-files list points
  // `aria-describedby` at a visually hidden span whose text is the resolved absolute path — the row
  // itself says only "view the diff of <name>" in its `aria-label`. Read the shell's own pointer rather
  // than its copy, so a row in another language works the same.
  const describedBy = press.getAttribute('aria-describedby')
  if (describedBy !== null) {
    const path = press.ownerDocument.getElementById(describedBy)?.textContent?.trim() ?? ''
    if (looksLikePath(path)) return path
  }
  if (press instanceof HTMLAnchorElement) {
    const path = stripSuffix(press.getAttribute('href')?.trim() ?? '')
    if (looksLikePath(path)) return path
  }
  return undefined
}

/** The press `replayFilePress` is replaying, if any: that press is the shell's, not the menu's. */
let replaying: Element | null = null

/**
 * Press a file's own press again — the shell's open, run the only way this plugin can run it
 * faithfully, with the bridge standing down for that press (see the file's own doc).
 *
 * The menu's first row must open the file exactly the way the shell does, and what that is is the
 * shell's business, not this plugin's: pressing the same element again keeps every part of it —
 * the viewer it opens, the line a `#L24` suffix asked for, whatever a future shell adds there.
 *
 * @param path - the file the press names.
 * @returns whether an element naming it was found to press.
 */
export function replayFilePress(path: string): boolean {
  const press = [...document.querySelectorAll<HTMLElement>(PRESS_SELECTOR)]
    .find(candidate => pressPathOf(candidate) === path)
  if (press === undefined) return false
  replaying = press
  try {
    press.click()
  } finally {
    replaying = null
  }
  return true
}

/**
 * The session a press belongs to, read from the pressed element's OWN surface.
 *
 * Ancestors only, and the NEAREST ancestor that names a session wins — whichever spelling it uses:
 *
 *   `data-row-key="session:<id>"`  a session-LIST item, measured by this repo's e2e harness. Right for a
 *                                  press raised inside the sidebar, and NOT an ancestor of a transcript
 *                                  chip (measured on the live shell: exactly one such element in the whole
 *                                  document, and it does not contain the chip).
 *   `data-conversation-session`    the conversation BODY, measured on the live shell — this is the one that
 *                                  covers the reader's press, a chip inside a message.
 *   `data-session-id`              unmeasured alternative spelling, kept as a last resort.
 *
 * Walking the chain rather than asking three separate `closest` queries is what makes "nearest wins" true
 * across spellings: a chip inside a session row that ALSO nests a conversation body takes the nearer
 * body's session. A document-wide search is still deliberately NOT done — an identity hit may be a SIBLING,
 * an `href` or an `aria-controls`, and guessing which session a press belongs to would be worse than not
 * knowing: a wrong guess would ask a THIRD session to add the file, which this can never do.
 *
 * @param press - the element the press landed on.
 * @returns the session id, or undefined when no ancestor names one.
 */
export function sessionOfPress(press: Element): string | undefined {
  for (let node: Element | null = press; node !== null; node = node.parentElement) {
    const rowKey = node.getAttribute('data-row-key')
    if (rowKey?.startsWith('session:') === true) {
      const fromRow = rowKey.slice('session:'.length).trim()
      if (fromRow !== '') return fromRow
    }
    const fromConversation = node.getAttribute('data-conversation-session')?.trim()
    if (fromConversation !== undefined && fromConversation !== '') return fromConversation
    const fromAttr = node.getAttribute('data-session-id')?.trim()
    if (fromAttr !== undefined && fromAttr !== '') return fromAttr
  }
  return undefined
}

/**
 * Start routing the presses that would open a file in the shell's own viewer.
 *
 * @param bridge - the host's decision (is the file pending) and where to report a press that is.
 * @returns a cleanup that stops routing.
 */
export function startProducedChipMenu(bridge: ProducedChipBridge): () => void {
  const onClick = (event: MouseEvent): void => {
    // THE SETTING, FIRST: with the file menu switched off this plugin touches nothing at all — no path
    // lookup, no `preventDefault`, no menu — so DSH's own behaviour runs exactly as if the plugin were not
    // loaded. Read before every other guard because "off" has to mean off for every press shape, including
    // this plugin's own preview (where a relative link then navigates, which is the honest consequence).
    if (bridge.enabled !== undefined && !bridge.enabled()) return
    // A modified press is not this bridge's: it is a gesture the harness may give its own meaning,
    // and the plugin has no menu to offer it (see the file's own doc).
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest(OWN_SURFACE_SELECTOR) !== null) return
    if (target.closest(SHELL_PICKER_SELECTOR) !== null) return
    const press = target.closest(PRESS_SELECTOR)
    if (press === null || press === replaying) return
    const path = pressPathOf(press)
    if (path === undefined) return
    // EVERY matched press becomes the menu — a file-list row and a message's file link alike — and the
    // shell's own press is suppressed from here on. "Does the review list hold it" rides along as the
    // `held` label the menu's items read (see `ProducedChipMenuDetail.held`); it does not decide whether
    // this press is ours, which is `pressPathOf`'s filter's job alone.
    const held = bridge.isPending(path)
    // The review panel's press: the shell must not also act on it, or the reader would get both the
    // shell's open and the menu. Captured on the document so no handler between here and the press
    // sees it either.
    event.preventDefault()
    event.stopImmediatePropagation()
    const rect = press.getBoundingClientRect()
    const sessionId = sessionOfPress(press)
    bridge.onMenu({ path, x: rect.left, y: rect.bottom, held, ...(sessionId === undefined ? {} : { sessionId }) })
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}
