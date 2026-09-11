/**
 * Windowed syntax highlighting for the diff viewer.
 *
 * The code view renders a virtual window of rows, so the viewer only ever needs
 * the colors of the lines near the viewport. Highlighting a whole file to show
 * one screenful is almost all waste — measured on a 3818-line file, the two
 * sides whole-file cost ~945 ms of main-thread time against ~8 ms for one window
 * — so this hook keeps a per-side store of highlighted lines and fills it:
 *
 * 1. **The window first.** Whenever the visible line range changes, the lines
 *    that are missing are highlighted (with a margin either side, debounced, so a
 *    fast scroll computes the window it lands on instead of every window it
 *    passes). A window with no state yet gets `context` lines above it so a
 *    construct that started earlier still colours correctly.
 * 2. **Already-highlighted lines are kept.** Scrolling back, or nudging the
 *    window by a few rows, finds the lines present and does no work at all.
 * 3. **An idle backfill** walks the file top-down in chunks when the pane reports
 *    a real viewport, recording the exact grammar state at each chunk boundary.
 *    Windows inside a backfilled region then resume exactly (no context guess),
 *    and a random scroll position is coloured before the user gets there.
 *
 * Lines that have never been highlighted are holes in the returned arrays: the
 * viewer renders them plain, which is the honest state of the work done so far.
 * @module dsh-diff-approval/client/windowed-highlight
 */

import { useEffect, useRef, useState } from 'react'
import type { HighlightSides, HighlightSpan, HighlightState } from './highlight.ts'
import { highlightWindow } from './highlight.ts'

/** One visible window, in source lines (1-based, inclusive). */
export interface LineRange {
  from: number
  to: number
}

/** The source lines one view is showing, plus whether that view measured a real
 *  viewport. Reported by whichever view is mounted (the single column computes its
 *  own window; the split view reports its own, which is the only one that matches
 *  its scroll container). */
export interface VisibleLines {
  oldRange: LineRange | undefined
  newRange: LineRange | undefined
  live: boolean
}

/** What the hook needs to know about the file and the pane. */
export interface WindowedHighlightInput {
  /** Identity of the content and language: a change resets everything. */
  key: unknown
  /** The old side's lines (index 0 = line 1). */
  oldLines: readonly string[]
  /** The new side's lines (index 0 = line 1). */
  newLines: readonly string[]
  /** The Shiki grammar id, or undefined for plain text. */
  lang: string | undefined
  /** The visible source lines of the old side, if any are on screen. */
  oldRange: LineRange | undefined
  /** The visible source lines of the new side, if any are on screen. */
  newRange: LineRange | undefined
  /** Whether the pane reports a real viewport. The idle backfill only runs with
   *  one: without a viewport (a test DOM, a pane that has not measured yet) there
   *  is no "idle" to spend and nothing to prefetch for. */
  live: boolean
}

/** Lines either side of the visible window to highlight, so a small scroll reuses
 *  what is already there instead of starting a new pass. */
const WINDOW_MARGIN_LINES = 40
/** Ceiling on one pass. A huge viewport (or a pane that reports no viewport at
 *  all, where the virtual window falls back to the whole file) must not turn one
 *  pass into a whole-file tokenize. */
const MAX_WINDOW_LINES = 400
/** Lines above a window that only inform the grammar when no state is saved. */
const CONTEXT_LINES = 40
/** A window pass waits this long, so scrolling computes where it lands, not every
 *  window it crosses (a crossed window costs ~8 ms, a swept file ~1.3 s). */
const DEBOUNCE_MS = 90
/** How much of the file the idle backfill tokenizes per step. */
const BACKFILL_CHUNK_LINES = 400
/** Where the idle backfill stops, per side. A few screens ahead is where the
 *  payoff is; past that the window pass colours whatever is looked at anyway, and
 *  a huge file must not churn in the background indefinitely. */
const BACKFILL_MAX_LINES = 6000
/** Idle delay before the backfill's next chunk (also its `requestIdleCallback`
 *  timeout, so a busy page still makes progress). */
const BACKFILL_DELAY_MS = 120

