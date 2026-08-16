/** Sidebar-foot pending-edit review action and the whole-file diff list it opens. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { IconListPenOutline16, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PendingFileDiff } from '../types.ts'
import type { PendingPanelFace } from './slots.ts'
import type { DiffApprovalKey } from './locales.ts'
import { computeWholeFileDiff } from './whole-file-diff.ts'
import type { WholeFileDiffRow } from './whole-file-diff.ts'
import { highlightLines } from './highlight.ts'
import { langFromPath } from './lang.ts'
import { copyDisplayPath, referenceOf } from './reference.ts'
import css from './PendingPanel.module.css'

/**
 * How often the panel re-reads the pending list. An external plugin cannot
 * register on the host's forwarded-event allowlist, so polling is its change
 * feed; it runs while the action is mounted so the badge count stays current
 * even with the panel closed. The read is one small RPC per second.
 */
const POLL_INTERVAL_MS = 1000

/** Full panel props composed by the sidebar footer-action slot. */
export type PendingPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<PendingPanelFace> & PropsLocale<'diff-approval'>

/** One pending file row: expandable head plus the merged whole-file diff. */
interface PendingRowProps {
  file: PendingFileDiff
  files: readonly PendingFileDiff[]
  selected: boolean
  busy: boolean
  t: (key: DiffApprovalKey, params?: Record<string, unknown>) => string
  onSelect: (id: string) => void
  onKeep: (sessionId: SessionId, id: string) => Promise<void>
  onRevert: (sessionId: SessionId, id: string) => Promise<void>
}

/** The diff body's row class per line kind. */
const ROW_CLASS = {
  context: css.context,
  del: css.del,
  add: css.add,
} as const

