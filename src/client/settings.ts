/** Client preferences for the review panel, persisted in localStorage. */

const PASTE_ON_COPY_KEY = 'diff-approval:paste-on-copy'
const IMPORT_UNTRACKED_KEY = 'diff-approval:import-untracked'
const CONFIRM_FILE_REMOVE_KEY = 'diff-approval:confirm-file-remove'
const SEARCH_CASE_KEY = 'diff-approval:search-case'
const SEARCH_WORD_KEY = 'diff-approval:search-word'
const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const SPLIT_MODE_KEY = 'diff-approval:split-mode'
const MD_PREVIEW_KEY = 'diff-approval:md-preview'
const MD_MAX_WIDTH_KEY = 'diff-approval:md-max-width'
const NAV_LEAD_KEY = 'diff-approval:nav-lead-rows'
const DIFF_FONT_SCALE_KEY = 'diff-approval:diff-font-scale'
const DIFF_LINE_HEIGHT_KEY = 'diff-approval:diff-line-height'
const DIFF_ADD_COLOR_KEY = 'diff-approval:diff-add-color'
const DIFF_DEL_COLOR_KEY = 'diff-approval:diff-del-color'
const WRAP_PREFIX = 'diff-approval:wrap:'

/** Default lead rows above a jumped-to diff block (kept small and bounded). */
export const NAV_LEAD_ROWS_DEFAULT = 2
export const NAV_LEAD_ROWS_MIN = 0
export const NAV_LEAD_ROWS_MAX = 10

/** The code block's fixed row height used by the virtual window and jump math.
 *  A hardcoded px base; the settings UI offers 10–36 (a low floor would clip the
 *  code text, so the range is loose but never degenerate). */
export const DIFF_LINE_HEIGHT_DEFAULT = 22
export const DIFF_LINE_HEIGHT_MIN = 10
export const DIFF_LINE_HEIGHT_MAX = 36
/** Font-size scale range: a percentage of the current value, stepped by 10. */
export const DIFF_FONT_SCALE_DEFAULT = 100
export const DIFF_FONT_SCALE_MIN = 50
export const DIFF_FONT_SCALE_MAX = 200

/** Markdown-preview content max width (single column): a comfortable reading
 *  width for mainstream 1080p+ displays. The double-column view is 2x this. */
export const MD_MAX_WIDTH_DEFAULT = 800
export const MD_MAX_WIDTH_MIN = 480
export const MD_MAX_WIDTH_MAX = 1600

/**
 * Whether copying a reference should also paste it into the chat input and
 * focus it. Defaults to on; only an explicit `'0'` disables it.
 * @returns whether auto-paste is enabled.
 */
export function pasteOnCopyEnabled(): boolean {
  return localStorage.getItem(PASTE_ON_COPY_KEY) !== '0'
}

/** Persist the auto-paste preference. */
export function setPasteOnCopyEnabled(value: boolean): void {
  localStorage.setItem(PASTE_ON_COPY_KEY, value ? '1' : '0')
}

/**
 * Whether importing workspace VCS changes includes new/untracked files (git
 * `??`, svn `?`, p4 unversioned). Defaults to off: collecting them scans the
 * whole workspace, which can be slow on large trees, so the preference is
 * opt-in. Only an explicit `'1'` enables it.
 * @returns whether untracked files are imported.
 */
export function includeUntrackedEnabled(): boolean {
  return localStorage.getItem(IMPORT_UNTRACKED_KEY) === '1'
}

/** Persist the import-untracked preference. */
export function setIncludeUntrackedEnabled(value: boolean): void {
  localStorage.setItem(IMPORT_UNTRACKED_KEY, value ? '1' : '0')
}

/**
 * Whether a whole-file keep/revert asks before dropping the resolved file from
 * the list. Defaults to on; only an explicit `'0'` disables it, which then
 * removes the file straight away.
 * @returns whether the remove prompt is enabled.
 */
