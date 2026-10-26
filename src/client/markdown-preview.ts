/** Self-contained Markdown preview-diff renderer.
 *
 *  Two styles, chosen by the caller:
 *
 *  - `blocks` (the original): the source diff is cut into contiguous add/del/context runs and each run is
 *    parsed as a document of its own, then wrapped in a `<div>`. Simple, and wrong for any structure that
 *    spans a run boundary — a reworded list item becomes four lists, a changed table row falls out of the
 *    table and renders as text, a changed fenced line stops being code.
 *  - `structure` (the default): the whole document is rendered ONCE, exactly as the author wrote it, and
 *    the diff is mapped onto the elements that came from the changed lines. Nothing is re-parsed, no
 *    wrapper is inserted, so the document keeps its own layout. A deletion and the addition that replaces
 *    it are shown TOGETHER inside the same element (`~~old~~ new`), and a deleted element with no
 *    counterpart is emitted as a struck ghost beside its sibling — inside the same list, table or column.
 *
 *  Both styles emit the same contract the panel's anchoring already reads: `data-md-block` / `data-md-kind` on
 *  every element that carries a difference BLOCK (what the toolbar numbers, frames and keeps), `data-md-unit`
 *  on every element that carries a character-level change inside one (what is highlighted), plus `mdAdd` /
 *  `mdDel` for the tint and `mdWordAdd` / `mdWordDel` for the changed characters inside one element.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { diffArrays, diffChars } from 'diff'
import type { WholeFileDiff } from './whole-file-diff.ts'
import { blockRangesOf, changeBlocksOf, computeWholeFileDiff, intraRunsOf } from './whole-file-diff.ts'
import type { IntraRun } from './whole-file-diff.ts'
import type { WholeFileDiffRow } from './whole-file-diff.ts'
import { treePreviewModel } from './markdown-tree-blocks.ts'
import type { MarkdownTreeNode } from './markdown-tree-match.ts'
import { matchMarkdownTrees, nodeVisibleText, planMergedSiblings, type MergePlanPiece } from './markdown-tree-match.ts'
import type { TreePreviewBlock, TreePreviewUnit } from './markdown-tree-blocks.ts'

/** How the preview expresses the diff. See the module comment. */
export type MarkdownPreviewStyle = 'structure' | 'blocks'

/** One rendered diff run (the `blocks` style): a contiguous run of same-kind rows, plus the change block
 *  it belongs to (`undefined` for context). */
interface DiffRun {
  kind: 'add' | 'del' | 'context'
  text: string
  block: number | undefined
}

function computeDiffOf(oldText: string, newText: string): WholeFileDiff {
  return computeWholeFileDiff(oldText, newText)
}

/* ============================== blocks style ============================== */

/** Group the whole-file diff rows into contiguous same-kind runs, tagged with their change block. */
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
 * Wrap the changed runs of one intra-diff side in a word-highlight span, so the specific changed words
 * (not the whole block) are emphasised. Splits at blank lines so no span crosses a paragraph boundary.
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
    const segments = safe.split(/(\n\n)/)
    out += segments.map(segment => (segment === '\n\n' || segment === '' ? segment : `<span class="${cls}">${segment}</span>`)).join('')
  }
  return out
}

/** The word-level highlight for a del/addition text pair, or undefined when the two are not a comparable
 *  edit (too dissimilar — a rewrite) or a fenced code block, where a wrapped span would render as text. */
function wordHighlight(delText: string, addText: string): { del: string; add: string } | undefined {
  if (delText.startsWith('```') || addText.startsWith('```')) return undefined
  const runs = intraRunsOf(delText, addText)
  if (runs === undefined) return undefined
  return {
    del: wrapChanged(runs.del, 'del'),
    add: wrapChanged(runs.add, 'add'),
  }
}

/** The change-block attributes one block-carrying run renders with; empty for context. */
function blockAttrs(run: DiffRun): string {
  return run.block === undefined ? '' : ` data-md-block="${run.block}" data-md-kind="${run.kind}"`
}

/** One run rendered as a block carrying its diff-kind class and, for a changed run, its change block. */
function renderBlock(run: DiffRun): string {
  const cls = run.kind === 'add' ? 'mdBlock mdAdd' : run.kind === 'del' ? 'mdBlock mdDel' : 'mdBlock'
  return `<div class="${cls}"${blockAttrs(run)}>${renderRun(run)}</div>`
}

/** One aligned before/after row: the same logical section on both sides. */
interface AlignedDoubleRow {
  before?: DiffRun | undefined
  after?: DiffRun | undefined
}

/** Pair the diff runs into aligned rows so a deletion and its replacement share one row. */
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

/** Render one aligned double row (before | divider | after). */
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

/* ============================ structure style ============================ */

/** An inclusive span of 0-based source lines. */
interface LineSpan {
  start: number
  end: number
}

/** One change block's footprint on each side of the diff. */
interface BlockSpan {
  old: LineSpan | undefined
  new: LineSpan | undefined
}

/**
 * One character-level change the preview HIGHLIGHTS.
 *
 * The source view's blocks are lines, but a rendered document puts several changes on one line: a table row
 * holds a reworded cell AND a retargeted link, and each is a separate run to highlight. The preview cuts each
 * line block into these units for the drawn marks. What the reader COUNTS and keeps, though, is a BLOCK
 * (`PreviewBlock`): one pure-addition hunk, one table row, or one invisible change — which may hold several
 * units (see `previewBlocks`).
 */
export interface PreviewUnit {
  /** Index in the preview's own unit numbering: the `data-md-unit` value (its block is `data-md-block`). */
  index: number
  /** The source-line block this unit was cut from. */
  lineBlock: number
  /** The line block's own 1-based inclusive line ranges, carried along for the source view. */
  oldLines: { start: number; end: number }
  newLines: { start: number; end: number }
  /** The change's absolute character span per side, `[start, end)`; `start === end` is an insertion. */
  oldChars: { start: number; end: number }
  newChars: { start: number; end: number }
  /** The changed source itself on each side, for matching the runs that were drawn. */
  oldText: string
  newText: string
}

/** Unchanged characters still folded into one unit: a space or two inside a reworded phrase. */
const UNIT_GAP = 3

/**
 * Whether each source line renders NOTHING on its own: a front-matter line, an HTML-comment-only line, or a
 * link reference definition.
 *
 * The renderer can tell this from the DOM, but `previewUnits` cannot see the DOM — and both sides need the
 * same answer, because the preview's numbers ARE these units. The heuristic here covers exactly the lines the
 * renderer turns into no element at all, so a block of them can be folded into one visible pair of blocks.
 *
 * @param text - one side's source.
 * @returns a flag per 0-based line (true = renders nothing).
 */
function noRenderLines(text: string): boolean[] {
  const lines = text.split('\n')
  const hidden = lines.map(() => false)
  const frontMatterLines = Math.min(frontMatterLineCount(text), lines.length)
  for (let index = 0; index < frontMatterLines; index++) hidden[index] = true
  let inComment = false
  for (let index = frontMatterLines; index < lines.length; index++) {
    const line = lines[index] ?? ''
    let rest = line
    /** What is left of the line once whole HTML comments are cut out: anything here renders. */
    let outside = ''
    while (rest !== '') {
      if (inComment) {
        const end = rest.indexOf('-->')
        if (end === -1) { rest = ''; break }
        rest = rest.slice(end + 3)
        inComment = false
        continue
      }
      const start = rest.indexOf('<!--')
      if (start === -1) { outside += rest; rest = ''; continue }
      outside += rest.slice(0, start)
      const end = rest.indexOf('-->', start + 4)
      if (end === -1) { inComment = true; rest = ''; break }
      rest = rest.slice(end + 3)
    }
    // Everything outside comments was whitespace: the line draws no element (whether it opened, closed or sat
    // entirely inside a comment). A link reference definition draws nothing either.
    if (outside.trim() === '') hidden[index] = true
    else if (/^\s{0,3}\[[^\]]+\]:\s*\S/.test(line)) hidden[index] = true
  }
  return hidden
}

/**
 * The inline links on one source line, as character ranges of the line: the whole `[text](target)` token.
 *
 * @param line - one line of source.
 * @returns the token ranges, in order.
 */
function inlineLinkTokens(line: string): { start: number; end: number; text: string }[] {
  const tokens: { start: number; end: number; text: string }[] = []
  const pattern = /\[[^\]\n]*\]\([^)\n]*\)/g
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    tokens.push({ start: match.index, end: match.index + match[0].length, text: match[0] })
  }
  return tokens
}

/**
 * Fold the changes that live inside ONE inline link into one unit.
 *
 * A link is one thing: its text and its target are parts of the same `[text](target)` token, and the source row
 * for either shows the whole link. Diffing the line character by character still reports an edited word in the
 * link's text and a retargeted URL as two separate runs, though — so hovering the word and hovering the link
 * would count two changes, with the URL's (later in the line) wrapping the word's, and keeping one left the
 * link half-changed. Both runs are folded into one unit spanning the token's changed range, which keeps and
 * reverts the link as the one thing it is (the reported "v2 should be part of the link's block" case).
 *
 * Only units lying INSIDE the same `[text](target)` token are folded: two links on one line stay two changes,
 * and a change after the link is a change of its own.
 *
 * @param units - the units built so far, in document order.
 * @param oldLines - the baseline's lines.
 * @param newLines - the current content's lines.
 * @returns the units with each link's inner runs folded together.
 */
function mergeInlineLinkUnits(
  units: readonly PreviewUnit[],
  oldLines: readonly string[],
  newLines: readonly string[],
): PreviewUnit[] {
  const lineOffset = (lines: readonly string[], line: number): number => {
    let offset = 0
    for (let index = 0; index < Math.min(Math.max(line - 1, 0), lines.length); index++) {
      offset += (lines[index]?.length ?? 0) + 1
    }
    return offset
  }
  // Units cut from one paired line, the only ones that can share a link token.
  const groups = new Map<string, PreviewUnit[]>()
  for (const unit of units) {
    if (unit.oldLines.start !== unit.oldLines.end || unit.newLines.start !== unit.newLines.end) continue
    const key = `${unit.lineBlock}\u0000${unit.oldLines.start}\u0000${unit.newLines.start}`
    const list = groups.get(key) ?? []
    list.push(unit)
    groups.set(key, list)
  }
  const removed = new Set<PreviewUnit>()
  const mergedAt = new Map<PreviewUnit, PreviewUnit>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]!
    const oldLine = first.oldLines.start
    const newLine = first.newLines.start
    const oldLineText = oldLines[oldLine - 1] ?? ''
    const newLineText = newLines[newLine - 1] ?? ''
    const oldTokens = inlineLinkTokens(oldLineText)
    const newTokens = inlineLinkTokens(newLineText)
    if (oldTokens.length === 0 || oldTokens.length !== newTokens.length) continue
    const oldBase = lineOffset(oldLines, oldLine)
    const newBase = lineOffset(newLines, newLine)
    for (let token = 0; token < oldTokens.length; token++) {
      const oldToken = oldTokens[token]!
      const newToken = newTokens[token]!
      if (oldToken.text === newToken.text) continue
      const oldStart = oldBase + oldToken.start
      const oldEnd = oldBase + oldToken.end
      const newStart = newBase + newToken.start
      const newEnd = newBase + newToken.end
      /** Whether a unit's side lies inside the token (a zero-width insertion just needs its point inside). */
      const inside = (chars: { start: number; end: number }, start: number, end: number): boolean =>
        chars.end > chars.start
          ? chars.start >= start && chars.end <= end
          : chars.start >= start && chars.start <= end
      const members = group.filter(unit => !removed.has(unit)
        && (inside(unit.oldChars, oldStart, oldEnd) || inside(unit.newChars, newStart, newEnd)))
      if (members.length < 2) continue
      const oldFrom = Math.min(...members.map(unit => unit.oldChars.start))
      const oldTo = Math.max(...members.map(unit => unit.oldChars.end))
      const newFrom = Math.min(...members.map(unit => unit.newChars.start))
      const newTo = Math.max(...members.map(unit => unit.newChars.end))
      for (const member of members) removed.add(member)
      mergedAt.set(members[0]!, {
        ...first,
        index: members[0]!.index,
        oldChars: { start: oldFrom, end: oldTo },
        newChars: { start: newFrom, end: newTo },
        oldText: oldLineText.slice(oldFrom - oldBase, oldTo - oldBase),
        newText: newLineText.slice(newFrom - newBase, newTo - newBase),
      })
    }
  }
  if (removed.size === 0) return [...units]
  const result: PreviewUnit[] = []
  for (const unit of units) {
    const merged = mergedAt.get(unit)
    if (merged !== undefined) {
      result.push(merged)
      continue
    }
    if (!removed.has(unit)) result.push(unit)
  }
  return result
}

/**
 * The fenced code blocks of one side: their line ranges (0-based, fences included) and language tag.
 *
 * @param lines - one side's lines.
 * @returns the blocks, in order.
 */
function fencedCodeBlocks(lines: readonly string[]): { start: number; end: number; language: string }[] {
  const blocks: { start: number; end: number; language: string }[] = []
  let open: { start: number; marker: string; language: string } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === undefined) {
      if (match !== null) open = { start: index, marker: match[1]!, language: (match[2] ?? '').trim() }
      continue
    }
    if (match !== null && match[1] === open.marker && (match[2] ?? '').trim() === '') {
      blocks.push({ start: open.start, end: index, language: open.language })
      open = undefined
    }
  }
  if (open !== undefined) blocks.push({ start: open.start, end: lines.length - 1, language: open.language })
  return blocks
}

/**
 * Fold the changes of one REPLACED fenced code block into one unit.
 *
 * A fence that changed language — or was mostly rewritten — is a REPLACED block in the preview (the old fence
 * struck above the new one, see `inlineMergeTarget`): the whole block is one thing to look at and to keep. The
 * character diff would still report the language tag and each edited line as separate units, and because the
 * replacement is drawn as the whole fence, those inner units have nowhere of their own to live and end up
 * WRAPPED INSIDE the fence's unit — a nested number, and a second tint inside the block's own tint. They are
 * one unit over the whole fence instead. A fence whose language is unchanged and whose text only lightly
 * changed is merged word by word INSIDE the fence, so its runs keep their own units and are left alone.
 *
 * @param units - the units built so far.
 * @param oldLines - the baseline's lines.
 * @param newLines - the current content's lines.
 * @returns the units with each replaced fence folded.
 */
function mergeCodeFenceUnits(
  units: readonly PreviewUnit[],
  oldLines: readonly string[],
  newLines: readonly string[],
): PreviewUnit[] {
  const oldBlocks = fencedCodeBlocks(oldLines)
  const newBlocks = fencedCodeBlocks(newLines)
  if (oldBlocks.length === 0 || oldBlocks.length !== newBlocks.length) return [...units]
  const lineOffset = (lines: readonly string[], line: number): number => {
    let offset = 0
    for (let index = 0; index < Math.min(Math.max(line - 1, 0), lines.length); index++) {
      offset += (lines[index]?.length ?? 0) + 1
    }
    return offset
  }
  const removed = new Set<PreviewUnit>()
  const mergedAt = new Map<PreviewUnit, PreviewUnit>()
  for (let fence = 0; fence < oldBlocks.length; fence++) {
    const oldBlock = oldBlocks[fence]!
    const newBlock = newBlocks[fence]!
    const oldText = oldLines.slice(oldBlock.start, oldBlock.end + 1).join('\n')
    const newText = newLines.slice(newBlock.start, newBlock.end + 1).join('\n')
    if (oldText === newText) continue
    // The renderer's own rule (`inlineMergeTarget`): same language and mostly the same code merges word by
    // word inside the fence; anything else is a replacement of the whole block.
    const oldContent = oldLines.slice(oldBlock.start + 1, oldBlock.end).join('\n')
    const newContent = newLines.slice(newBlock.start + 1, newBlock.end).join('\n')
    const shorter = Math.min(oldContent.length, newContent.length)
    const longer = Math.max(oldContent.length, newContent.length)
    const inline = oldBlock.language === newBlock.language
      && (longer === 0 || shorter / longer >= 0.5 || longer - shorter <= 24)
    if (inline) continue
    const oldStartLine = oldBlock.start + 1
    const oldEndLine = oldBlock.end + 1
    const newStartLine = newBlock.start + 1
    const newEndLine = newBlock.end + 1
    const inside = (range: { start: number; end: number }, start: number, end: number): boolean =>
      range.start >= start && range.end <= end
    const members = units.filter(unit => !removed.has(unit)
      && inside(unit.oldLines, oldStartLine, oldEndLine)
      && inside(unit.newLines, newStartLine, newEndLine))
    if (members.length === 0) continue
    const oldBase = lineOffset(oldLines, oldStartLine)
    const newBase = lineOffset(newLines, newStartLine)
    for (const member of members) removed.add(member)
    mergedAt.set(members[0]!, {
      ...members[0]!,
      index: members[0]!.index,
      oldLines: { start: oldStartLine, end: oldEndLine },
      newLines: { start: newStartLine, end: newEndLine },
      oldChars: { start: oldBase, end: oldBase + oldText.length },
      newChars: { start: newBase, end: newBase + newText.length },
      oldText,
      newText,
    })
  }
  if (removed.size === 0) return [...units]
  const result: PreviewUnit[] = []
  for (const unit of units) {
    const merged = mergedAt.get(unit)
    if (merged !== undefined) {
      result.push(merged)
      continue
    }
    if (!removed.has(unit)) result.push(unit)
  }
  return result
}

/**
 * How much two source lines read as the SAME thing: their longest common subsequence of characters, as a share
 * of the longer line.
 *
 * A prefix/suffix test would call two long lines with an early edit and a later edit dissimilar; the LCS keeps
 * their shared middle. A line that became a different KIND of line (an image line replaced by a paragraph) has
 * almost nothing in common either way.
 *
 * @param left - one line's text.
 * @param right - the other's.
 * @returns 0 when nothing is shared, 1 when the lines are identical (empty lines count as identical).
 */
function lineSimilarity(left: string, right: string): number {
  const longer = Math.max(left.length, right.length)
  if (longer === 0) return 1
  let previous = new Int32Array(right.length + 1)
  let current = new Int32Array(right.length + 1)
  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      current[column] = left[row - 1] === right[column - 1]
        ? previous[column - 1]! + 1
        : Math.max(previous[column]!, current[column - 1]!)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[right.length]! / longer
}

/**
 * Cut the file's change blocks into the preview's units.
 *
 * A line block is worked through LINE BY LINE: its changed old lines and changed new lines are paired in
 * order (the k-th removed line with the k-th added one, the same reading the side-by-side view uses), and each
 * pair is diffed again character by character — every run of changed characters becomes a unit, and runs a
 * few characters apart on that line are folded into one so a reworded sentence stays one change rather than
 * three. A changed line with no counterpart is a pure deletion or addition and is one unit itself over its
 * whole line.
 *
 * Working per line is what keeps a deleted paragraph from being swallowed by the retargeted link above it: a
 * character diff run over a whole multi-line block would fold the newline into the change and report the link
 * and the paragraph as one unit, and a unit is a hover target and a Keep/Revert action.
 *
 * @param oldText - the file's tracked baseline.
 * @param newText - the file's current content.
 * @returns the units, in document order.
 */
/** localStorage key that picks the preview's diff pipeline: `1` = tree-first, `0` = legacy line-hunk path. */
export const TREE_DIFF_SETTING = 'diff-approval:tree-diff'

/** The pipeline the preview uses when nothing is stored: the tree-first path. */
export const TREE_DIFF_DEFAULT = true

/** Whether a test/Node-like environment is running (where the legacy specs keep their own path unless opted in). */
function treeDiffInTestEnvironment(): boolean {
  try {
    return typeof process !== 'undefined' && (process.env.VITEST !== undefined || process.env.NODE_ENV === 'test')
  } catch {
    return false
  }
}

/**
 * Whether the tree-first diff is active.
 *
 * The browser default is the TREE path (`TREE_DIFF_DEFAULT`); `localStorage` can force either pipeline (1/0).
 * Inside the unit-test environment the default is the LEGACY path instead, so the old behavior's regression
 * specs keep asserting the old behavior; the tree path's own specs opt in explicitly. End-to-end tests run the
 * real browser default and a dedicated e2e spec pins the tree path there.
 */
export function treeDiffEnabled(): boolean {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(TREE_DIFF_SETTING) : null
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    // No storage (sandboxed iframe, disabled cookies): use the default.
  }
  if (treeDiffInTestEnvironment()) return false
  return TREE_DIFF_DEFAULT
}

export function previewUnits(oldText: string, newText: string): PreviewUnit[] {
  if (treeDiffEnabled()) return treePreviewUnits(oldText, newText)
  const diff = computeWholeFileDiff(oldText, newText)
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const offsetOfLine = (lines: readonly string[], line: number): number => {
    let offset = 0
    const upTo = Math.min(Math.max(line - 1, 0), lines.length)
    for (let index = 0; index < upTo; index++) offset += (lines[index]?.length ?? 0) + 1
    return offset
  }
  let units: PreviewUnit[] = []
  /**
   * The changed source lines of each line block, for the no-rendering fold at the end.
   *
   * A table's delimiter row is not a change at all: it draws nothing and is not compared (see
   * `tableLineInfo`), so it must not become a unit — nor an invisible-content block, which is what the
   * reachability net used to report it as (the reported `|---|---|` block).
   */
  const oldTables = tableLineInfo(oldText)
  const newTables = tableLineInfo(newText)
  /** The changed source lines of each line block, for the no-rendering fold at the end. */
  const changedLines = new Map<number, { old: number[]; new: number[] }>()
  const delimiterOnly = (lines: { start: number; end: number }, text: string, delimiters: ReadonlySet<number>): boolean => {
    if (text === '') return true
    for (let line = lines.start; line <= lines.end; line++) {
      if (!delimiters.has(line)) return false
    }
    return true
  }
  /** Add one unit over a character range of one side's line (or over a whole line when `line` is the only side). */
  const push = (
    lineBlock: number,
    oldLinesRange: { start: number; end: number },
    newLinesRange: { start: number; end: number },
    oldRange: { start: number; end: number },
    newRange: { start: number; end: number },
    oldTextOfUnit: string,
    newTextOfUnit: string,
  ): void => {
    // A line that only lost or gained whitespace has nothing to keep or revert: it is not a change the
    // preview can act on (the source view's own whitespace rule).
    if (oldTextOfUnit.trim() === '' && newTextOfUnit.trim() === '') return
    // A table's delimiter row is drawn by neither side (both spellings render the same `---` rule): it is
    // not a change the preview compares, so it produces no unit on either side.
    if (delimiterOnly(oldLinesRange, oldTextOfUnit, oldTables.delimiters)
      && delimiterOnly(newLinesRange, newTextOfUnit, newTables.delimiters)) return
    units.push({
      index: units.length,
      lineBlock,
      oldLines: oldLinesRange,
      newLines: newLinesRange,
      oldChars: oldRange,
      newChars: newRange,
      oldText: oldTextOfUnit,
      newText: newTextOfUnit,
    })
  }
  for (const [lineBlock, block] of changeBlocksOf(diff).entries()) {
    const range = blockRangesOf(diff.rows, block)
    // The block's changed lines on each side, in source order and each counted once.
    const oldLineNumbers: number[] = []
    const newLineNumbers: number[] = []
    for (let row = block.start; row <= block.end; row++) {
      const entry = diff.rows[row]
      if (entry?.oldLine !== undefined && !oldLineNumbers.includes(entry.oldLine)) oldLineNumbers.push(entry.oldLine)
      if (entry?.newLine !== undefined && !newLineNumbers.includes(entry.newLine)) newLineNumbers.push(entry.newLine)
    }
    oldLineNumbers.sort((left, right) => left - right)
    newLineNumbers.sort((left, right) => left - right)
    changedLines.set(lineBlock, { old: oldLineNumbers, new: newLineNumbers })
    const pairs = Math.min(oldLineNumbers.length, newLineNumbers.length)
    for (let step = 0; step < pairs; step++) {
      const oldLine = oldLineNumbers[step]!
      const newLine = newLineNumbers[step]!
      const oldLineText = oldLines[oldLine - 1] ?? ''
      const newLineText = newLines[newLine - 1] ?? ''
      const oldBase = offsetOfLine(oldLines, oldLine)
      const newBase = offsetOfLine(newLines, newLine)
      const runs = charChangeRuns(oldLineText, newLineText)
      // A paired line whose text is identical (never for a real diff, but a guard) is still a change: report
      // it as one unit over the whole line pair.
      const cuts = runs.length === 0
        ? [{ oldStart: 0, oldEnd: oldLineText.length, newStart: 0, newEnd: newLineText.length }]
        : runs
      for (const cut of cuts) {
        push(
          lineBlock,
          { start: oldLine, end: oldLine },
          { start: newLine, end: newLine },
          { start: oldBase + cut.oldStart, end: oldBase + cut.oldEnd },
          { start: newBase + cut.newStart, end: newBase + cut.newEnd },
          oldLineText.slice(cut.oldStart, cut.oldEnd),
          newLineText.slice(cut.newStart, cut.newEnd),
        )
      }
    }
    // A changed line with no counterpart: the whole line is the change.
    for (let step = pairs; step < oldLineNumbers.length; step++) {
      const oldLine = oldLineNumbers[step]!
      const lineText = oldLines[oldLine - 1] ?? ''
      const base = offsetOfLine(oldLines, oldLine)
      push(lineBlock, { start: oldLine, end: oldLine }, { start: range.newStart, end: range.newEnd },
        { start: base, end: base + lineText.length }, { start: base, end: base }, lineText, '')
    }
    for (let step = pairs; step < newLineNumbers.length; step++) {
      const newLine = newLineNumbers[step]!
      const lineText = newLines[newLine - 1] ?? ''
      const base = offsetOfLine(newLines, newLine)
      push(lineBlock, { start: range.oldStart, end: range.oldEnd }, { start: newLine, end: newLine },
        { start: base, end: base }, { start: base, end: base + lineText.length }, '', lineText)
    }
  }
  // A link is ONE change: the text edit inside it and the retarget of it are parts of the same token (see
  // `mergeInlineLinkUnits`), so they number, hover and keep as one block. A REPLACED code fence is one change
  // the same way (`mergeCodeFenceUnits`).
  units = mergeInlineLinkUnits(units, oldLines, newLines)
  units = mergeCodeFenceUnits(units, oldLines, newLines)
  // A block whose changed lines ALL render nothing (front-matter lines, HTML comments, link definitions) is
  // ONE pair of blocks, not one pair per line: the rendering shows no content at all there, so per-line pairs
  // are several pairs of squares for something the reader reads as a single invisible change. The pair spans
  // the block's whole changed lines on each side, and keeping or reverting it acts on the whole block.
  const hiddenOld = noRenderLines(oldText)
  const hiddenNew = noRenderLines(newText)
  const grouped = new Map<number, PreviewUnit[]>()
  for (const unit of units) {
    const list = grouped.get(unit.lineBlock) ?? []
    list.push(unit)
    grouped.set(unit.lineBlock, list)
  }
  /** The whole-line character span and text of one side's changed lines. */
  const wholeLines = (
    lines: readonly string[],
    lineNumbers: readonly number[],
  ): { chars: { start: number; end: number }; text: string } | undefined => {
    const first = lineNumbers[0]
    const last = lineNumbers[lineNumbers.length - 1]
    if (first === undefined || last === undefined) return undefined
    const start = offsetOfLine(lines, first)
    const end = offsetOfLine(lines, last) + (lines[last - 1]?.length ?? 0)
    return { chars: { start, end }, text: lines.slice(first - 1, last).join('\n') }
  }
  const folded: PreviewUnit[] = []
  for (const [lineBlock, list] of grouped) {
    const lines = changedLines.get(lineBlock)
    const hidden = lines !== undefined &&
      lines.old.every(line => hiddenOld[line - 1] === true) &&
      lines.new.every(line => hiddenNew[line - 1] === true)
    // One unit also when a paired line is not the same KIND of line any more — a deleted image line paired
    // with an added paragraph reads as a WHOLE-BLOCK replacement (the renderer draws the old block struck above
    // the new one), so its lines are one change: numbered separately, the deleted image and the paragraph after
    // it would be numbered around the replacement, and the drawn order could not ascend.
    const replacement = lines !== undefined && list.some(unit => {
      if (unit.oldText === '' || unit.newText === '') return false
      const oldLine = oldLines[unit.oldLines.start - 1] ?? ''
      const newLine = newLines[unit.newLines.start - 1] ?? ''
      return lineSimilarity(oldLine, newLine) < 0.2
    })
    // One unit when a SINGLE line of one side is drawn as several lines of the other — a paragraph split in
    // two, or a paragraph the table swallowed as several rows. (A block that ALSO holds a separate deletion
    // is not this: its lines are different changes and keep their own numbers — the extra line would be a
    // change of its own, not part of the expansion.)
    const oldDistinct = new Set(lines?.old ?? []).size
    const newDistinct = new Set(lines?.new ?? []).size
    const expansion = oldDistinct === 1 && newDistinct > 1
    const join = newDistinct === 1 && oldDistinct > 1
      && list.every(unit => unit.oldText !== '' && unit.newText !== '')
    const reflowed = expansion || join
    // A table row's changes stay ONE UNIT PER LINE/CELL: the whole-block folds below are for paragraphs and
    // images, and folding a changed row together with the row added after it would hide the added row from
    // rule B (it would look like part of the changed row).
    const tableRelated = lines !== undefined
      && (lines.old.some(line => oldTables.rows.has(line)) || lines.new.some(line => newTables.rows.has(line)))
    const fold = list.length > 1 && lines !== undefined
      && (hidden || (!tableRelated && (replacement || reflowed)))
    if (!fold || lines === undefined) {
      folded.push(...list)
      continue
    }
    const oldWhole = wholeLines(oldLines, lines.old)
    const newWhole = wholeLines(newLines, lines.new)
    const oldAnchor = list[0]!.oldChars.start
    const newAnchor = list[0]!.newChars.start
    folded.push({
      index: 0,
      lineBlock,
      oldLines: {
        start: oldWhole === undefined ? (lines.new[0] ?? 1) : lines.old[0]!,
        end: oldWhole === undefined ? (lines.new[lines.new.length - 1] ?? 1) : lines.old[lines.old.length - 1]!,
      },
      newLines: {
        start: newWhole === undefined ? (lines.old[0] ?? 1) : lines.new[0]!,
        end: newWhole === undefined ? (lines.old[lines.old.length - 1] ?? 1) : lines.new[lines.new.length - 1]!,
      },
      oldChars: oldWhole?.chars ?? { start: oldAnchor, end: oldAnchor },
      newChars: newWhole?.chars ?? { start: newAnchor, end: newAnchor },
      oldText: oldWhole?.text ?? '',
      newText: newWhole?.text ?? '',
    })
  }
  return folded.map((unit, index) => ({ ...unit, index }))
}

/** A change the rendering cannot show: the toolbar lists it as source, with its own line numbers. */
export interface PreviewInvisibleDiff {
  /** The removed source line(s), 1-based inclusive. */
  oldLines?: { start: number; end: number }
  /** The added source line(s), 1-based inclusive. */
  newLines?: { start: number; end: number }
  /** The removed source itself. */
  oldText?: string
  /** The added source itself. */
  newText?: string
  /** The grammar the source is highlighted with: YAML for front matter, Markdown otherwise. */
  grammar: 'markdown' | 'yaml'
}

/**
 * One DIFFERENCE BLOCK: what the preview numbers, navigates, frames, and keeps or reverts.
 *
 * A block is NOT the same thing as a unit. A unit is a character-level change inside one line — the thing the
 * preview highlights — while a block is the thing the reader counts and acts on. One block can hold several
 * units (a changed table row's cells, a whole added paragraph's lines) or none at all (a whole new row, a
 * deletion the rendering only reports as source). The rules:
 *
 *  - a pure addition or pure deletion hunk (a new paragraph, a new list, a new table, the whole of a new
 *    file) is ONE block, however many units its lines were cut into;
 *  - a mixed hunk (an edit) numbers one block per unit, except a table row, which is one block for the row;
 *    a table row with no counterpart in the other version is one block too, tinted as a row;
 *  - a change that renders nothing (front matter, an HTML comment, a link definition) is a block of its own;
 *    inside a merged pure block it joins that block instead (its source is listed in the block's tabs).
 */
export interface PreviewBlock {
  /** Document order: the preview's `data-md-block` value and the toolbar's number. */
  index: number
  /** The source-line hunk this block came from. */
  lineBlock: number
  /**
   * The highlighted units that belong to this block. A whole-row block still lists its one whole-line unit
   * (the unit→block map needs it), but the renderer draws the ROW rather than that unit's characters.
   */
  units: PreviewUnit[]
  /** Keep/revert range on the old side, 1-based; an absent side is empty (`oldStart > oldEnd`). */
  oldStart: number
  oldEnd: number
  /** Keep/revert range on the new side, 1-based; an absent side is empty (`newStart > newEnd`). */
  newStart: number
  newEnd: number
  /** The character span used when this block is exactly one unit and has no invisible part. */
  oldChars?: { start: number; end: number }
  newChars?: { start: number; end: number }
  /** The lines that actually changed (0-based, inclusive), for drawing the block: no insertion widening. */
  oldChanged?: LineSpan
  newChanged?: LineSpan
  /** Whether a whole pure-addition/deletion hunk was merged into this block. */
  merged: boolean
  /** A table row with no counterpart on the other side: tint the row, not its cells. */
  wholeRow?: 'add' | 'del'
  /** Changes inside this block that the rendering cannot show, in source order. */
  invisible: PreviewInvisibleDiff[]
}

/** One block being grouped from the units of one source hunk. */
interface PendingBlock {
  units: PreviewUnit[]
  wholeRow?: 'add' | 'del'
}

/**
 * The unit→block split of one mixed hunk: one block per change, except a table row, which is one block.
 *
 * A table row's cells are separate units (each changed cell is its own character run), but the reader keeps or
 * reverts the ROW — and the hover frame must go round the whole row. A row present on one side only is a
 * whole-row block: no cell/word highlight at all, the row itself tinted.
 *
 * @param units - the hunk's units, in order.
 * @param oldRows - the old side's table row lines (1-based).
 * @param newRows - the new side's table row lines (1-based).
 * @param oldLines - the old side's source lines, to tell a whole-line unit from a character run.
 * @param newLines - the new side's source lines.
 * @returns the blocks, in order.
 */
