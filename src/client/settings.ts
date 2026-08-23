/** Client preferences for the review panel, persisted in localStorage. */

const PASTE_ON_COPY_KEY = 'diff-approval:paste-on-copy'
const IMPORT_UNTRACKED_KEY = 'diff-approval:import-untracked'

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
