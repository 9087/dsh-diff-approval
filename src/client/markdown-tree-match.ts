/**
 * Markdown SYNTAX-TREE matching — the first stage of a tree-first diff.
 *
 * The preview's older pipeline diffed LINES first and then tried to map the changed lines onto whatever
 * element the renderer happened to produce for them. That got the outer structure wrong whenever the same
 * source lines produced different shapes on the two sides (a table row inserted in the middle, a paragraph
 * deleted before a heading, a list item moved): positional line pairing does not know what the document IS.
 *
 * This module does the matching the way the document is built:
 *
 *   1. parse BOTH sides with `marked` into a token tree (headings, paragraphs, lists, tables, blockquotes,
 *      code fences, rules, HTML, and their inline tokens: text, emphasis, links, code spans, images);
 *   2. give every node its exact source span (absolute character offsets + 1-based lines) by locating each
 *      token's `raw` inside its parent;
 *   3. match the two trees OUTERMOST first: identical nodes (same type and same source) are anchors; nodes of
 *      the same TYPE are paired between those anchors by a similarity-weighted alignment (so an inserted
 *      paragraph/item/row leaves the existing ones matched instead of shifting everything);
 *   4. only for a TYPE-matched pair recurse into the children, with rules per node type (list items by their
 *      content, table rows by their cells, code lines, blockquote children, inline tokens), and
 *   5. report what could not be matched on either side as pure additions/deletions.
 *
 * The result is a match PLAN: which old node corresponds to which new node, and which nodes exist on one side
 * only, naturally ordered by the tree. A later stage turns matched leaf text into character-level change units
 * and groups them into the preview's difference blocks; the renderer then draws exactly those pairs.
 */
import { marked } from 'marked'

/** One node of a parsed Markdown document. */
export interface MarkdownTreeNode {
  /** Stable path inside the document (`0.2.1`), for debugging and tests. */
  id: string
  /** `marked`'s token type (`heading`, `paragraph`, `list_item`, `text`, …), or a synthetic one. */
  type: string
  /** The node's own SOURCE spelling (what was written), used for span and exact-match comparisons. */
  raw: string
  /** The node's plain text where the token has one (`text`, `code`, heading text, …). */
  text: string
  /** The token's own attributes: heading depth, fence language, link href/title, list style, cell align. */
  attrs: Record<string, string | number | boolean>
  children: MarkdownTreeNode[]
  /** Absolute character offsets into the side's source: `[start, end)`. */
  start: number
  end: number
  /** 1-based inclusive source lines the node covers. */
  lines: { start: number; end: number }
}

/** One matched old/new node pair. */
export interface TreeMatchPair {
  old: MarkdownTreeNode
  new: MarkdownTreeNode
  /** Same source spelling for the whole node: nothing changed at or under it. */
  exact: boolean
  /** How alike the two nodes' visible text is (1 = identical, 0 = nothing in common). */
  similarity: number
  /** The match operations inside the pair, in reading order. */
  children: TreeMatchOp[]
}

/** One alignment step: a pair, or a node that exists on one side only. */
export type TreeMatchOp =
  | { kind: 'pair'; pair: TreeMatchPair }
  | { kind: 'oldOnly'; node: MarkdownTreeNode }
  | { kind: 'newOnly'; node: MarkdownTreeNode }

/** The whole-document match. */
export interface TreeMatchResult {
  oldRoot: MarkdownTreeNode[]
  newRoot: MarkdownTreeNode[]
  /** The outermost alignment, in reading order. */
  ops: TreeMatchOp[]
}

/** What `flattenTreeMatch` returns: every pair and every one-sided node, pairs before their children. */
export interface FlatTreeMatch {
  pairs: TreeMatchPair[]
  oldOnly: MarkdownTreeNode[]
  newOnly: MarkdownTreeNode[]
}

/** Token types that render no visible text of their own: they are pure structure/spacing. */
const SPACING_TYPES = new Set(['space'])

/** Parent attribute names copied from a token onto its node (the rest are parser bookkeeping). */
const ATTR_KEYS = [
  'depth', 'lang', 'href', 'title', 'ordered', 'start', 'task', 'loose', 'align', 'header', 'block', 'pre',
] as const

/** How a document's source is split for offset→line lookups. */
interface SourceIndex {
  text: string
  lineStarts: number[]
}

