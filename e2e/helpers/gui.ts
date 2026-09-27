/**
 * The GUI half of the real-browser E2E: what a reviewer does with the mouse and the
 * keyboard, addressed through the selectors the panel publishes for exactly this use
 * (`data-diff-*`) and through the app's own labels.
 *
 * Labels are matched against a candidate list (Chinese first, English second) because
 * the GUI's locale is the host's, not the test's: the assertions are about what the
 * panel did, never about which wording it did it in.
 */

import { expect, type Browser, type Locator, type Page } from '@playwright/test'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeHome, timing, waitForSessionOnDisk } from './host.ts'

/** Every name the row menu's keep-and-remove item is known to carry. */
export const KEEP_REMOVE = ['保留并移出', 'Keep and remove']
/** Every name the comment menu's close item is known to carry. */
export const CLOSE_COMMENT = ['关闭评论', 'Close comment']

/**
 * A GUI page with the panel's comment mode on.
 *
 * Comment mode ships OFF (a preview, see `commentModeEnabled` in the client's settings),
 * and with it off the panel draws no comments tab at all — so a test of the comments list
 * would otherwise be asserting against a feature the build deliberately hides. The panel's
 * own settings switch writes exactly this localStorage key and then fires its change event;
 * seeding it at page start is the same state, reached without a click that could land on a
 * switch the panel has not drawn yet.
 */
export async function newGuiPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(() => {
    window.localStorage.setItem('diff-approval:comment-mode-preview', '1')
  })
  return context.newPage()
}

/**
 * Dismiss the first-run notices, whatever they are.
 *
 * They are modals over a mask, so a click on anything underneath is swallowed rather
 * than merely misplaced: this loops until no mask is left, not once per button. Every
 * known wording is tried in both languages, because the GUI's locale is the host's.
 */
export async function dismissNotices(page: Page): Promise<void> {
  const mask = page.locator('div[aria-hidden="true"][class*="mask"]')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await mask.count() === 0) break
    let clicked = false
    for (const name of ['继续', '稍后配置', '稍后', '以后再说', 'Continue', 'Later', 'Skip', 'Skip for now', 'Not now']) {
      const button = page.getByRole('button', { name, exact: true })
      if (await button.count() === 0) continue
      if (!await button.first().isVisible().catch(() => false)) continue
      await button.first().click({ timeout: 5000 }).catch(() => {})
      clicked = true
      await sleep(2000)
      break
    }
    if (!clicked) {
      await sleep(2000)
    }
  }
  await sleep(1000)
}

/**
 * Open a workspace from the sidebar.
 *
 * Matched EXACTLY, because the sidebar also carries the section label "Workspaces" and
 * a substring match happily clicks the heading instead of the row.
 */
async function openWorkspace(page: Page, title: string): Promise<void> {
  const button = page.getByRole('button', { name: title, exact: true })
  if (await button.count() > 0) {
    await button.first().click({ timeout: 20_000 })
    return
  }
  await page.getByText(title, { exact: true }).last().click({ timeout: 20_000 })
}

/** How long a session id may take to appear on disk. */
const SESSION_ID_TIMEOUT_MS = 10_000
/** How long one accepted prompt may take to come back as an accepted turn. */
const TURN_ACCEPT_TIMEOUT_MS = 30_000

/** One `/api/<ns>/<method>` reply, as the browser transport frames it (`result.value`). */
interface ApiReply {
  result?: { value?: Record<string, unknown> }
}

/** Read a response body as that envelope; a body that is not one is simply not a reply. */
async function apiReply(response: { text(): Promise<string> }): Promise<ApiReply | undefined> {
  try {
    const body = JSON.parse(await response.text()) as unknown
    if (typeof body !== 'object' || body === null) return undefined
    return body as ApiReply
  } catch {
    return undefined
  }
}

/**
 * Open a workspace, take the session the GUI put in it, and return that session's id.
 *
 * The id comes from the host's own session directory — `<home>/sessions/<workspace-slug>/
 * <sessionId>/session.v3.jsonl.zstd` — and NOT from a response, which is what the first
 * version of this helper tried and why it wasted 30 s on every run.
 *
 * A probe of this build's own traffic says there is no response to wait for. Clicking
 * "新建会话" issues no `session/create` at all: it sent `session/prompt` into a session
 * that already existed, because opening the workspace is what creates one. Watching every
 * `/api/**` reply whose body parses as the transport envelope named a session id exactly
 * never — the GUI learns its session list from the host's follow stream, not from a reply
 * this side can read — so `page.waitForResponse` has nothing to match, and the previous
 * `page.on('response')` listener could only ever leave its promise pending.
 *
 * What replaces it is the fact the response would have carried, read where the host
 * actually writes it: the new session directory. That is still a wait rather than a
 * guess, it is armed from before the workspace click, and it resolves as soon as the
 * directory exists.
 *
 * A missing id is an ERROR, never an empty return: the caller cannot tell an empty id
 * from a wrong one, and "fall back and carry on" is what burned the deadline before.
 *
 * @param page - the GUI page.
 * @param workspaceTitle - the workspace to open, by its sidebar title.
 * @param home - the throwaway `DSH_HOME` those sessions are written under.
 * @returns the new session's id.
 * @throws when the session directory has named nothing within {@link SESSION_ID_TIMEOUT_MS}.
 */
