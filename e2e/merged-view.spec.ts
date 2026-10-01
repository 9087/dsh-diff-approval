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
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, waitForShellReady,
} from './helpers/gui.ts'

const SEED_MESSAGE = 'e2e: merged view'

/**
 * The child session the second row is recorded under. It never exists as a session: the merge walks the
 * lineage recorded ON THE ROW, so the fixture needs the link, not the child.
 */
const CHILD_SESSION = 'e2e-merged-view-child'

/** How the mark names itself, in whichever language the host drew (see `row.fromChild` in the locales). */
const MARK_COPY = /来自子会话的改动|Changed in a child session/

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
})
