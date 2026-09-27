/**
 * Real-browser E2E: the pending panel's keep-and-remove batch, its undo and its redo.
 *
 * Everything runs in the actual DSH Web GUI inside Chromium, against a throwaway
 * `DSH_HOME` this file creates and deletes. The two-phase setup is not a shortcut, it
 * is the only order that works: the plugin host reads its pending store once and caches
 * it, so the fixture has to exist before the process that reads it starts — and the
 * entries have to name the session the GUI actually created, so that session is made
 * first (phase one), the host is stopped, the store is written, and a second host boots
 * on the same home (phase two).
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, describeHome, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  timed, timing, type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  CLOSE_COMMENT, KEEP_REMOVE, askInComment, chooseMenuItem, commentRow, confirmBatch, confirmIfAsked, createSession,
  dismissNotices, ensurePanelList, footerBadge, newGuiPage, openListTab, openPanel, openSession, panelState, pick,
  pressRedo, pressUndo, row, sendMessage,
} from './helpers/gui.ts'

/** The two files this file keeps and re-keeps; the comments live on the other two. */
const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
  { name: 'gamma.txt', oldText: 'gamma one\ngamma two\n', newText: 'gamma one\nGAMMA TWO\n' },
  { name: 'delta.txt', oldText: 'delta one\ndelta two\n', newText: 'delta one\nDELTA TWO\n' },
]

const SEED_MESSAGE = 'e2e: seed this session'

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let paths: Record<string, string>
let gammaComment: string
let deltaComment: string

test.describe.configure({ mode: 'serial' })

/**
 * Declare one test with its own duration on the timing log.
 *
 * The body is the same body `test` would have taken; only the measurement is added, so
 * the per-test figures can be read off the same lines as the setup phases around them.
 *
 * @param key - short, stable name for the timing line (`a`..`d`).
 * @param title - the test's own title, unchanged.
 * @param body - the test's own body, unchanged.
 */
function timedTest(key: string, title: string, body: () => Promise<void>): void {
  test(title, async () => {
    const startedAt = Date.now()
    try {
      await body()
    } finally {
      timing(`test-${key}`, startedAt)
    }
  })
}

