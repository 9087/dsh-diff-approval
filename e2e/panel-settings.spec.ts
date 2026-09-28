// The settings page and the language selector — two panel surfaces nothing drove before.
//
// These are the controls a reader uses to make the panel theirs, and both are pure client state
// (localStorage), so they are exactly the kind that can break without any host involvement.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, dismissNotices, newGuiPage, openPanel, openSession, row,
} from './helpers/gui.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
]

const SEED_MESSAGE = 'e2e: settings and controls'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let paths: Record<string, string>

/** What the panel is saying, for a failure that has to explain itself. */
async function panelSaid(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const text = (node: Element): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    return [
      `settings: ${document.querySelectorAll('[data-diff-settings]').length}`,
      `dialogs: ${[...document.querySelectorAll('[role="dialog"]')].map(text).join(' | ') || '(none)'}`,
      `menu: ${[...document.querySelectorAll('[role="menuitem"]')].map(text).join(' | ') || '(none)'}`,
      `lang: ${text(document.querySelector('[data-diff-lang]') ?? document.createElement('i')) || '(none)'}`,
    ].join('\n')
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('设置与控件：复制引用 / 语言选择 / 设置页分组', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('settings')
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
    paths = Object.fromEntries(seeded.entries.map(entry => [entry.path.split(/[\\/]/).pop() ?? entry.path, entry.id]))
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
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('p2. 语言选择器：选一个语言，控件就显示那个语言', async () => {
    test.setTimeout(120_000)
    const lang = page.locator('[data-diff-lang]').first()
    await expect(lang).toBeVisible({ timeout: 20_000 })
    const before = (await lang.textContent() ?? '').trim()

    await lang.click({ timeout: 20_000 })
    const items = page.locator('[role="menuitem"]')
    try {
      await expect(items.first()).toBeVisible({ timeout: 20_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }
    // A language that is NOT the one showing: which one is on screen is the panel's business, so the spec
    // picks a different row rather than encoding the list.
    const labels = (await items.allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim()).filter(text => text !== '')
    const pick = labels.find(text => text !== before)
    expect(pick, `the menu offered nothing but ${JSON.stringify(before)}`).toBeDefined()
    await items.filter({ hasText: new RegExp(`^${(pick as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first().click({ timeout: 20_000 })

    await expect(lang).toContainText(pick as string, { timeout: 20_000 })
  })

  test('p3. 设置页：齿轮打开设置，评论与按键分组能展开，Escape 后回到列表', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
    const settings = page.locator('[data-diff-settings]').first()
    try {
      await expect(settings).toBeVisible({ timeout: 30_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }

    // Both groups are collapsed until pressed, and what they reveal is the point: the controls only exist
    // once the reader opens the group they are in.
    await settings.locator('[data-diff-comment-toggle]').first().click({ timeout: 20_000 })
    await expect(settings.locator('[data-diff-comment-mode-select]').first()).toBeVisible({ timeout: 20_000 })
    await settings.locator('[data-diff-keybindings-toggle]').first().click({ timeout: 20_000 })
    await expect(settings.locator('[data-diff-key-copyref]').first()).toBeVisible({ timeout: 20_000 })

    await page.keyboard.press('Escape')
    await openPanel(page)
    await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
  })
})
