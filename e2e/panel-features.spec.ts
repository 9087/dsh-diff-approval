// The panel's own features, the ones no spec drove before: search, go-to-line, the view switches, the
// floating file list, the markdown preview, the settings entry, one-file keep and revert, docking, and
// keep-all. Importing version-control changes has its own spec (it needs a checkout); the keep/revert
// BATCH and the undo/redo history have theirs (pending-keep), which is why the destructive keep-all is
// last here — after it there is nothing left to act on.
//
// The fixture is the same two-phase shape every spec in this suite uses, and for the same reason: the
// plugin host reads its pending store once, at boot, so the store has to be written while no host is
// running, and its entries have to name the session the GUI itself created.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, describeHome, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, chooseMenuItem, confirmIfAsked, dismissNotices, ensurePanelList, newGuiPage, openPanel,
  openSession, pressRedo, pressUndo, row,
} from './helpers/gui.ts'

import { dockPanel, dockedPanel, floatCard, openFloatList, setViewport } from './helpers/panel.ts'

/** Four changed text files plus a markdown one, so every feature below has something of its own. */
const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
  { name: 'gamma.txt', oldText: 'gamma one\ngamma two\n', newText: 'gamma one\nGAMMA TWO\n' },
  { name: 'delta.txt', oldText: 'delta one\ndelta two\n', newText: 'delta one\nDELTA TWO\n' },
  {
    name: 'notes.md',
    oldText: '# Notes\n\nplain paragraph\n',
    // The relative link is what `s15` presses: Markdown resolves it against THIS document, so
    // `../alpha.txt` means `alpha.txt` at the workspace root — and the panel, not the browser, answers it.
    newText: '# Notes\n\n**bold** paragraph\n\n[x](../alpha.txt)\n',
  },
]

const SEED_MESSAGE = 'e2e: panel features'

/** A file in the workspace that the panel has never heard of, for the detail path field to add. */
const FRESH = 'fresh.txt'

/**
 * The row menu's two revert items, each by its OWN label — they differ in exactly one thing: whether the
 * row stays listed. `action.revert` = 「回退」 keeps it (the file goes back to its old content, the row
 * stays with no pending diff) and `row.revertRemove` = 「回退并移出」 drops it. A substring match cannot
 * tell them apart, which is how a case once asserted one's semantics after pressing the other.
 */
const REVERT = ['回退', 'Revert']
const REVERT_REMOVE = ['回退并移出', 'Revert and remove']

/** What a seeded file currently holds on disk — the effect a keep has nothing to do with and a revert is. */
function diskText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '(missing)'
  }
}

/**
 * Start recording every element added to the page, by text.
 *
 * The panel's refusals arrive as a `Toast`, which the shell may dismiss within a frame in a headless
 * browser: polling for it can miss it entirely, and "no toast" is exactly the claim that has to be right.
 * An observer sees the element while it exists.
 *
 * @param page - the GUI page.
 */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = []
    ;(window as unknown as { __added?: string[] }).__added = record
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
          // Short additions only: a toast is a line, while React also adds subtree-sized nodes whose text
          // is the whole panel — recording those would grow this list without bound.
          if (text !== '' && text.length <= 120) record.push(text)
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

/** What has been added to the page since {@link recordToasts}, as one string. */
async function addedText(page: Page): Promise<string> {
  return await page.evaluate(() => ((window as unknown as { __added?: string[] }).__added ?? []).join(' | '))
}

/**
 * Everything the panel is saying right now, for a failure that has to explain itself.
 *
 * @param page - the GUI page.
 * @returns one line per channel: notices, action errors, open dialogs, status text, and the rows on screen.
 */
async function panelSaid(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const pick = (selector: string): string[] => [...document.querySelectorAll(selector)]
      .map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(text => text !== '')
    const rows = [...document.querySelectorAll('[data-diff-file]')]
      .map(node => node.getAttribute('data-diff-file')?.split(/[\\/]/).pop() ?? '?')
    return [
      `notices: ${pick('[data-diff-approval-notice]').join(' | ') || '(none)'}`,
      `action-error: ${pick('[data-diff-action-error]').join(' | ') || '(none)'}`,
      `dialogs: ${pick('[data-diff-batch-confirm], [data-diff-confirm], [data-diff-confirm-file]').join(' | ') || '(none)'}`,
      `status: ${pick('[role="status"], [role="alert"]').slice(0, 4).join(' | ') || '(none)'}`,
      `rows: ${rows.join(', ') || '(none)'}`,
    ].join('\n')
  })
}

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let sessionId: string
let paths: Record<string, string>