export function confirmFileRemoveEnabled(): boolean {
  return localStorage.getItem(CONFIRM_FILE_REMOVE_KEY) !== '0'
}

/** Persist the whole-file remove-prompt preference. */
export function setConfirmFileRemoveEnabled(value: boolean): void {
  localStorage.setItem(CONFIRM_FILE_REMOVE_KEY, value ? '1' : '0')
}

/**
 * Whether the in-file search matches letter case exactly. Defaults to off, so a
 * plain query keeps matching either case; only an explicit `'1'` turns it on.
 * @returns whether the search is case-sensitive.
 */
export function searchCaseSensitive(): boolean {
  return localStorage.getItem(SEARCH_CASE_KEY) === '1'
}

/** Persist the search case-sensitivity preference. */
export function setSearchCaseSensitive(value: boolean): void {
  localStorage.setItem(SEARCH_CASE_KEY, value ? '1' : '0')
}

/**
 * Whether the in-file search only matches whole words. Defaults to off; only an
 * explicit `'1'` enables it.
 * @returns whether the search matches whole words only.
 */
export function searchWholeWord(): boolean {
  return localStorage.getItem(SEARCH_WORD_KEY) === '1'
}

/** Persist the search whole-word preference. */
export function setSearchWholeWord(value: boolean): void {
  localStorage.setItem(SEARCH_WORD_KEY, value ? '1' : '0')
}

/**
 * Whether lines wrap (auto-wrap) in the diff for one highlight language.
 * Defaults to off; only an explicit `'1'` enables it. Stored per language, so
 * a language's preference never leaks into another's.
 * @param lang - the highlight language (or `''` for the auto/default bucket).
 * @returns whether lines wrap.
 */
export function wrapEnabled(lang: string): boolean {
  return localStorage.getItem(`${WRAP_PREFIX}${lang}`) === '1'
}

/** Persist the per-language auto-wrap preference. */
export function setWrapEnabled(lang: string, value: boolean): void {
  localStorage.setItem(`${WRAP_PREFIX}${lang}`, value ? '1' : '0')
}

/**
 * The diff's tab width in spaces. Defaults to 4; the settings UI offers 2/4/8,
 * but any positive integer is accepted. This drives both the rendered
 * `tab-size` and the wrapped-line tab measurement, so they always agree.
 * @returns the number of spaces one tab advances.
 */