export async function createSession(page: Page, workspaceTitle: string, home: string): Promise<string> {
  const startedAt = Date.now()
  await openWorkspace(page, workspaceTitle)
  await page.getByRole('button', { name: '新建会话' }).first().click({ timeout: 20_000 })

  const sessionId = await waitForSessionOnDisk(home, Date.now() + SESSION_ID_TIMEOUT_MS)
  if (sessionId === undefined) {
    throw new Error(
      `no session directory appeared within ${SESSION_ID_TIMEOUT_MS} ms of opening the workspace: the GUI `
      + `accepted the click but the host never wrote a session log for it.\n${describeHome(home)}`,
    )
  }
  // How long the id took, and that it came off disk, is what a slow future run needs to see.
  timing('session-id-from-disk', startedAt)
  return sessionId
}

/**
 * Send one message through the composer, and wait until the host accepted a turn for it.
 *
 * This is not decoration: the panel's entry is disabled for a session that is still
 * blank ("no messages yet"), and `blank` clears on the session's first `turn/start`.
 * The turn itself may fail on a host with no model credentials — the test does not
 * care what the agent answered, only that the session is a real one a reviewer can open.
 *
 * The wait is the host's own answer to `session/prompt` (`result.value.accepted`), which
 * is the moment the turn exists, not a fixed pause: a pause long enough for a cold turn on
 * a slow machine is seconds of nothing on a fast one, and too short is a flake. A composer
 * that never gets an accepted prompt fails the run by name instead of passing on a delay.
 *
 * @param page - the GUI page.
 * @param sessionId - the session whose turn this is; the id is what the error reports.
 * @param text - what to type.
 */
