/** Sidebar-foot pending-edit review action and the split review panel it opens. */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { IconBrowseOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconFolderOpenOutline16, IconFullscreenOutline16, IconListPenOutline16, IconSearchOutline16, IconSettingsOutline16, Menu, Toast, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DiffApprovalBlockRange, DiffApprovalOpenAction, PendingFileDiff } from '../types.ts'
import type { PendingPanelFace } from './slots.ts'
import type { DiffApprovalKey } from './locales.ts'
import { computeWholeFileDiff } from './whole-file-diff.ts'
import type { WholeFileDiffRow } from './whole-file-diff.ts'
import { computeSideBySideDiff, searchPairs } from './split-diff.ts'
import type { SplitPair, SplitSide } from './split-diff.ts'
import { HIGHLIGHT_LANGS, highlightLines, languageDisplayName } from './highlight.ts'
import type { HighlightSpan } from './highlight.ts'
import { langFromPath } from './lang.ts'
import { referenceOf } from './reference.ts'
import { includeUntrackedEnabled, pasteOnCopyEnabled, setWrapEnabled, splitMode, tabWidth, wrapEnabled } from './settings.ts'
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
/** Fixed window-edge inset used when expanded, mirroring `.panel`'s top/left/right. */
const PANEL_INSET_PX = 8
/** The harness composer seat (conversation scroll body + seat div). */
const SCROLL_SELECTOR = '[data-conversation-scroll]'
const SEAT_SELECTOR = '[data-composer-seat]'
/** Seat height ui-conversation publishes for floating controls (its own seat observer). */
const COMPOSER_HEIGHT_VAR = '--dsh-composer-height'
/** Interactive composer/approval cards; clicking these keeps the panel open.
    Deliberately the cards themselves, not the seat: the approval frame's wide
    side gutters are blank space, so a click there must still close. */
const KEEP_OPEN_SELECTOR = '[data-composer-card],[data-question-key] > *,[data-plan-review-key] > *'
/** Seat counts as docked when its bottom is this close to the window bottom. */
const DOCKED_TOLERANCE_PX = 48
/** File-list pane width bounds for the manual split drag, in px. */
const MIN_LIST_WIDTH_PX = 160
const MAX_LIST_WIDTH_PX = 560
/** Inset of the floating file-list card from the code scroll box, in px. */
const FLOAT_LIST_MARGIN_PX = 12
/** Fixed diff-row height in px; the virtual window and jump math are built on it. */
const ROW_HEIGHT_PX = 22
/** Total width of the two line-number gutters, subtracted from the code width
 * when measuring wrapped line heights. */
const WRAP_GUTTERS_PX = 88

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

/** Full panel props composed by the sidebar footer-action slot. */
export type PendingPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<PendingPanelFace> & PropsLocale<'diff-approval'>

/** Locale translator used by the panel and its rows. */
type Translator = (key: DiffApprovalKey, params?: Record<string, unknown>) => string

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

