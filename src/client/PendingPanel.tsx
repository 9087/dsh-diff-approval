/** Sidebar-foot pending-edit review action and the split review panel it opens. */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
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
import { HIGHLIGHT_LANGS, highlightLines, languageDisplayName } from './highlight.ts'
import { langFromPath } from './lang.ts'
import { referenceOf } from './reference.ts'
import { includeUntrackedEnabled, pasteOnCopyEnabled } from './settings.ts'
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
/** Fixed diff-row height in px; the virtual window and jump math are built on it. */
const ROW_HEIGHT_PX = 22
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
 * One rendered diff row, memoized so a poll or an unrelated state change
 * does not re-render rows whose content, highlight, and focus are unchanged.
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
}) {
  const { index, row, runs, focused, searchHit, searchCurrent, onRowHover } = props
  const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine
  const sideRuns = row.kind === 'del' ? runs?.oldRuns : runs?.newRuns
  const lineRuns = lineNumber === undefined ? undefined : sideRuns?.[lineNumber - 1]
  const content = lineRuns === undefined || lineRuns.length === 0
    ? row.text === '' ? '\u00a0' : row.text
    : lineRuns.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)
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
      <span className={css.code} data-diff-code>{content}</span>
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
function PendingDiff({ file, busy, workspacePath, jumpSignal, undoFlash, failedMessage, onPasteReference, t, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen }: PendingDiffProps) {
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
  // block so the user sees where the first change sits.
  useEffect(() => {
    setFocus(0)
    setScrollTop(0)
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0
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
    const target = row * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2 - body.clientHeight / 2
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
  const viewport = viewportHeight > 0 ? viewportHeight : rowCount * ROW_HEIGHT_PX
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS)
  const end = Math.min(rowCount, Math.ceil((scrollTop + viewport) / ROW_HEIGHT_PX) + OVERSCAN_ROWS)
  const visibleRows = rows.slice(start, end)

  // When the hovered block's last row reaches the bottom of the file, the
  // floating Keep/Revert frame (anchored to the block's bottom edge) would
  // extend past the scrollable content and be clipped by the scroller. Pad
  // the diff bottom with just enough height to fit it.
  const hoveredBlockEnd = hoveredBlock !== undefined ? model.blocks[hoveredBlock]?.end : undefined
  const blockActionsPadPx = hoveredBlockEnd === undefined
    ? 0
    : Math.max(0, (hoveredBlockEnd + 1) * ROW_HEIGHT_PX + BLOCK_ACTIONS_FRAME_PX - rowCount * ROW_HEIGHT_PX)

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

  // Center the focused change block after focus, content changes, or a jump.
  // Arithmetic on the fixed row height works even when the block's rows are
  // outside the rendered window. A programmatic scrollTop does not fire a
  // scroll event, so the DOM write is mirrored into state to re-render the
  // window; onScroll covers real user scrolling. Layout timing matters: the
  // block-flash overlay reads scrollTop while rendering, so the scroll must
  // settle BEFORE the browser paints — otherwise the flash shows a frame at
  // the stale offset and then jumps to the centered spot.
  useLayoutEffect(() => {
    if (rowCount === 0) return
    const block = model.blocks[focus]
    if (block === undefined) return
    const body = bodyRef.current
    if (body === null) return
    const target = block.start * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2 - body.clientHeight / 2
    const clamped = Math.max(0, Math.min(target, body.scrollHeight - body.clientHeight))
    if (body.scrollTop !== clamped) body.scrollTop = clamped
    setScrollTop(clamped)
  }, [model, focus, scrollTick, rowCount])

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
        if (block.start * ROW_HEIGHT_PX >= top) return index
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

  // Re-clicking the already-open file in the list jumps to the next change
  // block; the panel bumps `jumpSignal` to trigger it. A fresh signal while
  // on the same file re-runs this, wrapping to the first block when needed.
  useEffect(() => {
    if (jumpSignal === 0) return
    jump(1)
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
  const jumpRef = useRef(jump)
  jumpRef.current = jump
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
                onClick={() => { jump(-1) }}
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
                onClick={() => { jump(1) }}
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
      <div className={css.diffBodyWrap}>
        <div
          className={css.diffBody}
          ref={bodyRef}
          tabIndex={0}
          onScroll={onScroll}
          onMouseLeave={() => { setHoveredBlock(undefined) }}
          data-diff-body
        >
          <div className={css.lines} style={{ minWidth: `max(100%, ${widestLine}ch)` }}>
            {start > 0 && (
              <div className={css.vSpacer} style={{ height: start * ROW_HEIGHT_PX }} aria-hidden="true" />
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
                />
              )
            })}
            {end < rowCount && (
              <div className={css.vSpacer} style={{ height: (rowCount - end) * ROW_HEIGHT_PX }} aria-hidden="true" />
            )}
            {blockActionsPadPx > 0 && (
              <div className={css.vSpacer} style={{ height: blockActionsPadPx }} aria-hidden="true" />
            )}
          </div>
          {hoveredBlock !== undefined && model.blocks[hoveredBlock] !== undefined && (
            <div
              className={css.blockActions}
              data-diff-block-actions
              style={{ top: (model.blocks[hoveredBlock]!.end + 1) * ROW_HEIGHT_PX }}
            >
              <span className={css.blockPosition} data-diff-block-position>
                {t('panel.blockPosition', { current: hoveredBlock + 1, total: model.blocks.length })}
              </span>
              <button
                type="button"
                className={`${css.action} ${css.actionPrimary}`}
                data-diff-block-keep
                disabled={busy}
                onClick={() => { void onBlockKeep(file.sessionId, file.id, blockRanges[hoveredBlock]!) }}
              >
                {t('action.keep')}
              </button>
              <button
                type="button"
                className={css.action}
                data-diff-block-revert
                disabled={busy}
                onClick={() => { void onBlockRevert(file.sessionId, file.id, blockRanges[hoveredBlock]!) }}
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
              // The wrapper does not scroll, so the vertical position must
              // subtract the current scrollTop to keep the box on the block;
              // the width is the scroller's client width (the code area,
              // excluding the scrollbar and the overview ruler), so the right
              // edge lands exactly on the code's right edge. A block taller
              // than the viewport would draw a box past the scroll box, so the
              // height is clamped to the scroller's visible height.
              top: focusedBlock.start * ROW_HEIGHT_PX - scrollTop,
              height: Math.min(
                (focusedBlock.end - focusedBlock.start + 1) * ROW_HEIGHT_PX,
                viewportHeight > 0 ? viewportHeight : Number.POSITIVE_INFINITY,
              ),
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
          <div className={css.overviewRuler} data-diff-approval-ruler aria-hidden="true">
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
      </div>
    </div>
  )
}

/** Render the pending-edit review panel and its unified footer action. */
export function PendingPanel({
  wide, useSessions, usePending, onRefresh, onKeep, onRevert, onBlockKeep, onBlockRevert, onOpen, onPasteReference, onUndo, onRedo, onImportVcs, t,
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
  /** Bottom offset tracking the chat composer's top edge so the input stays visible. */
  const [bottomPx, setBottomPx] = useState(FALLBACK_BOTTOM_PX)
  /** Fullscreen expanded: the panel bottom pins to the window edge, ignoring the composer offset. */
  const [expanded, setExpanded] = useState(false)
  /** File-list pane width, adjustable by dragging the divider. */
  const [listWidth, setListWidth] = useState(240)
  const resizeDrag = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    onRefresh(current)
    const timer = setInterval(() => { onRefresh(current) }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [current, onRefresh])

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
  // same workspace stay out of the list, badge, and auto-advance.
  const files = snapshot.files.filter(file => file.sessionId === current)
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
        // the open file; any other row switches the selection.
        if (id === selected) setJumpSignal(signal => signal + 1)
        else setSelected(id)
      }}
    />
  )

  const selectedFile = files.find(file => file.id === selected)

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
            <div className={css.split}>
              <nav className={css.fileList} style={{ width: listWidth }} data-diff-approval-file-list>
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
              </nav>
              <div className={css.resizeHandle} data-diff-resize onMouseDown={startResize} />
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
                  />
                )}
              </div>
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
    </div>
  )
}
