// Import version-control changes: the button that fills an EMPTY pending list from the workspace's own
// checkout. It only exists in that empty state (see the panel's `files.length === 0` branch), so this
// spec is also the only cover that state has.
//
// The workspace is a real git repository with one committed file that is then modified, so "detected"
// and "imported" are both expected to be true and the assertion is about files appearing — not about the
// absence of an error message, which would pass on a button that did nothing.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { beginSession, dismissNotices, footerBadge, newGuiPage, row } from './helpers/gui.ts'
import { bootstrapHome, makeFixture, resolveDsh, startHost, stopHost } from './helpers/host.ts'
import type { Fixture } from './helpers/host.ts'

const SEED_MESSAGE = 'e2e import seed'

/** The file the fixture commits and then changes, so the import has exactly one change to find. */
const TRACKED = 'tracked.txt'

/** Run git in the fixture workspace, with an identity, so no global config is needed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test.describe('导入版本控制：空的待审列表里，按钮把工作区的改动拉进来', () => {
  let fixture: Fixture
  let host: Awaited<ReturnType<typeof startHost>>
  let browser: Browser
  let page: Page

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('import')
    // A real checkout: one committed file, then a change to it. `git init` instead of a clone keeps the
    // fixture offline, and the change is what the import is supposed to find.
    git(fixture.workspace, 'init')
    writeFileSync(join(fixture.workspace, TRACKED), 'one\n')
    git(fixture.workspace, 'add', TRACKED)
    git(fixture.workspace, 'commit', '-m', 'fixture')
    writeFileSync(join(fixture.workspace, TRACKED), 'one\ntwo\n')

    await bootstrapHome(dsh, fixture)
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    // A session with a message in it: a blank one disables the panel's own entry.
    await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, SEED_MESSAGE)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('i1. 面板空态 → 点「导入版本控制的改动」→ 列表里出现那个改动', async () => {
    test.setTimeout(120_000)
    await footerBadge(page).click({ timeout: 20_000 })
    // The empty state, which is where this button lives. Waiting for the button IS the assertion that
    // the list is empty: with a file in it the panel draws rows instead.
    const importButton = page.locator('[data-diff-import-vcs]').first()
    await expect(importButton).toBeVisible({ timeout: 30_000 })
    await importButton.click({ timeout: 20_000 })

    // What the button says afterwards, whatever it is: the note is the panel's own report of the import
    // (`importNone` / `importNoVcs` / `importFailed`), and it is what the reader
    // sees, so a failure has to be printed rather than turned into a timeout with no explanation.
    let note = ''
    await expect
      .poll(async () => {
        note = (await page.locator('[data-diff-approval-panel] p').allInnerTexts()).join(' | ')
        return page.locator('[data-diff-file]').count()
      }, { timeout: 30_000, message: 'the import never produced a row' })
      .toBeGreaterThan(0)
      .catch(async (error: unknown) => {
        throw new Error(`${String(error)}\nimport note was: ${note}`)
      })

    // The change the fixture made, named in the row the reviewer reads. (`row()` takes an entry ID, so
    // the name is asserted on the row's own text — the import is what put it there.)
    await expect(page.locator('[data-diff-file]').first()).toContainText('tracked.txt', { timeout: 20_000 })
  })

  test('i2. 单文件刷新：磁盘上又改了，点刷新后面板显示新内容', async () => {
    test.setTimeout(120_000)
    // The reader keeps working while the panel is open, so the file moves on — and per-file Refresh from
    // VCS is how the panel is told. That is a different button from the import (which fills an empty list).
    writeFileSync(join(fixture.workspace, TRACKED), 'one\ntwo\nthree\n')
    await page.locator('[data-diff-file]').first().click({ timeout: 20_000 })

    const refresh = page.locator('[data-diff-refresh-vcs]').first()
    await expect(refresh).toBeVisible({ timeout: 20_000 })
    await refresh.click({ timeout: 20_000 })

    // The new line has to be in the diff the panel draws: the row's own counts could be stale and still
    // read plausibly, so the assertion is about the content behind them.
    await expect(page.locator('[data-diff-body]').first()).toContainText('three', { timeout: 30_000 })
  })
})
