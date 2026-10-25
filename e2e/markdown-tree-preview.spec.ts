// The TREE-FIRST diff is the shipped default: this spec runs the real browser with NOTHING stored and pins
// the tree path's end-to-end behavior — the context-run rows in the double column, the block toolbar's
// numbering from the tree model, and a Keep whose range the tree model produced.
//
// (The other preview specs in this folder exercised the legacy pipeline while it was being replaced; after the
// switch they run whichever pipeline ships, and this spec names the tree path explicitly so a regression that
// silently falls back to line hunks fails HERE.)

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

const OLD = [
  '---', 'title: 旧标题', '---', '',
  '# 标题', '',
  '第一段旧文字。', '',
  '## 未变小节', '',
  '相同段落一。', '',
  '相同段落二。', '',
  '- 旧列表项',
  '- 不变列表项', '',
  '| 场景 | 结果 |',
  '|---|---|',
  '| 旧 | 1 |', '',
  '这一段会被删除。', '',
].join('\n')

const NEW = [
  '---', 'title: 新标题', '---', '',
  '# 标题（新）', '',
  '第一段新文字。', '',
  '## 未变小节', '',
  '相同段落一。', '',
  '相同段落二。', '',
  '- 新列表项',
  '- 不变列表项', '',
  '| 场景 | 结果 |',
  '|---|---|',
  '| 新 | 1 |', '',
  '这一段是新加的。', '',
].join('\n')

const INLINE_OLD = [
  '一段**普通**说明，其中有 **加粗重点**、`行内代码`，以及一个 [文档链接](https://example.com/v1/guide)。',
  '',
].join('\n')

const INLINE_NEW = [
  '一段**新的**说明，其中有 **重点加粗**、`行内代码`，以及一个 [文档链接](https://example.com/v2/guide)。',
  '',
].join('\n')

const CELLS_OLD = [
  '| 模块 | 说明 | 链接 |',
  '| --- | --- | --- |',
  '| core | 旧说明 | [core](https://example.com/core/v1) |',
  '',
].join('\n')

const CELLS_NEW = [
  '| 模块 | 说明 | 链接 |',
  '| --- | --- | --- |',
  '| core | 新说明 | [core](https://example.com/core/v2) |',
  '',
].join('\n')

const IMAGE_OLD = [
  '![截图](./shot-old.png "旧标题")',
  '',
].join('\n')

const IMAGE_NEW = [
  '![新截图](./shot-new.png "新标题")',
  '',
].join('\n')

const REPLACE_OLD = [
  '<!-- 旧注释 -->',
  '',
  '待删除的一段：这段话在新版本里会被删掉。',
  '',
].join('\n')

const REPLACE_NEW = [
  '<!-- 新注释 -->',
  '',
  '新增的一段说明。',
  '',
].join('\n')

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let fileId: string
let inlineFileId: string
let cellsFileId: string
let imageFileId: string
let replaceFileId: string

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

test.describe.configure({ mode: 'serial' })

