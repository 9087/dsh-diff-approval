// The new Markdown preview's scroll must survive a Keep.
//
// An action re-renders the preview from the new texts, and the resolved change loses height: a no-rendering
// pair (a front-matter chip) disappears, a ghost paragraph goes, a one-sided row collapses. The content under
// the viewport then slides up while the scroll offset stays put — the reader sees the document jump. This spec
// keeps a change ABOVE the viewport while scrolled down, in both layouts, and asserts the block the eye is on
// stays exactly where it was.
//
// The fixture is its own short guide (not the demo documents): a front-matter pair at the top — the chip that
// disappears when kept — a paragraph that exists only in the old version, a list item only in the new one, and
// a word change in each section so the diff has changes all the way down.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, pressUndo, row } from './helpers/gui.ts'

const SECTIONS = [
  ['安装', '第一步：克隆仓库。', '第一步：拉取仓库。'],
  ['配置', '端口默认 3000。', '端口默认 8080。'],
  ['构建', '执行 pnpm build。', '执行 pnpm run build。'],
  ['部署', '把产物拷贝到服务器。', '把产物上传到服务器。'],
  ['回滚', '使用上一版产物。', '使用上一版备份产物。'],
  ['监控', '查看错误日志。', '查看错误与慢请求日志。'],
  ['清理', '删除临时目录。', '删除临时目录与缓存。'],
  ['升级', '重新安装即可。', '拉取最新版后重新安装即可。'],
] as const

const OLD = [
  '---', 'title: 部署指南', 'version: 1', '---', '',
  '# 部署指南', '', '本文说明部署流程。', '',
  ...SECTIONS.flatMap(([title, before]) => [`## ${title}`, '', `${before}`, '',
    ...(title === '部署' ? ['旧版说明：拷贝完成后重启服务。', ''] : []),
    `- ${title}步骤一`, `- ${title}步骤二`, '']),
  '## 附录', '', '以上是全部内容。', '',
].join('\n')

const NEW = [
  '---', 'title: 部署指南', 'version: 2', '---', '',
  '# 部署指南', '', '本文说明部署流程。', '',
  ...SECTIONS.flatMap(([title, , after]) => [`## ${title}`, '', `${after}`, '',
    ...(title === '监控' ? ['- 监控步骤三', ''] : []),
    `- ${title}步骤一`, `- ${title}步骤二`, '']),
  '## 附录', '', '以上是全部内容。', '',
].join('\n')

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let fileId: string

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

test.describe.configure({ mode: 'serial' })

