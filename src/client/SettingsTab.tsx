/** DSH Settings top-level section for this plugin's preferences. */

import { useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_KEYBINDINGS, DIFF_FONT_SCALE_MAX, DIFF_FONT_SCALE_MIN, DIFF_LINE_HEIGHT_MAX, DIFF_LINE_HEIGHT_MIN, MD_MAX_WIDTH_MAX, MD_MAX_WIDTH_MIN, currentDiffAddColor, currentDiffDelColor, diffAddColor, diffDelColor, diffFontScale, diffLineHeight, includeUntrackedEnabled, keybindingOf, mdMaxWidth, mdPreviewEnabled, navLeadRows, pasteOnCopyEnabled, quickSummonKey, setDiffAddColor, setDiffDelColor, setDiffFontScale, setDiffLineHeight, setIncludeUntrackedEnabled, setKeybinding, setMdMaxWidth, setMdPreviewEnabled, setNavLeadRows, setPasteOnCopyEnabled, setQuickSummonKey, setSplitMode, setTabWidth, splitMode, tabWidth, NAV_LEAD_ROWS_MAX, NAV_LEAD_ROWS_MIN } from './settings.ts'
import type { DiffApprovalKey } from './locales.ts'
import { ColorPicker } from './ColorPicker.tsx'
import css from './PendingPanel.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type DiffApprovalSettingsTabProps =
  PropsRuntime<'settings.section'> & PropsLocale<'diff-approval'>

/** The same translator shape the panel uses. */
type Translator = (key: DiffApprovalKey, params?: Record<string, unknown>) => string

/** A toggle switch offering the two boolean states 打开 / 关闭. */
function OnOffToggle({
  value, onSelect, dataAttribute, t,
}: {
  value: boolean
  onSelect: (value: boolean) => void
  dataAttribute: string
  t: Translator
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={value ? t('action.toggleOn') : t('action.toggleOff')}
      className={`${css.toggle}${value ? ' ' + css.toggleOn : ''}`}
      {...{ [dataAttribute]: true }}
      onClick={() => { onSelect(!value) }}
    >
      <span className={css.toggleThumb} aria-hidden="true" />
    </button>
  )
}