/** One side's highlighted lines and the states that make continuations exact. */
interface SideStore {
  /** Runs per line (index = line - 1); a hole has not been highlighted. */
  runs: HighlightSpan[][]
  /** Exact grammar states at line boundaries, keyed by line index. */
  states: Map<number, HighlightState>
  /** How far the idle backfill has reached, from line 0, exactly. */
  filled: number
}

interface Store {
  key: unknown
  old: SideStore
  new: SideStore
}

function emptySide(): SideStore {
  return { runs: [], states: new Map(), filled: 0 }
}

function emptyStore(key: unknown): Store {
  return { key, old: emptySide(), new: emptySide() }
}

/** The greatest saved state at or before `line`, or undefined when the file's own
 *  top is the only known state. States are only written at chunk boundaries, so
 *  the map stays tiny; the scan is over those, never over the file. */
function stateAt(side: SideStore, line: number): HighlightState {
  let best = -1
  let state: HighlightState
  for (const [at, value] of side.states) {
    if (at <= line && at > best) {
      best = at
      state = value
    }
  }
  return state
}

/**
 * Whether every line of `[from, to)` already has runs.
 * @param side - the side's store.
 * @param from - first line index.
 * @param to - one past the last line index.
 * @returns whether the range is fully covered.
 */
function covered(side: SideStore, from: number, to: number): boolean {
  for (let line = from; line < to; line++) {
    if (side.runs[line] === undefined) return false
  }
  return true
}

/**
 * Highlight one side's line range into its store, resuming exactly from any saved
 * state at or above it (and from context lines when there is none).
 * @param side - the side's store.
 * @param lines - the side's lines.
 * @param lang - the grammar id.
 * @param from - first line index.
 * @param to - one past the last line index.
 * @returns whether anything was written.
 */
function fill(side: SideStore, lines: readonly string[], lang: string | undefined, from: number, to: number): boolean {
  let start = Math.max(0, Math.min(from, lines.length))
  let end = Math.max(0, Math.min(to, lines.length))
  if (end <= start) return false
  // Tokenize only the part that is missing: a window that grew by a few rows asks
  // for its whole margin, and re-tokenizing the already-coloured lines in it would
  // make every small scroll cost a full window.
  while (start < end && side.runs[start] !== undefined) start++
  while (end > start && side.runs[end - 1] !== undefined) end--
  if (end <= start) return false
  const state = stateAt(side, start)
  const result = highlightWindow(lines, lang, start, end, {
    ...(state === undefined ? { context: CONTEXT_LINES } : { state }),
  })
  if (result === undefined) return false
  result.runs.forEach((runs, index) => { side.runs[start + index] = runs })
  side.states.set(end, result.state)
  return true
}

/**
 * Keep syntax highlighting for the pane's visible window, plus (with a live
 * viewport) an idle top-down backfill of the rest.
 * @param input - the file's lines, language, and the visible line ranges.
 * @returns the runs per side, indexed by line - 1, with holes for unhighlighted lines.
 */
