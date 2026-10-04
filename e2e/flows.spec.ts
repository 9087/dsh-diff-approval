/**
 * Real-browser E2E: the two main flows — writing a comment, and what a host restart
 * keeps.
 *
 * Both flows are the real interactions. The comment is typed into the panel's own
 * compose row and sent with its own button, against a selection made by dragging over
 * the diff's own lines; nothing in this file writes to the plugin's comment store to
 * make a comment appear. The restart is `stopHost` + `startHost` on the SAME throwaway
 * `DSH_HOME`, which is what a user does when they quit and reopen the app.
 *
 * The undo stack's boundary is asserted where it was measured, not guessed: the stack
 * lives in the host process, so a page reload on the same host still has it (a comment
 * written and then Ctrl+Z'd on the reloaded page really goes away), while a host
 * restart has nothing left — Ctrl+Z after the restart changes nothing and the comment
 * is still in the store afterwards.
 */

import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  bootstrapHome, claimSession, describeHome, makeFixture, resolveDsh, seedPending, startHost, stopHost,
  type DshCommand, type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import {
  beginSession, CLOSE_COMMENT, describeSidebar, describeTitleMatches, dismissNotices, ensurePanelList, footerBadge,
  identityHits, identitySelectors, landingProbe, newGuiPage, openPanel, panelState, pressUndo, row, rowControlOf,
  sessionRowSelector, sessionRows, titleMatches, waitForCurrentSession, waitForShellReady, watchLanding,
} from './helpers/gui.ts'
import { openFloatList, noticesText, writeComment } from './helpers/panel.ts'

const FILES: SeededFile[] = [
  { name: 'alpha.txt', oldText: 'alpha one\nalpha two\n', newText: 'alpha one\nALPHA TWO\n' },
  { name: 'beta.txt', oldText: 'beta one\nbeta two\n', newText: 'beta one\nBETA TWO\n' },
]

const SEED_MESSAGE = 'e2e-flow: seed this session'
/** The words this suite writes; also how the restarted GUI names the session. */
const COMMENT_TEXT = 'e2e flow comment'

/**
 * Every comment the plugin has written down, as text.
 *
 * Read from the plugin's own store rather than from the page, so an assertion about a
 * comment existing is an assertion about the host's answer and not about a rendering.
 */
function commentStore(home: string): string {
  const dir = join(home, 'diff-approval', 'comments')
  if (!existsSync(dir)) return '(no comments directory)'
  const files = readdirSync(dir)
  if (files.length === 0) return '(no comment file)'
  return files.map(name => `${name}: ${readFileSync(join(dir, name), 'utf8')}`).join('\n')
}

