// The shell's tooltip WITH a shortcut, read from the real host in a real browser.
//
// The unit suite cannot see this shape: the primitives this repo compiles against (0.1.0-rc.6)
// predate `shortcutKeys`, so jsdom renders the label and drops the prop. What the reader gets is the
// HOST's own `Tooltip`, so the proof lives here — `data-has-shortcut`, one `<kbd>` per key, the
// shell's own separator and grouping classes, the label BEFORE the keys, and the chord the anchor
// advertises agreeing with the bubble's own `aria-label`.
//
// The fixture is the usual two-phase shape, for the usual reason: the plugin host reads its pending
// store once, at boot, so the store is written while no host is running and its entries name the
// session the GUI itself created.
//
// ORDER IS DELIBERATE and this file is serial: the header entry and the footer badge are sampled
// BEFORE the panel is opened. With the overlay panel up, the panel's own subtree intercepts pointer
// events over the session header — the probe hit exactly that `hover()` timeout — so those two are
// read while nothing covers them. Everything after that is sampled from the open panel.

import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host,
} from './helpers/host.ts'
import {
  beginSession, dismissNotices, ensurePanelList, newGuiPage, openPanel, openSession, row,
} from './helpers/gui.ts'

/** One changed text file: a row to open and, with it, a search bar to inspect. */
const FILES = [{ name: 'keys.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' }]

const SEED_MESSAGE = 'e2e: tooltip shortcuts'

/** Where the keys span sits relative to the label span. */
type Order = 'label-first' | 'keys-first' | 'no-keys' | 'no-label'

/** What the shell really drew in one bubble, plus the chord its anchor advertises. */
interface Caps {
  /** `data-has-shortcut` — the shell sets it while it renders keycaps, and only then. */
  hasShortcut: boolean
  /** Each cap's text, in the order drawn. */
  caps: string[]
  /** How many caps carry the shell's own SEPARATOR class. */
  separators: number
  /** Whether the cap group carries the shell's grouping class (a combination, drawn as one keycap). */
  joined: boolean
  /** The label span's position relative to the keys span: the shortcut has to be trailing. */
  order: Order
  /** The label span's own text: what a tooltip with no shortcut still says. */
  labelText: string
  /**
   * The bubble's own `aria-label`. `null` for a tooltip with NO shortcut: the shell sets it only when it
   * renders keycaps (`shortcutKeys?.length ? … : void 0`), because a plain tooltip's accessible name is
   * its text content.
   */
  bubbleAria: string | null
  /** The anchor's `aria-keyshortcuts`, in the DOM's spelling of the same chord. */
  anchorAria: string | null
  /** The anchor's `aria-label`: the name the site gave the control, which its bubble repeats. */
  anchorLabel: string | null
}

/**
 * Raise one control's tooltip and read what the shell drew.
 *
 * The shell raises a bubble on hover AND on focus, so both are cleared first (the pointer is parked
 * and the active element blurred) and the call then insists on exactly ONE visible bubble before and
 * after the hover: the facts returned belong to the anchor just hovered, never to a bubble left over
 * from the previous sample. The class names are read by their LOCAL fragment (`separator`, `joined`,
 * …), which the shell's hashed names keep, so the spec does not pin a build hash.
 *
 * @param page - the GUI page.
 * @param selector - the anchor: a control that already carries a `data-*` mark.
 * @returns the bubble's DOM facts and the anchor's chord.
 */
async function sample(page: Page, selector: string): Promise<Caps> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
  const bubbles = page.locator('[role="tooltip"]:visible')
  await expect(bubbles).toHaveCount(0, { timeout: 20_000 })

  const anchor: Locator = page.locator(selector).filter({ visible: true }).first()
  await expect(anchor).toBeVisible({ timeout: 20_000 })
  await anchor.hover({ timeout: 20_000 })
  await expect(bubbles).toHaveCount(1, { timeout: 20_000 })

  const facts = await bubbles.first().evaluate(element => {
    const label = element.querySelector('span[class*="label"]')
    const keys = element.querySelector('span[class*="keys"]')
    const caps = [...(keys?.querySelectorAll('kbd') ?? [])]
    const ahead = label !== null && keys !== null
      && (label.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    const order: Order = label === null && keys === null ? 'no-label'
      : keys === null ? 'no-keys'
        : ahead ? 'label-first' : 'keys-first'
    return {
      hasShortcut: element.getAttribute('data-has-shortcut') === 'true',
      caps: caps.map(cap => cap.textContent ?? ''),
      separators: caps.filter(cap => cap.className.includes('separator')).length,
      joined: keys !== null && keys.className.includes('joined'),
      order,
      labelText: (label?.textContent ?? '').trim(),
      bubbleAria: element.getAttribute('aria-label'),
    }
  })
  return {
    ...facts,
    anchorAria: await anchor.getAttribute('aria-keyshortcuts'),
    anchorLabel: await anchor.getAttribute('aria-label'),
  }
}

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let filePath: string

test.describe.configure({ mode: 'serial' })

