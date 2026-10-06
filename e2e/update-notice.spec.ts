// The newer-release notice, end to end against a REAL host and a REAL browser — with the registry
// STUBBED, because this case must not depend on the public internet: the plugin's own `dsh web` process
// is started with the one URL override the host reads at call time
// (`DSH_DIFF_APPROVAL_UPDATE_REGISTRY_URL`), and a throwaway HTTP server on 127.0.0.1 answers it.
//
// What that proves and what it does not: the host really does read its own installed `package.json`, really
// does fetch the registry over HTTP, really does compare and cache; the browser really does draw the chip in the
// open file's status bar — and nowhere else, which is a negative assertion below — the dialog from the host's
// answer, and really does keep a dismissal for the CLIENT LIFETIME only: the notice comes back on the next page
// while the registry still answers newer. What it does NOT prove is that registry.npmjs.org itself answers —
// nothing in a test can, and the code treats any failure there as "no notice".
//
// The stub answers a version far ahead of anything installed, so the case is about the MECHANISM, not
// about which release happens to be current. There is no changelog stub because there is no changelog:
// the dialog shows the versions and a button, and the negative assertions below keep it that way.

import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, newGuiPage, openPanel, openSession } from './helpers/gui.ts'

const FILES: SeededFile[] = [
  { name: 'notice.txt', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
]

const SEED_MESSAGE = 'e2e: update notice'

/** The version the stub registry offers: newer than any installed one, by construction. */
const STUB_VERSION = '9.9.9'
/**
 * The version this checkout reports as installed, read here rather than written down.
 *
 * The host reads it from its own `package.json`, which for a `file:` install is this repository's — and that
 * number is deliberately raised or lowered for a demo (a lower one is how a reader sees the notice at all),
 * so a literal here would fail for a reason that has nothing to do with the notice. What the case is about is
 * that the dialog names BOTH versions, whichever they are.
 */
const INSTALLED_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let stub: Server

test.describe.configure({ mode: 'serial' })

test.describe('新版本提示', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }

    // The stub registry: one JSON document, on a port the OS picks.
    stub = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ name: 'dsh-diff-approval', version: STUB_VERSION }))
    })
    await new Promise<void>(resolve => { stub.listen(0, '127.0.0.1', resolve) })
    const stubPort = (stub.address() as AddressInfo).port
    // Read by the HOST at call time, and `startHost` passes this process's environment through.
    process.env.DSH_DIFF_APPROVAL_UPDATE_REGISTRY_URL = `http://127.0.0.1:${stubPort}/latest.json`

    fixture = makeFixture('updatenotice')
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

    seedPending(fixture, sessionId, FILES, [])
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    // NO file row is clicked, here or in the case below: the notice must reach the reader from the panel
    // itself — the list pane's own footer — and the panel auto-selects the first pending file, so the file
    // view's status bar carries the same notice at the same time.
    await expect(page.locator('[data-diff-approval-file-list]').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
    delete process.env.DSH_DIFF_APPROVAL_UPDATE_REGISTRY_URL
    await new Promise<void>(resolve => { stub?.close(() => { resolve() }) })
  })

  test('u1. 状态栏出现新版本提示（列表里没有），弹窗只有一行正文与按钮，确认后消失、刷新后（新的一次客户端生命周期）再次出现', async () => {
    test.setTimeout(120_000)
    const chips = page.locator('[data-diff-update-chip]')
    // The status bar's chip: the panel's bottom edge. Nothing in this case clicks a file row — the panel
    // auto-selects the first pending file, so the status bar is there on opening it.
    const statusChip = page.locator('[data-diff-status-bar] [data-diff-update-chip]')

    // The chip: only because the STUB registry answered a strictly newer version.
    await expect(statusChip, 'the stub registry answered a newer version, so the chip must appear in the status bar')
      .toBeVisible({ timeout: 30_000 })
    await expect(statusChip).toContainText(STUB_VERSION)
    // ONE site, and it is the status bar's.
    await expect(chips).toHaveCount(1)
    // THE NEGATIVE PIN, in the real browser: the reader corrected us — the notice belongs in the status bar, and
    // the list pane must not carry one.
    await expect(
      page.locator('[data-diff-approval-file-list] [data-diff-update-chip]'),
      'the list pane must carry no notice',
    ).toHaveCount(0)

    // The dialog: ONE body line that carries both versions, and the one way out.
    await statusChip.click({ timeout: 20_000 })
    const dialog = page.locator('[data-diff-update] [role="dialog"]').first()
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    // NO title element, and nothing for `aria-labelledby` to point at.
    expect(await dialog.getAttribute('aria-labelledby'), 'a headingless dialog has nothing to label by').toBeNull()
    await expect(page.locator('[data-diff-update-title]')).toHaveCount(0)
    // Both versions on the body line: the one this checkout reports, and the one the stub offers.
    const body = page.locator('[data-diff-update-body]').first()
    await expect(body).toContainText(INSTALLED_VERSION)
    await expect(body).toContainText(STUB_VERSION)
    // …and that sentence IS the accessible name — the same words, so the two cannot drift.
    expect(await dialog.getAttribute('aria-label')).toBe((await body.textContent())?.trim())
    await expect(page.locator('[data-diff-update-dismiss]').first()).toBeVisible()
    // THE TWO DOORS, in the real browser: NPM and GitHub, each a real anchor to its own page, each opening
    // away from this page rather than in it.
    const doors = page.locator('[data-diff-update] a')
    await expect(doors).toHaveCount(2)
    await expect(page.locator('[data-diff-update-npm]'))
      .toHaveAttribute('href', 'https://www.npmjs.com/package/dsh-diff-approval')
    await expect(page.locator('[data-diff-update-github]'))
      .toHaveAttribute('href', 'https://github.com/9087/dsh-diff-approval')
    for (const door of await doors.all()) {
      await expect(door).toHaveAttribute('target', '_blank')
      await expect(door).toHaveAttribute('rel', 'noreferrer noopener')
    }
    // The blocks the reader cut stay cut: the changelog, the old single link, the title.
    await expect(page.locator('[data-diff-update-link]')).toHaveCount(0)
    await expect(page.locator('[data-diff-update-open]')).toHaveCount(0)
    await expect(page.locator('[data-diff-update-notes]')).toHaveCount(0)

    // The dismissal: the one chip goes out, and it is kept for THIS client lifetime only.
    await page.locator('[data-diff-update-dismiss]').first().click({ timeout: 20_000 })
    await expect(chips).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('[data-diff-update]')).toHaveCount(0, { timeout: 20_000 })

    // THE PAGE-LIFETIME HALF: a reload is a new client lifetime, so while the stub still answers a newer
    // version the notice must come BACK — nothing durable remembers the dismissal any more.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    await expect(page.locator('[data-diff-approval-file-list]').first()).toBeVisible({ timeout: 20_000 })
    await expect(
      page.locator('[data-diff-status-bar] [data-diff-update-chip]'),
      'a dismissal lasts one client lifetime, so the notice must come back after a reload',
    ).toBeVisible({ timeout: 30_000 })
    // …still in the status bar only: the reload does not move it back under the file list either.
    await expect(page.locator('[data-diff-approval-file-list] [data-diff-update-chip]')).toHaveCount(0)
  })
})
