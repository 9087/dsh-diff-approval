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
 * Every name the shell's new-session control is known to carry.
 *
 * The GUI's locale is the host's, not the test's, and 0.1.7 ignored the `locale: preference: zh` the
 * fixture seeds — it drew "New session" (its own bundle still carries 新建会话). Matching both is what
 * this harness does for every shell control, so the shell's language can never decide a run.
 */
export const NEW_SESSION = ['新建会话', 'New session']

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
 * Dismissed through the notice's OWN button, not by looking for its mask. The first version of this
 * helper looked for `div[aria-hidden="true"][class*="mask"]` and gave up when it found none — and 0.1.7's
 * notice is not that mask, so it exited having clicked nothing. The notice then stayed up over the app,
 * where it swallows every click: measured as ten-second timeouts on a "New session" button that was on
 * screen the whole time, and a composer that never became editable because a modal owned the page. The
 * loop therefore runs while a known dismiss control is VISIBLE, and stops when none is, which needs no
 * knowledge of the overlay at all.
 *
 * Every known wording is tried in both languages, because the GUI's locale is the host's.
 */
export async function dismissNotices(page: Page): Promise<void> {
  const names = [
    '继续', '稍后配置', '稍后', '以后再说', '知道了', '关闭',
    'Continue', 'Later', 'Skip', 'Skip for now', 'Not now', 'Got it', 'Dismiss', 'Close',
  ]
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let clicked = false
    for (const name of names) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if (!await button.isVisible().catch(() => false)) continue
      await button.click({ timeout: 5000 }).catch(() => {})
      clicked = true
      await sleep(1500)
      break
    }
    if (!clicked) break
  }
  await sleep(500)
}

/**
 * Open a workspace from the sidebar.
 *
 * Matched EXACTLY, because the sidebar also carries the section label "Workspaces" and
 * a substring match happily clicks the heading instead of the row.
 */
async function openWorkspace(page: Page, title: string): Promise<void> {
  // Already there is a success, not a wait: a shell may open the last workspace by itself (0.1.7 does),
  // and then the row this helper used to press is not drawn at all — twenty seconds of waiting for a
  // control the reader would not see either, and a failed run that was already where it wanted to be.
  if (await sessionViewUp(page)) return
  const button = page.getByRole('button', { name: title, exact: true })
  const text = page.getByText(title, { exact: true })
  // Polled, not checked once: the sidebar draws its rows a beat after the page is ready, and a
  // single `count()` on a loaded machine read zero and then pressed a fallback that was not there
  // either — measured as a 20 s timeout on this suite's first page while the same code passed alone.
  const deadline = Date.now() + 30_000
  for (;;) {
    if (await sessionViewUp(page)) return
    if (await button.count() > 0) {
      await button.first().click({ timeout: 20_000 })
      break
    }
    if (await text.count() > 0) {
      await text.last().click({ timeout: 20_000 })
      break
    }
    if (Date.now() >= deadline) {
      throw new Error(`the sidebar never offered the workspace "${title}"\n${await describeSidebar(page)}`)
    }
    await sleep(500)
  }
  // The view is what the press was FOR. Waiting silently here hands the cost to the next step, which
  // then fails with a locator timeout that says nothing about the page it was on.
  if (!await sessionViewUp(page, 30_000)) {
    throw new Error(`the workspace "${title}" opened but no session view appeared.\n${await describeSidebar(page)}`)
  }
}

/**
 * Whether a session view is on screen — the composer is the one thing every session view has.
 *
 * @param page - the GUI page.
 * @param timeout - how long to look, in ms (a short look for "already open", a long one after a press).
 * @returns true when the composer is visible.
 */
async function sessionViewUp(page: Page, timeout = 2_000): Promise<boolean> {
  return await page.locator('[data-composer-input], [contenteditable="true"]').first()
    .isVisible({ timeout })
    .catch(() => false)
}

