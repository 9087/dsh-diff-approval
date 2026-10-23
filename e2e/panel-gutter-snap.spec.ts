// The line-number columns are PINNED at the panel's left edge (`position: sticky; left: 0`) — for good. That is
// the reading surface's map of the file and it must not move.
//
// Pinned columns have one failure mode, though: a trackpad scrolled DOWN leaves a little sideways drift in its
// wheel events, and forwarded to `scrollLeft` that drift accumulates a character at a time — until the columns
// cover the BEGINNINGS of every line (the reported "每" case: the reader never panned, yet the line starts were
// gone). The panel therefore snaps a small sideways offset back to the left edge once a wheel burst settles;
// a deliberate pan (scrollbar drag, a wide swipe) is left alone.
//
// This spec drives a real wheel in a pane too narrow for the file's longest line and reads the offset back:
// small drift lands back at 0 with the columns still pinned and the line start still at their edge; a wide pan
// stays where the reader put it with the columns still pinned.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

const LONG = '每行文案取自汇总弹窗自己的专属 key，不再复用被合并弹窗的内容，载体是列表式面板，不依赖弹窗提醒的配置行。'.repeat(4)

const OLD = `# 说明\n\n| 场景 | 应返回 |\n| --- | --- |\n| All | true |\n\n${LONG}旧。\n\n# E2E 出口\n\ntail\n`
const NEW = `# 说明\n\n| 场景 | 应返回 |\n| --- | --- |\n| All | true |\n\n${LONG}新。\n\n# E2E 出口\n\ntail\n`

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let fileId: string

interface Reading {
  scrollLeft: number
  scrollable: boolean
  /** Computed `position` of the FIRST gutter cell — the pin the reader asked to keep. */
  position: string
  /** Right edge of the RIGHTMOST gutter cell: where the code column starts. */
  gutterRight: number
  /** On-screen x of the changed line's first character. */
  firstCharX: number | null
}

test.describe.configure({ mode: 'serial' })

test.describe('sideways drift under the pinned line numbers', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    const files: SeededFile[] = [{ name: 'pan.md', oldText: OLD, newText: NEW }]
    fixture = makeFixture('pan-snap')
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: pan snap')
    await page.close()
    await stopHost(host.proc)

    const seeded = seedPending(fixture, sessionId, files, [])
    fileId = seeded.entries[0]!.id
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, 'e2e: pan snap')
    await openPanel(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  const read = async (): Promise<Reading> => page.evaluate(() => {
    const body = document.querySelector('[data-diff-body]') as HTMLElement
    const gutters = [...body.querySelectorAll<HTMLElement>('[data-diff-gutter]')]
    const code = [...body.querySelectorAll<HTMLElement>('[data-diff-code]')]
      .find(element => (element.textContent ?? '').includes('每行文案')) as HTMLElement | undefined
    const rightmost = Math.round(Math.max(...gutters.map(gutter => gutter.getBoundingClientRect().right)))
    let firstCharX: number | null = null
    if (code !== undefined) {
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()
      if (node !== null) {
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, 1)
        firstCharX = Math.round(range.getBoundingClientRect().x)
      }
    }
    return {
      scrollLeft: Math.round(body.scrollLeft),
      scrollable: body.scrollWidth > body.clientWidth + 2,
      position: getComputedStyle(gutters[0]!).position,
      gutterRight: rightmost,
      firstCharX,
    }
  })

  /** Put the pointer over the code rows, where a wheel scrolls the code box. */
  const hoverCode = async (): Promise<void> => {
    const rect = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-body]') as HTMLElement
      const box = body.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + Math.min(220, box.height / 2) }
    })
    await page.mouse.move(rect.x, rect.y)
  }

  test('snaps a small sideways drift back, keeps a deliberate pan — and the line numbers stay pinned', async () => {
    test.setTimeout(300_000)
    await row(page, fileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body]').first().waitFor({ timeout: 20_000 })
    // Narrow enough that the long line really overflows: a pan has somewhere to go.
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(400)
    await hoverCode()

    const atLeft = await read()
    expect(atLeft.scrollable, 'the fixture must overflow so the pane can be panned').toBe(true)
    expect(atLeft.scrollLeft).toBe(0)
    expect(atLeft.position, 'the columns are pinned at the left edge').toBe('sticky')
    expect(atLeft.firstCharX).not.toBeNull()
    expect(Math.abs(atLeft.firstCharX! - atLeft.gutterRight)).toBeLessThanOrEqual(2)

    // The trackpad drift: a small wheel deltaX. It scrolls the code a character's width, then settles — and the
    // snap must give the line's first character its place back (the column never moved over it).
    await page.mouse.wheel(18, 0)
    await page.waitForTimeout(500)
    const drifted = await read()
    expect(drifted.scrollLeft, 'a small sideways drift snaps back to the left edge').toBe(0)
    expect(drifted.position, 'the columns stay pinned').toBe('sticky')
    expect(drifted.firstCharX).not.toBeNull()
    expect(Math.abs(drifted.firstCharX! - drifted.gutterRight)).toBeLessThanOrEqual(2)

    // A DELIBERATE pan (a wide swipe / dragging the scrollbar) is beyond the drift allowance: it stays.
    await page.mouse.wheel(240, 0)
    await page.waitForTimeout(500)
    const panned = await read()
    expect(panned.scrollLeft, 'a deliberate pan is not snapped away').toBeGreaterThan(32)
    expect(panned.position, 'the columns stay pinned').toBe('sticky')
  })
})
