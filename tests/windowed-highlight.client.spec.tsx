// @vitest-environment jsdom
// The windowed highlight store: which lines get highlighted when, and that the
// viewer never pays for lines nobody is looking at.

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWindowedHighlight } from '../src/client/windowed-highlight.ts'
import type { WindowedHighlightInput } from '../src/client/windowed-highlight.ts'
import { highlightWindow } from '../src/client/highlight.ts'

// Spy (keeping the real tokenizer) so a test can say which line ranges were asked
// for, not just what ended up highlighted.
vi.mock('../src/client/highlight.ts', { spy: true })

const LINES = Array.from({ length: 1000 }, (_, index) => `const v${index} = ${index}`)
/** One stable key object: a *new* object means new content, as the hook's contract
 *  says, so a re-render of the same file must pass the same one back. */
const KEY = { file: 'a' }

function inputFor(overrides: Partial<WindowedHighlightInput> = {}): WindowedHighlightInput {
  return {
    key: KEY,
    oldLines: LINES,
    newLines: LINES,
    lang: 'typescript',
    oldRange: { from: 1, to: 10 },
    newRange: { from: 1, to: 10 },
    live: false,
    ...overrides,
  }
}

/** Let the scheduled work run (fake timers: 0 for the first pass, 120 ms a chunk). */
const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }
/** The line ranges the highlighter was asked for, in order. */
const asked = (): number[][] => vi.mocked(highlightWindow).mock.calls.map(call => [call[2], call[3]])

afterEach(() => { vi.useRealTimers() })

describe('useWindowedHighlight', () => {
  it('highlights the visible window (plus its margin) and nothing beyond it', () => {
    vi.useFakeTimers()
    const { result } = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor(),
    })
    advance(0)
    // Window: lines 1..10 visible, 40 lines of margin above/below → 0..49.
    expect(result.current.newRuns[0]).toBeDefined()
    expect(result.current.newRuns[49]).toBeDefined()
    expect(result.current.newRuns[50]).toBeUndefined()
    // The whole 1000-line file was never touched.
    expect(result.current.newRuns.filter(Boolean).length).toBeLessThanOrEqual(400)
  })

  it('does no work when the window is already covered, and only the new lines when it grows', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor(),
    })
    advance(0)
    const runs = result.current.newRuns
    const calls = asked().length
    // A window fully inside what is already highlighted (the margin either side is
    // already coloured): no pass at all, and no publish, so no re-render either.
    rerender(inputFor({ newRange: { from: 5, to: 9 }, oldRange: { from: 5, to: 9 } }))
    advance(200)
    expect(asked().length).toBe(calls)
    expect(result.current.newRuns).toBe(runs)

    // Scrolling past what is coloured tokenizes only the missing part: the covered
    // prefix is skipped (50 is the first line the store does not have) and the new
    // margin below it is filled in the same pass.
    rerender(inputFor({ newRange: { from: 60, to: 70 }, oldRange: { from: 60, to: 70 } }))
    advance(200)
    const added = asked().slice(calls)
    expect(added.length).toBeGreaterThan(0)
    for (const [from, to] of added) {
      expect(from).toBe(50)
      expect(to! - from!).toBeLessThanOrEqual(70)
    }
    expect(result.current.newRuns[109]).toBeDefined()
    expect(result.current.newRuns[110]).toBeUndefined()
  })

  it('follows a jump to the far end without touching the lines above it', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor(),
    })
    advance(0)
    rerender(inputFor({ newRange: { from: 990, to: 1000 }, oldRange: { from: 990, to: 1000 } }))
    advance(200)
    expect(result.current.newRuns[999]).toBeDefined()
    expect(result.current.newRuns[500]).toBeUndefined()
    expect(result.current.newRuns[0]).toBeDefined()
  })

  it('backfills in idle chunks when a real viewport is reported, and only then', () => {
    vi.useFakeTimers()
    const still = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor(),
    })
    advance(0)
    // No viewport: no prefetching at all.
    advance(2000)
    expect(still.result.current.newRuns[400]).toBeUndefined()
    still.unmount()

    const live = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor({ live: true }),
    })
    advance(0)
    expect(live.result.current.newRuns[400]).toBeUndefined()
    // One chunk per idle step, top-down, 400 lines at a time, alternating sides.
    advance(150)
    expect(live.result.current.oldRuns[399]).toBeDefined()
    expect(live.result.current.newRuns[399]).toBeUndefined()
    advance(150)
    expect(live.result.current.newRuns[399]).toBeDefined()
    expect(live.result.current.newRuns[400]).toBeUndefined()
    // It stops when the file runs out instead of spinning.
    advance(5000)
    expect(live.result.current.newRuns[999]).toBeDefined()
    live.unmount()
  })

  it('starts clean when the file or language changes', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor(),
    })
    advance(0)
    expect(result.current.newRuns[0]).toBeDefined()
    // A new content identity: the previous file's colors must not survive, even
    // for the lines the new one has not reached yet.
    rerender(inputFor({ key: { file: 'b' } }))
    expect(result.current.newRuns.filter(Boolean).length).toBe(0)
    advance(0)
    expect(result.current.newRuns[0]).toBeDefined()
  })

  it('leaves lines plain for a language it has no grammar for', () => {
    vi.useFakeTimers()
    const { result } = renderHook((props: WindowedHighlightInput) => useWindowedHighlight(props), {
      initialProps: inputFor({ lang: undefined, live: true }),
    })
    advance(1000)
    expect(result.current.newRuns.filter(Boolean).length).toBe(0)
  })
})