function groupHunkUnits(
  units: readonly PreviewUnit[],
  oldRows: ReadonlySet<number>,
  newRows: ReadonlySet<number>,
  oldLines: readonly string[],
  newLines: readonly string[],
): PendingBlock[] {
  const groups: PendingBlock[] = []
  const rowKey = (unit: PreviewUnit): string => `${unit.oldLines.start}-${unit.oldLines.end}:${unit.newLines.start}-${unit.newLines.end}`
  for (const unit of units) {
    const onOldRow = unit.oldText !== '' && oldRows.has(unit.oldLines.start)
    const onNewRow = unit.newText !== '' && newRows.has(unit.newLines.start)
    if (!onOldRow && !onNewRow) {
      groups.push({ units: [unit] })
      continue
    }
    // A row with no counterpart is a WHOLE-LINE unit: the line that is entirely gone (or entirely new). A
    // character run inside a paired row — even one side of it is empty, an inserted word — is rule A and keeps
    // its per-cell highlight.
    const wholeNewLine = unit.oldText === '' && unit.newText === (newLines[unit.newLines.start - 1] ?? '')
    const wholeOldLine = unit.newText === '' && unit.oldText === (oldLines[unit.oldLines.start - 1] ?? '')
    if (wholeNewLine && onNewRow) {
      groups.push({ units: [unit], wholeRow: 'add' })
      continue
    }
    if (wholeOldLine && onOldRow) {
      groups.push({ units: [unit], wholeRow: 'del' })
      continue
    }
    // Cells of one row: their units pair the same row lines, so they fold into the previous group.
    const previous = groups[groups.length - 1]
    if (previous !== undefined && previous.wholeRow === undefined && previous.units[0] !== undefined
      && rowKey(previous.units[0]) === rowKey(unit)) {
      previous.units.push(unit)
      continue
    }
    groups.push({ units: [unit] })
  }
  return groups
}

/**
 * The invisible changes inside one unit, when EVERY side that carries characters renders nothing.
 *
 * @param unit - the unit to inspect.
 * @param hiddenOld - `noRenderLines(oldText)`.
 * @param hiddenNew - `noRenderLines(newText)`.
 * @param oldFrontMatter - the old side's front-matter line count.
 * @param newFrontMatter - the new side's front-matter line count.
 * @returns the invisible difference, or undefined when the change is drawn.
 */
function invisibleUnitOf(
  unit: PreviewUnit,
  hiddenOld: readonly boolean[],
  hiddenNew: readonly boolean[],
  oldFrontMatter: number,
  newFrontMatter: number,
): PreviewInvisibleDiff | undefined {
  const allHidden = (text: string, lines: { start: number; end: number }, hidden: readonly boolean[]): boolean => {
    if (text === '') return true
    for (let line = lines.start; line <= lines.end; line++) {
      if (hidden[line - 1] !== true) return false
    }
    return true
  }
  if (!allHidden(unit.oldText, unit.oldLines, hiddenOld)) return undefined
  if (!allHidden(unit.newText, unit.newLines, hiddenNew)) return undefined
  if (unit.oldText.trim() === '' && unit.newText.trim() === '') return undefined
  return {
    ...(unit.oldText !== '' ? { oldLines: unit.oldLines, oldText: unit.oldText } : {}),
    ...(unit.newText !== '' ? { newLines: unit.newLines, newText: unit.newText } : {}),
    grammar: unit.oldLines.start <= oldFrontMatter || unit.newLines.start <= newFrontMatter ? 'yaml' : 'markdown',
  }
}

/**
 * The invisible changes of a merged pure hunk: its changed CONTENT lines that render nothing.
 *
 * A blank line is not listed: it is part of the document's spacing, not a change the reader has to be told
 * about, and a full-file creation would otherwise produce one tab per blank line. Table delimiter rows are not
 * listed either — they are not compared at all (see `tableLineInfo`).
 *
 * @param lineNumbers - the hunk's changed lines on one side (1-based, sorted).
 * @param lines - that side's source lines.
 * @param hidden - `noRenderLines` of that side.
 * @param delimiters - that side's table delimiter lines.
 * @param frontMatter - that side's front-matter line count.
 * @param side - which side these lines belong to.
 * @returns one entry per contiguous run of invisible content lines.
 */
function invisibleRunsOf(
  lineNumbers: readonly number[],
  lines: readonly string[],
  hidden: readonly boolean[],
  delimiters: ReadonlySet<number>,
  frontMatter: number,
  side: 'old' | 'new',
): PreviewInvisibleDiff[] {
  const invisible = lineNumbers.filter(line => {
    if (delimiters.has(line)) return false
    if (hidden[line - 1] !== true) return false
    return (lines[line - 1] ?? '').trim() !== ''
  })
  const runs: PreviewInvisibleDiff[] = []
  let start: number | undefined
  let end: number | undefined
  const flush = (): void => {
    if (start === undefined || end === undefined) return
    const text = lines.slice(start - 1, end).join('\n')
    const range = { start, end }
    runs.push({
      ...(side === 'old' ? { oldLines: range, oldText: text } : { newLines: range, newText: text }),
      grammar: start <= frontMatter ? 'yaml' : 'markdown',
    })
    start = undefined
    end = undefined
  }
  for (const line of invisible) {
    if (start === undefined || end === undefined || line !== end + 1) {
      flush()
      start = line
    }
    end = line
  }
  flush()
  return runs
}

/**
 * The similarity below which a deleted source line and an added source line are NOT a modification of each
 * other but a pure deletion and a pure addition (spec §6). It is the replacement threshold the renderer already
 * uses for a block whose content was swapped wholesale (`lineSimilarity(...) < 0.2`, see the hunk fold).
 */
const LINE_PAIR_SIMILARITY_MIN = 0.2

/** A table row's CELL CONTENT, pipes and inline markers removed, for comparing two rows. */
function tableRowContent(line: string): string {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/[*_`\\]/g, ''))
    .join('')
}

/**
 * Whether a mixed hunk holds a deletion/addition PAIR that is not a modification of each other (spec §6).
 *
 * The line diff pairs del/add rows by POSITION; position is not meaning. When an ordered pairing shares almost
 * nothing — `English paragraph` against an unrelated Chinese paragraph, a deleted table row against an
 * unrelated added one — treating it as a modification would diff the two texts character by character and draw
 * nonsense. The whole hunk is then reported as pure deletion(s) plus pure addition(s) instead. Table rows
 * compare their CELL content, not their `|` layout: two rows of unrelated cells share their pipes, which must
 * not make them look alike.
 *
 * @param options - the hunk's del/add rows, both sides' lines, and their table-row line numbers.
 * @returns whether some ordered line pair is not a modification.
 */
function hunkHasUnrelatedPair(options: {
  delRows: readonly WholeFileDiffRow[]
  addRows: readonly WholeFileDiffRow[]
  oldLines: readonly string[]
  newLines: readonly string[]
  oldRows: ReadonlySet<number>
  newRows: ReadonlySet<number>
}): boolean {
  const { delRows, addRows, oldLines, newLines, oldRows, newRows } = options
  const pairs = Math.min(delRows.length, addRows.length)
  for (let step = 0; step < pairs; step++) {
    const oldLineNumber = delRows[step]!.oldLine
    const newLineNumber = addRows[step]!.newLine
    if (oldLineNumber === undefined || newLineNumber === undefined) continue
    const bothRows = oldRows.has(oldLineNumber) && newRows.has(newLineNumber)
    const oldText = oldLines[oldLineNumber - 1] ?? ''
    const newText = newLines[newLineNumber - 1] ?? ''
    const similarity = lineSimilarity(
      bothRows ? tableRowContent(oldText) : oldText,
      bothRows ? tableRowContent(newText) : newText,
    )
    if (similarity < LINE_PAIR_SIMILARITY_MIN) return true
  }
  return false
}

/**
 * The preview's DIFFERENCE BLOCKS: the unit the reader counts, navigates, frames and keeps/reverts.
 *
 * @param oldText - the file's tracked baseline.
 * @param newText - the file's current content.
 * @returns the blocks, in document order.
 */
export function previewBlocks(oldText: string, newText: string): PreviewBlock[] {
  if (treeDiffEnabled()) return treePreviewBlocks(oldText, newText)
  const diff = computeWholeFileDiff(oldText, newText)
  const units = previewUnits(oldText, newText)
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const hiddenOld = noRenderLines(oldText)
  const hiddenNew = noRenderLines(newText)
  const oldFrontMatter = frontMatterLineCount(oldText)
  const newFrontMatter = frontMatterLineCount(newText)
  const oldTables = tableLineInfo(oldText)
  const newTables = tableLineInfo(newText)
  const unitsOfHunk = new Map<number, PreviewUnit[]>()
  for (const unit of units) {
    const list = unitsOfHunk.get(unit.lineBlock) ?? []
    list.push(unit)
    unitsOfHunk.set(unit.lineBlock, list)
  }
  const blocks: PreviewBlock[] = []
  const push = (block: Omit<PreviewBlock, 'index'>): void => {
    blocks.push({ ...block, index: blocks.length })
  }
  const spanOfUnits = (list: readonly PreviewUnit[], side: 'old' | 'new'): { start: number; end: number } | undefined => {
    let start = Number.POSITIVE_INFINITY
    let end = -1
    for (const unit of list) {
      if ((side === 'old' ? unit.oldText : unit.newText) === '') continue
      const lines = side === 'old' ? unit.oldLines : unit.newLines
      start = Math.min(start, lines.start)
      end = Math.max(end, lines.end)
    }
    return end >= 0 ? { start, end } : undefined
  }
  changeBlocksOf(diff).forEach((hunk, lineBlock) => {
    const range = blockRangesOf(diff.rows, hunk)
    const rows = diff.rows.slice(hunk.start, hunk.end + 1)
    const kinds = new Set(rows.map(row => row.kind))
    // The hunk's actual changed lines (0-based), which is what the renderer draws.
    let oldStart = Number.POSITIVE_INFINITY
    let oldEnd = -1
    let newStart = Number.POSITIVE_INFINITY
    let newEnd = -1
    for (const row of rows) {
      if (row.oldLine !== undefined) {
        oldStart = Math.min(oldStart, row.oldLine - 1)
        oldEnd = Math.max(oldEnd, row.oldLine - 1)
      }
      if (row.newLine !== undefined) {
        newStart = Math.min(newStart, row.newLine - 1)
        newEnd = Math.max(newEnd, row.newLine - 1)
      }
    }
    const oldChanged = oldEnd >= 0 ? { start: oldStart, end: oldEnd } : undefined
    const newChanged = newEnd >= 0 ? { start: newStart, end: newEnd } : undefined
    const hunkUnits = unitsOfHunk.get(lineBlock) ?? []
    const delRows = rows.filter(row => row.kind === 'del')
    const addRows = rows.filter(row => row.kind === 'add')
    // Rule 6: the line diff laid a deletion and an addition side by side, but they share almost nothing — that
    // is a pure deletion plus a pure addition, not a modification to diff character by character.
    const unrelated = kinds.size === 2 && delRows.length > 0 && addRows.length > 0
      && hunkHasUnrelatedPair({
        delRows, addRows, oldLines, newLines, oldRows: oldTables.rows, newRows: newTables.rows,
      })
    // A pure addition or deletion hunk — and a hunk whose two sides are unrelated — is ONE block: the whole new
    // paragraph/list/table/document, and any invisible change inside it joins that block rather than becoming a
    // block of its own.
    if (kinds.size === 1 || unrelated) {
      const oldLineNumbers = rows.flatMap(row => row.oldLine === undefined ? [] : [row.oldLine])
      const newLineNumbers = rows.flatMap(row => row.newLine === undefined ? [] : [row.newLine])
      push({
        lineBlock,
        units: [...hunkUnits],
        oldStart: range.oldStart,
        oldEnd: range.oldEnd,
        newStart: range.newStart,
        newEnd: range.newEnd,
        ...(oldChanged !== undefined ? { oldChanged } : {}),
        ...(newChanged !== undefined ? { newChanged } : {}),
        merged: true,
        invisible: [
          ...invisibleRunsOf(oldLineNumbers, oldLines, hiddenOld, oldTables.delimiters, oldFrontMatter, 'old'),
          ...invisibleRunsOf(newLineNumbers, newLines, hiddenNew, newTables.delimiters, newFrontMatter, 'new'),
        ],
      })
      return
    }
    // An edit: one block per change, except a table row (rules A/B).
    for (const group of groupHunkUnits(hunkUnits, oldTables.rows, newTables.rows, oldLines, newLines)) {
      const oldSpan = spanOfUnits(group.units, 'old')
      const newSpan = spanOfUnits(group.units, 'new')
      const invisible = group.wholeRow === undefined
        ? group.units.flatMap(unit => {
          const hidden = invisibleUnitOf(unit, hiddenOld, hiddenNew, oldFrontMatter, newFrontMatter)
          return hidden === undefined ? [] : [hidden]
        })
        : []
      const single = group.units.length === 1 && group.units[0] !== undefined ? group.units[0] : undefined
      const chars = single !== undefined && group.wholeRow === undefined && invisible.length === 0
        ? { oldChars: single.oldChars, newChars: single.newChars }
        : {}
      // A whole-row block exists on ONE side only: that side's range is the row, the other side is EMPTY (its
      // start is the insertion point after the hunk's lines on that side), or reverting a new row would also
      // remove the row the hunk replaced.
      const absentOld = group.wholeRow === 'add'
      const absentNew = group.wholeRow === 'del'
      push({
        lineBlock,
        units: group.units,
        oldStart: oldSpan?.start ?? (absentOld ? range.oldEnd + 1 : range.oldStart),
        oldEnd: oldSpan?.end ?? range.oldEnd,
        newStart: newSpan?.start ?? (absentNew ? range.newEnd + 1 : range.newStart),
        newEnd: newSpan?.end ?? range.newEnd,
        ...chars,
        ...(oldChanged !== undefined ? { oldChanged } : {}),
        ...(newChanged !== undefined ? { newChanged } : {}),
        merged: false,
        ...(group.wholeRow !== undefined ? { wholeRow: group.wholeRow } : {}),
        invisible,
      })
    }
  })
  return blocks
}

/**
 * The unit→block mapping a renderer needs, derived from `previewBlocks`.
 *
 * @param blocks - the blocks.
 * @returns the block of each unit index, and which units are drawn as a whole table row.
 */
function blockMapsOf(blocks: readonly PreviewBlock[]): {
  blockOfUnit: Map<number, number>
  wholeRowUnits: Map<number, 'add' | 'del'>
} {
  const blockOfUnit = new Map<number, number>()
  const wholeRowUnits = new Map<number, 'add' | 'del'>()
  for (const block of blocks) {
    for (const unit of block.units) {
      blockOfUnit.set(unit.index, block.index)
      if (block.wholeRow !== undefined) wholeRowUnits.set(unit.index, block.wholeRow)
    }
  }
  return { blockOfUnit, wholeRowUnits }
}

/** One unit's character-level change inside a block's segments. */
interface CharRun {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
}

/** Whether a range of source is ONE Markdown style token on both sides (`**加粗**`, `_斜体_`, `~~x~~`). */
function isMarkdownMarkerToken(oldText: string, newText: string): boolean {
  const one = (text: string): boolean => text.length > 2 && /^(\*\*\*|\*\*|\*|___|__|_|~~|`)[^\n]*\1$/.test(text)
  return one(oldText) && one(newText)
}

/**
 * The character-level change runs of one block's two sides, with near neighbours folded together.
 *
 * @param oldSegment - the block's old text.
 * @param newSegment - the block's new text.
 * @returns the runs, in order.
 */
function charChangeRuns(oldSegment: string, newSegment: string): CharRun[] {
  const raw: CharRun[] = []
  let oldPosition = 0
  let newPosition = 0
  let pending: CharRun | undefined
  for (const part of diffChars(oldSegment, newSegment)) {
    if (part.added) {
      if (pending === undefined) pending = { oldStart: oldPosition, oldEnd: oldPosition, newStart: newPosition, newEnd: newPosition }
      newPosition += part.value.length
      pending.newEnd = newPosition
      continue
    }
    if (part.removed) {
      if (pending === undefined) pending = { oldStart: oldPosition, oldEnd: oldPosition, newStart: newPosition, newEnd: newPosition }
      oldPosition += part.value.length
      pending.oldEnd = oldPosition
      continue
    }
    if (pending !== undefined) {
      raw.push(pending)
      pending = undefined
    }
    oldPosition += part.value.length
    newPosition += part.value.length
  }
  if (pending !== undefined) raw.push(pending)
  const merged: CharRun[] = []
  /** Whether a gap between changed runs holds WORDS (as opposed to spacing/punctuation). */
  const wordsIn = (gap: string): boolean => /[\p{L}\p{N}]/u.test(gap)
  /** Whether a run changes MARKUP only (`**` → `__`): a re-spelling, folded even across words. */
  const markupOnly = (run: CharRun): boolean => !/[\p{L}\p{N}]/u.test(
    oldSegment.slice(run.oldStart, run.oldEnd) + newSegment.slice(run.newStart, run.newEnd),
  )
  for (const run of raw) {
    const previous = merged[merged.length - 1]
    // Runs are folded when they are a word or two apart ON THE SAME LINE. A line boundary is never folded
    // over — neither in the gap between runs nor inside a run being folded in: a retargeted link on one line
    // and a deleted paragraph below it are two changes, one hover target each and each keepable on its own,
    // not one unit that happens to span both.
    //
    // A gap holding WORDS is not folded either: `旧写法` → `新写法，内容更长一些` is two edits — the word swap
    // `旧`→`新` and the appended clause — and the reader must be able to hover/keep each on its own (the
    // reported "前后的内容都没连上" case). Only spacing and punctuation between runs stay one change, and so
    // does a marker-only re-spelling (`**x**` → `__x__`), whose words are unchanged.
    const oldGap = previous === undefined ? '' : oldSegment.slice(previous.oldEnd, run.oldStart)
    const newGap = previous === undefined ? '' : newSegment.slice(previous.newEnd, run.newStart)
    const markupOnlyFold = previous !== undefined && markupOnly(previous) && markupOnly(run)
    const foldable = previous !== undefined
      && !oldSegment.slice(previous.oldStart, run.oldEnd).includes('\n')
      && !newSegment.slice(previous.newStart, run.newEnd).includes('\n')
      && (
        (run.oldStart - previous.oldEnd <= UNIT_GAP
          && run.newStart - previous.newEnd <= UNIT_GAP
          && ((!wordsIn(oldGap) && !wordsIn(newGap)) || markupOnlyFold))
        // The two markers of ONE re-spelled style (`**加粗**` → `__加粗__`) are one change however long the
        // styled words between them are: the folded range is a single Markdown token on each side.
        || (markupOnlyFold && isMarkdownMarkerToken(
          oldSegment.slice(previous.oldStart, run.oldEnd),
          newSegment.slice(previous.newStart, run.newEnd),
        ))
      )
    if (previous !== undefined && foldable) {
      previous.oldEnd = run.oldEnd
      previous.newEnd = run.newEnd
      continue
    }
    merged.push({ ...run })
  }
  return merged
}

/**
 * Whether a unit's side carries a drawn run's text.
 *
 * Either way round: a drawn run may be wider than the character run it came from (a whole changed word over a
 * few changed letters, `today`→`tomorrow` where only `day`→`morrow` differs).
 *
 * @param unit - the unit to test.
 * @param text - the drawn run's text.
 * @param side - which version of the source to search.
 * @returns whether the unit claims the text.
 */
function unitCarriesText(unit: PreviewUnit, text: string, side: 'add' | 'del'): boolean {
  const needle = text.trim()
  if (needle === '') return false
  const source = side === 'add' ? unit.newText : unit.oldText
  if (source === '') return false
  // Forward containment first: the unit's changed text is usually a slice of the drawn run (or equal to it).
  if (source.includes(needle)) return true
  // The other way round, a run may be WIDER than the unit it came from (`today`→`tomorrow` where only
  // `day`→`morrow` differs). Only a run of two or more characters may claim a shorter unit: a long run must
  // not match a one-character unit just because that character appears somewhere inside it.
  return source.length >= 2 && needle.includes(source)
}

/**
 * The unit a piece of changed source belongs to, when the block holds several.
 *
 * A drawn run is a verbatim slice of the source that changed, so it names its unit by being contained in it.
 *
 * @param units - the block's units.
 * @param text - the drawn run's text.
 * @param side - which version of the source to search.
 * @returns the unit's index, or undefined when no unit claims the text.
 */
function unitIndexForText(units: readonly PreviewUnit[], text: string, side: 'add' | 'del'): number | undefined {
  return units.find(unit => unitCarriesText(unit, text, side))?.index
}

/** The units whose own line range passes through one drawn element's stamped lines. */
function crossingUnits(units: readonly PreviewUnit[], element: HTMLElement, side: 'add' | 'del'): PreviewUnit[] {
  const start = Number(element.dataset.srcStart)
  const end = Number(element.dataset.srcEnd ?? element.dataset.srcStart)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return []
  return units.filter(unit => {
    if ((side === 'add' ? unit.newText : unit.oldText) === '') return false
    const lines = side === 'add' ? unit.newLines : unit.oldLines
    return lines.start - 1 <= end && lines.end - 1 >= start
  })
}

/**
 * The unit an ELEMENT stands for: its own stamped source LINES decide first, its text second.
 *
 * Text alone is ambiguous for short cells — a table cell reading `是` is contained in a dozen longer additions,
 * so the first one that contains it claimed the wrong number (the real filing's table cells numbered by a
 * paragraph above them). The element's own line span names exactly the units that passed through it; when that
 * is one unit, it is the answer.
 *
 * @param units - the block's units.
 * @param element - the drawn element.
 * @param side - which version of the source to search.
 * @returns the unit's index, or undefined when the lines do not single one out.
 */
function unitIndexForElement(units: readonly PreviewUnit[], element: HTMLElement, side: 'add' | 'del'): number | undefined {
  const onLines = crossingUnits(units, element, side)
  if (onLines.length === 1) return onLines[0]!.index
  // Several units pass through one element (a table cell holds the row's other changes too): the element's own
  // TEXT names the one it stands for. Callers that would rather leave a multi-unit element unmarked check
  // `crossingUnits` themselves (see the leftover loops).
  return unitIndexForText(units, element.dataset.srcText ?? '', side)
}

/**
 * The unit behind a change of an element's own attributes (a link's target, an image's source).
 *
 * @param units - the block's units.
 * @param previous - the old element.
 * @param next - the new element.
 * @param taken - units already drawn on the pair's own content (its word runs): a line like
 *   `… npm run old … [目标不变](…/v1)` has TWO changes that read `old`→`new`, one in the text and one in the
 *   link's target. The text run claims the first; the attribute must claim the OTHER, or the second unit stays
 *   unreachable and gets a phantom "invisible content" block that both duplicates a drawn change and breaks the
 *   double column's row order (the rich fixture's reported misalignment).
 * @returns the unit's index, or undefined when no unit claims the changed value.
 */
function unitIndexForShell(
  units: readonly PreviewUnit[],
  previous: HTMLElement,
  next: HTMLElement,
  taken: ReadonlySet<number> = new Set(),
): number | undefined {
  const names = ['href', 'src', 'title', 'alt', 'class']
  // The pair can be a whole cell whose LINK changed: the attribute that moved may be on a descendant, so the
  // two subtrees are compared element by element.
  const beforeElements = [previous, ...previous.querySelectorAll<HTMLElement>('*')]
  const afterElements = [next, ...next.querySelectorAll<HTMLElement>('*')]
  const count = Math.min(beforeElements.length, afterElements.length)
  for (let position = 0; position < count; position++) {
    for (const name of names) {
      const before = beforeElements[position]!.getAttribute(name) ?? ''
      const after = afterElements[position]!.getAttribute(name) ?? ''
      if (before === after) continue
      // The unit's fragment is what the attribute itself changed: a URL's `v1`→`v2` lives in the old and in
      // the new `href`.
      // A unit can also SPAN the whole element — a link whose text and target both changed is one unit (see
      // `mergeInlineLinkUnits`), so the attribute values sit INSIDE the unit's text rather than the other way
      // round. That unit is the element's change even when a run already claimed it.
      const spanning = units.find(unit => unit.oldText !== '' && unit.newText !== ''
        && unit.oldText.includes(before) && unit.newText.includes(after))
      if (spanning !== undefined) return spanning.index
      const free = (unit: PreviewUnit): boolean => !taken.has(unit.index)
      const exact = units.find(unit => free(unit) && unit.oldText !== '' && unit.newText !== ''
        && before.includes(unit.oldText) && after.includes(unit.newText))
      if (exact !== undefined) return exact.index
      const loose = units.find(unit => free(unit) && unit.newText !== '' && after.includes(unit.newText))
      if (loose !== undefined) return loose.index
    }
  }
  return undefined
}

/** The units already drawn on one merged pair's content, read off the marks the runs and twins carry. */
function takenUnits(...elements: readonly (HTMLElement | undefined)[]): Set<number> {
  const taken = new Set<number>()
  for (const element of elements) {
    if (element === undefined) continue
    for (const marked of element.querySelectorAll<HTMLElement>('[data-md-unit]')) {
      const index = Number(marked.dataset.mdUnit)
      if (Number.isFinite(index)) taken.add(index)
    }
  }
  return taken
}

/**
 * Give each drawn word run of a merged element its OWN block number.
 *
 * A merged element's change lives in its runs, not in itself: tagging the element would make the whole
 * paragraph (or cell) a hover target, so passing over its unchanged words — or the space between them — would
 * raise a toolbar for a change that is not under the pointer. Each run is the run's unit, and a block with a
 * single unit gives all of them that unit.
 *
 * @param element - the merged element.
 * @param units - the block's units.
 * @param fallback - the block's first unit number, for a run no unit claims.
 */
function tagRuns(element: HTMLElement, units: readonly PreviewUnit[], fallback: number): void {
  // Runs are tagged in the order they were drawn, and units are walked in the same order — not "first unit
  // whose text matches". Two changed lines can read identically (`old one` / `old two` both changed `old` to
  // `new`), and a first-match search would give the second line's runs the FIRST line's number.
  let cursor = 0
  let current = -1
  let lastSide: 'add' | 'del' | undefined
  for (const run of element.querySelectorAll<HTMLElement>('.mdWordAdd, .mdWordDel')) {
    const added = run.classList.contains('mdWordAdd')
    const side: 'add' | 'del' = added ? 'add' : 'del'
    // One change is drawn as its old side then its new side, so a struck run AFTER an added one begins the
    // next change: the unit cursor moves past the one just finished.
    if (side === 'del' && lastSide === 'add') cursor = current + 1
    const text = run.textContent ?? ''
    const source = (unit: PreviewUnit): string => side === 'add' ? unit.newText : unit.oldText
    /** The per-unit rules that stop one unit claiming two runs it did not produce. */
    const claimable = (index: number, unit: PreviewUnit): boolean => {
      // One unit drawn on both sides: its struck run and its added run are the SAME unit, so the other side
      // may match it again. The same side twice means the match belongs to the next unit.
      if (index === current && lastSide === side) return false
      return unitCarriesText(unit, text, side)
    }
    // An EXACT unit first. A unit may SPAN more than the changed run — a link whose text and target both
    // changed is one unit (`mergeInlineLinkUnits`), and its text contains the `old` of a code change later on
    // the line. Taking the first unit that merely CONTAINS the run would give that later run the link's number.
    let match: number | undefined
    const needle = text.trim()
    if (needle !== '') {
      for (let index = cursor; index < units.length; index++) {
        const unit = units[index]
        if (unit === undefined || source(unit).trim() !== needle || !claimable(index, unit)) continue
        match = index
        break
      }
    }
    if (match === undefined) {
      for (let index = cursor; index < units.length; index++) {
        const unit = units[index]
        if (unit === undefined || !claimable(index, unit)) continue
        match = index
        break
      }
    }
    // The match is a POSITION in this block's unit list; the tag is the UNIT's own number (its index in the
    // preview's numbering, which the list need not start at).
    let unit = match === undefined ? undefined : units[match]
    // An inline boundary can SPLIT one change into several runs: the space of `项目文档` → `项目文档 v2` is drawn
    // outside the link element while its `v2` is drawn inside, so the whitespace run matches no unit on its own
    // (`unitCarriesText` ignores whitespace). That fragment still belongs to the change it was cut from — the
    // one just matched — and giving it the block's FIRST unit instead would stretch that unit's hover frame
    // across the link and the space (the reported "hovering 一二 lights up v2" bug).
    if (unit === undefined && current >= 0 && text.trim() === '') unit = units[current]
    const index = unit?.index ?? fallback
    if (match !== undefined) {
      current = match
      cursor = Math.max(cursor, match)
      lastSide = side
    }
    run.dataset.mdUnit = String(index)
    run.dataset.mdKind = side
  }
}

/** A rendered element that came from a known span of the source. */
interface SourceElement {
  el: HTMLElement
  start: number
  end: number
}

/** A rendered document plus the elements its source lines map onto. */
interface RenderedDoc {
  root: HTMLElement
  elements: SourceElement[]
}

/** One Markdown token, as far as this renderer reads it (marked's own types are internal). */
interface MdToken {
  type: string
  raw: string
  tokens?: MdToken[] | undefined
  items?: MdToken[] | undefined
  rows?: MdToken[][] | undefined
  header?: MdToken[] | undefined
}

/** Character offsets of every line start, for offset → line lookups. */
function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

/** The 0-based line one character offset sits on. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low
}

/** The line span a token's raw text covers, given the offset it starts at. */
function spanOf(starts: readonly number[], offset: number, raw: string): LineSpan {
  const start = lineAt(starts, offset)
  const end = lineAt(starts, offset + raw.length)
  // A token ending in a newline does not reach INTO the next line.
  return { start, end: raw.endsWith('\n') ? Math.max(start, end - 1) : end }
}

/** The lines one raw occupies: every newline, plus the last line when the raw does not end with one. */
function linesConsumed(raw: string): number {
  let count = 0
  for (let index = 0; index < raw.length; index++) {
    if (raw.charCodeAt(index) === 10) count++
  }
  return count + (raw.endsWith('\n') ? 0 : 1)
}

/**
 * The line span of each child token, in order, from one starting line.
 *
 * Child raws are contiguous slices of the document, so their own line counts locate them exactly — the
 * alternative (searching the parent's raw for the child's text) fails on a nested list, whose raw has its
 * indentation stripped and therefore does not appear verbatim inside the parent.
 *
 * @param tokens - the child tokens, in render order.
 * @param start - the line the first child begins on.
 * @returns one entry per token that occupies at least one line.
 */
function childSpans(tokens: readonly MdToken[] | undefined, start: number): { token: MdToken; span: LineSpan }[] {
  const spans: { token: MdToken; span: LineSpan }[] = []
  let line = start
  for (const token of tokens ?? []) {
    if (token.raw === '') continue
    const end = line + Math.max(0, linesConsumed(token.raw) - 1)
    spans.push({ token, span: { start: line, end } })
    line = end + 1
  }
  return spans
}

/** Whether two inclusive spans touch at all. */

