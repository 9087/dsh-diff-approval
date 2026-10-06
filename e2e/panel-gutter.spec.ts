// The line-number column's own surface: the numbers must be told apart from the code area, and BRIGHTER
// than it — the fill is what separates them, and no line is drawn.
//
// Nothing drove this before. The two colour cases that already exist are about something else: the one in
// `panel-comments.spec.ts` measures the comment CATEGORY DOT palette (a comment's class, not the code's
// columns), and `panel-settings.spec.ts` measures the settings preview's GEOMETRY (that it parks below the
// group header), never a colour. So the column's fill, its opacity, the changed rows' tint riding on it,
// the quoted frame's match and the preview's reuse are all new ground here.
//
// The column is pinned (`position: sticky; left: 0`), so its fill has to be opaque or the code would show
// through it as it slides under. The fill is the PANEL's own surface (`--dsw-alias-bg-base`), which in a
// light theme is white against the code block's `#f9fafb` — a small step, but a real one, and "brighter" is
// an ABSOLUTE direction: an earlier theme-relative mix (8% of the theme's LABEL into the code token) came
// out `#E6E7E9` here, DARKER than the code it was meant to stand off. That is why the direction assertion
// below is the property under test. There is NO line and NO shadow on either surface: a hairline edge was
// tried once, rejected, and removed — the fill alone separates the column, so either one coming back is a
// regression this file pins. The fill is opaque by definition, which is
// what the opacity assertions read back: a computed colour with no alpha channel at all.

import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedCommentFile, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { beginSession, dismissNotices, newGuiPage, openPanel, openSession, row } from './helpers/gui.ts'

/**
 * One changed file whose rows cover every kind the column has to carry: line 1 context, line 2 a removal
 * and its replacement (del then add), line 3 context, line 4 a pure addition. The numbers of all of them
 * sit in the same pinned column.
 */
const FILES: SeededFile[] = [
  { name: 'gutter.txt', oldText: 'one\ntwo\nthree\n', newText: 'one\nTWO\nthree\nfour\n' },
]

const SEED_MESSAGE = 'e2e: gutter surface'

/**
 * The fill in the light theme this run drew: `--dsw-alias-bg-base` is the panel's own white, measured in
 * the browser and pinned here. The code block beside it is `#f9fafb`, so the step is small but real
 * (+6/+5/+4); should a theme ever hand the panel a bg-base equal to its code block, the not-equal pin
 * fails loudly rather than papering over a column nobody can see.
 */
const LIGHT_FILL = { r: 255, g: 255, b: 255 }

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let path: string

/** One measurement of the column, the surface beside it and the layers over both. */
interface Reading {
  theme: { colorScheme: string, codeBlock: string, labelPrimary: string }
  /** The colour the numbers' cell paints, and the colour the code cell's own surface paints. */
  gutter: string
  codeSurface: string
  gutterPosition: string
  gutterLeft: string
  /** The column's computed `box-shadow` — MUST be `none`: a line here is a regression (see the header). */
  boxShadow: string
  quoteBoxShadow: string | null
  /** Per row kind: the cell's own fill, the tint/wash layers it repaints, and its shadow. */
  rows: { kind: string, gutter: string, image: string, shadow: string, codeSurface: string, band: boolean, rowImage: string }[]
  quoteGutter: string | null
  previewGutter: string | null
}

/** The property the reader asked for: never darker than the code on any channel, strictly brighter on one. */
function brightnessAgainst(
  column: { r: number, g: number, b: number },
  surface: { r: number, g: number, b: number },
): { deltas: number[], strictlyBrighter: number } {
  const deltas = [column.r - surface.r, column.g - surface.g, column.b - surface.b]
  return { deltas, strictlyBrighter: deltas.filter(delta => delta > 0).length }
}

