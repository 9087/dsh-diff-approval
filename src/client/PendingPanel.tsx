/** Sidebar-foot pending-edit review action and the split review panel it opens. */

import { Component, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { IconBrowseOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconPanelLeftOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, IconSettingsOutline16, Menu, Toast, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DiffApprovalBlockRange, DiffApprovalOpenAction, DiffApprovalRefreshOutcome, PendingFileDiff } from '../types.ts'
import type { PendingPanelFace } from './slots.ts'
import type { Translator } from './locales.ts'
import { PathPicker, pathPickerOpen } from './PathPicker.tsx'
import { PresentationMenu } from './presentation-menu.tsx'
import { CoverageControl, CoverageNotice, COVER_NOTICE_MS } from './coverage-control.tsx'
import { blockRangesOf, changeBlocksOf, computeIntraLineDiff, computeWholeFileDiff } from './whole-file-diff.ts'
import { renderMarkdownPreview } from './markdown-preview.ts'
import { resolvePreviewImages } from './markdown-images.ts'
import type { ChangeBlock, IntraRun, WholeFileDiffRow } from './whole-file-diff.ts'
import { computeSideBySideDiff, searchPairs } from './split-diff.ts'
import type { SplitPair, SplitSide } from './split-diff.ts'
import { HIGHLIGHT_LANGS, languageDisplayName } from './highlight.ts'
import type { HighlightSides } from './highlight.ts'
import { useWindowedHighlight } from './windowed-highlight.ts'
import type { LineRange, VisibleLines } from './windowed-highlight.ts'
import type { DockSnapshot } from './dock.tsx'
import type { HighlightSpan } from './highlight.ts'
import { langFromPath, suffixOfPath } from './lang.ts'
import { referenceLabelOf } from './reference.ts'
import { OPEN_FILE_EVENT } from './produced-diff.ts'
import type { DiffApprovalPresentation } from './settings.ts'
import { SHOW_PANEL_EVENT } from './dock.tsx'
import { confirmFileRemoveEnabled, COVER_CHANGED_EVENT, fileListFloat, includeUntrackedEnabled, keybindingOf, languageForSuffix, matchesShortcut, mdMaxWidth, mdPreviewEnabled, navLeadRows, panelCover, panelPresentation, pasteOnCopyEnabled, quickSummonKey, searchCaseSensitive, searchWholeWord, setFileListFloat, setLanguageForSuffix, setMdPreviewEnabled, setPanelCover, setPanelPresentation, setSearchCaseSensitive, setSearchWholeWord, setSplitMode, setWrapEnabled, splitMode, tabWidth, wrapEnabled, diffAddColor, diffDelColor, diffFontScale, diffLineHeight } from './settings.ts'
import type { DiffApprovalCover } from './settings.ts'
import { matchRangesOf } from './search.ts'
import type { SearchOptions } from './search.ts'
import css from './PendingPanel.module.css'

/**
 * How often the panel re-reads the pending list. An external plugin cannot
 * register on the host's forwarded-event allowlist, so polling is its change
 * feed; it runs while the action is mounted so the badge count stays current
 * even with the panel closed. The read is one small RPC per second.
 */
const POLL_INTERVAL_MS = 1000

/** Panel bottom offset when the composer cannot be measured, in px. */
const FALLBACK_BOTTOM_PX = 128
/** Gap kept between the composer's top edge and the panel bottom, in px. */
const COMPOSER_GAP_PX = 12
/** The coverage switch each chord toggles, in the order the popover lists them. */
const COVER_ACTIONS = [
  ['coverLeft', 'left'],
  ['coverTop', 'top'],
  ['coverRight', 'right'],
  ['coverComposer', 'composer'],
] as const satisfies readonly (readonly [string, keyof DiffApprovalCover])[]

/** Fixed window-edge inset the floating panel keeps on every side, mirroring
 *  `.panel`'s own left/right/top. */
const PANEL_INSET_PX = 8
/** The smallest floating panel worth drawing. A window that cannot hold the
 *  uncovered edges *and* a panel this big covers them instead — the edges are a
 *  preference, an invisible panel is a bug, and a phone-sized window is exactly
 *  the case where leaving a sidebar visible can squeeze the panel to nothing. */
const MIN_PANEL_WIDTH_PX = 240
const MIN_PANEL_HEIGHT_PX = 200

/**
 * The floating panel's four insets for the current coverage. An edge the panel
 * covers keeps the small window inset; one it does not cover starts past what the
 * app draws there. If the result would leave the panel smaller than
 * {@link MIN_PANEL_WIDTH_PX} / {@link MIN_PANEL_HEIGHT_PX}, the sides are covered
 * again rather than drawn as an invisible sliver.
 * @param cover - which edges the panel is covering.
 * @param sideInset - what the app occupies on each side (see {@link frameInsets}).
 * @param bottomPx - the composer offset used when the composer is not covered.
 * @param viewport - the window's size in px.
 * @returns the insets for the panel's style.
 */
function panelInsets(
  cover: DiffApprovalCover,
  sideInset: { top: number; left: number; right: number },
  bottomPx: number,
  viewport: { width: number; height: number },
): { top: number; left: number; right: number; bottom: number } {
  const side = (covered: boolean, value: number): number => covered ? PANEL_INSET_PX : value + PANEL_INSET_PX
  let left = side(cover.left, sideInset.left)
  let right = side(cover.right, sideInset.right)
  if (viewport.width - left - right < MIN_PANEL_WIDTH_PX) {
    left = PANEL_INSET_PX
    right = PANEL_INSET_PX
  }
  let top = cover.top ? PANEL_INSET_PX : sideInset.top
  let bottom = cover.composer ? PANEL_INSET_PX : bottomPx
  if (viewport.height - top - bottom < MIN_PANEL_HEIGHT_PX) {
    top = PANEL_INSET_PX
    bottom = PANEL_INSET_PX
  }
  return { top, left, right, bottom }
}
/** Narrowest docked panel that still fits the file list beside the detail. Below
 *  it the list folds into the floating card, exactly as it does in a narrow
 *  floating panel — a right-sidebar column is narrow even on a wide window, so the
 *  viewport width says nothing about it. */
const DOCK_TWO_COLUMN_MIN_PX = 520
/** The harness composer seat (conversation scroll body + seat div). */
const SCROLL_SELECTOR = '[data-conversation-scroll]'
const SEAT_SELECTOR = '[data-composer-seat]'
/** The chat composer's own editable box, where a closed panel hands the caret. */
const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

/**
 * Hand the caret back to the chat composer. Closing the review panel is a "done
 * reviewing, back to typing" move; a close the user made by clicking elsewhere is
 * the exception, and that path does not call this.
 */
function focusComposer(): void {
  document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus()
}
/** Seat height ui-conversation publishes for floating controls (its own seat observer). */
const COMPOSER_HEIGHT_VAR = '--dsh-composer-height'
/** Seat counts as docked when its bottom is this close to the window bottom. */
const DOCKED_TOLERANCE_PX = 48
/** File-list pane width bounds for the manual split drag, in px. */
const MIN_LIST_WIDTH_PX = 160
const MAX_LIST_WIDTH_PX = 560
/** Inset of the floating file-list card from the code scroll box, in px. */
const FLOAT_LIST_MARGIN_PX = 12

/** Normalize a path for comparison: forward slashes, no trailing slash. */
export function normalizeDiffPath(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '')
}

/** Whether a produced-file chip path and a pending file path refer to the same
 *  file, tolerant of separator style (\\ vs /) and of a workspace-relative vs
 *  absolute form. `chipPath` is typically the harness's workspace-relative
 *  forward-slash path; `filePath` is the host's absolute native-separator path.
 *  Matching is case-insensitive so a Windows drive/segment case difference does
 *  not miss the file the user clicked. */
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
  return file === rel || file.endsWith(`/${rel}`)
}
/** The diff view-mode toggle glyph: the whole file as one column of text lines
 *  (unified) or two side-by-side columns of text lines (split). Hand-drawn
 *  because the icon library has no single/double-column glyph. Rendered 1:1
 *  (viewBox matches the size) with integer bar geometry, so every thin line
 *  lands on whole pixels and stays crisp on any display scale. */
function ViewModeIcon({ split, size = 14 }: { split: boolean; size?: number }) {
  // VSCode Codicon "split-horizontal" (a rounded window split by a vertical rule
  // into two side-by-side panes) for the double-column (split) view; its
  // single-pane counterpart for the single-column (unified) view. Scaled from
  // the codicon 16px grid, so it matches the design those tools ship.
  const box = 'M12.5 1h-9A2.503 2.503 0 0 0 1 3.5v9C1 13.878 2.122 15 3.5 15h9c1.378 0 2.5-1.122 2.5-2.5v-9C15 2.122 13.878 1 12.5 1Z'
  const leftPane = 'M2 12.5v-9C2 2.673 2.673 2 3.5 2h4v12h-4c-.827 0-1.5-.673-1.5-1.5Z'
  const rightPane = 'm12 0c0 .827-.673 1.5-1.5 1.5h-4V2h4c.827 0 1.5.673 1.5 1.5z'
  const singlePane = 'M2 12.5v-9C2 2.673 2.673 2 3.5 2h9c.827 0 1.5.673 1.5 1.5v9c0 .827-.673 1.5-1.5 1.5h-9c-.827 0-1.5-.673-1.5-1.5Z'
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" d={split ? `${box}${leftPane}${rightPane}` : `${box}${singlePane}`} />
    </svg>
  )
}

/** Markdown source/preview toggle glyph: a document sheet whose interior shows
 *  source angle brackets when the diff is in source mode, and a heading bar with
 *  text lines when the rendered preview is shown. Custom SVG (the icon library
 *  has no source/rendered pair), following ViewModeIcon's 14-grid so it reads
 *  crisp at 14px. */
function MarkdownModeIcon({ preview, size = 14 }: { preview: boolean; size?: number }) {
  // Fill the same 12×12 footprint as ViewModeIcon (content x=1..13, y=1..13) so
  // this sparse outline glyph does not read smaller than the neighboring
  // source/split icons; the sheet is drawn on half-pixel edges to stay crisp.
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="1.25" stroke="currentColor" strokeWidth="1" />
      {preview
        ? (
          <>
            <rect x="3.5" y="3.5" width="7" height="1.5" fill="currentColor" />
            <rect x="3.5" y="6.5" width="7" height="1" fill="currentColor" />
            <rect x="3.5" y="8.5" width="5" height="1" fill="currentColor" />
          </>
        )
        : (
          <>
            <path d="M5.2 4.2 L3.2 7 L5.2 9.8" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <path d="M8.8 4.2 L10.8 7 L8.8 9.8" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </>
        )}
    </svg>
  )
}
/** Total width of the two line-number gutters, subtracted from the code width
 * when measuring wrapped line heights. */
const WRAP_GUTTERS_PX = 88
/** The dsh shell's sidebar auto-collapse breakpoint (ui-layout columns.ts):
 * below it the sidebar auto-collapses, and the file list floats on the same
 * breakpoint so the two stay consistent. */
export const SIDEBAR_AUTO_COLLAPSE_PX = 1024

/** A shared canvas for measuring wrapped line heights (CPU-only, no DOM reflow). */
let measureCanvas: CanvasRenderingContext2D | undefined

/**
 * Compute a diff line's visual sub-lines for soft wrap the way VSCode does it:
 * a Unicode line-break model — break at whitespace and between any two CJK
 * characters (Chinese han, Japanese kana, fullwidth forms), keep Latin and
 * numeric words atomic (a word longer than a whole line falls back to a
 * character split), and honor East Asian kinsoku so an opening bracket never
 * ends a line and a closing/terminal punctuation never starts one. Tabs
 * advance to the tab stop derived from the computed `tab-size`. This *is* the
 * wrap decision — the caller renders the returned sub-lines itself (never
 * `white-space: pre-wrap`), so the row height equals `subLines.length * 22`
 * by construction and can never drift from the browser re-wrapping.
 * The concatenation equals the input (no characters are dropped), so
 * highlight runs can be clipped back onto sub-lines by character offset.
 * @param text - the line's content (no trailing newline).
 * @param widthPx - the available code width, in px.
 * @param measure - `ctx.measureText` bound to the code font.
 * @param tabPx - the width of one tab stop, in px.
 */

const cpOf = (c: string): number => c.codePointAt(0) ?? 0

/** Space, tab, or the ideographic space — whitespace is a break opportunity. */
function isSpaceCode(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x3000
}

/**
 * CJK characters — Chinese han, Japanese kana, CJK fullwidth forms. Each is an
 * independent break opportunity (wrap between any two), unlike Latin words.
 */
function isCJKCode(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xffef)
    || (cp >= 0x20000 && cp <= 0x2fa1f)
}

/** Opening bracket/quote — kinsoku forbids ending a line right after it. */
function isOpenPunctCode(cp: number): boolean {
  return cp === 0x28 || cp === 0x5b || cp === 0x7b
    || cp === 0x3008 || cp === 0x300a || cp === 0x300c || cp === 0x300e
    || cp === 0x3010 || cp === 0x3014 || cp === 0x3016 || cp === 0x3018
    || cp === 0xff08 || cp === 0xff3b || cp === 0xff5b
    || cp === 0x2018 || cp === 0x201c
}

/** Closing bracket/quote or terminal punctuation — kinsoku forbids starting a line with it. */
function isClosePunctCode(cp: number): boolean {
  return cp === 0x29 || cp === 0x5d || cp === 0x7d
    || cp === 0x3001 || cp === 0x3002
    || cp === 0x3009 || cp === 0x300b || cp === 0x300d || cp === 0x300f
    || cp === 0x3011 || cp === 0x3015 || cp === 0x3017 || cp === 0x3019
    || cp === 0xff09 || cp === 0xff3d || cp === 0xff5d
    || cp === 0xff0c || cp === 0xff0e || cp === 0xff01 || cp === 0xff1f
    || cp === 0xff1b || cp === 0xff1a
    || cp === 0x2019 || cp === 0x201d
    || cp === 0x2026 || cp === 0x2014
}

/**
 * Whether a line break is allowed between characters `a` (ending the current
 * line) and `b` (starting the next). Whitespace and any CJK/serial-boundary
 * admit a break; a full Latin/numeric word does not. Kinsoku forbids a break
 * after an opening punct or before a closing/terminal one.
 */
function breakValid(a: string, b: string): boolean {
  const ac = cpOf(a)
  const bc = cpOf(b)
  if (isOpenPunctCode(ac)) return false
  if (isClosePunctCode(bc)) return false
  if (isSpaceCode(ac)) return true
  if (isSpaceCode(bc)) return false
  if (isCJKCode(ac) || isCJKCode(bc)) return true
  return false
}

/**
 * The largest index in `chars` at which a break may occur so the next line can
 * begin there with the overflowing character `next` (the break may be at the
 * line's end, `chars.length`). -1 when no position admits a break.
 */
function lastBreakIndex(chars: readonly string[], next: string): number {
  for (let k = chars.length; k >= 1; k--) {
    const a = chars[k - 1]!
    const b = k < chars.length ? chars[k]! : next
    if (breakValid(a, b)) return k
  }
  return -1
}

/** Width of a code-point array, advancing tabs to the next stop. */
function charsWidth(chars: readonly string[], measure: (t: string) => number, tabPx: number): number {
  let w = 0
  for (const c of chars) {
    if (c === '\t') w += tabPx - (w % tabPx)
    else w += measure(c)
  }
  return w
}

