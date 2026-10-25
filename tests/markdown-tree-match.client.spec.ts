// The TREE-FIRST matching core (spec direction: parse both sides, match the OUTER elements first — exact, then
// by type — and only then match the internals the way that node type allows).
//
// These cases are the ones positional line pairing gets wrong: a sibling inserted between unchanged ones (a
// list item/table row/paragraph at the FRONT or MIDDLE), a type change (paragraph → table), a heading level
// change, a re-spelled inline style, and code-line edits.

import { describe, expect, it } from 'vitest'
import {
  flattenTreeMatch,
  matchMarkdownTrees,
  nodeAtOffset,
  nodeMatchText,
  nodeVisibleText,
  pairFullyMatched,
  parseMarkdownTree,
  planIsAllContext,
  planMergedSiblings,
  siblingRuns,
  tableRowRuns,
  type MarkdownTreeNode,
  type MergePlanPiece,
  type TreeMatchOp,
  type TreeMatchPair,
} from '../src/client/markdown-tree-match.ts'

const walk = (nodes: readonly MarkdownTreeNode[], visit: (node: MarkdownTreeNode) => void): void => {
  for (const node of nodes) {
    visit(node)
    walk(node.children, visit)
  }
}

/** Every node of one side's forest, in reading order. */
const flatNodes = (nodes: readonly MarkdownTreeNode[]): MarkdownTreeNode[] => {
  const list: MarkdownTreeNode[] = []
  walk(nodes, node => list.push(node))
  return list
}

const typesOf = (nodes: readonly MarkdownTreeNode[]): string[] => nodes.map(node => node.type)

describe('Markdown syntax tree: parsing', () => {
  const TEXT = [
    '# Title',                                 // 1
    '',                                        // 2
    'Para **bold** and `code` [link](https://x.example).', // 3
    '',                                        // 4
    '- item one',                              // 5
    '- item *two*',                            // 6
    '',                                        // 7
    '> quote line',                            // 8
    '',                                        // 9
    '| a | b |',                               // 10
    '|---|---|',                                // 11
    '| 1 | 2 |',                               // 12
    '',                                        // 13
    '```ts',                                   // 14
    'const a = 1',                             // 15
    '```',                                     // 16
    '',                                        // 17
    '---',                                     // 18
    '',                                        // 19
    '<!-- comment -->',                        // 20
    '',                                        // 21
  ].join('\n')

  it('builds the block forest with source lines, and inline children inside it', () => {
    const root = parseMarkdownTree(TEXT)
    expect(typesOf(root)).toEqual(['heading', 'paragraph', 'list', 'blockquote', 'table', 'code', 'hr', 'html'])
    // Source lines are exact.
    expect(root[0]!.lines).toEqual({ start: 1, end: 1 })
    expect(root[1]!.lines).toEqual({ start: 3, end: 3 })
    expect(root[2]!.lines).toEqual({ start: 5, end: 6 })
    expect(root[3]!.lines.start).toBe(8)
    expect(root[4]!.lines).toEqual({ start: 10, end: 12 })
    expect(root[5]!.lines).toEqual({ start: 14, end: 16 })
    expect(root[6]!.lines).toEqual({ start: 18, end: 18 })
    expect(root[7]!.lines.start).toBe(20)
    // Inline children of the paragraph: text, strong, text, codespan, text, link, text.
    expect(typesOf(root[1]!.children)).toEqual(['text', 'strong', 'text', 'codespan', 'text', 'link', 'text'])
    expect(nodeVisibleText(root[1]!)).toBe('Para bold and code link.')
    expect(nodeMatchText(root[1]!)).toBe('Para bold and code link.')
    // List items, then their inline content.
    expect(typesOf(root[2]!.children)).toEqual(['list_item', 'list_item'])
    expect(root[2]!.children[1]!.lines).toEqual({ start: 6, end: 6 })
    expect(nodeVisibleText(root[2]!.children[1]!)).toContain('item two')
    // Table: header cells and body cells are separate nodes.
    const table = root[4]!
    expect(table.children.map(cell => ({
      type: cell.type, text: cell.text, header: cell.attrs.header, line: cell.lines.start,
    }))).toEqual([
      { type: 'table_cell', text: 'a', header: true, line: 10 },
      { type: 'table_cell', text: 'b', header: true, line: 10 },
      { type: 'table_cell', text: '1', header: false, line: 12 },
      { type: 'table_cell', text: '2', header: false, line: 12 },
    ])
    // A fenced block's lines are real nodes, so code can be matched line by line.
    expect(typesOf(root[5]!.children)).toEqual(['code_line'])
    expect(root[5]!.children[0]!.text).toBe('const a = 1')
    expect(root[5]!.children[0]!.lines.start).toBe(15)
    // The rule has no text; the comment renders nothing.
    expect(nodeVisibleText(root[6]!)).toBe('')
    expect(nodeVisibleText(root[7]!)).toBe('')
    // Parsing the same source twice gives the same tree.
    expect(parseMarkdownTree(TEXT)).toEqual(root)
  })

  it('finds the deepest node at a character offset', () => {
    const root = parseMarkdownTree(TEXT)
    const offset = TEXT.indexOf('bold')
    expect(nodeAtOffset(root, offset)?.type).toBe('text')
    expect(nodeAtOffset(root, offset + 1)?.text).toBe('bold')
  })

  it('turns front matter into ONE invisible node, keeping every later offset intact', () => {
    const text = '---\ntitle: T\nversion: 1\n---\n\n# H\n\nBody\n'
    const root = parseMarkdownTree(text)
    expect(typesOf(root)).toEqual(['front_matter', 'heading', 'paragraph'])
    // The metadata block is one node over its whole fence-to-fence span, and it renders no text.
    expect(root[0]!.lines).toEqual({ start: 1, end: 4 })
    expect(root[0]!.raw).toContain('version: 1')
    expect(nodeVisibleText(root[0]!)).toBe('')
    // The content after it keeps its ORIGINAL lines: masking preserved the source offsets.
    expect(root[1]!.lines).toEqual({ start: 6, end: 6 })
    expect(root[2]!.lines.start).toBe(8)
  })
})