/** Longest common subsequence of two small arrays, as index pairs. */
function lcsPairs<T>(left: readonly T[], right: readonly T[], same: (a: T, b: T) => boolean): [number, number][] {
  const rows = left.length
  const columns = right.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0))
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row]![column] = same(left[row]!, right[column]!)
        ? table[row + 1]![column + 1]! + 1
        : Math.max(table[row + 1]![column]!, table[row]![column + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let row = 0
  let column = 0
  while (row < rows && column < columns) {
    if (same(left[row]!, right[column]!)) {
      pairs.push([row, column])
      row++
      column++
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      row++
    } else {
      column++
    }
  }
  return pairs
}

/** Similarity of two pieces of visible text: longest common subsequence over the longer one (0..1). */
export function textSimilarity(left: string, right: string): number {
  if (left === right) return left === '' ? 1 : 1
  if (left === '' || right === '') return 0
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  let previous = new Uint16Array(shorter.length + 1)
  let current = new Uint16Array(shorter.length + 1)
  for (let row = 1; row <= longer.length; row++) {
    for (let column = 1; column <= shorter.length; column++) {
      current[column] = longer[row - 1] === shorter[column - 1]
        ? previous[column - 1]! + 1
        : Math.max(previous[column]!, current[column - 1]!)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[shorter.length]! / longer.length
}

/** Collapse runs of whitespace, for comparing what the reader sees rather than how it was wrapped. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The visible text a node contributes: inline text and code spans verbatim, containers by their children,
 * images by their alt, structure with no text (rules, comments) as `''`.
 */
export function nodeVisibleText(node: MarkdownTreeNode): string {
  switch (node.type) {
    case 'text':
      // A `text` token can be a wrapper around inline tokens (a list item's paragraph, say); its own `text`
      // then still holds the raw inline source, so the children are the visible words.
      return node.children.length > 0 ? node.children.map(child => nodeVisibleText(child)).join('') : node.text
    case 'codespan':
    case 'escape':
      return node.text
    case 'code':
      return node.text
    case 'image':
      return node.text
    case 'space':
      return ''
    case 'hr':
    case 'html':
      return ''
    default:
      return node.children.map(child => nodeVisibleText(child)).join('')
  }
}

/** The visible text of a node, whitespace-folded: what the preview's similarity compares. */
export function nodeMatchText(node: MarkdownTreeNode): string {
  return normalizeText(nodeVisibleText(node))
}

/** One side index for locating tokens in the source. */
function indexOfSource(text: string): SourceIndex {
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') lineStarts.push(index + 1)
  }
  return { text, lineStarts }
}

/** 1-based line of an absolute offset. */
function lineAt(index: SourceIndex, offset: number): number {
  let low = 0
  let high = index.lineStarts.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (index.lineStarts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

/** The span a node covers, given its start and raw length. */
function spanOf(index: SourceIndex, start: number, end: number): { lines: { start: number; end: number } } {
  return { lines: { start: lineAt(index, start), end: lineAt(index, Math.max(start, end - 1)) } }
}

/** A token is a plain object; this is the subset of `marked`'s token shape this matcher reads. */
interface TokenLike {
  type?: string
  raw?: string
  text?: string
  tokens?: TokenLike[]
  items?: TokenLike[]
  header?: TokenLike[]
  rows?: TokenLike[][]
  depth?: number
  lang?: string
  href?: string
  title?: string | null
  ordered?: boolean
  start?: number
  task?: boolean
  loose?: boolean
  align?: string[]
  headerRow?: boolean
  block?: boolean
  pre?: boolean
}

/** Locate one child's source inside its parent's source, from a moving cursor. */
function locateChild(parentRaw: string, parentStart: number, cursor: { at: number }, raw: string): number {
  const found = parentRaw.indexOf(raw, cursor.at)
  if (found !== -1) {
    cursor.at = found + raw.length
    return parentStart + found
  }
  const trimmed = raw.trim()
  if (trimmed !== '' && trimmed !== raw) {
    const again = parentRaw.indexOf(trimmed, 0)
    if (again !== -1) {
      cursor.at = again + trimmed.length
      return parentStart + again
    }
  }
  const position = parentStart + Math.min(cursor.at, parentRaw.length)
  cursor.at = Math.min(cursor.at + raw.length, parentRaw.length)
  return position
}

/** The attributes worth comparing for one token. */
function attrsOf(token: TokenLike): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {}
  for (const key of ATTR_KEYS) {
    const value = (token as Record<string, unknown>)[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[key] = value
      continue
    }
    // Table column alignment is an array of per-column strings: a property of the TABLE, not of a cell's text.
    if (key === 'align' && Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) {
      attrs.align = value.join(',')
    }
  }
  return attrs
}

/** Build the synthetic LINE children of a fenced code block (or an HTML block), so their text can be matched. */
function lineNodes(type: string, text: string, raw: string, start: number, index: SourceIndex, idBase: string): MarkdownTreeNode[] {
  const lines = text.split('\n')
  const cursor = { at: 0 }
  return lines.map((line, lineIndex) => {
    const found = locateChild(raw, start, cursor, line)
    const end = found + line.length
    return {
      id: `${idBase}.${lineIndex}`,
      type,
      raw: line,
      text: line,
      attrs: {},
      children: [],
      start: found,
      end,
      ...spanOf(index, found, end),
    }
  })
}

/** Build one node (and recursively its children) from a `marked` token. */
function buildNode(options: {
  token: TokenLike
  raw: string
  start: number
  id: string
  index: SourceIndex
}): MarkdownTreeNode {
  const { token, raw, start, id, index } = options
  const end = start + raw.length
  const type = typeof token.type === 'string' ? token.type : 'unknown'
  const node: MarkdownTreeNode = {
    id,
    type,
    raw,
    text: typeof token.text === 'string' ? token.text : '',
    attrs: attrsOf(token),
    children: [],
    start,
    end,
    ...spanOf(index, start, end),
  }
  const cursor = { at: 0 }
  /** The source position just after the last child located for real, so a fallback never searches backwards. */
  let absoluteCursor = start
  /**
   * Locate one child's source.
   *
   * `marked` strips the INDENTATION of a nested list from its `raw`, so a child raw found inside the parent's
   * raw can sit at a position that does not exist in the document (the second nested item's `- ` is two spaces
   * earlier in the raw than in the source). The position is therefore verified against the DOCUMENT text, and
   * when it does not match, the child is searched in the document from the previous child's own end — which is
   * where the indentation lives.
   */
  const childAt = (childRaw: string): number => {
    const approximate = locateChild(raw, start, cursor, childRaw)
    if (childRaw === '') return approximate
    if (index.text.startsWith(childRaw, approximate)) {
      absoluteCursor = Math.max(absoluteCursor, approximate + childRaw.length)
      return approximate
    }
    for (const needle of [childRaw, childRaw.trim()]) {
      if (needle === '') continue
      const found = index.text.indexOf(needle, absoluteCursor)
      if (found !== -1) {
        absoluteCursor = found + needle.length
        return found
      }
    }
    absoluteCursor = Math.max(absoluteCursor, approximate + childRaw.length)
    return approximate
  }
  const childId = (at: number): string => `${id}.${at}`

  if (type === 'table') {
    const cells: MarkdownTreeNode[] = []
    const buildCell = (cell: TokenLike, header: boolean): void => {
      const cellRaw = typeof cell.text === 'string' ? cell.text : ''
      const cellStart = cellRaw === '' ? start : childAt(cellRaw)
      const cellNode: MarkdownTreeNode = {
        id: childId(cells.length),
        type: 'table_cell',
        raw: cellRaw,
        text: typeof cell.text === 'string' ? cell.text : '',
        attrs: { ...attrsOf(cell), header },
        children: [],
        start: cellStart,
        end: cellStart + cellRaw.length,
        ...spanOf(index, cellStart, cellStart + cellRaw.length),
      }
      const inline = Array.isArray(cell.tokens) ? cell.tokens : []
      const cellCursor = { at: 0 }
      for (const [at, token2] of inline.entries()) {
        const inlineRaw = typeof token2.raw === 'string' ? token2.raw : (typeof token2.text === 'string' ? token2.text : '')
        const inlineStart = locateChild(cellRaw, cellStart, cellCursor, inlineRaw)
        cellNode.children.push(buildNode({ token: token2 as TokenLike, raw: inlineRaw, start: inlineStart, id: `${cellNode.id}.${at}`, index }))
      }
      cells.push(cellNode)
    }
    for (const cell of token.header ?? []) buildCell(cell, true)
    for (const row of token.rows ?? []) for (const cell of row) buildCell(cell, false)
    node.children = cells
    return node
  }

  if (Array.isArray(token.items)) {
    for (const [at, item] of token.items.entries()) {
      const itemRaw = typeof item.raw === 'string' ? item.raw : ''
      const itemStart = itemRaw === '' ? start : childAt(itemRaw)
      node.children.push(buildNode({ token: item, raw: itemRaw, start: itemStart, id: childId(at), index }))
    }
    return node
  }

  if (Array.isArray(token.tokens)) {
    for (const [at, child] of token.tokens.entries()) {
      const childRaw = typeof child.raw === 'string' ? child.raw : (typeof child.text === 'string' ? child.text : '')
      const childStart = childRaw === '' ? start : childAt(childRaw)
      node.children.push(buildNode({ token: child, raw: childRaw, start: childStart, id: childId(at), index }))
    }
    return node
  }

  if (type === 'code') {
    node.children = lineNodes('code_line', node.text, raw, start, index, id)
    return node
  }
  if (type === 'html') {
    node.children = lineNodes('html_line', node.text, raw, start, index, id)
    return node
  }
  return node
}

/** Whether one line is a GFM table's delimiter row (`| --- | :---: | ---: |`). */
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length > 0 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))
}