test.describe('工具提示：快捷键由外壳自己渲染成键帽', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('tooltip-shortcuts')
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

    const seeded = seedPending(fixture, sessionId, FILES, [])
    filePath = seeded.entries[0]?.path ?? ''
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the same home with the store in place. The panel stays CLOSED: s1 samples the
    // two entries that live outside it, and opens nothing.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('s1. 页脚入口与头部入口：组合键渲染成一枚分组的键帽', async () => {
    test.setTimeout(120_000)
    // The footer badge advertises the chord that summons the panel (Ctrl+D by default). Both entries
    // that open it are outside the panel and are sampled here, before it is opened.
    const badge = await sample(page, '[data-diff-approval-badge]')
    expect(badge.hasShortcut).toBe(true)
    // One cap per part, with the shell's separator between them, grouped into a single keycap.
    expect(badge.caps).toEqual(['Ctrl', '+', 'D'])
    expect(badge.separators).toBe(1)
    expect(badge.joined).toBe(true)
    // The shortcut trails the label…
    expect(badge.order).toBe('label-first')
    // …the anchor carries the chord in aria's spelling…
    expect(badge.anchorAria).toBe('Control+D')
    // …and the bubble says the same chord, in the caps' own words.
    expect(badge.bubbleAria).toContain(badge.caps.join(' '))

    // The header entry is the second way in, with the same chord. Sampled BEFORE `openPanel`: with the
    // overlay panel up its subtree intercepts pointer events over the session header (the probe's
    // `hover()` timeout), and a spec should not fight that.
    const header = await sample(page, '[data-diff-approval-header-entry]')
    expect(header.hasShortcut).toBe(true)
    expect(header.caps).toEqual(['Ctrl', '+', 'D'])
    expect(header.separators).toBe(1)
    expect(header.joined).toBe(true)
    expect(header.order).toBe('label-first')
    expect(header.anchorAria).toBe('Control+D')
    expect(header.bubbleAria).toContain('Ctrl + D')
  })

  test('s2. 搜索栏：组合键与单键，键帽数与 aria 都对得上', async () => {
    test.setTimeout(180_000)
    await openPanel(page)
    await ensurePanelList(page)
    await row(page, filePath).click({ timeout: 20_000 })
    await page.locator('[data-diff-search-toggle]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-search-input]').first()).toBeVisible({ timeout: 20_000 })

    // A combination: three caps — the two parts and the shell's own separator — in one grouped keycap.
    const strict = await sample(page, '[data-diff-search-case]')
    expect(strict.hasShortcut).toBe(true)
    expect(strict.caps).toEqual(['Alt', '+', 'C'])
    expect(strict.separators).toBe(1)
    expect(strict.joined).toBe(true)
    expect(strict.order).toBe('label-first')
    expect(strict.anchorAria).toBe('Alt+C')
    expect(strict.bubbleAria).toContain(strict.caps.join(' '))

    // A single key is the other shape: one cap, and neither a separator nor a grouping class.
    const close = await sample(page, '[data-diff-search-close]')
    expect(close.hasShortcut).toBe(true)
    expect(close.caps).toEqual(['Esc'])
    expect(close.separators).toBe(0)
    expect(close.joined).toBe(false)
    expect(close.order).toBe('label-first')
    expect(close.anchorAria).toBe('Escape')
    expect(close.bubbleAria).toContain('Esc')
  })

  test('s3. 面板关闭与没有快捷键的提示：两个出口各有一枚键帽，覆盖范围则一枚都没有', async () => {
    test.setTimeout(120_000)
    // The panel's close button has two ways out — Escape and the bound summon chord — drawn as two
    // caps, each saying its own thing: no separator and no grouping (one cap reads "Ctrl+D").
    const close = await sample(page, '[data-diff-approval-close]')
    expect(close.hasShortcut).toBe(true)
    expect(close.caps).toEqual(['Esc', 'Ctrl+D'])
    expect(close.separators).toBe(0)
    expect(close.joined).toBe(false)
    expect(close.order).toBe('label-first')
    expect(close.anchorAria).toBe('Escape Control+D')
    expect(close.bubbleAria).toContain('Esc Ctrl+D')

    // And a tooltip whose control has NO shortcut renders no keycaps at all — the claim the other
    // samples cannot make, and the one that would also catch a prop applied to the wrong control: an
    // empty keys span is exactly what the shell must not draw here.
    const cover = await sample(page, '[data-diff-approval-cover]')
    expect(cover.hasShortcut).toBe(false)
    expect(cover.caps).toEqual([])
    expect(cover.order).toBe('no-keys')
    // No keycaps means no shortcut aria: the shell sets the bubble's `aria-label` only when it has keys
    // to name (`shortcutKeys?.length ? … : void 0`), because a plain tooltip's accessible name is its
    // text. So the invariant is the TEXT — the bubble still reads as a tooltip with words, and they are
    // the name the control was given.
    expect(cover.bubbleAria).toBeNull()
    expect(cover.labelText).not.toBe('')
    expect(cover.labelText).toBe(cover.anchorLabel)
  })
})
