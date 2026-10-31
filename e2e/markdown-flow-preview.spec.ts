// End-to-end regression for the FLOW diff preview (the shipped pipeline):
//   single column  -> renderFlowMerged
//   double column  -> renderFlowDouble
// It pins the behaviours added during the flow redesign: character-level runs (paragraph/quote/table cell),
// task-list tick state, the double column's per-row blocks and divider, its right-anchored block toolbar, the
// whole-block tint of a language change, keep/revert writing the right line ranges, and whole-file add/delete.
//
// The old tree-column preview spec that lived here exercised `renderTreeMerged` / `renderTreeDocuments`, which
// were removed once the panel moved entirely to the flow renderers; its replacement is this file.

import { readFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

const FENCE = '`'.repeat(3)

const OLD = [
  '# 标题', '',
  '这是第二段，旧文字。', '',
  '> 引用里的旧句子。', '',
  '| 名称 | 说明 |', '| --- | --- |', '| 旧词汇 | 不变 |', '',
  '- [x] 已完成任务', '- [ ] 未完成任务', '',
  FENCE + 'js', "print('same language')", FENCE, '',
].join('\n')

const NEW = [
  '# 标题', '',
  '这是第二段，新文字。', '',
  '> 引用里的新句子。', '',
  '| 名称 | 说明 |', '| --- | --- |', '| 新词汇 | 不变 |', '',
  '- [x] 已完成任务', '- [ ] 未完成任务', '',
  FENCE + 'py', "print('language changed')", FENCE, '',
].join('\n')

const REVERT_OLD = [
  '# 回归', '',
  '| A | B |', '| --- | --- |', '| 旧说明 | 1 |', '| keep | 2 |', '',
  FENCE + 'js', 'const version = 1', FENCE, '',
].join('\n')

const REVERT_NEW = [
  '# 回归', '',
  '| A | B |', '| --- | --- |', '| 新说明 | 1 |', '| keep | 2 |', '',
  FENCE + 'py', "print('language changed')", FENCE, '',
].join('\n')

const ADD_NEW = '# 全新增\n\n新增段落。\n'
const DEL_OLD = '# 全删除\n\n删除段落。\n'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let mainId: string
let revertId: string
let addId: string
let delId: string

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

test.describe.configure({ mode: 'serial' })

test.describe('flow preview', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN。')
      return
    }
    const files: SeededFile[] = [
      { name: 'flow-main.md', oldText: OLD, newText: NEW },
      { name: 'flow-revert.md', oldText: REVERT_OLD, newText: REVERT_NEW },
      { name: 'flow-add.md', oldText: '', newText: ADD_NEW },
      { name: 'flow-delete.md', oldText: DEL_OLD, newText: '' },
    ]
    fixture = makeFixture('flow-preview')
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: flow preview')
    await page.close()
    await stopHost(host.proc)

    const seeded = seedPending(fixture, sessionId, files, [])
    mainId = seeded.entries[0]!.id
    revertId = seeded.entries[1]!.id
    addId = seeded.entries[2]!.id
    delId = seeded.entries[3]!.id
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await page.evaluate(() => {
      localStorage.setItem('diff-approval:temp-preview-v2', '1')
      localStorage.setItem('diff-approval:md-preview', '1')
      localStorage.removeItem('diff-approval:tree-diff')
    })
    await openSession(page, 'e2e: flow preview')
    await openPanel(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  const openPreview = async (id: string): Promise<void> => {
    await row(page, id).click({ timeout: 20_000 })
    await page.locator('[data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(400)
    }
    await sleep(500)
  }
  const body = (): ReturnType<Page['locator']> => page.locator('[data-diff-md-preview-body]').first()
  const ensureSingle = async (): Promise<void> => {
    if (await page.locator('.mdFlowDouble').count() > 0) {
      await page.locator('[data-diff-toggle-view]').click({ timeout: 10_000 })
      await page.waitForTimeout(700)
    }
  }
  const ensureDouble = async (): Promise<void> => {
    if (await page.locator('.mdFlowDouble').count() === 0) {
      await page.locator('[data-diff-toggle-view]').click({ timeout: 10_000 })
      await page.waitForTimeout(800)
    }
  }
  /** Hover a target and wait for the scroll-anchor restore to go quiet before measuring. */
  const hoverTarget = async (target: ReturnType<Page['locator']>): Promise<void> => {
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1600)
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + Math.min(30, box!.width / 2), box!.y + box!.height / 2)
    await page.waitForTimeout(500)
  }
  const revertAt = async (target: ReturnType<Page['locator']>): Promise<void> => {
    let position = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      await hoverTarget(target)
      position = await page.evaluate(() => document.querySelector('[data-diff-block-position]')?.textContent ?? '')
      if (position !== '') break
      await page.mouse.move(4, 4)
      await page.waitForTimeout(400)
    }
    expect(position).not.toBe('')
    await page.evaluate(() => { document.querySelector<HTMLElement>('[data-diff-block-revert]')?.click() })
    await page.waitForTimeout(700)
    const confirm = page.locator('[data-diff-confirm-keep]')
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click({ timeout: 10_000 })
      await page.waitForTimeout(900)
    }
    await page.waitForTimeout(1800)
  }

  test('single column: word runs, quote/table cell runs and task ticks', async () => {
    test.setTimeout(300_000)
    await openPreview(mainId)
    await ensureSingle()
    await page.waitForTimeout(500)
    const words = await page.evaluate(() => ({
      all: [...document.querySelectorAll('.mdWordDel, .mdWordAdd')].map(element => `${element.className}:${element.textContent}`),
      inQuote: [...document.querySelectorAll('blockquote .mdWordDel, blockquote .mdWordAdd')].map(element => element.textContent),
      inCell: [...document.querySelectorAll('td .mdWordDel, td .mdWordAdd')].map(element => element.textContent),
      ticks: [...document.querySelectorAll<HTMLInputElement>('[data-diff-md-preview-body] input[type="checkbox"]')].map(input => input.checked),
    }))
    // paragraph 旧/新 + quote 旧/新 + cell 旧/新
    expect(words.all.filter(entry => entry.startsWith('mdWordDel'))).toHaveLength(3)
    expect(words.all.filter(entry => entry.startsWith('mdWordAdd'))).toHaveLength(3)
    expect(words.inQuote.sort()).toEqual(['新', '旧'])
    expect(words.inCell.sort()).toEqual(['新', '旧'])
    expect(words.ticks).toEqual([true, false])
  })

  test('double column: aligned rows, divider, character runs and right-anchored toolbar', async () => {
    test.setTimeout(300_000)
    await openPreview(mainId)
    await ensureDouble()
    await expect(page.locator('.mdFlowDouble')).toHaveCount(1)
    // Rows: context rows and difference rows both exist; every difference row carries both halves.
    await expect(page.locator('.mdFlowDoubleRow-diff').first()).toBeVisible()
    const diff = page.locator('.mdFlowDoubleRow-diff').first()
    await expect(diff.locator('.mdFlowDoubleCell-old')).toHaveCount(1)
    await expect(diff.locator('.mdFlowDoubleCell-new')).toHaveCount(1)
    const divider = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.mdFlowDouble')!, '::after').width)
    expect(divider).toBe('1px')
    // Character runs survive in both halves.
    const runs = await page.evaluate(() => [...document.querySelectorAll('.mdWordDel, .mdWordAdd')].map(element => element.textContent).sort())
    expect(runs).toEqual(['新', '新', '新', '旧', '旧', '旧'].sort())
    // The toolbar is pinned to the pane's right edge (the code view's anchor).
    const quote = body().getByText('引用里的新句子。').first()
    await hoverTarget(quote)
    const right = await page.evaluate(() => document.querySelector<HTMLElement>('[data-diff-block-actions]')?.style.right ?? '')
    expect(right).toBe('0px')
    await expect(page.locator('[data-diff-block-position]')).not.toBeEmpty()
  })

  test('double column: a language change is ONE whole-block tint per half', async () => {
    test.setTimeout(300_000)
    await openPreview(mainId)
    await ensureDouble()
    const whole = page.locator('.mdFlowDoubleCodeWhole')
    await expect(whole).toHaveCount(1)
    // The whole-fence difference is painted by the row's own half-band, not by per-line bands.
    await expect(whole.locator('.mdFlowDoubleTintBand')).toHaveCount(0)
    const background = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.mdFlowDoubleCodeWhole')!, '::before').backgroundImage)
    expect(background).toContain('linear-gradient')
  })

  test('double column: revert writes the table cell and the changed-language fence', async () => {
    test.setTimeout(300_000)
    await openPreview(revertId)
    await ensureDouble()
    await revertAt(body().getByText('新说明', { exact: true }).first())
    let text = readFileSync(revertId, 'utf8')
    expect(text).toContain('| 旧说明 | 1 |')
    expect(text).not.toContain('新说明')
    await revertAt(body().getByText("print('language changed')").first())
    text = readFileSync(revertId, 'utf8')
    expect(text).toContain('const version = 1')
    expect(text).not.toContain('language changed')
  })

  test('double column: whole-file add and delete are one one-sided row each', async () => {
    test.setTimeout(300_000)
    await openPreview(addId)
    await ensureDouble()
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveCount(1)
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveAttribute('data-md-kind', 'add')
    await expect(page.locator('.mdFlowDoubleCell-old.mdFlowDoubleCell-empty')).toHaveCount(1)
    await expect(page.locator('.mdFlowDoubleCell-new .mdFlowDoubleContent')).toHaveCount(1)

    await openPreview(delId)
    await ensureDouble()
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveCount(1)
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveAttribute('data-md-kind', 'del')
    await expect(page.locator('.mdFlowDoubleCell-new.mdFlowDoubleCell-empty')).toHaveCount(1)
  })
})
