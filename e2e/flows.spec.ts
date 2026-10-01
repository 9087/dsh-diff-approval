/**
 * Real-browser E2E: the two main flows — writing a comment, and what a host restart
 * keeps.
 *
 * Both flows are the real interactions. The comment is typed into the panel's own
 * compose row and sent with its own button, against a selection made by dragging over
 * the diff's own lines; nothing in this file writes to the plugin's comment store to
 * make a comment appear. The restart is `stopHost` + `startHost` on the SAME throwaway
 * `DSH_HOME`, which is what a user does when they quit and reopen the app.
 *
 * The undo stack's boundary is asserted where it was measured, not guessed: the stack
 * lives in the host process, so a page reload on the same host still has it (a comment
 * written and then Ctrl+Z'd on the reloaded page really goes away), while a host
 * restart has nothing left — Ctrl+Z after the restart changes nothing and the comment
 * is still in the store afterwards.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootstrapHome, claimSession, describeHome, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type DshCommand, type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, CLOSE_COMMENT, dismissNotices, ensurePanelList, footerBadge, newGuiPage, openPanel, openSession,
  panelState, pressUndo, row, waitForShellReady,
} from './helpers/gui.ts'
import { openFloatList, noticesText, writeComment } from './helpers/panel.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
]

const SEED_MESSAGE = 'e2e-flow: seed this session'
/** The words this suite writes; also how the restarted GUI names the session. */
const COMMENT_TEXT = 'e2e flow comment'

/**
 * Every comment the plugin has written down, as text.
 *
 * Read from the plugin's own store rather than from the page, so an assertion about a
 * comment existing is an assertion about the host's answer and not about a rendering.
 */
function commentStore(home: string): string {
  const dir = join(home, 'diff-approval', 'comments')
  if (!existsSync(dir)) return '(no comments directory)'
  const files = readdirSync(dir)
  if (files.length === 0) return '(no comment file)'
  return files.map(name => `${name}: ${readFileSync(join(dir, name), 'utf8')}`).join('\n')
}

/** Whether the plugin's store currently holds this many comments. */
function commentCount(home: string): number {
  const text = commentStore(home)
  if (!text.includes('"comments"')) return 0
  return text.match(/"id":"/g)?.length ?? 0
}

let dsh: DshCommand
let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let paths: Record<string, string>

test.describe.configure({ mode: 'serial' })

/**
 * Boot a fresh page on the current host and open the seeded session's panel.
 *
 * The session is picked by the comment's own words once there is one: after a restart
 * the GUI names the session from its first message — which for the restarted runs here
 * is the comment this suite wrote — and the seed message is no longer on screen.
 *
 * @param tag - what a page error is labeled with, so a failure names which page threw.
 */
async function openFreshPage(tag: string): Promise<void> {
  page = await newGuiPage(browser)
  page.on('pageerror', error => { console.log(`[pageerror:${tag}]`, error.message) })
  await page.goto(host.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
  await dismissNotices(page)
  // Nothing is pressed into the page until the shell has DRAWN: a press made into a page that is still
  // mounting has nothing to land on, and a retry loop then spends its whole budget clicking nothing. The
  // wait is the shell's own evidence, not a pause, and its deadline fails by name — see
  // `waitForShellReady`.
  await waitForShellReady(page)
  // Which session the GUI opens is its own decision, and a reload is a fresh one: the press below can
  // land while the sidebar is still drawing, and then the panel's badge stays disabled and `openPanel`
  // waits out its whole 30s on a session that never arrives (measured: two consecutive runs failed
  // exactly there, with `data-diff-approval-badge="0"` and no page error). So the press is made only
  // while the badge says no session is open, and it is retried rather than slept on once.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await footerBadge(page).isEnabled().catch(() => false)) break
    const entry = page.getByText(COMMENT_TEXT, { exact: false })
    if (await entry.count() > 0) {
      await entry.last().click({ timeout: 20_000 }).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 4000))
      continue
    }
    // A miss is now VISIBLE: `openSession` throws when no row carries the title, and the attempt says so
    // with what the sidebar was offering, so the log can tell "found no such text" from "clicked but the
    // session did not open" — the distinction two failed runs could not make.
    await openSession(page, SEED_MESSAGE).catch((error: unknown) => {
      console.log(`[openFreshPage:${tag}] attempt ${attempt + 1}/4 found no session row:`, String(error).split('\n')[0])
    })
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  // A session that never opens is worth one line of the page itself: the badge says only that the
  // panel has nothing to show, and the next failure should say what the GUI was showing instead.
  if (!await footerBadge(page).isEnabled().catch(() => false)) {
    const text = await page.locator('body').innerText().catch(() => '(no body text)')
    console.log(`[nosession:${tag}]`, text.replace(/\s+/g, ' ').slice(0, 400))
  }
  await openPanel(page)
  await ensurePanelList(page)
}

