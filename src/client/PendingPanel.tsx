/** Sidebar-foot pending-edit review action and the split review panel it opens. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { IconBrowseOutline16, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconFolderOpenOutline16, IconFullscreenOutline16, IconListPenOutline16, Menu, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DiffApprovalOpenAction, PendingFileDiff } from '../types.ts'
import type { PendingPanelFace } from './slots.ts'
import type { DiffApprovalKey } from './locales.ts'
import { computeWholeFileDiff } from './whole-file-diff.ts'
import type { WholeFileDiffRow } from './whole-file-diff.ts'
import { HIGHLIGHT_LANGS, highlightLines, languageDisplayName } from './highlight.ts'
import { langFromPath } from './lang.ts'
import { referenceOf } from './reference.ts'
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

/** One file row in the left list pane. */
interface PendingFileRowProps {
  file: PendingFileDiff
  selected: boolean
  t: Translator
  onSelect: (id: string) => void
}

/** The right detail pane for one selected file: actions plus the merged diff. */
interface PendingDiffProps {
  file: PendingFileDiff
  files: readonly PendingFileDiff[]
  busy: boolean
  t: Translator
  onKeep: (sessionId: SessionId, id: string) => Promise<void>
  onRevert: (sessionId: SessionId, id: string) => Promise<void>
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
}

/** The diff body's row class per line kind. */
const ROW_CLASS = {
  context: css.context,
  del: css.del,
  add: css.add,
} as const

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
function PendingFileRow({ file, selected, t, onSelect }: PendingFileRowProps) {
  const stats = useMemo(
    () => computeWholeFileDiff(file.oldText, file.newText),
    [file.oldText, file.newText],
  )
  return (
    <li className={css.row}>
      <button
        type="button"
        className={css.rowHead}
        data-selected={selected || undefined}
        onClick={() => { onSelect(file.id) }}
      >
        <Tooltip label={file.path} delayMs={500} maxWidth={560}>
          <span className={css.rowPath}>{basenameOf(file.path)}</span>
        </Tooltip>
        {file.kind === 'create' && <span className={css.kindTag}>{t('row.create')}</span>}
        {file.missing && <span className={css.missing} title={t('panel.missingHint')}>{t('panel.missing')}</span>}
        <span className={css.rowMeta}>
          <span className={css.addCount}>{t('row.added', { added: stats.added })}</span>
          <span className={css.delCount}>{t('row.removed', { removed: stats.removed })}</span>
        </span>
      </button>
    </li>
  )
}

