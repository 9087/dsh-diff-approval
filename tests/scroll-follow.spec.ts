import { describe, expect, it } from 'vitest'
import { frameFollowIsAnimated, frameFollowKeyframes } from '../src/client/scroll-follow.ts'

/** The clamp the animation has to reproduce, straight from its definition. */
function clampAt(anchorTop: number, maxScroll: number, viewportHeight: number, frameHeight: number, progress: number): number {
  return Math.min(Math.max(0, viewportHeight - frameHeight), Math.max(0, anchorTop - progress * maxScroll))
}

/** What the browser renders: linear between the stops, held flat outside them. */
function interpolate(stops: { offset: number; y: number }[], progress: number): number {
  const first = stops[0]!
  const last = stops[stops.length - 1]!
  if (progress <= first.offset) return first.y
  if (progress >= last.offset) return last.y
  for (let index = 1; index < stops.length; index++) {
    const before = stops[index - 1]!
    const after = stops[index]!
    if (progress <= after.offset) {
      const span = after.offset - before.offset
      return span === 0 ? after.y : before.y + ((progress - before.offset) / span) * (after.y - before.y)
    }
  }
  return last.y
}

describe('when the follow animation can place the frame', () => {
  it('leaves it to the render when the code does not scroll', () => {
    // A scroller with no range has an inactive timeline: an animation on it reports a
    // null current time and is never applied, which parked the frame at the wrapper's
    // top edge — the top of the viewport — on a file short enough not to scroll.
    expect(frameFollowIsAnimated(true, 300, 0)).toBe(false)
    // The same before the box has been measured, and where there is no scroll timeline.
    expect(frameFollowIsAnimated(true, 0, 900)).toBe(false)
    expect(frameFollowIsAnimated(false, 300, 900)).toBe(false)
    // A measured box with a real range is the case the animation is for.
    expect(frameFollowIsAnimated(true, 300, 900)).toBe(true)
  })
})

describe('the action frame\'s follow animation', () => {
  it('reproduces the clamped follow exactly, whatever the anchor', () => {
    // The whole point of listing the corners: the animation is not an approximation of
    // "follow the row, stay on screen" - it has to land on the same pixel the direct
    // calculation would, at every scroll offset.
    const cases: { anchorTop: number; maxScroll: number; viewport: number }[] = [
      { anchorTop: 200, maxScroll: 1000, viewport: 300 },
      { anchorTop: 900, maxScroll: 1000, viewport: 300 },
      { anchorTop: 1200, maxScroll: 1000, viewport: 300 },
      { anchorTop: 60, maxScroll: 4000, viewport: 300 },
      { anchorTop: 88, maxScroll: 0, viewport: 300 },
      { anchorTop: 0, maxScroll: 500, viewport: 300 },
    ]
    for (const testCase of cases) {
      const stops = frameFollowKeyframes(testCase.anchorTop, testCase.maxScroll, testCase.viewport, 40)
      expect(stops.length).toBeGreaterThan(0)
      // Ascending, inside the range, no duplicates: WAAPI rejects anything else.
      const offsets = stops.map(stop => stop.offset)
      expect(offsets).toEqual([...new Set(offsets)].sort((left, right) => left - right))
      for (const offset of offsets) expect(offset).toBeGreaterThanOrEqual(0)
      for (const offset of offsets) expect(offset).toBeLessThanOrEqual(1)
      for (let step = 0; step <= 20; step++) {
        const progress = step / 20
        const expected = clampAt(testCase.anchorTop, testCase.maxScroll, testCase.viewport, 40, progress)
        expect(interpolate(stops, progress)).toBeCloseTo(expected, 6)
      }
    }
  })

  it('starts on the anchor and stops where the viewport\'s edges stop it', () => {
    // A row inside the viewport: the frame sits on it and then rides up with the code.
    expect(frameFollowKeyframes(200, 1000, 300, 40)).toEqual([
      { offset: 0, y: 200 },
      { offset: 0.2, y: 0 },
      { offset: 1, y: 0 },
    ])
    // A row below the viewport: the frame is held at the bottom edge (300 - 40) until the
    // row comes into view, and only then starts following it.
    expect(frameFollowKeyframes(560, 1000, 300, 40)).toEqual([
      { offset: 0, y: 260 },
      { offset: 0.3, y: 260 },
      { offset: 0.56, y: 0 },
      { offset: 1, y: 0 },
    ])
    // A row that stays below the viewport even at the end of the scroll: the clamp is
    // constant, so there is nothing to interpolate.
    expect(frameFollowKeyframes(1400, 1000, 300, 40)).toEqual([
      { offset: 0, y: 260 },
      { offset: 1, y: 260 },
    ])
  })

  it('has nothing to interpolate when the code does not scroll', () => {
    // No scrollable range means the progress is always 0, so a single stop is the whole
    // animation: the clamp at rest.
    expect(frameFollowKeyframes(120, 0, 300, 40)).toEqual([{ offset: 0, y: 120 }])
    expect(frameFollowKeyframes(500, 0, 300, 40)).toEqual([{ offset: 0, y: 260 }])
  })
})