test.describe('评论与重启：写一条评论，再看一次宿主重启保住了什么', () => {
  test.beforeAll(async () => {
    const found = resolveDsh()
    if (found === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    dsh = found
    fixture = makeFixture('flow')
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    const sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, SEED_MESSAGE)
    await page.close()
    await stopHost(host.proc)

    const written = seedPending(fixture, sessionId, FILES, [])
    paths = Object.fromEntries(written.entries.map(entry => [entry.path.split(/[\\/]/).pop() ?? entry.path, entry.id]))
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('setup')
    await openFloatList(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('f1. 打开差异 → 选中行 → 写一条评论 → 发出去 → 评论出现在评论列表里', async () => {
    // The file is opened the way a reader opens it, and only then is there a diff to
    // select lines in.
    await row(page, paths['alpha.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })

    await writeComment(page, 0, 1, COMMENT_TEXT)
    await new Promise(resolve => setTimeout(resolve, 6000))

    // The host took it: that is what its own store on disk says, and the list below is
    // what reads it back.
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) })
      .toPass({ timeout: 30_000 })

    // A reload is a fresh read of the host's store, so the list is the host's own answer
    // rather than a rendering the writing page kept for itself.
    await openFreshPage('after-comment')
    await page.locator('[data-diff-list-tab="comments"]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(1, { timeout: 30_000 })
    expect(await page.locator('[data-diff-list-scroll]').first().innerText()).toContain(COMMENT_TEXT)
    await expect(page.locator('[data-diff-list-count]').first()).toHaveText('1', { timeout: 20_000 })
  })

  test('f2. 重启宿主：待审列表与评论都还在', async () => {
    // The restart itself: the same throwaway home, a brand new host process. Nothing
    // about the writing page is carried over — not the page, not the process.
    await page.close()
    await stopHost(host.proc)
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('after-restart')

    // The pending list is a disk-backed store, so both files are still on it...
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    for (const name of Object.keys(paths)) {
      await expect(row(page, paths[name] as string)).toBeVisible({ timeout: 20_000 })
    }
    // ...and so is the comment, listed under the file it was written on.
    await page.locator('[data-diff-list-tab="comments"]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(1, { timeout: 30_000 })
    expect(await page.locator('[data-diff-list-scroll]').first().innerText()).toContain(COMMENT_TEXT)
    await expect(page.locator('[data-diff-list-count]').first()).toHaveText('1', { timeout: 20_000 })
  })

  test('f3. 撤销栈不跨重启：重启后 Ctrl+Z 什么也不撤', async () => {
    // First the part that is about the STACK and not about the restart. This page is
    // reloaded on the RESTARTED host, and the host still holds the comment's undo step
    // — the comment being undone here is this test's OWN fresh write, whose step the
    // host was there to record. Ctrl+Z really does take it back, which is what makes
    // the "nothing" below mean the restart emptied the stack rather than that this
    // suite never had one.
    await openFreshPage('before-undo')
    // beta.txt, not alpha.txt: a row belongs to one comment at most, and f1's comment sits
    // on alpha.txt's rows — the panel offers no second comment on a range that already
    // carries a block, and no drag can make one appear.
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    await writeComment(page, 0, 1, COMMENT_TEXT)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) })
      .toPass({ timeout: 30_000 })
    const alone = commentIdOnDisk(fixture.home)
    await pressUndo(page)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) })
      .toPass({ timeout: 30_000 })

    // ---- write it once more and leave the stack alone: this time the step that empties
    // the stack is the RESTART, not an undo the test performed on purpose.
    await openFreshPage('re-write')
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    await writeComment(page, 0, 1, COMMENT_TEXT)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) })
      .toPass({ timeout: 30_000 })

    await page.close()
    await stopHost(host.proc)
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('after-second-restart')
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })

    // ---- the boundary: Ctrl+Z after a restart is accepted and changes nothing.
    const before = await panelState(page)
    await pressUndo(page)
    const said = await noticesText(page)
    await new Promise(resolve => setTimeout(resolve, 4000))
    expect(commentCount(fixture.home)).toBe(2)
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 20_000 })
    // `panelState` starts with the row/comment/field counts; a notice about the press is
    // expected, but the LIST it is about must not have moved.
    expect((await panelState(page)).split('|').slice(0, 3).join('|'))
      .toBe(before.split('|').slice(0, 3).join('|'))
    // What the press said, as this build actually says it: nothing at all. The host
    // answers `nothing`, and the panel's list is unchanged — there is no notice to find,
    // and none is asserted for.
    expect(said).not.toContain('无法撤销')
    expect(said).not.toContain('Undo failed')
    console.log('[measured] post-restart Ctrl+Z said:', JSON.stringify(said.replace(/\s+/g, ' ').slice(-260)))
  })

  test('f4. 关闭评论后 Ctrl+Z 把评论带回来', async () => {
    // The reported flow, pressed the way the reader presses it: the card's own ⋯ menu, its
    // own close item (the panel calls it 关闭评论), then the platform's undo chord. Nothing
    // here touches the store or the host, so what the assertions read is what the two
    // presses did between them — first in the host's own file, then on screen.
    //
    // The comment this closes is f3's, written BEFORE the restart: the close is a fresh
    // action and takes a fresh undo step whatever the stack held, so an undo that brings it
    // back is about the close and not about the write that preceded it.
    await openFreshPage('close-undo')
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    const card = page.locator('[data-diff-discussion]').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.locator('[data-diff-discussion-menu]').click({ timeout: 20_000 })
    await page.locator('[role="menuitem"]').filter({ hasText: new RegExp(CLOSE_COMMENT.join('|')) }).first()
      .click({ timeout: 20_000 })

    // The close really happened: the host's store dropped it and the code view stopped drawing it.
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) }).toPass({ timeout: 30_000 })
    await expect(card).toHaveCount(0, { timeout: 30_000 })

    await pressUndo(page)
    const said = await noticesText(page)
    // The one assertion that matters: the comment is back in the host's own store…
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) }).toPass({ timeout: 30_000 })
    // …and the card is drawn again where it was, with what it said.
    await expect(page.locator('[data-diff-discussion]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-diff-discussion]').first()).toContainText(COMMENT_TEXT, { timeout: 20_000 })
    console.log('[measured] close-then-undo said:', JSON.stringify(said.replace(/\s+/g, ' ').slice(-260)))
  })
})

/** The first comment id in the plugin's store, so a run can tell one write from another. */
function commentIdOnDisk(home: string): string {
  const match = /"id":"([^"]+)"/.exec(commentStore(home))
  return match?.[1] ?? '(none)'
}
