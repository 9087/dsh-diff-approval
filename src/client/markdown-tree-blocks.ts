/**
 * Tree-first preview MODEL: the merge plan (see `markdown-tree-match.ts`) turned into the two things the
 * preview numbers and draws — UNITS (character-level changes, the highlights) and BLOCKS (what the reader
 * counts, hovers, keeps and reverts).
 *
 * This replaces the line-diff-derived model (`previewUnits` + `previewBlocks` in markdown-preview.ts) for the
 * tree path. The rules are the user's confirmed merge policy:
 *
 *  - a fully-matched subtree is context: it is never a unit and never a block;
 *  - an edit is blocked at its changed block-level node (paragraph, heading, list item, table row, code fence,
 *    rule) and its units are the character changes inside it;
 *  - adjacent pure additions (or deletions) at one level merge into ONE block (the whole new file is one block,
 *    apart from invisible content, which becomes an eye-icon block at its document position);
 *  - a table: a changed header row is one block (with per-cell units); each changed body row is one block; a
 *    row that exists on one side only is a whole-row block (rule B); matched rows produce nothing;
 *  - a list whose container changed but whose items match is ONE container block; changed items are item blocks;
 *  - a code fence with any changed line or a changed language is ONE block, whose units are the changed lines;
 *  - an invisible change (front matter, HTML comment, link definition) is a block of its own, flagged
 *    `invisible`, carrying its source for the eye-icon marker at that position.
 */
import { diffChars } from 'diff'
import { computeWholeFileDiff, intraRunsOf, type WholeFileDiffRow } from './whole-file-diff.ts'
import {
  matchMarkdownTrees,
  nodeVisibleText,
  pairFullyMatched,
  planMergedSiblings,
  tableRowRuns,
  textSimilarity,
  type MarkdownTreeNode,
  type MergePlanPiece,
  type TreeMatchOp,
  type TreeMatchPair,
} from './markdown-tree-match.ts'

/** One character-level change: what the preview highlights. Mirrors `PreviewUnit` in markdown-preview.ts. */
export interface TreePreviewUnit {
  index: number
  /** Kept for source-view compatibility; the tree path has no line hunks, so this is the block's index. */
  lineBlock: number
  oldLines: { start: number; end: number }
  newLines: { start: number; end: number }
  oldChars: { start: number; end: number }
  newChars: { start: number; end: number }
  oldText: string
  newText: string
}

/** A change the rendering cannot show: mirrors `PreviewInvisibleDiff` in markdown-preview.ts. */
export interface TreePreviewInvisibleDiff {
  oldLines?: { start: number; end: number }
  newLines?: { start: number; end: number }
  oldText?: string
  newText?: string
  grammar: 'markdown' | 'yaml'
}

/** One difference block: mirrors `PreviewBlock` in markdown-preview.ts, plus the tree nodes it came from. */
export interface TreePreviewBlock {
  index: number
  lineBlock: number
  units: TreePreviewUnit[]
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  oldChars?: { start: number; end: number }
  newChars?: { start: number; end: number }
  merged: boolean
  wholeRow?: 'add' | 'del'
  invisible: TreePreviewInvisibleDiff[]
  /** The block's own kind, for the renderer and tests (`paragraph`, `list_item`, `table_row`, `code`, …). */
  kind: string
  /** A `table_cell` block's column: which cell of its row it covers. */
  cellColumn?: number
  /**
   * For an INLINE-CHILD block (a text run, a changed link/strong/image inside a paragraph/cell/item): the
   * container pair whose rendered element hosts the change. The block never owns the container element
   * itself, so blocks cannot nest inside each other.
   */
  inlineContainer?: { old?: MarkdownTreeNode; new?: MarkdownTreeNode }
  /** The old-side nodes this block covers (empty for a pure addition). */
  oldNodes: MarkdownTreeNode[]
  /** The new-side nodes this block covers (empty for a pure deletion). */
  newNodes: MarkdownTreeNode[]
}

/** The tree path's whole model: units in reading order, and blocks in document order. */
export interface TreePreviewModel {
  blocks: TreePreviewBlock[]
  units: TreePreviewUnit[]
}

/** A character-level change not yet numbered: the raw material of one unit. */
interface RawUnit {
  oldText: string
  newText: string
  oldLines: { start: number; end: number }
  newLines: { start: number; end: number }
  oldChars: { start: number; end: number }
  newChars: { start: number; end: number }
}

/** A block being assembled, before its index and unit list are fixed. */
interface PendingBlock {
  kind: string
  oldNodes: MarkdownTreeNode[]
  newNodes: MarkdownTreeNode[]
  units: RawUnit[]
  invisible: TreePreviewInvisibleDiff[]
  merged: boolean
  wholeRow?: 'add' | 'del'
  /** For a merged pure group: the nodes' union line ranges decide old/new ranges. */
  pure?: 'old' | 'new'
  /** A `table_cell` block's column: which cell of its row it covers. */
  cellColumn?: number
  /** See `TreePreviewBlock.inlineContainer`. */
  inlineContainer?: { old?: MarkdownTreeNode; new?: MarkdownTreeNode }
}

/** Unchanged characters still folded into one unit: a space or two inside a reworded phrase. */
const UNIT_GAP = 3