describe('Markdown syntax tree: outer-first matching', () => {
  it('matches identical documents wholly by EXACT pairs', () => {
    const text = '# T\n\nFirst.\n\n- a\n- b\n\n| h |\n|---|\n| 1 |\n'
    const result = matchMarkdownTrees(text, text)
    expect(result.ops.every(op => op.kind === 'pair')).toBe(true)
    const flat = flattenTreeMatch(result.ops)
    expect(flat.oldOnly).toEqual([])
    expect(flat.newOnly).toEqual([])
    expect(flat.pairs.every(pair => pair.exact)).toBe(true)
  })

  it('pairs a changed paragraph by TYPE between its unchanged anchors, not by position', () => {
    const oldText = '# T\n\nFirst paragraph.\n\nSecond paragraph.\n'
    const newText = '# T\n\nFirst paragraph.\n\nA NEW PARAGRAPH.\n\nSecond paragraph.\n'
    const result = matchMarkdownTrees(oldText, newText)
    // The heading and both old paragraphs are matched; only the inserted paragraph is one-sided.
    expect(typesOf(result.oldRoot)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(typesOf(result.newRoot)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph'])
    const flat = flattenTreeMatch(result.ops)
    expect(flat.newOnly.map(node => node.type)).toEqual(['paragraph'])
    expect(flat.oldOnly).toEqual([])
    const top = result.ops.map(op => op.kind === 'pair' ? `pair:${op.pair.new.type}` : `${op.kind}`)
    expect(top).toEqual(['pair:heading', 'pair:paragraph', 'newOnly', 'pair:paragraph'])
  })

  it('keeps the EXISTING list items matched when one is inserted at the front', () => {
    const oldText = '- alpha\n- beta\n- gamma\n'
    const newText = '- brand new\n- alpha\n- beta\n- gamma\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    // The three originals are EXACT pairs; the inserted item is a pure addition — position pairing would have
    // shifted EVERY item and marked all four.
    expect(flat.pairs.filter(pair => pair.old.type === 'list_item').map(pair => pair.old.text.trim()))
      .toEqual(['alpha', 'beta', 'gamma'])
    expect(flat.newOnly.map(node => node.text.trim())).toEqual(['brand new'])
    expect(flat.oldOnly).toEqual([])
    for (const pair of flat.pairs.filter(item => item.old.type === 'list_item')) expect(pair.exact).toBe(true)
  })

  it('pairs an edited list item with its own counterpart, not with an inserted one', () => {
    const oldText = '- alpha\n- beta\n- gamma\n'
    const newText = '- alpha\n- inserted\n- beta EDITED\n- gamma\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    const edited = flat.pairs.find(pair => pair.old.type === 'list_item' && pair.old.text.includes('beta'))
    expect(edited, 'beta pairs with beta EDITED').toBeDefined()
    expect(edited!.new.text).toContain('beta EDITED')
    expect(edited!.exact).toBe(false)
    expect(edited!.similarity).toBeGreaterThan(0.3)
    expect(flat.newOnly.map(node => node.text.trim())).toEqual(['inserted'])
  })

  it('pairs a whole TYPE change as one-sided nodes (a paragraph is not a table)', () => {
    const oldText = 'Before.\n\nA plain paragraph.\n\nAfter.\n'
    const newText = 'Before.\n\n| h |\n|---|\n| 1 |\n\nAfter.\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    expect(flat.oldOnly.map(node => node.type)).toEqual(['paragraph'])
    expect(flat.newOnly.map(node => node.type)).toEqual(['table'])
    // The surrounding paragraphs still anchor exactly.
    expect(flat.pairs.filter(pair => pair.old.type === 'paragraph')).toHaveLength(2)
  })

  it('pairs a heading LEVEL change by type and reports the depth difference inside the pair', () => {
    const result = matchMarkdownTrees('#### 标题\n', '### 标题\n')
    expect(result.ops).toHaveLength(1)
    expect(result.ops[0]!.kind).toBe('pair')
    const pair = (result.ops[0] as { pair: { old: MarkdownTreeNode; new: MarkdownTreeNode; exact: boolean; children: TreeMatchOp[] } }).pair
    expect(pair.old.type).toBe('heading')
    expect(pair.new.type).toBe('heading')
    expect(pair.exact).toBe(false)
    expect(pair.old.attrs.depth).toBe(4)
    expect(pair.new.attrs.depth).toBe(3)
    // The heading's TEXT is unchanged and pairs exactly inside.
    expect(pair.children).toHaveLength(1)
    expect(pair.children[0]!.kind).toBe('pair')
    expect((pair.children[0] as { pair: { exact: boolean } }).pair.exact).toBe(true)
  })

  it('pairs a re-spelled inline style, leaving its words exact', () => {
    const result = matchMarkdownTrees('A **bold** word.\n', 'A __bold__ word.\n')
    const pair = flattenTreeMatch(result.ops).pairs[0]!
    expect(pair.old.type).toBe('paragraph')
    expect(pair.exact).toBe(false)
    const strong = pair.children.find(op => op.kind === 'pair' && op.pair.old.type === 'strong')
    expect(strong, 'the strong spelling pair is inside the paragraph').toBeDefined()
    expect((strong as { pair: { exact: boolean } }).pair.exact).toBe(false)
  })

  it('pairs table ROWS by their cell content, keeping an inserted row one-sided', () => {
    const oldText = '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n'
    const newText = '| k | v |\n|---|---|\n| a | 1 |\n| x | 9 |\n| b | 2 |\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    const rows = flat.pairs.filter(pair => pair.old.type === 'table_row')
    expect(rows).toHaveLength(2)
    expect(rows.map(pair => pair.old.children.map(cell => cell.text).join('|'))).toEqual(['a|1', 'b|2'])
    expect(flat.newOnly.filter(node => node.type === 'table_row').map(row => row.children.map(cell => cell.text).join('|'))).toEqual(['x|9'])
  })

  it('pairs a changed table cell inside its row, by column', () => {
    const oldText = '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n'
    const newText = '| k | v |\n|---|---|\n| a | ONE |\n| b | 2 |\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    // Row b is exact; row a pairs and the second cell pairs inside it, with a changed inline text.
    const rowA = flat.pairs.find(pair => pair.old.type === 'table_row' && pair.old.children[0]?.text === 'a')!
    expect(rowA.exact).toBe(false)
    const cellPairs = rowA.children.filter(op => op.kind === 'pair' && op.pair.old.type === 'table_cell') as { pair: { old: MarkdownTreeNode; new: MarkdownTreeNode; exact: boolean } }[]
    expect(cellPairs).toHaveLength(2)
    expect(cellPairs[0]!.pair.exact).toBe(true)
    expect(cellPairs[1]!.pair.exact).toBe(false)
    expect(cellPairs[1]!.pair.old.text).toBe('1')
    expect(cellPairs[1]!.pair.new.text).toBe('ONE')
  })

  it('matches code lines inside a fenced block, including an inserted line', () => {
    const oldText = '```ts\nconst a = 1\nconst b = 2\n```\n'
    const newText = '```ts\nconst a = 1\nconsole.log(a)\nconst b = 2\n```\n'
    const result = matchMarkdownTrees(oldText, newText)
    const flat = flattenTreeMatch(result.ops)
    const fence = flat.pairs.find(pair => pair.old.type === 'code')!
    expect(fence.exact).toBe(false)
    expect(flat.newOnly.filter(node => node.type === 'code_line').map(node => node.text)).toEqual(['console.log(a)'])
    expect(flat.pairs.filter(pair => pair.old.type === 'code_line').map(pair => pair.old.text)).toEqual(['const a = 1', 'const b = 2'])
  })

  it('pairs a re-spelled RULE by type (no text, different spelling)', () => {
    const result = matchMarkdownTrees('Above.\n\n---\n\nBelow.\n', 'Above.\n\n***\n\nBelow.\n')
    const flat = flattenTreeMatch(result.ops)
    const rule = flat.pairs.find(pair => pair.old.type === 'hr')
    expect(rule, 'the two rule spellings are type-matched').toBeDefined()
    expect(rule!.exact).toBe(false)
    expect(flat.oldOnly).toEqual([])
    expect(flat.newOnly).toEqual([])
  })

  it('pairs a changed front-matter block by type, leaving the body exact', () => {
    const result = matchMarkdownTrees(
      '---\ntitle: A\n---\n\nBody\n',
      '---\ntitle: B\n---\n\nBody\n',
    )
    const flat = flattenTreeMatch(result.ops)
    const front = flat.pairs.find(pair => pair.old.type === 'front_matter')
    expect(front, 'the two metadata blocks are type-matched').toBeDefined()
    expect(front!.exact).toBe(false)
    const body = flat.pairs.find(pair => pair.old.type === 'paragraph')
    expect(body, 'the body is exact').toBeDefined()
    expect(body!.exact).toBe(true)
  })
})

// Merge rules (user's): at one level, FULLY MATCHED siblings merge into one unchanged run; a table row matches
// only when EVERY cell matches; non-header body rows merge adjacently; a table merges as a whole only when BOTH
// its header and all its body rows match.
describe('Markdown syntax tree: fully-matched runs', () => {
  const rootPair = (result: ReturnType<typeof matchMarkdownTrees>, type: string): TreeMatchPair => {
    const op = result.ops.find(candidate => candidate.kind === 'pair' && candidate.pair.old.type === type)
    if (op === undefined || op.kind !== 'pair') throw new Error(`no ${type} pair`)
    return op.pair
  }

  it('merges adjacent fully-matched siblings at any level, and a change ends the run', () => {
    const result = matchMarkdownTrees('# T\n\nA.\n\nB.\n\nC.\n', '# T\n\nA.\n\nB2.\n\nC.\n')
    const runs = siblingRuns(result.ops)
    // The heading and paragraph A are both untouched → ONE merged run; B2 breaks it; C is its own run.
    expect(runs.map(run => run.merged)).toEqual([true, false, true])
    expect(runs[0]!.ops).toHaveLength(2)
    expect(runs[2]!.ops).toHaveLength(1)
  })

  it('defines a pair as fully matched only when every descendant matched', () => {
    const whole = matchMarkdownTrees('- a\n- b\n', '- a\n- b\n')
    expect(pairFullyMatched(rootPair(whole, 'list'))).toBe(true)
    const changed = matchMarkdownTrees('- a\n- b\n', '- a\n- B!\n')
    expect(pairFullyMatched(rootPair(changed, 'list'))).toBe(false)
    const runs = siblingRuns(rootPair(changed, 'list').children)
    // First item merges alone, the changed item is a difference.
    expect(runs.map(run => run.merged)).toEqual([true, false])
  })

  it('merges matched run of list items between changed items', () => {
    const result = matchMarkdownTrees('- a\n- b\n- c\n', '- a\n- B!\n- c\n')
    const runs = siblingRuns(rootPair(result, 'list').children)
    expect(runs.map(run => run.merged)).toEqual([true, false, true])
    expect(runs.map(run => run.ops.length)).toEqual([1, 1, 1])
  })

  it('matches a table row only when EVERY cell matches, and a whole table only with header + body', () => {
    const oldText = '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n'
    const newText = '| k | v |\n|---|---|\n| a | 1 |\n| b | TWO |\n'
    const result = matchMarkdownTrees(oldText, newText)
    const table = rootPair(result, 'table')
    // A table with one changed cell is NOT a fully matched table.
    expect(pairFullyMatched(table)).toBe(false)
    const runs = tableRowRuns(table)
    // Header: every header cell matches → the header is one merged run.
    expect(runs.header.merged).toBe(true)
    // Body: row a merges; row b has a changed cell (`TWO`) and is a difference row of its own.
    expect(runs.body.map(run => run.merged)).toEqual([true, false])
    const changedRow = runs.body[1]!.ops[0]
    expect(changedRow?.kind).toBe('pair')
    expect(changedRow?.kind === 'pair' ? pairFullyMatched(changedRow.pair) : false).toBe(false)
  })

  it('does not merge a changed HEADER into the body, even when every body row matches', () => {
    const oldText = '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n'
    const newText = '| K! | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n'
    const result = matchMarkdownTrees(oldText, newText)
    const table = rootPair(result, 'table')
    expect(pairFullyMatched(table)).toBe(false)
    const runs = tableRowRuns(table)
    expect(runs.header.merged).toBe(false)
    // The untouched body rows still merge into one unchanged run.
    expect(runs.body.map(run => run.merged)).toEqual([true])
  })

  it('merges an entirely matched table with its neighbouring matched blocks', () => {
    const text = 'Before.\n\n| k | v |\n|---|---|\n| a | 1 |\n\nAfter.\n'
    const result = matchMarkdownTrees(text, text)
    const runs = siblingRuns(result.ops)
    // Paragraph, table and following paragraph are all untouched → ONE merged run.
    expect(runs).toHaveLength(1)
    expect(runs[0]!.merged).toBe(true)
    expect(runs[0]!.ops).toHaveLength(3)
  })

  it('merges matched code lines inside a fence and ends the run at the changed line', () => {
    const oldText = '```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n'
    const newText = '```ts\nconst a = 1\nconst B = 2\nconst c = 3\n```\n'
    const result = matchMarkdownTrees(oldText, newText)
    const code = rootPair(result, 'code')
    const runs = siblingRuns(code.children)
    expect(runs.map(run => run.merged)).toEqual([true, false, true])
    expect(pairFullyMatched(code)).toBe(false)
  })
})

// The merge PLAN: what the renderer/block builder consumes. Fully-matched siblings collapse into context
// runs; everything else is a difference piece, with type-specific internals (tables, lists, code, quotes).
describe('Markdown syntax tree: merge plan', () => {
  const piecesOfDiff = (pieces: MergePlanPiece[], index = 0): MergePlanPiece => {
    const diffs = pieces.filter(piece => piece.kind === 'diff')
    const piece = diffs[index]
    if (piece === undefined) throw new Error(`no diff piece ${index}`)
    return piece
  }

  it('keeps matched list items as context and makes the inserted item a pure difference', () => {
    const result = matchMarkdownTrees('- alpha\n- beta\n- gamma\n', '- brand new\n- alpha\n- beta\n- gamma\n')
    const plan = planMergedSiblings(result.ops)
    expect(plan).toHaveLength(1)
    const list = piecesOfDiff(plan)
    expect(list.op?.kind).toBe('pair')
    const inner = list.inner ?? []
    expect(inner.map(piece => piece.kind)).toEqual(['diff', 'context'])
    expect(inner[0]!.pure).toBe('new')
    expect(inner[0]!.op?.kind).toBe('newOnly')
    expect(inner[1]!.ops).toHaveLength(3)
    expect(planIsAllContext(inner)).toBe(false)
  })

  it('plans a changed table cell as a row difference between merged header and body runs', () => {
    const result = matchMarkdownTrees(
      '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| b | TWO |\n',
    )
    const plan = planMergedSiblings(result.ops)
    const table = piecesOfDiff(plan)
    expect(table.op?.kind).toBe('pair')
    expect(table.op?.kind === 'pair' ? table.op.pair.old.type : undefined).toBe('table')
    const inner = table.inner ?? []
    // Header merged → context; row a merged → context; row b is the difference.
    expect(inner.map(piece => piece.kind)).toEqual(['context', 'context', 'diff'])
    const rowDiff = piecesOfDiff(inner)
    expect(rowDiff.pure).toBeUndefined()
    expect(rowDiff.op?.kind).toBe('pair')
    // Inside the changed row, the cell that changed is a difference and the other cell is context.
    const rowInner = rowDiff.inner ?? []
    expect(rowInner.some(piece => piece.kind === 'diff')).toBe(true)
    expect(rowInner.some(piece => piece.kind === 'context')).toBe(true)
  })

  it('plans a changed table HEADER as differences, with matched body rows still context', () => {
    const result = matchMarkdownTrees(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| K! | v |\n|---|---|\n| a | 1 |\n',
    )
    const table = piecesOfDiff(planMergedSiblings(result.ops))
    const inner = table.inner ?? []
    // The changed header cell is a difference; the unchanged one may context-merge with nothing, but the body
    // row remains a context run.
    expect(inner.some(piece => piece.kind === 'diff')).toBe(true)
    expect(inner.some(piece => piece.kind === 'context')).toBe(true)
    const bodyContext = inner.filter(piece => piece.kind === 'context').at(-1)!
    expect(bodyContext.ops?.some(op => op.kind === 'pair' && op.pair.old.type === 'table_row')).toBe(true)
  })

  it('collapses a wholly matched table (header + body) into context with its neighbours', () => {
    const text = 'Before.\n\n| k | v |\n|---|---|\n| a | 1 |\n\nAfter.\n'
    const result = matchMarkdownTrees(text, text)
    const plan = planMergedSiblings(result.ops)
    expect(plan).toHaveLength(1)
    expect(plan[0]!.kind).toBe('context')
    expect(plan[0]!.ops).toHaveLength(3)
    expect(planIsAllContext(plan)).toBe(true)
  })

  it('treats a list whose container attributes changed as a difference, but keeps matched items inside', () => {
    // `-` list → ordered list: the container differs, so the list itself is a difference; its items still match.
    const result = matchMarkdownTrees('- a\n- b\n', '1. a\n2. b\n')
    const list = piecesOfDiff(planMergedSiblings(result.ops))
    expect(list.op?.kind).toBe('pair')
    expect(list.op?.kind === 'pair' ? list.op.pair.old.type : undefined).toBe('list')
    const inner = list.inner ?? []
    // Both items fully matched: inside the changed list, they collapse into context (not new differences).
    expect(inner).toHaveLength(1)
    expect(inner[0]!.kind).toBe('context')
    expect(inner[0]!.ops).toHaveLength(2)
  })

  it('plans a code-language change with the code lines as context inside the fence', () => {
    const result = matchMarkdownTrees('```ts\nconst a = 1\nconst b = 2\n```\n', '```tsx\nconst a = 1\nconst b = 2\n```\n')
    const code = piecesOfDiff(planMergedSiblings(result.ops))
    expect(code.op?.kind).toBe('pair')
    expect(code.op?.kind === 'pair' ? code.op.pair.old.type : undefined).toBe('code')
    const inner = code.inner ?? []
    expect(inner).toHaveLength(1)
    expect(inner[0]!.kind).toBe('context')
    expect(inner[0]!.ops).toHaveLength(2)
  })

  it('recurses into a blockquote with the same rules', () => {
    const result = matchMarkdownTrees('> old quote text here\n', '> new quote text here\n')
    const quote = piecesOfDiff(planMergedSiblings(result.ops))
    expect(quote.op?.kind).toBe('pair')
    expect(quote.op?.kind === 'pair' ? quote.op.pair.old.type : undefined).toBe('blockquote')
    expect(quote.inner?.some(piece => piece.kind === 'diff')).toBe(true)
  })

  it('flags invisible content as differences that carry no rendering (the eye-icon markers)', () => {
    const oldText = 'A.\n\n<!-- old comment -->\n\nB.\n'
    const newText = 'A.\n\n<!-- new comment -->\n\nB.\n'
    const result = matchMarkdownTrees(oldText, newText)
    const plan = planMergedSiblings(result.ops)
    // Context A, invisible difference (the edited comment), context B.
    expect(plan.map(piece => piece.kind)).toEqual(['context', 'diff', 'context'])
    expect(plan[1]!.invisible).toBe(true)
    expect(plan[1]!.op?.kind).toBe('pair')
    // An INSERTED comment is a one-sided invisible difference too.
    const inserted = matchMarkdownTrees('A.\n\nB.\n', 'A.\n\n<!-- new comment -->\n\nB.\n')
    const insertedPlan = planMergedSiblings(inserted.ops)
    const comment = insertedPlan.find(piece => piece.kind === 'diff')!
    expect(comment.invisible).toBe(true)
    expect(comment.pure).toBe('new')
  })

  it('flags front matter changes as invisible differences at the document top', () => {
    const result = matchMarkdownTrees('---\ntitle: A\n---\n\nBody\n', '---\ntitle: B\n---\n\nBody\n')
    const plan = planMergedSiblings(result.ops)
    const front = plan.find(piece => piece.kind === 'diff')!
    expect(front.invisible).toBe(true)
    expect(front.op?.kind).toBe('pair')
  })
})


