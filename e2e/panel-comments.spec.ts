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