/** Render one top-level token's Markdown, sanitized, as detached elements. */
function renderToken(raw: string): HTMLElement[] {
  const holder = document.createElement('div')
  holder.innerHTML = DOMPurify.sanitize(marked.parse(raw, { async: false }) as string)
  return [...holder.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
}

/** The list items / table rows / quote children a token holds, in render order. */
function childTokensOf(token: MdToken): MdToken[] {
  if (token.type === 'list') return token.items ?? []
  if (token.type === 'blockquote') return token.tokens ?? []
  return []
}

/** Split one table row's source into its cells, honouring the `\|` escape. */
function splitCells(text: string): string[] {
  const body = text.trim()
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === '\\' && body[index + 1] === '|') {
      // An escaped pipe is cell CONTENT, not a delimiter: keep it and move past both characters.
      current += '\\|'
      index++
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  // A row wrapped in pipes leaves an empty slice at each end; a row without them does not.
  if (cells.length > 0 && cells[0]!.trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop()
  return cells
}

/** Stamp an element with the span AND the source text it stands for.
 *
 *  The text is what lets a later pass tell an element that merely sits inside a changed line (an unchanged
 *  table cell beside a changed one) from an element whose own source changed but whose rendering did not
 *  (a rewritten link target): their rendered text is the same, their source is not.
 *
 *  @param el - the element.
 *  @param lines - the document's lines.
 *  @param start - first source line the element covers.
 *  @param end - last source line it covers.
 *  @param text - the element's own slice, when it is narrower than its lines (a table cell).
 */
function stampSource(el: HTMLElement, lines: readonly string[], start: number, end: number, text?: string): void {
  el.dataset.srcStart = String(start)
  el.dataset.srcEnd = String(end)
  el.dataset.srcText = text ?? lines.slice(start, end + 1).join('\n')
}

/**
 * Record the elements a token's own text became, recursing into the containers that render one child
 * element per nested token (list items, table rows, a blockquote's blocks).
 *
 * @param el - the element this token rendered as.
 * @param token - the token it came from.
 * @param span - the source lines that token covers.
 * @param out - collects `{ el, start, end }` for every element that stands for exactly these lines.
 * @param lines - the document's own lines, for the element's source text.
 */
function collectSourceElements(
  el: HTMLElement,
  token: MdToken,
  span: LineSpan,
  out: SourceElement[],
  lines: readonly string[],
): void {
  if (token.type === 'list') {
    const items = token.items ?? []
    const lis = [...el.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'LI')
    const spans = childSpans(items, span.start)
    spans.forEach((entry, index) => {
      const li = lis[index]
      if (li === undefined) return
      const located = entry.span
      // A nested list is its own set of items: keep walking so the leaf is the inner item, not the parent.
      const nestedList = [...li.children].find((node): node is HTMLElement => node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL'))
      const nested = childSpans(entry.token.tokens, located.start).find(child => child.token.type === 'list')
      if (nestedList !== undefined && nested !== undefined) {
        // Only the item's OWN line belongs to it; the nested list below is a tree of its own.
        stampSource(li, lines, located.start, located.start)
        collectSourceElements(nestedList, nested.token, nested.span, out, lines)
        const own = (li.textContent ?? '').trim()
        if (own !== '') out.push({ el: li, start: located.start, end: located.start })
        return
      }
      stampSource(li, lines, located.start, located.end)
      out.push({ el: li, start: located.start, end: located.end })
    })
    return
  }
  if (token.type === 'table') {
    const headRow = el.querySelector<HTMLElement>('thead tr')
    const bodyRows = [...el.querySelectorAll<HTMLElement>('tbody tr')]
    const raw = token.raw.split('\n')
    const first = headRow ?? bodyRows[0]
    const cellLeaves = (tr: HTMLElement, line: number): void => {
      const cells = [...tr.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
      const text = raw[line - span.start] ?? ''
      // The slices are the cells' own source, so a changed cell can be marked where it reads.
      const slices = splitCells(text)
      if (cells.length === 0 || slices.length !== cells.length) {
        // A line swallowed by the table (a paragraph without a pipe, the reported case) is ONE source slice
        // spread over the header's cells: hand out the one cell that CARRIES the text, not the whole row. A
        // row-level carrier can only be replaced as a whole (its cells make it structural), so its change would
        // be a struck old row above a new one — and the other units on that line, drawn inside the new row,
        // would nest under the row's number.
        const filled = cells.filter(cell => (cell.textContent ?? '').trim() !== '')
        if (slices.length === 1 && filled.length === 1) {
          const cell = filled[0]!
          stampSource(cell, lines, line, line, slices[0] ?? '')
          out.push({ el: cell, start: line, end: line })
          return
        }
        stampSource(tr, lines, line, line)
        out.push({ el: tr, start: line, end: line })
        return
      }
      cells.forEach((cell, column) => {
        stampSource(cell, lines, line, line, slices[column] ?? '')
        out.push({ el: cell, start: line, end: line })
      })
    }
    if (first !== undefined) {
      stampSource(first, lines, span.start, span.start, raw[0] ?? '')
      // The header row is cells like any other: a changed header cell is marked where it reads, and a TR is
      // never handed out as a text carrier (its own text is the cells').
      if (headRow !== null) cellLeaves(headRow, span.start)
    }
    const rows = token.rows ?? []
    const offset = headRow === null ? 0 : 2
    rows.forEach((_row, index) => {
      const tr = bodyRows[index]
      if (tr === undefined) return
      const line = span.start + offset + index
      stampSource(tr, lines, line, line)
      cellLeaves(tr, line)
    })
    return
  }
  if (token.type === 'code') {
    // The code element is the text carrier: a changed line inside a fence is coloured where it reads, and
    // the `<pre>` around it keeps its own box.
    const code = el.querySelector<HTMLElement>('code')
    const carrier = code instanceof HTMLElement ? code : el
    stampSource(carrier, lines, span.start, span.end)
    out.push({ el: carrier, start: span.start, end: span.end })
    return
  }
  if (token.type === 'blockquote') {
    const children = [...el.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
    const tokens = childTokensOf(token)
    // Each child token covers its OWN lines: without this, every paragraph in a quote was stamped with the
    // quote's whole span and a change could not be told from its sibling's.
    const spans = childSpans(tokens, span.start)
    children.forEach((child, index) => {
      const entry = tokens[index]
      const childSpan = spans[index]?.span
      if (entry !== undefined && childSpan !== undefined) collectSourceElements(child, entry, childSpan, out, lines)
      else if (entry !== undefined) collectSourceElements(child, entry, span, out, lines)
    })
    return
  }
  stampSource(el, lines, span.start, span.end)
  out.push({ el, start: span.start, end: span.end })
  // An IMAGE-ONLY paragraph has no text of its own: the image is what the paragraph IS. Hand the image out as
  // the change's carrier too, so deleting it (or replacing its line with prose) stays visible — otherwise the
  // inline merge sees two paragraphs whose text differs and the removed image simply vanishes from the preview.
  if (token.type === 'paragraph' && (el.textContent ?? '').trim() === '') {
    for (const image of el.querySelectorAll<HTMLElement>('img')) {
      stampSource(image, lines, span.start, span.end)
      out.push({ el: image, start: span.start, end: span.end })
    }
  }
}

/**
 * Blank out a leading YAML front-matter block while keeping its lines.
 *
 * `marked` has no front-matter support, so `---` / `title: …` / `---` at the top would render as a rule plus
 * a setext heading: the metadata would appear INSIDE the document as content it never was. The block is
 * replaced by empty lines rather than removed, so every later line keeps its number and the diff's line
 * mapping stays exact — and a change to the metadata itself becomes a change with no rendered element,
 * which the preview reports as a dot.
 *
 * @param text - the document.
 * @returns the document with its front matter blanked.
 */
function maskFrontMatter(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return text
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close === -1) return text
  return lines.map((line, index) => (index <= close ? '' : line)).join('\n')
}

/**
 * How many leading lines a document's front matter covers (0 when it has none).
 *
 * The preview reports a front-matter change as blocks with no rendered content; the toolbar highlights those
 * lines as YAML, because that is what they are.
 *
 * @param text - the document.
 * @returns the front matter's line count, delimiters included.
 */
function frontMatterLineCount(text: string): number {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return 0
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return close === -1 ? 0 : close + 1
}

/**
 * Whether one line is a GFM table's delimiter row (`| --- | :---: | ---: |`).
 *
 * @param line - one line of source.
 * @returns whether it is a table delimiter.
 */
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))
}

/** The source lines of a document's GFM tables: which are row lines and which are delimiter rows. */
interface TableLineInfo {
  /** 1-based lines that hold a header or body row. */
  rows: Set<number>
  /** 1-based lines that hold a table's delimiter row (`| --- | --- |`). */
  delimiters: Set<number>
}

/**
 * Find the source lines that belong to GFM tables.
 *
 * A table's delimiter row renders nothing at all, so it is not a change the preview can show and must not be
 * compared at all — not as a unit, not as an invisible-content block (the reported `|---|---|` block). The row
 * lines are what table rules A/B are decided on (a whole added row is tinted as a row, not cell by cell).
 *
 * A line that merely LOOKS like a delimiter row inside a fenced code block is NOT one: the table tokens are
 * what say where tables are, exactly as the renderer parses them.
 *
 * @param text - one side's source.
 * @returns the row and delimiter line numbers (1-based).
 */
function tableLineInfo(text: string): TableLineInfo {
  const info: TableLineInfo = { rows: new Set(), delimiters: new Set() }
  const lines = text.split('\n')
  /** The fence marker of the code block we are inside, if any: a `| --- |` line there is code, not a table. */
  let fence: string | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch !== null) {
      if (fence === undefined) fence = fenceMatch[1]!
      else if (fenceMatch[1] === fence) fence = undefined
      index++
      continue
    }
    if (fence !== undefined) {
      index++
      continue
    }
    // A table starts at a header row (pipes) followed by a delimiter row — exactly the rule the renderer's own
    // `repairSwallowedTableLines` uses to find where a table ends (a line with no pipe ends it, blanks included).
    if (line.includes('|') && isTableDelimiterRow(lines[index + 1] ?? '')) {
      info.rows.add(index + 1)
      info.delimiters.add(index + 2)
      let row = index + 2
      while (row < lines.length) {
        const rowLine = lines[row] ?? ''
        if (rowLine.trim() === '' || !rowLine.includes('|')) break
        if (isTableDelimiterRow(rowLine)) {
          row++
          continue
        }
        info.rows.add(row + 1)
        row++
      }
      index = row
      continue
    }
    index++
  }
  return info
}

/**
 * Break the paragraph Markdown SWALLOWED into a table back out as a paragraph.
 *
 * GFM ends a table only at a blank line: lines written directly under a table row — with no `|`, clearly a
 * paragraph to the reader — become extra table rows. The preview used to render them there, which reads as the
 * diff having moved text INTO the table (the reported table-chapter confusion). They are reparsed as their own
 * paragraph here instead: a blank line is inserted in front of the first such line, and a line map keeps every
 * later line's ORIGINAL number, so the diff's line spans still name the same source lines.
 *
 * @param text - the masked document (front matter already blanked, line count unchanged).
 * @returns the repaired text and, per repaired line, its 0-based line in the original document (-1 = inserted).
 */
function repairSwallowedTableLines(text: string): { text: string; lineMap: number[] } {
  const lines = text.split('\n')
  const out: string[] = []
  const lineMap: number[] = []
  let inTable = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!inTable) {
      // A table starts at a header row (pipes) followed by a delimiter row.
      if (line.includes('|') && isTableDelimiterRow(lines[index + 1] ?? '')) inTable = true
      out.push(line)
      lineMap.push(index)
      continue
    }
    if (line.trim() === '') {
      inTable = false
      out.push(line)
      lineMap.push(index)
      continue
    }
    // A row (with its pipes) keeps the table going.
    if (line.includes('|')) {
      out.push(line)
      lineMap.push(index)
      continue
    }
    // A non-pipe line: the paragraph GFM would swallow. End the table with a blank line, then the paragraph.
    out.push('')
    lineMap.push(-1)
    inTable = false
    out.push(line)
    lineMap.push(index)
  }
  return { text: out.join('\n'), lineMap }
}

/**
 * Render a whole Markdown document ONCE and map its elements back to source lines.
 *
 * The CONTENT comes from a single `marked.parse` of the whole document, because Markdown is not
 * context-free: a reference-style link's target lives in a definition somewhere else in the file, and
 * rendering the paragraph alone turns `[docs][d]` into literal text. Per-token renders are used only to
 * learn HOW MANY top-level elements each token contributes, so the elements can be paired with the tokens
 * that produced them (a token that renders nothing — a link definition — contributes none).
 *
 * @param text - the document.
 * @returns the rendered tree and every element that stands for a known line span.
 */
function renderAnnotated(text: string): RenderedDoc {
  const masked = maskFrontMatter(text)
  const repaired = repairSwallowedTableLines(masked)
  const rendered = repaired.text
  const root = document.createElement('div')
  root.innerHTML = DOMPurify.sanitize(marked.parse(rendered, { async: false }) as string)
  const elements: SourceElement[] = []
  const tokens = marked.lexer(rendered) as unknown as MdToken[]
  const starts = lineStartsOf(rendered)
  // The ORIGINAL lines, so an element's stamped source is the document the reader is diffing (the front
  // matter's own text included, which is what a dot's hover text shows).
  const lines = text.split('\n')
  /** A repaired line's index as the ORIGINAL document numbers it (an inserted blank line maps to -1). */
  const originalLine = (line: number): number => {
    const mapped = repaired.lineMap[line]
    if (mapped !== undefined && mapped >= 0) return mapped
    // An inserted blank line: the token boundaries never start or end on one with content, so find the nearest
    // real line (back for an end, forward for a start).
    return line
  }
  const children = [...root.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
  let cursor = 0
  let placed = 0
  for (const token of tokens) {
    const raw = token.raw
    if (raw === '') continue
    const at = Math.max(cursor, rendered.indexOf(raw, cursor))
    if (token.type === 'space') {
      cursor = at + raw.length
      continue
    }
    const parsed = spanOf(starts, at, raw)
    const span = { start: originalLine(parsed.start), end: originalLine(parsed.end) }
    const count = renderToken(raw).length
    for (let step = 0; step < count; step++) {
      const el = children[placed]
      if (el === undefined) break
      placed++
      stampSource(el, lines, span.start, span.end)
      collectSourceElements(el, token, span, elements, lines)
    }
    cursor = at + raw.length
  }
  return { root, elements }
}

/** Each change block's line footprint on both sides. */
function blockSpans(diff: WholeFileDiff): Map<number, BlockSpan> {
  const spans = new Map<number, BlockSpan>()
  changeBlocksOf(diff).forEach((block, index) => {
    let oldStart = Number.POSITIVE_INFINITY
    let oldEnd = -1
    let newStart = Number.POSITIVE_INFINITY
    let newEnd = -1
    for (let row = block.start; row <= block.end; row++) {
      const entry = diff.rows[row]
      if (entry === undefined) continue
      if (entry.oldLine !== undefined) {
        oldStart = Math.min(oldStart, entry.oldLine - 1)
        oldEnd = Math.max(oldEnd, entry.oldLine - 1)
      }
      if (entry.newLine !== undefined) {
        newStart = Math.min(newStart, entry.newLine - 1)
        newEnd = Math.max(newEnd, entry.newLine - 1)
      }
    }
    spans.set(index, {
      old: oldEnd >= 0 ? { start: oldStart, end: oldEnd } : undefined,
      new: newEnd >= 0 ? { start: newStart, end: newEnd } : undefined,
    })
  })
  return spans
}

/** Whether two inclusive spans touch at all. */
function spansMeet(a: LineSpan, b: LineSpan): boolean {
  return a.start <= b.end && b.start <= a.end
}

/** The elements whose source lines meet a span, deepest first: an element that contains another match is
 *  dropped, so a changed list item marks the item rather than the list around it. */
function elementsIn(elements: readonly SourceElement[], span: LineSpan | undefined): SourceElement[] {
  if (span === undefined) return []
  const inside = elements.filter(entry => spansMeet({ start: entry.start, end: entry.end }, span))
  const deepest = inside.filter(entry => !inside.some(other => other !== entry && entry.el.contains(other.el)))
  // Document order, so two sides pair up the way they read.
  return deepest.sort((left, right) => (left.el.compareDocumentPosition(right.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

/** Mark one element as carrying a change UNIT on one side, without tinting it. */
/**
 * Stamp an element as carrying one UNIT of a change, without tinting it.
 *
 * A unit is the character-level change (the thing highlighted); the BLOCK it belongs to is stamped later,
 * from `previewBlocks` (see `applyBlockIndices`), so one element can say both "this is the unit" and "this is
 * the block the toolbar counts".
 */
function markUnit(el: HTMLElement, unit: number, kind: 'add' | 'del'): void {
  el.dataset.mdUnit = String(unit)
  el.dataset.mdKind = kind
}

/** Stamp an element as a BLOCK: the preview's `data-md-block`, the toolbar's number. */
function stampBlock(el: HTMLElement, block: number, kind: 'add' | 'del'): void {
  el.dataset.mdBlock = String(block)
  el.dataset.mdKind = kind
}

/** Stamp an element as a changed UNIT: its own surface is tinted, for a whole added or deleted part. */
function markChangedUnit(el: HTMLElement, unit: number, kind: 'add' | 'del'): void {
  el.classList.add(kind === 'add' ? 'mdAdd' : 'mdDel')
  markUnit(el, unit, kind)
}

/** Stamp an element as a changed BLOCK: its whole surface is tinted (a merged added paragraph/list/table). */
/**
 * Wrap a MERGED block's several rendered elements in ONE tinted container, so the colour is continuous across
 * the whole run instead of one background per element with the elements' margins showing white gaps between.
 *
 * The wrapper, not the children, carries the block number and the tint: one hover/target for the merged block.
 *
 * @param block - the merged block.
 * @param elements - the elements it renders (already in the DOM, in order).
 * @param kind - added (green) or deleted (red).
 * @returns the wrapper, or undefined when the elements do not share a parent.
 */
function wrapBlockUnion(block: TreePreviewBlock, elements: readonly HTMLElement[], kind: 'add' | 'del'): HTMLElement | undefined {
  const attached = elements.filter(element => element.parentNode !== null)
  if (attached.length < 2) return undefined
  const parent = attached[0]!.parentNode
  if (parent === null || !attached.every(element => element.parentNode === parent)) return undefined
  const wrapper = document.createElement('div')
  wrapper.className = kind === 'add' ? 'mdAdd mdBlockUnion' : 'mdDel mdBlockUnion'
  wrapper.dataset.mdBlock = String(block.index)
  wrapper.dataset.mdKind = kind
  parent.insertBefore(wrapper, attached[0]!)
  for (const element of attached) {
    element.classList.remove('mdAdd', 'mdDel')
    element.removeAttribute('data-md-block')
    element.removeAttribute('data-md-kind')
    element.removeAttribute('data-md-whole-row')
    wrapper.append(element)
  }
  return wrapper
}

function markChangedBlock(el: HTMLElement, block: number, kind: 'add' | 'del'): void {
  el.classList.add(kind === 'add' ? 'mdAdd' : 'mdDel')
  stampBlock(el, block, kind)
  // A whole table ROW is the change: it stays hoverable even though a row that merely carries a changed cell
  // is not (see the panel's `previewBlockAt`).
  if (el.tagName === 'TR') el.dataset.mdWholeRow = ''
}

/**
 * Interleave one element's two versions into a single inline run: changed words struck and highlighted in
 * place (`~~old~~ new`), unchanged text kept once.
 *
 * A `blockOf` callback lets a caller attribute each changed run to the change block it came from (see
 * `mergeSharedElement`), which is how ONE paragraph carrying several separate blocks keeps a mark for each
 * of them instead of being rewritten once per block, each pass clobbering the last.
 *
 * @param runs - the intra-line diff, whose two sides carry `same` runs in parallel and the changed runs on
 *   the side they belong to.
 * @param blockOf - the block a changed run belongs to, given the line it starts on and its side.
 * @returns the HTML for the element's content.
 */
function interleaveRuns(
  runs: { del: IntraRun[]; add: IntraRun[] },
  blockOf?: (line: number, side: 'add' | 'del') => number | undefined,
): string {
  const out: string[] = []
  let d = 0
  let a = 0
  let addLine = 0
  let delLine = 0
  const attribute = (text: string, side: 'add' | 'del'): string => {
    const line = side === 'add' ? addLine : delLine
    const block = blockOf?.(line, side)
    const kind = side === 'add' ? 'mdWordAdd' : 'mdWordDel'
    const attrs = block === undefined ? '' : ` data-md-unit="${block}" data-md-kind="${side}"`
    const cls = block === undefined ? kind : `${kind} ${side === 'add' ? 'mdAdd' : 'mdDel'}`
    return `<span class="${cls}"${attrs}>${escapeHtml(text)}</span>`
  }
  const countLines = (text: string): number => {
    let count = 0
    for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) count++
    return count
  }
  while (d < runs.del.length || a < runs.add.length) {
    const dr = runs.del[d]
    const ar = runs.add[a]
    if (dr !== undefined && dr.kind === 'del') {
      out.push(attribute(dr.text, 'del'))
      delLine += countLines(dr.text)
      d++
      continue
    }
    if (ar !== undefined && ar.kind === 'add') {
      out.push(attribute(ar.text, 'add'))
      addLine += countLines(ar.text)
      a++
      continue
    }
    if (dr !== undefined && ar !== undefined) {
      out.push(escapeHtml(ar.text))
      addLine += countLines(ar.text)
      delLine += countLines(dr.text)
      d++
      a++
      continue
    }
    if (dr !== undefined) {
      out.push(escapeHtml(dr.text))
      delLine += countLines(dr.text)
      d++
    } else if (ar !== undefined) {
      out.push(escapeHtml(ar.text))
      addLine += countLines(ar.text)
      a++
    }
  }
  return out.join('')
}

/** The parent a ghost of `kind` belongs in, and the node it goes before. */
function ghostAnchor(target: HTMLElement): { parent: HTMLElement; before: Node | null } {
  const parent = target.parentElement
  return { parent: parent ?? target, before: parent === null ? null : target }
}

/** Where an element with no counterpart of its own belongs in the fresh document. */
function insertionPointFor(freshRoot: HTMLElement, startLine: number): { parent: HTMLElement; before: Node | null } {
  const candidates = [...freshRoot.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
  // `>=` because a replacement's deleted side and its new side often name the SAME line: the ghost has to
  // land in front of the element that now occupies that place, not after it. A child with no line (a marker
  // placed earlier) says nothing about where this one belongs, so it is skipped rather than treated as "the
  // end of the document".
  const before = candidates.find(el => {
    const raw = el.dataset.srcStart
    return raw !== undefined && Number(raw) >= startLine
  })
  return { parent: freshRoot, before: before ?? null }
}

/** The text an element displays, with runs of whitespace folded so a syntax-only edit reads as equal. */
function shownText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Inline wrappers: an element made of these still reads as one line of text, so its own text can be
 * merged. EVERYTHING ELSE (a cell, a list, a paragraph inside an item) is structure and must be left alone.
 */
const INLINE_TAGS = new Set(['A', 'STRONG', 'EM', 'CODE', 'SPAN', 'DEL', 'INS', 'SUP', 'SUB', 'IMG', 'BR', 'MARK', 'SMALL', 'KBD', 'S', 'U'])

/**
 * The part of an element's text that belongs to the element ITSELF rather than to a nested structure.
 *
 * A list item with a nested list under it, or a table row made of cells, is one element holding several
 * things: only the leading text is the element's own line. Merging anything else would delete the
 * structure (a row's cells are not text).
 *
 * @param el - the element to read.
 * @returns the leading text, up to the first non-inline child element.
 */
function ownTextOf(el: HTMLElement): string {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      continue
    }
    // An inline wrapper (strong/em/code/a) is still part of the element's own line.
    if (node instanceof HTMLElement && INLINE_TAGS.has(node.tagName)) {
      text += node.textContent ?? ''
      continue
    }
    // A table cell, a nested list, another paragraph: the element's own text ended here.
    break
  }
  return text
}

/**
 * The text nodes that make up an element's OWN line: everything up to the first non-inline child.
 *
 * @param el - the element to walk.
 * @returns its own text nodes, in reading order.
 */
function ownTextNodes(el: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walk = (parent: Node): boolean => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        nodes.push(node as Text)
        continue
      }
      if (node instanceof HTMLElement && INLINE_TAGS.has(node.tagName)) {
        if (!walk(node)) return false
        continue
      }
      // A structural child (a cell, a nested list): the element's own line ended here.
      return false
    }
    return true
  }
  walk(el)
  return nodes
}

/** The character offset of every own text node's start, in reading order. */
function nodeOffsets(nodes: readonly Text[]): number[] {
  const offsets: number[] = []
  let total = 0
  for (const node of nodes) {
    offsets.push(total)
    total += node.data.length
  }
  return offsets
}

/** Split one text node at `offset` and return the half that starts there. */
function splitAt(node: Text, offset: number): Text {
  if (offset <= 0) return node
  if (offset >= node.data.length) return node
  return node.splitText(offset)
}

/**
 * Wrap the characters `[start, end)` of an element's own text in a span of `cls`, leaving every inline
 * element (a link, a bold run, inline code) exactly where it is.
 *
 * A range that crosses an inline element's boundary is wrapped per text node, which is what keeps the
 * element intact: the alternative — rewriting the element's innerHTML — deletes the link or the emphasis
 * along with the text it carried.
 *
 * @param el - the element to change.
 * @param start - first character offset, in the element's own text.
 * @param end - last character offset (exclusive).
 * @param cls - the class the wrapped characters take.
 */
function wrapOwnRange(el: HTMLElement, start: number, end: number, cls: string): void {
  const total = ownTextNodes(el).reduce((length, node) => length + node.data.length, 0)
  let cursor = Math.max(0, start)
  const limit = Math.min(end, total)
  while (cursor < limit) {
    const nodes = ownTextNodes(el)
    const offsets = nodeOffsets(nodes)
    let index = 0
    for (let step = 0; step < nodes.length; step++) {
      const node = nodes[step]!
      const from = offsets[step]!
      if (cursor >= from && cursor < from + node.data.length) {
        index = step
        break
      }
    }
    const node = nodes[index]
    if (node === undefined) return
    const localStart = cursor - offsets[index]!
    // Take the rest of THIS node only: an inline boundary ends the piece, and the next iteration carries on.
    const localEnd = Math.min(node.data.length, localStart + (limit - cursor))
    if (localEnd <= localStart) return
    const tail = splitAt(node, localEnd)
    const piece = localStart > 0 ? splitAt(node, localStart) : node
    const span = document.createElement('span')
    span.className = cls
    piece.parentNode?.insertBefore(span, piece)
    span.appendChild(piece)
    cursor += localEnd - localStart
    // `tail` is unused beyond the split: it is the text after this piece, which stays where it was.
    void tail
  }
}

/**
 * Wrap one side's changed characters INSIDE the element's own text, leaving nested structure alone.
 *
 * The runs partition the element's whole own text (unchanged runs included), so they are placed by walking
 * that text: each run lives where the previous runs ended. This is how the double column marks a changed WORD
 * inside a list item that also contains a nested list — the item itself is not washed.
 *
 * @param el - the element whose own text to mark.
 * @param runs - the side's runs, partitioning its own text.
 * @param cls - the word-run class to wrap the changed pieces with.
 */
function wrapOwnChangedRuns(el: HTMLElement, runs: readonly IntraRun[], cls: string): void {
  let cursor = 0
  for (const run of runs) {
    if (run.kind !== 'same' && run.text !== '') wrapOwnRange(el, cursor, cursor + run.text.length, cls)
    cursor += run.text.length
  }
}

/** Insert a struck run at character offset `at` of an element's own text. */
function insertOwnRun(el: HTMLElement, at: number, text: string, cls: string): void {
  const make = (): HTMLElement => {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    return span
  }
  // Only the element's own children are candidates — the first structural child ends the own line.
  const own: Node[] = []
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      own.push(node)
      continue
    }
    if (node instanceof HTMLElement && INLINE_TAGS.has(node.tagName)) {
      own.push(node)
      continue
    }
    break
  }
  let cursor = 0
  for (const child of own) {
    const length = (child.textContent ?? '').length
    // At the START of this child: the struck run goes before it, never inside it.
    if (at <= cursor) {
      el.insertBefore(make(), child)
      return
    }
    if (at < cursor + length) {
      if (child.nodeType === Node.TEXT_NODE) {
        const tail = (child as Text).splitText(at - cursor)
        tail.parentNode?.insertBefore(make(), tail)
        return
      }
      // Inside an inline wrapper: descend with the offset made relative to it.
      insertOwnRun(child as HTMLElement, at - cursor, text, cls)
      return
    }
    cursor += length
  }
  el.appendChild(make())
}

/**
 * Normalize one piece of text for the "is this change ALREADY on the page?" match, keeping a map back.
 *
 * The units come from the SOURCE (so they carry Markdown's own characters: `**`, backticks, escapes) while
 * the rendered document carries the marked-UP text. Removing the syntax characters and folding whitespace on
 * both sides makes the two comparable; the map lets a match in the normalized text be turned back into the
 * character range of the DOM's own text, which is what gets wrapped.
 *
 * @param text - raw text (source or rendered).
 * @returns the normalized text and, per normalized character, its index in `text`.
 */
function normalizeForMatch(text: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = []
  let space = false
  let atLineStart = true
  /** Characters Markdown syntax contributes but the rendering never shows. */
  const markupOnly = new Set(['*', '_', '`', '\\', '|', '['])
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '\n') atLineStart = true
    if (atLineStart && (character === ' ' || character === '\t')) continue
    // Blockquote markers and table borders never reach the rendered text, wherever they sit.
    if (character === '>' || character === '|') continue
    if (atLineStart && character === '#') continue
    if (atLineStart && (character === '-' || character === '+') && /[ \t]/.test(text[index + 1] ?? '')) continue
    if (atLineStart && /[0-9]/.test(character)) {
      let cursor = index
      while (cursor < text.length && /[0-9]/.test(text[cursor]!)) cursor += 1
      if (text[cursor] === '.' && /[ \t]/.test(text[cursor + 1] ?? '')) {
        index = cursor
        continue
      }
    }
    if (character === ']' && text[index + 1] === '(') {
      // A link's destination: the rendering shows the link text, never the `](url)` tail.
      let cursor = index + 1
      while (cursor < text.length && text[cursor] !== ')') cursor += 1
      index = cursor
      atLineStart = false
      continue
    }
    if (markupOnly.has(character)) continue
    atLineStart = false
    if (/\s/.test(character)) {
      if (space || out === '') continue
      out += ' '
      map.push(index)
      space = true
      continue
    }
    out += character
    map.push(index)
    space = false
  }
  // Trailing folded space is not part of a match; the leading one was already dropped.
  while (out.endsWith(' ')) {
    out = out.slice(0, -1)
    map.pop()
  }
  return { text: out, map }
}

/** Every text node under one element, in reading order, skipping inside a run this plugin already drew. */
function textNodesUnder(element: HTMLElement): Text[] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement
    // Only runs are skipped: the element being tagged is itself a `data-md-block` carrier, so checking that
    // attribute would skip every node under the very cell the text is in.
    if (parent !== null && parent.closest('.mdWordAdd, .mdWordDel') !== null) continue
    nodes.push(node as Text)
  }
  return nodes
}

/**
 * Wrap the characters `[start, end)` of one element's whole text in tagged runs.
 *
 * The range may cross inline boundaries (a bold word, a code span), so the pieces are collected first and
 * wrapped from LAST to first: splitting a later text node then cannot move the offsets of an earlier one.
 *
 * @param nodes - the element's text nodes, in reading order.
 * @param offsets - each node's start offset in the element's text.
 * @param start - first character offset.
 * @param end - last character offset (exclusive).
 * @param unit - the unit the wrapped characters belong to.
 * @param side - which side of the change they are.
 */
function wrapTextRangeWithUnit(
  nodes: readonly Text[],
  offsets: readonly number[],
  start: number,
  end: number,
  unit: PreviewUnit,
  side: 'old' | 'new',
): void {
  interface Piece { node: Text; from: number; to: number }
  const pieces: Piece[] = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    const nodeStart = offsets[index]!
    const from = Math.max(start, nodeStart) - nodeStart
    const to = Math.min(end, nodeStart + node.data.length) - nodeStart
    if (from < to) pieces.push({ node, from, to })
  }
  for (const piece of [...pieces].reverse()) {
    const tail = piece.to < piece.node.data.length ? piece.node.splitText(piece.to) : null
    const middle = piece.from > 0 ? piece.node.splitText(piece.from) : piece.node
    const span = document.createElement('span')
    span.className = side === 'new' ? 'mdWordAdd' : 'mdWordDel'
    span.dataset.mdUnit = String(unit.index)
    span.dataset.mdKind = side === 'new' ? 'add' : 'del'
    middle.parentNode?.insertBefore(span, middle)
    span.appendChild(middle)
    void tail
  }
}

/**
 * Mark a unit where the document ALREADY draws it, when the pair merge could not tag it.
 *
 * A changed line is usually drawn by the element the pair merge expected, but not always: a paragraph that
 * follows a GFM table without a blank line is parsed as more table rows by Markdown itself, so the renderer
 * sees no paragraph to merge — the text is on the page (inside the table), yet the unit had no element and
 * the reachability net below would have called it "invisible content". If the unit's text is on screen at the
 * unit's own line, it is tagged there instead: a real, hoverable change, not a phantom.
 *
 * @param root - the rendered document to search.
 * @param unit - the unit to place.
 * @param side - which side's text to look for.
 * @returns whether the unit was placed.
 */
function tagVisibleUnit(root: HTMLElement, unit: PreviewUnit, side: 'old' | 'new'): boolean {
  const raw = side === 'new' ? unit.newText : unit.oldText
  if (raw.trim() === '') return false
  const range = side === 'new' ? unit.newLines : unit.oldLines
  const wanted = normalizeForMatch(raw).text.trim()
  if (wanted === '') return false
  const candidates = [...root.querySelectorAll<HTMLElement>('[data-src-start]')]
    .filter(element => {
      const start = Number(element.dataset.srcStart)
      const end = Number(element.dataset.srcEnd ?? element.dataset.srcStart)
      return Number.isFinite(start) && Number.isFinite(end) && end >= range.start - 1 && start <= range.end - 1
    })
    // The DEEPEST element that carries the text is the cell/row that draws it; wrapping the whole table
    // instead would tag unrelated text as this unit.
    .filter(element => {
      const nodes = textNodesUnder(element)
      const text = nodes.map(node => node.data).join('')
      return normalizeForMatch(text).text.includes(wanted)
    })
    .sort((left, right) => (left.textContent ?? '').length - (right.textContent ?? '').length)
  const element = candidates[0]
  if (element === undefined) return false
  const nodes = textNodesUnder(element)
  const offsets: number[] = []
  let total = 0
  for (const node of nodes) {
    offsets.push(total)
    total += node.data.length
  }
  const plain = nodes.map(node => node.data).join('')
  const normalized = normalizeForMatch(plain)
  const at = normalized.text.indexOf(wanted)
  if (at === -1) return false
  const start = normalized.map[at]
  const end = normalized.map[at + wanted.length - 1]
  if (start === undefined || end === undefined) return false
  wrapTextRangeWithUnit(nodes, offsets, start, end + 1, unit, side)
  return true
}

/**
 * Place every unit the pair merge left untagged, where the document already draws its text.
 *
 * This runs BEFORE the reachability net: a unit whose text is visibly on the page is a drawn change, and a
 * phantom "invisible content" pair for it would be a lie (the reported table case). Only units with no
 * element AND no visible text remain for the net below.
 *
 * @param root - the rendered document.
 * @param units - the document's units.
 * @param side - which side's document this root is, in the double column; absent in the single column,
 *   where both sides' ghosts and merged runs live in one tree and either side may hold the text.
 */
function tagVisibleUnits(root: HTMLElement, units: readonly PreviewUnit[], side?: 'old' | 'new'): void {
  for (const unit of units) {
    if (root.querySelector(`[data-md-unit="${unit.index}"]`) !== null) continue
    if (side === 'old') {
      tagVisibleUnit(root, unit, 'old')
      continue
    }
    if (side === 'new') {
      tagVisibleUnit(root, unit, 'new')
      continue
    }
    if (tagVisibleUnit(root, unit, 'new')) continue
    tagVisibleUnit(root, unit, 'old')
  }
}

/**
 * Elements whose two versions are merged word by word only when the change is genuinely INLINE.
 *
 * The line diff pairs two LINES, so a one-line bullet that kept its opening words and then grew ten times
 * longer is still "one changed line" to the diff. Merging that pair word by word would bury the old sentence
 * inside a wall of new text — one endless paragraph. Those blocks stand as a replacement instead: the old
 * block struck above the new one. Cells and other purely inline carriers keep the merge either way.
 */
const INLINE_EDIT_GUARD = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD'])

/**
 * A fenced code block is merged word by word only when it is the SAME language and still mostly the same code.
 *
 * A code block's text is its LINES, so an inline merge inside a fence interleaves the old and the new program —
 * for a one-character tweak that is a readable mark on the changed characters, but a fence that became another
 * language, or was mostly rewritten, is a REPLACED block: the old fence struck above the new one, like any other
 * block whose content was replaced. The rich fixture hit exactly this: a `python` fence replaced by a `bash` one
 * came out as `print(echo "pythonadded block")`.
 *
 * `PRE` is here because a fence's diff element is its inner `CODE` (see `blockHostOf`); a `PRE` pair never
 * reaches the merge, and is listed so no future token shape starts merging it.
 */
