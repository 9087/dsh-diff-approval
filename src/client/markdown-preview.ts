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
 *  Both styles emit the same contract the panel's anchoring already reads: `data-md-block` /
 *  `data-md-kind` on every element that carries a change block, plus `mdAdd` / `mdDel` for the tint and
 *  `mdWordAdd` / `mdWordDel` for the changed characters inside one element.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { diffArrays, diffChars } from 'diff'
import type { WholeFileDiff } from './whole-file-diff.ts'
import { blockRangesOf, changeBlocksOf, computeWholeFileDiff, intraRunsOf } from './whole-file-diff.ts'
import type { IntraRun } from './whole-file-diff.ts'

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
 * One change the PREVIEW numbers on its own.
 *
 * The source view's blocks are lines, but a rendered document puts several changes on one line: a table row
 * holds a reworded cell AND a retargeted link, and each is a separate thing to look at and to keep. So the
 * preview cuts each line block into its character-level changes — the unit the toolbar counts, the hover
 * frame frames, and the keep/revert acts on (see the optional character spans in `DiffApprovalBlockRange`).
 */
export interface PreviewUnit {
  /** Index in the preview's own numbering: the `data-md-block` value and the toolbar's number. */
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
export function previewUnits(oldText: string, newText: string): PreviewUnit[] {
  const diff = computeWholeFileDiff(oldText, newText)
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const offsetOfLine = (lines: readonly string[], line: number): number => {
    let offset = 0
    const upTo = Math.min(Math.max(line - 1, 0), lines.length)
    for (let index = 0; index < upTo; index++) offset += (lines[index]?.length ?? 0) + 1
    return offset
  }
  const units: PreviewUnit[] = []
  /** The changed source lines of each line block, for the no-rendering fold at the end. */
  const changedLines = new Map<number, { old: number[]; new: number[] }>()
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
    const fold = list.length > 1 && lines !== undefined &&
      lines.old.every(line => hiddenOld[line - 1] === true) &&
      lines.new.every(line => hiddenNew[line - 1] === true)
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

/** One unit's character-level change inside a block's segments. */
interface CharRun {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
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
  for (const run of raw) {
    const previous = merged[merged.length - 1]
    // Runs are folded when they are a word or two apart ON THE SAME LINE. A line boundary is never folded
    // over — neither in the gap between runs nor inside a run being folded in: a retargeted link on one line
    // and a deleted paragraph below it are two changes, one hover target each and each keepable on its own,
    // not one unit that happens to span both.
    const foldable = previous !== undefined
      && run.oldStart - previous.oldEnd <= UNIT_GAP
      && run.newStart - previous.newEnd <= UNIT_GAP
      && !oldSegment.slice(previous.oldStart, run.oldEnd).includes('\n')
      && !newSegment.slice(previous.newStart, run.newEnd).includes('\n')
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

/**
 * The unit behind a change of an element's own attributes (a link's target, an image's source).
 *
 * @param units - the block's units.
 * @param previous - the old element.
 * @param next - the new element.
 * @returns the unit's index, or undefined when no unit claims the changed value.
 */
function unitIndexForShell(units: readonly PreviewUnit[], previous: HTMLElement, next: HTMLElement): number | undefined {
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
      const exact = units.find(unit => unit.oldText !== '' && unit.newText !== ''
        && before.includes(unit.oldText) && after.includes(unit.newText))
      if (exact !== undefined) return exact.index
      const loose = units.find(unit => unit.newText !== '' && after.includes(unit.newText))
      if (loose !== undefined) return loose.index
    }
  }
  return undefined
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
    let match: number | undefined
    for (let index = cursor; index < units.length; index++) {
      const unit = units[index]
      if (unit === undefined || !unitCarriesText(unit, run.textContent ?? '', side)) continue
      // One unit drawn on both sides: its struck run and its added run are the SAME unit, so the other side
      // may match it again. The same side twice means the match belongs to the next unit.
      if (index === current && lastSide === side) continue
      match = index
      break
    }
    // The match is a POSITION in this block's unit list; the tag is the UNIT's own number (its index in the
    // preview's numbering, which the list need not start at).
    const unit = match === undefined ? undefined : units[match]
    const index = unit?.index ?? fallback
    if (match !== undefined) {
      current = match
      cursor = Math.max(cursor, match)
      lastSide = side
    }
    run.dataset.mdBlock = String(index)
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
    children.forEach((child, index) => {
      const entry = tokens[index]
      if (entry !== undefined) collectSourceElements(child, entry, span, out, lines)
    })
    return
  }
  stampSource(el, lines, span.start, span.end)
  out.push({ el, start: span.start, end: span.end })
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
  const rendered = maskFrontMatter(text)
  const root = document.createElement('div')
  root.innerHTML = DOMPurify.sanitize(marked.parse(rendered, { async: false }) as string)
  const elements: SourceElement[] = []
  const tokens = marked.lexer(rendered) as unknown as MdToken[]
  const starts = lineStartsOf(rendered)
  // The ORIGINAL lines, so an element's stamped source is the document the reader is diffing (the front
  // matter's own text included, which is what a dot's hover text shows).
  const lines = text.split('\n')
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
    const span = spanOf(starts, at, raw)
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

/** Mark one element as carrying change block `index` on one side. */
/**
 * Stamp an element as belonging to a change block, without tinting it.
 *
 * A block's place is what the preview's hover frame and its keep/revert toolbar anchor to, and that is
 * wanted even when the element itself is not tinted: a paragraph whose words were merged in place carries
 * word runs, not a background wash.
 */
function markBlock(el: HTMLElement, index: number, kind: 'add' | 'del'): void {
  el.dataset.mdBlock = String(index)
  el.dataset.mdKind = kind
}

/** Stamp an element as a changed BLOCK: its own surface is tinted, for a whole added or deleted element. */
function markChanged(el: HTMLElement, index: number, kind: 'add' | 'del'): void {
  el.classList.add(kind === 'add' ? 'mdAdd' : 'mdDel')
  markBlock(el, index, kind)
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
    const attrs = block === undefined ? '' : ` data-md-block="${block}" data-md-kind="${side}"`
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
  let cursor = start
  while (cursor < end) {
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
    const localEnd = Math.min(node.data.length, localStart + (end - cursor))
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
 * Elements whose two versions are merged word by word only when the change is genuinely INLINE.
 *
 * The line diff pairs two LINES, so a one-line bullet that kept its opening words and then grew ten times
 * longer is still "one changed line" to the diff. Merging that pair word by word would bury the old sentence
 * inside a wall of new text — one endless paragraph. Those blocks stand as a replacement instead: the old
 * block struck above the new one. Cells and other purely inline carriers keep the merge either way.
 */
const INLINE_EDIT_GUARD = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD'])

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
  markBlock(struck, index, 'del')
  markBlock(added, index, 'add')
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
  markBlock(holder, index, kind)
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
 * @returns what was placed, which decides whether the block-level fallback marker is still needed.
 */
function mergeBlock(
  freshRoot: HTMLElement,
  newElements: readonly SourceElement[],
  oldElements: readonly SourceElement[],
  index: number,
  units: readonly PreviewUnit[] = [],
): MergeOutcome {
  // The preview numbers UNITS, not lines: one line can hold two changes, and each keeps its own number.
  const block = units[0]?.index ?? index
  let visible = false
  let syntaxOnly = false
  /** Hosts already drawn as a ghost: two deleted cells of one row are ONE deleted row. */
  const ghosted = new Set<HTMLElement>()
  /** Insert a ghost into a container so it reads in source order (before the element that replaced it). */
  const insertBySpan = (container: Element, ghost: HTMLElement, start: number): void => {
    // `>=` so a REPLACEMENT's struck side lands before the element that now occupies the same line.
    const next = [...container.children].find(child => Number((child as HTMLElement).dataset.srcStart ?? Number.MAX_SAFE_INTEGER) >= start)
    container.insertBefore(ghost, next ?? null)
  }
  const ghostOf = (previous: SourceElement, beside: HTMLElement | undefined): void => {
    // A deleted cell is drawn as its whole ROW, and a deleted item as the item itself: cloning a bare cell
    // would place a `<td>` outside any table, which renders as nothing at all.
    const host = (previous.el.closest('tr, li') as HTMLElement | null) ?? previous.el
    if (ghosted.has(host)) return
    ghosted.add(host)
    const ghost = host.cloneNode(true) as HTMLElement
    markChanged(ghost, unitIndexForText(units, previous.el.dataset.srcText ?? '', 'del') ?? block, 'del')
    const start = Number(host.dataset.srcStart ?? previous.start)
    if (host.tagName === 'TR') {
      const body = freshRoot.querySelector('tbody') ?? freshRoot.querySelector('table')
      if (body !== null) {
        insertBySpan(body, ghost, start)
        visible = true
        return
      }
    }
    if (host.tagName === 'LI') {
      const list = freshRoot.querySelector('ul, ol')
      if (list !== null) {
        insertBySpan(list, ghost, start)
        visible = true
        return
      }
    }
    const anchor = beside === undefined ? insertionPointFor(freshRoot, start) : ghostAnchor(beside)
    anchor.parent.insertBefore(ghost, anchor.before)
    visible = true
  }
  const pairs = Math.min(newElements.length, oldElements.length)
  for (let step = 0; step < pairs; step++) {
    const next = newElements[step]
    const previous = oldElements[step]
    if (next === undefined || previous === undefined) continue
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
      // A pure-syntax edit — same element, same attributes, same structure, written differently — is not
      // shown: seeing `**x**` spelled `__x__` spelled out helps nobody.
      if ((before ?? '') !== (after ?? '')
        && structureFingerprint(next.el) !== structureFingerprint(previous.el)) {
        // The rendering is the same; the element's own ATTRIBUTES are not. Draw both versions side by side —
        // the old tinted red on the left, the new tinted green on the right — and carry the source
        // difference for the toolbar to show on hover (see `applyTwin`).
        const changed = changedElementPairs(previous.el, next.el, true)
        twinPairs(changed, units, unitIndexForShell(units, previous.el, next.el) ?? block)
        visible = true
      } else {
        syntaxOnly = true
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
      if (isInlineEdit(previous.el, next.el) && mergeInlineText(next.el, previous.el)) {
        // Each drawn run names its OWN unit — and the RUNS, not the element, are the hover targets: the
        // element's unchanged words must not raise a toolbar (see `tagRuns`).
        tagRuns(next.el, units, block)
        visible = true
        // The words merged, but a change in a descendant's own ATTRIBUTES has no rendering of its own: it is
        // drawn as that element's two versions side by side, with its source difference on hover.
        if (shellPairs.length > 0) twinPairs(shellPairs, units, block)
        continue
      }
    }
    // Not inline-mergeable: the new side keeps its own formatting, the old side stands beside it.
    markChanged(next.el, block, 'add')
    visible = true
    ghostOf(previous, next.el)
  }
  // Anything left on the old side was deleted; anything left on the new side was added. A leftover deletion
  // goes where its OWN source lines sit (not beside the first paired element): the deleted paragraph under a
  // retargeted link follows the link, because that is the order the source is in.
  for (let step = pairs; step < oldElements.length; step++) {
    const previous = oldElements[step]
    if (previous !== undefined) ghostOf(previous, undefined)
  }
  for (let step = pairs; step < newElements.length; step++) {
    const next = newElements[step]
    if (next === undefined) continue
    markChanged(next.el, unitIndexForText(units, next.el.dataset.srcText ?? '', 'add') ?? block, 'add')
    visible = true
  }
  if (visible) return 'visible'
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
  markBlock(wrapper, index, 'add')
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
 * A change with NO rendered element at all — a front-matter line, an HTML comment: two modest blocks, red for
 * what went and green for what came, with the changed source carried for the toolbar. A pure insertion has no
 * red block, a pure deletion no green one.
 *
 * @param index - the change unit's number.
 * @param oldLine - the removed source line, when there is one.
 * @param newLine - the added source line, when there is one.
 * @param grammar - the grammar the toolbar highlights these lines with.
 * @returns the twin.
 */
function placeholderTwin(
  index: number,
  oldLine: string | undefined,
  newLine: string | undefined,
  grammar: SourceGrammar = 'markdown',
): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'mdTwin mdTwinPhantom'
  markBlock(wrapper, index, 'add')
  setSourceDiff(wrapper, {
    ...(oldLine !== undefined ? { old: oldLine } : {}),
    ...(newLine !== undefined ? { new: newLine } : {}),
  }, undefined, grammar)
  const oldSide = blockSide('old')
  const newSide = blockSide('new')
  if (oldLine === undefined) oldSide.hidden = true
  if (newLine === undefined) newSide.hidden = true
  wrapper.append(oldSide, newSide)
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
 */
function sideTwin(element: HTMLElement, side: 'old' | 'new', index: number, hidden: boolean): void {
  const row = hidden ? { [side === 'old' ? 'old' : 'new']: sourceOfElement(element) } : undefined
  if (element instanceof HTMLImageElement) {
    const holder = sideOf(side, imageFrame(element))
    holder.classList.add('mdTwinColumn')
    markBlock(holder, index, side === 'old' ? 'del' : 'add')
    setSourceDiff(holder, row, side)
    element.replaceWith(holder)
    return
  }
  markChanged(element, index, side === 'old' ? 'del' : 'add')
  setSourceDiff(element, row, side)
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
 * @returns whether anything was drawn.
 */
function twinPairs(pairs: readonly [HTMLElement, HTMLElement][], units: readonly PreviewUnit[], fallback: number): boolean {
  let drawn = false
  for (const [oldEl, newEl] of pairs) {
    if (!isAttached(newEl)) continue
    const index = unitIndexForShell(units, oldEl, newEl) ?? fallback
    const hidden = hasHiddenDiff(oldEl, newEl)
    if (!applyTwin(oldEl, newEl, index, hidden)) {
      markBlock(newEl, index, 'add')
      // The element itself carries the change: its row is its whole source on each side.
      if (hidden) setSourceDiff(newEl, { old: sourceOfElement(oldEl), new: sourceOfElement(newEl) })
    }
    drawn = true
  }
  return drawn
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
 */
function insertCardInSourceOrder(root: HTMLElement, marker: HTMLElement, span: BlockSpan): void {
  const line = (span.new ?? span.old)?.start ?? 0
  const next = [...root.children].find(child => {
    // Only a documented block has a line to compare against; a marker placed earlier has none.
    const raw = (child as HTMLElement).dataset.srcStart
    return raw !== undefined && Number(raw) >= line
  })
  if (next === undefined) root.appendChild(marker)
  else root.insertBefore(marker, next)
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
  const units = previewUnits(oldText, newText)
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
  for (const unit of units) {
    const list = unitsOfBlock.get(unit.lineBlock) ?? []
    list.push(unit)
    unitsOfBlock.set(unit.lineBlock, list)
  }
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  interface Entry { index: number; span: BlockSpan; freshEls: SourceElement[]; oldEls: SourceElement[] }
  const entries: Entry[] = [...spans.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, span]) => ({
      index,
      span,
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
    // The one element carrying several changes could not be merged: stand a pair of modest blocks per unit
    // beside it, so each change keeps its number and its source line on hover.
    for (const unit of unitsOfBlock.get(first.index) ?? []) {
      const twin = placeholderTwin(
        unit.index,
        unitSourceLines(oldText, first.span.old, unit.oldChars),
        unitSourceLines(newText, first.span.new, unit.newChars),
      )
      el.parentNode?.insertBefore(twin, el.nextSibling)
    }
  }

  /** Blocks whose whole difference is spelling: they are shown as nothing, and their units stay unreachable. */
  const syntaxBlocks = new Set<number>()
  for (const entry of entries) {
    // An element carrying several blocks was already handled above.
    if (entry.freshEls.length === 1 && (owners.get(entry.freshEls[0]!.el)?.length ?? 0) > 1) continue
    const blockUnits = unitsOfBlock.get(entry.index) ?? []
    const outcome = mergeBlock(fresh.root, entry.freshEls, entry.oldEls, entry.index, blockUnits)
    if (outcome === 'syntax') syntaxBlocks.add(entry.index)
    if (outcome !== 'none') continue
    // Nothing rendered on either side: an HTML comment, a front-matter line. Each UNIT becomes its own pair of
    // modest blocks — the red block is that side's line(s), the green one the other side's — placed where the
    // block sits, and hovering them shows the changed source in the toolbar. Per unit, so two changed lines are
    // two numbered changes; and BOTH sides of a unit are shown whenever that side of the block exists, so an
    // appended value (`title: A` → `title: A v2`) reads as a removed line and an added one, like the source.
    const anchor = entry.freshEls[0]?.el
    for (const unit of blockUnits) {
      const twin = placeholderTwin(
        unit.index,
        unitSourceLines(oldText, entry.span.old, unit.oldChars),
        unitSourceLines(newText, entry.span.new, unit.newChars),
        grammarOf(unit),
      )
      if (anchor !== undefined) anchor.parentNode?.insertBefore(twin, anchor.nextSibling)
      else insertCardInSourceOrder(fresh.root, twin, entry.span)
    }
  }
  // Every unit must be REACHABLE. A merge can leave one unplaced on its own — an HTML comment sharing a line
  // block with a deleted paragraph is handled as part of that block's ghost, and its own unit would otherwise
  // have no element at all (hoverable nowhere, never keepable from the preview, while the numbering still
  // counts it). A marker pair at the unit's own lines keeps the numbering honest.
  const untaggedUnits = units.filter(unit =>
    !syntaxBlocks.has(unit.lineBlock) && fresh.root.querySelector(`[data-md-block="${unit.index}"]`) === null)
  for (const unit of untaggedUnits) {
    const span = spans.get(unit.lineBlock)
    if (span === undefined) continue
    // Only a side that actually CARRIES this unit's characters is drawn: an inserted word has no old line to
    // show, and a marker for it would name a change the old document does not have.
    const oldLine = unit.oldText === '' ? undefined : unitSourceLines(oldText, span.old, unit.oldChars)
    const newLine = unit.newText === '' ? undefined : unitSourceLines(newText, span.new, unit.newChars)
    if (oldLine === undefined && newLine === undefined) continue
    const twin = placeholderTwin(unit.index, oldLine, newLine, grammarOf(unit))
    insertCardInSourceOrder(fresh.root, twin, span)
  }
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
  const units = previewUnits(oldText, newText)
  const oldFrontMatter = frontMatterLineCount(oldText)
  const newFrontMatter = frontMatterLineCount(newText)
  /** A no-rendering block's source is YAML when it is front matter, Markdown otherwise. */
  const grammarOf = (unit: PreviewUnit): SourceGrammar =>
    unit.oldLines.start <= oldFrontMatter || unit.newLines.start <= newFrontMatter ? 'yaml' : 'markdown'
  /** The units cut from one source-line block, in order. */
  const unitsOfBlock = new Map<number, PreviewUnit[]>()
  for (const unit of units) {
    const list = unitsOfBlock.get(unit.lineBlock) ?? []
    list.push(unit)
    unitsOfBlock.set(unit.lineBlock, list)
  }
  const fresh = renderAnnotated(newText)
  const baseline = renderAnnotated(oldText)
  /** Blocks whose whole difference is spelling: they are shown as nothing, and their units stay unreachable. */
  const syntaxBlocks = new Set<number>()
  for (const [index, span] of [...spans.entries()].sort((left, right) => left[0] - right[0])) {
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
          // right — and the source difference behind the change rides on it for the toolbar's hover row.
          for (const [oldEl, newEl] of changedElementPairs(previous.el, next.el, true)) {
            const unit = unitIndexForShell(blockUnits, oldEl, newEl) ?? primary
            const hidden = hasHiddenDiff(oldEl, newEl)
            if (isAttached(oldEl)) sideTwin(oldEl, 'old', unit, hidden)
            if (isAttached(newEl)) sideTwin(newEl, 'new', unit, hidden)
          }
          continue
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
        markChanged(next.el, primary, 'add')
        markChanged(previous.el, primary, 'del')
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
        // element itself is the change, in its own column — unless nothing changed in it at all.
        if (oldOwnText === newOwnText && !shellChanged) continue
        markChanged(next.el, primary, 'add')
        markChanged(previous.el, primary, 'del')
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
      // treatment, with the whole source of that side on hover.
      for (const [oldEl, newEl] of shellPairs) {
        const unit = unitIndexForShell(blockUnits, oldEl, newEl) ?? primary
        const hidden = hasHiddenDiff(oldEl, newEl)
        if (isAttached(oldEl)) sideTwin(oldEl, 'old', unit, hidden)
        if (isAttached(newEl)) sideTwin(newEl, 'new', unit, hidden)
      }
    }
    for (let step = pairs; step < oldElements.length; step++) {
      const previous = oldElements[step]
      if (previous !== undefined) {
        markChanged(previous.el, unitIndexForText(blockUnits, previous.el.dataset.srcText ?? '', 'del') ?? primary, 'del')
      }
    }
    for (let step = pairs; step < freshElements.length; step++) {
      const next = freshElements[step]
      if (next !== undefined) {
        markChanged(next.el, unitIndexForText(blockUnits, next.el.dataset.srcText ?? '', 'add') ?? primary, 'add')
      }
    }
    // A block that renders to nothing (front matter, an HTML comment) must still be reachable in BOTH
    // columns: one modest block per unit on each side — the before column's own line(s) and the after
    // column's — with the changed source carried for the toolbar's hover row.
    if (freshElements.length === 0 && oldElements.length === 0) {
      for (const unit of blockUnits) {
        const oldLine = unitSourceLines(oldText, span.old, unit.oldChars)
        const newLine = unitSourceLines(newText, span.new, unit.newChars)
        const grammar = grammarOf(unit)
        insertCardInSourceOrder(baseline.root, placeholderTwin(unit.index, oldLine, undefined, grammar), span)
        insertCardInSourceOrder(fresh.root, placeholderTwin(unit.index, undefined, newLine, grammar), span)
      }
    }
  }
  // The same REACHABILITY net as the single column, per side: a unit with no element in a column (an HTML
  // comment sharing a line block with a deleted paragraph) gets its marker in that column, so every number is
  // hoverable and keepable in the double view too.
  const ensureReachable = (root: HTMLElement, side: 'old' | 'new'): void => {
    for (const unit of units) {
      if (syntaxBlocks.has(unit.lineBlock)) continue
      if (root.querySelector(`[data-md-block="${unit.index}"]`) !== null) continue
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
        insertCardInSourceOrder(root, placeholderTwin(unit.index, line, undefined, grammar), span)
      } else {
        if (unit.newText === '') continue
        const line = unitSourceLines(newText, span.new, unit.newChars)
        if (line === undefined) continue
        insertCardInSourceOrder(root, placeholderTwin(unit.index, undefined, line, grammar), span)
      }
    }
  }
  ensureReachable(baseline.root, 'old')
  ensureReachable(fresh.root, 'new')
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
function captionHiddenPairs(root: HTMLElement, label: string | undefined): void {
  if (label === undefined || label === '') return
  for (const pair of root.querySelectorAll<HTMLElement>('.mdTwinPhantom')) {
    const caption = document.createElement('span')
    caption.className = 'mdTwinCaption'
    caption.setAttribute('data-md-twin-caption', '')
    caption.textContent = label
    pair.append(caption)
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
    return mode === 'single' ? renderMerged(oldText, newText, labels?.invisible) : renderDocuments(oldText, newText, labels?.invisible)
  }
  if (mode === 'single') {
    const runs = diffRuns(oldText, newText)
    return runs.map(renderBlock).join('')
  }
  const rows = alignedDoubleRows(diffRuns(oldText, newText))
  return `<div class="mdDouble">${rows.map(renderDoubleRow).join('')}</div>`
}
