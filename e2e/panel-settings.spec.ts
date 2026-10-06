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

  test('p4. 分组标题在设置区滚动时悬停在最上方，并被下一组接手', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
    const settings = page.locator('[data-diff-settings]').first()
    try {
      await expect(settings).toBeVisible({ timeout: 30_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }

    // Only the group headers: the rows' own buttons are nested deeper than `> div > button`.
    const headers = settings.locator('> div > button')
    const count = await headers.count()
    expect(count, 'the settings page did not render its four groups').toBeGreaterThanOrEqual(3)
    // Open the first three, so the page is long enough for the hand-off between groups 1 and 2.
    for (const index of [0, 1, 2]) {
      const open = await headers.nth(index).evaluate(node => node.parentElement?.hasAttribute('data-open') === true)
      if (!open) await headers.nth(index).click({ timeout: 20_000 })
    }
    await page.waitForTimeout(400)

    /** The scrollport, its top edge, and where each group header sits inside it right now. */
    const geometry = (): Promise<{
      scrollTop: number
      maxScroll: number
      scrollportTop: number
      surface: string | null
      headers: { top: number, height: number, position: string, background: string, hitHeader: boolean, hitClass: string }[]
    }> => page.evaluate(() => {
      const scroller = [...document.querySelectorAll('*')]
        .find(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) as HTMLElement | undefined
      if (scroller === undefined) throw new Error('the settings scroller was not found')
      const top = scroller.getBoundingClientRect().top
      const surface = document.querySelector('[data-shortcut-modal]')
      const found = [...document.querySelectorAll('[data-diff-settings] > div > button')] as HTMLElement[]
      return {
        scrollTop: scroller.scrollTop,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
        scrollportTop: +top.toFixed(1),
        surface: surface === null ? null : getComputedStyle(surface).backgroundColor,
        headers: found.map(header => {
          const box = header.getBoundingClientRect()
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 20))
          return {
            top: +box.top.toFixed(1),
            height: +box.height.toFixed(1),
            position: getComputedStyle(header).position,
            background: getComputedStyle(header).backgroundColor,
            hitHeader: hit !== null && (hit === header || header.contains(hit)),
            hitClass: hit === null ? '(none)' : (hit.className || '').toString().slice(0, 40),
          }
        }),
      }
    })
    const scrollTo = (value: number): Promise<void> => page.evaluate((target: number) => {
      const scroller = [...document.querySelectorAll('*')]
        .find(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) as HTMLElement
      scroller.scrollTop = target
    }, value)

    /** Alpha 1 — an opaque fill, or rows would show through the parked header. */
    const opaque = (colour: string): boolean => {
      const parts = /rgba?\(([^)]+)\)/.exec(colour)?.[1]?.split(',').map(part => Number.parseFloat(part)) ?? []
      return parts.length >= 3 && (parts.length < 4 || (parts[3] ?? 1) === 1)
    }

    // (a) A little way in: the FIRST header has parked at the scrollport's top edge, the second is below it.
    await scrollTo(220)
    await page.waitForTimeout(250)
    const first = await geometry()
    expect(first.headers[0]!.position, 'the header is not sticky at all').toBe('sticky')
    expect(opaque(first.headers[0]!.background), `header fill is ${first.headers[0]!.background}`).toBe(true)
    if (first.surface !== null) {
      expect(first.headers[0]!.background, 'the parked header must paint the surface it covers').toBe(first.surface)
    }
    expect(Math.abs(first.headers[0]!.top - first.scrollportTop),
      `first header top ${first.headers[0]!.top} vs scrollport ${first.scrollportTop} at scrollTop ${first.scrollTop}`).toBeLessThanOrEqual(3)
    expect(first.headers[1]!.top, `the second header is already at the top at scrollTop ${first.scrollTop}`).toBeGreaterThan(first.scrollportTop + 40)
    // It really COVERS: a click at its own centre lands on the header, not on a row passing under it.
    expect(first.headers[0]!.hitHeader, `elementFromPoint hit ${first.headers[0]!.hitClass}`).toBe(true)

    // (b) Scrolled until the SECOND header reaches the top: it takes over, and the first is pushed above.
    const delta = first.headers[1]!.top - first.scrollportTop
    await scrollTo(Math.min(first.scrollTop + delta, first.maxScroll))
    await page.waitForTimeout(250)
    const second = await geometry()
    expect(Math.abs(second.headers[1]!.top - second.scrollportTop),
      `second header top ${second.headers[1]!.top} vs scrollport ${second.scrollportTop} at scrollTop ${second.scrollTop}`).toBeLessThanOrEqual(3)
    expect(second.headers[0]!.top, 'the first header did not hand over: it is still parked at the top').toBeLessThan(second.scrollportTop)
    expect(second.headers[1]!.hitHeader, `elementFromPoint hit ${second.headers[1]!.hitClass}`).toBe(true)
    expect(opaque(second.headers[1]!.background), `second header fill is ${second.headers[1]!.background}`).toBe(true)

    await page.keyboard.press('Escape')
    await openPanel(page)
  })

  test('p5. 预览卡片停在分组标题下方，不被标题盖住', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
    const settings = page.locator('[data-diff-settings]').first()
    try {
      await expect(settings).toBeVisible({ timeout: 30_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }
    // The diff-view group, open: the preview only exists inside its body.
    const header = settings.locator('> div > button').first()
    if (await header.evaluate(node => node.parentElement?.hasAttribute('data-open') !== true)) {
      await header.click({ timeout: 20_000 })
    }
    await expect(page.locator('[data-diff-view-preview]').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(400)

    /** The scrollport, the parked header and the sticky preview. */
    const geometry = (): Promise<{
      scrollTop: number
      scrollportTop: number
      headerVariable: string
      header: { top: number, bottom: number, height: number }
      preview: { top: number, bottom: number }
      previewTopRule: string
    }> => page.evaluate(() => {
      const scroller = [...document.querySelectorAll('*')]
        .find(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) as HTMLElement | undefined
      if (scroller === undefined) throw new Error('the settings scroller was not found')
      const group = document.querySelector('[data-diff-settings] > div') as HTMLElement
      const headerNode = group.querySelector(':scope > button') as HTMLElement
      const preview = document.querySelector('[data-diff-view-preview]') as HTMLElement
      const rect = (node: Element): { top: number, bottom: number, height: number } => {
        const box = node.getBoundingClientRect()
        return { top: +box.top.toFixed(1), bottom: +box.bottom.toFixed(1), height: +box.height.toFixed(1) }
      }
      return {
        scrollTop: scroller.scrollTop,
        scrollportTop: +scroller.getBoundingClientRect().top.toFixed(1),
        headerVariable: getComputedStyle(group).getPropertyValue('--settings-header-h').trim(),
        header: rect(headerNode),
        preview: rect(preview),
        previewTopRule: getComputedStyle(preview).top,
      }
    })
    const scrollTo = (value: number): Promise<void> => page.evaluate((target: number) => {
      const scroller = [...document.querySelectorAll('*')]
        .find(node => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) as HTMLElement
      scroller.scrollTop = target
    }, value)

    // At rest the header is not stuck yet and the preview sits below it naturally.
    const rest = await geometry()
    expect(rest.headerVariable, `the group did not publish --settings-header-h: ${JSON.stringify(rest)}`).not.toBe('')
    // The published value is the header's own height, rounded to a whole pixel (the rect reports a fraction).
    expect(Math.abs(Number.parseFloat(rest.headerVariable) - rest.header.height),
      `published ${rest.headerVariable} vs header ${rest.header.height}: ${JSON.stringify(rest)}`).toBeLessThanOrEqual(1)
    expect(rest.preview.top).toBeGreaterThan(rest.header.bottom)

    // (a) Scrolled well in: BOTH are parked, and the preview is at or just below the header's bottom. The
    // conflict was a 75px overlap — the header covering the preview's whole top.
    await scrollTo(400)
    await page.waitForTimeout(250)
    const parked = await geometry()
    expect(Math.abs(parked.header.top - parked.scrollportTop),
      `the header is not parked: ${JSON.stringify(parked)}`).toBeLessThanOrEqual(3)
    expect(parked.preview.top, `the preview is not parked, it is still near its natural place: ${JSON.stringify(parked)}`)
      .toBeLessThan(parked.scrollportTop + parked.header.height + 40)
    expect(parked.preview.top, `header ${parked.header.top}..${parked.header.bottom} covers the preview at ${parked.preview.top}`)
      .toBeGreaterThanOrEqual(parked.header.bottom - 1)
    expect(parked.preview.top, `the preview parked far below the header: ${JSON.stringify(parked)}`)
      .toBeLessThanOrEqual(parked.header.bottom + 2)
    expect(parked.previewTopRule).toBe(parked.headerVariable)

    // (b) It is genuinely PARKED, not scrolled away: another step leaves both rects where they were.
    await scrollTo(460)
    await page.waitForTimeout(250)
    const further = await geometry()
    expect(Math.abs(further.preview.top - parked.preview.top),
      `the preview moved instead of staying parked: ${JSON.stringify(parked)} → ${JSON.stringify(further)}`).toBeLessThanOrEqual(1)
    expect(Math.abs(further.header.top - parked.header.top)).toBeLessThanOrEqual(1)
    expect(further.preview.top).toBeGreaterThanOrEqual(further.header.bottom - 1)

    await page.keyboard.press('Escape')
    await openPanel(page)
  })
})