export function useWindowedHighlight(input: WindowedHighlightInput): HighlightSides {
  const storeRef = useRef<Store>(emptyStore(input.key))
  const [sides, setSides] = useState<HighlightSides>({ oldRuns: [], newRuns: [] })
  // A window pass wins over the backfill: the backfill checks this before its own
  // chunk, so a scroll is never queued behind hundreds of prefetched lines.
  const windowPendingRef = useRef(false)

  const publish = (): void => {
    const store = storeRef.current
    setSides({ oldRuns: [...store.old.runs], newRuns: [...store.new.runs] })
  }

  // A new file (or language) starts clean, before the browser paints: line 5 of
  // the new file must never wear line 5 of the old file's colors.
  useEffect(() => {
    if (Object.is(storeRef.current.key, input.key)) return
    storeRef.current = emptyStore(input.key)
    setSides({ oldRuns: [], newRuns: [] })
  }, [input.key])

  const { oldLines, newLines, lang, oldRange, newRange, live } = input
  const oldFrom = oldRange?.from
  const oldTo = oldRange?.to
  const newFrom = newRange?.from
  const newTo = newRange?.to

  // 1. The visible window (debounced: a scroll computes where it lands). A pass
  //    with nothing missing does no work, which is what makes scrolling back free.
  useEffect(() => {
    const store = storeRef.current
    if (!Object.is(store.key, input.key)) return
    const targets = [
      { side: store.old, lines: oldLines, range: oldRange },
      { side: store.new, lines: newLines, range: newRange },
    ]
    const pending = targets.filter(({ side, lines, range }) => {
      if (range === undefined) return false
      // Ask about the *visible* lines only: work is done when they are not
      // covered, and that work then fills the margin around them. Asking about
      // the margin instead would re-tokenize on every small scroll, because each
      // pass would want a margin further out than the last one left.
      const visibleFrom = Math.max(0, range.from - 1)
      const visibleTo = Math.min(lines.length, range.to)
      return !covered(side, visibleFrom, visibleTo)
    })
    if (pending.length === 0) {
      windowPendingRef.current = false
      return
    }
    windowPendingRef.current = true
    // The first pass after opening a file runs immediately: the pane already
    // painted its plain rows, and a 90 ms wait would just delay the colors.
    const first = store.old.runs.length === 0 && store.new.runs.length === 0
    const timer = window.setTimeout(() => {
      windowPendingRef.current = false
      if (!Object.is(storeRef.current.key, input.key)) return
      let wrote = false
      for (const { side, lines, range } of pending) {
        if (range === undefined) continue
        const visibleFrom = Math.max(0, range.from - 1)
        const visibleTo = Math.min(lines.length, range.to)
        // Fill the visible lines plus a margin, so the next few rows of scroll are
        // already there.
        const from = Math.max(0, visibleFrom - WINDOW_MARGIN_LINES)
        const to = Math.min(lines.length, visibleTo + WINDOW_MARGIN_LINES, from + MAX_WINDOW_LINES)
        wrote = fill(side, lines, lang, from, to) || wrote
      }
      if (wrote) publish()
    }, first ? 0 : DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      windowPendingRef.current = false
    }
  }, [input.key, oldLines, newLines, lang, oldFrom, oldTo, newFrom, newTo, oldRange, newRange])

  // 3. The idle backfill: one chunk per step, top-down and exact, so windows
  //    inside a covered region resume from a real state and a random scroll
  //    position is already coloured.
  useEffect(() => {
    if (!live) return
    let cancelled = false
    let timer: number | undefined
    let idleHandle: number | undefined
    const requestIdle = (window as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }).requestIdleCallback
    const step = (): void => {
      if (cancelled || windowPendingRef.current) { schedule(); return }
      const store = storeRef.current
      if (!Object.is(store.key, input.key)) return
      const order = [
        { side: store.old, lines: oldLines },
        { side: store.new, lines: newLines },
      ].sort((a, b) => (a.side.filled / (a.lines.length || 1)) - (b.side.filled / (b.lines.length || 1)))
      const next = order.find(({ side, lines }) => side.filled < Math.min(lines.length, BACKFILL_MAX_LINES))
      if (next === undefined) return
      const to = Math.min(next.lines.length, next.side.filled + BACKFILL_CHUNK_LINES, BACKFILL_MAX_LINES)
      // Resume from the chunk boundary's own state: `filled` lines are exactly
      // highlighted, so the state saved there is the real one.
      const state = stateAt(next.side, next.side.filled)
      const result = highlightWindow(next.lines, lang, next.side.filled, to, { state })
      if (result !== undefined) {
        result.runs.forEach((runs, index) => { next.side.runs[next.side.filled + index] = runs })
        next.side.states.set(to, result.state)
        next.side.filled = to
        publish()
      } else {
        // Nothing to highlight (no grammar, or an unhighlightable window): mark it
        // consumed so the backfill does not spin on it.
        next.side.filled = to
      }
      schedule()
    }
    const schedule = (): void => {
      if (cancelled) return
      if (requestIdle !== undefined) idleHandle = requestIdle(step, { timeout: BACKFILL_DELAY_MS })
      else timer = window.setTimeout(step, BACKFILL_DELAY_MS)
    }
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      const cancelIdle = (window as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback
      if (idleHandle !== undefined && cancelIdle !== undefined) cancelIdle(idleHandle)
    }
  }, [input.key, live, oldLines, newLines, lang])

  return sides
}
