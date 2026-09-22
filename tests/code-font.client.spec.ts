// @vitest-environment jsdom
// The bundled code font, client half: the rules that get injected, how they are
// scoped, and 鈥?the point of the switch 鈥?that nothing at all happens until the
// reader asks for it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachCodeFont, codeFontCss, resetCodeFontForTests } from '../src/client/code-font.ts'
import { CODE_FONT_CHANGED_EVENT, codeFontEnabled, setCodeFontEnabled } from '../src/client/settings.ts'
import { FONT_FAMILY, FONT_ROUTE, FONT_STACK } from '../src/font-slices.ts'

/** Two weights, three slices: enough to pin the shape of the generated rules. */
const SLICES = [
  { file: 'regular-latin.woff2', unicodeRange: 'U+0020-007E', weight: 400 },
  { file: 'regular-hanzi-000.woff2', unicodeRange: 'U+4E00-5FFF', weight: 400 },
  { file: 'semibold-latin.woff2', unicodeRange: 'U+0020-007E', weight: 600 },
]

/** Let the attach promise chain settle. */
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

/** Stub `fetch` with a manifest response (or a failure), and count the calls. */
function stubFetch(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => payload }))
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

/** The injected element, or null. */
const injected = (): HTMLStyleElement | null =>
  document.head.querySelector<HTMLStyleElement>('style[data-diff-approval-code-font]')

/** Attachments made by a test, disposed after it: a live attachment keeps
 *  listening for the switch, so one test's listener would answer the next
 *  test's flip and inject rules nobody is asking for. */
const attachments: Array<() => void> = []
function attach(): () => void {
  const detach = attachCodeFont()
  attachments.push(detach)
  return detach
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  while (attachments.length > 0) attachments.pop()?.()
  // The manifest is cached for the life of a page, so a test that stubbed a
  // failed fetch would otherwise hand its answer to the next one.
  resetCodeFontForTests()
  vi.unstubAllGlobals()
})

describe('the injected code font rules', () => {
  it('declares each slice as a font face for its own weight', () => {
    const css = codeFontCss(SLICES)
    expect(css).toContain(`font-family:"${FONT_FAMILY}"`)
    expect(css).toContain(`url("${FONT_ROUTE}/regular-latin.woff2") format("woff2")`)
    expect(css).toContain(`url("${FONT_ROUTE}/regular-hanzi-000.woff2") format("woff2")`)
    expect(css).toContain(`url("${FONT_ROUTE}/semibold-latin.woff2") format("woff2")`)
    // Two faces, two weights: the code is 400, emphasis is 600, and a slice is
    // only declared for the weight it was subset from.
    expect(css.split('@font-face').length - 1).toBe(3)
    expect(css.slice(css.indexOf('regular-latin'), css.indexOf('regular-hanzi'))).toContain('font-weight:400')
    expect(css.slice(css.indexOf('semibold-latin'))).toContain('font-weight:600')
    // The manifest's own range is what decides when a browser fetches the file:
    // losing it would download every hanzi slice for any Chinese character.
    expect(css).toContain('unicode-range:U+4E00-5FFF')
    expect(css).toContain('font-display:swap')
  })

  it('puts only the code column on the font', () => {
    const css = codeFontCss(SLICES)
    expect(css).toContain(`.lines{font-family:${FONT_STACK}}`)
    // No device or width gate: the grid is what the diff needs on every screen.
    expect(css).not.toContain('@media')
    expect(css).not.toContain('max-width')
    expect(css).not.toContain('pointer')
    // Comment bubbles, the file list and the chrome keep the shell's stack.
    for (const selector of ['.discussionAnswer', '.discussionUser', '.rowPath', '.panel']) {
      expect(css).not.toContain(`${selector}{font-family`)
    }
  })
})

describe('the code font switch', () => {
  it('is off by default and fetches nothing until it is on', async () => {
    const fetchStub = stubFetch({ slices: SLICES })
    expect(codeFontEnabled()).toBe(false)
    attach()
    await settle()
    // The default panel must be exactly what it was before the font existed:
    // no manifest request, no @font-face, no rule.
    expect(fetchStub).not.toHaveBeenCalled()
    expect(injected()).toBeNull()
  })

  it('injects on the switch and takes the rules back out when it is turned off', async () => {
    const fetchStub = stubFetch({ slices: SLICES })
    attach()
    await settle()
    setCodeFontEnabled(true)
    await settle()
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(injected()?.textContent).toContain(FONT_ROUTE)
    expect(injected()?.textContent).toContain(`.lines{font-family:${FONT_STACK}}`)
    setCodeFontEnabled(false)
    await settle()
    expect(injected()).toBeNull()
    // 鈥nd it does not republish a font nobody asked for.
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('installs on attach when the preference is already on', async () => {
    stubFetch({ slices: SLICES })
    setCodeFontEnabled(true)
    attach()
    await settle()
    expect(injected()).not.toBeNull()
  })

  it('keeps the system stack when the host serves no slices', async () => {
    stubFetch({}, false)
    setCodeFontEnabled(true)
    attach()
    await settle()
    expect(injected()).toBeNull()
  })

  it('follows the preference only while attached', async () => {
    stubFetch({ slices: SLICES })
    const detach = attach()
    setCodeFontEnabled(true)
    await settle()
    expect(injected()).not.toBeNull()
    detach()
    expect(injected()).toBeNull()
    // A later flip must not resurrect the rules.
    setCodeFontEnabled(false)
    setCodeFontEnabled(true)
    await settle()
    expect(injected()).toBeNull()
  })
})

describe('the code font stack', () => {
  it('asks for the bundled family first and keeps the system stack behind it', () => {
    // A reader without the slices still gets the old rendering, and a character
    // the slices do not cover (Korean, CJK Ext-A) still resolves.
    expect(FONT_STACK.startsWith(`"${FONT_FAMILY}"`)).toBe(true)
    for (const fallback of ['Consolas', 'Menlo', '"Microsoft YaHei"']) {
      expect(FONT_STACK).toContain(fallback)
    }
  })

  it('names a face the reader can look up, without claiming the upstream name', () => {
    // Carries the project marker so a locally installed copy of the upstream
    // font cannot silently win over the webfont.
    expect(FONT_FAMILY).toContain('JetBrains Maple Mono')
    expect(FONT_FAMILY).not.toBe('JetBrains Maple Mono')
    expect(FONT_FAMILY.endsWith('DSH')).toBe(true)
  })
})

// The event name is part of the hand-off between the Settings section and the
// panel, so it is pinned: a rename here without renaming the listener would
// leave the switch doing nothing until a page reload.
describe('the switch event', () => {
  it('is the one the panel listens for', () => {
    expect(CODE_FONT_CHANGED_EVENT).toBe('diff-approval:code-font')
  })
})