/**
 * Break the paragraph GFM SWALLOWS into a table back out, exactly as the renderer does, while keeping a line map
 * so every token can still be located on its ORIGINAL source line.
 *
 * GFM ends a table only at a blank line: a paragraph written directly under a table row (no `|`) becomes an
 * extra table row. The preview renders it as its own paragraph, so the tree must too, or the two models would
 * see different documents.
 */
function repairSwallowedTableLinesForTree(text: string): { text: string; lineMap: number[] } {
  const lines = text.split('\n')
  const out: string[] = []
  const lineMap: number[] = []
  let inTable = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (!inTable) {
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
    if (line.includes('|')) {
      out.push(line)
      lineMap.push(index)
      continue
    }
    out.push('')
    lineMap.push(-1)
    inTable = false
    out.push(line)
    lineMap.push(index)
  }
  return { text: out.join('\n'), lineMap }
}

/** Parse one side into a forest, dropping the `space` tokens that only separate blocks. */
export function parseMarkdownTree(text: string): MarkdownTreeNode[] {
  const index = indexOfSource(text)
  // Front matter is not Markdown content: `marked` would read its `---` fences as rules/headings. The renderer
  // masks it, and so does the tree — with SPACES, so every later offset stays exactly where it was — and the
  // metadata becomes ONE `front_matter` node spanning the block (a change there is invisible content, not text).
  const lines = text.split('\n')
  let frontEnd = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
    if (close !== -1) {
      frontEnd = lines.slice(0, close + 1).reduce((total, line) => total + line.length + 1, 0)
    }
  }
  const masked = frontEnd === 0
    ? text
    : text.slice(0, frontEnd).replace(/[^\n]/g, ' ') + text.slice(frontEnd)
  // The same swallowed-table repair the renderer applies, with a map back to the ORIGINAL line of every token.
  const repaired = repairSwallowedTableLinesForTree(masked)
  const lexText = repaired.text
  const lexIndex = indexOfSource(lexText)
  const tokens = marked.lexer(lexText) as unknown as TokenLike[]
  const nodes: MarkdownTreeNode[] = []
  if (frontEnd > 0) {
    const frontLines = text.slice(0, frontEnd).split('\n').length - 1
    nodes.push({
      id: '0',
      type: 'front_matter',
      raw: text.slice(0, frontEnd),
      text: '',
      attrs: {},
      children: [],
      start: 0,
      end: frontEnd,
      lines: { start: 1, end: Math.max(1, frontLines) },
    })
  }
  let cursor = 0
  for (const token of tokens) {
    const raw = typeof token.raw === 'string' ? token.raw : ''
    const type = typeof token.type === 'string' ? token.type : ''
    const at = Math.max(cursor, lexText.indexOf(raw, cursor))
    cursor = at + raw.length
    if (SPACING_TYPES.has(type)) continue
    // A token starts on a repaired line; map it to the ORIGINAL document line so its span names the source the
    // reader diffs (an inserted blank line is never a token start). `lineAt` is 1-based, the line map 0-based.
    const repairedLine = lineAt(lexIndex, at) - 1
    let originalLine = repaired.lineMap[repairedLine] ?? repairedLine
    if (originalLine < 0) {
      for (let next = repairedLine + 1; next < repaired.lineMap.length; next++) {
        if ((repaired.lineMap[next] ?? -1) >= 0) {
          originalLine = repaired.lineMap[next]!
          break
        }
      }
    }
    const start = index.lineStarts[Math.max(0, Math.min(originalLine, index.lineStarts.length - 1))]!
    nodes.push(buildNode({ token, raw, start, id: String(nodes.length), index }))
  }
  return nodes
}