/** The selected file's diff, actions, jump controls, and copy toolbar. */
function PendingDiff({ file, files, busy, t, onKeep, onRevert, onOpen }: PendingDiffProps) {
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

  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const bodyRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  const [selection, setSelection] = useState<RowRange | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  // Reset transient viewer state whenever the selected file changes.
  useEffect(() => {
    setFocus(0)
    setSelection(undefined)
    setLangOverride(undefined)
    setLangMenuOpen(false)
    setCopied(false)
  }, [file.id])

  // Center the focused change block after focus, content changes, or a jump.
  useEffect(() => {
    if (model.blocks.length === 0) return
    const block = model.blocks[focus]
    if (block === undefined) return
    rowRefs.current.get(block.start)?.scrollIntoView({ block: 'center' })
  }, [model, focus, scrollTick])

  const jump = (direction: -1 | 1) => {
    if (model.blocks.length === 0) return
    setFocus(current => {
      if (direction === -1) {
        return (current - 1 + model.blocks.length) % model.blocks.length
      }
      const bodyRect = bodyRef.current?.getBoundingClientRect()
      // Forward scan without wrapping: land on the first block at or below
      // the viewport top (blocks scrolled out above are skipped).
      for (let index = current + 1; index < model.blocks.length; index++) {
        const block = model.blocks[index]
        if (block === undefined) continue
        const row = rowRefs.current.get(block.start)
        if (row === undefined || bodyRect === undefined || row.getBoundingClientRect().top >= bodyRect.top) {
          return index
        }
      }
      // Past the last block — wrap to the first.
      return 0
    })
    // Bump the centering effect even when the focus is unchanged (a single
    // block), so an out-of-view block is always scrolled back into view.
    setScrollTick(tick => tick + 1)
  }

  const registerRow = (index: number) => (element: HTMLDivElement | null) => {
    if (element === null) rowRefs.current.delete(index)
    else rowRefs.current.set(index, element)
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
    // New-side numbers where they exist; a pure deletion falls back to the
    // old side, which is the only side those lines have.
    const lineNumbers = rows
      .map(row => row.newLine ?? row.oldLine)
      .filter((number): number is number => number !== undefined)
    if (lineNumbers.length === 0) return undefined
    return referenceOf(file.path, files, Math.min(...lineNumbers), Math.max(...lineNumbers))
  })()

  const copySelection = useCallback(async () => {
    if (selectionReference === undefined) return
    const accepted = await writeClipboard(selectionReference)
    if (!accepted) return
    setCopied(true)
    window.setTimeout(() => { setCopied(false) }, 1500)
  }, [selectionReference])

  // Ctrl/Cmd+L copies the selected line range; the chord is left to the
  // browser's own default when there is no selection to reference.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== 'l') return
      if (selectionReference === undefined) return
      event.preventDefault()
      void copySelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [copySelection])

  /** One line's text: token spans when highlighted, plain text otherwise. */
  const renderLine = (row: WholeFileDiffRow): ReactNode => {
    const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine
    const sideRuns = row.kind === 'del' ? runs?.oldRuns : runs?.newRuns
    const lineRuns = lineNumber === undefined ? undefined : sideRuns?.[lineNumber - 1]
    if (lineRuns === undefined || lineRuns.length === 0) return row.text === '' ? '\u00a0' : row.text
    return lineRuns.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
  }

  const focusedBlock = model.blocks.length > 0 ? model.blocks[focus] : undefined
  const inFocusedBlock = (index: number): boolean =>
    focusedBlock !== undefined && index >= focusedBlock.start && index <= focusedBlock.end

  return (
    <div className={css.diff} data-diff-approval-diff>
      <div className={css.diffHeader}>
        <span className={css.diffPath}>{file.path}</span>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-open
          aria-label={t('action.openFile')}
          title={t('action.openFile')}
          onClick={() => { void onOpen(file.sessionId, file.id, 'open') }}
        >
          <IconBrowseOutline16 size={14} />
        </button>
        <button
          type="button"
          className={`${css.action} ${css.iconAction}`}
          data-diff-reveal
          aria-label={t('action.revealFile')}
          title={t('action.revealFile')}
          onClick={() => { void onOpen(file.sessionId, file.id, 'reveal') }}
        >
          <IconFolderOpenOutline16 size={14} />
        </button>
      </div>
      <div className={css.diffActions}>
        <span className={css.diffStats}>{t('panel.stats', { added: model.diff.added, removed: model.diff.removed })}</span>
        {file.kind === 'create' && <span className={css.kindHint}>{t('panel.createHint')}</span>}
        {model.blocks.length > 0 && (
          <>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-prev
              aria-label={t('action.prevDiff')}
              title={t('action.prevDiff')}
              disabled={busy}
              onClick={() => { jump(-1) }}
            >
              <IconChevronUpOutline14 size={14} />
            </button>
            <button
              type="button"
              className={`${css.action} ${css.iconAction}`}
              data-diff-next
              aria-label={t('action.nextDiff')}
              title={t('action.nextDiff')}
              disabled={busy}
              onClick={() => { jump(1) }}
            >
              <IconChevronDownOutline14 size={14} />
            </button>
          </>
        )}
        <span className={css.flexSpacer} />
        <button
          type="button"
          className={css.action}
          data-diff-keep
          disabled={busy}
          onClick={() => { void onKeep(file.sessionId, file.id) }}
        >
          {busy ? t('action.busy') : t('action.keep')}
        </button>
        <button
          type="button"
          className={css.action}
          data-diff-revert
          disabled={busy}
          onClick={() => { void onRevert(file.sessionId, file.id) }}
        >
          {busy ? t('action.busy') : t('action.revert')}
        </button>
      </div>
      {file.missing && <p className={css.missingHint}>{t('panel.missingHint')}</p>}
      <div className={css.diffBody} ref={bodyRef}>
        <div className={css.lines}>
          {model.diff.rows.map((row, index) => (
            <div
              key={index}
              ref={registerRow(index)}
              className={`${css.line} ${ROW_CLASS[row.kind]}`}
              data-diff-line={row.kind}
              data-diff-row={index}
              data-diff-focused={inFocusedBlock(index) ? '' : undefined}
            >
              <span className={css.gutter}>{row.oldLine ?? ''}</span>
              <span className={css.gutter}>{row.newLine ?? ''}</span>
              <span className={css.code} data-diff-code>{renderLine(row)}</span>
            </div>
          ))}
        </div>
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
            <button
              type="button"
              className={css.langSelect}
              data-diff-lang
              aria-label={t('action.langSelect')}
              title={t('action.langSelect')}
              onClick={() => { setLangMenuOpen(value => !value) }}
            >
              <span className={css.langLabel}>{langLabel}</span>
              <IconChevronDownOutline14 size={12} />
            </button>
          )}
        />
      </div>
    </div>
  )
}

