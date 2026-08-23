/** DSH Settings top-level section for this plugin's preferences. */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { includeUntrackedEnabled, pasteOnCopyEnabled, setIncludeUntrackedEnabled, setPasteOnCopyEnabled } from './settings.ts'
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

/**
 * The plugin's preferences: auto-paste a copied reference into the input, and
 * whether importing workspace VCS changes includes untracked files. Each row
 * mirrors the harness's Agent-preset row (title + description on the left, a
 * pill picker on the right) with the two boolean states 打开 / 关闭.
 */
export function DiffApprovalSettingsTab({ t }: DiffApprovalSettingsTabProps) {
  const [pasteOnCopy, setPasteOnCopyState] = useState(pasteOnCopyEnabled)
  const [pasteOnCopyOpen, setPasteOnCopyOpen] = useState(false)
  const [includeUntracked, setIncludeUntrackedState] = useState(includeUntrackedEnabled)
  const [includeUntrackedOpen, setIncludeUntrackedOpen] = useState(false)
  const setPasteOnCopy = (value: boolean): void => {
    setPasteOnCopyState(value)
    setPasteOnCopyEnabled(value)
  }
  const setIncludeUntracked = (value: boolean): void => {
    setIncludeUntrackedState(value)
    setIncludeUntrackedEnabled(value)
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
    </div>
  )
}
