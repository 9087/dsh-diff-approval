/** Self-contained Markdown preview-diff renderer.
 *
 *  Renders the whole-file text diff at the Markdown level: the source diff is
 *  computed first, then each added/removed/context run is rendered through
 *  `marked` and presented single-column (merged, like the unified source diff)
 *  or double-column (before | after). Every rendered block carries its run's
 *  add/remove/context status so it can be tinted with the diff colors.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { WholeFileDiff } from './whole-file-diff.ts'
import { changeBlocksOf, computeWholeFileDiff, intraRunsOf } from './whole-file-diff.ts'
import type { IntraRun } from './whole-file-diff.ts'

/** One rendered diff run: a contiguous run of same-kind rows, plus the change
 *  block it belongs to (`undefined` for context). The block index is the one the
 *  source view derives over the same contents, so a preview element and a source
 *  block name the same keep/revert target. */
interface DiffRun {
  kind: 'add' | 'del' | 'context'
  text: string
  block: number | undefined
}

function computeDiffOf(oldText: string, newText: string): WholeFileDiff {
  return computeWholeFileDiff(oldText, newText)
}

/** Group the whole-file diff rows into contiguous same-kind runs, tagged with
 *  their change block (a run never spans two blocks: context separates them). */
function diffRuns(oldText: string, newText: string): DiffRun[] {
  const diff = computeDiffOf(oldText, newText)
  const blockOfRow = new Map<number, number>()
  changeBlocksOf(diff).forEach((block, index) => {
    for (let row = block.start; row <= block.end; row++) blockOfRow.set(row, index)
  })
  const runs: DiffRun[] = []
  let current: DiffRun | null = null
  diff.rows.forEach((row, index) => {
    const kind = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'context'
    const block = blockOfRow.get(index)
    if (current === null || current.kind !== kind || current.block !== block) {
      current = { kind, text: row.text, block }
      runs.push(current)
    } else {
      current.text += `\n${row.text}`
    }
  })
  return runs
}

/** Render one text run to sanitized HTML (Markdown). */
function renderRun(run: DiffRun): string {
  const html = marked.parse(run.text, { async: false }) as string
  return DOMPurify.sanitize(html)
}

/** Escape HTML special characters before embedding text in the Markdown source. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render a Markdown string (already carrying injected inline spans) to sanitized HTML. */
function renderMarkdownInline(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string)
}

/**
 * Wrap the changed runs of one intra-diff side in a word-highlight span, so the
 * specific changed words (not the whole block) are emphasised. The runs
 * concatenate back to the original text, so escaping the unchanged runs keeps
 * the block exactly as it would render; a changed run is split at blank lines so
 * no span ever crosses a Markdown paragraph boundary (an inline `<span>` cannot
 * straddle two `<p>` blocks).
 */
function wrapChanged(runs: IntraRun[], kind: 'del' | 'add'): string {
  const cls = kind === 'del' ? 'mdWordDel' : 'mdWordAdd'
  let out = ''
  for (const run of runs) {
    const safe = escapeHtml(run.text)
    if (run.kind !== kind) {
      out += safe
      continue
    }
    // A changed run may contain a blank line; wrap each line-group separately so
    // the span stays inside one paragraph.
    const segments = safe.split(/(\n\n)/)
    out += segments.map(segment => (segment === '\n\n' || segment === '' ? segment : `<span class="${cls}">${segment}</span>`)).join('')
  }
  return out
}

/**
 * Compute the word-level highlight for a del/addition text pair, or undefined
 * when the two are not a comparable edit (too dissimilar — a rewrite) or a
 * fenced code block, where a wrapped span would render as literal text. Both
 * multi-line paragraphs and single lines are annotated.
 */
function wordHighlight(delText: string, addText: string): { del: string; add: string } | undefined {
  if (delText.startsWith('```') || addText.startsWith('```')) return undefined
  const runs = intraRunsOf(delText, addText)
  if (runs === undefined) return undefined
  return {
    del: wrapChanged(runs.del, 'del'),
    add: wrapChanged(runs.add, 'add'),
  }
}