export async function sendMessage(page: Page, sessionId: string, text: string): Promise<void> {
  const accepted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no turn was accepted for session ${sessionId} within ${TURN_ACCEPT_TIMEOUT_MS} ms`))
    }, TURN_ACCEPT_TIMEOUT_MS)
    page.on('response', response => {
      if (!response.url().includes('/api/session/prompt')) return
      void apiReply(response).then(reply => {
        if (reply?.result?.value?.['accepted'] !== true) return
        clearTimeout(timer)
        resolve()
      })
    })
  })

  const composer = page.locator('[contenteditable="true"]').last()
  await composer.click({ timeout: 20_000 })
  await composer.type(text, { delay: 10 })
  await page.keyboard.press('Enter')
  await accepted
}

/** Open the session whose sidebar title carries this text. */
export async function openSession(page: Page, title: string): Promise<void> {
  const row = page.getByText(title, { exact: false })
  const count = await row.count()
  if (count > 0) {
    await row.last().click({ timeout: 20_000 })
    await sleep(3000)
  }
}

/** Whether the plugin's footer badge is present and enabled (a blank session disables it). */
export function footerBadge(page: Page): Locator {
  return page.locator('[data-diff-approval-badge]').first()
}

/**
 * Click the footer badge and wait for the panel to be on screen with its file list drawn.
 *
 * The panel root paints before it has any rows, so waiting for the root alone would hand
 * the caller a half-built panel; the row is the signal that the list is actually there.
 */
export async function openPanel(page: Page): Promise<void> {
  const badge = footerBadge(page)
  await expect(badge).toBeEnabled({ timeout: 30_000 })
  await badge.click({ timeout: 20_000 })
  await expect(page.locator('[data-diff-approval-panel]').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
}

/**
 * Bring the panel's file list on screen, whatever it takes — the two controls a reader
 * would use are the panel's own footer badge and the app's right-sidebar button, because
 * the docked panel lives in that sidebar and is not rendered at all while it is closed.
 *
 * This is deliberately a loop over a check rather than one click: the badge is a toggle
 * whose aria-expanded can be true while the sidebar that would host it is shut, so
 * "press it once" is not a rule that holds after a batch keep.
 */
export async function ensurePanelList(page: Page): Promise<void> {
  const tabs = page.locator('[data-diff-list-tab]')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await tabs.count() > 0) {
      await sleep(500)
      return
    }
    const sidebar = page.getByRole('button', { name: /打开右侧边栏|Open right sidebar/i }).first()
    if (attempt % 2 === 0 && await sidebar.count() > 0) {
      await sidebar.click({ timeout: 10_000 }).catch(() => {})
    } else {
      const badge = footerBadge(page)
      await expect(badge).toBeEnabled({ timeout: 30_000 })
      await badge.click({ timeout: 20_000 }).catch(() => {})
    }
    await sleep(2000)
  }
  await expect(tabs.first()).toBeVisible({ timeout: 10_000 })
}

/** One pending row, by its `data-diff-file` id (the file path). */
export function row(page: Page, id: string): Locator {
  return page.locator(`[data-diff-file="${cssEscape(id)}"]`)
}

/** One comment row, by its `data-diff-comment-link` id. */
export function commentRow(page: Page, id: string): Locator {
  return page.locator(`[data-diff-comment-link="${cssEscape(id)}"]`)
}

/** Attribute-selector quoting, because these ids are Windows paths. */
function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Ctrl/Cmd-click a sequence of rows, leaving the whole set picked.
 *
 * Every press carries the modifier, including the first: a plain press is not a pick at
 * all — for a file row it opens the file, and for a comment row it jumps to the thread —
 * and the panel ends the pick on any unmodified press that is not on an already-picked row.
 */
export async function pick(page: Page, rows: readonly Locator[]): Promise<void> {
  for (const target of rows) {
    await target.click({ modifiers: ['Control'], timeout: 20_000 })
    await sleep(300)
  }
}

/** Right-click a row and click the menu item with one of these names. */
export async function chooseMenuItem(page: Page, target: Locator, names: readonly string[]): Promise<void> {
  await target.click({ button: 'right', timeout: 20_000 })
  const item = page.locator('[role="menuitem"]').filter({ hasText: new RegExp(names.join('|')) }).first()
  await expect(item).toBeVisible({ timeout: 20_000 })
  await item.click({ timeout: 20_000 })
  await sleep(800)
}

/** Accept the batch confirmation, when one is asked for. */
export async function confirmBatch(page: Page): Promise<void> {
  const confirm = page.locator('[data-diff-batch-confirm]').first()
  await expect(confirm).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-diff-batch-confirm-go]').first().click({ timeout: 20_000 })
  await expect(confirm).toBeHidden({ timeout: 20_000 })
  await sleep(1200)
}

/**
 * Accept a confirmation IF this action asks for one.
 *
 * The panel confirms what it cannot take back and acts outright on what it can, so a
 * test that decided in advance which of the two it is would be testing its own guess.
 */
export async function confirmIfAsked(page: Page): Promise<boolean> {
  const go = page.locator('[data-diff-batch-confirm-go]').first()
  const asked = await go.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
  if (!asked) return false
  await go.click({ timeout: 20_000 })
  await expect(page.locator('[data-diff-batch-confirm]').first()).toBeHidden({ timeout: 20_000 })
  await sleep(1200)
  return true
}

/** Switch the list pane to one of its tabs and let it settle. */
export async function openListTab(page: Page, tab: 'pending' | 'comments'): Promise<void> {
  const button = page.locator(`[data-diff-list-tab="${tab}"]`).first()
  await expect(button).toBeVisible({ timeout: 20_000 })
  await button.click({ timeout: 20_000 })
  await sleep(1200)
}

/**
 * Ask a question in one comment thread.
 *
 * Clicking the thread in the comments list is what puts its card in the code view; the
 * card's own row is the `data-diff-discussion-input` field and its send button. The
 * host is expected to accept the question and then fail to answer it (the profile has a
 * placeholder credential), which is exactly the state this step is about: a question
 * exists in the store.
 */
export async function askInComment(page: Page, commentId: string): Promise<void> {
  await openListTab(page, 'comments')
  await commentRow(page, commentId).click({ timeout: 20_000 })
  await sleep(2500)
  const input = page.locator('[data-diff-discussion-input]').first()
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.click({ timeout: 20_000 })
  await input.type('e2e question', { delay: 15 })
  await sleep(300)
  await page.locator('[data-diff-discussion-send]').first().click({ timeout: 20_000 })
  await sleep(6000)
}

/** A cheap fingerprint of what the panel is showing, for "Ctrl+Z changed nothing" assertions. */
export async function panelState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-diff-approval-panel]')
    const rows = document.querySelectorAll('[data-diff-file]').length
    const comments = document.querySelectorAll('[data-diff-comment-link]').length
    const asked = document.querySelectorAll('[data-diff-discussion-input]').length
    return `${rows}|${comments}|${asked}|${(panel?.textContent ?? '').replace(/\s+/g, ' ').trim()}`
  })
}

/**
 * The undo/redo the panel listens for.
 *
 * Focus is dropped from whatever holds it (an input keeps Ctrl+Z for its OWN undo, and
 * the panel's chord would never see it) by blurring, never by clicking: a click outside
 * the panel is how a docked panel gets dismissed.
 */
async function pressChord(page: Page, key: string): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await page.keyboard.press(key)
  await sleep(1500)
}

/** Undo, as the platform's first chord. */
export async function pressUndo(page: Page): Promise<void> {
  await pressChord(page, 'Control+z')
}

/** Redo, as the platform's second chord. */
export async function pressRedo(page: Page): Promise<void> {
  await pressChord(page, 'Control+y')
}
