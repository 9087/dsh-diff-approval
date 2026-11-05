// End-to-end regression for the FLOW diff preview (the shipped pipeline):
//   single column  -> renderFlowMerged
//   double column  -> renderFlowDouble
// It pins the behaviours added during the flow redesign: character-level runs (paragraph/quote/table cell),
// task-list tick state, the double column's per-row blocks and divider, its right-anchored block toolbar, the
// whole-block tint of a language change, keep/revert writing the right line ranges, and whole-file add/delete.
//
// The old tree-column preview spec that lived here exercised `renderTreeMerged` / `renderTreeDocuments`, which
// were removed once the panel moved entirely to the flow renderers; its replacement is this file.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

// The fence is on purpose: a whole-file addition must not paint a ghost card for it in the EMPTY old column.
const ADD_NEW = ['# 全新增', '', '新增段落。', '', FENCE + 'ts', 'const x = 1', FENCE, ''].join('\n')
const DEL_OLD = '# 全删除\n\n删除段落。\n'

// A picture's change: the block's height comes from the image, which is inlined AFTER the body renders. The
// flash measured before that inline is the collapsed block's, which is the drift the last test pins.
const IMAGE_OLD = [
  '# 图片', '',
  '旧段落。', '',
].join('\n')
const IMAGE_NEW = [
  '# 图片', '',
  '![截图](shot.svg)', '',
].join('\n')
/** A real (if plain) SVG so the host's preview-image read returns bytes the browser lays out. */
const SHOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#dbeafe"/></svg>'

// The SPEC table's case: a value grows from one word to a wrapped sentence and a row exists on one side only.
// The two columns' tables must keep the same row slots and level each pair's height (see the last test).
const TABLE_OLD = [
  '# 表格', '',
  '| 项目 | 内容 |', '| --- | --- |',
  '| 文档版本 | v1.0 |',
  '| 日期 | 2026-10-31 |',
  '| 不变 | 一样 |',
  '| 读者 | 旧读者 |', '',
].join('\n')
const TABLE_NEW = [
  '# 表格', '',
  '| 项目 | 内容 |', '| --- | --- |',
  '| 文档版本 | v4.0（新增「设置 → 任务闸机」实验性开关：全量劫持 todo 列表，宿主持久化；劫持引擎待实现） |',
  '| 日期 | 2026-11-03 |',
  '| 不变 | 一样 |',
  '| 参考实现 | `dsh-diff-approval`（工程结构 / connection RPC / wake-up 卡片投递）、`dsh-shortcut`（LLM 标题生成） |', '',
].join('\n')