/** The change-block attributes one block-carrying run renders with; empty for
 *  context, which belongs to no block and takes no keep/revert action. */
function blockAttrs(run: DiffRun): string {
  return run.block === undefined ? '' : ` data-md-block="${run.block}" data-md-kind="${run.kind}"`
}

/** One run rendered as a block carrying its diff-kind class and, for a changed
 *  run, the change block it belongs to. */
function renderBlock(run: DiffRun): string {
  const cls = run.kind === 'add' ? 'mdBlock mdAdd' : run.kind === 'del' ? 'mdBlock mdDel' : 'mdBlock'
  return `<div class="${cls}"${blockAttrs(run)}>${renderRun(run)}</div>`
}

/** One aligned before/after row: the same logical section on both sides. */
interface AlignedDoubleRow {
  before?: DiffRun | undefined
  after?: DiffRun | undefined
}

/**
 * Pair the diff runs into aligned rows so a deletion and the addition that
 * replaces it share one row (`before | after`), and context appears on both
 * sides. This keeps the two columns on the same horizontal line instead of
 * stacking independent side columns whose blocks drift when heights differ.
 */
function alignedDoubleRows(runs: DiffRun[]): AlignedDoubleRow[] {
  const rows: AlignedDoubleRow[] = []
  let i = 0
  while (i < runs.length) {
    const run = runs[i]!
    if (run.kind === 'context') {
      rows.push({ before: run, after: run })
      i++
    } else if (run.kind === 'del') {
      const next = runs[i + 1]
      if (next?.kind === 'add') {
        rows.push({ before: run, after: next })
        i += 2
      } else {
        rows.push({ before: run })
        i++
      }
    } else {
      const next = runs[i + 1]
      if (next?.kind === 'del') {
        rows.push({ before: next, after: run })
        i += 2
      } else {
        rows.push({ after: run })
        i++
      }
    }
  }
  return rows
}

/** Render one aligned double row (before | divider | after). Both cells are
 *  always emitted so the divider and the columns stay fixed regardless of
 *  which side this change touches. A comparable del→add edit gets word-level
 *  highlights on each side. */
function renderDoubleRow(row: AlignedDoubleRow): string {
  const { before, after } = row
  let beforeHtml = before === undefined ? '' : renderBlock(before)
  let afterHtml = after === undefined ? '' : renderBlock(after)
  if (before !== undefined && after !== undefined && before.kind === 'del' && after.kind === 'add') {
    const hl = wordHighlight(before.text, after.text)
    if (hl !== undefined) {
      beforeHtml = `<div class="mdBlock mdDel"${blockAttrs(before)}>${renderMarkdownInline(hl.del)}</div>`
      afterHtml = `<div class="mdBlock mdAdd"${blockAttrs(after)}>${renderMarkdownInline(hl.add)}</div>`
    }
  }
  return `<div class="mdDoubleRow"><div class="mdDoubleCol">${beforeHtml}</div><div class="mdDoubleRule"></div><div class="mdDoubleCol">${afterHtml}</div></div>`
}

/**
 * Render the Markdown preview as sanitized HTML.
 * @param oldText - the file's tracked baseline (rendered as "before").
 * @param newText - the file's current content (rendered as "after").
 * @param mode - 'single' merges add/remove/context (unified-like); 'double'
 *   shows the before and after renderings aligned row by row, each change block
 *   tinted (deleted on the before side, added on the after side). Comparable
 *   edits get word-level highlights on the changed words.
 * @returns sanitized HTML for the preview body. Local images keep their src so
 *   a later pass can resolve them to data URIs (see the preview image resolver).
 */
export function renderMarkdownPreview(oldText: string, newText: string, mode: 'single' | 'double'): string {
  if (mode === 'single') {
    // Single-column mirrors the source unified diff: whole-block tint only, no
    // word-level highlight (the source single-column view also has none).
    const runs = diffRuns(oldText, newText)
    return runs.map(renderBlock).join('')
  }
  const rows = alignedDoubleRows(diffRuns(oldText, newText))
  return `<div class="mdDouble">${rows.map(renderDoubleRow).join('')}</div>`
}