export function tabWidth(): number {
  const value = Number.parseInt(localStorage.getItem(TAB_WIDTH_KEY) ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : 4
}

/** Persist the diff's tab width (in spaces). */
export function setTabWidth(value: number): void {
  localStorage.setItem(TAB_WIDTH_KEY, String(value))
}

/**
 * The diff code font size as a percentage of the current (theme) size. Defaults
 * to 100 (the current look); the settings UI steps it by ±10.
 * @returns the font-size scale, as a percentage (e.g. 100, 110, 90).
 */
export function diffFontScale(): number {
  const raw = Number.parseInt(localStorage.getItem(DIFF_FONT_SCALE_KEY) ?? '', 10)
  if (!Number.isFinite(raw)) return DIFF_FONT_SCALE_DEFAULT
  return Math.max(DIFF_FONT_SCALE_MIN, Math.min(DIFF_FONT_SCALE_MAX, raw))
}

/** Persist the diff's code font-size scale (a percentage). */
export function setDiffFontScale(value: number): void {
  localStorage.setItem(DIFF_FONT_SCALE_KEY, String(Math.max(DIFF_FONT_SCALE_MIN, Math.min(DIFF_FONT_SCALE_MAX, value))))
}

/**
 * The diff code line height in px (the fixed row height the virtual window and
 * jump math are keyed to). Defaults to 22 (the pre-customization value).
 * @returns the line height in px.
 */
export function diffLineHeight(): number {
  const raw = Number.parseInt(localStorage.getItem(DIFF_LINE_HEIGHT_KEY) ?? '', 10)
  if (!Number.isFinite(raw)) return DIFF_LINE_HEIGHT_DEFAULT
  return Math.max(DIFF_LINE_HEIGHT_MIN, Math.min(DIFF_LINE_HEIGHT_MAX, raw))
}

/** Persist the diff's code line height (px). */
export function setDiffLineHeight(value: number): void {
  localStorage.setItem(DIFF_LINE_HEIGHT_KEY, String(Math.max(DIFF_LINE_HEIGHT_MIN, Math.min(DIFF_LINE_HEIGHT_MAX, value))))
}

/** Read a theme CSS custom property, with a fallback when it is unavailable. */
function themeColor(name: string, fallback: string): string {
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (/^#[0-9a-f]{6}$/i.test(v)) return v
  }
  return fallback
}

/** The added-line base color the user chose, or `undefined` (theme color). */
export function diffAddColor(): string | undefined {
  const v = localStorage.getItem(DIFF_ADD_COLOR_KEY)
  return v !== null && v.length > 0 ? v : undefined
}

/** Persist the added-line base color (a hex like `#22c55e`). */
export function setDiffAddColor(value: string): void {
  localStorage.setItem(DIFF_ADD_COLOR_KEY, value)
}

/** The removed-line base color the user chose, or `undefined` (theme color). */
export function diffDelColor(): string | undefined {
  const v = localStorage.getItem(DIFF_DEL_COLOR_KEY)
  return v !== null && v.length > 0 ? v : undefined
}

/** Persist the removed-line base color (a hex like `#ef4444`). */
export function setDiffDelColor(value: string): void {
  localStorage.setItem(DIFF_DEL_COLOR_KEY, value)
}

/** The theme's added-line base color, for the settings swatch default. */
export function currentDiffAddColor(): string {
  return themeColor('--dsw-alias-state-success-primary', '#22c55e')
}

/** The theme's removed-line base color, for the settings swatch default. */
export function currentDiffDelColor(): string {
  return themeColor('--dsw-alias-state-error-primary', '#ef4444')
}

/**
 * Whether the whole-file diff view uses the two-column (side-by-side) layout.
 * Default off (single column): the unified diff. Only an explicit `'1'` enables
 * split mode.
 * @returns whether the split (two-column) diff view is used.
 */
export function splitMode(): boolean {
  return localStorage.getItem(SPLIT_MODE_KEY) === '1'
}

/** Persist the split-view preference. */
export function setSplitMode(value: boolean): void {
  localStorage.setItem(SPLIT_MODE_KEY, value ? '1' : '0')
}

/**
 * Whether the rendered Markdown preview is shown by default (for Markdown files).
 * Default off: the source diff is shown unless the panel toggle is used. Only an
 * explicit `'1'` enables the preview default.
 * @returns whether the Markdown preview default is enabled.
 */
export function mdPreviewEnabled(): boolean {
  return localStorage.getItem(MD_PREVIEW_KEY) === '1'
}

/** Persist the Markdown-preview default preference. */
export function setMdPreviewEnabled(value: boolean): void {
  localStorage.setItem(MD_PREVIEW_KEY, value ? '1' : '0')
}

/**
 * The Markdown-preview content max width, in pixels (single column). Defaults to
 * 800; the double-column view totals 2x this. An out-of-range or non-integer
 * value falls back to the default.
 * @returns the max width in pixels.
 */
export function mdMaxWidth(): number {
  const raw = Number.parseInt(localStorage.getItem(MD_MAX_WIDTH_KEY) ?? '', 10)
  if (!Number.isInteger(raw)) return MD_MAX_WIDTH_DEFAULT
  return Math.max(MD_MAX_WIDTH_MIN, Math.min(MD_MAX_WIDTH_MAX, raw))
}

/** Persist the Markdown-preview content max width. */
export function setMdMaxWidth(value: number): void {
  localStorage.setItem(MD_MAX_WIDTH_KEY, String(Math.max(MD_MAX_WIDTH_MIN, Math.min(MD_MAX_WIDTH_MAX, value))))
}

/**
 * How many rows of lead the diff block jump leaves above the jumped-to block,
 * and how far the anchored navigation scans. Defaults to 2; an out-of-range or
 * non-integer value falls back to the default.
 * @returns the lead row count.
 */
export function navLeadRows(): number {
  const raw = Number.parseInt(localStorage.getItem(NAV_LEAD_KEY) ?? '', 10)
  if (!Number.isInteger(raw)) return NAV_LEAD_ROWS_DEFAULT
  return Math.max(NAV_LEAD_ROWS_MIN, Math.min(NAV_LEAD_ROWS_MAX, raw))
}

/** Persist the block-jump lead row count. */
export function setNavLeadRows(value: number): void {
  localStorage.setItem(NAV_LEAD_KEY, String(Math.max(NAV_LEAD_ROWS_MIN, Math.min(NAV_LEAD_ROWS_MAX, value))))
}

const QUICK_SUMMON_KEY = 'diff-approval:quick-summon-key'
/** Default quick-summon chord (toggle the review panel open/closed). */
export const DEFAULT_QUICK_SUMMON = 'Ctrl+D'

/**
 * The quick-summon chord. Stored as `Modifier+...+Key`; falls back to
 * {@link DEFAULT_QUICK_SUMMON}.
 * @returns the chord string.
 */
export function quickSummonKey(): string {
  return localStorage.getItem(QUICK_SUMMON_KEY) ?? DEFAULT_QUICK_SUMMON
}

/** Persist the quick-summon chord. */
export function setQuickSummonKey(value: string): void {
  localStorage.setItem(QUICK_SUMMON_KEY, value)
}

const KEY_PREFIX = 'diff-approval:key:'

/** Default chord for each configurable action (every supported key except the
 *  panel's own ESC-to-close, which is intentionally not remapped). */
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  jumpUp: 'Ctrl+ArrowUp',
  jumpDown: 'Ctrl+ArrowDown',
  copyRef: 'Ctrl+L',
  openSearch: 'Ctrl+F',
  searchNext: 'F3',
  searchPrev: 'Shift+F3',
  matchCase: 'Alt+C',
  matchWholeWord: 'Alt+W',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  cycleNext: 'Ctrl+Tab',
  cyclePrev: 'Ctrl+Shift+Tab',
}

