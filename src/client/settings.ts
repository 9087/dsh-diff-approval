/** Client preferences for the review panel, persisted in localStorage. */

const PASTE_ON_COPY_KEY = 'diff-approval:paste-on-copy'
const IMPORT_UNTRACKED_KEY = 'diff-approval:import-untracked'
const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const SPLIT_MODE_KEY = 'diff-approval:split-mode'
const WRAP_PREFIX = 'diff-approval:wrap:'

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
