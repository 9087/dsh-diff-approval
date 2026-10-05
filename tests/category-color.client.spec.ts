// A comment's CATEGORY, drawn as a colour: the one place the palette and the hash live. The colour has to
// be the same on any host and after any reload, so the mapping is a pure function of the id and nothing
// else — and the palette has to be readable, which is measured here in CIEDE2000 rather than asserted by
// eye or by hue angle (the hue floor this test used to carry passed a near-duplicate green at ΔE00 2.65).

import { describe, expect, it } from 'vitest'
import { CATEGORY_COLORS, categoryColor, categoryColorIndex } from '../src/client/category-color.ts'

// --- CIEDE2000: sRGB → linear → XYZ (D65) → Lab → ΔE00 ------------------------------------------------
// Sharma, Wu & Dalal (2005), "The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary
// Test Data, and Mathematical Observations" — the notes' branch handling for h̄′ and ΔH′. The reference
// pairs are checked below, so the metric this file pins the palette WITH is itself pinned.

const srgbToLinear = (value: number): number => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** One `#RRGGBB` colour as CIE L*a*b* under D65. */
function hexToLab(hex: string): [number, number, number] {
  const red = srgbToLinear(parseInt(hex.slice(1, 3), 16))
  const green = srgbToLinear(parseInt(hex.slice(3, 5), 16))
  const blue = srgbToLinear(parseInt(hex.slice(5, 7), 16))
  const x = (0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047
  const y = 0.2126729 * red + 0.7151522 * green + 0.0721750 * blue
  const z = (0.0193339 * red + 0.1191920 * green + 0.9503041 * blue) / 1.08883
  const f = (t: number): number => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIEDE2000 ΔE between two L*a*b* colours (kL = kC = kH = 1). */
function deltaE00(lab1: readonly number[], lab2: readonly number[]): number {
  const [l1, a1, b1] = lab1 as [number, number, number]
  const [l2, a2, b2] = lab2 as [number, number, number]
  const rad = Math.PI / 180
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const degrees = (value: number): number => (value * 180) / Math.PI
  const hueOf = (a: number, b: number): number => {
    if (a === 0 && b === 0) return 0
    const hue = degrees(Math.atan2(b, a))
    return hue >= 0 ? hue : hue + 360
  }
  const h1p = hueOf(a1p, b1)
  const h2p = hueOf(a2p, b2)
  const dLp = l2 - l1
  const dCp = c2p - c1p
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * rad) / 2)
  const lBarP = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP = h1p + h2p
  if (c1p * c2p !== 0) hBarP = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2
  const t = 1 - 0.17 * Math.cos((hBarP - 30) * rad) + 0.24 * Math.cos(2 * hBarP * rad)
    + 0.32 * Math.cos((3 * hBarP + 6) * rad) - 0.20 * Math.cos((4 * hBarP - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(2 * dTheta * rad) * rc
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh))
}

/** The closest pair in a palette, and how close it reads. */
function closestPair(colors: readonly string[]): { distance: number; pair: string } {
  let closest = { distance: Infinity, pair: '' }
  for (let first = 0; first < colors.length; first += 1) {
    for (let second = first + 1; second < colors.length; second += 1) {
      const distance = deltaE00(hexToLab(colors[first]!), hexToLab(colors[second]!))
      if (distance < closest.distance) closest = { distance, pair: `${colors[first]}/${colors[second]}` }
    }
  }
  return closest
}

describe('the CIEDE2000 metric this spec pins the palette with', () => {
  it('reproduces Sharma\'s reference pairs to four decimals', () => {
    // Four of the paper's pairs, chosen for the branches they exercise (the h̄′ wrap, the ΔH′ term, and one
    // pair with no chroma at all). A metric that is wrong here would pin the palette to the wrong floor.
    const pairs: Array<[readonly number[], readonly number[], number]> = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
      [[50, 0, 0], [50, -1, 2], 2.3669],
    ]
    for (const [first, second, expected] of pairs) {
      expect(deltaE00(first, second)).toBeCloseTo(expected, 4)
    }
  })
})