/**
 * Whether the shell's session view is DRAWN, read through the DOM rather than through Playwright.
 *
 * `focusComposer` already walks every shadow root by hand to find the composer, because part of this
 * shell lives where `document.querySelectorAll` does not go; the same walk is used here so that
 * readiness does not depend on the accessibility tree the locator engine reads. That distinction is
 * measured, not theoretical: on the page that failed twice, Playwright's own `error-context.md` held a
 * single node (the plugin's badge) while the shell's chrome — sidebar, session list, the composer host
 * — was outside that tree, and every text lookup into it found nothing.
 *
 * A node counts only when it has a box: the residence composer host is rendered inert
 * (`contenteditable="false"`) whenever no session is bound, and this asks whether the shell has DREW
 * that view, not whether a session is current.
 *
 * @param page - the GUI page.
 * @returns whether a laid-out composer host could be found by walking the DOM and its shadow roots.
 */
async function shellDrewSessionView(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const selectors = ['[data-composer-input]', '[contenteditable]']
    const walk = (root: Document | ShadowRoot): boolean => {
      for (const selector of selectors) {
        for (const node of root.querySelectorAll(selector)) {
          const box = (node as HTMLElement).getBoundingClientRect()
          if (box.width > 0 && box.height > 0) return true
        }
      }
      for (const node of root.querySelectorAll('*')) {
        const shadow = (node as HTMLElement).shadowRoot
        if (shadow !== null && walk(shadow)) return true
      }
      return false
    }
    return walk(document)
  })
}

/**
 * Wait until the shell has drawn its session view, BEFORE anything is pressed into the page.
 *
 * A fresh page used to be pressed the moment `goto` and the notice sweep returned. On a loaded machine the
 * shell had not drawn by then, so the press landed on nothing and a retry loop spent its whole budget
 * "clicking" a page that was not there yet — the failure this suite recorded twice, as a badge-disabled
 * `openPanel` with no page error and no hint of which step had really failed.
 *
 * This is the shell's own evidence, not a pause: the composer host the file already uses to mean "a
 * session view is up" (`sessionViewUp`), asked twice over — through Playwright's locator engine, and by
 * walking the DOM and its shadow roots (`shellDrewSessionView`) — so a shell whose chrome is outside the
 * accessibility tree cannot read as "not ready" either. Polling, not one look: this is the same shape
 * `composerOf` uses for the same reason.
 *
 * The deadline fails BY NAME and carries what the sidebar was offering, so a shell that never draws says
 * so here instead of handing the cost to the next locator timeout.
 *
 * @param page - the GUI page.
 * @param timeoutMs - how long the shell may take to draw, in ms.
 * @throws when no session view is on screen within `timeoutMs`.
 */
