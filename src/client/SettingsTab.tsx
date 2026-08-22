/** DSH Settings top-level section for this plugin's preferences. */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { pasteOnCopyEnabled, setPasteOnCopyEnabled } from './settings.ts'
import css from './PendingPanel.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type DiffApprovalSettingsTabProps =
  PropsRuntime<'settings.section'> & PropsLocale<'diff-approval'>

/** The plugin's one preference: auto-paste a copied reference into the input. */
export function DiffApprovalSettingsTab({ t }: DiffApprovalSettingsTabProps) {
  const [pasteOnCopy, setPasteOnCopyState] = useState(pasteOnCopyEnabled)
  const setPasteOnCopy = (value: boolean): void => {
    setPasteOnCopyState(value)
    setPasteOnCopyEnabled(value)
  }
  return (
    <div className={css.settingsPage} data-diff-settings>
      <label className={css.settingsRow}>
        <input
          type="checkbox"
          className={css.settingsCheckbox}
          checked={pasteOnCopy}
          onChange={(event) => { setPasteOnCopy(event.target.checked) }}
          data-diff-paste-on-copy
        />
        <span>{t('panel.pasteOnCopy')}</span>
      </label>
    </div>
  )
}