/** One expanded row's derived view: diff rows, change blocks, highlight runs. */
interface RowModel {
  diff: ReturnType<typeof computeWholeFileDiff>
  /** Maximal runs of changed rows (inclusive row indices); one per modification. */
  blocks: ChangeBlock[]
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

function PendingRow({ file, files, selected, busy, t, onSelect, onKeep, onRevert }: PendingRowProps) {
  const lang = useMemo(() => langFromPath(file.path), [file.path])
  const model = useMemo<RowModel | undefined>(() => {
    if (!selected) return undefined
    const diff = computeWholeFileDiff(file.oldText, file.newText)
    return {
      diff,
      blocks: changeBlocksOf(diff),
      oldRuns: highlightLines(file.oldText, lang),
      newRuns: highlightLines(file.newText, lang),
    }
  }, [selected, file.oldText, file.newText, lang])

  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const bodyRef = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const [drag, setDrag] = useState<{ anchor: number; end: number } | undefined>()
  const [range, setRange] = useState<RowRange | undefined>()
  const [copied, setCopied] = useState(false)

  // Reset transient viewer state whenever the expanded target changes.
  useEffect(() => {
    setFocus(0)
    setDrag(undefined)
    setRange(undefined)
    setCopied(false)
  }, [file.id, selected])

  // Center the focused change block after focus or content changes.
  useEffect(() => {
    if (model === undefined || model.blocks.length === 0) return
    const block = model.blocks[focus]
    if (block === undefined) return
    rowRefs.current.get(block.start)?.scrollIntoView({ block: 'center' })
  }, [model, focus])

  const jump = (direction: -1 | 1) => {
    setFocus(current => {
      if (model === undefined || model.blocks.length === 0) return current
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
  }

  const registerRow = (index: number) => (element: HTMLDivElement | null) => {
    if (element === null) rowRefs.current.delete(index)
    else rowRefs.current.set(index, element)
  }

  const rowMouseDown = (index: number) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    setDrag({ anchor: index, end: index })
    setRange({ start: index, end: index })
  }

  const rowMouseEnter = (index: number) => () => {
    setDrag(current => {
      if (current === undefined) return current
      const next = { ...current, end: index }
      setRange({ start: Math.min(next.anchor, next.end), end: Math.max(next.anchor, next.end) })
      return next
    })
  }

  const endDrag = () => {
    setDrag(current => {
      if (current === undefined) return undefined
      setRange({ start: Math.min(current.anchor, current.end), end: Math.max(current.anchor, current.end) })
      return undefined
    })
  }

  const selection = drag === undefined && range !== undefined && model !== undefined ? range : undefined
  // Anchor the toolbar to the selected range's first row as seen inside the
  // scrolled body, clamped so it never floats out of the visible diff area.
  const selectionTop = (() => {
    if (selection === undefined) return 0
    const row = rowRefs.current.get(selection.start)
    const body = bodyRef.current
    if (row === undefined || body === null) return 0
    const bodyTop = body.offsetTop
    const rowTop = bodyTop + row.getBoundingClientRect().top - body.getBoundingClientRect().top
    const clamped = Math.max(rowTop - 36, bodyTop)
    return Math.min(clamped, Math.max(bodyTop, bodyTop + body.clientHeight - 36))
  })()

  const copySelection = async () => {
    if (selection === undefined || model === undefined) return
    const rows = model.diff.rows.slice(selection.start, selection.end + 1)
    // New-side numbers where they exist; a pure deletion falls back to the
    // old side, which is the only side those lines have.
    const lineNumbers = rows
      .map(row => row.newLine ?? row.oldLine)
      .filter((number): number is number => number !== undefined)
    if (lineNumbers.length === 0) return
    const accepted = await writeClipboard(
      referenceOf(file.path, files, Math.min(...lineNumbers), Math.max(...lineNumbers)),
    )
    if (!accepted) return
    setCopied(true)
    window.setTimeout(() => { setCopied(false) }, 1500)
  }

  /** One line's text: token spans when highlighted, plain text otherwise. */
  const renderLine = (row: WholeFileDiffRow): ReactNode => {
    const lineNumber = row.kind === 'del' ? row.oldLine : row.newLine
    const runs = model === undefined || lineNumber === undefined
      ? undefined
      : (row.kind === 'del' ? model.oldRuns : model.newRuns)?.[lineNumber - 1]
    if (runs === undefined || runs.length === 0) return row.text === '' ? '\u00a0' : row.text
    return runs.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
  }

  const focusedBlock = model !== undefined && model.blocks.length > 0 ? model.blocks[focus] : undefined
  const inFocusedBlock = (index: number): boolean =>
    focusedBlock !== undefined && index >= focusedBlock.start && index <= focusedBlock.end

  return (
    <li className={css.row}>
      <button
        type="button"
        className={css.rowHead}
        data-selected={selected || undefined}
        aria-expanded={selected}
        onClick={() => { onSelect(selected ? '' : file.id) }}
      >
        <span className={css.rowPath} title={file.path}>{copyDisplayPath(file.path, files)}</span>
        {file.kind === 'create' && <span className={css.kindTag}>{t('row.create')}</span>}
        {file.missing && <span className={css.missing} title={t('panel.missingHint')}>{t('panel.missing')}</span>}
      </button>
      {selected && model !== undefined && (
        <div className={css.diff} data-diff-approval-diff onMouseUp={endDrag}>
          <div className={css.diffActions}>
            <span className={css.diffStats}>{t('panel.stats', { added: model.diff.added, removed: model.diff.removed })}</span>
            {file.kind === 'create' && <span className={css.kindHint}>{t('panel.createHint')}</span>}
            {model.blocks.length > 0 && (
              <>
                <button type="button" className={css.action} data-diff-prev disabled={busy} onClick={() => { jump(-1) }}>
                  {t('action.prevDiff')}
                </button>
                <button type="button" className={css.action} data-diff-next disabled={busy} onClick={() => { jump(1) }}>
                  {t('action.nextDiff')}
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
                  data-diff-focused={inFocusedBlock(index) ? '' : undefined}
                  onMouseDown={rowMouseDown(index)}
                  onMouseEnter={rowMouseEnter(index)}
                >
                  <span className={css.gutter}>{row.oldLine ?? ''}</span>
                  <span className={css.gutter}>{row.newLine ?? ''}</span>
                  <span className={css.code}>{renderLine(row)}</span>
                </div>
              ))}
            </div>
          </div>
          {selection !== undefined && (
            <div className={css.toolbar} style={{ top: selectionTop }} data-diff-selection-toolbar>
              <button type="button" className={css.toolbarButton} data-diff-copy onClick={() => { void copySelection() }}>
                {copied ? t('action.copied') : t('action.copyRange')}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** Render the pending-edit review panel and its unified footer action. */
export function PendingPanel({
  wide, useSessions, usePending, onRefresh, onKeep, onRevert, t,
}: PendingPanelProps) {
  const current = useSessions(state => state.current)
  const snapshot = usePending(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  /** Pending count captured at open time; auto-close needs a list that emptied. */
  const [openedCount, setOpenedCount] = useState(0)

  useEffect(() => {
    onRefresh(current)
    const timer = setInterval(() => { onRefresh(current) }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [current, onRefresh])

  const files = snapshot.files
  const mine = files.filter(file => file.sessionId === current)
  const theirs = files.filter(file => file.sessionId !== current)

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
    <PendingRow
      key={entry.id}
      file={entry}
      files={files}
      selected={selected === entry.id}
      busy={snapshot.busy.has(entry.id)}
      t={t}
      onSelect={setSelected}
      onKeep={onKeep}
      onRevert={onRevert}
    />
  )

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <section className={css.panel} data-diff-approval-panel aria-label={t('panel.title')}>
          <header className={css.header}>
            <span className={css.title}>{t('panel.title')}</span>
          </header>
          <div className={css.body}>
            {snapshot.error !== undefined && (
              <p className={css.readError} role="alert">{t('panel.readFailed', { message: snapshot.error })}</p>
            )}
            {!snapshot.read && snapshot.error === undefined && <p className={css.note}>{t('panel.loading')}</p>}
            {snapshot.read && snapshot.error === undefined && files.length === 0
              && <p className={css.note}>{t('panel.empty')}</p>}
            {snapshot.read && files.length > 0 && (
              <p className={css.hint}>{t('panel.selectHint')}</p>
            )}
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
          </div>
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-diff-approval-badge={files.length}
          data-active={open || files.length > 0 ? '' : undefined}
          aria-label={t('panel.aria')}
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {wide && <IconListPenOutline16 size={16} />}
          <span className={css.badgeLabel}>{t('panel.aria')}</span>
          {(wide || files.length > 0) && <span className={css.badgeCount}>{files.length}</span>}
        </button>
      </div>
    </div>
  )
}
