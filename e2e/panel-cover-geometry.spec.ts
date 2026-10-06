// The cover's right edge against the shell's right sidebar — open and collapsed.
//
// MEASURED, and the reason this file exists: while the right sidebar is collapsed the shell keeps
// `[data-sidebar-right-panel]` MOUNTED at its last width (630px at 770..1400, `aria-hidden="true"`), its grid
// track is 0px, and the strip draws nothing — the conversation reaches the viewport edge. `frameInsets()`
// counted that ghost, so with the right sidebar NOT covered the floating panel's inset was `8px 638px` and it
// stopped 638px short of the window edge: the empty strip the reader reported. The sidebar being a real,
// drawn column at 770..1400 while open is what the fix must keep respecting.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, newGuiPage, openPanel, openSession } from './helpers/gui.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
]
const SEED_MESSAGE = 'e2e: cover geometry'

/** The cover's edges, plus what the shell is drawing on the right. */
async function geometry(page: Page): Promise<{
  width: number
  panelRight: number
  panelGap: number
  panelInline: string
  panelInsetRight: number
  sidebarLeft: number | null
  sidebarWidth: number | null
  sidebarHidden: string | null
  collapsedMarker: string | null
  stripDrawsSidebar: boolean
}> {
  return await page.evaluate(() => {
    const panel = document.querySelector('[data-diff-approval-panel]') as HTMLElement | null
    if (panel === null) throw new Error('the floating panel is not mounted')
    const box = panel.getBoundingClientRect()
    const sidebar = document.querySelector('[data-sidebar-right-panel]')
    const sidebarBox = sidebar?.getBoundingClientRect() ?? null
    const marker = document.querySelector('[data-rightbar-collapsed]')
    // What is drawn at the window's right edge, a few pixels in: the conversation, or the sidebar's body.
    const atEdge = document.elementsFromPoint(window.innerWidth - 4, Math.round(window.innerHeight / 2))
    const inline = panel.getAttribute('style') ?? ''
    const sides = /inset:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/.exec(inline)
    return {
      width: window.innerWidth,
      panelRight: +box.right.toFixed(1),
      panelGap: +(window.innerWidth - box.right).toFixed(1),
      panelInline: inline,
      panelInsetRight: sides === null ? -1 : Number.parseFloat(sides[2] as string),
      sidebarLeft: sidebarBox === null ? null : +sidebarBox.left.toFixed(1),
      sidebarWidth: sidebarBox === null ? null : +sidebarBox.width.toFixed(1),
      sidebarHidden: sidebar?.getAttribute('aria-hidden') ?? null,
      collapsedMarker: marker?.getAttribute('data-rightbar-collapsed') ?? null,
      stripDrawsSidebar: sidebarBox !== null
        && atEdge.some(node => sidebar.contains(node) || node === sidebar),
    }
  })
}

/** The shell's sidebar state, its rect, and the plugin's own inset — everything a measurement reads. */
async function snapshot(page: Page): Promise<{ collapsed: boolean, width: number, hidden: string | null, inset: string }> {
  return await page.evaluate(() => {
    const marker = document.querySelector('[data-rightbar-collapsed]')
    const sidebar = document.querySelector('[data-sidebar-right-panel]')
    const panel = document.querySelector('[data-diff-approval-panel]')
    return {
      collapsed: marker !== null && marker.getAttribute('data-rightbar-collapsed') !== 'false',
      width: sidebar === null ? 0 : Math.round(sidebar.getBoundingClientRect().width),
      hidden: sidebar?.getAttribute('aria-hidden') ?? null,
      inset: panel?.getAttribute('style') ?? '',
    }
  })
}

/**
 * WAIT for the shell and the plugin to SETTLE, before any measurement.
 *
 * Two things have to stop moving before a read means anything: the shell's own transition (its
 * `data-rightbar-collapsed` marker and the sidebar panel's rect), and the PLUGIN's re-measure, which runs on
 * its own 400ms cycle and writes the panel's inline inset. The first version slept a fixed 1.2s and read
 * once — which raced exactly that: under load (the full suite boots a `dsh web` host per spec) the marker
 * could still carry the OLD state, so the case failed on a state it had not reached yet rather than on a
 * wrong inset. This polls, and never against an EXPECTED value: a genuinely wrong inset settles at the wrong
 * number and the assertion that follows still fails.
 *
 * @param page - the GUI page.
 * @param want - the state the assertion after this call depends on.
 */
