/**
 * Real-browser E2E: the three panel bugs that were fixed, each with a test that
 * FAILS when its fix is reverted.
 *
 * These tests are only worth having if they bite. Each one below was checked by
 * temporarily putting the old source back and rebuilding, and each one went red for the
 * reason its fix names:
 *
 * - g1 vs the floating list's exemption for a `role="dialog"` target (the confirm press);
 * - g2 vs the Escape handler's exemption for an open menu;
 * - g3 vs the undo chord's `!open` guard.
 *
 * g1 does NOT cover the same fix's `role="menu"` half: the row menu is portaled to the
 * document body, so its own press never reaches the panel's fold listener at all. See
 * the guard's own note in `PendingPanel.tsx` (`target.closest('[role="menu"]')`).
 *
 * The panel is driven in both of the presentations the fixes are about:
 *
 * - the FOLDED FILE LIST (a narrow window, so the list floats over the diff as a card),
 *   where a press on the list's own confirmation must not fold the card away;
 * - the DOCKED panel (the right sidebar's tab), where the overlay's `open` flag is
 *   false and only `docked` says the panel is on screen at all.
 *
 * Setup is the two-phase seed `pending-keep.spec.ts` documents: the host caches its
 * pending store at boot, so the fixture has to exist before the second host starts.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, describeHome, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  KEEP_REMOVE, beginSession, chooseMenuItem, confirmBatch, dismissNotices, ensurePanelList, newGuiPage,
  openPanel, openSession, pick, pressUndo, row,
} from './helpers/gui.ts'
import { dockPanel, dockedPanel, floatCard, openFloatList, panel, setViewport } from './helpers/panel.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
  { name: 'gamma.txt', oldText: 'gamma one\ngamma two\n', newText: 'gamma one\nGAMMA TWO\n' },
]

const SEED_MESSAGE = 'e2e-guards: seed this session'

/** A window narrow enough that the panel's own breakpoint folds the file list. */
const NARROW = 1000

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let paths: Record<string, string>

test.describe.configure({ mode: 'serial' })

test.describe('面板守卫：浮动列表与 Escape，以及停靠面板里的撤销', () => {
  test.beforeAll(async () => {
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('guards')
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
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    for (const name of Object.keys(paths)) {
      await expect(row(page, paths[name] as string)).toBeVisible({ timeout: 30_000 })
    }
    // The FLOATING presentation is the narrow window's own state; nothing is forced into
    // localStorage, and the card is opened with the knob the reader would use.
    await openFloatList(page, NARROW)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('g1. 浮动列表：确认框里的按钮按下后，面板与列表卡片都还在', async () => {
    if (await page.locator('[data-diff-floating-file-list]').count() === 0) {
      throw new Error(`the file list did not fold into its card at ${NARROW}px:\n${describeHome(fixture.home)}`)
    }
    const alpha = row(page, paths['alpha.txt'] as string)
    const beta = row(page, paths['beta.txt'] as string)
    await pick(page, [alpha, beta])
    await expect(page.locator('[data-picked]')).toHaveCount(2)

    // The batch confirmation is the panel's own dialog, drawn inside the panel: a press
    // on its button is "inside the panel, outside the CARD", which is exactly what the
    // fold rule acts on. The fix exempts a `role="dialog"` target, so answering the
    // list's own question must not fold the list away.
    await chooseMenuItem(page, beta, KEEP_REMOVE)
    const confirm = page.locator('[data-diff-batch-confirm]').first()
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await confirmBatch(page)

    await expect(floatCard(page)).toBeVisible({ timeout: 20_000 })
    await expect(panel(page)).toBeVisible()
    // The answer really landed: the two picked rows are gone, the unpicked one stays.
    await expect(alpha).toHaveCount(0)
    await expect(beta).toHaveCount(0)
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible({ timeout: 20_000 })
  })

  test('g2. 菜单开着时按 Escape：只关菜单，面板与卡片都还在', async () => {    const gamma = row(page, paths['gamma.txt'] as string)
    await gamma.click({ button: 'right', timeout: 20_000 })
    const menu = page.locator('[role="menu"]').first()
    await expect(menu).toBeVisible({ timeout: 20_000 })

    // The panel's Escape handler listens on `window` in the CAPTURE phase, so it runs
    // before the menu's own and cannot be stopped by it. Its fix yields to an open menu;
    // without that this press closes the whole panel and takes the list with it.
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden({ timeout: 20_000 })
    await expect(panel(page)).toBeVisible({ timeout: 20_000 })
    await expect(floatCard(page)).toBeVisible({ timeout: 20_000 })
    await expect(gamma).toBeVisible({ timeout: 20_000 })
  })

  test('g3. 停靠呈现下 Ctrl+Z / Ctrl+Y 有效：真动作能被撤销，再被重做', async () => {
    // A window wide enough that the sidebar the panel docks into is a full column.
    await setViewport(page, 1400)
    const offered = await dockPanel(page)
    if (!offered) {
      throw new Error('the mode switch offered no dock row: this host has no right sidebar to dock into')
    }
    await expect(dockedPanel(page)).toBeVisible({ timeout: 30_000 })
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible({ timeout: 30_000 })

    // A REAL action, taken in the docked panel: the row's own menu, then its keep. The
    // panel's undo chord has to reach the host from a tab, where its overlay flag is
    // false — with the old `!open` guard alone, this Ctrl+Z was a dead key.
    const gamma = row(page, paths['gamma.txt'] as string)
    await chooseMenuItem(page, gamma, KEEP_REMOVE)
    await expect(gamma).toHaveCount(0, { timeout: 30_000 })
    const remaining = await page.locator('[data-diff-file]').count()

    await pressUndo(page)
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible({ timeout: 30_000 })
    expect(await page.locator('[data-diff-file]').count()).toBe(remaining + 1)

    await page.keyboard.press('Control+y')
    await expect(row(page, paths['gamma.txt'] as string)).toHaveCount(0, { timeout: 30_000 })
    await expect(dockedPanel(page)).toBeVisible()
  })
})