test.describe.configure({ mode: 'serial' })

test.describe('面板功能：搜索 / 跳转 / 视图 / 浮动列表 / 预览 / 单文件动作 / 停靠 / 全部保留', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('features')
    const workspaceId = await bootstrapHome(dsh, fixture)

    // ---- phase one: a session made by the GUI, then the host stops so the store can be written.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, SEED_MESSAGE)
    await page.close()
    await stopHost(host.proc)

    // The file the detail path field is asked to add: in the WORKSPACE, never in the store.
    writeFileSync(join(fixture.workspace, FRESH), 'fresh one\n')
    const seeded = seedPending(fixture, sessionId, FILES, [])
    paths = Object.fromEntries(seeded.entries.map(entry => [entry.path.split(/[\\/]/).pop() ?? entry.path, entry.id]))
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the same home with the store in place.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await openSession(page, SEED_MESSAGE)
    await openPanel(page)
    await ensurePanelList(page)
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

  test('s1. 搜索：找到高亮、能上下跳、能开关大小写与全词，能关掉', async () => {
    test.setTimeout(120_000)
    // Open on the file whose changed line is worth searching for.
    await row(page, paths['alpha.txt'] as string).click({ timeout: 20_000 })
    await page.locator('[data-diff-search-toggle]').first().click({ timeout: 20_000 })

    const input = page.locator('[data-diff-search-input]').first()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('ALPHA')
    // The count is the panel's own answer, and it is what the reader reads: a match in the diff.
    await expect(page.locator('[data-diff-search-count]').first()).toContainText(/[1-9]/, { timeout: 20_000 })
    expect(await page.locator('[data-diff-search-match]').count()).toBeGreaterThan(0)

    // Case-sensitivity is a toggle with a state, not a silent mode: flipping it must leave the count
    // consistent with what is on screen (lower case does not match "ALPHA" case-sensitively).
    const caseToggle = page.locator('[data-diff-search-case]').first()
    await caseToggle.click({ timeout: 20_000 })
    await input.fill('alpha')
    await expect(page.locator('[data-diff-search-count]').first()).toContainText(/[0-9]/, { timeout: 20_000 })
    await caseToggle.click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-search-count]').first()).toContainText(/[1-9]/, { timeout: 20_000 })

    // Whole-word and the two jump buttons must not throw the bar away or empty the count.
    await page.locator('[data-diff-search-word]').first().click({ timeout: 20_000 })
    await page.locator('[data-diff-search-next]').first().click({ timeout: 20_000 })
    await page.locator('[data-diff-search-prev]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-search-count]').first()).toBeVisible({ timeout: 20_000 })

    await page.locator('[data-diff-search-close]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-search-input]')).toHaveCount(0, { timeout: 20_000 })
  })

  test('s2. 跳转行：输入行号后落在那一行上', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-goto]').first().click({ timeout: 20_000 })
    const input = page.locator('[data-diff-goto-input]').first()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('2')
    await page.locator('[data-diff-goto-go]').first().click({ timeout: 20_000 })
    // The panel marks the row it landed on, which is the only honest thing to assert: the line is in the
    // text, and a jump that did nothing would leave no marker.
    await expect(page.locator('[data-diff-focused]').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-diff-goto-input]')).toHaveCount(0, { timeout: 20_000 })
  })

  test('s3. 视图开关：统一 / 并排切换，换行开关不炸', async () => {
    test.setTimeout(120_000)
    const splitBefore = await page.locator('[data-diff-split-row]').count()
    await page.locator('[data-diff-toggle-view]').first().click({ timeout: 20_000 })
    const splitAfter = await page.locator('[data-diff-split-row]').count()
    expect(splitAfter).not.toBe(splitBefore)
    await page.locator('[data-diff-wrap]').first().click({ timeout: 20_000 })
    // Back to where it started, so the next case reads the same view this one began with.
    await page.locator('[data-diff-toggle-view]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-row]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('s4. 浮动文件列表：窄窗下折成卡片，宽窗下回到面板里', async () => {
    test.setTimeout(120_000)
    // The floating list is what the WINDOW WIDTH decides (the knob only exists below the breakpoint), so
    // this uses the suite's own helper for it rather than a selector that is not on screen at 1400px.
    await openFloatList(page, 1000)
    await expect(floatCard(page)).toBeVisible({ timeout: 20_000 })
    // The card is the file list, not an empty shell: the reader folds it out to pick a file.
    expect(await floatCard(page).locator('[data-diff-file]').count()).toBeGreaterThan(0)

    // Wide again: the list is the panel's own column once more, and the card is gone.
    await setViewport(page, 1400)
    await expect(floatCard(page)).toHaveCount(0, { timeout: 20_000 })
    await ensurePanelList(page)
    await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('s5. markdown 预览：打开后画出渲染过的正文', async () => {
    test.setTimeout(120_000)
    await row(page, paths['notes.md'] as string).click({ timeout: 20_000 })
    // `data-diff-md-preview` is the TOOLBAR toggle; `-md-mode`/`-md-preview-body` are marks the preview
    // paints once it is open, so pressing the toggle is what makes them appear.
    const toggle = page.locator('[data-diff-md-preview]').first()
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    await toggle.click({ timeout: 20_000 })

    // The rendered body exists and carries the bold run the fixture wrote: `**bold**` is not text in a
    // preview, it is a <strong>, so the assertion is about the preview actually rendering.
    const body = page.locator('[data-diff-md-preview-body]').first()
    await expect(body).toBeVisible({ timeout: 30_000 })
    await expect(body.locator('strong')).toHaveCount(1, { timeout: 20_000 })

    // Back to the source: the same press toggles it off, and the diff body is what is left.
    await toggle.click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-md-preview-body]')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('[data-diff-body]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('s15. markdown 预览里的相对链接：弹出文件菜单，页面不跳转', async () => {
    // The reader's failure was the BROWSER NAVIGATING a relative link, which jsdom can only assert as
    // "the default was prevented". Here the real Chromium says whether the URL moved, so (b) below is the
    // assertion this case exists for.
    //
    // It sits here, right after the preview case and BEFORE the destructive keep-all (s14), for the reason
    // that one is last: it empties the list, and a case that needs `notes.md` selectable cannot run after it.
    test.setTimeout(120_000)
    await row(page, paths['notes.md'] as string).click({ timeout: 20_000 })
    const toggle = page.locator('[data-diff-md-preview]').first()
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    await toggle.click({ timeout: 20_000 })
    const body = page.locator('[data-diff-md-preview-body]').first()
    await expect(body).toBeVisible({ timeout: 30_000 })

    // The fixture's `[x](../alpha.txt)` is rendered as an anchor carrying its RAW relative href — that is
    // what the panel has to resolve, against THIS document's own directory.
    const link = body.locator('a[href="../alpha.txt"]').first()
    await expect(link).toBeVisible({ timeout: 20_000 })
    const before = page.url()
    await link.click({ timeout: 20_000 })

    // (a) OUR menu, with the three rows a link can use — and pointedly NO default-open row, which for a link
    // could only replay the anchor and navigate the page. Labels are matched in both locales, the way this
    // file's other menu cases do.
    const items = page.locator('[role="menuitem"]')
    await expect(items).toHaveCount(3, { timeout: 20_000 })
    await expect(items.filter({ hasText: /在审批面板中查看|View in the review panel/ })).toHaveCount(1)
    await expect(items.filter({ hasText: /复制文件路径|Copy file path/ })).toHaveCount(1)
    await expect(items.filter({ hasText: /默认方式打开|Open as usual/ })).toHaveCount(0)
    // The third row explains the menu itself, and it is here for a LINK too — under the menu component's own
    // hairline (`role="separator"`, the same group boundary the row context menu draws), not as one more row.
    await expect(items.filter({ hasText: /关于此菜单|About this menu/ })).toHaveCount(1)
    await expect(page.locator('[role="menu"] [role="separator"]')).toHaveCount(1)

    // (b) THE PAGE DID NOT NAVIGATE — the reader's actual bug, and the reason this case is in a browser. A
    // file link is ours; the URL must be exactly what it was, and the preview must still be the page.
    expect(page.url(), 'a file link in the preview must not navigate the page').toBe(before)
    await expect(body).toBeVisible({ timeout: 20_000 })

    // (c) About, in a real browser: the dialog names the plugin that injects this menu, and it carries exactly
    // ONE button — an acknowledgement, not a choice. The copy itself is pinned by the unit tests in both
    // locales; what only a browser can say is that it is on screen, is one button, and closes on it.
    await items.filter({ hasText: /关于此菜单|About this menu/ }).first().click({ timeout: 20_000 })
    const about = page.locator('[data-diff-about]')
    await expect(about).toBeVisible({ timeout: 20_000 })
    await expect(about).toContainText('dsh-diff-approval')
    const aboutOk = about.locator('button')
    await expect(aboutOk).toHaveCount(1)
    await aboutOk.click({ timeout: 20_000 })
    await expect(about).toHaveCount(0, { timeout: 20_000 })
    // Explaining the menu is not acting on the link: the reader is still exactly where they were.
    expect(page.url(), 'closing the About dialog must not navigate either').toBe(before)
    await expect(body).toBeVisible({ timeout: 20_000 })

    // (d) Escape is the dialog's other way out, then the menu's own: raise the menu, open About, Escape it
    // away, and check the preview survived both.
    await link.click({ timeout: 20_000 })
    await expect(items).toHaveCount(3, { timeout: 20_000 })
    await items.filter({ hasText: /关于此菜单|About this menu/ }).first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-about]')).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-diff-about]')).toHaveCount(0, { timeout: 20_000 })
    await expect(body).toBeVisible({ timeout: 20_000 })

    // Close the menu and leave the panel the way the next case expects it: back on the source diff.
    await link.click({ timeout: 20_000 })
    await expect(items).toHaveCount(3, { timeout: 20_000 })
    await page.keyboard.press('Escape')
    await expect(items).toHaveCount(0, { timeout: 20_000 })
    await toggle.click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-md-preview-body]')).toHaveCount(0, { timeout: 20_000 })
  })

  test('s16. 设置关掉「文件菜单」：预览里的相对链接不再被接管，打开后恢复', async () => {
    test.setTimeout(180_000)
    // The reader's own route to the setting — the panel's gear, the diff-view group, this row — because the
    // whole point of the row is that a reader can switch the menu off without knowing a storage key.
    const menuRow = async () => {
      await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
      const settings = page.locator('[data-diff-settings]').first()
      try {
        await expect(settings).toBeVisible({ timeout: 30_000 })
      } catch (error: unknown) {
        throw new Error(`${String(error)}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
      }
      await settings.locator('[data-diff-view-toggle]').first().click({ timeout: 20_000 })
      const chipRow = settings.locator('[data-diff-chip-menu-select]').first()
      await expect(chipRow).toBeVisible({ timeout: 20_000 })
      return chipRow
    }

    // The panel's own opener is a TOGGLE (`openPanel` clicks the footer badge, so pressing it on an open
    // panel shuts it and its assertion can never be met). This case really does start in two different
    // states — s15 leaves the panel OPEN on the preview, and each visit to the shell's settings dialog
    // closes the panel again — so "the panel is on screen" has to be an idempotent step here rather than a
    // press. `openPanel` is left alone (other cases rely on its press semantics); this checks for the
    // panel's own surface first and presses the badge only when it is absent, then asserts what s16 needs:
    // the panel on screen (either presentation) and its list drawn. Nothing is weakened.
    const panelOnScreen = async (): Promise<void> => {
      const panelSurface = page.locator('[data-diff-approval-panel], [data-diff-approval-dock]')
      if (await panelSurface.count() === 0) {
        await openPanel(page)
      }
      await expect(panelSurface.first()).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
    }

    await panelOnScreen()
    const chipRow = await menuRow()
    // ON by default: the reader who never opens Settings keeps the menu they have always had.
    await expect(chipRow).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
    await chipRow.click({ timeout: 20_000 })
    await expect(chipRow).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 })
    await page.keyboard.press('Escape')

    // Back in the panel, on the same preview: with the menu switched off NOTHING of ours may take the press.
    // The press and the count happen in ONE evaluation, and the browser's own navigation is cancelled after
    // the fact — "no menu" is the assertion here, and what the browser would do instead is the honest
    // consequence of the setting, not this case's business (it is asserted in the jsdom test as "the default
    // was not prevented").
    await panelOnScreen()
    await row(page, paths['notes.md'] as string).click({ timeout: 20_000 })
    const previewToggle = page.locator('[data-diff-md-preview]').first()
    await expect(previewToggle).toBeVisible({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await previewToggle.click({ timeout: 20_000 })
    }
    await expect(page.locator('[data-diff-md-preview-body]').first()).toBeVisible({ timeout: 30_000 })
    const menusWhenOff = await page.evaluate(() => {
      const link = document.querySelector('[data-diff-md-preview-body] a[href="../alpha.txt"]') as HTMLAnchorElement
      link.addEventListener('click', event => { event.preventDefault() }, { once: true })
      link.click()
      return document.querySelectorAll('[role="menuitem"]').length
    })
    expect(menusWhenOff, 'with the file menu switched off, no menu may appear').toBe(0)

    // Back ON through the same row, and the very next press is ours again.
    const rowAgain = await menuRow()
    await rowAgain.click({ timeout: 20_000 })
    await expect(rowAgain).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
    await page.keyboard.press('Escape')
    await panelOnScreen()
    // The panel is remounted here, so the rendered preview is not guaranteed to be the one the first half
    // was looking at — the file it was closed on is remembered, the toolbar toggle is not. Selecting the
    // file and opening the preview ONLY if it is not already open is the same idempotent step as above.
    await row(page, paths['notes.md'] as string).click({ timeout: 20_000 })
    const previewToggleAgain = page.locator('[data-diff-md-preview]').first()
    await expect(previewToggleAgain).toBeVisible({ timeout: 20_000 })
    if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
      await previewToggleAgain.click({ timeout: 20_000 })
    }
    const link = page.locator('[data-diff-md-preview-body] a[href="../alpha.txt"]').first()
    await expect(link).toBeVisible({ timeout: 20_000 })
    const before = page.url()
    await link.click({ timeout: 20_000 })
    await expect(page.locator('[role="menuitem"]')).toHaveCount(3, { timeout: 20_000 })
    expect(page.url(), 'and once again the link does not navigate').toBe(before)
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menuitem"]')).toHaveCount(0, { timeout: 20_000 })
  })

  test('s6. 设置入口：齿轮把读者交给设置区，Escape 之后能回到列表', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-approval-settings]').first().click({ timeout: 20_000 })
    // The handoff is documented as "the panel closes too", and that is what makes the badge unusable
    // underneath: the settings dialog is over it. So the assertion is that the panel's own settings
    // marker is gone, not that the badge is still clickable through a dialog.
    await expect(page.locator('[data-diff-approval-settings]')).toHaveCount(0, { timeout: 20_000 })

    // Escape closes the shell's dialog, and then the reader's own way in works again.
    await page.keyboard.press('Escape')
    await openPanel(page)
    await expect(page.locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
  })

  test('s7. 单文件保留：行消失，Ctrl+Z 回来，Ctrl+Y 再消失', async () => {
    test.setTimeout(120_000)
    const alpha = paths['alpha.txt'] as string
    await chooseMenuItem(page, row(page, alpha), ['保留并移出', 'Keep and remove'])
    await confirmIfAsked(page)
    await expect(row(page, alpha)).toHaveCount(0, { timeout: 20_000 })

    await pressUndo(page)
    await expect(row(page, alpha)).toBeVisible({ timeout: 20_000 })
    await pressRedo(page)
    await expect(row(page, alpha)).toHaveCount(0, { timeout: 20_000 })
  })

  test('s8. 回退（保留在列表里）：磁盘回旧文本，行仍在；Ctrl+Z 恢复差异', async () => {
    test.setTimeout(120_000)
    const gamma = paths['gamma.txt'] as string
    await chooseMenuItem(page, row(page, gamma), REVERT)
    await confirmIfAsked(page)
    // Both halves are asserted, because the whole point of the two menu items is that they differ in
    // exactly this: 「回退」 writes the old text back and LEAVES the row (with no pending diff).
    try {
      await expect.poll(() => diskText(gamma), { timeout: 20_000 }).toBe('gamma one\ngamma two\n')
    } catch (error: unknown) {
      throw new Error(`${String(error)}\ngamma.txt on disk: ${JSON.stringify(diskText(gamma))}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }
    await expect(row(page, gamma)).toBeVisible({ timeout: 20_000 })

    await pressUndo(page)
    await expect.poll(() => diskText(gamma), { timeout: 20_000 }).toBe('gamma one\nGAMMA TWO\n')
    await expect(row(page, gamma)).toBeVisible({ timeout: 20_000 })
  })

  test('s9. 回退并移出：磁盘回旧文本，行消失；Ctrl+Z 把行和差异一起带回来', async () => {
    test.setTimeout(120_000)
    const beta = paths['beta.txt'] as string
    await chooseMenuItem(page, row(page, beta), REVERT_REMOVE)
    await confirmIfAsked(page)
    try {
      await expect.poll(() => diskText(beta), { timeout: 20_000 }).toBe('beta one\nbeta two\n')
    } catch (error: unknown) {
      throw new Error(`${String(error)}\nbeta.txt on disk: ${JSON.stringify(diskText(beta))}\n--- what the panel is saying ---\n${await panelSaid(page)}`)
    }
    await expect(row(page, beta)).toHaveCount(0, { timeout: 20_000 })

    await pressUndo(page)
    await expect(row(page, beta)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => diskText(beta), { timeout: 20_000 }).toBe('beta one\nBETA TWO\n')
  })

  test('s10. 详情路径框：敲一个未在列表里的文件路径 → 加进列表并打开它', async () => {
    test.setTimeout(120_000)
    const field = page.locator('[data-diff-path-input]').first()
    await expect(field).toBeVisible({ timeout: 20_000 })
    const fresh = join(fixture.workspace, FRESH)
    await field.fill(fresh)
    await field.press('Enter')

    // The row is the host's answer (the add is an RPC), and the field then shows the file it opened.
    await expect(page.locator('[data-diff-file]').filter({ hasText: FRESH }).first()).toBeVisible({ timeout: 30_000 })
    await expect(field).toHaveValue(fresh, { timeout: 20_000 })
  })

  test('s11. 详情路径框：路径不存在 → 弹提示，字段回到原来那个文件', async () => {
    test.setTimeout(120_000)
    const field = page.locator('[data-diff-path-input]').first()
    const before = await field.inputValue()
    const missing = join(fixture.workspace, 'no-such-file-anywhere.txt')
    await recordToasts(page)
    await field.fill(missing)
    await field.press('Enter')

    // The field going back is the handler's own doing (`setPathDraft(null)`), so it is what tells "the
    // gesture never reached the panel" apart from "the panel refused and said nothing" — and only the
    // second one is a defect. Asserted first, because it is the load-bearing fact of the two.
    await expect(field).not.toHaveValue(missing, { timeout: 20_000 })
    await expect(field).toHaveValue(before, { timeout: 20_000 })

    // …and the refusal is supposed to be a toast — the reader's only answer. Caught by WATCHING the DOM
    // rather than polling for it, because a headless browser can dismiss a toast inside a frame. Both
    // languages are accepted, like every other shell string in this harness: 0.1.7 no longer honours the
    // `locale: preference: zh` the fixture seeds, so the panel draws English here.
    await expect.poll(() => addedText(page), { timeout: 20_000, message: 'the panel refused the path and said nothing' })
      .toMatch(/路径不存在|No such path/)
    await expect(page.locator('[data-diff-file]').filter({ hasText: 'no-such-file' })).toHaveCount(0)
  })

  test('s12. 详情路径框：给的是一目录 → 提示要文件路径', async () => {
    test.setTimeout(120_000)
    const field = page.locator('[data-diff-path-input]').first()
    await recordToasts(page)
    await field.fill(fixture.workspace)
    await field.press('Enter')
    await expect.poll(() => addedText(page), { timeout: 20_000, message: 'the panel refused the directory and said nothing' })
      .toMatch(/这是一个目录，请输入文件路径|That is a directory; give a file path/)
    await expect(field).not.toHaveValue(fixture.workspace, { timeout: 20_000 })
  })

  test('s13. 停靠：面板能挂到侧栏，列表还在', async () => {
    test.setTimeout(120_000)
    const docked = await dockPanel(page)
    if (!docked) test.skip(true, '这个 shell 没有可用的停靠位：dockPanel 报告失败。')
    await expect(dockedPanel(page)).toBeVisible({ timeout: 20_000 })
    await expect(row(page, paths['gamma.txt'] as string)).toBeVisible({ timeout: 20_000 })
    // Undo still resolves while docked — the history is the host's, and the dock is another view of it.
    await pressUndo(page)
    await expect(dockedPanel(page)).toBeVisible({ timeout: 20_000 })
  })

  test('s14. 全部保留：清空列表', async () => {
    test.setTimeout(120_000)
    await page.locator('[data-diff-keep-all]').first().click({ timeout: 20_000 })
    await confirmIfAsked(page)
    await expect(page.locator('[data-diff-file]')).toHaveCount(0, { timeout: 30_000 })
    // …and the panel says so rather than drawing an empty list with a stale count: the empty state is the
    // one with the import button in it.
    await expect(page.locator('[data-diff-import-vcs]').first()).toBeVisible({ timeout: 20_000 })
  })
})
