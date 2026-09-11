/**
 * The add-path dialog: pick one path in a lazily-loaded workspace tree — or type
 * it outright — then press Add. Nothing is added by pointing at it: the path and
 * the no-change box are prepared first, and the host judges them once the button
 * is pressed.
 *
 * The path box is the single source of truth for the selection: a tree row is
 * highlighted while its path is the box's text, and editing the text by hand
 * simply leaves no row highlighted.
 *
 * The dialog is a modal inside the panel: it owns Escape while it is on screen
 * (the panel's own chords stand down, see `pathPickerOpen`).
 * @module dsh-diff-approval/client/PathPicker
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16, IconFolderClose16, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiffApprovalAddValue, DiffApprovalBrowseEntry } from '../types.ts'
import type { Translator } from './locales.ts'
import css from './PendingPanel.module.css'

/** Whether this panel's add-path dialog is on screen. The panel's global chords
 *  consult this so the modal owns the keyboard while it is open. */
export function pathPickerOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[data-diff-path-picker]') !== null
}

/** One directory level's state in the tree. */
type LevelState =
  | { status: 'loading' }
  | { status: 'ready'; entries: readonly DiffApprovalBrowseEntry[]; truncated: boolean }
  | { status: 'failed'; error: string }

/**
 * The file glyph the icon library lacks (it ships folders only): a page with a
 * folded corner, drawn on the same 16px grid as the folder icons.
 * @returns the 16px file glyph.
 */
function FileIcon(): ReactElement {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" data-diff-file-icon>
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M3.5 1.5h5l4 4v9h-9zM8.5 1.5v4h4z" />
    </svg>
  )
}

/** Full props of the add-path dialog. */
export interface PathPickerProps {
  /** The session's workspace root (absolute), for the tree's top row. */
  rootPath?: string | undefined
  /** List one workspace directory level (absolute path; undefined is the root). */
  onBrowse: (path?: string) => Promise<{ path: string; entries: DiffApprovalBrowseEntry[]; truncated: boolean }>
  /** Add the chosen path; resolves to what the host's scan did. */
  onAdd: (path: string, includeUnchanged: boolean) => Promise<DiffApprovalAddValue>
  /** Transient banner for an outcome the dialog does not stay open for. */
  onToast: (text: string) => void
  onClose: () => void
  t: Translator
}

/**
 * The add-path dialog.
 * @param props - the workspace root, the host calls, and the close/toast sinks.
 * @returns the modal (rendered only while open by its parent).
 */
