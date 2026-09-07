// HSV color-picker helpers: parse hex/rgb text and round-trip through HSV.

import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex, parseColor } from '../src/client/ColorPicker.tsx'

describe('parseColor', () => {
  it('parses #rrggbb, #rgb, bare hex, and rgb()/rgba()', () => {
    expect(parseColor('#22C55E')).toBe('#22c55e')
    expect(parseColor('22c55e')).toBe('#22c55e')
    expect(parseColor('#0f0')).toBe('#00ff00')
    expect(parseColor('rgb(17, 34, 51)')).toBe('#112233')
    expect(parseColor('rgba(17, 34, 51, 0.5)')).toBe('#112233')
  })

  it('returns undefined for non-colors', () => {
    expect(parseColor('not-a-color')).toBeUndefined()
    expect(parseColor('#12')).toBeUndefined()
  })
})

describe('hsv round-trip', () => {
  it('converts a hex to HSV and back unchanged', () => {
    for (const hex of ['#22c55e', '#ef4444', '#112233', '#ffffff', '#000000']) {
      const hsv = hexToHsv(hex)
      expect(hsvToHex(hsv.h, hsv.s, hsv.v)).toBe(hex)
    }
  })

  it('produces the expected hue for primary colors', () => {
    expect(hexToHsv('#ff0000').h).toBe(0)
    expect(hexToHsv('#00ff00').h).toBe(120)
    expect(hexToHsv('#0000ff').h).toBe(240)
  })
})
