/** Sidebar-foot pending-edit review action and the split review panel it opens. */

import { Component, Fragment, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { IconBrowseOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconEllipsisOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconPanelLeftOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, IconSettingsOutline16, Menu, Toast, Tooltip, writeClipboard } from './dsh-icons.ts'
import type { MenuEntry } from './dsh-icons.ts'
import { usePublishedSessionId, selectedSessionOf, sessionIsBlank } from './session-seat.ts'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  CommentQuoteLine, CommentRecord, DiffApprovalBlockRange, DiffApprovalCommentAddValue, DiffApprovalCommentAskValue,
  DiffApprovalCommentRemoveValue, DiffApprovalOpenAction, DiffApprovalRefreshOutcome, PendingFileDiff,
} from '../types.ts'
import type { CommentDraft } from './port.ts'
import type { PendingDiffSnapshot, PendingPanelFace, PendingViewHooks } from './slots.ts'
import type { Translator } from './locales.ts'
import { PathPicker, pathPickerOpen } from './PathPicker.tsx'
import { PresentationMenu } from './presentation-menu.tsx'
import { CoverageControl, CoverageNotice, COVER_NOTICE_MS } from './coverage-control.tsx'
// The chord vocabulary is shared: the header entry advertises the same summon
// hint this panel's close button spells, so both hint builders live in chords.ts.
import { actionTooltip, chordLabel, closeTooltip, escapeTooltip, summonTooltip, withChord } from './chords.ts'
import { blockRangesOf, changeBlocksOf, computeIntraLineDiff, computeWholeFileDiff } from './whole-file-diff.ts'
import {
  DISCUSSION_COMPOSE_ROWS, DISCUSSION_HEADER_ROWS, discussionOverlapping,
  discussionRowExtras, discussionRows, discussionRounds, discussionRuns, discussionStackOffsets,
  discussionText, frameCoversRemovedRow, frameNamesNoCurrentLine, quotedFrame, remapDiscussions, selectionFrame,
} from './discussion.ts'
import type { Discussion, DiscussionMessage, DiscussionQuoteLine } from './discussion.ts'
import { frameFollowIsAnimated, frameFollowKeyframes } from './scroll-follow.ts'
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
import { highlightWindow } from './highlight.ts'
import { langFromPath, suffixOfPath } from './lang.ts'
import { lineRangeLabel, referenceLabelOf } from './reference.ts'
import { newId } from './ids.ts'
import { CHIP_MENU_EVENT, OPEN_FILE_EVENT, replayFilePress } from './produced-diff.ts'
import type { ProducedChipMenuDetail } from './produced-diff.ts'
import type { DiffApprovalPresentation } from './settings.ts'
import { OPEN_PANEL_FILE_EVENT, PANEL_STATE_EVENT, SHOW_PANEL_EVENT, TOGGLE_PANEL_EVENT } from './dock.tsx'
import type { PanelFileDetail, PanelStateDetail } from './dock.tsx'
import { forgetPlacedThreadsNotIn, lastPanelFile, panelFileOffset, quietenRemovalAsk, rememberPlacedThreads, rememberThreads, rememberedPlacedThreads, rememberedThreads, rememberPanelView, removalAskQuiet } from './panel-memory.ts'
import type { PlacedThread, ThreadLocal } from './panel-memory.ts'
import { composerCoveredByPanel, leaveComposerCaret } from './composer-cover.ts'
import { commentModeEnabled, COMMENT_MODE_CHANGED_EVENT, confirmFileRemoveEnabled, COVER_CHANGED_EVENT, discussionRoundLimit, fileListFloat, includeUntrackedEnabled, keybindingOf, languageForSuffix, matchesShortcut, mdMaxWidth, mdPreviewEnabled, navLeadRows, panelCover, panelPresentation, pasteOnCopyEnabled, quickSummonKey, searchCaseSensitive, searchWholeWord, setFileListFloat, setLanguageForSuffix, setMdPreviewEnabled, setPanelCover, setPanelPresentation, setSearchCaseSensitive, setSearchWholeWord, setSplitMode, setWrapEnabled, splitMode, tabWidth, wrapEnabled, diffAddColor, diffDelColor, diffFontScale, diffLineHeight } from './settings.ts'
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
/**
 * File-list pane width bounds for the manual split drag, in px.
 *
 * The floor is the width the pane's bulk footer needs to keep its three labels on ONE line
 * (全部保留 / 全部回退 / 添加). Each is a `.action` — 12px text, 12px of side padding and a
 * hairline, so 26px of chrome — laid out in `.bulkActions` (6px gaps, and its own 8px right inset)
 * inside `.fileList`'s 8px side padding and 1px border: 74 + 6 + 74 + 6 + 66 + 8 + 17 = 251px, and
 * a hair of slack on top. Narrower than that the row shrinks its buttons until the labels wrap onto
 * two lines, which makes the pane's most-used controls two rows tall in the narrowest case — so the
 * floor is not just a drag limit, it is the width at which the footer is still itself.
 */
export const MIN_LIST_WIDTH_PX = 260
const MAX_LIST_WIDTH_PX = 560
/** Inset of the floating file-list card from the code scroll box, in px. */
const FLOAT_LIST_MARGIN_PX = 12
/** The folded card's width grip: how wide its hit strip is, and how much of it
 *  lies over the card (the rest overhangs the code view, so the card's own
 *  scrollbar strip stays clear). */
const FLOAT_GRIP_WIDTH_PX = 9
const FLOAT_GRIP_OVERHANG_PX = 3
/** How long the floating file list takes to fold away once it is put back — the
 *  `fileListShrink` animation's duration, which the panel holds the card for. */
const FILE_LIST_FOLD_MS = 140

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

/**
 * Whether one pending row belongs to a session's own view.
 *
 * A globally-unique entry is shown to every session that touched it (its `sessionIds`), so the rows a
 * panel may act on are the ones this answers true for — never whatever `snapshot.files` happens to hold
 * at that moment. The panel draws its own session's view (see `useSessionView`), so a row of another
 * session should not be there at all; this is the second line of that defence, and the one that still
 * holds for a legacy row carrying only a single `sessionId`.
 *
 * ONE exception, and it is the host's answer rather than the browser's: a row carrying `viaLineage` was
 * scoped into this session's view by the host's lineage MERGE, which is the only side that can walk a
 * lineage. It belongs to this view without this session having touched it, so it is taken as given — a
 * lineage walk here would need every hop the client has no data for.
 *
 * @param file - the pending row.
 * @param sessionId - the session this panel is showing.
 * @returns true only when that session is one of the row's own, or the host merged the row in.
 */
function belongsToSession(file: PendingFileDiff, sessionId: SessionId | undefined): boolean {
  if (sessionId === undefined) return false
  if (file.viaLineage === true) return true
  return touchedBy(file).includes(sessionId)
}

/**
 * One seat's own view of the pending list, as it is actually drawn.
 *
 * The seat reads the view for the session IT is about, so a poll another seat runs for another session
 * cannot put its files under this seat's badge — which is exactly what two live mounts did while they
 * shared one page-wide snapshot. The view arrives through `pendingView` (the store's per-session
 * reader); the SUBSCRIPTION that re-renders this seat is the `usePending` call beside it, which fires on
 * every publish and so wakes the seat to re-read its own slot. A publish that moved another session's
 * slot leaves this one's identity alone, so the render that follows draws the very same thing.
 *
 * `pageWide` is the fallback for a face with no per-session reader (a host, or a test, that offers only
 * `pending`), and it is also what a seat with no session of its own is shown.
 *
 * @param pendingView - the store's per-session view hook, when this face has one.
 * @param sessionId - the session this seat is about.
 * @param pageWide - the page-wide snapshot, used when there is no per-session reader.
 * @returns the view to draw.
 */
function useSessionView(
  pendingView: PendingViewHooks['pendingView'],
  sessionId: SessionId | undefined,
  pageWide: PendingDiffSnapshot,
): PendingDiffSnapshot {
  return useMemo(
    () => pendingView === undefined ? pageWide : pendingView(sessionId, view => view),
    [pendingView, sessionId, pageWide],
  )
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
/** The go-to-line glyph: an arrow landing on a line of code, drawn on the same 14-grid as
 *  `ViewModeIcon`, `MarkdownModeIcon` and `ReturnIcon` so a toolbar of these reads as one set. The
 *  icon library has no "go to line" mark, and a bare `#` beside three line drawings read as a stray
 *  key rather than a control. */
function GotoLineIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* The line it lands on —*/}
      <path d="M1.5 10.6h11" stroke="currentColor" strokeWidth="1.3" />
      {/* — and the arrow coming down onto it. */}
      <path d="M7 1.9v5.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.3 5.2 7 7.9l2.7-2.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  )
}

/** Return/enter glyph for the comment button: the key's own corner arrow, drawn on
 *  MarkdownModeIcon's 14-grid so the two read at the same weight. It is what tells
 *  the user that Enter sends the comment, without spending a row on the hint. */
function ReturnIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Shaft in from the right, then down; the head sits at the foot of it. */}
      <path d="M11.5 3.5 H4.5 V10.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M2.5 8.5 L4.5 10.5 L6.5 8.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  )
}
/** Total width of the two line-number gutters, subtracted from the code width
 *  when measuring wrapped line heights. */
const WRAP_GUTTERS_PX = 88
/** The dsh shell's sidebar auto-collapse breakpoint (ui-layout columns.ts):
 * below it the sidebar auto-collapses, and the file list floats on the same
 * breakpoint so the two stay consistent. */
export const SIDEBAR_AUTO_COLLAPSE_PX = 1024
/** How long a requested dock may take to actually show the panel before the
 *  overlay steps in. The tab body mounts a frame or two after the ask, so the
 *  wait is short — but a sidebar that accepts the ask and never brings the tab up
 *  must not swallow the click. */
const DOCK_REVEAL_GRACE_MS = 400

/** A shared canvas for measuring wrapped line heights (CPU-only, no DOM reflow). */
let measureCanvas: CanvasRenderingContext2D | undefined
/**
 * The font `measureCanvas` is currently set to, so a measurer can put its own back before it asks
 * for a width (see `makeMeasurer`). Every measurer shares the one context, and two of them are
 * alive at once — the thread's prose and its inline-code chips.
 */
let measureCanvasFont: string | undefined

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

/**
 * Wrap one line of a turn the way the browser lays it out: the prose by character, each inline-code
 * chip as one box that cannot be broken.
 *
 * `wrapInto` walks characters and nothing else, which is right for the code view and wrong here:
 * a turn's chip is an inline-flex box (the chat's own inline code, see `.discussionCode`), so half
 * of a chip never lands on the next line — it moves over whole, and the text after it starts after
 * the box rather than inside it. Measuring the chip as ordinary text therefore reserves the wrong
 * number of rows on exactly the lines that carry one, and a row too few is a clipped last line.
 *
 * The prose segments are wrapped by `wrapInto` itself, so a line with a chip in it breaks its words
 * and its spaces exactly where a line without one does; only the chips are placed as boxes.
 *
 * @param line - the line's text, markers and all: the runs are read the way the render reads them.
 * @param room - the width the line wraps in.
 * @param measure - the prose measurer.
 * @param chipWidth - the width of one chip's BOX (its text in the chip's own font, plus its padding
 *   and its hairline).
 * @param tabPx - one tab stop, in px.
 * @returns the row count for the line.
 */
export function wrapChipRows(
  line: string,
  room: number,
  measure: (text: string) => number,
  chipWidth: (text: string) => number,
  tabPx: number,
): number {
  let rows = 1
  let used = 0
  for (const run of discussionRuns(line)) {
    if (run.kind === 'code') {
      const width = chipWidth(run.text)
      // One box: it either fits where the line has got to, or it starts the next line. A chip wider
      // than the line itself stays put and overflows, which is what the browser does with it too.
      if (used > 0 && used + width > room) {
        rows += 1
        used = 0
      }
      used += width
      continue
    }
    if (run.text === '') continue
    // A chip that overflowed left no room to wrap in: the rest of the line starts a fresh row.
    // (The browser would flow on after the box; counting a row here is the safe side of that, and
    // an over-wide chip is a degenerate line either way.)
    if (used > room) {
      rows += 1
      used = 0
    }
    const parts = wrapInto(run.text, room - used, measure, tabPx)
    rows += parts.length - 1
    const last = parts[parts.length - 1] ?? ''
    used = parts.length === 1
      ? used + charsWidth(Array.from(run.text), measure, tabPx)
      : charsWidth(Array.from(last), measure, tabPx)
  }
  return rows
}

/**
 * Resolve the thread's own prose font for canvas measurement: the font the turns are drawn in.
 *
 * That is the app's message text (see `.discussionBody`), and the probe span is what carries it:
 * the turns themselves may not be in the DOM yet when a block is measured — the first render of a
 * new annotation happens before its bubble exists — while the probe is there as long as the panel
 * is. Reading the code cell was what this used to do, back when the thread was set in the code's
 * own face; the code cell still answers `codeFontOf`, and the chip its own (see `chipFontOf`).
 *
 * The string is rebuilt from the individual properties because canvas accepts no line height.
 *
 * @returns a canvas `font` string, or undefined when the panel is not mounted.
 */
function threadFontOf(): string | undefined {
  const probe = document.querySelector<HTMLElement>('[data-diff-thread-font]')
  if (probe === null) return undefined
  const computed = getComputedStyle(probe)
  return `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
}

/**
 * Resolve the inline-code chip's font for canvas measurement: the code face at
 * `DISCUSSION_CODE_FONT_SCALE` of the thread's prose size, which is what `.discussionCode` asks
 * for with `font-size: 0.875em`. The family comes off a code cell, which wears the same code token
 * the chip does.
 *
 * @returns a canvas `font` string, or undefined when there is no code cell to read.
 */
function chipFontOf(): string | undefined {
  const prose = document.querySelector<HTMLElement>('[data-diff-thread-font]')
  const code = document.querySelector<HTMLElement>('[data-diff-code]')
  if (prose === null || code === null) return undefined
  const size = Number.parseFloat(getComputedStyle(prose).fontSize)
  if (!Number.isFinite(size)) return undefined
  const computed = getComputedStyle(code)
  return `${computed.fontStyle} ${computed.fontWeight} ${size * DISCUSSION_CODE_FONT_SCALE}px ${computed.fontFamily}`
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
export function makeMeasurer(font: string | undefined): ((text: string) => number) | undefined {
  if (typeof document === 'undefined') return undefined
  try {
    if (measureCanvas === undefined) measureCanvas = document.createElement('canvas').getContext('2d') ?? undefined
  } catch {
    return undefined
  }
  const ctx = measureCanvas
  if (ctx === undefined) return undefined
  // The canvas's font is the context's own state, and every measurer shares the one context — so it
  // is set per call, not once here. Two measurers are alive at the same time (a thread's prose and
  // its inline-code chips, which are drawn in the code face at a share of the prose size), and a
  // measurer that set its font at creation left the OTHER one measuring in the wrong face from then
  // on: the wrap came out a line off — too many rows for a line of Latin (the code face is wider
  // there) and too few for a line of CJK, which is a block that either leaves a gap under the turns
  // or clips the writing row. Setting it here costs a string compare per ask and the context only
  // ever parses a font string when it actually changed.
  const current = (): CanvasRenderingContext2D => {
    if (font !== undefined && measureCanvasFont !== font) {
      ctx.font = font
      measureCanvasFont = font
    }
    return ctx
  }
  // One `measureText` per DISTINCT character, not per character drawn. The wrap walks a line
  // character by character and sums the advances, so a file asks for the same handful of widths
  // tens of thousands of times — and the canvas call is the expensive half of that loop. A
  // character's advance is a property of the font alone, so the cached number is the one the sum
  // would have used anyway. Only single characters are cached: the wrap's own widths are the ones
  // it asks for again and again, and keying whole lines would just hold the file in memory.
  const widths = new Map<string, number>()
  return text => {
    if (text.length !== 1) return current().measureText(text).width
    const cached = widths.get(text)
    if (cached !== undefined) return cached
    const width = current().measureText(text).width
    widths.set(text, width)
    return width
  }
}
/** The overview ruler's width in px (mirrors `.overviewRuler`). The flash is
 * kept off it even when the scroller has no vertical scrollbar. */
const OVERVIEW_RULER_WIDTH_PX = 4
/** The cap on a user bubble, as a share of the thread's width (mirrors
 * `.discussionUser`'s `max-width`, which is the chat's own `.userStack` cap). The
 * wrap measurement has to know it, since the bubble wraps at its cap, not at the
 * width of the block. */
const DISCUSSION_BUBBLE_MAX_WIDTH = 0.82
/** A user bubble's own vertical padding, as a share of a code row (mirrors
 * `.discussionUser`): the fill is the text plus 0.2 above and below. */
const DISCUSSION_BUBBLE_PADDING_ROWS = 0.2
/** The bubble's horizontal padding, as a share of a code row (mirrors
 * `.discussionUser`): its own 0.5 per side, and no margin outside it, so the fill is
 * flush with the thread's right column and this is what comes off the wrap width. */
const DISCUSSION_BUBBLE_SIDE_PADDING_ROWS = 0.5
/** The bubble's vertical margin, outside its fill (mirrors `.discussionUser`): with
 * the 0.2 padding above, half a row per side — one whole row of height. */
const DISCUSSION_BUBBLE_MARGIN_ROWS = 0.3
/**
 * The comment thread's own row height, in px — a fixed number, NOT the code's line height.
 * A thread is prose: it keeps the size the default settings show whatever the reader sets the
 * code's line height and font scale to, so a thread reads the same in a 10px code row as in a
 * 36px one. The block still reserves whole rows of its own, and the diff's height table takes
 * its exact pixel height (see the discussion extras below), so the rows under it stay exact.
 * Mirrors the literal 22px the thread's rules use in the stylesheet.
 */
const THREAD_ROW_PX = 22

/**
 * How close to a row's own height a measured block may sit and still count as that row, in px.
 *
 * A block whose content is a whole number of rows lands on either side of the pixel grid from one pass
 * to the next — the browser snaps the paint, so the same block measures 572.0004 one pass and 571.9996
 * the next. Rounding up without a band reads that as 27 rows and then 26, and every flip is a state
 * write from a layout effect: React counts those as nested updates and throws at fifty (minified #185,
 * which took the whole panel down). One pixel is far below any real change — the measurement is a row
 * grid — so a figure this close to the row below it IS that row.
 */
const DISCUSSION_ROW_SNAP_PX = 1

/**
 * The inline-code chip's own side padding, in px (mirrors `.discussionCode`'s `padding`): the
 * chip is wider than its text, so the row measurement takes that width off the line it sits in.
 * Without it a line whose chip ends near the wrap point would wrap in the DOM where the count
 * said it did not — which is a row too few, and a clipped last line.
 */
const DISCUSSION_CODE_PADDING_PX = 5

/**
 * The inline-code chip's own border width, in px (mirrors `.discussionCode`'s `border: 0.5px`, which
 * is the chat's own hairline): the chip's box is its text plus the padding plus this on each side.
 *
 * The stylesheet says 0.5px and this says 1px on purpose: a non-zero border is laid out a whole
 * pixel wide (measured in Blink at both 1x and 2x — the chip's own box comes out 2px wider than its
 * text and padding), so a model built on the half pixel would under-reserve by a pixel a chip, and
 * a row too few is a clipped line.
 */
const DISCUSSION_CODE_BORDER_PX = 1

/**
 * The share of the thread's prose size an inline-code chip is drawn at (mirrors
 * `.discussionCode`'s `font-size: 0.875em`, which is the chat's own inline code against its own
 * message text). The chip is measured in its own font, not in the prose one — a code face at
 * twelve and a bit pixels is not the UI face at fourteen — so the row count follows the run the
 * reader actually sees.
 */
const DISCUSSION_CODE_FONT_SCALE = 0.875

/** The thread's own side inset in px (mirrors `.discussionBody`'s padding): the one
 * column every turn starts from, so no turn carries a side inset of its own. */
const DISCUSSION_BODY_INSET_PX = 12
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
  & PendingPanelDockProps & PendingPanelSeat

/**
 * The session this mount is for, when the shell composes one into the seat.
 *
 * Session-scoped seats are handed it on 0.1.7; the root-scoped footer slot that hosts this panel is
 * not, and neither is the dock tab. The other two sources are read where this is absent (see
 * `session-seat.ts`).
 */
export interface PendingPanelSeat {
  sessionId?: SessionId | undefined
}

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
  /**
   * Whether this seat is SHOWING anything, and so whether it should read the host at all.
   *
   * A seat that is not on screen — a docked tab the reader has switched away from — draws nothing, so
   * its poll reads a list nobody is looking at, once a second, for a session the reader may not even be
   * in. `false` stops that read; the seat keeps what it last read and starts again the moment it is
   * shown. Absent means "always showing", which is what the footer entry is: its badge is the reader's
   * at-a-glance count, and a badge that never read would simply show nothing.
   */
  showing?: boolean
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
function openSettingsSection(sectionLabel: string): void {
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
  /** Picked for a decision over several files (Ctrl/Cmd-click). Not the same as `selected`. */
  picked: boolean
  /**
   * Which sentence this row's mark wears, or `undefined` for no mark at all (see `lineageNoteOf`): the host's
   * `viaLineage` for a row that is here only because of the merge, its `hasChildContribution` for a row this
   * session touched that another session in its lineage touched too — and its `lineageDirection` for WHICH
   * way that other session stands, so the same row reads right from either seat. Marked, never moved, and
   * still actionable exactly like this session's own — the host resolves the owner for a keep or a revert.
   */
  lineageNote: LineageNoteKey | undefined
  /** The last keep/revert failure for this file, shown as an inline tag. */
  failedMessage?: string | undefined
  t: Translator
  /** A press on the row: the caller decides whether it opens the file or picks it. */
  onSelect: (event: ReactMouseEvent<HTMLElement>, id: string) => void
  /** A right-click on the row: the panel opens the row's action menu at the press. */
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void
}

/**
 * The sessions that touched one listed row.
 *
 * The host sends every one of them (`sessionId` and `sessionIds`), and a row written by an older build
 * carries only the single id — the same tolerance `belongsToSession` keeps.
 * @param file - the listed row.
 * @returns the owning sessions, never empty.
 */
function touchedBy(file: PendingFileDiff): readonly SessionId[] {
  const ids = file.sessionIds
  return Array.isArray(ids) && ids.length > 0 ? ids : [file.sessionId]
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

/**
 * The one-line title a comment is listed under in the comments tab: the first sentence of what the
 * reader wrote in it. A record's text IS the annotation (later turns are follow-ups on the same
 * rows, questions the host keeps separately), so that is the comment's own voice; the sentence is
 * cut at its own full stop, and the list ellipsises whatever is still too long for the column (see
 * `.commentTitle`).
 *
 * A record with no text has nothing to quote — the caller names it with the comment box's own
 * placeholder, so the item says what that box is asking for rather than claiming a title.
 *
 * @param text - the comment's text.
 * @returns the title, or an empty string when there is nothing to say yet.
 */
function commentTitle(text: string): string {
  const line = text.split('\n').find(part => part.trim() !== '') ?? ''
  const stop = /[。！？!?]/.exec(line)
  return (stop === null ? line : line.slice(0, stop.index + 1)).trim()
}

/**
 * The model row that holds one new-file line, or the last row that reads before it.
 *
 * The list's comments tab names a comment by the LINES it was written on (it draws no rows, so it has
 * no row index to give), and a jump has to land the way every other jump does. A line the model no
 * longer holds — an outdated thread — lands on the last row before it, which is exactly where
 * `remapDiscussion` hangs a thread whose range is gone, so the box the reader came for is on screen.
 *
 * A row the file STILL HAS wins over one it is offering to take away, because a modified file numbers
 * both sides and the same number is often carried by each: the row for old line 378 sits in the row
 * stream just above the row for new line 378 (that is what a four-line deletion above the line looks
 * like), and reading `newLine ?? oldLine` in one pass answers with the DELETED row. Landing there put
 * the view above the code the number names — which is a comment's box with its top edge cut off by the
 * viewport, the report this answers. The deleted row is still the right answer when the line exists
 * nowhere else, and the last row before it when the file has moved past the number altogether.
 *
 * @param rows - the current model's rows.
 * @param line - the new-file line to find.
 * @returns the row index, or undefined when no row reads before that line.
 */
export function rowOfLine(rows: readonly WholeFileDiffRow[], line: number, oldSide = false): number | undefined {
  let before: number | undefined
  let removed: number | undefined
  let named: number | undefined
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const value = row.newLine ?? row.oldLine
    if (value === undefined) continue
    // The row the file as it reads NOW calls that line, and the removal that carried that number in the
    // old file. Both are collected rather than returned on the spot, because which one the caller means
    // is the third argument: a comment written on a removed line has no current line at all, and the
    // number it holds happens to name a DIFFERENT line of the file now (see `frameNamesNoCurrentLine`).
    if (row.newLine === line) {
      if (named === undefined) named = index
    } else if (value === line && removed === undefined) {
      removed = index
    }
    if (value < line) before = index
  }
  // Old side, and a removal does carry it: that removal is the answer, and the current line that reads
  // that number is not. Otherwise the lookup is exactly what it always was — the current line first,
  // then a removal, then the last row before the number.
  if (oldSide && removed !== undefined) return removed
  return named ?? removed ?? before
}

/**
 * The new-file lines a row range covers, or `undefined` when it covers none.
 *
 * A changed line is two rows here — the removed copy and the line that replaced it — and each carries
 * a number of its own file and nothing on the other side. Reading them together (`newLine ?? oldLine`)
 * is what let a removal's old number stand in for a current line, so the range then named a line the
 * reader never picked. This reads the NEW side alone: the lines the file has, which is what every
 * label, jump and reference shows and what a thread is anchored to. A frame that covers none of them
 * has nothing to anchor to at all (see `selectionFrame`).
 *
 * The range is contiguous and the new side numbers its rows in order, so the answer is `undefined` or
 * one contiguous run: the first and last row of the frame that has a new-file line.
 *
 * @param rows - the current model's rows.
 * @param range - the row range (inclusive).
 * @returns the line range, or `undefined` when the frame holds no current line.
 */
function newLinesInRows(
  rows: readonly WholeFileDiffRow[],
  range: RowRange,
): { startLine: number; endLine: number } | undefined {
  let startLine: number | undefined
  let endLine: number | undefined
  for (let index = range.start; index <= range.end; index++) {
    const line = rows[index]?.newLine
    if (line === undefined) continue
    if (startLine === undefined) startLine = line
    endLine = line
  }
  return startLine === undefined || endLine === undefined ? undefined : { startLine, endLine }
}

/**
 * The record's gutter pairs as the thread's own quote lines.
 *
 * The record's type is the host's (a wire record, where a side may simply be absent); the thread's
 * is the renderer's (each side is a `number | undefined` it always reads). They say the same thing,
 * so this is the one place that says so.
 *
 * @param lines - the record's quoted gutter pairs.
 * @returns the same pairs as the block reads them.
 */
function quoteLinesOf(lines: readonly CommentQuoteLine[]): DiscussionQuoteLine[] {
  return lines.map(line => ({
    old: line.old,
    new: line.new,
    ...(line.kind === undefined ? {} : { kind: line.kind }),
  }))
}

/**
 * Whether two answer maps say the same thing.
 *
 * The panel derives its threads from these, and a poll hands it a freshly built map every second.
 * Comparing them by content is what keeps an unchanged read from re-deriving every thread (a
 * re-anchor joins the file's row windows) and from handing every block a new object to draw.
 *
 * @param a - the answers the pane last derived from.
 * @param b - the answers the snapshot now carries.
 * @returns true when every question has the same answer text.
 */
function sameAnswers(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * One host record as the block that draws it.
 *
 * The record's `anchor` line numbers are the thread's position; the ROW indices are not in it (they
 * are model-relative, so the host could not keep them — see `CommentRecord`), and the caller
 * re-anchors what this returns against the current model.
 *
 * The turns are the annotation and then, for each question in the order it was asked, the question's
 * own words and the answer to it when one exists. The first question is the annotation itself — its
 * words ARE `record.text` — so it is not drawn a second time: a three-question thread reads
 * annotation, Q2, A2, Q3, A3. A question still in flight contributes its words and then nothing,
 * which is what the block's waiting note sits under; a dropped question says so instead of waiting
 * for an answer that is not coming, and a question whose turn has ended with no answer says the
 * answer was stopped (the transcript decides: `ended` only says the turn is over).
 *
 * @param record - the stored comment.
 * @param answers - the derived answer text per question id.
 * @param local - the page-local state of every thread (draft, fold, measured body).
 * @returns the discussion the block draws.
 */
function discussionOfRecord(
  record: CommentRecord,
  answers: Readonly<Record<string, string>>,
  local: Readonly<Record<string, ThreadLocal>>,
): Discussion {
  const asks = record.asks ?? []
  const last = asks.at(-1)
  const answered = last === undefined ? undefined : answers[last.requestId]
  const messages: DiscussionMessage[] = [
    // The first turn is whoever wrote the annotation: the reader's own words for a comment they made,
    // and the agent's for a card the agent placed on the code (see `CommentRecord.author`). Drawing the
    // agent's explanation as the reader's would put words in their mouth.
    { role: record.author === 'agent' ? 'assistant' : 'user', text: record.text },
  ]
  asks.forEach((ask, index) => {
    // The first question IS the annotation: the reader popped the compose row on those rows and its
    // words became `record.text`, so drawing `ask.text` too would show the same sentence twice.
    if (index > 0 && typeof ask.text === 'string' && ask.text !== '') {
      messages.push({ role: 'user', text: ask.text })
    }
    const answer = answers[ask.requestId]
    if (answer !== undefined) messages.push({ role: 'assistant', text: answer })
  })
  const state = local[record.id]
  return {
    id: record.id,
    anchor: { start: 0, end: 0, startLine: record.anchor.startLine, endLine: record.anchor.endLine },
    messages,
    draft: state?.draft ?? '',
    collapsed: state?.collapsed ?? false,
    quote: record.quote,
    ...(record.quoteContext === undefined ? {} : { quoteContext: record.quoteContext }),
    ...(record.quoteLines === undefined ? {} : { quoteLines: quoteLinesOf(record.quoteLines) }),
    // Waiting is "the newest question has no answer yet, and nothing has said it is over": a question
    // the session dropped is the failure the block has always reported for one that will never be
    // answered, and one whose turn ENDED is the stop note below. A send this pane refused outright is
    // page-local (`failed` below), because no question was ever stored for the host to know about.
    ...(last !== undefined && answered === undefined && last.dropped !== true && last.ended !== true
      ? { asking: true } : {}),
    ...(state?.failed === true || (last !== undefined && last.dropped === true) ? { failed: true } : {}),
    // The turn that claimed the newest question is over and the transcript holds no answer for it:
    // the question was cut off, and the reader is told so rather than left waiting on a turn that
    // ended. Only ever read when there is no answer — the transcript is what decides that.
    ...(last !== undefined && answered === undefined && last.ended === true && last.dropped !== true
      ? { stopped: true } : {}),
    // What the host has not been told the reader has looked at: the card's dot. Carried through
    // untouched — the panel never decides this for itself, because a client's idea of "seen" would be
    // the second client of the same session reading a thread the reader has not opened.
    ...(record.unseen === true ? { unseen: true } : {}),
  }
}

/**
 * One placed-but-unsent block as the block that draws it: the reader's compose row, and nothing else
 * yet. Its words come from the placement itself (they are the only copy of an unsent question), and
 * the fold and the measured body from the page-local thread state, as for any other thread.
 * @param thread - the placement, as the page's memory holds it.
 * @param local - the page-local state of every thread.
 * @returns the discussion the block draws.
 */
function discussionOfDraft(
  thread: PlacedThread,
  local: Readonly<Record<string, ThreadLocal>>,
): Discussion {
  const state = local[thread.id]
  return {
    id: thread.id,
    anchor: thread.anchor,
    messages: [],
    draft: thread.draft,
    collapsed: state?.collapsed ?? false,
    quote: thread.quote,
    ...(thread.quoteContext === undefined ? {} : { quoteContext: thread.quoteContext }),
    ...(thread.quoteLines === undefined ? {} : { quoteLines: thread.quoteLines }),
    ...(state?.failed === true ? { failed: true } : {}),
  }
}

/** The right detail pane for one selected file: actions plus the merged diff. */
interface PendingDiffProps {  file: PendingFileDiff
  /**
   * The session the panel is VIEWING: the one whose list is on screen, and the only one
   * that can answer a comment. Deliberately not `file.sessionId`, which names the session
   * that most recently TOUCHED the file — often a subagent whose agent is gone by the time
   * the reader comments, which is why asking there could only fail with "no agent".
   */
  sessionId: SessionId
  busy: boolean
  /** The current workspace root, for workspace-relative copied references. */
  workspacePath?: string | undefined
  /** Bumped by the panel when the already-open file is clicked again: jumps
   * to the next change block. */
  jumpSignal: number
  /** Bumped when an undo/redo touched the currently open file: re-select the
   * undone diff (flash its first change block). */
  undoFlash: number
  /** The code view's offset to open this file at, when the panel resumed a
   *  remembered view; absent means the file's first change block. */
  landingTop?: number | undefined
  /** Bumped with every landing request, so a repeated one for the file already
   *  open (the produced-file chip, clicked twice) lands again. */
  landingTick?: number | undefined
  /** A model row to land on — a jump to a comment, from the list's comments tab. It lands the way a
   *  jump to a change block does: the configured lead rows above the row. No frame is drawn around the
   *  block that holds it, though — the reader asked for the comment, not for the change (see the
   *  landing effect). */
  landingRow?: number | undefined
  /**
   * A new-file LINE to land on — a jump to a comment from the list's comments tab. The list draws no
   * rows, so it names the line the comment was written on and this pane resolves it against the model
   * it is holding (see `rowOfLine`). It lands exactly like `landingRow` once resolved, and it is the
   * FALLBACK: when `landingComment` names a thread this pane draws, the row its box hangs at is a fact
   * here — the line is a number the record may have outlived, or one the added side of the diff does
   * not own (see `rowOfLine`).
   */
  landingLine?: number | undefined
  /**
   * Whether that fallback line came from the OLD file, when the comment's frame held no current line
   * at all (see `frameNamesNoCurrentLine`). It changes which row the number resolves to: the removal
   * that carries it, rather than whatever current line happens to read that number now.
   */
  landingOld?: boolean | undefined
  /** The comment a jump is for, when it came from the list's comments tab. This pane draws that
   *  thread, so its `anchor.end` IS the row its box hangs at — the one place the row can be read
   *  without going through a line number at all. */
  landingComment?: string | undefined
  /** Land on the thread's own box rather than on the row above: what an outdated comment gets, since
   *  the code it was written about is gone and the position its numbers point at says nothing. */
  landingCard?: boolean | undefined
  /** Called once this pane has taken the landing above. The panel spends it then, so a pane that
   *  mounts later for the same open file cannot land it again (see the landing effect). */
  onLanded?: (() => void) | undefined
  /** The last keep/revert failure for this file, shown as an inline banner. */
  failedMessage?: string | undefined
  /**
   * The answer-rules skill this host can deliver. With it, a comment prompt points at
   * the skill and carries no rules of its own; without it, the prompt carries them.
   */
  commentSkill?: string | undefined
  /** Paste a copied reference into the session's chat input and focus it. */
  onPasteReference: (sessionId: SessionId, reference: string) => void
  /**
   * The session's comment records, as the host holds them. This file's are the threads the pane
   * draws: a thread is the host's record, not the page's, so the panel renders the snapshot
   * rather than a copy of it (see `PendingDiffSnapshot.comments`).
   */
  comments: readonly CommentRecord[]
  /** The derived answer text per question id, read by the host from the session's transcript. */
  commentAnswers: Readonly<Record<string, string>>
  /** The host's comment revision counter: a changed value means the records themselves changed. */
  commentsRevision: number
  /**
   * The new-file lines the HOST resolved each comment to, keyed by comment id (see the wire type).
   *
   * Every number this pane PRINTS for a comment comes from here — the card's own chip, and the
   * reference a question carries — so the card and the list cannot name two lines for one thread. A
   * comment the host could not place is absent, and its card prints `record.anchor`: the line it was
   * written on, which is what an outdated thread shows. Where the card is DRAWN is still this pane's
   * own business (`remapDiscussions`): that is layout, not a number.
   */
  commentLines: Readonly<Record<string, { start: number; end: number }>>
  /**
   * Write one annotation down. The host refuses a comment on an entry that has left the list,
   * which the pane reports instead of drawing a thread the host does not have.
   */
  onCommentAdd: (sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>
  /** Drop one annotation (the host's record goes; the next read is what shows it). */
  onCommentRemove: (sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>
  /**
   * Ask one stored comment; the answer arrives on a later read, derived by the host. `prompt` is
   * what the agent is asked and `text` is the reader's own words inside it — the host stores those
   * on the question, which is the only place a follow-up's words exist (see `CommentAsk`).
   */
  onCommentAsk: (sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>
  /** The reader has this comment's card in view: its unseen dot goes out. */
  onCommentSeen?: ((sessionId: SessionId, id: string) => void) | undefined
  /** Show a transient toast (used when a reference is copied to the clipboard). */
  onToast: (text: string) => void
  t: Translator
  /** `keepListed` answers the whole-file prompt up front: false removes the entry outright. */
  onKeep: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** The reader is looking at this file now: its row's unseen dot goes out. */
  onMarkSeen?: ((sessionId: SessionId, id: string) => void) | undefined
  onRevert: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** Replace this file's diff with its current local VCS change. */
  onRefreshVcs: (file: PendingFileDiff) => void
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Inline one workspace image as a base64 data URI for the Markdown preview. */
  onPreviewImage: (sessionId: SessionId, path: string) => Promise<string | undefined>
  /**
   * Open the path typed into the header field: false when it could not be opened.
   *
   * The detail's field and the list's Add button both land here. The field does not
   * select directly — it goes through {@link OPEN_PANEL_FILE_EVENT}, so the overlay
   * and the docked tab agree on what is open and the landing is the one every other
   * way of opening a file uses.
   */
  onAddTypedPath: (path: string) => Promise<{ openPath?: string } | undefined>
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

/**
 * The code an outdated thread was written about.
 *
 * Laid out as the file's own rows are: the same two 44px gutters — with the numbers the lines
 * had — then the code column, so the quote sits on the file's columns rather than in a box of
 * its own. Highlighted with the same highlighter the rows use, on the language the file is read
 * in: a quote of code that renders as grey prose three rows under coloured code reads as a
 * different kind of thing. No search hits either — those belong to the file, and the quote is
 * not in it. The tokenize is memoised per quote and language, and the window is exactly the
 * quote, so a long one is one bounded job; an unknown language comes back plain.
 *
 * @param props.quote - the code, one line per `\n`.
 * @param props.lines - each line's gutter pair, in the same order.
 * @param props.lang - the grammar id the file is read in, or `undefined` for plain text.
 * @param props.wrap - the code view's wrap setting: off, the quote is one line per quoted line,
 * as the file renders it.
 */
/**
 * One turn's text as the thread draws it: its literal runs, its inline `code`, its **bold**.
 *
 * The thread draws on the diff's own row grid, so these two are the whole of the inline
 * Markdown it knows (see `discussionRuns`); everything else is left exactly as written.
 *
 * @param text - the turn's text.
 * @returns its nodes, in order.
 */
function discussionNodes(text: string): ReactNode[] {
  return discussionRuns(text).map((run, index) => {
    if (run.kind === 'code') return <code className={css.discussionCode} key={index}>{run.text}</code>
    if (run.kind === 'strong') return <strong key={index}>{run.text}</strong>
    return run.text
  })
}

function DiscussionQuote({ quote, lines, lang, wrap, split }: {
  quote: string
  lines: readonly DiscussionQuoteLine[] | undefined
  lang: string | undefined
  wrap: boolean
  /**
   * The side-by-side view draws one row per ALIGNED PAIR, in the two columns the file itself shows
   * (left = the old file, right = the new one): a selection there covers both halves, so the thread
   * it became quotes both, and a single-column quote would show only half of what it was about.
   */
  split: boolean
}) {
  /** The diff's own wash for a quoted row, or nothing for context (and for older threads). */
  const wash = (kind: DiscussionQuoteLine['kind']): string => (
    kind === 'add' ? ` ${css.quoteAdd}` : kind === 'del' ? ` ${css.quoteDel}` : ''
  )
  const texts = useMemo(() => quote.split('\n'), [quote])
  /** The quoted lines paired the way the split view pairs the file's rows. */
  const pairs = useMemo(() => {
    if (!split) return undefined
    const rows = texts.map((text, index) => {
      const line = lines?.[index]
      // The recorded gutter pair and kind are the row's own; a thread quoted before they were kept
      // has neither, and then reads as context.
      return { text, kind: line?.kind ?? 'context', oldLine: line?.old, newLine: line?.new } as WholeFileDiffRow
    })
    return computeSideBySideDiff(rows, true).pairs
  }, [split, texts, lines])
  /**
   * One column's lines and the highlighted runs each draws. Highlighted per column rather than from
   * one window over the quoted rows: a multi-line construct must not light up across the divider,
   * which is also how the file's own two columns are lit.
   */
  const sides = useMemo(() => {
    if (pairs === undefined) return undefined
    const build = (which: 'left' | 'right'): {
      lines: string[]
      runs: ReturnType<typeof highlightWindow>
    } => {
      const columnLines = pairs.map(pair => pair[which]?.text ?? '')
      return { lines: columnLines, runs: highlightWindow(columnLines, lang, 0, columnLines.length) }
    }
    return { left: build('left'), right: build('right') }
  }, [pairs, lang])
  /** One line's nodes: the highlighted runs it draws, or its own text when nothing highlighted it. */
  const nodesOf = (
    lineRuns: readonly { style: CSSProperties; text: string }[] | undefined,
    text: string,
  ): ReactNode[] => {
    if (lineRuns === undefined) return [text]
    const content: ReactNode[] = []
    for (const run of lineRuns) content.push(<span key={content.length} style={run.style}>{run.text}</span>)
    return content
  }
  const rows = useMemo(() => {
    const runs = highlightWindow(texts, lang, 0, texts.length)?.runs
    return texts.map((text, index) => ({ content: nodesOf(runs?.[index], text), gutter: lines?.[index] }))
  }, [texts, lines, lang])
  if (pairs !== undefined && sides !== undefined) {
    /** The tint a pair's two cells wear, the same way the file's columns tint theirs. */
    const pairWash = (which: 'left' | 'right', kind: SplitPair['kind']): string => (
      which === 'left' ? wash(kind === 'context' ? 'context' : 'del') : wash(kind === 'context' ? 'context' : 'add')
    )
    return (
      <div
        className={`${css.quoteLines} ${css.quoteSplit}${wrap ? '' : ' ' + css.quoteNoWrap}`}
        data-diff-discussion-quote
      >
        {(['left', 'right'] as const).map(which => (
          <div className={css.quoteSplitSide} data-diff-quote-side={which} key={which}>
            <div className={css.quoteSplitTable}>
              {pairs.map((pair, index) => (
                <div className={css.quoteLine} data-diff-quote-pair key={index}>
                  <span className={css.gutter} data-diff-quote-gutter>{pair[which]?.line ?? ''}</span>
                  <span className={`${css.quoteCode}${pairWash(which, pair.kind)}`}>
                    <span
                      className={css.quoteText}
                      data-diff-quote-text
                      data-diff-quote-side={which}
                    >
                      {nodesOf(sides[which].runs?.runs?.[index], sides[which].lines[index] ?? '')}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={`${css.quoteLines}${wrap ? '' : ' ' + css.quoteNoWrap}`} data-diff-discussion-quote>
      {rows.map((row, index) => (
        // One code row each, in the file's own two gutter columns: the numbers are what the
        // reader navigates by, and a quote without them cannot be looked up.
        <div
          // The row keeps the colour it had in the file: a quote of added and removed lines that
          // renders as plain code loses exactly what the reader was looking at.
          className={`${css.quoteLine}${wash(row.gutter?.kind)}`}
          data-diff-quote-kind={row.gutter?.kind}
          key={index}
        >
          <span className={css.gutter} data-diff-quote-gutter>{row.gutter?.old ?? ''}</span>
          <span className={css.gutter} data-diff-quote-gutter>{row.gutter?.new ?? ''}</span>
          {/* The text is a block of its own so an unwrapped long line is clipped here rather
              than overflowing the block: an ancestor that can scroll sideways is one a jump or
              a focus can scroll, which is what pushed the whole thread left in a narrow panel. */}
          <span className={css.quoteCode}><span className={css.quoteText} data-diff-quote-text>{row.content}</span></span>
        </div>
      ))}
    </div>
  )
}

/** How far outside the viewport a side-by-side thread's card is still drawn, in px: it is a pair's
 *  hop from the edge before the scroll brings it in, and dropping it earlier would flash the card
 *  away at the boundary. */
const SPLIT_DISCUSSION_MARGIN_PX = 200

/**
 * How much of a comment's card must be visible before the reader counts as having looked at it.
 *
 * Half is the point where the card is in front of them rather than passing by, and it is the same
 * bar for the fold: a card the reader has only scrolled past on the way somewhere else never reaches
 * it, so a change they never saw does not go quiet.
 */
const COMMENT_SEEN_THRESHOLD = 0.5

/**
 * How long that half-visible state must HOLD before the card is reported seen, in ms.
 *
 * The observer fires on the way past as well as on the way to: a scroll that flings a card through
 * the viewport for two frames is not reading it, and clearing the dot then would lose the one signal
 * the dot carries. Three quarters of a second is below the time it takes to read the header of a card
 * the reader actually stopped on, and well above a scroll's own pass.
 */
const COMMENT_SEEN_DWELL_MS = 700

/**
 * Report a card seen once the reader has actually been looking at it, and say so on screen at the
 * same moment.
 *
 * The intersection is only half the question: the browser has no idea whether a visible card was read
 * or flung past, so the dwell above is what turns "on screen" into "looked at". Nothing is ever
 * reported twice — the first report is the reader's one look, and the flag cannot come back without a
 * new answer.
 *
 * The second half is the dot. The host only takes the flag down on its next list read, so a card that
 * reported itself would go on wearing its dot for the dwell PLUS that round trip (up to a poll cycle):
 * the panel would spend that whole time telling the reader about attention it had just said was spent.
 * The report and the local clearing are therefore one act, in the same tick, and `dotOff` below is what
 * the card's dot reads — the host is still told (nothing about `comment-seen` moved, and the flag still
 * has to travel), but the panel no longer draws a mark it knows is answered.
 *
 * @param unseen - whether the host still has attention to clear for this card.
 * @param onSeen - what to tell the host (absent in a panel with no host behind it).
 * @returns the ref to hang on the card's own element, and `dotOff` — this reader has already reported
 *   that card, so its dot stays down whatever the host has answered.
 */
function useSeenOnView(unseen: boolean, onSeen: (() => void) | undefined): {
  ref: (element: HTMLElement | null) => void
  dotOff: boolean
} {
  const cardRef = useRef<HTMLElement | null>(null)
  const seenRef = useRef(false)
  const [dotOff, setDotOff] = useState(false)
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  useEffect(() => {
    const card = cardRef.current
    // The host's flag is the EPISODE, and one card outlives its episodes: the render sites key the card
    // `discussion.id`, which is `record.id`, and `unseen` is a plain prop — so a second answer on the same
    // comment comes back to this same instance with `seenRef` and `dotOff` still standing from the first
    // look. The host clearing the flag is the one moment the episode is over: the look it was waiting for
    // has been reported and taken down, so the guard is re-armed and the local mark dropped here. A later
    // `unseen: true` is then a new episode — a new dot, and a new look to report — rather than a card that
    // looks permanently read.
    if (!unseen) {
      seenRef.current = false
      setDotOff(false)
    }
    // Observed only while there is attention to clear, and stop observing once THIS episode's look has been
    // reported: the same episode is not reported twice.
    if (card === null || !unseen || seenRef.current) return undefined
    if (typeof IntersectionObserver !== 'function') return undefined
    let timer: number | undefined
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry === undefined) return
      const dwelling = entry.isIntersecting && entry.intersectionRatio >= COMMENT_SEEN_THRESHOLD
      if (!dwelling) {
        // Scrolled back out before the dwell was up: the reader was passing, not reading.
        if (timer !== undefined) window.clearTimeout(timer)
        timer = undefined
        return
      }
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        seenRef.current = true
        observer.disconnect()
        // The reader's look is spent HERE, and the dot goes with it: `dotOff` lands in the same
        // render as the report, so the card cannot wear a mark the reader has just answered.
        setDotOff(true)
        onSeenRef.current?.()
      }, COMMENT_SEEN_DWELL_MS)
    }, { threshold: COMMENT_SEEN_THRESHOLD })
    observer.observe(card)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [unseen])
  // Held only while the host still has attention for this card: once its answer lands the flag is
  // false, and this local mark can never outlive the episode it was made for.
  return { ref: useCallback((element: HTMLElement | null) => { cardRef.current = element }, []), dotOff: unseen && dotOff }
}

/** One comment thread as the panel draws it, whoever is drawing it. */
interface DiscussionBlockProps {
  discussion: Discussion
  /** The `path:lines` reference the header wears, from the thread's own anchor. */
  label: string
  /** The panel's width, ruler strip included: the card is laid out to it (see the style below). */
  bodyWidth: number
  /** The file's language, for the quote's highlighting. */
  lang: string | undefined
  /** Whether this block's ⋯ menu is the open one. */
  menuOpen: boolean
  /** Whether THIS thread is waiting on an answer: only its own send button is refused then. */
  asking: boolean
  t: Translator
  onToggle: (id: string) => void
  onMenuOpen: (id: string | undefined) => void
  onRemove: (id: string) => void
  onDraft: (id: string, value: string) => void
  onSend: (id: string) => void
  /** Hands the writing field's element to the panel, so a send can ask for the caret back. */
  registerInput: (id: string, element: HTMLInputElement | null) => void
  /**
   * The reader has this card in front of them, held there: the host takes its unseen dot down. Not
   * called for a card the panel never drew, and never called twice for one look.
   */
  onSeen?: (() => void) | undefined
  /** The card is drawn in the side-by-side view, whose code it quotes as two columns. */
  split: boolean
}

/**
 * A thread's card: the header (range, fold, ⋯ , the quote when the code it was written about is
 * gone, the turns, and the writing row.
 *
 * Every view draws the same card — the single-column code view hangs it in a row of its own below
 * the rows the thread annotates, and whatever view comes next hangs it under whatever it draws that
 * anchor as — so it is a component rather than a piece of one view's row stream. What varies per
 * view is only the wrapper around it and the width it is given.
 *
 * @param props - the thread, where it hangs, and the panel's own callbacks.
 * @returns the card, sized to the rows the panel laid the thread out in.
 */
function DiscussionBlock({
  discussion, label, bodyWidth, lang, menuOpen, asking, t,
  onToggle, onMenuOpen, onRemove, onDraft, onSend, registerInput, onSeen, split,
}: DiscussionBlockProps) {
  const rows = discussionRows(discussion)
  const menuItems: MenuEntry[] = [{ id: 'delete', label: t('action.discussionEnd') }]
  // The reader looking at the card is what clears the host's dot: the card is the only place a comment
  // can be read in full, so its own visibility is the signal (see `useSeenOnView`).
  const { ref: cardRef, dotOff } = useSeenOnView(discussion.unseen === true, onSeen)
  return (
    <div
      className={css.discussion}
      data-diff-discussion
      data-lost={discussion.lost === true ? '' : undefined}
      data-diff-discussion-id={discussion.id}
      ref={cardRef}
      style={{
        // The panel's own width, ruler strip included. The block's background is transparent, so the
        // only thing that would land on the ruler is what the reader came for: its two edge lines
        // (they are drawn inside the block, so they can only ever reach as far as the block does)
        // and the left rule. The thread's own content keeps its 12px inset, so no text goes under the
        // ruler. The row measurements stay conservative by the same 4px on purpose.
        width: Math.max(0, bodyWidth),
        height: rows * THREAD_ROW_PX,
      }}
    >
      <div className={css.discussionHead}>
        <button
          type="button"
          className={css.discussionToggle}
          data-diff-discussion-toggle
          aria-expanded={!discussion.collapsed}
          aria-label={t(discussion.collapsed ? 'action.discussionExpand' : 'action.discussionCollapse')}
          onClick={() => { onToggle(discussion.id) }}
        >
          {discussion.collapsed
            ? <IconChevronDownOutline14 size={12} />
            : <IconChevronUpOutline14 size={12} />}
        </button>
        <span className={css.discussionRangeWrap}>
          {/* The dot is the first thing the header says after the fold arrow, and it says it about the whole
              card. It is an inline mark here rather than the file row's out-of-flow one: this card clips its
              overflow, and the head's left edge is the arrow's. It carries a title and an aria-label, so
              colour is never the only cue. `dotOff` is the file row's `!selected` in this card's shape: the
              card has reported the reader's look, so drawing the mark while the host's answer is in flight
              would say the opposite of what the card just told it. */}
          {discussion.unseen === true && !dotOff && (
            <svg className={css.unseenDot} data-diff-comment-unseen width="3" height="3" viewBox="0 0 3 3" role="img" aria-label={t('panel.unseen')}>
              <title>{t('panel.unseen')}</title>
              <circle cx="1.5" cy="1.5" r="1.5" fill="var(--dsw-alias-state-business-primary)" />
            </svg>
          )}
          {/* One isolated left-to-right run inside a right-to-left box: the box is what makes a long
              path ellipsise from the FRONT — a path is told apart by its tail, and the header's own
              left edge is the least informative character it has (see `.discussionRange`) — while the
              isolate is what keeps the path in its own order. Without it the bidi algorithm reads the
              leading separator against the box and moves it to the far end (`/repo/a.ts:1` draws as
              `repo/a.ts:1/`). */}
          <span className={css.discussionRange} data-diff-discussion-range>
            <bdi dir="ltr">{label}</bdi>
          </span>
        </span>
        <span className={css.flexSpacer} />
        <Menu
          open={menuOpen}
          portal
          compact
          align="end"
          items={menuItems}
          onSelect={(id) => {
            if (id === 'delete') onRemove(discussion.id)
            onMenuOpen(undefined)
          }}
          onClose={() => { onMenuOpen(undefined) }}
          anchor={(
            <button
              type="button"
              className={css.discussionToggle}
              data-diff-discussion-menu
              aria-label={t('action.more')}
              onClick={() => { onMenuOpen(menuOpen ? undefined : discussion.id) }}
            >
              {'\u22ef'}
            </button>
          )}
        />
      </div>
      {!discussion.collapsed && (
        <div className={css.discussionBody}>
          {/* What the thread was written about. The lines it named are gone or rewritten, so this is
              the only way to see what it meant — the mature review tools keep the same quote with an
              outdated thread. The label in front of it is where the block says it is outdated: the
              header keeps to the position the thread names and says nothing about its state. */}
          {discussion.lost === true && discussion.quote !== undefined && discussion.quote !== '' && (
            <>
              <p className={css.discussionNote} data-diff-discussion-quote-label>
                {t('discussion.outdatedQuote')}
              </p>
              {/* The wrap comes from the block's own layout, not from the setting: the rows above
                  this quote were counted from it (see `laidDiscussions`), so a quote drawn with
                  anything else would be drawn at a height nobody reserved. */}
              <DiscussionQuote quote={discussion.quote} lines={discussion.quoteLines} lang={lang} wrap={discussion.quoteWrap === true} split={split} />
            </>
          )}
          {discussion.hidden !== undefined && discussion.hidden > 0 && (
            <p className={css.discussionNote} data-diff-discussion-hidden>
              {t('discussion.hidden', { count: discussion.hidden })}
            </p>
          )}
          {discussion.messages.map((message, index) => (
            message.role === 'user' ? (
              <p className={css.discussionUser} data-diff-discussion-user key={`u${index}`}>{discussionNodes(message.text)}</p>
            ) : (
              <p className={css.discussionAnswer} data-diff-discussion-reply key={`a${index}`}>{discussionNodes(message.text)}</p>
            )
          ))}
          {/* What became of the newest question: it is still being answered, the session let it go
              without one, or the turn that claimed it has stopped. Whichever it is, the writing row
              below STAYS — a thread the reader is waiting on is still a thread they may write a
              follow-up in, and the row is where that starts — so the note and the writing row are two
              separate pieces of the block's height (see `layoutDiscussion`), and only this thread's
              own button is refused while it waits. */}
          {discussion.failed === true ? (
            <p className={css.discussionNote} data-diff-discussion-failed>{t('discussion.failed')}</p>
          ) : discussion.asking === true ? (
            <p className={css.discussionNote} data-diff-discussion-asking>
              {t('discussion.thinking')}
              {/* Decorative: the words above say it all, and a screen reader should not read the
                  dots. */}
              <span className={css.discussionDots} data-diff-discussion-dots aria-hidden="true">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </p>
          ) : discussion.stopped === true ? (
            /* The turn that claimed this question is over and the transcript holds no answer for it:
               the reader is told rather than left waiting on a turn that ended. An `ended` ask that
               DOES have an answer never reaches this note — the transcript decides, and the answer
               is above it. */
            <p className={css.discussionNote} data-diff-discussion-stopped>{t('discussion.stopped')}</p>
          ) : null}
          {/* At most one spare row of the block's own measurement, and only here, next to the
              writing row it belongs to (see `.discussionSlack`). */}
          <div className={css.discussionSlack} data-diff-discussion-slack aria-hidden="true" />
          <div className={css.discussionCompose}>
            {/* An outdated thread writes like any other: what the thread was about is quoted
                above this row, so a reply still has something to be about, and the row stays
                where the writing would happen so the block's shape does not change under the
                reader when the code moves on. */}
            <input
              className={css.discussionInput}
              data-diff-discussion-input
              ref={(element) => { registerInput(discussion.id, element) }}
              value={discussion.draft}
              placeholder={t('discussion.placeholder')}
              onChange={(event) => { onDraft(discussion.id, event.target.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                // An IME's "confirm the candidate" Enter must not send: composing is the signal
                // for it, and 229 is the code some engines send when they will not say so.
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                event.preventDefault()
                // The button's own rule, for the field's Enter: this thread is already waiting on an
                // answer, and a second question would ride in on top of the first.
                if (asking) return
                onSend(discussion.id)
              }}
            />
            <button
              type="button"
              className={`${css.action} ${css.actionPrimary} ${css.discussionSend}`}
              data-diff-discussion-send
              // THIS thread's question is still in flight: sending another one now would leave the
              // first answer with nowhere to land, so its own button waits — the others are free.
              disabled={asking}
              onClick={() => { onSend(discussion.id) }}
            >
              {t('action.comment')}
              <ReturnIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  )
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
 * What a press inside the panel must NOT drop the text selection for: the content itself, and the
 * frame that acts on the selection.
 *
 * The content mirrors the `user-select` whitelist in `.panel`: the code, the rendered Markdown
 * preview, a thread's own turns, the code a comment quotes, and any field. Everything else is
 * chrome (see `.panel`), and a press on chrome ends the selection rather than leaving it standing
 * — see `onPanelMouseDown`. The frame is the exception that is not content: its 评论 / 保留 / 回退
 * buttons are about exactly that selection, so dropping it on the way to them would leave them
 * acting on nothing.
 */
const KEEPS_SELECTION = [
  'input',
  'textarea',
  '[contenteditable]',
  '[data-diff-code]',
  '[data-diff-md-preview-body]',
  '[data-diff-discussion-user]',
  '[data-diff-discussion-reply]',
  '[data-diff-quote-text]',
  '[data-diff-selection-actions]',
  '[data-diff-copy]',
].join(', ')

/**
 * Whether a press landed on a row the live selection already covers — the highlighted text itself,
 * or the blank space beside it on the same line.
 *
 * Both are inside the code view, which `KEEPS_SELECTION` leaves to the browser, and the browser
 * keeps the selection for neither: inside the highlight is where a drag that extends it would
 * begin, and the blank beside it is chrome, which it never clears a selection from. So a plain
 * press there left the highlight and the frame standing over a gesture that plainly ended. This is
 * the one press in the content the panel has to end itself (see `onPanelMouseDown`).
 *
 * @param target - the element the press landed on.
 * @param live - the window's selection, still the one the reader had.
 * @returns whether that selection covers the pressed row.
 */
function pressOnSelectedRow(target: Element, live: Selection | null): boolean {
  if (live === null || live.isCollapsed) return false
  const unified = rowRangeOf(live)
  const split = unified === undefined ? splitRowRangeOf(live) : undefined
  const range = unified ?? split
  if (range === undefined) return false
  const row = target.closest<HTMLElement>('[data-diff-row], [data-diff-split-row]')
  if (row === null) return false
  let index: number | undefined
  if (unified !== undefined) {
    const value = Number(row.dataset.diffRow)
    index = Number.isFinite(value) ? value : undefined
  } else {
    const info = splitRowInfoAt(target)
    // The two columns are two files: a press on the other one is not on this selection.
    if (info === undefined || (range.side !== undefined && info.side !== range.side)) return false
    index = info.pairIndex
  }
  if (index === undefined) return false
  return index >= range.start && index <= range.end
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
 * there — the user is usually typing when the panel's edges need rearranging — * while every other text field (this panel's own search box, the add-path
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
  /** Whether this row is one a discussion annotates: it carries the wash itself. */
  discussed: boolean
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
  const { index, row, runs, focused, discussed, searchHit, searchCurrent, searchQuery, searchOptions, onRowHover, wrappedLines } = props
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
      className={`${css.line} ${ROW_CLASS[row.kind]}${discussed ? ` ${css.rowDiscussed}` : ''}`}
      data-diff-line={row.kind}
      data-diff-row={index}
      data-diff-discussion-band={discussed ? '' : undefined}
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

/**
 * Whether a pending file has nothing left to review: its content already matches the tracked baseline.
 *
 * Such a row has nothing left to accept and nothing to put back, so its only remaining decision is
 * whether it stays in the list (移出 — a keep that folds the content and drops the entry, leaving the file
 * itself alone). The row menu, the bulk footer and the detail toolbar all decide their actions off this
 * ONE answer, so a row, the set of rows, and the file that row opens cannot disagree about which actions
 * they are.
 *
 * It is deliberately not `oldText === ''`: an empty COMMITTED file still has an earlier version to
 * restore.
 * @param file - the pending file to classify.
 * @returns true when the only decision left on it is whether it stays listed.
 */
function fileHasNoDiff(file: PendingFileDiff): boolean {
  return changeBlocksOf(computeWholeFileDiff(file.oldText, file.newText)).length === 0
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

/**
 * Which change block to focus once the operated one has left the diff.
 *
 * The operated block(s) are gone, so the change that followed them slid into the slot they held: focusing
 * that same index is what recenters and flashes the NEXT change. An operated range that reached the END of
 * the diff has no such change — every block still pending is above the reader — so the walk wraps to the
 * first one, the same wrap the prev/next stepping does. Clamping to the last index instead left the focus
 * pointing past the shorter diff, and then nothing was focused, flashed or scrolled at all.
 *
 * @param operated - the index the operated range started at.
 * @param count - how many blocks the diff holds NOW, after the action.
 * @returns the block index to focus.
 */
function blockAfterAction(operated: number, count: number): number {
  return operated >= count ? 0 : operated
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
function SplitSideRow({ index, side, wrapped, runs, kind, isLeft, height, focused, discussed, searchHit, searchCurrent, searchQuery, searchOptions, onHover, intra }: {
  index: number
  side: SplitSide | undefined
  wrapped: string[] | undefined
  runs: readonly HighlightSpan[] | undefined
  kind: SplitPair['kind']
  isLeft: boolean
  height: number
  focused: boolean
  /** Whether a thread annotates this row: it carries the wash (see `rowDiscussed`). */
  discussed: boolean
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
      className={`${css.line}${discussed ? ' ' + css.rowDiscussed : ''}`}
      style={{ height }}
      data-diff-split-row
      data-diff-discussion-band={discussed ? '' : undefined}
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
export interface SplitDiffHandle { jump: (direction: -1 | 1, wrapGuard?: boolean, singleToast?: boolean) => void; land: (row: number, toCard?: boolean, flash?: boolean, comment?: string | undefined) => void; openSearch: () => void; toggleSearch: () => void; closeSearch: () => boolean; searchNext: (direction: -1 | 1) => boolean; toggleMatchCase: () => boolean; toggleMatchWholeWord: () => boolean }

/** The two-column (side-by-side) whole-file diff view. */
export const SplitDiff = forwardRef<SplitDiffHandle, {
  file: PendingFileDiff
  /** The session the panel is VIEWING, which owns every decision made in this view (see
   *  `PendingDiffProps.sessionId`). Not `file.sessionId`, which names the session that most
   *  recently touched the file. */
  sessionId: SessionId
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
  /** The threads this file carries, laid out: each hangs under the pair its anchor ends in. */
  discussions?: readonly Discussion[]
  /** Draws one thread's card at the width this view gives it (see `DiscussionBlock`). */
  renderDiscussion?: (discussion: Discussion, bodyWidth: number, split: boolean) => ReactNode
  /** The comment action for the current selection, when the panel offers one for it. */
  selectionComment?: ReactNode
  /** The changed-line runs the overview ruler draws, in whole-file row indices. */
  rulerRuns: readonly RulerRun[]
  /** The go-to popup, which this view centres on its own box (see `gotoDialog`). */
  gotoDialog?: ReactNode
}>(function SplitDiff({ file, sessionId, model, runs, langWrap, tabWidthSpaces, busy, t, selection, leadRows, onBlockKeep, onBlockRevert, onWrapToast, onVisibleLines, discussions, renderDiscussion, selectionComment, rulerRuns, gotoDialog }, ref) {
  // The search bar's tooltips, decided once (see `chords.ts`): this host's keycaps where it can draw
  // them, the pre-0.1.7-rc.2 glued label where it cannot. One entry per control, so the five controls
  // cannot spell a chord differently from the bar in the unified view.
  const hintCase = actionTooltip(t('action.matchCase'), 'matchCase')
  const hintWords = actionTooltip(t('action.matchWholeWord'), 'matchWholeWord')
  const hintPrev = actionTooltip(t('action.prevDiff'), 'searchPrev')
  const hintNext = actionTooltip(t('action.nextDiff'), 'searchNext')
  const hintClose = escapeTooltip(t)
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
  const splitRootRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [focus, setFocus] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
  /**
   * Bumped by every landing this view is asked for, and the key the landing effect runs on.
   *
   * `flashKey` cannot be that key: a landing on a THREAD'S OWN BOX deliberately leaves the frame alone
   * (it SETS the key back to 0 rather than raising one), so two jumps inside one pair would leave it
   * unchanged and the second landing would never be placed at all. This one only ever moves, and only
   * a landing moves it.
   */
  const [landKey, setLandKey] = useState(0)
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
  /** The model rows a thread annotates: the wash their halves wear (see `rowDiscussed`). */
  const discussedRows = useMemo(() => {
    const set = new Set<number>()
    for (const discussion of discussions ?? []) {
      if (discussion.lost === true) continue
      for (let row = Math.max(0, discussion.anchor.start); row <= Math.min(discussion.anchor.end, model.diff.rows.length - 1); row++) {
        set.add(row)
      }
    }
    return set
  }, [discussions, model])
  /**
   * The pairs that wear the wash: a pair does when either of its rows is one a thread annotates. Per
   * pair rather than per half, because a commented ADDED line has no old-side row at all — asking each
   * half about its own row left the empty half bare, and the band is what says the pair carries a
   * thread. Both halves take it from either row, the way the single-column view washes the whole row.
   */
  const discussedPairs = useMemo(() => {
    const set = new Set<number>()
    for (const [pair, rows] of pairRowIndices) {
      const left = rows.left === undefined ? false : discussedRows.has(rows.left)
      const right = rows.right === undefined ? false : discussedRows.has(rows.right)
      if (left || right) set.add(pair)
    }
    return set
  }, [pairRowIndices, discussedRows])
  /** The threads that hang under each pair, by the row their anchor ends in. */
  const pairOfDiscussion = useCallback(
    (discussion: Discussion): number | undefined =>
      pairOfRow.get(discussion.anchor.end) ?? pairOfRow.get(discussion.anchor.start),
    [pairOfRow],
  )
  const pairDiscussions = useMemo(() => {
    const map = new Map<number, Discussion[]>()
    for (const discussion of discussions ?? []) {
      const pair = pairOfDiscussion(discussion)
      if (pair === undefined) continue
      const list = map.get(pair)
      if (list === undefined) map.set(pair, [discussion])
      else list.push(discussion)
    }
    return map
  }, [discussions, pairOfDiscussion])
  /**
   * The height a pair holds for the threads hanging under it, in px.
   *
   * A thread's rows are the thread's own (see `THREAD_ROW_PX`), not the code's, so a block off the
   * code's grid still lands exactly where the height table says. Both columns reserve this much —
   * the cards themselves are drawn over both (see the layer below) — which is what keeps the two
   * halves from drifting apart under a thread either of them shows.
   */
  const discussionPx = useCallback(
    (k: number): number => (pairDiscussions.get(k) ?? []).reduce((px, discussion) => px + discussionRows(discussion) * THREAD_ROW_PX, 0),
    [pairDiscussions],
  )
  /**
   * Where each thread's OWN box starts, in px, measured from the base of the pair's stack.
   *
   * The cards are drawn one below the other under their pair, in this list's order (see the card layer
   * below), so the first card starts at the pair's end and the nth one a card later. A jump that names
   * a thread has to add these to the base, or it lands the first card of the pair whatever thread the
   * reader asked for — the same defect the single-column landing had.
   */
  const discussionStack = useMemo(
    () => discussionStackOffsets(discussions ?? [], thread => pairOfDiscussion(thread) ?? -1),
    [discussions, pairOfDiscussion],
  )
  const pairOffsets = useMemo(() => {
    // With no threads the cheap uniform-row path is the whole story (and `pairHeights` is null
    // while wrap is off, which is the common case); a thread anywhere in the file needs the table,
    // because its rows are not the code's and every offset below it moves.
    if (pairHeights === null && pairDiscussions.size === 0) return null
    const offs = new Array<number>(pairCount + 1)
    offs[0] = 0
    for (let i = 0; i < pairCount; i++) {
      offs[i + 1] = offs[i]! + (pairHeights === null ? ROW_HEIGHT_PX : pairHeights[i] ?? ROW_HEIGHT_PX) + discussionPx(i)
    }
    return offs
  }, [pairHeights, pairCount, discussionPx, pairDiscussions])
  const totalHeight = pairOffsets === null ? pairCount * ROW_HEIGHT_PX : (pairOffsets[pairCount] ?? 0)
  const off = (k: number): number => (pairOffsets === null ? k * ROW_HEIGHT_PX : (pairOffsets[Math.max(0, Math.min(k, pairCount))] ?? 0))
  /**
   * The overview ruler's markers, in the height table's own units: a run's rows are mapped to the PAIRS
   * they sit in, because pairs are what this view's offsets measure. A change that renders on both sides
   * — a del pair with the add beside it — lands in the same band and contributes both markers, exactly
   * like the preview's double column: the ruler says "this stretch changed", and which side changed is
   * what the two columns themselves show.
   */
  const rulerMarkersNow = useMemo(() => {
    if (totalHeight <= 0 || pairCount === 0) return []
    const at = (k: number): number => pairOffsets === null ? k * ROW_HEIGHT_PX : (pairOffsets[Math.max(0, Math.min(k, pairCount))] ?? 0)
    return rulerRuns.flatMap(run => {
      let first = -1
      let last = -1
      for (let row = run.start; row <= run.end; row++) {
        const pair = pairOfRow.get(row)
        if (pair === undefined) continue
        if (first === -1) first = pair
        last = pair
      }
      if (first === -1) return []
      const top = pairOffsets === null ? first / pairCount : at(first) / totalHeight
      const bottom = pairOffsets === null ? (last + 1) / pairCount : at(last + 1) / totalHeight
      return [{ top: top * 100, height: Math.max(0, bottom - top) * 100, kind: run.kind }]
    })
  }, [rulerRuns, pairOfRow, pairCount, pairOffsets, totalHeight])
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

  // Whether Ctrl (or ⌘ is down RIGHT NOW. The strips are native scrollbars, so dragging one dispatches no
  // pointer events at all — a modifier cannot be read off the gesture itself, and this key state is what
  // tells a plain drag (move this pane) apart from a Ctrl drag (move both). A window that loses focus
  // never sees the keyup, so blur releases it too.
  const ctrlHeldRef = useRef(false)
  useEffect(() => {
    const track = (event: KeyboardEvent): void => { ctrlHeldRef.current = event.ctrlKey || event.metaKey }
    const release = (): void => { ctrlHeldRef.current = false }
    window.addEventListener('keydown', track)
    window.addEventListener('keyup', track)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', track)
      window.removeEventListener('keyup', track)
      window.removeEventListener('blur', release)
    }
  }, [])

  /** A strip offset this view wrote itself, so the follow-up scroll event is not read as a new drag. */
  const mirroredRef = useRef<{ side: 'left' | 'right'; value: number } | undefined>(undefined)

  // Dragging a pinned strip scrolls that column's content — and, with it, the half of an outdated thread's
  // quote that stands for that column. The quote is drawn in the card over both halves rather than inside
  // them (see `DiscussionQuote`), so nothing else would move it with its own code.
  //
  // With Ctrl (or ⌘ held the OTHER pane follows the one being dragged, both its column and its strip: the
  // two panes of a side-by-side diff are read against each other, and lining them up by hand is what the
  // modifier is for. Whichever strip is dragged leads; the follower's own scroll event is marked as ours so
  // it cannot drag the leader back into the follower's own range.
  const onHScroll = useCallback((side: 'left' | 'right') => {
    const strip = side === 'left' ? leftHScrollRef.current : rightHScrollRef.current
    if (strip === null) return
    const mirrored = mirroredRef.current
    const follows = mirrored !== undefined && mirrored.side === side && mirrored.value === strip.scrollLeft
    if (follows) mirroredRef.current = undefined
    const move = (which: 'left' | 'right', offset: number): void => {
      const col = which === 'left' ? leftColRef.current : rightColRef.current
      if (col !== null) col.scrollLeft = offset
      const quotes = splitRootRef.current?.querySelectorAll<HTMLElement>(
        `[data-diff-quote-text][data-diff-quote-side="${which}"]`,
      )
      for (const text of quotes ?? []) text.scrollLeft = offset
    }
    move(side, strip.scrollLeft)
    if (follows || !ctrlHeldRef.current) return
    const otherSide = side === 'left' ? 'right' : 'left'
    const otherStrip = otherSide === 'left' ? leftHScrollRef.current : rightHScrollRef.current
    move(otherSide, strip.scrollLeft)
    // The follower's thumb is brought along too, so the two visible controls read as one; nothing is marked
    // when the value already matches, because then no scroll event follows to consume the mark.
    if (otherStrip !== null && otherStrip.scrollLeft !== strip.scrollLeft) {
      mirroredRef.current = { side: otherSide, value: strip.scrollLeft }
      otherStrip.scrollLeft = strip.scrollLeft
    }
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
  // blocks shift into the operated block's slot, so that index is the next one —
  // and an operated range that reached the end of the diff wraps to the first
  // (see `blockAfterAction`).
  //
  // The count is read back through a ref: the action removes the operated blocks, and this view is
  // re-rendered with the shorter diff before the action's promise settles, so the count captured here is
  // the pre-action one.
  const blockCountRef = useRef(0)
  blockCountRef.current = model.blocks.length
  const handleBlockAction = async (action: 'keep' | 'revert'): Promise<void> => {
    const operated = hoveredBlock ?? hoveredBlockRef.current
    if (operated === undefined) return
    const range = blockRanges[operated]
    if (range === undefined) return
    await (action === 'keep'
      ? onBlockKeep(sessionId, file.id, range)
      : onBlockRevert(sessionId, file.id, range))
    const count = blockCountRef.current
    if (count === 0) return
    const next = blockAfterAction(operated, count)
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
  /**
   * The row this view was asked to land on — the comments list's jump into a file that is already open —
   * and whether it is a thread's own BOX rather than a place in the code. The centering effect below
   * lands it at the pair that row is in (or at the box hanging under that pair) rather than at its
   * block's first pair, which is the precision the single-column view has; spent once, like every
   * landing.
   */
  const landingRowRef = useRef<{ row: number; toCard: boolean; comment?: string | undefined } | undefined>(undefined)
  /** A row this view was asked to frame and land on rather than a whole block (a go-to-line). */
  const flashRowRef = useRef<number | undefined>(undefined)
  const land = useCallback((row: number, toCard = false, rowFlash = false, comment?: string): void => {
    landingRowRef.current = { row, toCard, comment }
    const pair = pairOfRow.get(row)
    const block = pair === undefined ? undefined : blockIndexByPair.get(pair)
    if (block !== undefined) setFocus(block)
    // A landing that means "here is the change you were looking for" flashes the whole block; a
    // go-to-line frames the one row it was asked for, and recenters without that block flash.
    // Neither happens for a THREAD'S OWN BOX (`toCard`): the frame it would draw is the pair's whole
    // change block, whose top edge sits above the viewport — a blinking line at the top of the pane,
    // which is the noise the comments list's jump was reported for (see the single-column landing).
    // So the frame already on screen is taken down rather than another one raised.
    flashRowRef.current = rowFlash ? row : undefined
    setLandKey(key => key + 1)
    if (toCard) setFlashKey(0)
    else setFlashKey(key => key + 1)
  }, [pairOfRow, blockIndexByPair])

  // Expose the block jump to the parent so the shared toolbar/keyboard drives
  // this split view's own (private) focus in split mode — and the landing of a row the comments list
  // asked for, which is a jump to a place inside a block rather than to a block.
  useImperativeHandle(ref, () => ({ jump, land, openSearch, toggleSearch, closeSearch, searchNext, toggleMatchCase, toggleMatchWholeWord }), [jump, land, openSearch, toggleSearch, closeSearch, searchNext, toggleMatchCase, toggleMatchWholeWord])

  useLayoutEffect(() => {
    if (pairCount === 0) return
    const block = blockOfPair[focus]
    if (block === undefined) return
    const body = bodyRef.current
    if (body === null) return
    // Leave the configured lead rows above the block, matching the single-column view — or above the
    // pair a landing named (or the box hanging under it), which is the row the reader asked for.
    const landed = landingRowRef.current
    landingRowRef.current = undefined
    const from = landed === undefined ? block.start : pairOfRow.get(landed.row) ?? block.start
    // A landing that named a THREAD lands ITS box, not the first one under the pair: the cards are
    // drawn one below the other in `pairDiscussions`' order (see the card layer), so the base the pair
    // ends at is only the first card's top edge (see `discussionStack`). The offset is in the thread's
    // OWN rows (`discussionRows`, the unit a card's height is drawn in), so it is scaled by
    // `THREAD_ROW_PX` exactly as the single-column landing scales it.
    const cardTop = landed?.toCard === true
      ? pairHeightAt(from) + (landed.comment === undefined ? 0 : (discussionStack.get(landed.comment) ?? 0) * THREAD_ROW_PX)
      : 0
    const target = off(from) + cardTop - leadRows * ROW_HEIGHT_PX
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
    // `model`/`pairCount` are deliberately NOT deps — a content refresh would
    // otherwise re-center the view and lose the user's scroll position. `focus`
    // is also NOT a dep: a scroll re-anchors `focus` to the block under the
    // viewport (see `onScroll`), and that must NOT recenter and fight the scroll.
    // `landKey` is what makes a LANDING run: `flashKey` alone misses the second jump inside one pair (a
    // card landing leaves the frame alone, see `land`), and a landing placed nowhere is a jump the
    // reader never took.
  }, [flashKey, landKey])

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
  const flashRow = flashRowRef.current
  const flashTop = flashRow !== undefined
    ? Math.max(0, off(pairOfRow.get(flashRow) ?? flashRow) - scrollTop)
    : focusedBlock === undefined
      ? 0
      : Math.max(0, off(focusedBlock.start) - scrollTop)
  const flashBottom = flashRow !== undefined
    ? Math.min(viewportH > 0 ? viewportH : Number.POSITIVE_INFINITY, off((pairOfRow.get(flashRow) ?? flashRow) + 1) - scrollTop)
    : focusedBlock === undefined
      ? 0
      : Math.min(viewportH > 0 ? viewportH : Number.POSITIVE_INFINITY, off(focusedBlock.end + 1) - scrollTop)
  const flashHeight = Math.max(0, flashBottom - flashTop)
  // Hovered block's actions frame, pinned to the block's bottom edge. The actions
  // live in the non-scrolling wrapper (viewport coordinates), so subtract
  // scrollTop; the frame is clamped to stay on-screen.
  const blockActionsTop = hoveredBlock === undefined || blockOfPair[hoveredBlock] === undefined
    ? 0
    : Math.max(0, Math.min(off(blockOfPair[hoveredBlock]!.end + 1) - scrollTop, Math.max(0, viewportH - BLOCK_ACTIONS_FRAME_PX)))

  /**
   * How a press in the side-by-side view makes a selection. Left to the browser, a drag that crosses
   * the divider takes in the rest of the column it began in and then the other one upwards — the
   * pointer's own position decides that, and the selection cannot be written to stop it (a write under
   * a live drag makes the browser drop the drag instead). An editor has no such problem because a
   * pointer there is only ever a coordinate: it computes the position inside the editor, so a drag
   * cannot leave it, which is how VS Code's own text keeps a selection inside its box. The same is
   * done here for the column the press began in: x is taken inside that column's code cell, so
   * dragging past the divider keeps the row the pointer is on and the line numbers never join the
   * selection, and y is taken inside the scroller, which is scrolled here when the pointer leaves it.
   * Double and triple clicks are still the browser's (`detail` above one), so word and line selection
   * are unchanged.
   *
   * Touch cannot be driven this way — the platform owns the long press, and preventing the touch would
   * take the scroll with it — so there the other column is simply made unselectable while the press
   * lasts (see `.splitSealed`), which stops the caret from entering it at all; the cost is that the
   * caret then resolves to the nearest selectable position rather than to the row under the finger.
   */
  useEffect(() => {
    const root = splitRootRef.current
    const scroller = bodyRef.current
    if (root === null || scroller === null) return
    const caretApi = document as Document & { caretRangeFromPoint?: unknown; caretPositionFromPoint?: unknown }
    // Without a point-to-position API the drag cannot be computed, and the selection is left to the
    // browser (a touch press is still sealed below, which needs none of this).
    const canDrive = caretApi.caretRangeFromPoint !== undefined || caretApi.caretPositionFromPoint !== undefined
    let drag: { column: HTMLElement; anchor: { node: Node; offset: number } } | null = null
    let frame = 0
    let point = { x: 0, y: 0 }
    let pointerType: string | undefined
    /** The position a point names inside `column`: its row for y, and that row's code cell for x. */
    const positionIn = (column: HTMLElement, clientX: number, clientY: number): { node: Node; offset: number } | undefined => {
      const rows = column.querySelectorAll<HTMLElement>('[data-diff-split-row]')
      if (rows.length === 0) return undefined
      let row = rows[rows.length - 1]!
      for (const candidate of rows) {
        if (clientY < candidate.getBoundingClientRect().bottom) {
          row = candidate
          break
        }
      }
      const box = row.getBoundingClientRect()
      const y = Math.min(Math.max(clientY, box.top + 1), box.bottom - 1)
      const code = row.querySelector<HTMLElement>('[data-diff-code]')
      if (code === null) return undefined
      const cell = code.getBoundingClientRect()
      const x = Math.min(Math.max(clientX, cell.left + 1), cell.right - 1)
      const found = caretAtPoint(x, y)
      if (found !== undefined && code.contains(found.node)) return found
      // Something drawn over the row (a card, an action frame) took that point: then take the row's own
      // edge on the side the pointer is on.
      const edges = textEdgesOf(code)
      if (edges === undefined) return undefined
      return x < (cell.left + cell.right) / 2
        ? { node: edges.first, offset: 0 }
        : { node: edges.last, offset: edges.last.length }
    }
    const apply = (): void => {
      if (drag === null) return
      const selection = window.getSelection()
      const extent = positionIn(drag.column, point.x, point.y)
      if (selection === null || extent === undefined) return
      selection.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, extent.node, extent.offset)
    }
    /** One pass per frame: the position first, then a scroll if the pointer is outside the scroller. */
    const tick = (): void => {
      frame = 0
      if (drag === null) return
      const box = scroller.getBoundingClientRect()
      const out = point.y < box.top ? point.y - box.top : point.y > box.bottom ? point.y - box.bottom : 0
      if (out !== 0) {
        const step = Math.min(ROW_HEIGHT_PX * 3, Math.max(ROW_HEIGHT_PX, Math.abs(out) / 3))
        scroller.scrollTop += Math.sign(out) * step
      }
      apply()
      if (out !== 0) frame = window.requestAnimationFrame(tick)
    }
    /** The column a node sits in, or undefined for anything else in the view (a card, a frame). */
    const columnOf = (target: Element): HTMLElement | undefined => {
      const row = target.closest<HTMLElement>('[data-diff-split-row]')
      if (row === null) return undefined
      const left = leftColRef.current
      const right = rightColRef.current
      if (left !== null && left.contains(row)) return left
      return right !== null && right.contains(row) ? right : undefined
    }
    const onPointerDown = (event: PointerEvent): void => {
      pointerType = event.pointerType
      if (event.pointerType === 'mouse') return
      const target = event.target
      if (!(target instanceof Element) || columnOf(target) === undefined) return
      const sealed = css.splitSealed
      const side = css.splitSealedLeft
      const other = css.splitSealedRight
      if (sealed === undefined || side === undefined || other === undefined) return
      document.body.classList.add(sealed, target.closest('[data-diff-split-side="left"]') !== null ? side : other)
    }
    const onMouseDown = (event: MouseEvent): void => {
      if (!canDrive) return
      // A press the platform reported as touch or pen is sealed instead of driven; one the platform
      // did not report at all (no pointer event seen) is treated as a mouse.
      if (pointerType !== undefined && pointerType !== 'mouse') return
      if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const column = columnOf(target)
      if (column === undefined) return
      const anchor = positionIn(column, event.clientX, event.clientY)
      if (anchor === undefined) return
      // The browser's own drag would run past the divider; this one is computed and cannot.
      event.preventDefault()
      // …and with that default goes the focus the press would have given the scroller.
      scroller.focus()
      point = { x: event.clientX, y: event.clientY }
      drag = { column, anchor }
      apply()
    }
    const onMove = (event: PointerEvent): void => {
      if (drag === null) return
      point = { x: event.clientX, y: event.clientY }
      if (frame === 0) frame = window.requestAnimationFrame(tick)
    }
    const release = (): void => {
      const sealed = css.splitSealed
      const side = css.splitSealedLeft
      const other = css.splitSealedRight
      if (sealed !== undefined && side !== undefined && other !== undefined) {
        document.body.classList.remove(sealed, side, other)
      }
    }
    const stop = (): void => {
      drag = null
      release()
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
    }
    root.addEventListener('pointerdown', onPointerDown, true)
    root.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerup', stop, true)
    document.addEventListener('pointercancel', stop, true)
    document.addEventListener('touchend', release, true)
    document.addEventListener('touchcancel', release, true)
    window.addEventListener('blur', stop)
    return () => {
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', stop, true)
      document.removeEventListener('pointercancel', stop, true)
      document.removeEventListener('touchend', release, true)
      document.removeEventListener('touchcancel', release, true)
      window.removeEventListener('blur', stop)
      stop()
    }
  }, [])

  return (
    <div className={css.splitRoot} ref={splitRootRef} onMouseLeave={() => setHoveredBlock(undefined)}>
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
                  <Fragment key={index}>
                  <SplitSideRow
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
                    discussed={discussedPairs.has(index)}
                  />
                  {/* The rows a thread under this pair holds. Both halves reserve the same height —                       the card itself is drawn over both (see the layer below) — which is what keeps
                      the two halves from drifting apart under a thread. */}
                  {discussionPx(index) > 0 && (
                    <div
                      className={css.vSpacer}
                      data-diff-discussion-space={discussionPx(index)}
                      style={{ height: discussionPx(index) }}
                      aria-hidden="true"
                    />
                  )}
                  </Fragment>
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
                  <Fragment key={index}>
                  <SplitSideRow
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
                    discussed={discussedPairs.has(index)}
                  />
                  {/* The same rows the left half reserved, so the pair below this one starts on the
                      same pixel in both halves (the thread itself is drawn over both, below). */}
                  {discussionPx(index) > 0 && (
                    <div
                      className={css.vSpacer}
                      data-diff-discussion-space={discussionPx(index)}
                      style={{ height: discussionPx(index) }}
                      aria-hidden="true"
                    />
                  )}
                  </Fragment>
                )
              })}
              {end < pairCount && <div className={css.vSpacer} style={{ height: totalHeight - off(end) }} aria-hidden="true" />}
            </div>
          </div>
        </div>
        {/* The threads, in the code's own stream. A card is the width of the view and hangs below the
            pair its anchor ends in, at that pair's content offset, so the browser scrolls it with the
            code exactly as it scrolls a row — and a wheel or a drag that starts on a card reaches the
            scroller instead of dying on a layer pinned above it. It cannot live in either half (they
            are separate clipped scrollers, and the card spans both), so it is a sibling of the
            columns. Only the cards take presses; the layer between them does not, or it would stand
            between the reader and the code. */}
        <div
          className={css.splitDiscussions}
          data-diff-split-discussions
          // Each half of an outdated thread's quote gets its own column's pan range (see
          // `.quoteNoWrap`), so the quoted code can travel exactly as far as the file's does.
          style={{
            '--dsh-quote-width-left': `${widestSide.left}ch`,
            '--dsh-quote-width-right': `${widestSide.right}ch`,
          } as CSSProperties}
        >
          {[...pairDiscussions.entries()].map(([pair, list]) => {
            const top = off(pair) + pairHeightAt(pair)
            const height = discussionPx(pair)
            if (top - scrollTop > viewportH + SPLIT_DISCUSSION_MARGIN_PX || top + height - scrollTop < -SPLIT_DISCUSSION_MARGIN_PX) return null
            return (
              <div
                key={pair}
                className={css.splitDiscussion}
                data-discussion-pair={pair}
                // The height is the reservation's, not the card's: the card is absolutely positioned
                // (`see .discussion`), so the plate has to be told how far down to paint or it paints
                // nothing and the divider shows through the thread's empty rows.
                style={{ top, width: bodyWidth, height }}
              >
                {list.map(discussion => (
                  <Fragment key={discussion.id}>{renderDiscussion?.(discussion, bodyWidth, true)}</Fragment>
                ))}
              </div>
            )
          })}
        </div>
      </div>
      {/* The diff ruler, over this view's own vertical bar. It stops above the pinned horizontal row
          below, which is a sibling of the scroller rather than a bar inside it — hence its own class
          (see `.overviewRulerSplit`); the single column measures an inner scrollbar instead.

          The strip is read as TWO columns, like the panes it overlays: its left half is the left pane
          (what the file had) and its right half the right pane (what it has now), so a deletion marks
          the left half, an addition the right, and an aligned change fills both — instead of one colour
          painting over the other in a single band (see `.markerSplitDel` / `.markerSplitAdd`). */}
      {rulerMarkersNow.length > 0 && (
        <div className={`${css.overviewRuler} ${css.overviewRulerSplit}`} data-diff-approval-ruler aria-hidden="true">
          {rulerMarkersNow.map((marker, index) => (
            <div
              key={index}
              className={`${css.overviewMarker} ${marker.kind === 'del' ? `${css.markerDel} ${css.markerSplitDel}` : `${css.markerAdd} ${css.markerSplitAdd}`}`}
              data-diff-ruler-marker={marker.kind}
              data-diff-ruler-side={marker.kind === 'del' ? 'left' : 'right'}
              style={{ top: `${marker.top}%`, height: `${marker.height}%` }}
            />
          ))}
        </div>
      )}
      {/* The go-to popup, centred on this view the way the single column centres it on its own wrapper. */}
      {gotoDialog}
      {/* The selection's own frame: a range in either half offers the comment, which is the one
          action this view takes on a selection (keep/revert belong to the change blocks' own frames
          here). It is placed against the scroller the two halves share — the content offset of the
          selection's last pair, less the scroll — so it stays where the reader selected. */}
      {selectionComment !== undefined && selection !== undefined && (
        <div
          className={css.blockActions}
          data-diff-selection-actions
          style={{ top: Math.max(0, Math.min(off(selection.end + 1) - scrollTop, Math.max(0, viewportH - 32))) }}
        >
          {selectionComment}
        </div>
      )}
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
          <Tooltip label={hintCase.label} shortcutKeys={hintCase.shortcutKeys} side="bottom" delayMs={500}>
            <button
              type="button"
              className={search.caseSensitive ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
              data-diff-search-case
              data-on={search.caseSensitive ? '' : undefined}
              aria-label={t('action.matchCase')}
              aria-keyshortcuts={hintCase.aria}
              aria-pressed={search.caseSensitive}
              onClick={() => { andRefocus(() => { search.toggleCase() }) }}
            >
              <SearchOptionIcon kind="case" />
            </button>
          </Tooltip>
          <Tooltip label={hintWords.label} shortcutKeys={hintWords.shortcutKeys} side="bottom" delayMs={500}>
            <button
              type="button"
              className={search.wholeWord ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
              data-diff-search-word
              data-on={search.wholeWord ? '' : undefined}
              aria-label={t('action.matchWholeWord')}
              aria-keyshortcuts={hintWords.aria}
              aria-pressed={search.wholeWord}
              onClick={() => { andRefocus(() => { search.toggleWord() }) }}
            >
              <SearchOptionIcon kind="word" />
            </button>
          </Tooltip>
          <Tooltip label={hintPrev.label} shortcutKeys={hintPrev.shortcutKeys} side="bottom" delayMs={500}>
            <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-prev aria-label={t('action.prevDiff')} aria-keyshortcuts={hintPrev.aria} disabled={searchMatches.length === 0} onClick={() => { andRefocus(() => { goSearch(-1) }) }}>
              <IconChevronUpOutline14 size={14} />
            </button>
          </Tooltip>
          <Tooltip label={hintNext.label} shortcutKeys={hintNext.shortcutKeys} side="bottom" delayMs={500}>
            <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-next aria-label={t('action.nextDiff')} aria-keyshortcuts={hintNext.aria} disabled={searchMatches.length === 0} onClick={() => { andRefocus(() => { goSearch(1) }) }}>
              <IconChevronDownOutline14 size={14} />
            </button>
          </Tooltip>
          <Tooltip label={hintClose.label} shortcutKeys={hintClose.shortcutKeys} side="bottom" delayMs={500}>
            <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-close aria-label={t('action.close')} aria-keyshortcuts={hintClose.aria} onClick={closeSearch}>
              <IconCloseOutline16 size={14} />
            </button>
          </Tooltip>
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

/** The first and last text node inside `root`, or undefined when it holds no text. */
function textEdgesOf(root: Node): { first: Text; last: Text } | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()
  if (!(first instanceof Text)) return undefined
  let last = first
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) last = node
  }
  return { first, last }
}

/**
 * The text position a point names, in whichever of the two spellings the browser has — or undefined
 * when it has neither, which is when the panel has to leave the selection to the browser (see the
 * split view's own drag).
 * @param x - client X of the point.
 * @param y - client Y of the point.
 * @returns the position, or undefined when the browser cannot resolve one.
 */
function caretAtPoint(x: number, y: number): { node: Node; offset: number } | undefined {
  const api = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const range = api.caretRangeFromPoint?.(x, y)
  if (range !== undefined && range !== null) return { node: range.startContainer, offset: range.startOffset }
  const position = api.caretPositionFromPoint?.(x, y)
  return position === undefined || position === null
    ? undefined
    : { node: position.offsetNode, offset: position.offset }
}

/**
 * Derive the selected split pair range per side (a left-column selection
 * references the old file, a right-column selection the new file). The two ends
 * can only disagree about the side when the selection was not made by the split
 * view's own drag, which cannot leave its column (see `SplitDiff`) — a keyboard
 * selection onto the neighbouring column, say, or a touch press. The range then
 * belongs to the column the selection began in and covers the pairs both ends
 * name: the pairs are the same list in both halves, so that is the range a
 * selection that stayed in that half would have made.
 */
function splitRowRangeOf(selection: Selection | null): RowRange | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined
  const range = selection.getRangeAt(0)
  const startInfo = splitRowInfoAt(range.startContainer)
  const endInfo = splitRowInfoAt(range.endContainer)
  if (startInfo === undefined || endInfo === undefined) return undefined
  let start = startInfo.pairIndex
  let end = endInfo.pairIndex
  if (lineOffsetAt(range.startContainer, range.startOffset) >= lineLengthAt(range.startContainer)) start += 1
  if (lineOffsetAt(range.endContainer, range.endOffset) === 0) end -= 1
  if (start > end) return undefined
  return { start, end, side: splitRowInfoAt(selection.anchorNode)?.side ?? startInfo.side }
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

/** One maximal run of same-kind changed rows: what both views' rulers are built from. */
interface RulerRun {
  start: number
  end: number
  kind: 'del' | 'add'
}

/** One ruler marker for the rendered Markdown preview. */
interface PreviewRulerMarker {
  top: number
  height: number
  kind: 'del' | 'add'
}

/**
 * Convert row-run ruler markers to the preview's fraction-of-rows shape. The
 * preview has no discussion blocks (they are a code-view feature), so a fraction
 * of the row count is exact there and stays the cheap conversion.
 *
 * @param markers - row runs, as the shared computation returns them.
 * @param rowCount - how many rows the diff has.
 * @returns markers positioned as percentages of the row count.
 */
function previewRulerMarkersOf(
  markers: readonly { start: number; end: number; kind: 'del' | 'add' }[],
  rowCount: number,
): PreviewRulerMarker[] {
  if (rowCount === 0) return []
  return markers.map(marker => ({
    top: (marker.start / rowCount) * 100,
    height: ((marker.end - marker.start + 1) / rowCount) * 100,
    kind: marker.kind,
  }))
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

/**
 * Which sentence a row's mark wears, or none: FOUR directions (the host's answer, one walk of the recorded
 * parent links) times the two forms.
 *
 * The two forms are separate sentences because they say different things: a row only the other session
 * touched, and one THIS session touched as well — the first would deny the reader's own edit on the second.
 */
type LineageNoteKey =
  | 'row.fromChild' | 'row.fromChildShared'
  | 'row.fromParent' | 'row.fromParentShared'
  | 'row.fromSibling' | 'row.fromSiblingShared'
  | 'row.fromOther' | 'row.fromOtherShared'

/**
 * The mark one row wears, from the host's two answers plus its direction — the ONE place a sentence is
 * picked from them, so no call site can choose one.
 *
 * `viaLineage` first: a row in this session's list ONLY because of the merge was not touched here at all, so
 * the "only" form is the whole truth about it. A row that got here on its own merit and ALSO carries another
 * session's change takes the "also" form, because the first would deny the reader's own edit.
 *
 * The direction is the HOST's (`lineageDirection`, computed from the recorded parent links), never inferred
 * here: this function's whole job is to turn a direction the host knows into a sentence. `mixed` — the owners
 * disagree, so no single relationship is true of the row — and an older host's silence both take the neutral
 * pair: naming a direction in either case would be a guess, which is the bug this field exists to fix.
 * @param file - one listed row.
 * @returns the locale key to draw, or `undefined` for a row with nothing to say.
 */
function lineageNoteOf(file: PendingFileDiff): LineageNoteKey | undefined {
  const only = file.viaLineage === true
  if (!only && file.hasChildContribution !== true) return undefined
  switch (file.lineageDirection) {
    case 'child': return only ? 'row.fromChild' : 'row.fromChildShared'
    case 'parent': return only ? 'row.fromParent' : 'row.fromParentShared'
    case 'sibling': return only ? 'row.fromSibling' : 'row.fromSiblingShared'
    // Non-requester owners of different directions: the row carries more than one relationship, so it gets
    // the sentence that is true of all of them rather than an arbitrary member of the set.
    case 'mixed': return only ? 'row.fromOther' : 'row.fromOtherShared'
    // No direction at all: a host older than the field. The neutral sentence is the honest one — the client
    // cannot walk a lineage, and must not pretend to (see `PendingFileDiff.lineageDirection`).
    default: return only ? 'row.fromOther' : 'row.fromOtherShared'
  }
}

/** One row of the file list: the clickable head in the left pane. */
function PendingFileRow({ file, selected, picked, lineageNote, failedMessage, t, onSelect, onMenu }: PendingFileRowProps) {
  const stats = useMemo(
    () => computeWholeFileDiff(file.oldText, file.newText),
    [file.oldText, file.newText],
  )
  return (
    <li
      className={css.row}
      onContextMenu={(event) => {
        // The browser's own menu has nothing to say about a pending file, and this row's own
        // actions are the whole of what it could offer: the press opens ours instead.
        event.preventDefault()
        onMenu(event)
      }}
    >
      <Tooltip label={file.path} delayMs={500} maxWidth={560}>
        <button
          type="button"
          className={css.rowHead}
          data-diff-file={file.id}
          data-selected={selected || undefined}
          // A pick is its own state, not the open file: the CSS says so, and the blur rule reads the id.
          data-picked={picked || undefined}
          aria-pressed={picked}
          onMouseDown={(event) => {
            // A modified press is the pick (see the panel's `onSelect`): hand it over on the press, so it
            // lands with this button's own press state instead of a mouseup later.
            if (event.ctrlKey || event.metaKey || event.shiftKey) onSelect(event, file.id)
          }}
          onClick={(event) => { onSelect(event, file.id) }}
        >
          {/* A file ON SCREEN wears no dot: the reader is looking at it right now, so waiting for the host to
              acknowledge `seen` would flash a dot at them for a poll cycle — and again every time the agent
              touches the open file. The host is still told (see the effect that marks the shown row seen),
              which is what keeps the dot out after the row is left. */}
          {file.unseen === true && !selected && (
            <svg className={css.unseenDot} data-diff-unseen width="3" height="3" viewBox="0 0 3 3" role="img" aria-label={t('panel.unseen')}>
              <title>{t('panel.unseen')}</title>
              <circle cx="1.5" cy="1.5" r="1.5" fill="var(--dsw-alias-state-business-primary)" />
            </svg>
          )}
          <span className={css.rowPath}>{basenameOf(file.path)}</span>
          {lineageNote !== undefined && (
            // A row another session in this lineage has a hand in — either ONLY that (it arrived through the
            // merged view and this session never touched it) or that session's share of a row this session
            // touched too. MARKED rather than moved either way, and actionable exactly like this session's
            // own rows: the host resolves the owner for a keep or a revert. The sentence names the direction
            // the HOST computed (child / ancestor / sibling / neutral) and never 队友/teammate, because a
            // child's own header cannot tell a teammate from any other subagent child (see the host's
            // `lineageView`). It never claims the comments or the undo history are merged either: those stay
            // per-session.
            <Tooltip label={t(lineageNote)} delayMs={500}>
              <span className={css.rowChild} data-diff-child role="img" aria-label={t(lineageNote)}>
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M1.5 1 V5.2 A1.3 1.3 0 0 0 2.8 6.5 H6.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M5.1 4.7 L6.9 6.5 L5.1 8.3" fill="none" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </span>
            </Tooltip>
          )}
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

/** The gap the diff toolbar's left group lays its items out with, in px (mirrors `.diffActionInfo`). */
const TOOLBAR_ITEM_GAP_PX = 8
/** The overflow button's own width in px — a `.action .iconAction` chip around a 14px glyph — used
 *  until the button itself has been measured. */
const TOOLBAR_OVERFLOW_PX = 28

/** One control in the diff toolbar's left group: a button, or the hairline that groups them. */
type DiffToolbarItem =
  | { kind: 'divider'; key: string }
  | {
      kind: 'button'
      /** Stable identity: the key its width is remembered under and its row id in the overflow menu. */
      key: string
      /** The action's own name: the button's accessible name, and the whole tooltip when it carries
       *  no chord. */
      label: string
      /** The tooltip text when it says more than the name — a chord appended to it. The overflow
       *  menu titles its row with this, so a control that has moved into the menu still says
       *  everything its own tooltip said. */
      hint?: string
      /** The keybinding action whose chord the tooltip renders as keycaps (see `shortcutOf`). The
       *  menu is a list of text rows and has no keycap row, which is why `hint` stays flat. */
      shortcut?: string
      icon: ReactNode
      /** The `data-*` marker the panel's tests and hosts find this control by. */
      data: Record<string, string>
      disabled?: boolean
      onSelect: () => void
    }

/**
 * How many leading toolbar items fit in `available` px, with `gap` between neighbours.
 *
 * The decisions at the right end of the row (Keep / Revert) are what the row is for, so the
 * informational buttons on its left are the ones that give way. An item that has not been measured
 * yet costs nothing here and is settled by the next pass.
 *
 * @param widths - each item's own width in px, in the order they are drawn.
 * @param available - the width the items may occupy.
 * @param gap - the space between two neighbouring items.
 * @returns the number of leading items that fit; 0 when even the first one does not.
 */
export function fittingItems(widths: readonly number[], available: number, gap: number): number {
  let used = 0
  let count = 0
  for (const width of widths) {
    const cost = count === 0 ? width : width + gap
    if (used + cost > available) break
    used += cost
    count += 1
  }
  return count
}

/**
 * How many leading items the toolbar draws inline, given the room the group has.
 *
 * When they do not all fit, room has to be made for the overflow button that holds the rest — which
 * can push one more item out — so the answer is asked twice, the second time with that button's
 * width reserved. Reserving space can only shrink the count, so two passes settle it.
 *
 * @param widths - each item's own width in px, in the order they are drawn.
 * @param available - the width the group may occupy.
 * @param gap - the space between two neighbouring items.
 * @param overflowWidth - the overflow button's width, reserved only when something is left over.
 * @returns how many leading items to draw inline.
 */
export function inlineItemCount(widths: readonly number[], available: number, gap: number, overflowWidth: number): number {
  const inline = fittingItems(widths, available, gap)
  if (inline >= widths.length) return inline
  return fittingItems(widths, available - (overflowWidth + gap), gap)
}

/** The selected file's diff, actions, jump controls, and copy toolbar. */
function PendingDiff({ file, sessionId, busy, workspacePath, jumpSignal, undoFlash, landingTop, landingTick, landingRow, landingLine, landingOld, landingComment, landingCard, onLanded, failedMessage, commentSkill, comments, commentAnswers, commentsRevision, commentLines, onCommentAdd, onCommentRemove, onCommentAsk, onCommentSeen, onPasteReference, onToast, t, onAddTypedPath, onKeep, onRevert, onRefreshVcs, onBlockKeep, onBlockRevert, onOpen, onPreviewImage }: PendingDiffProps) {
  // The same five search-bar tooltips as the split view, plus the copy-reference button, decided once
  // (see `chords.ts`): this host's keycaps where it can draw them, the pre-0.1.7-rc.2 glued label
  // where it cannot. The toolbar's own items decide per item, in their map below.
  const hintCase = actionTooltip(t('action.matchCase'), 'matchCase')
  const hintWords = actionTooltip(t('action.matchWholeWord'), 'matchWholeWord')
  const hintPrev = actionTooltip(t('action.prevDiff'), 'searchPrev')
  const hintNext = actionTooltip(t('action.nextDiff'), 'searchNext')
  const hintClose = escapeTooltip(t)
  const hintCopy = actionTooltip(t('action.copyHint'), 'copyRef')
  // A manual highlight-language override; undefined means auto-detect from the
  // file extension. The picker is DSH's own Menu dropdown, portaled so the
  // list escapes the diff's overflow clip.
  /** The path being typed into the header field; null shows the open file's own path. */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
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
  const splitModel = useMemo(() => (
    splitView ? computeSideBySideDiff(model.diff.rows, true) : null
  ), [splitView, model])
  const splitPairs = splitModel?.pairs ?? null
  /**
   * Which model row each pair holds on each side: the side-by-side view selects PAIRS and names one
   * column (see `splitRowRangeOf`), while everything that reads a selection as lines — the anchor a
   * comment is written to, and the "this range already has a thread" test — speaks rows.
   */
  const pairRows = useMemo(() => {
    const map = new Map<number, { old?: number; new?: number }>()
    if (splitModel === null) return map
    model.diff.rows.forEach((row, rowIndex) => {
      const pair = splitModel.pairOfRow.get(rowIndex)
      if (pair === undefined) return
      const entry = map.get(pair) ?? {}
      if (row.kind !== 'add') entry.old = rowIndex
      if (row.kind !== 'del') entry.new = rowIndex
      map.set(pair, entry)
    })
    return map
  }, [splitModel, model])
  /**
   * The rows a selection names, whichever view made it: the pair range of a side-by-side selection
   * mapped to that column's rows, and a single-column range left as it is.
   *
   * Only the NEW side can be named. A thread is anchored to new-file lines — those are what survive
   * the model being rebuilt, and what its reference label shows — so a left-column selection (the
   * old file, code that may not exist any more) has nothing to anchor to: it reads as no rows, and
   * the comment is not offered on it.
   *
   * @param range - the selection to read.
   * @returns the same lines as a row range, or undefined when the view named none.
   */
  const selectionRows = (range: RowRange | undefined): RowRange | undefined => {
    if (range === undefined) return undefined
    if (!splitView || range.side === undefined || splitModel === null) return range
    if (range.side !== 'new') return undefined
    const rows: number[] = []
    for (let index = range.start; index <= range.end; index++) {
      const row = pairRows.get(index)?.new
      if (row !== undefined) rows.push(row)
    }
    return rows.length === 0 ? undefined : { start: Math.min(...rows), end: Math.max(...rows) }
  }

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

  // Overview-ruler markers: one per maximal run of same-kind changed rows, as
  // row runs. Each surface converts them: the code view reads the height table
  // (discussion blocks reserve rows, so a row-count fraction would misplace
  // them), the preview keeps the row-count fraction for its fallback markers.
  const rulerMarkers = useMemo(() => {
    const rows = model.diff.rows
    if (rows.length === 0) return []
    const markers: { start: number; end: number; kind: 'del' | 'add' }[] = []
    let runStart = -1
    let runKind: 'del' | 'add' = 'del'
    const flush = (end: number) => {
      markers.push({ start: runStart, end, kind: runKind })
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
    setMdRulerMarkers(measured.length > 0 ? measured : previewRulerMarkersOf(rulerMarkers, model.diff.rows.length))
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
  /** The scroll box's non-scrolling parent, which carries the chrome painted over
   *  it (discussion blocks, action frames, the search bar) — see the wheel effect. */
  const bodyWrapRef = useRef<HTMLDivElement>(null)
  // The floating action frame (whichever of the two it is): the element the follow
  // animation is attached to.
  const frameRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  /** The go-to-line dialog: whether it is up, and what has been typed into it. */
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoDraft, setGotoDraft] = useState('')
  /** The row a go-to-line flashed: its box frames that one row instead of the block around it. */
  const flashRowRef = useRef<number | undefined>(undefined)
  const [hScrollbarPx, setHScrollbarPx] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [selection, setSelection] = useState<RowRange | undefined>(undefined)
  // Comment mode (a preview that ships off — see `commentModeEnabled`): whether the panel
  // offers to comment on a range at all. The event below is what re-renders the panel when
  // the Settings section flips it, since the two are separate mounts.
  const [commentMode, setCommentMode] = useState(commentModeEnabled)
  // Comment threads attached to a row range. A thread is the HOST's record (see
  // `PendingDiffSnapshot.comments`) — one copy every client of the session shares, which is what a
  // durable comment has to be — so nothing here is the thread itself: this pane renders the
  // snapshot, and the work below only maps it onto the rows the current model draws. Each block
  // reserves rows in the height table (see `discussionRowExtras`) and paints itself below the range,
  // so the code after it is pushed down rather than covered — the block is part of the row stream's
  // arithmetic, not an overlay.
  //
  // The comment state the derivation below reads, held still across polls that changed nothing. A
  // poll rebuilds the snapshot — and with it these two values — once a second, and re-deriving every
  // thread means re-anchoring it, which joins the file's row windows; doing that for a read that
  // carried the same comments is work nobody asked for, and it would also hand every block a fresh
  // object identity on every tick. `commentsRevision` says the records changed; the answers are
  // compared by their content, because an answer arrives without a new revision (nothing about a
  // record changed, the transcript merely answered it).
  const commentSourceRef = useRef<{ revision: number; comments: readonly CommentRecord[]; answers: Readonly<Record<string, string>> }>(
    { revision: -1, comments: [], answers: {} },
  )
  if (commentSourceRef.current.revision !== commentsRevision
    || !sameAnswers(commentSourceRef.current.answers, commentAnswers)) {
    commentSourceRef.current = { revision: commentsRevision, comments, answers: commentAnswers }
  }
  const commentSource = commentSourceRef.current
  /** The comment records that hang off the file this pane is showing, oldest first. */
  const fileComments = useMemo(
    () => commentSource.comments.filter(record => record.entryId === file.id),
    [commentSource, file.id],
  )
  /**
   * The page-local half of every thread — the draft, the fold, the measured body — kept by comment
   * id in the page's memory, so a poll (which replaces the snapshot under it) does not clear the
   * field the reader is typing in, and a mount that comes back draws what they left.
   *
   * Keyed by the VIEWING session (`sessionId`), not by `file.sessionId`: the record below is the
   * whole session's, every thread the panel could draw, so it belongs to the session whose panel
   * this is. `file.sessionId` names the session that most recently TOUCHED the file, and one entry
   * is shown in every session that touched it — keying the drafts on it would file them under
   * whichever subagent edited the file last, and every session would read another's memory.
   */
  const [threadState, setThreadState] = useState<Readonly<Record<string, ThreadLocal>>>(
    () => rememberedThreads(sessionId),
  )
  useEffect(() => { rememberThreads(sessionId, threadState) }, [sessionId, threadState])
  /**
   * A thread the reader has PLACED but not sent: 评论 opens a compose row on those rows before
   * anything is written, and until `onCommentAdd` returns there is no host record to draw it from.
   *
   * It lives in the page's memory, not in this mount: the panel is unmounted by every close and by a
   * presentation switch, and a block the reader had started — its lines and the words in it — must
   * be there when the panel comes back (the same reason the draft of a stored thread is). The host
   * learns about a comment when it is sent, which is why this half is the page's own record — and
   * why it is the viewing session's, like the thread state above: a placement is a fact about this
   * panel's visit, not about which session last wrote the file.
   */
  const [draftThreads, setDraftThreads] = useState<readonly PlacedThread[]>(
    () => rememberedPlacedThreads(sessionId),
  )
  useEffect(() => { rememberPlacedThreads(sessionId, draftThreads) }, [sessionId, draftThreads])
  /**
   * The threads this pane draws, in the order their rows run: the host's records re-anchored, plus
   * the blocks that have not been written yet.
   *
   * Re-anchoring runs here rather than in an effect that rewrites state: the anchor's new-file lines
   * are what survive a rebuild, and the record's quote is what says whether they still hold the code
   * the comment was written about. When they do not, the thread follows the quote; when even that
   * finds nothing it is marked outdated — it stays where the reader last saw it, says so, and keeps
   * the quote (see `remapDiscussion`).
   */
  const discussions = useMemo<readonly Discussion[]>(() => {
    const mapped: Discussion[] = [
      ...fileComments.map(record => discussionOfRecord(record, commentSource.answers, threadState)),
      ...draftThreads.filter(thread => thread.fileId === file.id).map(thread => discussionOfDraft(thread, threadState)),
    ]
    return remapDiscussions(
      mapped,
      (row) => {
        const entry = model.diff.rows[row]
        return entry?.newLine ?? entry?.oldLine
      },
      (row) => model.diff.rows[row]?.text ?? '',
      model.diff.rows.length,
      // Whether a row is code the file still has (a deleted row has no new-file line): the quote may
      // only be followed to a window that is current in some part, or a copy left behind in the
      // deletions reads as the comment still holding.
      (row) => model.diff.rows[row]?.newLine !== undefined,
    )
  }, [fileComments, commentSource, threadState, draftThreads, model])
  /** Patch the page-local thread state in one commit, so a keystroke is one update. */
  const patchThreads = useCallback((patch: Readonly<Record<string, Partial<ThreadLocal>>>): void => {
    setThreadState(current => {
      let next: Record<string, ThreadLocal> | undefined
      for (const [id, change] of Object.entries(patch)) {
        const before = current[id] ?? { draft: '', collapsed: false }
        const after = { ...before, ...change }
        // Only a real change republishes: the measurement pass reads this on every render, and a
        // record handed back with equal fields would be adopted as a change by everyone holding it.
        if (before.draft === after.draft && before.collapsed === after.collapsed
          && before.failed === after.failed && before.bodyRows === after.bodyRows) continue
        next = next ?? { ...current }
        next[id] = after
      }
      return next ?? current
    })
  }, [])
  /**
   * Forget the page-local state of threads that are gone. A draft belongs to a comment, and a
   * comment the host no longer holds is not coming back: keeping its key would only leave a field's
   * worth of text waiting for an id that will never be drawn again.
   * @param ids - the comment ids to forget.
   */
  const forgetThreads = useCallback((ids: readonly string[]): void => {
    setThreadState(current => {
      let next: Record<string, ThreadLocal> | undefined
      for (const id of ids) {
        if (current[id] === undefined) continue
        next = next ?? { ...current }
        delete next[id]
      }
      return next ?? current
    })
  }, [])
  /**
   * Forget the page's state for threads that are gone.
   *
   * A comment id is the host's, minted once and never reused, so state under an id nothing draws any
   * more — a thread the reader ended, or one whose entry left the list — is dead weight, and a long
   * visit would otherwise keep every draft ever typed. This runs AFTER the render that drew the
   * threads, so a keystroke is never the thing that prunes it.
   *
   * The live set is the SESSION's, never this file's: `threadState` is one record for the whole
   * session (see `rememberedThreads`), so pruning it against the open file's blocks deleted every
   * other file's draft — switching A -> B and back left A's field empty. What is live is every
   * comment the session holds, plus the page-local blocks this pane has placed (which have no host
   * record yet). A comment the host no longer holds is in neither, so it is still dropped.
   */
  useEffect(() => {
    const live = new Set<string>(commentSource.comments.map(record => record.id))
    for (const placed of draftThreads) live.add(placed.id)
    const gone = Object.keys(threadState).filter(id => !live.has(id))
    if (gone.length > 0) forgetThreads(gone)
  }, [commentSource, draftThreads, threadState, forgetThreads])
  /** Which block's overflow menu is open, if any. The card builds the menu's own row (see
   *  `DiscussionBlock`): finishing a thread takes the block, and its rows, away. */
  const [discussionMenuFor, setDiscussionMenuFor] = useState<string | undefined>(undefined)
  /** The compose inputs, so a freshly created block can take the caret. */
  const discussionInputEls = useRef(new Map<string, HTMLInputElement>())
  /** The block whose input should be focused once it is on screen. */
  const focusPendingRef = useRef<string | undefined>(undefined)
  /**
   * The block whose input should take the caret back after a send: the reader is writing a
   * follow-up there, and the send must not leave them with no caret at all. Cleared by the first
   * thing the user does anywhere, because that means they moved on and the caret is not ours.
   */
  const discussionRefocusRef = useRef<string | undefined>(undefined)
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
  /** The offset the file now showing was asked to open at, held until the landing
   *  effect below spends it (that effect runs a render later than the switch). */
  const landingTopRef = useRef<number | undefined>(undefined)
  /** The model row a jump to a comment asked for, spent the same way and by the same effect. */
  const landingRowRef = useRef<number | undefined>(undefined)
  /** Whether that row is a thread's own box rather than a place in the code (see `landingCard`). */
  const landingCardRef = useRef(false)
  /** The latest `onLanded`, for the landing effect: it says the ask has been taken, and the panel
   *  then spends it so a pane that mounts later cannot take it again. Read through a ref because the
   *  panel hands a fresh closure on every render, and re-running the landing effect for that would
   *  place the file twice. */
  const onLandedRef = useRef(onLanded)
  onLandedRef.current = onLanded
  /** The thread the landing effect was asked for, when it named one: several boxes can hang under the
   *  row a jump points at, and the landing has to put the reader at THIS one's top edge rather than at
   *  the top of the stack (see `discussionStack`). Held beside the row so the two are spent together. */
  const landingCommentRef = useRef<string | undefined>(undefined)
  /** Whether a row landing has been asked for and the scroll box could not take it yet (see
   *  `applyScrollTop`): the pane is still its previous size while it opens, so a jump into a file it has
   *  only just mounted can be refused. The ask is then kept and re-applied on the pane's own measurement
   *  (see the retry effect beside the landing) instead of being spent on a write that did not happen. */
  const landingPendingRef = useRef(false)
  /**
   * A landing that did not end where it asked to be: the place itself, and how long to keep trying it.
   *
   * The write is clamped to the box's range, and the box's range is not the reader's yet when the pane has
   * only just mounted for the file — the float card is still opening, this file's rows are not laid out,
   * the comment model may still be arriving — so the write lands short. Nothing re-lands it afterwards
   * (the request has been spent), which is why the same jump is exact on a file already on screen and
   * "somewhere" on one it just opened, at the mercy of which of those is true on the frame the jump runs.
   *
   * Held as the PLACE rather than re-derived, so the retry lands the same spot whatever `focus` or the
   * ranges have become in between, and dropped as soon as the reader scrolls, so it never fights a view
   * they have taken over (see the retry effect beside the landing).
   */
  const landingGoalRef = useRef<{
    /** When to stop trying (a landing is a jump, not a standing order). */
    until: number
    /** The row a comment/row landing named, or `undefined` for a change-block landing. */
    row: number | undefined
    /** The block a block landing named, or `undefined` for a row landing. */
    blockStart: number | undefined
    card: boolean
    comment: string | undefined
  } | undefined>(undefined)
  /** Bumped when a landing is left unfinished, to start the retry loop (see `landingGoalRef`). */
  const [landingVerify, setLandingVerify] = useState(0)
  /**
   * The offset the panel itself last wrote, so `onScroll` can tell its own write's event from the reader's.
   *
   * A programmatic `scrollTop` DOES fire a scroll event in a real browser (only an unchanged value does
   * not) — the panel's own note here claims otherwise, which is why this went unnoticed — so without this
   * marker every write the panel makes for a landing comes back as "the reader scrolled away". That is what
   * abandoned a landing that was still being kept true (see `armLandingGoal`), and it is invisible in a DOM
   * without scroll events: the jump that was a few rows short stayed a few rows short.
   */
  const selfScrollRef = useRef<number | undefined>(undefined)
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
  /**
   * Take the frame off the screen instead of starting another one.
   *
   * A jump that lands a comment's own box raises no flash (see the landing effect), and "no flash"
   * has to mean the one already on screen goes too: opening a file flashes its first change, so a
   * reader who opens a file and then clicks a comment in the list would otherwise keep looking at
   * that frame — moved over the comment's block. Zero is the render gate's off state (see the
   * overlay): the next `bumpFlash` is what puts a frame back.
   */
  const clearFlash = (): void => {
    previewFlashPendingRef.current = false
    setPreviewFlash(undefined)
    setFlashKey(0)
  }

  // Reset transient viewer state whenever the selected file changes, take
  // keyboard focus into the diff body so the Ctrl+Up/Down block-jump (scoped
  // to the panel) works as soon as a file is shown. The scroll position is left
  // to the landing effect below: it scrolls the first change block into view,
  // and resetting it to 0 here would override that for long files whose
  // first change sits far down. This is about the FILE, so a landing that arrives
  // later for the file already showing does not reset any of it.
  useEffect(() => {
    bodyRef.current?.focus()
    setHoveredBlock(undefined)
    setSelection(undefined)
    setLangOverride(undefined)
    setLangMenuOpen(false)
    setCopied(false)
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }, [file.id])

  // Where this file opens. The panel decides that per selection and says so with a
  // landing: the offset it was left at when a showing resumed, the row a comment jump
  // named, or nothing for the file's first change. `focus` follows it — the block the
  // reader was in becomes the current one, so prev/next walk from there — but only a
  // jump flashes: arriving somewhere is not a jump.
  //
  // NO landing, and the file is one this mount did not open, means the pane remounted
  // under a reader who is already reading it: the pending list lost the entry for a
  // moment (a poll re-capturing it), or the panel changed presentation. A file that is
  // already open must not be scrolled — the code under the reader may have changed, but
  // the reader has not — so it resumes the offset they had scrolled it to, which the
  // scroll handler mirrors into the page's memory as they read. Taking the stale
  // landing again here is what threw the reader's place away exactly when the code
  // changed, and landing the first change instead is no better.
  //
  // `landedFileRef` is what separates "this mount has not placed this file yet" from a
  // later render of the same file: without it, the panel spending the landing (see
  // `onLanded`) would look like a remount and re-place the file a second time, undoing
  // whatever jump had just been asked for.
  const landedFileRef = useRef<string | undefined>(undefined)
  /** The file the placement effect below has decided the opening place for (see `placedFileRef`). */
  const placedFileRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    // A landing is "the panel asked for this file, at this place": the tick is what says an ask is
    // there at all, since a plain "land on the first change" carries no offset and no row.
    const landing = (landingTick ?? 0) > 0
    const opened = landedFileRef.current !== file.id
    landedFileRef.current = file.id
    // The landing effect below must not place this file before this decision is made: it runs in the
    // LAYOUT phase, and a fresh mount's wrap measurement becomes ready in the very commit this file
    // first renders in — so it would land the first block on a file whose reader had scrolled it
    // somewhere, and write that over the place they were. This is the mark that says the decision is
    // in; until then the landing effect does nothing.
    placedFileRef.current = file.id
    if (!landing && !opened) return
    if (landing) {
      // The list's comments tab names a comment by its new-file LINE (it draws no rows to give an
      // index); this pane owns the model, so that is where the line becomes a row — once, here, so
      // everything below lands the one row like any other jump.
      // The comment's OWN block answers first, and it is the whole answer when the list's click named
      // one: this pane is the pane drawing that thread, so the row its box hangs at is a fact right
      // here — `anchor.end`, clamped exactly as the row stream clamps it (`discussionsAtRow`) — rather
      // than a new-file line to go looking for. That lookup is what the number cannot always survive:
      // an outdated record names a line the file has moved past, and a line the file still has is often
      // carried by the row DELETING that same number as well, so `rowOfLine` can answer with a row
      // above the code the number names. The line stays as the fallback: a jump that named no comment,
      // or a thread this model is not carrying at all.
      const cardEnd = landingComment === undefined
        ? undefined
        : discussions.find(entry => entry.id === landingComment)?.anchor.end
      const cardRow = cardEnd === undefined
        ? undefined
        : Math.max(0, Math.min(cardEnd, Math.max(0, model.diff.rows.length - 1)))
      const row = landingRow
        ?? cardRow
        ?? (landingLine === undefined ? undefined : rowOfLine(model.diff.rows, landingLine, landingOld === true))
      landingTopRef.current = landingTop
      landingRowRef.current = row
      landingCardRef.current = landingCard === true
      // The named thread travels with the row: several boxes can hang under that row, and the landing
      // below has to put the reader at THIS thread's box rather than at the first one under it.
      landingCommentRef.current = landingComment
      if (row !== undefined) {
        // A jump to a comment: focus the block the comment hangs on, so prev/next walk from where the
        // reader arrived, and let the landing effect below put the row itself where a jump to a
        // change block would put the block — the configured lead rows above it.
        //
        // No flash, though: the frame is the whole change BLOCK's, and the block a comment hangs in
        // usually starts above the viewport, so the reader sees only its top edge blinking at the top
        // of the pane. What the jump was for is the comment's own box, which the landing below puts on
        // screen — and the request says so itself (`landingComment`/`landingCard`). A jump to a change
        // block keeps its flash: there the frame IS the thing that says where the reader landed.
        setFocus(blockIndexAtOffset(offsetOf(row)))
        if (landingComment !== undefined || landingCard === true) clearFlash()
        else bumpFlash(false)
      } else if (landingTop === undefined) {
        setFocus(0)
        bumpFlash(false)
      } else {
        setFocus(blockIndexAtOffset(landingTop))
      }
      // Bump the landing tick so switching files re-lands even when the focus index
      // is unchanged (0 -> 0); the landing effect keys off this instead of the
      // model, so a content refresh no longer re-centers.
      setScrollTick(tick => tick + 1)
      // The ask has been taken: the panel spends it, so a pane that mounts later cannot land it a
      // second time (see the comment above).
      onLandedRef.current?.()
      return
    }
    // Nothing was asked for: the reader's own place, or nothing at all — a file that has never been
    // scrolled opens at the top like any other, and there is no reason to move it.
    landingRowRef.current = undefined
    landingCardRef.current = false
    landingCommentRef.current = undefined
    const offset = panelFileOffset(sessionId, file.id)
    if (offset === undefined) return
    landingTopRef.current = offset
    setFocus(blockIndexAtOffset(offset))
    setScrollTick(tick => tick + 1)
    // `landingTop`, `landingRow`, `landingLine`, `landingComment` and `landingTick` are deps as well as
    // `file.id`: a fresh showing can re-land the *same* file (reopening where it was left), and the
    // chip's own jump lands on the first change of the file already open. `discussions` is a dep
    // because it is where a named comment's row is read from: the blocks are re-anchored against the
    // model in the same render, so the row this effect resolves is the row the cards are drawn at.
  }, [file.id, landingTop, landingTick, landingRow, landingLine, landingComment, landingCard, discussions, model])

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
    // the anchor: land on the selected occurrence first (so "选中这个作为第一个
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
  // Discussions and their bands are painted INSIDE the scroller, so `right` is
  // measured against the scroller's padding box — which already excludes its
  // vertical bar. A bar therefore needs no inset of its own (its left edge is
  // where the code area ends, exactly like `flashWidth`); only a bar-less
  // scroller leaves the ruler sitting in the content area, and that is reserved.
  // Declared here, above the thread's row measurement, because that measurement
  // needs the same number to know how wide the block's body is.
  const discussionRightInsetPx = (() => {
    const scroller = bodyRef.current
    if (scroller === null) return OVERVIEW_RULER_WIDTH_PX
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth
    return scrollbarWidth > 0 ? 0 : OVERVIEW_RULER_WIDTH_PX
  })()
  // The block's own horizontal placement is the browser's job now: it is mounted
  // under a zero-width `position: sticky` pin in its row (`.discussionPin`), which
  // holds the panel's left edge while the code slides sideways. Nothing here has to
  // read `scrollLeft`, and no scroll event has to place anything.

  /**
   * How many code rows one message occupies when the block renders it, at the code's
   * own font and the width that turn actually gets — the same canvas measurement the
   * diff's own wrap mode uses, so the block's height stays exact and the last line is
   * never clipped. A bubble's own padding counts too: half a row above and below add
   * up to a whole one.
   *
   * @param text - the message text.
   * @param role - who said it: the two sides wrap at different widths.
   * @param widthPx - the exact width the text wraps in, when the caller lays it out somewhere
   * other than the thread's own column (the quote's code cell, which sits behind the file's two
   * gutters). Omitted, the turn's own column is used — and a bubble ignores it, since a bubble
   * wraps at its own percentage regardless.
   * @returns the occupied row count (whole: a bubble's chrome is a whole row).
   */
  const messageRowsOf = useCallback((text: string, role: DiscussionMessage['role'], widthPx?: number): number => {
    const lines = text.split('\n')
    // A bubble pads its text by 0.2 of a row above and below and sits 0.3 of a row
    // inside its own margin, so its two vertical sides are exactly one more row; the
    // horizontal padding comes off the wrap width below (there is no horizontal
    // margin, so only the padding narrows the text).
    const bubble = role === 'user'
    const chrome = bubble ? 2 * (DISCUSSION_BUBBLE_PADDING_ROWS + DISCUSSION_BUBBLE_MARGIN_ROWS) : 0
    const measure = makeMeasurer(threadFontOf())
    if (measure === undefined || bodyWidth === 0) return lines.length + chrome
    // The block spans the scroller's client box, so its body is that less the
    // block's own 3px border and the thread's own side inset — and that body is
    // then what a turn wraps inside. Measuring at the CODE column's width instead
    // (what this used to do) over-reserved, since the code starts two gutters in
    // and the block does not — but a bubble capped at a percentage of the body is
    // narrower than both, and there the same shortcut would under-reserve and clip.
    // So measure each side where it actually wraps. The percentage resolves against
    // the body, which is why the inset is subtracted before it is taken.
    const body = Math.max(0, bodyWidth - discussionRightInsetPx - 3 - 2 * DISCUSSION_BODY_INSET_PX)
    const width = widthPx ?? (bubble
      ? body * DISCUSSION_BUBBLE_MAX_WIDTH - 2 * DISCUSSION_BUBBLE_SIDE_PADDING_ROWS * THREAD_ROW_PX
      : body)
    // One character of slack, like the diff's own wrap: canvas metrics and the DOM's
    // glyph advances can differ by a fraction, and a row too few clips.
    const wrapping = width - measure('0')
    if (wrapping <= 0) return lines.length + chrome
    const tabPx = tabWidthSpaces * measure(' ')
    // A chip is a box, not text: its own font (see `chipFontOf`), its padding and its hairline.
    const chipMeasure = makeMeasurer(chipFontOf())
    const chipWidth = (text: string): number => (
      (chipMeasure === undefined ? measure(text) : chipMeasure(text))
      + 2 * (DISCUSSION_CODE_PADDING_PX + DISCUSSION_CODE_BORDER_PX)
    )
    return chrome + lines.reduce((rows, line) => (
      // Always the chip-aware walk, never a plain `wrapInto` on the line: a line with no chip in it
      // comes out of it as one text run, which is the same `wrapInto` on the same characters. What
      // this must NOT be handed is the text with its markers stripped — `discussionRuns` is what
      // finds a chip, and stripped text has none left to find (see `messageSizeOf`).
      rows + Math.max(1, wrapChipRows(line, wrapping, measure, chipWidth, tabPx))
    ), 0)
  }, [bodyWidth, tabWidthSpaces, discussionRightInsetPx])

  /**
   * How many rows the quote of an outdated thread occupies: the code as it wraps in its own
   * code cell, which is the block's full width less the two gutters the quote lays out in. It
   * carries no chrome of its own — no box, no padding — so the count is the wrapped lines.
   *
   * @param quote - the code the thread was written about.
   * @param wrap - the code view's wrap setting: off, no line wraps, so the quote is exactly one
   * row per quoted line whatever the width.
   * @returns the occupied row count (whole).
   */
  const quoteRowsOf = useCallback((
    quote: string,
    lines: readonly DiscussionQuoteLine[] | undefined,
    wrap: boolean,
    split: boolean,
  ): number => {
    const texts = quote.split('\n')
    if (!split) {
      if (!wrap) return texts.length
      const measure = makeMeasurer(codeFontOf())
      const width = Math.max(0, bodyWidth - discussionRightInsetPx) - WRAP_GUTTERS_PX
      if (measure === undefined) return texts.length
      const wrapping = width - measure('0')
      if (wrapping <= 0) return texts.length
      const tabPx = tabWidthSpaces * measure(' ')
      return texts.reduce((rows, line) => rows + Math.max(1, wrapInto(line, wrapping, measure, tabPx).length), 0)
    }
    // Side by side: one row per ALIGNED PAIR, each as tall as the taller of its two halves — the rule
    // the file's own columns follow (see `pairWrapped`), and the reason a quote of a changed line
    // takes one row here where one column would give it two.
    const rows = texts.map((text, index) => {
      const line = lines?.[index]
      return { text, kind: line?.kind ?? 'context', oldLine: line?.old, newLine: line?.new } as WholeFileDiffRow
    })
    const pairs = computeSideBySideDiff(rows, true).pairs
    if (!wrap) return pairs.length
    const measure = makeMeasurer(codeFontOf())
    if (measure === undefined) return pairs.length
    const wrapping = Math.max(0, (bodyWidth - 1) / 2) - WRAP_GUTTERS_PX / 2 - measure('0')
    if (wrapping <= 0) return pairs.length
    const tabPx = tabWidthSpaces * measure(' ')
    const rowsIn = (text: string | undefined): number => (
      text === undefined ? 1 : Math.max(1, wrapInto(text, wrapping, measure, tabPx).length)
    )
    return pairs.reduce((count, pair) => count + Math.max(rowsIn(pair.left?.text), rowsIn(pair.right?.text)), 0)
  }, [bodyWidth, discussionRightInsetPx, tabWidthSpaces])

  /**
   * The size one rendered message needs in code rows: its wrapped lines plus its own
   * padding — which for a bubble is exactly one row (half a row above, half below).
   * Every turn is therefore a whole number of rows and the thread stays on the code's
   * own grid. The text is measured with its inline markers gone, because that is what the
   * turn draws: counting `` and ** would reserve room for characters nobody sees.
   *
   * @param message - the message to size.
   * @returns its size in code rows.
   */
  const messageSizeOf = useCallback((message: DiscussionMessage): number => {
    // The text the turn DRAWS, markers included: `messageRowsOf` reads its runs, and a chip's box —     // its padding, its hairline and the code face it draws its text in — is only visible in the
    // markers. Measuring the plain text instead (which is what this did) counted every chip as
    // ordinary prose, so a line ending in one reserved a row less than it drew and the writing row
    // below it was pushed out of the block, which clips what it did not reserve.
    return messageRowsOf(discussionText(message), message.role)
  }, [messageRowsOf])

  /**
   * The thread as the block will render it, plus the body height that follows from
   * it: the newest turns that fit the cap, an optional "older" note, the answer in
   * flight (or the failure note), and the compose row the user writes in. An outdated
   * block's note and quote count as part of the trailing piece, above the turns.
   *
   * @param discussion - the block to lay out.
   * @returns the messages to render, the hidden count, and the body height.
   */
  // How much of a thread a block keeps: a preference, so a reader who wants more (or less) of a
  // long thread gets it. Read per render, not once, so the settings take effect without a reload.
  const roundLimit = discussionRoundLimit()
  /**
   * Rows a thread's own rendered height corrected the model to, by thread id.
   *
   * The rows a block reserves are meant to BE the rows it draws, and the wrap model above is how
   * they are worked out — but a wrap model that is off by a row or by ten shows up as air under the
   * writing row (or as a clipped turn), and this one demonstrably is: the same answer has measured
   * 7, 11, 25 and 35 rows in different sessions at the same width. So the block's own rendered
   * height is read back after every render and the reservation is corrected to it — the same
   * "measure it, do not reason about it" rule the code view's wrapped rows follow. The map only
   * ever holds what was measured, and an entry stops changing once the drawing settles.
   */
  const layoutDiscussion = useCallback((discussion: Discussion): { messages: readonly DiscussionMessage[]; hidden: number; rows: number } => {
    // Every trailing piece is a whole number of rows: a status note is one row, the
    // compose area two, an answer as many as its wrapped lines. There is no chrome
    // left to round away, which is what keeps the thread on the code's grid.
    //
    // An outdated thread carries the code it was written about below the turns' label — the
    // state itself rides the header, beside the range. It is budgeted like any other turn, so
    // the block still reserves exactly what it draws, and the writing row below is still there —     // an outdated thread is answerable like any other — and still costs its two rows. The quoted
    // lines are CODE rows, though: the label above them is a thread row, and they are counted in
    // that unit scaled by the ratio of the two heights, so a line-height setting moves the block
    // by exactly the pixels the quote draws.
    const outdatedRows = discussion.lost === true && discussion.quote !== undefined && discussion.quote !== ''
      ? 1 + quoteRowsOf(discussion.quote, discussion.quoteLines, langWrap, splitView) * (ROW_HEIGHT_PX / THREAD_ROW_PX)
      : 0
    // The status note and the writing row are BOTH drawn when a question is in flight, has failed or
    // was stopped (see `DiscussionBlock`): the row stays so the reader can write on, and the note is
    // a row of its own — reserved here, or the block would draw a row the height table never counted
    // and clip whatever sits below it.
    const statusNote = discussion.asking === true || discussion.failed === true || discussion.stopped === true
    const trailing = outdatedRows + DISCUSSION_COMPOSE_ROWS + (statusNote ? 1 : 0)
    const tail = discussionRounds(discussion.messages, roundLimit, messageSizeOf)
    return {
      messages: tail.messages,
      hidden: tail.hidden,
      // The cap is spent on whole older turns by the tail above; the newest piece (a note,
      // the compose area) is always carried in full. Not rounded up either: the quote's share is
      // fractional in thread rows but exact in pixels, and a whole row of round-up would leave
      // that much air above the writing row.
      rows: tail.rows + trailing,
    }
  // `bodyWidth` is in the list explicitly, and not only through `messageSizeOf`/`quoteRowsOf`: those
  // two are callbacks of their own, and one link in the chain that stops short of the width is a
  // block laid out for the width it had at some earlier moment — a side-by-side column kept after
  // switching back to one column, say, which reserves rows for a turn wrapped half as wide as the
  // card it is drawn in. That is the difference that shows up as a blank under the writing row.
  }, [langWrap, quoteRowsOf, messageSizeOf, roundLimit, ROW_HEIGHT_PX, bodyWidth, splitView])

  /**
   * The discussions as the render will draw them: the body height the measurement
   * above arrived at, the turns it kept, and the text those turns actually show.
   * The text goes through `discussionText` here as well as in the measurement, so
   * an answer with a blank line is drawn without one AND counted without one — the
   * two can never disagree (see `stripBlankLines`).
   */
  const laidDiscussions = useMemo(
    () => discussions.map(discussion => {
      const laid = layoutDiscussion(discussion)
      return {
        ...discussion,
        // The measured body wins over the model's estimate once the block has drawn once (see the
        // read-back below); it rides the page's memory with the draft, so a mount that comes back
        // draws the thread at the size it already measured.
        bodyRows: threadState[discussion.id]?.bodyRows ?? laid.rows,
        hidden: laid.hidden,
        // The wrap the rows above were counted with, handed to the quote that draws them: the
        // count and the drawing have to be the same decision. `bodyRows` is measured from the
        // wrapped quote and the quote is rendered from this flag — one render, one value, and no
        // way for the two to drift apart into a block that reserves the wrapped height and draws
        // the unwrapped one (see `.discussionCompose`, which turns that difference into air).
        quoteWrap: langWrap,
        messages: laid.messages.map(message => ({ ...message, text: discussionText(message) })),
      }
    }),
    [discussions, layoutDiscussion, threadState, langWrap],
  )

  // Discussion blocks reserve whole rows in the same height table the wrap model
  // uses: a block hangs below its range's last row, so its rows are added to that
  // row's entry. With nothing reserved the table stays null and the cheap
  // uniform-row path is unchanged.
  const discussionExtras = useMemo(
    () => discussionRowExtras(laidDiscussions, rows.length),
    [laidDiscussions, rows.length],
  )
  // Where each block's OWN box starts, in whole rows below the base of the stack it hangs in (see
  // `discussionStackOffsets`): several blocks can end on one row, and the row stream draws them one
  // below the other in this order, so a jump that names a block has to add these to the stack's base
  // or it lands the first box of the row whatever block the reader asked for.
  const discussionStack = useMemo(
    () => discussionStackOffsets(laidDiscussions, thread => Math.max(0, Math.min(thread.anchor.end, Math.max(0, rows.length - 1)))),
    [laidDiscussions, rows.length],
  )
  // Blocks sharing a row render in insertion order, one row each, so their reserved
  // rows never overlap: the row a block hangs below is its range's last row, clamped
  // to the diff (a stale anchor after an edit keeps the block at the end of the file).
  const discussionsAtRow = useMemo(() => {
    const byRow = new Map<number, Discussion[]>()
    for (const discussion of laidDiscussions) {
      const row = Math.max(0, Math.min(discussion.anchor.end, Math.max(0, rows.length - 1)))
      const list = byRow.get(row)
      if (list === undefined) byRow.set(row, [discussion])
      else list.push(discussion)
    }
    return byRow
  }, [laidDiscussions, rows.length])
  /**
   * The rows a discussion annotates. They carry their own wash, so the mark scrolls with
   * the code in both axes with no positioning at all — the overlay this replaces had to
   * be counter-translated on every horizontal scroll and trailed the text. An outdated
   * block washes nothing: the rows under its numbers are no longer the code the comment
   * was written about, so a band there would claim them as annotated (GitHub drops the
   * position of an outdated thread the same way). It says it is outdated and shows the
   * code it was about instead.
   */
  const discussedRows = useMemo(() => {
    const set = new Set<number>()
    for (const discussion of laidDiscussions) {
      if (discussion.lost === true) continue
      for (let row = Math.max(0, discussion.anchor.start); row <= Math.min(discussion.anchor.end, rowCount - 1); row++) {
        set.add(row)
      }
    }
    return set
  }, [laidDiscussions, rowCount])
  const rowHeights = useMemo(() => {
    const wrapped = rowWrapped === null ? null : rowWrapped.map(lines => lines.length * ROW_HEIGHT_PX)
    if (discussionExtras.size === 0) return wrapped
    const heights = wrapped === null
      ? new Array<number>(rows.length).fill(ROW_HEIGHT_PX)
      : [...wrapped]
    for (const [after, extra] of discussionExtras) {
      const index = Math.max(0, Math.min(after, heights.length - 1))
      heights[index] = (heights[index] ?? ROW_HEIGHT_PX) + extra * THREAD_ROW_PX
    }
    return heights
  }, [rowWrapped, discussionExtras, rows.length])
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
  /**
   * Whether the height table carries measured (wrapped) row heights. It is the
   * signal the landing effect waits for; a discussion's reserved rows are a table
   * of their own and must not read as "the measurement just became ready".
   */
  const offsetsFromWrap = rowWrapped !== null
  // The code view's ruler markers: once a block reserves rows the strip's
  // denominator is the real height, so positions come from the height table.
  const rulerMarkersNow: PreviewRulerMarker[] = totalHeight <= 0
    ? []
    : rowOffsets === null
      ? previewRulerMarkersOf(rulerMarkers, rowCount)
      : rulerMarkers.map(marker => ({
          top: (offsetOf(marker.start) / totalHeight) * 100,
          height: ((offsetOf(marker.end + 1) - offsetOf(marker.start)) / totalHeight) * 100,
          kind: marker.kind,
        }))

  // A block that changes height above the viewport shifts every row below it, so
  // the scroll offset has to follow or the code under the user's eyes jumps. The
  // shift is applied in a layout effect, once the height table has been rebuilt.
  const pendingScrollShiftRef = useRef(0)
  useLayoutEffect(() => {
    const shift = pendingScrollShiftRef.current
    pendingScrollShiftRef.current = 0
    const body = bodyRef.current
    if (shift === 0 || body === null) return
    body.scrollTop += shift
    setScrollTop(body.scrollTop)
  }, [discussions])

  // Nothing places a block: each one is a row in the code's own stream, so the browser
  // scrolls it vertically with the code, and its zero-width sticky pin (`.discussionPin`)
  // holds the panel's left edge while the code slides sideways. Both axes are the
  // compositor's, and `setScrollTop` only has to re-render the window. (A scroll-driven
  // animation would do the sideways half too, but the pin needs no keyframes at all; the
  // action frame, whose clamp is not a plain translation, uses one — see
  // `frameFollowKeyframes`.)

  // Put the caret in a just-created block's input, so commenting is one gesture
  // (pick rows → 评论 → type) rather than two. Runs after the commit, so the
  // input exists; the caret goes to the end for a pre-filled draft. The same pass
  // hands the caret back to a block that just sent a comment and whose compose row
  // has returned - but only while the user has not touched anything since (see the
  // listeners below), so a caret that was moved on purpose stays where it is.
  useEffect(() => {
    const fresh = focusPendingRef.current
    const id = fresh ?? discussionRefocusRef.current
    if (id === undefined) return
    const input = discussionInputEls.current.get(id)
    // No input yet means the turn is still running and the compose row is not on
    // screen: the want stays pending until the row comes back.
    if (input === undefined) return
    if (fresh !== undefined) focusPendingRef.current = undefined
    else discussionRefocusRef.current = undefined
    input.focus()
    try {
      input.setSelectionRange(input.value.length, input.value.length)
    } catch {
      // Selection verbs are optional on some input embeddings; focus still lands.
    }
  }, [laidDiscussions])

  // Any pointer or key event anywhere is the user acting on their own: drop the
  // pending caret hand-back. Both listeners run in the capture phase, which is what
  // lets the send itself (a keydown, or the click on the comment button) still set
  // the want *after* its own event has passed through.
  useEffect(() => {
    const drop = (): void => { discussionRefocusRef.current = undefined }
    document.addEventListener('pointerdown', drop, true)
    document.addEventListener('keydown', drop, true)
    return () => {
      document.removeEventListener('pointerdown', drop, true)
      document.removeEventListener('keydown', drop, true)
    }
  }, [])

  // The discussion blocks — and the action frames and the search bar with them —   // are painted in the NON-scrolling wrapper, over the scroll box. A wheel over one
  // of them therefore never reaches that box and the code view sits still under the
  // pointer, which reads as a dead zone exactly where the user is reading. Forward
  // the wheel by hand, but only the part the box can actually take: at either end
  // the event is left alone so it chains outward, the same as a wheel over the code.
  useEffect(() => {
    const wrap = bodyWrapRef.current
    if (wrap === null) return
    const onWheel = (event: WheelEvent): void => {
      const body = bodyRef.current
      const target = event.target
      if (body === null || !(target instanceof Element)) return
      // Over the code itself the browser already scrolls the box; only the chrome
      // floating above it needs this.
      if (target.closest('[data-diff-body]') !== null) return
      const per = event.deltaMode === 1 ? ROW_HEIGHT_PX : event.deltaMode === 2 ? body.clientHeight : 1
      const top = body.scrollTop
      const left = body.scrollLeft
      body.scrollTop = top + event.deltaY * per
      body.scrollLeft = left + event.deltaX * per
      if (body.scrollTop !== top || body.scrollLeft !== left) event.preventDefault()
    }
    // Not passive: this handler is the only thing that can stop the wheel from
    // scrolling whatever is outside the panel instead.
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => { wrap.removeEventListener('wheel', onWheel) }
  }, [ROW_HEIGHT_PX])

  /** Start a discussion on the current selection (no-op on a range that has one). */
  const addDiscussion = (): void => {
    // Comment mode is off by default (a preview): the button and the chord are withheld
    // while it is, so this is the belt to that pair of braces.
    if (!commentMode) return
    // The rows the range names, whichever view made it. A side-by-side selection hands over a pair
    // range and a column, and only its new column reads as rows (see `selectionRows`), so the
    // anchor is always new-file lines — the lines that survive the model being rebuilt.
    const range = selectionRows(selection)
    if (range === undefined) return
    // A row belongs to one annotation at most, so any overlap refuses a second.
    if (discussionOverlapping(discussions, range) !== undefined) return
    // What the frame COVERED on the NEW side — the side every label, jump and reference names, and
    // the side a thread is anchored to. A frame that holds a removal AND a current line therefore
    // names the current line, not the removal's old-file number; a frame of removed lines alone has
    // no such line at all, and is still read the way it always was (see the fallback below): that
    // case is an open question, since a comment there can only be labelled with a line the file no
    // longer has.
    const newLines = newLinesInRows(model.diff.rows, range)
    const first = model.diff.rows[range.start]
    const last = model.diff.rows[range.end] ?? first
    const startLine = newLines?.startLine ?? first?.newLine ?? first?.oldLine
    if (startLine === undefined) return
    const endLine = newLines?.endLine ?? last?.newLine ?? last?.oldLine ?? startLine
    // A new block reserves rows below the anchored row. When that row sits above
    // the viewport, everything the user is reading moves down by the same amount,
    // so the scroll offset follows it - the same rule folding and removal use.
    const body = bodyRef.current
    if (body !== null && offsetOf(range.start) - body.scrollTop < 0) {
      pendingScrollShiftRef.current += (DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS) * THREAD_ROW_PX
    }
    const id = `draft-${Date.now().toString(36)}-${draftThreads.length}`
    // What those lines read like right now, and the numbers the file showed beside them. The
    // anchor is line numbers, and the quote is what tells a later rebuild whether they still
    // point at the same code — see `remapDiscussion`. The gutter pair rides along so an
    // outdated block can show the quote where the file showed it.
    const quoted = model.diff.rows.slice(range.start, range.end + 1)
    const quote = quoted.map(row => row.text).join('\n')
    const quoteLines = quoted.map(row => ({ old: row.oldLine, new: row.newLine, kind: row.kind }))
    // The quoted rows with one row of context on each side — the fingerprint a rebuild matches the
    // thread against, so the code it was about is followed only where its surroundings read the same
    // (see `remapDiscussion`). A quote alone is too weak: a comment on a closing brace or a blank line
    // found that line elsewhere in the file and never went outdated.
    const quoteContext = model.diff.rows
      .slice(Math.max(0, range.start - 1), Math.min(model.diff.rows.length, range.end + 2))
      .map(row => row.text)
      .join('\n')
    // The block the reader just placed is not a comment yet: nothing is written until they send it,
    // so it goes into the page's own placement list — the host has nothing to hold for it (see
    // `sendDiscussion`), and the next poll has no record to replace it with. It starts empty; the
    // words arrive in `onDraft`, which is why they live on the placement rather than in the
    // per-comment state (there is no comment id yet to hang them under).
    setDraftThreads(current => [...current, {
      id,
      fileId: file.id,
      anchor: { start: range.start, end: range.end, startLine, endLine },
      quote,
      quoteContext,
      quoteLines,
      draft: '',
    }])
    // The user asked to comment, so the caret belongs in the new block's input
    // once it is on screen (the effect below runs after the commit).
    focusPendingRef.current = id
    // The selection has become an object: drop the browser's own highlight so
    // only the discussion's band marks those rows, and so the toolbar (which is
    // about a live selection) goes away with it. Guarded: a partial Selection
    // implementation (some embeddings, test doubles) has no range verbs.
    const live = window.getSelection()
    if (typeof live?.removeAllRanges === 'function') live.removeAllRanges()
    selectionTextRef.current = ''
    setSelection(undefined)
  }
  // The shortcut effect below runs while the comment button is on screen, but must not
  // re-register on every render: the same hand-off the search bar uses.
  const addDiscussionRef = useRef(addDiscussion)
  addDiscussionRef.current = addDiscussion

  /**
   * Fold or unfold one block, keeping the code the user is reading in place.
   * @param id - the block to fold.
   * @param collapsed - the state to set (defaults to the opposite of the current).
   */
  const setDiscussionCollapsed = (id: string, collapsed?: boolean): void => {
    const discussion = discussions.find(entry => entry.id === id)
    if (discussion === undefined) return
    const next = collapsed ?? !discussion.collapsed
    if (next === discussion.collapsed) return
    const nextRows = next ? DISCUSSION_HEADER_ROWS : discussionRows(discussion)
    const shift = (nextRows - discussionRows(discussion)) * THREAD_ROW_PX
    const body = bodyRef.current
    // Only compensate when the block sits above the viewport: at or below it the
    // block grows downwards, and nothing the user is reading moves.
    if (body !== null && offsetOf(discussion.anchor.start) - body.scrollTop < 0) {
      pendingScrollShiftRef.current += shift
    }
    patchThreads({ [id]: { collapsed: next } })
  }

  /** Fold or unfold one block from its header arrow. */
  const toggleDiscussion = (id: string): void => { setDiscussionCollapsed(id) }

  /**
   * Ask one STORED comment, and report what the ask did.
   *
   * Nothing here tracks which turn belongs to which thread: the host mints the request id the answer
   * is keyed by, and derives the answer text from the session's own transcript on every read (see
   * `commentAnswers`). So a question asked before the panel was closed is still waiting when it comes
   * back, and two threads may wait at once — each one's answer is keyed by its own request.
   *
   * The words come back to the field when the ask did not go through: the reader wrote them, and a
   * session with no live agent is not a reason to make them write it again.
   *
   * @param id - the stored comment to ask.
   * @param prompt - the question text to submit.
   * @param text - the reader's own words, which the prompt wraps: the thread draws these.
   */
  const askComment = async (id: string, prompt: string, text: string): Promise<void> => {
    // Sending empties the row, so the send reads as taken rather than as a field that did nothing.
    patchThreads({ [id]: { draft: '', failed: false, collapsed: false } })
    let value: DiffApprovalCommentAskValue
    try {
      value = await onCommentAsk(sessionId, id, prompt, text)
    } catch (error: unknown) {
      patchThreads({ [id]: { draft: text, failed: true } })
      onToast(error instanceof Error ? error.message : String(error))
      return
    }
    if (value.outcome === 'missing') {
      // The host does not hold this comment any more (the entry left the list, which takes its
      // comments with it): the next read drops the block, and the reader is told why it went.
      onToast(t('discussion.askMissing'))
      return
    }
    // `no-agent` and `failed` are the same surface the block has always had for a declined send:
    // the note under the turns, and the writing row back with what was written still in it. When the
    // host knows why (`failed` carries a message), the reader is told that too — a question that
    // will not go through is not something the block alone can explain.
    if (value.outcome !== 'asked') {
      patchThreads({ [id]: { draft: text, failed: true } })
      if (value.message !== undefined) onToast(value.message)
    }
  }

  /**
   * Send one turn of a discussion to the agent.
   *
   * The first turn is the annotation: the `(path:lines)` reference, the reader's words and the
   * length policy. Later turns are follow-ups in the same thread - the reference rides along so the
   * agent keeps answering about these rows, and the answer is appended rather than replacing the
   * previous one, because it is a new question inside the same stored comment.
   *
   * A thread the host does not know yet is written down first: the comment IS the annotation, and a
   * question can only be asked inside a stored one. Nothing local stands in for a write the host
   * refused — the block goes, and the refusal is said out loud — so what the panel shows is always
   * something the host will still be holding on the next read.
   *
   * @param id - the discussion to ask in.
   */
  const sendDiscussion = (id: string): void => {
    const discussion = discussions.find(entry => entry.id === id)
    if (discussion === undefined) return
    // Trimmed once: a field holding nothing but spaces has nothing to send, and the trimmed text is
    // what the prompt below is built from.
    const text = discussion.draft.trim()
    if (text === '') return
    const reference = `(${discussionLineRange(discussion)})`
    const marker = `${t('discussion.marker')} ${reference}`
    // The rules ride the message only when this host cannot deliver the skill: with a
    // skill the prompt is the marker, the question and a pointer at it, so a long rule
    // never costs tokens again (the catalog advertises the skill's own summary, and the
    // body is loaded on demand — see `src/comment-skill.ts`).
    const rule = commentSkill === undefined
      ? t('discussion.promptRule')
      : t('discussion.promptRuleSkill', { skill: commentSkill })
    // The frame the reader drew rides the question as a block of its own lines. A reference is one
    // number, and a number cannot say which of the rows it was written on is a REMOVAL: annotating a
    // deleted line sent `a.txt:2`, and the reader of that prompt went to line 2 of the file — which is
    // another line entirely, since a removed line keeps only the OLD file's numbers. The block carries
    // every row, its side, and that side's number (see `quotedFrame`), so what the comment is about is
    // in the question instead of being reconstructed from one integer.
    const frame = quotedFrame(discussion.quote, discussion.quoteLines)
    const legend = frameCoversRemovedRow(discussion.quoteLines) ? `\n${t('discussion.frameLegend')}` : ''
    const prompt = frame === ''
      ? `${marker}\n${text}\n\n${rule}`
      : `${marker}\n${frame}${legend}\n\n${text}\n\n${rule}`
    if (fileComments.some(record => record.id === id)) {
      // Already written down: this is a follow-up, and it appends a question of its own rather than
      // writing a second comment (see `CommentAsk`).
      void askComment(id, prompt, text)
      return
    }
    // The id the host will know this thread by is minted here, not taken from the local block: the
    // page's state for a thread is keyed by that id (see `threadState`), so the draft follows the id
    // the snapshot will carry.
    const commentId = newId()
    const draft: CommentDraft = {
      id: commentId,
      entryId: file.id,
      anchor: { startLine: discussion.anchor.startLine, endLine: discussion.anchor.endLine },
      quote: discussion.quote ?? '',
      text,
      ...(discussion.quoteContext === undefined ? {} : { quoteContext: discussion.quoteContext }),
      ...(discussion.quoteLines === undefined ? {} : { quoteLines: [...discussion.quoteLines] }),
    }
    void (async () => {
      let added = false
      try {
        added = (await onCommentAdd(sessionId, draft)).outcome === 'added'
      } catch (error: unknown) {
        onToast(error instanceof Error ? error.message : String(error))
      }
      if (!added) {
        // The host refused it — in practice because the entry left the list while the reader was
        // writing. The local block goes with the refusal: a compose row the host cannot answer for
        // is worse than none, and the reader is told what happened.
        onToast(t('discussion.addMissing'))
        setDraftThreads(current => current.filter(thread => thread.id !== id))
        return
      }
      // The host holds the comment now — the store re-read before its write resolved — so the local
      // block is spent and the snapshot's record takes its place. The ask lands on that record.
      setDraftThreads(current => current.filter(thread => thread.id !== id))
      discussionRefocusRef.current = commentId
      await askComment(commentId, prompt, text)
    })()
  }

  /** Discard one block, keeping the code the user is reading in place. */
  const removeDiscussion = (id: string): void => {
    const discussion = discussions.find(entry => entry.id === id)
    if (discussion === undefined) return
    const shift = discussionRows(discussion) * THREAD_ROW_PX * -1
    const body = bodyRef.current
    // Same rule as folding: only a block above the viewport moves what is below it.
    if (body !== null && offsetOf(discussion.anchor.start) - body.scrollTop < 0) {
      pendingScrollShiftRef.current += shift
    }
    if (fileComments.some(record => record.id === id)) {
      // A written-down thread belongs to the host, so ending it is a host action and the next read is
      // what takes the block away. A refusal is said out loud rather than leaving the block up with
      // no explanation.
      void onCommentRemove(sessionId, id).catch((error: unknown) => {
        onToast(error instanceof Error ? error.message : String(error))
      })
      return
    }
    setDraftThreads(current => current.filter(thread => thread.id !== id))
    forgetThreads([id])
  }

  /**
   * The commented lines as a `path:lines` label - the same reference vocabulary the copy control
   * uses, so a discussion names where it sits in the file.
   *
   * The numbers are the HOST's answer for this comment (see `commentLines`): it resolved the quote
   * against the file's current content, and the list pane, this card and the reference a question
   * carries all read that one map — which is what stops one comment reading `[382]` in the list and
   * 378 in the code view. A comment the host could not place keeps the lines its record holds: the
   * anchor it was WRITTEN on, which is what an outdated block says too.
   * @param discussion - the block being labelled.
   * @returns the reference label.
   */
  const discussionLineRange = (discussion: Discussion): string => {
    const resolved = commentLines[discussion.id]
    const label = referenceLabelOf(
      file.path,
      workspacePath,
      resolved?.start ?? discussion.anchor.startLine,
      resolved?.end ?? discussion.anchor.endLine,
    )
    // A frame of removed rows alone has no current line to name, so the numbers it carries are the
    // OLD file's: the label says which file they came from rather than pointing the reader (and the
    // question) at whatever line now happens to read that number. A comment the host placed, or one
    // whose frame kept no sides, is labelled exactly as before.
    const oldOnly = resolved === undefined && frameNamesNoCurrentLine(discussion.quoteLines)
    return oldOnly ? `${label}${t('discussion.deletedLabel')}` : label
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

  // The floating action frame anchors to the bottom edge of the hovered block, or of
  // the last block a selection covers. A selection that covers no change block
  // (comment-only) has no such block, so it anchors to its own last row instead.
  const hoveredBlockEnd = hoveredBlock === undefined ? undefined : model.blocks[hoveredBlock]?.end
  const selectionBlockEnd = ((): number | undefined => {
    if (coveredBlockIndices.length > 0) {
      const lastIndex = coveredBlockIndices[coveredBlockIndices.length - 1]
      if (lastIndex !== undefined) {
        const end = model.blocks[lastIndex]?.end
        if (end !== undefined) return end
      }
    }
    return selection?.end
  })()

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
  //
  // `splitView` belongs in the dependency list for the same reason the viewport
  // measurement above carries it: the split view unmounts this scroller, so a wrap toggle
  // flipped while that view is up has no box to measure and the last figure stands. For a
  // file opened in split mode that figure is zero, and coming back to one column left the
  // unified view wrapping against it — the setting was on and nothing wrapped, until some
  // other dependency happened to change.
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
  }, [file.id, langWrap, previewActive, splitView])

  // Read that same width back after every render, not only when the observer fires. A drag of the
  // panel's edge re-renders per frame, and the observer delivers its callback in a later task, so the
  // comment card — whose box is an inline width from this state, unlike the code rows, whose width is
  // the layout's — stayed visibly behind the code while the reader dragged and only caught up once the
  // drag ended. A layout effect runs before paint, so the card lands on the frame the drag made. The
  // guard is what keeps this from looping; the observer above still covers the changes that come with
  // no render at all (a window resize, a platform scrollbar appearing).
  const widthMovedRef = useRef(false)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const width = body.clientWidth
    widthMovedRef.current = width !== bodyWidth
    if (width !== bodyWidth) setBodyWidth(width)
  })

  // The reservation follows the drawing (see the page's `bodyRows`): what the card renders is
  // measured here and the thread's rows are corrected to it. The last child's bottom edge IS the
  // content's height — margins included, since the model counts a bubble's own margin as a row — and
  // the box's `overflow: hidden` does not move it, so an under-reserved block grows and an
  // over-reserved one gives its air back. One row of rounding is left to the writing row's own slack
  // spacer. The measurement is written into the page's memory with the draft, so a mount that comes
  // back draws the thread at the size it was already measured at.
  // The width the cards are drawn at, from the last pass. While it is still moving — the panel's
  // edge being dragged, a divider — the correction waits: a resize re-wraps every thread on every
  // frame, and correcting each one costs a second render per frame, which is what left the card's
  // own width a frame behind the code view's while the reader dragged. The frame after it settles
  // corrects as usual.
  const fitWidthRef = useRef(0)
  // A correction that the settled pass still owes. Needed because the pass that first sees the new
  // width is the pass the read-back above triggered — and nothing else may re-render this panel once
  // the reader lets go of the edge, so without this the reservation could keep the outgoing figure.
  const [, bumpFixTick] = useReducer((n: number) => n + 1, 0)
  const fixTickArmedRef = useRef(false)
  useLayoutEffect(() => {
    const firstCard = document.querySelector<HTMLElement>('[data-diff-discussion]')
    const cardWidth = firstCard?.getBoundingClientRect().width ?? 0
    const settled = cardWidth > 0 && Math.abs(cardWidth - fitWidthRef.current) <= 1
    fitWidthRef.current = cardWidth
    if (!settled) {
      // Still moving (a drag, a divider) — correcting every frame costs a render per frame, which is
      // what made the card's own width trail the code view's. Wait for the box to stop moving and then
      // take one more pass, since this one drew the outgoing width. What "stopped" means is checked a
      // frame later, because the pass that first wears the new width is the one the read-back above
      // triggered and a drag will have moved the box again by the time the frame is over. With no card
      // drawn there is nothing to correct and nothing to wait for.
      if (cardWidth > 0 && !widthMovedRef.current && !fixTickArmedRef.current) {
        const armed = bodyRef.current?.clientWidth ?? 0
        fixTickArmedRef.current = true
        requestAnimationFrame(() => {
          fixTickArmedRef.current = false
          if ((bodyRef.current?.clientWidth ?? 0) !== armed) return
          bumpFixTick()
        })
      }
      return
    }
    const measured: Record<string, Partial<ThreadLocal>> = {}
    for (const card of document.querySelectorAll<HTMLElement>('[data-diff-discussion]')) {
      const id = card.dataset.diffDiscussionId
      const body = card.children[1]
      const last = body?.lastElementChild
      if (id === undefined || body === undefined || last === null || last === undefined) continue
      // Measure the CONTENT only. The slack above the writing row is the placeholder that fills whatever
      // height the block was reserved and is not spent (`.discussionSlack`), so counting it measures the
      // reservation that was just written rather than the thread: the correction would feed its own output
      // back in, and at a whole-row height the pixel snapping described on `DISCUSSION_ROW_SNAP_PX`
      // turned that into an endless write. Taking it out leaves a figure that does not depend on what the
      // block is holding, so the correction settles — and it settles closer to what the block draws.
      const slack = body.querySelector<HTMLElement>('[data-diff-discussion-slack]')
      const drawn = last.getBoundingClientRect().bottom
        + (Number.parseFloat(getComputedStyle(last).marginBottom) || 0)
        - body.getBoundingClientRect().top
        - (slack?.getBoundingClientRect().height ?? 0)
      // A collapsed or not-yet-laid-out card measures zero; leave it to a later pass.
      if (drawn <= 0) continue
      const want = Math.max(1, Math.ceil((drawn - DISCUSSION_ROW_SNAP_PX) / THREAD_ROW_PX))
      if (threadState[id]?.bodyRows !== want) measured[id] = { bodyRows: want }
    }
    if (Object.keys(measured).length > 0) patchThreads(measured)
  })

  // The writing field of the thread the reader is typing in must not move on the SCREEN when the file
  // under it changes — a re-read from disk, an external write, a row above it that now wraps onto a
  // line it did not have. The reader stays where they are, so a box that slides away from their eyes
  // takes the caret's context with it; what has to stay is the field's place on the screen, not the
  // line it hangs on, so the correction is the difference between the two drawings of one commit
  // rather than the row delta between them.
  //
  // Those two drawings have to be read in their own moments. The OLD one is read here, in the render,
  // while the DOM this render was planned against is still the one on screen; the NEW one is read in
  // the layout pass below, after React has swapped the content in and after every other pass that
  // could have moved the rows. A correction that read both of its figures in the same layout pass
  // would be handed the new drawing as its "before" — the two would cancel out and the field would
  // never be kept still — which is why the first reading cannot be deferred into an effect.
  //
  // A reading is a place on the SCREEN, so it is turned into a place in the CONTENT before the two
  // are compared — the scroll it was taken at and the viewport's own top both come out of it (see
  // the layout pass). The old reading carries its own scroll for exactly that reason: without it the
  // comparison counts the scroll the last correction already applied, and the correction then chases
  // its own output — 200, 400, —— until it hits the end of the file. The render that a correction's
  // own `applyScrollTop` triggers is read like any other, so this is the common case, not an edge.
  const composerBeforeRef = useRef<{ id: string; fileId: string; top: number; viewportTop: number; scrollTop: number } | undefined>(undefined)
  /** The field the caret is in, if it is in one this panel is drawing. */
  const focusedComposer = (): { id: string; input: HTMLElement } | undefined => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-diff-discussion-input]')) return undefined
    const card = active.closest<HTMLElement>('[data-diff-discussion]')
    const id = card?.dataset.diffDiscussionId
    return id === undefined ? undefined : { id, input: active }
  }
  {
    const typing = focusedComposer()
    const planned = bodyRef.current
    composerBeforeRef.current = typing === undefined || planned === null
      ? undefined
      : {
          id: typing.id,
          fileId: file.id,
          top: typing.input.getBoundingClientRect().top,
          viewportTop: planned.getBoundingClientRect().top,
          scrollTop: planned.scrollTop,
        }
  }
  useLayoutEffect(() => {
    const before = composerBeforeRef.current
    // The reading is this commit's, and it is spent here: the next render takes its own.
    composerBeforeRef.current = undefined
    if (before === undefined) return
    const body = bodyRef.current
    const typing = focusedComposer()
    if (body === null || typing === undefined || typing.id !== before.id || before.fileId !== file.id) return
    // Both readings are turned into CONTENT offsets before they are compared, each through the scroll
    // it was taken at and the viewport top it was taken against. What is left is how far the content
    // under the box moved; adding that to wherever the view is NOW keeps whatever another pass of
    // this same commit did (a row shift, a landing, a card reveal) and corrects only the reflow.
    const viewportTop = body.getBoundingClientRect().top
    const beforeContentTop = before.top - before.viewportTop + before.scrollTop
    const contentTop = typing.input.getBoundingClientRect().top - viewportTop + body.scrollTop
    const shift = contentTop - beforeContentTop
    if (shift === 0) return
    const target = Math.max(0, Math.min(body.scrollTop + shift, body.scrollHeight - body.clientHeight))
    if (target === body.scrollTop) return
    applyScrollTop(body, target)
  })

  // A thread that grows while its reader watches must not end up half under the viewport's bottom
  // edge: an answer arriving is the case that does it, because the block's reserved rows are being
  // corrected at the same moment and the reader has already been left with a clipped last line.
  // What is revealed is the bottom edge in full, and by the smallest scroll that gets it there: the
  // write puts the bottom exactly on the edge, so the pass the write itself triggers asks for nothing
  // and the correction cannot walk the view up a row at a time.
  //
  // Two things gate it, and both are the reader's own: a card that is not on screen is not dragged
  // back into view (they scrolled away from it on purpose), and a card the block did not make BIGGER
  // was not grown by an answer — the reader moved past it, or the text was only replaced.
  //
  // "Bigger" is a fact about the thread's own content — the rows it reserves in the height table
  // (`discussionRows`, the figure `data-diff-discussion-space` draws) and the turns it draws — read
  // against the previous pass, NOT the box the browser handed back. The drawn box is exactly what the
  // read-back above then corrects to the reservation, so the pass an answer arrives on may well
  // measure a box still at an older height; the box is the panel's output, and reading growth off it
  // is reading the correction's own subject. An answer ARRIVING is a turn the thread did not draw
  // before, and a replacement of its text is not: the turn count separates the two even when the
  // rows do not move, because the row the note of a question in flight took is the row the answer
  // then takes. A card with no reading from an earlier pass is a thread that just arrived — the file
  // opened, the panel came back — and its clipped bottom is a real thing to reveal. The reading is
  // taken before the card's box is even looked at, so a card that draws nothing yet — a collapsed or
  // not-yet-laid-out box — still answers for the pass that draws it for real.
  const cardThreadRef = useRef(new Map<string, { rows: number; turns: number }>())
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const viewport = body.getBoundingClientRect()
    const scrollTop = body.scrollTop
    // What each block holds now, off the same model the height table was built from.
    const shapeNow = new Map<string, { rows: number; turns: number }>()
    for (const discussion of laidDiscussions) {
      shapeNow.set(discussion.id, { rows: discussionRows(discussion), turns: discussion.messages.length })
    }
    const seen = cardThreadRef.current
    const ids = new Set<string>()
    let shift = 0
    for (const card of document.querySelectorAll<HTMLElement>('[data-diff-discussion]')) {
      const id = card.dataset.diffDiscussionId
      if (id === undefined) continue
      ids.add(id)
      const shape = shapeNow.get(id)
      if (shape === undefined) continue
      const before = seen.get(id)
      seen.set(id, shape)
      const box = card.getBoundingClientRect()
      if (box.height <= 0) continue
      const needs = box.bottom <= viewport.bottom ? 0 : box.bottom - viewport.bottom
      const onScreen = box.top < viewport.bottom && box.bottom > viewport.top
      const grew = before === undefined || shape.rows > before.rows || shape.turns > before.turns
      if (needs <= 0 || !onScreen || !grew) continue
      shift = Math.max(shift, needs)
    }
    // Threads the page no longer draws: their reading would answer for a card that comes back at
    // the same id (a re-opened file) with a stale shape.
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id)
    if (shift <= 0) return
    const reveal = Math.min(scrollTop + shift, body.scrollHeight - body.clientHeight)
    if (reveal === scrollTop) return
    applyScrollTop(body, reveal)
  })

  // Scroll the focused change block into view after focus, content changes, or
  // a jump. The block's top edge lands two rows below the viewport top so a
  // little context stays visible above it; near the top or bottom the scroll
  // clamps to the scrollable range instead. Arithmetic on the fixed row height
  // works even when the block's rows are outside the rendered window. A
  // programmatic scrollTop DOES fire a scroll event in a real browser (only an unchanged value does not),
  // so the DOM write is mirrored into state to re-render the window AND remembered as the panel's own —
  // `onScroll` uses that to tell its write from the reader's. Layout timing matters: the block-flash
  // overlay reads scrollTop while rendering, so the scroll must settle BEFORE the browser paints —
  /**
   * Move the code view to one offset, and take the page's memory with it.
   *
   * The memory is what a pane that remounts under the reader resumes (see the landing effect), so it
   * has to follow every write the panel itself makes — a jump included. Mirroring only the reader's
   * own scrolls would leave a remount resuming the place they left rather than the place the jump
   * put them, which is the same "it moved on its own" the memory exists to stop.
   *
   * @param body - the code view's scroll box.
   * @param offset - the offset to settle it at.
   * @returns whether the box TOOK the offset (see the note on a refused write below).
   */
  const applyScrollTop = (body: HTMLElement, offset: number): boolean => {
    if (body.scrollTop !== offset) body.scrollTop = offset
    // A pane that is not its final size yet — the float card still opening, a pane that has just mounted
    // for the file a jump opened — refuses an offset past its own range and keeps the one it had.
    // Mirroring that write into this pane's state and into the page's memory is what left a jump looking
    // like it landed "somewhere": the place the reader was in before, which is also the place a pane that
    // mounts again would resume.
    const took = Math.abs(body.scrollTop - offset) < 1
    if (!took) return false
    // Written by the panel: the scroll event this raises is not the reader taking over (see `selfScrollRef`).
    selfScrollRef.current = body.scrollTop
    setScrollTop(offset)
    rememberPanelView(sessionId, { fileId: file.id, scrollTop: offset })
    return true
  }

  /**
   * Put one row's landing where it belongs, and say whether the box took it (see `applyScrollTop`).
   *
   * A thread's box hangs just below the row its range ends in, so it starts where that row's own height
   * ends — the reserving rows charged to it are the box itself, not part of the row.
   *
   * That end is the BASE of the row's stack, and several boxes can share it: the row stream draws one
   * reserving box per thread, in the order the threads are held, so the box that was asked for starts
   * that many boxes further down. Taking the whole charge off (`discussionExtras`) is what landed the
   * FIRST box under the row whatever thread the jump named — the two boxes then could not be told apart
   * by where the jump went. `discussionStack` is that same drawing order, as the reserved height of the
   * boxes before this one.
   *
   * @param rowBody - the code view's scroll box.
   * @param row - the row the landing names.
   * @param toCard - whether the landing is the thread's own box rather than the row.
   * @param wantedCard - the thread the landing named, when it named one.
   * @returns whether the box could REACH the offset (see below).
   */
  const rowLandingTarget = (row: number, toCard: boolean, wantedCard: string | undefined): number => {
    const stackBase = offsetOf(row + 1) - (discussionExtras.get(row) ?? 0) * THREAD_ROW_PX
    const cardTop = stackBase + (wantedCard === undefined ? 0 : (discussionStack.get(wantedCard) ?? 0) * THREAD_ROW_PX)
    const target = toCard ? cardTop : offsetOf(row)
    return target - leadRows * ROW_HEIGHT_PX
  }
  const applyRowLanding = (rowBody: HTMLElement, row: number, toCard: boolean, wantedCard: string | undefined): boolean => {
    const wanted = rowLandingTarget(row, toCard, wantedCard)
    const written = Math.max(0, Math.min(wanted, rowBody.scrollHeight - rowBody.clientHeight))
    applyScrollTop(rowBody, written)
    // Whether the box could reach it: a range SHORTER than the target — a pane still the previous
    // layout's size, rows that are not laid out yet — leaves the write short of where the reader asked to
    // go, and the ask is then kept for the retry below (see `landingGoalRef`). A target past the end of a
    // fully measured file is a legitimate clamp and counts as reached: that is the bottom of the file,
    // not a pane that cannot show it.
    return wanted - written < 1
  }
  /** Spend the row landing that has just been applied: the refs beside the pending flag ARE the ask. */
  const landRowDone = (): void => {
    landingRowRef.current = undefined
    landingCardRef.current = false
    landingCommentRef.current = undefined
    landingPendingRef.current = false
  }
  /**
   * Keep a landing true for a moment after it is applied (see the retry effect below).
   *
   * A landing is computed from heights that are still settling: a thread's own size is measured a frame
   * or two after it first draws, wrapped row heights arrive later still, and the pane itself may be its
   * previous layout's. Any of those moves the place the landing asked for, and the write that was exact
   * when it was made is then a few rows out — which only a file this pane has just mounted shows, and
   * only on some frames. Held as the PLACE (a row, a card, a block) rather than re-derived, so the retry
   * lands the same spot whatever `focus` has become; dropped as soon as the reader scrolls.
   *
   * @param goal - the place the landing named, without its deadline.
   */
  const armLandingGoal = (goal: { row: number | undefined; blockStart: number | undefined; card: boolean; comment: string | undefined }): void => {
    landingGoalRef.current = { ...goal, until: Date.now() + LANDING_RETRY_MS }
    setLandingVerify(n => n + 1)
  }
  /**
   * Where a goal's place sits in the CURRENT heights, read afresh every render.
   *
   * The retry loop below runs across many frames and many renders, and the whole reason it exists is that
   * the heights move under it: read through a closure captured when the loop started, it would keep
   * re-asserting the offset that was right one frame ago — which is the difference between a jump that
   * lands and one that stops a few rows short, and it is exactly what a jump from one comment to another
   * shows (the first landing's own card has just changed the heights above the second one).
   */
  const landingTargetRef = useRef<(goal: { row: number | undefined; blockStart: number | undefined; card: boolean; comment: string | undefined }) => number>(() => 0)
  landingTargetRef.current = goal => (
    goal.row === undefined
      ? offsetOf(goal.blockStart ?? 0) - leadRows * ROW_HEIGHT_PX
      : rowLandingTarget(goal.row, goal.card, goal.comment)
  )
  useLayoutEffect(() => {
    if (rowCount === 0) return
    // Nothing is placed before the placement effect has decided where this file opens: this runs in
    // the layout phase, and a fresh mount's wrap measurement becomes ready in the same commit — it
    // would land the first block on a file whose reader had scrolled it elsewhere (see
    // `placedFileRef`).
    if (placedFileRef.current !== file.id) {
      return
    }
    // A resumed view wins over the focused block: the reader comes back to the
    // line they left, and the exact stored offset is a better answer than the
    // change block the anchor in `blockIndexAtOffset` approximated. Spent here,
    // so a later jump recenters as usual.
    const resumed = landingTopRef.current
    if (resumed !== undefined) {
      landingTopRef.current = undefined
      if (!previewActive) {
        const resumeBody = bodyRef.current
        if (resumeBody !== null) {
          applyScrollTop(resumeBody, Math.max(0, Math.min(resumed, resumeBody.scrollHeight - resumeBody.clientHeight)))
        }
      }
      return
    }
    // A jump to a comment (the list's comments tab): the row it hangs on, landed on the way a jump
    // to a change block lands — the same lead rows above it, clamped to the scroll range, and no
    // flash (the ask is the comment's own box, not the block around it; see the landing effect
    // above). The preview has no rows to scroll by, so it falls through to the block path below and
    // lands the block the comment is in.
    const row = landingRowRef.current
    if (row !== undefined && !previewActive) {
      const toCard = landingCardRef.current
      // The thread this landing named, if it named one: several boxes can hang under one row, and the
      // reader asked for THEIRS (see `applyRowLanding`).
      const wantedCard = toCard ? landingCommentRef.current : undefined
      // A frame a block jump raises frames the block, not the row a go-to-line framed last.
      flashRowRef.current = undefined
      // The split view owns its own scroller — this component's `bodyRef` is null while it is up — so
      // the row is landed there, at the pair it is in, by the same rule. It has no refused write to
      // retry: its own effect lands the pair on `landKey`.
      if (splitView) {
        splitDiffRef.current?.land(row, toCard, false, wantedCard)
        landRowDone()
        return
      }
      const rowBody = bodyRef.current
      if (rowBody !== null) applyRowLanding(rowBody, row, toCard, wantedCard)
      landRowDone()
      // Kept true for a moment after it is applied: the heights this place is computed from are still
      // settling (a thread's own size is measured a frame or two later, and a card that grows moves
      // everything under it), so a landing that was exact when it was written can be a few rows out by
      // the time the reader looks. See `armLandingGoal`.
      armLandingGoal({ row, blockStart: undefined, card: toCard, comment: wantedCard })
      return
    }
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
    const written = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    applyScrollTop(body, written)
    armLandingGoal({ row: undefined, blockStart: block.start, card: false, comment: undefined })
    // Re-run once when wrapped offsets go from "not measured yet" to ready, so
    // an open-with-wrap-on file centers on the block's real (wrapped) offset
    // instead of the initial fixed-22px guess. `rowOffsets === null` flips only
    // on the readiness transition, not on every resize re-measure.
    // The `focus` is deliberately NOT a dep: a scroll re-anchors `focus` to the
    // block under the viewport (see `onScroll`), and that must NOT recenter and
    // fight the user's scroll. Only a jump/keep/switch (which bump `scrollTick`)
    // recenters the focused block.
    // NOTE: `model`/`rowCount` are deliberately NOT deps - a content refresh
    // would otherwise re-center the view and lose the user's scroll position.
    // The readiness flag is the WRAP measurement (the initial render guesses the
    // fixed row height), not `rowOffsets === null`: a discussion block reserving
    // rows also materializes that table, and recentering the view when the user
    // simply annotates a line would be a jump they did not ask for.
  }, [scrollTick, offsetsFromWrap, previewActive])

  /** How long a landing that fell short keeps trying (see `landingGoalRef`). A jump is a moment, not a
   *  standing order: this covers a float card opening, a first layout and a model arriving, and then
   *  stops — it is not a "keep the reader here" rule. */
  const LANDING_RETRY_MS = 1500
  // A landing that did not end where it asked to be (see `landingGoalRef`): tried again on the frames that
  // follow, because whatever the pane was missing when the jump ran — its own size, this file's rows, the
  // comment model — is exactly what stands between the write and the target, and none of them are facts
  // this effect can watch. It writes directly (no re-render per frame) and stops as soon as the target is
  // reached, when the reader scrolls, or after `LANDING_RETRY_MS`.
  //
  // The block landing is still not re-run for a bare resize: this waits for a write that FELL SHORT, so a
  // reader who resizes a pane they have already landed in is not dragged anywhere.
  useEffect(() => {
    if (landingGoalRef.current === undefined) return
    // A frame, spelled so an environment without `requestAnimationFrame` (a bare DOM in a test) still
    // retries rather than throwing: the retry is the point, not the particular scheduler.
    const schedule = (callback: () => void): number => (
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (setTimeout(callback, 16) as unknown as number)
    )
    const cancel = (handle: number): void => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
      else clearTimeout(handle)
    }
    let frame = schedule(function tick(): void {
      const goal = landingGoalRef.current
      if (goal === undefined) return
      const body = bodyRef.current
      if (body !== null && !previewActive) {
        // Through the ref: the heights this place is measured against are the ones that stand NOW, not the
        // ones the loop was started with (see `landingTargetRef`).
        const wanted = landingTargetRef.current(goal)
        // The place is what is kept true, not the offset that stood for it when it was first written: a
        // thread that grew, a wrapped row that got taller or a pane that reached its real size all move
        // it, and each of those turns an exact landing into one a few rows out.
        if (Math.abs(body.scrollTop - wanted) >= 1) {
          applyScrollTop(body, Math.max(0, Math.min(wanted, body.scrollHeight - body.clientHeight)))
        }
      }
      if (Date.now() >= goal.until) {
        landingGoalRef.current = undefined
        return
      }
      frame = schedule(tick)
    })
    return () => { cancel(frame) }
  }, [landingVerify])

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

  /**
   * Go to a line of the file as it reads NOW: the row carrying that new-file line, because the old side
   * of the diff is not a place a reader can be sent (its numbers belong to text that is already gone) —
   * a number that only exists there is answered with a note instead. Both views take it the way a comment
   * jump does: the split view through its own handle, one column through the height table, with the
   * configured lead rows above it and the block it lands in flashed.
   */
  const gotoLine = (line: number): void => {
    const row = model.diff.rows.findIndex(entry => entry.newLine === line)
    if (row === -1) {
      onToast(t('panel.gotoMissing', { line }))
      return
    }
    if (splitView && !previewActive) {
      splitDiffRef.current?.land(row, false, true)
      return
    }
    // Order matters: a block flash clears the row the previous go-to-line framed, so this sets it
    // AFTER asking for the flash.
    bumpFlash(false)
    flashRowRef.current = row
    setFocus(blockIndexAtOffset(offsetOf(row)))
    const body = bodyRef.current
    if (body === null) return
    applyScrollTop(body, Math.max(0, Math.min(offsetOf(row) - leadRows * ROW_HEIGHT_PX, body.scrollHeight - body.clientHeight)))
  }

  // The configured go-to-line chord opens the dialog, unless a text field (or the file picker) already
  // has those keys. Capture on the window and preventDefault, the way the comment chord does: Ctrl+G is
  // the browser's own find-again, and this panel is where the reader means it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesShortcut(event, keybindingOf('goto'))) return
      if (isTextFieldEvent(event) || pathPickerOpen()) return
      event.preventDefault()
      setGotoDraft('')
      setGotoOpen(true)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  /**
   * The popup's one answer. Enter and the 确定 button both run this, so the key and the press are literally
   * the same action: the number is read, the popup closes, and a number the current side does not have is
   * answered with a note instead of a jump (see `gotoLine`).
   */
  const submitGoto = (): void => {
    const line = Number.parseInt(gotoDraft.trim(), 10)
    setGotoOpen(false)
    if (Number.isFinite(line) && line > 0) gotoLine(line)
  }

  /**
   * The go-to popup, centred on the code view: the layer fills that view's own box (the single column's
   * wrapper, or the side-by-side view's root, which is why it is handed to `SplitDiff` there), and the
   * parts wear the search bar's recipe (see `.gotoBox` / `.gotoInput`). Side by side there are two code
   * boxes rather than one, and the one being read is the right pane: the layer is cut back to that half
   * (`splitView`, see `.gotoLayerRight`), which is what `data-diff-goto-pane` records for the tests. A
   * press anywhere dismisses it — the layer catches the presses inside the code view, the full-window
   * catcher the rest — while the bar itself stops them. Escape, Cancel and focus leaving the popup leave
   * everything as it was.
   */
  const gotoDialog = !gotoOpen || previewActive ? null : (
    <>
      <div className={css.gotoBackdrop} data-diff-goto-backdrop aria-hidden="true" onClick={() => { setGotoOpen(false) }} />
      <div
        className={`${css.gotoLayer}${splitView ? ` ${css.gotoLayerRight}` : ''}`}
        data-diff-goto-layer
        data-diff-goto-pane={splitView ? 'right' : 'code'}
        onClick={() => { setGotoOpen(false) }}
      >
        <div
          role="dialog"
          aria-label={t('action.goto')}
          data-diff-goto-dialog
          className={css.gotoBox}
          onClick={(event) => { event.stopPropagation() }}
          // Focus leaving the popup closes it — that is the reader pressing somewhere that takes focus, or
          // tabbing out — while a move to its own buttons is not leaving: they have to stay clickable.
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
            setGotoOpen(false)
          }}
        >
          <input
            className={css.gotoInput}
            data-diff-goto-input
            value={gotoDraft}
            autoFocus
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            aria-label={t('action.goto')}
            placeholder={t('action.goto')}
            onChange={(event) => { setGotoDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setGotoOpen(false)
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              submitGoto()
            }}
          />
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary} ${css.gotoAction}`}
            data-diff-goto-go
            onClick={submitGoto}
          >
            {t('action.gotoGo')}
          </button>
          <button
            type="button"
            className={`${css.action} ${css.gotoAction}`}
            data-diff-goto-cancel
            onClick={() => { setGotoOpen(false) }}
          >
            {t('action.gotoCancel')}
          </button>
        </div>
      </div>
    </>
  )

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

  // The diff as the CONTINUATION below has to read it. A block action takes the operated blocks out of
  // the list, and the panel is re-rendered with the shorter diff before that action's promise settles
  // (the store re-reads the list before it resolves) — so the count this handler was created with is the
  // pre-action one, and "is there a change after the operated slot?" is a question about the diff that
  // exists NOW.
  const blockCountRef = useRef(0)
  blockCountRef.current = model.blocks.length

  // Run one block (or combined multi-block) keep/revert, then advance focus to
  // the next change block: the operated block(s) leave the list, so the next
  // block shifts into the `operated` slot, and focusing that slot recenters and
  // flashes the following change. Shared by the hover frame and the selection
  // frame so the two stay aligned; an operated range that reached the end of the
  // diff wraps to the first block (see `blockAfterAction`).
  const runBlockAction = async (action: 'keep' | 'revert', range: DiffApprovalBlockRange, operated: number): Promise<void> => {
    await (action === 'keep'
      ? onBlockKeep(sessionId, file.id, range)
      : onBlockRevert(sessionId, file.id, range))
    const count = blockCountRef.current
    if (count === 0) return
    const next = blockAfterAction(operated, count)
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

  /**
   * The change block the view is in at one scroll offset: the last block at or
   * above the offset, i.e. the same anchor `onScroll` re-focuses from. Used when
   * a resumed view starts away from the first change, so prev/next walk from the
   * block the reader was actually in.
   * @param offset - a code view scrollTop.
   * @returns the block index; 0 when the offset is above every change.
   */
  const blockIndexAtOffset = (offset: number): number => {
    const anchor = offset + leadRows * ROW_HEIGHT_PX
    let found = 0
    for (let index = 0; index < model.blocks.length; index++) {
      const block = model.blocks[index]
      if (block !== undefined && offsetOf(block.start) <= anchor + NAV_ANCHOR_TOLERANCE_PX) found = index
    }
    return found
  }

  // The code an outdated thread quotes pans with the code it came from: a quoted line is its own
  // clipped box (see `.quoteNoWrap .quoteText`), so writing the body's horizontal offset into it
  // keeps the same columns in the quote as in the file under it. It rides the body's own scroll
  // handler rather than a listener of its own because the scroller is not always the same element
  // (the split view has none, and a reader can switch views), while this handler is on whichever
  // one is up. One write per quoted line and no layout read — the same imperative sync the split
  // view's pinned strips use — so the block stays out of React's render loop while the reader
  // drags the code sideways.
  const syncQuoteScroll = useCallback((body: HTMLElement | null): void => {
    if (body === null) return
    for (const text of body.querySelectorAll<HTMLElement>('[data-diff-quote-text]')) {
      text.scrollLeft = body.scrollLeft
    }
  }, [])

  const onScroll = () => {
    const body = bodyRef.current
    if (body === null) return
    // The panel's own write raises a scroll event too (see `selfScrollRef`): only a scroll that lands
    // somewhere the panel did NOT put the view is the reader taking over, and only that abandons a landing
    // still being kept true (see `landingGoalRef`) — anything else would cancel a jump's own correction.
    const written = selfScrollRef.current
    selfScrollRef.current = undefined
    if (written === undefined || Math.abs(body.scrollTop - written) >= 1) {
      landingGoalRef.current = undefined
      landingPendingRef.current = false
    }
    syncQuoteScroll(body)
    // The reader's place in this file, recorded as they read it rather than only on the way out: a
    // pane that remounts under them (a poll that lost the entry for a moment, a presentation
    // switch) resumes it, so the code changing under the reader cannot move them (see the landing
    // effect). This is the offset the panel would have remembered on closing — just kept current.
    rememberPanelView(sessionId, { fileId: file.id, scrollTop: body.scrollTop })
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

  // Comment mode changed elsewhere (the Settings section is a different mount): re-read it,
  // so a switch flipped there reaches the frame without waiting for the next open.
  useEffect(() => {
    const onCommentMode = (): void => { setCommentMode(commentModeEnabled()) }
    window.addEventListener(COMMENT_MODE_CHANGED_EVENT, onCommentMode)
    return () => { window.removeEventListener(COMMENT_MODE_CHANGED_EVENT, onCommentMode) }
  }, [])

  /**
   * One thread's card, as every view draws it. The views differ only in where the card hangs and
   * how wide the thing it hangs in is, so the card itself is built in exactly one place (see
   * `DiscussionBlock`): the single-column row stream, and whatever view comes next.
   */
  const renderDiscussion = useCallback((discussion: Discussion, width: number, split: boolean): ReactNode => (
    <DiscussionBlock
      discussion={discussion}
      label={discussionLineRange(discussion)}
      bodyWidth={width}
      lang={lang}
      menuOpen={discussionMenuFor === discussion.id}
      asking={discussion.asking === true}
      split={split}
      t={t}
      onToggle={toggleDiscussion}
      onMenuOpen={setDiscussionMenuFor}
      onRemove={removeDiscussion}
      onDraft={(id, value) => {
        // A placed-but-unsent block keeps its words on the placement itself — there is no comment id
        // yet to hang them under — and a stored comment keeps them in the per-comment state. One
        // home either way, so a poll and a remount both see the same text.
        if (draftThreads.some(thread => thread.id === id)) {
          setDraftThreads(current => current.map(thread => (thread.id === id ? { ...thread, draft: value } : thread)))
          return
        }
        patchThreads({ [id]: { draft: value } })
      }}
      onSend={sendDiscussion}
      // Only a STORED thread has a dot to clear: a block the reader placed but has not written yet is
      // not the host's record, so there is nothing on the host to tell.
      onSeen={discussion.unseen === true && fileComments.some(record => record.id === discussion.id)
        ? () => { onCommentSeen?.(sessionId, discussion.id) }
        : undefined}
      registerInput={(id, element) => {
        if (element === null) discussionInputEls.current.delete(id)
        else discussionInputEls.current.set(id, element)
      }}
    />
  // The card is given its width as an ARGUMENT (`renderDiscussion(discussion, bodyWidth)`), so this
  // callback reads nothing but the menu, the question in flight, where the reader's words go, and which
  // of the threads on screen the host is holding (only those have a dot to clear).
  ), [discussionMenuFor, t, lang, toggleDiscussion, removeDiscussion, sendDiscussion, discussionLineRange, patchThreads, draftThreads, fileComments, onCommentSeen])

  /**
   * The lines a selection names, whichever view made it, or undefined when it names none this panel
   * can comment on — a side-by-side selection of the LEFT column is the old file, and a thread is
   * anchored to new-file lines. The frame (and the chord) hang off this, so the left column simply
   * offers nothing.
   */
  const selectionRowRange = selectionRows(selection)
  /**
   * Whether those lines already carry a thread: the comment is withheld then (a row belongs to one
   * annotation at most).
   */
  const selectionHasDiscussion = selectionRowRange !== undefined
    && discussionOverlapping(discussions, selectionRowRange) !== undefined

  // What the frame offers for the current selection (see `selectionFrame`), with comment
  // mode applied: an OFF mode withholds the comment action but not the frame, so a range
  // over change blocks still offers keep/revert. A range whose only action would have been
  // the comment then has no frame at all — which is also what keeps the chord below off.
  const frameForSelection = selectionRowRange !== undefined
    ? selectionFrame({
        // Keep/revert are the change blocks' own frames, and only the single-column view anchors a
        // selection to them (see `selectionRange`); the comment is offered wherever a range reads as
        // the current file's lines, which the side-by-side view's right column does too.
        coversBlocks: !splitView && selectionRange !== undefined,
        hasDiscussion: selectionHasDiscussion,
      })
    : undefined
  const selectionCommentOffered = commentMode && frameForSelection?.comment === true
  const selectionFrameVisible = frameForSelection !== undefined
    && (frameForSelection.keepRevert || selectionCommentOffered)
  // The comment chord, as the button prints it (that frame cannot carry a tooltip — see the
  // render). Read at render rather than cached, so a rebind in Settings shows on the next
  // selection, and empty when the action has been left unbound, so no hint is drawn at all.
  const commentChord = chordLabel('addComment')

  // Ctrl/Cmd+K comments on the selection - but only while the button that does it is on
  // screen: the chord is bound to the affordance, so it can never start a comment the
  // user had no way to click. Window capture with `preventDefault`, because Ctrl+K is the
  // browser's own address-bar search on the page; the chat composer and the panel's own
  // text fields keep their keys, and the file-picker dialog is a modal this panel owns.
  useEffect(() => {
    if (!selectionCommentOffered) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, keybindingOf('addComment'))) return
      if (isTextFieldEvent(event) || pathPickerOpen()) return
      event.preventDefault()
      addDiscussionRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [selectionCommentOffered])

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
  // A go-to-line frames the ROW it landed on rather than the change block around it: the reader named a
  // line, not a change (see `gotoLine`). Everything else keeps the block's own box.
  const flashRow = flashRowRef.current
  const flashTop = flashRow !== undefined
    ? Math.max(0, offsetOf(flashRow) - scrollTop)
    : focusedBlock === undefined
      ? 0
      : Math.max(0, offsetOf(focusedBlock.start) - scrollTop)
  const flashBottom = flashRow !== undefined
    ? Math.min(viewportHeight > 0 ? viewportHeight : Number.POSITIVE_INFINITY, offsetOf(flashRow + 1) - scrollTop)
    : focusedBlock === undefined
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
      <Tooltip label={hintCase.label} shortcutKeys={hintCase.shortcutKeys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={search.caseSensitive ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
          data-diff-search-case
          data-on={search.caseSensitive ? '' : undefined}
          aria-label={t('action.matchCase')}
          aria-keyshortcuts={hintCase.aria}
          aria-pressed={search.caseSensitive}
          onClick={() => { andRefocus(() => { search.toggleCase() }) }}
        >
          <SearchOptionIcon kind="case" />
        </button>
      </Tooltip>
      <Tooltip label={hintWords.label} shortcutKeys={hintWords.shortcutKeys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={search.wholeWord ? `${css.searchToggle} ${css.searchToggleOn}` : css.searchToggle}
          data-diff-search-word
          data-on={search.wholeWord ? '' : undefined}
          aria-label={t('action.matchWholeWord')}
          aria-keyshortcuts={hintWords.aria}
          aria-pressed={search.wholeWord}
          onClick={() => { andRefocus(() => { search.toggleWord() }) }}
        >
          <SearchOptionIcon kind="word" />
        </button>
      </Tooltip>
      <Tooltip label={hintPrev.label} shortcutKeys={hintPrev.shortcutKeys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-search-prev
          aria-label={t('action.prevDiff')}
          aria-keyshortcuts={hintPrev.aria}
          disabled={searchMatchCount === 0}
          onClick={() => { andRefocus(() => { goSearch(-1) }) }}
        >
          <IconChevronUpOutline14 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={hintNext.label} shortcutKeys={hintNext.shortcutKeys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-search-next
          aria-label={t('action.nextDiff')}
          aria-keyshortcuts={hintNext.aria}
          disabled={searchMatchCount === 0}
          onClick={() => { andRefocus(() => { goSearch(1) }) }}
        >
          <IconChevronDownOutline14 size={14} />
        </button>
      </Tooltip>
      <Tooltip label={hintClose.label} shortcutKeys={hintClose.shortcutKeys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-search-close
          aria-label={t('action.close')}
          aria-keyshortcuts={hintClose.aria}
          onClick={closeSearch}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </Tooltip>
    </div>
  ) : null

  const frameAnchorEnd = selectionFrameVisible ? selectionBlockEnd : hoveredBlockEnd
  // The anchor in the scroller's CONTENT coordinates: the row's bottom edge, less the 2px
  // that tuck the frame against it. The frame's POSITION is not written from here — see
  // the follow animation below — only this row-anchored number is.
  const frameAnchorTop = frameAnchorEnd === undefined ? 0 : offsetOf(frameAnchorEnd + 1) - 2
  const frameLimit = Math.max(0, viewportHeight - BLOCK_ACTIONS_FRAME_PX)
  // With scroll-driven animations the browser owns the frame's position: it interpolates
  // the clamp over the scroll range off the main thread, so the frame cannot trail the
  // code the compositor has already moved. Without them the same clamp is evaluated here,
  // from the render that `setScrollTop` schedules — a frame late, but correct. The range
  // is the row model's own height (the scroller has no padding or border), so it needs no
  // measurement and follows a discussion that just reserved rows.
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  // A scroller with nothing to scroll cannot drive the animation at all (its timeline is
  // inactive), so the render places the frame instead; with no range, that clamp is exact.
  const frameFollowsScroll = frameFollowIsAnimated(typeof ScrollTimeline !== 'undefined', viewportHeight, maxScroll)
  const frameTop = frameFollowsScroll ? 0 : Math.max(0, Math.min(frameAnchorTop - scrollTop, frameLimit))

  // Start (and restart) the follow animation whenever what it maps changes: the anchor,
  // the scrollable range, the box it is clamped into, or which of the two frames is up.
  // `fill: both` so the frame is already in place before the first scroll, and a layout
  // effect because until the animation exists the frame would sit at the wrapper's top
  // edge — a one-frame flash at the wrong end of the screen.
  useLayoutEffect(() => {
    const element = frameRef.current
    const body = bodyRef.current
    if (!frameFollowsScroll || frameAnchorEnd === undefined || element === null || body === null) return
    const keyframes = frameFollowKeyframes(frameAnchorTop, maxScroll, viewportHeight, BLOCK_ACTIONS_FRAME_PX)
      .map(stop => ({ offset: stop.offset, transform: `translateY(${stop.y}px)` }))
    const animation = element.animate(keyframes, { duration: 1000, fill: 'both' })
    // Reading the scroll offset is the browser's job now: the animation's clock IS the
    // scroller's scroll progress, on the compositor.
    animation.timeline = new ScrollTimeline({ source: body })
    return () => { animation.cancel() }
  }, [frameFollowsScroll, frameAnchorEnd, frameAnchorTop, maxScroll, viewportHeight])

  // The diff toolbar's left group gives way before its decisions do: whichever buttons the row
  // cannot hold are moved into one overflow menu rather than wrapped or clipped. Their widths are
  // measured, not assumed — each is a chip whose width follows its glyph — and remembered by key,
  // because a button that has moved into the menu is no longer in the DOM when the panel grows
  // again and still has to be able to come back.
  const actionGroupRef = useRef<HTMLDivElement | null>(null)
  const actionStatsRef = useRef<HTMLSpanElement | null>(null)
  const actionRefs = useRef(new Map<string, HTMLElement>())
  const actionWidths = useRef(new Map<string, number>())
  const [inlineActions, setInlineActions] = useState(Number.MAX_SAFE_INTEGER)
  const [moreOpen, setMoreOpen] = useState(false)
  const rememberActionWidth = (key: string, element: HTMLElement | null): void => {
    if (element === null) actionRefs.current.delete(key)
    else actionRefs.current.set(key, element)
  }

  // The group in the order it draws them: the jump pair (only for a file with changes to jump
  // between), search, go-to, then the view toggles and the version-control reset. Each button's
  // tooltip is also its row's title in the overflow menu, so a control that has moved into the
  // menu is named exactly as its own button names it — its chord included.
  const toolbarItems: DiffToolbarItem[] = []
  if (model.blocks.length > 0) {
    toolbarItems.push(
      {
        kind: 'button', key: 'prev', data: { 'data-diff-prev': '' }, disabled: busy,
        label: t('action.prevDiff'), hint: withChord(t('action.prevDiff'), 'jumpUp'), shortcut: 'jumpUp', icon: <IconChevronUpOutline14 size={14} />,
        onSelect: () => { jumpBlock(-1, true) },
      },
      {
        kind: 'button', key: 'next', data: { 'data-diff-next': '' }, disabled: busy,
        label: t('action.nextDiff'), hint: withChord(t('action.nextDiff'), 'jumpDown'), shortcut: 'jumpDown', icon: <IconChevronDownOutline14 size={14} />,
        onSelect: () => { jumpBlock(1, true) },
      },
    )
  }
  toolbarItems.push({
    kind: 'button', key: 'search', data: { 'data-diff-search-toggle': '' },
    label: t('action.search'), hint: withChord(t('action.search'), 'openSearch'), shortcut: 'openSearch', icon: <IconSearchOutline16 size={14} />,
    onSelect: toggleSearch,
  })
  if (!previewActive) {
    // The button only asks; the popup itself is rendered by the code view it belongs to (see
    // `gotoDialog`), so it can be centred on that view's own box.
    toolbarItems.push({
      kind: 'button', key: 'goto', data: { 'data-diff-goto': '' },
      label: t('action.goto'), hint: withChord(t('action.goto'), 'goto'), shortcut: 'goto', icon: <GotoLineIcon />,
      onSelect: () => { setGotoDraft(''); setGotoOpen(true) },
    })
  }
  toolbarItems.push({ kind: 'divider', key: 'viewDivider' })
  toolbarItems.push({
    kind: 'button', key: 'splitView', data: { 'data-diff-toggle-view': '' },
    label: t(splitView ? 'action.viewUnified' : 'action.viewSplit'), icon: <ViewModeIcon split={splitView} />,
    onSelect: toggleSplitView,
  })
  if (lang === 'markdown') {
    toolbarItems.push({
      kind: 'button', key: 'mdPreview', data: { 'data-diff-md-preview': '' },
      label: t(mdPreview ? 'action.viewSource' : 'action.viewPreview'), icon: <MarkdownModeIcon preview={mdPreview} />,
      onSelect: () => {
        const next = !mdPreview
        setMdPreview(next)
        setMdPreviewEnabled(next)
      },
    })
  }
  toolbarItems.push({
    kind: 'button', key: 'refreshVcs', data: { 'data-diff-refresh-vcs': '' }, disabled: busy,
    label: t('action.refreshVcs'), icon: <IconRefreshOutline16 size={14} />,
    onSelect: () => { onRefreshVcs(file) },
  })

  const inlineToolbarItems = toolbarItems.slice(0, inlineActions)
  const hiddenToolbarItems = toolbarItems.slice(inlineActions).flatMap(item => item.kind === 'button' ? [item] : [])
  const hiddenToolbarMenu: MenuEntry[] = hiddenToolbarItems.map(item => (
    {
      id: item.key,
      label: item.hint ?? item.label,
      icon: item.icon,
      ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
    }
  ))
  const showStats = model.diff.added !== 0 || model.diff.removed !== 0

  // Only the item KEYS and the stats' presence are dependencies: a label or a glyph can change
  // (a toggle names its other state) without moving a single width, and the observer below covers
  // the panel being dragged wider or narrower — which is also what makes the decisions' own width
  // count, since a one-button decision row leaves this group more of the row than a two-button one.
  // A layout effect, so the first painted frame is already the settled one.
  const toolbarMeasureKey = `${toolbarItems.map(item => item.key).join(' ')}|${showStats ? 'stats' : ''}`
  useLayoutEffect(() => {
    const group = actionGroupRef.current
    if (group === null) return
    const measure = (): void => {
      // A box with no width is a document with no layout (the test environment): every button is
      // drawn and no measurement is claimed.
      if (group.clientWidth === 0) {
        setInlineActions(toolbarItems.length)
        return
      }
      for (const item of toolbarItems) {
        const element = actionRefs.current.get(item.key)
        if (element !== undefined) actionWidths.current.set(item.key, element.offsetWidth)
      }
      // The stats are the group's fixed prefix, so the room the buttons have is what is left of it.
      const stats = actionStatsRef.current?.offsetWidth ?? 0
      const budget = Math.max(0, group.clientWidth - (stats === 0 ? 0 : stats + TOOLBAR_ITEM_GAP_PX))
      const overflow = actionRefs.current.get('more')?.offsetWidth || TOOLBAR_OVERFLOW_PX
      let count = inlineItemCount(toolbarItems.map(item => actionWidths.current.get(item.key) ?? 0), budget, TOOLBAR_ITEM_GAP_PX, overflow)
      // A hairline is not a control: the row never ends with one.
      if (count > 0 && toolbarItems[count - 1]?.kind === 'divider') count -= 1
      setInlineActions(count)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    return () => { observer.disconnect() }
  }, [toolbarMeasureKey, inlineActions])

  // A quote can also arrive under code that is already scrolled sideways — a thread that has just
  // gone outdated, one revealed further down the file — so it catches up after every commit that
  // could have drawn one, before the reader could see it at the wrong column.
  useLayoutEffect(() => { syncQuoteScroll(bodyRef.current) })

  return (
    <div
      className={css.diff}
      data-diff-approval-diff
      style={diffViewVars as unknown as CSSProperties}
    >
      <div className={css.diffHeader} data-diff-toolbar>
        {/* The full path, in place and editable: typing another one opens that file (adding it
            to the list first when it is not listed yet), and anything that cannot be opened puts
            the shown path back. The field is its own scroller — the caret drags it along — so
            the row no longer needs any scroll treatment of its own. */}
        <input
          className={css.diffPath}
          data-diff-path-input
          type="text"
          value={pathDraft ?? file.path}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('action.pathField')}
          onChange={(event) => { setPathDraft(event.target.value) }}
          onBlur={() => { setPathDraft(null) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              const typed = (pathDraft ?? '').trim()
              if (typed === '' || typed === file.path) { setPathDraft(null); return }
              // Either way the draft goes: a file that opened shows its own path, one that was
              // refused says why in a toast and leaves the path that was showing.
              void onAddTypedPath(typed).then((result) => {
                setPathDraft(null)
                // Opening is the panel's own event, not this view's state: the overlay and the
                // docked tab follow the same one, and the landing is a file's first change —
                // the file already listed included, which is what typing its path asks for.
                if (result?.openPath === undefined) return
                window.dispatchEvent(new CustomEvent<PanelFileDetail>(
                  OPEN_PANEL_FILE_EVENT, { detail: { fileId: result.openPath } }))
              })
            } else if (event.key === 'Escape') {
              // Escape is this field's own: it puts the path back and leaves the field, rather
              // than closing the whole review (see the panel's own Escape handler).
              event.preventDefault()
              setPathDraft(null)
              event.currentTarget.blur()
            }
          }}
        />
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
        <div className={css.diffActionInfo} data-diff-actions ref={actionGroupRef}>
          {showStats && (
            <span className={css.diffStats} ref={actionStatsRef}>{t('panel.stats', { added: model.diff.added, removed: model.diff.removed })}</span>
          )}
          {/* Drawn while they fit; the rest are the overflow menu below. The stats above are the
              group's fixed prefix — the summary of the diff is not something to hide behind `⋯`. */}
          {inlineToolbarItems.map(item => {
            if (item.kind === 'divider') {
              return (
                <Fragment key={item.key}>
                  <span className={css.divider} ref={(element) => { rememberActionWidth(item.key, element) }} />
                </Fragment>
              )
            }
            // One decision per item (see `chords.ts`): this host's keycaps where it can draw them, the
            // pre-0.1.7-rc.2 glued label where it cannot, and the same chord in aria either way.
            const tip = actionTooltip(item.label, item.shortcut)
            return (
              <Fragment key={item.key}>
                <Tooltip label={tip.label} shortcutKeys={tip.shortcutKeys} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    ref={(element) => { rememberActionWidth(item.key, element) }}
                    className={`${css.action} ${css.iconAction}`}
                    {...item.data}
                    aria-label={item.label}
                    aria-keyshortcuts={tip.aria}
                    disabled={item.disabled}
                    onClick={item.onSelect}
                  >
                    {item.icon}
                  </button>
                </Tooltip>
              </Fragment>
            )
          })}
          {/* What did not fit, in the order it would have been drawn. Portaled like the language
              picker, so the list is not cropped by the group it hangs off. */}
          {hiddenToolbarItems.length > 0 && (
            <Menu
              open={moreOpen}
              portal
              compact
              align="end"
              items={hiddenToolbarMenu}
              onSelect={(id) => {
                setMoreOpen(false)
                hiddenToolbarItems.find(item => item.key === id)?.onSelect()
              }}
              onClose={() => { setMoreOpen(false) }}
              anchor={(
                <Tooltip label={t('action.more')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    ref={(element) => { rememberActionWidth('more', element) }}
                    className={`${css.action} ${css.iconAction}`}
                    data-diff-actions-more
                    aria-label={t('action.more')}
                    onClick={() => { setMoreOpen(value => !value) }}
                  >
                    <IconEllipsisOutline16 size={14} />
                  </button>
                </Tooltip>
              )}
            />
          )}
        </div>
        <div className={css.diffActionDecisions}>
        {/* A row whose content already matches the baseline has nothing left to accept or put back, so the
            pair collapses into the one decision still open on it: whether it stays in the list. 移出 is a
            keep — the host folds the (identical) content and drops the entry — which leaves the file itself
            exactly as it is. The row menu and the bulk footer ask the same question of the same helper
            (`fileHasNoDiff`), so the three surfaces cannot disagree. */}
        {fileHasNoDiff(file) ? (
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary} ${css.actionQuietDisabled}`}
            data-diff-remove
            disabled={busy}
            onClick={() => { void onKeep(sessionId, file.id, false) }}
          >
            {t('row.dismiss')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`${css.action} ${css.actionPrimary} ${css.actionQuietDisabled}`}
              data-diff-keep
              disabled={busy}
              onClick={() => { void onKeep(sessionId, file.id) }}
            >
              {t('action.keep')}
            </button>
            <button
              type="button"
              className={`${css.action} ${css.actionQuietDisabled}`}
              data-diff-revert
              disabled={busy}
              onClick={() => { void onRevert(sessionId, file.id) }}
            >
              {file.earlierVersion === 'none' ? t('action.delete') : t('action.revert')}
            </button>
          </>
        )}
        </div>
      </div>
      {failedMessage !== undefined && <p className={css.actionError} data-diff-action-error>{failedMessage}</p>}
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
          sessionId={sessionId}
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
          discussions={laidDiscussions}
          renderDiscussion={renderDiscussion}
          rulerRuns={rulerMarkers}
          gotoDialog={gotoDialog}
          // A range in either half offers the comment; keep/revert stay with the change blocks' own
          // frames here (see `frameForSelection`).
          selectionComment={splitView && selectionCommentOffered ? (
            <button
              type="button"
              className={css.action}
              data-diff-selection-comment
              onClick={addDiscussion}
            >
              {t('action.comment')}
              {commentChord !== '' && (
                <span className={css.actionChord} data-diff-selection-comment-chord>{commentChord}</span>
              )}
            </button>
          ) : undefined}
        />
      ) : (
      <div className={css.diffBodyWrap} ref={bodyWrapRef} onMouseLeave={() => { setHoveredBlock(undefined) }}>
        <div
          className={css.diffBody}
          ref={bodyRef}
          tabIndex={0}
          onScroll={onScroll}
          // The quote pans with this scroller (see `syncQuoteScroll`), so its own scroller is given
          // the width the file's widest line has: a narrower one clamps the pan and the quoted
          // columns drift out of alignment for the rest of the file's horizontal range.
          style={{ tabSize: tabWidthSpaces, '--dsh-diff-quote-width': `${widestLine}ch` } as CSSProperties}
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
              const blocks = discussionsAtRow.get(index) ?? []
              return (
                <Fragment key={index}>
                  <DiffRow
                    index={index}
                    row={row}
                    runs={runs}
                    focused={inFocusedBlock(index)}
                    discussed={discussedRows.has(index)}
                    searchHit={searchHitSet.has(index)}
                    searchCurrent={index === currentSearchRow}
                    searchQuery={searchQuery}
                    searchOptions={search.options}
                    onRowHover={onRowHover}
                    wrappedLines={rowWrapped?.[index]}
                  />
                  {/* A discussion block hangs in a row of its own, right below the rows
                      it annotates. The DOM has to carry the reserved rows, and being in
                      the row stream is what lets the browser scroll the block with the
                      code on both axes - natively, on the compositor (see
                      `.discussionRow` and `.discussionPin`). */}
                  {blocks.map(discussion => {
                    const rows = discussionRows(discussion)
                    return (
                      <div
                        key={discussion.id}
                        className={css.discussionRow}
                        data-diff-discussion-space={rows}
                        style={{ height: rows * THREAD_ROW_PX }}
                      >
                        <div className={css.gutter} aria-hidden="true" />
                        <div className={css.gutter} aria-hidden="true" />
                        <div className={css.discussionCell}>
                          {/* Zero-width, so it never widens the code column (`max-content`
                              sizing); sticky, so the block keeps the panel's left edge while
                              the code slides sideways; the negative gutter margin starts it at
                              the table's left edge instead of the code column's. */}
                          <div className={css.discussionPin} style={{ marginLeft: -WRAP_GUTTERS_PX }}>
                            {renderDiscussion(discussion, bodyWidth, false)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </Fragment>
              )
            })}
            {end < rowCount && (
              <div className={css.vSpacer} style={{ height: totalHeight - offsetOf(end) }} aria-hidden="true" />
            )}
          </div>
        </div>
        {selectionFrameVisible ? (
          <div
            ref={frameRef}
            className={css.blockActions}
            data-diff-selection-actions
            style={{ top: frameTop }}
          >
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary}`}
            data-diff-selection-keep
            hidden={selectionRange === undefined}
            disabled={busy}
            onClick={() => { void handleSelectionAction('keep') }}
          >
            {t('action.keep')}
          </button>
          <button
            type="button"
            className={css.action}
            data-diff-selection-revert
            hidden={selectionRange === undefined}
            disabled={busy}
            onClick={() => { void handleSelectionAction('revert') }}
          >
            {t('action.revert')}
          </button>
          {/* The frame holds two groups: what may be kept or reverted on the
              covered change blocks, and the comment on the range. The hairline
              appears only when both are there - keep/revert are hidden over a
              range with no covered blocks (their `hidden` attribute takes them
              out of the layout), the comment group is missing while comment mode
              is off, and a divider with nothing on one side of it would read as a
              rendering fault. */}
          {selectionRange !== undefined && selectionCommentOffered && (
            <span className={css.blockActionsDivider} data-diff-selection-divider aria-hidden="true" />
          )}
          {/* Offered when the range has no discussion yet and comment mode is on
              (`selectionFrame`, plus the mode): a range without change blocks can
              still be discussed, and a range that already has one gets no second.
              Its chord is printed on the label rather than shown as a tooltip: this frame is
              moved by a scroll-driven transform (see `frameFollowKeyframes`), and a
              transformed element is the containing block for the kit's `position: fixed`
              bubble, so a tooltip here would land wherever that transform puts it instead of
              beside the button. */}
          {selectionCommentOffered && (
            <button
              type="button"
              className={css.action}
              data-diff-selection-comment
              onClick={addDiscussion}
            >
              {t('action.comment')}
              {commentChord !== '' && (
                <span className={css.actionChord} data-diff-selection-comment-chord>{commentChord}</span>
              )}
            </button>
          )}
          </div>
        ) : hoveredBlock !== undefined && model.blocks[hoveredBlock] !== undefined ? (
          <div
            ref={frameRef}
            className={css.blockActions}
            data-diff-block-actions
            style={{ top: frameTop }}
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
        {/* The go-to popup, centred on the code view it belongs to (see `gotoDialog`). */}
        {gotoDialog}
        {rulerMarkers.length > 0 && (
          <div
            className={css.overviewRuler}
            data-diff-approval-ruler
            aria-hidden="true"
            style={{ bottom: hScrollbarPx }}
          >
            {rulerMarkersNow.map((marker, index) => (
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
          <Tooltip label={copied ? t('action.copied') : hintCopy.label} shortcutKeys={copied ? undefined : hintCopy.shortcutKeys} side="top" delayMs={300}>
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
              aria-keyshortcuts={copied ? undefined : hintCopy.aria}
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
  wide, useSessions, sessionId, usePending, pendingView, showing = true, onRefresh, onMarkSeen, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen, onPreviewImage, onPasteReference, onCommentAdd, onCommentRemove, onCommentRemoveMany, onCommentAsk, onCommentSeen, onUndo, onRedo, onImportVcs, onRefreshVcs, onBrowse, onAddPath, onKeepAll, onKeepMany, onRevertMany, onAckRedoCleared, onAckUndoNotice, collapseSidebar, t,
  docked = false, dockHost, onOpenDock, closeDock, useDock,
}: PendingPanelProps) {
  // The two tooltips that name a way out of the panel, decided once (see `chords.ts`): this host's
  // keycaps where it can draw them, the pre-0.1.7-rc.2 glued label where it cannot.
  const closeTip = closeTooltip(t)
  const summonTip = summonTooltip(t)
  const storeSelected = useSessions(state => selectedSessionOf(state))
  // The session this panel is about: what the shell composed (session-scoped seats), else the store's
  // own selection (shells that keep it there), else what the header entry published — 0.1.7 hands the
  // root-scoped footer slot nothing but `wide`, so the header's answer is the only one there is. That
  // answer is read as a subscribed value, because the header publishes it from an effect: a plain read
  // here would keep whatever it was on this mount's first render and never follow a session switch.
  const published = usePublishedSessionId()
  const current = sessionId ?? storeSelected ?? published
  // A newly created session is selected but still blank (no messages yet); it
  // has nothing to review, so the entry is grayed out exactly like no session.
  const currentBlank = useSessions(state => sessionIsBlank(state, sessionId ?? selectedSessionOf(state)))
  const noSession = current === undefined || currentBlank
  /**
   * The list this seat draws: THIS session's own view, never another session's.
   *
   * The page-wide snapshot (`usePending`) stays subscribed as the fallback for a face that offers no
   * per-session view and as the source of the change signal that re-renders this seat; what the panel
   * reads is `current`'s slot, so a poll another seat runs for another session cannot put its files
   * under this badge.
   */
  const pageWide = usePending(snapshot => snapshot)
  const snapshot = useSessionView(pendingView, current, pageWide)
  // Whether the panel is showing in the right sidebar's tab right now (absent
  // hook: this build has no right sidebar). The face is fixed per mount, so the
  // optional hook never appears mid-life: the call order stays stable.
  const dockShowing = useDock?.((state: DockSnapshot) => state.open) === true
  // Whether this build has a right sidebar to dock into at all: the observable
  // exists from apply time and flips to available once the sidebar is attached.
  const dockAvailable = useDock?.((state: DockSnapshot) => state.available) === true
  /** Why the dock is unavailable, when it is (shown once, if asked for). */
  const dockReason = useDock?.((state: DockSnapshot) => state.reason) as string | undefined
  /** The dock's visibility as the latest render has it, for the reveal fallback's
   *  timer (which runs outside this render's closure). */
  const dockShowingRef = useRef(false)
  dockShowingRef.current = dockShowing
  /** The pending "did the dock actually come up" check, if any. */
  const revealTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (revealTimerRef.current !== undefined) window.clearTimeout(revealTimerRef.current)
  }, [])
  // A docked panel that un-docks asks this instance (the footer's) to show the
  // overlay: the two are separate mounts, and the stored presentation says which
  // one. A docked instance ignores it — it is the one that asked.
  const revealRef = useRef<() => void>(() => {})
  /** The header entry's toggle, deferred to the latest render (see `toggleOpen`):
   *  this instance owns the overlay's open state, and the entry is a second mount
   *  that can only ask. */
  const toggleRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (docked) return
    const onShow = (): void => { revealRef.current() }
    const onToggle = (): void => { toggleRef.current() }
    window.addEventListener(SHOW_PANEL_EVENT, onShow)
    window.addEventListener(TOGGLE_PANEL_EVENT, onToggle)
    return () => {
      window.removeEventListener(SHOW_PANEL_EVENT, onShow)
      window.removeEventListener(TOGGLE_PANEL_EVENT, onToggle)
    }
  }, [docked])
  // Rendering as the tab's body is itself the dock presentation: remember it, so
  // the footer entry brings the panel back here rather than floating it.
  useEffect(() => {
    if (docked) setPanelPresentation('dock')
  }, [docked])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  /**
   * A file the detail header's path field just added, waiting for it to show up in the list so it
   * can be selected. The add's own refresh lands a poll later, and a selection made to an id that
   * is not in the list yet would be replaced by the list's first row, so the id waits here.
   */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  /**
   * Where the diff should land for the file it is about to show, and a nonce so a
   * repeated request for the *same* file lands again. `top` carries the offset the
   * reader was left at when the panel resumes a view (see `panel-memory`); it is
   * absent when the request means "show me this diff" — a file picked from the
   * list, the advance a decision leaves behind, or the produced-file chip — and
   * that lands on the file's first change. `row`/`line` are the two ways a jump can
   * name a place: a model row (this panel's own jumps) and a new-file line (the list's
   * comments tab, which draws no rows — the detail resolves the line against its model). `comment` is
   * that tab's other half and the better one: the id of the thread the reader clicked, because the
   * detail is the pane drawing its box and knows the row it hangs at (see the resolution effect). The
   * line is what that resolve falls back to, and it is all a request that names no comment has.
   */
  const [landing, setLanding] = useState<{ fileId: string; top?: number | undefined; row?: number | undefined; line?: number | undefined; old?: boolean | undefined; card?: boolean | undefined; comment?: string | undefined; n: number } | undefined>(undefined)
  /** Ask the diff to land on one file: its first change unless `top` says where, or the row/line a
   *  jump to a comment names (which lands the way a change-block jump does, see `landingRow`). `card`
   *  lands the thread's own box instead of the rows it named, which is what the list's comments tab
   *  asks for: the box hangs below the range it names, and an outdated comment's lines may point at
   *  code that is gone. `comment` names that thread, which is how the detail finds the box's own row
   *  without trusting a number the record may have outlived (see the resolution effect).
   *  The nonce makes the request an event rather than a value, so re-clicking the
   *  chip for the file already open lands on its first change again. */
  const landOn = (
    fileId: string,
    top?: number | undefined,
    row?: number | undefined,
    card?: boolean,
    line?: number | undefined,
    comment?: string | undefined,
    old?: boolean | undefined,
  ): void => {
    setLanding(prev => ({ fileId, top, row, line, old, card, comment, n: (prev?.n ?? 0) + 1 }))
  }
  /** The selection as the latest render has it, for the closers that run from a
   *  cleanup (the docked tab unmounting) rather than from a handler. */
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /**
   * Which tab the list pane shows: the pending files, or every comment the files in the list carry.
   * The pane's own state rather than a remembered preference: a reader who came to the list for a
   * comment is in the comments tab while they read it, and the next time the panel opens it is the
   * list they are shown — the pending list is what the panel is for.
   */
  const [listTab, setListTab] = useState<'pending' | 'comments'>('pending')
  /**
   * Whether this panel is commenting at all: with comment mode off there are no comments to list, so
   * the pane is the pending list alone and shows no tabs. It follows the setting like the frame does
   * (the Settings section is another mount).
   */
  const [commentMode, setCommentMode] = useState(commentModeEnabled)
  /** The tabs the pane offers: the comments one exists only while the panel is commenting, so with
   *  the mode off the pane has one view and no switch to offer. */
  const listTabs = commentMode ? ['pending', 'comments'] as const : ['pending'] as const
  /** The tab actually shown: the comments one only exists while the mode is on. */
  const activeTab = commentMode ? listTab : 'pending'
  useEffect(() => {
    const onCommentMode = (): void => { setCommentMode(commentModeEnabled()) }
    window.addEventListener(COMMENT_MODE_CHANGED_EVENT, onCommentMode)
    return () => { window.removeEventListener(COMMENT_MODE_CHANGED_EVENT, onCommentMode) }
  }, [])
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
  /**
   * The host says it cannot write the pending state to disk. Said ONCE per distinct message: that file
   * is what makes the list survive a restart, so a reader who is never told simply finds the list gone
   * later with nothing to explain it (issue #6) — but the field rides every poll, and a filesystem that
   * keeps failing must not toast on each one. The host retracts the field once a write works, and that
   * retraction is what arms the marker again: the same disk failing twice, with a working spell between,
   * is news the second time too.
   */
  const persistToastRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const message = snapshot.persistError
    if (message === undefined) {
      persistToastRef.current = undefined
      return
    }
    if (message === persistToastRef.current) return
    persistToastRef.current = message
    showCopyToast(t('panel.persistFailed'))
  }, [snapshot.persistError, showCopyToast, t])
  /**
   * A comment thread that could not be written to disk, said once per distinct message and for
   * the same reason the pending file's failure is: the thread was drawn from the host's memory,
   * so the reader has no way to tell that a restart will erase it. Its own copy, because the
   * comment files are their own files — one may refuse while the other works.
   */
  const commentPersistToastRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const message = snapshot.commentPersistError
    if (message === undefined) {
      commentPersistToastRef.current = undefined
      return
    }
    if (message === commentPersistToastRef.current) return
    commentPersistToastRef.current = message
    showCopyToast(t('panel.commentPersistFailed'))
  }, [snapshot.commentPersistError, showCopyToast, t])
  /**
   * A refused undo/redo, with the host's own reason. The press produced an answer that
   * never reached the reader before: the divergence guard's "the file changed outside the
   * review after the action" is something only the host knows, so it is shown as it
   * arrived. Acknowledged straight after, so the field does not sit there for the rest of
   * the session and the SAME refusal on a later press is said again.
   *
   * Said once per distinct message, and held by a marker rather than by the ack alone, because
   * the ack is a round trip: until a later read drops the field the panel is still handed it,
   * and `showCopyToast` is rebuilt on every render. An effect that toasted on every pass would
   * toast on its own re-render, and on the render that caused, for as long as the field stood —
   * which is what this effect did before the marker: a refused undo spun the panel (and hung
   * every test that staged one) until the host's next read came back.
   */
  const undoNoticeToastRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const message = snapshot.undoNotice
    if (message === undefined) {
      undoNoticeToastRef.current = undefined
      return
    }
    if (message === undoNoticeToastRef.current) return
    undoNoticeToastRef.current = message
    showCopyToast(t('panel.undoFailed', { message }))
    onAckUndoNotice()
  }, [snapshot.undoNotice, showCopyToast, onAckUndoNotice, t])
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
    // The chip named the file, not an offset in it: it opens at that file's first
    // change. Every mounted instance follows the ask (the floating overlay and the
    // docked tab are separate mounts), and the memory names the file — with its
    // remembered place *forgotten*, since the landing is the first change — so an
    // instance that only appears afterwards opens the same file the same way.
    revealPanel()
    rememberPanelView(current, { fileId: entry.id })
    window.dispatchEvent(new CustomEvent<PanelFileDetail>(OPEN_PANEL_FILE_EVENT, { detail: { fileId: entry.id } }))
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
  // A file named for the panel (see OPEN_PANEL_FILE_EVENT): both mounts follow it,
  // so the chip's "查看差异" reaches the panel wherever it is showing — in the
  // overlay or in the docked tab — instead of only the mount that is already open.
  // The payload is checked: this is a window event, and a listener that trusted
  // it would let any other event's shape (the chip's own path payload) clear the
  // selection.
  useEffect(() => {
    const onPanelFile = (event: Event): void => {
      const detail = (event as CustomEvent<PanelFileDetail>).detail
      if (detail === undefined || typeof detail.fileId !== 'string') return
      setSelected(detail.fileId)
      // "Show me this diff": the file's first change, wherever it was left — for
      // the file already open too, so re-clicking the chip jumps back to the top
      // change rather than doing nothing.
      landOn(detail.fileId)
    }
    window.addEventListener(OPEN_PANEL_FILE_EVENT, onPanelFile)
    return () => { window.removeEventListener(OPEN_PANEL_FILE_EVENT, onPanelFile) }
  }, [])
  // A press on a produced-file chip of a file this panel holds (see produced-diff.ts) arrives here as
  // the menu the press asked for. The docked instance stands down, the same way it does for the
  // summon chord: the footer entry is mounted whether or not a tab is drawn, so one press is answered
  // once — by that mount — instead of by both.
  useEffect(() => {
    if (docked) return
    const onChipMenu = (event: Event): void => {
      const detail = (event as CustomEvent<ProducedChipMenuDetail>).detail
      if (detail === undefined || typeof detail.path !== 'string') return
      if (typeof detail.x !== 'number' || typeof detail.y !== 'number') return
      setChipMenu({ path: detail.path, x: detail.x, y: detail.y })
    }
    window.addEventListener(CHIP_MENU_EVENT, onChipMenu)
    return () => { window.removeEventListener(CHIP_MENU_EVENT, onChipMenu) }
  }, [docked])
  /** Whether the redo-cleared notice is showing (bottom-right, OK to dismiss). */
  const [redoClearedNotice, setRedoClearedNotice] = useState(false)
  /** A last-block keep/revert awaiting the user's remove-or-keep choice; the
   *  choice rides the same block RPC as its `removeWhenResolved` flag. */
  const [blockPrompt, setBlockPrompt] = useState<ResolvedBlockPrompt | null>(null)
  const [filePrompt, setFilePrompt] = useState<FileActionPrompt | null>(null)
  /**
   * The batch action waiting for the reader to confirm it: which action, over what, and the files a
   * revert would DELETE — the one thing in a batch that cannot be taken back. Every bulk action goes
   * through here (a pick's own menu, the list's bulk footer, the comments list), because each of them is
   * one press that settles many things at once, and the dialog is where the reader sees how many.
   */
  const [batchPrompt, setBatchPrompt] = useState<{
    sessionId: SessionId
    kind: 'keep-picked' | 'keep-remove-picked' | 'revert-picked' | 'revert-remove-picked' | 'keep-all' | 'revert-all' | 'close-picked'
      | 'remove-one' | 'keep-remove-one' | 'revert-remove-one'
    ids: readonly string[]
    doomed: readonly string[]
  } | null>(null)
  /** What one batch action's dialog asks, in that action's own words. */
  const batchAskOf = (prompt: NonNullable<typeof batchPrompt>): string => {
    const { kind } = prompt
    // A single row is NAMED: "保留并移出「a.txt」？" reads as the press the reader made, where "1 个文件"
    // reads like a report. The action word is the row's own label, so the dialog and the menu agree.
    if (kind === 'remove-one' || kind === 'keep-remove-one' || kind === 'revert-remove-one') {
      const file = files.find(entry => entry.id === prompt.ids[0])
      // 移出 and 保留并移出 are the same words their row menu uses. 回退并移出 is not: with no earlier
      // version to write back, the whole-file action DELETES, so the dialog says 删除并移出 — the row's own
      // label (see `rowMenuItems`), so the press and the question it opens agree.
      const action = kind === 'remove-one'
        ? t('row.dismiss')
        : kind === 'keep-remove-one'
          ? t('row.keepRemove')
          : file?.earlierVersion === 'none' ? t('row.deleteRemove') : t('row.revertRemove')
      return t('panel.removeOneAsk', { action, file: basenameOf(file?.path ?? '') })
    }
    // The two WHOLE-LIST asks name 移出 in their own text (`panel.batchKeepAllAsk` / `panel.batchRevertAllAsk`),
    // even though the buttons that open them stay 全部保留 / 全部回退: a footer button has no room for it, and
    // both presses DO take their rows out of the list (see `runBulk`). The pick's asks keep a pick's own
    // words, because a pick acts on a subset the dialog counts rather than on the whole list.
    //
    // The whole-list REVERT is the one ask whose own text depends on what the press will do: reverting a row
    // with no earlier version DELETES its file, so a batch holding any of those says 删除 and counts them,
    // while a batch where every row has something to write back uses the plain ask and claims no deletion.
    // The button says 全部回退 either way — the reader asked for the deed in the box, not on the button.
    // (`data-diff-batch-deletes` below names the same files, which is where the reader recognises them.)
    if (kind === 'revert-all') {
      const doomed = prompt.doomed.length
      return doomed > 0
        ? t('panel.batchRevertAllDeletedAsk', { count: prompt.ids.length, doomed })
        : t('panel.batchRevertAllAsk', { count: prompt.ids.length })
    }
    return t(
      kind === 'keep-picked' ? 'panel.batchKeepAsk'
        : kind === 'keep-remove-picked' ? 'panel.batchKeepRemoveAsk'
          : kind === 'revert-picked' ? 'panel.batchRevertAsk'
            : kind === 'revert-remove-picked' ? 'panel.batchRevertRemoveAsk'
              : kind === 'keep-all' ? 'panel.batchKeepAllAsk'
                : 'panel.batchCloseAsk',
      { count: prompt.ids.length },
    )
  }
  /**
   * Run what the dialog was confirming. The dialog is the only caller: nothing bulk happens without it.
   *
   * A pick's ids are filtered against the list as it reads NOW — the pick was taken before the dialog
   * opened, and a refresh may have settled a file in between — while an all-file action names the list it
   * was opened over, which is the set the host will walk.
   */
  const runBatchConfirm = (prompt: NonNullable<typeof batchPrompt>): void => {
    // The three single-row removals are the row menu's own press, confirmed: the same calls it would have
    // made on the spot, now behind the warning that the file's comments go with it.
    if (prompt.kind === 'remove-one' || prompt.kind === 'keep-remove-one') {
      void onKeep(prompt.sessionId, prompt.ids[0] ?? '')
      return
    }
    if (prompt.kind === 'revert-remove-one') {
      // 回退并移出 DROPS the row, which is what its label says (see `runRowMenu`).
      void onRevert(prompt.sessionId, prompt.ids[0] ?? '')
      return
    }
    if (prompt.kind === 'close-picked') {
      clearPicked()
      if (prompt.ids.length === 0) return
      void onCommentRemoveMany(prompt.sessionId, prompt.ids).catch((error: unknown) => {
        showCopyToast(error instanceof Error ? error.message : String(error))
      })
      return
    }
    if (prompt.kind === 'keep-all') { void runBulk('keep'); return }
    if (prompt.kind === 'revert-all') { void runBulk('revert'); return }
    const ids = prompt.ids.filter(id => files.some(file => file.id === id))
    // The pick has been spent: the reader asked for those files to be settled, so the state that named
    // them does not outlive the answer.
    clearPickedFiles()
    if (ids.length === 0) return
    if (prompt.kind === 'keep-picked') void onKeepMany(prompt.sessionId, ids, true)
    else if (prompt.kind === 'keep-remove-picked') void onKeepMany(prompt.sessionId, ids, undefined)
    // Same shape as the keep pair, and as the single row (see `runRowMenu`): 回退 leaves the rows listed,
    // 回退并移出 drops them.
    else if (prompt.kind === 'revert-picked') void onRevertMany(prompt.sessionId, ids, true)
    else void onRevertMany(prompt.sessionId, ids, undefined)
  }
  /**
   * The comments the reader has picked in the list (Ctrl/Cmd-click), by id.
   *
   * Picking is a mode of its own rather than a navigation: the reader is gathering a few comments for ONE
   * action — ending them together, from the row's own menu — so a click that picks does NOT jump (a jump
   * would take them out of the list they are picking from), and anything else they do with the list ends
   * it (`clearPicked`, plus the effect below for the two switches that replace what is on screen).
   */
  const [pickedComments, setPickedComments] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * Where a Shift press in the COMMENTS list measures from: the comment the last non-Shift press landed on
   * (a Ctrl/Cmd pick, or an ordinary press, which jumps to the comment). The comments list has no "open"
   * item of its own — a press navigates away rather than selecting — so this is what stands in for the file
   * list's open file, and it is the reason the two lists can share one rule (see `pickCommentRangeTo`).
   */
  const [commentAnchor, setCommentAnchor] = useState<string | undefined>(undefined)
  /** End the picking, keeping the same set object when there is nothing to end (so nothing re-renders). */
  const clearPicked = (): void => {
    setPickedComments(current => (current.size === 0 ? current : new Set()))
  }
  /** Pick or unpick one comment. The click that reaches this never jumps (see `pickedComments`). */
  const togglePicked = (id: string): void => {
    setPickedComments(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Picking is about the comments in front of the reader NOW: switching files or tabs replaces every item
  // it could have named, so the pick ends with the switch rather than surviving into a list it is not about.
  useEffect(() => { clearPicked() }, [selected, activeTab])
  // A press anywhere else ends the pick — the blur rule a multi-selection has.
  //
  // Picking is a mode the reader is in, so what ends it is what means they have moved on: a press on a
  // file row, the toolbar, the diff, the list's empty space, or anything outside this panel at all —
  // which is why the listener is on the document and why it only exists while there is a pick to end.
  // Three presses are NOT that: a press on a row that is picked (the reader acting on the pick, which
  // that row's own handlers read), a Ctrl/Cmd- or Shift-press (both are themselves picks — see
  // `togglePicked` and `pickCommentRangeTo`), and a press inside an open menu (this pick's own menu is
  // where the pick is spent, and it is read on select).
  useEffect(() => {
    if (pickedComments.size === 0) return
    const onPress = (event: PointerEvent): void => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target
      if (target instanceof Element) {
        const row = target.closest('[data-diff-comment-link]')
        if (row !== null && pickedComments.has(row.getAttribute('data-diff-comment-link') ?? '')) return
        if (target.closest('[role="menu"]') !== null) return
      }
      clearPicked()
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => { document.removeEventListener('pointerdown', onPress, true) }
  }, [pickedComments])
  /** The file list row whose action menu is open, and where the right-click landed. */
  const [rowMenu, setRowMenu] = useState<{ file: PendingFileDiff; x: number; y: number; picked: boolean } | null>(null)
  /**
   * The FILES the reader has picked in the list (Ctrl/Cmd-click), by id — the same mode the comments tab
   * has, for the same reason: the four decisions a row offers are decisions about one file, and a reader
   * looking at ten of them should not have to answer ten times.
   *
   * The row head's own `data-selected` means something else (the file open in the detail pane), so the
   * pick wears `data-picked`: the two states coexist, and a picked file is NOT thereby opened — which is
   * the whole point of picking with a modifier.
   */
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * Where a Shift press measures from: the row the last NON-Shift press landed on — a Ctrl/Cmd pick, or an
   * ordinary press, which opens the file. Shift never moves it, so pressing Shift twice measures from the
   * same place and the range can shrink as well as grow (see `pickRangeTo`).
   *
   * Nothing has been pressed yet on a fresh panel, and `selected` was not the reader's doing (the list
   * opens on its first file), so the range falls back to the open file when this is unset: the row the
   * reader is looking at is the only sensible place to measure from before they have touched anything.
   */
  const [pickAnchor, setPickAnchor] = useState<string | undefined>(undefined)
  /** End the file picking, keeping the same set object when there is nothing to end. */
  const clearPickedFiles = (): void => {
    setPickedFiles(current => (current.size === 0 ? current : new Set()))
  }
  // The pick is about the list in front of the reader: the comments tab is a different set of rows, so
  // switching to it ends the pick — and drops the ANCHOR with it. The anchor is "where the reader last
  // acted", and after a tab switch they are somewhere else: a Shift press there must measure from the row
  // it lands on, not from one they left behind (which may not even be in this list any more). A file that
  // left the list needs no effect of its own — the two places the pick is READ both look it up in the
  // current list, so an id that is gone simply is not acted on.
  useEffect(() => {
    clearPickedFiles()
    setPickAnchor(undefined)
    setCommentAnchor(undefined)
  }, [activeTab])
  // The blur rule, the one the comments pick wears: any press that is not on a picked row, not a
  // Ctrl/Cmd- or Shift-press (both are pick gestures themselves) and not inside an open menu or dialog
  // ends the pick. A DIALOG especially: the pick-revert confirmation is about the very files that are
  // picked, so a press on its buttons must not be read as the reader walking away from them.
  useEffect(() => {
    if (pickedFiles.size === 0) return
    const onPress = (event: PointerEvent): void => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target
      if (target instanceof Element) {
        const row = target.closest('[data-diff-file]')
        if (row !== null && pickedFiles.has(row.getAttribute('data-diff-file') ?? '')) return
        if (target.closest('[role="menu"]') !== null) return
        if (target.closest('[role="dialog"]') !== null) return
      }
      clearPickedFiles()
    }
    document.addEventListener('pointerdown', onPress, true)
    return () => { document.removeEventListener('pointerdown', onPress, true) }
  }, [pickedFiles])
  /** The comments-tab item whose menu is open, if any: which thread, where the press landed, and whether
   *  that press acted on a PICK of comments rather than on the one row it landed on. */
  const [commentMenu, setCommentMenu] = useState<{ id: string; fileId: string; x: number; y: number; picked: boolean } | null>(null)
  /** The produced-file chip whose menu is open, and where that chip is: the press on a pending file's
   *  chip is the panel's (see produced-diff.ts), so the panel answers it with the two ways to open it. */
  const [chipMenu, setChipMenu] = useState<{ path: string; x: number; y: number } | null>(null)
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
  /** File-list pane width, adjustable by dragging the divider. It opens AT the floor, which is the
   *  width the bulk footer needs for its three labels, so a fresh pane cannot wrap them either. */
  const [listWidth, setListWidth] = useState(MIN_LIST_WIDTH_PX)
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
    // A seat that is not showing anything draws no list, so it reads none: an undocked tab the reader
    // has switched away from was polling its own session once a second for nobody, and (before the
    // per-session views) its answers were what every badge on the page was reading.
    if (!showing || current === undefined || currentBlank) return
    onRefresh(current)
    const timer = setInterval(() => { onRefresh(current) }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [current, currentBlank, showing, onRefresh])

  /**
   * A file the list no longer holds takes its placed-but-unsent blocks with it, on every poll.
   *
   * A placement is a block of rows in one file's diff, so a file the reader kept or reverted out
   * of the list leaves nothing for it to hang on. The entry ids ARE paths, so without this the
   * placement survived the file leaving and was drawn again — on a file the reader had already
   * dealt with — the moment that path was re-added, and it went on refusing a fresh comment on
   * those rows meanwhile (see `discussionOverlapping`). The host drops the file's COMMENTS at the
   * same moment; this is the page's own half of that rule.
   */
  useEffect(() => {
    forgetPlacedThreadsNotIn(current, snapshot.files.map(file => file.id))
  }, [current, snapshot.files])

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
  /**
   * Set when a fresh showing of the panel should start with the folded list open —    * the panel opens to show the list, and the knob that reveals it is for folding
   * it away again — and spent by the first frame it can be spent on. The folded
   * mode is not always known on that frame: a docked panel measures its own width a
   * frame after it mounts. A hand on the list's own switches clears it, so the
   * reader's choice always wins over the default.
   */
  const startListOpenRef = useRef(false)
  // The card is on its way into the corner: still mounted (and still `floatOpen`) so the
  // shrink can play, with the reveal switch below counting it as open meanwhile.
  const [floatClosing, setFloatClosing] = useState(false)
  const foldTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (foldTimerRef.current !== undefined) window.clearTimeout(foldTimerRef.current)
  }, [])
  /** Fold the card away, giving the exit animation its `FILE_LIST_FOLD_MS` first; `then`
   *  runs once it has gone, for callers with work to do the moment it is folded. */
  const foldCardAway = (then?: () => void): void => {
    if (foldTimerRef.current !== undefined) window.clearTimeout(foldTimerRef.current)
    setFloatClosing(true)
    foldTimerRef.current = window.setTimeout(() => {
      foldTimerRef.current = undefined
      setFloatClosing(false)
      setFloatOpen(false)
      then?.()
    }, FILE_LIST_FOLD_MS)
  }
  const toggleFileList = (): void => {
    startListOpenRef.current = false
    // Pressing the knob again while the card is being drawn into the corner takes the fold
    // back: the card never left the DOM, so it is simply there again.
    if (floatClosing) {
      if (foldTimerRef.current !== undefined) window.clearTimeout(foldTimerRef.current)
      foldTimerRef.current = undefined
      setFloatClosing(false)
      return
    }
    if (floatOpen) { foldCardAway(); return }
    setFloatOpen(true)
  }
  /** Flip the always-fold preference, remembered for the next open. */
  const toggleForceFloat = (): void => {
    startListOpenRef.current = false
    const next = !forceFloat
    setForceFloat(next)
    setFileListFloat(next)
    // The switch says where the list lives, not whether it is there: folding it for good leaves
    // the card up — the list the reader was just looking at stays on screen, and the knob is the
    // gesture that folds it away — while turning the fold off puts the list back in its column,
    // which needs no card at all.
    if (next) setFloatOpen(true)
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

  // Spend the "start with the folded list open" mark as soon as it applies: the
  // panel is showing and the list really is floating (so there is a card to open at
  // all; in the in-flow list there is nothing folded to reveal).
  useEffect(() => {
    if (!startListOpenRef.current) return
    if (!open && !docked) return
    if (!floatMode) return
    startListOpenRef.current = false
    setFloatOpen(true)
  }, [open, docked, floatMode])

  // Clicking anywhere outside the floating card — or on the toggle button, which
  // toggles it, or on the card's width grip, which sits just outside its right
  // edge — folds the floating list back, through the same corner fold the knob uses.
  useEffect(() => {
    if (!floatMode || !floatOpen) return
    const el = panelRef.current
    if (el === null) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target instanceof Element
        && (target.closest('[data-diff-floating-file-list]') !== null
          || target.closest('[data-diff-file-list-toggle]') !== null
          || target.closest('[data-diff-float-resize]') !== null
          // An open MENU or DIALOG is part of this list's own work, not somewhere else the reader walked
          // off to. Both are drawn INSIDE the panel (the row menu raises the confirmation that answers it),
          // so a press on one is "inside the panel, outside the CARD" — which is exactly what this rule
          // folds on. Answering the list's own question must not fold the list away.
          || target.closest('[role="menu"]') !== null
          || target.closest('[role="dialog"]') !== null)) return
      // Already on its way in: leave the fold it is playing alone.
      if (floatClosing) return
      foldCardAway()
    }
    el.addEventListener('pointerdown', onPointerDown, true)
    return () => { el.removeEventListener('pointerdown', onPointerDown, true) }
  }, [floatMode, floatOpen, floatClosing])

  // Where the floating file list goes: it is measured from the code view when a
  // file is open, and from the detail pane when none is — so the folded list has
  // a box either way. Both the card and the knob on its corner are placed from
  // this one box, which is what keeps them aligned.
  //
  // The box has to follow the *content*, not just the panel's own size. Opening
  // the first file mounts the diff's action row above the code view, which moves
  // that view's top down by the row's height; the search bar adds another row, and
  // the Markdown preview swaps the element being measured outright. So it is
  // measured in the layout phase (before paint, so nothing shows at the old place)
  // whenever something that moves it changes, and watched for the changes that come
  // with no render of this panel at all: a ResizeObserver for the box resizing (a
  // dock divider being dragged), and a MutationObserver because the measured
  // element can be replaced outright.
  //
  // Deliberately NOT a dependency-free effect, which is what this was: React's
  // "maximum update depth exceeded" names that pattern for a reason. The observers
  // hand an update to a commit that is already rendering, so a `setState` from there
  // has no eager bail-out to absorb it — with the drag moving the box every frame,
  // each commit scheduled another, and the panel's boundary took the review away
  // mid-drag. The dependencies below are what that effect was really for.
  const measureFloatBox = (): void => {
    if (!floatMode) return
    const panel = panelRef.current
    const split = splitRef.current
    if (panel === null || split === null) return
    const body = panel.querySelector<HTMLElement>('[data-diff-body],[data-diff-md-preview-body]')
      ?? panel.querySelector<HTMLElement>('[data-diff-detail]')
    if (body === null) return
    const s = split.getBoundingClientRect()
    const b = body.getBoundingClientRect()
    setFloatBox(current => current !== null
      && current.left === b.left - s.left && current.top === b.top - s.top
      && current.width === b.width && current.height === b.height
      ? current
      : { left: b.left - s.left, top: b.top - s.top, width: b.width, height: b.height })
  }
  // Read through a ref so the observers below always run the current render's
  // measurement (its `floatMode` and refs) without re-subscribing every render.
  const measureFloatBoxRef = useRef(measureFloatBox)
  measureFloatBoxRef.current = measureFloatBox
  useLayoutEffect(() => {
    measureFloatBoxRef.current()
  }, [floatMode, floatOpen, panelWidth, selected, snapshot.files.length])
  useEffect(() => {
    if (!floatMode) return
    const split = splitRef.current
    if (split === null) return
    const measure = (): void => { measureFloatBoxRef.current() }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    resize?.observe(split)
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
    mutations?.observe(split, { childList: true, subtree: true })
    return () => {
      resize?.disconnect()
      mutations?.disconnect()
    }
  }, [floatMode, floatOpen, panelWidth, selected])

  // The list rows' right band is the shared `.listScroll` gutter alone now (`scrollbar-gutter:
  // stable` there). The JS that measured the platform's strip and padded the FILES scroller is gone:
  // it never reached the comments list, and against a reserved gutter it would double the inset.

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

  // A covered composer must not keep the caret. The panel is over it, so the reader
  // cannot see what they type — and the caret is usually already there (typing is
  // what a composer is for, and selecting lines in the diff with the mouse does not
  // move the focus). The copy-reference action applies the same rule before it pastes
  // (see `composer-cover`); this is the half that catches the panel simply opening,
  // or being covered, while the caret was in the composer.
  useEffect(() => {
    if (!open && !docked) return
    if (!composerCoveredByPanel()) return
    leaveComposerCaret()
  }, [open, docked, floatMode, cover.composer, selected, panelWidth, snapshot.files.length])

  // Nothing outside the panel dismisses it — not a press on the editor, the chat,
  // the composer, or the sidebar's own blank space. The panel is a working
  // surface, not a popover: closing it is a decision, and the ways to make it are
  // the ✕ Escape, and the quick-summon chord. (The folded file-list card inside
  // it is still dismissed by a press away from the card — see below.)
  /**
   * The one path this panel has already reported seen, for the episode its dot was in.
   *
   * An "episode" is the dot being up: the ref is cleared the moment the flag is false again, so a later
   * change that lights the same path is reported afresh. What it exists for is that the effect below runs
   * on EVERY publish — a poll hands over a new `files` array even when nothing changed — and reporting a
   * row that is already reported is not free: the store used to re-read the list on `markSeen`, which
   * published another `files` array, which re-ran this effect, which reported again — a list read per
   * report, with the badge counting whatever that read answered with.
   */
  const markedSeenRef = useRef<string | null>(null)
  // The reader is looking at this file: a dot that arrived for it is already stale — a file on screen wears
  // none. The host owns the flag, so it is told, and the next read brings the list back without it.
  useEffect(() => {
    if (selected === null || selected === undefined) return
    // The row has to be THIS session's as well as this id's: an id is a path that more than one session
    // can have pending, so a row the view holds for another session (or a legacy row whose single
    // `sessionId` names one) must not be taken for the file the reader is looking at. Reporting such a
    // row would take a dot down for a file the reader was never shown — and name the wrong session for it.
    const row = snapshot.files.find(file => file.id === selected && belongsToSession(file, current))
    // No dot on it now — the host answered, the row left the list, or it was never this session's: the
    // episode is over, so the next one that lights this path is reported again.
    if (row?.unseen !== true) { markedSeenRef.current = null; return }
    if (markedSeenRef.current === selected) return
    markedSeenRef.current = selected
    onMarkSeen?.(current, selected)
  }, [selected, snapshot.files, current, onMarkSeen])

  // The panel reviews only the current session's files; other sessions of the
  // same workspace stay out of the list, badge, and auto-advance. Sort by the
  // displayed file name so the list reads in dictionary order even before the
  // host's own ordering is picked up.
  const files = snapshot.files
    // A globally-unique entry is shown to every session that touched it (its
    // sessionIds), so a file edited by multiple sessions appears once in each
    // of their views. Tolerant of a legacy row carrying only `sessionId`.
    .filter(file => belongsToSession(file, current))
    .sort((left, right) => compareFileNames(left.path, right.path))
  // Wrap the block keep/revert so a last-block action prompts for remove-or-keep
  // up front; the choice rides the same RPC as `removeWhenResolved`. A file with
  // more than one remaining block is never cleared by a single action, so it runs
  // straight through. Re-deriving the change blocks here (the panel already has
  // each file's text) keeps one interception point for both view modes.
  const blockKeepWithPrompt: PendingPanelFace['onBlockKeep'] = (sessionId, id, block, removeWhenResolved) => {
    const file = files.find(entry => entry.id === id)
    if (removeWhenResolved === undefined && file !== undefined && blockResolvesWholeFile(file, block)) {
      // The reader has already answered this question for this file (the keep-and-stop-asking
      // button in the dialog): run the action with the row left in the list, for them to take out
      // by hand when they are done.
      if (removalAskQuiet(current, id)) return onBlockKeep(sessionId, id, block, false)
      setBlockPrompt({ action: 'keep', sessionId, id, block })
      return Promise.resolve()
    }
    return removeWhenResolved === undefined ? onBlockKeep(sessionId, id, block) : onBlockKeep(sessionId, id, block, removeWhenResolved)
  }
  const blockRevertWithPrompt: PendingPanelFace['onBlockRevert'] = (sessionId, id, block, removeWhenResolved) => {
    const file = files.find(entry => entry.id === id)
    if (removeWhenResolved === undefined && file !== undefined && blockResolvesWholeFile(file, block)) {
      if (removalAskQuiet(current, id)) return onBlockRevert(sessionId, id, block, false)
      setBlockPrompt({ action: 'revert', sessionId, id, block })
      return Promise.resolve()
    }
    return removeWhenResolved === undefined ? onBlockRevert(sessionId, id, block) : onBlockRevert(sessionId, id, block, removeWhenResolved)
  }

  // A whole-file keep/revert always resolves the file outright, so — while the
  // preference is on — ask whether to drop it from the list rather than removing
  // it silently. An explicit `keepListed` (the prompt's own answer, and the "移出" the
  // detail view offers once a file has no diff left) runs straight through, so the
  // prompt cannot re-enter itself.
  const keepWithPrompt: PendingPanelFace['onKeep'] = (sessionId, id, keepListed) => {
    // An explicit `false` is the detail view's own 移出 (the one a file with no diff left offers): it DROPS
    // the entry, and a dropped entry takes its comments with it — so a file that has any is confirmed
    // first. The keep-and-stop-asking button in the dialog is the reader's answer to exactly this
    // question, so pressing it silences this one too.
    if (keepListed === false && commentsOn([id]).count > 0 && !removalAskQuiet(current, id)) {
      setBatchPrompt({ sessionId, kind: 'remove-one', ids: [id], doomed: [] })
      return Promise.resolve()
    }
    // The confirm-first SETTING governs asking about the row; a file whose comments would die with it is
    // asked about regardless, because that loss is not something the setting was ever about.
    if (keepListed === undefined && (confirmFileRemoveEnabled() || commentsOn([id]).count > 0)) {
      if (removalAskQuiet(current, id)) return onKeep(sessionId, id, true)
      setFilePrompt({ action: 'keep', sessionId, id })
      return Promise.resolve()
    }
    return keepListed === undefined ? onKeep(sessionId, id) : onKeep(sessionId, id, keepListed)
  }
  const revertWithPrompt: PendingPanelFace['onRevert'] = (sessionId, id, keepListed) => {
    if (keepListed === undefined && (confirmFileRemoveEnabled() || commentsOn([id]).count > 0)) {
      if (removalAskQuiet(current, id)) return onRevert(sessionId, id, true)
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

  // What the panel shows, and where it lands, each time it starts showing: the
  // overlay opening (the panel is always mounted, its content is not) or the
  // docked tab mounting. Closing the panel is not "done reviewing", so a fresh
  // showing resumes the file this session was left in — at the offset it was left
  // at — and falls back to the list's first file, at its first change, when there
  // is nothing remembered. Selection is single and cannot be cleared by clicking:
  // only an empty list shows the empty state.
  //
  // In the layout phase, not after paint: the code view exists only once a file
  // is open, and one painted frame of "nothing selected" is enough for the folded
  // file list to be placed from the pane's box instead of the code view's — the
  // stale placement this was reported for. Selecting in the same commit means the
  // first frame the user sees is already the final one.
  const wasShowingRef = useRef(false)
  useLayoutEffect(() => {
    const showing = open || docked
    const started = showing && !wasShowingRef.current
    wasShowingRef.current = showing
    if (!showing) return
    // A fresh showing starts with the folded list open: the panel opens to show the
    // list, and the knob that reveals it is for folding it away again. Marked here,
    // before any selection decision: a showing on an empty list has no file to pick,
    // and the list that arrives later belongs to this same showing. (The mark is
    // spent once the folded mode is known — see below.)
    if (started) startListOpenRef.current = true
    const pending = (id: string): boolean => files.some(file => file.id === id)
    // A file the detail header's path field just opened: once it is in the list it wins over
    // everything else — the reader asked for that file, not for the one that was open.
    const typed = pendingSelect !== null && pending(pendingSelect) ? pendingSelect : undefined
    if (typed !== undefined) setPendingSelect(null)
    // The file already chosen, while it is still pending.
    const keep = selected !== '' && pending(selected) ? selected : undefined
    // Resuming is for a fresh showing with nothing chosen yet; a selection that a
    // keep/revert resolved away mid-session keeps the older rule (the list's
    // first file) rather than jumping to whatever was open last time.
    const remembered = keep === undefined && started ? lastPanelFile(current) : undefined
    const resumed = remembered !== undefined && pending(remembered) ? remembered : undefined
    const pick = typed ?? keep ?? resumed ?? files[0]?.id
    if (pick === undefined) return
    if (pick !== selected) setSelected(pick)
    // A fresh showing lands where that file was left (its first change when it has
    // never been left). Everything else — a row the reader clicked, the advance a
    // decision leaves behind — lands on the file's first change, which is the
    // default its own callers set.
    // A typed path lands on its file's first change like a row click does, whatever this
    // showing was doing; a fresh showing lands where the file was left instead.
    if (started) landOn(pick, panelFileOffset(current, pick))
    else if (typed !== undefined) landOn(pick)
  }, [open, docked, current, files, selected, pendingSelect])

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
      } else {
        // What came in, as the same transient banner: the rows themselves are behind the modal's
        // dismissal, so the count is the one thing that says the press did something. It counts the
        // entries the import actually took in (see `foldBatch`): a change folding into an existing
        // entry counts too, a no-op one does not — so the sentence says 改动 / changes, which is what
        // it counts, not files and not new rows.
        setImportToast(t('panel.importDone', { count: value.imported }))
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
   * floating panel, covering whatever {@link panelCover} says.
   *
   * A remembered dock is only taken when the dock can actually show the panel.
   * "dock" is remembered from a page where the right sidebar existed, and the ask
   * itself is not proof: `onOpenDock` is always wired, and a sidebar whose
   * services never came up (or a controller that has since gone stale) accepts the
   * call and shows nothing. That used to swallow the click whole — the badge, the
   * header entry, the chord and the produced-file chips all did nothing, and the
   * only switch back to floating lives *inside* the panel, so the page had to be
   * reloaded to reach the review again. Now the overlay steps in whenever the tab
   * does not come up.
   */
  const revealPanel = (): void => {
    const stored = panelPresentation()
    if (stored === 'dock' && onOpenDock !== undefined && dockAvailable) {
      try {
        onOpenDock()
      } catch {
        // The sidebar is mounted but cannot take the panel yet (no seat bound):
        // open the overlay instead of doing nothing at all.
        collapseSidebar()
        setOpen(true)
        return
      }
      // Give the tab a moment to come up (its body mounts a frame or two later and
      // reports itself through the dock state), then fall back to the overlay if it
      // never did.
      if (revealTimerRef.current !== undefined) window.clearTimeout(revealTimerRef.current)
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = undefined
        if (dockShowingRef.current) return
        collapseSidebar()
        setOpen(true)
      }, DOCK_REVEAL_GRACE_MS)
      return
    }
    // Opening the floating modal: collapse the narrow sidebar first so it can't
    // overlap it.
    collapseSidebar()
    setOpen(true)
  }

  revealRef.current = revealPanel

  // The panel shows in one place at a time: if the docked tab comes up while this
  // overlay is open (the fallback above, or a tab the user brought back), the
  // overlay steps aside rather than drawing a second copy of the review.
  //
  // It watches the dock *becoming* visible, not the two states merely overlapping,
  // because the hand-off out of the dock is itself a moment of overlap: the chip
  // closes the tab and asks the overlay to open in the same tick, and the dock keeps
  // reporting "showing" until that tab's body unmounts a commit later. Closing on
  // the level alone shut the overlay the instant it was asked for — which is what
  // made "switch a docked panel to floating" take a second click.
  const wasDockShowingRef = useRef(false)
  useEffect(() => {
    const was = wasDockShowingRef.current
    wasDockShowingRef.current = dockShowing
    if (docked) return
    if (!was && dockShowing && open) setOpen(false)
  }, [docked, dockShowing, open])

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
    // This mount is closing as the docked tab takes over: record the place, so the
    // tab resumes it — the two are separate mounts sharing one memory.
    rememberView()
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
   * Remember what this panel is showing, so the next open resumes it: the file
   * that is open and how far down it the code view is. Called on every way out —    * the overlay's close, the hand-off to the dock, and the docked tab unmounting.
   * With no code view (the Markdown preview is showing) the file's offset is kept
   * as it was: the file is what the reader comes back to.
   */
  const rememberView = (): void => {
    const id = selectedRef.current
    if (id === '' || current === undefined) return
    const body = panelRef.current?.querySelector<HTMLElement>('[data-diff-body]')
    const previous = panelFileOffset(current, id)
    rememberPanelView(current, { fileId: id, scrollTop: body?.scrollTop ?? previous ?? 0 })
  }
  /** The latest `rememberView`, for the docked instance's unmount cleanup: that
   *  closer runs outside this render's closure. */
  const rememberViewRef = useRef(rememberView)
  rememberViewRef.current = rememberView
  // A layout effect, so the closer runs while the panel's own tree is still in the
  // document: it reads the code view's offset, and a passive cleanup would run
  // after the tree is detached.
  useLayoutEffect(() => {
    if (!docked) return
    // The docked panel's "close" is its tab closing, which unmounts this instance.
    return () => { rememberViewRef.current() }
  }, [docked])

  /**
   * Close the floating panel and hand the caret back to the chat composer:
   * closing the review is a "done reviewing, back to typing" move. A close the
   * user made by clicking somewhere else is the exception — that press is an
   * instruction to put the caret where they clicked, so the outside-click path
   * closes without touching focus.
   */
  const closePanel = (): void => {
    rememberView()
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

  // The header entry's button runs this same toggle: one action, two mounts, so
  // neither entry can disagree with the other about what a press does.
  toggleRef.current = toggleOpen

  // Tell the world (the header entry, in particular) whether the overlay is up:
  // it lights its button from this, exactly as the footer badge lights itself
  // from the state it owns. Published on mount too, so an entry that mounted
  // after the panel opened still learns the truth.
  useEffect(() => {
    if (docked) return
    window.dispatchEvent(new CustomEvent<PanelStateDetail>(PANEL_STATE_EVENT, { detail: { open } }))
  }, [docked, open])

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
    setRowMenu(null)
  }, [open])

  /**
   * The whole-list decisions, decided off the same rule a single row uses (`fileHasNoDiff`), so the
   * footer and the rows can never disagree about what a file is for.
   *
   * `bulkRevertFiles` is also what makes the footer's 全部回退 inert: the rows it names are the whole of
   * what that press would act on, so when it is empty the button is DISABLED (see the footer) rather
   * than left to open a confirmation that names nothing.
   */
  const bulkRevertFiles = files.filter(file => !fileHasNoDiff(file))

  /** Ask before running a session-wide bulk decision — the same dialog a pick's rows open. */
  const askBulk = (kind: 'keep' | 'revert'): void => {
    if (current === undefined) return
    // 保留 acts on every row: folding and dropping it is the one decision a row with nothing left to
    // review still has. A 回退 SKIPS those rows (see `runBulk`), so it acts on `bulkRevertFiles` alone.
    const acted = kind === 'revert' ? bulkRevertFiles : files
    // 回退 DELETES every file the agent created; the dialog names those, because that is the part with no undo
    // behind it. Read off the rows this press ACTS on, not off the whole list: a created file that is also
    // dismiss-only (an empty one, or one gone from disk) is skipped, so nothing of its is deleted and the
    // dialog must not say otherwise.
    const doomed = kind === 'revert'
      ? acted.filter(file => file.earlierVersion === 'none').map(file => file.id)
      : []
    setBatchPrompt({
      sessionId: current,
      kind: kind === 'keep' ? 'keep-all' : 'revert-all',
      ids: acted.map(file => file.id),
      doomed,
    })
  }

  /**
   * Run the same decision over the current-session list.
   *
   * Both presses SETTLE the list: the rows they decided leave it, which is what the reader asked a
   * whole-list button to mean (and what its own confirmation now spells out — see `batchAskOf`). The
   * two differ only in what they do to the files on the way out.
   *
   * 保留 is one call: `keep-all` folds every entry and drops it (the host's own handler walks the
   * session and `dropEntry`s each one — `src/index.ts` `case 'keep-all'`, pinned by the host suite's
   * "keeps every session entry in one call"), so nothing here has to name the rows.
   *
   * 回退 names the rows it may act on EXPLICITLY rather than asking the host for the whole session,
   * for two reasons. A row with nothing left to review must be skipped: putting it back would fold
   * nothing and only churn the list (see `fileHasNoDiff`). And the
   * rows it does act on must LEAVE the list, like 保留's do and like a single row's 「回退并移出」 —
   * so `keepListed` is left off (the host drops the row unless it is `true`, which is the plain
   * single-row 回退 and NOT what a whole-list button means).
   */
  const runBulk = async (kind: 'keep' | 'revert') => {
    if (current === undefined) return
    const ids = bulkRevertFiles.map(file => file.id)
    if (kind === 'revert' && ids.length === 0) return
    setBulkBusy(kind)
    try {
      if (kind === 'keep') await onKeepAll(current)
      // `undefined` is the REMOVE variant (`keepListed` is only honoured when it is `true`), which is the
      // shape the single row's 「回退并移出」 and the pick's own 回退并移出 both use.
      else await onRevertMany(current, ids, undefined)
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

  /**
   * Open a path typed into the detail header's field: add it to the list when it is not there
   * yet, then select the file the host says it landed as.
   *
   * The host is the one that judges the path, and its refusal is the only thing the reader can
   * act on — "nothing happened" is what sent them looking for a bug. So every refusal says why:
   * the same wording the browse dialog uses for the same outcomes, plus the two this field can
   * hit and that dialog cannot (a directory named as one file, and an add that raises).
   *
   * @param path - the path as typed.
   * @returns what to select: the entry opened (the one already listed, for a duplicate), or
   *   undefined when the host refused the path.
   */
  const addTypedPath = async (path: string): Promise<{ openPath?: string } | undefined> => {
    if (current === undefined) {
      showCopyToast(t('panel.fileNotPending'))
      return undefined
    }
    const value = await onAddPath(current, path, true, true).catch((error: unknown) => {
      showCopyToast(t('panel.addFailed', { message: error instanceof Error ? error.message : String(error) }))
      return undefined
    })
    if (value === undefined) return undefined
    if (value.outcome === 'added' || value.outcome === 'duplicate') {
      if (value.id !== undefined) {
        setPendingSelect(value.id)
        // The id is the host's answer, and the panel can only select ids its own list holds: ask
        // for the list now instead of waiting for the next poll. The field is a way to open a
        // file, and opening it a second later is not that.
        onRefresh(current)
        return { openPath: value.id }
      }
      // Landed, but the host named no single entry (a directory scan): nothing to open.
      onRefresh(current)
      return {}
    }
    if (value.outcome === 'missing') showCopyToast(t('panel.addMissing'))
    else if (value.outcome === 'outside') showCopyToast(t('panel.addOutside'))
    else if (value.outcome === 'not-a-file') showCopyToast(t('panel.addNotAFile'))
    else if (value.outcome === 'unchanged') {
      // The same case the browse dialog names: the file has to be asked for by name
      // (`includeUnchanged`) or it will not be listed at all.
      showCopyToast(t('panel.addUnchanged'))
    } else if (value.outcome === 'empty') showCopyToast(t('panel.addEmpty'))
    else if (value.outcome === 'no-vcs') showCopyToast(t('panel.importNoVcs'))
    else showCopyToast(t('panel.addFailed', { message: value.message ?? '' }))
    return undefined
  }

  /**
   * Pick or unpick one file, bringing the OPEN file along the first time.
   *
   * A Ctrl/Cmd-click starts a pick in front of the file the reader is reading, so that file is part of it:
   * they are gathering rows out of the list they are looking at, and the row the detail pane is showing is
   * one of them. Only when the pick is empty — otherwise the open row could never be clicked OUT of a pick
   * it is already in, and Ctrl-click is the only way to take anything out.
   */
  const pickFile = (id: string): void => {
    // The press just made is where the next Shift press measures from, whatever it did to the pick — a
    // Ctrl press that took the row OUT is still the row the reader last acted on.
    setPickAnchor(id)
    setPickedFiles(current => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
        return next
      }
      if (next.size === 0 && selected !== undefined && selected !== '' && selected !== id) next.add(selected)
      next.add(id)
      return next
    })
  }
  /**
   * Set the pick to exactly the rows between the OPEN file and `id`, both ends included — Shift-click.
   *
   * Shift REPLACES the pick instead of adding to it. The reader names one end by looking at it (the open
   * file) and the other by pressing, and the span between them IS the selection: anything picked earlier
   * that falls outside that span goes. That is what makes the gesture work in both directions — press
   * nearer than last time and the range shrinks, press further and it grows — with the anchor staying put.
   * A stale open file (its row left the list) degrades to the pressed row alone: a Shift press must always
   * leave something selected, since it has just thrown the old pick away.
   */
  const pickRangeTo = (id: string): void => {
    setPickedFiles(() => {
      const to = files.findIndex(file => file.id === id)
      if (to === -1) return new Set()
      const anchorId = pickAnchor ?? selected
      const from = anchorId === undefined || anchorId === ''
        ? -1
        : files.findIndex(file => file.id === anchorId)
      if (from === -1) return new Set([id])
      return new Set(files.slice(Math.min(from, to), Math.max(from, to) + 1).map(file => file.id))
    })
  }

  /**
   * The row a modified press has already picked, so the `click` that follows it does not pick again (a Ctrl
   * toggle would otherwise pick and immediately unpick). A click with no press of its own — a synthetic
   * event, or one an automated harness sends — still picks, because nothing was handled for it.
   */
  const pressHandledRef = useRef<string | undefined>(undefined)
  /**
   * Answer a modified press on a pickable row: Ctrl/Cmd picks that one row, Shift sets the span between the
   * anchor and it. Returns false for an ordinary press, so the caller's own handling runs.
   *
   * The pick happens on the PRESS — `mousedown`, not the `click` that follows at mouseup — because the
   * button paints its own press state the moment the key goes down, and that state looks like a picked row.
   * Picking at mouseup therefore read as a delay: the row under the finger looked picked at once while the
   * rest of a Shift span arrived only on release. One gesture, one pick (see `pressHandledRef`).
   */
  const consumePickPress = (
    event: ReactMouseEvent<HTMLElement>,
    id: string,
    onToggle: (id: string) => void,
    onSpan: (id: string) => void,
  ): boolean => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return false
    // The press of this same gesture has already picked: swallow the click that follows it. A click with no
    // press of ours in front of it is an ordinary click event, and still picks.
    if (event.type === 'click' && pressHandledRef.current === id) {
      pressHandledRef.current = undefined
      return true
    }
    if (event.type !== 'click') pressHandledRef.current = id
    if (event.ctrlKey || event.metaKey) onToggle(id)
    else onSpan(id)
    return true
  }

  const renderEntry = (entry: PendingFileDiff) => (
    <PendingFileRow
      key={entry.id}
      file={entry}
      // The sentence this row's mark wears, from the HOST's answers alone: it scoped the row in through the
      // lineage merge (`viaLineage`) or carries another session's share of it (`hasChildContribution`), and
      // `lineageDirection` says which way that session stands. It is marked, not moved: the row keeps its
      // owner and every decision on it works exactly as it does on one of this session's own — the host
      // resolves the owner for those.
      lineageNote={lineageNoteOf(entry)}
      selected={selected === entry.id}
      picked={pickedFiles.has(entry.id)}
      failedMessage={failed.get(entry.id)}
      t={t}
      onMenu={(event) => {
        // A press ON the pick keeps it and offers the decisions over all of it; a press anywhere else is
        // an ordinary one, and ordinary things end the pick (the same rule the comments tab follows).
        const onPick = pickedFiles.has(entry.id)
        if (!onPick) clearPickedFiles()
        setRowMenu({ file: entry, x: event.clientX, y: event.clientY, picked: onPick })
      }}
      onSelect={(event, id) => {
        // A Ctrl/Cmd or Shift press PICKS — on the press itself, so the pick lands with the button's own
        // press state rather than a mouseup later (see `consumePickPress`).
        if (consumePickPress(event, id, pickFile, pickRangeTo)) return
        // Re-clicking the already-open file jumps to the next diff block in
        // the open file; any other row switches the selection and lands on that
        // file's first change (not the offset it was left at: the reader asked for
        // the file, not for wherever it happened to be). The floating list stays
        // open so you can browse more files; clicking outside the card (or the
        // toggle button) folds it back.
        // An ordinary press is also the reader ACTING on this row, so it becomes the anchor a Shift press
        // measures from — the same rule as a Ctrl press (see `pickAnchor`).
        setPickAnchor(id)
        clearPickedFiles()
        // The dot for the file coming on screen is cleared by the effect above, off `selected`, and
        // nowhere else: a second report from this press would be the same look told to the host twice —
        // and, since the row's flag is still up in the snapshot this press renders from, the effect's own
        // report would follow it. Every other way a file comes on screen (auto-advance, a jump, the
        // restored view) ends in `selected` too, so one reporter covers them all.
        if (id === selected) setJumpSignal(signal => signal + 1)
        else {
          setSelected(id)
          landOn(id)
        }
      }}
    />
  )

  /** The row menu's rows: the pair the file's own toolbar offers, or its single 移出. */
  const rowMenuItems = useMemo<MenuEntry[]>(() => {
    if (rowMenu === null) return []
    if (rowMenu.picked) {
      // The pick's own menu: the SAME four decisions the single row offers, in the same short words. The
      // scope is not in the label — 所有选中 made every row a sentence — it is in the confirmation each
      // row opens, which counts the files, and (for a revert over a row with no earlier version) NAMES the
      // ones about to be deleted via `data-diff-batch-deletes`. So a pick across both kinds says the single
      // row's 回退 / 回退并移出, exactly as the footer says 全部回退: the reader asked for the deed — and the
      // word 删除 — to live in the box, not on a button whose text changes with the selection.
      return [
        { id: 'keep-picked', label: t('row.keepListed') },
        { id: 'keep-remove-picked', label: t('row.keepRemove') },
        { id: 'revert-picked', label: t('action.revert') },
        { id: 'revert-remove-picked', label: t('row.revertRemove') },
      ]
    }
    // The two ways out of the panel, behind a hairline: they act on the FILE, not on the review, so they
    // are a different group from the decisions above — and the open file's own header already has both
    // (the same `open` endpoint with 'open' / 'reveal'), which this simply reaches from the row.
    const openRows: MenuEntry[] = [
      { type: 'separator', id: 'open-separator' },
      { id: 'open-file', label: t('action.openFile') },
      { id: 'open-folder', label: t('action.revealFile') },
    ]
    // Nothing left to KEEP or to PUT BACK: 移出 is the only decision, and the two ways out still apply to
    // the file. A row gets here when its content already matches the baseline (`fileHasNoDiff`) — it was
    // kept or put back and left listed, so there is nothing to accept and nothing to restore.
    if (fileHasNoDiff(rowMenu.file)) {
      return [{ id: 'remove', label: t('row.dismiss') }, ...openRows]
    }
    // Put back wins a second reading too: 回退 puts the file back and leaves it listed, so a file
    // with more than one operation can be put back one at a time while staying in view.
    const revertLabel = rowMenu.file.earlierVersion === 'none' ? t('action.delete') : t('action.revert')
    return [
      // Keeping is two decisions, not one, and the row menu names both: plain 保留 accepts the change
      // and leaves the file in the list, 保留并移出  does the same and takes the row out. The pair is
      // one character apart by design — the tail says what happens to the list.
      { id: 'keep-listed', label: t('row.keepListed') },
      { id: 'keep-remove', label: t('row.keepRemove') },
      { id: 'revert', label: revertLabel },
      // 回退并移出  is the same pair on the other decision — put the file back and take the row out — and
      // it names the same action `revertLabel` just named: with no earlier version to write back the
      // whole-file action DELETES the file, so the row says 删除并移出 rather than promising a revert.
      {
        id: 'revert-remove',
        label: rowMenu.file.earlierVersion === 'none' ? t('row.deleteRemove') : t('row.revertRemove'),
      },
      ...openRows,
    ]
  }, [rowMenu, pickedFiles, files, t])

  /** Run a row-menu choice through the same handlers the open file uses. 移出 is a keep: the
   *  host folds the content and drops the entry, so the file itself is left alone. The `并移出`
   *  rows say so explicitly rather than taking the toolbar's confirm-first default. The session
   *  is the one being VIEWED (`current`), not `target.file.sessionId`: a row can list a file
   *  another session touched, and the decision — and the undo that follows it — is the reader's. */
  const runRowMenu = (id: string): void => {
    const target = rowMenu
    setRowMenu(null)
    if (target === null || current === undefined) return
    if (target.picked) {
      // The pick's four decisions all ask before they run (see `batchPrompt`): each one is a single press
      // that settles several files, and the dialog is where the reader sees how many — and, for a revert,
      // which of them are about to be DELETED, the one part of this that cannot be undone.
      //
      // Only the files the list still holds: a row that left it cannot be decided on, and naming it in
      // the request would be asking the host about a file the reader can no longer see.
      const picked = files.filter(file => pickedFiles.has(file.id))
      const ids = picked.map(file => file.id)
      if (ids.length === 0) { clearPickedFiles(); return }
      if (id !== 'keep-picked' && id !== 'keep-remove-picked'
        && id !== 'revert-picked' && id !== 'revert-remove-picked') return
      // The pick stays until the dialog is answered, so cancelling leaves the reader where they were.
      const doomed = id.startsWith('revert')
        ? picked.filter(file => file.earlierVersion === 'none').map(file => file.id)
        : []
      setBatchPrompt({ sessionId: current, kind: id, ids, doomed })
      return
    }
    // 移出, 保留并移出 and 回退并移出 DROP the entry, and a dropped entry takes its comments with it (see
    // `dropEntry`): when the file has any, the press is confirmed first rather than running on the spot. A
    // file with no comments keeps the one-press it has always had.
    if ((id === 'keep-remove' || id === 'remove' || id === 'revert-remove')
      && commentsOn([target.file.id]).count > 0) {
      setBatchPrompt({
        sessionId: current,
        kind: id === 'remove' ? 'remove-one' : id === 'keep-remove' ? 'keep-remove-one' : 'revert-remove-one',
        ids: [target.file.id],
        doomed: [],
      })
      return
    }
    if (id === 'keep-listed') void onKeep(current, target.file.id, true)
    else if (id === 'keep-remove' || id === 'remove') void onKeep(current, target.file.id)
    // The revert pair is the KEEP pair's shape: plain 回退 writes the baseline back and LEAVES the row
    // listed (nothing left to show, like a kept file), 回退并移出 does the same and drops it. It used to be
    // wired the other way round — the row that said 移出 stayed and the one that did not say it went.
    else if (id === 'revert') void onRevert(current, target.file.id, true)
    else if (id === 'revert-remove') void onRevert(current, target.file.id)
    // Opening is not a decision about the review, so it takes the FILE's own session — the one the header's
    // two icon buttons pass — rather than the session being viewed.
    else if (id === 'open-file') void onOpen(target.file.sessionId, target.file.id, 'open')
    else if (id === 'open-folder') void onOpen(target.file.sessionId, target.file.id, 'reveal')
  }

  const selectedFile = files.find(file => file.id === selected)
  /**
   * Every comment the session's files carry, grouped by the file it hangs in: what the comments tab
   * shows. The session is the scope — every file of it that is still in the list, whether or not the
   * reader has opened it, and however many files that is — and the file is what the comments are
   * grouped by, under the file's own name.
   *
   * A comment IS a block of rows in one file, so its label is the lines it is on — the `path:lines`
   * reference the thread's own header wears, with the path left off (the group above IS that file) and
   * nothing in front of the numbers, which are the whole label at that point. Its title is the first
   * sentence of what the reader asked (the first turn is the annotation; later ones are follow-ups), and
   * an outdated one says so — the same state the block itself is wearing (see `[data-lost]`).
   *
   * The list reads in the order things were ADDED, not the order the code runs. A walkthrough's cards sit
   * wherever the lines they are about sit — often not in reading order, and often in different files — and
   * what tells the reader which comes next is when it arrived (and, for a flow, the number its own header
   * carries). So the items of a group keep their arrival order, and the groups themselves are ordered by
   * the first card each one gained. The host hands them over oldest-first (`CommentStore.list`); this
   * sorts on the record's own `createdAt` regardless, so a payload that stopped being ordered that way
   * could not quietly turn the list back into a second view of the file.
   *
   * The records come from the snapshot, which is also where they go: a comment is the host's, shared
   * with every client of the session, and this pane is a second view of it rather than a second copy
   * (see `PendingDiffSnapshot.comments`). The lines come from the host too (`snapshot.commentLines`):
   * it resolved each quote against the entry's current content, so an item names the same line the
   * open card does — and names it for a file this panel has never opened, which the detail's own
   * re-anchoring could only do once the reader had opened it. A comment the host could not place
   * keeps `record.anchor`, the line it was written on (see `jumpToComment` for the landing).
   */
  const commentGroups = useMemo(() => {
    const byFile = new Map<string, CommentRecord[]>()
    for (const record of snapshot.comments) {
      const list = byFile.get(record.entryId)
      if (list === undefined) byFile.set(record.entryId, [record])
      else list.push(record)
    }
    /** When a group's first card arrived: what the groups themselves are ordered by. */
    const firstAdded = (records: readonly CommentRecord[]): number =>
      records.reduce((earliest, record) => Math.min(earliest, record.createdAt), Number.POSITIVE_INFINITY)
    return [...byFile]
      .flatMap(([fileId, records]) => {
        // A comment whose file has left the list is not shown at all: this pane lists what the session
        // still has pending, and the row such a card hangs under left the list with the file.
        const file = files.find(candidate => candidate.id === fileId)
        return file === undefined ? [] : [{ file, records }]
      })
      // The groups follow the first card each one gained, the way the items inside them follow their own
      // arrival — so a walkthrough that moves between files reads in the order it was written.
      .sort((left, right) => firstAdded(left.records) - firstAdded(right.records))
      .map(({ file, records }) => ({
        fileId: file.id,
        // The file's own name: what the file list shows it as, and what the reader calls it. Two files of
        // the same name in different directories then share a heading, which is what the path in each
        // comment's own reference is for (`:8` names the lines there, the block names the file in full).
        name: basenameOf(file.path),
        // …and the full path, which is what an item names on hover: a name can be shared, and this is how
        // the reader tells which file a comment is in without opening it.
        path: file.path,
        // The items keep their arrival order (oldest first). `sort` is stable, so cards stamped in the
        // same millisecond — several placed in one turn — keep the order the store handed them over in,
        // which is the order they were added.
        entries: [...records].sort((left, right) => left.createdAt - right.createdAt).map(record => {
          const written = commentTitle(record.text)
          const empty = written === ''
          // Where the comment is NOW, as the host resolved it, and where the record says it was
          // WRITTEN when the host could not place it (its quote is gone): a comment is listed either
          // way, and its item wears the numbers the card's own header wears.
          const resolved = snapshot.commentLines[record.id]
          const start = resolved?.start ?? record.anchor.startLine
          const end = resolved?.end ?? record.anchor.endLine
          // The numbers a comment the host could not place carries are the OLD file's when its frame
          // held no current line at all: the item says so, the way the card's own header does.
          const oldOnly = resolved === undefined && frameNamesNoCurrentLine(record.quoteLines)
          return {
            id: record.id,
            fileId: file.id,
            // The lines the comment's box hangs below: the LAST one, because the box sits under the
            // row its range ends in, and that row is what a jump to the box has to name.
            line: end,
            // …and the same numbers are what the jump resolves, so it is told which file they came
            // from: it lands on the REMOVAL that carries that old number rather than on whatever
            // current line now reads it (see `frameNamesNoCurrentLine`).
            oldSide: oldOnly,
            // The file itself is the group above, so the reference is cut to what is left of it: the lines
            // it names — `[8]`, or `[10-17]` for a range — bracketed so the row opens with a marker rather
            // than with a bare digit that could be anything.
            label: `[${lineRangeLabel(start, end)}]${oldOnly ? t('discussion.deletedLabel') : ''}`,
            // Nothing written yet: the item says what the comment box is asking for, in the box's own
            // words (a comment the host holds with no text is one the reader never finished; the panel
            // does not write those, but a record from elsewhere can be one).
            title: empty ? t('discussion.placeholder') : written,
            empty,
            // What the host has not been told the reader has looked at: the row's own dot, carried through
            // untouched for the same reason the card's is (see the discussion the code view builds). It is
            // the ONLY dot that can reach a reader who is not on this comment's file: the card's is drawn
            // in the code view, which renders the selected file alone, and the file row's is about the
            // file rather than about the thread.
            ...(record.unseen === true ? { unseen: true } : {}),
          }
        }),
      }))
      .filter(group => group.entries.length > 0)
  }, [files, snapshot.comments, snapshot.commentLines, t])
  /** The same comments, flat: what the tab counts and what says whether there are any. */
  const commentEntries = useMemo(() => commentGroups.flatMap(group => group.entries), [commentGroups])
  /**
   * Set the comment pick to the span between the anchor and `id`, both ends included — Shift-click.
   *
   * The same rule the file list follows (see `pickRangeTo`): Shift REPLACES the pick, the anchor is where
   * the last non-Shift press landed, and Shift never moves it — so pressing Shift again measures from the
   * same place and the span can shrink as well as grow. The span follows the RENDERED order, which is the
   * order the reader sees: comments grouped by file, and inside a group the file's own comments — so a span
   * may cross a file boundary, exactly as it reads on screen. With no anchor yet (nothing pressed in this
   * tab), the pressed comment is the whole selection.
   */
  const pickCommentRangeTo = (id: string): void => {
    setPickedComments(() => {
      const ids = commentEntries.map(entry => entry.id)
      const to = ids.indexOf(id)
      if (to === -1) return new Set()
      const from = commentAnchor === undefined ? -1 : ids.indexOf(commentAnchor)
      if (from === -1) return new Set([id])
      return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
    })
  }
  /** Open the file a comment hangs in and land on the thread's own box, not on the rows it names:
   *  the box hangs below the range it ends in, and the code an outdated comment named may be gone
   *  altogether, so "show me this comment" means the comment rather than the code under it. The line
   *  handed over is the one the panel believes the comment is on — the detail's own resolved line when
   *  that file has been opened, the record's stored one otherwise (see `commentGroups`) — and the
   *  thread's own id goes with it: the detail holds the block, so it can put the row the box actually
   *  hangs at under the reader without depending on a number this list can only guess at. `oldSide`
   *  says which file that fallback number came from: a frame of removed rows alone holds an OLD-file
   *  line, and the detail lands on the removal carrying it rather than on the current line that now
   *  reads that number (see `frameNamesNoCurrentLine`). */
  const jumpToComment = (fileId: string, line: number, id: string, oldSide: boolean): void => {
    if (fileId !== selected) setSelected(fileId)
    landOn(fileId, undefined, undefined, true, line, id, oldSide)
  }
  /**
   * The comment menu's rows: the action a thread has, named exactly as the block's own overflow menu
   * names it — ending a comment is one thing, and the pane it is asked from must not look like it does
   * something else. Opened on a pick, it says what it will actually end: the whole pick, not the one row
   * the press happened to land on.
   */
  const commentMenuItems = useMemo<MenuEntry[]>(
    // One word for both: what the menu says does not change with the pick — the confirmation that
    // follows says how many comments it is about to close.
    () => [{ id: commentMenu?.picked === true ? 'close-picked' : 'close', label: t('action.discussionEnd') }],
    [commentMenu?.picked, t],
  )
  /**
   * The chip menu's rows: the two ways a produced file can be opened now that this plugin is holding
   * it. The first is DSH's own open — the press the reader made, replayed by `replayFilePress`, which
   * is the only way to run it faithfully (what the harness does with that press is its business) — and
   * the second is this panel, which is the whole reason the press was taken over. The third is not a
   * way to open it at all: it hands back the path the shell itself gave the menu.
   */
  const chipMenuItems = useMemo<MenuEntry[]>(() => [
    { id: 'default', label: t('chip.openDefault') },
    { id: 'review', label: t('chip.reviewInPanel') },
    { id: 'copy-path', label: t('chip.copyPath') },
  ], [t])
  /** Open the produced file the chip menu was raised for, the way the reader chose. */
  const runChipMenu = (id: string): void => {
    const target = chipMenu
    setChipMenu(null)
    if (target === null) return
    if (id === 'default') {
      // The press is looked up by path rather than kept: the row is React's and may have re-rendered
      // between the press and this pick, and a stale element would swallow the press in silence.
      if (!replayFilePress(target.path)) showCopyToast(t('chip.gone'))
      return
    }
    if (id === 'copy-path') {
      // The path is copied exactly as the shell handed it over — the Markdown link's own spelling, the
      // `@file` token with its `@` and quotes already stripped, or the absolute path a changed-files
      // row carries. This menu has no spelling of its own to prefer, so it invents none: a conversion
      // here would copy a path the reader never pointed at. The toast is the acceptance, not the
      // attempt — a host that refused the write has copied nothing to confirm.
      void writeClipboard(target.path).then((accepted) => { if (accepted) showCopyToast(t('action.copied')) })
      return
    }
    if (id !== 'review') return
    window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: { path: target.path } }))
  }
  /**
   * End what the comment menu was opened on: that one comment, or every picked one.
   *
   * A comment belongs to the host, so ending it is a host action like the block's own menu offers: the
   * record goes, and the next read is what takes the block out of the open file (and the item out of this
   * list). The pick goes as ONE request: it is one action the reader asked for, the host drops the whole
   * batch in one write, and the list reads once when it is done rather than dismantling itself between
   * comments. A refusal is said out loud rather than leaving an item the reader believes they removed.
   */
  const runCommentMenu = (id: string): void => {
    const target = commentMenu
    setCommentMenu(null)
    if (target === null || current === undefined) return
    if (id === 'close-picked') {
      const ids = [...pickedComments]
      if (ids.length === 0) { clearPicked(); return }
      // The pick stays until the dialog is answered, so cancelling leaves the reader where they were.
      setBatchPrompt({ sessionId: current, kind: 'close-picked', ids, doomed: [] })
      return
    }
    if (id !== 'close') return
    void onCommentRemove(current, target.id).catch((error: unknown) => {
      showCopyToast(error instanceof Error ? error.message : String(error))
    })
  }
  /**
   * The folded card's own box, derived from the measured one, or undefined while
   * the list is not folded open. The card and its width grip are both placed from
   * these numbers, which is what keeps the grip on the card's right edge as the
   * width changes.
   */
  const floatCard = !floatMode || !floatOpen || files.length === 0 || floatBox === null
    ? undefined
    : {
        left: floatBox.left + FLOAT_LIST_MARGIN_PX,
        top: floatBox.top + FLOAT_LIST_MARGIN_PX,
        width: Math.min(listWidth, Math.max(0, floatBox.width - 2 * FLOAT_LIST_MARGIN_PX)),
        height: Math.max(0, floatBox.height - 2 * FLOAT_LIST_MARGIN_PX),
      }
  /** The file whose removal is being confirmed (a last-block action), if any. */
  const promptFile = blockPrompt === null ? undefined : files.find(file => file.id === blockPrompt.id)
  /** The file whose removal is being confirmed (a whole-file action), if any. */
  const promptEntry = filePrompt === null ? undefined : files.find(file => file.id === filePrompt.id)
  /**
   * The comments a set of files carries: how many files, how many comments, and one ITEM per file for the
   * confirmation's list. Every file bearing a comment is in `items` — the run used to be cut off at three
   * here ("… 等 4 个文件", a truncation path since deleted), which hid exactly the files the
   * reader opens this box to check; the box's own height is what gives instead (see `.confirmList`).
   */
  const commentsOn = (ids: readonly string[]): {
    files: number
    count: number
    items: readonly { id: string; path: string; name: string; count: number }[]
  } => {
    const perFile = new Map<string, number>()
    for (const record of snapshot.comments) {
      if (!ids.includes(record.entryId)) continue
      perFile.set(record.entryId, (perFile.get(record.entryId) ?? 0) + 1)
    }
    const items = files
      .filter(file => perFile.has(file.id))
      .map(file => ({ id: file.id, path: file.path, name: basenameOf(file.path), count: perFile.get(file.id) ?? 0 }))
    return {
      files: items.length,
      count: items.reduce((sum, item) => sum + item.count, 0),
      items,
    }
  }
  /** What the dialog says about the comments a removal would take with it (empty when there are none). */
  const batchCommentsText = (): string => {
    if (batchPrompt === null) return ''
    const on = commentsOn(batchPrompt.ids)
    if (on.count === 0) return ''
    if (batchPrompt.ids.length === 1) {
      const file = files.find(entry => entry.id === batchPrompt.ids[0])
      return t('panel.removeCommentsOne', { file: basenameOf(file?.path ?? ''), count: on.count })
    }
    // `list` is emptied the way the delete sentence's `files` is (see `batchDoomed`): the wording and its
    // closing colon stay byte-identical, and the names follow as the list block below instead of a run
    // cut short inside the sentence.
    return t('panel.removeCommentsMany', { files: on.files, count: on.count, list: '' })
  }
  /**
   * The files whose comments a held batch would close: one item per file, for the list under the sentence.
   * Empty for the single-file press, which names its one file inside the sentence itself
   * (`panel.removeCommentsOne`) and has no run to cut short.
   */
  const batchCommentFiles = batchPrompt === null || batchPrompt.ids.length === 1
    ? []
    : commentsOn(batchPrompt.ids).items
  /** The files a held batch-revert would delete, in the order the list holds them. EVERY one of them is
   *  drawn — the reader asked for the names, and a run of names cut off at three ("…等 9 个") is exactly
   *  what they asked to stop: the dialog is where they recognise what is about to go, and a name that is
   *  not there is one they cannot check. The list's height is what gives, not the list (see
   *  `.confirmDeleteList`). */
  const batchDoomed = batchPrompt === null
    ? []
    : batchPrompt.doomed
        .map(id => files.find(file => file.id === id))
        .filter((file): file is PendingFileDiff => file !== undefined)

  // The list pane's header (its tabs, and the fold-away toggle), its scrollable rows, and the pinned
  // bulk footer, shared by the in-flow left pane and the floating (collapsed) overlay. Only the rows
  // scroll: the header and the footer stay put.
  const fileListBody = (
    <>
      {files.length > 0 && (
        <div className={css.listHead}>
          {/* One view is not a choice: with nothing to switch between, the same spot says which
              list this is instead of offering a single tab. */}
          {listTabs.length > 1 ? (
            <div className={css.listTabs} role="tablist" aria-label={t('panel.tabs')}>
              <button
                type="button"
                role="tab"
                className={css.listTab}
                data-diff-list-tab="pending"
                aria-selected={activeTab === 'pending'}
                onClick={() => { setListTab('pending') }}
              >
                {t('panel.tab.pending')}
              </button>
              <button
                type="button"
                role="tab"
                className={css.listTab}
                data-diff-list-tab="comments"
                aria-selected={activeTab === 'comments'}
                onClick={() => { setListTab('comments') }}
              >
                {/* The count rides the label, and nothing at all when there is nothing to count: a
                    zero would say "there is a list here" to a reader with no comments. The two are
                    separate spans so the row's own gap sets the space between them. */}
                <span>{t('panel.tab.comments')}</span>
                {commentEntries.length > 0 && (
                  <span className={css.tabCount} data-diff-list-count>{commentEntries.length}</span>
                )}
              </button>
            </div>
          ) : (
            <h3 className={css.listTitle} data-diff-list-title>{t(`panel.tab.${activeTab}`)}</h3>
          )}
          {/* The tabs take the room up to the toggle themselves (the strip is the flexible item), so
              the spacer is only what pushes the toggle over when a lone title leaves the row slack. */}
          {listTabs.length <= 1 && <span className={css.flexSpacer} />}
          {/* Fold the list away for good, whatever the width allows. The choice is stored, so it
              survives a reopen. */}
          <Tooltip label={t(forceFloat ? 'action.fileListFloatOff' : 'action.fileListFloatOn')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={`${css.action} ${css.addButton} ${css.listFold}`}
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
      {listTab === 'comments' ? (
        <div className={css.listScroll} data-diff-list-scroll>
          {commentEntries.length === 0
            ? <p className={css.listEmpty} data-diff-comments-empty>{t('panel.commentsEmpty')}</p>
            : (
              /* The session's comments as one tree, a file to a group. Nothing folds: every group is
                 open, and its name is a heading rather than a control, so the list stays a way to the
                 comments themselves. */
              <div data-diff-comment-list>
                {commentGroups.map(group => (
                  <div key={group.fileId} className={css.commentGroup} data-diff-comment-group={group.fileId}>
                    {/* The group names the file the short way the file list does, and a name can be shared:
                        a hover here is where the file is named in full. */}
                    <Tooltip label={group.path} delayMs={500} maxWidth={560}>
                      <h4 className={css.commentGroupName} data-diff-comment-group-name>{group.name}</h4>
                    </Tooltip>
                    <ul className={css.rows}>
                      {group.entries.map(entry => (
                        <li key={entry.id} className={css.row}>
                          {/* A control, but deliberately NOT a `<button>`: dsh-pocket's narrow-layout guard
                              swallows the click on any `button, a` whose text looks like a file path — it
                              answers with "you cannot open a file from the phone" instead of letting the
                              press through — and this item's text can look like one (its label is a line
                              reference, and the reader's own words often name a file). It is still
                              reachable and operable: focusable, and Enter or Space jumps.
                              `data-mobile-nav-copy` is pocket's own "already handled" mark, kept so it adds
                              no copy-file button here either — this is a way to a comment, not a file. */}
                          <div
                            role="button"
                            tabIndex={0}
                            className={css.commentRow}
                            data-diff-comment-link={entry.id}
                            data-mobile-nav-copy="1"
                            // The row wears the pick the way a picked tree row does: a state, not a hover.
                            data-selected={pickedComments.has(entry.id) ? '' : undefined}
                            aria-pressed={pickedComments.has(entry.id)}
                            // The jump names the lines the comment was written on. Whether they still
                            // hold that code is the block's own state, which the detail re-anchors
                            // against its row model — this pane does not guess at it.
                            onMouseDown={(event) => {
                              // A modified press is the pick, taken on the press itself (see
                              // `consumePickPress`) so it lands with this row's own press state.
                              consumePickPress(
                                event, entry.id,
                                (id) => { setCommentAnchor(id); togglePicked(id) },
                                pickCommentRangeTo,
                              )
                            }}
                            onClick={(event) => {
                              // Ctrl/Cmd-click PICKS instead of jumping: the reader is gathering a few
                              // comments for one action, and a jump would take them out of the list they
                              // are picking from (see `pickedComments`).
                              if (consumePickPress(
                                event, entry.id,
                                (id) => { setCommentAnchor(id); togglePicked(id) },
                                pickCommentRangeTo,
                              )) return
                              // An ordinary press is a jump, and it is also the reader ACTING on this
                              // comment, so it becomes the anchor a Shift press measures from.
                              setCommentAnchor(entry.id)
                              clearPicked()
                              jumpToComment(entry.fileId, entry.line, entry.id, entry.oldSide)
                            }}
                            onContextMenu={(event) => {
                              // The browser's own menu has nothing to say about a comment, and the actions
                              // a thread has are the whole of what it could offer — the same press on a
                              // file row opens that row's actions (see `PendingFileRow`). A press ON the
                              // pick keeps it and acts on all of it; a press anywhere else is an ordinary
                              // one, and ordinary things end the pick.
                              event.preventDefault()
                              const onPick = pickedComments.has(entry.id)
                              if (!onPick) clearPicked()
                              setCommentMenu({ id: entry.id, fileId: entry.fileId, x: event.clientX, y: event.clientY, picked: onPick })
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              clearPicked()
                              jumpToComment(entry.fileId, entry.line, entry.id, entry.oldSide)
                            }}
                          >
                            {/* The card's own dot, on the row that is always there to carry it: the code
                                view renders the SELECTED file alone, so a comment on a file the reader is
                                not looking at has no card on screen — and with no card there is nowhere for
                                its dot to appear. This row is that place. Same mark as the card's, out of
                                flow to the LEFT of the row's own content (the row is the containing block,
                                see `.commentRow`), naming itself on `aria-label` / a `<title>` child —
                                an SVG has no `title` attribute. What clears it is unchanged: this row is
                                how the reader reaches the card, and the card coming into view is what
                                tells the host the attention is spent. */}
                            {entry.unseen === true && (
                              <svg className={css.unseenDot} data-diff-comment-unseen width="3" height="3" viewBox="0 0 3 3" role="img" aria-label={t('panel.unseen')}>
                                <title>{t('panel.unseen')}</title>
                                <circle cx="1.5" cy="1.5" r="1.5" fill="var(--dsw-alias-state-business-primary)" />
                              </svg>
                            )}
                            {/* One line: what was asked, then where in the file it sits — the title takes
                                the room and reads from the left, the line numbers sit at the row's right
                                edge, so a file's comments line up on the side the eye scans them by. */}
                            <span className={css.commentHead}>
                              <span
                                className={entry.empty ? `${css.commentTitle} ${css.commentTitleEmpty}` : css.commentTitle}
                                data-diff-comment-title
                                data-diff-comment-empty={entry.empty ? '' : undefined}
                              >{entry.title}</span>
                              <span className={css.commentLabel} data-diff-comment-label>{entry.label}</span>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
        </div>
      ) : (
        <>
          <div className={css.listScroll} data-diff-list-scroll>
            {files.length > 0 && <ul className={css.rows}>{files.map(renderEntry)}</ul>}
          </div>
          {files.length > 0 && (
            <div className={css.bulkActions}>
              {/* The list's two decisions, in EVERY state it can be in: a button that changed shape — or
                  word — with the selection is what the reader was correcting. 全部保留 always has every row
                  to act on: it folds each entry and drops it, which is the one decision a row with nothing
                  left to review still has. 全部回退 acts on the rows that still have something to put back
                  (`bulkRevertFiles`), so it is DISABLED when that set is empty rather than left armed to
                  open a confirmation that names nothing and then changes nothing — the words stay put
                  either way, and the dimming is the shape's (see `.bulkActions .action:disabled`). */}
              <button
                type="button"
                className={`${css.action} ${css.actionPrimary}`}
                data-diff-keep-all
                disabled={bulkBusy !== null}
                onClick={() => { askBulk('keep') }}
              >
                {bulkBusy === 'keep' ? t('action.busy') : t('action.keepAll')}
              </button>
              <button
                type="button"
                className={css.action}
                data-diff-revert-all
                disabled={bulkBusy !== null || bulkRevertFiles.length === 0}
                onClick={() => { askBulk('revert') }}
              >
                {/* 全部回退, whatever the list holds: the rows decide whether this DELETES their files,
                    writes them back, or does both, and the reader asked for that deed to be named in the
                    CONFIRMATION rather than on the button (see `batchAskOf`). A button that changed its
                    word with the selection was the thing they were correcting. */}
                {bulkBusy === 'revert' ? t('action.busy') : t('action.revertAll')}
              </button>
              {/* Add goes last, past the decisions: it is how a path JOINS the list, and the two
                  decisions to its left are about the files already in it. Its own mark and label, so
                  a third button in the row is read as a way in rather than as another decision. */}
              <button
                type="button"
                className={`${css.action} ${css.addPath}`}
                data-diff-add
                aria-label={t('action.addPath')}
                onClick={() => { setAddOpen(true) }}
              >
                <IconPlusOutline16 size={12} />
                {t('panel.addPathGo')}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )

  // Undo/redo resolves to the affected entry id while it is still pending.
  // The panel then selects that file, or — when it is already the open one —
   const handleUndo = async (sessionId: SessionId): Promise<void> => {
    const id = await onUndo(sessionId)
    if (id === undefined) return
    if (id === selected) setUndoFlash(signal => signal + 1)
    else {
      setSelected(id)
      landOn(id)
    }
  }
  const handleRedo = async (sessionId: SessionId): Promise<void> => {
    const id = await onRedo(sessionId)
    if (id === undefined) return
    if (id === selected) setUndoFlash(signal => signal + 1)
    else {
      setSelected(id)
      landOn(id)
    }
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
    // The chord belongs to whichever instance is on screen: the overlay while it is open, the sidebar tab
    // while the panel is docked. `open` is the OVERLAY's own flag and stays false in a tab, so a guard that
    // checked it alone made Ctrl+Z/Ctrl+Y dead keys for anyone reviewing from the sidebar. (The mounts stand
    // down for each other — an overlay closes as the dock takes over — so any overlap is a frame, and the
    // host is what pops, not this listener.)
    if ((!open && !docked) || current === undefined) return
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
      if (next !== undefined) {
        // Cycling is a switch like a click on the list: the file opens at its
        // first change rather than at wherever it was last left.
        setSelected(next.id)
        landOn(next.id)
      }
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

  // Edge floats its own "mini menu" (copy / search / define) over a text selection once the
  // mouse is released. It is browser chrome — not an element, and it ignores `contextmenu`'s
  // preventDefault — but it does wait on the release's default action, so taking that away
  // inside our own surface holds it back while leaving selection itself untouched. Only our
  // surface: the app's own DOM is not ours to change, and a field the reader may be selecting
  // text in keeps the browser's own UI (a menu over an input is not in the way of anything).
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      const target = event.target
      const panel = panelRef.current
      if (panel === null || !(target instanceof Node) || !panel.contains(target)) return
      if (target instanceof Element && target.closest('input, textarea, [contenteditable]') !== null) return
      event.preventDefault()
    }
    // Capture, so the release is marked handled before anything downstream can act on it, and
    // on the window, because the panel is portalled into the page rather than nested in us.
    window.addEventListener('mouseup', onMouseUp, true)
    return () => { window.removeEventListener('mouseup', onMouseUp, true) }
  }, [])

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
      // The detail header's path field keeps its own Escape — it puts the shown path back —       // so this press belongs to the field and never to the panel behind it.
      if (event.target instanceof Element && event.target.closest('[data-diff-path-input]') !== null) return
      // The coverage popover is the innermost dismissible while it is up, and it
      // closes on this same press.
      if (document.querySelector('[data-diff-approval-cover-popover]') !== null) return
      // An open MENU is the innermost dismissible as well: this press closes the menu, which listens for
      // the same key — and the panel behind it must stand. This handler is on `window` in the CAPTURE
      // phase, so it runs before the menu's own and cannot be stopped by it: the exemption has to be here.
      // Folding the panel on this press would lose the list the reader was answering (its pick, its
      // scroll, the file it had open) to a key they pressed to shut a menu.
      if (document.querySelector('[role="menu"]') !== null) return
      // The batch confirmation this panel raised is answered by this same key: 取消 is what Escape means
      // there, and the panel stays up behind it.
      if (batchPrompt !== null) {
        setBatchPrompt(null)
        return
      }
      const target = event.target
      const inPanel = target instanceof Node && panelRef.current?.contains(target) === true
      if (inPanel && document.querySelector('[data-diff-searchbar]') !== null) return
      // The go-to popup is the innermost dismissible too, and its own Escape is what closes it — the same
      // rule the search bar gets, so one press never takes the popup AND the panel behind it.
      if (inPanel && document.querySelector('[data-diff-goto-dialog]') !== null) return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, docked, batchPrompt])

  /**
   * Drag the list's width, from a mouse *or* a finger. Pointer events rather than
   * mouse ones, because a touch drag never produces the mouse events this used to
   * wait for: the browser's synthetic `mousemove` does not exist, and the synthetic
   * `mousedown`/`mouseup` pair arrives together at the *end* of the gesture — so on
   * a phone the grip read as a tap and the width never changed. The handles also
   * declare `touch-action: none` (see the stylesheet), without which the browser
   * would take the drag as a pan and cancel the pointer stream outright.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Primary button or finger only: a right-click, or a second finger landing
    // mid-drag, is not a resize.
    if (event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = listWidth
    // The folded card floats inside the code view, so that view's box is its own
    // ceiling: a drag past the code's right edge stops there rather than storing a
    // width the card has no room to show.
    const cap = floatMode && floatBox !== null
      ? Math.max(MIN_LIST_WIDTH_PX, floatBox.width - 2 * FLOAT_LIST_MARGIN_PX)
      : MAX_LIST_WIDTH_PX
    // Keep the moves coming when the pointer leaves the grip (a mouse dragged out
    // of the card, a finger that strays): a touch pointer is captured implicitly,
    // and this captures a mouse. jsdom has no `setPointerCapture`, hence the guard.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Not implemented here; the window listeners below still carry the drag.
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    // One width per animation frame, not one per pointer event. A mouse reports at 125— 000Hz
    // while the screen draws at 60— 20, so most of those events would re-render the list — and,
    // with wrap on, re-wrap the whole code view — for positions nobody ever sees; the frame's own
    // render is the one that shows. The frame takes the LAST position of the events it absorbed.
    let latest = startWidth
    let pending = 0
    const onMove = (move: PointerEvent) => {
      latest = Math.min(Math.max(startWidth + (move.clientX - startX), MIN_LIST_WIDTH_PX), cap)
      if (pending !== 0) return
      pending = requestAnimationFrame(() => {
        pending = 0
        setListWidth(latest)
      })
    }
    // `pointercancel` is the browser taking the gesture over (a pan it decided to
    // start, a system gesture): the drag ends there, like a release.
    const finish = (): void => {
      // A release inside the same frame as the last move would otherwise land the width one frame
      // behind where the reader let go, so the position the drag ended at still goes in — once.
      if (pending !== 0) {
        cancelAnimationFrame(pending)
        pending = 0
        setListWidth(latest)
      }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  /**
   * End the text selection when the press lands on the panel's chrome — blank space, a label, the
   * toolbar, the file list — or on a row the selection already covers (see `pressOnSelectedRow`).
   *
   * The chrome is `user-select: none` (see `.panel`), and a press on such an area is one the
   * browser does NOT clear the selection for: the highlight stayed up, and so did the selection
   * frame that goes with it, over a gesture that plainly ended. The same is true inside the code
   * view when the press lands on the selection's own row, which is the one content press the panel
   * ends itself. What IS content is otherwise left to the browser — which is also what keeps a drag
   * started on chrome able to select the code it runs into, since dropping the ranges first costs
   * the drag nothing.
   */
  const onPanelMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const live = window.getSelection()
    // The selection frame is about the selection: a press on it must not drop it (see
    // `KEEPS_SELECTION`).
    if (target.closest('[data-diff-selection-actions], [data-diff-copy]') === null
      && pressOnSelectedRow(target, live)) {
      if (typeof live?.removeAllRanges === 'function') live.removeAllRanges()
      return
    }
    if (target.closest(KEEPS_SELECTION) !== null) return
    if (typeof live?.removeAllRanges === 'function') live.removeAllRanges()
  }

  // Docked, the panel is a sidebar tab: it fills the tab body the dock body
  // handed it, so it draws no layer of its own. That layer is the footer seat's
  // box (42px plus margins) and would push the tab content past its own height —   // the sidebar body then scrolls and shows a blank strip under the panel.
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
      {/* The produced-file chip's menu. It hangs under a chip in the conversation, so it is drawn
          here — outside the panel's own frame, which a closed panel does not render at all — and it
          is a portal like every other menu, so nothing about the panel's layout can clip it. */}
      {chipMenu !== null && (
        <Menu
          open
          portal
          compact
          items={chipMenuItems}
          onSelect={runChipMenu}
          onClose={() => { setChipMenu(null) }}
          getAnchorRect={() => new DOMRect(chipMenu.x, chipMenu.y, 0, 0)}
          anchor={<span className={css.rowMenuAnchor} />}
        />
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
            onMouseDown={onPanelMouseDown}
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
              <Tooltip label={closeTip.label} shortcutKeys={closeTip.shortcutKeys} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.close}
                  data-diff-approval-close
                  aria-label={t('action.close')}
                  aria-keyshortcuts={closeTip.aria}
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
                    // The card covers the knob but not its glow, which would otherwise
                    // fringe past the card's corner while the list is open: the halo is
                    // for the button standing on its own (see `.fileListKnob[data-open]`).
                    data-open={floatOpen || undefined}
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
              {!floatMode && <div className={css.resizeHandle} data-diff-resize onPointerDown={startResize} />}
              <div className={css.detail} data-diff-detail>
                {/* The detail belongs to a session: without one there is no list to have
                    picked a file from, and nothing that could answer a comment. */}
                {selectedFile === undefined || current === undefined ? (
                  <p className={css.detailEmpty}>{t('panel.selectHint')}</p>
                ) : (
                  <PendingDiff
                    file={selectedFile}
                    sessionId={current}
                    busy={snapshot.busy.has(selectedFile.id)}
                    workspacePath={snapshot.workspacePath}
                    jumpSignal={jumpSignal}
                    undoFlash={undoFlash}
                    // The offset this file should open at, when this showing resumed
                    // a remembered view: absent means the file's first change. The
                    // tick makes a repeated request for the same file land again.
                    landingTop={landing !== undefined && landing.fileId === selectedFile.id ? landing.top : undefined}
                    landingTick={landing !== undefined && landing.fileId === selectedFile.id ? landing.n : 0}
                    landingRow={landing !== undefined && landing.fileId === selectedFile.id ? landing.row : undefined}
                    landingLine={landing !== undefined && landing.fileId === selectedFile.id ? landing.line : undefined}
                    landingOld={landing !== undefined && landing.fileId === selectedFile.id ? landing.old : undefined}
                    landingComment={landing !== undefined && landing.fileId === selectedFile.id ? landing.comment : undefined}
                    landingCard={landing !== undefined && landing.fileId === selectedFile.id ? landing.card : undefined}
                    // The landing is an ask, not a state: once the pane showing the file has taken
                    // it, the panel forgets it, so a pane that mounts later for the same open file
                    // resumes the reader's own place instead of landing where they once arrived.
                    onLanded={() => { setLanding(current => (current === undefined ? current : undefined)) }}
                    failedMessage={failed.get(selectedFile.id)}
                    commentSkill={snapshot.commentSkill}
                    comments={snapshot.comments}
                    commentAnswers={snapshot.commentAnswers}
                    commentsRevision={snapshot.commentsRevision}
                    commentLines={snapshot.commentLines}
                    onPasteReference={onPasteReference}
                    onCommentAdd={onCommentAdd}
                    onCommentRemove={onCommentRemove}
                    onCommentAsk={onCommentAsk}
                    onCommentSeen={onCommentSeen}
                    onToast={showCopyToast}
                    t={t}
                    onAddTypedPath={addTypedPath}
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
              {floatCard !== undefined && (
                <>
                  <div
                    className={floatClosing ? `${css.fileListFloat} ${css.fileListFloatClosing}` : css.fileListFloat}
                    style={{ left: floatCard.left, top: floatCard.top, width: floatCard.width, height: floatCard.height }}
                    data-diff-floating-file-list
                  >
                    {fileListBody}
                  </div>
                  {/* The folded list is dragged by the same divider the docked one
                      uses: a full-height strip on its right edge, straddling the
                      card's border so the edge the eye already reads as "the end of
                      the list" is the edge the finger grabs. It sits *outside* the
                      card (a sibling, like the docked divider is a sibling of the
                      docked list) so the strip of scrollbar along that edge stays
                      the scrollbar's. */}
                  <div
                    className={css.floatResizeHandle}
                    style={{
                      left: floatCard.left + floatCard.width - FLOAT_GRIP_OVERHANG_PX,
                      top: floatCard.top,
                      width: FLOAT_GRIP_WIDTH_PX,
                      height: floatCard.height,
                    }}
                    data-diff-float-resize
                    onPointerDown={startResize}
                  />
                </>
              )}
            </div>
          )}
          {blockPrompt !== null && promptFile !== undefined && (
            <div className={css.confirmBackdrop} data-diff-confirm>
              <div className={css.confirmCard} role="dialog" aria-modal="true">
                <p className={css.confirmText}>{t('panel.resolvedAsk', { file: basenameOf(promptFile.path) })}</p>
                {/* A block action that resolved the whole file is about to drop it, and dropping it deletes
                    its comments on the host: the same line the other removal dialogs carry. */}
                {commentsOn([promptFile.id]).count > 0 && (
                  <p className={css.confirmText} data-diff-block-comments>
                    {t('panel.removeCommentsOne', { file: basenameOf(promptFile.path), count: commentsOn([promptFile.id]).count })}
                  </p>
                )}
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
                  {/* The third answer, and the only one that is about the questions STILL TO COME: keep
                      the row listed and stop asking about this file. It is a button rather than the tick
                      this dialog used to carry, because a tick beside two buttons reads as a modifier of
                      whichever one is pressed — so "yes, and stop asking" had to be spelled as an answer
                      of its own. The title carries what "for now" is: the client's own lifetime, not the
                      session's (see `quietenRemovalAsk`). */}
                  <button
                    type="button"
                    className={css.action}
                    data-diff-confirm-keep-quiet
                    title={t('panel.keepInListQuietHint')}
                    onClick={() => {
                      setBlockPrompt(null)
                      const { action, sessionId, id, block } = blockPrompt
                      quietenRemovalAsk(current, id)
                      // Not removed, exactly as the button above: the difference is only what the file
                      // is told about the questions that follow (see `removalAskQuiet`).
                      void (action === 'keep'
                        ? onBlockKeep(sessionId, id, block, false)
                        : onBlockRevert(sessionId, id, block, false))
                    }}
                  >
                    {t('panel.keepInListQuiet')}
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
                {/* Removing it here deletes its comments too, so the question says so. */}
                {commentsOn([promptEntry.id]).count > 0 && (
                  <p className={css.confirmText} data-diff-file-comments>
                    {t('panel.removeCommentsOne', { file: basenameOf(promptEntry.path), count: commentsOn([promptEntry.id]).count })}
                  </p>
                )}
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
                  {/* The same third answer the block dialog carries, on the whole-file question: keep the
                      row and stop asking about this file. The scope is the page's memory — this client's
                      lifetime, not the session's — which the title spells out (see `quietenRemovalAsk`). */}
                  <button
                    type="button"
                    className={css.action}
                    data-diff-file-confirm-keep-quiet
                    title={t('panel.keepInListQuietHint')}
                    onClick={() => {
                      setFilePrompt(null)
                      const { action, sessionId, id } = filePrompt
                      quietenRemovalAsk(current, id)
                      void (action === 'keep' ? onKeep(sessionId, id, true) : onRevert(sessionId, id, true))
                    }}
                  >
                    {t('panel.keepInListQuiet')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {batchPrompt !== null && (
            <div className={css.confirmBackdrop} data-diff-batch-confirm>
              <div className={css.confirmCard} role="dialog" aria-modal="true">
                <p className={css.confirmText}>
                  {batchAskOf(batchPrompt)}
                </p>
                {/* The file's comments go with it: the host DELETES them when the entry leaves the list
                    (see `dropEntry`). Every dropping action that carries an undo pair snapshots them
                    into that pair's `before` side (see `droppingComments`), so Ctrl+Z brings the
                    threads back with the row — the two drops that record no pair at all are the ones
                    that really lose them: a revert that deletes a created file, and a file the host
                    finds unavailable. */}
                {/* The files whose comments this press would close, every one of them, in the same list block
                    the deletion warning below uses (see `.confirmList`) — the reader asked for the
                    comment-closing line to read like the line beside it. Every file appears: the run used to
                    stop at three with a 等 "more" tail, which hid the very files this box is opened to check.
                    `list: ''` is the sentence's own template with the names moved out of it. The single-file
                    press keeps its sentence alone: one name in a sentence is not a run to cut short. */}
                {batchCommentsText() !== '' && (
                  <div className={css.confirmBlock}>
                    <p className={css.confirmText} data-diff-batch-comments>
                      {batchCommentsText()}
                    </p>
                    {batchCommentFiles.length > 0 && (
                      <ul
                        className={css.confirmList}
                        data-diff-batch-comments-list
                        aria-label={t('panel.batchCommentsList')}
                      >
                        {batchCommentFiles.map(item => (
                          <li key={item.id} title={item.path}>{`${item.name} (${item.count})`}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {/* The part with no undo behind it. The sentence counts them and keeps its colon; the names
                    it used to run inline (cut off at three) are EVERY one of them here, in the shared list
                    block — see `.confirmList`, which the comment-closing list above also carries.
                    `files: ''` is the sentence's own template with the names moved out of it, not a rewrite
                    of the copy. */}
                {batchDoomed.length > 0 && (
                  <div className={css.confirmBlock} data-diff-batch-deletes>
                    <p className={css.confirmText}>
                      {t('panel.batchDeletes', { count: batchDoomed.length, files: '' })}
                    </p>
                    <ul
                      className={css.confirmList}
                      data-diff-batch-delete-list
                      aria-label={t('panel.batchDeletesList')}
                    >
                      {/* The row shows the basename — a list of files is scanned by name — and its `title`
                          carries the entry's FULL path, exactly as the entry holds it, so one file can be told
                          from its namesake in another directory without opening either. */}
                      {batchDoomed.map(file => (
                        <li key={file.id} title={file.path}>{basenameOf(file.path)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {/* 确定 on the LEFT of 取消: this is a desktop panel, and it is what the two dialogs above
                    already do (移除 before 保留在列表) — the primary press first, not the iOS order. */}
                <div className={css.confirmActions}>
                  <button
                    type="button"
                    className={`${css.action} ${css.actionPrimary}`}
                    data-diff-batch-confirm-go
                    onClick={() => {
                      const prompt = batchPrompt
                      setBatchPrompt(null)
                      runBatchConfirm(prompt)
                    }}
                  >
                    {t('panel.batchGo')}
                  </button>
                  <button
                    type="button"
                    className={css.action}
                    data-diff-batch-confirm-cancel
                    onClick={() => {
                      const prompt = batchPrompt
                      setBatchPrompt(null)
                      // Either answer ends the selection. The dialog was asked ABOUT that selection, so a
                      // pick that outlives the question is a pick the reader has to remember cancelling —
                      // and an all-file action's dialog ends it too, rather than leaving a pick behind a
                      // decision that was never about it.
                      if (prompt?.kind === 'close-picked') clearPicked()
                      else clearPickedFiles()
                    }}
                  >
                    {t('action.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {rowMenu !== null && (
            <Menu
              open
              portal
              compact
              items={rowMenuItems}
              onSelect={runRowMenu}
              onClose={() => { setRowMenu(null) }}
              getAnchorRect={() => new DOMRect(rowMenu.x, rowMenu.y, 0, 0)}
              anchor={<span className={css.rowMenuAnchor} />}
            />
          )}
          {commentMenu !== null && (
            <Menu
              open
              portal
              compact
              items={commentMenuItems}
              onSelect={runCommentMenu}
              onClose={() => { setCommentMenu(null) }}
              getAnchorRect={() => new DOMRect(commentMenu.x, commentMenu.y, 0, 0)}
              anchor={<span className={css.rowMenuAnchor} />}
            />
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
          {/* The thread's own prose font, for the canvas: a zero-sized span wearing the same font
              the turns are drawn in (see `.discussionBody` and `threadFontOf`), so the wrap can be
              measured before the first turn of a new annotation exists. Never seen, never focused. */}
          <span className={css.threadFontProbe} data-diff-thread-font aria-hidden="true" />
          </section>
        </>,
        docked && dockHost !== undefined ? dockHost : document.body,
      )}
      {!docked && <div className={css.footerButtons}>
        <Tooltip label={summonTip.label} shortcutKeys={summonTip.shortcutKeys} side="top" delayMs={500}>
          <button
            type="button"
            className={css.badge}
            data-diff-approval-badge={files.length}
            data-active={open || dockShowing ? '' : undefined}
            aria-label={t('panel.aria')}
            aria-keyshortcuts={summonTip.aria}
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
