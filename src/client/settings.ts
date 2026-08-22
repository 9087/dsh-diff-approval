/** Client preferences for the review panel, persisted in localStorage. */

const PASTE_ON_COPY_KEY = 'diff-approval:paste-on-copy'

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
