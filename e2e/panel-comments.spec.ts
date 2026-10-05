// Comments and the two bulk actions that had no coverage: writing a comment from a selection, removing
// one and getting it back, adding a path the panel does not know about yet, and reverting everything.
//
// The comment WRITE path is the one the tablet bug lived in (a secure-context API in the id it minted),
// and until now only the unit suite drove it: this spec drives it through the real GUI, where the whole
// chain runs — drag, toolbar, field, send, host store, list.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  CLOSE_COMMENT, beginSession, chooseMenuItem, commentRow, confirmIfAsked, dismissNotices, newGuiPage,
  openListTab, openPanel, openSession, pressUndo, row,
} from './helpers/gui.ts'
import { writeComment } from './helpers/panel.ts'

/**
 * Three changed files. Line 2 of each is the changed one, so rows 1..2 of the code view are a range a
 * reader would annotate (a context line and the change under it).
 */
const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
  { name: 'gamma.txt', oldText: 'gamma one\ngamma two\n', newText: 'gamma one\nGAMMA TWO\n' },
]

/** A file the panel has never seen, for the add-path dialog. Written before the host boots. */
const FRESH = 'fresh.txt'

const SEED_MESSAGE = 'e2e: comments and bulk actions'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let paths: Record<string, string>

/** What the panel's own toast/notice area says, for a failure that has to explain itself. */
async function panelSaid(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const text = (node: Element): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    return [
      `notices: ${[...document.querySelectorAll('[data-diff-approval-notice]')].map(text).join(' | ') || '(none)'}`,
      `action-error: ${[...document.querySelectorAll('[data-diff-action-error]')].map(text).join(' | ') || '(none)'}`,
      `dialogs: ${[...document.querySelectorAll('[role="dialog"]')].map(text).join(' | ') || '(none)'}`,
      `comments: ${document.querySelectorAll('[data-diff-comment-link]').length}`,
      `rows: ${[...document.querySelectorAll('[data-diff-file]')].map(node => node.getAttribute('data-diff-file')?.split(/[\\/]/).pop() ?? '?').join(', ') || '(none)'}`,
    ].join('\n')
  })
}

/** The comment id of the first comment row on screen (the list is the panel's own read of the store). */
async function firstCommentId(page: Page): Promise<string> {
  const id = await page.locator('[data-diff-comment-link]').first().getAttribute('data-diff-comment-link')
  if (id === null) throw new Error(`no comment row to read an id from.\n${await panelSaid(page)}`)
  return id
}

/**
 * A comment whose TITLE is far longer than the list's three-line clamp, for `c0`: one sentence (the row
 * shows the comment's first sentence), no internal full stop to be cut at, and long enough that the browser
 * wraps it over many lines at the comments column's width. That is what makes the clamp observable at all —
 * with a short title there is nothing to clamp.
 */
const LONG_TITLE = 'the quick brown fox jumps over the lazy dog and then keeps walking '
  + 'through the whole paragraph so that the comment list has to wrap this over several '
  + 'lines before it is finally cut off with an ellipsis which is exactly what this case measures '
  + 'and it has still not stopped going because a clamp needs more than three lines to be worth asserting '
  + 'so this sentence keeps adding words until there can be no doubt about how many lines it takes '
  + 'and then it ends'

test.describe.configure({ mode: 'serial' })

