// README figures, generated from the REAL plugin in a real browser.
//
// This spec is the screenshot pipeline: it boots throwaway `dsh web` hosts against a temporary `DSH_HOME`, seeds
// a believable project with pending edits, and writes the images both READMEs embed into `docs/images/`.
//
// It is OPT-IN: `pnpm run screenshots` sets README_SHOTS=1 (see scripts/screenshots.mjs). A plain `pnpm e2e`
// skips it, because rewriting committed images on every ordinary test run would make unrelated diffs noisy.
//
// Each host carries a fixture plugin (`e2e/fixtures/seed-screenshot-session.mjs`, mounted with `--patch`) that
// publishes ONE live session with a finished user prompt and a finished assistant reply. That is what lets the
// conversation in the docked figure read as a completed turn without a model, a key, or a network.
//
// Two languages are captured from the same project: the host is restarted with `locale.preference` set and the
// fixture publishes its conversation in that language; each browser context uses a matching `locale`, so the
// shell and the plugin's labels agree too. English writes `name.png`, Chinese `name.zh.png`.
//
// The four figures and the names this repository uses for them:
//   floating-panel    the floating review panel over a live session, an HTML source diff open
//   docked-sidebar    the review docked in the right sidebar (≈ 2/3 of the window), conversation on the left
//   markdown-preview  the structured Markdown preview, right sidebar in FULLSCREEN mode
//   comment-card      a seeded comment card on the diff, in the same ≈ 2/3 docked layout
//
// The last test rewrites `screenshots.json` at the repository root from the files actually captured.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import {
  bootstrapHome, claimSession, resolveDsh, seedCommentFile, seedPending, startHost, stopHost, waitForLogMarker,
  type Fixture, type Host, type SeededFile,
} from './helpers/host.ts'
import { dismissNotices, ensurePanelList, openPanel, row } from './helpers/gui.ts'
import { dockPanel } from './helpers/panel.ts'

const ENABLED = process.env.README_SHOTS === '1'
const OUT = join('docs', 'images')
const VIEWPORT = { width: 1200, height: 800 }

/** The fixture session `e2e/fixtures/seed-screenshot-session.mjs` publishes (and prints to the host log). */
const SESSION_ID = 'e2e-readme-shots-session'
const SESSION_MARKER = 'SCREENSHOT_E2E_SESSION='

/** The project the figures show. It lives under `C:\PROJECTS` so its path reads like a real checkout. */
const WORKSPACE = 'C:\\PROJECTS\\dsh-homepage'

const INDEX_OLD = [
  '<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <meta name="theme-color" content="#ffffff">',
  '  <meta name="description" content="DeepSeek Harness — agentic coding workspace">',
  '  <title>DeepSeek Harness · Homepage</title>', '  <link rel="stylesheet" href="styles.css">', '</head>',
  '<body>', '  <header class="hero">', '    <h1>Build faster, ship calmer.</h1>',
  '    <p>One workspace for design, code and review.</p>', '  </header>', '</body>', '</html>', '',
].join('\n')

const INDEX_NEW = [
  '<!doctype html>', '<html lang="en">', '<head>', '  <meta charset="utf-8">',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <meta name="theme-color" content="#0f172a">',
  '  <meta name="description" content="DeepSeek Harness — agentic coding workspace with a built-in review panel">',
  '  <title>DeepSeek Harness · Product homepage</title>', '  <link rel="stylesheet" href="styles.css">', '</head>',
  '<body>', '  <header class="hero">', '    <h1>Build faster, review together.</h1>',
  '    <p>Design, code and review in one workspace.</p>', '  </header>', '</body>', '</html>', '',
].join('\n')

const MAIN_OLD = [
  "const themeToggle = document.querySelector('.theme-toggle')",
  'themeToggle?.addEventListener(\'click\', () => {',
  "  document.documentElement.dataset.theme = 'light'",
  '})', '',
].join('\n')

