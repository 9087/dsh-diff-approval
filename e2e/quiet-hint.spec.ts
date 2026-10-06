// The quiet button's hint is the HOUSE tooltip, not the browser's own bubble.
//
// The button used to carry a raw `title` attribute, so hovering it drew whatever grey bubble the platform
// draws — the reader's report (「怎么是系统默认样式」). It is now the primitives' `Tooltip`, and this is the
// measurement that proves which of the two is on screen: NO `title` attribute on the button, and the kit's
// own `role="tooltip"` element carrying the hint text after a real hover.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
]
const SEED_MESSAGE = 'e2e: quiet hint tooltip'

/** Either language's hint, so the case does not encode which locale the fixture landed in. */
const HINT = /不移出列表中的这一行|Keeps the row in the list/

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host

test.describe.configure({ mode: 'serial' })

test.describe('the quiet answer\'s hint', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('quiethint')
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

    const seeded = seedPending(fixture, sessionId, FILES, [])
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    for (const entry of seeded.entries) await row(page, entry.id).waitFor({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('h1. the whole-file confirm\'s quiet button shows the house tooltip, not a native title', async () => {
    test.setTimeout(120_000)
    // The confirm-first setting is ON unless a profile stored `'0'`, so a keep on the open file asks.
    await page.locator('[data-diff-file]').first().click({ timeout: 20_000 })
    await page.locator('[data-diff-keep]').first().click({ timeout: 20_000 })
    const dialog = page.locator('[data-diff-confirm-file]').first()
    await expect(dialog).toBeVisible({ timeout: 20_000 })

    const quiet = page.locator('[data-diff-file-confirm-keep-quiet]').first()
    await expect(quiet).toBeVisible({ timeout: 20_000 })
    // THE NATIVE BUBBLE IS GONE: nothing to give the platform something to draw.
    await expect(quiet, 'the quiet button still carries a native title').not.toHaveAttribute('title', /./)
    // …and the button is still named by its own text (the tooltip is extra information, not the name).
    await expect(quiet).toHaveText(/\S/)

    await quiet.hover()
    const tip = page.locator('[role="tooltip"]').filter({ hasText: HINT }).first()
    await expect(tip, 'the house tooltip did not appear on hover').toBeVisible({ timeout: 10_000 })
    // MEASURED: the kit's bubble is `role="tooltip"` with `data-side`/`data-align` and no id; it does NOT
    // wire the button to it (`aria-describedby` is absent), so the button's accessible name stays its own
    // text and the hint is purely extra — which is why the assertions above keep the name and the bubble
    // apart.

    // The dialog is left as it was: the answer under the pointer is the one that changes nothing but the
    // session's quiet flag, and this case answers it so no later step inherits an open dialog.
    await quiet.click({ timeout: 20_000 })
    await expect(dialog).toBeHidden({ timeout: 20_000 })
  })
})