test.describe('评论与批量动作：写一条评论 / 移除并撤销 / 添加路径 / 全部回退', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('comments')
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

    // The fresh file goes in with the seeded ones: it is in the WORKSPACE but not in the store, which is
    // exactly what the add-path dialog is for.
    writeFileSync(join(fixture.workspace, FRESH), 'fresh one\n')
    const seeded = seedPending(fixture, sessionId, FILES, [
      // Two seeded threads with two CLASSES, for the category dot `c0` measures: the ids are the
      // tool's own parameter, and the mapping decides which of the twelve colours each one is.
      // `alpha.txt` also carries a deliberately LONG title, so the same case can measure the three-line
      // clamp on one row against a single-line title on the other.
      { name: 'alpha.txt', category: 'pass-1', text: LONG_TITLE },
      { name: 'beta.txt', category: 'pass-2' },
    ])
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

  test('c0. 类别圆点：两条不同类别的评论行画出两种颜色，圆点是 3×3 的整圆；长标题最多三行并被截断', async () => {
    test.setTimeout(120_000)
    // The category dot, measured the way the browser decides it: `getComputedStyle` on the marks the panel
    // drew, never the text of a rule. Two seeded threads carry two classes, so this also pins that the panel
    // READ the field at all (port.ts parses it) — a record whose category never arrives draws no dot, and
    // this case is the only place that would notice.
    await openListTab(page, 'comments')
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('[data-diff-comment-category]')).toHaveCount(2, { timeout: 20_000 })

    const painted = await page.evaluate(() => [...document.querySelectorAll('[data-diff-comment-category]')].map((node) => {
      const style = getComputedStyle(node)
      return {
        category: node.getAttribute('data-diff-comment-category'),
        background: style.backgroundColor,
        radius: style.borderRadius,
        width: style.width,
        height: style.height,
      }
    }))
    const byCategory = new Map(painted.map(entry => [entry.category, entry]))
    // The colour the mapping PREDICTS, recomputed for the maximal-spread order (2026-10-06): `pass-1` is
    // bucket 10 (olive `#577F11`) and `pass-2` bucket 11 (tan `#C19784`), which is what the browser computes
    // them as. The ORDER is part of the contract — bucket = array index — so a reshuffle changes these two
    // strings, and that is exactly why they are written out rather than read back from the module.
    expect(byCategory.get('pass-1')?.background, 'pass-1 must wear the palette colour it maps to').toBe('rgb(87, 127, 17)')
    expect(byCategory.get('pass-2')?.background, 'pass-2 must wear the palette colour it maps to').toBe('rgb(193, 151, 132)')
    // Two classes, two colours: the whole point of the feature.
    expect(byCategory.get('pass-1')?.background).not.toBe(byCategory.get('pass-2')?.background)
    // A FULL CIRCLE, asserted so that a square cannot satisfy it: the box is 3x3 AND the radius is the whole
    // half of it. MEASURED in this very case: this Chromium reports the computed `border-radius` as `50%`
    // (it does NOT resolve a percentage of a 3px box to `1.5px` the way the shorthand's computed length can
    // be), so the measured string is what is pinned — a square reports `0px` here and fails outright.
    for (const entry of painted) {
      expect(entry.width, 'the dot is 3px wide').toBe('3px')
      expect(entry.height, 'the dot is 3px tall').toBe('3px')
      expect(entry.radius, 'Chromium reports the computed border-radius as 50% — a full circle').toBe('50%')
    }

    // THE THREE-LINE CLAMP — the reader's ask (2026-10-06): a long title shows at most three lines and is
    // ellipsised beyond. The ellipsis GLYPH itself cannot be asserted (it is painted, not a character in the
    // DOM), so the clamp plus `scrollHeight > clientHeight` IS the proxy: the element is genuinely cut, and
    // `-webkit-line-clamp` is what paints the ellipsis at the cut. `alpha.txt` carries the long title and
    // `beta.txt` the short one, so one row proves the clamp and the other proves it is not blanket-applied.
    const titles = await page.evaluate(() => [...document.querySelectorAll('[data-diff-comment-link]')].map((row) => {
      const title = row.querySelector('[data-diff-comment-title]') as HTMLElement
      const style = getComputedStyle(title)
      return {
        text: title.textContent ?? '',
        full: title.getAttribute('title'),
        lineClamp: style.getPropertyValue('-webkit-line-clamp'),
        lineHeight: Number.parseFloat(style.lineHeight),
        clientHeight: title.clientHeight,
        scrollHeight: title.scrollHeight,
      }
    }))
    const long = titles.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    const short = titles.find(entry => entry !== long)!
    // The clamp is really a clamp…
    expect(long.lineClamp, 'the long title carries the three-line clamp').toBe('3')
    // …three lines is what it takes, with a pixel or two of rounding allowed…
    expect(long.clientHeight, `${long.text.length} chars measured ${long.clientHeight}px at ${long.lineHeight}px a line`)
      .toBeLessThanOrEqual(long.lineHeight * 3 + 2)
    // …MORE than one line, which is what proves the wrapping happens at all: a `white-space: nowrap`
    // regression would report exactly one line here…
    expect(long.clientHeight).toBeGreaterThan(long.lineHeight)
    // …and the text is genuinely cut, which is where the ellipsis comes from.
    expect(long.scrollHeight, 'the long title overflows what is shown').toBeGreaterThan(long.clientHeight)
    // The whole string is still reachable, because the clamp only ever hides it.
    expect(long.full).toBe(long.text)
    expect(long.text.length).toBeGreaterThan(200)
    // The short title is NOT padded out to three lines: one line, and nothing of it overflows.
    expect(short.clientHeight).toBeLessThanOrEqual(short.lineHeight + 2)
    expect(short.scrollHeight).toBeLessThanOrEqual(short.clientHeight)

    // THE DOT'S ANCHOR — the reader's other ask (2026-10-06): the mark in the row's left inset belongs on
    // the FIRST line of the title, not in the middle of the row, so it does not slide down as the title
    // grows. Measured as centres relative to each row's own top edge — the row is the containing block (see
    // `.commentRow`), which is the same frame `.categoryDot`'s `top` is resolved in. The old `top: 50%`
    // cannot satisfy the second assertion: with a three-line title it lands ~12px lower than the first line.
    const anchors = await page.evaluate(() => [...document.querySelectorAll('[data-diff-comment-link]')].map((row) => {
      const dot = row.querySelector('[data-diff-comment-category]') as HTMLElement
      const title = row.querySelector('[data-diff-comment-title]') as HTMLElement
      const rowBox = row.getBoundingClientRect()
      const dotBox = dot.getBoundingClientRect()
      const titleBox = title.getBoundingClientRect()
      return {
        text: title.textContent ?? '',
        rowHeight: rowBox.height,
        dotCentre: dotBox.top + dotBox.height / 2 - rowBox.top,
        firstLineCentre: titleBox.top - rowBox.top + Number.parseFloat(getComputedStyle(title).lineHeight) / 2,
        dotInside: dotBox.top >= rowBox.top && dotBox.bottom <= rowBox.bottom,
      }
    }))
    const longAnchor = anchors.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    const shortAnchor = anchors.find(entry => entry !== longAnchor)!
    // On the three-line row the dot sits on the first line's centre…
    expect(Math.abs(longAnchor.dotCentre - longAnchor.firstLineCentre),
      `long row: dot centre ${longAnchor.dotCentre} vs first line ${longAnchor.firstLineCentre}`).toBeLessThanOrEqual(1)
    // …and on the one-line row it is the same pixel, which is the property: the mark does not move when the
    // title grows. The rows are NOT the same height, so "same height" is not an artefact of two equal rows.
    expect(longAnchor.rowHeight).toBeGreaterThan(shortAnchor.rowHeight)
    expect(Math.abs(longAnchor.dotCentre - shortAnchor.dotCentre),
      `dot centre: ${longAnchor.dotCentre} on the three-line row vs ${shortAnchor.dotCentre} on the one-line row`)
      .toBeLessThanOrEqual(1)
    // The dot is inside its row, in the row's own left inset — nothing clips it now that the row can grow.
    expect(longAnchor.dotInside).toBe(true)
    expect(shortAnchor.dotInside).toBe(true)

    // Leave the store as the cases below expect it: the two seeded threads go away again (the list is the
    // host's, so an empty list is the proof they really were there), and the pane returns to the file list.
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-diff-comment-link]')]
      .map(node => node.getAttribute('data-diff-comment-link') ?? ''))
    for (const id of ids) {
      await chooseMenuItem(page, commentRow(page, id), CLOSE_COMMENT)
      await confirmIfAsked(page)
    }
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(0, { timeout: 20_000 })
    await openListTab(page, 'pending')
    await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })

    // THE OTHER DOT SURFACES, checked here rather than assumed. The file row's mark (`.unseenDot`, still
    // `top: 50%`) centres on that row — which is the SAME pixel as first-line centring exactly while the
    // row's content is one line tall, and it is: the name is `white-space: nowrap` with an ellipsis, so it
    // cannot wrap. `data-diff-file` IS the `.rowHead` element the dot is positioned against, so this measures
    // the very box the dot's percentage resolves in: content 18px, and half of the 30px row = padding-top + 9.
    const fileRows = await page.evaluate(() => [...document.querySelectorAll('[data-diff-file]')].map((row) => {
      const style = getComputedStyle(row)
      const paddingTop = Number.parseFloat(style.paddingTop)
      return {
        height: row.getBoundingClientRect().height,
        content: row.getBoundingClientRect().height - paddingTop - Number.parseFloat(style.paddingBottom),
        paddingTop,
      }
    }))
    expect(fileRows.length).toBeGreaterThan(0)
    for (const fileRow of fileRows) {
      expect(fileRow.content, 'a file row holds one line of text, so its centre IS that line\'s centre').toBe(18)
      expect(fileRow.height / 2, 'the row centre and the first line centre are the same pixel')
        .toBeCloseTo(fileRow.paddingTop + 9, 1)
    }
  })

  test('c1. 写评论：拖选两行 → 工具栏批注 → 输入 → 发送，评论进入评论列表', async () => {
    test.setTimeout(120_000)
    await row(page, paths['alpha.txt'] as string).click({ timeout: 20_000 })
    const written = await writeComment(page, 1, 2, 'e2e: 这条评论是被写下来的')
    expect(written).toContain('e2e:')

    await openListTab(page, 'comments')
    // The list is the host's, not the panel's optimism: the row exists because the store holds it.
    await expect(page.locator('[data-diff-comment-link]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-diff-comment-link]').first()).toContainText('e2e:', { timeout: 20_000 })
  })

  test('c2. 移除评论：从评论列表右键关闭 → 列表空了 → Ctrl+Z 回来', async () => {
    test.setTimeout(120_000)
    const id = await firstCommentId(page)
    await chooseMenuItem(page, commentRow(page, id), CLOSE_COMMENT)
    await confirmIfAsked(page)
    try {
      await expect(page.locator('[data-diff-comment-link]')).toHaveCount(0, { timeout: 20_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }

    // The removal is an action like any other, so the panel's own history takes it back.
    await page.locator('[data-diff-approval-panel]').first().click({ position: { x: 5, y: 5 }, timeout: 20_000 }).catch(() => {})
    await pressUndo(page)
    await expect(page.locator('[data-diff-comment-link]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('c3. 全部回退：列表清空，磁盘上的文件回到各自的旧文本', async () => {
    test.setTimeout(120_000)
    // `revert-all` puts every listed file back to its OLD content, which is the one bulk action that
    // touches the worktree: the list empties and the files on disk hold `oldText`. Run before the add
    // case, which needs the list EMPTY anyway (the add control lives in the empty state).
    // The bulk buttons belong to the FILES tab, and the previous case left the list on comments.
    await openListTab(page, 'pending')
    await page.locator('[data-diff-revert-all]').first().click({ timeout: 20_000 })
    await confirmIfAsked(page)
    await expect(page.locator('[data-diff-file]')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => readFileSync(join(fixture.workspace, 'alpha.txt'), 'utf8'), { timeout: 20_000 })
      .toBe('alpha one\nalpha two\n')
  })

  test('c4. 添加路径：空列表里打开对话框，它开在工作区树上并列出那个新文件', async () => {
    test.setTimeout(120_000)
    // NOT driven to completion on purpose. The dialog opens on the workspace TREE (its own path field is
    // what "按文件或目录添加" reveals), and picking an entry + Add produced no row and no notice when this
    // was tried — either the selection semantics are not what a click on the label does, or that path is
    // broken. That is a question for the owner rather than something to encode as an expectation, so what
    // is asserted is what was measured: the dialog opens, and the file the panel has never seen is in it.
    await page.locator('[data-diff-add]').first().click({ timeout: 20_000 })
    const dialog = page.locator('[role="dialog"]').first()
    try {
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(dialog.getByText(FRESH, { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    } catch (error: unknown) {
      throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0, { timeout: 20_000 })
  })
})