const NO_INLINE_MERGE = new Set(['PRE'])

/** The highlight language a fenced code element carries (`language-ts` on the `CODE`), or `''`. */
function codeLanguage(element: HTMLElement): string {
  return /(?:^|\s)language-([^\s]+)/.exec(element.className)?.[1] ?? ''
}

/**
 * Whether two versions of one diff element should be merged word by word rather than drawn as a replacement.
 *
 * @param previous - the old element.
 * @param next - the new element.
 * @returns whether an inline merge is the right rendering.
 */
function inlineMergeTarget(previous: HTMLElement, next: HTMLElement): boolean {
  if (previous.tagName === 'CODE') {
    const before = previous.textContent ?? ''
    const after = next.textContent ?? ''
    if (before === after) return true
    // A fence whose program is still mostly the same merges its changed CHARACTERS inside one code block, even
    // when the LANGUAGE tag changed: `ts` → `tsx` with an edited line reads as one block with `1`→`2` marked,
    // and the tag (which draws nothing) rides on the block for the toolbar. A program that was REPLACED is not
    // merged character by character — its two versions are laid out line by line inside one block instead (see
    // `mergeFenceVersions`).
    return lineSimilarity(before, after) >= 0.5
  }
  return !NO_INLINE_MERGE.has(previous.tagName)
}

/** The element a code block's change should be painted on and ghosted from: the fence around its `CODE`. */
function blockHostOf(element: HTMLElement): HTMLElement {
  if (element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE') return element.parentElement
  return element
}

/**
 * Lay a REPLACED fence's two versions out INSIDE one code block.
 *
 * A wholesale code change cannot be merged character by character — the two programs would interleave into
 * nonsense (`print(echo "pythonadded block")`) — but drawing the whole fence TWICE reads as two code blocks
 * where the document has one. So the new fence keeps its place and carries both versions: the old program's
 * lines struck, then the new program's lines added, each line naming the change. The language tag draws nothing,
 * so it rides on the block as its source row for the toolbar.
 *
 * @param nextCode - the new fence's `CODE` (the block that stays).
 * @param oldCode - the old fence's `CODE`.
 * @param units - the block's change units (a replaced fence is ONE unit).
 * @param fallback - the unit to name when none claims the fence.
 */
function mergeFenceVersions(
  nextCode: HTMLElement,
  oldCode: HTMLElement,
  units: readonly PreviewUnit[],
  fallback: number,
): void {
  const index = unitIndexForText(units, nextCode.dataset.srcText ?? '', 'add') ?? fallback
  const oldLines = (oldCode.textContent ?? '').replace(/\n$/, '').split('\n')
  const newLines = (nextCode.textContent ?? '').replace(/\n$/, '').split('\n')
  const row = { old: sourceOfElement(oldCode), new: sourceOfElement(nextCode) }
  nextCode.textContent = ''
  const append = (line: string, kind: 'add' | 'del'): void => {
    const run = document.createElement('span')
    run.className = kind === 'add' ? 'mdWordAdd' : 'mdWordDel'
    markUnit(run, index, kind)
    run.textContent = line
    nextCode.append(run, document.createTextNode('\n'))
  }
  for (const line of oldLines) append(line, 'del')
  for (const line of newLines) append(line, 'add')
  // The whole fence is the change: its own element is the hover/keep target for the lines' runs.
  markUnit(nextCode, index, 'add')
  if (codeLanguage(oldCode) !== codeLanguage(nextCode)) {
    setSourceDiff(nextCode, row, undefined, 'markdown')
    // Every line run names the fence too, so hovering a changed line shows the source row of the whole fence
    // (the language tag lives in its opening line and has no rendering of its own).
    for (const run of nextCode.querySelectorAll<HTMLElement>('.mdWordAdd, .mdWordDel')) {
      setSourceDiff(run, row, undefined, 'markdown')
    }
  }
}

/** Mark a fence's LANGUAGE-tag change on an otherwise merged code block, so the hidden part is readable. */
function announceFenceLanguage(nextCode: HTMLElement, oldCode: HTMLElement, units: readonly PreviewUnit[], fallback: number): void {
  const row = { old: sourceOfElement(oldCode), new: sourceOfElement(nextCode) }
  const index = unitIndexForText(units, nextCode.dataset.srcText ?? '', 'add') ?? fallback
  if (codeLanguage(oldCode) !== codeLanguage(nextCode)) {
    setSourceDiff(nextCode, row, undefined, 'markdown')
    for (const run of nextCode.querySelectorAll<HTMLElement>('.mdWordAdd, .mdWordDel')) {
      setSourceDiff(run, row, undefined, 'markdown')
    }
  }
  markUnit(nextCode, index, 'add')
}

/**
 * Whether two versions of one element are an INLINE edit rather than a replaced block.
 *
 * An inline edit is the same text lightly changed: at least half of the longer version is the shorter one, so
 * appending a sentence, rewording a phrase or changing a word's case still merges. A line that mostly GREW —
 * a one-line bullet expanded into a paragraph — is a replacement: it is shown as its two whole versions, the
 * old block struck above the new one, rather than burying the old text inside a wall of new text.
 *
 * @param previous - the old element.
 * @param next - the new element.
 * @returns whether to merge them word by word.
 */
function isInlineEdit(previous: HTMLElement, next: HTMLElement): boolean {
  if (!INLINE_EDIT_GUARD.has(previous.tagName)) return true
  const before = ownTextOf(previous)
  const after = ownTextOf(next)
  if (before === after) return true
  const shorter = Math.min(before.length, after.length)
  const longer = Math.max(before.length, after.length)
  if (longer === 0) return true
  // Kept most of the text, or the change is only a few characters wide (a short line gaining a word): the
  // same text, lightly edited. A long line that multiplied in length is a replacement.
  return shorter / longer >= 0.5 || longer - shorter <= 24
}

/**
 * Merge the two versions of one element IN PLACE: each changed run is wrapped on the text it belongs to,
 * and a deleted run is inserted struck where its replacement starts.
 *
 * The element's own inline structure survives — a link stays a link, bold stays bold, inline code stays
 * code — because nothing is re-serialized from plain text.
 *
 * @param next - the element in the new document.
 * @param previous - the element in the old document.
 * @param index - the change block index.
 * @returns whether the two could be merged this way.
 */
function mergeInlineText(next: HTMLElement, previous: HTMLElement): boolean {
  const nodes = ownTextNodes(next)
  if (nodes.length === 0) return false
  const oldText = ownTextOf(previous)
  const newText = nodes.map(node => node.data).join('')
  // Only whitespace of its own means the element's text is NOT its own: it lives in children (a row's cells,
  // a block's blocks), and wrapping that whitespace would put runs where nothing readable changed.
  if (oldText.trim() === '' && newText.trim() === '') return false
  // The own text can be equal while an INLINE CHILD changed (a retargeted link): there is nothing to merge,
  // and treating the equal strings as "too dissimilar" would wrap the whole text as added and strike a copy.
  if (oldText === newText) return false
  const runs = intraRunsOf(oldText, newText)
  if (runs === undefined) {
    // Too dissimilar to align word by word (a case-only rewrite, a replaced cell): the element is still the
    // same one on both sides, so say the whole of what it said and the whole of what it says, in place. The
    // wrap comes FIRST: inserting the struck run also inserts its text into the element's own text, which
    // would then be what a later wrap of the same offsets covered.
    wrapOwnRange(next, 0, newText.length, 'mdWordAdd')
    insertOwnRun(next, 0, oldText, 'mdWordDel')
    return true
  }
  // The add side carries the positions in the text that is on screen; the del side says what to strike
  // beside them. Both are applied back-to-front, so an earlier edit cannot move a later one's offsets.
  interface Edit { kind: 'add' | 'del'; text: string; at: number }
  const edits: Edit[] = []
  let add = 0
  let del = 0
  let position = 0
  while (add < runs.add.length || del < runs.del.length) {
    const dr = runs.del[del]
    const ar = runs.add[add]
    if (dr !== undefined && dr.kind === 'del') {
      edits.push({ kind: 'del', text: dr.text, at: position })
      del++
      continue
    }
    if (ar !== undefined && ar.kind === 'add') {
      edits.push({ kind: 'add', text: ar.text, at: position })
      position += ar.text.length
      add++
      continue
    }
    if (dr !== undefined && ar !== undefined) {
      position += ar.text.length
      del++
      add++
      continue
    }
    if (ar !== undefined) {
      position += ar.text.length
      add++
    } else if (dr !== undefined) {
      del++
    }
  }
  for (const edit of [...edits].reverse()) {
    if (edit.kind === 'add') wrapOwnRange(next, edit.at, edit.at + edit.text.length, 'mdWordAdd')
    else insertOwnRun(next, edit.at, edit.text, 'mdWordDel')
  }
  return true
}

/**
 * The two sides' checkboxes, when this pair is a checkbox whose STATE changed.
 *
 * A ticked box is something the reader SEES, so its change must be drawn as the box itself: the old state
 * struck beside the new one. Reporting it as a source card would be describing a change that is right there
 * on the page.
 *
 * @param previous - the old element (or one containing the box).
 * @param next - the new element (or one containing the box).
 * @returns the old and new boxes, or undefined when this is not a checkbox state change.
 */
function checkboxPair(previous: HTMLElement, next: HTMLElement): [HTMLInputElement, HTMLInputElement] | undefined {
  const find = (el: HTMLElement): HTMLInputElement | undefined => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el
    const box = el.querySelector('input[type="checkbox"]')
    return box instanceof HTMLInputElement ? box : undefined
  }
  const oldBox = find(previous)
  const newBox = find(next)
  if (oldBox === undefined || newBox === undefined) return undefined
  if (oldBox.checked === newBox.checked) return undefined
  return [oldBox, newBox]
}

/**
 * Draw a checkbox state change where it happens: the old box (struck, red) beside the new one (green).
 *
 * BOTH boxes are the change — one unit — so both carry its number: either can be hovered, and the unit's
 * outline (the union of its elements) then frames the two of them together.
 *
 * @param previous - the old element.
 * @param next - the new element.
 * @param index - the change block index.
 * @returns whether both states were drawn, which replaces any source card for the pair.
 */
function drawCheckboxStates(previous: HTMLElement, next: HTMLElement, index: number): boolean {
  const pair = checkboxPair(previous, next)
  if (pair === undefined) return false
  const [oldBox, newBox] = pair
  const struck = document.createElement('span')
  struck.className = 'mdWordDel'
  struck.appendChild(oldBox.cloneNode(true))
  const added = document.createElement('span')
  added.className = 'mdWordAdd'
  newBox.replaceWith(added)
  added.appendChild(newBox)
  added.before(struck)
  markUnit(struck, index, 'del')
  markUnit(added, index, 'add')
  return true
}

/**
 * Mark ONE side's checkbox with the change tint, in place.
 *
 * A ticked box is a change of the BOX, not of the item: only the box gets the removed/added surface (and the
 * unit's number, so it is the hover target), and the rest of the line stays untouched. The double column
 * draws each version in its own column, so each column tints its own box instead of the struck-and-added pair
 * the single column draws.
 *
 * @param host - the changed element on one side.
 * @param index - the change unit's number.
 * @param kind - which side this is.
 * @returns whether a box was found and marked.
 */
function markCheckboxSide(host: HTMLElement, index: number, kind: 'add' | 'del'): boolean {
  const box = host instanceof HTMLInputElement && host.type === 'checkbox'
    ? host
    : host.querySelector('input[type="checkbox"]')
  if (!(box instanceof HTMLInputElement)) return false
  const holder = document.createElement('span')
  holder.className = kind === 'add' ? 'mdWordAdd' : 'mdWordDel'
  markUnit(holder, index, kind)
  box.replaceWith(holder)
  holder.appendChild(box)
  return true
}

/** What one change block's merge produced. */
type MergeOutcome =
  /** Something the reader can see was placed — a tint, a word run, a ghost, or a source-diff card. */
  | 'visible'
  /** Every changed pair differs only in SPELLING (same element, attrs and text): nothing to show. */
  | 'syntax'
  /** Nothing rendered on either side — an HTML comment, a front-matter line. */
  | 'none'

/**
 * Merge the two renderings for one change block into the NEW document.
 *
 * Both sides are shown. A pair of elements that stand for the same lines and hold plain text becomes one
 * element carrying `~~old~~ new`; a pair whose rendered text is the same is a change the preview cannot
 * show, and is reported as a source-diff card unless the two are only SPELLED differently; any other pair
 * keeps the new formatting and puts the old element beside it as a struck ghost. An element with no
 * counterpart at all is emitted as a ghost (deleted) or tinted (added). Nothing is wrapped, so the
 * document's own structure is untouched.
 *
 * @param freshRoot - the new document's root, for a deletion that has no sibling to sit beside.
 * @param newElements - the new side's elements for this block.
 * @param oldElements - the old side's elements for this block.
 * @param index - the source-LINE block index.
 * @param units - this line block's character-level units (see `previewUnits`); the first one supplies the
 *   number the element carries, and each drawn run is retagged with its own unit.
 * @param ghostLine - the NEW document's 0-based line where a leftover deletion belongs, when the caller can
 *   map it through the diff. An old-side line number cannot be used for that: deleted lines shift the new
 *   document's numbering, and a paragraph deleted after another changed one would land BEFORE it (the reported
 *   "deleted paragraph drawn above the merged paragraph" order).
 * @returns what was placed, which decides whether the block-level fallback marker is still needed.
 */
function mergeBlock(
  freshRoot: HTMLElement,
  newElements: readonly SourceElement[],
  oldElements: readonly SourceElement[],
  index: number,
  units: readonly PreviewUnit[] = [],
  ghostLine?: number,
): MergeOutcome {
  // The preview numbers UNITS, not lines: one line can hold two changes, and each keeps its own number.
  const block = units[0]?.index ?? index
  let visible = false
  let syntaxOnly = false
  /** A syntax-only pair whose element draws NO characters at all (a rule): hidden changes nothing would show. */
  let emptySyntax = false
  /** Hosts already drawn as a ghost: two deleted cells of one row are ONE deleted row. */
  const ghosted = new Set<HTMLElement>()
  /** Insert a ghost into a container so it reads in source order (before the element that replaced it). */
  const insertBySpan = (container: Element, ghost: HTMLElement, start: number): void => {
    // `>=` so a REPLACEMENT's struck side lands before the element that now occupies the same line.
    const next = [...container.children].find(child => Number((child as HTMLElement).dataset.srcStart ?? Number.MAX_SAFE_INTEGER) >= start)
    container.insertBefore(ghost, next ?? null)
  }
  /** Build the struck copy of one deleted element (its whole row/item/fence), or nothing when already drawn. */
  const buildGhost = (previous: SourceElement): HTMLElement | undefined => {
    // A deleted cell is drawn as its whole ROW, and a deleted item as the item itself: cloning a bare cell
    // would place a `<td>` outside any table, which renders as nothing at all. A code block is ghosted as its
    // whole fence, not the bare `CODE` inside it.
    const host = (previous.el.closest('tr, li') as HTMLElement | null) ?? blockHostOf(previous.el)
    if (ghosted.has(host)) return undefined
    ghosted.add(host)
    const ghost = host.cloneNode(true) as HTMLElement
    markChangedUnit(ghost, unitIndexForElement(units, previous.el, 'del') ?? unitIndexForText(units, previous.el.dataset.srcText ?? '', 'del') ?? block, 'del')
    return ghost
  }
  /** Put one ghost in a table/list container so it reads in source order (before the element it replaced). */
  const insertGhostInContainer = (ghost: HTMLElement, host: HTMLElement, start: number): boolean => {
    if (host.tagName === 'TR') {
      const body = freshRoot.querySelector('tbody') ?? freshRoot.querySelector('table')
      if (body !== null) {
        insertBySpan(body, ghost, start)
        return true
      }
    }
    if (host.tagName === 'LI') {
      const list = freshRoot.querySelector('ul, ol')
      if (list !== null) {
        insertBySpan(list, ghost, start)
        return true
      }
    }
    return false
  }
  const ghostOf = (previous: SourceElement, beside: HTMLElement | undefined): HTMLElement | undefined => {
    const host = (previous.el.closest('tr, li') as HTMLElement | null) ?? blockHostOf(previous.el)
    const start = Number(host.dataset.srcStart ?? previous.start)
    const ghost = buildGhost(previous)
    if (ghost === undefined) return undefined
    if (insertGhostInContainer(ghost, host, start)) {
      visible = true
      return ghost
    }
    // A ghost that has a sibling to sit beside (a replacement's struck side) uses that sibling; a leftover
    // DELETION has none, and goes where the block sits in the NEW document's order — mapped through the diff by
    // the caller, because the old line number means nothing in the new document (lines were added and removed).
    const anchor = beside !== undefined
      ? ghostAnchor(beside)
      : insertionPointFor(freshRoot, ghostLine ?? start)
    anchor.parent.insertBefore(ghost, anchor.before)
    visible = true
    return ghost
  }
  /** The last ghost this block placed: a later leftover deletion goes AFTER it, in source order. */
  let lastGhost: HTMLElement | undefined
  const pairs = Math.min(newElements.length, oldElements.length)
  for (let step = 0; step < pairs; step++) {
    const next = newElements[step]
    const previous = oldElements[step]
    if (next === undefined || previous === undefined) continue
    // A different element type cannot be twinned or merged character by character: the old version stands
    // struck above the new one. This holds even when the words are the SAME — a `####` heading demoted to `###`
    // is a visible change (the heading's size), and silently tagging only the new heading left the old one
    // unmarked and the change colorless.
    if (next.el.tagName !== previous.el.tagName) {
      markChangedUnit(next.el, unitIndexForElement(units, next.el, 'add') ?? block, 'add')
      visible = true
      lastGhost = ghostOf(previous, blockHostOf(next.el)) ?? lastGhost
      continue
    }
    // Nothing RENDERS differently for this pair. Whether its SHELL changed decides between a source-diff
    // card and nothing at all: an unchanged table cell beside a changed one reads the same and IS the same;
    // a rewritten link target reads the same but carries another `href`.
    if (shownText(next.el) === shownText(previous.el)) {
      // A box that got ticked shows its two states on the page — it is not a source-level change at all. Its
      // own number comes from the `x` the state change added (GFM ticks a box by replacing its space).
      if (drawCheckboxStates(previous.el, next.el, unitIndexForText(units, 'x', 'add') ?? block)) {
        visible = true
        continue
      }
      const before = previous.el.dataset.srcText
      const after = next.el.dataset.srcText
      // The rendering is the same; the SOURCE is not. A change of the element's own attributes (a link's
      // target) is drawn as its two versions below. A change of only the inline STYLE markers is drawn per
      // re-spelled element, also as two versions (see `inlineStylePairs`). A whitespace-only edit stays hidden.
      if ((before ?? '') !== (after ?? '')
        && structureFingerprint(next.el) !== structureFingerprint(previous.el)) {
        // The rendering is the same; the element's own ATTRIBUTES are not. Draw both versions side by side —
        // the old tinted red on the left, the new tinted green on the right — and carry the source
        // difference for the toolbar to show on hover (see `applyTwin`).
        const changed = changedElementPairs(previous.el, next.el, true)
        visible = true
        const already = takenUnits(previous.el, next.el)
        twinPairs(changed, units, unitIndexForShell(units, previous.el, next.el, already) ?? block, already)
      } else if (shownText(next.el) === '') {
        // Two spellings of an element that draws no characters at all — `---` and `***` both draw a rule: there
        // is not one pixel to tint, so the change cannot be SHOWN. Report it as invisible content instead of
        // hiding it: the reader must still see that something changed there and be able to keep/revert it.
        emptySyntax = true
      } else {
        // Same words, same element, only the MARKERS around them re-spelled (`**加粗**` → `__加粗__`): the
        // reader asked to COMPARE the two styles, so each re-spelled inline element is drawn as its two
        // versions, red and green, and each pair is its OWN change (`加粗` and `斜体` are two comparisons).
        // Anything else that renders identically (a whitespace-only line) stays hidden.
        const stylePairs = inlineStylePairs(previous.el, next.el, units)
        let drawnStyle = false
        for (const [oldEl, newEl, unit] of stylePairs) {
          if (!applyTwin(oldEl, newEl, unit, false)) continue
          drawnStyle = true
        }
        if (drawnStyle) visible = true
        else syntaxOnly = true
      }
      continue
    }
    // The same element on both sides: merge its text IN PLACE, so whatever inline structure it carries (a
    // link, a bold run, inline code) survives the edit instead of being re-serialized as plain text.
    if (next.el.tagName === previous.el.tagName) {
      const shellChanged = structureFingerprint(next.el) !== structureFingerprint(previous.el)
      // Which descendants carry a shell change, measured BEFORE the merge: merging inserts runs, which would
      // shift the two subtrees' child lists apart and hide the element that actually changed.
      const shellPairs = shellChanged ? changedElementPairs(previous.el, next.el, false) : []
      if (inlineMergeTarget(previous.el, next.el)
        && isInlineEdit(previous.el, next.el) && mergeInlineText(next.el, previous.el)) {
        // Each drawn run names its OWN unit — and the RUNS, not the element, are the hover targets: the
        // element's unchanged words must not raise a toolbar (see `tagRuns`).
        tagRuns(next.el, units, block)
        visible = true
        // A fence whose language tag changed but whose program still merged: the tag draws nothing, so the
        // fence's source row rides on the block for the toolbar.
        if (next.el.tagName === 'CODE' && next.el.parentElement?.tagName === 'PRE') {
          announceFenceLanguage(next.el, previous.el, units, block)
        }
        // The words merged, but a change in a descendant's own ATTRIBUTES has no rendering of its own: it is
        // drawn as that element's two versions side by side, with its source difference on hover.
        if (shellPairs.length > 0) twinPairs(shellPairs, units, block, takenUnits(next.el, previous.el))
        continue
      }
    }
    // A fence that was REPLACED cannot merge character by character, but it must not become two code blocks
    // either: one block carries both programs, the old lines struck and the new ones added.
    if (next.el.tagName === 'CODE' && next.el.parentElement?.tagName === 'PRE'
      && previous.el.tagName === 'CODE' && previous.el.parentElement?.tagName === 'PRE') {
      mergeFenceVersions(next.el, previous.el, units, block)
      visible = true
      continue
    }
    // Not inline-mergeable: the new side keeps its own formatting, the old side stands beside it.
    markChangedUnit(blockHostOf(next.el), block, 'add')
    visible = true
    lastGhost = ghostOf(previous, blockHostOf(next.el))
  }
  // Anything left on the old side was deleted; anything left on the new side was added. A leftover deletion
  // goes where its OWN source lines sit (not beside the first paired element): the deleted paragraph under a
  // retargeted link follows the link, because that is the order the source is in.
  //
  // Its place is found in this order:
  //  1. after a struck side this block already placed (the old versions stay one run, in source order);
  //  2. mapped through the DIFF to the new document's next line — one block can hold both a replacement and a
  //     deletion, and the deletion's OLD line means nothing in the new numbering;
  //  3. in front of the block's new element (a block that only tucks its leftovers behind their replacement);
  //  4. by the ghost's own line as a last resort.
  const blockFront = newElements[0]?.el
  for (let step = pairs; step < oldElements.length; step++) {
    const previous = oldElements[step]
    if (previous === undefined) continue
    const host = (previous.el.closest('tr, li') as HTMLElement | null) ?? blockHostOf(previous.el)
    const start = Number(host.dataset.srcStart ?? previous.start)
    const ghost = buildGhost(previous)
    if (ghost === undefined) continue
    if (insertGhostInContainer(ghost, host, start)) {
      visible = true
      lastGhost = ghost
      continue
    }
    if (lastGhost !== undefined && lastGhost.isConnected) {
      lastGhost.parentNode?.insertBefore(ghost, lastGhost.nextSibling)
    } else if (ghostLine !== undefined) {
      const anchor = insertionPointFor(freshRoot, ghostLine)
      anchor.parent.insertBefore(ghost, anchor.before)
    } else if (blockFront !== undefined && isAttached(blockFront)) {
      blockFront.parentNode?.insertBefore(ghost, blockFront)
    } else {
      const anchor = insertionPointFor(freshRoot, start)
      anchor.parent.insertBefore(ghost, anchor.before)
    }
    visible = true
    lastGhost = ghost
  }
  for (let step = pairs; step < newElements.length; step++) {
    const next = newElements[step]
    if (next === undefined) continue
    // A multi-unit element (ONE paragraph carrying several added lines, a blockquote) is tagged line by line
    // where its text sits; marking the element with the block's first number would NEST those lines inside it
    // and paint one number over all of them (the reported nested-diff bug on a real filing).
    if (crossingUnits(units, next.el, 'add').length > 1) continue
    markChangedUnit(next.el, unitIndexForElement(units, next.el, 'add') ?? block, 'add')
    visible = true
  }
  if (visible) return 'visible'
  // A re-spelling the renderer CAN draw (a paragraph whose words are unchanged) is left alone. A re-spelling of
  // an element that draws nothing gets the invisible-content blocks instead, so the change is not lost.
  if (emptySyntax) return 'none'
  // Everything changed only in its spelling: the caller must NOT add a fallback card for it.
  return syntaxOnly ? 'syntax' : 'none'
}

/**
 * The element's tag, attributes and descendants' — WITHOUT any text.
 *
 * This is what tells a change of WORDS (which the merge draws) apart from a change of the element's own
 * shell: a link's target, an image's source, a code fence's language. The shell cannot be drawn — nothing
 * about it looks different — so it has to be reported as source beside the words that did change.
 *
 * @param el - the element to fingerprint.
 * @returns the structure fingerprint.
 */
