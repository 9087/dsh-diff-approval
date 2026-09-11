// @vitest-environment jsdom
// Opt-in performance probe: opening a large file in the pending panel. Measures
// the pure computation (diff + highlight) and the jsdom interaction (list mount,
// row click, highlighted rows arriving) separately, so a number points at a stage
// instead of at "it feels slow".
//
// It is a benchmark, not an assertion, so the suite does not collect it at all
// (see the `include` switch in vitest.config.ts) and the default run has no
// skipped entry. Run it on demand with PERF_PROBE=1:
//   $env:PERF_PROBE='1'; node ./node_modules/vitest/vitest.mjs run tests/perf-open-file.probe.tsx
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import { PendingPanel } from '../src/client/PendingPanel.tsx'
import type { PendingDiffSnapshot } from '../src/client/slots.ts'
import { computeWholeFileDiff } from '../src/client/whole-file-diff.ts'
import { highlightWindow } from '../src/client/highlight.ts'
import { langFromPath } from '../src/client/lang.ts'

const TARGET = 'tests/pending-panel.client.spec.tsx'
const S1 = 'session-1' as SessionId
const newText = readFileSync(TARGET, 'utf8')
// A realistic pending change: a handful of edited lines spread over the file, so
// both sides are full-size (the whole-file view diffs and highlights all of it).
const newLines = newText.split('\n')
const oldLines = newLines.map((line, index) => {
  if (index % 700 === 3) return `${line} // baseline`
  if (index % 1100 === 7) return ''
  return line
})
const oldText = oldLines.join('\n')

const lang = langFromPath(TARGET) ?? 'typescript'

function time<T>(label: string, runs: number, fn: () => T): T {
  let out: T | undefined
  const start = performance.now()
  for (let i = 0; i < runs; i++) out = fn()
  const each = (performance.now() - start) / runs
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${each.toFixed(1)}ms  (avg of ${runs})`)
  return out as T
}

function entry(overrides: Partial<PendingFileDiff>): PendingFileDiff {
  return {
    id: 'big-1', sessionId: S1, path: `/${TARGET}`, kind: 'edit',
    oldText, newText, updatedAt: 10, missing: false, diverged: false,
    sessionIds: [S1], ...overrides,
  }
}

function panelProps(snapshot: PendingDiffSnapshot): ComponentProps<typeof PendingPanel> {
  return {
    wide: true,
    useSessions: (select: (state: { current: SessionId; byId: Record<string, { blank?: boolean }> }) => SessionId) =>
      select({ current: S1, byId: {} }),
    usePending: (select: (state: PendingDiffSnapshot) => PendingDiffSnapshot) => select(snapshot),
    onRefresh: () => {}, onKeep: async () => {}, onRevert: async () => {},
    onBlockKeep: async () => {}, onBlockRevert: async () => {}, onOpen: async () => {},
    onPreviewImage: async () => undefined, onPasteReference: () => {}, onUndo: () => {}, onRedo: () => {},
    onImportVcs: async () => ({ imported: 0, detected: false }),
    onRefreshVcs: async () => ({ outcome: 'refreshed' }),
    onBrowse: async () => ({ path: '', entries: [], truncated: false }),
    onAddPath: async () => ({ outcome: 'added', added: 1, duplicates: 0 }),
    onKeepAll: async () => {}, onRevertAll: async () => {}, onAckRedoCleared: () => {}, collapseSidebar: () => {},
    t: (key: string) => key,
  } as unknown as ComponentProps<typeof PendingPanel>
}

describe('perf: opening a large file', () => {
  it('reports the stage costs', async () => {
    // eslint-disable-next-line no-console
    console.log(`[perf] file: ${TARGET} — ${newLines.length} lines, ${(newText.length / 1024).toFixed(0)} KB`)

    const diff = time('computeWholeFileDiff', 3, () => computeWholeFileDiff(oldText, newText))
    // eslint-disable-next-line no-console
    console.log(`[perf] rows: ${diff.rows.length}`)
    time('highlightWindow(new, whole file)', 1, () => highlightWindow(newLines, lang, 0, newLines.length))
    time('highlightWindow(old, whole file)', 1, () => highlightWindow(oldLines, lang, 0, oldLines.length))
    time('highlightWindow(new, whole file) again (cache hit)', 3, () => highlightWindow(newLines, lang, 0, newLines.length))
    time('highlightWindow(new, first 200 lines)', 3, () => highlightWindow(newLines, lang, 0, 200))
    // A window-sized slice (70 lines) at four offsets: what one window pass costs,
    // wherever the user is in the file.
    for (const [label, from] of [['start', 0], ['1/3', 1270], ['2/3', 2540], ['end', newLines.length - 70]] as const) {
      time(`highlightWindow(new, 70 lines @ ${label})`, 3, () => highlightWindow(newLines, lang, from, from + 70, { context: 40 }))
    }
    // The naive sweep a non-debounced window pass would pay: every intermediate
    // window of a top-to-bottom scroll.
    const sweep = time('highlightWindow(new, 70 lines) x 55 windows (full sweep)', 1, () => {
      let out = 0
      for (let from = 0; from < newLines.length; from += 70) {
        out += (highlightWindow(newLines, lang, from, from + 70, { context: 40 })?.runs ?? []).length
      }
      return out
    })
    // eslint-disable-next-line no-console
    console.log(`[perf] sweep tokenized ${sweep} line runs`)

    // The panel twice: once with a viewport (what a browser reports, so the row
    // window is ~20 rows and only those render) and once without (jsdom's own
    // fallback, which renders every row — the numbers there are not browser-like).
    const measurePanel = async (label: string, withViewport: boolean): Promise<void> => {
      cleanup()
      if (withViewport) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 440 })
      } else {
        delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
      }
      const props = panelProps({ read: true, files: [entry({ id: `perf-${label}` })], busy: new Set() })
      const mountStart = performance.now()
      render(<PendingPanel {...props} />)
      const mount = performance.now() - mountStart
      fireEvent.click(screen.getByLabelText('panel.aria'))
      const clickStart = performance.now()
      fireEvent.click(screen.getByText(`/${TARGET}`))
      const click = performance.now() - clickStart
      const settleStart = performance.now()
      await waitFor(() => { expect(document.querySelector('[data-diff-code] span')).not.toBeNull() }, { timeout: 20000 })
      const settle = performance.now() - settleStart
      // eslint-disable-next-line no-console
      console.log(`[perf] ${label}: mount ${mount.toFixed(1)}ms, click ${click.toFixed(1)}ms, until highlighted ${settle.toFixed(1)}ms, rows ${document.querySelectorAll('[data-diff-row]').length}, spans ${document.querySelectorAll('[data-diff-code] span').length}`)
      cleanup()
    }
    await measurePanel('browser-like (viewport reported)', true)
    await measurePanel('jsdom fallback (no viewport)', false)
  }, 120000)
})