/** The currently configured chord for one action; falls back to its default. */
export function keybindingOf(action: string): string {
  return localStorage.getItem(`${KEY_PREFIX}${action}`) ?? DEFAULT_KEYBINDINGS[action] ?? ''
}

/** Persist one action's chord. */
export function setKeybinding(action: string, chord: string): void {
  localStorage.setItem(`${KEY_PREFIX}${action}`, chord)
}

/**
 * Whether a keyboard event matches a chord string like `Ctrl+D`. Modifier
 * names are matched case-insensitively (`Ctrl`/`Control`, `Alt`/`Option`,
 * `Shift`, `Meta`/`Cmd`/`Command`/`Win`); the final part is the key. Exact
 * modifier set is required (extra modifiers do not match).
 * @param event - the keydown event.
 * @param shortcut - the chord string.
 * @returns whether the event matches.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split('+').map(part => part.trim().toLowerCase())
  const key = parts.pop()
  if (key === undefined || key === '') return false
  const mods = new Set(parts)
  const ctrl = mods.has('ctrl') || mods.has('control')
  const alt = mods.has('alt') || mods.has('option')
  const shift = mods.has('shift')
  const meta = mods.has('meta') || mods.has('cmd') || mods.has('command') || mods.has('win')
  return event.key.toLowerCase() === key
    && event.ctrlKey === ctrl
    && event.altKey === alt
    && event.shiftKey === shift
    && event.metaKey === meta
}