test.describe('the preview keeps its scroll across a Keep', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    const files: SeededFile[] = [{ name: 'deploy-guide.md', oldText: OLD, newText: NEW }]
    fixture = makeFixture('scroll')
    const workspaceId = await bootstrapHome(dsh, fixture)

    // ---- phase one: a session made by the GUI, then the host stops so the store can be written.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: scroll')
    await page.close()
    await stopHost(host.proc)

    const seeded = seedPending(fixture, sessionId, files, [])
    fileId = seeded.entries[0]!.id
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the host comes back up and reads the store it could not see while running.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    // The new preview sits behind its temporary switch, and it is off by default: set the flag BEFORE the
    // panel mounts, so it reads the setting at startup.
    await page.evaluate(() => {
      localStorage.setItem('diff-approval:temp-preview-v2', '1')
      localStorage.setItem('diff-approval:md-preview', '1')
    })
    await openSession(page, 'e2e: scroll')
    await openPanel(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  const openPreview = async (): Promise<void> => {
    await row(page, fileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(400)
    }
  }

  /**
   * Scroll into the middle, keep the no-rendering pair that sits ABOVE the viewport (the chip loses its
   * height when kept), and return where the panel's OWN scroll anchor stood on screen before and after.
   *
   * The panel records the anchor it captures in `data-preview-scroll-anchor` (on the document element) right
   * before the action. That record is the promise this spec verifies: after the re-render, the SAME element is
   * still at the SAME screen position. It is deliberately not an arbitrary heading: the anchor is the first
   * visible unchanged block — the place the reader's eye actually rests.
   */
  const keepAboveAndMeasure = async (): Promise<{ before: number; after: number; scrollBefore: number; scrollAfter: number }> => {
    const setup = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) * 0.55)
      delete document.documentElement.dataset.previewScrollAnchor
      const bodyRect = body.getBoundingClientRect()
      const chip = [...body.querySelectorAll<HTMLElement>('[data-md-block="0"]')].find(element =>
        element.classList.contains('mdSourcePair'))
      if (chip === undefined) return null
      chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      return {
        scrollTop: body.scrollTop,
        chipAbove: chip.getBoundingClientRect().bottom < bodyRect.top,
      }
    })
    expect(setup, 'the fixture must render the front-matter chip').not.toBeNull()
    expect(setup!.chipAbove, 'the kept change must sit above the viewport').toBe(true)
    await sleep(250)
    await page.evaluate(() => {
      document.querySelector('[data-diff-block-keep]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The panel records its anchor before it starts the action; wait for that record.
    let anchor: { tag: string; text: string; ordinal: number; screenTop: number } | null = null
    for (let attempt = 0; attempt < 40 && anchor === null; attempt++) {
      await sleep(50)
      anchor = await page.evaluate(() => {
        const raw = document.documentElement.dataset.previewScrollAnchor
        return raw === undefined ? null : JSON.parse(raw) as { tag: string; text: string; ordinal: number; screenTop: number }
      })
    }
    expect(anchor, 'the panel must record the scroll anchor it captures').not.toBeNull()
    // The re-render lands and the anchor is restored in the frames after it; a web font settling can reflow the
    // preview later (the panel keeps holding the anchor through that first second), so measure only once the
    // anchor's position is STABLE for two consecutive samples.
    const selector = 'h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,blockquote'
    let after: { top: number | null; scrollTop: number } = { top: null, scrollTop: 0 }
    let lastTop: number | null = null
    let stable = 0
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(100)
      after = await page.evaluate(({ anchor: wanted, selector: anchorSelector }) => {
        const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
        const bodyRect = body.getBoundingClientRect()
        const same = [...body.querySelectorAll<HTMLElement>(anchorSelector)].filter(element =>
          element.closest('[data-diff-md-preview-content]') !== null &&
          element.querySelector('[data-md-block]') === null &&
          element.tagName === wanted.tag &&
          (element.textContent ?? '').replace(/\s+/g, ' ').trim() === wanted.text)
        const target = same[wanted.ordinal]
        return {
          top: target === undefined ? null : Math.round(target.getBoundingClientRect().top - bodyRect.top),
          scrollTop: body.scrollTop,
        }
      }, { anchor, selector })
      if (after.top === null) {
        stable = 0
        continue
      }
      if (lastTop !== null && Math.abs(after.top - lastTop) <= 1) {
        stable++
        if (stable >= 2) break
      } else {
        stable = 0
      }
      lastTop = after.top
    }
    expect(after.top, 'the anchor block must still be on screen').not.toBeNull()
    return { before: anchor!.screenTop, after: after.top!, scrollBefore: setup!.scrollTop, scrollAfter: after.scrollTop }
  }

  test('single column: the anchor stays put', async () => {
    test.setTimeout(300_000)
    await openPreview()
    const measured = await keepAboveAndMeasure()
    console.log('[scroll single]', JSON.stringify(measured))
    expect(Math.abs(measured.after - measured.before)).toBeLessThanOrEqual(2)
    // The scroll offset itself moved to make that true: the document got shorter above the viewport.
    expect(measured.scrollAfter).not.toBe(measured.scrollBefore)
    // Put the source twin back for the double-column case: the two layouts are measured on the same diff.
    await pressUndo(page)
    await page.waitForTimeout(800)
    await page.locator('.mdSourcePair').first().waitFor({ timeout: 20_000 })
  })

  test('double column: the anchor stays put', async () => {
    test.setTimeout(300_000)
    await page.locator('[data-diff-toggle-view]').first().click()
    await page.waitForTimeout(700)
    const measured = await keepAboveAndMeasure()
    console.log('[scroll double]', JSON.stringify(measured))
    expect(Math.abs(measured.after - measured.before)).toBeLessThanOrEqual(2)
    expect(measured.scrollAfter).not.toBe(measured.scrollBefore)
  })
})
