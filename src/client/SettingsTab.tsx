/** DSH Settings top-level section for this plugin's preferences. */

import { useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { includeUntrackedEnabled, pasteOnCopyEnabled, quickSummonKey, setIncludeUntrackedEnabled, setPasteOnCopyEnabled, setQuickSummonKey, setSplitMode, setTabWidth, splitMode, tabWidth } from './settings.ts'
import type { DiffApprovalKey } from './locales.ts'
import css from './PendingPanel.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type DiffApprovalSettingsTabProps =
  PropsRuntime<'settings.section'> & PropsLocale<'diff-approval'>

/** The same translator shape the panel uses. */
type Translator = (key: DiffApprovalKey, params?: Record<string, unknown>) => string

/** A pill picker offering the two boolean states 打开 / 关闭. */
function OnOffPicker({
  value, open, onOpenChange, onSelect, dataAttribute, t,
}: {
  value: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (value: boolean) => void
  dataAttribute: string
  t: Translator
}) {
  return (
    <Menu
      open={open}
      onClose={() => { onOpenChange(false) }}
      items={[
        { id: 'on', label: t('action.toggleOn') },
        { id: 'off', label: t('action.toggleOff') },
      ]}
      selectedId={value ? 'on' : 'off'}
      onSelect={(id) => {
        onOpenChange(false)
        onSelect(id === 'on')
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className={css.settingsSelector}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { onOpenChange(!open) }}
          {...{ [dataAttribute]: true }}
        >
          {value ? t('action.toggleOn') : t('action.toggleOff')}
          <IconChevronDownOutline14 className={css.settingsSelectorChevron} />
        </button>
      )}
    />
  )
}

/** One Agent-preset-style preference row: title + description, pill picker right. */
function PreferenceRow({
  title, description, value, open, onOpenChange, onSelect, dataAttribute, t,
}: {
  title: string
  description: string
  value: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (value: boolean) => void
  dataAttribute: string
  t: Translator
}) {
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowText}>
        <div className={css.settingsRowTitle}>{title}</div>
        <div className={css.settingsRowDesc}>{description}</div>
      </div>
      <OnOffPicker
        value={value}
        open={open}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        dataAttribute={dataAttribute}
        t={t}
      />
    </div>
  )
}

/** A picker offering the tab-width choices 2 / 4 / 8 (spaces). */
function TabWidthPicker({
  value, open, onOpenChange, onSelect, dataAttribute,
}: {
  value: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (value: number) => void
  dataAttribute: string
}) {
  const options = [2, 4, 8]
  return (
    <Menu
      open={open}
      onClose={() => { onOpenChange(false) }}
      items={options.map(n => ({ id: String(n), label: String(n) }))}
      selectedId={String(value)}
      onSelect={(id) => {
        onOpenChange(false)
        const n = Number.parseInt(id, 10)
        if (Number.isFinite(n)) onSelect(n)
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className={css.settingsSelector}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { onOpenChange(!open) }}
          {...{ [dataAttribute]: true }}
        >
          {value}
          <IconChevronDownOutline14 className={css.settingsSelectorChevron} />
        </button>
      )}
    />
  )
}

/** One tab-width preference row: title + description, number picker right. */
function TabWidthRow({
  title, description, value, open, onOpenChange, onSelect, dataAttribute,
}: {
  title: string
  description: string
  value: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (value: number) => void
  dataAttribute: string
}) {
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowText}>
        <div className={css.settingsRowTitle}>{title}</div>
        <div className={css.settingsRowDesc}>{description}</div>
      </div>
      <TabWidthPicker
        value={value}
        open={open}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        dataAttribute={dataAttribute}
      />
    </div>
  )
}

/** Build the `Modifier+...+Key` chord label from a keydown event; a bare
 * modifier key alone returns undefined (wait for the full combo). */
function chordLabel(event: ReactKeyboardEvent<HTMLElement>): string | undefined {
  const key = event.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return undefined
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

/** A button that records the next key chord (modifiers + key) as the shortcut. */
function ShortcutRecorder({
  value, onChange, dataAttribute, placeholder,
}: {
  value: string
  onChange: (value: string) => void
  dataAttribute: string
  placeholder: string
}) {
  const [recording, setRecording] = useState(false)
  return (
    <button
      type="button"
      className={css.settingsSelector}
      onClick={() => { setRecording(true) }}
      onBlur={() => { setRecording(false) }}
      onKeyDown={recording ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') { setRecording(false); return }
        const chord = chordLabel(event)
        if (chord !== undefined) { onChange(chord); setRecording(false) }
      } : undefined}
      {...{ [dataAttribute]: true }}
    >
      {recording ? placeholder : value}
      <IconChevronDownOutline14 className={css.settingsSelectorChevron} />
    </button>
  )
}

