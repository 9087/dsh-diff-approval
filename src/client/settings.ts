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
const LANG_BY_SUFFIX_KEY = 'diff-approval:lang-by-suffix'
const PRESENTATION_KEY = 'diff-approval:presentation'
const FLOAT_COVER_KEY = 'diff-approval:float-cover'
const FILE_LIST_FLOAT_KEY = 'diff-approval:file-list-float'
const WRAP_PREFIX = 'diff-approval:wrap:'

/** Where the review panel shows: floating over the app, or docked as a tab in the
 *  app's right sidebar. What the floating panel covers is a separate setting —
 *  see {@link DiffApprovalCover}. */
export type DiffApprovalPresentation = 'float' | 'dock'

/**
 * What the floating panel covers: the app's header above the conversation, its
 * left sidebar, its right sidebar, and the composer below. All four on is the
 * presentation the panel used to call "fullscreen" — the panel filling the
 * window; both sidebars and the header only is the plain floating panel, which
 * leaves the input usable.
 */
export interface DiffApprovalCover {
  readonly top: boolean
  readonly left: boolean
  readonly right: boolean
  readonly composer: boolean
}

/** The floating panel's default coverage: the header and both sidebars, not the
 *  composer. */
export const FLOAT_COVER_DEFAULT: DiffApprovalCover = { top: true, left: true, right: true, composer: false }

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
 * Where the review panel shows, as the user last had it. Two states, both
 * remembered so the footer entry can restore the one they were using:
 *
 * - `float` — the panel floating over the app, covering what
 *   {@link panelCover} says (and the composer only when that says so);
 * - `dock` — the panel docked in the app's right sidebar, as its own tab.
 *
 * A stored `fullscreen` — the third state before coverage became three switches —
 * reads as `float`, with {@link panelCover} supplying the all-on coverage it
 * meant.
 * @returns the remembered presentation; `float` when unset or unrecognized.
 */
export function panelPresentation(): DiffApprovalPresentation {
  return localStorage.getItem(PRESENTATION_KEY) === 'dock' ? 'dock' : 'float'
}

/** Persist the panel's presentation (see {@link panelPresentation}). */
export function setPanelPresentation(value: DiffApprovalPresentation): void {
  localStorage.setItem(PRESENTATION_KEY, value)
}

/**
 * What the floating panel covers (see {@link DiffApprovalCover}). Defaults to
 * both sidebars and not the composer; a stored `fullscreen` presentation from
 * before the switches means all three.
 * @returns the remembered coverage.
 */
export function panelCover(): DiffApprovalCover {
  const raw = localStorage.getItem(FLOAT_COVER_KEY)
  if (raw === null) {
    return localStorage.getItem(PRESENTATION_KEY) === 'fullscreen'
      ? { top: true, left: true, right: true, composer: true }
      : FLOAT_COVER_DEFAULT
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return FLOAT_COVER_DEFAULT
    const stored = parsed as Record<string, unknown>
    const flag = (name: keyof DiffApprovalCover): boolean => typeof stored[name] === 'boolean'
      ? stored[name]
      : FLOAT_COVER_DEFAULT[name]
    return { top: flag('top'), left: flag('left'), right: flag('right'), composer: flag('composer') }
  } catch {
    // A hand-edited or truncated value must not break the panel.
    return FLOAT_COVER_DEFAULT
  }
}

/** Window event: the floating panel's coverage changed (see {@link setPanelCover}). */
export const COVER_CHANGED_EVENT = 'diff-approval:cover'

/** Persist what the floating panel covers. */
export function setPanelCover(value: DiffApprovalCover): void {
  localStorage.setItem(FLOAT_COVER_KEY, JSON.stringify(value))
  // The panel and the Settings section are separate mounts, so the event is how a
  // switch flipped in one reaches the other straight away rather than at the
  // panel's next open.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(COVER_CHANGED_EVENT))
}

/**
 * Whether the file list always folds into its floating card, whatever width the
 * panel has. Defaults to off, where the width decides: the list sits beside the
 * diff while there is room for both. Only an explicit `'1'` forces the fold.
 * @returns whether the file list is always folded.
 */
export function fileListFloat(): boolean {
  return localStorage.getItem(FILE_LIST_FLOAT_KEY) === '1'
}

/** Persist the always-fold preference for the file list. */
export function setFileListFloat(value: boolean): void {
  localStorage.setItem(FILE_LIST_FLOAT_KEY, value ? '1' : '0')
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
 * The highlight language chosen by hand for one file suffix, remembered so the
 * choice sticks for every file with that suffix. Not a Settings row: it is a
 * per-suffix consequence of using the language picker, so it lives here as
 * storage only.
 * @param suffix - the lowercase extension without the dot (see `suffixOfPath`).
 * @returns the remembered language id, or undefined for "auto".
 */
export function languageForSuffix(suffix: string): string | undefined {
  const stored = rememberedLanguages()
  const language = stored[suffix]
  return language === undefined || language === '' ? undefined : language
}

/**
 * Remember (or clear) the language chosen for one suffix. A `null` language
 * forgets the suffix, which is what picking "auto" means.
 * @param suffix - the lowercase extension without the dot.
 * @param language - the language id, or null to forget the suffix.
 */
export function setLanguageForSuffix(suffix: string, language: string | null): void {
  const stored = rememberedLanguages()
  if (language === null) {
    if (stored[suffix] === undefined) return
    delete stored[suffix]
  } else {
    if (stored[suffix] === language) return
    stored[suffix] = language
  }
  localStorage.setItem(LANG_BY_SUFFIX_KEY, JSON.stringify(stored))
}

/** The whole suffix → language map (empty when unset or unreadable). */
function rememberedLanguages(): Record<string, string> {
  const raw = localStorage.getItem(LANG_BY_SUFFIX_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const cleaned: Record<string, string> = {}
    for (const [suffix, language] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof language === 'string' && language !== '') cleaned[suffix] = language
    }
    return cleaned
  } catch {
    // A hand-edited or truncated value must not break the picker.
    return {}
  }
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
 *  panel's own ESC-to-close, which is intentionally not remapped). The coverage
 *  switches are keyed like the edges they toggle, in the order the panel lists
 *  them: left, top, right, bottom. */
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
  coverLeft: 'Ctrl+Shift+ArrowLeft',
  coverTop: 'Ctrl+Shift+ArrowUp',
  coverRight: 'Ctrl+Shift+ArrowRight',
  coverComposer: 'Ctrl+Shift+ArrowDown',
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