test.describe('tree-first preview is the shipped default', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN。')
      return
    }
    const files: SeededFile[] = [
      { name: 'tree-default.md', oldText: OLD, newText: NEW },
      { name: 'tree-inline.md', oldText: INLINE_OLD, newText: INLINE_NEW },
      { name: 'tree-cells.md', oldText: CELLS_OLD, newText: CELLS_NEW },
      { name: 'tree-image.md', oldText: IMAGE_OLD, newText: IMAGE_NEW },
      { name: 'tree-replace.md', oldText: REPLACE_OLD, newText: REPLACE_NEW },
    ]
    fixture = makeFixture('tree-default')
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, 'e2e: tree default')
    await page.close()
    await stopHost(host.proc)

    const seeded = seedPending(fixture, sessionId, files, [])
    fileId = seeded.entries[0]!.id
    inlineFileId = seeded.entries[1]!.id
    cellsFileId = seeded.entries[2]!.id
    imageFileId = seeded.entries[3]!.id
    replaceFileId = seeded.entries[4]!.id
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    // The preview per se is behind its temporary switch; the DIFF pipeline is NOT set here (no tree-diff key):
    // the default is what this spec is about.
    await page.evaluate(() => {
      localStorage.setItem('diff-approval:temp-preview-v2', '1')
      localStorage.setItem('diff-approval:md-preview', '1')
      localStorage.removeItem('diff-approval:tree-diff')
    })
    await openSession(page, 'e2e: tree default')
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
      await page.waitForTimeout(500)
    }
    await sleep(500)
  }

  test('the double column merges the unchanged siblings into ONE layout row', async () => {
    test.setTimeout(300_000)
    await openPreview()
    // The front-matter change is drawn at its document position with the eye icon (tree path behavior).
    const chips = await page.evaluate(() =>
      document.querySelectorAll('[data-diff-md-preview-body] .mdTwinPhantom .mdTwinCaption svg').length)
    expect(chips).toBeGreaterThanOrEqual(2)
    await page.locator('[data-diff-toggle-view]').first().click({ timeout: 20_000 })
    await page.waitForTimeout(900)
    const rows = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const runs = [...body.querySelectorAll<HTMLElement>('.mdTreeRun')]
      return {
        runs: runs.length,
        texts: runs.map(run => (run.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)),
        // The unchanged section's two paragraphs sit in the merged run, not in rows of their own.
        mergedHasBoth: runs.some(run => (run.textContent ?? '').includes('相同段落一。') && (run.textContent ?? '').includes('相同段落二。')),
      }
    })
    console.log('[tree default double]', JSON.stringify(rows))
    expect(rows.runs).toBeGreaterThanOrEqual(2)
    expect(rows.mergedHasBoth).toBe(true)
  })

  test('the block toolbar numbers tree blocks and a Keep applies the tree block range', async () => {
    test.setTimeout(300_000)
    await page.locator('[data-diff-toggle-view]').first().click({ timeout: 20_000 })
    await page.waitForTimeout(700)
    const beforeRow = (await row(page, fileId).textContent()) ?? ''
    const hovered = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const target = body.querySelector<HTMLElement>('[data-md-unit]')
      if (target === null) return null
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      return { unit: target.dataset.mdUnit ?? null, tag: target.tagName }
    })
    expect(hovered).not.toBeNull()
    await sleep(500)
    const position = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    console.log('[tree default toolbar]', JSON.stringify({ hovered, position }))
    // Locale-agnostic: the toolbar's position reads "第 N/M 块" or "N/M" depending on the UI language.
    expect(position).toMatch(/\d+\s*\/\s*\d+/u)
    await page.locator('[data-diff-block-keep]').first().click({ timeout: 20_000 })
    await sleep(1200)
    const afterRow = (await row(page, fileId).textContent()) ?? ''
    console.log('[tree default keep]', JSON.stringify({ beforeRow, afterRow }))
    expect(afterRow).not.toBe(beforeRow)
  })

  test('a table row change frames the changed CELLS, not the whole row', async () => {
    test.setTimeout(300_000)
    // Back to the tree-default file; its table row changes one cell (`| 旧 |` → `| 新 |`).
    await row(page, fileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    await sleep(500)
    const cell = page.locator('[data-diff-md-preview-body] tr [data-md-unit]').first()
    const box = await cell.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await sleep(600)
    const measured = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const rowElement = body.querySelector<HTMLElement>('tr')
      if (rowElement === null) return null
      return {
        rowWidth: Math.round(rowElement.getBoundingClientRect().width),
        rowCarriesBlock: rowElement.dataset.mdBlock !== undefined,
        // The dashed outlines are siblings of the scrolling body, not descendants of it.
        outlines: [...document.querySelectorAll<HTMLElement>('[data-diff-unit-outline]')]
          .map(element => Math.round(element.getBoundingClientRect().width)),
        position: document.querySelector('[data-diff-block-position]')?.textContent ?? '',
      }
    })
    console.log('[tree table row outline]', JSON.stringify(measured))
    expect(measured).not.toBeNull()
    expect(measured!.outlines.length).toBeGreaterThanOrEqual(1)
    // The outline hugs the tinted cell: it is narrower than the row it sits in.
    for (const width of measured!.outlines) expect(width).toBeLessThan(measured!.rowWidth * 0.75)
    // A changed cell is its OWN block: the row is not a block carrier around it.
    expect(measured!.rowCarriesBlock).toBe(false)
    expect(measured!.position).toMatch(/\d+\s*\/\s*\d+/u)
  })

  test('two changed cells of one row are two blocks, each hovered on its own cell', async () => {
    test.setTimeout(300_000)
    await row(page, cellsFileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    await sleep(500)
    const cellInfo = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const rowElement = body.querySelector<HTMLElement>('tbody tr')
      if (rowElement === null) return null
      const cells = [...rowElement.children].filter((cell): cell is HTMLElement => cell instanceof HTMLElement)
      return {
        rowCarriesBlock: rowElement.dataset.mdBlock !== undefined,
        blocksByCell: cells.map(cell => [...new Set([...cell.querySelectorAll<HTMLElement>('[data-md-block]')]
          .map(element => element.dataset.mdBlock))]),
      }
    })
    console.log('[tree cells split]', JSON.stringify(cellInfo))
    expect(cellInfo).not.toBeNull()
    expect(cellInfo!.rowCarriesBlock).toBe(false)
    // Column 0 unchanged, columns 1 and 2 changed: two different blocks, one per cell.
    expect(cellInfo!.blocksByCell[0]).toEqual([])
    expect(cellInfo!.blocksByCell[1]).toHaveLength(1)
    expect(cellInfo!.blocksByCell[2]).toHaveLength(1)
    expect(cellInfo!.blocksByCell[1]).not.toEqual(cellInfo!.blocksByCell[2])

    const firstBox = await page.locator('[data-diff-md-preview-body] tbody td:nth-child(2) [data-md-unit]').first().boundingBox()
    expect(firstBox).not.toBeNull()
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
    await sleep(500)
    const firstPosition = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    const secondBox = await page.locator('[data-diff-md-preview-body] tbody td:nth-child(3) [data-md-unit]').first().boundingBox()
    expect(secondBox).not.toBeNull()
    await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2)
    await sleep(500)
    const secondPosition = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    console.log('[tree cells hover]', JSON.stringify({ firstPosition, secondPosition }))
    expect(firstPosition).not.toBe(secondPosition)
    const outlineWidths = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-diff-unit-outline]')]
      .map(element => Math.round(element.getBoundingClientRect().width)))
    console.log('[tree cells outlines]', JSON.stringify(outlineWidths))
    expect(outlineWidths.length).toBeGreaterThanOrEqual(1)
  })

  test('one line splits into three blocks and the retargeted link is a red/green twin with its source', async () => {
    test.setTimeout(300_000)
    // The inline fixture's single line has three changes separated by unchanged words.
    await row(page, inlineFileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    await sleep(500)
    const measured = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll<HTMLElement>('[data-diff-md-preview-body] p')]
        .find(element => (element.textContent ?? '').includes('说明，其中有'))
      if (paragraph === undefined) return null
      const twin = paragraph.querySelector<HTMLElement>('.mdTwin')
      return {
        blocks: [...new Set([...paragraph.querySelectorAll<HTMLElement>('[data-md-block]')]
          .map(element => element.dataset.mdBlock))],
        links: twin === null ? [] : [...twin.querySelectorAll('a')].map(link => link.getAttribute('href')),
        sourceOld: twin?.getAttribute('data-md-diff-old') ?? null,
        sourceNew: twin?.getAttribute('data-md-diff-new') ?? null,
      }
    })
    console.log('[tree inline measured]', JSON.stringify(measured))
    expect(measured, 'the inline fixture must render its paragraph').not.toBeNull()
    // Three separate blocks for the word swap, the strong swap and the retargeted link.
    expect(measured!.blocks.length).toBeGreaterThanOrEqual(3)
    // Red old link + green new link, and the toolbar source of each.
    expect(measured!.links).toEqual(['https://example.com/v1/guide', 'https://example.com/v2/guide'])
    expect(measured!.sourceOld).toContain('example.com/v1/guide')
    expect(measured!.sourceNew).toContain('example.com/v2/guide')

    // Hovering the twin raises its own block with the code diff in the toolbar, not just a block number.
    const twinBox = await page.locator('[data-diff-md-preview-body] .mdTwin').first().boundingBox()
    expect(twinBox).not.toBeNull()
    await page.mouse.move(twinBox!.x + twinBox!.width / 2, twinBox!.y + twinBox!.height / 2)
    await sleep(500)
    const position = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    const source = await page.evaluate(() => {
      const sourceRow = document.querySelector('[data-diff-block-sourcediff]')
      return sourceRow === null ? '' : (sourceRow.textContent ?? '').replace(/\s+/g, ' ').trim()
    })
    console.log('[tree inline toolbar]', JSON.stringify({ position, source }))
    // Locale-agnostic block position ("第 N/M 块" or "N/M").
    expect(position).toMatch(/\d+\s*\/\s*\d+/u)
    expect(source).toContain('example.com/v1/guide')
    expect(source).toContain('example.com/v2/guide')
  })

  test('an image path/title change is drawn as two frames, left old and right new, with its source', async () => {
    test.setTimeout(300_000)
    // The image fixture changes the path, the alt text and the title at once.
    await row(page, imageFileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    await sleep(500)
    const measured = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const twin = body.querySelector<HTMLElement>('.mdTwin.mdTwinImages')
      if (twin === null) return null
      const frames = [...twin.querySelectorAll<HTMLElement>('.mdImageFrame')]
      return {
        block: twin.dataset.mdBlock,
        sourceOld: twin.dataset.mdDiffOld,
        sourceNew: twin.dataset.mdDiffNew,
        frames: frames.map(frame => ({
          side: frame.parentElement?.className,
          path: frame.querySelector('.mdImagePath')?.textContent,
          alt: frame.querySelector('.mdImageAlt')?.textContent,
          title: frame.querySelector('.mdImageTitle')?.textContent,
        })),
      }
    })
    console.log('[tree image twin]', JSON.stringify(measured))
    expect(measured).not.toBeNull()
    expect(measured!.frames.map(frame => frame.path)).toEqual(['./shot-old.png', './shot-new.png'])
    expect(measured!.frames[0]!.side).toContain('mdTwinOld')
    expect(measured!.frames[1]!.side).toContain('mdTwinNew')
    expect(measured!.frames[0]!.title).toBe('旧标题')
    expect(measured!.frames[1]!.title).toBe('新标题')
    expect(measured!.sourceOld).toContain('shot-old.png')
    expect(measured!.sourceNew).toContain('shot-new.png')

    const twinLocator = page.locator('[data-diff-md-preview-body] .mdTwin.mdTwinImages').first()
    await twinLocator.scrollIntoViewIfNeeded()
    const box = await twinLocator.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await sleep(600)
    const position = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    const source = await page.evaluate(() => {
      const sourceRow = document.querySelector('[data-diff-block-sourcediff]')
      return sourceRow === null ? '' : (sourceRow.textContent ?? '').replace(/\s+/g, ' ').trim()
    })
    console.log('[tree image toolbar]', JSON.stringify({ position, source }))
    expect(position).toMatch(/\d+\s*\/\s*\d+/u)
    expect(source).toContain('shot-old.png')
    expect(source).toContain('shot-new.png')
  })

  test('a rewritten sentence is one block: blank area raises nothing, the words raise 1/1', async () => {
    test.setTimeout(300_000)
    // The two sentences barely align, so the whole line is ONE replacement block — not one block per char run
    // (the reported "an extra 15/15 block whose phantom chips cover the same line").
    await row(page, replaceFileId).click({ timeout: 20_000 })
    await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(500)
    }
    await sleep(500)
    const paragraph = page.locator('[data-diff-md-preview-body] p').filter({ hasText: '新增的一段说明' }).first()
    const paragraphBox = await paragraph.boundingBox()
    expect(paragraphBox).not.toBeNull()
    // The blank end of the line (past the last glyph) is not a change.
    await page.mouse.move(paragraphBox!.x + paragraphBox!.width - 12, paragraphBox!.y + paragraphBox!.height / 2)
    await sleep(700)
    const blank = await page.evaluate(() => {
      const position = document.querySelector<HTMLElement>('[data-diff-block-position]')
      const frame = position?.closest('[data-diff-block-actions]') as HTMLElement | null
      return {
        hasPosition: position !== null,
        visible: frame !== null && frame !== undefined && frame.offsetParent !== null,
        outlines: document.querySelectorAll('[data-diff-unit-outline]').length,
      }
    })
    console.log('[tree replace blank]', JSON.stringify(blank))
    expect(blank.visible).toBe(false)
    expect(blank.outlines).toBe(0)

    const words = page.locator('[data-diff-md-preview-body] .mdWordAdd').filter({ hasText: '新增的一段说明' }).first()
    const wordBox = await words.boundingBox()
    expect(wordBox).not.toBeNull()
    await page.mouse.move(wordBox!.x + wordBox!.width / 2, wordBox!.y + wordBox!.height / 2)
    await sleep(700)
    const position = (await page.locator('[data-diff-block-position]').first().textContent({ timeout: 20_000 })) ?? ''
    console.log('[tree replace hover]', JSON.stringify({ position }))
    expect(position).toMatch(/\d+\s*\/\s*\d+/u)
    // ONE block: the current number is the last one (the duplicate block is gone).
    const numbers = position.match(/\d+/g) ?? []
    expect(numbers[0]).toBe(numbers[1])
    // And the outline belongs to THIS paragraph only: the invisible change's marker chips above it (a
    // different block whose UNIT number happens to equal one of this block's run units) must not be framed.
    const outlines = await page.evaluate(() => {
      const body = document.querySelector('[data-diff-md-preview-body]') as HTMLElement
      const paragraph = body.querySelector('p')
      if (paragraph === null) return null
      const paragraphRect = paragraph.getBoundingClientRect()
      return [...document.querySelectorAll<HTMLElement>('[data-diff-unit-outline]')].map(element => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, paragraphTop: paragraphRect.top, paragraphBottom: paragraphRect.bottom }
      })
    })
    console.log('[tree replace outlines]', JSON.stringify(outlines))
    expect(outlines).not.toBeNull()
    expect(outlines!.length).toBeGreaterThanOrEqual(1)
    for (const outline of outlines!) {
      expect(outline.top).toBeGreaterThanOrEqual(outline.paragraphTop - 4)
      expect(outline.bottom).toBeLessThanOrEqual(outline.paragraphBottom + 4)
    }
  })
})
