/** DSH Settings top-level section for this plugin's preferences. */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { pasteOnCopyEnabled, setPasteOnCopyEnabled } from './settings.ts'
import css from './PendingPanel.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type DiffApprovalSettingsTabProps =
  PropsRuntime<'settings.section'> & PropsLocale<'diff-approval'>

/**
 * The plugin's preference: auto-paste a copied reference into the input.
 * The row mirrors the harness's Agent-preset row (title + description on the
 * left, a pill picker on the right) — only here the picker offers the two
 * boolean states 打开 / 关闭 instead of presets.
 */
export function DiffApprovalSettingsTab({ t }: DiffApprovalSettingsTabProps) {
  const [pasteOnCopy, setPasteOnCopyState] = useState(pasteOnCopyEnabled)
  const [open, setOpen] = useState(false)
  const setPasteOnCopy = (value: boolean): void => {
    setPasteOnCopyState(value)
    setPasteOnCopyEnabled(value)
  }
  return (
    <div className={css.settingsPage} data-diff-settings>
      <div className={css.settingsRow}>
        <div className={css.settingsRowText}>
          <div className={css.settingsRowTitle}>{t('panel.pasteOnCopy')}</div>
          <div className={css.settingsRowDesc}>{t('panel.pasteOnCopyDesc')}</div>
        </div>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={[
            { id: 'on', label: t('action.toggleOn') },
            { id: 'off', label: t('action.toggleOff') },
          ]}
          selectedId={pasteOnCopy ? 'on' : 'off'}
          onSelect={(id) => {
            setOpen(false)
            setPasteOnCopy(id === 'on')
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.settingsSelector}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
              data-diff-paste-on-copy-select
            >
              {pasteOnCopy ? t('action.toggleOn') : t('action.toggleOff')}
              <IconChevronDownOutline14 className={css.settingsSelectorChevron} />
            </button>
          )}
        />
      </div>
    </div>
  )
}