export async function waitForShellReady(page: Page, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  for (;;) {
    const drawn = await sessionViewUp(page, 1_000) || await shellDrewSessionView(page)
    if (drawn) {
      // How long the shell took to draw is what a slow future run needs to see (see `timing`).
      timing('shell-ready', startedAt)
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the shell drew no session view within ${timeoutMs} ms, so nothing could be pressed into it.`
        + `\n${await describeSidebar(page)}`,
      )
    }
    await sleep(300)
  }
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
 * What the sidebar is offering, for a failure that has to explain itself.
 *
 * These controls are the shell's, not this plugin's: a shell that moves one of them turns a helper into a
 * 20-second timeout whose locator log says only that the locator never matched. Printing the buttons (by
 * accessible name) and the head of the page's own text is what will name such a change — which is how the
 * 0.1.7 break was read: the control the helper presses is still labelled the same in that shell's bundle,
 * but it is no longer on the view the workspace opens onto.
 *
 * @param page - the GUI page.
 * @returns one line of buttons, one line of page text.
 */
export async function describeSidebar(page: Page): Promise<string> {
  const names: string[] = []
  for (const button of (await page.getByRole('button').all()).slice(0, 40)) {
    const label = (await button.getAttribute('aria-label')) ?? (await button.innerText().catch(() => ''))
    const text = (label ?? '').replace(/\s+/g, ' ').trim()
    if (text !== '') names.push(text.slice(0, 40))
  }
  const body = (await page.locator('body').innerText().catch(() => '(no body text)')).replace(/\s+/g, ' ').slice(0, 500)
  return `buttons on screen: ${JSON.stringify([...new Set(names)])}\npage text: ${body}`
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
export async function beginSession(page: Page, workspaceTitle: string, home: string, text: string): Promise<string> {
  const startedAt = Date.now()
  await openWorkspace(page, workspaceTitle)
  // A new session first, where the shell offers the control. The press is best-effort on purpose: what
  // this helper promises is a session with a message in it, not the press — 0.1.7 keeps the composer
  // usable without it, and a shell that moves the control again must not fail the run while the composer
  // is right there. Whatever happens is printed, with what the sidebar was offering (see
  // `describeSidebar`), because a silent fallback is how a harness stops testing what it says it does.
  const newSession = page.getByRole('button', { name: new RegExp(NEW_SESSION.join('|'), 'i') })
  // The press and the wait for a composer that can TAKE WORDS are one step, retried: with no session
  // bound to it the shell renders the editor host inert (`contenteditable="false"` — the hero state and
  // the no-session state are the same div), and typing into that does nothing at all. So a press that did
  // not land is not something to log and walk past: it is the difference between a session with a message
  // and a run that dies in the next helper. A press that lands first time makes this one iteration.
  let ready = false
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    // A notice that appears a beat after the page loads is a notice nothing can be clicked through, so it
    // is cleared again on every attempt rather than once in `beforeAll` (see `dismissNotices`).
    await dismissNotices(page)
    if (await newSession.count() > 0) {
      await newSession.first().click({ timeout: 10_000 }).catch(async (error: unknown) => {
        console.log(`[beginSession] the new-session press did not land (attempt ${attempt + 1}):`, String(error).split('\n')[0])
      })
    }
    ready = await focusComposer(page, 20_000)
  }
  if (!ready) {
    throw new Error(`no session took the composer, so nothing could be typed into it.\n${await describeSidebar(page)}`)
  }
  // The message comes BEFORE the id is read. A new session is provisional until its first turn, and only
  // then does the host write `sessions/<bucket>/<id>/session.v3.jsonl.zstd`: measured on 0.1.7, the press
  // went through and no directory appeared within ten seconds, while the id was on disk right after the
  // message. Reading it off that disk is still the only source — the GUI learns its session list from the
  // host's follow stream, and no reply this side can parse names the id (see `waitForSessionOnDisk`).
  await sendMessage(page, undefined, text)

  const sessionId = await waitForSessionOnDisk(home, Date.now() + SESSION_ID_TIMEOUT_MS)
  if (sessionId === undefined) {
    throw new Error(
      `no session directory appeared within ${SESSION_ID_TIMEOUT_MS} ms of the session's first message: the GUI `
      + `accepted the prompt but the host never wrote a session log for it.\n${describeHome(home)}`,
    )
  }
  // How long the id took, and that it came off disk, is what a slow future run needs to see.
  timing('session-id-from-disk', startedAt)
  return sessionId
}

/**
 * The composer the reader would type into: the first VISIBLE editable in the tree.
 *
 * Not a fixed position, because the shell's own tree holds several: the resident composer host sits
 * inert whenever no editor is bound (0.1.7 writes `contenteditable="false"` onto it), the hero state
 * adds another host, and Lexical keeps hidden editables of its own. Both a bare
 * `[contenteditable="true"]` with `.last()` and a bare `[data-composer-input]` with `.first()` picked a
 * node that never became visible — a twenty-second click timeout on a composer that was on screen.
 *
 * @param page - the GUI page.
 * @returns the locator to type into.
 * @throws when nothing visible is editable, naming what the page was offering instead.
 */