/** The right detail pane for one selected file: actions plus the merged diff. */
interface PendingDiffProps {
  file: PendingFileDiff
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
  t: Translator
  onKeep: (sessionId: SessionId, id: string) => Promise<void>
  onRevert: (sessionId: SessionId, id: string) => Promise<void>
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** The file list is collapsed to a floating button (its width would exceed a
   * third of the panel); the diff then takes the full width. */
  floatMode: boolean
  /** Whether the floating file list is currently expanded. */
  floatOpen: boolean
  /** Toggle the floating file list. */
  onToggleFileList: () => void
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
 * One rendered diff row, memoized so a poll or an unrelated state change
 * does not re-render rows whose content, highlight, and focus are unchanged.
 * With auto-wrap on, `wrappedLines` carries the row's visual sub-lines and the
 * code cell renders each at a fixed 22px (never `pre-wrap`), so the row height
 * is `wrappedLines.length * 22` by construction.
 */
const DiffRow = memo(function DiffRow(props: {
  index: number
  row: WholeFileDiffRow
  runs: HighlightRuns | undefined
  focused: boolean
  /** Whether this row contains a search hit, and if so whether it is current. */
  searchHit: boolean
  searchCurrent: boolean
  onRowHover: (index: number) => void
  /** Visual sub-lines when auto-wrap is on, else undefined (single line). */
  wrappedLines: string[] | undefined
}) {
  const { index, row, runs, focused, searchHit, searchCurrent, onRowHover, wrappedLines } = props
  const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine
  const sideRuns = row.kind === 'del' ? runs?.oldRuns : runs?.newRuns
  const lineRuns = lineNumber === undefined ? undefined : sideRuns?.[lineNumber - 1]

  let code: ReactNode
  if (wrappedLines === undefined) {
    code = lineRuns !== undefined && lineRuns.length > 0
      ? lineRuns.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)
      : (row.text === '' ? '\u00a0' : row.text)
  } else {
    const highlighted = lineRuns !== undefined && lineRuns.length > 0
    let offset = 0
    code = wrappedLines.map((line, lineIndex) => {
      const start = offset
      offset += line.length
      const content = highlighted
        ? clipRuns(lineRuns!, start, offset)
        : (line === '' ? '\u00a0' : line)
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
      <span className={css.gutter}>{row.oldLine ?? ''}</span>
      <span className={css.gutter}>{row.newLine ?? ''}</span>
      <span className={css.code} data-diff-code>{code}</span>
    </div>
  )
})

/** One file's synchronous view: diff rows and change blocks. */
interface RowModel {
  diff: ReturnType<typeof computeWholeFileDiff>
  /** Maximal runs of changed rows (inclusive row indices); one per modification. */
  blocks: ChangeBlock[]
}

/** One file's deferred syntax-highlight runs, one entry per side. */
interface HighlightRuns {
  oldRuns: ReturnType<typeof highlightLines>
  newRuns: ReturnType<typeof highlightLines>
}

/** One contiguous run of changed rows, treated as a single modification. */
interface ChangeBlock {
  start: number
  end: number
}

/** One selected line range in row indices, normalized low-to-high. */
interface RowRange {
  start: number
  end: number
}

/**
 * One diff block's old/new line ranges, 1-based inclusive, for block-level
 * keep/revert. A side with no lines (a pure addition or deletion) is empty;
 * its start is that side's insertion point — the line after the surrounding
 * context — so the host can insert there.
 * @param rows - the whole-file diff rows.
 * @param block - the block's row range.
 * @returns the old and new line ranges.
 */
function blockRangesOf(rows: readonly WholeFileDiffRow[], block: ChangeBlock): DiffApprovalBlockRange {
  let oldStart = Infinity
  let oldEnd = -Infinity
  let newStart = Infinity
  let newEnd = -Infinity
  for (let index = block.start; index <= block.end; index++) {
    const row = rows[index]
    if (row === undefined) continue
    if (row.oldLine !== undefined) {
      oldStart = Math.min(oldStart, row.oldLine)
      oldEnd = Math.max(oldEnd, row.oldLine)
    }
    if (row.newLine !== undefined) {
      newStart = Math.min(newStart, row.newLine)
      newEnd = Math.max(newEnd, row.newLine)
    }
  }
  const before = rows[block.start - 1]
  if (oldStart === Infinity) {
    oldStart = (before?.oldLine ?? 0) + 1
    oldEnd = oldStart - 1
  }
  if (newStart === Infinity) {
    newStart = (before?.newLine ?? 0) + 1
    newEnd = newStart - 1
  }
  return { oldStart, oldEnd, newStart, newEnd }
}

/** Split a row list into maximal runs of non-context rows. */
function changeBlocksOf(diff: ReturnType<typeof computeWholeFileDiff>): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let start = -1
  diff.rows.forEach((row, index) => {
    if (row.kind !== 'context') {
      if (start === -1) start = index
    } else if (start !== -1) {
      blocks.push({ start, end: index - 1 })
      start = -1
    }
  })
  if (start !== -1) blocks.push({ start, end: diff.rows.length - 1 })
  return blocks
}

/** One side's line-content for the split view: the highlighted runs or plain text. */
function splitSideContent(
  side: SplitSide | undefined,
  wrapped: string[] | undefined,
  runs: readonly HighlightSpan[] | undefined,
): ReactNode {
  if (side === undefined) return ''
  const highlighted = runs !== undefined && runs.length > 0
  if (wrapped === undefined) {
    return highlighted
      ? runs.map((span, i) => <span key={i} style={span.style}>{span.text}</span>)
      : (side.text === '' ? '\u00a0' : side.text)
  }
  let offset = 0
  return wrapped.map((line, i) => {
    const start = offset
    offset += line.length
    const content = highlighted ? clipRuns(runs, start, offset) : (line === '' ? '\u00a0' : line)
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
function SplitSideRow({ side, wrapped, runs, kind, isLeft, height, focused, searchHit, searchCurrent, onHover }: {
  side: SplitSide | undefined
  wrapped: string[] | undefined
  runs: readonly HighlightSpan[] | undefined
  kind: SplitPair['kind']
  isLeft: boolean
  height: number
  focused: boolean
  searchHit: boolean
  searchCurrent: boolean
  onHover: () => void
}) {
  const tint = isLeft
    ? (kind === 'del' || kind === 'replace' ? css.splitLdel : '')
    : (kind === 'add' || kind === 'replace' ? css.splitRadd : '')
  return (
    <div
      className={css.line}
      style={{ height }}
      data-diff-split-row
      data-diff-split-side={isLeft ? 'left' : 'right'}
      data-diff-focused={focused ? '' : undefined}
      data-diff-search={searchHit ? (searchCurrent ? 'current' : 'hit') : undefined}
      onMouseEnter={onHover}
    >
      <span className={css.gutter}>{side?.line ?? ''}</span>
      <span className={`${css.code} ${tint}`} data-diff-code>{splitSideContent(side, wrapped, runs)}</span>
    </div>
  )
}

/** Imperative surface the parent uses to drive block navigation from the
 *  shared toolbar/keyboard in split mode (its own `focus` is private here). */
export interface SplitDiffHandle { jump: (direction: -1 | 1) => void; openSearch: () => void }

/** The two-column (side-by-side) whole-file diff view. */
export const SplitDiff = forwardRef<SplitDiffHandle, {
  file: PendingFileDiff
  model: RowModel
  runs: HighlightRuns | undefined
  langWrap: boolean
  tabWidthSpaces: number
  busy: boolean
  t: Translator
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
}>(function SplitDiff({ file, model, runs, langWrap, tabWidthSpaces, busy, t, onBlockKeep, onBlockRevert }, ref) {
  const { pairs, pairOfRow } = useMemo(() => computeSideBySideDiff(model.diff.rows), [model])
  const pairCount = pairs.length
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [focus, setFocus] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
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
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFocus(0)
    bodyRef.current?.focus()
    setFlashKey(k => k + 1)
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

  // Pair index range per change block (mapped from the original row range).
  const blockOfPair = useMemo(() => model.blocks.map(block => ({
    start: pairOfRow.get(block.start) ?? 0,
    end: pairOfRow.get(block.end) ?? 0,
  })), [model, pairOfRow])
  const blockIndexByPair = useMemo(() => {
    const map = new Map<number, number>()
    blockOfPair.forEach((block, bi) => { for (let k = block.start; k <= block.end; k++) map.set(k, bi) })
    return map
  }, [blockOfPair])
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
  const searchMatches = useMemo(() => searchPairs(pairs, searchQuery), [pairs, searchQuery])
  const searchHitSet = useMemo(() => new Set(searchMatches), [searchMatches])
  const currentSearchPair = searchMatches.length === 0 ? undefined : searchMatches[searchIndex % searchMatches.length]

  const closeSearch = (): void => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
    bodyRef.current?.focus()
  }
  const openSearch = (): void => {
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
    // Center the matched pair near the viewport top, like the block jump.
    const target = Math.max(0, off(pairIndex) - 2 * ROW_HEIGHT_PX)
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
    setFlashKey(key => key + 1)
  }
  const pairAtY = (y: number): number => {
    if (pairOffsets === null) return Math.floor(y / ROW_HEIGHT_PX)
    if (y <= 0) return 0
    let lo = 0, hi = pairCount
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((pairOffsets[mid] ?? 0) <= y) lo = mid; else hi = mid - 1 }
    return lo
  }
  const viewport = viewportH > 0 ? viewportH : totalHeight
  const start = Math.max(0, pairAtY(scrollTop) - OVERSCAN_ROWS)
  const end = Math.min(pairCount, pairAtY(scrollTop + viewport) + OVERSCAN_ROWS)
  const visiblePairs = pairs.slice(start, end)

  // Block navigation: jump between change blocks (flashes the focused one).
  const jump = (direction: -1 | 1): void => {
    if (blockOfPair.length === 0) return
    setFocus(current => {
      if (direction === -1) return (current - 1 + blockOfPair.length) % blockOfPair.length
      const top = bodyRef.current?.scrollTop ?? 0
      for (let index = current + 1; index < blockOfPair.length; index++) {
        if (off(blockOfPair[index]!.start) >= top) return index
      }
      return 0
    })
    setFlashKey(k => k + 1)
  }
  // Expose the block jump to the parent so the shared toolbar/keyboard drives
  // this split view's own (private) focus in split mode.
  useImperativeHandle(ref, () => ({ jump, openSearch }), [jump, openSearch])

  useLayoutEffect(() => {
    if (pairCount === 0) return
    const block = blockOfPair[focus]
    if (block === undefined) return
    const body = bodyRef.current
    if (body === null) return
    // Leave two rows of lead above the block, matching the single-column view.
    const target = off(block.start) - 2 * ROW_HEIGHT_PX
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
  }, [model, focus, flashKey, pairCount])

  const onScroll = (): void => { setScrollTop(bodyRef.current?.scrollTop ?? 0) }
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
                return (
                  <SplitSideRow
                    key={index}
                    side={pair.left}
                    wrapped={pairWrapped?.[index]?.left}
                    runs={leftRuns}
                    kind={pair.kind}
                    isLeft
                    height={pairHeightAt(index)}
                    focused={inFocused(index)}
                    searchHit={searchHitSet.has(index)}
                    searchCurrent={index === currentSearchPair}
                    onHover={() => onPairHover(index)}
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
                return (
                  <SplitSideRow
                    key={index}
                    side={pair.right}
                    wrapped={pairWrapped?.[index]?.right}
                    runs={rightRuns}
                    kind={pair.kind}
                    isLeft={false}
                    height={pairHeightAt(index)}
                    focused={inFocused(index)}
                    searchHit={searchHitSet.has(index)}
                    searchCurrent={index === currentSearchPair}
                    onHover={() => onPairHover(index)}
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
            onChange={(event) => { setSearchQuery(event.target.value); setSearchIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goSearch(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                closeSearch()
              }
            }}
          />
          <span className={css.searchCount} data-diff-search-count>
            {searchMatches.length === 0
              ? '0/0'
              : `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}`}
          </span>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-prev aria-label={t('action.prevDiff')} disabled={searchMatches.length === 0} onClick={() => { goSearch(-1) }}>
            <IconChevronUpOutline14 size={14} />
          </button>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-next aria-label={t('action.nextDiff')} disabled={searchMatches.length === 0} onClick={() => { goSearch(1) }}>
            <IconChevronDownOutline14 size={14} />
          </button>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-search-close aria-label={t('action.close')} onClick={closeSearch}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
      )}
      {focusedBlock !== undefined && (
        <div className={css.blockFlash} data-diff-block-flash style={{ top: flashTop, height: flashHeight }} />
      )}
      {hoveredBlock !== undefined && blockOfPair[hoveredBlock] !== undefined && (
        <div className={css.blockActions} data-diff-block-actions style={{ top: blockActionsTop }}>
          <span className={css.blockPosition} data-diff-block-position>
            {t('panel.blockPosition', { current: hoveredBlock + 1, total: blockOfPair.length })}
          </span>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-block-prev aria-label={t('action.prevDiff')} disabled={busy} onClick={() => jump(-1)}>
            <IconChevronUpOutline14 size={14} />
          </button>
          <button type="button" className={`${css.action} ${css.iconAction}`} data-diff-block-next aria-label={t('action.nextDiff')} disabled={busy} onClick={() => jump(1)}>
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

/** Character offset of a selection boundary within its line's code text. */
function lineOffsetAt(node: Node, offset: number): number {
  const code = (node instanceof Element ? node : node.parentElement)?.closest('[data-diff-code]')
  if (code === null || code === undefined) return 0
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

/** Length of the code text on the line holding a node. */
function lineLengthAt(node: Node): number {
  const code = (node instanceof Element ? node : node.parentElement)?.closest('[data-diff-code]')
  return code?.textContent?.length ?? 0
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
          <span className={css.rowMeta}>
            <span className={css.addCount}>{t('row.added', { added: stats.added })}</span>
            <span className={css.delCount}>{t('row.removed', { removed: stats.removed })}</span>
          </span>
        </button>
      </Tooltip>
    </li>
  )
}

/** The selected file's diff, actions, jump controls, and copy toolbar. */
function PendingDiff({ file, busy, workspacePath, jumpSignal, undoFlash, failedMessage, onPasteReference, t, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen, floatMode, floatOpen, onToggleFileList }: PendingDiffProps) {
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
  const lang = useMemo(() => langOverride ?? detectedLang, [detectedLang, langOverride])
  // The trigger label: the override, or auto with the detected language named
  // so the user sees what auto resolved to (plain text when none is detected).
  const langLabel = langOverride === undefined
    ? (detectedLang === undefined ? t('action.langAuto') : t('action.langAutoDetected', { lang: languageDisplayName(detectedLang) }))
    : languageDisplayName(langOverride)
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
  // Side-by-side (split) mode from settings. Read once on mount so a change
  // applies on the next panel open, matching the tab-width behaviour above.
  const splitView = splitMode()
  // Handle to the split view's imperative block-jump, used to route the shared
  // toolbar/keyboard to it while split mode is active (null in single column).
  const splitDiffRef = useRef<SplitDiffHandle>(null)
  const model = useMemo<RowModel>(() => {
    const diff = computeWholeFileDiff(file.oldText, file.newText)
    return { diff, blocks: changeBlocksOf(diff) }
  }, [file.oldText, file.newText])

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

  // Syntax highlight arrives a tick after selection so clicking a file never
  // blocks the diff paint on tokenization; the plain-text diff shows first.
  const [runs, setRuns] = useState<HighlightRuns | undefined>(undefined)
  useEffect(() => {
    setRuns(undefined)
    const timer = window.setTimeout(() => {
      setRuns({
        oldRuns: highlightLines(file.oldText, lang),
        newRuns: highlightLines(file.newText, lang),
      })
    }, 0)
    return () => { window.clearTimeout(timer) }
  }, [file.id, file.oldText, file.newText, lang])

  const bodyRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [bodyWidth, setBodyWidth] = useState(0)
  const [hScrollbarPx, setHScrollbarPx] = useState(0)
  const [hoveredBlock, setHoveredBlock] = useState<number | undefined>(undefined)
  const [selection, setSelection] = useState<RowRange | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Keys the block-flash overlay; every increment remounts it so the fade-out
  // animation restarts. Bumped on file open/switch and on every jump (even a
  // same-block wrap), so the focused block flashes whenever it is (re)shown.
  const [flashKey, setFlashKey] = useState(0)

  // Reset transient viewer state whenever the selected file changes, take
  // keyboard focus into the diff body so the Ctrl+Up/Down block-jump (scoped
  // to the panel) works as soon as a file is shown, and flash the initial
  // block so the user sees where the first change sits. The scroll position is
  // left to the block-centering effect below: it scrolls the first change
  // block into view, and resetting it to 0 here would override that for long
  // files whose first change sits far down.
  useEffect(() => {
    setFocus(0)
    bodyRef.current?.focus()
    setFlashKey(key => key + 1)
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
    setFlashKey(key => key + 1)
  }, [undoFlash])

  // Old/new line ranges per diff block, for block-level keep/revert.
  const blockRanges = useMemo(() => {
    return model.blocks.map(block => blockRangesOf(model.diff.rows, block))
  }, [model])

  // In-file search: matching lines over the whole diff (not just the rendered
  // window), so the count and jumps stay correct while the virtual list
  // scrolls. A line counts once however many times the query appears in it.
  const searchMatches = useMemo(() => {
    if (searchQuery === '') return []
    const lower = searchQuery.toLowerCase()
    const matches: number[] = []
    for (let index = 0; index < model.diff.rows.length; index++) {
      if (model.diff.rows[index]!.text.toLowerCase().includes(lower)) matches.push(index)
    }
    return matches
  }, [model, searchQuery])
  const searchHitSet = useMemo(() => new Set(searchMatches), [searchMatches])
  const currentSearchRow = searchMatches.length === 0 ? undefined : searchMatches[searchIndex % searchMatches.length]

  const goSearch = (direction: -1 | 1) => {
    if (searchMatches.length === 0) return
    setSearchIndex(current => (current + direction + searchMatches.length) % searchMatches.length)
  }
  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
      setSearchIndex(0)
    } else {
      setSearchOpen(true)
    }
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIndex(0)
  }

  // Focus the query box each time the search bar opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // A new query or a new file lands on the first match.
  useEffect(() => {
    setSearchIndex(0)
  }, [searchQuery, file.id])

  // Center the current search match in the scroller (same arithmetic as the
  // block centering; layout timing keeps the search state consistent too).
  useLayoutEffect(() => {
    const row = currentSearchRow
    if (row === undefined) return
    const body = bodyRef.current
    if (body === null) return
    const target = offsetOf(row) + extentOf(row, row) / 2 - body.clientHeight / 2
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
  const start = Math.max(0, rowAtY(scrollTop) - OVERSCAN_ROWS)
  const end = Math.min(rowCount, rowAtY(scrollTop + viewport) + OVERSCAN_ROWS)
  const visibleRows = rows.slice(start, end)

  // The floating Keep/Revert frame anchors to the hovered block's bottom edge.
  // When that edge runs into the content's bottom, the frame must move up so
  // its own bottom stays inside the scrollable content — padding the bottom
  // would grow the content and make the last rows jump. Clamping to
  // `totalHeight - FRAME_HEIGHT` (never past `0`) keeps the frame reachable.
  const blockEnd = hoveredBlock === undefined ? undefined : model.blocks[hoveredBlock]?.end
  const blockActionsTop = blockEnd === undefined
    ? 0
    : Math.min(offsetOf(blockEnd + 1), Math.max(0, totalHeight - BLOCK_ACTIONS_FRAME_PX))

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
  // render window tracks the visible area.
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const measure = () => { setViewportHeight(body.clientHeight) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    return () => { observer?.disconnect() }
  }, [file.id])

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
  }, [file.id, langWrap])

  // Scroll the focused change block into view after focus, content changes, or
  // a jump. The block's top edge lands two rows below the viewport top so a
  // little context stays visible above it; near the top or bottom the scroll
  // clamps to the scrollable range instead. Arithmetic on the fixed row height
  // works even when the block's rows are outside the rendered window. A
  // programmatic scrollTop does not fire a scroll event, so the DOM write is
  // mirrored into state to re-render the window; onScroll covers real user
  // scrolling. Layout timing matters: the block-flash overlay reads scrollTop
  // while rendering, so the scroll must settle BEFORE the browser paints —
  // otherwise the flash shows a frame at the stale offset and then jumps.
  useLayoutEffect(() => {
    if (rowCount === 0) return
    const block = model.blocks[focus]
    if (block === undefined) return
    const body = bodyRef.current
    if (body === null) return
    // Leave two rows of lead above the block's top edge; when the block is too
    // close to the top or bottom to afford it, clamp to the scrollable range.
    const target = offsetOf(block.start) - 2 * ROW_HEIGHT_PX
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
    // Re-run once when wrapped offsets go from "not measured yet" to ready, so
    // an open-with-wrap-on file centers on the block's real (wrapped) offset
    // instead of the initial fixed-22px guess. `rowOffsets === null` flips only
    // on the readiness transition, not on every resize re-measure.
  }, [model, focus, scrollTick, rowCount, rowOffsets === null])

  const jump = (direction: -1 | 1) => {
    if (rowCount === 0) return
    setFocus(current => {
      if (direction === -1) {
        return (current - 1 + model.blocks.length) % model.blocks.length
      }
      const top = bodyRef.current?.scrollTop ?? 0
      // Forward scan without wrapping: land on the first block at or below
      // the viewport top (blocks scrolled out above are skipped).
      for (let index = current + 1; index < model.blocks.length; index++) {
        const block = model.blocks[index]
        if (block === undefined) continue
        if (offsetOf(block.start) >= top) return index
      }
      // Past the last block — wrap to the first.
      return 0
    })
    // Bump the centering effect even when the focus is unchanged (a single
    // block), so an out-of-view block is always scrolled back into view, and
    // re-flash the block (its key changes -> the overlay remounts) so the
    // fade-out replays when the same block is selected again.
    setScrollTick(tick => tick + 1)
    setFlashKey(key => key + 1)
  }

  // Block jump the shared toolbar/keyboard/jumpSignal use. In split mode the
  // single-column `jump` below has no body to drive (its `bodyRef` is null), so
  // delegate to the split view's own imperative jump; otherwise use the
  // single-column one. Kept in a ref so the capture-phase keydown listener
  // always sees the current closure.
  const jumpBlock = (direction: -1 | 1): void => {
    if (splitView) {
      splitDiffRef.current?.jump(direction)
      return
    }
    jump(direction)
  }
  const jumpBlockRef = useRef(jumpBlock)
  jumpBlockRef.current = jumpBlock

  // Step the hovered block's floating actions frame to the adjacent diff block
  // (wrapping). Both the hovered block (the frame follows it) and the focused
  // block (which recenters and re-flashes) advance together.
  const stepBlock = (direction: -1 | 1): void => {
    const count = model.blocks.length
    if (count === 0) return
    const base = hoveredBlock ?? focus
    const target = (base + direction + count) % count
    setHoveredBlock(target)
    setFocus(target)
    setScrollTick(tick => tick + 1)
    setFlashKey(key => key + 1)
  }

  // Keep/revert the hovered block, then advance focus to the next change block
  // (if there is one). The store removes the operated block and refreshes, so
  // the remaining blocks shift into its slot; using the operated index makes the
  // next block land on that index, and the clamp keeps it in range when the
  // operated block was the last one. On a failed action the block is still
  // present, so focus stays where it was.
  const handleBlockAction = async (action: 'keep' | 'revert'): Promise<void> => {
    if (busy || hoveredBlock === undefined) return
    const operated = hoveredBlock
    const range = blockRanges[operated]!
    await (action === 'keep'
      ? onBlockKeep(file.sessionId, file.id, range)
      : onBlockRevert(file.sessionId, file.id, range))
    const count = model.blocks.length
    if (count === 0) return
    const next = Math.max(0, Math.min(operated, count - 1))
    setFocus(next)
    setHoveredBlock(undefined)
    setScrollTick(tick => tick + 1)
    setFlashKey(key => key + 1)
  }

  // Re-clicking the already-open file in the list jumps to the next change
  // block; the panel bumps `jumpSignal` to trigger it. A fresh signal while
  // on the same file re-runs this, wrapping to the first block when needed.
  useEffect(() => {
    if (jumpSignal === 0) return
    jumpBlock(1)
  }, [jumpSignal])

  const onScroll = () => {
    const body = bodyRef.current
    if (body === null) return
    setScrollTop(body.scrollTop)
    setViewportHeight(body.clientHeight)
  }

  // Track the native text selection inside the diff: the copy-reference
  // toolbar appears once lines are selected and hides when the selection
  // collapses. The toolbar's own mousedown prevents the default so the
  // selection survives the click that triggers the copy.
  useEffect(() => {
    const update = () => setSelection(rowRangeOf(window.getSelection()))
    document.addEventListener('selectionchange', update)
    update()
    return () => { document.removeEventListener('selectionchange', update) }
  }, [file.id])

  // The reference text for the current selection, shown in the status bar and
  // copied on click; undefined when no lines are selected.
  const selectionReference = (() => {
    if (selection === undefined) return undefined
    const rows = model.diff.rows.slice(selection.start, selection.end + 1)
    // Only the new (current) file's lines are referenceable: removed lines
    // have no current-side number, so they contribute nothing to the range.
    const lineNumbers = rows
      .map(row => row.newLine)
      .filter((number): number is number => number !== undefined)
    if (lineNumbers.length === 0) return undefined
    return referenceOf(file.path, workspacePath, Math.min(...lineNumbers), Math.max(...lineNumbers))
  })()

  const copySelection = useCallback(async () => {
    if (selectionReference === undefined) return
    const accepted = await writeClipboard(selectionReference)
    if (!accepted) return
    setCopied(true)
    // The preference lives in DSH Settings → this plugin's tab; read it at
    // copy time so a change there takes effect without reopening the panel.
    if (pasteOnCopyEnabled()) onPasteReference(file.sessionId, selectionReference)
    window.setTimeout(() => { setCopied(false) }, 1500)
  }, [file.sessionId, onPasteReference, selectionReference])

  // Ctrl/Cmd+L copies the selected line range. The detail pane is mounted
  // only while a file is open, so the chord is global while the diff is shown
  // (the reference copy works from anywhere, no focus scope); it is left to
  // the browser's own default when there is no selection to reference.
  //
  // TODO(editable code view): if the editable surface ever needs its own
  // Ctrl+L, revisit this global interception.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'l') return
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
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      // In split mode the single-column search bar isn't mounted; route to the
      // split view's own search bar instead.
      if (splitView) { splitDiffRef.current?.openSearch(); return }
      setSearchOpen(true)
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [])

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
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key !== 'arrowup' && key !== 'arrowdown') return
      const target = event.target as Node | null
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      event.preventDefault()
      jumpRef.current(key === 'arrowup' ? -1 : 1)
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

  return (
    <div className={css.diff} data-diff-approval-diff>
      <div className={css.diffHeader}>
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
        {floatMode && (
          <Tooltip label={t(floatOpen ? 'action.hideFileList' : 'action.showFileList')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-file-list-toggle
              aria-label={t(floatOpen ? 'action.hideFileList' : 'action.showFileList')}
              onClick={onToggleFileList}
            >
              <IconListPenOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        <span className={css.diffStats}>{t('panel.stats', { added: model.diff.added, removed: model.diff.removed })}</span>
        {file.kind === 'create' && <span className={css.kindHint}>{t('panel.createHint')}</span>}
        {model.blocks.length > 0 && (
          <>
            <Tooltip label={`${t('action.prevDiff')} (Ctrl+↑)`} side="bottom" delayMs={500}>
              <button
                type="button"
                className={`${css.action} ${css.iconAction}`}
                data-diff-prev
                aria-label={t('action.prevDiff')}
                disabled={busy}
                onClick={() => { jumpBlock(-1) }}
              >
                <IconChevronUpOutline14 size={14} />
              </button>
            </Tooltip>
            <Tooltip label={`${t('action.nextDiff')} (Ctrl+↓)`} side="bottom" delayMs={500}>
              <button
                type="button"
                className={`${css.action} ${css.iconAction}`}
                data-diff-next
                aria-label={t('action.nextDiff')}
                disabled={busy}
                onClick={() => { jumpBlock(1) }}
              >
                <IconChevronDownOutline14 size={14} />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip label={t('action.search')} side="bottom" delayMs={500}>
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
          {t('action.revert')}
        </button>
      </div>
      {failedMessage !== undefined && <p className={css.actionError} data-diff-action-error>{failedMessage}</p>}
      {file.missing && <p className={css.missingHint}>{t('panel.missingHint')}</p>}
      {splitView ? (
        <SplitDiff
          ref={splitDiffRef}
          file={file}
          model={model}
          runs={runs}
          langWrap={langWrap}
          tabWidthSpaces={tabWidthSpaces}
          busy={busy}
          t={t}
          onBlockKeep={onBlockKeep}
          onBlockRevert={onBlockRevert}
        />
      ) : (
      <div className={css.diffBodyWrap}>
        <div
          className={css.diffBody}
          ref={bodyRef}
          tabIndex={0}
          onScroll={onScroll}
          onMouseLeave={() => { setHoveredBlock(undefined) }}
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
                  onRowHover={onRowHover}
                  wrappedLines={rowWrapped?.[index]}
                />
              )
            })}
            {end < rowCount && (
              <div className={css.vSpacer} style={{ height: totalHeight - offsetOf(end) }} aria-hidden="true" />
            )}
          </div>
          {hoveredBlock !== undefined && model.blocks[hoveredBlock] !== undefined && (
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
          )}
        </div>
        {focusedBlock !== undefined && flashKey > 0 && (
          <div
            key={flashKey}
            className={css.blockFlash}
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
        {searchOpen && (
          <div className={css.searchBar} data-diff-searchbar>
            <input
              ref={searchInputRef}
              className={css.searchInput}
              data-diff-search-input
              value={searchQuery}
              placeholder={t('panel.searchPlaceholder')}
              onChange={(event) => { setSearchQuery(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  goSearch(event.shiftKey ? -1 : 1)
                } else if (event.key === 'Escape') {
                  closeSearch()
                }
              }}
            />
            <span className={css.searchCount} data-diff-search-count>
              {searchMatches.length === 0
                ? '0/0'
                : `${(searchIndex % searchMatches.length) + 1}/${searchMatches.length}`}
            </span>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-search-prev
              aria-label={t('action.prevDiff')}
              disabled={searchMatches.length === 0}
              onClick={() => { goSearch(-1) }}
            >
              <IconChevronUpOutline14 size={14} />
            </button>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-search-next
              aria-label={t('action.nextDiff')}
              disabled={searchMatches.length === 0}
              onClick={() => { goSearch(1) }}
            >
              <IconChevronDownOutline14 size={14} />
            </button>
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
        )}
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
          <Tooltip label={copied ? t('action.copied') : `${t('action.copyHint')} (Ctrl+L)`} side="top" delayMs={300}>
            <button
              type="button"
              className={css.statusAction}
              data-diff-copy
              // Keep the native selection alive across the click so the
              // reference stays in the status bar after copying.
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { void copySelection() }}
            >
              {copied ? t('action.copied') : selectionReference}
            </button>
          </Tooltip>
        )}
        <span className={css.flexSpacer} />
        <Menu
          open={langMenuOpen}
          portal
          compact
          align="end"
          items={langMenuItems}
          selectedId={langOverride ?? ''}
          onSelect={(id) => { setLangOverride(id === '' ? undefined : id); setLangMenuOpen(false) }}
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
      </div>
    </div>
  )
}

/** Render the pending-edit review panel and its unified footer action. */
export function PendingPanel({
  wide, useSessions, usePending, onRefresh, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen, onPasteReference, onUndo, onRedo, onImportVcs, onAckRedoCleared, t,
}: PendingPanelProps) {
  const current = useSessions(state => state.current)
  // A newly created session is selected but still blank (no messages yet); it
  // has nothing to review, so the entry is grayed out exactly like no session.
  const currentBlank = useSessions(state => {
    const id = state.current
    return id === undefined ? false : (state.byId[id]?.blank ?? false)
  })
  const noSession = current === undefined || currentBlank
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
  /** Whether the redo-cleared notice is showing (bottom-right, OK to dismiss). */
  const [redoClearedNotice, setRedoClearedNotice] = useState(false)
  /** Bottom offset tracking the chat composer's top edge so the input stays visible. */
  const [bottomPx, setBottomPx] = useState(FALLBACK_BOTTOM_PX)
  /** Fullscreen expanded: the panel bottom pins to the window edge, ignoring the composer offset. */
  const [expanded, setExpanded] = useState(false)
  /** File-list pane width, adjustable by dragging the divider. */
  const [listWidth, setListWidth] = useState(240)
  const resizeDrag = useRef<{ startX: number; startWidth: number } | null>(null)
  /** Whether the floating (collapsed) file list is currently expanded. */
  const [floatOpen, setFloatOpen] = useState(false)
  /** The review panel's width, measured so the file list can collapse when it
   * would take more than a third of it (browser zoom / window resize). */
  const [panelWidth, setPanelWidth] = useState(0)
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

  // Measure the panel width so the file list can auto-collapse to a floating
  // button when it would occupy more than a third of the panel (narrow windows
  // from browser zoom/resize). The panel only mounts while open.
  useEffect(() => {
    const el = panelRef.current
    if (el === null) return
    const measure = (): void => { setPanelWidth(el.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => { observer?.disconnect() }
  }, [open])

  const floatMode = panelWidth > 0 && listWidth > panelWidth / 3
  const toggleFileList = (): void => { setFloatOpen(value => !value) }

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

  // Constrain the floating file-list card to the code scroll box (`.diffBody`):
  // measure its bounds within the split each time the list opens or the panel
  // resizes, so the card never extends beyond the code view.
  useEffect(() => {
    if (!floatMode || !floatOpen) return
    const split = splitRef.current
    const body = panelRef.current?.querySelector<HTMLElement>('[data-diff-body]')
    if (split === null || body == null) return
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

  // Clicking outside the panel closes it, except on the entry badge itself
  // (whose own click toggles) and on the interactive composer/approval cards
  // — the input capsule and the approval/question card must keep the review
  // panel open, but the approval frame's blank side gutters are outside.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target === null) return
      const element = target instanceof Element ? target : target.parentElement
      if (element !== null
        && (element.closest('[data-diff-approval-panel]') !== null
          || element.closest('[data-diff-approval-badge]') !== null
          || element.closest(KEEP_OPEN_SELECTOR) !== null)) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open])



  // The panel reviews only the current session's files; other sessions of the
  // same workspace stay out of the list, badge, and auto-advance. Sort by the
  // displayed file name so the list reads in dictionary order even before the
  // host's own ordering is picked up.
  const files = snapshot.files
    .filter(file => file.sessionId === current)
    .sort((left, right) => compareFileNames(left.path, right.path))
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

  const toggleOpen = () => {
    setOpen(value => !value)
  }

  // No reviewable session (none selected, or a freshly created blank one): the
  // button is disabled and an open panel closes — there is nothing to review.
  useEffect(() => {
    if (noSession) setOpen(false)
  }, [noSession])

  /** Run the same decision over every current-session file, sequentially. */
  const runBulk = async (kind: 'keep' | 'revert') => {
    setBulkBusy(kind)
    try {
      for (const file of files) {
        if (kind === 'keep') await onKeep(file.sessionId, file.id)
        else await onRevert(file.sessionId, file.id)
      }
    } finally {
      setBulkBusy(null)
    }
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

  // The file list's scrollable rows plus the pinned bulk footer, shared by the
  // in-flow left pane and the floating (collapsed) overlay.
  const fileListBody = (
    <>
      <div className={css.listScroll}>
        {files.length > 0 && (
          <section>
            <h3 className={css.group}>{t('panel.group.current')}</h3>
            <ul className={css.rows}>{files.map(renderEntry)}</ul>
          </section>
        )}
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
  // bumps `undoFlash` so its detail pane re-flashes the undone diff.
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
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const target = event.target as Node | null
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      event.preventDefault()
      if (key === 'z') {
        if (event.shiftKey) void handleRedo(current)
        else void handleUndo(current)
      } else {
        void handleRedo(current)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, current, handleUndo, handleRedo])

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

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {/* A transient banner for an import that found no changes; the Toast
          reports completion so it can be unmounted. */}
      {importToast !== null && (
        <Toast text={importToast} onDone={() => { setImportToast(null) }} />
      )}
      {actionToast !== null && (
        <Toast text={actionToast} onDone={() => { setActionToast(null) }} />
      )}
      {/* Expanded keeps an 8px inset, so a full-screen backdrop painted with
          the sidebar's fill hides the app behind the seam instead of letting
          it show through. It sits just below the panel's z-index. */}
      {open && expanded && <div className={css.fullscreenBackdrop} data-diff-fullscreen-backdrop />}
      {open && (
        <section
          className={css.panel}
          ref={panelRef}
          style={{ bottom: expanded ? PANEL_INSET_PX : bottomPx }}
          data-diff-approval-panel
          aria-label={t('panel.title')}
        >
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
                    // Hand off to the settings dialog: close this panel too,
                    // since the review list is left behind for the settings
                    // section the button just opened.
                    setOpen(false)
                    openSettingsSection(t('settings.tabLabel'))
                  }}
                >
                  <IconSettingsOutline16 size={14} />
                </button>
              </Tooltip>
              <Tooltip label={t(expanded ? 'action.exitFullscreen' : 'action.expand')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={expanded ? `${css.expand} ${css.expandExpanded}` : css.expand}
                  data-diff-approval-expand
                  aria-label={t(expanded ? 'action.exitFullscreen' : 'action.expand')}
                  onClick={() => { setExpanded(value => !value) }}
                >
                  <IconFullscreenOutline16 size={14} />
                </button>
              </Tooltip>
              <Tooltip label={t('action.close')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.close}
                  data-diff-approval-close
                  aria-label={t('action.close')}
                  onClick={() => { setOpen(false) }}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </Tooltip>
            </div>
          </header>
          {snapshot.error !== undefined || !snapshot.read || files.length === 0 ? (
            <div className={css.states}>
              {snapshot.error !== undefined && (
                <p className={css.readError} role="alert">{t('panel.readFailed', { message: snapshot.error })}</p>
              )}
              {!snapshot.read && snapshot.error === undefined && <p className={css.note}>{t('panel.loading')}</p>}
              {snapshot.read && snapshot.error === undefined && files.length === 0 && (
                <div className={css.emptyState}>
                  <p className={`${css.note} ${css.noteCentered}`}>{t('panel.empty')}</p>
                  <button
                    type="button"
                    className={css.importButton}
                    data-diff-import-vcs
                    disabled={importBusy}
                    onClick={() => { void runImportVcs() }}
                  >
                    {importBusy ? t('action.importVcsBusy') : t('action.importVcs')}
                  </button>
                  {importNote !== undefined && <p className={css.importNote} role={importFailed ? 'alert' : undefined}>{importNote}</p>}
                </div>
              )}
            </div>
          ) : (
            <div className={css.split} ref={splitRef}>
              {!floatMode && (
                <nav className={css.fileList} style={{ width: listWidth }} data-diff-approval-file-list>
                  {fileListBody}
                </nav>
              )}
              {!floatMode && <div className={css.resizeHandle} data-diff-resize onMouseDown={startResize} />}
              <div className={css.detail}>
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
                    t={t}
                    onKeep={onKeep}
                    onRevert={onRevert}
                    onBlockKeep={onBlockKeep}
                    onBlockRevert={onBlockRevert}
                    onOpen={onOpen}
                    floatMode={floatMode}
                    floatOpen={floatOpen}
                    onToggleFileList={toggleFileList}
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
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={noSession ? `${css.badge} ${css.badgeDisabled}` : css.badge}
          data-diff-approval-badge={files.length}
          data-active={open ? '' : undefined}
          aria-label={t('panel.aria')}
          aria-expanded={open}
          disabled={noSession}
          onClick={toggleOpen}
        >
          <IconListPenOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.badgeLabel}>{t('panel.aria')}</span>}
          {(wide || files.length > 0) && <span className={css.badgeCount}>{files.length}</span>}
        </button>
      </div>
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
    </div>
  )
}