const MAIN_NEW = [
  "const themeToggle = document.querySelector('.theme-toggle')",
  'themeToggle?.addEventListener(\'click\', () => {',
  "  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'",
  '  document.documentElement.dataset.theme = next',
  '  localStorage.setItem(\'theme\', next)',
  '})', '',
].join('\n')

const STYLES_OLD = ':root {\n  --bg: #ffffff;\n  --fg: #111827;\n  --accent: #2563eb;\n}\n\n.hero {\n  padding: 64px 24px;\n}\n'
const STYLES_NEW = ':root {\n  --bg: #f9fafb;\n  --fg: #111827;\n  --accent: #7c3aed;\n}\n\n.hero {\n  padding: 80px 24px;\n  text-align: center;\n}\n'
const ROUTES_OLD = "export const routes = ['/', '/product', '/pricing'] as const\n"
const ROUTES_NEW = "export const routes = ['/', '/product', '/pricing', '/docs'] as const\n"

/** A believable project README whose heading, intro, feature table and development list all changed. */
function readmeLanguages(preference: 'en' | 'zh'): { oldText: string; newText: string } {
  if (preference === 'zh') {
    return {
      oldText: [
        '# dsh-homepage', '', 'DeepSeek Harness 的产品首页，使用原生 HTML、CSS 和 JavaScript 构建。', '',
        '## 功能', '',
        '| 模块 | 说明 | 状态 |', '| --- | --- | --- |',
        '| Hero | 首屏大标题与说明 | 已完成 |',
        '| 主题 | 亮色主题 | 已完成 |', '',
        '- 响应式布局', '- 基础动画', '',
        '## 开发', '', '直接在浏览器中打开 `index.html` 即可预览。', '',
      ].join('\n'),
      newText: [
        '# dsh-homepage', '', 'DeepSeek Harness 的产品首页，使用原生 HTML、CSS 和 JavaScript 构建，并附带一个可交互的主题切换。', '',
        '## 功能', '',
        '| 模块 | 说明 | 状态 |', '| --- | --- | --- |',
        '| Hero | 首屏大标题、说明与行动按钮 | 已完成 |',
        '| 主题 | 亮色 / 暗色主题切换 | 已完成 |', '',
        '- 响应式布局', '- 基础动画', '- 记忆上次选择的主题', '',
        '## 开发与预览', '', '在浏览器中打开 `index.html` 即可预览，或运行本地静态服务器。', '',
      ].join('\n'),
    }
  }
  return {
    oldText: [
      '# dsh-homepage', '', 'The DeepSeek Harness product homepage, built with plain HTML, CSS and JavaScript.', '',
      '## Features', '',
      '| Area | Description | Status |', '| --- | --- | --- |',
      '| Hero | Headline and description | Done |',
      '| Theme | Light theme only | Done |', '',
      '- Responsive layout', '- Basic animations', '',
      '## Development', '', 'Open `index.html` in a browser to preview the page.', '',
    ].join('\n'),
    newText: [
      '# dsh-homepage', '', 'The DeepSeek Harness product homepage, built with plain HTML, CSS and JavaScript, with an interactive theme switch.', '',
      '## Features', '',
      '| Area | Description | Status |', '| --- | --- | --- |',
      '| Hero | Headline, description and a call to action | Done |',
      '| Theme | Light / dark theme switch | Done |', '',
      '- Responsive layout', '- Basic animations', '- Remembers the last chosen theme', '',
      '## Development and preview', '', 'Open `index.html` in a browser, or run a local static server.', '',
    ].join('\n'),
  }
}

const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Add a dark theme with a remembered preference.\n- Expand the homepage preview with a review panel.\n'

/** The comment seeded on `main.js`, in the language of the README being illustrated. */
function commentText(preference: 'en' | 'zh'): string {
  return preference === 'en'
    ? 'The stored preference is read nowhere yet — should this land together with the dark palette, or stay a separate change?'
    : '这里保存的主题偏好还没有任何读取方——是和暗色配色一起合入，还是单独一个改动？'
}

