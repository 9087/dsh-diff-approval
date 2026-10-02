// The merged view, read from the real host in a real browser: a row recorded by a CHILD session reaches the
// parent session's list, and it is marked as such.
//
// What makes the fixture small: the host's merge reads the lineage an entry RECORDED (see `listWithState`
// and `lineageView`) before it asks the session registry, so the store only has to carry a child-owned row
// whose `lineage.parentSessionId` is the session the panel will show. No live child session is needed, and
// the child id in this fixture never exists as a session at all — which is the honest shape of the claim:
// this proves the READ and the MARK, not that a real subagent spawn produces such a row (no spec can).
//
// The fixture is the usual two-phase shape, for the usual reason: the plugin host reads its pending store
// once, at boot, so the store is written while no host is running and its entries have to name the session
// the GUI itself created.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedCommentFile, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, commentRow, dismissNotices, ensurePanelList, newGuiPage, openListTab, openPanel, openSession,
  waitForShellReady,
} from './helpers/gui.ts'

const SEED_MESSAGE = 'e2e: merged view'

/**
 * The child session the second row is recorded under. It never exists as a session: the merge walks the
 * lineage recorded ON THE ROW, so the fixture needs the link, not the child.
 */
const CHILD_SESSION = 'e2e-merged-view-child'

/** The thread recorded in the CHILD's own comment file, and the words it must show up with. */
const CHILD_COMMENT = 'e2e-merged-view-note'
const CHILD_COMMENT_TEXT = 'note from the child seat'

/** How the mark names itself, in whichever language the host drew (see `row.fromChild` in the locales). */
const MARK_COPY = /来自子会话的改动|Changed in a child session/

/**
 * The SHARED row's sentence, and it must NOT be the one above: that row carries the reader's own change too,
 * so "changed in a child session" alone would deny it (see `row.fromChildShared` in the locales).
 */
const SHARED_COPY = /也包含子会话的改动|Also includes changes from a child session/

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let ownPath: string
let childPath: string

test.describe.configure({ mode: 'serial' })

test.describe('合并视图：子会话的行与它的标记', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('merged-view')
    const workspaceId = await bootstrapHome(dsh, fixture)

    // ---- phase one: a session made by the GUI, then the host stops so the store can be written.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    const sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, SEED_MESSAGE)
    await page.close()
    await stopHost(host.proc)

    // One row the session owns, and one recorded by a child whose lineage points at it. The child's link is
    // the ONLY thing that puts the second row in this session's list.
    const files: SeededFile[] = [
      { name: 'own.txt', oldText: 'own one\n', newText: 'own two\n' },
      {
        name: 'child.txt', oldText: 'child one\n', newText: 'child two\n',
        owner: { sessionId: CHILD_SESSION, parentSessionId: sessionId, origin: 'subagent', delegationDepth: 1 },
      },
    ]
    const seeded = seedPending(fixture, sessionId, files, [])
    ownPath = seeded.entries[0]?.path ?? ''
    childPath = seeded.entries[1]?.path ?? ''
    // The child's own comment FILE, written after the pending store: the thread belongs to a seat that never
    // ran here, lives in that seat's file on disk (no migration), and is readable from the parent's panel
    // only because the comment read fans out across the lineage instead of reading one session's file.
    seedCommentFile(fixture, CHILD_SESSION, [{
      id: CHILD_COMMENT,
      entryId: childPath,
      path: childPath,
      // The child file's own last line, which is what lets the host place the thread in that content.
      quote: 'child two',
      text: CHILD_COMMENT_TEXT,
    }])
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the same home with the store in place.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await waitForShellReady(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('m1. 两个会话的行都在，而标记只在子会话那一行上', async () => {
    test.setTimeout(120_000)
    const own = page.locator(`[data-diff-file="${ownPath.replace(/\\/g, '\\\\')}"]`).first()
    const child = page.locator(`[data-diff-file="${childPath.replace(/\\/g, '\\\\')}"]`).first()

    // Both rows are listed for the parent session: its own, and the child's — which is the whole merge.
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    await expect(own).toBeVisible({ timeout: 30_000 })
    await expect(child).toBeVisible({ timeout: 30_000 })

    // …and the child-owned row is the one that wears the mark.
    await expect(child.locator('[data-diff-child]')).toHaveCount(1)
    await expect(own.locator('[data-diff-child]')).toHaveCount(0)

    // The mark names itself with the honest copy — "child session", never a claim about teammates. The host
    // translates the key, so this matches the SENTENCE in either language rather than the key.
    const mark = child.locator('[data-diff-child]').first()
    await expect(mark).toHaveAttribute('aria-label', MARK_COPY)

    // Hovering it raises a bubble saying the same thing. Filtered by text rather than counting bubbles: the
    // row's own path tooltip wraps the same button, so what matters is that THIS sentence is on screen.
    await mark.hover({ timeout: 20_000 })
    await expect(page.locator('[role="tooltip"]:visible').filter({ hasText: MARK_COPY }))
      .toHaveCount(1, { timeout: 20_000 })
  })

  test('m3. 子会话的评论在父会话的面板里列出', async () => {
    test.setTimeout(120_000)
    // The comment READ is the lineage's too. The thread lives in the CHILD's own file on disk — the author's,
    // never migrated — and the parent's panel lists it because the read fans out across the lineage. Under
    // the read this replaced (one session's own file) this thread was invisible to every seat but its
    // author's, which is the state `m1`/`m2` cannot show: they are about the row, not the threads.
    await openListTab(page, 'comments')
    const thread = commentRow(page, CHILD_COMMENT)
    await expect(thread).toBeVisible({ timeout: 30_000 })
    await expect(thread).toContainText(CHILD_COMMENT_TEXT, { timeout: 20_000 })
    // …and it is the only thread on screen: the parent wrote none, so a second row here would be the child's
    // file read twice rather than one lineage's threads read once.
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(1)
  })
})