/** Whether two nodes are the SAME document element: same type and exactly the same source. */
function sameSource(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): boolean {
  return oldNode.type === newNode.type && oldNode.raw === newNode.raw
}

/** Whether two nodes are of a compatible type (the same `marked` token type, or the same synthetic one). */
function sameType(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): boolean {
  return oldNode.type === newNode.type
}

/** How alike two nodes are: the similarity of their visible text (1 = identical, 0 = nothing in common). */
export function nodeSimilarity(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): number {
  return textSimilarity(nodeMatchText(oldNode), nodeMatchText(newNode))
}

/** The child operations for a pair the two sides' types agree on: rules per node type, outermost first. */
function matchChildrenByIdType(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): TreeMatchOp[] {
  if (oldNode.type === 'table' && newNode.type === 'table') return matchTable(oldNode, newNode)
  return alignNodeLists(oldNode.children, newNode.children)
}

/** Table: header cells pair by column, body rows match by their CELL content (not by position). */
function matchTable(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): TreeMatchOp[] {
  const oldHeader = oldNode.children.filter(cell => cell.attrs.header === true)
  const newHeader = newNode.children.filter(cell => cell.attrs.header === true)
  const oldRows: MarkdownTreeNode[] = []
  const newRows: MarkdownTreeNode[] = []
  const oldBody = oldNode.children.filter(cell => cell.attrs.header !== true)
  const newBody = newNode.children.filter(cell => cell.attrs.header !== true)
  const columns = Math.max(oldHeader.length, newHeader.length, 1)
  for (let at = 0; at * columns < oldBody.length; at += 1) {
    const cells = oldBody.slice(at * columns, (at + 1) * columns)
    if (cells.length === 0) break
    oldRows.push(rowNode(oldNode, cells, at))
  }
  for (let at = 0; at * columns < newBody.length; at += 1) {
    const cells = newBody.slice(at * columns, (at + 1) * columns)
    if (cells.length === 0) break
    newRows.push(rowNode(newNode, cells, at))
  }
  const ops: TreeMatchOp[] = []
  const headerPairs = Math.min(oldHeader.length, newHeader.length)
  for (let at = 0; at < headerPairs; at += 1) {
    const pair = makePair(oldHeader[at]!, newHeader[at]!, alignNodeLists(oldHeader[at]!.children, newHeader[at]!.children))
    ops.push({ kind: 'pair', pair })
  }
  for (let at = headerPairs; at < oldHeader.length; at += 1) ops.push({ kind: 'oldOnly', node: oldHeader[at]! })
  for (let at = headerPairs; at < newHeader.length; at += 1) ops.push({ kind: 'newOnly', node: newHeader[at]! })
  ops.push(...alignNodeLists(oldRows, newRows))
  return ops
}

