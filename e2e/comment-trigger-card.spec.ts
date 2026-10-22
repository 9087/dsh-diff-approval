// A comment sent from the review panel is DELIVERED through the host's wake-up seam, so the chat draws it
// as a `turn-trigger` card — the same card a scheduled reminder or a shortcut gets — instead of a user
// bubble. The shell's title comes from a closed switch over the message source, so this plugin's client
// corrects it to name the file and lines the comment came from.
//
// What this spec proves, end to end: the delivery path really is the wake-up one (a card exists at all), the
// card is attributed to this plugin (`data-diff-approval-comment-card`), and its title names the reviewed
// file and the comment's lines. The agent's own turn is not asserted: a fixture host has no model.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  askInComment, beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession,
} from './helpers/gui.ts'

const OLD = '# 部署指南\n\n第一步：克隆仓库。\n\n## 配置\n\n端口默认 3000。\n'
const NEW = '# 部署指南\n\n第一步：拉取仓库。\n\n## 配置\n\n端口默认 8080。\n'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let commentId: string

test.describe.configure({ mode: 'serial' })

test.describe('a delivered comment is drawn as a trigger card', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    const files: SeededFile[] = [{ name: 'deploy-guide.md', oldText: OLD, newText: NEW }]
    fixture = makeFixture('card')
    const workspaceId = await bootstrapHome(dsh, fixture)

    // ---- phase one: a session made by the GUI, then the host stops so the store can be written.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: card')
    await page.close()
    await stopHost(host.proc)

    const seeded = seedPending(fixture, sessionId, files, ['deploy-guide.md'])
    commentId = seeded.comments[0]!.id
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the host reads the seeded store; the panel asks its comment.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, 'e2e: card')
    await openPanel(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('the card names this plugin and the comment\'s file and lines', async () => {
    test.setTimeout(300_000)
    await page.locator('[data-diff-approval-panel], [data-diff-approval-dock]').first().waitFor({ timeout: 20_000 })
    await askInComment(page, commentId)
    // The wake-up delivery draws the card immediately; the title is corrected a frame after the snapshot
    // reaches the bridge, so give the DOM pass a beat.
    await page.waitForTimeout(2500)

    const cards = await page.evaluate(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="turn-trigger"]')]
      return found.map(card => {
        const header = card.querySelector('button[aria-expanded]')
        const titleSpan = header === null
          ? null
          : [...header.children].find(child => child.tagName === 'SPAN' && child.querySelector('svg') === null)
        return {
          title: titleSpan?.textContent ?? null,
          ours: card.hasAttribute('data-diff-approval-comment-card'),
          text: (card.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
        }
      })
    })
    // The message woke the agent, so the shell drew it as a card — not as a user bubble.
    expect(cards.length).toBeGreaterThan(0)
    const ours = cards.filter(card => card.ours)
    expect(ours).toHaveLength(1)
    // The title is the plugin's own wording plus the file and the comment's lines (the anchor is line 2 of
    // the seeded comment). The shell's own generic title never survives on our card.
    expect(ours[0]!.title).toMatch(/^(代码评论|Code comment) · deploy-guide\.md:2$/)
    expect(ours[0]!.text).not.toContain('收到执行请求')
    expect(ours[0]!.text).not.toContain('Execution requested')
  })
})
