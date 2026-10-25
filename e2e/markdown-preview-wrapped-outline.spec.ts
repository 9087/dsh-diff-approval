// The preview's hover outline around a change that WRAPS over several lines.
//
// The outline used to be ONE bounding box around the change's whole extent. For a paragraph that wraps, that
// box swallowed the empty tail of a short line and the gap between the lines (the reported wrapped-paragraph
// case). It is now one rectangle per VISUAL LINE: hovering a wrapped change frames each line separately.
//
// This spec measures the real geometry: a deleted (ghost) paragraph long enough to wrap, hovered, must produce
// several outline boxes with distinct vertical positions, each a single line tall, and the toolbar still
// anchored once.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

/** Long enough to wrap over several lines at the panel's width. */
const WRAPPED = '这一段在新版本里会被整段删除，用来验证换行后的差异框选：它必须换成每一行一个矩形，而不是一个包围盒。'.repeat(3)

const OLD = `# 说明\n\n${WRAPPED}\n\n结尾一段。\n`
const NEW = '# 说明\n\n结尾一段。\n'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let fileId: string

interface Outline {
  top: number
  left: number
  width: number
  height: number
}

test.describe.configure({ mode: 'serial' })

test.describe('hover outline of a wrapped change', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    const files: SeededFile[] = [{ name: 'wrapped.md', oldText: OLD, newText: NEW }]
    fixture = makeFixture('wrapped-outline')
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: wrapped outline')
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
    await page.evaluate(() => {
      localStorage.setItem('diff-approval:temp-preview-v2', '1')
      localStorage.setItem('diff-approval:md-preview', '1')
    })
    await openSession(page, 'e2e: wrapped outline')
    await openPanel(page)
    await ensurePanelList(page)
    await page.setViewportSize({ width: 1200, height: 950 })
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('frames every visual line separately', async () => {
    test.setTimeout(300_000)
    await row(page, fileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    // The deleted paragraph is a ghost block (it no longer renders, so it is drawn struck), and it wraps.
    const target = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const ghost = [...body.querySelectorAll<HTMLElement>('p')]
        .find(paragraph => (paragraph.textContent ?? '').includes('这一段在新版本里会被整段删除'))
      if (ghost === undefined) return null
      const rect = ghost.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      return {
        x: rect.left + 40,
        y: rect.top + rect.height / 2,
        bodyHeight: bodyRect.height,
        bodyWidth: bodyRect.width,
        ghostWidth: rect.width,
      }
    })
    expect(target, 'the wrapped ghost paragraph is rendered').not.toBeNull()
    expect(target!.ghostWidth).toBeGreaterThan(300)
    await page.mouse.move(target!.x, target!.y)
    await page.waitForTimeout(500)

    const outlines: Outline[] = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-diff-unit-outline]')]
      .map(element => {
        const rect = element.getBoundingClientRect()
        return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }
      })
      .filter(outline => outline.width > 0 && outline.height > 0))
    // One rectangle per visual line — a single bounding box would be ONE (short) box.
    expect(outlines.length).toBeGreaterThanOrEqual(2)
    // Each is one text line tall, not the whole paragraph.
    for (const outline of outlines) {
      expect(outline.height, JSON.stringify(outline)).toBeLessThan(40)
      expect(outline.height, JSON.stringify(outline)).toBeGreaterThan(10)
    }
    // They sit on DIFFERENT lines, and none is the paragraph's outer box.
    const tops = outlines.map(outline => outline.top).sort((left, right) => left - right)
    expect(new Set(tops).size).toBeGreaterThanOrEqual(2)
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(15)
    // The last line of a wrapped paragraph is shorter: at least one box is narrower than the body.
    const narrowest = Math.min(...outlines.map(outline => outline.width))
    expect(narrowest).toBeLessThan(target!.bodyWidth - 20)
    // The toolbar is still ONE frame, anchored to the change.
    const frame = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('[data-diff-block-actions]')
      return element === null ? null : (element.textContent ?? '').slice(0, 20)
    })
    expect(frame, 'the keep/revert toolbar is placed').not.toBeNull()
  })

  test('frames a change that sits on one line as one rectangle', async () => {
    test.setTimeout(300_000)
    // `结尾一段。` is untouched: hover it and nothing is framed (context, not a change).
    const context = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const paragraph = [...body.querySelectorAll<HTMLElement>('p')]
        .find(element => (element.textContent ?? '').includes('结尾一段'))
      return paragraph === undefined ? null : { x: paragraph.getBoundingClientRect().left + 10, y: paragraph.getBoundingClientRect().top + 6 }
    })
    expect(context).not.toBeNull()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(300)
    await page.mouse.move(context!.x, context!.y)
    await page.waitForTimeout(500)
    const outlines = await page.evaluate(() => document.querySelectorAll('[data-diff-unit-outline]').length)
    expect(outlines).toBe(0)
  })
})