export function PathPicker({ rootPath, onBrowse, onAdd, onToast, onClose, t }: PathPickerProps): ReactElement {
  /** The path box: the target, and the tree's selection, in one string. */
  const [path, setPath] = useState('')
  const [levels, setLevels] = useState<Readonly<Record<string, LevelState>>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']))
  /** Every open starts unticked: the box is a per-add decision. */
  const [includeUnchanged, setIncludeUnchanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // The caller passes fresh closures every render (the panel re-renders on its
  // poll); keeping them in refs means no effect or callback here ever re-runs
  // because of that, which is what used to bounce the browser back to the root.
  const browseRef = useRef(onBrowse)
  browseRef.current = onBrowse
  const addRef = useRef(onAdd)
  addRef.current = onAdd
  const toastRef = useRef(onToast)
  toastRef.current = onToast
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  /** Load one directory level; `dir` is workspace-relative (`''` is the root). */
  const load = useCallback(async (dir: string): Promise<void> => {
    setLevels(prev => ({ ...prev, [dir]: { status: 'loading' } }))
    try {
      const value = await browseRef.current(dir === '' ? undefined : dir)
      setLevels(prev => ({ ...prev, [dir]: { status: 'ready', entries: value.entries, truncated: value.truncated } }))
    } catch (error: unknown) {
      setLevels(prev => ({ ...prev, [dir]: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }))
    }
  }, [])

  // Load the root exactly once, and put the caret in the box: typing a path is
  // the fastest route for anyone who already knows it.
  useEffect(() => {
    void load('')
    inputRef.current?.focus()
  }, [load])

  // The modal owns Escape while it is on screen. A window-capture listener is
  // the only place that can win against the panel's own global chords, and those
  // stand down while `pathPickerOpen()` (see PendingPanel).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  /** Report one add outcome; only a landed add closes the dialog. */
  const report = (value: DiffApprovalAddValue): void => {
    const toast = toastRef.current
    if (value.outcome === 'added') {
      // A cut walk says so: the caller asked for everything under the path.
      toast(value.truncated === true
        ? t('panel.addDoneTruncated', { count: value.added })
        : t('panel.addDone', { count: value.added }))
      closeRef.current()
      return
    }
    if (value.outcome === 'duplicate') toast(t('panel.addDuplicate'))
    else if (value.outcome === 'unchanged') toast(t('panel.addUnchanged'))
    else if (value.outcome === 'empty') toast(t('panel.addEmpty'))
    else if (value.outcome === 'missing') toast(t('panel.addMissing'))
    else if (value.outcome === 'outside') toast(t('panel.addOutside'))
    else if (value.outcome === 'no-vcs') toast(t('panel.importNoVcs'))
    else toast(t('panel.addFailed', { message: value.message ?? '' }))
  }

  /** The dialog's one action: the host judges the path here, not on selection. */
  const submit = async (): Promise<void> => {
    const target = path.trim()
    if (target === '' || busy) return
    setBusy(true)
    try {
      report(await addRef.current(target, includeUnchanged))
    } catch (error: unknown) {
      toastRef.current(t('panel.addFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** Expand or collapse one directory, loading its level the first time. */
  const toggle = (dir: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
    if (levels[dir] === undefined) void load(dir)
  }

  /** One tree row: caret, icon, name. Selecting only fills the path box. */
  const row = (entry: DiffApprovalBrowseEntry, depth: number): ReactNode => {
    const isDirectory = entry.type === 'directory'
    const isOpen = expanded.has(entry.path)
    const selected = path === entry.path
    return (
      <div
        key={entry.path}
        className={css.treeRow}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        data-diff-picker-row={entry.path}
        data-selected={selected ? '' : undefined}
      >
        {isDirectory
          ? (
            <button
              type="button"
              className={css.treeCaret}
              data-diff-picker-toggle={entry.path}
              aria-expanded={isOpen}
              aria-label={isOpen ? t('action.collapseRow') : t('action.expandRow')}
              onClick={() => { toggle(entry.path) }}
            >
              {isOpen ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
            </button>
          )
          : <span className={css.treeCaret} aria-hidden="true" />}
        <button
          type="button"
          className={css.treeName}
          data-diff-picker-select={entry.path}
          aria-pressed={selected}
          onClick={() => { setPath(entry.path) }}
        >
          {isDirectory
            ? (isOpen ? <IconFolderOpen16 size={16} className={css.pickerIcon} /> : <IconFolderClose16 size={16} className={css.pickerIcon} />)
            : <span className={css.pickerIcon}><FileIcon /></span>}
          <span className={css.pickerName}>{entry.name}</span>
        </button>
      </div>
    )
  }

  /** One loaded level's children, expanded directories recursing into their own.
   *  `trail` carries the branch's ancestors: a directory that lists itself (a
   *  symlink loop) must stop the walk rather than recurse forever. */
  const levelRows = (dir: string, depth: number, trail: ReadonlySet<string>): ReactNode => {
    const level = levels[dir]
    if (level === undefined || level.status === 'loading') {
      return <p className={css.treeNote} style={{ paddingLeft: `${10 + depth * 14}px` }}>{t('panel.loading')}</p>
    }
    if (level.status === 'failed') {
      return <p className={css.treeNote} style={{ paddingLeft: `${10 + depth * 14}px` }} role="alert">{level.error}</p>
    }
    if (level.entries.length === 0) {
      return <p className={css.treeNote} style={{ paddingLeft: `${10 + depth * 14}px` }}>{t('panel.addNoEntries')}</p>
    }
    return (
      <>
        {level.entries.map(entry => {
          const descends = entry.type === 'directory' && expanded.has(entry.path) && !trail.has(entry.path)
          return (
            <div key={entry.path}>
              {row(entry, depth)}
              {descends ? levelRows(entry.path, depth + 1, new Set([...trail, entry.path])) : null}
            </div>
          )
        })}
        {level.truncated && (
          <p className={css.treeNote} style={{ paddingLeft: `${10 + depth * 14}px` }}>
            {t('panel.addTruncated', { count: level.entries.length })}
          </p>
        )}
      </>
    )
  }

  const rootSelected = rootPath !== undefined && path === rootPath

  return (
    <div className={css.confirmBackdrop} data-diff-path-picker>
      <div className={css.pickerCard} role="dialog" aria-modal="true" aria-label={t('panel.addTitle')}>
        <span className={css.pickerTitle}>{t('panel.addTitle')}</span>
        <div className={css.pickerForm}>
          <input
            ref={inputRef}
            className={css.pickerInput}
            data-diff-picker-input
            value={path}
            placeholder={t('panel.addPathPlaceholder')}
            onChange={(event) => { setPath(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void submit()
            }}
          />
        </div>
        <div className={css.tree} data-diff-picker-tree>
          <div
            className={css.treeRow}
            style={{ paddingLeft: '4px' }}
            data-diff-picker-row={rootPath ?? ''}
            data-selected={rootSelected ? '' : undefined}
          >
            <button
              type="button"
              className={css.treeCaret}
              data-diff-picker-toggle=""
              aria-expanded={expanded.has('')}
              aria-label={expanded.has('') ? t('action.collapseRow') : t('action.expandRow')}
              onClick={() => { toggle('') }}
            >
              {expanded.has('') ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
            </button>
            <button
              type="button"
              className={css.treeName}
              data-diff-picker-select=""
              aria-pressed={rootSelected}
              disabled={rootPath === undefined}
              onClick={() => { setPath(rootPath ?? '') }}
            >
              {expanded.has('') ? <IconFolderOpen16 size={16} className={css.pickerIcon} /> : <IconFolderClose16 size={16} className={css.pickerIcon} />}
              <span className={css.pickerName}>{t('panel.addRoot')}</span>
            </button>
          </div>
          {expanded.has('') ? levelRows('', 1, new Set([''])) : null}
        </div>
        <p className={css.pickerNote}>{t('panel.addHint')}</p>
        <div className={css.confirmActions}>
          <label className={css.pickerCheck}>
            <input
              type="checkbox"
              data-diff-picker-unchanged
              checked={includeUnchanged}
              onChange={(event) => { setIncludeUnchanged(event.target.checked) }}
            />
            {t('panel.addIncludeUnchanged')}
          </label>
          <button type="button" className={css.action} data-diff-picker-cancel onClick={() => { closeRef.current() }}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className={`${css.action} ${css.actionPrimary}`}
            data-diff-picker-submit
            disabled={busy || path.trim() === ''}
            onClick={() => { void submit() }}
          >
            {t('panel.addPathGo')}
          </button>
        </div>
        <button type="button" className={css.pickerClose} data-diff-picker-close aria-label={t('action.close')} onClick={() => { closeRef.current() }}>
          <IconCloseOutline16 size={14} />
        </button>
      </div>
    </div>
  )
}
