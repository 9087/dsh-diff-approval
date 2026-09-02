/** Client preferences for the review panel, persisted in localStorage. */

const PASTE_ON_COPY_KEY = 'diff-approval:paste-on-copy'
const IMPORT_UNTRACKED_KEY = 'diff-approval:import-untracked'
const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const SPLIT_MODE_KEY = 'diff-approval:split-mode'
const NAV_LEAD_KEY = 'diff-approval:nav-lead-rows'
const WRAP_PREFIX = 'diff-approval:wrap:'

/** Default lead rows above a jumped-to diff block (kept small and bounded). */
export const NAV_LEAD_ROWS_DEFAULT = 2
export const NAV_LEAD_ROWS_MIN = 0
export const NAV_LEAD_ROWS_MAX = 10

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