function structureFingerprint(el: HTMLElement): string {
  const attrs = [...el.attributes]
    .filter(attr => !attr.name.startsWith('data-src'))
    .map(attr => `${attr.name}=${attr.value}`)
    .sort()
    .join('|')
  const children = [...el.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map(child => structureFingerprint(child))
    .join(',')
  return `${el.tagName}[${attrs}](${children})`
}

/*
 * ====== twin rendering ======
 * A change the rendering cannot SHOW — a link's target, an image's source, a box's ticked state, a
 * front-matter line — is drawn as the two versions themselves: the old on the left, tinted red, the new on
 * the right, tinted green. The reader sees that a change exists and what each side says, and the SOURCE
 * difference rides along as data attributes: the toolbar shows it on hover, as a detail on demand rather than
 * a card that takes up a line of the document.
 */

/** The attributes a rendered element carries, leaving out our own bookkeeping. */
function attributeFingerprint(el: HTMLElement): string {
  return [...el.attributes]
    .filter(attr => !attr.name.startsWith('data-src') && !attr.name.startsWith('data-md-'))
    .map(attr => `${attr.name}=${attr.value}`)
    .sort()
    .join('|')
}

/** Attributes a twin's frame already DRAWS (an image's path), so they need no source row on hover. */
const DRAWN_IN_TWIN = new Set(['src', 'class'])

/**
 * Whether the shell change behind a pair is INVISIBLE — a link's target, an image's caption, a heading's
 * level, a fence's language.
 *
 * An image's own path is drawn in its twin frames, so a path-only change is not invisible: the reader already
 * reads both paths. Everything else in the attributes is invisible in the rendering and is reported to the
 * toolbar.
 *
 * @param previous - the old element.
 * @param next - the new element.
 * @returns whether the rendering cannot say what changed.
 */
function hasHiddenDiff(previous: HTMLElement, next: HTMLElement): boolean {
  // A change of ELEMENT (a heading level): the tag itself is the difference, and it is invisible.
  if (previous.tagName !== next.tagName) return true
  for (const name of ['href', 'src', 'title', 'alt', 'class']) {
    if (previous.getAttribute(name) === next.getAttribute(name)) continue
    if (previous.tagName === 'IMG' && DRAWN_IN_TWIN.has(name)) continue
    return true
  }
  return false
}

/**
 * An element's own MARKDOWN source — the whole thing, not just the part that changed.
 *
 * The toolbar's row is "源码差异", so it shows what the source said, the way the reader would have written it:
 * a link as `[text](target)`, an image as `![alt](path)`, a heading with its `#`s. The rendering is thrown
 * away for this, so a link's whole line reads as the link rather than as one attribute of it.
 *
 * @param el - the rendered element.
 * @returns its Markdown source.
 */
function sourceOfElement(el: HTMLElement): string {
  const tag = el.tagName
  if (tag === 'A') return `[${el.textContent ?? ''}](${el.getAttribute('href') ?? ''})`
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt') ?? ''
    const path = el.getAttribute('src') ?? ''
    const title = el.getAttribute('title')
    return `![${alt}](${path}${title === null ? '' : ` "${title}"`})`
  }
  if (tag === 'INPUT') {
    return (el as HTMLInputElement).checked ? '[x]' : '[ ]'
  }
  // A fence keeps the block's own source: the language change is in its opening line, and the code belongs to
  // the block it is in.
  if (tag === 'CODE' && el.parentElement?.tagName === 'PRE') {
    return el.parentElement.dataset.srcText ?? el.textContent ?? ''
  }
  if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${el.textContent ?? ''}`
  const stamped = el.dataset.srcText
  if (stamped !== undefined && stamped !== '') return stamped.trim()
  return (el.textContent ?? '').trim()
}

/** One side of a twin: its tint, and (for a frame) the rendered content. */
function sideOf(side: 'old' | 'new', content: HTMLElement): HTMLElement {
  const holder = document.createElement('span')
  holder.className = side === 'old' ? 'mdTwinOld' : 'mdTwinNew'
  holder.appendChild(content)
  return holder
}

/**
 * One side of a twin that has nothing to render — an added or a removed piece.
 *
 * The block is the SIDE itself, so its tint is the one every other change uses (a change drawn at full
 * strength): a square the height of a text line, not a marker floating inside another tinted box.
 *
 * @param side - which version it stands for.
 * @returns the block.
 */
function blockSide(side: 'old' | 'new'): HTMLElement {
  const block = document.createElement('span')
  block.className = side === 'old' ? 'mdTwinOld mdTwinBlock' : 'mdTwinNew mdTwinBlock'
  return block
}

/**
 * An image's twin frame: the frame shows the PATH the image names, because for an image the path IS the
 * change — there is nothing else about it to see.
 *
 * @param img - the rendered image.
 * @returns its frame.
 */
function imageFrame(img: Element): HTMLElement {
  const frame = document.createElement('span')
  frame.className = 'mdImageFrame'
  const path = document.createElement('span')
  path.className = 'mdImagePath'
  path.textContent = img.getAttribute('src') ?? ''
  frame.appendChild(path)
  const alt = img.getAttribute('alt') ?? ''
  if (alt !== '') {
    const caption = document.createElement('span')
    caption.className = 'mdImageAlt'
    caption.textContent = alt
    frame.appendChild(caption)
  }
  // The title is an IMAGE attribute too: a change to it must read on the frame that owns it, like the path.
  const title = img.getAttribute('title') ?? ''
  if (title !== '') {
    const caption = document.createElement('span')
    caption.className = 'mdImageTitle'
    caption.textContent = title
    frame.appendChild(caption)
  }
  return frame
}

/** The grammar the toolbar's source row is highlighted with: Markdown source, or YAML for front matter. */
type SourceGrammar = 'markdown' | 'yaml'

/**
 * Carry one side's source line on the element the toolbar reads it from.
 *
 * @param element - the element the toolbar reads.
 * @param diff - the two sides' source, if the change has an invisible part.
 * @param side - which side this element belongs to (double column); both when omitted.
 * @param grammar - the grammar the row is highlighted with.
 */
function setSourceDiff(
  element: HTMLElement,
  diff: { old?: string; new?: string } | undefined,
  side?: 'old' | 'new',
  grammar: SourceGrammar = 'markdown',
): void {
  if (diff === undefined) return
  if (side !== 'new' && diff.old !== undefined) element.dataset.mdDiffOld = diff.old
  if (side !== 'old' && diff.new !== undefined) element.dataset.mdDiffNew = diff.new
  element.dataset.mdDiffGrammar = grammar
}

/**
 * Show both versions of one element side by side, replacing the new one in place: the old tinted red on the
 * left, the new tinted green on the right. An image pair becomes two frames with their paths; a block that
 * cannot sit inline becomes two marker blocks.
 *
 * When part of the change is still invisible, the toolbar's row carries each side's WHOLE source — the whole
 * link, not just its target.
 *
 * @param previous - the old element.
 * @param next - the new element.
 * @param index - the change unit's number.
 * @param hidden - whether the rendering cannot say what changed.
 * @returns whether the twin was placed.
 */
function applyTwin(previous: HTMLElement, next: HTMLElement, index: number, hidden: boolean): boolean {
  const parent = next.parentNode
  if (parent === null) return false
  // A fence's code element belongs to a block: two copies of the code side by side would read as duplicated
  // content, so a language change is reported on the element itself instead (the caller's fallback).
  if (next.tagName === 'CODE' && next.parentElement?.tagName === 'PRE') return false
  if (previous.tagName !== next.tagName) return false
  const wrapper = document.createElement('span')
  wrapper.className = 'mdTwin'
  markUnit(wrapper, index, 'add')
  if (hidden) setSourceDiff(wrapper, { old: sourceOfElement(previous), new: sourceOfElement(next) })
  if (next instanceof HTMLImageElement) {
    // An image took the whole line before, so its pair does too: two frames sharing the width.
    wrapper.classList.add('mdTwinImages')
    wrapper.append(sideOf('old', imageFrame(previous)), sideOf('new', imageFrame(next)))
  } else if (INLINE_TAGS.has(next.tagName)) {
    wrapper.append(
      sideOf('old', previous.cloneNode(true) as HTMLElement),
      sideOf('new', next.cloneNode(true) as HTMLElement),
    )
  } else {
    // A block that cannot sit inline: one block per side says a removal and an addition happened here.
    wrapper.append(blockSide('old'), blockSide('new'))
  }
  parent.replaceChild(wrapper, next)
  return true
}

/**
 * Carry a unit's own source line numbers on its marker block, so the toolbar can show the untouched context
 * lines around an invisible change (see the panel's `previewContextAround`).
 *
 * @param element - the marker block.
 * @param unit - the unit it stands for.
 * @param side - which side's line numbers to write.
 */
function setMarkerLines(element: HTMLElement, unit: PreviewUnit | undefined, side: 'old' | 'new'): void {
  if (unit === undefined) return
  const lines = side === 'old' ? unit.oldLines : unit.newLines
  const text = side === 'old' ? unit.oldText : unit.newText
  if (text === '') return
  element.dataset[side === 'old' ? 'mdDiffOldLines' : 'mdDiffNewLines'] = `${lines.start}-${lines.end}`
}

/**
 * The blocks for a change with NO rendered element at all — a front-matter line, an HTML comment.
 *
 * ONE block per side the change has: a red block for the removed line, a green one for the added line, never one
 * split block joining the two. That is how every drawn change reads (a removal and an addition are two things),
 * and it is what lets each side's source line ride on its own block for the toolbar. A pure insertion has only
 * the green block, a pure deletion only the red one.
 *
 * @param index - the change unit's number.
 * @param oldLine - the removed source line, when there is one.
 * @param newLine - the added source line, when there is one.
 * @param grammar - the grammar the toolbar highlights these lines with.
 * @param unit - the unit, when its LINE NUMBERS are known: they let the toolbar add context lines.
 * @returns one block per existing side, in the order removal then addition.
 */
function placeholderTwins(
  index: number,
  oldLine: string | undefined,
  newLine: string | undefined,
  grammar: SourceGrammar = 'markdown',
  unit?: PreviewUnit,
): HTMLElement[] {
  const blocks: HTMLElement[] = []
  if (oldLine !== undefined) {
    const block = phantomBlock(index, oldLine, 'old', grammar)
    setMarkerLines(block, unit, 'old')
    blocks.push(block)
  }
  if (newLine !== undefined) {
    const block = phantomBlock(index, newLine, 'new', grammar)
    setMarkerLines(block, unit, 'new')
    blocks.push(block)
  }
  return blocks
}

/**
 * ONE side's modest block for a change with no rendered content: the wrapper is tinted red (removal) or green
 * (addition) by the stylesheet, from the side that is NOT hidden.
 *
 * @param index - the change unit's number.
 * @param line - that side's changed source line(s).
 * @param side - which side this block stands for.
 * @param grammar - the grammar the toolbar highlights the line with.
 * @returns the block.
 */
function phantomBlock(index: number, line: string, side: 'old' | 'new', grammar: SourceGrammar): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'mdTwin mdTwinPhantom'
  markUnit(wrapper, index, side === 'old' ? 'del' : 'add')
  setSourceDiff(wrapper, side === 'old' ? { old: line } : { new: line }, undefined, grammar)
  const oldSide = blockSide('old')
  const newSide = blockSide('new')
  // The other side does not exist on THIS block: the stylesheet reads the hidden side for the tint.
  if (side === 'old') newSide.hidden = true
  else oldSide.hidden = true
  wrapper.append(oldSide, newSide)
  return wrapper
}

/**
 * A change with NO rendered element at all, both sides in ONE element — the double column's own shape, where each
 * column holds only ITS side (see `phantomBlock`, which the single column uses per side).
 *
 * @param index - the change unit's number.
 * @param oldLine - the removed source line, when there is one.
 * @param newLine - the added source line, when there is one.
 * @param grammar - the grammar the toolbar highlights these lines with.
 * @param unit - the unit, when its LINE NUMBERS are known: they let the toolbar add context lines.
 * @returns the twin.
 */
function placeholderTwin(
  index: number,
  oldLine: string | undefined,
  newLine: string | undefined,
  grammar: SourceGrammar = 'markdown',
  unit?: PreviewUnit,
): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'mdTwin mdTwinPhantom'
  markUnit(wrapper, index, 'add')
  setSourceDiff(wrapper, {
    ...(oldLine !== undefined ? { old: oldLine } : {}),
    ...(newLine !== undefined ? { new: newLine } : {}),
  }, undefined, grammar)
  const oldSide = blockSide('old')
  const newSide = blockSide('new')
  if (oldLine === undefined) oldSide.hidden = true
  if (newLine === undefined) newSide.hidden = true
  wrapper.append(oldSide, newSide)
  if (oldLine !== undefined) setMarkerLines(wrapper, unit, 'old')
  if (newLine !== undefined) setMarkerLines(wrapper, unit, 'new')
  return wrapper
}

/**
 * The source line(s) a unit covers inside one side of its block, for a change with no rendered content.
 *
 * The unit's characters say WHERE it is; the block's own span says whether that side exists at all. This is
 * what makes a change inside a line (a value APPENDED to `title: A`) show that line on BOTH sides: the old
 * line is `title: A` and the new one `title: A v2`, exactly the removal and addition the source view shows.
 * Pure insertions and deletions (one side of the block missing) show only their own side.
 *
 * @param text - the side's whole file.
 * @param span - that side's block span, or undefined when the block does not exist on it.
 * @param chars - the unit's character range on that side.
 * @returns the line(s), without a trailing newline.
 */
function unitSourceLines(text: string, span: LineSpan | undefined, chars: { start: number; end: number }): string | undefined {
  if (span === undefined) return undefined
  const starts = lineStartsOf(text)
  // `span` is 0-based (see `blockSpans`); clamp the unit's characters into this block's own lines.
  const blockStart = starts[span.start] ?? 0
  const blockEnd = Math.max(blockStart, (starts[span.end + 1] ?? text.length) - 1)
  const start = Math.min(Math.max(chars.start, blockStart), blockEnd)
  const end = Math.min(Math.max(chars.end, start), blockEnd)
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const to = text.indexOf('\n', end)
  return text.slice(from, to === -1 ? text.length : to)
}

/**
 * In one column of the double view, show a changed element for ITS side: tinted red (before) or green (after),
 * carrying that side's whole source for the toolbar. An image becomes a frame with its own path, since the
 * path is the change.
 *
 * @param element - the element to change.
 * @param side - which column it stands in.
 * @param index - the change unit's number.
 * @param hidden - whether the rendering cannot say what changed.
 * @returns the element now standing for that side (the original element, or the replacement frame holder).
 */
function sideTwin(element: HTMLElement, side: 'old' | 'new', index: number, hidden: boolean): HTMLElement {
  const row = hidden ? { [side === 'old' ? 'old' : 'new']: sourceOfElement(element) } : undefined
  if (element instanceof HTMLImageElement) {
    const holder = sideOf(side, imageFrame(element))
    holder.classList.add('mdTwinColumn')
    markUnit(holder, index, side === 'old' ? 'del' : 'add')
    setSourceDiff(holder, row, side)
    element.replaceWith(holder)
    return holder
  }
  markChangedUnit(element, index, side === 'old' ? 'del' : 'add')
  setSourceDiff(element, row, side)
  return element
}

/**
 * The pairs of elements whose SHELL differs between the two versions of one element — its changed descendants
 * (and, when asked, itself).
 *
 * @param previous - the old element tree.
 * @param next - the new element tree.
 * @param includeRoot - whether the element itself may be one of the pairs.
 * @returns the element pairs, outermost first.
 */
function changedElementPairs(previous: HTMLElement, next: HTMLElement, includeRoot: boolean): [HTMLElement, HTMLElement][] {
  const pairs: [HTMLElement, HTMLElement][] = []
  const walk = (oldEl: HTMLElement, newEl: HTMLElement, isRoot: boolean): void => {
    // A change of ELEMENT itself (a heading level, a cell that became a header) is a shell change too.
    if (oldEl.tagName !== newEl.tagName) {
      if (!isRoot || includeRoot) pairs.push([oldEl, newEl])
      return
    }
    if (attributeFingerprint(oldEl) !== attributeFingerprint(newEl)) {
      if (!isRoot || includeRoot) pairs.push([oldEl, newEl])
      return
    }
    const oldChildren = [...oldEl.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
    const newChildren = [...newEl.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
    const count = Math.min(oldChildren.length, newChildren.length)
    for (let position = 0; position < count; position++) walk(oldChildren[position]!, newChildren[position]!, false)
  }
  walk(previous, next, true)
  return pairs
}

/** Whether an element is still in the tree being built (the preview's root is detached, so not `isConnected`). */
function isAttached(element: HTMLElement): boolean {
  return element.parentNode !== null
}

/**
 * Draw the changed descendants of a pair as twins (the element itself optionally included).
 *
 * A pair that cannot be twinned — a change of TAG, or a fence whose code element belongs to a block — keeps
 * the document's own content and carries the source difference on the element instead, so hovering it still
 * says what changed.
 *
 * @param pairs - the pairs from `changedElementPairs`.
 * @param units - the block's units.
 * @param fallback - the unit number to use when no unit claims an element's change.
 * @param already - units already drawn on the pair (its word runs), so a same-reading text change cannot claim
 *   the attribute change's unit too — see `unitIndexForShell`.
 * @returns whether anything was drawn.
 */
function twinPairs(
  pairs: readonly [HTMLElement, HTMLElement][],
  units: readonly PreviewUnit[],
  fallback: number,
  already: ReadonlySet<number> = new Set(),
): boolean {
  const taken = new Set(already)
  let drawn = false
  for (const [oldEl, newEl] of pairs) {
    if (!isAttached(newEl)) continue
    const index = unitIndexForShell(units, oldEl, newEl, taken) ?? fallback
    taken.add(index)
    const hidden = hasHiddenDiff(oldEl, newEl)
    if (!applyTwin(oldEl, newEl, index, hidden)) {
      markUnit(newEl, index, 'add')
      // The element itself carries the change: its row is its whole source on each side.
      if (hidden) setSourceDiff(newEl, { old: sourceOfElement(oldEl), new: sourceOfElement(newEl) })
    }
    drawn = true
  }
  return drawn
}

/**
 * Strip the Markdown markers that STYLE a piece of inline source, leaving the words they style.
 *
 * `**加粗**` and `__加粗__` are one word written two ways; the comparison the reader wants is between the two
 * STYLED versions, so the markers come off to find the element that renders those words.
 *
 * @param text - one unit's source on one side.
 * @returns the words the markers wrap (`''` for a markers-only unit).
 */
function stripInlineStyleMarkers(text: string): string {
  return text.replace(/^[*_~`]+/, '').replace(/[*_~`]+$/, '')
}

/** The deepest element in `root` whose rendered text is exactly `text`. */
function deepestElementWithText(root: HTMLElement, text: string): HTMLElement | undefined {
  let found: HTMLElement | undefined
  const walk = (element: HTMLElement): void => {
    for (const child of element.children) {
      if (!(child instanceof HTMLElement)) continue
      if ((child.textContent ?? '') === text) found = child
      walk(child)
    }
  }
  walk(root)
  return found
}

/**
 * The inline elements whose WORDS are unchanged but whose Markdown SPELLING is not (`**加粗**` vs `__加粗__`).
 *
 * A re-spelling is not nothing: the reader asked to compare the two styles, so each pair is drawn as its two
 * versions side by side — the old tinted red, the new green — and each pair is its OWN change (`加粗` and
 * `斜体` are two comparisons, not one block).
 *
 * @param previousRoot - the old version of the block element.
 * @param nextRoot - the new version.
 * @param units - the block's change units.
 * @returns old/new element pairs with their unit numbers, in source order.
 */
function inlineStylePairs(
  previousRoot: HTMLElement,
  nextRoot: HTMLElement,
  units: readonly PreviewUnit[],
): [HTMLElement, HTMLElement, number][] {
  const pairs: [HTMLElement, HTMLElement, number][] = []
  const used = new Set<HTMLElement>()
  for (const unit of units) {
    if (unit.oldText === unit.newText) continue
    const oldWords = stripInlineStyleMarkers(unit.oldText)
    const newWords = stripInlineStyleMarkers(unit.newText)
    // Only a re-spelling: the same words, only the markers around them changed.
    if (oldWords === '' || oldWords !== newWords) continue
    const oldEl = deepestElementWithText(previousRoot, oldWords)
    const newEl = deepestElementWithText(nextRoot, newWords)
    if (oldEl === undefined || newEl === undefined || oldEl === newEl) continue
    // The block element itself is not an inline style to compare; its own spelling is the block's.
    if (oldEl === previousRoot || newEl === nextRoot) continue
    if (oldEl.tagName !== newEl.tagName) continue
    if (used.has(oldEl) || used.has(newEl)) continue
    used.add(oldEl)
    used.add(newEl)
    pairs.push([oldEl, newEl, unit.index])
  }
  return pairs
}

/**
 * The span a unit's marker should be placed by: the unit's OWN line(s), not its block's whole span.
 *
 * In a CREATION (empty baseline) the whole file is one change block, so every unit's block span starts at line
 * 1 — placing the leftover markers by it stacked them above the document's first heading (the reported
 * numbering/order bug on a real filing). A unit's own line number is the place the marker belongs.
 *
 * @param unit - the unit to place.
 * @param span - its block's span, when there is one.
 * @param side - which side's line numbers to use.
 * @returns the span carrying that side's own line range.
 */
function unitInsertSpan(unit: PreviewUnit, span: BlockSpan | undefined, side: 'old' | 'new'): BlockSpan {
  const lines = side === 'old' ? unit.oldLines : unit.newLines
  if (span === undefined) {
    const lineSpan = { start: lines.start - 1, end: lines.end - 1 }
    return side === 'old' ? { old: lineSpan, new: undefined } : { old: undefined, new: lineSpan }
  }
  const text = side === 'old' ? unit.oldText : unit.newText
  if (text === '' || lines.start < 1) return span
  return side === 'old'
    ? { ...span, old: { start: lines.start - 1, end: lines.end - 1 } }
    : { ...span, new: { start: lines.start - 1, end: lines.end - 1 } }
}

/**
 * Place a marker where its own source lines sit, among the document's blocks.
 *
 * A change that renders to nothing — an HTML comment, a front-matter line — still happened at a place in the
 * document, and that place is its line number: the marker goes before the first block that starts at or after
 * it (and after the last one when it is at the end). Dropping it at the top instead would show the ninth
 * change of a file above the first, which is what the reader would then read as an anchoring bug.
 *
 * @param root - the rendered document.
 * @param marker - the element to place.
 * @param span - the block's source span.
 * @param side - which column's line numbers this root is stamped with: the OLD column must be placed by the
 *   OLD side's line, not the new one (using the new line put a reference-definition marker AFTER the image
 *   paragraph that the old document has before it).
 */
function insertCardInSourceOrder(root: HTMLElement, marker: HTMLElement, span: BlockSpan, side: 'old' | 'new' = 'new'): void {
  const line = (side === 'old' ? (span.old ?? span.new) : (span.new ?? span.old))?.start ?? 0
  // A line INSIDE a container the document draws (a table's delimiter row) belongs inside that container: at the
  // top level it would land after the rows above it, whose numbers then run backwards (a real filing's table).
  const table = [...root.querySelectorAll<HTMLElement>('table')].find(element => {
    const start = Number(element.dataset.srcStart)
    const end = Number(element.dataset.srcEnd ?? element.dataset.srcStart)
    return Number.isFinite(start) && Number.isFinite(end) && start <= line && line <= end
  })
  if (table !== undefined) {
    const columns = table.querySelector('thead tr')?.children.length ?? table.querySelector('tr')?.children.length ?? 1
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = Math.max(1, columns)
    cell.append(marker)
    row.append(cell)
    const rows = [...table.querySelectorAll<HTMLElement>('tr')]
    const nextRow = rows.find(candidate => Number(candidate.dataset.srcStart ?? Number.MAX_SAFE_INTEGER) >= line)
    if (nextRow !== undefined && nextRow.parentNode !== null) nextRow.parentNode.insertBefore(row, nextRow)
    else (table.querySelector('tbody') ?? table).append(row)
    return
  }
  const next = [...root.children].find(child => {
    // Only a documented block has a line to compare against; a marker placed earlier has none.
    const raw = (child as HTMLElement).dataset.srcStart
    return raw !== undefined && Number(raw) >= line
  })
  if (next === undefined) root.appendChild(marker)
  else root.insertBefore(marker, next)
}

/** The source lines a rendered element was stamped with, 0-based. */
function sourceSpanOf(el: HTMLElement): LineSpan | undefined {
  const raw = el.dataset.srcStart
  if (raw === undefined) return undefined
  const start = Number(raw)
  if (!Number.isFinite(start)) return undefined
  const end = Number(el.dataset.srcEnd ?? raw)
  return { start, end: Number.isFinite(end) ? end : start }
}

/**
 * The rendered elements a merged pure block paints.
 *
 * A hunk that covers a whole top-level block (a new paragraph, list, table, fence) paints that element: one
 * green/red surface for the block. A hunk INSIDE a larger element (a row added to an existing table, a line
 * added inside a paragraph) paints the row/item/cell host it lies in instead — and a table cell becomes its
 * ROW, so an added row is tinted as a row rather than cell by cell (rule B).
 *
 * @param root - the side's rendered document.
 * @param elements - its stamped elements.
 * @param span - the hunk's changed lines on this side (0-based).
 * @returns the hosts to paint, deduplicated and in document order.
 */
function mergedHosts(root: HTMLElement, elements: readonly SourceElement[], span: LineSpan): SourceElement[] {
  const topLevel = [...root.children]
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .map(element => ({ element, span: sourceSpanOf(element) }))
    .filter((entry): entry is { element: HTMLElement; span: LineSpan } => entry.span !== undefined
      && entry.span.start >= span.start && entry.span.end <= span.end)
  if (topLevel.length > 0) {
    return topLevel.map(entry => ({ el: entry.element, start: entry.span.start, end: entry.span.end }))
  }
  const seen = new Set<HTMLElement>()
  const hosts: SourceElement[] = []
  for (const entry of elementsIn(elements, span)) {
    let host = entry.el
    if (host.tagName === 'TD' || host.tagName === 'TH') host = (host.closest('tr') as HTMLElement | null) ?? host
    if (host.tagName === 'CODE' && host.parentElement?.tagName === 'PRE') host = host.parentElement
    if (seen.has(host)) continue
    seen.add(host)
    hosts.push({ el: host, start: entry.start, end: entry.end })
  }
  return hosts
}

/**
 * Put a deletion's struck ghost where it belongs among the NEW document's elements.
 *
 * A deleted row/item goes back into a table/list that still exists; anything else is a top-level block and
 * lands by the line the diff maps it to.
 *
 * @param freshRoot - the new document's root.
 * @param host - the deleted element's host in the old document.
 * @param ghost - its struck clone.
 * @param ghostLine - the new-side line the deletion belongs at.
 */
function insertGhostHost(freshRoot: HTMLElement, host: HTMLElement, ghost: HTMLElement, ghostLine: number): void {
  const container = host.tagName === 'TR' ? 'table' : host.tagName === 'LI' ? 'ul, ol' : undefined
  if (container !== undefined) {
    const candidates = [...freshRoot.querySelectorAll<HTMLElement>(container)]
    const containing = candidates.find(candidate => {
      const span = sourceSpanOf(candidate)
      return span !== undefined && span.start <= ghostLine && ghostLine <= span.end
    })
    const following = candidates.find(candidate => {
      const span = sourceSpanOf(candidate)
      return span !== undefined && span.start >= ghostLine
    })
    const target = containing ?? following ?? candidates[0]
    if (target !== undefined) {
      for (const child of target.children) {
        const span = sourceSpanOf(child as HTMLElement)
        if (span !== undefined && span.start >= ghostLine) {
          child.parentNode?.insertBefore(ghost, child)
          return
        }
      }
      target.appendChild(ghost)
      return
    }
  }
  const anchor = insertionPointFor(freshRoot, ghostLine)
  anchor.parent.insertBefore(ghost, anchor.before)
}

/**
 * A marker for a merged block that renders NOTHING: one chip for the block (never one per line), carrying
 * the block's own number so it can be hovered, kept and reverted like any other block.
 *
 * @param block - the merged block.
 * @param side - which side's source the chip stands for.
 * @param grammar - the grammar that side's source is highlighted with.
 * @returns the chip.
 */
function blockPhantom(block: PreviewBlock, side: 'old' | 'new', grammar: SourceGrammar): HTMLElement {
  const text = block.invisible
    .map(diff => (side === 'old' ? diff.oldText : diff.newText))
    .filter((line): line is string => line !== undefined)
    .join('\n')
  const marker = phantomBlock(block.index, text, side, grammar)
  delete marker.dataset.mdUnit
  stampBlock(marker, block.index, side === 'old' ? 'del' : 'add')
  return marker
}

/**
 * Draw one merged pure block: a whole added paragraph/list/table is tinted where it already renders, a whole
 * deleted one is cloned as a struck ghost, and a block with no rendering at all gets ONE marker.
 *
 * The two preview layouts differ only in where a deletion is drawn: the single column clones it into the new
 * document (beside the content that replaced it), while the double column keeps each side's own document, so
 * there the old column simply tints its own copy.
 *
 * @param options - the block and the two rendered documents.
 */
function applyMergedBlock(options: {
  block: PreviewBlock
  freshRoot: HTMLElement
  baselineRoot: HTMLElement
  freshElements: readonly SourceElement[]
  baselineElements: readonly SourceElement[]
  mode: 'single' | 'double'
  ghostLine: number | undefined
}): void {
  const { block, freshRoot, baselineRoot, freshElements, baselineElements, mode, ghostLine } = options
  const grammar = block.invisible[0]?.grammar ?? 'markdown'
  const newSpan = block.newChanged
  const oldSpan = block.oldChanged
  if (newSpan !== undefined) {
    const hosts = mergedHosts(freshRoot, freshElements, newSpan)
    if (hosts.length === 0) {
      // The added content draws nothing: one chip for the block, where it belongs in the new document.
      insertCardInSourceOrder(freshRoot, blockPhantom(block, 'new', grammar), { old: undefined, new: newSpan }, 'new')
    } else {
      for (const host of hosts) markChangedBlock(host.el, block.index, 'add')
    }
  }
  if (oldSpan !== undefined) {
    const oldHosts = mergedHosts(baselineRoot, baselineElements, oldSpan)
    if (oldHosts.length === 0) {
      // The removed content drew nothing: one chip, placed where the diff says it was removed.
      const line = ghostLine ?? oldSpan.start
      const target = mode === 'double' ? baselineRoot : freshRoot
      const side = mode === 'double' ? 'old' : 'new'
      const placement: BlockSpan = side === 'old'
        ? { old: { start: line, end: line }, new: undefined }
        : { old: undefined, new: { start: line, end: line } }
      insertCardInSourceOrder(target, blockPhantom(block, 'old', grammar), placement, side)
    } else if (mode === 'double') {
      for (const host of oldHosts) markChangedBlock(host.el, block.index, 'del')
    } else {
      // A merged block that ALSO has new content is a replacement (an unrelated deletion + addition, or a
      // pure hunk that happens to have both): the struck old version belongs directly ABOVE the new one. A
      // pure deletion has no new content to sit above, so it goes where the diff maps it among its neighbours.
      const placement = newSpan !== undefined ? newSpan.start : (ghostLine ?? oldSpan.start)
      for (const host of oldHosts) {
        const ghost = host.el.cloneNode(true) as HTMLElement
        // The ghost is a BLOCK: any unit markup its clone carried would number it as characters.
        for (const marked of [ghost, ...ghost.querySelectorAll<HTMLElement>('[data-md-unit]')]) {
          delete marked.dataset.mdUnit
          delete marked.dataset.mdKind
        }
        markChangedBlock(ghost, block.index, 'del')
        insertGhostHost(freshRoot, host.el, ghost, placement)
      }
    }
  }
}

/**
 * Turn the renderer's UNIT stamps into BLOCK stamps.
 *
 * The renderer marks the characters it changed (`data-md-unit`); everything the reader counts, frames and
 * keeps, however, is a BLOCK (`data-md-block`, from `previewBlocks`). This pass is the one place the mapping is
 * applied, so the drawn numbering and the panel's numbering cannot drift apart.
 *
 * A table row's block is also stamped on the `<tr>` itself (the hover frame unions every element of a block, so
 * the dashed box then goes round the whole row — rule A). A whole-row block drops its cell marks: the row is
 * tinted, not the cells, and no word runs are left inside it (rule B).
 *
 * @param root - one rendered document.
 * @param blockOfUnit - the block each unit belongs to.
 * @param wholeRowUnits - the units drawn as a whole table row (rule B).
 */
function applyBlockIndices(
  root: HTMLElement,
  blockOfUnit: ReadonlyMap<number, number>,
  wholeRowUnits: ReadonlyMap<number, 'add' | 'del'>,
): void {
  for (const element of [...root.querySelectorAll<HTMLElement>('[data-md-unit]')]) {
    const unit = Number(element.dataset.mdUnit)
    if (!Number.isFinite(unit)) continue
    const block = blockOfUnit.get(unit)
    if (block === undefined) continue
    const whole = wholeRowUnits.get(unit)
    if (whole !== undefined) {
      const row = element.tagName === 'TR' ? element : element.closest('tr')
      if (element.tagName !== 'TR') {
        // Rule B: a whole added/removed row is ONE tinted row, never per-cell or per-word marks.
        element.classList.remove('mdAdd', 'mdDel')
        delete element.dataset.mdUnit
        delete element.dataset.mdKind
      } else {
        delete element.dataset.mdUnit
      }
      if (row !== null) {
        row.classList.add(whole === 'add' ? 'mdAdd' : 'mdDel')
        row.dataset.mdBlock = String(block)
        row.dataset.mdKind = whole
        row.dataset.mdWholeRow = ''
      }
      continue
    }
    element.dataset.mdBlock = String(block)
    // Rule A: the row itself carries the block too, so the frame and the anchor cover the whole row.
    if (element.tagName !== 'TR') {
      const row = element.closest('tr')
      if (row !== null && row.dataset.mdBlock === undefined) row.dataset.mdBlock = String(block)
    }
  }
}

/**
 * Merge several change blocks that all live inside ONE element into a single pass.
 *
 * A paragraph whose second and fourth lines both changed is one rendered element with two blocks in it.
 * Rewriting that element once per block would clobber the earlier pass, so the element is rewritten once,
 * and each changed run carries the block it came from — which is also what the panel's frame reads, since
 * it unions the rects of every `[data-md-block="N"]` in the body.
 *
 * @param el - the element both blocks sit in.
 * @param group - the blocks, with their spans and their old-side elements.
 * @returns whether anything visible was drawn.
 */
function mergeSharedElement(el: HTMLElement, group: readonly { index: number; span: BlockSpan; oldEl: SourceElement | undefined }[]): boolean {
  const first = group[0]
  const oldEl = first?.oldEl
  if (first === undefined || oldEl === undefined) return false
  const runs = intraRunsOf(oldEl.el.textContent ?? '', el.textContent ?? '')
  if (runs === undefined) return false
  const newBase = Number(el.dataset.srcStart ?? 0)
  const oldBase = Number(oldEl.el.dataset.srcStart ?? 0)
  const blockOf = (line: number, side: 'add' | 'del'): number | undefined => {
    const absolute = (side === 'add' ? newBase : oldBase) + line
    return group.find(entry => {
      const span = side === 'add' ? entry.span.new : entry.span.old
      return span !== undefined && absolute >= span.start && absolute <= span.end
    })?.index
  }
  el.innerHTML = interleaveRuns(runs, blockOf)
  return true
}

/**
 * The merged single column: the new document, with every change block's both sides drawn on it.
 *
 * @param oldText - the baseline the diff was taken from.
 * @param newText - the current content.
 * @returns sanitized HTML for the preview body.
 */
function renderMerged(oldText: string, newText: string, invisibleLabel?: string): string {
  const diff = computeDiffOf(oldText, newText)
  const spans = blockSpans(diff)
  /**
   * The preview's DIFFERENCE BLOCKS. A pure addition/deletion hunk is one block however many units its lines
   * were cut into, so a whole new document is one block rather than one per changed line (the reported "a new
   * file shows 78 blocks"); a merged block's lines are drawn as whole tinted elements instead of unit runs.
   */
  const previewFileBlocks = previewBlocks(oldText, newText)
  const { blockOfUnit, wholeRowUnits } = blockMapsOf(previewFileBlocks)
  const mergedHunks = new Set(previewFileBlocks.filter(block => block.merged).map(block => block.lineBlock))
  const units = previewFileBlocks.flatMap(block => block.units)
  /** The units the per-hunk renderer draws: a merged block's lines are drawn by `applyMergedBlock` instead. */
  const renderUnits = units.filter(unit => !mergedHunks.has(unit.lineBlock))
  const oldFrontMatter = frontMatterLineCount(oldText)
  const newFrontMatter = frontMatterLineCount(newText)
  /**
   * Which grammar the toolbar highlights a no-rendering block's source with: a front-matter line is YAML,
   * anything else (an HTML comment, a link definition) is Markdown.
   */
  const grammarOf = (unit: PreviewUnit): SourceGrammar =>
    unit.oldLines.start <= oldFrontMatter || unit.newLines.start <= newFrontMatter ? 'yaml' : 'markdown'
  /** The units cut from one source-line block, in order. */
  const unitsOfBlock = new Map<number, PreviewUnit[]>()
  for (const unit of renderUnits) {
    const list = unitsOfBlock.get(unit.lineBlock) ?? []
    list.push(unit)
    unitsOfBlock.set(unit.lineBlock, list)
  }
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  const hunks = changeBlocksOf(diff)
  /**
   * Where a block's LEFTOVER deletion belongs in the NEW document: the new-side line of the first diff row
   * after the block. Old line numbers cannot be used for that — lines were added and removed, so an old line
   * number points somewhere else in the new document (the reported "deleted paragraph drawn above the merged
   * paragraph" order).
   */
  const ghostLineOf = (index: number): number | undefined => {
    const block = hunks[index]
    if (block === undefined) return undefined
    for (let row = block.end + 1; row < diff.rows.length; row++) {
      const newLine = diff.rows[row]?.newLine
      if (newLine !== undefined) return newLine - 1
    }
    return undefined
  }
  interface Entry {
    index: number
    span: BlockSpan
    freshEls: SourceElement[]
    oldEls: SourceElement[]
    ghostLine: number | undefined
  }
  const entries: Entry[] = [...spans.entries()]
    .sort((left, right) => left[0] - right[0])
    // A merged pure hunk is drawn as whole block-level elements by `applyMergedBlock`.
    .filter(([index]) => !mergedHunks.has(index))
    .map(([index, span]) => ({
      index,
      span,
      ghostLine: ghostLineOf(index),
      freshEls: elementsIn(fresh.elements, span.new),
      oldEls: elementsIn(baseline.elements, span.old),
    }))

  // Which blocks share one element: those need a single pass over the element (see `mergeSharedElement`).
  const owners = new Map<HTMLElement, Entry[]>()
  for (const entry of entries) {
    for (const element of entry.freshEls) {
      const list = owners.get(element.el) ?? []
      list.push(entry)
      owners.set(element.el, list)
    }
  }
  const shared = [...owners.entries()].filter(([, list]) => list.length > 1)
  for (const [el, list] of shared) {
    const first = list[0]!
    const drawn = mergeSharedElement(el, list.map(entry => ({
      // The unit carries the preview's number; a line block with no units (never in practice) falls back to
      // its own index.
      index: unitsOfBlock.get(entry.index)?.[0]?.index ?? entry.index,
      span: entry.span,
      oldEl: entry.oldEls[0],
    })))
    if (drawn) continue
    // The one element carrying several changes could not be merged: stand the blocks for each side of a unit
    // beside it, so each change keeps its number and its source line on hover.
    for (const unit of unitsOfBlock.get(first.index) ?? []) {
      const blocks = placeholderTwins(
        unit.index,
        unitSourceLines(oldText, first.span.old, unit.oldChars),
        unitSourceLines(newText, first.span.new, unit.newChars),
        grammarOf(unit),
        unit,
      )
      if (el.parentNode !== null) {
        let cursor: Node = el
        for (const block of blocks) {
          el.parentNode.insertBefore(block, cursor.nextSibling)
          cursor = block
        }
      }
    }
  }

  /** Blocks whose whole difference is spelling: they are shown as nothing, and their units stay unreachable. */
  const syntaxBlocks = new Set<number>()
  for (const entry of entries) {
    // An element carrying several blocks was already handled above.
    if (entry.freshEls.length === 1 && (owners.get(entry.freshEls[0]!.el)?.length ?? 0) > 1) continue
    const blockUnits = unitsOfBlock.get(entry.index) ?? []
    const outcome = mergeBlock(fresh.root, entry.freshEls, entry.oldEls, entry.index, blockUnits, entry.ghostLine)
    if (outcome === 'syntax') syntaxBlocks.add(entry.index)
    if (outcome !== 'none') continue
    // Nothing rendered on either side: an HTML comment, a front-matter line. Each UNIT becomes its own blocks,
    // ONE per side — the red block is that side's line(s), the green one the other side's, never one split block
    // joining the two — placed where the block sits, and hovering either shows its own source in the toolbar.
    // Per unit, so two changed lines are two numbered changes; and BOTH sides of a unit are shown whenever that
    // side of the block exists, so an appended value (`title: A` → `title: A v2`) reads as a removed line and an
    // added one, like the source.
    const anchor = entry.freshEls[0]?.el
    for (const unit of blockUnits) {
      const blocks = placeholderTwins(
        unit.index,
        unitSourceLines(oldText, entry.span.old, unit.oldChars),
        unitSourceLines(newText, entry.span.new, unit.newChars),
        grammarOf(unit),
        unit,
      )
      if (anchor !== undefined) {
        let cursor: Node = anchor
        for (const block of blocks) {
          anchor.parentNode?.insertBefore(block, cursor.nextSibling)
          cursor = block
        }
      } else {
        for (const block of blocks) insertCardInSourceOrder(fresh.root, block, unitInsertSpan(unit, entry.span, 'new'))
      }
    }
  }
  // A merged pure hunk: every rendered element the hunk covers is ONE block. An addition is tinted where it
  // draws; a deletion is cloned as a struck ghost at the place the diff puts it. A hunk that renders nothing
  // at all keeps one marker (not one per line) so the block can still be hovered and kept.
  for (const block of previewFileBlocks) {
    if (!block.merged) continue
    applyMergedBlock({
      block,
      freshRoot: fresh.root,
      baselineRoot: baseline.root,
      freshElements: fresh.elements,
      baselineElements: baseline.elements,
      mode: 'single',
      ghostLine: ghostLineOf(block.lineBlock),
    })
  }
  // A unit whose text the document already draws (a paragraph Markdown itself swallowed into a GFM table is
  // the reported case) is a DRAWN change even when the pair merge never tagged it: mark it where it shows
  // instead of letting the reachability net below call it invisible content.
  tagVisibleUnits(fresh.root, renderUnits)
  // Every unit must be REACHABLE. A merge can leave one unplaced on its own — an HTML comment sharing a line
  // block with a deleted paragraph is handled as part of that block's ghost, and its own unit would otherwise
  // have no element at all (hoverable nowhere, never keepable from the preview, while the numbering still
  // counts it). A marker pair at the unit's own lines keeps the numbering honest.
  const untaggedUnits = renderUnits.filter(unit =>
    !syntaxBlocks.has(unit.lineBlock) && fresh.root.querySelector(`[data-md-unit="${unit.index}"]`) === null)
  for (const unit of untaggedUnits) {
    const span = spans.get(unit.lineBlock)
    if (span === undefined) continue
    // Only a side that actually CARRIES this unit's characters is drawn: an inserted word has no old line to
    // show, and a marker for it would name a change the old document does not have.
    const oldLine = unit.oldText === '' ? undefined : unitSourceLines(oldText, span.old, unit.oldChars)
    const newLine = unit.newText === '' ? undefined : unitSourceLines(newText, span.new, unit.newChars)
    if (oldLine === undefined && newLine === undefined) continue
    for (const block of placeholderTwins(unit.index, oldLine, newLine, grammarOf(unit), unit)) {
      insertCardInSourceOrder(fresh.root, block, unitInsertSpan(unit, span, 'new'))
    }
  }
  // The unit markup says WHERE the characters changed; the block markup says which BLOCK the toolbar counts,
  // frames and keeps. Stamp the latter from the same `previewBlocks` the panel numbers, so the two can never
  // disagree.
  applyBlockIndices(fresh.root, blockOfUnit, wholeRowUnits)
  captionHiddenPairs(fresh.root, invisibleLabel)
  return fresh.root.innerHTML
}

/**
 * A top-level rendered block's identity for column alignment.
 *
 * Its tag and text, plus its images' sources (an image block has no text at all): two blocks with the same key
 * are the same part of the document on both sides and share a row.
 *
 * @param block - one top-level rendered block.
 * @returns the key.
 */
function blockKey(block: Element): string {
  const images = [...block.querySelectorAll('img')].map(img => img.getAttribute('src') ?? '').join(',')
  const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim()
  return `${block.tagName}\u0000${text}\u0000${images}`
}

/** One row of the aligned double column: the before side's block, the after side's, or both. */
interface DocumentRow {
  left?: Element | undefined
  right?: Element | undefined
}

/**
 * Put the two documents' top-level blocks on shared rows.
 *
 * The same block (same key) is found in both documents by a longest-common-subsequence walk; the runs between
 * those anchors are paired in order — the k-th changed block of the before side with the k-th of the after
 * side — and whatever is left over stands on its own row. A block that exists on one side ONLY therefore
 * takes a row of its own instead of pushing everything under it out of line with the other column, which is
 * what row alignment means in a rendered document whose row heights come from the content itself.
 *
 * @param left - the before document's top-level blocks.
 * @param right - the after document's top-level blocks.
 * @returns the rows, in document order.
 */
function alignDocumentBlocks(left: readonly Element[], right: readonly Element[]): DocumentRow[] {
  const rows: DocumentRow[] = []
  let leftIndex = 0
  let rightIndex = 0
  let pendingLeft: number[] = []
  let pendingRight: number[] = []
  const flush = (): void => {
    const pairs = Math.min(pendingLeft.length, pendingRight.length)
    for (let step = 0; step < pairs; step++) {
      rows.push({ left: left[pendingLeft[step]!], right: right[pendingRight[step]!] })
    }
    for (let step = pairs; step < pendingLeft.length; step++) rows.push({ left: left[pendingLeft[step]!] })
    for (let step = pairs; step < pendingRight.length; step++) rows.push({ right: right[pendingRight[step]!] })
    pendingLeft = []
    pendingRight = []
  }
  for (const part of diffArrays(left.map(blockKey), right.map(blockKey))) {
    const length = part.value.length
    if (part.removed) {
      for (let step = 0; step < length; step++) pendingLeft.push(leftIndex + step)
      leftIndex += length
      continue
    }
    if (part.added) {
      for (let step = 0; step < length; step++) pendingRight.push(rightIndex + step)
      rightIndex += length
      continue
    }
    flush()
    for (let step = 0; step < length; step++) {
      rows.push({ left: left[leftIndex + step], right: right[rightIndex + step] })
    }
    leftIndex += length
    rightIndex += length
  }
  flush()
  return rows
}

/**
 * The blocks the aligned double column lays one document out as, in reading order.
 *
 * A list is split into ONE UNIT PER ITEM, each wrapped in a copy of its own list element (tag and attributes
 * kept, so the marker and indent still render). A changed item grows taller in one column, and if the whole
 * list were one row that growth would push every later item out of line with its counterpart; per-item rows
 * leave the rest of the list aligned. Other blocks stay whole.
 *
 * @param root - one document's rendered root.
 * @returns its layout units.
 */
function layoutUnits(root: HTMLElement): HTMLElement[] {
  const units: HTMLElement[] = []
  for (const child of [...root.children] as HTMLElement[]) {
    if (child.tagName !== 'UL' && child.tagName !== 'OL') {
      units.push(child)
      continue
    }
    if (![...child.children].every(item => item.tagName === 'LI')) {
      units.push(child)
      continue
    }
    for (const item of [...child.children] as HTMLElement[]) {
      const list = child.cloneNode(false) as HTMLElement
      list.appendChild(item)
      units.push(list)
    }
  }
  return units
}

/**
 * Draw the two documents as ONE grid, row by row (see `alignDocumentBlocks`).
 *
 * The `.mdDoubleCol` wrappers stay — the styles, the tests and the panel read them as the two sides — but
 * they are `display: contents`, so the row cells are the grid's items: a row is as tall as its taller side and
 * the next row begins on the same line in both columns.
 *
 * @param baseline - the before document's rendered root.
 * @param fresh - the after document's rendered root.
 * @returns sanitized HTML for the preview body.
 */
function renderAlignedDocuments(baseline: HTMLElement, fresh: HTMLElement): string {
  const rows = alignDocumentBlocks(layoutUnits(baseline), layoutUnits(fresh))
  const oldCells: string[] = []
  const newCells: string[] = []
  rows.forEach((row, index) => {
    // Both cells of a row always exist: an empty one keeps the divider continuous and leaves the row's height
    // to the side that has something in it.
    const gridRow = `grid-row: ${index + 1}`
    const oldContent = row.left === undefined ? '' : row.left.outerHTML
    const newContent = row.right === undefined ? '' : row.right.outerHTML
    oldCells.push(`<div class="mdDoubleCell mdDoubleCellOld" style="${gridRow}; grid-column: 1">${oldContent}</div>`)
    newCells.push(`<div class="mdDoubleCell mdDoubleCellNew" style="${gridRow}; grid-column: 2">${newContent}</div>`)
  })
  return `<div class="mdDouble mdDoubleDocs"><div class="mdDoubleCol" data-diff-doc-side="old">${oldCells.join('')}</div><div class="mdDoubleCol" data-diff-doc-side="new">${newCells.join('')}</div></div>`
}

/**
 * The double column under the structure style: the OLD document and the NEW document, each rendered whole
 * and tinted where its own change blocks sit. Nothing is re-aligned or re-parsed, so each side reads as the
 * document it is.
 *
 * @param oldText - the baseline.
 * @param newText - the current content.
 * @returns sanitized HTML for the preview body.
 */
function renderDocuments(oldText: string, newText: string, invisibleLabel?: string): string {
  const diff = computeDiffOf(oldText, newText)
  const spans = blockSpans(diff)
  /** The preview's difference blocks (see `previewBlocks`): the same numbering the single column uses. */
  const previewFileBlocks = previewBlocks(oldText, newText)
  const { blockOfUnit, wholeRowUnits } = blockMapsOf(previewFileBlocks)
  const mergedHunks = new Set(previewFileBlocks.filter(block => block.merged).map(block => block.lineBlock))
  const units = previewFileBlocks.flatMap(block => block.units)
  const renderUnits = units.filter(unit => !mergedHunks.has(unit.lineBlock))
  const oldFrontMatter = frontMatterLineCount(oldText)
  const newFrontMatter = frontMatterLineCount(newText)
  /** A no-rendering block's source is YAML when it is front matter, Markdown otherwise. */
  const grammarOf = (unit: PreviewUnit): SourceGrammar =>
    unit.oldLines.start <= oldFrontMatter || unit.newLines.start <= newFrontMatter ? 'yaml' : 'markdown'
  /** The units cut from one source-line block, in order. */
  const unitsOfBlock = new Map<number, PreviewUnit[]>()
  for (const unit of renderUnits) {
    const list = unitsOfBlock.get(unit.lineBlock) ?? []
    list.push(unit)
    unitsOfBlock.set(unit.lineBlock, list)
  }
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  /** Blocks whose whole difference is spelling: they are shown as nothing, and their units stay unreachable. */
  const syntaxBlocks = new Set<number>()
  for (const [index, span] of [...spans.entries()].sort((left, right) => left[0] - right[0])) {
    // A merged pure hunk is one block, drawn whole by `applyMergedBlock` below.
    if (mergedHunks.has(index)) continue
    const freshElements = elementsIn(fresh.elements, span.new)
    const oldElements = elementsIn(baseline.elements, span.old)
    const blockUnits = unitsOfBlock.get(index) ?? []
    // The preview numbers UNITS here too: one source line can hold two changes, and each keeps its number.
    const primary = blockUnits[0]?.index ?? index
    const pairs = Math.min(freshElements.length, oldElements.length)
    for (let step = 0; step < pairs; step++) {
      const next = freshElements[step]
      const previous = oldElements[step]
      if (next === undefined || previous === undefined) continue
      // A pair that says the same thing is not a change this view can show by tinting: make it visible as
      // the SOURCE it changed, in the column that side belongs to — red for the removed line on the left,
      // green for the added one on the right — so the toolbar's count means the same in both layouts. A
      // pure-syntax edit (same shell) is left alone.
      const before = previous.el.dataset.srcText
      const after = next.el.dataset.srcText
      const shellChanged = structureFingerprint(next.el) !== structureFingerprint(previous.el)
      if (shownText(next.el) === shownText(previous.el)) {
        // In the double column each side keeps its own box: tint the BOX there, not the item — a ticked task
        // is a change of the checkbox, and the rest of the line did not change.
        if (checkboxPair(previous.el, next.el) !== undefined) {
          const boxUnit = unitIndexForText(blockUnits, 'x', 'add') ?? primary
          markCheckboxSide(previous.el, boxUnit, 'del')
          markCheckboxSide(next.el, boxUnit, 'add')
          continue
        }
        if ((before ?? '') !== (after ?? '') && shellChanged) {
          // Each column shows ITS OWN side — the old tinted red on the left, the new tinted green on the
          // right — and the source difference behind the change rides on it for the toolbar's hover row. The
          // pair's own visits name their units first, so an attribute change with the same reading as a text
          // change does not steal its unit.
          const taken = takenUnits(previous.el, next.el)
          for (const [oldEl, newEl] of changedElementPairs(previous.el, next.el, true)) {
            const unit = unitIndexForShell(blockUnits, oldEl, newEl, taken) ?? primary
            taken.add(unit)
            const hidden = hasHiddenDiff(oldEl, newEl)
            if (isAttached(oldEl)) sideTwin(oldEl, 'old', unit, hidden)
            if (isAttached(newEl)) sideTwin(newEl, 'new', unit, hidden)
          }
          continue
        }
        if ((before ?? '') !== (after ?? '') && shownText(next.el) === '') {
          // Two spellings of an element that draws NO characters at all — `---` and `***` both draw a rule:
          // there is nothing to tint, so each column reports its own side as an invisible-content block, in
          // source order. Left unhandled this change would vanish from the preview (the reported `---`→`***`).
          for (const unit of blockUnits) {
            const oldLine = unit.oldText === '' ? undefined : unitSourceLines(oldText, span.old, unit.oldChars)
            const newLine = unit.newText === '' ? undefined : unitSourceLines(newText, span.new, unit.newChars)
            if (oldLine !== undefined) {
              insertCardInSourceOrder(baseline.root, placeholderTwin(unit.index, oldLine, undefined, grammarOf(unit), unit), unitInsertSpan(unit, span, 'old'), 'old')
            }
            if (newLine !== undefined) {
              insertCardInSourceOrder(fresh.root, placeholderTwin(unit.index, undefined, newLine, grammarOf(unit), unit), unitInsertSpan(unit, span, 'new'), 'new')
            }
          }
          continue
        }
        if ((before ?? '') !== (after ?? '')) {
          // A re-spelled inline STYLE (`**加粗**` → `__加粗__`): each column tints ITS OWN version of that
          // element — red in the old column, green in the new — so the two styles can be compared.
          const stylePairs = inlineStylePairs(previous.el, next.el, blockUnits)
          if (stylePairs.length > 0) {
            for (const [oldEl, newEl, unit] of stylePairs) {
              if (isAttached(oldEl)) sideTwin(oldEl, 'old', unit, false)
              if (isAttached(newEl)) sideTwin(newEl, 'new', unit, false)
            }
            continue
          }
        }
        // Same text, same shell: a pure SPELLING difference. Left alone, like the single column.
        syntaxBlocks.add(index)
        continue
      }
      // Which descendants carry a shell change, measured before the runs are drawn (drawing them re-writes
      // an element's innerHTML when it has no element children, which would drop the node being measured).
      const shellPairs = shellChanged ? changedElementPairs(previous.el, next.el, false) : []
      if (next.el.tagName !== previous.el.tagName) {
        // Different elements cannot be compared character by character: each side stands as a whole block in
        // its own column.
        markChangedUnit(next.el, unitIndexForElement(blockUnits, next.el, 'add') ?? primary, 'add')
        markChangedUnit(previous.el, unitIndexForElement(blockUnits, previous.el, 'del') ?? primary, 'del')
        continue
      }
      // The change is the CHANGED CHARACTERS of this element's own line, not a wash over the whole block: an
      // item whose word changed case shows just that word, in the same strong word highlight the single
      // column uses. The element's own text is what is diffed; nested structure (a list inside the item) is
      // paired separately, and its changes are drawn there.
      const oldOwnText = ownTextOf(previous.el)
      const newOwnText = ownTextOf(next.el)
      const runs = oldOwnText === newOwnText ? undefined : intraRunsOf(oldOwnText, newOwnText)
      if (runs === undefined) {
        // No comparable own-text edit (a rewrite, or a change that lives entirely in a descendant): the
        // element itself is the change, in its own column — unless nothing changed in it at all. The element's
        // OWN source picks the unit (`OldRow`→`NewRow` is a rewrite it cannot diff word by word): marking it
        // with the block's first unit instead would nest the real unit inside it.
        if (oldOwnText === newOwnText && !shellChanged) continue
        markChangedUnit(next.el, unitIndexForElement(blockUnits, next.el, 'add') ?? primary, 'add')
        markChangedUnit(previous.el, unitIndexForElement(blockUnits, previous.el, 'del') ?? primary, 'del')
        continue
      }
      // Each column highlights ITS OWN changed characters; the unchanged text is left alone.
      if (next.el.children.length === 0 && previous.el.children.length === 0) {
        next.el.innerHTML = wrapChanged(runs.add, 'add')
        previous.el.innerHTML = wrapChanged(runs.del, 'del')
      } else {
        wrapOwnChangedRuns(previous.el, runs.del, 'mdWordDel')
        wrapOwnChangedRuns(next.el, runs.add, 'mdWordAdd')
      }
      // …and each drawn run names its OWN unit, so two changes on one line stay two numbers.
      tagRuns(next.el, blockUnits, primary)
      tagRuns(previous.el, blockUnits, primary)
      // A descendant's own attributes (a link's target beside a reworded sentence) get their side's twin
      // treatment, with the whole source of that side on hover. The runs above already claimed their units, so
      // each attribute takes a unit that is still free (the rich fixture's link: text `old`→`new` AND
      // target `old`→`new` are two changes that read the same).
      const taken = takenUnits(next.el, previous.el)
      for (const [oldEl, newEl] of shellPairs) {
        const unit = unitIndexForShell(blockUnits, oldEl, newEl, taken) ?? primary
        taken.add(unit)
        const hidden = hasHiddenDiff(oldEl, newEl)
        if (isAttached(oldEl)) sideTwin(oldEl, 'old', unit, hidden)
        if (isAttached(newEl)) sideTwin(newEl, 'new', unit, hidden)
      }
    }
    for (let step = pairs; step < oldElements.length; step++) {
      const previous = oldElements[step]
      if (previous === undefined) continue
      // Multi-unit element: its own units are tagged where the text sits; marking the element would nest them.
      if (crossingUnits(blockUnits, previous.el, 'del').length > 1) continue
      markChangedUnit(previous.el, unitIndexForElement(blockUnits, previous.el, 'del') ?? primary, 'del')
    }
    for (let step = pairs; step < freshElements.length; step++) {
      const next = freshElements[step]
      if (next === undefined) continue
      if (crossingUnits(blockUnits, next.el, 'add').length > 1) continue
      markChangedUnit(next.el, unitIndexForElement(blockUnits, next.el, 'add') ?? primary, 'add')
    }
    // A block that renders to nothing (front matter, an HTML comment) must still be reachable in BOTH
    // columns: one modest block per unit on each side — the before column's own line(s) and the after
    // column's — with the changed source carried for the toolbar's hover row.
    if (freshElements.length === 0 && oldElements.length === 0) {
      for (const unit of blockUnits) {
        const oldLine = unitSourceLines(oldText, span.old, unit.oldChars)
        const newLine = unitSourceLines(newText, span.new, unit.newChars)
        const grammar = grammarOf(unit)
        insertCardInSourceOrder(baseline.root, placeholderTwin(unit.index, oldLine, undefined, grammar, unit), unitInsertSpan(unit, span, 'old'), 'old')
        insertCardInSourceOrder(fresh.root, placeholderTwin(unit.index, undefined, newLine, grammar, unit), unitInsertSpan(unit, span, 'new'), 'new')
      }
    }
  }
  // A merged pure hunk is ONE block drawn whole, on whichever side it exists: the added document's elements
  // are tinted in the after column, the deleted ones in the before column, and a hunk that renders nothing
  // gets one marker in its own column.
  for (const block of previewFileBlocks) {
    if (!block.merged) continue
    applyMergedBlock({
      block,
      freshRoot: fresh.root,
      baselineRoot: baseline.root,
      freshElements: fresh.elements,
      baselineElements: baseline.elements,
      mode: 'double',
      ghostLine: undefined,
    })
  }
  // The same REACHABILITY net as the single column, per side: a unit with no element in a column (an HTML
  // comment sharing a line block with a deleted paragraph) gets its marker in that column, so every number is
  // hoverable and keepable in the double view too.
  const ensureReachable = (root: HTMLElement, side: 'old' | 'new'): void => {
    for (const unit of renderUnits) {
      if (syntaxBlocks.has(unit.lineBlock)) continue
      if (root.querySelector(`[data-md-unit="${unit.index}"]`) !== null) continue
      const span = spans.get(unit.lineBlock)
      if (span === undefined) continue
      const grammar = grammarOf(unit)
      // A side only gets a marker when it actually carries the unit's characters: an inserted run has no old
      // line, and a marker there would be a row the old document does not have — it would also break the two
      // columns' block order (and with it every later row's alignment).
      if (side === 'old') {
        if (unit.oldText === '') continue
        const line = unitSourceLines(oldText, span.old, unit.oldChars)
        if (line === undefined) continue
        insertCardInSourceOrder(root, placeholderTwin(unit.index, line, undefined, grammar, unit), unitInsertSpan(unit, span, 'old'), 'old')
      } else {
        if (unit.newText === '') continue
        const line = unitSourceLines(newText, span.new, unit.newChars)
        if (line === undefined) continue
        insertCardInSourceOrder(root, placeholderTwin(unit.index, undefined, line, grammar, unit), unitInsertSpan(unit, span, 'new'), 'new')
      }
    }
  }
  // Same as the single column: a unit the document already draws is marked where it shows, per side, and
  // only the genuinely invisible ones reach the reachability net below.
  tagVisibleUnits(baseline.root, renderUnits, 'old')
  tagVisibleUnits(fresh.root, renderUnits, 'new')
  ensureReachable(baseline.root, 'old')
  ensureReachable(fresh.root, 'new')
  // Stamp the block each unit belongs to (and each table row's block), exactly as the single column does.
  applyBlockIndices(baseline.root, blockOfUnit, wholeRowUnits)
  applyBlockIndices(fresh.root, blockOfUnit, wholeRowUnits)
  captionHiddenPairs(baseline.root, invisibleLabel)
  captionHiddenPairs(fresh.root, invisibleLabel)
  return renderAlignedDocuments(baseline.root, fresh.root)
}

/* ============================== entry point ============================== */

/**
 * Write the caption that says what a pair of no-rendering blocks is.
 *
 * A pair of tiny tinted squares is the change the rendering cannot show; without a word beside it the reader
 * has to hover to find out. The caption is localization, so it comes from the caller — the renderer itself
 * has no translator (and the unit tests want none).
 *
 * @param root - the rendered document whose pairs get the caption.
 * @param label - the caption, or undefined to leave the pairs bare.
 */
/**
 * The eye-with-a-slash that says "this change has no rendering of its own".
 *
 * The marker used to carry the words "invisible content"; the icon says the same in a square that sits in the
 * reading line like the image twin's frame does (same dashed edge, same radius — see the stylesheet), and the
 * caller's words move to the marker's accessible name (`aria-label`, and `title` for the pointer).
 *
 * @param label - the caller's words for the marker, when there are any.
 * @returns the icon element.
 */
function invisibleContentIcon(label: string | undefined): HTMLElement {
  const holder = document.createElement('span')
  holder.className = 'mdTwinCaption'
  holder.setAttribute('data-md-twin-caption', '')
  if (label === undefined || label === '') {
    holder.setAttribute('aria-hidden', 'true')
  } else {
    holder.setAttribute('role', 'img')
    holder.setAttribute('aria-label', label)
    holder.setAttribute('title', label)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const eye = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  eye.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z')
  const pupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  pupil.setAttribute('cx', '12')
  pupil.setAttribute('cy', '12')
  pupil.setAttribute('r', '3')
  const slash = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  slash.setAttribute('d', 'm3 3 18 18')
  svg.append(eye, pupil, slash)
  holder.append(svg)
  return holder
}

/** Put the invisible-change icon in every no-rendering marker, naming it with the caller's words when given. */
function captionHiddenPairs(root: HTMLElement, label: string | undefined): void {
  for (const pair of root.querySelectorAll<HTMLElement>('.mdTwinPhantom')) {
    pair.append(invisibleContentIcon(label))
    if (label !== undefined && label !== '') pair.setAttribute('title', label)
  }
}

/**
 * Render the Markdown preview as sanitized HTML.
 * @param oldText - the file's tracked baseline (rendered as "before").
 * @param newText - the file's current content.
 * @param mode - 'single' merges both sides into one reading of the document; 'double' shows the before and
 *   after renderings as two whole documents.
 * @param style - 'structure' (default) renders each document once and maps the diff onto its elements;
 *   'blocks' is the original fragment-per-run renderer, kept behind the setting.
 * @param labels - user-facing words the rendered markup must carry (none by default; the tests render bare).
 * @returns sanitized HTML for the preview body. Local images keep their src so a later pass can resolve
 *   them to data URIs (see the preview image resolver).
 */
export function renderMarkdownPreview(
  oldText: string,
  newText: string,
  mode: 'single' | 'double',
  style: MarkdownPreviewStyle = 'structure',
  labels?: { readonly invisible?: string },
): string {
  if (style === 'structure') {
    // The tree-first path is being brought up beside the line-hunk one; the setting opts in (default: old path).
    if (treeDiffEnabled()) {
      return mode === 'single'
        ? renderTreeMerged(oldText, newText, labels)
        : renderTreeDocuments(oldText, newText, labels)
    }
    return mode === 'single' ? renderMerged(oldText, newText, labels?.invisible) : renderDocuments(oldText, newText, labels?.invisible)
  }
  if (mode === 'single') {
    const runs = diffRuns(oldText, newText)
    return runs.map(renderBlock).join('')
  }
  const rows = alignedDoubleRows(diffRuns(oldText, newText))
  return `<div class="mdDouble">${rows.map(renderDoubleRow).join('')}</div>`
}

/* ========================== tree-first renderer ========================== */

/** Which element tags can carry one tree node type (a change maps back to the element it renders as). */
const TREE_TAGS: Record<string, readonly string[]> = {
  paragraph: ['P'],
  heading: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'],
  list: ['UL', 'OL'],
  list_item: ['LI'],
  table: ['TABLE'],
  table_row: ['TR'],
  table_cell: ['TD', 'TH'],
  code: ['CODE'],
  hr: ['HR'],
  blockquote: ['BLOCKQUOTE'],
  html: ['DIV', 'P', 'SPAN', 'PRE', 'HR', 'BLOCKQUOTE', 'TABLE'],
}

/** Unique elements, in document order. */
function uniqueElements(elements: readonly HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const element of elements) if (!out.includes(element)) out.push(element)
  return out
}

/**
 * The rendered elements one tree node stands for, in the tree-first renderer.
 *
 * The annotated renderer already stamps every top-level element AND the nested carriers a change can land on
 * (list items, table rows, table cells, code content) with their source line span, so a node is found by its
 * span first, then by containment (a paragraph inside a blockquote is stamped with its quote's span).
 *
 * @param doc - one rendered document.
 * @param node - the tree node.
 * @returns its elements, empty when the node renders nothing.
 */
function treeNodeElements(doc: RenderedDoc, node: MarkdownTreeNode): HTMLElement[] {
  const start = node.lines.start - 1
  const end = node.lines.end - 1
  const wanted = TREE_TAGS[node.type]
  const tagOk = (element: HTMLElement): boolean => wanted === undefined || wanted.includes(element.tagName)
  // A table row has no entry of its own in `elements` (its cells are the leaves): resolve it through the row's
  // cells, which ARE stamped with the row's line.
  if (node.type === 'table_row') {
    const cell = doc.elements.find(entry => entry.start <= start && entry.end >= end)
    const row = cell?.el.closest('tr')
    if (row instanceof HTMLElement) return [row]
    return []
  }
  // Several table cells share one line: a cell node is identified by its OWN source slice, not by the line alone.
  if (node.type === 'table_cell') {
    const cells = doc.elements.filter(entry => entry.start <= start && entry.end >= end && tagOk(entry.el))
    const text = node.text.trim()
    const byText = cells.filter(entry => (entry.el.dataset.srcText ?? '').trim() === text)
    if (byText.length > 0) return uniqueElements(byText.map(entry => entry.el))
    return uniqueElements(cells.slice(0, 1).map(entry => entry.el))
  }
  // A list item that CONTAINS a nested list covers more lines than the LI itself is stamped with: the parent
  // item's own marker line is the start, and its nested items are leaves of their own.
  if (node.type === 'list_item') {
    const items = doc.elements
      .filter(entry => entry.el.tagName === 'LI' && entry.start <= end && entry.end >= start)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))
    const own = items.find(entry => entry.start === start) ?? items[0]
    if (own !== undefined) return [own.el]
  }
  const exact = doc.elements.filter(entry => entry.start === start && entry.end === end && tagOk(entry.el))
  if (exact.length > 0) return uniqueElements(exact.map(entry => entry.el))
  const inside = doc.elements
    .filter(entry => entry.start <= start && entry.end >= end && tagOk(entry.el))
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))
  if (inside.length > 0) return uniqueElements(inside.map(entry => entry.el))
  const stamped = [...doc.root.children]
    .filter((node2): node2 is HTMLElement => node2 instanceof HTMLElement)
    .filter(element => {
      const span = sourceSpanOf(element)
      return span !== undefined && span.start === start && span.end === end && tagOk(element)
    })
  if (stamped.length > 0) return stamped
  // Containers (table/list/quote) have no element of their own in `elements`: resolve through a descendant.
  const descendant = doc.elements.find(entry => entry.start <= start && entry.end >= end)?.el
  if (descendant !== undefined) {
    if (node.type === 'table') {
      const table = descendant.closest('table')
      if (table instanceof HTMLElement) return [table]
    }
    if (node.type === 'list') {
      const list = descendant.closest('ul, ol')
      if (list instanceof HTMLElement) return [list]
    }
    if (node.type === 'blockquote') {
      const quote = descendant.closest('blockquote')
      if (quote instanceof HTMLElement) return [quote]
    }
  }
  return []
}

/** The elements of every node in one block, in node order (one side's document). */
function treeBlockElements(block: TreePreviewBlock, doc: RenderedDoc, side: 'old' | 'new'): HTMLElement[] {
  const nodes = side === 'new' ? block.newNodes : block.oldNodes
  return uniqueElements(nodes.flatMap(node => treeNodeElements(doc, node)))
}

/** A struck/side tinted CLONE of one rendered element, stripped of the other side's unit marks. */
function treeGhostOf(element: HTMLElement, block: TreePreviewBlock, side: 'old' | 'new'): HTMLElement {
  const ghost = element.cloneNode(true) as HTMLElement
  for (const marked of [ghost, ...ghost.querySelectorAll<HTMLElement>('[data-md-unit], [data-md-block]')]) {
    marked.removeAttribute('data-md-unit')
    marked.removeAttribute('data-md-kind')
    marked.removeAttribute('data-md-block')
    marked.removeAttribute('data-md-whole-row')
    marked.classList.remove('mdAdd', 'mdDel', 'mdWordAdd', 'mdWordDel')
  }
  markChangedBlock(ghost, block.index, side === 'old' ? 'del' : 'add')
  return ghost
}

/** Put a deletion's ghost where the block's new-side insertion point says it belongs. */
function treeInsertGhost(block: TreePreviewBlock, baselineElement: HTMLElement, freshRoot: HTMLElement): void {
  const ghost = treeGhostOf(baselineElement, block, 'old')
  const line = Math.max(0, block.newStart - 1)
  const container = baselineElement.tagName === 'TR'
    ? 'table'
    : baselineElement.tagName === 'LI'
      ? 'ul, ol'
      : undefined
  if (container !== undefined) {
    insertGhostHost(freshRoot, baselineElement, ghost, line)
    return
  }
  const anchor = insertionPointFor(freshRoot, line)
  anchor.parent.insertBefore(ghost, anchor.before)
}

/** Draw a replacement fallback: old side as a struck ghost, new side tinted whole. */
function treeReplacement(block: TreePreviewBlock, freshElements: readonly HTMLElement[], oldElements: readonly HTMLElement[], freshRoot: HTMLElement): void {
  for (const element of oldElements) {
    const ghost = treeGhostOf(element, block, 'old')
    const next = freshElements[0]
    if (next !== undefined && next.parentNode !== null) {
      next.parentNode.insertBefore(ghost, next)
      continue
    }
    treeInsertGhost(block, element, freshRoot)
  }
  for (const element of freshElements) markChangedBlock(element, block.index, 'add')
}

/** Draw one invisible change as the source markers of both sides, at its document position. */
function treeInvisibleBlock(block: TreePreviewBlock, freshRoot: HTMLElement): void {
  const diff = block.invisible[0]
  if (diff === undefined) return
  // The new side's position is the insertion point even for a pure deletion (its range is empty there): using
  // the OLD line for a deleted definition put its marker rows at the wrong place in the new document.
  const line = block.newStart >= 1 ? block.newStart : block.oldStart
  const chips = placeholderTwins(block.index, diff.oldText, diff.newText, diff.grammar)
  for (const chip of chips) {
    const side = chip.dataset.mdKind === 'del' ? 'del' : 'add'
    stampBlock(chip, block.index, side)
  }
  const anchor = insertionPointFor(freshRoot, Math.max(0, line - 1))
  for (const chip of chips) anchor.parent.insertBefore(chip, anchor.before)
}

/**
 * The TD elements a `table_cell` block covers, one per side.
 *
 * The cell node identifies its own source slice, but several cells share a source LINE; the model stores the
 * cell's COLUMN as well, so the renderer marks exactly that column of the row its cell resolved in.
 *
 * @param block - the cell block.
 * @param freshElements - the new document's element(s) for the node.
 * @param oldElements - the old document's element(s) for the node.
 * @returns the new/old cell elements, when rendered.
 */
function tableCellElements(
  block: TreePreviewBlock,
  freshElements: readonly HTMLElement[],
  oldElements: readonly HTMLElement[],
): { next: HTMLElement | undefined; previous: HTMLElement | undefined } {
  const column = block.cellColumn
  const pick = (elements: readonly HTMLElement[]): HTMLElement | undefined => {
    const first = elements[0]
    if (first === undefined) return undefined
    const row = first.tagName === 'TR' ? first : first.closest('tr')
    if (row !== null && column !== undefined) {
      const cell = row.children[column]
      if (cell instanceof HTMLElement) return cell
    }
    return first
  }
  return { next: pick(freshElements), previous: pick(oldElements) }
}

/** Draw a table row edit: per-cell character marks on the row, the row itself carrying the block number. */
function treeTableRowBlock(block: TreePreviewBlock, freshElements: readonly HTMLElement[], oldElements: readonly HTMLElement[]): boolean {
  const newRow = freshElements.find(element => element.tagName === 'TR')
    ?? freshElements.find(element => element.closest('tr') !== null)?.closest('tr')
  if (!(newRow instanceof HTMLElement)) return false
  const oldRow = oldElements.find(element => element.tagName === 'TR')
    ?? oldElements.find(element => element.closest('tr') !== null)?.closest('tr')
  const newCells = [...newRow.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
  const oldCells = oldRow instanceof HTMLElement
    ? [...oldRow.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
    : []
  // The cell element pairs are read before the text merges (the merges split text nodes).
  const rowPairs = oldRow instanceof HTMLElement ? changedElementPairs(oldRow, newRow, false) : []
  let unitAt = 0
  const drawnUnits = new Set<number>()
  const pairs = Math.min(newCells.length, oldCells.length)
  for (let index = 0; index < pairs; index++) {
    const nextCell = newCells[index]!
    const oldCell = oldCells[index]!
    if (shownText(nextCell) === shownText(oldCell)) continue
    if (mergeInlineText(nextCell, oldCell)) {
      const unit = block.units[unitAt] ?? block.units[0]
      if (unit !== undefined) {
        markUnit(nextCell, unit.index, 'add')
        drawnUnits.add(unit.index)
      }
      unitAt++
      continue
    }
    const unit = block.units[unitAt] ?? block.units[0]
    if (unit !== undefined) {
      markChangedUnit(nextCell, unit.index, 'add')
      drawnUnits.add(unit.index)
    }
    unitAt++
  }
  // A header-row block carries only the changed cells in its nodes (a partial header): mark those cells too.
  for (const cellNode of block.newNodes.filter(node => node.type === 'table_cell')) {
    const cell = newCells.find(candidate => {
      const span = sourceSpanOf(candidate)
      return span !== undefined && span.start === cellNode.lines.start - 1 && span.end === cellNode.lines.end - 1
    })
    if (cell === undefined) continue
    if (cell.dataset.mdUnit !== undefined) continue
    const unit = block.units[unitAt] ?? block.units[0]
    if (unit !== undefined) {
      markUnit(cell, unit.index, 'add')
      drawnUnits.add(unit.index)
    }
    unitAt++
  }
  // The remaining changes of the row are INVISIBLE inline ones (a retargeted link in a cell): red/green twins
  // inside the cell, with their own source for the toolbar. A row is still ONE block (rule A), so each twin
  // carries the row's block number.
  const twinUnits = block.units
    .filter(unit => !drawnUnits.has(unit.index))
    .map(unit => ({ blockIndex: block.index, unit }))
  if (twinUnits.length > 0 && oldRow instanceof HTMLElement) twinHiddenInlineUnits(twinUnits, oldRow, newRow, rowPairs)
  stampBlock(newRow, block.index, 'add')
  return true
}

/** Draw an edit of a paragraph/heading/list item (and similar block nodes): inline character runs when possible. */
function treeInlineBlock(block: TreePreviewBlock, freshElements: readonly HTMLElement[], oldElements: readonly HTMLElement[], freshRoot: HTMLElement): void {
  const next = freshElements[0]
  const previous = oldElements[0]
  if (next !== undefined && previous !== undefined && next.tagName === previous.tagName && mergeInlineText(next, previous)) {
    stampBlock(next, block.index, 'add')
    const unit = block.units[0]
    if (unit !== undefined) markUnit(next, unit.index, 'add')
    // The merge drew character runs: this block is visible as a modification (word marks inside the element).
    if (next.querySelector('.mdWordAdd, .mdWordDel') !== null) return
  }
  treeReplacement(block, freshElements, oldElements, freshRoot)
}

/** Draw a code fence edit: changed code text merged in the CODE element, else a whole-fence replacement. */
function treeCodeBlock(block: TreePreviewBlock, freshElements: readonly HTMLElement[], oldElements: readonly HTMLElement[], freshRoot: HTMLElement): void {
  const next = freshElements[0]
  const previous = oldElements[0]
  if (next === undefined || previous === undefined) {
    treeReplacement(block, freshElements, oldElements, freshRoot)
    return
  }
  const nextText = (next.textContent ?? '').replace(/\s+/g, ' ').trim()
  const previousText = (previous.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (nextText === previousText) {
    // The language or fence spelling changed while the code reads the same: show both whole versions.
    const host = next.parentElement?.tagName === 'PRE' ? next.parentElement : next
    const oldHost = previous.parentElement?.tagName === 'PRE' ? previous.parentElement : previous
    const ghost = treeGhostOf(oldHost, block, 'old')
    if (host.parentNode !== null) host.parentNode.insertBefore(ghost, host)
    markChangedBlock(host, block.index, 'add')
    return
  }
  if (mergeInlineText(next, previous)) {
    stampBlock(next, block.index, 'add')
    const unit = block.units[0]
    if (unit !== undefined) markUnit(next, unit.index, 'add')
    return
  }
  treeReplacement(block, freshElements, oldElements, freshRoot)
}

/** Whether a block is ONE inline change of a paragraph/heading/list item (its frame is its characters). */
function isInlineUnitBlock(block: TreePreviewBlock): boolean {
  return (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'list_item')
    && block.merged === false
    && block.units.length >= 1
    && block.oldNodes.length === 1
    && block.newNodes.length === 1
    && block.invisible.length === 0
}

/** The end (exclusive) of the consecutive inline-unit blocks sharing one rendered node pair. */
function inlineUnitGroupEnd(blocks: readonly TreePreviewBlock[], start: number): number {
  const first = blocks[start]!
  let end = start + 1
  while (end < blocks.length) {
    const next = blocks[end]!
    if (!isInlineUnitBlock(next)) break
    if (next.oldNodes[0] !== first.oldNodes[0] || next.newNodes[0] !== first.newNodes[0]) break
    end++
  }
  return end
}

/** Stamp one drawn word-run element with its UNIT and BLOCK, so hover/keep name the change it draws. */
function stampInlineRun(element: HTMLElement, block: TreePreviewBlock, unitIndex: number, kind: 'add' | 'del'): void {
  element.dataset.mdUnit = String(unitIndex)
  element.dataset.mdBlock = String(block.index)
  element.dataset.mdKind = kind
}

/**
 * Attribute the word runs `mergeInlineText` drew to their blocks/units, in reading order.
 *
 * One group can hold several changes of the same paragraph; each unit's `oldText`/`newText` is exactly what the
 * drawn del/add spans carry, so the spans are matched in order and stamped.
 *
 * @param element - the merged element (the new side).
 * @param blocks - the group's single-unit blocks, in order.
 * @param wordClass - which span class this side's runs use.
 * @returns the blocks whose runs were found and stamped.
 */
function tagInlineRuns(element: HTMLElement, blocks: readonly TreePreviewBlock[], wordClass: 'mdWordAdd' | 'mdWordDel'): Set<number> {
  const runs = [...element.querySelectorAll<HTMLElement>(`.${wordClass}`)]
  const used = new Set<HTMLElement>()
  const matched = new Set<number>()
  const side: 'add' | 'del' = wordClass === 'mdWordAdd' ? 'add' : 'del'
  for (const block of blocks) {
    const unit = block.units[0]!
    const text = side === 'add' ? unit.newText : unit.oldText
    if (text === '') continue
    const run = runs.find(candidate => !used.has(candidate) && (candidate.textContent ?? '') === text)
      ?? runs.find(candidate => !used.has(candidate) && text.trim() !== '' && (candidate.textContent ?? '').includes(text.trim()))
    if (run === undefined) continue
    used.add(run)
    stampInlineRun(run, block, unit.index, side)
    matched.add(block.index)
  }
  return matched
}

/** Whether an inline element pair's own Markdown source is the text this unit's change is about. */
function inlinePairMatchesUnit(unit: { oldText: string; newText: string }, oldElement: HTMLElement, newElement: HTMLElement): boolean {
  const oldSource = sourceOfElement(oldElement)
  const newSource = sourceOfElement(newElement)
  const same = (a: string, b: string): boolean => a === b || a.includes(b) || b.includes(a)
  if (same(unit.oldText, oldSource) || same(unit.newText, newSource)) return true
  // A link/destination change can leave the ELEMENT's rendered text unchanged while the unit names the same
  // visible anchor (a reference-style link whose target moved): match the pair by the words both read.
  const oldVisible = (oldElement.textContent ?? '').trim()
  const newVisible = (newElement.textContent ?? '').trim()
  return oldVisible !== '' && oldVisible === newVisible
    && (unit.oldText.includes(oldVisible) || unit.newText.includes(newVisible))
}

/** Stamp every element inside `root` that already carries one unit with that unit's block number. */
function stampUnitElements(root: HTMLElement, unitIndex: number, blockIndex: number, kind: 'add' | 'del'): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-md-unit="${unitIndex}"]`)) {
    element.dataset.mdBlock = String(blockIndex)
    element.dataset.mdKind = kind
  }
}