// A long document, so the preview body really overflows and its vertical bar can be measured in the browser.
const LONG_PARAGRAPHS = Array.from(
  { length: 120 },
  (_unused, index) => `第 ${index + 1} 段：这一段不变，只用来让预览出现垂直滚动。`,
).join('\n\n')
const LONG_OLD = `# 长文\n\n${LONG_PARAGRAPHS}\n\n最后一段：旧。\n`
const LONG_NEW = `# 长文\n\n${LONG_PARAGRAPHS}\n\n最后一段：新。\n`

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let mainId: string
let revertId: string
let addId: string
let delId: string
let imageId: string
let tableId: string
let longId: string

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
      { name: 'flow-image.md', oldText: IMAGE_OLD, newText: IMAGE_NEW },
      { name: 'flow-table.md', oldText: TABLE_OLD, newText: TABLE_NEW },
      { name: 'flow-long.md', oldText: LONG_OLD, newText: LONG_NEW },
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
    imageId = seeded.entries[4]!.id
    tableId = seeded.entries[5]!.id
    longId = seeded.entries[6]!.id
    // The image itself is a workspace file, not a pending one: the preview's image read only needs it on
    // disk at the path the Markdown names (the seeded file's own folder).
    writeFileSync(join(fixture.workspace, 'shot.svg'), SHOT_SVG)
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
    // The new document has a fence; the EMPTY old column must not show a card (whose banner would carry the
    // new side's language) for code it does not contain.
    const emptyOldCell = page.locator('.mdFlowDoubleCell-old').first()
    await expect(emptyOldCell.locator('.mdFlowCodeBlock, .mdFlowCodeBanner')).toHaveCount(0)

    await openPreview(delId)
    await ensureDouble()
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveCount(1)
    await expect(page.locator('.mdFlowDoubleRow-diff')).toHaveAttribute('data-md-kind', 'del')
    await expect(page.locator('.mdFlowDoubleCell-new.mdFlowDoubleCell-empty')).toHaveCount(1)
  })

  test('single column: a picture change flashes on the block only after the image is in', async () => {
    test.setTimeout(300_000)
    // The previous case left the double column up; the reader lands this file in the single column, so pin
    // that FIRST — the flash is measured in the layout it lands in, and switching layouts after it would be
    // testing a different drift.
    await ensureSingle()
    await openPreview(imageId)
    const previewBody = body()
    // The picture is inlined (the data URI is what gives it a box at all)…
    await expect(previewBody.locator('img[src^="data:image/"]')).toBeVisible({ timeout: 20_000 })
    // …and the flash it raised outlines the SETTLED block. A box measured before the inline pass would be
    // the collapsed block's, and its bottom would sit above the picture now filling the block.
    const flash = page.locator('[data-diff-block-flash]').first()
    await expect(flash).toHaveCount(1, { timeout: 20_000 })
    await page.waitForTimeout(400)
    const boxes = await page.evaluate(() => {
      const flashElement = document.querySelector<HTMLElement>('[data-diff-block-flash]')
      const blocks = [...document.querySelectorAll<HTMLElement>('[data-md-block="0"]')]
      if (flashElement === null || blocks.length === 0) return null
      const flashBox = flashElement.getBoundingClientRect()
      return {
        flashTop: flashBox.top,
        flashBottom: flashBox.bottom,
        blockTop: Math.min(...blocks.map(block => block.getBoundingClientRect().top)),
        blockBottom: Math.max(...blocks.map(block => block.getBoundingClientRect().bottom)),
      }
    })
    expect(boxes).not.toBeNull()
    expect(Math.abs(boxes!.flashTop - boxes!.blockTop)).toBeLessThan(2)
    expect(Math.abs(boxes!.flashBottom - boxes!.blockBottom)).toBeLessThan(2)
    // The ruler is measured only once the picture has a box: each mark's band matches its block's rendered
    // position. A measurement taken while the image was still loading would have put the marks below it too
    // high (a collapsed document), which is the inaccurate first ruler this case guards.
    await expect(page.locator('[data-diff-approval-ruler]')).toHaveCount(1, { timeout: 20_000 })
    const bands = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-diff-md-preview-body]')
      const ruler = document.querySelector<HTMLElement>('[data-diff-approval-ruler]')
      if (body === null || ruler === null) return null
      const markers = [...ruler.querySelectorAll<HTMLElement>('[data-diff-ruler-marker]')]
      const blocks = [...body.querySelectorAll<HTMLElement>(
        '.mdBlock.mdAdd, .mdBlock.mdDel, .mdFlowGroup-old, .mdFlowGroup-new',
      )]
      const bodyRect = body.getBoundingClientRect()
      return {
        markerTops: markers.map(marker => Number.parseFloat(marker.style.top)),
        markerKinds: markers.map(marker => marker.dataset.diffRulerMarker),
        blockTops: blocks.map(block =>
          ((block.getBoundingClientRect().top - bodyRect.top + body.scrollTop) / body.scrollHeight) * 100),
      }
    })
    expect(bands).not.toBeNull()
    expect(bands!.markerTops.length).toBeGreaterThan(0)
    expect(bands!.markerTops).toHaveLength(bands!.blockTops.length)
    // The structured block's two versions are their own bands: a deletion (old paragraph) and an addition
    // (the picture), so the ruler carries both colours rather than one wrapper's kind.
    expect(bands!.markerKinds).toContain('del')
    expect(bands!.markerKinds).toContain('add')
    for (let index = 0; index < bands!.markerTops.length; index++) {
      expect(Math.abs(bands!.markerTops[index]! - bands!.blockTops[index]!)).toBeLessThan(1)
    }
  })

  test('double column: matched table rows share a line, even when one cell wraps or a row is one-sided', async () => {
    test.setTimeout(300_000)
    await openPreview(tableId)
    await ensureDouble()
    await expect(page.locator('.mdFlowDoubleRow-table')).toHaveCount(1, { timeout: 20_000 })
    // Let the row-leveling pass settle (it re-runs on the ResizeObserver once the level heights land).
    await page.waitForTimeout(700)
    const slots = await page.evaluate(() => {
      const tables = [...document.querySelectorAll<HTMLElement>('.mdFlowDoubleRow-table table')]
      if (tables.length !== 2) return null
      const rowsOf = (table: HTMLElement): Map<string, DOMRect> => new Map(
        [...table.querySelectorAll<HTMLElement>('tr[data-md-table-slot]')]
          .map(row => [row.dataset.mdTableSlot ?? '', row.getBoundingClientRect()] as const),
      )
      const oldRows = rowsOf(tables[0]!)
      const newRows = rowsOf(tables[1]!)
      return [...oldRows.keys()].filter(slot => newRows.has(slot)).map(slot => ({
        slot,
        oldTop: oldRows.get(slot)!.top,
        newTop: newRows.get(slot)!.top,
        oldHeight: oldRows.get(slot)!.height,
        newHeight: newRows.get(slot)!.height,
      }))
    })
    expect(slots).not.toBeNull()
    expect(slots!.length).toBeGreaterThan(3)
    for (const slot of slots!) {
      expect(Math.abs(slot.oldTop - slot.newTop), `row slot ${slot.slot} top`).toBeLessThan(2)
      expect(Math.abs(slot.oldHeight - slot.newHeight), `row slot ${slot.slot} height`).toBeLessThan(2)
    }
  })

  test('the preview scrollbar is twice the app bar, and its change marks are louder', async () => {
    test.setTimeout(300_000)
    // The previous case left the double column up; this one measures a single scrolling column.
    await ensureSingle()
    await openPreview(longId)
    const measured = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-diff-md-preview-body]')
      if (body === null) return null
      const appToken = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--dsh-scrollbar-width'))
      const ruler = document.querySelector<HTMLElement>('[data-diff-approval-ruler]')
      // Headless Chromium draws OVERLAY scrollbars here, so the bar takes no layout width (offset − client is
      // 0); the computed `::-webkit-scrollbar` pseudo-element is what the browser will actually paint, and it
      // is the honest number to compare. `height` is the horizontal bar's thickness and stays the app's.
      const scrollbar = getComputedStyle(body, '::-webkit-scrollbar')
      const thumb = getComputedStyle(body, '::-webkit-scrollbar-thumb')
      return {
        appToken,
        scrolls: body.scrollHeight > body.clientHeight,
        opacity: ruler === null ? null : Number.parseFloat(getComputedStyle(ruler).opacity),
        markers: document.querySelectorAll('[data-diff-ruler-marker]').length,
        rulerWidth: ruler === null ? 0 : ruler.getBoundingClientRect().width,
        verticalBar: scrollbar.width,
        horizontalBar: scrollbar.height,
        thumbRadius: thumb.borderRadius,
      }
    })
    expect(measured).not.toBeNull()
    expect(measured!.scrolls).toBe(true)
    expect(measured!.appToken).toBeGreaterThan(0)
    // The vertical bar is exactly twice the app's, while the horizontal thickness stays the app's.
    expect(measured!.verticalBar).toBe(`${measured!.appToken * 2}px`)
    expect(measured!.horizontalBar).toBe(`${measured!.appToken}px`)
    // The CORNER is the app's old radius on its narrow bar (2.5px), not half of the new one (5px).
    expect(measured!.thumbRadius).toBe(`${measured!.appToken / 2}px`)
    // The diff marks are drawn and readable: in the single column the ruler is ONE 2px strip.
    expect(measured!.markers).toBeGreaterThan(0)
    expect(measured!.opacity).toBeCloseTo(0.6, 2)
    expect(measured!.rulerWidth).toBe(2)
  })

  test('double column: the ruler is two centred adjacent 2px strips, one per column', async () => {
    test.setTimeout(300_000)
    // Open the long file explicitly (this case must also run on its own), then switch it to the double column.
    await openPreview(longId)
    await ensureDouble()
    await expect(page.locator('[data-diff-approval-ruler][data-diff-ruler-layout="two"]')).toHaveCount(1, { timeout: 20_000 })
    await page.waitForTimeout(500)
    const geometry = await page.evaluate(() => {
      const ruler = document.querySelector<HTMLElement>('[data-diff-approval-ruler]')
      if (ruler === null) return null
      const markers = [...ruler.querySelectorAll<HTMLElement>('[data-diff-ruler-marker]')]
      const boxesOf = (side: 'left' | 'right'): DOMRect[] => markers
        .filter(marker => marker.dataset.diffRulerSide === side)
        .map(marker => marker.getBoundingClientRect())
      const del = boxesOf('left')
      const add = boxesOf('right')
      const group = ruler.getBoundingClientRect()
      const body = document.querySelector<HTMLElement>('[data-diff-md-preview-body]')
      const panel = body?.closest('section')
      return {
        layout: ruler.dataset.diffRulerLayout,
        groupWidth: group.width,
        groupRight: group.right,
        bodyRight: body?.getBoundingClientRect().right ?? 0,
        rulerBar: panel === null || panel === undefined
          ? 0
          : Number.parseFloat(getComputedStyle(panel).getPropertyValue('--dsh-ruler-bar')),
        delCount: del.length,
        addCount: add.length,
        delWidth: del[0]?.width ?? 0,
        addWidth: add[0]?.width ?? 0,
        gap: del[0] === undefined || add[0] === undefined ? 0 : add[0].left - del[0].right,
        delTop: del[0]?.top ?? 0,
        delBottom: del[0]?.bottom ?? 0,
        addTop: add[0]?.top ?? 0,
        addBottom: add[0]?.bottom ?? 0,
      }
    })
    expect(geometry).not.toBeNull()
    expect(geometry!.layout).toBe('two')
    // Two adjacent 2px strips (NO gap); the 4px group is centred on the measured bar, so it keeps equal air
    // on both sides of the pair.
    expect(geometry!.groupWidth).toBe(4)
    expect(geometry!.delCount).toBeGreaterThan(0)
    expect(geometry!.addCount).toBeGreaterThan(0)
    expect(geometry!.delWidth).toBe(2)
    expect(geometry!.addWidth).toBe(2)
    expect(geometry!.gap).toBe(0)
    const margin = (geometry!.bodyRight - geometry!.groupRight)
    const expectedMargin = (geometry!.rulerBar - geometry!.groupWidth) / 2
    expect(Math.abs(margin - expectedMargin)).toBeLessThan(1)
    // The paired markers sit in the same band: the left strip's deletion and the right strip's addition align.
    expect(Math.abs(geometry!.delTop - geometry!.addTop)).toBeLessThan(2)
    expect(Math.abs(geometry!.delBottom - geometry!.addBottom)).toBeLessThan(2)
  })

  test('side-by-side code view: its ruler is the same two 2px strips, aligned', async () => {
    test.setTimeout(300_000)
    // Closing the rendered preview leaves the source diff, whose view toggle is still on side-by-side.
    await page.locator('[data-diff-md-preview]').click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-split-row]').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-diff-approval-ruler][data-diff-ruler-layout="two"]')).toHaveCount(1, { timeout: 20_000 })
    await page.waitForTimeout(400)
    const geometry = await page.evaluate(() => {
      const ruler = document.querySelector<HTMLElement>('[data-diff-approval-ruler]')
      if (ruler === null) return null
      const markers = [...ruler.querySelectorAll<HTMLElement>('[data-diff-ruler-marker]')]
      const boxesOf = (side: 'left' | 'right'): DOMRect[] => markers
        .filter(marker => marker.dataset.diffRulerSide === side)
        .map(marker => marker.getBoundingClientRect())
      const del = boxesOf('left')
      const add = boxesOf('right')
      return {
        groupWidth: ruler.getBoundingClientRect().width,
        delCount: del.length,
        addCount: add.length,
        delWidth: del[0]?.width ?? 0,
        addWidth: add[0]?.width ?? 0,
        gap: del[0] === undefined || add[0] === undefined ? 0 : add[0].left - del[0].right,
        delTop: del[0]?.top ?? 0,
        addTop: add[0]?.top ?? 0,
        delBottom: del[0]?.bottom ?? 0,
        addBottom: add[0]?.bottom ?? 0,
      }
    })
    expect(geometry).not.toBeNull()
    expect(geometry!.groupWidth).toBe(4)
    expect(geometry!.delCount).toBeGreaterThan(0)
    expect(geometry!.addCount).toBeGreaterThan(0)
    expect(geometry!.delWidth).toBe(2)
    expect(geometry!.addWidth).toBe(2)
    expect(geometry!.gap).toBe(0)
    expect(Math.abs(geometry!.delTop - geometry!.addTop)).toBeLessThan(2)
    expect(Math.abs(geometry!.delBottom - geometry!.addBottom)).toBeLessThan(2)
  })
})