/** A synthetic table-row node: the cells of one row, in column order. */
function rowNode(table: MarkdownTreeNode, cells: MarkdownTreeNode[], at: number): MarkdownTreeNode {
  const first = cells[0]
  const last = cells[cells.length - 1]
  const start = first?.start ?? table.start
  const end = last?.end ?? table.end
  return {
    id: `${table.id}.row${at}`,
    type: 'table_row',
    raw: cells.map(cell => cell.raw).join('|'),
    text: cells.map(cell => cell.text).join('|'),
    attrs: {},
    children: cells,
    start,
    end,
    lines: {
      start: first?.lines.start ?? table.lines.start,
      end: last?.lines.end ?? table.lines.end,
    },
  }
}

/** A pair node with its similarity and recursively matched children. */
function makePair(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode, children: TreeMatchOp[]): TreeMatchPair {
  const similarity = nodeSimilarity(oldNode, newNode)
  return {
    old: oldNode,
    new: newNode,
    exact: sameSource(oldNode, newNode) && oldNode.raw === newNode.raw,
    similarity,
    children,
  }
}

/**
 * Align two sibling lists: identical nodes anchor the alignment; between the anchors, nodes of the same type
 * pair by a similarity-weighted order-preserving walk (so an inserted or deleted sibling shifts nothing).
 */