export function wrapInto(text: string, widthPx: number, measure: (t: string) => number, tabPx: number): string[] {
  if (widthPx <= 0) return [text]
  const codepoints = Array.from(text)
  if (codepoints.length === 0) return ['']
  const out: string[] = []
  let line: string[] = []
  let lineW = 0
  for (const ch of codepoints) {
    const adv = ch === '\t' ? tabPx - (lineW % tabPx) : measure(ch)
    if (line.length > 0 && lineW + adv > widthPx) {
      if (isSpaceCode(cpOf(ch))) {
        // A space is the break point itself: hang it trailing on the current
        // line and start a fresh line after it, so the wrap never opens a line
        // with a space (or with a lone space-only line).
        line.push(ch)
        lineW += adv
        out.push(line.join(''))
        line = []
        lineW = 0
        continue
      }
      const k = lastBreakIndex(line, ch)
      if (k >= 1) {
        out.push(line.slice(0, k).join(''))
        line = line.slice(k)
        lineW = charsWidth(line, measure, tabPx)
      } else {
        // No break opportunity (an overlong Latin word): split at the char.
        out.push(line.join(''))
        line = []
        lineW = 0
      }
    }
    line.push(ch)
    lineW += ch === '\t' ? tabPx - (lineW % tabPx) : measure(ch)
  }
  out.push(line.join(''))
  // A hanging trailing space emptied the last line; drop the phantom blank.
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

/** Resolve the code cell's computed font for canvas measurement. */
function codeFontOf(): string | undefined {
  const code = document.querySelector<HTMLElement>('[data-diff-code]')
  if (code === null) return undefined
  const computed = getComputedStyle(code)
  // Prefer the resolved shorthand; fall back to the individual properties
  // (canvas `font` accepts no line-height).
  return computed.font || `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
}

/** Create a measurer bound to `font`; falls back to a rough char estimate. */
function makeMeasurer(font: string | undefined): ((text: string) => number) | undefined {
  if (typeof document === 'undefined') return undefined
  try {
    if (measureCanvas === undefined) measureCanvas = document.createElement('canvas').getContext('2d') ?? undefined
  } catch {
    return undefined
  }
  const ctx = measureCanvas
  if (ctx === undefined) return undefined
  if (font !== undefined) ctx.font = font
  return text => ctx.measureText(text).width
}
/** The overview ruler's width in px (mirrors `.overviewRuler`). The flash is
 * kept off it even when the scroller has no vertical scrollbar. */
const OVERVIEW_RULER_WIDTH_PX = 4
/** Rows rendered beyond the visible window in each direction. */
const OVERSCAN_ROWS = 8
/** Height of the floating per-block Keep/Revert frame in px: 26px actions +
 * 5px frame padding on each side + 1px border on each side, plus a little
 * breathing room so the bottom padding never sits flush against it. */
const BLOCK_ACTIONS_FRAME_PX = 40
/** How far a floating block-action frame stays inside the surface it is anchored
 *  to (the content's right edge in the Markdown preview, the pane's in the code
 *  view). */
const FRAME_INSET_PX = 8

/** One Markdown-preview frame's measured placement. `contentBottom` is the block
 *  group's bottom edge in content coordinates (scroll independent), `maxTop` the
 *  lowest top the frame may take inside the pane, `right` its inset from the
 *  pane's right edge. */
interface PreviewFramePlacement {
  contentBottom: number
  maxTop: number
  right: number
}

/** One Markdown-preview flash box's measured placement: the jumped-to block's
 *  rendered extent in content coordinates (scroll independent), plus its insets
 *  from the pane's edges — the same shape the code view derives from row
 *  offsets, measured from the rendered block instead. */
interface PreviewFlashPlacement {
  contentTop: number
  contentBottom: number
  left: number
  right: number
}

/** Full panel props composed by the sidebar footer-action slot. */
export type PendingPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<PendingPanelFace> & PropsLocale<'diff-approval'>
  & PendingPanelDockProps

/** How the panel is hosted when it is not the footer's floating overlay: the
 *  right sidebar's tab renders it docked, filling the tab and portaling its
 *  content into `dockHost` (the element the tab body owns). */
export interface PendingPanelDockProps {
  /** Docked in the sidebar tab: no badge, no overlay positioning, no composer
   *  offset, and no header of its own — the tab's chip carries the title, the
   *  mode switch, and the kit's close button. */
  docked?: boolean
  /** The element the docked panel portals its content into. */
  dockHost?: HTMLElement
}

/** A last-block keep/revert awaiting the user's remove-or-keep choice; the choice
 *  rides the same block RPC as its `removeWhenResolved` flag. */
interface ResolvedBlockPrompt {
  action: 'keep' | 'revert'
  sessionId: SessionId
  id: string
  block: DiffApprovalBlockRange
}

/** A whole-file keep/revert awaiting the user's remove-or-keep choice; the
 *  choice rides the same keep/revert RPC as its `keepListed` flag. */
interface FileActionPrompt {
  action: 'keep' | 'revert'
  sessionId: SessionId
  id: string
}

/** The trailing file-name segment of a path, used for row display. */
function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Order two paths by their displayed file name (dictionary, case-insensitive),
 * breaking a same-name tie on the full path so files in different directories
 * keep a stable order. The file list shows only the file name, so the panel
 * sorts by it here — the host's list order (oldest capture first) is not a
 * display guarantee.
 */
function compareFileNames(a: string, b: string): number {
  const na = basenameOf(a).toLowerCase()
  const nb = basenameOf(b).toLowerCase()
  if (na !== nb) return na < nb ? -1 : 1
  const pa = a.toLowerCase()
  const pb = b.toLowerCase()
  if (pa !== pb) return pa < pb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** A tiny React error boundary for the best-effort Markdown preview. DSH's
 *  `MarkdownText` is built for the conversation message stream; if it throws in
 *  this standalone panel context, degrade to a note rather than let the error
 *  unmount the whole panel (which reads as "the plugin disappeared"). */
class MarkdownPreviewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(): void { /* best-effort preview: swallow the render error. */ }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * Open the DSH settings dialog and switch to this plugin's section. The
 * settings shell keeps its open state and the active section id as
 * component-local viewing state with no cross-plugin service, so the dialog
 * is opened by clicking the sidebar's settings trigger and then the nav cell
 * for this section. `element.click()` still fires React's delegated click
 * handlers, reaching the same state transitions a user gesture would.
 * @param sectionLabel - the nav label of this plugin's settings section.
 */
export function openSettingsSection(sectionLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (trigger === null) return
  trigger.click()
  // Let the shell mount the modal before driving its nav rail.
  requestAnimationFrame(() => {
    const cell = Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === sectionLabel)
    cell?.click()
  })
}

/** One file row in the left list pane. */
interface PendingFileRowProps {
  file: PendingFileDiff
  selected: boolean
  /** The last keep/revert failure for this file, shown as an inline tag. */
  failedMessage?: string | undefined
  t: Translator
  onSelect: (id: string) => void
}

/**
 * Search narrowing glyphs, taken from VS Code's Codicons so the two find-widget
 * toggles read exactly as they do in that editor: `case-sensitive` (an upper- and
 * lower-case letter pair) and `whole-word` (the same letter pair over a bar that
 * marks the word boundary). Inline SVG because the icon library ships neither.
 * @param props.kind - which glyph to draw.
 * @returns the 16px-grid glyph.
 */
function SearchOptionIcon({ kind }: { kind: 'case' | 'word' }) {
  const upperA = 'M4.02602 3.34176C4.16218 2.93404 4.83818 2.93398 4.97426 3.34176L6.97426 9.34274C6.97526 9.34674 6.97817 9.35544 6.97817 9.35544L7.97426 12.3427C8.06126 12.6047 7.91984 12.8875 7.65786 12.9756C7.60486 12.9926 7.55165 13.0009 7.49965 13.0009C7.29082 13.0008 7.09602 12.868 7.02602 12.6591L6.14028 10.0009H2.86L1.97426 12.6591C1.88728 12.919 1.60634 13.0634 1.34243 12.9746C1.08043 12.8866 0.93902 12.6038 1.02602 12.3418L2.02211 9.35544C2.02311 9.35144 2.02602 9.34274 2.02602 9.34274L4.02602 3.34176ZM3.19399 8.99997H5.80629L4.49965 5.08102L3.19399 8.99997Z'
  const lowerA = 'M11.8581 6.66794C13.165 6.73296 13.9427 7.48427 13.9967 8.69626L13.9997 8.83297V12.5078C13.9957 12.7568 13.809 12.9621 13.568 12.9951L13.4997 13C13.2469 12.9998 13.0376 12.8121 13.0045 12.5683L12.9997 12.5V12.4297C12.3407 12.8066 11.7316 13 11.1666 13C9.94081 12.9998 8.99965 12.1369 8.99965 10.833C8.99967 9.68299 9.79211 8.82889 11.1061 8.66989C11.7279 8.59493 12.3589 8.64164 12.9987 8.80954C12.9915 8.07194 12.6279 7.70704 11.8082 7.66598C11.1672 7.63398 10.7158 7.72415 10.4518 7.90915C10.2258 8.06799 9.91347 8.01301 9.75551 7.78708C9.59671 7.56115 9.65178 7.24878 9.87758 7.09079C10.3165 6.78283 10.9138 6.64715 11.6666 6.6611L11.8581 6.66794ZM12.7965 9.8154C12.2587 9.66749 11.7361 9.62551 11.2262 9.68747C10.4042 9.78747 9.99868 10.2244 9.99868 10.8574C9.99884 11.5881 10.474 12.0242 11.1657 12.0244C11.6196 12.0244 12.1777 11.8137 12.8336 11.3818L12.9987 11.2695V9.87594L12.7965 9.8154Z'
  const wordA = 'M4.8584 5.6709C6.16516 5.73603 6.94308 6.48734 6.99707 7.69922L7 7.83594V11.5107C6.996 11.7596 6.80919 11.9649 6.56836 11.998L6.5 12.0029C6.24709 12.0029 6.038 11.8152 6.00488 11.5713L6 11.5029V11.4326C5.341 11.8096 4.73199 12.0029 4.16699 12.0029C2.941 12.0029 2 11.1399 2 9.83594C2.00003 8.68597 2.79247 7.83185 4.10645 7.67285C4.7283 7.59793 5.35918 7.64552 5.99902 7.81348C5.99202 7.07548 5.62762 6.70995 4.80762 6.66895C4.16686 6.637 3.7161 6.72717 3.45215 6.91211C3.22615 7.07111 2.91386 7.01604 2.75586 6.79004C2.5969 6.56404 2.65194 6.25174 2.87793 6.09375C3.31692 5.78579 3.91404 5.65006 4.66699 5.66406L4.8584 5.6709ZM5.79688 8.81836C5.25888 8.67037 4.73558 8.62843 4.22559 8.69043C3.40389 8.79054 2.99902 9.22747 2.99902 9.86035C2.99917 10.5911 3.47413 11.0273 4.16602 11.0273C4.62001 11.0273 5.17799 10.8168 5.83398 10.3848L5.99902 10.2725V8.87891L5.79688 8.81836Z'
  const wordB = 'M9.55078 2.00586C9.78578 2.02986 9.97307 2.21715 9.99707 2.45215C10 2.46907 10 2.48601 10 2.50293V6.60254C10.418 6.22566 10.9371 6.00293 11.5 6.00293C12.881 6.00293 14 7.34596 14 9.00293C14 10.6599 12.881 12.0029 11.5 12.0029C10.9371 12.0029 10.418 11.7802 10 11.4033V11.5029C10 11.7619 9.80278 11.974 9.55078 12C9.53385 12.003 9.51693 12.0029 9.5 12.0029C9.224 12.0029 9 11.7789 9 11.5029V2.50293C9 2.486 9.00095 2.46907 9.00293 2.45215C9.02793 2.20015 9.241 2.00293 9.5 2.00293C9.51692 2.00293 9.53386 2.00388 9.55078 2.00586ZM11.4355 7.00391C11.0307 7.03208 10.5769 7.31545 10.29 7.82227C10.1232 8.12611 10.018 8.49479 10.002 8.89453C9.99995 8.92952 10 8.96597 10 9.00195C10 9.03795 10.001 9.07438 10.002 9.10938C10.018 9.50814 10.1222 9.87582 10.2891 10.1797C10.576 10.6875 11.0307 10.9728 11.4355 11C11.4565 11.002 11.478 11.002 11.5 11.002C11.522 11.002 11.5435 11.001 11.5645 11C11.9693 10.9728 12.424 10.6875 12.7109 10.1797C12.8778 9.87582 12.982 9.50814 12.998 9.10938C13 9.07438 13 9.03795 13 9.00195C13 8.96597 12.999 8.92952 12.998 8.89453C12.982 8.49479 12.8768 8.12611 12.71 7.82227C12.4231 7.31545 11.9693 7.03109 11.5645 7.00391C11.5435 7.00191 11.522 7.00195 11.5 7.00195C11.478 7.00195 11.4565 7.00291 11.4355 7.00391Z'
  const wordBar = 'M15.5 12.5C15.776 12.5 16 12.724 16 13V13.5C16 14.327 15.327 15 14.5 15H1.5C0.673 15 0 14.327 0 13.5V13C0 12.724 0.224 12.5 0.5 12.5C0.776 12.5 1 12.724 1 13V13.5C1 13.775 1.224 14 1.5 14H14.5C14.776 14 15 13.775 15 13.5V13C15 12.724 15.224 12.5 15.5 12.5Z'
  const d = kind === 'case' ? `${upperA}${lowerA}` : `${wordA}${wordB}${wordBar}`
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={d} />
    </svg>
  )
}

/**
 * The app's view tabs above the conversation (对话 / 轨迹 and the like). A panel
 * that leaves the header visible still covers these: the session's title row is
 * the part worth keeping, and the tab strip sits directly under it, above the
 * conversation body — a sibling of the scroller's own parent. Nothing else's
 * tablists count: the right sidebar's own tab strip, and any inside this panel,
 * are excluded.
 * @param scroller - the conversation scroll body.
 * @returns the strip's top edge in viewport px, or undefined when there is none.
 */
function viewTabsTop(scroller: Element): number | undefined {
  for (const strip of document.querySelectorAll('[role="tablist"]')) {
    if (strip.closest('[data-sidebar-right-panel]') !== null) continue
    if (strip.closest('[data-diff-approval-panel]') !== null) continue
    if ((strip.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) continue
    const rect = strip.getBoundingClientRect()
    if (rect.height > 0) return rect.top
  }
  return undefined
}

/**
 * How much of the window the app itself occupies on each side of the conversation
 * — how far the floating panel has to start from an edge to leave that part
 * visible.
 *
 * The centre column's own box is the direct answer: the header above it, an
 * expanded sidebar, a collapsed rail, and a right panel hanging over the centre
 * all sit outside it. The frame's grid tracks fill in the rest — they name the
 * sidebar columns even before a conversation is mounted, and a right sidebar shown
 * without a track of its own draws over the centre, so its own panel is measured
 * instead. Relying on the frame's *resizers* alone was a bug: a collapsed sidebar
 * renders no resizer, so a collapsed rail read as "nothing on that side".
 * @returns each side's occupied size, 0 when that side shows nothing.
 */
export function frameInsets(): { top: number; bottom: number; left: number; right: number } {
  if (typeof document === 'undefined') return { top: 0, bottom: 0, left: 0, right: 0 }
  const viewport = window.innerWidth
  const viewportHeight = window.innerHeight
  let top = 0
  let bottom = 0
  let left = 0
  let right = 0
  const scroller = document.querySelector('[data-conversation-scroll]')
  const centre = scroller?.getBoundingClientRect()
  if (scroller != null && centre !== undefined && centre.width > 0 && centre.height > 0) {
    // The title row stays visible; the view tabs under it do not, so the panel's
    // top edge sits at the strip when there is one.
    top = Math.max(top, viewTabsTop(scroller) ?? centre.top)
    bottom = Math.max(bottom, viewportHeight - centre.bottom)
    left = Math.max(left, centre.left)
    right = Math.max(right, viewport - centre.right)
  }
  const frame = document.querySelector('[data-side="sidebar"],[data-side="rightbar"]')?.parentElement
    ?? document.querySelector('[data-sidebar-collapsed],[data-rightbar-collapsed],[data-rightbar-fullscreen]')
  const frameRect = frame?.getBoundingClientRect()
  if (frame != null && frameRect !== undefined) {
    const tracks = getComputedStyle(frame).gridTemplateColumns
      .split(' ')
      .map(part => Number.parseFloat(part))
      .filter(Number.isFinite)
    if (tracks.length > 0) {
      left = Math.max(left, frameRect.left + (tracks[0] ?? 0))
      right = Math.max(right, tracks.length > 1 ? (tracks[tracks.length - 1] ?? 0) : 0)
    }
  }
  const rightPanel = document.querySelector('[data-sidebar-right-panel]')?.getBoundingClientRect()
  if (rightPanel !== undefined && rightPanel.width > 0) right = Math.max(right, viewport - rightPanel.left)
  return { top, bottom, left, right }
}

/** The right detail pane for one selected file: actions plus the merged diff. */
interface PendingDiffProps {  file: PendingFileDiff
  busy: boolean
  /** The current workspace root, for workspace-relative copied references. */
  workspacePath?: string | undefined
  /** Bumped by the panel when the already-open file is clicked again: jumps
   * to the next change block. */
  jumpSignal: number
  /** Bumped when an undo/redo touched the currently open file: re-select the
   * undone diff (flash its first change block). */
  undoFlash: number
  /** The last keep/revert failure for this file, shown as an inline banner. */
  failedMessage?: string | undefined
  /** Paste a copied reference into the session's chat input and focus it. */
  onPasteReference: (sessionId: SessionId, reference: string) => void
  /** Show a transient toast (used when a reference is copied to the clipboard). */
  onToast: (text: string) => void
  t: Translator
  onKeep: (sessionId: SessionId, id: string) => Promise<void>
  onRevert: (sessionId: SessionId, id: string) => Promise<void>
  /** Replace this file's diff with its current local VCS change. */
  onRefreshVcs: (file: PendingFileDiff) => void
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Inline one workspace image as a base64 data URI for the Markdown preview. */
  onPreviewImage: (sessionId: SessionId, path: string) => Promise<string | undefined>
}

/** The diff body's row class per line kind. */
const ROW_CLASS = {
  context: css.context,
  del: css.del,
  add: css.add,
} as const

/** Empty failure map reused as the snapshot's canonical absent value. */
const EMPTY_FAILED_MAP: ReadonlyMap<string, string> = new Map()

/**
 * Clip highlight runs (which partition one whole line) to the character range
 * `[start, end)` of that line, producing the sub-line's highlighted content.
 */
function clipRuns(runs: readonly HighlightSpan[], start: number, end: number): ReactNode {
  const nodes: ReactNode[] = []
  let pos = 0
  for (const run of runs) {
    const runStart = pos
    const runEnd = pos + run.text.length
    pos = runEnd
    if (runEnd <= start || runStart >= end) continue
    const text = run.text.slice(Math.max(runStart, start) - runStart, Math.min(runEnd, end) - runStart)
    if (text.length === 0) continue
    nodes.push(<span key={nodes.length} style={run.style}>{text}</span>)
  }
  return nodes.length === 0 ? '\u00a0' : nodes
}

/** Chip styling for each intra-line run: removed chars and added chars stand out. */
const INTRA_CLASS: Record<IntraRun['kind'], string | undefined> = {
  same: undefined,
  del: css.intraDel,
  add: css.intraAdd,
}

/** Clip intra-line runs to a character range, renumbering each cut run. */
function clipIntra(intra: readonly IntraRun[], start: number, end: number): IntraRun[] {
  const out: IntraRun[] = []
  let pos = 0
  for (const run of intra) {
    const runStart = pos
    const runEnd = pos + run.text.length
    pos = runEnd
    if (runEnd <= start || runStart >= end) continue
    const text = run.text.slice(Math.max(runStart, start) - runStart, Math.min(runEnd, end) - runStart)
    if (text.length === 0) continue
    out.push({ text, kind: run.kind })
  }
  return out
}

/**
 * Render a character range as intra-line runs, with the syntax color clipped
 * back onto each run. Context (`same`) runs show no draw; removed/added runs
 * carry the chip draw. `intra` must cover `[start, end)` — it is clipped and
 * reassembled per run, so the returned nodes concatenate to that range.
 * @param runs - the syntax highlight for the whole line, or undefined.
 * @param intra - the intra-line runs for the whole line.
 * @param start - the range start (character offset in the line).
 * @param end - the range end (exclusive).
 * @returns the merged spans for the range.
 */
function renderIntra(
  runs: readonly HighlightSpan[] | undefined,
  intra: readonly IntraRun[],
  start: number,
  end: number,
): ReactNode {
  const clipped = clipIntra(intra, start, end)
  let cursor = start
  return clipped.map((run, i) => {
    const runStart = cursor
    const runEnd = runStart + run.text.length
    cursor = runEnd
    const syntax = runs !== undefined && runs.length > 0
      ? clipRuns(runs, runStart, runEnd)
      : run.text
    return <span key={i} className={INTRA_CLASS[run.kind]}>{syntax}</span>
  })
}

/** Render `text[segStart, segEnd)` with every `query` match wrapped in a search
 *  highlight, keeping the syntax highlight and intra-line chips on the non-match
 *  parts. When no match is present it renders exactly as before (syntax / intra /
 *  plain). `segStart`/`segEnd` let the caller render a wrapped sub-line range. */
function textWithSearch(
  text: string,
  runs: readonly HighlightSpan[] | undefined,
  intra: IntraRun[] | undefined,
  options: SearchOptions,
  query: string,
  segStart = 0,
  segEnd = text.length,
  current = false,
): ReactNode {
  const segText = text.slice(segStart, segEnd)
  const ranges = matchRangesOf(segText, query, options)
  if (ranges.length === 0) {
    return intra !== undefined && intra.length > 0
      ? renderIntra(runs, intra, segStart, segEnd)
      : runs !== undefined && runs.length > 0
        ? clipRuns(runs, segStart, segEnd)
        : (segText === '' ? '\u00a0' : segText)
  }
  const nodes: ReactNode[] = []
  const push = (absStart: number, absEnd: number, isMatch: boolean): void => {
    if (isMatch) {
      nodes.push(
        <span
          key={nodes.length}
          className={current ? css.searchMatchCurrent : css.searchMatch}
          data-diff-search-match={current ? 'current' : 'hit'}
        >
          {text.slice(absStart, absEnd)}
        </span>,
      )
      return
    }
    if (intra !== undefined && intra.length > 0) {
      nodes.push(<span key={nodes.length}>{renderIntra(runs, intra, absStart, absEnd)}</span>)
    } else if (runs !== undefined && runs.length > 0) {
      nodes.push(<span key={nodes.length}>{clipRuns(runs, absStart, absEnd)}</span>)
    } else {
      nodes.push(<span key={nodes.length}>{text.slice(absStart, absEnd)}</span>)
    }
  }
  let cursor = segStart
  for (const [s, e] of ranges) {
    const absS = segStart + s
    const absE = segStart + e
    if (absS > cursor) push(cursor, absS, false)
    push(absS, absE, true)
    cursor = absE
  }
  if (cursor < segEnd) push(cursor, segEnd, false)
  return nodes
}

/** Arrow keys render as arrows in a tooltip hint (`Ctrl+↑`, not `Ctrl+ArrowUp`). */
const CHORD_KEY_GLYPHS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/**
 * One stored chord as a hint renders it: modifiers as written, arrow keys as
 * glyphs (`Ctrl+ArrowUp` → `Ctrl+↑`).
 * @param chord - the stored chord.
 * @returns the hint text.
 */
function chordHint(chord: string): string {
  return chord.split('+').map(part => CHORD_KEY_GLYPHS[part] ?? part).join('+')
}

/**
 * One action's chord as a hint. Every place a chord is shown reads it here, so a
 * rebind in Settings shows up everywhere it is advertised.
 * @param action - the keybinding action id (see `DEFAULT_KEYBINDINGS`).
 * @returns the hint text; `''` when the action has no chord at all.
 */
function chordLabel(action: string): string {
  return chordHint(keybindingOf(action))
}

/**
 * A tooltip label with the action's configured chord appended. The hint states
 * the binding the user actually has — including one rebound in Settings — rather
 * than a default baked into the label.
 * @param label - the translated action label.
 * @param action - the keybinding action id (see `DEFAULT_KEYBINDINGS`).
 * @returns the label, with ` (chord)` appended when one is configured.
 */
function withChord(label: string, action: string): string {
  const chord = chordLabel(action)
  return chord === '' ? label : `${label} (${chord})`
}

/**
 * The close button's tooltip: the panel closes with Escape and with the
 * quick-summon chord, so the hint names both — and names the chord as the user
 * has it bound, not a default baked into the label. A chord the user unbound
 * leaves Escape as the only way, so the hint says just that.
 * @param t - the panel's translator.
 * @returns the label with the ways out appended.
 */
function closeHint(t: Translator): string {
  const hint = chordHint(quickSummonKey())
  return hint === '' ? t('action.closeHintEsc') : t('action.closeHint', { chord: hint })
}

/**
 * The footer entry's tooltip: what the button opens, and the chord that does the
 * same from the keyboard.
 * @param t - the panel's translator.
 * @returns the label with the quick-summon chord appended.
 */
function summonHint(t: Translator): string {
  const hint = chordHint(quickSummonKey())
  return hint === '' ? t('panel.aria') : t('action.summonHint', { chord: hint })
}

/**
 * Whether a key event's target is one of the panel's search query boxes. The
 * bar's own chords (step, narrow) are scoped this way: the caret has to be in
 * the box, so an open bar is not enough — the same chord must stay free for
 * whatever else happens to have focus (the chat composer above all), and a mouse
 * click on a bar button hands the focus straight back to the box.
 * @param event - the keydown event.
 * @returns whether the event came from a search query box.
 */
function isSearchInputEvent(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof HTMLInputElement && target.hasAttribute('data-diff-search-input')
}

/**
 * Whether a key event came from inside the plugin's own panel. Esc is split along
 * that line: a press inside the panel is the panel's to dismiss (its search bar
 * first, otherwise the panel itself), while anything outside it — the chat
 * composer above all — dismisses the panel and keeps its own Esc besides.
 * @param event - the keydown event.
 * @returns whether the event came from inside the panel.
 */
function isInPanelEvent(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof Element && target.closest('[data-diff-approval-panel]') !== null
}

/**
 * Whether a key event came from a text field that owns its own keys (`Esc`,
 * cursor moves). The chat composer is the one that matters: the panel leaves it
 * alone even while its own search bar is open.
 * @param event - the keydown event.
 * @returns whether the event came from a text field.
 */
function isTextFieldEvent(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null
}

/**
 * Whether a key event came from the chat composer. The coverage chords fire
 * there — the user is usually typing when the panel's edges need rearranging —
 * while every other text field (this panel's own search box, the add-path
 * dialog's input) keeps its Ctrl+Shift+Arrow for word-wise selection.
 * @param event - the keydown event.
 * @returns whether the event came from the composer.
 */
function isComposerEvent(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof Element && target.closest('[data-composer-input], [data-composer-card]') !== null
}

/**
 * The in-file search's narrowing toggles. The persisted preference is the
 * source of truth, so the choice survives a reopen and the two views cannot
 * disagree: each bar owns one of these, and it re-reads the stored flags with
 * {@link sync} whenever its bar opens. The options object is memoized so the
 * memoized rows only re-render when a toggle changes.
 * @returns the options, their current values, the two toggles, and the re-read.
 */
function useSearchOptions(): {
  options: SearchOptions
  caseSensitive: boolean
  wholeWord: boolean
  toggleCase: () => void
  toggleWord: () => void
  /** Re-read both persisted flags, so a bar opens on the stored setting. */
  sync: () => void
} {
  const [caseSensitive, setCase] = useState(searchCaseSensitive)
  const [wholeWord, setWord] = useState(searchWholeWord)
  const options = useMemo<SearchOptions>(() => ({ caseSensitive, wholeWord }), [caseSensitive, wholeWord])
  // Read the persisted value rather than flipping inside a state updater: an
  // updater must stay pure, and the stored flag is this state's source.
  const toggleCase = useCallback(() => {
    const next = !searchCaseSensitive()
    setSearchCaseSensitive(next)
    setCase(next)
  }, [])
  const toggleWord = useCallback(() => {
    const next = !searchWholeWord()
    setSearchWholeWord(next)
    setWord(next)
  }, [])
  const sync = useCallback(() => {
    setCase(searchCaseSensitive())
    setWord(searchWholeWord())
  }, [])
  return { options, caseSensitive, wholeWord, toggleCase, toggleWord, sync }
}

/**
 * One rendered diff row, memoized so a poll or an unrelated state change
 * does not re-render rows whose content, highlight, and focus are unchanged.
 * With auto-wrap on, `wrappedLines` carries the row's visual sub-lines and the
 * code cell renders each at a fixed 22px (never `pre-wrap`), so the row height
 * is `wrappedLines.length * 22` by construction.
 */
const DiffRow = memo(function DiffRow(props: {
  index: number
  row: WholeFileDiffRow
  runs: HighlightSides | undefined
  focused: boolean
  /** Whether this row contains a search hit, and if so whether it is current. */
  searchHit: boolean
  searchCurrent: boolean
  /** The active search query, used to highlight the matched substrings. */
  searchQuery: string
  /** How that query is matched (case, whole word). */
  searchOptions: SearchOptions
  onRowHover: (index: number) => void
  /** Visual sub-lines when auto-wrap is on, else undefined (single line). */
  wrappedLines: string[] | undefined
}) {
  const { index, row, runs, focused, searchHit, searchCurrent, searchQuery, searchOptions, onRowHover, wrappedLines } = props
  const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine
  const sideRuns = row.kind === 'del' ? runs?.oldRuns : runs?.newRuns
  const lineRuns = lineNumber === undefined ? undefined : sideRuns?.[lineNumber - 1]

  let code: ReactNode
  if (wrappedLines === undefined) {
    code = textWithSearch(row.text, lineRuns, undefined, searchOptions, searchQuery, 0, row.text.length, searchCurrent)
  } else {
    let offset = 0
    code = wrappedLines.map((line, lineIndex) => {
      const start = offset
      offset += line.length
      const content = textWithSearch(row.text, lineRuns, undefined, searchOptions, searchQuery, start, offset, searchCurrent)
      return <div key={lineIndex} className={css.subline}>{content}</div>
    })
  }

  return (
    <div
      className={`${css.line} ${ROW_CLASS[row.kind]}`}
      data-diff-line={row.kind}
      data-diff-row={index}
      data-diff-focused={focused ? '' : undefined}
      data-diff-search={searchHit ? (searchCurrent ? 'current' : 'hit') : undefined}
      onMouseEnter={() => { onRowHover(index) }}
    >
      <span className={css.gutter} data-diff-gutter>{row.oldLine ?? ''}</span>
      <span className={css.gutter} data-diff-gutter>{row.newLine ?? ''}</span>
      <span className={css.code} data-diff-code data-diff-code-line={row.kind}>{code}</span>
    </div>
  )
})

/** One file's synchronous view: diff rows and change blocks. */
interface RowModel {
  diff: ReturnType<typeof computeWholeFileDiff>
  /** Maximal runs of changed rows (inclusive row indices); one per modification. */
  blocks: ChangeBlock[]
  /** Intra-line runs keyed by row index, present only for annotated del/add rows. */
  intra: Map<number, IntraRun[]>
}

/** One selected line range in row indices, normalized low-to-high. */
interface RowRange {
  start: number
  end: number
  /** Which file's lines a split selection references: 'old' (left column), 'new'
   *  (right column); undefined in single column (always the new file). */
  side?: 'old' | 'new'
}

/** Whether a block keep/revert range covers the file's entire change region, so
 *  applying it leaves the file with no pending diff — the "remove or keep in
 *  list" prompt applies. This generalises the single-block case to a selection
 *  that spans the file's last change (a bulk block keep/revert). */
function blockResolvesWholeFile(file: PendingFileDiff, block: DiffApprovalBlockRange): boolean {
  const diff = computeWholeFileDiff(file.oldText, file.newText)
  const blocks = changeBlocksOf(diff)
  if (blocks.length === 0) return false
  let oldMin = Number.POSITIVE_INFINITY
  let oldMax = Number.NEGATIVE_INFINITY
  let newMin = Number.POSITIVE_INFINITY
  let newMax = Number.NEGATIVE_INFINITY
  for (const cb of blocks) {
    const range = blockRangesOf(diff.rows, cb)
    oldMin = Math.min(oldMin, range.oldStart)
    oldMax = Math.max(oldMax, range.oldEnd)
    newMin = Math.min(newMin, range.newStart)
    newMax = Math.max(newMax, range.newEnd)
  }
  return block.oldStart <= oldMin && block.oldEnd >= oldMax
    && block.newStart <= newMin && block.newEnd >= newMax
}

/** Row indices whose text matches `query` under the options; empty for ''. Counted
 *  through the same matcher the highlights use, so the tally can never disagree
 *  with what is drawn. */
function matchingRows(rows: readonly WholeFileDiffRow[], query: string, options: SearchOptions): number[] {
  if (query === '') return []
  const out: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (matchRangesOf(rows[i]!.text, query, options).length > 0) out.push(i)
  }
  return out
}

/** The source lines one row window covers on a side (1-based, inclusive), or
 *  undefined when the window shows none of that side — an all-added or
 *  all-deleted stretch, where the other side has nothing to highlight. */
function windowLineRange(
  rows: readonly WholeFileDiffRow[],
  from: number,
  to: number,
  side: 'old' | 'new',
): LineRange | undefined {
  let first = Infinity
  let last = -Infinity
  for (let index = from; index < to; index++) {
    const row = rows[index]
    if (row === undefined) continue
    const line = side === 'old' ? row.oldLine : row.newLine
    if (line === undefined) continue
    if (line < first) first = line
    if (line > last) last = line
  }
  return Number.isFinite(first) ? { from: first, to: last } : undefined
}

/** The source lines one split-view pair window covers on a side (1-based,
 *  inclusive), or undefined when the window shows none of that side. */
function pairLineRange(
  pairs: readonly SplitPair[],
  from: number,
  to: number,
  side: 'left' | 'right',
): LineRange | undefined {
  let first = Infinity
  let last = -Infinity
  for (let index = from; index < to; index++) {
    const pair = pairs[index]
    const line = side === 'left' ? pair?.left?.line : pair?.right?.line
    if (line === undefined) continue
    if (line < first) first = line
    if (line > last) last = line
  }
  return Number.isFinite(first) ? { from: first, to: last } : undefined
}

/** One side's line-content for the split view: the highlighted runs or plain text. */
function splitSideContent(
  side: SplitSide | undefined,
  wrapped: string[] | undefined,
  runs: readonly HighlightSpan[] | undefined,
  intra: IntraRun[] | undefined,
  options: SearchOptions,
  query: string,
  current: boolean,
): ReactNode {
  if (side === undefined) return ''
  if (wrapped === undefined) {
    return textWithSearch(side.text, runs, intra, options, query, 0, side.text.length, current)
  }
  let offset = 0
  return wrapped.map((line, i) => {
    const start = offset
    offset += line.length
    const content = textWithSearch(side.text, runs, intra, options, query, start, offset, current)
    return <div key={i} className={css.subline}>{content}</div>
  })
}

/**
 * One side of a split pair row, rendered inside its own column. The two columns
 * are drawn by two independent `.splitCol` scrollers (each with its own
 * horizontal scrollbar) that share one vertical scroller, and each row gets the
 * same fixed `height` (the pair's max of the two sides' wrapped sub-line
 * counts) so the left/right halves always align on the same Y — no jump when
 * one side is longer. The gutter and code are top-aligned so sub-lines line up
 * across the divider.
 */
function SplitSideRow({ index, side, wrapped, runs, kind, isLeft, height, focused, searchHit, searchCurrent, searchQuery, searchOptions, onHover, intra }: {
  index: number
  side: SplitSide | undefined
  wrapped: string[] | undefined
  runs: readonly HighlightSpan[] | undefined
  kind: SplitPair['kind']
  isLeft: boolean
  height: number
  focused: boolean
  searchHit: boolean
  searchCurrent: boolean
  /** The active search query, used to highlight the matched substrings. */
  searchQuery: string
  /** How that query is matched (case, whole word). */
  searchOptions: SearchOptions
  onHover: () => void
  intra: IntraRun[] | undefined
}) {
  const tint = isLeft
    ? (kind === 'del' || kind === 'replace' ? css.splitLdel : '')
    : (kind === 'add' || kind === 'replace' ? css.splitRadd : '')
  return (
    <div
      className={css.line}
      style={{ height }}
      data-diff-split-row
      data-diff-split-index={index}
      data-diff-split-side={isLeft ? 'left' : 'right'}
      data-diff-focused={focused ? '' : undefined}
      data-diff-search={searchHit ? (searchCurrent ? 'current' : 'hit') : undefined}
      onMouseEnter={onHover}
    >
      <span className={css.gutter} data-diff-gutter>{side?.line ?? ''}</span>
      <span className={`${css.code} ${tint}`} data-diff-code data-diff-code-side={isLeft ? 'left' : 'right'}>{splitSideContent(side, wrapped, runs, intra, searchOptions, searchQuery, searchCurrent)}</span>
    </div>
  )
}

/** Imperative surface the parent uses to drive block navigation from the
 *  shared toolbar/keyboard in split mode (its own `focus` is private here). */
export interface SplitDiffHandle { jump: (direction: -1 | 1, wrapGuard?: boolean, singleToast?: boolean) => void; openSearch: () => void; toggleSearch: () => void; closeSearch: () => boolean; searchNext: (direction: -1 | 1) => boolean; toggleMatchCase: () => boolean; toggleMatchWholeWord: () => boolean }

/** The two-column (side-by-side) whole-file diff view. */
export const SplitDiff = forwardRef<SplitDiffHandle, {
  file: PendingFileDiff
  model: RowModel
  runs: HighlightSides | undefined
  langWrap: boolean
  tabWidthSpaces: number
  busy: boolean
  t: Translator
  selection: RowRange | undefined
  leadRows: number
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  /** Notify the parent to toast a block-wrap boundary / single-block (Ctrl+Up/Down). */
  onWrapToast: (text: string) => void
  /** Report which source lines this view is showing, so the parent's windowed
   *  highlighter follows this view's own scroller (it has its own virtual window). */
  onVisibleLines: (visible: VisibleLines) => void
}>(function SplitDiff({ file, model, runs, langWrap, tabWidthSpaces, busy, t, selection, leadRows, onBlockKeep, onBlockRevert, onWrapToast, onVisibleLines }, ref) {
  // Use the configured line height for the split virtual window and jump math
  // (the rendered split rows already size to the same value).
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const ROW_HEIGHT_PX = diffLineHeight()
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const NAV_ANCHOR_TOLERANCE_PX = ROW_HEIGHT_PX / 4
  const { pairs, pairOfRow } = useMemo(
    () => computeSideBySideDiff(model.diff.rows, true),
    [model],
  )
  const pairCount = pairs.length
  // Pair index → the whole-file row indices of its left (old) and right (new)
  // sides, so the split view can look up a side's intra-line runs.
  const pairRowIndices = useMemo(() => {
    const map = new Map<number, { left?: number; right?: number }>()
    model.diff.rows.forEach((row, rowIndex) => {
      const pairIndex = pairOfRow.get(rowIndex)
      if (pairIndex === undefined) return
      const entry = map.get(pairIndex) ?? {}
      if (row.kind !== 'add') entry.left = rowIndex
      if (row.kind !== 'del') entry.right = rowIndex
      map.set(pairIndex, entry)
    })
    return map
  }, [model, pairOfRow])
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [focus, setFocus] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
  // When the flash is a "boundary pin" it shakes instead of fading. Set per-flash
  // by `bumpFlash` so the overlay className stays stable for its whole life.
  const pinShakeRef = useRef(false)
  const bumpFlash = (shake: boolean): void => {
    pinShakeRef.current = shake
    setFlashKey(prev => prev + 1)
  }
  // The block index recorded at hover: a keep/revert prefers the current
  // `hoveredBlock` (the block the actions frame is for) and only falls back to
  // this if the body's mouseleave cleared `hoveredBlock` before the click.
  const hoveredBlockRef = useRef<number | undefined>(undefined)
  // Pinned horizontal scrollbars: each column's content is a hidden-scroll
  // `.splitCol` whose `scrollLeft` we drive from a pinned native scrollbar
  // strip in `.splitHScrollRow`. We track the content width of each column to
  // size the strip's thumb, and pin the `.lines` table to the file's widest
  // line so the thumb never jumps as the virtual window scrolls.
  const leftColRef = useRef<HTMLDivElement>(null)
  const rightColRef = useRef<HTMLDivElement>(null)
  const leftHScrollRef = useRef<HTMLDivElement>(null)
  const rightHScrollRef = useRef<HTMLDivElement>(null)
  const [fillWidth, setFillWidth] = useState<{ left: number; right: number }>({ left: 0, right: 0 })
  // In-split search: matches are whole pairs (a pair counts once, however many
  // times the query appears, and both columns highlight together). Own copy so
  // split keeps its own bar independent of the single-column one.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const search = useSearchOptions()
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFocus(0)
    bodyRef.current?.focus()
    bumpFlash(false)
    setHoveredBlock(undefined)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }, [file.id])

  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const measure = () => { setViewportH(body.clientHeight); setBodyWidth(body.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    return () => { observer?.disconnect() }
  }, [file.id])

  // Pair index range per change block (mapped from the original row range). For
  // a similarity-aligned block the rows pair by similarity rather than order, so
  // `pairOfRow(block.start)`/`pairOfRow(block.end)` can collapse to one pair while
  // the block spans several; fold the block's OWN rows' pair indices to the
  // [min, max] extent so the flash/frame covers the whole block.
  const blockOfPair = useMemo(() => model.blocks.map(block => {
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (let row = block.start; row <= block.end; row++) {
      const pair = pairOfRow.get(row)
      if (pair === undefined) continue
      if (pair < start) start = pair
      if (pair > end) end = pair
    }
    return { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 }
  }), [model, pairOfRow])
  // Pair index → the change block covering it. Fold the block's own rows' pair
  // indices, not a contiguous range: similarity alignment reorders a block's
  // pairs, so a [start,end]-row-range assumption misses some of them and
  // hovering those pairs would fail to surface the block's approval frame.
  const blockIndexByPair = useMemo(() => {
    const map = new Map<number, number>()
    model.blocks.forEach((block, bi) => {
      for (let row = block.start; row <= block.end; row++) {
        const pair = pairOfRow.get(row)
        if (pair !== undefined) map.set(pair, bi)
      }
    })
    return map
  }, [model, pairOfRow])
  const onPairHover = useCallback((k: number) => {
    const bi = blockIndexByPair.get(k)
    setHoveredBlock(bi)
    if (bi !== undefined) hoveredBlockRef.current = bi
  }, [blockIndexByPair])

  // One column's content width: both columns are equal `flex: 1 1 0` shares of
  // `.diffBody`'s client box minus the 1px divider. `bodyWidth` already excludes
  // the vertical scrollbar, so this is the real column width even when a
  // scrollbar is present (which the full-width pinned strip row would otherwise
  // overrun and misalign with).
  const colWidth = Math.max(0, (bodyWidth - 1) / 2)

  const pairWrapped = useMemo(() => {
    if (!langWrap || bodyWidth === 0) return null
    const measure = makeMeasurer(codeFontOf())
    if (measure === undefined) return null
    const charWidth = measure('0')
    const wrapW = colWidth - WRAP_GUTTERS_PX / 2 - charWidth
    const tabPx = tabWidthSpaces * measure(' ')
    return pairs.map(p => ({
      left: p.left === undefined ? undefined : wrapInto(p.left.text, wrapW, measure, tabPx),
      right: p.right === undefined ? undefined : wrapInto(p.right.text, wrapW, measure, tabPx),
    }))
  }, [pairs, langWrap, bodyWidth, colWidth, tabWidthSpaces])
  const pairHeights = useMemo(() => {
    if (pairWrapped === null) return null
    return pairWrapped.map(w => Math.max(w.left?.length ?? 1, w.right?.length ?? 1) * ROW_HEIGHT_PX)
  }, [pairWrapped])
  const pairOffsets = useMemo(() => {
    if (pairHeights === null) return null
    const offs = new Array<number>(pairHeights.length + 1)
    offs[0] = 0
    for (let i = 0; i < pairHeights.length; i++) offs[i + 1] = offs[i]! + pairHeights[i]!
    return offs
  }, [pairHeights])
  const totalHeight = pairOffsets === null ? pairCount * ROW_HEIGHT_PX : (pairOffsets[pairCount] ?? 0)
  const off = (k: number): number => (pairOffsets === null ? k * ROW_HEIGHT_PX : (pairOffsets[Math.max(0, Math.min(k, pairCount))] ?? 0))
  // Fixed height for a pair's row: both columns must hold this exact value so
  // the shorter side keeps an empty slot and the halves never desync.
  const pairHeightAt = (k: number): number => (pairHeights === null ? ROW_HEIGHT_PX : (pairHeights[k] ?? ROW_HEIGHT_PX))
  // Widest line (in characters) on each side, over the whole file. Used to pin
  // the column's `.lines` width to the widest line so the horizontal scrollbar
  // thumb's size and range stay stable while the virtual window scrolls.
  const widestSide = useMemo(() => {
    let left = 0
    let right = 0
    for (const p of pairs) {
      if (p.left !== undefined) left = Math.max(left, p.left.text.length)
      if (p.right !== undefined) right = Math.max(right, p.right.text.length)
    }
    return { left, right }
  }, [pairs])

  // Measure each column's content width and size its pinned scrollbar strip,
  // then re-sync the strip's scrollLeft to the column's. Runs after the column
  // content (or its width) changes; `overflow-x: hidden` still reports the full
  // content width via scrollWidth.
  useLayoutEffect(() => {
    const sync = (side: 'left' | 'right') => {
      const col = side === 'left' ? leftColRef.current : rightColRef.current
      const strip = side === 'left' ? leftHScrollRef.current : rightHScrollRef.current
      if (col === null || strip === null) return
      const width = col.scrollWidth
      setFillWidth(prev => (prev[side] === width ? prev : { ...prev, [side]: width }))
      strip.scrollLeft = col.scrollLeft
    }
    sync('left')
    sync('right')
  }, [pairs, langWrap, tabWidthSpaces, bodyWidth])

  // Dragging a pinned strip scrolls only that column's content.
  const onHScroll = useCallback((side: 'left' | 'right') => {
    const strip = side === 'left' ? leftHScrollRef.current : rightHScrollRef.current
    const col = side === 'left' ? leftColRef.current : rightColRef.current
    if (strip === null || col === null) return
    col.scrollLeft = strip.scrollLeft
  }, [])
  // Search: pair indices whose left or right text contains the query.
  const searchMatches = useMemo(() => searchPairs(pairs, searchQuery, search.options), [pairs, searchQuery, search.options])
  const searchHitSet = useMemo(() => new Set(searchMatches), [searchMatches])
  const currentSearchPair = searchMatches.length === 0 ? undefined : searchMatches[searchIndex % searchMatches.length]

  // Reports whether the bar was open, so a caller that also owns another Esc
  // (the panel) can leave the press alone instead of swallowing it.
  const closeSearch = (): boolean => {
    if (!searchOpen) return false
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
    bodyRef.current?.focus()
    return true
  }
  /** Run one bar control's action, then hand the focus back to the query box:
   *  the bar's chords are scoped to the box (its Esc to the bar), so a mouse
   *  click on a bar button must not leave them dead on the button it landed on. */
  const andRefocus = (action: () => void): void => {
    action()
    searchInputRef.current?.focus()
  }
  /** The shared toolbar's search button: the split view owns its own bar, so the
   *  button has to toggle this one rather than the single-column state. */
  const toggleSearch = (): void => {
    if (searchOpen) closeSearch()
    else openSearch()
  }
  // The narrowing chords only apply while this bar is open, so report whether the
  // chord was consumed rather than swallowing it for a closed bar.
  const toggleMatchCase = (): boolean => {
    if (!searchOpen) return false
    search.toggleCase()
    return true
  }
  const toggleMatchWholeWord = (): boolean => {
    if (!searchOpen) return false
    search.toggleWord()
    return true
  }
  const openSearch = (): void => {
    // The selection acts as the search's start position (there is no text
    // cursor in a diff): auto-fill the query with it and seed the current match.
    // Already open: keep the current query and match, just refocus the box (a
    // repeated Ctrl+F must not re-anchor an earlier match).
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    // The stored preference wins over this instance's last-known state: the
    // other view's bar may have toggled it since.
    search.sync()
    const live = window.getSelection()
    const liveRange = splitRowRangeOf(live)
    // Fall back to the last tracked selection: clicking the search button moves
    // focus and can collapse the live selection before this handler runs.
    const range = liveRange !== undefined ? liveRange : (selection as RowRange | undefined)
    const liveText = (live?.toString() ?? '').trim()
    const value = liveText !== '' && !liveText.includes('\n') ? liveText : ''
    setSearchQuery(value)
    const matches = value === '' ? [] : searchPairs(pairs, value, search.options)
    let index = 0
    if (matches.length > 0) {
      const inSel =
        range === undefined ? -1 : matches.findIndex(i => i >= range.start && i <= range.end)
      if (inSel !== -1) {
        index = inSel
      } else {
        const body = bodyRef.current
        const top = body === null ? 0 : pairAtY(body.scrollTop)
        const at = matches.findIndex(i => i >= top)
        index = at === -1 ? 0 : at
      }
    }
    setSearchIndex(index)
    setSearchOpen(true)
    // Focus after the bar mounts (it is conditionally rendered).
    requestAnimationFrame(() => { searchInputRef.current?.focus(); searchInputRef.current?.select() })
  }
  const goSearch = (direction: -1 | 1): void => {
    const len = searchMatches.length
    if (len === 0) return
    const next = (searchIndex + direction + len) % len
    setSearchIndex(next)
    const pairIndex = searchMatches[next]
    if (pairIndex === undefined) return
    const body = bodyRef.current
    if (body === null) return
    // Bring the pair into view only when it is off-screen; never recenter a
    // match that is already visible.
    if (body.clientHeight <= 0) return
    const viewTop = body.scrollTop
    const viewBottom = viewTop + body.clientHeight
    const pairTop = off(pairIndex)
    const pairBottom = pairTop + ROW_HEIGHT_PX
    let target: number | undefined
    if (pairTop < viewTop) target = pairTop
    else if (pairBottom > viewBottom) target = pairBottom - body.clientHeight
    if (target === undefined) return
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
  }
  // Keep/revert the hovered block, then advance focus to the next change block
  // (if there is one), mirroring the single-column behaviour. The remaining
  // blocks shift into the operated block's slot, so that index is the next one.
  const handleBlockAction = async (action: 'keep' | 'revert'): Promise<void> => {
    const operated = hoveredBlock ?? hoveredBlockRef.current
    if (operated === undefined) return
    const range = blockRanges[operated]
    if (range === undefined) return
    await (action === 'keep'
      ? onBlockKeep(file.sessionId, file.id, range)
      : onBlockRevert(file.sessionId, file.id, range))
    const count = model.blocks.length
    if (count === 0) return
    const next = Math.max(0, Math.min(operated, count - 1))
    setFocus(next)
    setHoveredBlock(undefined)
    bumpFlash(false)
  }
  const pairAtY = (y: number): number => {
    if (pairOffsets === null) return Math.floor(y / ROW_HEIGHT_PX)
    if (y <= 0) return 0
    let lo = 0, hi = pairCount
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((pairOffsets[mid] ?? 0) <= y) lo = mid; else hi = mid - 1 }
    return lo
  }
  const viewport = viewportH > 0 ? viewportH : totalHeight
  let start = Math.max(0, pairAtY(scrollTop) - OVERSCAN_ROWS)
  let end = Math.min(pairCount, pairAtY(scrollTop + viewport) + OVERSCAN_ROWS)
  // Keep the selected pairs rendered when scrolled out of the window, so
  // virtualization never unmounts the nodes the native selection references.
  if (selection !== undefined) {
    start = Math.min(start, selection.start)
    end = Math.max(end, selection.end + 1)
  }
  const visiblePairs = pairs.slice(start, end)

  // Tell the parent which source lines are on screen, so its windowed highlighter
  // follows *this* view's scroller (the split view has its own virtual window and
  // its own scroll container, so the parent's single-column window means nothing
  // here). Runs after a scroll settles in the parent's own effect.
  useEffect(() => {
    onVisibleLines({
      oldRange: pairLineRange(pairs, start, end, 'left'),
      newRange: pairLineRange(pairs, start, end, 'right'),
      live: viewportH > 0,
    })
  }, [onVisibleLines, pairs, start, end, viewportH])

  // Block navigation: jump between change blocks (flashes the focused one).
  // At the wrap boundary (last block + down, first block + up) a guarded press
  // (keyboard or toolbar) only toasts; the next press in the same direction
  // wraps. Armed direction = 0.
  const wrapArmedRef = useRef<0 | -1 | 1>(0)
  const jump = (direction: -1 | 1, wrapGuard = false, singleToast = wrapGuard): void => {
    const count = blockOfPair.length
    if (count === 0) return
    if (wrapGuard) {
      if (count === 1) {
        if (singleToast) onWrapToast(t('panel.blockSingle'))
      } else {
        const atBoundary = (direction === 1 && focus === count - 1)
          || (direction === -1 && focus === 0)
        if (atBoundary) {
          // Toast only on the press that does NOT jump; the next press wraps.
          if (wrapArmedRef.current !== direction) {
            wrapArmedRef.current = direction
            onWrapToast(t(direction === 1 ? 'panel.blockAtEnd' : 'panel.blockAtStart'))
            // Flash the current block with a shake to show it is pinned here.
            bumpFlash(true)
            return
          }
          wrapArmedRef.current = 0
        } else {
          wrapArmedRef.current = 0
        }
      }
    }
    setFocus(current => {
      if (direction === -1) return (current - 1 + count) % count
      const top = bodyRef.current?.scrollTop ?? 0
      for (let index = current + 1; index < count; index++) {
        if (off(blockOfPair[index]!.start) >= top) return index
      }
      return 0
    })
    bumpFlash(false)
  }
  // Step the hovered block's floating actions frame to the adjacent diff block
  // (wrapping), matching the single-column frame: both the hovered block (the
  // frame follows it) and the focused block advance together, and the view
  // recenters + re-flashes via `bumpFlash`.
  const stepBlock = (direction: -1 | 1): void => {
    const count = blockOfPair.length
    if (count === 0) return
    const base = hoveredBlock ?? focus
    const target = (base + direction + count) % count
    setHoveredBlock(target)
    setFocus(target)
    bumpFlash(false)
  }
  // Step the search (F3 / Shift+F3), but only when this view's own search bar
  // is open — so a closed bar never advances a stale match list.
  const searchNext = (direction: -1 | 1): boolean => {
    if (!searchOpen) return false
    goSearch(direction)
    return true
  }
  // Expose the block jump to the parent so the shared toolbar/keyboard drives
  // this split view's own (private) focus in split mode.
  useImperativeHandle(ref, () => ({ jump, openSearch, toggleSearch, closeSearch, searchNext, toggleMatchCase, toggleMatchWholeWord }), [jump, openSearch, toggleSearch, closeSearch, searchNext, toggleMatchCase, toggleMatchWholeWord])

  useLayoutEffect(() => {
    if (pairCount === 0) return
    const block = blockOfPair[focus]
    if (block === undefined) return
    const body = bodyRef.current
    if (body === null) return
    // Leave the configured lead rows above the block, matching the single-column view.
    const target = off(block.start) - leadRows * ROW_HEIGHT_PX
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
    // `model`/`pairCount` are deliberately NOT deps — a content refresh would
    // otherwise re-center the view and lose the user's scroll position. `focus`
    // is also NOT a dep: a scroll re-anchors `focus` to the block under the
    // viewport (see `onScroll`), and that must NOT recenter and fight the scroll.
  }, [flashKey])

  const onScroll = (): void => {
    const body = bodyRef.current
    if (body === null) return
    setScrollTop(body.scrollTop)
    // Re-anchor the "current diff" (`focus`) to the block under the viewport
    // anchor, so a manual scroll updates which block prev/next walk from
    // instead of a stale last-jumped-to block. Updating focus does NOT recenter
    // (the effect above keys off `flashKey`, not `focus`), so it never fights
    // the user's scroll; this only runs on real user scrolls, since programmatic
    // recenters set scrollTop directly and do NOT fire a scroll event.
    const count = blockOfPair.length
    if (count === 0) return
    // Edge-clamp: pinned to top/bottom → first/last block, not the anchor one
    // (the last block's `start` sits below the anchor when clamped to the bottom,
    // so the anchor lookup would pull focus off-by-one after a boundary wrap).
    let ref = -1
    if (body.clientHeight > 0) {
      const viewportBottom = body.scrollTop + body.clientHeight
      if (body.scrollTop <= NAV_ANCHOR_TOLERANCE_PX) ref = 0
      else if (body.scrollHeight - viewportBottom <= NAV_ANCHOR_TOLERANCE_PX) ref = count - 1
    }
    if (ref === -1) {
      const anchor = body.scrollTop + leadRows * ROW_HEIGHT_PX
      for (let index = 0; index < count; index++) {
        if (off(blockOfPair[index]!.start) <= anchor + NAV_ANCHOR_TOLERANCE_PX) ref = index
      }
    }
    setFocus(ref === -1 ? 0 : ref)
  }
  const inFocused = (k: number): boolean => {
    const block = blockOfPair[focus]
    return block !== undefined && k >= block.start && k <= block.end
  }

  // Split keeps the whole-diff stats from the single-column model (same diff).
  const blockRanges = useMemo(() => model.blocks.map(block => blockRangesOf(model.diff.rows, block)), [model])
  const focusedBlock = blockOfPair[focus]
  const flashTop = focusedBlock === undefined ? 0 : Math.max(0, off(focusedBlock.start) - scrollTop)
  const flashBottom = focusedBlock === undefined
    ? 0
    : Math.min(viewportH > 0 ? viewportH : Number.POSITIVE_INFINITY, off(focusedBlock.end + 1) - scrollTop)
  const flashHeight = Math.max(0, flashBottom - flashTop)
  // Hovered block's actions frame, pinned to the block's bottom edge. The actions
  // live in the non-scrolling wrapper (viewport coordinates), so subtract
  // scrollTop; the frame is clamped to stay on-screen.
  const blockActionsTop = hoveredBlock === undefined || blockOfPair[hoveredBlock] === undefined
    ? 0
    : Math.max(0, Math.min(off(blockOfPair[hoveredBlock]!.end + 1) - scrollTop, Math.max(0, viewportH - BLOCK_ACTIONS_FRAME_PX)))

  return (
    <div className={css.splitRoot} onMouseLeave={() => setHoveredBlock(undefined)}>
      <div
        className={`${css.diffBody} ${css.diffBodySplit}`}
        ref={bodyRef}
        tabIndex={0}
        onScroll={onScroll}
        style={{ tabSize: tabWidthSpaces }}
        data-diff-body
      >
        <div className={css.splitCols}>
          <div className={css.splitCol} ref={leftColRef} data-diff-split-side="left">
            <div
              className={`${css.lines}${langWrap ? ' ' + css.wrap : ''}`}
              style={langWrap ? undefined : { minWidth: `max(100%, ${widestSide.left}ch)` }}
            >
              {start > 0 && <div className={css.vSpacer} style={{ height: off(start) }} aria-hidden="true" />}
              {visiblePairs.map((pair, offset) => {
                const index = start + offset
                const leftRuns = pair.left === undefined ? undefined : runs?.oldRuns?.[(pair.left.line ?? 0) - 1]
                const sideIndex = pairRowIndices.get(index)
                return (
                  <SplitSideRow
                    key={index}
                    index={index}
                    side={pair.left}
                    wrapped={pairWrapped?.[index]?.left}
                    runs={leftRuns}
                    kind={pair.kind}
                    isLeft
                    height={pairHeightAt(index)}
                    focused={inFocused(index)}
                    searchHit={searchHitSet.has(index)}
                    searchCurrent={index === currentSearchPair}
                    searchQuery={searchQuery}
                    searchOptions={search.options}
                    onHover={() => onPairHover(index)}
                    intra={sideIndex?.left === undefined ? undefined : model.intra.get(sideIndex.left)}
                  />
                )
              })}
              {end < pairCount && <div className={css.vSpacer} style={{ height: totalHeight - off(end) }} aria-hidden="true" />}
            </div>
          </div>
          <div className={css.splitDivider} />
          <div className={css.splitCol} ref={rightColRef} data-diff-split-side="right">
            <div
              className={`${css.lines}${langWrap ? ' ' + css.wrap : ''}`}
              style={langWrap ? undefined : { minWidth: `max(100%, ${widestSide.right}ch)` }}
            >
              {start > 0 && <div className={css.vSpacer} style={{ height: off(start) }} aria-hidden="true" />}
              {visiblePairs.map((pair, offset) => {
                const index = start + offset
                const rightRuns = pair.right === undefined ? undefined : runs?.newRuns?.[(pair.right.line ?? 0) - 1]
                const sideIndex = pairRowIndices.get(index)
                return (
                  <SplitSideRow
                    key={index}
                    index={index}
                    side={pair.right}
                    wrapped={pairWrapped?.[index]?.right}
                    runs={rightRuns}
                    kind={pair.kind}
                    isLeft={false}
                    height={pairHeightAt(index)}
                    focused={inFocused(index)}
                    searchHit={searchHitSet.has(index)}
                    searchCurrent={index === currentSearchPair}
                    searchQuery={searchQuery}
                    searchOptions={search.options}
                    onHover={() => onPairHover(index)}
                    intra={sideIndex?.right === undefined ? undefined : model.intra.get(sideIndex.right)}
                  />
                )
              })}
              {end < pairCount && <div className={css.vSpacer} style={{ height: totalHeight - off(end) }} aria-hidden="true" />}
            </div>
          </div>
        </div>
      </div>
      <div className={css.splitHScrollRow} data-diff-hscroll-row>
        <div className={css.splitHScroll} ref={leftHScrollRef} data-diff-hscroll="left" style={{ width: colWidth, flex: 'none' }} onScroll={() => onHScroll('left')}>
          <div className={css.splitHScrollFill} style={{ width: fillWidth.left || undefined }} />
        </div>
        <div className={css.splitDivider} />
        <div className={css.splitHScroll} ref={rightHScrollRef} data-diff-hscroll="right" style={{ width: colWidth, flex: 'none' }} onScroll={() => onHScroll('right')}>
          <div className={css.splitHScrollFill} style={{ width: fillWidth.right || undefined }} />
        </div>
      </div>
      {searchOpen && (
        <div className={css.searchBar} data-diff-searchbar>
          <input
            ref={searchInputRef}
            className={css.searchInput}
            data-diff-search-input
            value={searchQuery}
            placeholder={t('panel.searchPlaceholder')}
            onChange={(event) => {
              const value = event.target.value
              setSearchQuery(value)
              if (value !== '') {
                const body = bodyRef.current
                const matches = searchPairs(pairs, value, search.options)
                // Anchor from the current highlighted pair (the search "cursor").
                // On the very first input there is no highlight yet, so fall back
                // to the row at the viewport top.
                const anchor = currentSearchPair ?? (body === null ? 0 : pairAtY(body.scrollTop))
                const at = matches.findIndex(index => index >= anchor)
                setSearchIndex(at === -1 ? 0 : at)
              } else {
                setSearchIndex(0)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goSearch(event.shiftKey ? -1 : 1)
              }
            }}
          />
          <span className={css.searchCount} data-diff-search-count>
            {searchMatches.length === 0
              ? '0/0'
              : `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}`}
          </span>
          <Tooltip label={withChord(t('action.matchCase'), 'matchCase')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={search.caseSensitive ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
              data-diff-search-case
              data-on={search.caseSensitive ? '' : undefined}
              aria-label={t('action.matchCase')}
              aria-pressed={search.caseSensitive}
              onClick={() => { andRefocus(() => { search.toggleCase() }) }}
            >
              <SearchOptionIcon kind="case" />
            </button>
          </Tooltip>
          <Tooltip label={withChord(t('action.matchWholeWord'), 'matchWholeWord')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={search.wholeWord ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
              data-diff-search-word
              data-on={search.wholeWord ? '' : undefined}
              aria-label={t('action.matchWholeWord')}
              aria-pressed={search.wholeWord}
              onClick={() => { andRefocus(() => { search.toggleWord() }) }}
            >
              <SearchOptionIcon kind="word" />
            </button>
          </Tooltip>
          <Tooltip label={withChord(t('action.prevDiff'), 'searchPrev')} side="bottom" delayMs={500}>
            <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-prev aria-label={t('action.prevDiff')} disabled={searchMatches.length === 0} onClick={() => { andRefocus(() => { goSearch(-1) }) }}>
              <IconChevronUpOutline14 size={14} />
            </button>
          </Tooltip>
          <Tooltip label={withChord(t('action.nextDiff'), 'searchNext')} side="bottom" delayMs={500}>
            <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-next aria-label={t('action.nextDiff')} disabled={searchMatches.length === 0} onClick={() => { andRefocus(() => { goSearch(1) }) }}>
              <IconChevronDownOutline14 size={14} />
            </button>
          </Tooltip>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-close aria-label={t('action.close')} onClick={closeSearch}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
      )}
      {focusedBlock !== undefined && flashKey > 0 && (
        <div className={pinShakeRef.current ? `${css.blockFlash} ${css.blockFlashShake}` : css.blockFlash} data-diff-block-flash key={flashKey} style={{ top: flashTop, height: flashHeight }} />
      )}
      {hoveredBlock !== undefined && blockOfPair[hoveredBlock] !== undefined && (
        <div className={css.blockActions} data-diff-block-actions style={{ top: blockActionsTop }}>
          <span className={css.blockPosition} data-diff-block-position>
            {t('panel.blockPosition', { current: hoveredBlock + 1, total: blockOfPair.length })}
          </span>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-block-prev aria-label={t('action.prevDiff')} disabled={busy} onClick={() => stepBlock(-1)}>
            <IconChevronUpOutline14 size={14} />
          </button>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-block-next aria-label={t('action.nextDiff')} disabled={busy} onClick={() => stepBlock(1)}>
            <IconChevronDownOutline14 size={14} />
          </button>
          <button type="button" className={`${css.action} ${css.actionPrimary}`} data-diff-block-keep disabled={busy} onClick={() => { void handleBlockAction('keep') }}>
            {t('action.keep')}
          </button>
          <button type="button" className={`${css.action}`} data-diff-block-revert disabled={busy} onClick={() => { void handleBlockAction('revert') }}>
            {t('action.revert')}
          </button>
        </div>
      )}
    </div>
  )
})

/** The diff-row index containing a node, or undefined. */
function rowIndexAt(node: Node | null): number | undefined {
  if (node === null) return undefined
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest('[data-diff-row]')
  if (row === null || row === undefined) return undefined
  const index = Number((row as HTMLElement).dataset.diffRow)
  return Number.isFinite(index) ? index : undefined
}

/** The split pair index and which side (left=old, right=new) a node sits in, or undefined. */
function splitRowInfoAt(node: Node | null): { pairIndex: number; side: 'old' | 'new' } | undefined {
  if (node === null) return undefined
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest('[data-diff-split-row]')
  if (row === null || row === undefined) return undefined
  const side = (row as HTMLElement).dataset.diffSplitSide
  if (side !== 'left' && side !== 'right') return undefined
  const index = Number((row as HTMLElement).dataset.diffSplitIndex)
  if (!Number.isFinite(index)) return undefined
  return { pairIndex: index, side: side === 'left' ? 'old' : 'new' }
}

/**
 * Derive the selected split pair range per side (a left-column selection
 * references the old file, a right-column selection the new file). A selection
 * spanning the divider (both sides) references two files, so it is rejected.
 */
function splitRowRangeOf(selection: Selection | null): RowRange | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  const startInfo = splitRowInfoAt(range.startContainer)
  const endInfo = splitRowInfoAt(range.endContainer)
  if (startInfo === undefined || endInfo === undefined) return undefined
  if (startInfo.side !== endInfo.side) return undefined
  let start = startInfo.pairIndex
  let end = endInfo.pairIndex
  if (lineOffsetAt(range.startContainer, range.startOffset) >= lineLengthAt(range.startContainer)) start += 1
  if (lineOffsetAt(range.endContainer, range.endOffset) === 0) end -= 1
  if (start > end) return undefined
  return { start, end, side: startInfo.side }
}

/** The code cell in `node`'s visual row, a sibling of its gutter cells. A
 * line-number boundary must measure against the line's own selectable text even
 * though the gutter text is not inside the code cell; this resolves the cell
 * for both the unified row and a split column row. */
function codeCellAt(node: Node): HTMLElement | null {
  const container = node instanceof Element ? node : node.parentElement
  const row = container?.closest('[data-diff-row], [data-diff-split-row]')
  return row?.querySelector<HTMLElement>('[data-diff-code]') ?? null
}

/**
 * The change block a rendered Markdown-preview node belongs to, or undefined (a
 * context block, or a node outside any tagged block). The preview tags every
 * changed run's element with `data-md-block`, carrying the same block index the
 * source view's `changeBlocksOf` derives over the same contents — so a preview
 * element and a source block name the same keep/revert target.
 * @param node - the node under the pointer.
 * @returns the block index, or undefined.
 */
function previewBlockAt(node: Node | null): number | undefined {
  const element = node instanceof Element ? node : node?.parentElement ?? null
  const raw = element?.closest('[data-md-block]')?.getAttribute('data-md-block')
  if (raw === null || raw === undefined) return undefined
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : undefined
}

/** Character offset of a selection boundary within its line's code text. A
 * boundary outside the code cell (the line-number gutter) sits at the line's
 * start — offset 0, never the line's end — so it never skips the line. */
function lineOffsetAt(node: Node, offset: number): number {
  const code = codeCellAt(node)
  if (code === null || !code.contains(node)) return 0
  let before = 0
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let current: Node | null = walker.nextNode()
  while (current !== null) {
    if (current === node) return before + offset
    // A boundary on an element (the code cell or a highlight span) stops at
    // the first text inside it; its own first `offset` children are added
    // below.
    if (node instanceof Element && node.contains(current)) break
    before += (current as Text).length
    current = walker.nextNode()
  }
  if (node instanceof Element) {
    const children = [...node.childNodes]
    for (let i = 0; i < Math.min(offset, children.length); i++) {
      const inner = document.createTreeWalker(children[i]!, NodeFilter.SHOW_TEXT)
      let text: Node | null = inner.nextNode()
      while (text !== null) {
        before += (text as Text).length
        text = inner.nextNode()
      }
    }
  }
  return before
}

/** Length of the code text on the line holding a node (the line's selectable
 * text, even when `node` is in a gutter cell of the same row). */
function lineLengthAt(node: Node): number {
  return codeCellAt(node)?.textContent?.length ?? 0
}

/**
 * Reconstruct the plain text of the current selection so auto-wrap's visual
 * line breaks never leak into the clipboard. A wrapped row renders its code as
 * several `.subline` block elements, and the browser's default copy inserts a
 * newline between them; those segments form one logical line, so they are joined
 * without a newline while the real newline between diff rows is kept.
 */
export function selectedPlainText(): string | undefined {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  const container = document.createElement('div')
  container.appendChild(range.cloneContents())
  const parts: string[] = []
  let atLineStart = true
  const push = (text: string): void => {
    if (text.length === 0) return
    parts.push(text)
    atLineStart = text.endsWith('\n')
  }
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      // An empty wrapped segment is rendered as a non-breaking space purely to
      // keep its row height; that is layout-only, not file content — drop it.
      // Mark the line as consumed so a following row still starts a new line.
      if (/^\u00a0+$/.test(text)) { atLineStart = false; return }
      push(text)
      return
    }
    if (!(node instanceof Element)) return
    const el = node as HTMLElement
    // The line-number gutter cells are not diff content — drop their digits.
    if (el.dataset.diffGutter !== undefined) return
    // A deleted (old) line is not part of the current file: copying a selection
    // should give the real current code, so skip del rows entirely. Context and
    // added rows are the current file's lines.
    if (el.dataset.diffLine === 'del') return
    if (el.dataset.diffCodeLine === 'del') return
    // Split view's left column (or a left code cell) is the old revision, so
    // skip it — copy is the current (right) code.
    if (el.dataset.diffSplitSide === 'left') return
    if (el.dataset.diffCodeSide === 'left') return
    // A diff row (unified or split) is a logical line: precede it with a
    // newline unless we are already at a line start. A wrapped `.subline` is
    // a segment of that same line, so it is intentionally NOT a boundary.
    const isRow = el.dataset.diffRow !== undefined
      || el.dataset.diffSplitRow !== undefined
      || el.dataset.diffSplitIndex !== undefined
    if (isRow && !atLineStart) push('\n')
    for (const child of node.childNodes) walk(child)
  }
  walk(container)
  return parts.join('')
}

/**
 * Derive the selected diff-row range from a native text selection. A
 * boundary sitting exactly at a line edge contributes no content: a start at
 * the line's end skips to the next line, an end at the line's start falls
 * back to the previous line.
 */
function rowRangeOf(selection: Selection | null): RowRange | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  let start = rowIndexAt(range.startContainer)
  let end = rowIndexAt(range.endContainer)
  if (start === undefined || end === undefined) return undefined
  if (lineOffsetAt(range.startContainer, range.startOffset) >= lineLengthAt(range.startContainer)) start += 1
  if (lineOffsetAt(range.endContainer, range.endOffset) === 0) end -= 1
  if (start > end) return undefined
  return { start, end }
}

/** One ruler marker for the rendered Markdown preview. */
interface PreviewRulerMarker {
  top: number
  height: number
  kind: 'del' | 'add'
}

/**
 * Measure the single-column preview's change blocks to position its ruler
 * markers by RENDERED height, so a tall block (an inline image, a large code
 * fence) is not miscounted by source-line fractions. `offsetTop`/`offsetHeight`
 * are relative to `.mdPreviewBody` (which is the blocks' positioned parent);
 * each change block was rendered as one run, so one marker per block. A floor
 * keeps a thin block visible on a long document.
 * @param container - the rendered preview body.
 * @returns markers positioned as fractions of the content's scroll height.
 */
function markdownPreviewMarkers(container: HTMLElement): PreviewRulerMarker[] {
  const total = container.scrollHeight
  if (total === 0) return []
  const markers: PreviewRulerMarker[] = []
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('.mdBlock.mdAdd, .mdBlock.mdDel'))) {
    markers.push({
      top: (el.offsetTop / total) * 100,
      height: Math.max((el.offsetHeight / total) * 100, 0.5),
      kind: el.classList.contains('mdDel') ? 'del' : 'add',
    })
  }
  return markers
}

/** One row of the file list: the clickable head in the left pane. */
function PendingFileRow({ file, selected, failedMessage, t, onSelect }: PendingFileRowProps) {
  const stats = useMemo(
    () => computeWholeFileDiff(file.oldText, file.newText),
    [file.oldText, file.newText],
  )
  return (
    <li className={css.row}>
      <Tooltip label={file.path} delayMs={500} maxWidth={560}>
        <button
          type="button"
          className={css.rowHead}
          data-selected={selected || undefined}
          onClick={() => { onSelect(file.id) }}
        >
          <span className={css.rowPath}>{basenameOf(file.path)}</span>
          {file.kind === 'create' && <span className={css.kindTag}>{t('row.create')}</span>}
          {file.missing && <span className={css.missing} title={t('panel.missingHint')}>{t('panel.missing')}</span>}
          {failedMessage !== undefined && <span className={css.rowFailed} title={failedMessage}>{t('row.failed')}</span>}
          {(stats.added !== 0 || stats.removed !== 0) && (
            <span className={css.rowMeta}>
              <span className={css.addCount}>{t('row.added', { added: stats.added })}</span>
              <span className={css.delCount}>{t('row.removed', { removed: stats.removed })}</span>
            </span>
          )}
        </button>
      </Tooltip>
    </li>
  )
}

/** The selected file's diff, actions, jump controls, and copy toolbar. */
function PendingDiff({ file, busy, workspacePath, jumpSignal, undoFlash, failedMessage, onPasteReference, onToast, t, onKeep, onRevert, onRefreshVcs, onBlockKeep, onBlockRevert, onOpen, onPreviewImage }: PendingDiffProps) {
  // A manual highlight-language override; undefined means auto-detect from the
  // file extension. The picker is DSH's own Menu dropdown, portaled so the
  // list escapes the diff's overflow clip.
  const [langOverride, setLangOverride] = useState<string | undefined>(undefined)
  const [langMenuOpen, setLangMenuOpen] = useState(false)
  const langMenuItems = useMemo<MenuEntry[]>(() => [
    { id: '', label: t('action.langAuto') },
    ...HIGHLIGHT_LANGS.map(language => ({ id: language, label: languageDisplayName(language) })),
  ], [t])
  const detectedLang = useMemo(() => langFromPath(file.path), [file.path])
  // The suffix a manual choice is remembered under (undefined when the name has
  // no extension: there is nothing narrow enough to remember it by).
  const langSuffix = useMemo(() => suffixOfPath(file.path), [file.path])
  // This session's explicit pick for the OPEN file; undefined falls back to what
  // was remembered for the file's suffix, and then to auto-detection.
  const rememberedLang = useMemo(() => (langSuffix === undefined ? undefined : languageForSuffix(langSuffix)), [langSuffix])
  const effectiveLang = langOverride ?? rememberedLang
  const lang = useMemo(() => effectiveLang ?? detectedLang, [detectedLang, effectiveLang])
  // The trigger label: an explicit choice names the language; auto names what it
  // resolved to, so the user sees the effective highlighting either way.
  const langLabel = effectiveLang === undefined
    ? (detectedLang === undefined ? t('action.langAuto') : t('action.langAutoDetected', { lang: languageDisplayName(detectedLang) }))
    : languageDisplayName(effectiveLang)
  // Per-language auto-wrap preference: keyed by the resolved language so each
  // language's setting is remembered independently; defaults to off.
  const wrapKey = lang ?? ''
  const [langWrap, setLangWrap] = useState(() => wrapEnabled(wrapKey))
  useEffect(() => { setLangWrap(wrapEnabled(wrapKey)) }, [wrapKey])
  const toggleLangWrap = (): void => {
    const next = !langWrap
    setLangWrap(next)
    setWrapEnabled(wrapKey, next)
  }
  // Global tab width (spaces) from settings: drives the rendered `tab-size`
  // on the diff and the wrapped-line tab measurement, so both agree. Read once
  // on mount; a change in DSH Settings applies on the next panel open.
  const [tabWidthSpaces] = useState(() => tabWidth())
  // Side-by-side (split) mode from settings. Held in state so the toolbar
  // toggle can switch the view live (and persist the choice); a change in DSH
  // Settings still applies on the next panel open.
  const [splitView, setSplitView] = useState(() => splitMode())
  // Rendered-Markdown preview on/off (only offered for Markdown files). When on,
  // the diff body shows the rendered Markdown instead of the source-line diff;
  // the existing single/side-by-side view toggle (`splitView`) drives whether it
  // is single-column (merged, unified-like) or double-column (before | after).
  // The default comes from the persisted setting (settable in DSH Settings).
  const [mdPreview, setMdPreview] = useState(() => mdPreviewEnabled())
  // The preview replaces the code view only for a Markdown file while the
  // preference is on. The stored preference alone (a non-Markdown file, or a
  // manual language override) must never hide the source view's own controls —
  // so everything below that asks "is the preview showing?" asks this, not
  // `mdPreview`.
  const previewActive = mdPreview && lang === 'markdown'
  // The preview body element, for the post-render local-image resolution pass.
  const mdPreviewBodyRef = useRef<HTMLDivElement>(null)
  // The single-column preview's diff-ruler markers, measured from the rendered
  // blocks (height-aware) after each render and again once local images inline.
  const [mdRulerMarkers, setMdRulerMarkers] = useState<PreviewRulerMarker[]>([])
  // Bumped after local images inline so the ruler re-measures their true height.
  const [mdImageTick, setMdImageTick] = useState(0)
  // Rows of lead left above a jumped-to diff block (configurable in Settings).
  const leadRows = navLeadRows()
  // Diff-view customization (font/line-height scale, add/del base colors) read
  // on mount and applied as CSS variables on the diff card; a change in DSH
  // Settings applies on the next panel open. Font-size and line-height are
  // relative scales (100% = current), so the default is the current appearance.
  const diffFontScaleValue = diffFontScale()
  const diffLineHeightValue = diffLineHeight()
  const diffAddColorPx = diffAddColor()
  const diffDelColorPx = diffDelColor()
  // Markdown-preview content max width (single column), read on mount; the
  // double-column view uses twice this (each column the same single width).
  const mdPreviewMaxWidthPx = mdMaxWidth()
  // CSS variables for the diff card: line height always; colors only when
  // customized (unset keeps the theme, so the default is the current look).
  const diffViewVars: Record<string, string> = {}
  diffViewVars['--dsh-diff-font-scale'] = String(diffFontScaleValue / 100)
  diffViewVars['--dsh-diff-line-height'] = `${diffLineHeightValue}px`
  if (diffAddColorPx !== undefined) diffViewVars['--dsh-diff-add-color'] = diffAddColorPx
  if (diffDelColorPx !== undefined) diffViewVars['--dsh-diff-del-color'] = diffDelColorPx
  // Shadow the module defaults so the virtual window and jump math follow the
  // configured line height (the CSS `.line`/`.subline` use the same value).
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const ROW_HEIGHT_PX = diffLineHeightValue
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const NAV_ANCHOR_TOLERANCE_PX = ROW_HEIGHT_PX / 4
  // Quick toolbar toggle between the single-column (unified) and side-by-side
  // (split) views. Persists the choice through the same setting the Settings
  // tab uses, so the two stay in sync and the view survives a reopen.
  const toggleSplitView = (): void => {
    const next = !splitView
    setSplitView(next)
    setSplitMode(next)
    // Switching back to the single-column view mounts a fresh body whose real
    // scrollTop is 0, but the `scrollTop` state is stale. A stale window would
    // render nothing until the next wheel (the rows sit below a huge spacer).
    // Reset the window and re-centre on the focused change block, like opening.
    if (!next) {
      setScrollTop(0)
      setScrollTick(tick => tick + 1)
    }
  }
  // Handle to the split view's imperative block-jump, used to route the shared
  // toolbar/keyboard to it while split mode is active (null in single column).
  const splitDiffRef = useRef<SplitDiffHandle>(null)
  const model = useMemo<RowModel>(() => {
    const diff = computeWholeFileDiff(file.oldText, file.newText)
    // The split view always aligns changed blocks by content similarity and
    // highlights intra-line runs; the single-column view never uses either, so
    // skip the (O(n·m)) computation entirely when split is off.
    const intra = splitView ? computeIntraLineDiff(diff.rows, true) : new Map<number, IntraRun[]>()
    return { diff, blocks: changeBlocksOf(diff), intra }
  }, [file.oldText, file.newText, splitView])
  // The aligned split pairs (only in split mode): used to map a left/right
  // selection to the old/new line numbers for the copy reference.
  const splitPairs = useMemo(() => (
    splitView ? computeSideBySideDiff(model.diff.rows, true).pairs : null
  ), [splitView, model])

  // Inline local Markdown images after the preview body renders. The preview is
  // injected as innerHTML, so `<img src="details/x.png">` keeps its relative
  // path; rewrite it (via the host RPC) to a data URI so it actually renders.
  // Runs whenever the preview mounts, the layout toggles, or the file changes.
  // After inlining, bump the tick so the ruler re-measures the images' true
  // heights (a data URI gives the <img> a real size).
  useEffect(() => {
    if (!previewActive) return
    const body = mdPreviewBodyRef.current
    if (body === null) return
    void resolvePreviewImages(body, file.path, workspacePath, (path) => onPreviewImage(file.sessionId, path))
      .then(() => setMdImageTick(tick => tick + 1))
  }, [previewActive, splitView, file.path, file.sessionId, workspacePath, onPreviewImage])

  // Overview-ruler markers: one per maximal run of same-kind changed rows,
  // positioned as a fraction of the whole file so the scrollbar strip mirrors
  // where each added/deleted run sits. Percentage positioning keeps the strip
  // correct for any diff-body height.
  const rulerMarkers = useMemo(() => {
    const rows = model.diff.rows
    const total = rows.length
    if (total === 0) return []
    const markers: { top: number; height: number; kind: 'del' | 'add' }[] = []
    let runStart = -1
    let runKind: 'del' | 'add' = 'del'
    const flush = (end: number) => {
      const span = end - runStart + 1
      markers.push({ top: (runStart / total) * 100, height: (span / total) * 100, kind: runKind })
    }
    rows.forEach((row, index) => {
      if (row.kind === 'context') {
        if (runStart !== -1) { flush(index - 1); runStart = -1 }
        return
      }
      if (runStart === -1) {
        runStart = index
        runKind = row.kind
      } else if (row.kind !== runKind) {
        flush(index - 1)
        runStart = index
        runKind = row.kind
      }
    })
    if (runStart !== -1) flush(rows.length - 1)
    return markers
  }, [model])

  // Measure the preview's change blocks into ruler markers once the preview is
  // shown and after each re-render/image-inline. Both preview layouts are
  // measured: the double column's rows are aligned, so its cells share the same
  // vertical extent (and a change that renders on both sides contributes both a
  // del and an add marker, exactly like the single column's two stacked runs).
  // Falls back to the source-line `rulerMarkers` when the blocks cannot be laid
  // out (jsdom), so the ruler still appears while keeping height-aware positions
  // in a real browser.
  useLayoutEffect(() => {
    if (!previewActive) return
    const body = mdPreviewBodyRef.current
    if (body === null) return
    const measured = markdownPreviewMarkers(body)
    setMdRulerMarkers(measured.length > 0 ? measured : rulerMarkers)
  }, [previewActive, splitView, file.oldText, file.newText, mdImageTick, rulerMarkers])

  // Syntax highlighting is windowed (see the hook): only the lines near the
  // viewport are tokenized, so opening a large file no longer pays for a
  // whole-file tokenize, and jumping to its middle never tokenizes what is above
  // it. The hook returns runs indexed by line - 1, with holes for lines that have
  // not been reached yet — those render plain, which is what makes scrolling into
  // fresh territory cheap instead of blocking.
  const oldLines = useMemo(() => file.oldText.split('\n'), [file.oldText])
  const newLines = useMemo(() => file.newText.split('\n'), [file.newText])
  // The window store's identity: a new object means new content or a new
  // language, and the hook drops everything highlighted for the previous one.
  const highlightKey = useMemo(() => ({ file: file.id, lang }), [file.id, lang, file.oldText, file.newText])
  // What the split view reports as visible: it owns its own scroller, so its
  // window is the only one that describes what that view is showing.
  const [splitVisible, setSplitVisible] = useState<VisibleLines | undefined>(undefined)

  const bodyRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [hScrollbarPx, setHScrollbarPx] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [selection, setSelection] = useState<RowRange | undefined>(undefined)
  // The Markdown preview has no fixed row grid, so its block frames are placed by
  // measuring the tagged elements and the preview content instead: the hovered
  // block's frame, and the blocks a native selection fully covers (with their own
  // combined frame). The measurement is scroll independent; the live scroll
  // offset is mirrored in a ref so the scroll path can move a frame without a
  // render (and a render for any other reason still places it correctly).
  const [previewFrame, setPreviewFrame] = useState<PreviewFramePlacement | undefined>(undefined)
  const [previewCovered, setPreviewCovered] = useState<number[]>([])
  const [previewSelectionFrame, setPreviewSelectionFrame] = useState<PreviewFramePlacement | undefined>(undefined)
  const previewScrollTopRef = useRef(0)
  const previewHoverFrameRef = useRef<HTMLDivElement>(null)
  const previewSelectionFrameRef = useRef<HTMLDivElement>(null)
  // The query's occurrences inside the rendered preview, in document order. The
  // preview has no rows to map matches onto, so these marks ARE its match list
  // (see the highlight pass). `previewHitCount` mirrors their length in state so
  // the search bar can count them like the code view counts its rows.
  const previewSearchHitsRef = useRef<HTMLElement[]>([])
  const [previewHitCount, setPreviewHitCount] = useState(0)
  // Set when the query changed and the preview's marks are about to be rebuilt:
  // the pass then anchors the current match on what the pane is showing, instead
  // of an index that named a row a moment ago.
  const previewSearchAnchorRef = useRef(false)
  // The flash box for the last jump, and whether one is owed: `bumpFlash` (the
  // code view's own "flash the focused block" signal) marks it pending and the
  // shared landing path turns it into this box, so both views flash on exactly
  // the same events.
  const [previewFlash, setPreviewFlash] = useState<PreviewFlashPlacement | undefined>(undefined)
  const previewFlashRef = useRef<HTMLDivElement>(null)
  const previewFlashPendingRef = useRef(false)
  // The plain text of the last valid (single-line) diff selection, so opening
  // search auto-fills the query even after clicking the search button collapses
  // the native selection.
  const selectionTextRef = useRef<string>('')
  const [copied, setCopied] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const search = useSearchOptions()
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Keys the block-flash overlay; every increment remounts it so the fade-out
  // animation restarts. Bumped on file open/switch and on every jump (even a
  // same-block wrap), so the focused block flashes whenever it is (re)shown.
  const [flashKey, setFlashKey] = useState(0)
  // When the flash is a "boundary pin" (no jump) it shakes; otherwise it fades.
  // Set per-flash by `bumpFlash`, so the overlay's className stays stable for
  // the whole flash and is never flipped mid-animation (which would cut the
  // shake short).
  const pinShakeRef = useRef(false)
  const bumpFlash = (shake: boolean): void => {
    pinShakeRef.current = shake
    setFlashKey(prev => prev + 1)
    // The preview draws the flash itself (from the rendered block, not from
    // rows), so the landing path is told to build one for the block it lands on.
    previewFlashPendingRef.current = true
  }

  // Reset transient viewer state whenever the selected file changes, take
  // keyboard focus into the diff body so the Ctrl+Up/Down block-jump (scoped
  // to the panel) works as soon as a file is shown, and flash the initial
  // block so the user sees where the first change sits. The scroll position is
  // left to the block-centering effect below: it scrolls the first change
  // block into view, and resetting it to 0 here would override that for long
  // files whose first change sits far down.
  useEffect(() => {
    setFocus(0)
    // Bump the centering tick so switching files re-centers even when the
    // focus index is unchanged (0 -> 0); the centering effect keys off this
    // instead of the model, so a content refresh no longer re-centers.
    setScrollTick(tick => tick + 1)
    bodyRef.current?.focus()
    bumpFlash(false)
    setHoveredBlock(undefined)
    setSelection(undefined)
    setLangOverride(undefined)
    setLangMenuOpen(false)
    setCopied(false)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }, [file.id])

  // An undo/redo that touched the currently open file re-selects the undone
  // diff the same way switching to a file does: reset to the first change
  // block, recenter it, and flash it (the highlight box). The panel bumps
  // `undoFlash` when the action's affected id is the open file's.
  useEffect(() => {
    if (undoFlash === 0) return
    setFocus(0)
    setScrollTick(tick => tick + 1)
    bumpFlash(false)
  }, [undoFlash])

  // Old/new line ranges per diff block, for block-level keep/revert.
  const blockRanges = useMemo(() => {
    return model.blocks.map(block => blockRangesOf(model.diff.rows, block))
  }, [model])

  // Blocks fully covered by the current text selection, in order. A selection
  // covering one or more complete blocks shows its own keep/revert frame (the
  // combined range below) in place of the single-block hover frame.
  const coveredBlockIndices = useMemo(() => {
    if (previewActive) return previewCovered
    if (selection === undefined || splitView) return []
    const covered: number[] = []
    for (let index = 0; index < model.blocks.length; index++) {
      const block = model.blocks[index]!
      if (selection.start <= block.start && block.end <= selection.end) covered.push(index)
    }
    return covered
  }, [selection, splitView, model, mdPreview, lang, previewCovered])

  // The combined old/new range spanning the covered blocks (first to last), so
  // keep/revert applies to every covered block in one host call. The preview's
  // covered blocks feed this too, through `coveredBlockIndices`.
  const selectionRange = useMemo(() => {
    if (coveredBlockIndices.length === 0) return undefined
    const firstIndex = coveredBlockIndices[0]
    const lastIndex = coveredBlockIndices[coveredBlockIndices.length - 1]
    if (firstIndex === undefined || lastIndex === undefined) return undefined
    const first = model.blocks[firstIndex]
    const last = model.blocks[lastIndex]
    if (first === undefined || last === undefined) return undefined
    return blockRangesOf(model.diff.rows, { start: first.start, end: last.end })
  }, [coveredBlockIndices, model])

  // In-file search: matching lines over the whole diff (not just the rendered
  // window), so the count and jumps stay correct while the virtual list
  // scrolls. A line counts once however many times the query appears in it.
  const searchMatches = useMemo(() => matchingRows(model.diff.rows, searchQuery, search.options), [model, searchQuery, search.options])
  const searchHitSet = useMemo(() => new Set(searchMatches), [searchMatches])
  const currentSearchRow = searchMatches.length === 0 ? undefined : searchMatches[searchIndex % searchMatches.length]
  // What the search bar counts and steps: the code view's matching rows, or the
  // occurrences the preview actually rendered (a query can match Markdown text
  // that the source diff rows show — and vice versa for markup).
  const searchMatchCount = previewActive ? previewHitCount : searchMatches.length

  /**
   * Measure one frame's placement for a set of change blocks in the Markdown
   * preview. The block's bottom is stored in *content* coordinates (scroll
   * independent), so the scroll path can move the frame without re-measuring or
   * re-rendering — the preview's markdown re-render is far too heavy to run per
   * scroll event.
   *
   * - vertically at the block group's bottom edge, clamped into the pane exactly
   *   like the code view (`pane height - frame height`), so a block near or past
   *   the bottom keeps its actions visible at the pane's bottom edge;
   * - horizontally at the *content's* right edge, because the preview content is
   *   centred under a max width — anchoring to the pane would leave the frame
   *   stranded in the empty margin on a wide panel.
   * @param indices - the block indices the frame acts on.
   * @returns the placement, or undefined when nothing is rendered.
   */
  const previewFrameFor = useCallback((indices: readonly number[]): PreviewFramePlacement | undefined => {
    const body = mdPreviewBodyRef.current
    if (body === null || indices.length === 0) return undefined
    const bodyRect = body.getBoundingClientRect()
    let bottom = -Infinity
    for (const index of indices) {
      for (const element of body.querySelectorAll(`[data-md-block="${index}"]`)) {
        bottom = Math.max(bottom, element.getBoundingClientRect().bottom)
      }
    }
    if (!Number.isFinite(bottom)) return undefined
    const content = body.querySelector('[data-diff-md-preview-content]')
    const contentRight = content === null ? bodyRect.right : content.getBoundingClientRect().right
    previewScrollTopRef.current = body.scrollTop
    return {
      contentBottom: bottom - bodyRect.top + body.scrollTop,
      maxTop: Math.max(0, body.clientHeight - BLOCK_ACTIONS_FRAME_PX),
      right: Math.max(0, bodyRect.right - contentRight) + FRAME_INSET_PX,
    }
  }, [])

  /** One placement's viewport top at a given scroll offset, clamped into the pane. */
  const previewFrameTop = (frame: PreviewFramePlacement | undefined, scrollTop: number): number | undefined =>
    frame === undefined ? undefined : Math.min(Math.max(0, frame.contentBottom - scrollTop - 2), frame.maxTop)

  /** Write one placement onto its element right away, so a scroll tracks the pane
   *  in the same frame as the content instead of waiting for a React render. */
  const applyPreviewFrame = (element: HTMLDivElement | null, frame: PreviewFramePlacement | undefined): void => {
    if (element === null || frame === undefined) return
    const top = previewFrameTop(frame, previewScrollTopRef.current)
    if (top === undefined) return
    element.style.top = `${top}px`
    element.style.right = `${frame.right}px`
  }

  /**
   * Measure the flash box for one preview change block: the union of the block's
   * rendered elements, in content coordinates. The box is the background-diff
   * area itself — the code view's outline spans its pane the same way — so
   * vertically it is the tinted block, and horizontally the widest thing that
   * tint belongs to: its own edge in the single column, and the *aligned row* in
   * the double column, which spans both columns even when the change exists on
   * one side only. The code view derives that from row offsets; rendered
   * Markdown has no rows, so the elements are measured.
   * @param index - the change block to outline.
   * @returns the placement, or undefined when the block is not rendered.
   */
  const previewFlashFor = (index: number): PreviewFlashPlacement | undefined => {
    const body = mdPreviewBodyRef.current
    if (body === null) return undefined
    const bodyRect = body.getBoundingClientRect()
    let top = Infinity
    let bottom = -Infinity
    let left = Infinity
    let right = -Infinity
    for (const element of body.querySelectorAll(`[data-md-block="${index}"]`)) {
      const rect = element.getBoundingClientRect()
      top = Math.min(top, rect.top)
      bottom = Math.max(bottom, rect.bottom)
      const row = element.closest('.mdDoubleRow')
      const span = row === null ? rect : row.getBoundingClientRect()
      left = Math.min(left, span.left)
      right = Math.max(right, span.right)
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return undefined
    return {
      contentTop: top - bodyRect.top + body.scrollTop,
      contentBottom: bottom - bodyRect.top + body.scrollTop,
      // Those edges are the inset: a 2px border drawn border-box lands on them.
      left: Math.max(0, left - bodyRect.left),
      right: Math.max(0, bodyRect.right - right),
    }
  }

  /** One flash's viewport box at a given scroll offset. The block is clamped into
   *  the pane exactly like the code view clamps its rows, so a block taller than
   *  the pane outlines the visible part instead of running past the edge. */
  const previewFlashBox = (flash: PreviewFlashPlacement | undefined, scrollTop: number): { top: number; height: number } | undefined => {
    if (flash === undefined) return undefined
    const paneHeight = mdPreviewBodyRef.current?.clientHeight ?? 0
    const top = Math.max(0, flash.contentTop - scrollTop)
    const bottom = Math.min(paneHeight > 0 ? paneHeight : Number.POSITIVE_INFINITY, flash.contentBottom - scrollTop)
    return { top, height: Math.max(0, bottom - top) }
  }

  /** Write the flash box onto its element right away (the scroll path, so the box
   *  tracks its block for the second it is visible). */
  const applyPreviewFlash = (element: HTMLDivElement | null, flash: PreviewFlashPlacement | undefined): void => {
    if (element === null || flash === undefined) return
    const box = previewFlashBox(flash, previewScrollTopRef.current)
    if (box === undefined) return
    element.style.top = `${box.top}px`
    element.style.height = `${box.height}px`
    element.style.left = `${flash.left}px`
    element.style.right = `${flash.right}px`
  }

  /** Re-place the two action frames at the mirrored scroll offset. */
  const applyPreviewFrames = (): void => {
    applyPreviewFrame(previewHoverFrameRef.current, previewFrame)
    applyPreviewFrame(previewSelectionFrameRef.current, previewSelectionFrame)
  }

  /** Re-place every preview overlay: the frames follow the pointer and the
   *  selection, the flash box the last jump. Only a user scroll uses this — the
   *  landing path re-measures the flash instead, and writing the previous
   *  placement there would stomp the element that React then declines to
   *  rewrite (its style values come out equal, so the write is skipped). */
  const applyPreviewOverlays = (): void => {
    applyPreviewFrames()
    applyPreviewFlash(previewFlashRef.current, previewFlash)
  }

  // Place the preview's hover frame on the hovered block. Re-runs on a content
  // change (a keep/revert rewrites the preview) and after images inline, since
  // both move the block; scrolling is handled imperatively (see `onScroll`).
  useLayoutEffect(() => {
    if (!previewActive) return
    setPreviewFrame(hoveredBlock === undefined ? undefined : previewFrameFor([hoveredBlock]))
  }, [mdPreview, lang, hoveredBlock, file.oldText, file.newText, splitView, mdImageTick, previewFrameFor])

  // Likewise for the selection frame: the last covered block's bottom edge.
  useLayoutEffect(() => {
    if (!previewActive) return
    setPreviewSelectionFrame(previewFrameFor(previewCovered))
  }, [mdPreview, lang, previewCovered, file.oldText, file.newText, splitView, mdImageTick, previewFrameFor])

  // A mode switch starts both preview interactions clean: a hover or a selection
  // from the other view must not carry over onto freshly rendered elements.
  useEffect(() => {
    setHoveredBlock(undefined)
    setPreviewCovered([])
  }, [mdPreview, lang])

  /** The change blocks a live native selection inside the preview fully covers,
   *  in order — the preview's counterpart of the code view's row-range rule. */
  const coveredPreviewBlocks = (): number[] => {
    const body = mdPreviewBodyRef.current
    const live = window.getSelection()
    if (body === null || live === null || live.isCollapsed || live.rangeCount === 0) return []
    const range = live.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) return []
    const covered: number[] = []
    for (let index = 0; index < model.blocks.length; index++) {
      const elements = body.querySelectorAll(`[data-md-block="${index}"]`)
      if (elements.length === 0) continue
      let inside = true
      for (const element of elements) {
        const blockRange = document.createRange()
        blockRange.selectNode(element)
        // The selection must start at or before the block and end at or after it.
        if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) > 0
          || range.compareBoundaryPoints(Range.END_TO_END, blockRange) < 0) {
          inside = false
          break
        }
      }
      if (inside) covered.push(index)
    }
    return covered
  }

  /**
   * Bring one preview block into view. The code view scrolls arithmetically on
   * row offsets; rendered Markdown has no rows to count, so the block's own
   * element is measured instead. Its top edge lands `leadRows` code rows below
   * the pane's top — the same lead the code view leaves — clamped to the scroll
   * range, so a jump always lands the block in the same place (a bare
   * `scrollIntoView({ block: 'nearest' })` left it flush against whichever edge
   * it came from). The settled offset is mirrored into the frames right away: a
   * programmatic `scrollTop` fires `scroll` no earlier than the next task, and
   * the frames must not lag the content.
   * @param index - the change block to bring into view.
   */
  const scrollPreviewBlockIntoView = (index: number): void => {
    const body = mdPreviewBodyRef.current
    if (body === null) return
    const element = body.querySelector(`[data-md-block="${index}"]`)
    if (element === null) return
    const elementTop = element.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
    const maxTop = Math.max(0, body.scrollHeight - body.clientHeight)
    const target = Math.max(0, Math.min(elementTop - leadRows * ROW_HEIGHT_PX, maxTop))
    if (body.scrollTop !== target) body.scrollTop = target
    previewScrollTopRef.current = body.scrollTop
    // Only the frames: the caller re-measures the flash for the block it landed
    // on, and writing the outgoing one here would stomp the element that React
    // then declines to rewrite (equal style values -> the write is skipped).
    applyPreviewFrames()
  }

  /**
   * Bring one preview search occurrence into view. The code view's search rule is
   * reused: a hit that is already fully visible is left alone (a search must not
   * yank the pane off what the user can see), one above the viewport lands with
   * the lead rows above it — the block-jump rule — and one below lands at the
   * bottom edge. The settled offset is mirrored into the frames, as for a jump.
   * @param hit - the highlighted occurrence to reveal.
   */
  const scrollPreviewHitIntoView = (hit: HTMLElement): void => {
    const body = mdPreviewBodyRef.current
    if (body === null) return
    const bodyRect = body.getBoundingClientRect()
    const hitTop = hit.getBoundingClientRect().top - bodyRect.top + body.scrollTop
    const hitBottom = hit.getBoundingClientRect().bottom - bodyRect.top + body.scrollTop
    const viewTop = body.scrollTop
    const viewBottom = viewTop + body.clientHeight
    let target: number | undefined
    if (hitTop - leadRows * ROW_HEIGHT_PX < viewTop) target = hitTop - leadRows * ROW_HEIGHT_PX
    else if (hitBottom > viewBottom) target = hitBottom - body.clientHeight
    if (target === undefined) return
    const maxTop = Math.max(0, body.scrollHeight - body.clientHeight)
    const clamped = Math.max(0, Math.min(target, maxTop))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    previewScrollTopRef.current = body.scrollTop
    applyPreviewOverlays()
  }

  /**
   * Highlight the query inside the rendered preview. The preview's HTML is one
   * sanitized string (a flat blob to React) and re-rendering the Markdown per
   * keystroke is far too heavy, so the matches are wrapped onto the text nodes
   * that are already there — same matcher, same colors as the code view. The
   * wrapped elements become the preview's match list, since rendered Markdown
   * has no rows to map hits onto. A match Markdown split across elements (say
   * `**bo**ld` for `bold`) is not found: matching what is rendered cannot see
   * through the markup, which is the honest trade for highlighting the text the
   * user is actually looking at.
   */
  useLayoutEffect(() => {
    // Undo the previous pass first: React rewrites the content only when the
    // rendered HTML string changes, so marks can outlive the query that made
    // them (a kept block, a toggled option, a closed bar).
    for (const hit of previewSearchHitsRef.current) {
      hit.replaceWith(document.createTextNode(hit.textContent ?? ''))
      hit.parentNode?.normalize()
    }
    previewSearchHitsRef.current = []
    const body = mdPreviewBodyRef.current
    const content = body?.querySelector('[data-diff-md-preview-content]') ?? null
    if (!previewActive || content === null || searchQuery === '') {
      setPreviewHitCount(0)
      return
    }
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node as Text)
    const hits: HTMLElement[] = []
    for (const node of texts) {
      const parent = node.parentElement
      // Rendered code keeps its own text nodes; `<script>`/`<style>` bodies are
      // not user content and must never be searched (or wrapped).
      if (parent === null || parent.closest('script,style') !== null) continue
      const ranges = matchRangesOf(node.data, searchQuery, search.options)
      if (ranges.length === 0) continue
      const marks: HTMLElement[] = []
      // Right to left: wrapping an earlier range would invalidate the offsets of
      // the later ones in the same text node.
      for (let index = ranges.length - 1; index >= 0; index--) {
        const [start, end] = ranges[index]!
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, end)
        const mark = document.createElement('mark')
        mark.className = css.searchMatch ?? ''
        mark.setAttribute('data-diff-search-match', 'hit')
        range.surroundContents(mark)
        marks.push(mark)
      }
      hits.push(...marks.reverse())
    }
    previewSearchHitsRef.current = hits
    setPreviewHitCount(hits.length)
    if (previewSearchAnchorRef.current) {
      previewSearchAnchorRef.current = false
      // Anchor on what the pane is showing (the code view anchors on its viewport
      // top): the first occurrence at or below the top edge, else the first one.
      const bodyTop = body === null ? 0 : body.getBoundingClientRect().top
      const scrollTop = body?.scrollTop ?? 0
      const at = hits.findIndex(hit => hit.getBoundingClientRect().top - bodyTop + scrollTop >= scrollTop - 1)
      setSearchIndex(at === -1 ? 0 : at)
    }
  }, [previewActive, searchQuery, search.options, file.oldText, file.newText, splitView])

  // Paint the current occurrence differently from the other hits. The index is
  // shared with the code view's rows, so it is clamped into this list rather
  // than reset: retyping the query keeps the position roughly where it was.
  useEffect(() => {
    const hits = previewSearchHitsRef.current
    if (!previewActive || hits.length === 0) return
    const current = searchIndex % hits.length
    hits.forEach((hit, index) => {
      const isCurrent = index === current
      hit.className = (isCurrent ? css.searchMatchCurrent : css.searchMatch) ?? ''
      hit.setAttribute('data-diff-search-match', isCurrent ? 'current' : 'hit')
    })
  }, [previewActive, previewHitCount, searchIndex])

  const goSearch = (direction: -1 | 1) => {
    if (previewActive) {
      // The preview's anchoring is viewport-based (done by the highlight pass),
      // so a recorded row cursor has nothing to say here.
      cursorPosRef.current = undefined
      const hits = previewSearchHitsRef.current
      if (hits.length === 0) return
      const next = ((searchIndex % hits.length) + direction + hits.length) % hits.length
      setSearchIndex(next)
      scrollPreviewHitIntoView(hits[next]!)
      return
    }
    if (searchMatches.length === 0) return
    // A just-recorded cursor (a fresh selection made while the bar is open) sets
    // the anchor: land on the selected occurrence first (so "选中这个作为第一个"
    // holds), then subsequent presses advance normally.
    if (cursorPosRef.current !== undefined) {
      setSearchIndex(startIndexFor(searchQuery))
      return
    }
    setSearchIndex(current => (current + direction + searchMatches.length) % searchMatches.length)
  }

  /**
   * The search's start index for `value`. The recorded cursor (the selection, if
   * any) anchors ONE search, then is consumed; after that the current highlight
   * drives subsequent searches, and, with neither set, the viewport top is the
   * start (the "no cursor" fallback).
   */
  const startIndexFor = (value: string): number => {
    const matches = value === '' ? [] : matchingRows(model.diff.rows, value, search.options)
    const pos = cursorPosRef.current
    cursorPosRef.current = undefined // consumed after this search
    if (matches.length === 0) return 0
    // The selected occurrence is the first result when the cursor covers it.
    const inPos = pos === undefined ? -1 : matches.findIndex(i => i >= pos.start && i <= pos.end)
    if (inPos !== -1) return inPos
    const body = bodyRef.current
    const fromRow = pos !== undefined ? pos.start : (currentSearchRow ?? (body === null ? 0 : rowAtY(body.scrollTop)))
    const at = matches.findIndex(i => i >= fromRow)
    return at === -1 ? 0 : at
  }

  // The search's cursor position: the recorded location (a diff selection) that
  // the next search starts from, since a diff has no text caret. Cleared once
  // consumed, and whenever the search bar closes.
  const cursorPosRef = useRef<RowRange | undefined>(undefined)
  // Remembers the range the cursor was last recorded from, so a repeated
  // `selectionchange` for the same lingering selection (e.g. after a focus move)
  // does not re-record it.
  const lastRecordedCursorRef = useRef<RowRange | undefined>(undefined)

  const openSearchWithSelection = () => {
    // Already open: keep the current query and current match, just refocus the
    // box for editing. Re-running the first-search anchoring here would re-read
    // the (now-collapsed) selection / viewport top and recenter an earlier match.
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    // The stored preference wins over this instance's last-known state: the
    // other view's bar may have toggled it since.
    search.sync()
    const live = window.getSelection()
    // Three selection geometries: the split view's rows, the code view's rows,
    // and the preview's covered blocks (which the highlight pass anchors on
    // instead, so neither row mapper applies — it simply yields nothing here).
    const liveRange = splitView && !previewActive ? splitRowRangeOf(live) : rowRangeOf(live)
    // Fall back to the last tracked selection: clicking the search button moves
    // focus and can collapse the live selection before this handler runs.
    const pos = liveRange !== undefined ? liveRange : selection
    cursorPosRef.current = pos
    lastRecordedCursorRef.current = pos
    const liveText = (live?.toString() ?? '').trim()
    const value =
      liveText !== '' && !liveText.includes('\n') ? liveText : selectionTextRef.current
    setSearchQuery(value)
    if (previewActive) {
      // The preview's occurrences are rebuilt after this render; the pass below
      // anchors the current one on what the pane is showing.
      previewSearchAnchorRef.current = true
      setSearchIndex(0)
    } else {
      setSearchIndex(startIndexFor(value)) // consumes the cursor
    }
    setSearchOpen(true)
    // Focus after the bar mounts (it is conditionally rendered).
    requestAnimationFrame(() => { searchInputRef.current?.focus(); searchInputRef.current?.select() })
  }
  const openSearchRef = useRef(openSearchWithSelection)
  openSearchRef.current = openSearchWithSelection
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen
  /** Run one bar control's action, then hand the focus back to the query box:
   *  the bar's chords are scoped to the box (its Esc to the bar), so a mouse
   *  click on a bar button must not leave them dead on the button it landed on. */
  const andRefocus = (action: () => void): void => {
    action()
    searchInputRef.current?.focus()
  }
  const toggleSearch = () => {
    // In split mode the single-column bar is not mounted, so the shared button
    // must drive the split view's own bar instead of this component's state.
    // The preview's double column is still this component's bar (there is no
    // split view mounted under it).
    if (splitView && !previewActive) {
      splitDiffRef.current?.toggleSearch()
      return
    }
    if (searchOpen) {
      cursorPosRef.current = undefined
      lastRecordedCursorRef.current = undefined
      setSearchOpen(false)
      setSearchQuery('')
      setSearchIndex(0)
    } else {
      openSearchWithSelection()
    }
  }
  const closeSearch = () => {
    cursorPosRef.current = undefined
    lastRecordedCursorRef.current = undefined
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }

  // Focus the query box each time the search bar opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // Bring the current search match into view, but never recenter when it is
  // already inside the viewport: a search shouldn't yank the scroll position if
  // the match is already visible.
  useLayoutEffect(() => {
    const row = currentSearchRow
    if (row === undefined) return
    const body = bodyRef.current
    if (body === null) return
    if (body.clientHeight <= 0) return
    const viewTop = body.scrollTop
    const viewBottom = viewTop + body.clientHeight
    const rowTop = offsetOf(row)
    const rowBottom = rowTop + extentOf(row, row)
    let target: number | undefined
    if (rowTop < viewTop) target = rowTop
    else if (rowBottom > viewBottom) target = rowBottom - body.clientHeight
    if (target === undefined) return
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
  }, [currentSearchRow, searchMatches])

  // Row index -> block index, so hovering any row of a block shows its actions.
  const blockIndexByRow = useMemo(() => {
    const map = new Map<number, number>()
    model.blocks.forEach((block, blockIndex) => {
      for (let index = block.start; index <= block.end; index++) map.set(index, blockIndex)
    })
    return map
  }, [model])

  const onRowHover = useCallback((index: number) => {
    setHoveredBlock(blockIndexByRow.get(index))
  }, [blockIndexByRow])

  // Virtual window over the fixed-height diff rows: only rows near the viewport
  // render, so a huge file never mounts tens of thousands of nodes. An unmounted
  // or jsdom scroller (no height) falls back to rendering the whole file.
  const rows = model.diff.rows
  const rowCount = rows.length
  // When auto-wrap is on, each diff row becomes one or more visual sub-lines
  // computed here the way VSCode wraps text (break at words, split overlong
  // words, tab stops). The row's height is then `subLines.length * 22` by
  // construction — the browser never re-wraps, so the prefix sum cannot drift.
  // `rowWrapped` feeds both the heights and the rendered sub-lines. Off wrap,
  // both stay null and the fixed-22px model is used.
  const rowWrapped = useMemo(() => {
    if (!langWrap || bodyWidth === 0) return null
    const measure = makeMeasurer(codeFontOf())
    if (measure === undefined) return null
    const charWidth = measure('0')
    // One-char safety margin keeps a sub-line from clipping on a sub-pixel
    // difference between canvas metrics and the DOM's actual glyph advance.
    const wrapping = bodyWidth - WRAP_GUTTERS_PX - charWidth
    const tabPx = tabWidthSpaces * measure(' ')
    return rows.map(row => wrapInto(row.text, wrapping, measure, tabPx))
  }, [langWrap, bodyWidth, rows, tabWidthSpaces])
  const rowHeights = useMemo(() => {
    if (rowWrapped === null) return null
    return rowWrapped.map(lines => lines.length * ROW_HEIGHT_PX)
  }, [rowWrapped])
  const rowOffsets = useMemo(() => {
    if (rowHeights === null) return null
    const offs = new Array<number>(rowHeights.length + 1)
    offs[0] = 0
    for (let i = 0; i < rowHeights.length; i++) offs[i + 1] = offs[i]! + rowHeights[i]!
    return offs
  }, [rowHeights])
  const totalHeight = rowOffsets === null ? rowCount * ROW_HEIGHT_PX : (rowOffsets[rowCount] ?? 0)
  const offsetOf = (index: number): number => {
    if (rowOffsets === null) return index * ROW_HEIGHT_PX
    const i = Math.max(0, Math.min(index, rowCount))
    return rowOffsets[i] ?? 0
  }
  const extentOf = (from: number, to: number): number => {
    if (rowOffsets === null) return (to - from + 1) * ROW_HEIGHT_PX
    return Math.max(0, offsetOf(to + 1) - offsetOf(from))
  }
  const rowAtY = (y: number): number => {
    if (rowOffsets === null) return Math.floor(y / ROW_HEIGHT_PX)
    if (y <= 0) return 0
    let lo = 0
    let hi = rowCount
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (rowOffsets[mid]! <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const viewport = viewportHeight > 0 ? viewportHeight : totalHeight
  let start = Math.max(0, rowAtY(scrollTop) - OVERSCAN_ROWS)
  let end = Math.min(rowCount, rowAtY(scrollTop + viewport) + OVERSCAN_ROWS)
  // Keep the user's text selection rendered even when it scrolls out of the
  // viewport window: virtualization would otherwise unmount the selected rows,
  // and the browser's native Selection (whose anchor/focus reference those nodes)
  // would be invalidated — the highlight comes back garbled. Pin the window to
  // the selection so it survives a scroll out and back.
  if (selection !== undefined) {
    start = Math.min(start, selection.start)
    end = Math.max(end, selection.end + 1)
  }
  const visibleRows = rows.slice(start, end)

  // The source lines that window covers on each side, so the highlighter works on
  // exactly what is on screen (plus its own margins). One side can be missing
  // entirely — a window of pure additions shows nothing from the old side.
  const oldWindow = useMemo(() => windowLineRange(rows, start, end, 'old'), [rows, start, end])
  const newWindow = useMemo(() => windowLineRange(rows, start, end, 'new'), [rows, start, end])
  // The split view has its own scroller and its own virtual window, so it reports
  // what it is showing instead — the single-column window above means nothing to it.
  const onSplitVisibleLines = useCallback((visible: VisibleLines): void => { setSplitVisible(visible) }, [])
  const runs = useWindowedHighlight({
    key: highlightKey,
    oldLines,
    newLines,
    lang,
    oldRange: splitView ? splitVisible?.oldRange : oldWindow,
    newRange: splitView ? splitVisible?.newRange : newWindow,
    // The idle backfill needs a real viewport: without one there is nothing to
    // prefetch toward (and jsdom, which reports none, stays deterministic).
    live: splitView ? splitVisible?.live ?? false : viewportHeight > 0,
  })

  // The floating Keep/Revert frame anchors to the hovered block's bottom edge.
  // It lives in the non-scrolling wrapper (viewport coordinates), so subtract
  // scrollTop, and clamp it so its own bottom never passes the visible diff
  // area's bottom (`viewportHeight - FRAME_PX`) — a block near the viewport
  // bottom would otherwise push the frame off into the status bar/composer.
  // Never clamps past 0.
  const blockEnd = hoveredBlock === undefined ? undefined : model.blocks[hoveredBlock]?.end
  const blockActionsTop = blockEnd === undefined
    ? 0
    : Math.max(0, Math.min(offsetOf(blockEnd + 1) - scrollTop - 2, Math.max(0, viewportHeight - BLOCK_ACTIONS_FRAME_PX)))

  // The selection frame anchors to the last covered block's bottom edge — the
  // same spot that block's own hover frame would use.
  const selectionBlockEnd = ((): number | undefined => {
    if (coveredBlockIndices.length === 0) return undefined
    const lastIndex = coveredBlockIndices[coveredBlockIndices.length - 1]
    if (lastIndex === undefined) return undefined
    return model.blocks[lastIndex]?.end
  })()
  const selectionActionsTop = selectionBlockEnd === undefined
    ? 0
    : Math.max(0, Math.min(offsetOf(selectionBlockEnd + 1) - scrollTop - 2, Math.max(0, viewportHeight - BLOCK_ACTIONS_FRAME_PX)))

  // Widest line in the file, in characters: pins the table's width so the
  // added/deleted tint spans the same width at every scroll position (the
  // rendered window's own widest line alone would make it jump).
  const widestLine = useMemo(() => {
    let widest = 0
    for (const row of model.diff.rows) {
      if (row.text.length > widest) widest = row.text.length
    }
    return widest
  }, [model])

  // Measure the scroller's viewport once it mounts and on resize, so the
  // render window tracks the visible area. `splitView` and `previewActive` are
  // deps so toggling off the split view or the Markdown preview re-measures the
  // fresh body (otherwise the stale viewportHeight would leave the window wrong
  // until a scroll).
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const measure = () => { setViewportHeight(body.clientHeight) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    return () => { observer?.disconnect() }
  }, [file.id, splitView, previewActive])

  // Measure the code scroll box's width so wrapped line heights can be computed.
  // Re-measure immediately on resize so a drag re-wraps live. ResizeObserver
  // already delivers at most one callback per frame, so "immediate" here is
  // per-frame, not per-pixel — no extra coalescing is needed. Also track the
  // horizontal scrollbar's height so the overview ruler stops above it.
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const measure = () => {
      setBodyWidth(body.clientWidth)
      setHScrollbarPx(Math.max(0, body.offsetHeight - body.clientHeight))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    return () => { observer?.disconnect() }
  }, [file.id, langWrap, previewActive])

  // Scroll the focused change block into view after focus, content changes, or
  // a jump. The block's top edge lands two rows below the viewport top so a
  // little context stays visible above it; near the top or bottom the scroll
  // clamps to the scrollable range instead. Arithmetic on the fixed row height
  // works even when the block's rows are outside the rendered window. A
  // programmatic scrollTop does not fire a scroll event, so the DOM write is
  // mirrored into state to re-render the window; onScroll covers real user
  // scrolling. Layout timing matters: the block-flash overlay reads scrollTop
  // while rendering, so the scroll must settle BEFORE the browser paints —
  useLayoutEffect(() => {
    if (rowCount === 0) return
    const block = model.blocks[focus]
    if (block === undefined) return
    // The preview replaces the code body, so there is no scroll box to move and
    // no rows to compute with: the rendered block element is scrolled instead.
    // This is the shared landing path of every jump — the toolbar's prev/next,
    // the Ctrl+Up/Down chords, a re-click on the open file in the list, and the
    // focus move a keep/revert leaves behind.
    if (previewActive) {
      scrollPreviewBlockIntoView(focus)
      // A jump also flashes the block it landed on — the same outline the code
      // view draws around its focused block. `bumpFlash` marks the flash pending
      // and this landing path builds it from the rendered block.
      if (previewFlashPendingRef.current) {
        previewFlashPendingRef.current = false
        setPreviewFlash(previewFlashFor(focus))
      }
      return
    }
    const body = bodyRef.current
    if (body === null) return
    // Leave the configured lead rows above the block's top edge; when the block
    // is too close to the top or bottom to afford it, clamp to the scroll range.
    const target = offsetOf(block.start) - leadRows * ROW_HEIGHT_PX
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
    // Re-run once when wrapped offsets go from "not measured yet" to ready, so
    // an open-with-wrap-on file centers on the block's real (wrapped) offset
    // instead of the initial fixed-22px guess. `rowOffsets === null` flips only
    // on the readiness transition, not on every resize re-measure.
    // The `focus` is deliberately NOT a dep: a scroll re-anchors `focus` to the
    // block under the viewport (see `onScroll`), and that must NOT recenter and
    // fight the user's scroll. Only a jump/keep/switch (which bump `scrollTick`)
    // recenters the focused block.
    // NOTE: `model`/`rowCount` are deliberately NOT deps — a content refresh
    // would otherwise re-center the view and lose the user's scroll position.
  }, [scrollTick, rowOffsets === null, previewActive])

  // At the wrap boundary (last block + down, first block + up) a guarded press
  // (keyboard or toolbar) only toasts; the next press in the same direction
  // wraps. Armed direction = 0.
  const wrapArmedRef = useRef<0 | -1 | 1>(0)
  const jump = (direction: -1 | 1, wrapGuard = false, singleToast = wrapGuard) => {
    if (rowCount === 0) return
    const count = model.blocks.length
    if (count === 0) return
    // Boundary guard. A single block has nothing to wrap to, so it just toasts;
    // with several blocks, a boundary press toasts and the next press in the
    // same direction wraps.
    if (wrapGuard) {
      if (count === 1) {
        if (singleToast) onToast(t('panel.blockSingle'))
      } else {
        const atBoundary = (direction === 1 && focus === count - 1)
          || (direction === -1 && focus === 0)
        if (atBoundary) {
          // Toast only on the press that does NOT jump; the next press wraps.
          if (wrapArmedRef.current !== direction) {
            wrapArmedRef.current = direction
            onToast(t(direction === 1 ? 'panel.blockAtEnd' : 'panel.blockAtStart'))
            // Flash the current block with a shake to show it is pinned here.
            bumpFlash(true)
            return
          }
          wrapArmedRef.current = 0
        } else {
          wrapArmedRef.current = 0
        }
      }
    }
    // The next block in `direction`. Backwards is a plain step; forwards skips
    // the blocks already scrolled out above the viewport, so the walk follows
    // what the user is looking at rather than a stale pointer. The preview has
    // no code viewport (`bodyRef` is null), so `top` reads 0 there and this
    // degrades to a plain forward step over the rendered block order.
    const targetOf = (current: number): number => {
      if (direction === -1) {
        return (current - 1 + count) % count
      }
      const top = bodyRef.current?.scrollTop ?? 0
      // Forward scan without wrapping: land on the first block at or below
      // the viewport top (blocks scrolled out above are skipped).
      for (let index = current + 1; index < count; index++) {
        const block = model.blocks[index]
        if (block === undefined) continue
        if (offsetOf(block.start) >= top) return index
      }
      // Past the last block — wrap to the first.
      return 0
    }
    const landed = targetOf(focus)
    setFocus(landed)
    // Bump the centering effect even when the focus is unchanged (a single
    // block), so an out-of-view block is always scrolled back into view, and
    // re-flash the block (its key changes -> the overlay remounts) so the
    // fade-out replays when the same block is selected again.
    setScrollTick(tick => tick + 1)
    bumpFlash(false)
  }

  // Block jump the shared toolbar/keyboard/jumpSignal use. In split mode the
  // single-column `jump` below has no body to drive (its `bodyRef` is null), so
  // delegate to the split view's own imperative jump; otherwise use the
  // single-column one. The preview's double column is NOT the split view — it is
  // this component's own rendering, with no split view mounted under it — so it
  // jumps through `jump` like the single-column preview. Kept in a ref so the
  // capture-phase keydown listener always sees the current closure.
  const jumpBlock = (direction: -1 | 1, wrapGuard = false, singleToast = wrapGuard): void => {
    if (splitView && !previewActive) {
      splitDiffRef.current?.jump(direction, wrapGuard, singleToast)
      return
    }
    jump(direction, wrapGuard, singleToast)
  }
  const jumpBlockRef = useRef(jumpBlock)
  jumpBlockRef.current = jumpBlock

  // Step the hovered block's floating actions frame to the adjacent diff block
  // (wrapping). Both the hovered block (the frame follows it) and the focused
  // block (which recenters and re-flashes) advance together; the shared
  // centering effect is what scrolls the code view — or the preview — to it.
  const stepBlock = (direction: -1 | 1): void => {
    const count = model.blocks.length
    if (count === 0) return
    const base = hoveredBlock ?? focus
    const target = (base + direction + count) % count
    setHoveredBlock(target)
    setFocus(target)
    setScrollTick(tick => tick + 1)
    bumpFlash(false)
  }

  // Run one block (or combined multi-block) keep/revert, then advance focus to
  // the next change block: the operated block(s) leave the list, so the next
  // block shifts into the `operated` slot, and focusing that slot recenters and
  // flashes the following change. Shared by the hover frame and the selection
  // frame so the two stay aligned.
  const runBlockAction = async (action: 'keep' | 'revert', range: DiffApprovalBlockRange, operated: number): Promise<void> => {
    await (action === 'keep'
      ? onBlockKeep(file.sessionId, file.id, range)
      : onBlockRevert(file.sessionId, file.id, range))
    const count = model.blocks.length
    if (count === 0) return
    const next = Math.max(0, Math.min(operated, count - 1))
    setFocus(next)
    setHoveredBlock(undefined)
    setScrollTick(tick => tick + 1)
    bumpFlash(false)
  }

  const handleBlockAction = async (action: 'keep' | 'revert'): Promise<void> => {
    if (busy || hoveredBlock === undefined) return
    const operated = hoveredBlock
    const range = blockRanges[operated]!
    await runBlockAction(action, range, operated)
  }

  // Keep/revert every block covered by the current text selection in one
  // combined host call (the covered blocks are contiguous); the shared post-
  // action logic then advances focus to the next change block. The operated
  // blocks leave the diff, so their old row-range selection no longer maps to
  // real rows — clear it (and the native highlight) once the action settles, or
  // the stale selection lingers offset against the now-smaller diff.
  const handleSelectionAction = async (action: 'keep' | 'revert'): Promise<void> => {
    if (busy || selectionRange === undefined) return
    const firstCovered = coveredBlockIndices[0]
    if (firstCovered === undefined) return
    await runBlockAction(action, selectionRange, firstCovered)
    setSelection(undefined)
    setPreviewCovered([])
    window.getSelection()?.removeAllRanges?.()
  }

  // Re-clicking the already-open file in the list jumps to the next change
  // block; the panel bumps `jumpSignal` to trigger it. A fresh signal while
  // on the same file re-runs this, wrapping to the first block when needed.
  // This is a mouse "jog the highlight" gesture: keep the multi-block boundary
  // toast/wrap, but a single-block file must NOT toast "仅有一个差异块" (which
  // would fire on what reads as a plain open) — it just re-flashes the block.
  useEffect(() => {
    if (jumpSignal === 0) return
    jumpBlock(1, true, false)
  }, [jumpSignal])

  const onScroll = () => {
    const body = bodyRef.current
    if (body === null) return
    setScrollTop(body.scrollTop)
    setViewportHeight(body.clientHeight)
    // Re-anchor the "current diff" (`focus`) to the block under the viewport
    // anchor, so a manual scroll updates which block prev/next walk from instead
    // of a stale last-jumped-to block. Updating focus does NOT recenter — the
    // centering effect keys off `scrollTick`, not `focus` — so this never fights
    // the user's scroll. This only runs on real user scrolls: programmatic
    // recenters set scrollTop directly and do NOT fire a scroll event.
    const count = model.blocks.length
    if (rowCount === 0 || count === 0) return
    // Edge-clamp: when the scroller is pinned to the top or bottom, the "current"
    // block is the first/last change block, not the one at the anchor — the first
    // block can sit below the anchor at the top, and the last block's `start` sits
    // below the anchor when clamped to the bottom, so the anchor lookup would pick
    // the neighboring block and pull focus off-by-one after a boundary wrap. Only
    // with a real viewport (jsdom has no layout, heights read 0).
    let ref = -1
    if (body.clientHeight > 0) {
      const viewportBottom = body.scrollTop + body.clientHeight
      if (body.scrollTop <= NAV_ANCHOR_TOLERANCE_PX) ref = 0
      else if (body.scrollHeight - viewportBottom <= NAV_ANCHOR_TOLERANCE_PX) ref = count - 1
    }
    if (ref === -1) {
      const anchor = body.scrollTop + leadRows * ROW_HEIGHT_PX
      for (let index = 0; index < count; index++) {
        const block = model.blocks[index]
        if (block !== undefined && offsetOf(block.start) <= anchor + NAV_ANCHOR_TOLERANCE_PX) ref = index
      }
    }
    setFocus(ref === -1 ? 0 : ref)
  }

  // Track the native text selection inside the diff: the copy-reference
  // toolbar appears once lines are selected and hides when the selection
  // collapses. The toolbar's own mousedown prevents the default so the
  // selection survives the click that triggers the copy.
  useEffect(() => {
    const update = () => {
      // The preview renders Markdown, not diff rows: its selection resolves to
      // the change blocks it fully covers (the same rule as below) rather than a
      // row range, and only the preview owns the selection then.
      if (previewActive) {
        setPreviewCovered(coveredPreviewBlocks())
        selectionTextRef.current = ''
        return
      }
      const live = window.getSelection()
      const range = splitView ? splitRowRangeOf(live) : rowRangeOf(live)
      // Only serialize the selected text when there is a real in-diff selection;
      // jsdom fires `selectionchange` repeatedly during a large render and
      // `Selection#toString()` is expensive to run for every event.
      let text = ''
      if (range !== undefined) {
        const raw = live?.toString() ?? ''
        text = raw !== '' && !raw.includes('\n') ? raw.trim() : ''
      }
      selectionTextRef.current = text
      setSelection(range)
      // While the search bar is open, a fresh single-line diff selection records
      // the cursor (the position the next search starts from). The query is
      // deliberately left unchanged — matching a mature find box. A repeated
      // `selectionchange` for the same range is skipped.
      const last = lastRecordedCursorRef.current
      const sameRange =
        last !== undefined && range !== undefined && last.start === range.start && last.end === range.end
      if (searchOpenRef.current && range !== undefined && text !== '' && !sameRange) {
        lastRecordedCursorRef.current = range
        cursorPosRef.current = range
      }
    }
    document.addEventListener('selectionchange', update)
    update()
    return () => { document.removeEventListener('selectionchange', update) }
  }, [file.id, splitView, mdPreview, lang])

  // Override copy so auto-wrap's visual line breaks never leak into the
  // clipboard: rebuild the selected plain text (join a wrapped line's sub-lines
  // back together) instead of the browser's block-newline text. Only active
  // when the selection is inside a code cell of this diff.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent): void => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode
      const inCode = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest('[data-diff-code]') !== null
      if (!inCode) return
      const text = selectedPlainText()
      if (text === undefined) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', text)
    }
    document.addEventListener('copy', onCopy)
    return () => { document.removeEventListener('copy', onCopy) }
  }, [])

  // The reference for the current selection. The `(path:range)` payload is what
  // actually gets copied / pasted (parens keep the rematch precise); the status
  // bar copy control shows the same reference without the wrapping parens.
  const selectionReferenceLabel = (() => {
    if (selection === undefined) return undefined
    if (splitView) {
      if (selection.side === undefined || splitPairs === null) return undefined
      const lineNumbers: number[] = []
      for (let index = selection.start; index <= selection.end; index++) {
        const pair = splitPairs[index]
        if (pair === undefined) continue
        const line = selection.side === 'old' ? pair.left?.line : pair.right?.line
        if (line !== undefined) lineNumbers.push(line)
      }
      if (lineNumbers.length === 0) return undefined
      return referenceLabelOf(file.path, workspacePath, Math.min(...lineNumbers), Math.max(...lineNumbers))
    }
    const rows = model.diff.rows.slice(selection.start, selection.end + 1)
    // Only the new (current) file's lines are referenceable: removed lines
    // have no current-side number, so they contribute nothing to the range.
    const lineNumbers = rows
      .map(row => row.newLine)
      .filter((number): number is number => number !== undefined)
    if (lineNumbers.length === 0) return undefined
    return referenceLabelOf(file.path, workspacePath, Math.min(...lineNumbers), Math.max(...lineNumbers))
  })()
  const selectionReference = selectionReferenceLabel === undefined ? undefined : `(${selectionReferenceLabel})`

  const copySelection = useCallback(async () => {
    if (selectionReference === undefined) return
    // "Auto-paste to composer" (Settings → this plugin) takes the whole action:
    // paste the reference into the composer and skip the clipboard write and the
    // toast. Off, the reference is copied to the clipboard and a toast confirms
    // it. The preference is read at copy time so a change takes effect without
    // reopening the panel.
    if (pasteOnCopyEnabled()) {
      onPasteReference(file.sessionId, selectionReference)
      return
    }
    const accepted = await writeClipboard(selectionReference)
    if (!accepted) return
    setCopied(true)
    onToast(t('action.copied'))
    window.setTimeout(() => { setCopied(false) }, 1500)
  }, [file.sessionId, onPasteReference, onToast, selectionReference, t])

  // Ctrl/Cmd+L copies the selected line range. The detail pane is mounted
  // only while a file is open, so the chord is global while the diff is shown
  // (the reference copy works from anywhere, no focus scope); it is left to
  // the browser's own default when there is no selection to reference.
  //
  // TODO(editable code view): if the editable surface ever needs its own
  // Ctrl+L, revisit this global interception.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, keybindingOf('copyRef'))) return
      if (selectionReference === undefined) return
      event.preventDefault()
      void copySelection()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [copySelection])

  // Ctrl/Cmd+F opens the search bar and focuses its query box. The detail
  // pane is mounted only while a file is open, so this intercepts globally
  // while the diff is shown — browser find stays available whenever no file
  // is open. Window capture is the earliest interception point, so nothing
  // inside the harness (the code view is read-only and never holds focus) can
  // swallow the chord; re-hitting it while open re-focuses and selects the
  // query for retyping.
  //
  // TODO(editable code view): once the diff becomes an editable surface that
  // can hold focus, scope this interception back to the panel (or to the
  // open search bar) instead of hijacking Ctrl+F globally, so the browser's
  // native find is available again elsewhere in the harness.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, keybindingOf('openSearch'))) return
      // The add-path dialog is a modal this panel owns.
      if (pathPickerOpen()) return
      event.preventDefault()
      // In split mode the single-column search bar isn't mounted; route to the
      // split view's own search bar instead. The preview has no split view (its
      // double column is another preview mode), so its bar is this one.
      if (splitView && !previewActive) { splitDiffRef.current?.openSearch(); return }
      openSearchRef.current?.()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [searchOpen, splitView])

  // F3 / Shift+F3 step the search to the next/previous match while the caret is
  // in the plugin's own search box (leaving F3 to the browser's find — and to the
  // composer — anywhere else). Routed to the split view's search in split mode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchInputEvent(event)) return
      let direction: -1 | 1 | 0 = 0
      if (matchesShortcut(event, keybindingOf('searchNext'))) direction = 1
      else if (matchesShortcut(event, keybindingOf('searchPrev'))) direction = -1
      if (direction === 0) return
      if (splitView && !previewActive) {
        if (splitDiffRef.current?.searchNext(direction)) event.preventDefault()
        return
      }
      if (searchOpen && searchMatchCount > 0) {
        event.preventDefault()
        goSearch(direction)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [searchOpen, searchMatches, searchMatchCount, splitView, previewActive])

  // Alt+C / Alt+W toggle the two search narrowing options — the chords VS Code's
  // find widget uses. Scoped to the query box, like the step chords: only the
  // box's own caret turns them on, so the chord stays free for whatever else has
  // focus. Each bar owns its own state, so this routes to the split view's bar in
  // split mode; only an actually-open bar consumes the chord.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchInputEvent(event)) return
      const option = matchesShortcut(event, keybindingOf('matchCase')) ? 'case'
        : matchesShortcut(event, keybindingOf('matchWholeWord')) ? 'word'
          : undefined
      if (option === undefined) return
      if (splitView && !previewActive) {
        const handle = splitDiffRef.current
        const acted = option === 'case' ? handle?.toggleMatchCase() === true : handle?.toggleMatchWholeWord() === true
        if (acted) event.preventDefault()
        return
      }
      if (!searchOpen) return
      event.preventDefault()
      if (option === 'case') search.toggleCase()
      else search.toggleWord()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [searchOpen, splitView, previewActive, search])

  // Esc closes the open search bar — the innermost thing to dismiss — for a press
  // from inside the panel, wherever the focus sits there (the query box, one of
  // the bar's buttons, the diff around it). A press from outside the panel is not
  // the bar's to take: it belongs to the panel's own Esc, which dismisses the
  // panel outright (the chat composer above all, which also keeps its own Esc).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isInPanelEvent(event)) return
      // The add-path dialog is a modal this panel owns: it closes itself on
      // Escape, so the search bar underneath must not claim the press.
      if (pathPickerOpen()) return
      // The preview mounts this component's own bar (there is no split view under
      // it, even in its double-column mode), so the press is the bar's to take.
      // The split view owns its own bar, which this component's `searchOpen` does
      // not describe, so it is asked before that state is consulted.
      if (!previewActive && splitView) {
        // Report whether the bar was actually open, so a closed one leaves the
        // press to the panel's own Esc instead of swallowing it.
        if (splitDiffRef.current?.closeSearch() === true) event.preventDefault()
        return
      }
      if (!searchOpen) return
      event.preventDefault()
      closeSearch()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [searchOpen, splitView, previewActive])

  // Ctrl+Up/Down jumps between change blocks. The detail pane is mounted only
  // while a file is open, so this intercepts globally while the diff is shown
  // — the code view is read-only and never reliably holds focus (after any
  // panel interaction the focus sits on the body), so a panel scope would make
  // the chord dead right after an action. Window capture beats any inner
  // handler; text inputs (the composer, the search box) keep their own
  // Ctrl+Up/Down cursor moves.
  //
  // TODO(editable code view): once the diff becomes an editable surface that
  // can hold focus, scope this back to the panel so the composer's own chords
  // are restored everywhere else.
  const jumpRef = useRef(jumpBlock)
  jumpRef.current = jumpBlock
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      let direction: -1 | 1 | 0 = 0
      if (matchesShortcut(event, keybindingOf('jumpUp'))) direction = -1
      else if (matchesShortcut(event, keybindingOf('jumpDown'))) direction = 1
      if (direction === 0) return
      if (pathPickerOpen()) return
      if (isTextFieldEvent(event)) return
      event.preventDefault()
      jumpRef.current(direction, true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  const focusedBlock = model.blocks.length > 0 ? model.blocks[focus] : undefined
  const inFocusedBlock = (index: number): boolean =>
    focusedBlock !== undefined && index >= focusedBlock.start && index <= focusedBlock.end
  // The flash's width: `clientWidth` already ends at a real vertical scrollbar,
  // so when one is present no adjustment is needed; without one, the ruler's
  // own width is reserved so the box never overlaps it.
  const flashWidth = (() => {
    const scroller = bodyRef.current
    if (scroller === null) return 0
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth
    return Math.max(0, scroller.clientWidth - (scrollbarWidth > 0 ? 0 : OVERVIEW_RULER_WIDTH_PX))
  })()
  // The flash is absolutely positioned inside `.diffBody` (the scroll box); it
  // is fixed relative to that box and does NOT scroll with the in-flow rows.
  // So `top = contentOffset - scrollTop` (viewport coordinates), clamped to the
  // block's intersection with the viewport — a tall block scrolled into never
  // draws a box past the top edge, and still fills the visible area.
  const flashTop = focusedBlock === undefined
    ? 0
    : Math.max(0, offsetOf(focusedBlock.start) - scrollTop)
  const flashBottom = focusedBlock === undefined
    ? 0
    : Math.min(viewportHeight > 0 ? viewportHeight : Number.POSITIVE_INFINITY, offsetOf(focusedBlock.end + 1) - scrollTop)
  const flashHeight = Math.max(0, flashBottom - flashTop)

  // The preview's flash box at the mirrored scroll offset; a scroll re-places it
  // imperatively (see `applyPreviewOverlays`), exactly like the frames.
  const previewFlashNow = previewActive ? previewFlashBox(previewFlash, previewScrollTopRef.current) : undefined

  // The search bar, shared by the code view and the preview: each mounts it in
  // its own positioned wrapper (the query box, its chords and its state are the
  // same either way). Only the count differs — the preview counts the
  // occurrences it rendered, the code view counts matching rows.
  const searchBar = searchOpen ? (
    <div className={css.searchBar} data-diff-searchbar>
      <input
        ref={searchInputRef}
        className={css.searchInput}
        data-diff-search-input
        value={searchQuery}
        placeholder={t('panel.searchPlaceholder')}
        onChange={(event) => {
          const value = event.target.value
          setSearchQuery(value)
          if (previewActive) {
            // The preview's occurrences are wrapped after this render; that pass
            // anchors the current one on what the pane is showing.
            previewSearchAnchorRef.current = true
            setSearchIndex(0)
            return
          }
          // Anchor from the recorded cursor if one is pending, else the
          // current highlight, else the viewport top (no cursor).
          setSearchIndex(startIndexFor(value))
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            goSearch(event.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className={css.searchCount} data-diff-search-count>
        {searchMatchCount === 0
          ? '0/0'
          : `${(searchIndex % searchMatchCount) + 1}/${searchMatchCount}`}
      </span>
      <Tooltip label={withChord(t('action.matchCase'), 'matchCase')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={search.caseSensitive ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
          data-diff-search-case
          data-on={search.caseSensitive ? '' : undefined}
          aria-label={t('action.matchCase')}
          aria-pressed={search.caseSensitive}
          onClick={() => { andRefocus(() => { search.toggleCase() }) }}
        >
          <SearchOptionIcon kind="case" />
        </button>
      </Tooltip>
      <Tooltip label={withChord(t('action.matchWholeWord'), 'matchWholeWord')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={search.wholeWord ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
          data-diff-search-word
          data-on={search.wholeWord ? '' : undefined}
          aria-label={t('action.matchWholeWord')}
          aria-pressed={search.wholeWord}
          onClick={() => { andRefocus(() => { search.toggleWord() }) }}
        >
          <SearchOptionIcon kind="word" />
        </button>
      </Tooltip>
      <Tooltip label={withChord(t('action.prevDiff'), 'searchPrev')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-search-prev
          aria-label={t('action.prevDiff')}
          disabled={searchMatchCount === 0}
          onClick={() => { andRefocus(() => { goSearch(-1) }) }}
        >
          <IconChevronUpOutline14 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={withChord(t('action.nextDiff'), 'searchNext')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-search-next
          aria-label={t('action.nextDiff')}
          disabled={searchMatchCount === 0}
          onClick={() => { andRefocus(() => { goSearch(1) }) }}
        >
          <IconChevronDownOutline14 size={14} />
        </button>
      </Tooltip>
      <button
        type="button"
        className={`${css.action} ${css.iconAction}`}
        data-diff-search-close
        aria-label={t('action.close')}
        onClick={closeSearch}
      >
        <IconCloseOutline16 size={14} />
      </button>
    </div>
  ) : null

  return (
    <div
      className={css.diff}
      data-diff-approval-diff
      style={diffViewVars as unknown as CSSProperties}
    >
      <div className={css.diffHeader} data-diff-toolbar>
        <span className={css.diffPath}>{file.path}</span>
        <Tooltip label={t('action.openFile')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={`${css.action} ${css.iconAction}`}
            data-diff-open
            aria-label={t('action.openFile')}
            onClick={() => { void onOpen(file.sessionId, file.id, 'open') }}
          >
            <IconBrowseOutline16 size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('action.revealFile')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={`${css.action} ${css.iconAction}`}
            data-diff-reveal
            aria-label={t('action.revealFile')}
            onClick={() => { void onOpen(file.sessionId, file.id, 'reveal') }}
          >
            <IconFolderOpenOutline16 size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={css.diffActions}>
        {(model.diff.added !== 0 || model.diff.removed !== 0) && (
          <span className={css.diffStats}>{t('panel.stats', { added: model.diff.added, removed: model.diff.removed })}</span>
        )}
        {model.blocks.length > 0 && (
          <>
            <Tooltip label={withChord(t('action.prevDiff'), 'jumpUp')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={`${css.action} ${css.iconAction}`}
                data-diff-prev
                aria-label={t('action.prevDiff')}
                disabled={busy}
                onClick={() => { jumpBlock(-1, true) }}
              >
                <IconChevronUpOutline14 size={14} />
              </button>
            </Tooltip>
            <Tooltip label={withChord(t('action.nextDiff'), 'jumpDown')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={`${css.action} ${css.iconAction}`}
                data-diff-next
                aria-label={t('action.nextDiff')}
                disabled={busy}
                onClick={() => { jumpBlock(1, true) }}
              >
                <IconChevronDownOutline14 size={14} />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip label={withChord(t('action.search'), 'openSearch')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={`${css.action} ${css.iconAction}`}
            data-diff-search-toggle
            aria-label={t('action.search')}
            onClick={toggleSearch}
          >
            <IconSearchOutline16 size={14} />
          </button>
        </Tooltip>
        <span className={css.divider} />
        <Tooltip label={t(splitView ? 'action.viewUnified' : 'action.viewSplit')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={`${css.action} ${css.iconAction}`}
            data-diff-toggle-view
            aria-label={t(splitView ? 'action.viewUnified' : 'action.viewSplit')}
            onClick={toggleSplitView}
          >
            <ViewModeIcon split={splitView} />
          </button>
        </Tooltip>
        {lang === 'markdown' && (
          <Tooltip label={t(mdPreview ? 'action.viewSource' : 'action.viewPreview')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-md-preview
              aria-label={t(mdPreview ? 'action.viewSource' : 'action.viewPreview')}
              onClick={() => {
                const next = !mdPreview
                setMdPreview(next)
                setMdPreviewEnabled(next)
              }}
            >
              <MarkdownModeIcon preview={mdPreview} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('action.refreshVcs')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={`${css.action} ${css.iconAction}`}
            data-diff-refresh-vcs
            disabled={busy}
            aria-label={t('action.refreshVcs')}
            onClick={() => { onRefreshVcs(file) }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
        <span className={css.flexSpacer} />
        <button
          type="button"
          className={`${css.action} ${css.actionPrimary} ${css.actionQuietDisabled}`}
          data-diff-keep
          disabled={busy}
          onClick={() => { void onKeep(file.sessionId, file.id) }}
        >
          {t('action.keep')}
        </button>
        <button
          type="button"
          className={`${css.action} ${css.actionQuietDisabled}`}
          data-diff-revert
          disabled={busy}
          onClick={() => { void onRevert(file.sessionId, file.id) }}
        >
          {file.kind === 'create' ? t('action.delete') : t('action.revert')}
        </button>
      </div>
      {failedMessage !== undefined && <p className={css.actionError} data-diff-action-error>{failedMessage}</p>}
      {file.missing && <p className={css.missingHint}>{t('panel.missingHint')}</p>}
      {previewActive ? (
        <MarkdownPreviewBoundary fallback={<div className={css.mdPreviewFallback} data-diff-md-preview-fallback>{t('panel.mdPreviewFailed')}</div>}>
          <div className={css.mdPreviewWrap} onMouseLeave={() => { setHoveredBlock(undefined) }}>
            <div
              className={`${css.mdPreviewBody} ${splitView ? css.mdPreviewDouble : css.mdPreviewSingle}`}
              data-diff-md-preview-body
              data-diff-md-mode={splitView ? 'double' : 'single'}
              ref={mdPreviewBodyRef}
              onScroll={(event) => {
                // Move the frames in this very frame, without a React render: the
                // preview's markdown re-render is far too heavy to run per scroll
                // event (that was the visible lag).
                previewScrollTopRef.current = event.currentTarget.scrollTop
                applyPreviewOverlays()
              }}
              onMouseOver={(event) => {
                // The rendered HTML is a flat blob to React: resolve the block from
                // the event's target instead of wiring a handler per block. A
                // pointer over the frames themselves keeps the current block (so
                // moving onto the buttons never makes them disappear), while a
                // pointer over context clears it — exactly like the code view,
                // where hovering an unchanged line drops the frame.
                const target = event.target as Node | null
                if (target instanceof Element
                  && target.closest('[data-diff-block-actions],[data-diff-selection-actions]') !== null) return
                const index = previewBlockAt(target)
                if (index !== hoveredBlock) setHoveredBlock(index)
              }}
            >
              <div
                className={css.mdPreviewContent}
                data-diff-md-preview-content
                style={{ maxWidth: splitView ? mdPreviewMaxWidthPx * 2 : mdPreviewMaxWidthPx }}
                dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(file.oldText, file.newText, splitView ? 'double' : 'single') }}
              />
            </div>
            {searchBar}
            {previewFlash !== undefined && previewFlashNow !== undefined && (
              <div
                ref={previewFlashRef}
                key={flashKey}
                className={pinShakeRef.current ? `${css.blockFlash} ${css.blockFlashShake}` : css.blockFlash}
                data-diff-block-flash
                style={{
                  top: previewFlashNow.top,
                  height: previewFlashNow.height,
                  left: previewFlash.left,
                  right: previewFlash.right,
                }}
              />
            )}
            {previewCovered.length > 0 && selectionRange !== undefined && previewSelectionFrame !== undefined ? (
              <div
                ref={previewSelectionFrameRef}
                className={css.blockActions}
                data-diff-selection-actions
                style={{ top: previewFrameTop(previewSelectionFrame, previewScrollTopRef.current) ?? 0, right: previewSelectionFrame.right }}
              >
                <button
                  type="button"
                  className={`${css.action} ${css.actionPrimary}`}
                  data-diff-selection-keep
                  disabled={busy}
                  onClick={() => { void handleSelectionAction('keep') }}
                >
                  {t('action.keep')}
                </button>
                <button
                  type="button"
                  className={css.action}
                  data-diff-selection-revert
                  disabled={busy}
                  onClick={() => { void handleSelectionAction('revert') }}
                >
                  {t('action.revert')}
                </button>
              </div>
            ) : hoveredBlock !== undefined && model.blocks[hoveredBlock] !== undefined && previewFrame !== undefined ? (
              <div
                ref={previewHoverFrameRef}
                className={css.blockActions}
                data-diff-block-actions
                style={{ top: previewFrameTop(previewFrame, previewScrollTopRef.current) ?? 0, right: previewFrame.right }}
              >
                <span className={css.blockPosition} data-diff-block-position>
                  {t('panel.blockPosition', { current: hoveredBlock + 1, total: model.blocks.length })}
                </span>
                <button
                  type="button"
                  className={`${css.action} ${css.iconAction}`}
                  data-diff-block-prev
                  aria-label={t('action.prevDiff')}
                  disabled={busy}
                  onClick={() => { stepBlock(-1) }}
                >
                  <IconChevronUpOutline14 size={14} />
                </button>
                <button
                  type="button"
                  className={`${css.action} ${css.iconAction}`}
                  data-diff-block-next
                  aria-label={t('action.nextDiff')}
                  disabled={busy}
                  onClick={() => { stepBlock(1) }}
                >
                  <IconChevronDownOutline14 size={14} />
                </button>
                <button
                  type="button"
                  className={`${css.action} ${css.actionPrimary}`}
                  data-diff-block-keep
                  disabled={busy}
                  onClick={() => { void handleBlockAction('keep') }}
                >
                  {t('action.keep')}
                </button>
                <button
                  type="button"
                  className={css.action}
                  data-diff-block-revert
                  disabled={busy}
                  onClick={() => { void handleBlockAction('revert') }}
                >
                  {t('action.revert')}
                </button>
              </div>
            ) : null}
            {mdRulerMarkers.length > 0 && (
              <div className={css.overviewRuler} data-diff-approval-ruler aria-hidden="true">
                {mdRulerMarkers.map((marker, index) => (
                  <div
                    key={index}
                    className={`${css.overviewMarker} ${marker.kind === 'del' ? css.markerDel : css.markerAdd}`}
                    data-diff-ruler-marker={marker.kind}
                    style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
                  />
                ))}
              </div>
            )}
          </div>
        </MarkdownPreviewBoundary>
      ) : splitView ? (
        <SplitDiff
          ref={splitDiffRef}
          file={file}
          model={model}
          runs={runs}
          langWrap={langWrap}
          tabWidthSpaces={tabWidthSpaces}
          busy={busy}
          t={t}
          selection={selection}
          leadRows={leadRows}
          onBlockKeep={onBlockKeep}
          onBlockRevert={onBlockRevert}
          onWrapToast={(text) => onToast(text)}
          onVisibleLines={onSplitVisibleLines}
        />
      ) : (
      <div className={css.diffBodyWrap} onMouseLeave={() => { setHoveredBlock(undefined) }}>
        <div
          className={css.diffBody}
          ref={bodyRef}
          tabIndex={0}
          onScroll={onScroll}
          style={{ tabSize: tabWidthSpaces }}
          data-diff-body
        >
          <div
            className={`${css.lines}${langWrap ? ' ' + css.wrap : ''}`}
            style={langWrap ? { width: '100%', minWidth: '100%' } : { minWidth: `max(100%, ${widestLine}ch)` }}
          >
            {start > 0 && (
              <div className={css.vSpacer} style={{ height: offsetOf(start) }} aria-hidden="true" />
            )}
            {visibleRows.map((row, offset) => {
              const index = start + offset
              return (
                <DiffRow
                  key={index}
                  index={index}
                  row={row}
                  runs={runs}
                  focused={inFocusedBlock(index)}
                  searchHit={searchHitSet.has(index)}
                  searchCurrent={index === currentSearchRow}
                  searchQuery={searchQuery}
                  searchOptions={search.options}
                  onRowHover={onRowHover}
                  wrappedLines={rowWrapped?.[index]}
                />
              )
            })}
            {end < rowCount && (
              <div className={css.vSpacer} style={{ height: totalHeight - offsetOf(end) }} aria-hidden="true" />
            )}
          </div>
        </div>
        {selectionRange !== undefined ? (
          <div
            className={css.blockActions}
            data-diff-selection-actions
            style={{ top: selectionActionsTop }}
          >
            <button
              type="button"
              className={`${css.action} ${css.actionPrimary}`}
              data-diff-selection-keep
              disabled={busy}
              onClick={() => { void handleSelectionAction('keep') }}
            >
              {t('action.keep')}
            </button>
            <button
              type="button"
              className={css.action}
              data-diff-selection-revert
              disabled={busy}
              onClick={() => { void handleSelectionAction('revert') }}
            >
              {t('action.revert')}
            </button>
          </div>
        ) : hoveredBlock !== undefined && model.blocks[hoveredBlock] !== undefined ? (
          <div
            className={css.blockActions}
            data-diff-block-actions
            style={{ top: blockActionsTop }}
          >
            <span className={css.blockPosition} data-diff-block-position>
              {t('panel.blockPosition', { current: hoveredBlock + 1, total: model.blocks.length })}
            </span>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-block-prev
              aria-label={t('action.prevDiff')}
              disabled={busy}
              onClick={() => { stepBlock(-1) }}
            >
              <IconChevronUpOutline14 size={14} />
            </button>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-block-next
              aria-label={t('action.nextDiff')}
              disabled={busy}
              onClick={() => { stepBlock(1) }}
            >
              <IconChevronDownOutline14 size={14} />
            </button>
            <button
              type="button"
              className={`${css.action} ${css.actionPrimary}`}
              data-diff-block-keep
              disabled={busy}
              onClick={() => { void handleBlockAction('keep') }}
            >
              {t('action.keep')}
            </button>
            <button
              type="button"
              className={css.action}
              data-diff-block-revert
              disabled={busy}
              onClick={() => { void handleBlockAction('revert') }}
            >
              {t('action.revert')}
            </button>
          </div>
        ) : null}
        {focusedBlock !== undefined && flashKey > 0 && (
          <div
            key={flashKey}
            className={pinShakeRef.current ? `${css.blockFlash} ${css.blockFlashShake}` : css.blockFlash}
            data-diff-block-flash
            style={{
              // The flash is fixed relative to the scroll box, so `top`/`height`
              // are viewport coordinates (content offset minus scrollTop), clamped
              // to the block's visible intersection. The width is the scroller's
              // client width (code area, excluding the scrollbar and the
              // overview ruler).
              top: flashTop,
              height: flashHeight,
              width: flashWidth,
            }}
          />
        )}
        {searchBar}
        {rulerMarkers.length > 0 && (
          <div
            className={css.overviewRuler}
            data-diff-approval-ruler
            aria-hidden="true"
            style={{ bottom: hScrollbarPx }}
          >
            {rulerMarkers.map((marker, index) => (
              <div
                key={index}
                className={`${css.overviewMarker} ${marker.kind === 'del' ? css.markerDel : css.markerAdd}`}
                data-diff-ruler-marker={marker.kind}
                style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
              />
            ))}
          </div>
        )}
      </div>
      )}
      <div className={css.statusBar} data-diff-status-bar>
        {selectionReference === undefined ? null : (
          <Tooltip label={copied ? t('action.copied') : withChord(t('action.copyHint'), 'copyRef')} side="top" delayMs={300}>
            {/*
             * Deliberately NOT a native <button>/<a>: the "dsh-pocket" mobile
             * bridge hijacks any button/link whose text *looks like a file path*
             * (its fileGuard looksLikeFilePath heuristic matches a `path/file.ext`
             * substring anywhere in the text). This control's text is a copy
             * reference `path:range` like `Source/foo.cpp:42`, which that
             * heuristic false-positives on — so on phones dsh-pocket would
             * (1) swallow the click and show "手机上无法直接打开电脑上的文件"
             *     instead of copying the reference, and
             * (2) inject an extra 复制 button beside it.
             * Rendering it as a non-button role=button keeps it out of the
             * `button, a` selectors dsh-pocket scans, while we keep real
             * semantics (role, tabIndex, Enter/Space) for keyboard/AT users.
             * The data-mobile-nav-copy marker is defensive: if dsh-pocket ever
             * widens its selector beyond `button, a`, the marker still opts this
             * element out of its 复制 injection (it skips elements carrying it).
             */}
            <span
              role="button"
              tabIndex={0}
              className={css.statusAction}
              data-diff-copy
              data-mobile-nav-copy="1"
              // Keep the native selection alive across the click so the
              // reference stays in the status bar after copying.
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { void copySelection() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void copySelection()
                }
              }}
            >
              {copied ? t('action.copied') : selectionReferenceLabel}
            </span>
          </Tooltip>
        )}
        <span className={css.flexSpacer} />
        {!previewActive && (
          <>
            <Menu
              open={langMenuOpen}
              portal
              compact
              align="end"
              items={langMenuItems}
              selectedId={effectiveLang ?? ''}
              onSelect={(id) => {
                const next = id === '' ? undefined : id
                setLangOverride(next)
                // A hand-picked language is remembered for the file's suffix (and
                // "auto" forgets it), so the same kind of file keeps the choice.
                if (langSuffix !== undefined) setLanguageForSuffix(langSuffix, next ?? null)
                setLangMenuOpen(false)
              }}
              onClose={() => { setLangMenuOpen(false) }}
              anchor={(
                <Tooltip label={t('action.langSelect')} side="top" delayMs={500}>
                  <button
                    type="button"
                    className={css.langSelect}
                    data-diff-lang
                    aria-label={t('action.langSelect')}
                    onClick={() => { setLangMenuOpen(value => !value) }}
                  >
                    <span className={css.langLabel}>{langLabel}</span>
                    <IconChevronDownOutline14 size={12} />
                  </button>
                </Tooltip>
              )}
            />
            <Tooltip label={langWrap ? t('action.toggleOff') : t('action.toggleOn')} side="top" delayMs={500}>
              <button
                type="button"
                className={`${css.langSelect}${langWrap ? ' ' + css.wrapActive : ''}`}
                data-diff-wrap
                aria-label={langWrap ? t('action.toggleOff') : t('action.toggleOn')}
                aria-pressed={langWrap}
                onClick={toggleLangWrap}
              >
                <span className={css.langLabel}>{t('action.wrap')}</span>
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}

/** Render the pending-edit review panel and its unified footer action. */
export function PendingPanel({
  wide, useSessions, usePending, onRefresh, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen, onPreviewImage, onPasteReference, onUndo, onRedo, onImportVcs, onRefreshVcs, onBrowse, onAddPath, onKeepAll, onRevertAll, onAckRedoCleared, collapseSidebar, t,
  docked = false, dockHost, onOpenDock, closeDock, useDock,
}: PendingPanelProps) {
  const current = useSessions(state => state.current)
  // A newly created session is selected but still blank (no messages yet); it
  // has nothing to review, so the entry is grayed out exactly like no session.
  const currentBlank = useSessions(state => {
    const id = state.current
    return id === undefined ? false : (state.byId[id]?.blank ?? false)
  })
  const noSession = current === undefined || currentBlank
  // Whether the panel is showing in the right sidebar's tab right now (absent
  // hook: this build has no right sidebar). The face is fixed per mount, so the
  // optional hook never appears mid-life: the call order stays stable.
  const dockShowing = useDock?.((state: DockSnapshot) => state.open) === true
  // Whether this build has a right sidebar to dock into at all: the observable
  // exists from apply time and flips to available once the sidebar is attached.
  const dockAvailable = useDock?.((state: DockSnapshot) => state.available) === true
  /** Why the dock is unavailable, when it is (shown once, if asked for). */
  const dockReason = useDock?.((state: DockSnapshot) => state.reason) as string | undefined
  // A docked panel that un-docks asks this instance (the footer's) to show the
  // overlay: the two are separate mounts, and the stored presentation says which
  // one. A docked instance ignores it — it is the one that asked.
  const revealRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (docked) return
    const onShow = (): void => { revealRef.current() }
    window.addEventListener(SHOW_PANEL_EVENT, onShow)
    return () => { window.removeEventListener(SHOW_PANEL_EVENT, onShow) }
  }, [docked])
  // Rendering as the tab's body is itself the dock presentation: remember it, so
  // the footer entry brings the panel back here rather than floating it.
  useEffect(() => {
    if (docked) setPanelPresentation('dock')
  }, [docked])
  const snapshot = usePending(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  /** Bumped when the already-open file is clicked again, to jump to the next
   * diff block in the open file's detail pane. */
  const [jumpSignal, setJumpSignal] = useState(0)
  /** Bumped when an undo/redo affected the already-open file, so its detail
   * pane re-selects the undone diff (flash). */
  const [undoFlash, setUndoFlash] = useState(0)
  /** Which bulk decision (keep-all / revert-all) is running; null when idle. */
  const [bulkBusy, setBulkBusy] = useState<'keep' | 'revert' | null>(null)
  /** True while a workspace-changes import is running. */
  const [importBusy, setImportBusy] = useState(false)
  /** Feedback under the empty note after an import (no VCS, or a failure). */
  const [importNote, setImportNote] = useState<string | undefined>(undefined)
  /** Whether the last import note is a failure (drives the alert role). */
  const [importFailed, setImportFailed] = useState(false)
  /** A transient banner for an import that found nothing to bring in. */
  const [importToast, setImportToast] = useState<string | null>(null)
  /** A transient banner for a keep/revert failure. */
  const [actionToast, setActionToast] = useState<string | null>(null)
  /** A transient banner confirming a reference was copied to the clipboard. */
  const [copyToast, setCopyToast] = useState<{ text: string; n: number } | null>(null)
  // Show a transient toast that re-triggers even for the same text: each call
  // bumps the nonce, and the Toast is keyed on it, so a repeated boundary press
  // re-shows rather than being a React no-op on an unchanged string.
  const showCopyToast = (text: string): void => {
    setCopyToast(prev => ({ text, n: (prev?.n ?? 0) + 1 }))
  }
  // "查看差异" bridge from a produced-file chip (see produced-diff.ts): the
  // injected button dispatches OPEN_FILE_EVENT with a path. Open the panel and
  // select the file when it is still pending; otherwise toast. The ref defers to
  // the latest render's snapshot so this stays accurate without re-subscribing.
  const handleOpenFileRef = useRef<(path: string) => void>()
  handleOpenFileRef.current = (path) => {
    // The produced-file chip's path is workspace-relative and forward-slashed,
    // while a pending file's path is absolute and native-separated — match
    // tolerant of both (see diffPathsMatch).
    const entry = snapshot.files.find(file => diffPathsMatch(path, file.path, snapshot.workspacePath))
    if (entry === undefined) {
      showCopyToast(t('panel.fileNotPending'))
      return
    }
    revealPanel()
    setSelected(entry.id)
  }
  useEffect(() => {
    const onOpenFile = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (typeof path !== 'string') return
      handleOpenFileRef.current?.(path)
    }
    window.addEventListener(OPEN_FILE_EVENT, onOpenFile)
    return () => { window.removeEventListener(OPEN_FILE_EVENT, onOpenFile) }
  }, [])
  /** Whether the redo-cleared notice is showing (bottom-right, OK to dismiss). */
  const [redoClearedNotice, setRedoClearedNotice] = useState(false)
  /** A last-block keep/revert awaiting the user's remove-or-keep choice; the
   *  choice rides the same block RPC as its `removeWhenResolved` flag. */
  const [blockPrompt, setBlockPrompt] = useState<ResolvedBlockPrompt | null>(null)
  const [filePrompt, setFilePrompt] = useState<FileActionPrompt | null>(null)
  /** Whether the add-path dialog is open. One dialog covers both shapes: what
   *  the browser settles on decides whether a file or a directory is added. */
  const [addOpen, setAddOpen] = useState(false)
  /** Bottom offset tracking the chat composer's top edge so the input stays visible. */
  const [bottomPx, setBottomPx] = useState(FALLBACK_BOTTOM_PX)
  /** The app frame's sidebar columns, in px: how far the floating panel has to
   *  start from each window edge to leave that sidebar visible. */
  /** How much of the window the app occupies on each side of the conversation:
   *  how far the floating panel starts from an edge it does not cover. */
  const [sideInset, setSideInset] = useState({ top: 0, bottom: 0, left: 0, right: 0 })
  /** What the floating panel covers: the app's two sidebars and the composer. */
  const [cover, setCover] = useState<DiffApprovalCover>(() => panelCover())
  /** The chord's on-screen echo: the edge just flipped, and a nonce so a repeat
   *  restarts the notice instead of re-rendering the same one. */
  const [coverNotice, setCoverNotice] = useState<{ edge: keyof DiffApprovalCover; n: number } | null>(null)
  /** File-list pane width, adjustable by dragging the divider. */
  const [listWidth, setListWidth] = useState(240)
  const resizeDrag = useRef<{ startX: number; startWidth: number } | null>(null)
  /** Whether the floating (collapsed) file list is currently shown. */
  const [floatOpen, setFloatOpen] = useState(false)
  /** Whether the file list is always folded, whatever the width allows. */
  const [forceFloat, setForceFloat] = useState(() => fileListFloat())
  /** The review panel's width, measured so the file list can collapse when it
   * would take more than a third of it (browser zoom / window resize). */
  const [panelWidth, setPanelWidth] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  /** The window's height, for the panel's minimum-size floor (see {@link panelInsets}). */
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const panelRef = useRef<HTMLElement>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  /** The code scroll box's bounds within the split, so the floating card is
   * constrained to it. */
  const [floatBox, setFloatBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)

  useEffect(() => {
    onRefresh(current)
    const timer = setInterval(() => { onRefresh(current) }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [current, onRefresh])

  // Track the panel's width as a resize trigger so the floating file-list card
  // re-measures its bounds when the panel resizes. The panel only mounts open.
  useEffect(() => {
    const el = panelRef.current
    if (el === null) return
    const measure = (): void => { setPanelWidth(el.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => { observer?.disconnect() }
  }, [open, docked])

  // The file list floats on the same breakpoint the DSH sidebar auto-collapses
  // on, so the two stay consistent (the sidebar closes at < 1024 and the file
  // list folds into a floating button at the same width) — or whenever the user
  // has asked for it always to, which is what the list's own switch stores.
  const floatMode = forceFloat || (docked
    ? panelWidth > 0 && panelWidth < DOCK_TWO_COLUMN_MIN_PX
    : viewportWidth < SIDEBAR_AUTO_COLLAPSE_PX)
  const toggleFileList = (): void => { setFloatOpen(value => !value) }
  /** Flip the always-fold preference, remembered for the next open. */
  const toggleForceFloat = (): void => {
    const next = !forceFloat
    setForceFloat(next)
    setFileListFloat(next)
    // Folding it away means the card starts closed: the knob opens it again.
    if (next) setFloatOpen(false)
  }

  // Track the window's size for the breakpoint above and the panel's floor.
  useEffect(() => {
    const onResize = (): void => {
      setViewportWidth(window.innerWidth)
      setViewportHeight(window.innerHeight)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  // Clicking anywhere outside the floating card — or on the toggle button,
  // which toggles it — folds the floating list back.
  useEffect(() => {
    if (!floatMode || !floatOpen) return
    const el = panelRef.current
    if (el === null) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target instanceof Element
        && (target.closest('[data-diff-floating-file-list]') !== null || target.closest('[data-diff-file-list-toggle]') !== null)) return
      setFloatOpen(false)
    }
    el.addEventListener('pointerdown', onPointerDown, true)
    return () => { el.removeEventListener('pointerdown', onPointerDown, true) }
  }, [floatMode, floatOpen])

  // Where the floating file list goes: it is measured from the code view when a
  // file is open, and from the detail pane when none is — so the folded list has
  // a box either way. Both the card and the knob on its corner are placed from
  // this one box, which is what keeps them aligned.
  useEffect(() => {
    if (!floatMode) return
    const split = splitRef.current
    if (split === null) return
    const body = panelRef.current?.querySelector<HTMLElement>('[data-diff-body],[data-diff-md-preview-body]')
      ?? panelRef.current?.querySelector<HTMLElement>('[data-diff-detail]')
    if (body == null) return
    const s = split.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    setFloatBox({ left: b.left - s.left, top: b.top - s.top, width: b.width, height: b.height })
  }, [floatMode, floatOpen, panelWidth])

  // Surface a detected external change that superseded the redo history. The
  // notice is deferred until the panel is open, and the store latches the flag
  // so a change observed while closed is still shown once the panel reopens.
  useEffect(() => {
    if (!open || !snapshot.redoCleared) return
    onAckRedoCleared()
    setRedoClearedNotice(true)
  }, [open, snapshot.redoCleared, onAckRedoCleared])

  // While the panel is open, sit above the docked composer seat. The seat
  // hosts the input card OR an elected approval/question takeover (the input
  // bar is kept mounted but hidden during a takeover), so its top is the one
  // true line to clear. It is measured directly — never the input card, whose
  // rect is all zeros while hidden. A docked seat sits pinned to the window
  // bottom (sticky/absolute); a centered hero seat is not something to avoid,
  // so it falls back to the fixed offset. A ResizeObserver makes the response
  // immediate when the seat grows (a takeover mounting, a draft expanding);
  // a slow interval catches a seat that mounts after the panel opens.
  useEffect(() => {
    if (!open) return
    const MEASURE_INTERVAL_MS = 400
    const measure = () => {
      setSideInset(frameInsets())
      const scrollers = document.querySelectorAll(SCROLL_SELECTOR)
      for (const scroller of scrollers) {
        const seat = scroller.querySelector(SEAT_SELECTOR)
        if (seat === null) continue
        const seatRect = seat.getBoundingClientRect()
        const docked = seatRect.bottom >= window.innerHeight - DOCKED_TOLERANCE_PX
          && seatRect.top > 0 && seatRect.top < window.innerHeight
        if (!docked) continue
        // Inherit the harness's own live seat height: ui-conversation keeps
        // --dsh-composer-height current on this scroll body (its seat
        // ResizeObserver), so the panel tracks the composer even if its
        // layout changes. Fall back to measuring the seat's top edge.
        const height = Number.parseFloat((scroller as HTMLElement).style.getPropertyValue(COMPOSER_HEIGHT_VAR))
        const clearance = Number.isFinite(height) && height > 0
          ? height
          : window.innerHeight - seatRect.top
        setBottomPx(Math.round(clearance) + COMPOSER_GAP_PX)
        return
      }
      setBottomPx(FALLBACK_BOTTOM_PX)
    }
    measure()
    const seats = [...document.querySelectorAll(SEAT_SELECTOR)]
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure)
    for (const seat of seats) observer?.observe(seat)
    const timer = window.setInterval(measure, MEASURE_INTERVAL_MS)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // Nothing outside the panel dismisses it — not a press on the editor, the chat,
  // the composer, or the sidebar's own blank space. The panel is a working
  // surface, not a popover: closing it is a decision, and the ways to make it are
  // the ✕, Escape, and the quick-summon chord. (The folded file-list card inside
  // it is still dismissed by a press away from the card — see below.)
  // The panel reviews only the current session's files; other sessions of the
  // same workspace stay out of the list, badge, and auto-advance. Sort by the
  // displayed file name so the list reads in dictionary order even before the
  // host's own ordering is picked up.
  const files = snapshot.files
    // A globally-unique entry is shown to every session that touched it (its
    // sessionIds), so a file edited by multiple sessions appears once in each
    // of their views. Tolerant of a legacy row carrying only `sessionId`.
    .filter(file => current !== undefined && (file.sessionIds ?? [file.sessionId]).includes(current))
    .sort((left, right) => compareFileNames(left.path, right.path))
  // Wrap the block keep/revert so a last-block action prompts for remove-or-keep
  // up front; the choice rides the same RPC as `removeWhenResolved`. A file with
  // more than one remaining block is never cleared by a single action, so it runs
  // straight through. Re-deriving the change blocks here (the panel already has
  // each file's text) keeps one interception point for both view modes.
  const blockKeepWithPrompt: PendingPanelFace['onBlockKeep'] = (sessionId, id, block, removeWhenResolved) => {
    const file = files.find(entry => entry.id === id)
    if (removeWhenResolved === undefined && file !== undefined && blockResolvesWholeFile(file, block)) {
      setBlockPrompt({ action: 'keep', sessionId, id, block })
      return Promise.resolve()
    }
    return removeWhenResolved === undefined ? onBlockKeep(sessionId, id, block) : onBlockKeep(sessionId, id, block, removeWhenResolved)
  }
  const blockRevertWithPrompt: PendingPanelFace['onBlockRevert'] = (sessionId, id, block, removeWhenResolved) => {
    const file = files.find(entry => entry.id === id)
    if (removeWhenResolved === undefined && file !== undefined && blockResolvesWholeFile(file, block)) {
      setBlockPrompt({ action: 'revert', sessionId, id, block })
      return Promise.resolve()
    }
    return removeWhenResolved === undefined ? onBlockRevert(sessionId, id, block) : onBlockRevert(sessionId, id, block, removeWhenResolved)
  }

  // A whole-file keep/revert always resolves the file outright, so — while the
  // preference is on — ask whether to drop it from the list rather than removing
  // it silently. An explicit `keepListed` (the prompt's own answer) runs straight
  // through, so the prompt cannot re-enter itself.
  const keepWithPrompt: PendingPanelFace['onKeep'] = (sessionId, id, keepListed) => {
    if (keepListed === undefined && confirmFileRemoveEnabled()) {
      setFilePrompt({ action: 'keep', sessionId, id })
      return Promise.resolve()
    }
    return keepListed === undefined ? onKeep(sessionId, id) : onKeep(sessionId, id, keepListed)
  }
  const revertWithPrompt: PendingPanelFace['onRevert'] = (sessionId, id, keepListed) => {
    if (keepListed === undefined && confirmFileRemoveEnabled()) {
      setFilePrompt({ action: 'revert', sessionId, id })
      return Promise.resolve()
    }
    return keepListed === undefined ? onRevert(sessionId, id) : onRevert(sessionId, id, keepListed)
  }
  /** Per-file keep/revert failures, surfaced inline on the row and detail. */
  const failed = snapshot.failed ?? EMPTY_FAILED_MAP

  // A keep/revert failure also pops a transient banner: watch the failure map
  // for entries that were not there before (the panel's own actions mark them;
  // the first observation is the baseline and does not toast). The inline tag
  // and detail banner stay for context.
  const failedInitialized = useRef(false)
  const failedRef = useRef<ReadonlyMap<string, string> | undefined>(undefined)
  useEffect(() => {
    const current = snapshot.failed
    if (!failedInitialized.current) {
      failedInitialized.current = true
      failedRef.current = current
      return
    }
    const previous = failedRef.current
    const fresh = [...(current ?? EMPTY_FAILED_MAP).entries()]
      .filter(([id]) => previous === undefined || !previous.has(id))
    if (fresh.length > 0) setActionToast(fresh[0]![1])
    failedRef.current = current
  }, [snapshot.failed])

  // Auto-open the first pending file when the panel opens, and advance to the
  // next one once the selected file is handled. Selection is single and cannot
  // be cleared by clicking — only an empty list shows the empty state.
  useEffect(() => {
    if (!open) return
    if (selected !== '' && files.some(file => file.id === selected)) return
    const next = files[0]
    if (next !== undefined && next.id !== selected) setSelected(next.id)
  }, [open, current, files, selected])

  // A fully-processed (emptied) list stays open with the empty state on
  // purpose — no auto-close — so the last action (a Keep-all/Revert-all
  // especially) stays undoable via Ctrl+Z and the import button is still
  // reachable.

  // Import is explicitly button-triggered: the empty state's button runs the
  // whole detect-and-import in one call (no host probe until the user asks).
  // The host's answer distinguishes a workspace outside any git/svn/p4 checkout
  // (`detected: false`) from one with no changes to bring in (`imported: 0`).
  const runImportVcs = async (): Promise<void> => {
    if (current === undefined || importBusy) return
    setImportBusy(true)
    setImportNote(undefined)
    setImportFailed(false)
    setImportToast(null)
    try {
      const value = await onImportVcs(current, includeUntrackedEnabled())
      await onRefresh(current)
      if (!value.detected) {
        setImportNote(t('panel.importNoVcs'))
      } else if (value.imported === 0) {
        // Nothing came in and the list stays empty: a transient banner is all
        // the feedback needed.
        setImportToast(t('panel.importNone'))
      }
    } catch (error: unknown) {
      setImportFailed(true)
      setImportNote(t('panel.importFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setImportBusy(false)
    }
  }

  /**
   * Show the panel the way the user last had it. `dock` hands off to the app's
   * right sidebar, where the panel lives in its own tab; `float` opens this
   * floating panel, covering whatever {@link panelCover} says. A remembered dock
   * in a build without a right sidebar falls back to the floating panel instead
   * of doing nothing.
   */
  const revealPanel = (): void => {
    const stored = panelPresentation()
    if (stored === 'dock' && onOpenDock !== undefined) {
      try {
        onOpenDock()
        return
      } catch {
        // The sidebar is mounted but cannot take the panel yet (no seat bound):
        // open the overlay instead of doing nothing at all.
      }
    }
    // Opening the floating modal: collapse the narrow sidebar first so it can't
    // overlap it.
    collapseSidebar()
    setOpen(true)
  }

  revealRef.current = revealPanel

  /** Move the panel into the right sidebar's tab: the tab is opened and this
   *  overlay steps aside, with the presentation remembered for the entry. The
   *  sidebar's controller throws when it is mounted but cannot act on a session
   *  yet (no seat bound), so a failure is said out loud rather than swallowed. */
  const dockPanel = (): void => {
    if (onOpenDock === undefined) return
    try {
      onOpenDock()
    } catch (error) {
      showCopyToast(`${t('panel.dockFailed')} (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    setPanelPresentation('dock')
    setOpen(false)
  }

  /** Where the panel is showing right now: the mode switch's checked row. */
  const presentation: DiffApprovalPresentation = docked ? 'dock' : 'float'
  /**
   * Move the panel to the chosen presentation. Leaving the dock is not this
   * component's to do: a docked panel draws no header (its tab chip carries the
   * switch), and the chip closes the tab and hands the panel back to the footer
   * entry itself.
   */
  const choosePresentation = (next: DiffApprovalPresentation): void => {
    if (next === 'dock') {
      if (docked) return
      if (!dockAvailable) {
        // Say what the lookup saw; without a right sidebar there is nothing to
        // dock into, and "nothing happens" would be the worst possible answer.
        showCopyToast(`${t('panel.dockUnavailable')}${dockReason === undefined ? '' : ` (${dockReason})`}`)
        return
      }
      dockPanel()
      return
    }
    // Float: what it covers is the coverage control's business, and the choice is
    // remembered for the next open.
    if (docked) return
    setPanelPresentation('float')
  }

  /** Flip one coverage switch, remembered for the next open. */
  const toggleCover = (key: keyof DiffApprovalCover): void => {
    const next = { ...cover, [key]: !cover[key] }
    setCover(next)
    setPanelCover(next)
  }

  // The echo clears itself once its animation has run: a fixed budget keeps a
  // repeated chord from stacking notices, and needs no animation events.
  useEffect(() => {
    if (coverNotice === null) return
    const timer = window.setTimeout(() => { setCoverNotice(null) }, COVER_NOTICE_MS)
    return () => { window.clearTimeout(timer) }
  }, [coverNotice])

  // The Settings section is a separate mount offering the same four coverage
  // switches: it announces a flip, and the open panel follows straight away.
  useEffect(() => {
    const onCover = (): void => { setCover(panelCover()) }
    window.addEventListener(COVER_CHANGED_EVENT, onCover)
    return () => { window.removeEventListener(COVER_CHANGED_EVENT, onCover) }
  }, [])

  /**
   * Close the floating panel and hand the caret back to the chat composer:
   * closing the review is a "done reviewing, back to typing" move. A close the
   * user made by clicking somewhere else is the exception — that press is an
   * instruction to put the caret where they clicked, so the outside-click path
   * closes without touching focus.
   */
  const closePanel = (): void => {
    setOpen(false)
    focusComposer()
  }

  const toggleOpen = () => {
    // Opening the modal: collapse the sidebar first so it can't overlap the
    // modal. Collapse before `setOpen` so the sidebar's own re-render doesn't
    // disrupt the panel while it opens.
    if (!open) revealPanel()
    else closePanel()
  }

  // No reviewable session (none selected, or a freshly created blank one): the
  // button is disabled and an open panel closes — there is nothing to review.
  useEffect(() => {
    if (noSession) setOpen(false)
  }, [noSession])

  // Every transient modal belongs to one panel session: closing the panel drops
  // them, so reopening never resumes a dialog that was left behind. (The panel
  // element stays mounted while closed, which is why this needs saying.)
  useEffect(() => {
    if (open) return
    setAddOpen(false)
    setBlockPrompt(null)
    setFilePrompt(null)
  }, [open])

  /** Run the same decision over every current-session file, sequentially. */
  const runBulk = async (kind: 'keep' | 'revert') => {
    if (current === undefined) return
    setBulkBusy(kind)
    try {
      if (kind === 'keep') await onKeepAll(current)
      else await onRevertAll(current)
    } finally {
      setBulkBusy(null)
    }
  }

  /**
   * Replace one file's diff with its current local VCS change, then report what
   * the scan found. A scan that sees no change leaves the entry alone, so the
   * message names the file rather than silently blanking a review in progress.
   */
  const runRefreshVcs = async (entry: PendingFileDiff): Promise<void> => {
    if (current === undefined) return
    const includeUntracked = includeUntrackedEnabled()
    let outcome: DiffApprovalRefreshOutcome
    try {
      const value = await onRefreshVcs(current, entry.id, includeUntracked)
      outcome = value.outcome
    } catch (error: unknown) {
      showCopyToast(t('panel.refreshFailed', { message: error instanceof Error ? error.message : String(error) }))
      return
    }
    // The refresh came from the open file's own toolbar, so no message needs a
    // file name to be unambiguous.
    if (outcome === 'refreshed') {
      showCopyToast(t('panel.refreshDone'))
      return
    }
    if (outcome === 'unchanged') {
      showCopyToast(t('panel.refreshUnchanged'))
      return
    }
    if (outcome === 'no-change') {
      // Untracked files are only visible to the scan while untracked imports are
      // on, so say so instead of implying the file is clean.
      const hint = includeUntracked ? '' : ` ${t('panel.refreshUntrackedHint')}`
      showCopyToast(`${t('panel.refreshNone')}${hint}`)
      return
    }
    if (outcome === 'no-vcs') {
      showCopyToast(t('panel.importNoVcs'))
      return
    }
    showCopyToast(t('panel.fileNotPending'))
  }

  const renderEntry = (entry: PendingFileDiff) => (
    <PendingFileRow
      key={entry.id}
      file={entry}
      selected={selected === entry.id}
      failedMessage={failed.get(entry.id)}
      t={t}
      onSelect={(id) => {
        // Re-clicking the already-open file jumps to the next diff block in
        // the open file; any other row switches the selection. The floating
        // list stays open so you can browse more files; clicking outside the
        // card (or the toggle button) folds it back.
        if (id === selected) setJumpSignal(signal => signal + 1)
        else setSelected(id)
      }}
    />
  )

  const selectedFile = files.find(file => file.id === selected)
  /** The file whose removal is being confirmed (a last-block action), if any. */
  const promptFile = blockPrompt === null ? undefined : files.find(file => file.id === blockPrompt.id)
  /** The file whose removal is being confirmed (a whole-file action), if any. */
  const promptEntry = filePrompt === null ? undefined : files.find(file => file.id === filePrompt.id)

  // The file list's pinned heading, its scrollable rows, and the pinned bulk
  // footer, shared by the in-flow left pane and the floating (collapsed) overlay.
  // Only the rows scroll: the heading (and the add button beside it) stays put.
  const fileListBody = (
    <>
      {files.length > 0 && (
        <div className={css.groupHead}>
          <h3 className={css.group}>{t('panel.group.current')}</h3>
          <span className={css.flexSpacer} />
          <Tooltip label={t('action.addPath')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={`${css.action} ${css.addButton}`}
              data-diff-add
              aria-label={t('action.addPath')}
              onClick={() => { setAddOpen(true) }}
            >
              <IconPlusOutline16 size={12} />
            </button>
          </Tooltip>
          {/* Beside Add: fold the list away for good, whatever the width allows.
              The choice is stored, so it survives a reopen. */}
          <Tooltip label={t(forceFloat ? 'action.fileListFloatOff' : 'action.fileListFloatOn')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={`${css.action} ${css.addButton}`}
              data-diff-file-list-float
              data-active={forceFloat ? '' : undefined}
              aria-label={t(forceFloat ? 'action.fileListFloatOff' : 'action.fileListFloatOn')}
              aria-pressed={forceFloat}
              onClick={toggleForceFloat}
            >
              <IconPanelLeftOutline16 size={12} />
            </button>
          </Tooltip>
        </div>
      )}
      <div className={css.listScroll} data-diff-list-scroll>
        {files.length > 0 && <ul className={css.rows}>{files.map(renderEntry)}</ul>}
      </div>
      {files.length > 0 && (
        <div className={css.bulkActions}>
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary}`}
            data-diff-keep-all
            disabled={bulkBusy !== null}
            onClick={() => { void runBulk('keep') }}
          >
            {bulkBusy === 'keep' ? t('action.busy') : t('action.keepAll')}
          </button>
          <button
            type="button"
            className={css.action}
            data-diff-revert-all
            disabled={bulkBusy !== null}
            onClick={() => { void runBulk('revert') }}
          >
            {bulkBusy === 'revert' ? t('action.busy') : t('action.revertAll')}
          </button>
        </div>
      )}
    </>
  )

  // Undo/redo resolves to the affected entry id while it is still pending.
  // The panel then selects that file, or — when it is already the open one —
  const handleUndo = async (sessionId: SessionId): Promise<void> => {
    const id = await onUndo(sessionId)
    if (id === undefined) return
    if (id === selected) setUndoFlash(signal => signal + 1)
    else setSelected(id)
  }
  const handleRedo = async (sessionId: SessionId): Promise<void> => {
    const id = await onRedo(sessionId)
    if (id === undefined) return
    if (id === selected) setUndoFlash(signal => signal + 1)
    else setSelected(id)
  }

  // Ctrl+Z / Ctrl+Y undo/redo the last keep/revert (per-file or bulk). The
  // handler lives on the panel — not the detail pane — so it works even with
  // no file selected (a bulk action leaves an empty list, which stays open).
  // Window capture beats any
  // inner handler; text inputs (the composer, the search box) keep their own
  // Ctrl+Z/Ctrl+Y editing, and Ctrl+Shift+Z also redoes.
  //
  // TODO(editable code view): once the diff becomes an editable surface that
  // can hold focus, scope this back to the panel so the composer's own
  // undo/redo is restored everywhere else.
  useEffect(() => {
    if (!open || current === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      // The add-path dialog is a modal this panel owns.
      if (pathPickerOpen()) return
      const target = event.target as Node | null
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      if (matchesShortcut(event, keybindingOf('undo'))) { event.preventDefault(); void handleUndo(current); return }
      // Ctrl+Y stays a redo alias alongside the configurable redo chord.
      if (matchesShortcut(event, keybindingOf('redo')) || matchesShortcut(event, 'Ctrl+Y')) { event.preventDefault(); void handleRedo(current) }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, current, handleUndo, handleRedo])

  // The coverage switches have chords of their own (Alt-free Ctrl+Shift arrows by
  // default), so the floating panel's edges can be re-arranged without reaching
  // for the popover. They only apply where coverage does — the panel is open and
  // floating, not a sidebar tab. The chat composer keeps them (that is where the
  // caret usually is); every other text field keeps its own word-wise selection.
  useEffect(() => {
    if (!open || docked) return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = COVER_ACTIONS.find(([name]) => matchesShortcut(event, keybindingOf(name)))
      if (action === undefined) return
      if (pathPickerOpen()) return
      if (isTextFieldEvent(event) && !isComposerEvent(event)) return
      event.preventDefault()
      const edge = action[1]
      toggleCover(edge)
      // A chord flip happens with no pointer anywhere near the control, so it
      // reports itself on screen: the same row of glyphs, centred, for a second.
      setCoverNotice({ edge, n: (coverNotice?.n ?? 0) + 1 })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, docked, cover, coverNotice])

  // Ctrl+Tab / Ctrl+Shift+Tab cycle the pending file list (forward / backward),
  // wrapping at the ends. Same global-capture scope as the other chords so the
  // panel works without its own focus, and text inputs keep the browser's
  // native tab behavior.
  useEffect(() => {
    if (!open || current === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      let direction = 0
      if (matchesShortcut(event, keybindingOf('cycleNext'))) direction = 1
      else if (matchesShortcut(event, keybindingOf('cyclePrev'))) direction = -1
      if (direction === 0) return
      // The add-path dialog is a modal: it owns the keyboard while it is open.
      if (pathPickerOpen()) return
      const target = event.target as Node | null
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      if (files.length === 0) return
      event.preventDefault()
      const index = files.findIndex(file => file.id === selected)
      const next = files[(index + direction + files.length) % files.length]
      if (next !== undefined) setSelected(next.id)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, current, files, selected])

  // Quick-summon chord (default Ctrl+D): toggles the panel open/closed from
  // anywhere, matching the chord stored in Settings. The panel is always mounted
  // (its badge lives in the sidebar footer), so this handler stays live whether
  // the modal is open or closed. It is deliberately NOT gated on focus being
  // outside an input: the user wants the chord to work even while the cursor is
  // in the composer, and Ctrl+D is not a common editing combo there.
  useEffect(() => {
    // The docked instance stands down: the same chord is handled once, by the
    // footer entry's handler, which is mounted whether or not a tab is drawn.
    if (docked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, quickSummonKey())) return
      // A modal this panel owns keeps the keyboard to itself.
      if (pathPickerOpen()) return
      event.preventDefault()
      // The panel lives in the sidebar's tab right now: the chord closes that tab
      // (the chip published its close), rather than opening a second copy.
      if (dockShowing) {
        closeDock?.()
        focusComposer()
        return
      }
      // Same open path as the badge: restore the remembered presentation, or
      // close the floating panel when it is already open.
      if (open) closePanel()
      else revealPanel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [docked, open, dockShowing, closeDock, collapseSidebar])

  // Escape dismisses the panel (a modal-close convention). A press inside the
  // panel while a search bar is on screen is the bar's instead: the bar is the
  // innermost dismissible and its own handler closes it, so the panel yields and
  // one press never fires both. Everywhere else — the chat composer included,
  // which keeps its own Esc too — the panel closes.
  useEffect(() => {
    // Docked, the panel is a tab: Escape belongs to whatever is inside it (a
    // search bar closes its own press) and never to the tab's own life.
    if (!open || docked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The add-path modal closes itself: this press is not the panel's.
      if (pathPickerOpen()) return
      // The coverage popover is the innermost dismissible while it is up, and it
      // closes on this same press.
      if (document.querySelector('[data-diff-approval-cover-popover]') !== null) return
      const target = event.target
      const inPanel = target instanceof Node && panelRef.current?.contains(target) === true
      if (inPanel && document.querySelector('[data-diff-searchbar]') !== null) return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, docked])

  /** Drag the list/detail divider; width follows the pointer within its bounds. */
  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    resizeDrag.current = { startX: event.clientX, startWidth: listWidth }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (move: MouseEvent) => {
      const start = resizeDrag.current
      if (start === null) return
      const next = start.startWidth + (move.clientX - start.startX)
      setListWidth(Math.min(Math.max(next, MIN_LIST_WIDTH_PX), MAX_LIST_WIDTH_PX))
    }
    const onUp = () => {
      resizeDrag.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Docked, the panel is a sidebar tab: it fills the tab body the dock body
  // handed it, so it draws no layer of its own. That layer is the footer seat's
  // box (42px plus margins) and would push the tab content past its own height —
  // the sidebar body then scrolls and shows a blank strip under the panel.
  const content = (
    <>
      {/* A transient banner for an import that found no changes; the Toast
          reports completion so it can be unmounted. */}
      {importToast !== null && (
        <Toast text={importToast} onDone={() => { setImportToast(null) }} />
      )}
      {actionToast !== null && (
        <Toast text={actionToast} onDone={() => { setActionToast(null) }} />
      )}
      {copyToast !== null && (
        <Toast key={copyToast.n} text={copyToast.text} onDone={() => { setCopyToast(null) }} />
      )}
      {/* The coverage chords' echo: keyed on the nonce so a repeated chord
          restarts it rather than reusing the half-faded one. */}
      {coverNotice !== null && (
        <CoverageNotice key={coverNotice.n} t={t} cover={cover} changed={coverNotice.edge} />
      )}
      {/* Covering everything keeps an 8px inset, so a layer painted with the
          sidebar's fill hides the app behind those seams instead of letting it
          show through. It sits just below the panel's z-index. */}
      {(docked || open) && createPortal(
        <>
          {!docked && cover.top && cover.left && cover.right && cover.composer
            && <div className={css.coverBackdrop} data-diff-cover-backdrop />}
          <section
            className={docked ? `${css.panel} ${css.panelDocked}` : css.panel}
            ref={panelRef}
            style={docked ? undefined : panelInsets(
              cover,
              sideInset,
              bottomPx,
              { width: viewportWidth, height: viewportHeight },
            )}
            data-diff-approval-panel
            data-diff-docked={docked ? '' : undefined}
            aria-label={t('panel.title')}
          >
          {/* A docked panel draws no header: the tab above it already IS the
              frame — its chip carries the title, the pending count, the mode
              switch, and the kit's own close button — so a second row would only
              repeat them and cost the list its height. */}
          {!docked && (
          <header className={css.header}>
            <span className={css.title}>{t('panel.title')}</span>
            <div className={css.headerActions}>
              <Tooltip label={t('action.settings')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.expand}
                  data-diff-approval-settings
                  aria-label={t('action.settings')}
                  onClick={() => {
                    // Hand off to the settings dialog: the floating panel closes
                    // too, since the review list is left behind for the settings
                    // section the button just opened. A docked tab has nothing to
                    // hide — the settings dialog covers the sidebar anyway.
                    if (!docked) setOpen(false)
                    openSettingsSection(t('settings.tabLabel'))
                  }}
                >
                  <IconSettingsOutline16 size={14} />
                </button>
              </Tooltip>
              {/* What the floating panel covers: the two sidebars and the
                  composer. What the panel used to call "fullscreen" is simply all
                  three on, so the state is composed rather than enumerated. */}
              {!docked && <CoverageControl t={t} cover={cover} onToggle={toggleCover} />}
              {/* One control for where the panel shows: floating over the app, or
                  the right sidebar's tab. The current one is checked, so the two
                  are named rather than cycled. */}
              <PresentationMenu t={t} current={presentation} onChoose={choosePresentation} />
              <Tooltip label={closeHint(t)} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.close}
                  data-diff-approval-close
                  aria-label={t('action.close')}
                  onClick={closePanel}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </Tooltip>
            </div>
          </header>
          )}
          {snapshot.error !== undefined || !snapshot.read || files.length === 0 ? (
            <div className={css.states}>
              {snapshot.error !== undefined && (
                <p className={css.readError} role="alert">{t('panel.readFailed', { message: snapshot.error })}</p>
              )}
              {!snapshot.read && snapshot.error === undefined && <p className={css.note}>{t('panel.loading')}</p>}
              {snapshot.read && snapshot.error === undefined && files.length === 0 && (
                <div className={css.emptyState}>
                  <p className={`${css.note} ${css.noteCentered}`}>{t('panel.empty')}</p>
                  <div className={css.emptyActions}>
                    <button
                      type="button"
                      className={css.importButton}
                      data-diff-import-vcs
                      disabled={importBusy}
                      onClick={() => { void runImportVcs() }}
                    >
                      {importBusy ? t('action.importVcsBusy') : t('action.importVcs')}
                    </button>
                    <button
                      type="button"
                      className={css.importButton}
                      data-diff-add
                      onClick={() => { setAddOpen(true) }}
                    >
                      {t('action.addPath')}
                    </button>
                  </div>
                  {importNote !== undefined && <p className={css.importNote} role={importFailed ? 'alert' : undefined}>{importNote}</p>}
                </div>
              )}
            </div>
          ) : (
            <div className={css.split} ref={splitRef}>
              {/* Folding the list away must not fold its switch away with it: the
                  knob lives on the panel's left edge, below the diff toolbar,
                  rather than inside the diff view — which is not drawn at all
                  while no file is open, and took the switch down with it. */}
              {floatMode && (
                <Tooltip label={t(floatOpen ? 'action.hideFileList' : 'action.showFileList')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.fileListKnob}
                    // Exactly the floating card's own corner — the same measured
                    // box, the same inset — so opening the list covers the knob
                    // rather than sitting beside it. Below the card in z-order.
                    style={{
                      left: (floatBox?.left ?? 0) + FLOAT_LIST_MARGIN_PX,
                      top: (floatBox?.top ?? 0) + FLOAT_LIST_MARGIN_PX,
                    }}
                    data-diff-file-list-toggle
                    aria-label={t(floatOpen ? 'action.hideFileList' : 'action.showFileList')}
                    aria-expanded={floatOpen}
                    onClick={toggleFileList}
                  >
                    <IconListPenOutline16 size={14} />
                  </button>
                </Tooltip>
              )}
              {!floatMode && (
                <nav className={css.fileList} style={{ width: listWidth }} data-diff-approval-file-list>
                  {fileListBody}
                </nav>
              )}
              {!floatMode && <div className={css.resizeHandle} data-diff-resize onMouseDown={startResize} />}
              <div className={css.detail} data-diff-detail>
                {selectedFile === undefined ? (
                  <p className={css.detailEmpty}>{t('panel.selectHint')}</p>
                ) : (
                  <PendingDiff
                    file={selectedFile}
                    busy={snapshot.busy.has(selectedFile.id)}
                    workspacePath={snapshot.workspacePath}
                    jumpSignal={jumpSignal}
                    undoFlash={undoFlash}
                    failedMessage={failed.get(selectedFile.id)}
                    onPasteReference={onPasteReference}
                    onToast={showCopyToast}
                    t={t}
                    onKeep={keepWithPrompt}
                    onRevert={revertWithPrompt}
                    onRefreshVcs={(entry) => { void runRefreshVcs(entry) }}
                    onBlockKeep={blockKeepWithPrompt}
                    onBlockRevert={blockRevertWithPrompt}
                    onOpen={onOpen}
                    onPreviewImage={onPreviewImage}
                  />
                )}
              </div>
              {floatMode && floatOpen && files.length > 0 && floatBox !== null && (
                <div
                  className={css.fileListFloat}
                  style={{
                    left: floatBox.left + FLOAT_LIST_MARGIN_PX,
                    top: floatBox.top + FLOAT_LIST_MARGIN_PX,
                    width: Math.min(listWidth, Math.max(0, floatBox.width - 2 * FLOAT_LIST_MARGIN_PX)),
                    height: Math.max(0, floatBox.height - 2 * FLOAT_LIST_MARGIN_PX),
                  }}
                  data-diff-floating-file-list
                >
                  {fileListBody}
                </div>
              )}
            </div>
          )}
          {blockPrompt !== null && promptFile !== undefined && (
            <div className={css.confirmBackdrop} data-diff-confirm>
              <div className={css.confirmCard} role="dialog" aria-modal="true">
                <p className={css.confirmText}>{t('panel.resolvedAsk', { file: basenameOf(promptFile.path) })}</p>
                <div className={css.confirmActions}>
                  <button
                    type="button"
                    className={`${css.action} ${css.actionPrimary}`}
                    data-diff-confirm-remove
                    onClick={() => {
                      // Remove the file when this action clears its last change:
                      // the choice rides the same block RPC as `removeWhenResolved`.
                      setBlockPrompt(null)
                      const { action, sessionId, id, block } = blockPrompt
                      void (action === 'keep'
                        ? onBlockKeep(sessionId, id, block, true)
                        : onBlockRevert(sessionId, id, block, true))
                    }}
                  >
                    {t('row.dismiss')}
                  </button>
                  <button
                    type="button"
                    className={css.action}
                    data-diff-confirm-keep
                    onClick={() => {
                      // Keep the file listed: run the action with it not removed.
                      setBlockPrompt(null)
                      const { action, sessionId, id, block } = blockPrompt
                      void (action === 'keep'
                        ? onBlockKeep(sessionId, id, block, false)
                        : onBlockRevert(sessionId, id, block, false))
                    }}
                  >
                    {t('panel.keepInList')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {filePrompt !== null && promptEntry !== undefined && (
            <div className={css.confirmBackdrop} data-diff-confirm-file>
              <div className={css.confirmCard} role="dialog" aria-modal="true">
                <p className={css.confirmText}>
                  {t(filePrompt.action === 'keep' ? 'panel.fileKeptAsk' : 'panel.fileRevertedAsk', { file: basenameOf(promptEntry.path) })}
                </p>
                <div className={css.confirmActions}>
                  <button
                    type="button"
                    className={`${css.action} ${css.actionPrimary}`}
                    data-diff-file-confirm-remove
                    onClick={() => {
                      // Remove the resolved file: the choice rides the same
                      // keep/revert RPC as `keepListed: false`.
                      setFilePrompt(null)
                      const { action, sessionId, id } = filePrompt
                      void (action === 'keep' ? onKeep(sessionId, id, false) : onRevert(sessionId, id, false))
                    }}
                  >
                    {t('row.dismiss')}
                  </button>
                  <button
                    type="button"
                    className={css.action}
                    data-diff-file-confirm-keep
                    onClick={() => {
                      // Keep the resolved file listed, with no pending diff.
                      setFilePrompt(null)
                      const { action, sessionId, id } = filePrompt
                      void (action === 'keep' ? onKeep(sessionId, id, true) : onRevert(sessionId, id, true))
                    }}
                  >
                    {t('panel.keepInList')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {addOpen && current !== undefined && (
            <PathPicker
              rootPath={snapshot.workspacePath}
              onBrowse={(path) => onBrowse(current, path)}
              onAdd={(path, includeUnchanged) => onAddPath(current, path, includeUnchanged)}
              onToast={showCopyToast}
              onClose={() => { setAddOpen(false) }}
              t={t}
            />
          )}
          </section>
        </>,
        docked && dockHost !== undefined ? dockHost : document.body,
      )}
      {!docked && <div className={css.footerButtons}>
        <Tooltip label={summonHint(t)} side="top" delayMs={500}>
          <button
            type="button"
            className={noSession ? `${css.badge} ${css.badgeDisabled}` : css.badge}
            data-diff-approval-badge={files.length}
            data-active={open || dockShowing ? '' : undefined}
            aria-label={t('panel.aria')}
            aria-expanded={open || dockShowing}
            disabled={noSession}
            onClick={toggleOpen}
          >
            <IconListPenOutline16 size={wide ? 16 : 18} />
            {wide && <span className={css.badgeLabel}>{t('panel.aria')}</span>}
            {(wide || files.length > 0) && <span className={css.badgeCount}>{files.length}</span>}
          </button>
        </Tooltip>
      </div>}
      {redoClearedNotice && (
        <div className={css.notice} role="status" data-diff-approval-notice>
          <p className={css.noticeText}>{t('panel.externalChanged')}</p>
          <button
            type="button"
            className={css.noticeButton}
            data-diff-notice-dismiss
            onClick={() => { setRedoClearedNotice(false) }}
          >
            {t('panel.dismiss')}
          </button>
        </div>
      )}
    </>
  )
  return docked
    ? content
    : <div className={wide ? css.layer : `${css.layer} ${css.rail}`} data-diff-approval-layer>{content}</div>
}
