/**
 * Review-panel actions the two newer specs need on top of `gui.ts`: the floating
 * file list (the narrow presentation), the mode switch that docks the panel, a
 * comment written on a diff selection, and the notices the panel shows.
 *
 * Everything here addresses the panel through the `data-diff-*` hooks the panel
 * publishes for exactly this use. Nothing reaches into the store or the disk to
 * make a state appear: the comment below is typed into the panel's own field and
 * sent with its own button, which is the point of the test that uses it.
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { setTimeout as sleep } from 'node:timers/promises'
import { row } from './gui.ts'

/** Every name the mode switch's dock row is known to carry. */
export const DOCK_MENU_ITEM = ['停靠到右侧边栏', 'Dock in the right sidebar']
/** Every name the row menu's keep item is known to carry (one file, no batch). */
export const KEEP = ['保留', 'Keep']

/** Resize the page: the floating file list is what the window width decides. */
export async function setViewport(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height })
  await sleep(800)
}

/** The floating file list card, drawn only while the list is folded out over the diff. */
export function floatCard(page: Page): Locator {
  return page.locator('[data-diff-floating-file-list]').first()
}

/** The knob on the panel's edge that folds the floating list out and away. */
export function floatToggle(page: Page): Locator {
  return page.locator('[data-diff-file-list-toggle]').first()
}

/**
 * Get the floating file list on screen: narrow the window until the list's
 * breakpoint folds it, and open the card with the knob if it is folded away.
 *
 * The card is what every "a press on the list's own confirm must not fold this"
 * assertion is about, so it has to really be there.
 */
export async function openFloatList(page: Page, width = 1000): Promise<void> {
  await setViewport(page, width)
  await expect(floatToggle(page)).toBeVisible({ timeout: 20_000 })
  if (!await floatCard(page).isVisible()) {
    await floatToggle(page).click({ timeout: 20_000 })
  }
  await expect(floatCard(page)).toBeVisible({ timeout: 20_000 })
  await expect(floatCard(page).locator('[data-diff-file]').first()).toBeVisible({ timeout: 20_000 })
}

/** Open a row's context menu and leave it open (no item picked). */
export async function openRowMenu(page: Page, target: Locator): Promise<Locator> {
  await target.click({ button: 'right', timeout: 20_000 })
  const menu = page.locator('[role="menu"]').first()
  await expect(menu).toBeVisible({ timeout: 20_000 })
  return menu
}

/**
 * Switch the panel's presentation with its own mode switch — the panel's header
 * control, then the row. The dock is only offered by a build whose right sidebar
 * is mounted, so a window with no sidebar reports that rather than a dock.
 *
 * The press is retried: the menu, the row and the sidebar's tab body are three
 * separate frames, and a press that lands while one of them is still coming up can
 * be swallowed by the tab drag the sidebar puts on its chip.
 *
 * @returns whether the dock row was there to pick (a "no right sidebar" toast otherwise).
 */
export async function dockPanel(page: Page): Promise<boolean> {
  const trigger = page.locator('[data-diff-approval-presentation][data-diff-approval-presentation-host="header"]').first()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await dockedPanel(page).isVisible()) return true
    await expect(trigger).toBeVisible({ timeout: 20_000 })
    await trigger.click({ timeout: 20_000 })
    const item = page.locator('[role="menuitem"]')
      .filter({ hasText: new RegExp(DOCK_MENU_ITEM.join('|')) })
      .first()
    if (await item.count() === 0) return false
    await item.click({ timeout: 20_000 })
    await sleep(2500)
  }
  return true
}

/** The panel's docked instance: it carries `data-diff-docked` and lives in the sidebar. */
export function dockedPanel(page: Page): Locator {
  return page.locator('[data-diff-approval-panel][data-diff-docked]').first()
}

/** The panel, wherever it is showing (overlay or sidebar tab). */
export function panel(page: Page): Locator {
  return page.locator('[data-diff-approval-panel]').first()
}