/** `rgb(r, g, b)` / `color(srgb r g b)` / `color(srgb r g b / a)` as channels 0-255, or `null`. */
function channelsOf(colour: string): { r: number, g: number, b: number, alpha: number } | null {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(colour.trim())
  if (rgb !== null) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), alpha: 1 }
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(colour.trim())
  if (srgb !== null) {
    return {
      r: Number(srgb[1]) * 255,
      g: Number(srgb[2]) * 255,
      b: Number(srgb[3]) * 255,
      alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
    }
  }
  return null
}

/** Whether a colour string carries any transparency at all. */
function isOpaque(colour: string): boolean {
  const parsed = channelsOf(colour)
  return parsed !== null && parsed.alpha === 1
}

/** The panel's own reading of the file view, the quotes it drew and (once open) the settings preview. */
async function read(page: Page): Promise<Reading> {
  return await page.evaluate(() => {
    /** The colour a cell actually shows: its first ancestor that paints one. */
    const surfaceOf = (node: Element | null): string => {
      let at: Element | null = node
      while (at !== null) {
        const bg = getComputedStyle(at).backgroundColor
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
        at = at.parentElement
      }
      return ''
    }
    const preview = document.querySelector('[data-diff-view-preview]')
    // The settings preview reuses the code view's classes without its data attributes, so both surfaces
    // are read the same way: by marker when there is one, by class when the preview is what is open.
    const cell = (document.querySelector('[data-diff-gutter]')
      ?? preview?.querySelector('[class*="gutter"]')
      ?? null) as HTMLElement | null
    if (cell === null) throw new Error('no gutter cell is drawn')
    const codeCell = document.querySelector('[data-diff-code]') ?? preview?.querySelector('[class*="code"]') ?? null
    const cells = [...document.querySelectorAll('[data-diff-row]')].map(node => {
      const each = node.querySelector('[data-diff-gutter]') as HTMLElement
      return {
        kind: node.getAttribute('data-diff-line') ?? '',
        gutter: getComputedStyle(each).backgroundColor,
        image: getComputedStyle(each).backgroundImage,
        shadow: getComputedStyle(each).boxShadow,
        codeSurface: surfaceOf(node.querySelector('[data-diff-code]')),
        band: node.hasAttribute('data-diff-discussion-band'),
        rowImage: getComputedStyle(node).backgroundImage,
      }
    })
    const quote = document.querySelector('[data-diff-quote-gutter]')
    const previewGutter = preview === null ? null : preview.querySelector('[class*="gutter"]')
    return {
      theme: {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        codeBlock: getComputedStyle(cell).getPropertyValue('--dsw-alias-markdown-code-block').trim(),
        labelPrimary: getComputedStyle(cell).getPropertyValue('--dsw-alias-label-primary').trim(),
      },
      gutter: getComputedStyle(cell).backgroundColor,
      codeSurface: surfaceOf(codeCell),
      gutterPosition: getComputedStyle(cell).position,
      gutterLeft: getComputedStyle(cell).left,
      boxShadow: getComputedStyle(cell).boxShadow,
      quoteBoxShadow: quote === null ? null : getComputedStyle(quote).boxShadow,
      rows: cells,
      quoteGutter: quote === null ? null : getComputedStyle(quote).backgroundColor,
      previewGutter: previewGutter === null ? null : getComputedStyle(previewGutter as Element).backgroundColor,
    }
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('行号列的底色：与代码区分、不透明、改动行的色带仍在、引用框与预览同色', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('gutter')
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

    const seeded = seedPending(fixture, sessionId, FILES, [])
    path = seeded.entries[0]!.id
    expect(path, 'the seeded entry must be on disk').toBeTruthy()
    // Two threads on the same rows: one PLACEABLE (its quote is the file's own last line), which is what
    // paints the comment wash across the rows it names, and one OUTDATED (its quoted line is gone), which
    // is the only case where a card draws its own quoted frame — the frame whose numbers reuse the file's.
    seedCommentFile(fixture, sessionId, [
      {
        id: 'banded', entryId: path, path, quote: 'four', text: 'review note for gutter.txt',
        anchor: { startLine: 2, endLine: 2 },
      },
      {
        id: 'outdated', entryId: path, path, quote: 'a line that is gone', text: 'the lines this was about are gone',
        anchor: { startLine: 2, endLine: 2 },
      },
    ])
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    await row(page, path).click({ timeout: 30_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    // The cards (and the wash that marks their rows) are drawn a frame or two later than the code.
    await expect(page.locator('[data-diff-discussion-band]').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-diff-quote-gutter]').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('g1. 行号列有自己的底色：与代码区不同、完全不透明，改动行的色带与评论洗色仍盖在它上面', async () => {
    test.setTimeout(120_000)
    const reading = await read(page)

    // Which theme the shell gave us, stated rather than assumed. The mix is written toward WHITE, so the
    // direction it must move is absolute: brighter than the code in either theme.
    const code = channelsOf(reading.codeSurface)
    const gutter = channelsOf(reading.gutter)
    expect(code, `the code surface must be a readable colour, got ${reading.codeSurface}`).not.toBeNull()
    expect(gutter, `the column must be a readable colour, got ${reading.gutter}`).not.toBeNull()

    // CONTRACT 1a: the column is its own surface, not the code's repeated. This is the reader's ask.
    expect(gutter, 'the numbers must not sit on exactly the code\'s surface').not.toEqual(code)
    // CONTRACT 1b: OPAQUE. A computed colour with an alpha channel (or a `transparent`) would let the
    // code show through the pinned column as it scrolls under it.
    expect(isOpaque(reading.gutter), `the column must be opaque, got ${reading.gutter}`).toBe(true)
    // THE DIRECTION, which is the whole requirement: never darker than the code on ANY channel, and strictly
    // brighter on at least one. A magnitude demand cannot hold here — in this light theme the panel's white
    // is only 6/255 above `#f9fafb` — but the direction does, and it is the property the earlier
    // theme-relative mix failed to give.
    const against = brightnessAgainst(gutter as { r: number, g: number, b: number }, code as { r: number, g: number, b: number })
    for (const [index, delta] of against.deltas.entries()) {
      expect(delta, `the column must not be darker than the code on ${['red', 'green', 'blue'][index]} (deltas ${against.deltas.map(value => value.toFixed(2)).join('/')})`)
        .toBeGreaterThanOrEqual(0)
    }
    expect(against.strictlyBrighter, 'the column must be strictly brighter than the code on at least one channel')
      .toBeGreaterThan(0)
    // MEASURED, in the light theme this run drew: the panel's own surface, white against the code block's
    // `#f9fafb`. If a theme ever hands the panel a bg-base equal to its code block, this pins the difference
    // as ZERO and the not-equal pin above fails first — the column would be invisible and the failure says so
    // rather than passing on a colour that happens to look right here.
    if (reading.theme.colorScheme === 'light') {
      expect(gutter!.r, 'the fill the slice measured, red channel').toBeCloseTo(LIGHT_FILL.r, 0)
      expect(gutter!.g, 'the fill the slice measured, green channel').toBeCloseTo(LIGHT_FILL.g, 0)
      expect(gutter!.b, 'the fill the slice measured, blue channel').toBeCloseTo(LIGHT_FILL.b, 0)
    }
    // NO LINE, on any row's cell. A hairline edge was tried here once and rejected, so its return is a
    // regression this pin exists to catch — including on changed rows, where a shadow used to paint over
    // the tint.
    expect(reading.boxShadow, 'the column must wear NO line: the reader rejected the hairline edge').toBe('none')
    for (const entry of reading.rows) {
      expect(entry.shadow, `a ${entry.kind} row's cell must wear no line either`).toBe('none')
    }
    // The fill is the panel's own surface, read live rather than assumed to be a colour written down here.
    // The shell on this machine only ever handed this spec LIGHT (`data-ds-theme-source=system`,
    // `color-scheme: light`), so where a theme's own surface sits is measured by forcing the CODE-BLOCK token
    // to a dark value on the panel: the column must STILL come out brighter than the code surface (its own
    // bg-base does not move), and removing the override must put the reading straight back. A TOKEN OVERRIDE,
    // said plainly — not a claim that a dark theme was reachable.
    const forced = await page.evaluate(() => {
      const cell = document.querySelector('[data-diff-gutter]') as HTMLElement
      const panel = cell.closest('section') as HTMLElement | null
      if (panel === null) throw new Error('the panel root was not found above the gutter')
      const colour = (): string => getComputedStyle(cell).backgroundColor
      const surface = (): string => {
        let at: Element | null = document.querySelector('[data-diff-code]')
        while (at !== null) {
          const bg = getComputedStyle(at).backgroundColor
          if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
          at = at.parentElement
        }
        return ''
      }
      const before = { colour: colour(), surface: surface() }
      panel.style.setProperty('--dsw-alias-markdown-code-block', '#1e1e1e')
      const dark = { colour: colour(), surface: surface() }
      panel.style.removeProperty('--dsw-alias-markdown-code-block')
      return { before, dark, after: { colour: colour(), surface: surface() } }
    })
    expect(forced.before.colour, 'the reading above must be the shell\'s own theme').toBe(reading.gutter)
    // Two halves, both needed: the override really moved the CODE surface (otherwise this check proves
    // nothing), and the column did NOT move with it — it is the panel's own surface, not a function of the
    // code block, which is exactly why it cannot be dragged dark by the code's token.
    expect(forced.dark.surface, 'the token override must move the code surface, or this proves nothing')
      .not.toBe(forced.before.surface)
    expect(forced.dark.colour, 'the column is the panel\'s own surface and must not follow the code token')
      .toBe(forced.before.colour)
    const darkSurface = channelsOf(forced.dark.surface)
    const darkColumn = channelsOf(forced.dark.colour)
    expect(darkSurface, `the dark code surface must be readable, got ${forced.dark.surface}`).not.toBeNull()
    expect(darkColumn, `the dark column must be readable, got ${forced.dark.colour}`).not.toBeNull()
    // The same absolute direction dark, asserted the same way: never darker, strictly brighter on one.
    const darkAgainst = brightnessAgainst(
      darkColumn as { r: number, g: number, b: number },
      darkSurface as { r: number, g: number, b: number },
    )
    for (const [index, delta] of darkAgainst.deltas.entries()) {
      expect(delta, `with a dark code block the column must not be darker on ${['red', 'green', 'blue'][index]} (deltas ${darkAgainst.deltas.map(value => value.toFixed(2)).join('/')})`)
        .toBeGreaterThanOrEqual(0)
    }
    expect(darkAgainst.strictlyBrighter, 'with a dark code block the column must still be strictly brighter')
      .toBeGreaterThan(0)
    expect(forced.after, 'removing the override must restore the shell\'s own colour').toEqual(forced.before)

    // The column really is the pinned one, so what was measured is the cell the reader sees holding still.
    expect(reading.gutterPosition, 'the column must be pinned').toBe('sticky')
    expect(reading.gutterLeft, 'the first column pins at the panel edge').toBe('0px')

    // CONTRACT 2: the layers stay ON TOP of the lifted colour. The diff's own tint rides the pinned cell
    // (`--diff-row-tint`), so a changed row's numbers still read as part of their row...
    const byKind = (kind: string): Reading['rows'][number] | undefined => reading.rows.find(entry => entry.kind === kind)
    const context = byKind('context')
    const add = byKind('add')
    const del = byKind('del')
    expect(context, 'the seeded file must draw a context row').toBeTruthy()
    expect(add, 'the seeded file must draw an added row').toBeTruthy()
    expect(del, 'the seeded file must draw a deleted row').toBeTruthy()
    // A context row has no tint: both of its layers are transparent gradients.
    expect(context!.image, 'a context row\'s cell carries no tint').toContain('rgba(0, 0, 0, 0)')
    for (const changed of [add!, del!]) {
      expect(changed.image, `a ${changed.kind} row's cell must still carry its tint over the new colour`)
        .not.toBe(context!.image)
      expect(changed.image, `a ${changed.kind} row's tint must not be transparent`)
        .toMatch(/linear-gradient\((?!rgba\(0, 0, 0, 0\))/)
      // ...and the fill UNDER that tint is the same lifted colour, so the tint is a wash over the column
      // rather than a replacement for its surface.
      expect(changed.gutter, `a ${changed.kind} row's cell keeps the column's own surface`).toBe(reading.gutter)
    }
    // ...and the comment wash still covers the gutters of the rows it marks: the banded row's own wash
    // (a flat gradient on the row) is repainted by its cells, which is the second layer there.
    const banded = reading.rows.filter(entry => entry.band)
    expect(banded.length, 'the placeable thread must wash the rows it names').toBeGreaterThan(0)
    for (const entry of banded) {
      expect(entry.rowImage, 'the washed row paints its wash on the code side').toMatch(/linear-gradient\((?!rgba\(0, 0, 0, 0\))/)
      const layers = entry.image.split('), linear-gradient(').length
      expect(layers, 'a washed row\'s cell repaints the wash as a second layer over the tint').toBeGreaterThan(1)
      expect(entry.gutter, 'the wash is a layer, not a replacement: the column\'s surface is still under it')
        .toBe(reading.gutter)
    }
  })

  test('g2. 引用框的行号与文件同一底色，引用读起来像同一张表', async () => {
    test.setTimeout(120_000)
    // The quoted frame a card draws for an outdated thread reuses `.gutter` for its numbers, and the card
    // sits on the panel's own white rather than on the code block's surface. Left alone it read as a plain
    // two-column table beside the file's distinguished column; matched, a quote of these rows reads like
    // these rows. Its position is NOT shared (the card pins its own frame), only the colour.
    const reading = await read(page)
    expect(reading.quoteGutter, 'the outdated thread must draw its quoted frame').not.toBeNull()
    expect(isOpaque(reading.quoteGutter as string), `the quote's numbers must be opaque, got ${String(reading.quoteGutter)}`).toBe(true)
    expect(channelsOf(reading.quoteGutter as string), 'the quote must paint the file\'s own column colour')
      .toEqual(channelsOf(reading.gutter))
    // ...and it wears NO line either: the same no-line rule as the file's own numbers, so a shadow cannot
    // creep back in on one surface while the other stays clean.
    expect(reading.quoteBoxShadow, 'the quote\'s numbers must wear no line either').toBe('none')
  })

  test('g3. 设置里的差异预览复用同一条规则，画同一个底色', async () => {
    test.setTimeout(120_000)
    // The preview (SettingsTab) renders the real `.line`/`.gutter` classes on its own card, OUTSIDE the code
    // view — which is why the colour is declared on the panel rather than on `.diff`: a variable scoped to
    // the code view would leave the preview with no surface at all. That reuse is what this case reads back.
    const fileReading = await read(page)
    await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
    const settings = page.locator('[data-diff-settings]').first()
    await expect(settings).toBeVisible({ timeout: 30_000 })
    const header = settings.locator('> div > button').first()
    if (await header.evaluate(node => node.parentElement?.hasAttribute('data-open') !== true)) {
      await header.click({ timeout: 20_000 })
    }
    await expect(page.locator('[data-diff-view-preview]').first()).toBeVisible({ timeout: 20_000 })
    const previewReading = await read(page)
    expect(channelsOf(previewReading.previewGutter ?? ''), 'the preview\'s numbers must wear the same column surface')
      .toEqual(channelsOf(fileReading.gutter))
  })
})