/**
 * One block's unit, as the inline-twin helper needs it: which block the twin belongs to, and the change.
 */
interface InlineTwinUnit {
  blockIndex: number
  unit: TreePreviewUnit
}

/**
 * Whether two paired elements are an IMAGE whose path/alt/title changed.
 *
 * An image's attributes cannot be read off the rendered picture (and a wrong path shows nothing at all), so
 * its pair is ALWAYS drawn as the two frames — old red on the left, new green on the right — exactly like a
 * retargeted link. That covers both the path and the title/alt text: each frame names its own side.
 */
function isImagePairChange(previous: HTMLElement, next: HTMLElement): boolean {
  return previous.tagName === 'IMG'
    && next.tagName === 'IMG'
    && attributeFingerprint(previous) !== attributeFingerprint(next)
}

/**
 * Put the red/green twin of every INVISIBLE inline change (a retargeted link, a re-spelled style) inside one
 * rendered line, and stamp each twin with its block/unit and source.
 *
 * @param units - the block/unit pairs of this line that still have no drawn word run.
 * @param previous - the old side's element.
 * @param next - the new side's element.
 * @returns the indices of the units that got a twin.
 */
function twinHiddenInlineUnits(
  units: readonly InlineTwinUnit[],
  previous: HTMLElement,
  next: HTMLElement,
  pairs: [HTMLElement, HTMLElement][] = changedElementPairs(previous, next, false),
): Set<number> {
  const matched = new Set<number>()
  for (const { blockIndex, unit } of units) {
    if (matched.has(unit.index)) continue
    const pair = pairs.find(([oldElement, newElement]) =>
      (hasHiddenDiff(oldElement, newElement) || isImagePairChange(oldElement, newElement))
      && inlinePairMatchesUnit(unit, oldElement, newElement))
    if (pair === undefined) continue
    const parent = pair[1].parentNode
    if (parent === null) continue
    const position = [...parent.childNodes].indexOf(pair[1])
    if (position === -1 || !applyTwin(pair[0], pair[1], unit.index, true)) continue
    const wrapper = parent.childNodes[position]
    if (!(wrapper instanceof HTMLElement)) continue
    wrapper.dataset.mdBlock = String(blockIndex)
    wrapper.dataset.mdKind = 'add'
    setMarkerLines(wrapper, unit, 'old')
    setMarkerLines(wrapper, unit, 'new')
    matched.add(unit.index)
  }
  return matched
}

