// The bundled code font, when the *deployment* is what is missing: the host
// bundle has no `assets/fonts` beside it, which is what a profile installed
// before the package's file list grew assets looks like. Every slice is then a
// 404 — and because the reader turned the switch on and nothing else in the
// panel would ever say why the font does nothing, the first such answer is
// reported to the host log. Two properties are pinned here: the report is once
// per route (a page asks for dozens of slices, not one) and the missing
// manifest is not cached (a deployment fixed under a running host starts
// serving without a restart).

import { describe, expect, it, vi } from 'vitest'

/** Where the route looks for its manifest; the host resolves it beside its bundle. */
const assets = { dir: '../assets/fonts-that-never-arrived' }

vi.mock('../src/font-slices.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/font-slices.ts')>(),
  get FONT_ASSET_DIR() { return assets.dir },
}))

const { fontRoute, resetFontSlicesForTests, serveFontSlice } = await import('../src/index.ts')
const { FONT_ROUTE } = await import('../src/font-slices.ts')

/** A response stub that records what the route wrote. */
function responseStub(): { statusCode: number; body: Uint8Array | string | undefined; setHeader: (name: string, value: string) => void; end: (body?: Uint8Array | string) => void } {
  return {
    statusCode: 0,
    body: undefined,
    setHeader() {},
    end(body?: Uint8Array | string) { this.body = body },
  }
}

/** One `regular-latin.woff2` request through the route. */
async function request(handler: (req: { url: string; method: string }, res: ReturnType<typeof responseStub>) => Promise<void>): Promise<ReturnType<typeof responseStub>> {
  const res = responseStub()
  await handler({ url: `${FONT_ROUTE}/regular-latin.woff2`, method: 'GET' }, res)
  return res
}

describe('the code font route without its assets', () => {
  it('answers 404, reports it once per route, and keeps asking for the manifest', async () => {
    resetFontSlicesForTests()
    assets.dir = '../assets/fonts-that-never-arrived'
    const warnings: string[] = []
    const route = fontRoute(message => warnings.push(message))
    expect(route.path).toBe(FONT_ROUTE)
    for (const _ of [0, 1, 2]) {
      const res = await request(route.handler)
      expect(res.statusCode).toBe(404)
      expect(res.body).toBe('font unavailable')
    }
    // One line for the page, however many slices it asked for — and it names the
    // absolute path it looked in, so a deployment problem is diagnosable from the
    // log alone (the separator is the host's, so only the parts are asserted).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('fonts-that-never-arrived')
    expect(warnings[0]).toContain('manifest.json')
  })

  it('reports every time it is handed a reporter, so the route owns the dedupe', async () => {
    resetFontSlicesForTests()
    assets.dir = '../assets/fonts-that-never-arrived'
    const warnings: string[] = []
    const res = await request((req, response) => serveFontSlice(req, response, message => warnings.push(message)))
    expect(res.statusCode).toBe(404)
    expect(warnings).toHaveLength(1)
  })

  it('serves as soon as the manifest is there, without a restart', async () => {
    resetFontSlicesForTests()
    // The deployment as it is: nothing beside the bundle.
    assets.dir = '../assets/fonts-that-never-arrived'
    const route = fontRoute(() => {})
    expect((await request(route.handler)).statusCode).toBe(404)
    // …and the deployment after the reinstall that put `assets/fonts` there. A
    // cached negative answer would keep this a 404 until the host restarted.
    assets.dir = '../assets/fonts'
    const res = await request(route.handler)
    expect(res.statusCode).toBe(200)
    expect(Buffer.from(res.body as Uint8Array).subarray(0, 4).toString('latin1')).toBe('wOF2')
  })
})
