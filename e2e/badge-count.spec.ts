// The badge's own read, in a real browser: with the panel CLOSED the footer badge shows the right count
// without the full list ever being sent to the page.
//
// What this proves, and why it needs a browser: the full read carries every visible entry's whole old and
// new text — 6.77 MB across the reader's 302 stored entries, single rows at 1.2-1.6 MB — and it used to run
// once a second for a seat whose panel was shut, because the footer seat is always "showing" while its
// overlay is closed. The closed tick now asks `list-count`, which returns one number and reads no file
// content. The component-level split is pinned in `tests/pending-panel.client.spec.tsx`; what only a real
// page can show is that the live GUI reaches a correct badge WITHOUT issuing the `list` request, and how
// the two responses compare in bytes on the wire.
//
// The measurement is Playwright's own view of the transport, and it is the WHOLE response body of each
// channel call: the plugin's port POSTs `<channel>/<endpoint>` (see `createWebConnectionRpc` in
// `@deepseek-ai/dsh-client-connection`), so a `response` event IS the call, and `response.body()` IS what
// the browser received. Nothing here is inferred from the panel's DOM or from a host-side counter.
//
// NOT TESTED HERE, deliberately: making a SECOND entry appear while the page is open, so the badge's count
// can be watched going up. The two in-page ways to add one are both dead ends in this harness — the
// add-path dialog is recorded in `panel-comments.spec.ts` as not driven to completion ("picking an entry +
// Add produced no row and no notice"), and the VCS import button only exists in the EMPTY state (see the
// panel's `files.length === 0` branch and `import-vcs.spec.ts`), which is not the state a two-row badge
// proof needs. Claiming a count update from either would be a claim this spec cannot make honestly, so the
// jsdom pin and the two measured windows below carry it instead.
//
// FOUND BY THIS SPEC, and the reason b1 is RED on the build it was written against: with the panel SHUT the
// count IS asked for and correctly answered, and the badge still reads 0. Measured on a real page —
// `list-count` POSTs carrying the right session, answered `{ok:true,value:{count:2}}` in 114 bytes, once a
// second, and `data-diff-approval-badge` staying "0" for 34 s and across a forced re-render; and the SAME
// page reading 2 the moment the panel opens (one `list`, 313,363 bytes) — so the number reaches the store
// and the seat never sees it.
//
// WHAT THE READER ACTUALLY HIT, corrected after their second report: the shell's changed-files card was
// showing a path this panel no longer held (the change had been settled away, and re-importing the file from
// version control made the menu work again). That was the press bridge's "not held ⇒ leave the press to the
// shell" path, working as designed and looking like a dead control. A file-list ROW's press is now ALWAYS
// this menu, with "not held" deciding only that "在审批面板中查看" adds the file first (through the same add
// verb the path picker uses) and then opens it. The menu and that flow are pinned in
// `tests/produced-diff.client.spec.ts` and `tests/pending-panel.client.spec.tsx`: the shell's own
// changed-files card cannot be raised from this fixture, whose store is seeded directly rather than by
// session events, so no synthetic press on it would be honest. What the browser is used for here is what
// only a browser can measure: the badge, and the two payloads.

import { chromium, expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import {
  beginSession, dismissNotices, footerBadge, newGuiPage, openPanel, openSession, waitForShellReady,
} from './helpers/gui.ts'
import {
  bootstrapHome, claimSession, makeFixture, resolveDsh, seedPending, startHost, stopHost,
} from './helpers/host.ts'
import type { Fixture, Host, SeededFile } from './helpers/host.ts'

const SEED_MESSAGE = 'e2e badge count'

/**
 * The big row's text, sized so the full read it rides is unmistakable.
 *
 * 4800 lines of 63 characters plus the newline: 307,200 bytes of `newText`, which the read ships (escaped,
 * so a little more) on every full read. The fixture's own cost stays small: the panel is never opened on a
 * diff of this file in the assertions that matter, and `writeFileSync` plus the store's JSON are the only
 * places the text is touched before the browser sees it.
 */
const BIG_LINE = `${'x'.repeat(63)}\n`
const BIG_TEXT = BIG_LINE.repeat(4800)

/** How big the full read must measure for this spec to call it the dominating payload. */
const BIG_ENOUGH_BYTES = 200_000

/** How big the count's own answer may measure, with room to spare over one number and its envelope. */
const COUNT_SMALL_ENOUGH_BYTES = 4096

/** The two channel endpoints this spec watches, as the port names them. */
type Endpoint = 'list' | 'list-count'

/** One observed call: which endpoint it was, what it asked, and the response body the browser received. */
interface Trace {
  endpoint: Endpoint
  /** The request's own JSON body, for the post-mortem line (the payload names the session). */
  post: string | null
  body: Promise<Buffer | undefined>
}

/** Which endpoint one browser request called, or undefined for anything else the page fetches. */
function endpointOf(url: string, method: string): Endpoint | undefined {
  if (method !== 'POST') return undefined
  const path = new URL(url).pathname
  if (path.endsWith('/diff-approval/list-count')) return 'list-count'
  if (path.endsWith('/diff-approval/list')) return 'list'
  return undefined
}

/**
 * The number a `list-count` body carries, whatever envelope this build wraps it in.
 *
 * Read rather than assumed: the transport answers `{ rpcId, ok, value }` today, and a spec that searched
 * for the literal shape of one release would report "no number" the day it changed rather than failing on
 * the number itself.
 */
function countIn(body: Buffer): number | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    // The transport wraps the channel's own result: `{ type, rpcId, result: { ok, value: { count } } }`.
    // Both shapes are read, so this keeps working if the envelope is ever flattened.
    const result = (parsed.result ?? parsed) as Record<string, unknown>
    const value = (result.value ?? result) as Record<string, unknown>
    const count = value.count
    return typeof count === 'number' ? count : undefined
  } catch {
    return undefined
  }
}