/**
 * The SHARED row: one the listing session touched itself AND a child in its lineage touched too. Its own
 * fixture, because `m1` asserts the exact row count of ITS two rows and must stay untouched; this block
 * seeds the two rows its own claim needs.
 *
 * The shape that makes it shared is `sessionIds: [child, thisSession]` — written by `alsoSessions`. The
 * session is therefore an OWNER of the row, so the host answers "not merged, but a child's change is in it",
 * which is the second sentence. The child's lineage record rides the same row, so no live child is needed.
 */
test.describe('合并视图：与子会话共享的行', () => {
  let sharedFixture: Fixture
  let sharedBrowser: Browser
  let sharedPage: Page
  let sharedHost: Host
  let sharedOwnPath: string
  let sharedPath: string

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    sharedFixture = makeFixture('merged-shared')
    const workspaceId = await bootstrapHome(dsh, sharedFixture)

    sharedHost = await startHost(dsh, sharedFixture.home, sharedFixture.workspace, sharedFixture.logFile)
    sharedBrowser = await chromium.launch()
    sharedPage = await newGuiPage(sharedBrowser)
    await sharedPage.goto(sharedHost.url, { waitUntil: 'domcontentloaded' })
    await sharedPage.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(sharedPage)
    const sessionId = await beginSession(
      sharedPage, sharedFixture.workspace.split(/[\\/]/).pop() ?? 'workspace', sharedFixture.home, SEED_MESSAGE,
    )
    await sharedPage.close()
    await stopHost(sharedHost.proc)

    const files: SeededFile[] = [
      { name: 'own.txt', oldText: 'own one\n', newText: 'own two\n' },
      {
        // The child is the first writer AND the recorded lineage is its own, while the session is named as a
        // co-owner: exactly the shape `listWithState` answers with the shared mark.
        name: 'shared.txt', oldText: 'shared one\n', newText: 'shared two\n',
        owner: {
          sessionId: CHILD_SESSION, parentSessionId: sessionId, origin: 'subagent', delegationDepth: 1,
          alsoSessions: [sessionId],
        },
      },
    ]
    const seeded = seedPending(sharedFixture, sessionId, files, [])
    sharedOwnPath = seeded.entries[0]?.path ?? ''
    sharedPath = seeded.entries[1]?.path ?? ''
    claimSession(sharedFixture, workspaceId, sessionId)

    sharedHost = await startHost(dsh, sharedFixture.home, sharedFixture.workspace, sharedFixture.logFile)
    sharedPage = await newGuiPage(sharedBrowser)
    sharedPage.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await sharedPage.goto(sharedHost.url, { waitUntil: 'domcontentloaded' })
    await sharedPage.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(sharedPage)
    await waitForShellReady(sharedPage)
    await openSession(sharedPage, SEED_MESSAGE)
    await openPanel(sharedPage)
    await ensurePanelList(sharedPage)
  })

  test.afterAll(async () => {
    await sharedPage?.close().catch(() => {})
    await sharedBrowser?.close().catch(() => {})
    await stopHost(sharedHost?.proc)
    sharedFixture?.cleanup()
  })

  test('m2. 与子会话共享的行说的是另一句，而本会话自己的行仍然没有标记', async () => {
    test.setTimeout(120_000)
    const own = sharedPage.locator(`[data-diff-file="${sharedOwnPath.replace(/\\/g, '\\\\')}"]`).first()
    const shared = sharedPage.locator(`[data-diff-file="${sharedPath.replace(/\\/g, '\\\\')}"]`).first()

    // The shared row is in the list because THIS session is one of its owners, not through the merge.
    await expect(sharedPage.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    await expect(own).toBeVisible({ timeout: 30_000 })
    await expect(shared).toBeVisible({ timeout: 30_000 })

    // It wears the mark, in the SHARED sentence: the row is the reader's own work as well, and the first
    // sentence would deny that.
    await expect(shared.locator('[data-diff-child]')).toHaveCount(1)
    await expect(own.locator('[data-diff-child]')).toHaveCount(0)
    await expect(shared.locator('[data-diff-child]').first()).toHaveAttribute('aria-label', SHARED_COPY)

    // …and the sentence is on a RENDERED surface too, the way `m1` proves its own: hover the mark and a visible
    // bubble carries it. Same technique, same locator shape, same nesting — only the sentence differs.
    const mark = shared.locator('[data-diff-child]').first()
    await mark.hover({ timeout: 20_000 })
    await expect(sharedPage.locator('[role="tooltip"]:visible').filter({ hasText: SHARED_COPY }))
      .toHaveCount(1, { timeout: 20_000 })
  })
})