async function composerOf(page: Page, timeoutMs = 60_000): Promise<Locator> {
  const selectors = ['[data-composer-input][contenteditable="true"]', '[data-composer-input]', '[contenteditable="true"]']
  // Polled, not scanned once: a cold host draws the session view a beat after the workspace is open, and a
  // single scan on a loaded machine found nothing and then spent twenty seconds clicking a locator that was
  // never going to resolve (measured on this suite's first page, while the same step passed a minute later).
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const selector of selectors) {
      const candidates = page.locator(selector)
      const count = await candidates.count()
      for (let index = 0; index < count; index++) {
        if (await candidates.nth(index).isVisible().catch(() => false)) return candidates.nth(index)
      }
    }
    if (Date.now() >= deadline) break
    await sleep(500)
  }
  throw new Error(`no composer became visible within ${timeoutMs} ms.\n${await describeSidebar(page)}`)
}

/**
 * Focus the composer through the DOM, the way a reader's own click does.
 *
 * Not `locator.click()`: the composer is a Lexical editor the shell re-renders while the session view
 * settles, and a locator re-resolved at click time can land on the hidden node that replaced the visible
 * one — measured as twenty seconds of "waiting for element to be visible, enabled and stable" on a
 * composer that was on screen and focusable the whole time.
 *
 * Searched the way Playwright searches, too: the shell's UI lives inside shadow roots, which
 * `document.querySelectorAll` does not enter, and the focused node there is not `document.activeElement`
 * (its shadow HOST is). So the walk enters every shadow root, and "focused" is asked of the node itself
 * with `:focus`.
 *
 * @param page - the GUI page.
 * @param timeoutMs - how long to keep trying, in ms.
 * @returns whether an editable composer took focus.
 */
async function focusComposer(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const focused = await page.evaluate(() => {
      const selectors = ['[data-composer-input][contenteditable="true"]', '[data-composer-input]', '[contenteditable="true"]']
      const found: HTMLElement[] = []
      const walk = (root: Document | ShadowRoot): void => {
        for (const selector of selectors) {
          for (const node of root.querySelectorAll(selector)) found.push(node as HTMLElement)
        }
        for (const node of root.querySelectorAll('*')) {
          const shadow = (node as HTMLElement).shadowRoot
          if (shadow !== null) walk(shadow)
        }
      }
      walk(document)
      for (const element of found) {
        // ONLY an editor that can take words: the resident host is rendered inert
        // (`contenteditable="false"`) whenever no editor is bound, and focusing that does nothing.
        if (!element.isContentEditable) continue
        element.focus()
        if (element.matches(':focus')) return true
      }
      return false
    })
    if (focused) return true
    if (Date.now() >= deadline) return false
    await sleep(300)
  }
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
 * @param sessionId - the session whose turn this is, when the caller knows it; it is only ever used to
 *   name the session in the failure text, because a new session's id cannot be known before this turn
 *   exists (see `beginSession`).
 * @param text - what to type.
 */