/**
 * Select a range of the open file's diff by dragging across its code lines.
 *
 * A drag is the interaction the selection actually is: the panel derives the row
 * range from the browser's own selection, so a synthetic `Selection` would be
 * testing the test. The pointer lands on the character the row range is meant to
 * start and end at — measured from the line's own box — because the panel reads a
 * boundary that sits exactly at a line edge as no content at all (see `rowRangeOf`),
 * so a drag that stops a pixel short would select one line and not two.
 *
 * The anchors are the SECOND character of the first line and the LAST character of
 * the last line: both are inside their line, neither is an edge.
 *
 * @returns the selected text, read from the live selection before the toolbar is pressed.
 */
export async function selectDiffRows(page: Page, from: number, to: number): Promise<string> {
  const point = async (index: number, atEnd: boolean): Promise<{ x: number; y: number }> => {
    const box = await page.evaluate(({ rowIndex, end }) => {
      const code = document.querySelectorAll<HTMLElement>('[data-diff-code]')[rowIndex]
      if (code === undefined) return null
      const rect = code.getBoundingClientRect()
      const width = rect.width / Math.max(1, (code.textContent ?? '').length)
      return { x: rect.left + (end ? width * ((code.textContent ?? '').length - 0.5) : width * 1.5), y: rect.top + rect.height / 2 }
    }, { rowIndex: index, end: atEnd })
    if (box === null) throw new Error(`the diff has no code line at index ${index}`)
    return box
  }
  const start = await point(from, false)
  const end = await point(to, true)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
  await sleep(700)
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

/** The comment button the selection toolbar offers (it only exists while a range is selected). */
export function selectionCommentButton(page: Page): Locator {
  return page.locator('[data-diff-selection-comment]').first()
}

/** The empty field of a freshly placed comment block. */
export function discussionInput(page: Page): Locator {
  return page.locator('[data-diff-discussion-input]').first()
}

/** The send button of that same block. */
export function discussionSend(page: Page): Locator {
  return page.locator('[data-diff-discussion-send]').first()
}

/**
 * Write one comment the way a reviewer does: select diff rows, press the toolbar's
 * comment button, type into the block's field, and send it.
 *
 * The drag is retried. The panel measures the diff's rows in a layout pass that runs
 * after the file mounts and again after any content above the code view changes, so a
 * drag aimed at the first frame's geometry can land on the wrong row and select
 * nothing — the panel derives the range from what the browser REALLY selected, and an
 * empty or single-row selection offers no comment button at all. Re-measuring and
 * dragging again is what makes that a wait rather than a flake.
 *
 * Nothing here writes to the plugin's comment store: the field and the send button
 * are the panel's own, and the comment only exists because the host took it.
 *
 * @returns the text that was written.
 */
export async function writeComment(page: Page, from: number, to: number, text: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selected = await selectDiffRows(page, from, to)
    if (selected.trim() !== '' && await selectionCommentButton(page).isVisible()) break
    if (attempt === 3) {
      // A range that already carries a comment gets no second one (the panel refuses an
      // overlap), and the drag would be re-tried forever for a test's own mistake: say
      // which of the two it is, because they need different fixes.
      const carrying = await discussionRows(page)
      throw new Error(
        `no comment button after ${attempt + 1} drags over rows ${from}..${to}: the last drag selected `
        + `${JSON.stringify(selected)}; the blocks on screen are ${JSON.stringify(carrying)}`,
      )
    }
    await sleep(1500)
  }
  await selectionCommentButton(page).click({ timeout: 20_000 })
  await expect(discussionInput(page)).toBeVisible({ timeout: 20_000 })
  await discussionInput(page).click({ timeout: 20_000 })
  await discussionInput(page).type(text, { delay: 15 })
  await discussionSend(page).click({ timeout: 20_000 })
  return text
}

/** What each comment block on screen says its range is, for a failure message that can tell them apart. */
async function discussionRows(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('[data-diff-discussion]')]
    .map(node => node.querySelector('[data-diff-discussion-range]')?.textContent ?? '?'))
}

/** Everything the panel is saying in a toast/notice right now, as one string. */
export async function noticesText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
}

/** Whether the row for this file id is on screen in the file list. */
export function fileRow(page: Page, id: string): Locator {
  return row(page, id)
}

/** Wait until a row is gone, letting the list re-read first. */
export async function expectRowGone(page: Page, id: string): Promise<void> {
  await expect(row(page, id)).toHaveCount(0, { timeout: 30_000 })
}