function alignNodeLists(oldNodes: readonly MarkdownTreeNode[], newNodes: readonly MarkdownTreeNode[]): TreeMatchOp[] {
  const ops: TreeMatchOp[] = []
  const anchors = lcsPairs(oldNodes, newNodes, sameSource)
  let oldAt = 0
  let newAt = 0
  const flushGap = (oldEnd: number, newEnd: number): void => {
    if (oldAt < oldEnd || newAt < newEnd) ops.push(...alignGap(oldNodes.slice(oldAt, oldEnd), newNodes.slice(newAt, newEnd)))
    oldAt = oldEnd
    newAt = newEnd
  }
  for (const [oldIndex, newIndex] of anchors) {
    flushGap(oldIndex, newIndex)
    const oldNode = oldNodes[oldIndex]!
    const newNode = newNodes[newIndex]!
    ops.push({ kind: 'pair', pair: makePair(oldNode, newNode, matchChildrenByIdType(oldNode, newNode)) })
    oldAt = oldIndex + 1
    newAt = newIndex + 1
  }
  flushGap(oldNodes.length, newNodes.length)
  return ops
}

/**
 * Pair the nodes of one gap: order-preserving, same-type nodes only, preferring the more similar
 * (a paragraph inserted between two others matches nothing; the two originals still pair with each other).
 */
function alignGap(oldGap: readonly MarkdownTreeNode[], newGap: readonly MarkdownTreeNode[]): TreeMatchOp[] {
  const rows = oldGap.length
  const columns = newGap.length
  if (rows === 0) return newGap.map(node => ({ kind: 'newOnly', node }))
  if (columns === 0) return oldGap.map(node => ({ kind: 'oldOnly', node }))
  interface Score {
    value: number
    /** What this cell decides: pair the two nodes here, or step over one side. */
    kind: 'pair' | 'old' | 'new'
  }
  const table: Score[][] = Array.from({ length: rows + 1 }, () => new Array<Score>(columns + 1).fill({ value: 0, kind: 'old' }))
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      const skipOld = table[row + 1]![column]!
      const skipNew = table[row]![column + 1]!
      let best: Score = skipOld.value >= skipNew.value
        ? { value: skipOld.value, kind: 'old' }
        : { value: skipNew.value, kind: 'new' }
      const oldNode = oldGap[row]!
      const newNode = newGap[column]!
      if (sameType(oldNode, newNode)) {
        // Same type is a match by the user's rule; similarity only chooses the BEST type-matched partner.
        const value = table[row + 1]![column + 1]!.value + 1 + nodeSimilarity(oldNode, newNode)
        if (value > best.value + 1e-9) best = { value, kind: 'pair' }
      }
      table[row]![column] = best
    }
  }
  const ops: TreeMatchOp[] = []
  let row = 0
  let column = 0
  while (row < rows && column < columns) {
    const decision = table[row]![column]!
    if (decision.kind === 'pair') {
      const oldNode = oldGap[row]!
      const newNode = newGap[column]!
      ops.push({ kind: 'pair', pair: makePair(oldNode, newNode, matchChildrenByIdType(oldNode, newNode)) })
      row++
      column++
      continue
    }
    if (decision.kind === 'old') {
      ops.push({ kind: 'oldOnly', node: oldGap[row]! })
      row++
    } else {
      ops.push({ kind: 'newOnly', node: newGap[column]! })
      column++
    }
  }
  while (row < rows) ops.push({ kind: 'oldOnly', node: oldGap[row++]! })
  while (column < columns) ops.push({ kind: 'newOnly', node: newGap[column++]! })
  return ops
}

/** Match two whole documents tree-first. */
export function matchMarkdownTrees(oldText: string, newText: string): TreeMatchResult {
  const oldRoot = parseMarkdownTree(oldText)
  const newRoot = parseMarkdownTree(newText)
  return { oldRoot, newRoot, ops: alignNodeLists(oldRoot, newRoot) }
}

/** Every pair and one-sided node of a match, pairs before their own children (pre-order). */
export function flattenTreeMatch(ops: readonly TreeMatchOp[]): FlatTreeMatch {
  const pairs: TreeMatchPair[] = []
  const oldOnly: MarkdownTreeNode[] = []
  const newOnly: MarkdownTreeNode[] = []
  const walk = (list: readonly TreeMatchOp[]): void => {
    for (const op of list) {
      if (op.kind === 'pair') {
        pairs.push(op.pair)
        walk(op.pair.children)
      } else if (op.kind === 'oldOnly') {
        oldOnly.push(op.node)
      } else {
        newOnly.push(op.node)
      }
    }
  }
  walk(ops)
  return { pairs, oldOnly, newOnly }
}