/** Sizes of the observed bodies, ignoring the ones this side could not read (reported as `undefined`). */
async function sizesOf(traces: readonly Trace[]): Promise<number[]> {
  const bodies = await Promise.all(traces.map(trace => trace.body))
  return bodies.map(body => body?.length ?? -1)
}

/**
 * One line describing every call this spec observed, with the number a count carried.
 *
 * Printed before the assertions rather than after them: a run whose badge is wrong has to say WHAT the
 * browser actually received (nothing at all? a count of zero? a count of two?) — otherwise the failure
 * only says the DOM disagreed with the expectation, and the two very different causes look alike.
 */
async function describeTraces(observed: readonly Trace[]): Promise<string> {
  const parts = await Promise.all(observed.map(async trace => {
    const body = await trace.body
    const post = trace.post === null ? '(no body)' : trace.post.slice(0, 200)
    if (body === undefined) return `${trace.endpoint} <- ${post} => (unreadable response)`
    const text = body.toString('utf8')
    const answer = trace.endpoint === 'list-count'
      ? `${body.length} B, count=${countIn(body) ?? '?'}, text=${text.slice(0, 220)}`
      : `${body.length} B`
    return `${trace.endpoint} <- ${post} => ${answer}`
  }))
  return `${observed.length} channel calls: ${parts.join(' | ') || '(none)'}`
}

let fixture: Fixture
let browser: Browser
let page: Page
let host: Host
/** Every channel call the browser made, in order; the two tests reset it to measure their own window. */
let traces: Trace[] = []

test.describe.configure({ mode: 'serial' })

