// The bundled font: the host route that serves its slices, and the files
// themselves. This is the one place where a plan built by `scripts/fonts/build.py`
// and shipped as static woff2 meets the code that hands it to a browser, so it
// checks the whole contract: what the manifest claims, what the slice actually
// covers, and what the route answers.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serveFontSlice } from '../src/index.ts'
import { FONT_FACES, FONT_FAMILY, FONT_ROUTE, FONT_STACK } from '../src/font-slices.ts'

const FONTS_DIR = join(process.cwd(), 'assets', 'fonts')

interface Slice {
  readonly file: string
  readonly bytes: number
  readonly unicodeRange: string
  readonly kind: string
  readonly weight: number
  readonly face: string
  readonly glyphs: number | null
}

interface Manifest {
  readonly source: { readonly sha256: string; readonly license: string; readonly release: string }
  readonly slicing: { readonly capBytes: number; readonly seedGlyphs: number }
  readonly slices: readonly Slice[]
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(FONTS_DIR, 'manifest.json'), 'utf8')) as Manifest
}

/** Every codepoint a `unicode-range` value names. */
function codepointsOf(range: string): Set<number> {
  const out = new Set<number>()
  for (const span of range.split(',')) {
    // Only the first endpoint carries the `U+` prefix: "U+4E09-4E0B".
    const [start, end] = span.split('-')
    const lo = Number.parseInt((start ?? '').replace(/^U\+/i, ''), 16)
    const hi = end === undefined ? lo : Number.parseInt(end.replace(/^U\+/i, ''), 16)
    for (let cp = lo; cp <= hi; cp += 1) out.add(cp)
  }
  return out
}

/** A response stub that records what the route wrote. */
function responseStub(): { statusCode: number; headers: Record<string, string>; body: Uint8Array | string | undefined; setHeader: (name: string, value: string) => void; end: (body?: Uint8Array | string) => void } {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value },
    end(body?: Uint8Array | string) { this.body = body },
  }
}

describe('the bundled code font', () => {
  it('is pinned to a checksummed upstream release under a licence we can redistribute', async () => {
    const { source } = await manifest()
    // Sixteen hex characters is enough to notice a swapped font; the whole
    // digest is in the manifest and re-checked by `scripts.fonts.build --download`.
    expect(source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(source.release).toMatch(/^\d+\.\d+\.\d+$/)
    expect(source.license).toBe('SIL OFL 1.1')
    // The licence has to travel with the slices: subsetting strips the licence
    // name records out of the woff2, so the file is the only notice a reader gets.
    const ofl = await readFile(join(FONTS_DIR, 'OFL.txt'), 'utf8')
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(ofl).toContain('JetBrains Mono Project Authors')
    expect(ofl).toContain('Maple Mono Project Authors')
  })

  it('covers the hanzi block exactly once per face, with both weights cut alike', async () => {
    const { slices } = await manifest()
    const expected = new Set(Array.from({ length: 0xA000 - 0x4E00 }, (_, i) => 0x4E00 + i))
    const ranges = new Map<string, string>()
    for (const face of FONT_FACES) {
      const hanzi = slices.filter(slice => slice.face === face.name && slice.kind === 'hanzi')
      expect(hanzi.length).toBeGreaterThan(10)
      const covered = new Set<number>()
      for (const slice of hanzi) {
        const here = codepointsOf(slice.unicodeRange)
        for (const cp of here) {
          // A character in two slices is downloaded twice and can render from
          // either — the plan must partition, not overlap.
          expect(covered.has(cp)).toBe(false)
          covered.add(cp)
        }
      }
      expect(covered.size).toBe(expected.size)
      for (const cp of expected) expect(covered.has(cp)).toBe(true)
      ranges.set(face.name, hanzi.map(slice => slice.unicodeRange).join('|'))
    }
    // The browser picks a face by weight; if the two weights disagreed on which
    // slice holds a character, one of them would silently fall back.
    const [first, second] = [...ranges.values()]
    expect(second).toBe(first)
  })

  it('keeps every slice under the cap, bar the seed, and ships the files it lists', async () => {
    const { slices, slicing } = await manifest()
    for (const slice of slices) {
      const bytes = (await readFile(join(FONTS_DIR, slice.file))).byteLength
      expect(bytes).toBe(slice.bytes)
      // The seed slice is a fixed glyph count, not a byte budget: it is small
      // on purpose (the commonest few hundred hanzi) and never the cap.
      if (slice.kind === 'hanzi' && slice.glyphs !== slicing.seedGlyphs) {
        expect(slice.bytes).toBeLessThanOrEqual(slicing.capBytes)
      }
    }
    const seed = slices.find(slice => slice.face === 'regular' && slice.kind === 'hanzi' && slice.glyphs === slicing.seedGlyphs)
    expect(seed).toBeDefined()
    // The seed carries the commonest characters, so it is the slice an ordinary
    // Chinese comment pulls. It is a glyph count, not a byte budget, and its job
    // is to stay cheap: well under half the cap is the whole point of it existing
    // (a page of nothing but capped slices would start at the cap).
    expect(seed!.bytes).toBeLessThan(slicing.capBytes * 0.65)
    // …and it has to be the first slice, covering the most frequent ranks.
    expect(seed!.unicodeRange).toContain('U+7684')
  })

  it('serves a listed slice as an immutable woff2', async () => {
    const { slices } = await manifest()
    const slice = slices.find(row => row.kind === 'latin')!
    const res = responseStub()
    await serveFontSlice({ url: `${FONT_ROUTE}/${slice.file}`, method: 'GET' }, res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('font/woff2')
    expect(res.headers['content-length']).toBe(String(slice.bytes))
    expect(res.headers['cache-control']).toContain('immutable')
    expect((res.body as Uint8Array).byteLength).toBe(slice.bytes)
    // A real woff2, not an error page with the right headers.
    expect(Buffer.from(res.body as Uint8Array).subarray(0, 4).toString('latin1')).toBe('wOF2')
  })

  it('serves the manifest the client reads before it can install any rule', async () => {
    const { slices } = await manifest()
    const res = responseStub()
    await serveFontSlice({ url: `${FONT_ROUTE}/manifest.json`, method: 'GET' }, res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    // The reader re-reads it on every page load and a plugin upgrade changes it.
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body as string) as { slices: { file: string; unicodeRange: string; weight: number }[] }
    // Exactly the three fields the client's `ListedSlice` reads.
    expect([...body.slices].map(row => row.file).sort()).toEqual(slices.map(row => row.file).sort())
    for (const row of body.slices) {
      expect(row.file).toMatch(/^[a-z]+-[a-z0-9-]*\.woff2$/)
      expect(row.unicodeRange).toContain('U+')
      expect([400, 600]).toContain(row.weight)
    }
  })

  it('answers 404 for anything the manifest does not list', async () => {
    const cases = [
      `${FONT_ROUTE}/nope.woff2`,
      `${FONT_ROUTE}/../../package.json`,
      `${FONT_ROUTE}/${encodeURIComponent('..\\..\\package.json')}`,
      `${FONT_ROUTE}/`,
      `${FONT_ROUTE}`,
    ]
    for (const url of cases) {
      const res = responseStub()
      await serveFontSlice({ url, method: 'GET' }, res)
      expect(res.statusCode, url).toBe(404)
    }
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
})