/** Two nodes' attrs are the same: heading level, fence language, link target, list style, table alignment. */
function attrsEqual(oldNode: MarkdownTreeNode, newNode: MarkdownTreeNode): boolean {
  const keys = new Set([...Object.keys(oldNode.attrs), ...Object.keys(newNode.attrs)])
  for (const key of keys) {
    // A cell's column alignment is the TABLE's attribute (already compared on the table pair): two cells with
    // the same content are fully matched even when their column was re-aligned.
    if (key === 'align' && oldNode.type === 'table_cell') continue
    if (oldNode.attrs[key] !== newNode.attrs[key]) return false
  }
  return true
}

/**
 * Whether a pair's whole subtree is UNCHANGED: the same node type and attributes, and every child fully
 * matched (no one-sided child anywhere).
 *
 * This is the recursive definition the merge rules use. A table row is fully matched only when EVERY cell is;
 * a table is fully matched only when its header cells and every body row are — so a table with one changed
 * cell is not merged as a whole, while its matched rows still can be (see `siblingRuns`).
 */
export function pairFullyMatched(pair: TreeMatchPair): boolean {
  if (pair.old.type !== pair.new.type) return false
  if (!attrsEqual(pair.old, pair.new)) return false
  // Leaf nodes (a rule, a comment line, an inline text): the source itself must be unchanged.
  if (pair.old.children.length === 0 && pair.new.children.length === 0) return pair.exact
  // Every child operation must be a pair whose own subtree fully matched: one one-sided node (a changed inline
  // word, an inserted table cell) makes the parent changed.
  return pair.children.length > 0 && pair.children.every(op => op.kind === 'pair' && pairFullyMatched(op.pair))
}

/**
 * One run of adjacent siblings at ONE level, and whether the run is "merged" — i.e. every node in it is a
 * fully-matched pair, so the reader can treat them as one unchanged stretch.
 */
export interface MatchedRun {
  ops: TreeMatchOp[]
  /** The whole run is fully-matched pairs: merge these siblings into one unchanged piece. */
  merged: boolean
}

/**
 * Group a level's alignment into runs: adjacent FULLY-MATCHED siblings merge into one run; a run ends at any
 * change (a modified pair, a node that exists on one side only). The caller can then treat each merged run as
 * one unchanged piece and every other run as a difference to draw.
 */
export function siblingRuns(ops: readonly TreeMatchOp[]): MatchedRun[] {
  const runs: MatchedRun[] = []
  for (const op of ops) {
    const merged = op.kind === 'pair' && pairFullyMatched(op.pair)
    const last = runs[runs.length - 1]
    if (merged && last !== undefined && last.merged) last.ops.push(op)
    else runs.push({ ops: [op], merged })
  }
  return runs
}

/** One matched table's header run and body-row runs, kept apart (see `tableRowRuns`). */
export interface TableRowRuns {
  /** The header is ONE structural piece: merged only when EVERY header cell is fully matched. */
  header: MatchedRun
  /** Body rows: adjacent fully-matched rows merge; a changed/inserted row ends the run. */
  body: MatchedRun[]
}

/**
 * A table's matched runs, HEADER and BODY kept apart.
 *
 * The header is one structural piece: it is either wholly matched (all cells) or not, and it never merges with
 * the body rows into "one matched stretch" — a table whose header changed is a changed table even when every
 * body row matches. Body rows follow the general rule: adjacent fully-matched rows merge; a row matches only
 * when EVERY cell of it matches (a row with one changed cell is a difference row, not a merged one).
 *
 * @param pair - a matched `table` pair.
 * @returns its header run and body runs, in reading order.
 */
export function tableRowRuns(pair: TreeMatchPair): TableRowRuns {
  const headerOps: TreeMatchOp[] = []
  const bodyOps: TreeMatchOp[] = []
  for (const op of pair.children) {
    const headerCell = op.kind === 'pair' && op.pair.old.type === 'table_cell' && op.pair.old.attrs.header === true
    if (headerCell) headerOps.push(op)
    else bodyOps.push(op)
  }
  const headerMerged = headerOps.length > 0
    && headerOps.every(op => op.kind === 'pair' && pairFullyMatched(op.pair))
  return { header: { ops: headerOps, merged: headerMerged }, body: siblingRuns(bodyOps) }
}

/**
 * Whether a node renders NOTHING at all, so a change to it can only be reported as invisible content (the
 * eye-with-a-slash marker placed at its document position): front matter, an HTML comment, a link definition.
 */
export function isInvisibleNode(node: MarkdownTreeNode): boolean {
  if (node.type === 'front_matter' || node.type === 'def') return true
  if (node.type === 'html') return node.raw.trimStart().startsWith('<!--')
  return false
}