/** Render the pending-edit review panel and its unified footer action. */
export function PendingPanel({
  wide, useSessions, usePending, onRefresh, onKeep, onRevert, onOpen, t,
}: PendingPanelProps) {
  const current = useSessions(state => state.current)
  const snapshot = usePending(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  /** Pending count captured at open time; auto-close needs a list that emptied. */
  const [openedCount, setOpenedCount] = useState(0)
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

  const files = snapshot.files
  const mine = files.filter(file => file.sessionId === current)
  const theirs = files.filter(file => file.sessionId !== current)

  // Auto-open the first pending file when the panel opens, and advance to the
  // next one once the selected file is handled. Selection is single and cannot
  // be cleared by clicking — only an empty list shows the empty state.
  useEffect(() => {
    if (!open) return
    if (selected !== '' && files.some(file => file.id === selected)) return
    const next = [...mine, ...theirs][0]
    if (next !== undefined && next.id !== selected) setSelected(next.id)
  }, [open, current, files, selected])

  // A list that empties through Keep/Revert closes the panel; opening an
  // already-empty list stays open so the empty note stays readable. An error
  // also keeps it open.
  useEffect(() => {
    if (open && openedCount > 0 && snapshot.read && snapshot.error === undefined && files.length === 0) {
      setOpenedCount(0)
      setOpen(false)
    }
  }, [open, openedCount, snapshot.read, snapshot.error, files.length])

  const toggleOpen = () => {
    if (!open) setOpenedCount(files.length)
    setOpen(value => !value)
  }

  const renderEntry = (entry: PendingFileDiff) => (
    <PendingFileRow
      key={entry.id}
      file={entry}
      selected={selected === entry.id}
      t={t}
      onSelect={setSelected}
    />
  )

  const selectedFile = files.find(file => file.id === selected)

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
              <button
                type="button"
                className={expanded ? `${css.expand} ${css.expandExpanded}` : css.expand}
                data-diff-approval-expand
                aria-label={t(expanded ? 'action.exitFullscreen' : 'action.expand')}
                title={t(expanded ? 'action.exitFullscreen' : 'action.expand')}
                onClick={() => { setExpanded(value => !value) }}
              >
                <IconFullscreenOutline16 size={14} />
              </button>
              <button
                type="button"
                className={css.close}
                data-diff-approval-close
                aria-label={t('action.close')}
                title={t('action.close')}
                onClick={() => { setOpen(false) }}
              >
                <IconCloseOutline16 size={14} />
              </button>
            </div>
          </header>
          {snapshot.error !== undefined || !snapshot.read || files.length === 0 ? (
            <div className={css.states}>
              {snapshot.error !== undefined && (
                <p className={css.readError} role="alert">{t('panel.readFailed', { message: snapshot.error })}</p>
              )}
              {!snapshot.read && snapshot.error === undefined && <p className={css.note}>{t('panel.loading')}</p>}
              {snapshot.read && snapshot.error === undefined && files.length === 0
                && <p className={css.note}>{t('panel.empty')}</p>}
            </div>
          ) : (
            <div className={css.split}>
              <nav className={css.fileList} style={{ width: listWidth }} data-diff-approval-file-list>
                {mine.length > 0 && (
                  <section>
                    <h3 className={css.group}>{t('panel.group.current')}</h3>
                    <ul className={css.rows}>{mine.map(renderEntry)}</ul>
                  </section>
                )}
                {theirs.length > 0 && (
                  <section>
                    <h3 className={css.group}>{t('panel.group.others')}</h3>
                    <ul className={css.rows}>{theirs.map(renderEntry)}</ul>
                  </section>
                )}
              </nav>
              <div className={css.resizeHandle} data-diff-resize onMouseDown={startResize} />
              <div className={css.detail}>
                {selectedFile === undefined ? (
                  <p className={css.detailEmpty}>{t('panel.selectHint')}</p>
                ) : (
                  <PendingDiff
                    file={selectedFile}
                    files={files}
                    busy={snapshot.busy.has(selectedFile.id)}
                    t={t}
                    onKeep={onKeep}
                    onRevert={onRevert}
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
          className={css.badge}
          data-diff-approval-badge={files.length}
          data-active={open ? '' : undefined}
          aria-label={t('panel.aria')}
          aria-expanded={open}
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