export async function sendMessage(page: Page, sessionId: string | undefined, text: string): Promise<void> {
  const accepted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no turn was accepted${sessionId === undefined ? '' : ` for session ${sessionId}`} within ${TURN_ACCEPT_TIMEOUT_MS} ms`))
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

  // Wait for the composer, then FOCUS it through the DOM and type with real key events rather than
  // clicking it — see `focusComposer` for why both of those are the reliable way here.
  await composerOf(page)
  if (!await focusComposer(page)) {
    throw new Error(`no composer could take focus.\n${await describeSidebar(page)}`)
  }
  await page.keyboard.type(text, { delay: 10 })
  await page.keyboard.press('Enter')
  await accepted
}

/**
 * Open the session whose sidebar title carries this text.
 *
 * A title that is not on screen is NOT automatically an error. The shell may have opened a session ITSELF:
 * after a restart it names that session 未命名 (or from its first message), so the title this call was
 * given is nowhere on screen while the session is perfectly current — and the old silent return was
 * load-bearing for exactly that, measured as two specs that went red the moment a miss started throwing
 * (`panel-comments` c1 and `panel-settings` p2, whose sidebar dump showed a drawn shell, the plugin's own
 * pending rows on screen, and the badge reading 3 and 2). So a miss asks first whether the page already has
 * what it came for, and only a page with NEITHER the session nor the title is an error.
 *
 * Two signals, because they answer different questions and only the pair is right:
 *
 *   * a session view is DRAWN — `sessionViewUp` or `shellDrewSessionView`, the same predicate
 *     `waitForShellReady` waits on: the shell is up at all;
 *   * the panel's own footer badge is ENABLED — a session is CURRENT. It renders `disabled={noSession}`, and
 *     it is the signal `openFreshPage`'s own loop already reads for exactly this question.
 *
 * The drawn-view test ALONE would swallow the failure this check exists for: a page whose chrome is drawn
 * with no session bound also has a laid-out composer host (the resident one is rendered inert, not absent),
 * so it would read as "ready" while the badge is disabled and no caller's next step can work. Requiring
 * both keeps the old tolerance and the throw's teeth.
 *
 * The success path is unchanged: the same substring locator, the same `.last()` (the sidebar may carry the
 * title in more than one row), the same 20 s click budget and the same settle afterwards.
 *
 * @param page - the GUI page.
 * @param title - text the session's sidebar row carries.
 * @throws when no row carries the title AND no session is current either.
 */
export async function openSession(page: Page, title: string): Promise<void> {
  const row = page.getByText(title, { exact: false })
  const count = await row.count()
  if (count === 0) {
    const drawn = await sessionViewUp(page, 1_000) || await shellDrewSessionView(page)
    if (drawn && await footerBadge(page).isEnabled().catch(() => false)) return
    throw new Error(
      `no session on screen carries "${title}" and no session is current, so nothing could be opened.`
      + `\n${await describeSidebar(page)}`,
    )
  }
  await row.last().click({ timeout: 20_000 })
  await sleep(3000)
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
export async function chooseMenuItem(
  page: Page,
  target: Locator,
  names: readonly string[],
  options: { exact?: boolean } = {},
): Promise<void> {
  await target.click({ button: 'right', timeout: 20_000 })
  const items = page.locator('[role="menuitem"]')
  await expect(items.first()).toBeVisible({ timeout: 20_000 })
  // The item is picked by its OWN label, not by a substring of it: `hasText` matches "回退并移出" when the
  // caller asked for "回退", so a spec could press one action and assert the other one's semantics
  // (measured: a revert that was expected to drop the row kept it listed, because the plain revert is the
  // one that does). The labels are read out and compared here, so a miss says what the menu did offer.
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const wanted = names.map(normalize)
  const labels = (await items.allInnerTexts()).map(normalize)
  const at = options.exact === false
    ? labels.findIndex(label => wanted.some(name => label.includes(name)))
    : labels.findIndex(label => wanted.includes(label))
  if (at < 0) {
    throw new Error(`no menu item named ${JSON.stringify(names)}; the menu offered ${JSON.stringify(labels)}`)
  }
  await items.nth(at).click({ timeout: 20_000 })
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
  // TWO dialogs ask, not one: the batch confirmation (`data-diff-batch-confirm-go`) and the SINGLE-FILE one
  // a keep or a revert raises when that file is about to leave the list
  // (`data-diff-file-confirm-remove` = "移出列表", the answer the reader's own action means). Only the first
  // was known here, so a spec that reverted one file left the dialog on screen and the action never ran —
  // measured as a row that stayed put for twenty seconds with a dialog over it.
  const batch = page.locator('[data-diff-batch-confirm-go]').first()
  const single = page.locator('[data-diff-file-confirm-remove]').first()
  const asked = await Promise.race([
    batch.waitFor({ state: 'visible', timeout: 4_000 }).then(() => 'batch' as const).catch(() => undefined),
    single.waitFor({ state: 'visible', timeout: 4_000 }).then(() => 'single' as const).catch(() => undefined),
  ])
  if (asked === undefined) return false
  const go = asked === 'batch' ? batch : single
  await go.click({ timeout: 20_000 })
  await expect(page.locator('[data-diff-batch-confirm], [data-diff-confirm-file]').first()).toBeHidden({ timeout: 20_000 })
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