describe('categoryColor', () => {
  it('offers twelve colours, all of them different', () => {
    // Twelve because that is what the hash indexes and what the reader can hold apart; distinct because a
    // repeated entry would make two classes indistinguishable.
    expect(CATEGORY_COLORS).toHaveLength(12)
    expect(new Set(CATEGORY_COLORS).size).toBe(12)
  })

  it('gives one id the same colour on every call', () => {
    // The promise the feature is built on: the same class of annotation looks the same everywhere, across
    // calls, hosts and reloads — because nothing but the id goes in.
    const id = '11111111-1111-1111-1111-111111111111'
    const first = categoryColor(id)
    expect(categoryColor(id)).toBe(first)
    expect(categoryColorIndex(id)).toBe(categoryColorIndex(id))
    expect(categoryColor(id)).toBe(CATEGORY_COLORS[categoryColorIndex(id)])
  })

  it('pins the index a fixed id maps to, so the hash cannot drift silently', () => {
    // A concrete pair, as the brief asks: this id lands in bucket 5, whose colour is the dark teal. Changing
    // the hash (or reordering the palette) recolours every existing annotation, so it must fail here first.
    // It survived the 2026-10-06 reorder by luck — the maximal-spread order happens to keep dark teal at
    // index 5 — but its NEIGHBOURS changed with every other index, and the consecutive pin below is what
    // makes that a deliberate decision rather than a silent recolouring.
    expect(categoryColorIndex('11111111-1111-1111-1111-111111111111')).toBe(5)
    expect(categoryColor('11111111-1111-1111-1111-111111111111')).toBe('#1D6F66')
  })

  it('is not a constant: different ids reach different colours, and collisions are possible', () => {
    // Two DIFFERENT ids CAN share a bucket — twelve of them cannot promise otherwise, which is why the mark
    // also carries the id in words and why the tool tells an agent to reuse one id per class. What must never
    // happen is every id landing on one colour, which is the regression a constant mapping produces.
    const ids = ['pass-1', 'pass-2', 'run-a', 'run-b', 'alpha', 'beta']
    expect(new Set(ids.map(categoryColor)).size).toBeGreaterThan(1)
    expect(categoryColorIndex('alpha')).toBe(categoryColorIndex('beta'))
  })

  it('keeps every pair of palette colours at least 18.82 ΔE00 apart', () => {
    // THE PIN, and the reason the palette is not arranged by hue: perceptual distance is what a 3px mark is
    // judged by, and hue angle is blind to it. The set's measured minimum is 18.8221 — light blue `#80A5EB`
    // against grey `#7F888E` — so the floor is that value; a colour added any closer than this fails here.
    // For scale: the palette this replaced held indigo against purple at 6.94, and a near-duplicate green
    // (`#57a751`, ΔE00 2.65) passed the hue-angle floor that used to stand in this test.
    const closest = closestPair(CATEGORY_COLORS)
    expect(closest.distance, `closest pair is ${closest.pair}`).toBeGreaterThanOrEqual(18.82)
  })

  it('keeps every CONSECUTIVE pair of palette colours at least 32.75 ΔE00 apart', () => {
    // THE ORDER, not the set (2026-10-06). The bucket IS the array index and the hash is FNV-1a mod 12, so
    // two categories land on ADJACENT indices 2 times out of 12 — the reader's own pair did, and the order
    // shipped first was a hue ramp whose consecutive minimum was only 19.28 (bronze `#8D711B` / olive
    // `#577F11`). What is below is the bottleneck Hamiltonian path over these same twelve colours: the order
    // that maximises the minimum over the eleven consecutive pairs, proved optimal by a DP over
    // (mask, last) in the scratch script that chose it. Its measured consecutive minimum is **32.7475**,
    // owned by the grey `#7F888E` and the red `#C33D41`. So moving any entry into a slot next to one of its
    // near neighbours — or appending a thirteenth anywhere but the far end — fails HERE, which is what makes
    // the array's order load-bearing rather than cosmetic.
    let minimum = Infinity
    let owning = ''
    for (let index = 0; index + 1 < CATEGORY_COLORS.length; index += 1) {
      const distance = deltaE00(hexToLab(CATEGORY_COLORS[index]!), hexToLab(CATEGORY_COLORS[index + 1]!))
      if (distance < minimum) { minimum = distance; owning = `${CATEGORY_COLORS[index]}/${CATEGORY_COLORS[index + 1]}` }
    }
    expect(minimum, `closest consecutive pair is ${owning}`).toBeGreaterThanOrEqual(32.7474)
  })

  it('keeps every colour mid-tone, so a mark reads on either background', () => {
    // The other half of "reads on the panel's light and dark surfaces": a near-black or near-white dot is
    // invisible on one of them, however far it sits from its neighbours. L* 42..70 is the band the palette was
    // chosen in, and this stops a future entry sliding out of it for the sake of the ΔE00 floor.
    for (const color of CATEGORY_COLORS) {
      const lightness = hexToLab(color)[0]
      expect(lightness, `${color} is L*${lightness.toFixed(1)}`).toBeGreaterThanOrEqual(42)
      expect(lightness, `${color} is L*${lightness.toFixed(1)}`).toBeLessThanOrEqual(70)
    }
  })
})