/**
 * The double column's version of `twinHiddenInlineUnits`: each column gets ITS side tinted with that side's
 * source, so the two link targets read as one red and one green link across the columns.
 */
function twinHiddenInlineUnitsDouble(
  units: readonly InlineTwinUnit[],
  previous: HTMLElement,
  next: HTMLElement,
  pairs: [HTMLElement, HTMLElement][] = changedElementPairs(previous, next, false),
): Set<number> {
  const matched = new Set<number>()
  for (const { blockIndex, unit } of units) {
    if (matched.has(unit.index)) continue
    const pair = pairs.find(([oldElement, newElement]) =>
      (hasHiddenDiff(oldElement, newElement) || isImagePairChange(oldElement, newElement))
      && inlinePairMatchesUnit(unit, oldElement, newElement))
    if (pair === undefined) continue
    const oldSide = sideTwin(pair[0], 'old', unit.index, true)
    const newSide = sideTwin(pair[1], 'new', unit.index, true)
    oldSide.dataset.mdBlock = String(blockIndex)
    oldSide.dataset.mdKind = 'del'
    newSide.dataset.mdBlock = String(blockIndex)
    newSide.dataset.mdKind = 'add'
    matched.add(unit.index)
  }
  return matched
}

/**
 * Draw one rendered line's inline changes: the word runs AND the one-red-one-green twins for changes that the
 * text itself cannot show (a retargeted link, a re-spelled style). Every block of the group is stamped onto the
 * elements its own change produced, so the toolbar frames/hovers just that difference, not the whole line.
 *
 * @param blocks - the group's single-unit inline blocks, in order.
 * @param next - the new side's element.
 * @param previous - the old side's element.
 * @param freshRoot - the new document's root (needed by the replacement fallback).
 */
function renderInlineUnitGroup(
  blocks: readonly TreePreviewBlock[],
  next: HTMLElement | undefined,
  previous: HTMLElement | undefined,
  freshRoot: HTMLElement,
): void {
  if (next === undefined || previous === undefined || next.tagName !== previous.tagName) {
    for (const block of blocks) treeReplacement(block, next === undefined ? [] : [next], previous === undefined ? [] : [previous], freshRoot)
    return
  }
  // The inline element pairs are read BEFORE the text merge: the merge splits text nodes, so a later walk would
  // compare a changed child list and could miss the link that moved its target.
  const inlinePairs = changedElementPairs(previous, next, false)
  const merged = mergeInlineText(next, previous)
  const matched = merged
    ? new Set<number>([...tagInlineRuns(next, blocks, 'mdWordAdd'), ...tagInlineRuns(next, blocks, 'mdWordDel')])
    : new Set<number>()
  const remaining = blocks.filter(block => !matched.has(block.index))
  // A CHECKBOX state change is drawn as the box itself: old box struck beside the new one (one block).
  const unmatched: TreePreviewBlock[] = []
  for (const block of remaining) {
    const unit = block.units[0]!
    if (drawCheckboxStates(previous, next, unit.index)) {
      stampUnitElements(next, unit.index, block.index, 'add')
      matched.add(block.index)
      continue
    }
    unmatched.push(block)
  }
  if (unmatched.length > 0) {
    const twinUnits = unmatched.map(block => ({
      blockIndex: block.index,
      unit: block.units[0]!,
    }))
    const twins = twinHiddenInlineUnits(twinUnits, previous, next, inlinePairs)
    for (const unit of twins) {
      const block = unmatched.find(candidate => candidate.units[0]!.index === unit)
      if (block !== undefined) matched.add(block.index)
    }
  }
  // A change with no drawable run at all (a changed attribute on a wrapper): mark its element whole. When the
  // merge DID draw a whole-line run pair (a rewritten sentence), that pair is the block's visible extent — tag
  // it, so hovering the blank end of the line does not raise a block whose carrier is the whole paragraph.
  for (const block of blocks) {
    if (matched.has(block.index)) continue
    const unit = block.units[0]!
    const drawnRuns = [...next.querySelectorAll<HTMLElement>('.mdWordAdd, .mdWordDel')]
      .filter(run => run.dataset.mdBlock === undefined)
      .filter(run => {
        const text = run.textContent ?? ''
        return (unit.oldText !== '' && text.includes(unit.oldText))
          || (unit.newText !== '' && text.includes(unit.newText))
      })
    if (drawnRuns.length > 0) {
      for (const run of drawnRuns) {
        const kind = run.classList.contains('mdWordDel') ? 'del' : 'add'
        markUnit(run, unit.index, kind)
        stampBlock(run, block.index, kind)
      }
      setMarkerLines(drawnRuns[0]!, unit, 'old')
      setMarkerLines(drawnRuns[0]!, unit, 'new')
      matched.add(block.index)
      continue
    }
    markChangedUnit(next, unit.index, 'add')
    stampBlock(next, block.index, 'add')
  }
}

/** Draw a group of inline-unit blocks in the double column: each column keeps its own side's text/marks. */
function renderInlineUnitGroupDouble(
  blocks: readonly TreePreviewBlock[],
  oldElement: HTMLElement | undefined,
  newElement: HTMLElement | undefined,
): void {
  if (oldElement === undefined || newElement === undefined || oldElement.tagName !== newElement.tagName) {
    for (const block of blocks) {
      const unit = block.units[0]!
      if (oldElement !== undefined) {
        markChangedUnit(oldElement, unit.index, 'del')
        stampBlock(oldElement, block.index, 'del')
      }
      if (newElement !== undefined) {
        markChangedUnit(newElement, unit.index, 'add')
        stampBlock(newElement, block.index, 'add')
      }
    }
    return
  }
  const inlinePairs = changedElementPairs(oldElement, newElement, false)
  const oldText = ownTextOf(oldElement)
  const newText = ownTextOf(newElement)
  if (oldText !== newText) {
    const runs = intraRunsOf(oldText, newText)
    if (runs !== undefined) {
      wrapOwnChangedRuns(oldElement, runs.del, 'mdWordDel')
      wrapOwnChangedRuns(newElement, runs.add, 'mdWordAdd')
    }
  }
  const matchedOld = tagInlineRuns(oldElement, blocks, 'mdWordDel')
  const matchedNew = tagInlineRuns(newElement, blocks, 'mdWordAdd')
  for (const block of blocks) {
    if (matchedOld.has(block.index) || matchedNew.has(block.index)) continue
    const unit = block.units[0]!
    // A checkbox state change: each column tints ITS OWN box (no struck/added pair across columns).
    if (markCheckboxSide(oldElement, unit.index, 'del') && markCheckboxSide(newElement, unit.index, 'add')) {
      stampUnitElements(oldElement, unit.index, block.index, 'del')
      stampUnitElements(newElement, unit.index, block.index, 'add')
      continue
    }
    const pair = inlinePairs.find(([oldPair, newPair]) =>
      (hasHiddenDiff(oldPair, newPair) || isImagePairChange(oldPair, newPair))
      && inlinePairMatchesUnit(unit, oldPair, newPair))
    if (pair !== undefined) {
      const oldSide = sideTwin(pair[0], 'old', unit.index, true)
      const newSide = sideTwin(pair[1], 'new', unit.index, true)
      oldSide.dataset.mdBlock = String(block.index)
      oldSide.dataset.mdKind = 'del'
      newSide.dataset.mdBlock = String(block.index)
      newSide.dataset.mdKind = 'add'
      continue
    }
    markChangedUnit(oldElement, unit.index, 'del')
    stampBlock(oldElement, block.index, 'del')
    markChangedUnit(newElement, unit.index, 'add')
    stampBlock(newElement, block.index, 'add')
  }
}

/**
 * Every numbered block must be reachable in the DOM.
 *
 * A merge can leave one block without a drawn element: a rewritten line whose character runs cannot be
 * attributed to the separate changes, or an inline attribute change whose counterpart element never rendered.
 * Such a block gets ONE modest source marker at its position (the old renderer's reachability net), so the
 * toolbar can still number, hover and keep it.
 */
function ensureTreeBlocksReachable(root: HTMLElement, blocks: readonly TreePreviewBlock[], otherRoot?: HTMLElement): void {
  for (const block of blocks) {
    if (block.invisible.length > 0) continue
    if (root.querySelector(`[data-md-block="${block.index}"]`) !== null) continue
    // In the double column a block only needs ONE column to carry it: a deletion lives in the old column and an
    // addition in the new one. Marking it in both would put phantom chips in the column that does not show it,
    // out of preorder.
    if (otherRoot !== undefined && otherRoot.querySelector(`[data-md-block="${block.index}"]`) !== null) continue
    const oldSource = block.oldNodes.map(node => node.raw).join('\n').replace(/\n+$/, '')
    const newSource = block.newNodes.map(node => node.raw).join('\n').replace(/\n+$/, '')
    if (oldSource === '' && newSource === '') continue
    const markers = placeholderTwins(
      block.index,
      oldSource === '' ? undefined : oldSource,
      newSource === '' ? undefined : newSource,
      'markdown',
      block.units[0] as unknown as PreviewUnit | undefined,
    )
    for (const marker of markers) stampBlock(marker, block.index, marker.dataset.mdKind === 'del' ? 'del' : 'add')
    const line = block.newStart <= block.newEnd ? block.newStart : block.oldStart
    const anchor = insertionPointFor(root, Math.max(0, line - 1))
    for (const marker of markers) anchor.parent.insertBefore(marker, anchor.before)
  }
}

/** Rendered tag for each inline tree-node type whose element can be twinned. */
const INLINE_NODE_TAGS: Record<string, string> = {
  link: 'A',
  strong: 'STRONG',
  em: 'EM',
  codespan: 'CODE',
  image: 'IMG',
  del: 'DEL',
  ins: 'INS',
}