/** The pending set for one language. */
function shotFiles(preference: 'en' | 'zh'): SeededFile[] {
  const readme = readmeLanguages(preference)
  return [
    { name: 'index.html', oldText: INDEX_OLD, newText: INDEX_NEW },
    { name: 'main.js', oldText: MAIN_OLD, newText: MAIN_NEW },
    { name: 'styles.css', oldText: STYLES_OLD, newText: STYLES_NEW },
    { name: 'README.md', oldText: readme.oldText, newText: readme.newText },
    { name: 'CHANGELOG.md', oldText: '', newText: CHANGELOG },
    { name: 'src/routes.ts', oldText: ROUTES_OLD, newText: ROUTES_NEW },
  ]
}

/** The image names, in README order (also the order `screenshots.json` lists). */
const FIGURES = ['floating-panel', 'docked-sidebar', 'markdown-preview', 'comment-card'] as const

let fixture: Fixture
let browser: Browser
let host: Host | undefined
let workspaceId: string
let readmeFileId: string
let htmlFileId: string
let mainFileId: string

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

test.describe.configure({ mode: 'serial' })

test.describe('README screenshots', () => {
  test.beforeAll(async () => {
    if (!ENABLED) {
      test.skip(true, 'screenshots are opt-in: run `pnpm run screenshots`')
      return
    }
    test.setTimeout(900_000)
    const dsh = resolveDsh()
    if (dsh === undefined) {
      test.skip(true, '找不到 dsh 可执行文件：请设置 DSH_BIN。')
      return
    }
    fixture = makeReadmeFixture()
    workspaceId = await bootstrapHome(dsh, fixture)
    browser = await chromium.launch()
  })

  test.afterAll(async () => {
    await browser?.close().catch(() => {})
    if (host !== undefined) await stopHost(host.proc)
    try { fixture?.cleanup() } catch { /* windows temp dirs may still be locked */ }
  })

  test('capture all four figures in both languages', async () => {
    test.setTimeout(900_000)
    if (!ENABLED) test.skip(true, 'screenshots are opt-in')
    const dsh = resolveDsh()!
    const written: string[] = []
    for (const variant of [
      { preference: 'en', locale: 'en-US', suffix: '' },
      { preference: 'zh', locale: 'zh-CN', suffix: '.zh' },
    ] as const) {
      // The SHELL language comes from the host preference; the browser locale makes the plugin's own labels
      // match it, and the fixture publishes its conversation in the same language.
      writeFileSync(join(fixture.home, 'settings.yaml'), `locale:\n  preference: ${variant.preference}\n`)

      // Seed BEFORE the host boots: the plugin host caches the pending store and the comments once, at start-up.
      const files = shotFiles(variant.preference)
      for (const file of files) mkdirSync(dirname(join(fixture.workspace, file.name)), { recursive: true })
      const seeded = seedPending(fixture, SESSION_ID, files, [])
      readmeFileId = seeded.entries.find(entry => entry.path.endsWith('README.md'))!.id
      htmlFileId = seeded.entries.find(entry => entry.path.endsWith('index.html'))!.id
      const mainEntry = seeded.entries.find(entry => entry.path.endsWith('main.js'))!
      mainFileId = mainEntry.id
      seedCommentFile(fixture, SESSION_ID, [{
        id: 'comment-main-js',
        entryId: mainEntry.id,
        path: mainEntry.path,
        // The new line 3 is the `next` computation; the anchor is where the card hangs in the source diff.
        quote: "  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'",
        anchor: { startLine: 3, endLine: 3 },
        text: commentText(variant.preference),
      }])
      claimSession(fixture, workspaceId, SESSION_ID)

      host = await startHost(dsh, fixture.home, fixture.workspace, join(fixture.home, `host-${variant.preference}.log`), {
        extraArgs: ['--patch', resolve('e2e', 'fixtures', 'profile.patch.yml')],
        locale: variant.preference,
      })
      await waitForLogMarker(host.logFile, SESSION_MARKER)

      const context = await browser.newContext({ viewport: VIEWPORT, locale: variant.locale })
      // The session is published by the host, not created by the GUI, so the persisted client store is what
      // tells the shell to open it. The screenshot-only plugin flags go in the same pre-boot script.
      await context.addInitScript((id: string) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
        localStorage.setItem('diff-approval:temp-preview-v2', '1')
        localStorage.removeItem('diff-approval:md-preview')
        localStorage.removeItem('diff-approval:tree-diff')
        localStorage.removeItem('diff-approval:presentation')
        localStorage.removeItem('diff-approval:coverage')
      }, SESSION_ID)
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      await page.goto(host.url, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('text=/工作区|Workspaces/', { timeout: 60_000 })
      await dismissNotices(page)
      // Wait until the fixture conversation is on screen: the user prompt and the finished agent reply.
      try {
        await page.getByText(variant.preference === 'en' ? 'I reviewed the homepage changes' : '首页这轮的改动我看过了', { exact: false })
          .first().waitFor({ timeout: 60_000 })
      } catch (error) {
        writeFileSync(join('scratch', 'shot-debug.txt'), [
          `locale=${variant.locale}`,
          `current=${await page.evaluate(() => localStorage.getItem('dsh.sessions.current'))}`,
          `body:\n${await page.locator('body').innerText()}`,
          `host:\n${readFileSync(host.logFile, 'utf8')}`,
        ].join('\n\n'))
        throw error
      }
      await collapseLeftSidebar(page)
      await openPanel(page)
      await ensurePanelList(page)

      // 1. floating-panel: the whole window, with the review floating over the conversation.
      console.log('[shot]', variant.suffix || 'en', 'floating-panel')
      await row(page, htmlFileId).click({ timeout: 20_000 })
      await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
      if (await page.locator('[data-diff-md-preview-body]').count() > 0) {
        await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
        await page.waitForTimeout(400)
      }
      await hoverAChange(page)
      await sleep(300)
      written.push(await bounded('floating-panel', shotPage(page, `floating-panel${variant.suffix}.png`)))

      // 2. docked-sidebar: docked, then widened to the shell's maximum (≈ two thirds of the window).
      console.log('[shot]', variant.suffix || 'en', 'docked-sidebar')
      const docked = await dockPanel(page)
      if (!docked) throw new Error('the right-sidebar dock row was not offered')
      await page.waitForTimeout(1400)
      await widenRightSidebar(page, Math.round(VIEWPORT.width / 3))
      await page.waitForTimeout(900)
      written.push(await bounded('docked-sidebar', shotPage(page, `docked-sidebar${variant.suffix}.png`)))

      // 3. comment-card: a comment card on main.js, in the same ≈ 2/3 docked layout.
      console.log('[shot]', variant.suffix || 'en', 'comment-card')
      await row(page, mainFileId).click({ timeout: 20_000 })
      await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
      if (await page.locator('[data-diff-md-preview-body]').count() > 0) {
        await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
        await page.waitForTimeout(500)
      }
      await page.getByText(commentText(variant.preference), { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {})
      await page.waitForTimeout(800)
      written.push(await bounded('comment-card', shotPage(page, `comment-card${variant.suffix}.png`)))

      // 4. markdown-preview: the structured README preview in the right sidebar's FULLSCREEN mode.
      console.log('[shot]', variant.suffix || 'en', 'markdown-preview')
      await page.locator('[data-sidebar-right-mode="fullscreen"]').first().click({ timeout: 20_000 })
      await page.waitForTimeout(1400)
      await row(page, readmeFileId).click({ timeout: 20_000 })
      await page.locator('[data-diff-body], [data-diff-md-preview-body]').first().waitFor({ timeout: 20_000 })
      if (await page.locator('[data-diff-md-preview-body]').count() === 0) {
        await page.locator('[data-diff-md-preview]').first().click({ timeout: 20_000 })
        await page.waitForTimeout(500)
      }
      if (await page.locator('.mdFlowDouble').count() === 0) {
        await page.locator('[data-diff-toggle-view]').first().click({ timeout: 20_000 })
        await page.waitForTimeout(700)
      }
      // Top of the document first, so the changed heading is not clipped by the toolbar; then hover a change
      // block that is already in view for its Keep/Revert toolbar.
      await page.locator('[data-diff-md-preview-body]').first().evaluate(element => { element.scrollTop = 0 })
      await sleep(500)
      const diffRows = page.locator('.mdFlowDoubleRow-diff')
      if (await diffRows.count() > 0) await diffRows.first().hover()
      await sleep(400)
      written.push(await bounded('markdown-preview', shotPage(page, `markdown-preview${variant.suffix}.png`)))

      await context.close()
      await stopHost(host.proc)
      host = undefined
    }
    console.log('[screenshots]', JSON.stringify(written))
    expect(written).toHaveLength(8)
    // The manifest follows the README order, English first then Chinese.
    const manifest = ['', '.zh'].flatMap(suffix => FIGURES.map(name => `docs/images/${name}${suffix}.png`))
    for (const file of manifest) expect(written).toContain(file.replace('docs/images/', ''))
    writeFileSync('screenshots.json', `${JSON.stringify(manifest, null, 2)}\n`)
  })
})

/** The project under `C:\PROJECTS` (a believable path in the panel header) plus a throwaway home in scratch/. */
function makeReadmeFixture(): Fixture {
  const root = resolve('scratch', 'readme-fixture')
  rmSync(root, { recursive: true, force: true })
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-real-key\n')
  return {
    home,
    workspace: WORKSPACE,
    logFile: join(home, 'host.log'),
    cleanup: () => {
      rmSync(WORKSPACE, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Collapse the shell's left sidebar, so the docked figure reads as conversation | review side by side. */
async function collapseLeftSidebar(page: Page): Promise<void> {
  const collapse = page.getByRole('button', { name: /收起侧边栏|Collapse sidebar|Hide sidebar|Toggle sidebar/i }).first()
  if (await collapse.count() === 0 || !await collapse.isVisible().catch(() => false)) return
  await collapse.click({ timeout: 10_000 }).catch(() => {})
  await sleep(600)
}

/**
 * Widen the docked right sidebar with the shell's own drag handle until its divider sits at `targetLeftX`
 * (the shell clamps the width, so a request for two thirds lands at its maximum instead of failing).
 */
async function widenRightSidebar(page: Page, targetLeftX: number): Promise<void> {
  const handle = page.locator('[data-side="rightbar"]').first()
  await handle.waitFor({ state: 'attached', timeout: 20_000 })
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await handle.boundingBox()
    if (box === null) { await sleep(300); continue }
    const y = Math.round(VIEWPORT.height / 2)
    await page.mouse.move(box.x + box.width / 2, y)
    await sleep(200)
    await page.mouse.down()
    await page.mouse.move(targetLeftX, y, { steps: 12 })
    await page.mouse.up()
    await sleep(700)
    const sidebarBox = await page.locator('[data-sidebar-right-panel]').first().boundingBox()
    if ((sidebarBox?.width ?? 0) >= VIEWPORT.width * 0.6) return
  }
  throw new Error('the right sidebar never widened past 60% of the window')
}

async function shotPage(page: Page, file: string): Promise<string> {
  await page.screenshot({ path: join(OUT, file), animations: 'disabled' })
  return file
}

/** Hover the first changed row so the code view's block toolbar is part of the figure. */
async function hoverAChange(page: Page): Promise<void> {
  const rowLocator: Locator = page.locator('[data-diff-row]').first()
  if (await rowLocator.count() > 0) await rowLocator.hover().catch(() => {})
  const block = page.locator('[data-md-block]').first()
  if (await block.count() > 0) await block.hover().catch(() => {})
}

/**
 * Await one capture step with a hard ceiling. A screenshot can in principle wait on a page whose compositor
 * never settles; the ceiling turns that into a named failure instead of a run that looks hung.
 */
async function bounded<T>(label: string, promise: Promise<T>, ms = 45_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`screenshot step timed out: ${label}`)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