/** Whether a string is one Markdown style token on both sides (`**加粗**`, `_斜体_`, `~~x~~`). */
function isMarkdownMarkerToken(oldText: string, newText: string): boolean {
  const one = (text: string): boolean => text.length > 2 && /^(\*\*\*|\*\*|\*|___|__|_|~~|`)[^\n]*\1$/.test(text)
  return one(oldText) && one(newText)
}

/**
 * The character-level change runs between two pieces of leaf source, with near neighbours folded together.
 *
 * The same rules as the line path (`charChangeRuns` in markdown-preview.ts): a run is a word swap or an
 * insertion; runs a word or two apart on one line fold together, except when the gap holds WORDS (then they are
 * two edits). A marker-only re-spelling (`**x**` → `__x__`) folds however long the styled words are.
 */
function changeRuns(oldSegment: string, newSegment: string): { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] {
  const raw: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] = []
  let oldPosition = 0
  let newPosition = 0
  let pending: { oldStart: number; oldEnd: number; newStart: number; newEnd: number } | undefined
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
  const merged: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] = []
  const wordsIn = (gap: string): boolean => /[\p{L}\p{N}]/u.test(gap)
  const markupOnly = (run: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }): boolean => !/[\p{L}\p{N}]/u.test(
    oldSegment.slice(run.oldStart, run.oldEnd) + newSegment.slice(run.newStart, run.newEnd),
  )
  for (const run of raw) {
    const previous = merged[merged.length - 1]
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

/** The units one matched leaf's character changes become. */
function leafUnits(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): RawUnit[] {
  const runs = changeRuns(oldNode.raw, newNode.raw)
  return runs.map(run => ({
    oldText: oldNode.raw.slice(run.oldStart, run.oldEnd),
    newText: newNode.raw.slice(run.newStart, run.newEnd),
    oldLines: oldNode.lines,
    newLines: newNode.lines,
    oldChars: { start: oldNode.start + run.oldStart, end: oldNode.start + run.oldEnd },
    newChars: { start: newNode.start + run.newStart, end: newNode.start + run.newEnd },
  }))
}

/** One whole node as a unit (a re-spelled inline style, a changed heading level, an added inline token). */
function wholeNodeUnit(node: MarkdownTreeNode, side: 'old' | 'new' | 'both', other?: MarkdownTreeNode): RawUnit {
  if (side === 'old') return { oldText: node.raw, newText: '', oldLines: node.lines, newLines: node.lines, oldChars: { start: node.start, end: node.end }, newChars: { start: node.start, end: node.start } }
  if (side === 'new') return { oldText: '', newText: node.raw, oldLines: node.lines, newLines: node.lines, oldChars: { start: node.start, end: node.start }, newChars: { start: node.start, end: node.end } }
  const peer = other ?? node
  return {
    oldText: node.raw,
    newText: peer.raw,
    oldLines: node.lines,
    newLines: peer.lines,
    oldChars: { start: node.start, end: node.end },
    newChars: { start: peer.start, end: peer.end },
  }
}

/** Text similarity under which a type-matched block pair is not an edit of one text but a replacement. */
const UNRELATED_PAIR_SIMILARITY_MIN = 0.2

/** Block-level node types whose changes are INLINE: one block per change inside them. */
const INLINE_BLOCK_TYPES = new Set(['paragraph', 'heading', 'list_item'])

/** Node types that are STRUCTURE inside a list item: their changes are blocks of their own, never flattened. */
const STRUCTURAL_TYPES = new Set(['list', 'blockquote', 'code', 'table', 'html', 'hr', 'def', 'front_matter'])

/** Inline node types whose rendered ELEMENT can be twinned as the change itself. */
const INLINE_ELEMENT_TYPES = new Set(['strong', 'em', 'link', 'codespan', 'image', 'del', 'ins', 'escape', 'checkbox'])

/**
 * Whether a type-matched pair is really a deletion plus an addition the tree merely laid side by side: the outer
 * node types agree, but their visible texts share almost nothing. Such a pair is drawn as a whole replacement
 * (old above new) rather than diffed character by character — the user's rule 6 carried into the tree path.
 */
function pairIsUnrelated(pair: TreeMatchPair): boolean {
  if (!['paragraph', 'heading', 'list_item', 'table_row', 'table_cell', 'blockquote'].includes(pair.old.type)) return false
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()
  const oldText = normalize(nodeVisibleText(pair.old))
  const newText = normalize(nodeVisibleText(pair.new))
  if (oldText === '' || newText === '') return false
  return textSimilarity(oldText, newText) < UNRELATED_PAIR_SIMILARITY_MIN
}

/** Whether one text pair's changes can be drawn as separate word runs (the renderer's own alignment). */
function textRunsSeparable(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): boolean {
  const oldText = nodeVisibleText(oldNode)
  const newText = nodeVisibleText(newNode)
  if (oldText.trim() === '' || newText.trim() === '') return true
  return intraRunsOf(oldText, newText) !== undefined
}

/** Whether a pair's own attributes differ (heading level, fence language, list style, link target, …). */
function pairAttributesDiffer(pair: TreeMatchPair): boolean {
  const keys = new Set([...Object.keys(pair.old.attrs), ...Object.keys(pair.new.attrs)])
  for (const key of keys) if (pair.old.attrs[key] !== pair.new.attrs[key]) return true
  if (pair.old.raw !== pair.new.raw && pair.old.children.length > 0) {
    // The source differs beyond the children (a list's marker style, a heading's hashes): still a change of the
    // container itself, unless a child difference already accounts for it.
    const oldText = nodeVisibleText(pair.old)
    const newText = nodeVisibleText(pair.new)
    if (oldText === newText && !pair.exact) return true
  }
  return false
}

/** Collect the units inside one changed pair, in reading order. */
function collectUnits(inner: readonly MergePlanPiece[], pair: TreeMatchPair, fallback = true): RawUnit[] {
  const units: RawUnit[] = []
  for (const piece of inner) {
    if (piece.kind === 'context' || piece.invisible === true) continue
    if (piece.pure !== undefined) {
      const op = piece.op
      if (op !== undefined && op.kind !== 'pair') units.push(wholeNodeUnit(op.node, op.kind === 'oldOnly' ? 'old' : 'new'))
      continue
    }
    const op = piece.op
    if (op === undefined || op.kind !== 'pair') continue
    const child = op.pair
    const childInner = piece.inner ?? []
    if (child.old.type === 'table_cell' || child.old.type === 'table_row') {
      const nested = collectUnits(childInner, child)
      if (nested.length > 0) units.push(...nested)
      else units.push(wholeNodeUnit(child.old, 'both', child.new))
      continue
    }
    if (childInner.length > 0) {
      const nested = collectUnits(childInner, child)
      if (nested.length > 0) units.push(...nested)
      else if (pairAttributesDiffer(child)) units.push(wholeNodeUnit(child.old, 'both', child.new))
      continue
    }
    if (!pairFullyMatched(child)) {
      // A leaf or attribute-only change: character runs inside its own source when it has text, else one unit.
      if (child.old.children.length === 0 && child.new.children.length === 0) {
        const runs = leafUnits(child.old, child.new)
        if (runs.length > 0) units.push(...runs)
        else units.push(wholeNodeUnit(child.old, 'both', child.new))
      } else {
        units.push(wholeNodeUnit(child.old, 'both', child.new))
      }
    }
  }
  // A container whose only difference is its own attributes (heading level, list marker style, link target):
  // its children are all context, so the container itself is the unit.
  if (fallback && units.length === 0 && inner.length > 0 && !pairFullyMatched(pair)) {
    units.push(wholeNodeUnit(pair.old, 'both', pair.new))
  }
  return units
}

/** The 1-based line range covering a set of nodes. */
function unionLines(nodes: readonly MarkdownTreeNode[], side: 'old' | 'new'): { start: number; end: number } | undefined {
  let start = Number.POSITIVE_INFINITY
  let end = -1
  for (const node of nodes) {
    start = Math.min(start, node.lines.start)
    end = Math.max(end, node.lines.end)
  }
  void side
  return end >= 0 ? { start, end } : undefined
}

/** The block builder: turns the merge plan into blocks, with the reading-order position bookkeeping. */
class BlockBuilder {
  readonly blocks: PendingBlock[] = []
  readonly oldLines: string[]
  readonly newLines: string[]

  constructor(oldText: string, newText: string) {
    this.oldLines = oldText.split('\n')
    this.newLines = newText.split('\n')
  }

  /** Add a finished block. */
  push(block: PendingBlock): void {
    this.blocks.push(block)
  }

  /** A pair that is its own block (paragraph, heading, list item, rule, …). */
  pairBlock(piece: MergePlanPiece): void {
    const op = piece.op
    if (op === undefined || op.kind !== 'pair') return
    const pair = op.pair
    const inner = piece.inner ?? []
    if (pair.old.type === 'table') {
      this.tableBlocks(pair, inner)
      return
    }
    if (pair.old.type === 'list') {
      this.listBlocks(pair, inner)
      return
    }
    if (pair.old.type === 'blockquote') {
      this.walk(inner)
      return
    }
    if (pair.old.type === 'code') {
      this.codeBlocks(pair, inner)
      return
    }
    if (pair.old.type === 'html') {
      this.blockWithUnits(pair.old.type, [pair.old], [pair.new], collectUnits(inner, pair))
      return
    }
    if (pairIsUnrelated(pair)) {
      // Rule 6: an unrelated type-matched pair is a whole replacement, not a character-level edit.
      this.push({ kind: pair.old.type, oldNodes: [pair.old], newNodes: [pair.new], units: [], invisible: [], merged: true })
      return
    }
    if (INLINE_BLOCK_TYPES.has(pair.old.type)) {
      // A paragraph/heading/list item is a container of inline changes: the matcher already aligned its inline
      // children, so each changed CHILD becomes its own block. Blocks stay disjoint (no block owns the container
      // element around another block), in tree order.
      this.inlineChildBlocks(pair, inner)
      return
    }
    this.blockWithUnits(pair.old.type, [pair.old], [pair.new], collectUnits(inner, pair))
  }

  /**
   * The blocks of one INLINE container (paragraph/heading/list item/cell).
   *
   * One block per changed inline child or text run: the container element itself is never a block carrier, so
   * a block can never contain (and a hover never includes) a sibling block. Order is the children's tree order.
   *
   * @param pair - the container pair.
   * @param pieces - the plan of its inline children.
   */
  inlineChildBlocks(pair: TreeMatchPair, pieces: readonly MergePlanPiece[], allowContainerFallback = true): void {
    let emitted = 0
    let pureOld: MarkdownTreeNode[] = []
    let pureNew: MarkdownTreeNode[] = []
    const pushBlock = (kind: string, oldNodes: MarkdownTreeNode[], newNodes: MarkdownTreeNode[], units: RawUnit[]): void => {
      this.push({
        kind,
        oldNodes,
        newNodes,
        units,
        invisible: [],
        merged: false,
        inlineContainer: { old: pair.old, new: pair.new },
      })
      emitted++
    }
    const flushPure = (): void => {
      if (pureOld.length === 0 && pureNew.length === 0) return
      pushBlock('inline', pureOld, pureNew, [])
      pureOld = []
      pureNew = []
    }
    const pushUnits = (kind: string, oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode, units: RawUnit[]): void => {
      for (const unit of units) {
        if (unit.oldText === unit.newText) continue
        // A whitespace-only run is not a reader-visible change: it is what a Markdown marker respelling leaves
        // behind (the element's own block carries that change).
        if (unit.oldText.trim() === '' && unit.newText.trim() === '') continue
        if (unit.oldText.trim() === unit.newText.trim()) continue
        pushBlock(kind, [oldNode], [newNode], [unit])
      }
    }
    for (const piece of pieces) {
      if (piece.invisible === true) {
        flushPure()
        this.invisibleBlock(piece)
        continue
      }
      if (piece.kind === 'context') {
        flushPure()
        for (const op of piece.ops ?? []) {
          if (op.kind !== 'pair') continue
          const oldNode = op.pair.old
          const newNode = op.pair.new
          if (oldNode.type !== newNode.type || !INLINE_ELEMENT_TYPES.has(oldNode.type)) continue
          if (oldNode.raw === newNode.raw) continue
          // The rendering looks identical (`**x**` → `__x__`): ONE element block, drawn as its red/green pair.
          if (nodeVisibleText(oldNode) !== nodeVisibleText(newNode)) continue
          pushBlock(oldNode.type, [oldNode], [newNode], [])
        }
        continue
      }
      const op = piece.op
      if (op === undefined) continue
      if (op.kind === 'oldOnly') {
        pureOld.push(op.node)
        continue
      }
      if (op.kind === 'newOnly') {
        pureNew.push(op.node)
        continue
      }
      flushPure()
      const oldNode = op.pair.old
      const newNode = op.pair.new
      if (oldNode.type === 'text' && newNode.type === 'text') {
        const units = collectUnits([piece], op.pair)
        // A rewritten sentence cannot be split into word runs: keep it ONE block (drawn as the whole line),
        // instead of one block per char run that the renderer could only draw as duplicate lines.
        if (units.length > 1 && !textRunsSeparable(oldNode, newNode)) {
          pushBlock('text', [oldNode], [newNode], units)
          continue
        }
        pushUnits('text', oldNode, newNode, units)
        continue
      }
      if (oldNode.type === newNode.type && INLINE_ELEMENT_TYPES.has(oldNode.type)) {
        // A LINK is compared as ONE whole: any difference in its text (or target) draws the complete old link
        // and the complete new link in red/green — never word runs inside the link's text.
        if (oldNode.type === 'link') {
          pushBlock('link', [oldNode], [newNode], [])
          continue
        }
        // ONE block for the element, however many word runs its text has: the element is the drawer, and two
        // blocks on the same element would fight over it (the second one ended up nested in the first twin).
        const units = collectUnits(piece.inner ?? [], op.pair)
          .filter(unit => unit.oldText !== unit.newText)
          .filter(unit => unit.oldText.trim() !== '' || unit.newText.trim() !== '')
        pushBlock(oldNode.type, [oldNode], [newNode], units)
        continue
      }
      // A link that became literal text (or the reverse): one replacement block, never a container tint.
      pushBlock('inline', [oldNode], [newNode], [])
    }
    flushPure()
    // Nothing inline changed visibly: the container's own syntax is the difference.
    if (allowContainerFallback && emitted === 0 && (pair.old.raw !== pair.new.raw || pairAttributesDiffer(pair))) {
      this.blockWithUnits(pair.old.type, [pair.old], [pair.new], collectUnits(pieces, pair))
    }
  }

  /**
   * A code fence: one block per contiguous run of changed LINES.
   *
   * Two edits on lines that are not adjacent are two blocks — a hover frames only its own line, not the whole
   * fence. Adjacent changed lines stay one block (the reader sees them as one edit).
   */
  codeBlocks(pair: TreeMatchPair, pieces: readonly MergePlanPiece[]): void {
    // DIFFERENT fence languages: the two fences are not the same kind of code, so line-by-line comparison would
    // be meaningless. The whole fence pair is one replacement block (old version shown red, new version green),
    // and the language itself is an invisible difference carried as the source of that block.
    const oldLanguage = String(pair.old.attrs.lang ?? '')
    const newLanguage = String(pair.new.attrs.lang ?? '')
    if (oldLanguage !== newLanguage) {
      this.push({ kind: 'code', oldNodes: [pair.old], newNodes: [pair.new], units: [], invisible: [], merged: true })
      return
    }
    let run: RawUnit[] = []
    let lineChanged = false
    const flush = (): void => {
      if (!lineChanged || run.length === 0) {
        run = []
        lineChanged = false
        return
      }
      this.push({
        kind: 'code',
        oldNodes: [pair.old],
        newNodes: [pair.new],
        units: run,
        invisible: [],
        merged: false,
        inlineContainer: { old: pair.old, new: pair.new },
      })
      run = []
      lineChanged = false
    }
    for (const piece of pieces) {
      if (piece.kind === 'context') {
        flush()
        continue
      }
      if (piece.invisible === true) {
        flush()
        this.invisibleBlock(piece)
        continue
      }
      lineChanged = true
      run.push(...this.unitsOf(piece))
    }
    flush()
    // Language / fence syntax only: the fence itself is the block.
    if (!pieces.some(piece => piece.kind === 'diff' && piece.invisible !== true) && pairAttributesDiffer(pair)) {
      this.blockWithUnits('code', [pair.old], [pair.new], [])
    }
  }

  /** A table: header row blocks, then body row blocks. */
  tableBlocks(pair: TreeMatchPair, inner: readonly MergePlanPiece[]): void {
    const runs = tableRowRuns(pair)
    const headerDiff = runs.header.merged ? [] : inner.filter(piece => piece.kind === 'diff' && this.nodeOf(piece)?.old.type === 'table_cell')
    if (headerDiff.length > 0) {
      const oldCells = headerDiff.flatMap(piece => this.oldNodesOf(piece))
      const newCells = headerDiff.flatMap(piece => this.newNodesOf(piece))
      this.blockWithUnits('table_header', oldCells, newCells, headerDiff.flatMap(piece => this.unitsOf(piece)))
    }
    let pureGroup: PendingBlock | undefined
    const flush = (): void => {
      if (pureGroup !== undefined) {
        this.push(pureGroup)
        pureGroup = undefined
      }
    }
    for (const piece of inner) {
      if (piece.kind === 'context') continue
      const node = this.nodeOf(piece)
      if (node === undefined) continue
      const isRow = node.old.type === 'table_row'
      const isHeaderCell = node.old.type === 'table_cell' && node.old.attrs.header === true
      if (isHeaderCell) continue
      // A row that exists on one side only: a whole-row block (rule B). Adjacent pure rows merge into one block.
      if (piece.pure !== undefined) {
        const side = piece.pure
        if (pureGroup !== undefined && pureGroup.pure === side) {
          pureGroup.oldNodes.push(...this.oldNodesOf(piece))
          pureGroup.newNodes.push(...this.newNodesOf(piece))
          pureGroup.units.push(...this.unitsOf(piece))
          continue
        }
        flush()
        pureGroup = {
          kind: 'table_row',
          oldNodes: this.oldNodesOf(piece),
          newNodes: this.newNodesOf(piece),
          units: [],
          invisible: [],
          merged: true,
          wholeRow: side === 'old' ? 'del' : 'add',
          pure: side,
        }
        continue
      }
      flush()
      if (!isRow) {
        // A cell diff outside its row (a column structure change): keep it as its own block.
        this.blockWithUnits('table_cell', this.oldNodesOf(piece), this.newNodesOf(piece), this.unitsOf(piece))
        continue
      }
      const pair = piece.op?.kind === 'pair' ? piece.op.pair : undefined
      if (pair !== undefined && pairIsUnrelated(pair)) {
        // An unrelated "paired" row is really a deleted row plus an added one: draw it as a replacement row.
        this.push({ kind: 'table_row', oldNodes: [pair.old], newNodes: [pair.new], units: [], invisible: [], merged: true })
        continue
      }
      // A changed row is ONE BLOCK PER CHANGED CELL: the cells are separate rendered boxes, so two cells that
      // both changed are two hover/keep targets — never one frame around the whole row (the reported case:
      // "旧/新" in one cell and the retargeted link in another must not merge because they are not adjacent).
      const cellDiffs = (piece.inner ?? []).filter(innerPiece =>
        innerPiece.kind === 'diff' && this.nodeOf(innerPiece)?.old.type === 'table_cell')
      if (cellDiffs.length > 0) {
        for (const cellPiece of cellDiffs) {
          const cellPair = cellPiece.op?.kind === 'pair' ? cellPiece.op.pair : undefined
          if (cellPair === undefined) {
            this.blockWithUnits('table_cell', this.oldNodesOf(cellPiece), this.newNodesOf(cellPiece), this.unitsOf(cellPiece))
            continue
          }
          this.inlineChildBlocks(cellPair, cellPiece.inner ?? [])
        }
        continue
      }
      this.blockWithUnits('table_row', this.oldNodesOf(piece), this.newNodesOf(piece), this.unitsOf(piece))
    }
    flush()
    // The table's own structure changed (column alignment, header/column count) while no row difference was
    // planned: the table is one difference block of its own.
    const hadRowDiffs = inner.some(piece => piece.kind === 'diff' && this.nodeOf(piece)?.old.type === 'table_row')
    if (!hadRowDiffs && headerDiff.length === 0 && pairAttributesDiffer(pair)) {
      this.blockWithUnits('table', [pair.old], [pair.new], [])
    }
  }

  /** A list: item blocks, or one container block when only the container changed. */
  listBlocks(pair: TreeMatchPair, inner: readonly MergePlanPiece[]): void {
    const itemDiffs = inner.filter(piece => piece.kind === 'diff' && this.nodeOf(piece)?.old.type === 'list_item')
    const otherDiffs = inner.filter(piece => piece.kind === 'diff' && this.nodeOf(piece)?.old.type !== 'list_item')
    const attrsChanged = pairAttributesDiffer(pair)
    if (itemDiffs.length === 0 && otherDiffs.length === 0) {
      // Nothing inside changed, only the list itself (style, numbering): one container block.
      if (attrsChanged) this.blockWithUnits('list', [pair.old], [pair.new], [])
      return
    }
    let pureGroup: PendingBlock | undefined
    const flush = (): void => {
      if (pureGroup !== undefined) {
        this.push(pureGroup)
        pureGroup = undefined
      }
    }
    for (const piece of inner) {
      if (piece.kind === 'context') continue
      const node = this.nodeOf(piece)
      if (node === undefined) continue
      if (node.old.type !== 'list_item') {
        // A nested structure inside the item (a nested list, a blockquote): recurse; its own blocks appear at
        // their document positions.
        this.walk([piece])
        continue
      }
      if (piece.pure !== undefined) {
        const side = piece.pure
        if (pureGroup !== undefined && pureGroup.pure === side) {
          pureGroup.oldNodes.push(...this.oldNodesOf(piece))
          pureGroup.newNodes.push(...this.newNodesOf(piece))
          pureGroup.units.push(...this.unitsOf(piece))
          continue
        }
        flush()
        pureGroup = { kind: 'list_item', oldNodes: this.oldNodesOf(piece), newNodes: this.newNodesOf(piece), units: [], invisible: [], merged: true, pure: side }
        continue
      }
      flush()
      const pair = piece.op?.kind === 'pair' ? piece.op.pair : undefined
      if (pair !== undefined && pairIsUnrelated(pair)) {
        this.push({ kind: 'list_item', oldNodes: [pair.old], newNodes: [pair.new], units: [], invisible: [], merged: true })
        continue
      }
      if (pair !== undefined) {
        // An item's own TEXT is an inline change (one block per inline child); a nested list/quote/code block
        // inside it is STRUCTURE: it must become blocks of its own where it sits, never be flattened into the
        // item's inline unit — flattening it would tint the whole list item green for a change deep inside it.
        const structural: MergePlanPiece[] = []
        const inline: MergePlanPiece[] = []
        for (const innerPiece of piece.inner ?? []) {
          if (innerPiece.invisible === true) {
            structural.push(innerPiece)
            continue
          }
          const innerNode = this.nodeOf(innerPiece)
          if (innerNode !== undefined && STRUCTURAL_TYPES.has(innerNode.old.type)) structural.push(innerPiece)
          else inline.push(innerPiece)
        }
        this.inlineChildBlocks(pair, inline, structural.length === 0)
        for (const innerPiece of structural) {
          if (innerPiece.invisible === true) this.invisibleBlock(innerPiece)
          else this.walk([innerPiece])
        }
        continue
      }
      this.blockWithUnits('list_item', this.oldNodesOf(piece), this.newNodesOf(piece), this.unitsOf(piece))
    }
    flush()
  }

  /** A block covering one or more whole nodes, with its units. */
  blockWithUnits(kind: string, oldNodes: MarkdownTreeNode[], newNodes: MarkdownTreeNode[], units: RawUnit[], cellColumn?: number): void {
    if (oldNodes.length === 0 && newNodes.length === 0) return
    this.push({ kind, oldNodes, newNodes, units, invisible: [], merged: false, ...(cellColumn !== undefined ? { cellColumn } : {}) })
  }

  /**
   * One block per INLINE change of a block-level node (a paragraph/heading/list item/cell).
   *
   * Two reworded words separated by unchanged text are two changes the reader can hover and keep on their own
   * — they must not be folded into one block just because the same paragraph renders them. Only changes that
   * the character diff already folded together (nothing unchanged between them) share a unit, and a block that
   * has exactly one unit is left as one block.
   */
  inlineBlocks(kind: string, oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode, units: RawUnit[], cellColumn?: number): void {
    if (units.length <= 1) {
      this.blockWithUnits(kind, [oldNode], [newNode], units, cellColumn)
      return
    }
    for (const unit of units) {
      this.push({
        kind,
        oldNodes: [oldNode],
        newNodes: [newNode],
        units: [unit],
        invisible: [],
        merged: false,
        ...(cellColumn !== undefined ? { cellColumn } : {}),
      })
    }
  }

  /** Add a block containing only invisible content (front matter, a comment, a link definition). */
  invisibleBlock(piece: MergePlanPiece): void {
    const op = piece.op
    if (op === undefined) return
    const oldNode = op.kind === 'pair' ? op.pair.old : (op.kind === 'oldOnly' ? op.node : undefined)
    const newNode = op.kind === 'pair' ? op.pair.new : (op.kind === 'newOnly' ? op.node : undefined)
    const grammar: 'markdown' | 'yaml' = (oldNode ?? newNode)?.type === 'front_matter' ? 'yaml' : 'markdown'
    this.push({
      kind: 'invisible',
      oldNodes: oldNode === undefined ? [] : [oldNode],
      newNodes: newNode === undefined ? [] : [newNode],
      units: [],
      invisible: [{
        ...(oldNode !== undefined ? { oldLines: oldNode.lines, oldText: oldNode.raw } : {}),
        ...(newNode !== undefined ? { newLines: newNode.lines, newText: newNode.raw } : {}),
        grammar,
      }],
      merged: op.kind !== 'pair',
      ...(op.kind === 'oldOnly' ? { pure: 'old' as const } : op.kind === 'newOnly' ? { pure: 'new' as const } : {}),
    })
  }

  /** Add one merged PURE block for consecutive one-sided nodes. */
  pureBlock(pieces: readonly MergePlanPiece[]): void {
    if (pieces.length === 0) return
    const oldNodes = pieces.flatMap(piece => this.oldNodesOf(piece))
    const newNodes = pieces.flatMap(piece => this.newNodesOf(piece))
    const side = pieces[0]!.pure!
    const wholeRow = oldNodes.some(node => node.type === 'table_row') || newNodes.some(node => node.type === 'table_row')
    this.push({
      kind: pieces.some(piece => this.nodeOf(piece)?.new.type === 'list_item') ? 'list_item' : 'node',
      oldNodes,
      newNodes,
      units: [],
      invisible: [],
      merged: true,
      pure: side,
      ...(wholeRow ? { wholeRow: side === 'old' ? 'del' : 'add' as const } : {}),
    })
  }

  /** Plan one tree level: context is skipped, invisible changes are their own blocks, pure runs merge. */
  walk(pieces: readonly MergePlanPiece[]): void {
    let pure: MergePlanPiece[] = []
    const flushPure = (): void => {
      if (pure.length > 0) this.pureBlock(pure)
      pure = []
    }
    for (const piece of pieces) {
      if (piece.kind === 'context') continue
      if (piece.invisible === true) {
        flushPure()
        this.invisibleBlock(piece)
        continue
      }
      if (piece.pure !== undefined) {
        if (pure.length > 0 && pure[0]!.pure !== piece.pure) flushPure()
        pure.push(piece)
        continue
      }
      flushPure()
      this.pairBlock(piece)
    }
    flushPure()
  }

  /** The op behind a diff piece. */
  nodeOf(piece: MergePlanPiece): { old: MarkdownTreeNode; new: MarkdownTreeNode } | undefined {
    const op = piece.op
    if (op === undefined) return undefined
    if (op.kind === 'pair') return { old: op.pair.old, new: op.pair.new }
    if (op.kind === 'oldOnly') return { old: op.node, new: op.node }
    return { old: op.node, new: op.node }
  }

  /** The old-side nodes of a piece (a one-sided addition has none). */
  oldNodesOf(piece: MergePlanPiece): MarkdownTreeNode[] {
    const op = piece.op
    if (op === undefined) return []
    if (op.kind === 'pair') return [op.pair.old]
    return op.kind === 'oldOnly' ? [op.node] : []
  }

  /** The new-side nodes of a piece (a one-sided deletion has none). */
  newNodesOf(piece: MergePlanPiece): MarkdownTreeNode[] {
    const op = piece.op
    if (op === undefined) return []
    if (op.kind === 'pair') return [op.pair.new]
    return op.kind === 'newOnly' ? [op.node] : []
  }

  /** The units of a diff piece. */
  unitsOf(piece: MergePlanPiece): RawUnit[] {
    const op = piece.op
    if (op === undefined) return []
    if (op.kind !== 'pair') {
      const node = op.node
      return [wholeNodeUnit(node, op.kind === 'oldOnly' ? 'old' : 'new')]
    }
    const inner = piece.inner ?? []
    // A leaf pair with no children of its own (a code line is the clearest case) still changed: its whole
    // spelling on both sides is the unit.
    if (inner.length === 0 && !pairFullyMatched(op.pair)) return [wholeNodeUnit(op.pair.old, 'both', op.pair.new)]
    return collectUnits(inner, op.pair)
  }
}

/**
 * The line on the OTHER side before which a one-sided block inserts its content.
 *
 * For a new-side block at `line`, walk the line diff's rows until the new line is reached and remember the last
 * old line seen: the block inserts before that old line's successor. Symmetrically for a deleted block.
 */
function insertionAnchor(rows: readonly WholeFileDiffRow[], side: 'old' | 'new', line: number): number {
  let lastOther = 0
  for (const row of rows) {
    const mine = side === 'old' ? row.oldLine : row.newLine
    const other = side === 'old' ? row.newLine : row.oldLine
    if (mine !== undefined && mine >= line) break
    if (other !== undefined) lastOther = other
  }
  return lastOther + 1
}

/** One top-level match op's node pair: the scope a source-fallback block covers. */
interface SourceOwner {
  old?: MarkdownTreeNode | undefined
  new?: MarkdownTreeNode | undefined
}

/**
 * Whether a node contains content the rendered preview cannot faithfully show:
 *  - raw HTML (a block, or an inline `<strong class=…>` whose attribute is not drawn), including comments;
 *  - front matter / link reference definitions, which render nothing at all.
 *
 * Such a scope degrades to a source twin (old Markdown above new Markdown) instead of structured tinting.
 */
function nodeNeedsSourceFallback(node: MarkdownTreeNode): boolean {
  if (node.type === 'html' || node.type === 'front_matter' || node.type === 'def') return true
  return node.children.some(child => nodeNeedsSourceFallback(child))
}

/** A block whose whole reading is its Markdown source: old source above new source, one block. */
function sourceFallbackBlock(oldNodes: MarkdownTreeNode[], newNodes: MarkdownTreeNode[]): PendingBlock {
  return { kind: 'source', oldNodes, newNodes, units: [], invisible: [], merged: false }
}

/** The top-level owners of the match, in document order. */
function sourceOwners(ops: readonly TreeMatchOp[]): SourceOwner[] {
  return ops.map(op => {
    if (op.kind === 'pair') return { old: op.pair.old, new: op.pair.new }
    if (op.kind === 'oldOnly') return { old: op.node }
    return { new: op.node }
  })
}

/** The owner index of one node (char ranges nest inside their top-level owner). */
function ownerOfNode(owners: readonly SourceOwner[], node: MarkdownTreeNode, side: 'old' | 'new'): number {
  for (let index = 0; index < owners.length; index++) {
    const owner = side === 'old' ? owners[index]!.old : owners[index]!.new
    if (owner !== undefined && owner.start <= node.start && node.end <= owner.end) return index
  }
  return -1
}

/** The owner index of one block, judged by its first old-side (else new-side) node. */
function ownerOfBlock(owners: readonly SourceOwner[], block: PendingBlock): number {
  const oldNode = block.oldNodes[0]
  if (oldNode !== undefined) {
    const index = ownerOfNode(owners, oldNode, 'old')
    if (index >= 0) return index
  }
  const newNode = block.newNodes[0]
  return newNode === undefined ? -1 : ownerOfNode(owners, newNode, 'new')
}

/**
 * Split a MERGED pure run so its HTML/invisible nodes become source twins of their own and the rest stays the
 * continuous tint it was: a wholly new document whose comments are mixed in keeps its green body, with each
 * comment shown as source at its place.
 *
 * @param block - the merged block.
 * @returns one block per consecutive run of same-fallback nodes.
 */
function splitMergedSourceFallback(block: PendingBlock): PendingBlock[] {
  const side: 'old' | 'new' | undefined = block.oldNodes.length > 0 && block.newNodes.length === 0
    ? 'old'
    : block.newNodes.length > 0 && block.oldNodes.length === 0 ? 'new' : undefined
  if (side === undefined) {
    const nodes = [...block.oldNodes, ...block.newNodes]
    if (!nodes.some(node => nodeNeedsSourceFallback(node))) return [block]
    return [sourceFallbackBlock(block.oldNodes, block.newNodes)]
  }
  const nodes = side === 'old' ? block.oldNodes : block.newNodes
  const parts: PendingBlock[] = []
  let run: MarkdownTreeNode[] = []
  let runFallback: boolean | undefined
  const flush = (): void => {
    if (run.length === 0) return
    if (runFallback === true) parts.push(sourceFallbackBlock(side === 'old' ? run : [], side === 'new' ? run : []))
    else parts.push({ ...block, ...(side === 'old' ? { oldNodes: run, newNodes: [] } : { oldNodes: [], newNodes: run }) })
    run = []
  }
  for (const node of nodes) {
    const fallback = nodeNeedsSourceFallback(node)
    if (runFallback === undefined) runFallback = fallback
    if (fallback !== runFallback) {
      flush()
      runFallback = fallback
    }
    run.push(node)
  }
  flush()
  return parts
}

/**
 * Degrade HTML-bearing and invisible-only scopes to whole-source twins.
 *
 * A block scope that contains raw HTML (inline or block), or that renders nothing at all (front matter, comment,
 * link definition), is shown as its Markdown source: old version above the new one. This replaces the old
 * eye-icon chips, which readers found too cryptic.
 *
 * @param blocks - the builder's blocks, in document order.
 * @param ops - the top-level match ops (the source scopes).
 * @returns the final blocks, source twins where needed.
 */
function applySourceFallbacks(blocks: readonly PendingBlock[], ops: readonly TreeMatchOp[]): PendingBlock[] {
  const owners = sourceOwners(ops)
  const needsFallback = (node: MarkdownTreeNode | undefined): boolean => node !== undefined && nodeNeedsSourceFallback(node)
  const active = owners.some(owner => needsFallback(owner.old) || needsFallback(owner.new))
    || blocks.some(block => block.invisible.length > 0
      || [...block.oldNodes, ...block.newNodes].some(node => nodeNeedsSourceFallback(node)))
  if (!active) return [...blocks]
  // A merged run may mix plain blocks and HTML/invisible nodes: split it before scoping.
  const flat = blocks.flatMap(block => (
    block.oldNodes.length > 1 || block.newNodes.length > 1 ? splitMergedSourceFallback(block) : [block]
  ))
  const result: PendingBlock[] = []
  for (let index = 0; index < flat.length;) {
    const block = flat[index]!
    if (block.kind === 'source' || block.invisible.length > 0) {
      result.push(block.kind === 'source' ? block : sourceFallbackBlock(block.oldNodes, block.newNodes))
      index++
      continue
    }
    // Merged runs that were not split keep their tint unless they contain HTML; those were split above.
    if (block.oldNodes.length > 1 || block.newNodes.length > 1) {
      result.push(...splitMergedSourceFallback(block))
      index++
      continue
    }
    const ownerIndex = ownerOfBlock(owners, block)
    if (ownerIndex < 0) {
      result.push(block)
      index++
      continue
    }
    const owner = owners[ownerIndex]!
    if (!needsFallback(owner.old) && !needsFallback(owner.new)) {
      result.push(block)
      index++
      continue
    }
    // All blocks of this top-level scope are ONE source twin.
    let end = index + 1
    while (end < flat.length && ownerOfBlock(owners, flat[end]!) === ownerIndex) end++
    result.push(sourceFallbackBlock(owner.old === undefined ? [] : [owner.old], owner.new === undefined ? [] : [owner.new]))
    index = end
  }
  return result
}

/**
 * Compute the tree path's preview model for one document pair.
 *
 * @param oldText - the baseline.
 * @param newText - the current content.
 * @returns the blocks (document order) and their units, with 1-based line ranges for keep/revert.
 */
export function treePreviewModel(oldText: string, newText: string): TreePreviewModel {
  const result = matchMarkdownTrees(oldText, newText)
  const builder = new BlockBuilder(oldText, newText)
  builder.walk(planMergedSiblings(result.ops))
  // Raw HTML / invisible-only scopes are shown as whole Markdown source twins (see applySourceFallbacks).
  const pending = applySourceFallbacks(builder.blocks, result.ops)
  // Number the blocks and lay out their units. Ranges: a block with both sides uses the nodes' own lines; a
  // one-sided block keeps its own side and gets an EMPTY range on the other side whose start is the insertion
  // point (the host inserts before that line).
  // The line diff supplies the one-sided blocks' insertion points: a new-side block inserts before the old line
  // after the last old line that precedes it; a deleted block inserts before the new line at its old position.
  const diff = computeWholeFileDiff(oldText, newText)
  const units: TreePreviewUnit[] = []
  const blocks: TreePreviewBlock[] = pending.map((block, index) => {
    const oldSpan = unionLines(block.oldNodes, 'old')
    const newSpan = unionLines(block.newNodes, 'new')
    let oldStart: number
    let oldEnd: number
    let newStart: number
    let newEnd: number
    const oldOnly = block.oldNodes.length > 0 && block.newNodes.length === 0
    const newOnly = block.newNodes.length > 0 && block.oldNodes.length === 0
    if (block.pure === 'new' || (!oldOnly && newOnly)) {
      newStart = newSpan?.start ?? 1
      newEnd = newSpan?.end ?? Math.max(0, newStart - 1)
      const at = insertionAnchor(diff.rows, 'new', newStart)
      oldStart = at
      oldEnd = at - 1
    } else if (block.pure === 'old' || (oldOnly && !newOnly)) {
      oldStart = oldSpan?.start ?? 1
      oldEnd = oldSpan?.end ?? Math.max(0, oldStart - 1)
      const at = insertionAnchor(diff.rows, 'old', oldStart)
      newStart = at
      newEnd = at - 1
    } else {
      oldStart = oldSpan?.start ?? 1
      oldEnd = oldSpan?.end ?? Math.max(0, oldStart - 1)
      newStart = newSpan?.start ?? 1
      newEnd = newSpan?.end ?? Math.max(0, newStart - 1)
    }
    const blockUnits: TreePreviewUnit[] = block.units.map(unit => {
      const entry: TreePreviewUnit = {
        index: units.length,
        lineBlock: index,
        oldLines: unit.oldLines,
        newLines: unit.newLines,
        oldChars: unit.oldChars,
        newChars: unit.newChars,
        oldText: unit.oldText,
        newText: unit.newText,
      }
      units.push(entry)
      return entry
    })
    const single = blockUnits.length === 1 ? blockUnits[0] : undefined
    const chars = single !== undefined && block.invisible.length === 0
      ? { oldChars: single.oldChars, newChars: single.newChars }
      : {}
    return {
      index,
      lineBlock: index,
      units: blockUnits,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      ...chars,
      merged: block.merged,
      ...(block.wholeRow !== undefined ? { wholeRow: block.wholeRow } : {}),
      ...(block.cellColumn !== undefined ? { cellColumn: block.cellColumn } : {}),
      ...(block.inlineContainer !== undefined ? { inlineContainer: block.inlineContainer } : {}),
      invisible: block.invisible,
      kind: block.kind,
      oldNodes: block.oldNodes,
      newNodes: block.newNodes,
    }
  })
  return { blocks, units }
}