/** One Agent-preset-style preference row: title + description, toggle right. */
function PreferenceRow({
  title, description, value, onSelect, dataAttribute, t,
}: {
  title: string
  description: string
  value: boolean
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
      <OnOffToggle
        value={value}
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

/** A +/- number stepper for an integer preference, clamped to [min, max]. The
 *  optional `step` changes the increment (default 1) and `unit` is appended to
 *  the shown value (e.g. '%'). */
function StepperRow({
  title, description, value, onChange, min, max, dataAttribute, t, step = 1, unit = '',
}: {
  title: string
  description: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  dataAttribute: string
  t: Translator
  step?: number
  unit?: string
}) {
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowText}>
        <div className={css.settingsRowTitle}>{title}</div>
        <div className={css.settingsRowDesc}>{description}</div>
      </div>
      <div className={css.stepper}>
        <button
          type="button"
          className={css.stepperButton}
          data-diff-stepper-down
          aria-label={t('action.decrease')}
          disabled={value <= min}
          onClick={() => { onChange(Math.max(min, value - step)) }}
        />
        <span className={css.stepperValue} {...{ [dataAttribute]: true }}>{value}{unit}</span>
        <button
          type="button"
          className={`${css.stepperButton} ${css.stepperButtonUp}`}
          data-diff-stepper-up
          aria-label={t('action.increase')}
          disabled={value >= max}
          onClick={() => { onChange(Math.min(max, value + step)) }}
        />
      </div>
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

/** One color-picker row: title + description left, a DSH pill trigger that opens
 *  a small HSV dial (a real color picker, not preset swatches) with a hex/RGB
 *  input. The native color dialog is browser-styled and is avoided. */
function ColorRow({
  title, description, value, onChange, dataAttribute,
}: {
  title: string
  description: string
  value: string
  onChange: (value: string) => void
  dataAttribute: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.settingsRow}>
      <div className={css.settingsRowText}>
        <div className={css.settingsRowTitle}>{title}</div>
        <div className={css.settingsRowDesc}>{description}</div>
      </div>
      <div className={css.colorPicker}>
        <button
          type="button"
          className={css.colorPickerTrigger}
          {...{ [dataAttribute]: true }}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-diff-color-trigger
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.colorSwatch} style={{ background: value }} aria-hidden="true" />
          <span className={css.colorValue}>{value.toUpperCase()}</span>
          <IconChevronDownOutline14 className={css.colorPickerChevron} />
        </button>
        {open && (
          <>
            <div className={css.colorBackdrop} onClick={() => { setOpen(false) }} />
            <div className={css.colorPickerPopover}>
              <ColorPicker
                value={value}
                onChange={onChange}
                onClose={() => { setOpen(false) }}
                ariaLabel={title}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** A live single-column diff preview driven by the current diff-view settings.
 *  It reuses the real diff's CSS (`.line`/`.gutter`/`.code`/`.del`/`.add`/intra)
 *  and applies the same CSS variables, so it reflects the actual look. */
function DiffViewPreview({ fontScale, lineHeight, addColor, delColor, tabSize, t }: {
  fontScale: number
  lineHeight: number
  addColor: string
  delColor: string
  tabSize: number
  t: Translator
}) {
  const vars: Record<string, string> = {
    '--dsh-diff-font-scale': String(fontScale / 100),
    '--dsh-diff-line-height': `${lineHeight}px`,
    '--dsh-diff-add-color': addColor,
    '--dsh-diff-del-color': delColor,
  }
  const rows = [
    { kind: css.context, old: '1', next: '1', code: 'export function review(file) {' },
    { kind: css.context, old: '2', next: '2', code: '  // 旧实现：保留当前改动' },
    { kind: css.del, old: '3', next: '', code: <>{'  return '}<span className={css.intraDel}>keep</span>{'(file)'}</> },
    { kind: css.context, old: '3', next: '3', code: '  // 新实现：回退该改动' },
    { kind: css.add, old: '', next: '3', code: <>{'  return '}<span className={css.intraAdd}>revert</span>{'(file)'}</> },
    { kind: css.context, old: '4', next: '4', code: '\u007d' },
  ]
  return (
    <div className={css.diffPreview} style={{ ...(vars as unknown as CSSProperties), tabSize }} data-diff-view-preview>
      <div className={css.diffPreviewTitle}>{t('settings.diffPreview')}</div>
      <div className={css.diffPreviewScroll}>
        <div className={css.lines}>
          {rows.map((row, index) => (
            <div key={index} className={`${css.line} ${row.kind}`}>
              <span className={css.gutter}>{row.old}</span>
              <span className={css.gutter}>{row.next}</span>
              <span className={css.code}>{row.code}</span>
            </div>
          ))}
        </div>
      </div>
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
  const [includeUntracked, setIncludeUntrackedState] = useState(includeUntrackedEnabled)
  const [tab, setTabState] = useState(tabWidth)
  const [tabOpen, setTabOpen] = useState(false)
  const [split, setSplitState] = useState(splitMode)
  const [mdPreview, setMdPreviewState] = useState(mdPreviewEnabled)
  const [mdWidth, setMdWidthState] = useState(mdMaxWidth)
  const [lead, setLeadState] = useState(navLeadRows)
  // Diff-view customization defaults to the current values (100% font size =
  // current; line height defaults to the fixed 22px).
  const [fontScale, setFontScaleState] = useState(diffFontScale)
  const [lineHeight, setLineHeightState] = useState(diffLineHeight)
  const [addColor, setAddColorState] = useState(() => diffAddColor() ?? currentDiffAddColor())
  const [delColor, setDelColorState] = useState(() => diffDelColor() ?? currentDiffDelColor())
  // The theme's current added/removed base colors, shown as the palette default.
  const addDefault = currentDiffAddColor()
  const delDefault = currentDiffDelColor()
  const [diffOpen, setDiffOpen] = useState(true)
  const [summon, setSummonState] = useState(quickSummonKey)
  const [keysOpen, setKeysOpen] = useState(false)
  const [keybindings, setKeybindingsState] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const action of Object.keys(DEFAULT_KEYBINDINGS)) initial[action] = keybindingOf(action)
    return initial
  })
  const setKB = (action: string, chord: string): void => {
    setKeybindingsState(prev => ({ ...prev, [action]: chord }))
    setKeybinding(action, chord)
  }
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
  const setMdPreview = (value: boolean): void => {
    setMdPreviewState(value)
    setMdPreviewEnabled(value)
  }
  const setMdWidth = (value: number): void => {
    setMdWidthState(value)
    setMdMaxWidth(value)
  }
  const setLead = (value: number): void => {
    setLeadState(value)
    setNavLeadRows(value)
  }
  const setFontScale = (value: number): void => {
    setFontScaleState(value)
    setDiffFontScale(value)
  }
  const setLineHeight = (value: number): void => {
    setLineHeightState(value)
    setDiffLineHeight(value)
  }
  const setAddColor = (value: string): void => {
    setAddColorState(value)
    setDiffAddColor(value)
  }
  const setDelColor = (value: string): void => {
    setDelColorState(value)
    setDiffDelColor(value)
  }
  return (
    <div className={css.settingsPage} data-diff-settings>
      <div className={css.settingsGroup} data-open={diffOpen || undefined}>
        <button
          type="button"
          className={css.settingsGroupHeader}
          onClick={() => { setDiffOpen(open => !open) }}
          data-diff-view-toggle
        >
          <span className={css.settingsGroupText}>
            <span className={css.settingsGroupTitle}>{t('settings.diffView')}</span>
            <span className={css.settingsGroupDesc}>{t('settings.diffViewDesc')}</span>
          </span>
          <IconChevronDownOutline14 className={css.settingsGroupChevron} />
        </button>
        {diffOpen && (
          <div className={css.settingsGroupBody}>
            <DiffViewPreview
              fontScale={fontScale}
              lineHeight={lineHeight}
              addColor={addColor}
              delColor={delColor}
              tabSize={tab}
              t={t}
            />
            <StepperRow
              title={t('panel.diffFontSize')}
              description={t('panel.diffFontSizeDesc')}
              value={fontScale}
              onChange={setFontScale}
              min={DIFF_FONT_SCALE_MIN}
              max={DIFF_FONT_SCALE_MAX}
              step={10}
              unit="%"
              dataAttribute="data-diff-font-size"
              t={t}
            />
            <StepperRow
              title={t('panel.diffLineHeight')}
              description={t('panel.diffLineHeightDesc')}
              value={lineHeight}
              onChange={setLineHeight}
              min={DIFF_LINE_HEIGHT_MIN}
              max={DIFF_LINE_HEIGHT_MAX}
              dataAttribute="data-diff-line-height"
              t={t}
            />
            <ColorRow
              title={t('panel.diffAddColor')}
              description={t('panel.diffAddColorDesc', { default: addDefault.toUpperCase() })}
              value={addColor}
              onChange={setAddColor}
              dataAttribute="data-diff-add-color"
            />
            <ColorRow
              title={t('panel.diffDelColor')}
              description={t('panel.diffDelColorDesc', { default: delDefault.toUpperCase() })}
              value={delColor}
              onChange={setDelColor}
              dataAttribute="data-diff-del-color"
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
              onSelect={setSplit}
              dataAttribute="data-diff-split-mode-select"
              t={t}
            />
            <PreferenceRow
              title={t('panel.mdPreview')}
              description={t('panel.mdPreviewDesc')}
              value={mdPreview}
              onSelect={setMdPreview}
              dataAttribute="data-diff-md-preview-select"
              t={t}
            />
            <StepperRow
              title={t('panel.mdMaxWidth')}
              description={t('panel.mdMaxWidthDesc')}
              value={mdWidth}
              onChange={setMdWidth}
              min={MD_MAX_WIDTH_MIN}
              max={MD_MAX_WIDTH_MAX}
              step={80}
              unit="px"
              dataAttribute="data-diff-md-max-width"
              t={t}
            />
            <StepperRow
              title={t('panel.navLeadRows')}
              description={t('panel.navLeadRowsDesc')}
              value={lead}
              onChange={setLead}
              min={NAV_LEAD_ROWS_MIN}
              max={NAV_LEAD_ROWS_MAX}
              dataAttribute="data-diff-nav-lead-rows"
              t={t}
            />
            <PreferenceRow
              title={t('panel.pasteOnCopy')}
              description={t('panel.pasteOnCopyDesc')}
              value={pasteOnCopy}
              onSelect={setPasteOnCopy}
              dataAttribute="data-diff-paste-on-copy-select"
              t={t}
            />
          </div>
        )}
      </div>
      <div className={css.settingsGroup} data-open={keysOpen || undefined}>
        <button
          type="button"
          className={css.settingsGroupHeader}
          onClick={() => { setKeysOpen(open => !open) }}
          data-diff-keybindings-toggle
        >
          <span className={css.settingsGroupText}>
            <span className={css.settingsGroupTitle}>{t('settings.keybindings')}</span>
            <span className={css.settingsGroupDesc}>{t('settings.keybindingsDesc')}</span>
          </span>
          <IconChevronDownOutline14 className={css.settingsGroupChevron} />
        </button>
        {keysOpen && (
          <div className={css.settingsGroupBody}>
            <ShortcutRow
              title={t('panel.quickSummon')}
              description={t('panel.quickSummonDesc')}
              value={summon}
              onChange={setSummon}
              dataAttribute="data-diff-quick-summon-key"
              placeholder={t('panel.recordShortcut')}
            />
            {Object.keys(DEFAULT_KEYBINDINGS).map(action => (
              <ShortcutRow
                key={action}
                title={t(`panel.key.${action}` as DiffApprovalKey)}
                description={t('panel.keyDesc')}
                value={keybindings[action] ?? DEFAULT_KEYBINDINGS[action] ?? ''}
                onChange={(chord) => { setKB(action, chord) }}
                dataAttribute={`data-diff-key-${action}`}
                placeholder={t('panel.recordShortcut')}
              />
            ))}
          </div>
        )}
      </div>
      <PreferenceRow
        title={t('panel.importUntracked')}
        description={t('panel.importUntrackedDesc')}
        value={includeUntracked}
        onSelect={setIncludeUntracked}
        dataAttribute="data-diff-import-untracked-select"
        t={t}
      />
    </div>
  )
}
