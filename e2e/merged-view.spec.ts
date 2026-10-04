// The merged view, read from the real host in a real browser: a row recorded by a CHILD session reaches the
// parent session's list as an ordinary row — same list, same actions, no glyph of its own. The mark that used
// to sit beside the file name is gone by the reader's decision, while the fields behind it stay (`viaLineage`
// still scopes the row in and the host tests pin the rest); what this spec proves is the READ.
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

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let ownPath: string
let childPath: string

test.describe.configure({ mode: 'serial' })

test.describe('合并视图：子会话的行照常列出', () => {
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

  test('m1. 两个会话的行都在，而这一行不再有自己的标记', async () => {
    test.setTimeout(120_000)
    const own = page.locator(`[data-diff-file="${ownPath.replace(/\\/g, '\\\\')}"]`).first()
    const child = page.locator(`[data-diff-file="${childPath.replace(/\\/g, '\\\\')}"]`).first()

    // Both rows are listed for the parent session: its own, and the child's — which is the whole merge.
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    await expect(own).toBeVisible({ timeout: 30_000 })
    await expect(child).toBeVisible({ timeout: 30_000 })

    // The merged row is an ORDINARY row now: it carries its own file name in the same list, and nothing
    // draws a glyph for it — nor for the session's own row. The merge itself is what this asserts, and the
    // fields behind the old mark stay pinned by the host and port tests rather than by a picture here.
    await expect(child).toContainText('child.txt')
    await expect(page.locator('[data-diff-child]')).toHaveCount(0, { timeout: 20_000 })
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
 * session is therefore an OWNER of the row, so the host answers "not merged, but a child's change is in it"
 * (`hasChildContribution`, which no longer draws anything). The child's lineage record rides the same row, so
 * no live child is needed.
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

  test('m2. 与子会话共享的行也在同一个列表里，同样没有标记', async () => {
    test.setTimeout(120_000)
    const own = sharedPage.locator(`[data-diff-file="${sharedOwnPath.replace(/\\/g, '\\\\')}"]`).first()
    const shared = sharedPage.locator(`[data-diff-file="${sharedPath.replace(/\\/g, '\\\\')}"]`).first()

    // The shared row is in the list because THIS session is one of its owners, not through the merge.
    await expect(sharedPage.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    await expect(own).toBeVisible({ timeout: 30_000 })
    await expect(shared).toBeVisible({ timeout: 30_000 })

    // Both are ordinary rows: each carries its own name and neither draws a glyph. The host's
    // `hasChildContribution` answer that used to pick a second sentence still rides the row — the port and
    // host tests pin it — but the list draws nothing from it.
    await expect(shared).toContainText('shared.txt')
    await expect(sharedPage.locator('[data-diff-child]')).toHaveCount(0, { timeout: 20_000 })
  })
})