test.describe('待处理面板：保留并移出 / 撤销 / 重做（真 Chromium）', () => {
  test.beforeAll(async () => {
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH；本机既没有可用的 PATH 垫片，也没有 npx 缓存里的 @deepseek-ai/dsh。')
      return
    }
    fixture = makeFixture('keep')
    // Measured as one phase: this is the deliberate first boot whose only job is to make
    // the profile this plugin is then linked into.
    const workspaceId = await timed('bootstrap-host', () => bootstrapHome(dsh, fixture))

    // ---- phase one: a real session, created by the GUI, then the host stops.
    host = await timed('phase1-host-start', () => startHost(dsh, fixture.home, fixture.workspace, fixture.logFile))
    browser = await timed('browser-launch', () => chromium.launch())
    await timed('phase1-gui-ready', async () => {
      page = await newGuiPage(browser)
      await page.goto(host.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
      await dismissNotices(page)
    })
    await timed('session-create', async () => {
      sessionId = await createSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home)
      await sendMessage(page, sessionId, SEED_MESSAGE)
    })
    await timed('phase1-teardown', async () => {
      await page.close()
      await stopHost(host.proc)
    })

    // ---- the fixture, written while no host is running (the store is read once, at boot).
    await timed('seed-fixture', async () => {
      const seeded = seedPending(fixture, sessionId, FILES, ['gamma.txt', 'delta.txt'])
      paths = Object.fromEntries(seeded.entries.map(entry => [entry.path.split(/[\\/]/).pop() ?? entry.path, entry.id]))
      const commentOf = (name: string): string => seeded.comments.find(comment => comment.entryId.endsWith(name))?.id ?? ''
      gammaComment = commentOf('gamma.txt')
      deltaComment = commentOf('delta.txt')
      if (gammaComment === '' || deltaComment === '') throw new Error(`the comment fixture did not land:\n${describeHome(fixture.home)}`)
      claimSession(fixture, workspaceId, sessionId)
    })

    // ---- phase two: the same home, this time with the pending store in place.
    host = await timed('phase2-host-start', () => startHost(dsh, fixture.home, fixture.workspace, fixture.logFile))
    await timed('phase2-open-panel', async () => {
      page = await newGuiPage(browser)
      page.on('pageerror', error => { console.log('[pageerror]', error.message) })
      await page.goto(host.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
      await dismissNotices(page)
      await openSession(page, SEED_MESSAGE)
      await openPanel(page)
      for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt']) {
        await expect(row(page, paths[name] as string)).toBeVisible({ timeout: 30_000 })
      }
    })
  })

  test.afterAll(async () => {
    const startedAt = Date.now()
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
    timing('file-teardown', startedAt)
  })

  timedTest('a', 'a. Ctrl 选两个文件 → 右键「保留并移出」→ 确认 → 两行消失 → Ctrl+Z 回来', async () => {
    const alpha = row(page, paths['alpha.txt'] as string)
    const beta = row(page, paths['beta.txt'] as string)
    await pick(page, [alpha, beta])
    await expect(page.locator('[data-picked]')).toHaveCount(2)

    await chooseMenuItem(page, beta, KEEP_REMOVE)
    await confirmBatch(page)

    await expect(alpha).toHaveCount(0)
    await expect(beta).toHaveCount(0)
    // The other two files were never picked, so they stay: the pick is what decided.
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible()

    await pressUndo(page)
    await expect(alpha).toBeVisible({ timeout: 20_000 })
    await expect(beta).toBeVisible({ timeout: 20_000 })
  })

  timedTest('b', 'b. 紧接 Ctrl+Y → 两行再次消失', async () => {
    await pressRedo(page)
    await expect(row(page, paths['alpha.txt'] as string)).toHaveCount(0)
    await expect(row(page, paths['beta.txt'] as string)).toHaveCount(0)
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible()
    // The badge is the plugin's own count of what is still pending.
    await expect(footerBadge(page)).toHaveAttribute('data-diff-approval-badge', '2')
  })

  timedTest('c', 'c. 评论 tab 里 Ctrl 选两条评论 → 右键「关闭评论」→ 两条消失 → 一次 Ctrl+Z 两条都回来', async () => {
    await ensurePanelList(page)
    await openListTab(page, 'comments')
    const gamma = commentRow(page, gammaComment)
    const delta = commentRow(page, deltaComment)
    await expect(gamma).toBeVisible({ timeout: 20_000 })
    await expect(delta).toBeVisible({ timeout: 20_000 })

    await pick(page, [gamma, delta])
    // Comments mark a pick with `data-selected` (a file row's own `data-selected` means
    // "open in the detail pane", which is why files pick with `data-picked` instead).
    await expect(page.locator('[data-diff-comment-link][data-selected]')).toHaveCount(2)

    await chooseMenuItem(page, delta, CLOSE_COMMENT)
    await confirmIfAsked(page)

    await expect(gamma).toHaveCount(0)
    await expect(delta).toHaveCount(0)

    await pressUndo(page)
    await expect(gamma).toBeVisible({ timeout: 20_000 })
    await expect(delta).toBeVisible({ timeout: 20_000 })
  })

  timedTest('d', 'd. 对一条评论提问后 Ctrl+Z → 不应有任何变化（提问不压栈）', async () => {
    // Tests a and b left keep/undo/redo steps on this session's stack, and Ctrl+Z is the
    // panel's one chord for "take back the last ACTION". Draining them first is what lets
    // "no change" below mean the ask, rather than an older pending action coming back.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = await panelState(page)
      await pressUndo(page)
      if (await panelState(page) === before) break
    }

    await askInComment(page, gammaComment)
    // The ask landed, and the thread says so on its own: waiting for an answer, reported
    // stopped by the turn that claimed it, or refused. Which of the three it is depends on
    // how far the host got — with the placeholder credential the turn starts and then fails —
    // so this is about the question being registered, not about an answer.
    await expect(
      page.locator('[data-diff-discussion-asking], [data-diff-discussion-stopped], [data-diff-discussion-failed]').first(),
    ).toBeVisible({ timeout: 30_000 })

    const before = await panelState(page)
    await pressUndo(page)
    expect(await panelState(page)).toBe(before)
  })
})