/**
 * One piece of the merge plan at one tree level: a CONTEXT stretch of fully-matched siblings (merged into one
 * unchanged run) or a DIFFERENCE (a changed pair, or a node that exists on one side only).
 */
export interface MergePlanPiece {
  kind: 'context' | 'diff'
  /** For a context piece: the fully-matched sibling ops it merged (in order). */
  ops?: TreeMatchOp[]
  /** For a difference: the op it stands for. */
  op?: TreeMatchOp
  /** The changes INSIDE a changed pair, as pieces of the next level down (same rules recursively). */
  inner?: MergePlanPiece[]
  /** The difference has no rendering (html comment, front matter, link definition): draw the icon marker. */
  invisible?: boolean
  /** A node that exists on one side only. */
  pure?: 'old' | 'new'
}

/**
 * Plan the merge of one tree level: fully-matched adjacent siblings become CONTEXT runs; everything else is a
 * DIFFERENCE piece, recursing into its type-specific internals.
 *
 * The rules this implements (user's decisions):
 *  - at any level, adjacent FULLY-MATCHED siblings merge into one unchanged run;
 *  - a fully-matched pair disappears into the context; a one-sided node is a pure deletion/addition;
 *  - table: the header is one piece (partial header → per-cell differences), body rows merge when every cell
 *    matches, and a row with any changed cell is a difference;
 *  - list: a container whose own attributes changed is a difference, but its items are still matched and
 *    planned item by item;
 *  - code: the fence is one difference when its language or any code line changed, with its lines planned
 *    inside (matched lines become context);
 *  - blockquote: its children are planned with the same rules;
 *  - an invisible node (html comment, front matter, link definition) is a difference flagged `invisible`.
 *
 * @param ops - the match operations of one tree level, in reading order.
 * @returns the plan pieces of that level, in reading order.
 */
export function planMergedSiblings(ops: readonly TreeMatchOp[]): MergePlanPiece[] {
  const pieces: MergePlanPiece[] = []
  for (const run of siblingRuns(ops)) {
    if (run.merged) {
      pieces.push({ kind: 'context', ops: [...run.ops] })
      continue
    }
    for (const op of run.ops) pieces.push(planDifference(op))
  }
  return pieces
}

/** Plan one difference (a changed pair, or a one-sided node), recursing into its type-specific children. */
function planDifference(op: TreeMatchOp): MergePlanPiece {
  if (op.kind !== 'pair') {
    const invisible = isInvisibleNode(op.node)
    return { kind: 'diff', op, pure: op.kind === 'oldOnly' ? 'old' : 'new', ...(invisible ? { invisible: true } : {}) }
  }
  const pair = op.pair
  const invisible = isInvisibleNode(pair.old) && isInvisibleNode(pair.new)
  if (invisible) return { kind: 'diff', op, invisible: true }
  if (pair.old.type === 'table' && pair.new.type === 'table') {
    return { kind: 'diff', op, inner: planTableInner(pair) }
  }
  if (pair.children.length > 0) return { kind: 'diff', op, inner: planMergedSiblings(pair.children) }
  return { kind: 'diff', op }
}

/** Plan a table's internals: header as one piece, body rows merged/planned separately. */
function planTableInner(pair: TreeMatchPair): MergePlanPiece[] {
  const runs = tableRowRuns(pair)
  const pieces: MergePlanPiece[] = []
  for (const run of siblingRuns(runs.header.ops)) {
    if (run.merged) {
      pieces.push({ kind: 'context', ops: [...run.ops] })
      continue
    }
    for (const op of run.ops) pieces.push(planDifference(op))
  }
  for (const run of runs.body) {
    if (run.merged) {
      pieces.push({ kind: 'context', ops: [...run.ops] })
      continue
    }
    for (const op of run.ops) pieces.push(planDifference(op))
  }
  return pieces
}

/** Whether a plan is entirely context (nothing to draw): true for a wholly unchanged tree level. */
export function planIsAllContext(pieces: readonly MergePlanPiece[]): boolean {
  return pieces.every(piece => piece.kind === 'context')
}

/** The node a character offset belongs to, deepest first: for tests and later span mapping. */
export function nodeAtOffset(root: readonly MarkdownTreeNode[], offset: number): MarkdownTreeNode | undefined {
  const walk = (nodes: readonly MarkdownTreeNode[]): MarkdownTreeNode | undefined => {
    for (const node of nodes) {
      if (offset < node.start || offset >= node.end) continue
      return walk(node.children) ?? node
    }
    return undefined
  }
  return walk(root)
}