/** Whether the plugin's store currently holds this many comments. */
function commentCount(home: string): number {
  const text = commentStore(home)
  if (!text.includes('"comments"')) return 0
  return text.match(/"id":"/g)?.length ?? 0
}

let dsh: DshCommand
let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
let paths: Record<string, string>

test.describe.configure({ mode: 'serial' })

/**
 * What the current fresh page threw and what it asked the host, for a landing that fails.
 *
 * Collected from before the page's first byte (`openFreshPage` wires the listeners onto the new page):
 * `pageErrors` holds page errors and console errors, `apiTraffic` the `/api/**` replies it got. Both are
 * cleared per page, because evidence from an earlier page says nothing about this one.
 */
let pageErrors: string[] = []
let apiTraffic: string[] = []
/** How many console errors this page produced, kept apart from the bounded `pageErrors` list. */
let consoleErrorCount = 0
/** The session `beforeAll` created and seeded — the identity the landing presses, if the shell shows it. */
let seededSessionId = ''
/** The workspace's sidebar title, so a landing can tell its row from a session's. */
let workspaceName = ''

/**
 * Boot a fresh page on the current host and open the seeded session's panel.
 *
 * The session is picked by the comment's own words once there is one: after a restart
 * the GUI names the session from its first message — which for the restarted runs here
 * is the comment this suite wrote — and the seed message is no longer on screen.
 *
 * @param tag - what a page error is labeled with, so a failure names which page threw.
 */
/** How long a drawn page gets to be current on its own before the landing looks for a row to press. */
const LANDING_INSTANT_MS = 1_000
/** How long a drawn page gets to OFFER something to press (`pressTarget`'s row). */
const LANDING_ROW_DEADLINE_MS = 25_000
/** How long the badge gets to confirm a press, once one has been made. */
const LANDING_CONFIRM_MS = 10_000

/** The row a landing press would use, and what the press would land on. */
interface PressTarget {
  /** WHICH candidate found it, so a failure can name the one that did not work. */
  which: 'identity' | 'structure' | 'comment' | 'seed'
  /** How to describe it in a log or a failure. */
  describe: string
  /** What to click: the row's own control, or the matched node when nothing encloses it. */
  target: Locator
}

/** The texts a text candidate may match, in the order the landing has always tried them. */
const TEXT_CANDIDATES: { which: 'comment' | 'seed', text: string }[] = [
  { which: 'comment', text: COMMENT_TEXT },
  { which: 'seed', text: SEED_MESSAGE },
]

/** Whether a row's own text says it is the shell's provisional blank session rather than a real one. */
function isProvisional(text: string): boolean {
  return /^\s*(新会话|new session)/i.test(text)
}

/**
 * The session rows this landing may press, in preference order, as finders rather than as presses.
 *
 *   1. IDENTITY — the seeded session's own id. Measured on the live shell, a session-list item carries
 *      `data-row-key="session:<id>"`, and it carries it BEFORE a session is current as well as after. This
 *      is the only candidate a changed TITLE cannot defeat: the flake this fixes was a row whose text had
 *      become `[评论] (alpha.txt:2…` while its identity was untouched.
 *   2. STRUCTURE — a laid-out session-list item that is neither the workspace row nor the provisional
 *      `新会话`/`New Session` row, for a shell that stops exposing the id.
 *   3. TEXT — the comment's own words, then the seeded message, exactly as the landing did before.
 *
 * @param page - the GUI page.
 * @returns the candidates, best first.
 */
function pressCandidates(page: Page): { which: PressTarget['which'], find: () => Promise<PressTarget | undefined> }[] {
  const target = (which: PressTarget['which'], describe: string, node: Locator): Promise<PressTarget> =>
    rowControlOf(node).count().then(async count => ({
      which,
      describe,
      target: count > 0 ? rowControlOf(node).first() : node,
    }))

  return [
    {
      which: 'identity',
      async find() {
        if (seededSessionId === '') return undefined
        for (const selector of identitySelectors(seededSessionId)) {
          const node = page.locator(selector).first()
          if (await node.count() === 0) continue
          if (!await node.isVisible().catch(() => false)) continue
          return await target('identity', `the row carrying ${selector}`, node)
        }
        return undefined
      },
    },
    {
      which: 'structure',
      async find() {
        const rows = await sessionRows(page)
        const index = rows.findIndex(row =>
          row.laidOut
          && row.control !== 'none'
          && !isProvisional(row.text)
          && row.text !== workspaceName)
        if (index < 0) return undefined
        const row = rows[index]
        const node = page.locator(sessionRowSelector).nth(index)
        return await target('structure', `session-list row #${index} ${JSON.stringify(row?.text ?? '')}`, node)
      },
    },
    ...TEXT_CANDIDATES.map(candidate => ({
      which: candidate.which,
      async find() {
        const matches = await titleMatches(page, candidate.text)
        const last = matches[matches.length - 1]
        if (last === undefined) return undefined
        const node = page.getByText(candidate.text, { exact: false }).last()
        return await target(
          candidate.which,
          `the ${candidate.which} text ${JSON.stringify(candidate.text)} (control=${last.control}`
          + `, ${last.inSidebar ? 'sidebar' : 'NOT-sidebar'})`,
          node,
        )
      },
    })),
  ]
}

async function openFreshPage(tag: string): Promise<void> {
  // The page this one REPLACES is closed FIRST. It is bound to a host the later steps kill, and a page left
  // open logs `ERR_CONNECTION_REFUSED`/`remote.mux` once a second for the rest of the run (measured:
  // hundreds of lines in a full suite). Every caller is finished with the old page by the time it gets here,
  // and f2/f3 close it themselves before their post-restart pages, where this is a no-op.
  if (page !== undefined) await page.close().catch(() => {})
  page = await newGuiPage(browser)
  pageErrors = []
  apiTraffic = []
  consoleErrorCount = 0
  page.on('pageerror', error => {
    pageErrors.push(error.message)
    console.log(`[pageerror:${tag}]`, error.message)
  })
  page.on('console', message => {
    if (message.type() !== 'error') return
    consoleErrorCount += 1
    if (pageErrors.length < 40) pageErrors.push(`console: ${message.text()}`)
    // Bounded on purpose: a page left open across a host restart logs ERR_CONNECTION_REFUSED once a second,
    // which in a full-suite run is hundreds of lines saying one thing. All of them are kept for a failure.
    if (consoleErrorCount <= 3) console.log(`[console-error:${tag}]`, message.text())
    else if (consoleErrorCount === 4) console.log(`[console-error:${tag}] (further console errors suppressed; the failure dump lists them)`)
  })
  // Whether the shell TALKED to the host at all. A page that never asked for anything is a different
  // failure from one whose asks all failed, and the two runs that failed could not tell them apart.
  page.on('response', response => {
    if (!response.url().includes('/api/')) return
    apiTraffic.push(`${response.status()} ${response.url().slice(host.url.length)}`)
  })
  await page.goto(host.url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
  await dismissNotices(page)
  // Nothing is pressed into the page until the shell has DRAWN: a press made into a page that is still
  // mounting has nothing to land on, and a retry loop then spends its whole budget clicking nothing. The
  // wait is the shell's own evidence, not a pause, and its deadline fails by name — see
  // `waitForShellReady`.
  await waitForShellReady(page)
  // THE MEASUREMENT. From here to "a session is current" is the landing's own number, sampled once a second
  // in between, and `watchLanding`'s closing line says which way the landing got there (see `watchLanding`).
  const landingStartedAt = Date.now()
  // What the title matched ON ARRIVAL, before anything is pressed: one line per fresh page, and the thing
  // that separates a page the shell has already bound (its transcript is rendered, so a session is current)
  // from one it has not (the sidebar row exists and nothing else does).
  console.log(`[title-match:${tag}] on arrival: ${describeTitleMatches(await titleMatches(page, SEED_MESSAGE))}`)
  console.log(`[rows:${tag}] identity on arrival: ${JSON.stringify(await identityHits(page, seededSessionId))}`)
  const landing = watchLanding(page, tag, SEED_MESSAGE)
  let presses = 0
  let target: PressTarget | undefined
  let instant = false
  let autoBound = false
  /** Which candidates were tried, and what each one did — the failure message prints this. */
  const candidateLog: string[] = []
  try {
    // A PRESS-FIRST LANDING, in three steps that were measured rather than assumed:
    //
    //   1. THE INSTANT PATH. The first page after a restart is usually already current by the time the shell
    //      has drawn (measured: 3-11 ms), and a page that answers here is not pressed into at all.
    //   2. WAIT FOR SOMETHING TO PRESS — not for a session to appear. A fresh page does NOT bind a session by
    //      itself: with every press disabled it stayed unbound for 25 s while the session's own row sat on
    //      screen from t≈1 s. So the event to wait for is the ROW, and this waits for either the row or a
    //      bind, on one deadline, and never presses before the row exists.
    //   3. PRESS ONCE PER CANDIDATE, best first, each confirmed. Identity (the seeded session id in the DOM)
    //      is the candidate a changed title cannot defeat; structure is the fallback for a shell that stops
    //      exposing the id; text is the last resort. A press that does not bind moves to the next candidate,
    //      which is what the confirm budget is for — and a failure names the candidate that failed.
    instant = await waitForCurrentSession(page, LANDING_INSTANT_MS)
    if (!instant) {
      // One deadline for the whole walk, and every candidate is offered on every tick, best first: a
      // candidate that is not on screen yet must not spend the budget the others still need (measured the
      // hard way — a forced-absent identity burned all 25 s and the fallbacks never got a turn).
      const rowDeadline = Date.now() + LANDING_ROW_DEADLINE_MS
      const candidates = pressCandidates(page)
      const tried = new Set<PressTarget['which']>()
      while (Date.now() < rowDeadline) {
        autoBound = await footerBadge(page).isEnabled().catch(() => false)
        if (autoBound) break
        let found: PressTarget | undefined
        for (const candidate of candidates) {
          if (tried.has(candidate.which)) continue
          found = await candidate.find()
          if (found !== undefined) break
        }
        if (found === undefined) {
          await page.waitForTimeout(250)
          continue
        }
        tried.add(found.which)
        target = found
        presses += 1
        console.log(`[landing-press:${tag}] pressing the ${found.which} candidate after ${Date.now() - landingStartedAt}ms: ${found.describe}`)
        // A press that throws is reported and then judged by the confirm below, not swallowed as a retry.
        await found.target.click({ timeout: 20_000 }).catch((error: unknown) => {
          console.log(`[landing-press:${tag}] the ${found.which} press threw: ${String(error).split('\n')[0]}`)
        })
        if (await waitForCurrentSession(page, LANDING_CONFIRM_MS)) {
          candidateLog.push(`${found.which}: pressed and bound`)
          break
        }
        candidateLog.push(`${found.which}: pressed ${found.describe} and did NOT bind`)
      }
    }
  } finally {
    // Always printed, passing or not: this is the distribution the landing question is answered from.
    landing.stop(
      `instant=${instant ? 'yes' : 'no'} autoBound=${autoBound ? 'yes' : 'no'}`
      + ` target=${target === undefined ? 'none' : target.which} presses=${presses}`
      + `${candidateLog.length > 0 ? ` [${candidateLog.join('; ')}]` : ''}`,
      true,
    )
  }
  // A landing that failed is THROWN AT ITS OWN SITE and NAMED — which candidate failed, and what the row set
  // was. The two surviving failure modes used to print the same sentence: "the page offered no row to press"
  // and "the row was pressed and nothing bound". The third one a reader might expect — "the wrong match was
  // pressed" — was measured away: on every page that needed a press there was exactly ONE text match, the
  // sidebar row, with its own control (see `titleMatches`), and the row is now found by identity anyway.
  if (!await footerBadge(page).isEnabled().catch(() => false)) {
    const text = await page.locator('body').innerText().catch(() => '(no body text)')
    console.log(`[nosession:${tag}]`, text.replace(/\s+/g, ' ').slice(0, 400))
    // The state that decides between "too slow", "the shell never binds here" and something else: what the
    // page last looked like, whether it ever reached the host, what it threw, what the row set was, and what
    // the host's own home holds for the seeded session.
    console.log(`[nosession:${tag}] timeline:\n  ${landing.samples.slice(-8).join('\n  ') || '(no samples)'}`)
    console.log(`[nosession:${tag}] api: ${apiTraffic.length} reply/replies ${JSON.stringify(apiTraffic.slice(-8))}`)
    console.log(`[nosession:${tag}] errors: ${pageErrors.length} kept of ${consoleErrorCount} console error(s), ${JSON.stringify(pageErrors.slice(0, 5))}`)
    console.log(`[nosession:${tag}] title matches: ${describeTitleMatches(await titleMatches(page, SEED_MESSAGE))}`)
    console.log(`[nosession:${tag}] identity hits for ${seededSessionId || '(no id)'}: ${JSON.stringify(await identityHits(page, seededSessionId))}`)
    console.log(`[nosession:${tag}] row set: ${JSON.stringify(await sessionRows(page))}`)
    console.log(`[nosession:${tag}] candidates: ${candidateLog.join('; ') || '(none reached)'}`)
    console.log(`[nosession:${tag}] home:\n${describeHome(fixture.home)}`)
    console.log(`[nosession:${tag}] badge said: ${await landingProbe(page, SEED_MESSAGE)}`)
    if (target === undefined) {
      throw new Error(
        `no session row appeared on the fresh page "${tag}" within ${LANDING_ROW_DEADLINE_MS} ms and no session`
        + ` became current either, so there was nothing to press. Candidates, in order: identity (session`
        + ` ${seededSessionId || '(unknown)'}), structure (a laid-out row that is neither the workspace nor`
        + ` 新会话), then the texts "${COMMENT_TEXT}" and "${SEED_MESSAGE}" — ${candidateLog.join('; ') || 'none found'}.`
        + ` The badge said ${await landingProbe(page, SEED_MESSAGE)}.`
        + `\n${await describeSidebar(page)}`,
      )
    }
    throw new Error(
      `the ${target.which} candidate was pressed on the fresh page "${tag}" (${target.describe}) and no session`
      + ` became current within ${LANDING_CONFIRM_MS} ms. Candidates, in order: ${candidateLog.join('; ')}.`
      + ` The badge said ${await landingProbe(page, SEED_MESSAGE)}.`
      + `\n${await describeSidebar(page)}`,
    )
  }
  await openPanel(page)
  await ensurePanelList(page)
}

test.describe('评论与重启：写一条评论，再看一次宿主重启保住了什么', () => {
  test.beforeAll(async () => {
    const found = resolveDsh()
    if (found === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    dsh = found
    fixture = makeFixture('flow')
    workspaceName = fixture.workspace.split(/[\\/]/).pop() ?? 'workspace'
    const workspaceId = await bootstrapHome(dsh, fixture)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    const sessionId = await beginSession(page, workspaceName || 'workspace', fixture.home, SEED_MESSAGE)
    seededSessionId = sessionId
    await page.close()
    await stopHost(host.proc)

    const written = seedPending(fixture, sessionId, FILES, [])
    paths = Object.fromEntries(written.entries.map(entry => [entry.path.split(/[\\/]/).pop() ?? entry.path, entry.id]))
    claimSession(fixture, workspaceId, sessionId)

    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('setup')
    await openFloatList(page)
    await ensurePanelList(page)
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    fixture?.cleanup()
  })

  test('f1. 打开差异 → 选中行 → 写一条评论 → 发出去 → 评论出现在评论列表里', async () => {
    // The file is opened the way a reader opens it, and only then is there a diff to
    // select lines in.
    await row(page, paths['alpha.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })

    await writeComment(page, 0, 1, COMMENT_TEXT)
    await new Promise(resolve => setTimeout(resolve, 6000))

    // The host took it: that is what its own store on disk says, and the list below is
    // what reads it back.
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) })
      .toPass({ timeout: 30_000 })

    // A reload is a fresh read of the host's store, so the list is the host's own answer
    // rather than a rendering the writing page kept for itself.
    await openFreshPage('after-comment')
    await page.locator('[data-diff-list-tab="comments"]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(1, { timeout: 30_000 })
    expect(await page.locator('[data-diff-list-scroll]').first().innerText()).toContain(COMMENT_TEXT)
    await expect(page.locator('[data-diff-list-count]').first()).toHaveText('1', { timeout: 20_000 })
  })

  test('f2. 重启宿主：待审列表与评论都还在', async () => {
    // The restart itself: the same throwaway home, a brand new host process. Nothing
    // about the writing page is carried over — not the page, not the process.
    await page.close()
    await stopHost(host.proc)
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('after-restart')

    // The pending list is a disk-backed store, so both files are still on it...
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })
    for (const name of Object.keys(paths)) {
      await expect(row(page, paths[name] as string)).toBeVisible({ timeout: 20_000 })
    }
    // ...and so is the comment, listed under the file it was written on.
    await page.locator('[data-diff-list-tab="comments"]').first().click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-comment-link]')).toHaveCount(1, { timeout: 30_000 })
    expect(await page.locator('[data-diff-list-scroll]').first().innerText()).toContain(COMMENT_TEXT)
    await expect(page.locator('[data-diff-list-count]').first()).toHaveText('1', { timeout: 20_000 })
  })

  test('f3. 撤销栈不跨重启：重启后 Ctrl+Z 什么也不撤', async () => {
    // First the part that is about the STACK and not about the restart. This page is
    // reloaded on the RESTARTED host, and the host still holds the comment's undo step
    // — the comment being undone here is this test's OWN fresh write, whose step the
    // host was there to record. Ctrl+Z really does take it back, which is what makes
    // the "nothing" below mean the restart emptied the stack rather than that this
    // suite never had one.
    await openFreshPage('before-undo')
    // beta.txt, not alpha.txt: a row belongs to one comment at most, and f1's comment sits
    // on alpha.txt's rows — the panel offers no second comment on a range that already
    // carries a block, and no drag can make one appear.
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    await writeComment(page, 0, 1, COMMENT_TEXT)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) })
      .toPass({ timeout: 30_000 })
    const alone = commentIdOnDisk(fixture.home)
    await pressUndo(page)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) })
      .toPass({ timeout: 30_000 })

    // ---- write it once more and leave the stack alone: this time the step that empties
    // the stack is the RESTART, not an undo the test performed on purpose.
    await openFreshPage('re-write')
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    await writeComment(page, 0, 1, COMMENT_TEXT)
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) })
      .toPass({ timeout: 30_000 })

    await page.close()
    await stopHost(host.proc)
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    await openFreshPage('after-second-restart')
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 30_000 })

    // ---- the boundary: Ctrl+Z after a restart is accepted and changes nothing.
    const before = await panelState(page)
    await pressUndo(page)
    const said = await noticesText(page)
    await new Promise(resolve => setTimeout(resolve, 4000))
    expect(commentCount(fixture.home)).toBe(2)
    await expect(page.locator('[data-diff-file]')).toHaveCount(2, { timeout: 20_000 })
    // `panelState` starts with the row/comment/field counts; a notice about the press is
    // expected, but the LIST it is about must not have moved.
    expect((await panelState(page)).split('|').slice(0, 3).join('|'))
      .toBe(before.split('|').slice(0, 3).join('|'))
    // What the press said, as this build actually says it: nothing at all. The host
    // answers `nothing`, and the panel's list is unchanged — there is no notice to find,
    // and none is asserted for.
    expect(said).not.toContain('无法撤销')
    expect(said).not.toContain('Undo failed')
    console.log('[measured] post-restart Ctrl+Z said:', JSON.stringify(said.replace(/\s+/g, ' ').slice(-260)))
  })

  test('f4. 关闭评论后 Ctrl+Z 把评论带回来', async () => {
    // The reported flow, pressed the way the reader presses it: the card's own ⋯ menu, its
    // own close item (the panel calls it 关闭评论), then the platform's undo chord. Nothing
    // here touches the store or the host, so what the assertions read is what the two
    // presses did between them — first in the host's own file, then on screen.
    //
    // The comment this closes is f3's, written BEFORE the restart: the close is a fresh
    // action and takes a fresh undo step whatever the stack held, so an undo that brings it
    // back is about the close and not about the write that preceded it.
    await openFreshPage('close-undo')
    await row(page, paths['beta.txt'] as string).click({ timeout: 20_000 })
    await expect(page.locator('[data-diff-code]').first()).toBeVisible({ timeout: 30_000 })
    const card = page.locator('[data-diff-discussion]').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.locator('[data-diff-discussion-menu]').click({ timeout: 20_000 })
    await page.locator('[role="menuitem"]').filter({ hasText: new RegExp(CLOSE_COMMENT.join('|')) }).first()
      .click({ timeout: 20_000 })

    // The close really happened: the host's store dropped it and the code view stopped drawing it.
    await expect(async () => { expect(commentCount(fixture.home)).toBe(1) }).toPass({ timeout: 30_000 })
    await expect(card).toHaveCount(0, { timeout: 30_000 })

    await pressUndo(page)
    const said = await noticesText(page)
    // The one assertion that matters: the comment is back in the host's own store…
    await expect(async () => { expect(commentCount(fixture.home)).toBe(2) }).toPass({ timeout: 30_000 })
    // …and the card is drawn again where it was, with what it said.
    await expect(page.locator('[data-diff-discussion]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-diff-discussion]').first()).toContainText(COMMENT_TEXT, { timeout: 20_000 })
    console.log('[measured] close-then-undo said:', JSON.stringify(said.replace(/\s+/g, ' ').slice(-260)))
  })
})

/** The first comment id in the plugin's store, so a run can tell one write from another. */
function commentIdOnDisk(home: string): string {
  const match = /"id":"([^"]+)"/.exec(commentStore(home))
  return match?.[1] ?? '(none)'
}