/** One shortcut row: title + description, chord recorder right. */
function ShortcutRow({
  title, description, value, onChange, dataAttribute, placeholder,
}: {
  title: string
  description: string
  value: string
  onChange: (value: string) => void
  dataAttribute: string
  placeholder: string
}) {
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowText}>
        <div className={css.settingsRowTitle}>{title}</div>
        <div className={css.settingsRowDesc}>{description}</div>
      </div>
      <ShortcutRecorder
        value={value}
        onChange={onChange}
        dataAttribute={dataAttribute}
        placeholder={placeholder}
      />
    </div>
  )
}

/**
 * The plugin's preferences: auto-paste a copied reference into the input,
 * whether importing workspace VCS changes includes untracked files, and the
 * diff's tab width. Each row mirrors the harness's Agent-preset row (title +
 * description on the left, a pill picker on the right); the tab-width row
 * offers 2 / 4 / 8 spaces.
 */
export function DiffApprovalSettingsTab({ t }: DiffApprovalSettingsTabProps) {
  const [pasteOnCopy, setPasteOnCopyState] = useState(pasteOnCopyEnabled)
  const [pasteOnCopyOpen, setPasteOnCopyOpen] = useState(false)
  const [includeUntracked, setIncludeUntrackedState] = useState(includeUntrackedEnabled)
  const [includeUntrackedOpen, setIncludeUntrackedOpen] = useState(false)
  const [tab, setTabState] = useState(tabWidth)
  const [tabOpen, setTabOpen] = useState(false)
  const [split, setSplitState] = useState(splitMode)
  const [splitOpen, setSplitOpen] = useState(false)
  const [summon, setSummonState] = useState(quickSummonKey)
  const setSummon = (value: string): void => {
    setSummonState(value)
    setQuickSummonKey(value)
  }
  const setPasteOnCopy = (value: boolean): void => {
    setPasteOnCopyState(value)
    setPasteOnCopyEnabled(value)
  }
  const setIncludeUntracked = (value: boolean): void => {
    setIncludeUntrackedState(value)
    setIncludeUntrackedEnabled(value)
  }
  const setTab = (value: number): void => {
    setTabState(value)
    setTabWidth(value)
  }
  const setSplit = (value: boolean): void => {
    setSplitState(value)
    setSplitMode(value)
  }
  return (
    <div className={css.settingsPage} data-diff-settings>
      <PreferenceRow
        title={t('panel.pasteOnCopy')}
        description={t('panel.pasteOnCopyDesc')}
        value={pasteOnCopy}
        open={pasteOnCopyOpen}
        onOpenChange={setPasteOnCopyOpen}
        onSelect={setPasteOnCopy}
        dataAttribute="data-diff-paste-on-copy-select"
        t={t}
      />
      <PreferenceRow
        title={t('panel.importUntracked')}
        description={t('panel.importUntrackedDesc')}
        value={includeUntracked}
        open={includeUntrackedOpen}
        onOpenChange={setIncludeUntrackedOpen}
        onSelect={setIncludeUntracked}
        dataAttribute="data-diff-import-untracked-select"
        t={t}
      />
      <TabWidthRow
        title={t('panel.tabWidth')}
        description={t('panel.tabWidthDesc')}
        value={tab}
        open={tabOpen}
        onOpenChange={setTabOpen}
        onSelect={setTab}
        dataAttribute="data-diff-tab-width-select"
      />
      <PreferenceRow
        title={t('panel.splitMode')}
        description={t('panel.splitModeDesc')}
        value={split}
        open={splitOpen}
        onOpenChange={setSplitOpen}
        onSelect={setSplit}
        dataAttribute="data-diff-split-mode-select"
        t={t}
      />
      <ShortcutRow
        title={t('panel.quickSummon')}
        description={t('panel.quickSummonDesc')}
        value={summon}
        onChange={setSummon}
        dataAttribute="data-diff-quick-summon-key"
        placeholder={t('panel.recordShortcut')}
      />
    </div>
  )
}