/** The rendered element for one inline tree node INSIDE its container element. */
function inlineElementForNode(container: HTMLElement, node: MarkdownTreeNode): HTMLElement | undefined {
  if (node.type === 'checkbox') {
    const box = container.querySelector('input[type="checkbox"]')
    return box instanceof HTMLElement ? box : undefined
  }
  const tag = INLINE_NODE_TAGS[node.type]
  if (tag === undefined) return undefined
  const candidates = [...container.querySelectorAll<HTMLElement>(tag)]
  if (node.type === 'image') {
    const path = (node.attrs.src as string | undefined) ?? ''
    return candidates.find(image => image.getAttribute('src') === path) ?? candidates[0]
  }
  const text = nodeVisibleText(node).trim()
  const exact = candidates.filter(element => (element.textContent ?? '').trim() === text)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    const raw = node.raw.replace(/\s+/g, '')
    const bySource = exact.find(element => {
      const source = sourceOfElement(element).replace(/\s+/g, '')
      return source === raw || source.includes(raw) || raw.includes(source)
    })
    return bySource ?? exact[0]
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Where a needle sits in one element's OWN text (text nodes up to the first structural child). */
function ownTextIndexOf(element: HTMLElement, needle: string): number {
  if (needle === '') return -1
  return ownTextOf(element).indexOf(needle)
}

/**
 * The text a tree node contributes to its container's OWN rendered text.
 *
 * This is how the renderer maps a node's SOURCE position to a DOM text offset without searching for the words
 * (a search picks the wrong occurrence when the line repeats itself, which is what put blocks out of order and
 * let one block's run wrap inside another's).
 */
function ownRenderedTextOfNode(node: MarkdownTreeNode): string {
  switch (node.type) {
    case 'image':
    case 'checkbox':
    case 'hr':
    case 'html':
      return ''
    case 'text':
      return node.children.length > 0 ? node.children.map(child => ownRenderedTextOfNode(child)).join('') : node.raw
    case 'codespan':
    case 'escape':
      return node.text
    case 'list':
    case 'blockquote':
    case 'table':
    case 'code':
      return ''
    default:
      return node.children.length > 0 ? node.children.map(child => ownRenderedTextOfNode(child)).join('') : node.text
  }
}

/** The rendered-own-text offset of one source position, walking the container's children in tree order. */
function renderedOffsetInChildren(children: readonly MarkdownTreeNode[], target: MarkdownTreeNode, sourceOffset: number): number {
  let offset = 0
  for (const child of children) {
    if (child.id === target.id) return offset + Math.max(0, sourceOffset - child.start)
    if (child.children.length > 0) {
      const nested = renderedOffsetInChildren(child.children, target, sourceOffset)
      if (nested >= 0) return offset + nested
    }
    offset += ownRenderedTextOfNode(child).length
  }
  return -1
}

/** The DOM own-text offset of a text unit (or a whole node, when `sourceOffset` is its start). */
function renderedOffsetOf(container: MarkdownTreeNode, node: MarkdownTreeNode, sourceOffset: number): number {
  if (container.id === node.id) return Math.max(0, sourceOffset - container.start)
  return renderedOffsetInChildren(container.children, node, sourceOffset)
}

/**
 * The DOM own-text offset of one text unit (or a whole node, when `sourceOffset` is its start).
 *
 * @param container - the inline container's tree node.
 * @param node - the text node the unit belongs to.
 * @param unit - the unit.
 * @param side - which side's character range to use.
 * @returns the offset in the element's own rendered text, or -1 when it cannot be mapped.
 */
function renderedOffsetOfUnit(container: MarkdownTreeNode, node: MarkdownTreeNode, unit: TreePreviewUnit, side: 'old' | 'new'): number {
  const chars = side === 'new' ? unit.newChars : unit.oldChars
  return renderedOffsetOf(container, node, chars.start)
}

/** The DOM own-text offset where a whole node starts. */
function renderedOffsetOfNode(container: MarkdownTreeNode, node: MarkdownTreeNode): number {
  return renderedOffsetOf(container, node, node.start)
}

/**
 * The DOM own-text offset of one CODE line unit.
 *
 * The CODE element holds only the fence's CONTENT lines; the opening ``` line is part of the code node's raw
 * source but not of the element's text. The tree offset must drop that opening line, or the run lands six
 * characters into the first code line (the reported broken fence).
 */
function renderedOffsetOfCodeUnit(
  container: MarkdownTreeNode,
  node: MarkdownTreeNode,
  unit: TreePreviewUnit,
  side: 'old' | 'new',
): number {
  if (node.type !== 'code') return renderedOffsetOfUnit(container, node, unit, side)
  const chars = side === 'new' ? unit.newChars : unit.oldChars
  const raw = container.raw
  const opening = raw.indexOf('\n')
  const prefix = opening === -1 ? 0 : opening + 1
  return Math.max(0, chars.start - container.start - prefix)
}

/** The newly created `.cls` run, once a wrap/insert has run on the element. */
function newestRun(element: HTMLElement, cls: string, before: ReadonlySet<Element>): HTMLElement | undefined {
  return [...element.querySelectorAll<HTMLElement>(`.${cls}`)]
    .filter(run => !before.has(run) && run.dataset.mdBlock === undefined)
    .pop()
}

/** Stamp one drawn run with the block and its unit, and carry the unit's source lines for the toolbar. */
function stampDrawnRun(element: HTMLElement, block: TreePreviewBlock, unit: TreePreviewUnit | undefined, kind: 'add' | 'del'): void {
  element.dataset.mdBlock = String(block.index)
  element.dataset.mdKind = kind
  if (unit !== undefined) {
    element.dataset.mdUnit = String(unit.index)
    setMarkerLines(element, unit as unknown as PreviewUnit, 'old')
    setMarkerLines(element, unit as unknown as PreviewUnit, 'new')
  }
}

/** Insert a styled run at a DOM own-text offset (used for a deletion's struck words, which have no new run). */
function insertOwnSpanAt(element: HTMLElement, offset: number, text: string, cls: string): HTMLElement | undefined {
  if (text === '') return undefined
  const nodes = ownTextNodes(element)
  const offsets = nodeOffsets(nodes)
  const at = Math.max(0, Math.min(offset, ownTextOf(element).length))
  const span = document.createElement('span')
  span.className = cls
  span.textContent = text
  for (let step = 0; step < nodes.length; step++) {
    const node = nodes[step]!
    const from = offsets[step]!
    if (at >= from && at < from + node.data.length) {
      const tail = splitAt(node, at - from)
      tail.parentNode?.insertBefore(span, tail)
      return span
    }
  }
  const last = nodes[nodes.length - 1]
  if (last !== undefined) {
    const parent = last.parentNode
    if (parent !== null) {
      parent.insertBefore(span, last.nextSibling)
      return span
    }
  }
  return undefined
}

/**
 * Insert the old words immediately BEFORE the new run they replaced.
 *
 * Inserting by text offset would be wrong as soon as another unit's run was already inserted on the same line
 * (the old text shifts every later offset), and it could nest the struck run inside a later wrapper. Anchoring
 * to the new run keeps the two halves of ONE change together and independent of the other blocks.
 */
function insertDelRunBefore(anchor: HTMLElement, text: string, block: TreePreviewBlock, unit: TreePreviewUnit): HTMLElement | undefined {
  if (text === '') return undefined
  const span = document.createElement('span')
  span.className = 'mdWordDel'
  span.textContent = text
  anchor.before(span)
  stampDrawnRun(span, block, unit, 'del')
  return span
}

/**
 * Draw one unit's characters at a KNOWN own-text offset.
 *
 * @param element - the element whose own text carries the change.
 * @param offset - the DOM own-text offset (negative to fall back to searching the words).
 * @param unit - the change.
 * @param block - its block.
 * @param side - which side's words to draw.
 * @returns the created run, when drawn.
 */
function drawUnitAt(
  element: HTMLElement,
  offset: number,
  unit: TreePreviewUnit,
  block: TreePreviewBlock,
  side: 'add' | 'del',
): HTMLElement | undefined {
  const needle = side === 'add' ? unit.newText : unit.oldText
  if (needle === '') return undefined
  const ownLength = ownTextOf(element).length
  let at = offset >= 0 ? offset : ownTextIndexOf(element, needle)
  // A source offset can land past the rendered own text (text inside a nested structure, markup that does not
  // render): wrapping such a range would run off the end and never advance. Skip instead.
  if (at < 0 || at >= ownLength || at + needle.length > ownLength) at = ownTextIndexOf(element, needle)
  if (at < 0) return undefined
  const cls = side === 'add' ? 'mdWordAdd' : 'mdWordDel'
  const before = new Set<Element>(element.querySelectorAll(`.${cls}`))
  wrapOwnRange(element, at, at + needle.length, cls)
  const run = newestRun(element, cls, before)
  if (run === undefined) return undefined
  stampDrawnRun(run, block, unit, side)
  return run
}

function drawTextUnitIn(element: HTMLElement, unit: TreePreviewUnit, side: 'add' | 'del'): HTMLElement | undefined {
  const needle = side === 'add' ? unit.newText : unit.oldText
  if (needle === '') return undefined
  const at = ownTextIndexOf(element, needle)
  if (at < 0) return undefined
  const cls = side === 'add' ? 'mdWordAdd' : 'mdWordDel'
  const before = new Set<Element>(element.querySelectorAll(`.${cls}`))
  wrapOwnRange(element, at, at + needle.length, cls)
  return newestRun(element, cls, before)
}

/**
 * The hover/keep markers for an inline block that has no drawable element (a deleted inline link, a node that
 * changed TYPE): its own source chips at the container's position — never a tint on the whole container.
 */
function insertInlineSourceMarkers(
  block: TreePreviewBlock,
  freshContainer: HTMLElement | undefined,
  baselineContainer: HTMLElement | undefined,
  side: 'single' | 'old' | 'new',
): boolean {
  const oldSource = block.oldNodes.map(node => node.raw).join('').replace(/\n+$/, '')
  const newSource = block.newNodes.map(node => node.raw).join('').replace(/\n+$/, '')
  const wantOld = side !== 'new' && oldSource !== ''
  const wantNew = side !== 'old' && newSource !== ''
  if (!wantOld && !wantNew) return false
  const chips = placeholderTwins(
    block.index,
    wantOld ? oldSource : undefined,
    wantNew ? newSource : undefined,
    'markdown',
  )
  for (const chip of chips) stampBlock(chip, block.index, chip.dataset.mdKind === 'del' ? 'del' : 'add')
  const anchor = freshContainer ?? baselineContainer
  if (anchor?.parentNode !== undefined && anchor?.parentNode !== null) {
    for (const chip of chips) anchor.parentNode.insertBefore(chip, anchor)
    return true
  }
  return false
}

/**
 * Draw ONE inline-child block (a text run, a changed link/strong/image, or an inline node that exists on one
 * side only) in the single column.
 *
 * The block's container is its rendered parent; the change is drawn as word runs inside the changed element or,
 * for an attribute-only change (a retargeted link, an image path, a syntax respelling), as the red/green pair.
 * Nothing here ever tints the container element, so one block cannot contain another.
 *
 * @param block - the inline block.
 * @param fresh - the new document's rendered tree.
 * @param baseline - the old document's rendered tree.
 */
function renderInlineChildBlock(block: TreePreviewBlock, fresh: RenderedDoc, baseline: RenderedDoc): void {
  const containerNew = block.inlineContainer?.new === undefined ? undefined : treeNodeElements(fresh, block.inlineContainer.new)[0]
  const containerOld = block.inlineContainer?.old === undefined ? undefined : treeNodeElements(baseline, block.inlineContainer.old)[0]
  const unit = block.units[0] as unknown as TreePreviewUnit | undefined
  if (block.kind === 'checkbox') {
    const index = unit?.index ?? block.index
    if (containerOld !== undefined && containerNew !== undefined && drawCheckboxStates(containerOld, containerNew, index)) {
      stampUnitElements(containerNew, index, block.index, 'add')
      return
    }
    insertInlineSourceMarkers(block, containerNew, containerOld, 'single')
    return
  }
  const oldNode = block.oldNodes[0]
  const newNode = block.newNodes[0]
  // A REWRITTEN text pair (several char runs the line merge cannot align) is drawn as the whole line, once.
  const containerNodeNew = block.inlineContainer?.new
  if (block.units.length > 1 && block.kind === 'text' && containerOld !== undefined && containerNew !== undefined
    && oldNode !== undefined && newNode !== undefined) {
    const oldText = block.oldNodes.map(node => node.raw).join('')
    const newText = newNode.raw
    const offset = containerNodeNew === undefined ? -1 : renderedOffsetOfNode(containerNodeNew, newNode)
    const at = offset >= 0 ? offset : ownTextIndexOf(containerNew, newText)
    if (at >= 0) {
      const length = newText.length
      const addBefore = new Set<Element>(containerNew.querySelectorAll('.mdWordAdd'))
      wrapOwnRange(containerNew, at, at + length, 'mdWordAdd')
      const addRun = newestRun(containerNew, 'mdWordAdd', addBefore)
      if (addRun !== undefined) {
        stampDrawnRun(addRun, block, block.units[0] as unknown as TreePreviewUnit, 'add')
        insertDelRunBefore(addRun, oldText, block, block.units[0] as unknown as TreePreviewUnit)
      }
      return
    }
  }
  // Code lines / text runs: wrap exactly the unit's source characters, located by the tree offset.
  if (block.units.length > 0 && containerNew !== undefined && (block.kind === 'code' || block.kind === 'text')
    && oldNode !== undefined && newNode !== undefined && containerNodeNew !== undefined) {
    let drew = false
    // Back to front: inserting one unit's old words must not move the offsets of units still to draw.
    const orderedUnits = [...block.units as unknown as TreePreviewUnit[]]
      .map(blockUnit => ({
        blockUnit,
        offset: block.kind === 'code'
          ? renderedOffsetOfCodeUnit(containerNodeNew, newNode, blockUnit, 'new')
          : renderedOffsetOfUnit(containerNodeNew, newNode, blockUnit, 'new'),
      }))
      .sort((left, right) => right.offset - left.offset)
    for (const { blockUnit, offset } of orderedUnits) {
      if (blockUnit.newText === '') {
        // A pure deletion has no new run: its struck words sit where they were removed.
        const deleted = insertOwnSpanAt(containerNew, Math.max(0, offset), blockUnit.oldText, 'mdWordDel')
        if (deleted !== undefined) {
          stampDrawnRun(deleted, block, blockUnit, 'del')
          drew = true
        }
        continue
      }
      const addRun = drawUnitAt(containerNew, offset, blockUnit, block, 'add')
      if (addRun === undefined) continue
      insertDelRunBefore(addRun, blockUnit.oldText, block, blockUnit)
      drew = true
    }
    if (drew) return
  }
  // Text edits INSIDE one inline element (a link/strong whose words changed): word runs on that element.
  if (block.units.length > 0 && oldNode !== undefined && newNode !== undefined) {
    const oldTarget = block.kind === 'text' ? containerOld : containerOld === undefined ? undefined : inlineElementForNode(containerOld, oldNode)
    const newTarget = block.kind === 'text' ? containerNew : containerNew === undefined ? undefined : inlineElementForNode(containerNew, newNode)
    if (oldTarget !== undefined && newTarget !== undefined) {
      let drew = false
      for (const blockUnit of block.units as unknown as TreePreviewUnit[]) {
        const addRun = drawTextUnitIn(newTarget, blockUnit, 'add')
        if (addRun === undefined) continue
        stampDrawnRun(addRun, block, blockUnit, 'add')
        insertDelRunBefore(addRun, blockUnit.oldText, block, blockUnit)
        drew = true
      }
      if (drew) return
    }
  }
  // An attribute-only change: the element itself is the change — red old copy, green new copy.
  if (oldNode !== undefined && newNode !== undefined && oldNode.type === newNode.type && INLINE_NODE_TAGS[oldNode.type] !== undefined) {
    const oldElement = containerOld === undefined ? undefined : inlineElementForNode(containerOld, oldNode)
    const newElement = containerNew === undefined ? undefined : inlineElementForNode(containerNew, newNode)
    if (oldElement !== undefined && newElement !== undefined) {
      const parent = newElement.parentNode
      if (parent !== null) {
        const position = [...parent.childNodes].indexOf(newElement)
        const index = unit?.index ?? block.index
        if (applyTwin(oldElement, newElement, index, true)) {
          const wrapper = parent.childNodes[position]
          if (wrapper instanceof HTMLElement) {
            wrapper.dataset.mdBlock = String(block.index)
            wrapper.dataset.mdKind = 'add'
            if (unit !== undefined) wrapper.dataset.mdUnit = String(unit.index)
            // The toolbar wants the Markdown that was written (`**x**` / `__x__`), not the rendered words.
            setSourceDiff(wrapper, { old: oldNode.raw, new: newNode.raw })
            return
          }
        }
      }
    }
  }
  // No drawable element: its own source chips stand for it.
  insertInlineSourceMarkers(block, containerNew, containerOld, 'single')
}

/**
 * Draw code changes BY LINE, TOP TO BOTTOM: the old line struck above the new line, then the untouched lines.
 *
 * A code fence is read line by line, so a changed line is a red line followed by its green replacement — not
 * two half-lines squeezed onto one row.
 *
 * @param blocks - the fence's changed-line blocks (one per contiguous run), in model order.
 * @param codeNode - the fence's tree node.
 * @param codeElement - the rendered CODE element.
 */
function renderCodeLines(blocks: readonly TreePreviewBlock[], codeNode: MarkdownTreeNode, codeElement: HTMLElement): void {
  const content = codeElement.textContent ?? ''
  const lines = content.split('\n')
  const changed = new Map<number, { block: TreePreviewBlock; unit: TreePreviewUnit }>()
  for (const block of blocks) {
    for (const unit of block.units as unknown as TreePreviewUnit[]) {
      const line = unit.newLines.start - codeNode.lines.start - 1
      changed.set(line, { block, unit })
    }
  }
  const parts: Node[] = []
  const appendLine = (text: string, cls: string | undefined, entry: { block: TreePreviewBlock; unit: TreePreviewUnit } | undefined): void => {
    if (cls === undefined) {
      parts.push(document.createTextNode(text))
      return
    }
    const span = document.createElement('span')
    span.className = `${cls} mdCodeLine`
    span.textContent = text
    if (entry !== undefined) stampDrawnRun(span, entry.block, entry.unit, cls === 'mdWordDel' ? 'del' : 'add')
    parts.push(span)
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const entry = changed.get(index)
    if (entry === undefined) {
      appendLine(line, undefined, undefined)
      if (index < lines.length - 1) parts.push(document.createTextNode('\n'))
      continue
    }
    if (entry.unit.oldText !== '') appendLine(entry.unit.oldText, 'mdWordDel', entry)
    if (entry.unit.newText !== '') appendLine(entry.unit.newText, 'mdWordAdd', entry)
  }
  codeElement.replaceChildren(...parts)
}

/**
 * Render every inline block of ONE container together, so blocks that have only ONE side are placed where the
 * model puts them (before the next block's rendered element) instead of as marker chips around the container.
 *
 * @param blocks - the container's inline blocks, in model order.
 * @param fresh - the new document's rendered tree.
 * @param baseline - the old document's rendered tree.
 */
function renderInlineContainerGroup(blocks: readonly TreePreviewBlock[], fresh: RenderedDoc, baseline: RenderedDoc): void {
  const first = blocks[0]!
  const newContainer = first.inlineContainer?.new === undefined ? undefined : treeNodeElements(fresh, first.inlineContainer.new)[0]
  const oldContainer = first.inlineContainer?.old === undefined ? undefined : treeNodeElements(baseline, first.inlineContainer.old)[0]
  if (blocks.every(block => block.kind === 'code') && first.inlineContainer?.new?.type === 'code' && newContainer !== undefined) {
    renderCodeLines(blocks, first.inlineContainer.new, newContainer)
    return
  }
  const deletions = blocks.filter(block => block.oldNodes.length > 0 && block.newNodes.length === 0)
  const additions = blocks.filter(block => block.newNodes.length > 0 && block.oldNodes.length === 0)
  const both = blocks.filter(block => block.oldNodes.length > 0 && block.newNodes.length > 0)
  // Text runs inside one container are drawn back to front: a struck insertion must not move the source
  // offsets of the runs still to draw.
  const textRuns = both
    .filter(block => (block.kind === 'text' || block.kind === 'code') && block.units.length > 0 && block.inlineContainer?.new !== undefined)
    .map(block => ({
      block,
      offset: block.kind === 'code'
        ? renderedOffsetOfCodeUnit(
          block.inlineContainer!.new!,
          block.newNodes[0]!,
          block.units[0] as unknown as TreePreviewUnit,
          'new',
        )
        : renderedOffsetOfUnit(
          block.inlineContainer!.new!,
          block.newNodes[0]!,
          block.units[0] as unknown as TreePreviewUnit,
          'new',
        ),
    }))
    .sort((left, right) => right.offset - left.offset)
  for (const entry of textRuns) renderInlineChildBlock(entry.block, fresh, baseline)
  for (const block of both) {
    if (textRuns.some(entry => entry.block === block)) continue
    renderInlineChildBlock(block, fresh, baseline)
  }
  // One-sided blocks are MARKS on the side that exists: the side's own content is already rendered in place.
  for (const block of additions) {
    if (newContainer === undefined) continue
    for (const node of block.newNodes) {
      if (node.type === 'text') {
        const offset = renderedOffsetOfNode(block.inlineContainer!.new!, node)
        if (offset < 0) continue
        const before = new Set<Element>(newContainer.querySelectorAll('.mdWordAdd'))
        wrapOwnRange(newContainer, offset, offset + node.raw.length, 'mdWordAdd')
        const run = newestRun(newContainer, 'mdWordAdd', before)
        if (run !== undefined) stampDrawnRun(run, block, undefined, 'add')
      } else {
        const element = inlineElementForNode(newContainer, node)
        if (element !== undefined) {
          markChangedUnit(element, block.index, 'add')
          stampBlock(element, block.index, 'add')
        }
      }
    }
  }
  for (const block of deletions) {
    if (newContainer === undefined) continue
    // Find the next block of this container that has rendered content: the deleted words sit right before it.
    const later = blocks.slice(blocks.indexOf(block) + 1).find(candidate =>
      newContainer.querySelector(`[data-md-block="${candidate.index}"]`) !== null)
    const anchor = later === undefined ? undefined : newContainer.querySelector<HTMLElement>(`[data-md-block="${later.index}"]`) ?? undefined
    const wrapper = document.createElement('span')
    wrapper.className = 'mdWordDel'
    wrapper.dataset.mdBlock = String(block.index)
    wrapper.dataset.mdKind = 'del'
    for (const node of block.oldNodes) {
      if (node.type === 'text') {
        wrapper.append(document.createTextNode(node.raw))
        continue
      }
      const element = oldContainer === undefined ? undefined : inlineElementForNode(oldContainer, node)
      if (element !== undefined) {
        const clone = element.cloneNode(true) as HTMLElement
        clone.removeAttribute('data-md-block')
        clone.removeAttribute('data-md-unit')
        wrapper.append(clone)
      } else {
        wrapper.append(document.createTextNode(node.raw))
      }
    }
    if (anchor !== undefined) anchor.before(wrapper)
    else newContainer.append(wrapper)
  }
}

/**
 * Draw ONE inline-child block in the double column: each column shows its own side's text edit or element twin.
 *
 * @param block - the inline block.
 * @param fresh - the new document's rendered tree.
 * @param baseline - the old document's rendered tree.
 */
function renderInlineChildBlockDouble(block: TreePreviewBlock, fresh: RenderedDoc, baseline: RenderedDoc): void {
  const containerNew = block.inlineContainer?.new === undefined ? undefined : treeNodeElements(fresh, block.inlineContainer.new)[0]
  const containerOld = block.inlineContainer?.old === undefined ? undefined : treeNodeElements(baseline, block.inlineContainer.old)[0]
  const unit = block.units[0] as unknown as TreePreviewUnit | undefined
  const index = unit?.index ?? block.index
  if (block.kind === 'checkbox') {
    if (containerOld !== undefined) markCheckboxSide(containerOld, index, 'del')
    if (containerNew !== undefined) markCheckboxSide(containerNew, index, 'add')
    if (containerOld !== undefined) stampUnitElements(containerOld, index, block.index, 'del')
    if (containerNew !== undefined) stampUnitElements(containerNew, index, block.index, 'add')
    return
  }
  const oldNode = block.oldNodes[0]
  const newNode = block.newNodes[0]
  const containerNodeNew = block.inlineContainer?.new
  const containerNodeOld = block.inlineContainer?.old
  if (block.units.length > 1 && block.kind === 'text' && containerOld !== undefined && containerNew !== undefined
    && oldNode !== undefined && newNode !== undefined && containerNodeOld !== undefined && containerNodeNew !== undefined) {
    const firstUnit = block.units[0] as unknown as TreePreviewUnit
    const oldOffset = renderedOffsetOfNode(containerNodeOld, oldNode)
    const newOffset = renderedOffsetOfNode(containerNodeNew, newNode)
    const oldLength = ownRenderedTextOfNode(oldNode).length
    const newLength = ownRenderedTextOfNode(newNode).length
    let drew = false
    if (oldOffset >= 0) {
      const before = new Set<Element>(containerOld.querySelectorAll('.mdWordDel'))
      wrapOwnRange(containerOld, oldOffset, oldOffset + oldLength, 'mdWordDel')
      const run = newestRun(containerOld, 'mdWordDel', before)
      if (run !== undefined) {
        stampDrawnRun(run, block, firstUnit, 'del')
        drew = true
      }
    }
    if (newOffset >= 0) {
      const before = new Set<Element>(containerNew.querySelectorAll('.mdWordAdd'))
      wrapOwnRange(containerNew, newOffset, newOffset + newLength, 'mdWordAdd')
      const run = newestRun(containerNew, 'mdWordAdd', before)
      if (run !== undefined) {
        stampDrawnRun(run, block, firstUnit, 'add')
        drew = true
      }
    }
    if (drew) return
  }
  if (block.units.length > 0 && containerOld !== undefined && containerNew !== undefined && (block.kind === 'code' || block.kind === 'text')
    && oldNode !== undefined && newNode !== undefined && containerNodeOld !== undefined && containerNodeNew !== undefined) {
    let drew = false
    for (const blockUnit of block.units as unknown as TreePreviewUnit[]) {
      const oldOffset = block.kind === 'code'
        ? renderedOffsetOfCodeUnit(containerNodeOld, oldNode, blockUnit, 'old')
        : renderedOffsetOfUnit(containerNodeOld, oldNode, blockUnit, 'old')
      const newOffset = block.kind === 'code'
        ? renderedOffsetOfCodeUnit(containerNodeNew, newNode, blockUnit, 'new')
        : renderedOffsetOfUnit(containerNodeNew, newNode, blockUnit, 'new')
      const oldRun = drawUnitAt(containerOld, oldOffset, blockUnit, block, 'del')
      const newRun = drawUnitAt(containerNew, newOffset, blockUnit, block, 'add')
      if (oldRun !== undefined) drew = true
      if (newRun !== undefined) drew = true
    }
    if (drew) return
  }
  if (block.units.length > 0 && oldNode !== undefined && newNode !== undefined) {
    const oldTarget = block.kind === 'text' ? containerOld : containerOld === undefined ? undefined : inlineElementForNode(containerOld, oldNode)
    const newTarget = block.kind === 'text' ? containerNew : containerNew === undefined ? undefined : inlineElementForNode(containerNew, newNode)
    if (oldTarget !== undefined && newTarget !== undefined) {
      let drew = false
      for (const blockUnit of block.units as unknown as TreePreviewUnit[]) {
        const oldRun = drawTextUnitIn(oldTarget, blockUnit, 'del')
        const newRun = drawTextUnitIn(newTarget, blockUnit, 'add')
        if (oldRun !== undefined) {
          stampDrawnRun(oldRun, block, blockUnit, 'del')
          drew = true
        }
        if (newRun !== undefined) {
          stampDrawnRun(newRun, block, blockUnit, 'add')
          drew = true
        }
      }
      if (drew) return
    }
  }
  if (oldNode !== undefined && newNode !== undefined && oldNode.type === newNode.type && INLINE_NODE_TAGS[oldNode.type] !== undefined) {
    const oldElement = containerOld === undefined ? undefined : inlineElementForNode(containerOld, oldNode)
    const newElement = containerNew === undefined ? undefined : inlineElementForNode(containerNew, newNode)
    if (oldElement !== undefined && newElement !== undefined) {
      const oldSide = sideTwin(oldElement, 'old', index, true)
      const newSide = sideTwin(newElement, 'new', index, true)
      oldSide.dataset.mdBlock = String(block.index)
      oldSide.dataset.mdKind = 'del'
      newSide.dataset.mdBlock = String(block.index)
      newSide.dataset.mdKind = 'add'
      // The toolbar wants the Markdown that was written (`**x**` / `__x__`), not the rendered words.
      setSourceDiff(oldSide, { old: oldNode.raw })
      setSourceDiff(newSide, { new: newNode.raw })
      return
    }
  }
  const oldSource = block.oldNodes.map(node => node.raw).join('').replace(/\n+$/, '')
  const newSource = block.newNodes.map(node => node.raw).join('').replace(/\n+$/, '')
  if (containerOld !== undefined && containerOld.parentNode !== null && oldSource !== '') {
    const chip = placeholderTwin(block.index, oldSource, undefined, 'markdown')
    stampBlock(chip, block.index, 'del')
    containerOld.parentNode.insertBefore(chip, containerOld)
  }
  if (containerNew !== undefined && containerNew.parentNode !== null && newSource !== '') {
    const chip = placeholderTwin(block.index, undefined, newSource, 'markdown')
    stampBlock(chip, block.index, 'add')
    containerNew.parentNode.insertBefore(chip, containerNew)
  }
}

/**
 * Render one inline container's blocks in the double column: each column shows its own side, so one-sided
 * blocks are marks on the side that exists (its content is already rendered in place there).
 *
 * @param blocks - the container's inline blocks, in model order.
 * @param fresh - the new document's rendered tree.
 * @param baseline - the old document's rendered tree.
 */
function renderInlineContainerGroupDouble(blocks: readonly TreePreviewBlock[], fresh: RenderedDoc, baseline: RenderedDoc): void {
  const first = blocks[0]!
  const newContainer = first.inlineContainer?.new === undefined ? undefined : treeNodeElements(fresh, first.inlineContainer.new)[0]
  const oldContainer = first.inlineContainer?.old === undefined ? undefined : treeNodeElements(baseline, first.inlineContainer.old)[0]
  for (const block of blocks) {
    if (block.oldNodes.length > 0 && block.newNodes.length > 0) {
      renderInlineChildBlockDouble(block, fresh, baseline)
      continue
    }
    if (block.oldNodes.length > 0 && oldContainer !== undefined) {
      for (const node of block.oldNodes) {
        if (node.type === 'text') {
          const offset = renderedOffsetOfNode(block.inlineContainer!.old!, node)
          if (offset < 0) continue
          const before = new Set<Element>(oldContainer.querySelectorAll('.mdWordDel'))
          wrapOwnRange(oldContainer, offset, offset + node.raw.length, 'mdWordDel')
          const run = newestRun(oldContainer, 'mdWordDel', before)
          if (run !== undefined) stampDrawnRun(run, block, undefined, 'del')
        } else {
          const element = inlineElementForNode(oldContainer, node)
          if (element !== undefined) {
            markChangedUnit(element, block.index, 'del')
            stampBlock(element, block.index, 'del')
          }
        }
      }
    }
    if (block.newNodes.length > 0 && newContainer !== undefined) {
      for (const node of block.newNodes) {
        if (node.type === 'text') {
          const offset = renderedOffsetOfNode(block.inlineContainer!.new!, node)
          if (offset < 0) continue
          const before = new Set<Element>(newContainer.querySelectorAll('.mdWordAdd'))
          wrapOwnRange(newContainer, offset, offset + node.raw.length, 'mdWordAdd')
          const run = newestRun(newContainer, 'mdWordAdd', before)
          if (run !== undefined) stampDrawnRun(run, block, undefined, 'add')
        } else {
          const element = inlineElementForNode(newContainer, node)
          if (element !== undefined) {
            markChangedUnit(element, block.index, 'add')
            stampBlock(element, block.index, 'add')
          }
        }
      }
    }
  }
}

/**
 * Render the Markdown preview with the TREE-FIRST diff: the two documents are parsed into syntax trees, matched
 * outermost-first (exact, then by type, then each type's internals), and the resulting match plan is drawn onto
 * the elements those nodes rendered as.
 *
 * This is the new pipeline being brought up beside the line-diff one; it currently supports the single column.
 *
 * @param oldText - the file's tracked baseline.
 * @param newText - the file's current content.
 * @param labels - user-facing words the rendered markup must carry (none by default).
 * @returns sanitized HTML for the preview body.
 */
export function renderTreeMerged(oldText: string, newText: string, labels?: { readonly invisible?: string }): string {
  const model = treePreviewModel(oldText, newText)
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  for (let index = 0; index < model.blocks.length;) {
    const block = model.blocks[index]!
    if (block.inlineContainer !== undefined) {
      // A change INSIDE one inline container: draw ALL of that container's blocks together, so blocks with one
      // side only are placed where the model puts them and text runs are drawn back to front (source offsets).
      const containerNew = block.inlineContainer.new
      const containerOld = block.inlineContainer.old
      const group = [block]
      let end = index + 1
      while (end < model.blocks.length) {
        const candidate = model.blocks[end]!
        if (candidate.inlineContainer === undefined) break
        const sameNew = containerNew === undefined ? candidate.inlineContainer.new === undefined : candidate.inlineContainer.new === containerNew
        const sameOld = containerOld === undefined ? candidate.inlineContainer.old === undefined : candidate.inlineContainer.old === containerOld
        if (!sameNew || !sameOld) break
        group.push(candidate)
        end++
      }
      renderInlineContainerGroup(group, fresh, baseline)
      index = end
      continue
    }
    if (isInlineUnitBlock(block)) {
      const end = inlineUnitGroupEnd(model.blocks, index)
      const group = model.blocks.slice(index, end)
      renderInlineUnitGroup(
        group,
        treeBlockElements(group[0]!, fresh, 'new')[0],
        treeBlockElements(group[0]!, baseline, 'old')[0],
        fresh.root,
      )
      index = end
      continue
    }
    if (block.invisible.length > 0) {
      treeInvisibleBlock(block, fresh.root)
      index++
      continue
    }
    const freshElements = treeBlockElements(block, fresh, 'new')
    const oldElements = treeBlockElements(block, baseline, 'old')
    if (block.merged) {
      // A pure addition is tinted where it renders; a pure deletion is cloned as a struck ghost. A merged pair
      // that exists on both sides (an unrelated replacement) is drawn as the old version above the new one.
      const ghosts: HTMLElement[] = []
      for (const element of oldElements) {
        const ghost = treeGhostOf(element, block, 'old')
        const next = freshElements[0]
        if (next !== undefined && next.parentNode !== null) next.parentNode.insertBefore(ghost, next)
        else treeInsertGhost(block, element, fresh.root)
        ghosts.push(ghost)
      }
      if (oldElements.length === 0 && freshElements.length > 0) {
        // A run of adjacent wholly-added blocks: ONE continuous green area (no white gaps between them).
        if (freshElements.length > 1) wrapBlockUnion(block, freshElements, 'add')
        else markChangedBlock(freshElements[0]!, block.index, 'add')
      } else if (oldElements.length > 0 && freshElements.length === 0) {
        // A run of adjacent wholly-deleted blocks: ONE continuous red area.
        if (ghosts.length > 1) wrapBlockUnion(block, ghosts, 'del')
      } else {
        for (const element of freshElements) markChangedBlock(element, block.index, 'add')
      }
      index++
      continue
    }
    if (block.units.length === 0) {
      treeReplacement(block, freshElements, oldElements, fresh.root)
      index++
      continue
    }
    if (block.kind === 'table_cell') {
      // A changed table cell is its OWN block: mark only that cell (its word runs/twins), never the row.
      const { next, previous } = tableCellElements(block, freshElements, oldElements)
      if (next === undefined || previous === undefined) {
        treeReplacement(block, freshElements, oldElements, fresh.root)
      } else {
        renderInlineUnitGroup([block], next, previous, fresh.root)
        const unit = block.units[0]
        if (unit !== undefined && next.querySelector(`[data-md-block="${block.index}"]`) === null) {
          markChangedUnit(next, unit.index, 'add')
          stampBlock(next, block.index, 'add')
          setMarkerLines(next, unit, 'old')
          setMarkerLines(next, unit, 'new')
        }
      }
      index++
      continue
    }
    if (block.kind === 'table_row' || block.kind === 'table_header') {
      if (!treeTableRowBlock(block, freshElements, oldElements)) treeReplacement(block, freshElements, oldElements, fresh.root)
      index++
      continue
    }
    if (block.kind === 'code') {
      treeCodeBlock(block, freshElements, oldElements, fresh.root)
      index++
      continue
    }
    treeInlineBlock(block, freshElements, oldElements, fresh.root)
    index++
  }
  ensureTreeBlocksReachable(fresh.root, model.blocks)
  captionHiddenPairs(fresh.root, labels?.invisible)
  return fresh.root.innerHTML
}

/** The tree path's units, adapted to the panel's `PreviewUnit` shape. */
export function treePreviewUnits(oldText: string, newText: string): PreviewUnit[] {
  return treePreviewModel(oldText, newText).units as unknown as PreviewUnit[]
}

/**
 * One plan piece's top-level nodes on one side: for a context piece the merged siblings, for a diff piece its
 * own node. Used by the double column's context-run row merging.
 */
function treePlanSideNodes(piece: MergePlanPiece, side: 'old' | 'new'): MarkdownTreeNode[] {
  const nodes: MarkdownTreeNode[] = []
  if (piece.kind === 'context') {
    for (const op of piece.ops ?? []) {
      if (op.kind === 'pair') nodes.push(side === 'old' ? op.pair.old : op.pair.new)
      else if (side === 'old' && op.kind === 'oldOnly') nodes.push(op.node)
      else if (side === 'new' && op.kind === 'newOnly') nodes.push(op.node)
    }
    return nodes
  }
  const op = piece.op
  if (op === undefined) return nodes
  if (op.kind === 'pair') nodes.push(side === 'old' ? op.pair.old : op.pair.new)
  else if (side === 'old' && op.kind === 'oldOnly') nodes.push(op.node)
  else if (side === 'new' && op.kind === 'newOnly') nodes.push(op.node)
  return nodes
}

/**
 * Wrap each adjacent run of FULLY-MATCHED top-level siblings into one layout element, so the double column
 * lays that whole unchanged run in ONE grid row instead of giving each block a row of its own.
 *
 * The rows themselves stay visually the same (an unchanged run has the same height in both columns); the
 * wrapper is `display: contents`, so its blocks still read as the document's own blocks.
 */
function wrapTreeContextRuns(roots: { old: HTMLElement; new: HTMLElement }, plan: readonly MergePlanPiece[]): void {
  for (const side of ['old', 'new'] as const) {
    const root = roots[side]
    for (const piece of plan) {
      if (piece.kind !== 'context') continue
      const nodes = treePlanSideNodes(piece, side)
      if (nodes.length === 0) continue
      let start = Number.POSITIVE_INFINITY
      let end = -1
      for (const node of nodes) {
        start = Math.min(start, node.lines.start - 1)
        end = Math.max(end, node.lines.end - 1)
      }
      if (end < start) continue
      const selected = [...root.children].filter((child): child is HTMLElement => {
        if (!(child instanceof HTMLElement)) return false
        const span = sourceSpanOf(child)
        return span !== undefined && span.start >= start && span.end <= end
      })
      // One element only: it already IS the run's row; nothing to merge.
      if (selected.length < 2) continue
      const wrapper = document.createElement('div')
      wrapper.className = 'mdTreeRun'
      wrapper.style.display = 'contents'
      selected[0]!.parentNode?.insertBefore(wrapper, selected[0]!)
      for (const element of selected) wrapper.appendChild(element)
    }
  }
}

/**
 * Render the TREE-FIRST diff as two whole documents (the double column): each column keeps its own
 * rendering and is tinted on ITS side, a paired edit highlights each side's changed characters, adjacent
 * fully-matched siblings are merged into one layout row, and the two documents are then laid out row by row.
 *
 * @param oldText - the file's tracked baseline (the before column).
 * @param newText - the file's current content (the after column).
 * @param labels - user-facing words the rendered markup must carry (none by default).
 * @returns sanitized HTML for the preview body.
 */
export function renderTreeDocuments(oldText: string, newText: string, labels?: { readonly invisible?: string }): string {
  const model = treePreviewModel(oldText, newText)
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  /** Draw one invisible change as each column's own source marker at its position. */
  const drawInvisible = (block: TreePreviewBlock): void => {
    const diff = block.invisible[0]
    if (diff === undefined) return
    if (diff.oldText !== undefined) {
      const chip = placeholderTwin(block.index, diff.oldText, undefined, diff.grammar)
      stampBlock(chip, block.index, 'del')
      const anchor = insertionPointFor(baseline.root, Math.max(0, block.oldStart - 1))
      anchor.parent.insertBefore(chip, anchor.before)
    }
    if (diff.newText !== undefined) {
      const chip = placeholderTwin(block.index, undefined, diff.newText, diff.grammar)
      stampBlock(chip, block.index, 'add')
      const anchor = insertionPointFor(fresh.root, Math.max(0, block.newStart - 1))
      anchor.parent.insertBefore(chip, anchor.before)
    }
  }
  const drawSideRuns = (
    oldElement: HTMLElement,
    newElement: HTMLElement,
    block: TreePreviewBlock,
    unitIndex: number,
  ): void => {
    const oldTextOfElement = ownTextOf(oldElement)
    const newTextOfElement = ownTextOf(newElement)
    let drewRuns = false
    if (oldElement.tagName === newElement.tagName && oldTextOfElement !== newTextOfElement) {
      const runs = intraRunsOf(oldTextOfElement, newTextOfElement)
      if (runs !== undefined) {
        wrapOwnChangedRuns(oldElement, runs.del, 'mdWordDel')
        wrapOwnChangedRuns(newElement, runs.add, 'mdWordAdd')
        drewRuns = true
      }
    }
    if (drewRuns) {
      // Only the changed CHARACTERS are tinted in a column (the block frame says which block); marking the whole
      // element would paint an unchanged sentence red just because one word in it changed.
      markUnit(oldElement, unitIndex, 'del')
      markUnit(newElement, unitIndex, 'add')
    } else {
      markChangedUnit(oldElement, unitIndex, 'del')
      markChangedUnit(newElement, unitIndex, 'add')
    }
    stampBlock(oldElement, block.index, 'del')
    stampBlock(newElement, block.index, 'add')
  }
  for (let index = 0; index < model.blocks.length;) {
    const block = model.blocks[index]!
    if (block.inlineContainer !== undefined) {
      // A change INSIDE one inline container: draw ALL of that container's blocks together, each column
      // showing its own side of the child.
      const containerNew = block.inlineContainer.new
      const containerOld = block.inlineContainer.old
      const group = [block]
      let end = index + 1
      while (end < model.blocks.length) {
        const candidate = model.blocks[end]!
        if (candidate.inlineContainer === undefined) break
        const sameNew = containerNew === undefined ? candidate.inlineContainer.new === undefined : candidate.inlineContainer.new === containerNew
        const sameOld = containerOld === undefined ? candidate.inlineContainer.old === undefined : candidate.inlineContainer.old === containerOld
        if (!sameNew || !sameOld) break
        group.push(candidate)
        end++
      }
      renderInlineContainerGroupDouble(group, fresh, baseline)
      index = end
      continue
    }
    if (isInlineUnitBlock(block)) {
      const end = inlineUnitGroupEnd(model.blocks, index)
      const group = model.blocks.slice(index, end)
      renderInlineUnitGroupDouble(
        group,
        treeBlockElements(group[0]!, baseline, 'old')[0],
        treeBlockElements(group[0]!, fresh, 'new')[0],
      )
      index = end
      continue
    }
    if (block.invisible.length > 0) {
      drawInvisible(block)
      index++
      continue
    }
    const freshElements = treeBlockElements(block, fresh, 'new')
    const oldElements = treeBlockElements(block, baseline, 'old')
    if (block.merged) {
      for (const element of oldElements) markChangedBlock(element, block.index, 'del')
      for (const element of freshElements) markChangedBlock(element, block.index, 'add')
      index++
      continue
    }
    if (block.units.length === 0) {
      for (const element of oldElements) {
        markChangedUnit(element, block.index, 'del')
        stampBlock(element, block.index, 'del')
      }
      for (const element of freshElements) {
        markChangedUnit(element, block.index, 'add')
        stampBlock(element, block.index, 'add')
      }
      index++
      continue
    }
    const unitIndex = block.units[0]!.index
    if (block.kind === 'table_cell') {
      // A changed table cell is its own block: each column draws only that cell's runs/twins.
      const { next, previous } = tableCellElements(block, freshElements, oldElements)
      if (next === undefined || previous === undefined) {
        if (next !== undefined) markChangedBlock(next, block.index, 'add')
        if (previous !== undefined) markChangedBlock(previous, block.index, 'del')
      } else {
        renderInlineUnitGroupDouble([block], previous, next)
        const unit = block.units[0]
        const drawnNew = next.querySelector(`[data-md-block="${block.index}"]`) !== null
          || next.getAttribute('data-md-block') === String(block.index)
        const drawnOld = previous.querySelector(`[data-md-block="${block.index}"]`) !== null
          || previous.getAttribute('data-md-block') === String(block.index)
        if (unit !== undefined && !drawnNew) {
          markChangedUnit(next, unit.index, 'add')
          stampBlock(next, block.index, 'add')
          setMarkerLines(next, unit, 'old')
          setMarkerLines(next, unit, 'new')
        }
        if (unit !== undefined && !drawnOld) {
          markChangedUnit(previous, unit.index, 'del')
          stampBlock(previous, block.index, 'del')
        }
      }
      index++
      continue
    }
    if (block.kind === 'table_row' || block.kind === 'table_header') {
      const oldRowElement = oldElements.find(element => element.tagName === 'TR')
        ?? oldElements.find(element => element.closest('tr') !== null)?.closest('tr')
      const newRowElement = freshElements.find(element => element.tagName === 'TR')
        ?? freshElements.find(element => element.closest('tr') !== null)?.closest('tr')
      if (oldRowElement instanceof HTMLElement) stampBlock(oldRowElement, block.index, 'del')
      if (newRowElement instanceof HTMLElement) stampBlock(newRowElement, block.index, 'add')
      const oldCells = oldRowElement instanceof HTMLElement
        ? [...oldRowElement.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
        : []
      const newCells = newRowElement instanceof HTMLElement
        ? [...newRowElement.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
        : []
      let cellUnit = 0
      const drawnCellUnits = new Set<number>()
      const rowPairsDouble = oldRowElement instanceof HTMLElement && newRowElement instanceof HTMLElement
        ? changedElementPairs(oldRowElement, newRowElement, false)
        : []
      for (let column = 0; column < Math.min(oldCells.length, newCells.length); column++) {
        const oldCell = oldCells[column]!
        const newCell = newCells[column]!
        if (shownText(oldCell) === shownText(newCell)) continue
        const unit = block.units[cellUnit] ?? block.units[0]!
        cellUnit++
        drawSideRuns(oldCell, newCell, block, unit.index)
        drawnCellUnits.add(unit.index)
      }
      // An invisible inline change of the row (a retargeted link inside a cell) gets its own side's tint per column.
      if (oldRowElement instanceof HTMLElement && newRowElement instanceof HTMLElement) {
        const twinUnits = block.units
          .filter(unit => !drawnCellUnits.has(unit.index))
          .map(unit => ({ blockIndex: block.index, unit }))
        if (twinUnits.length > 0) twinHiddenInlineUnitsDouble(twinUnits, oldRowElement, newRowElement, rowPairsDouble)
      }
      index++
      continue
    }
    if (oldElements[0] !== undefined && freshElements[0] !== undefined) {
      drawSideRuns(oldElements[0], freshElements[0], block, unitIndex)
      index++
      continue
    }
    for (const element of oldElements) markChangedUnit(element, unitIndex, 'del')
    for (const element of freshElements) markChangedUnit(element, unitIndex, 'add')
    index++
  }
  // Adjacent fully-matched top-level siblings become ONE layout row (the user's merge rule applied to the
  // double column's row layout); the blocks themselves are unchanged and still read as the document's blocks.
  ensureTreeBlocksReachable(fresh.root, model.blocks, baseline.root)
  const plan = planMergedSiblings(matchMarkdownTrees(oldText, newText).ops)
  wrapTreeContextRuns({ old: baseline.root, new: fresh.root }, plan)
  captionHiddenPairs(fresh.root, labels?.invisible)
  captionHiddenPairs(baseline.root, labels?.invisible)
  return renderAlignedDocuments(baseline.root, fresh.root)
}

/** The tree path's blocks, adapted to the panel's `PreviewBlock` shape. */
export function treePreviewBlocks(oldText: string, newText: string): PreviewBlock[] {
  return treePreviewModel(oldText, newText).blocks as unknown as PreviewBlock[]
}