test.describe('角标计数：面板关着时只问数量，不问那份大文本', () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN，或把 `dsh`（@deepseek-ai/dsh 的 bin）放进 PATH。')
      return
    }
    fixture = makeFixture('badge-count')
    const workspaceId = await bootstrapHome(dsh, fixture)

    // ---- phase one: a session made by the GUI, then the host stops so the store can be written. The
    // plugin host reads its pending store once, at boot (see `helpers/host.ts`), so this order is what
    // makes the seed visible to the panel at all.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    browser = await chromium.launch()
    page = await newGuiPage(browser)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    const sessionId = await beginSession(page, fixture.workspace.split(/[\\/]/).pop() ?? 'workspace', fixture.home, SEED_MESSAGE)
    await page.close()
    await stopHost(host.proc)

    // Two rows: one small, one whose text alone dwarfs a count answer. The big row's `oldText` is small on
    // purpose — the response's size is what this spec measures, and a small old text keeps the panel's own
    // diff work (if a later step ever opens that file) proportional to one side of the change.
    const files: SeededFile[] = [
      { name: 'small.txt', oldText: 'small one\n', newText: 'small two\n' },
      { name: 'big.txt', oldText: 'big one\n', newText: BIG_TEXT },
    ]
    seedPending(fixture, sessionId, files, [])
    claimSession(fixture, workspaceId, sessionId)

    // ---- phase two: the same home, with the store in place.
    host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
    page = await newGuiPage(browser)
    page.on('pageerror', error => { console.log('[pageerror]', error.message) })
    // Armed BEFORE the page loads: the first count tick fires as soon as a session is current, and a
    // listener attached later would miss the very traffic this spec is about.
    page.on('response', response => {
      const endpoint = endpointOf(response.url(), response.request().method())
      if (endpoint === undefined) return
      traces.push({
        endpoint,
        post: response.request().postData(),
        body: response.body().catch(() => undefined),
      })
    })
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
    await dismissNotices(page)
    await waitForShellReady(page)
    await openSession(page, SEED_MESSAGE)
    // The badge is the seat's only signal that a session is current; wait for it before measuring so the
    // window below is about polling, not about the page still binding.
    await expect(footerBadge(page)).toBeEnabled({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await stopHost(host?.proc)
    fixture?.cleanup()
  })

  test('b1. 面板关着：角标显示 2 且可用，而全程没有发过一次 list', async () => {
    test.setTimeout(120_000)
    // The window starts here: everything measured below is traffic from a page whose panel is shut.
    traces = []
    const badge = footerBadge(page)

    // A few seconds of shut-panel polling, then what actually arrived, printed BEFORE any assertion: a
    // badge that is wrong because nothing was ever asked for and one that is wrong because the host
    // answered zero look identical in the DOM, and this line is what tells them apart.
    await page.waitForTimeout(4000)
    const summary = await describeTraces(traces)
    console.log(`[badge-count] closed panel: badge=${await badge.getAttribute('data-diff-approval-badge')} ${summary}`)

    // The reader's symptom, asserted first and without any help from a full read: the badge reaches the
    // count 2. Before the count arrives the same element reads 0 (no list has been read either), so this
    // waiting assertion IS the proof that the number came from the light read.
    await expect(badge, summary).toHaveAttribute('data-diff-approval-badge', '2', { timeout: 30_000 })
    await expect(badge).toBeEnabled()

    // At least two count ticks in the window, so this is polling and not one lucky answer. The interval is
    // one second, so this also says the poll is running while the panel is shut — the badge keeps working.
    await expect
      .poll(() => traces.filter(trace => trace.endpoint === 'list-count').length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2)

    // THE PIN: while nothing is on screen, the full read is never issued. This is what the 6.77 MB were.
    const lists = traces.filter(trace => trace.endpoint === 'list')
    expect(lists, `full list reads observed while the panel was closed: ${lists.length}`).toHaveLength(0)

    // …and the number the badge is showing is the number the host sent, read out of the response bodies.
    const counts = (await Promise.all(traces
      .filter(trace => trace.endpoint === 'list-count')
      .map(async trace => { const body = await trace.body; return body === undefined ? undefined : countIn(body) })))
      .filter((count): count is number => count !== undefined)
    expect(counts.length, 'no list-count body could be parsed').toBeGreaterThan(0)
    expect(counts).toContain(2)

    // How small the count's own answer is, in bytes on the wire.
    const countSizes = await sizesOf(traces.filter(trace => trace.endpoint === 'list-count'))
    const biggest = Math.max(...countSizes)
    console.log(`[badge-count] closed panel: ${countSizes.length} list-count responses, largest body ${biggest} B`)
    expect(biggest).toBeGreaterThan(0)
    expect(biggest).toBeLessThan(COUNT_SMALL_ENOUGH_BYTES)
  })

  test('b2. 打开面板：list 这才出现，而且它背的正是那份大文本', async () => {
    test.setTimeout(120_000)
    // The reader opens the panel: this is the state that always did full-read, and it still does.
    await openPanel(page)

    // One full read has to arrive, and it is the payload the closed badge used to wait behind.
    await expect
      .poll(() => traces.filter(trace => trace.endpoint === 'list').length, { timeout: 60_000, message: 'the opened panel never issued a full read' })
      .toBeGreaterThan(0)
    const listSizes = await sizesOf(traces.filter(trace => trace.endpoint === 'list'))
    const biggestList = Math.max(...listSizes)
    console.log(`[badge-count] opened panel: ${listSizes.length} list responses, largest body ${biggestList} B`)
    expect(biggestList).toBeGreaterThan(BIG_ENOUGH_BYTES)

    // The badge still reads 2 while the panel is open: it is the same count either way.
    await expect(footerBadge(page)).toHaveAttribute('data-diff-approval-badge', '2', { timeout: 30_000 })

    // The other direction of the split, measured from a clean slate: with the panel ON SCREEN the tick is
    // the full read and not the count. Counted from HERE (after the opened panel settled) so the tick that
    // was already in flight when the reader clicked is not miscounted as "the count ran while open".
    const listsBefore = traces.filter(trace => trace.endpoint === 'list').length
    const countsBefore = traces.filter(trace => trace.endpoint === 'list-count').length
    await expect
      .poll(() => traces.filter(trace => trace.endpoint === 'list').length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(listsBefore + 2)
    expect(traces.filter(trace => trace.endpoint === 'list-count').length - countsBefore).toBe(0)
  })
})