async function settle(page: Page, want: 'collapsed' | 'expanded'): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).collapsed, {
    timeout: 30_000,
    message: `the shell never said the sidebar was ${want}`,
  }).toBe(want === 'collapsed')
  let last = ''
  await expect.poll(async () => {
    const now = await snapshot(page)
    const reading = `${now.width}:${now.hidden ?? 'none'}:${now.inset}`
    const stable = last === reading
    last = reading
    return stable
  }, { timeout: 30_000, message: `the sidebar and the panel never settled while ${want}` }).toBe(true)
}

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host

test.describe.configure({ mode: 'serial' })

test.describe('cover geometry beside the right sidebar', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('covergeometry')
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

    seedPending(fixture, sessionId, FILES, [])
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    // Floating panel, covering the header/left/bottom but NOT the right sidebar: the configuration whose
    // right inset is the sidebar's own width, and so the one that showed the empty strip.
    await page.evaluate(() => {
      localStorage.setItem('diff-approval:float-cover', JSON.stringify({ top: true, left: true, right: false, composer: false }))
      localStorage.setItem('diff-approval:presentation', 'float')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    await settle(page, 'collapsed')
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('c1. collapsed sidebar: the panel reaches the window edge; open sidebar: it stops beside it', async () => {
    test.setTimeout(120_000)
    // Start collapsed: what is drawn at the right edge is the conversation, not the sidebar's body. The poll
    // is what makes this read mean something — the beforeAll's own settle has already run, and this one
    // guards the case when the file is run on its own.
    await settle(page, 'collapsed')
    const collapsed = await geometry(page)
    expect(collapsed.sidebarWidth, 'the fixture did not stage a right sidebar at all').not.toBeNull()
    expect(collapsed.collapsedMarker, `the shell is not collapsed at the start: ${JSON.stringify(collapsed)}`).not.toBeNull()
    expect(collapsed.stripDrawsSidebar, `the collapsed strip draws the sidebar after all: ${JSON.stringify(collapsed)}`).toBe(false)
    expect(collapsed.sidebarHidden, 'a collapsed shell marks its mounted panel hidden').toBe('true')

    // THE PIN: nothing is drawn there, so the cover reaches the window edge. The inset left is the 8px window
    // inset plus the conversation scroller's own 2px slack (measured: its border box ends at 1398 while the
    // conversation body reaches 1400) — NOT a sidebar. Before the fix this was 638px.
    expect(collapsed.panelInsetRight, `panel inset was ${collapsed.panelInline}: ${JSON.stringify(collapsed)}`)
      .toBeLessThan(20)
    expect(collapsed.panelGap, `panel inset was ${collapsed.panelInline}: ${JSON.stringify(collapsed)}`)
      .toBeLessThan(20)

    // Open it with the shell's own expand button, then collapse it with the shell's own toggle.
    await page.locator('[data-sidebar-right-expand]').first().click({ timeout: 20_000 })
    await settle(page, 'expanded')
    const open = await geometry(page)
    expect(open.collapsedMarker, `the shell still says collapsed: ${JSON.stringify(open)}`).toBeNull()
    expect(open.stripDrawsSidebar, `the open sidebar is not drawn: ${JSON.stringify(open)}`).toBe(true)
    // The drawn sidebar is respected: the panel's right inset is the sidebar's own width (plus the 8px window
    // inset), so the panel stops at the sidebar's left edge rather than over it.
    expect(open.panelInsetRight, `panel inset was ${open.panelInline} while the sidebar is drawn at ${open.sidebarLeft}: ${JSON.stringify(open)}`)
      .toBeGreaterThanOrEqual((open.sidebarWidth ?? 0) - 2)
    expect(open.panelGap, `panel inset was ${open.panelInline}: ${JSON.stringify(open)}`)
      .toBeGreaterThan((open.sidebarWidth ?? 0) - 2)
    expect(open.panelRight).toBeLessThanOrEqual((open.sidebarLeft ?? 0) + 1)

    await page.locator('[data-sidebar-right-toggle]').first().click({ timeout: 20_000 })
    await settle(page, 'collapsed')
    const closedAgain = await geometry(page)
    expect(closedAgain.collapsedMarker, `the shell did not collapse again: ${JSON.stringify(closedAgain)}`).not.toBeNull()
    expect(closedAgain.stripDrawsSidebar).toBe(false)
    // …and the strip is gone again, on the same page: the fix is a re-measure, not a one-time mount.
    expect(closedAgain.panelInsetRight, `panel inset was ${closedAgain.panelInline} after collapsing again: ${JSON.stringify(closedAgain)}`)
      .toBeLessThan(20)
  })
})
