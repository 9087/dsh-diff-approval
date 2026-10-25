// The Markdown preview's BLOCK rules, in a CREATION diff (empty baseline → new file) and in table edits.
//
// A "block" is what the preview numbers, navigates, frames and keeps/reverts; a "unit" is the character-level
// change that is highlighted inside it. The rules this file pins down (see `Saved/md-table-blocks-spec.md`):
//
//   1. a pure addition/deletion hunk is ONE block — a whole new paragraph/list/table/document, however many
//      units its lines were cut into (a whole new file must NOT read as one block per changed line);
//   2. a table's delimiter row takes part in nothing — it is not a unit and not a "invisible content" block;
//   3. table rule A: a row present on both sides is one block; its changed cells keep their character-level
//      highlight, and the row itself carries the block so the frame goes round the whole row;
//   4. table rule B: a row with no counterpart on the other side is tinted as a ROW, never cell by cell;
//   5. invisible content (front matter, HTML comments) inside a pure hunk joins that block instead of becoming
//      a block of its own — it is listed in the block's toolbar tabs.
//
// The document mirrors a real filing: heading, multi-line blockquote, paragraph, table with a short cell,
// nested list, and a table delimiter row. Order/nesting/reachability invariants are asserted for both layouts.

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { previewBlocks, previewUnits, renderMarkdownPreview, type PreviewBlock, type PreviewUnit } from '../src/client/markdown-preview.ts'

const DOC = [
  '# 需求规格',
  '',
  '> 第一行说明。',
  '> 第二行说明。',
  '> 第三行说明。',
  '> 第四行说明。',
  '',
  '产品是一套让 AI harness 远程驱动的工具，拆成两个仓库、两层。',
  '',
  '| 组件 | 角色 | 是否依赖 harness |',
  '|---|---|---|',
  '| **A** | 插件 | 否 |',
  '| **B** | 适配 | 是 |',
  '',
  '## 列表',
  '',
  '- 普通列表项。',
  '- **可视化**：',
  '  - 右侧栏：当前会话的历史操作。',
  '  - 会话内：工具卡片显示结果。',
  '- 历史：读会话记录。',
  '',
].join('\n')

/** The unit numbers of the marked elements, in reading order, consecutive repeats collapsed. */
function unitReadingOrder(root: Element): number[] {
  const order: number[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-md-unit]')) {
    const index = Number(element.getAttribute('data-md-unit'))
    if (!Number.isFinite(index)) continue
    if (order[order.length - 1] !== index) order.push(index)
  }
  return order
}

/** The block numbers drawn, in reading order, consecutive repeats collapsed. */
function blockReadingOrder(root: Element): number[] {
  const order: number[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-md-block]')) {
    const index = Number(element.getAttribute('data-md-block'))
    if (!Number.isFinite(index)) continue
    if (order[order.length - 1] !== index) order.push(index)
  }
  return order
}

/** Marks whose ancestor carries a DIFFERENT unit number. */
function nestedUnitMarks(root: Element): string[] {
  const nested: string[] = []
  for (const mark of root.querySelectorAll<HTMLElement>('[data-md-unit]')) {
    const index = mark.getAttribute('data-md-unit')
    let parent = mark.parentElement
    while (parent !== null) {
      const outer = parent.closest('[data-md-unit]')
      if (outer !== null && outer !== mark && outer.getAttribute('data-md-unit') !== index) {
        nested.push(`${mark.tagName} unit ${index} inside ${outer.tagName} unit ${outer.getAttribute('data-md-unit')}`)
      }
      parent = parent.parentElement
    }
  }
  return [...new Set(nested)]
}

/** Units whose block is not drawn anywhere (neither as a unit nor as a block-level tint). */
function unreachableUnits(root: Element, blocks: readonly PreviewBlock[]): number[] {
  const blockOf = new Map<number, number>()
  for (const block of blocks) for (const unit of block.units) blockOf.set(unit.index, block.index)
  const tags = new Set([...root.querySelectorAll('[data-md-block]')].map(element => element.getAttribute('data-md-block')))
  const unitTags = new Set([...root.querySelectorAll('[data-md-unit]')].map(element => element.getAttribute('data-md-unit')))
  const missing: number[] = []
  for (const unit of blocks.flatMap(block => block.units)) {
    const block = blockOf.get(unit.index)
    if (block !== undefined && tags.has(String(block))) continue
    if (unitTags.has(String(unit.index))) continue
    missing.push(unit.index)
  }
  return missing
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Units whose own visible text is on the page but that neither their block nor a unit mark reaches. */
function visibleUnreachableUnits(root: Element, units: readonly PreviewUnit[], blocks: readonly PreviewBlock[]): number[] {
  const blockOf = new Map<number, number>()
  for (const block of blocks) for (const unit of block.units) blockOf.set(unit.index, block.index)
  const tags = new Set([...root.querySelectorAll('[data-md-block]')].map(element => element.getAttribute('data-md-block')))
  const visible = normalize(root.textContent ?? '')
  const missing: number[] = []
  for (const unit of units) {
    const oldNormalized = normalize(unit.oldText)
    const newNormalized = normalize(unit.newText)
    if (unit.oldText !== unit.newText && oldNormalized !== '' && oldNormalized === newNormalized) continue
    const wanted = [oldNormalized, newNormalized].filter(text => text !== '')
    if (wanted.length === 0) continue
    if (!wanted.some(text => visible.includes(text))) continue
    const block = blockOf.get(unit.index)
    if (block === undefined || !tags.has(String(block))) missing.push(unit.index)
  }
  return missing
}

/** Assert order, nesting and reachability on one reading of the document. */
function expectInvariants(root: Element, blocks: readonly PreviewBlock[], where: string): void {
  const order = unitReadingOrder(root)
  for (let index = 1; index < order.length; index++) {
    expect(order[index]!, `${where}: unit ${order[index]} drawn after unit ${order[index - 1]} (${JSON.stringify(order)})`)
      .toBeGreaterThanOrEqual(order[index - 1]!)
  }
  const blocksOrder = blockReadingOrder(root)
  for (let index = 1; index < blocksOrder.length; index++) {
    expect(blocksOrder[index]!, `${where}: block ${blocksOrder[index]} drawn after block ${blocksOrder[index - 1]} (${JSON.stringify(blocksOrder)})`)
      .toBeGreaterThanOrEqual(blocksOrder[index - 1]!)
  }
  expect(nestedUnitMarks(root), `${where}: nested changes`).toEqual([])
  expect(unreachableUnits(root, blocks), `${where}: unreachable units`).toEqual([])
  const units = blocks.flatMap(block => block.units)
  expect(visibleUnreachableUnits(root, units, blocks), `${where}: visible units with no block`).toEqual([])
}

const render = (layout: 'single' | 'double', oldText = '', newText = DOC): HTMLElement => {
  const holder = document.createElement('div')
  holder.innerHTML = renderMarkdownPreview(oldText, newText, layout, 'structure')
  return holder
}

describe('Markdown preview · a CREATION diff is ONE block', () => {
  const blocks = previewBlocks('', DOC)
  const units = previewUnits('', DOC)

  it('merges the whole new file into one block, however many units its lines hold', () => {
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
    expect(blocks[0]!.units).toHaveLength(units.length)
    // An empty baseline: the old side is the insertion point (1), not a line.
    expect(blocks[0]!.oldStart).toBe(1)
    expect(blocks[0]!.oldEnd).toBe(0)
    expect(blocks[0]!.newStart).toBe(1)
    expect(blocks[0]!.newEnd).toBe(DOC.split('\n').length - 1)
  })

  it('draws the one block over the whole document, tinted, with no block-per-line numbering', () => {
    const root = render('single')
    // The first block of the reading is the heading itself — not a leftover marker for a unit far below.
    expect(root.firstElementChild?.tagName).toBe('H1')
    expect(blockReadingOrder(root)).toEqual([0])
    // The whole block is tinted: the top-level elements are added surfaces, and no character-level run is
    // needed for an all-new document.
    for (const element of root.querySelectorAll<HTMLElement>('[data-md-block="0"]')) {
      expect(element.classList.contains('mdAdd'), element.tagName).toBe(true)
    }
    expect(root.querySelectorAll('[data-md-unit]')).toHaveLength(0)
    expect(root.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
    expect(root.querySelector('[data-md-block="1"]')).toBeNull()
    expectInvariants(root, blocks, 'single column')
  })

  it('does not compare a table\'s delimiter row: no unit, no invisible-content block', () => {
    expect(units.some(unit => /^\|?\s*:?-{3,}/.test(unit.newText.trim()) && unit.newText.includes('|'))).toBe(false)
    const invisible = blocks.flatMap(block => block.invisible)
    expect(invisible.some(diff => (diff.newText ?? '').includes('---'))).toBe(false)
    const root = render('single')
    // No chip reports it, and the table is part of the one tinted block rather than a marker inside it.
    expect([...root.querySelectorAll<HTMLElement>('.mdTwinPhantom')]
      .some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('---'))).toBe(false)
    const table = root.querySelector('table') as HTMLElement
    expect(table).not.toBeNull()
    expect(table.getAttribute('data-md-block')).toBe('0')
  })

  it('keeps adjacent complete new blocks of every kind as ONE block', () => {
    const oldText = '# T\n'
    const newText = [
      '# T',
      '',
      '- first',
      '- second',
      '- third',
      '',
      'One whole new paragraph.',
      '',
      '> A new quote.',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '| h |',
      '| --- |',
      '| cell |',
      '',
    ].join('\n')
    const docBlocks = previewBlocks(oldText, newText)
    // The added lines form ONE hunk: paragraph, list, quote, code and table are one block (rule 5).
    expect(docBlocks).toHaveLength(1)
    const root = render('single', oldText, newText)
    for (const selector of ['ul', 'p', 'blockquote', 'pre', 'table']) {
      const element = root.querySelector(selector) as HTMLElement
      expect(element, selector).not.toBeNull()
      expect(element.getAttribute('data-md-block'), selector).toBe('0')
      expect(element.classList.contains('mdAdd'), selector).toBe(true)
    }
    expect(blockReadingOrder(root)).toEqual([0])
    expect(root.querySelector('[data-md-block="1"]')).toBeNull()
  })

  it('merges invisible content into the block, listing it in the block\'s own source', () => {
    const front = '---\ntitle: T\n---\n\n# H\n\n<!-- a comment -->\n\nBody\n'
    const docBlocks = previewBlocks('', front)
    expect(docBlocks).toHaveLength(1)
    const invisible = docBlocks[0]!.invisible
    // The front matter and the comment are the block's invisible parts — each with its line numbers.
    expect(invisible.some(diff => diff.grammar === 'yaml' && diff.newLines?.start === 1)).toBe(true)
    expect(invisible.some(diff => (diff.newText ?? '').includes('a comment'))).toBe(true)
    const root = render('single', '', front)
    // They do NOT become chunks of their own in the document.
    expect(root.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
    expect(blockReadingOrder(root)).toEqual([0])
  })

  it('holds the same invariants in both columns of the double view', () => {
    const holder = render('double')
    const columns = [...holder.querySelectorAll<HTMLElement>('[data-diff-doc-side]')]
    expect(columns.length).toBe(2)
    // The baseline is empty: the before column has nothing to draw; the after column carries the whole block.
    expect(blockReadingOrder(columns[0]!)).toEqual([])
    expect(blockReadingOrder(columns[1]!)).toEqual([0])
    expectInvariants(columns[1]!, blocks, 'double new column')
  })
})

describe('Markdown preview · table rules A and B', () => {
  const TABLE = (rows: string[]): string => ['| k | v |', '| --- | --- |', ...rows, ''].join('\n')

  it('rule A: a row with a changed cell is ONE block, and its runs keep their own highlights', () => {
    const oldText = TABLE(['| a | 1 |', '| b | 2 |'])
    const newText = TABLE(['| a | ONE |', '| b | 2 |'])
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    const root = render('single', oldText, newText)
    const row = root.querySelector('tbody tr') as HTMLElement
    expect(row).not.toBeNull()
    // The row itself carries the block (so the frame encloses the whole row)…
    expect(row.getAttribute('data-md-block')).toBe('0')
    expect(row.hasAttribute('data-md-whole-row')).toBe(false)
    // …while the changed cell keeps its character-level run and the unchanged one carries nothing.
    const cells = [...row.children] as HTMLElement[]
    expect(cells[0]!.hasAttribute('data-md-block')).toBe(false)
    expect(cells[0]!.querySelector('[data-md-unit]')).toBeNull()
    const run = row.querySelector('.mdWordAdd') as HTMLElement
    expect(run).not.toBeNull()
    expect(run.getAttribute('data-md-unit')).toBe('0')
    expect(run.getAttribute('data-md-block')).toBe('0')
  })

  it('rule B: an added row with no counterpart is tinted as a ROW, not cell by cell', () => {
    const oldText = TABLE(['| a | 1 |', '| b | 2 |'])
    const newText = TABLE(['| a | 1 |', '| b | TWO |', '| c | 3 |'])
    const blocks = previewBlocks(oldText, newText)
    // The changed row and the added row are two blocks.
    expect(blocks).toHaveLength(2)
    expect(blocks.some(block => block.wholeRow === 'add')).toBe(true)
    const added = blocks.find(block => block.wholeRow === 'add')!
    // A pure insertion: the old side is empty at its insertion point.
    expect(added.oldStart).toBe(added.oldEnd + 1)
    const root = render('single', oldText, newText)
    const rows = [...root.querySelectorAll<HTMLElement>('tbody tr')]
    expect(rows).toHaveLength(3)
    const addedRow = rows[2]!
    expect(addedRow.getAttribute('data-md-block')).toBe(String(added.index))
    expect(addedRow.hasAttribute('data-md-whole-row')).toBe(true)
    expect(addedRow.classList.contains('mdAdd')).toBe(true)
    // No cell and no word run inside it is a change: the row is the change.
    for (const cell of addedRow.children) {
      expect(cell.hasAttribute('data-md-block')).toBe(false)
      expect(cell.hasAttribute('data-md-unit')).toBe(false)
      expect(cell.querySelector('[data-md-unit]')).toBeNull()
    }
    expect(addedRow.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
    expectInvariants(root, blocks, 'rule B row')
  })

  it('rule B: a lone added row is a pure hunk, and still one whole-row block', () => {
    const oldText = TABLE(['| a | 1 |', '| b | 2 |'])
    const newText = TABLE(['| a | 1 |', '| b | 2 |', '| c | 3 |'])
    const blocks = previewBlocks(oldText, newText)
    // A pure addition hunk is ONE merged block (rule 1) — and it is still drawn as a row, not cell by cell.
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
    const root = render('single', oldText, newText)
    const addedRow = [...root.querySelectorAll<HTMLElement>('tbody tr')][2]!
    expect(addedRow.getAttribute('data-md-block')).toBe('0')
    expect(addedRow.hasAttribute('data-md-whole-row')).toBe(true)
    expect(addedRow.classList.contains('mdAdd')).toBe(true)
    expect(addedRow.querySelectorAll('[data-md-unit]')).toHaveLength(0)
    expect(addedRow.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
  })

  it('rule B: a deleted row with no counterpart is a struck ROW in the single column', () => {
    const oldText = TABLE(['| a | 1 |', '| b | 2 |', '| c | 3 |'])
    const newText = TABLE(['| a | 1 |', '| b | TWO |'])
    const blocks = previewBlocks(oldText, newText)
    expect(blocks.some(block => block.wholeRow === 'del')).toBe(true)
    const root = render('single', oldText, newText)
    const ghosts = [...root.querySelectorAll<HTMLElement>('tbody tr.mdDel')]
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0]!.getAttribute('data-md-whole-row')).toBe('')
    expect(ghosts[0]!.textContent).toContain('c')
    // The ghost is the whole row, not a cell: no unit marks inside it.
    expect(ghosts[0]!.querySelectorAll('[data-md-unit]')).toHaveLength(0)
  })
})

// Spec §6: the line diff pairs a deletion with an addition by POSITION, but position is not meaning. When the
// two sides share almost nothing, that is a pure deletion plus a pure addition — one merged block drawn as
// block-level versions — not a modification to diff character by character.
// Spec §7: the double view's row alignment is LAYOUT. A deleted row and an unrelated added row may share a row
// because their positions match; that must not make them "matched" — the block model decides, and the same
// block index has to be on both columns so the frame/keep union both.
describe('Markdown preview · unrelated del/add (rules 6 and 7)', () => {
  const TABLE = (rows: string[]): string => ['| k | v |', '| --- | --- |', ...rows, ''].join('\n')

  it('rule 6: an unrelated replacement is ONE merged block of a pure deletion and a pure addition', () => {
    const oldText = 'English paragraph only.\n'
    const newText = '一段完全无关的中文内容。\n'
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
    expect([blocks[0]!.oldStart, blocks[0]!.oldEnd]).toEqual([1, 1])
    expect([blocks[0]!.newStart, blocks[0]!.newEnd]).toEqual([1, 1])
    const root = render('single', oldText, newText)
    // Block-level versions: the old paragraph struck above the new one tinted — never the two texts merged
    // character by character into one paragraph.
    const paragraphs = [...root.querySelectorAll<HTMLElement>('p')]
    expect(paragraphs).toHaveLength(2)
    const ghost = root.querySelector('p.mdDel') as HTMLElement
    const added = root.querySelector('p.mdAdd') as HTMLElement
    expect(ghost).not.toBeNull()
    expect(added).not.toBeNull()
    expect(ghost.textContent).toBe('English paragraph only.')
    expect(added.textContent).toBe('一段完全无关的中文内容。')
    expect(ghost.getAttribute('data-md-block')).toBe(added.getAttribute('data-md-block'))
    expect(ghost.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(root.querySelectorAll('[data-md-unit]')).toHaveLength(0)
    expect(root.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
    expectInvariants(root, blocks, 'rule 6 single column')
  })

  it('rule 6: unrelated table rows are pure rows tinted as ROWS, inside ONE block', () => {
    const oldText = TABLE(['| x | 1 |'])
    const newText = TABLE(['| y | 2 |'])
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
    const root = render('single', oldText, newText)
    const ghost = root.querySelector('tbody tr.mdDel') as HTMLElement
    const added = root.querySelector('tbody tr.mdAdd') as HTMLElement
    expect(ghost, 'the deleted row is drawn struck').not.toBeNull()
    expect(added, 'the added row is drawn tinted').not.toBeNull()
    expect(ghost.getAttribute('data-md-block')).toBe(added.getAttribute('data-md-block'))
    // Rule B inside the merged block: the row is the change, no cell/word marks.
    for (const row of [ghost, added]) {
      expect(row.hasAttribute('data-md-whole-row')).toBe(true)
      expect(row.querySelectorAll('[data-md-unit]')).toHaveLength(0)
      expect(row.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
    }
    expect(root.querySelectorAll('[data-md-unit]')).toHaveLength(0)
    expectInvariants(root, blocks, 'rule 6 table rows')
  })

  it('rule 6: a hunk with one unrelated line pair is replaced whole, never interleaved', () => {
    // One hunk may hold several ordered pairs where only one is unrelated (a list whose middle item was
    // replaced by an unrelated sentence). That pair must not be diffed character by character and merged into
    // one item; the conservative rendering is the hunk's two whole versions (old struck, new tinted).
    const oldText = '- Alpha version 1\n- English only line\n- Beta version 1\n'
    const newText = '- Alpha version 2\n- 一段无关中文\n- Beta version 2\n'
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
    const root = render('single', oldText, newText)
    // No item carries words from BOTH versions (the nonsense interleave the rule exists to prevent).
    for (const item of root.querySelectorAll('li')) {
      const text = item.textContent ?? ''
      expect(text.includes('English only') && text.includes('一段无关'), text).toBe(false)
      expect(text.includes('Alpha version 1') && text.includes('Alpha version 2'), text).toBe(false)
    }
    // The two whole list versions are drawn at block level, with no character runs.
    const lists = [...root.querySelectorAll<HTMLElement>('ul')]
    expect(lists.some(list => list.classList.contains('mdDel'))).toBe(true)
    expect(lists.some(list => list.classList.contains('mdAdd'))).toBe(true)
    expect(root.querySelectorAll('[data-md-unit]')).toHaveLength(0)
    expect(root.querySelectorAll('[data-md-block="1"]')).toHaveLength(0)
  })

  it('rule 6: a similar edit is still a modification, not a merged pure block', () => {
    const oldText = 'Version 1 text.\n'
    const newText = 'Version 2 text.\n'
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(false)
    expect(blocks[0]!.oldChars).toBeDefined()
    const root = render('single', oldText, newText)
    // The changed characters are drawn inside ONE paragraph, with the unchanged words around them.
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.querySelector('.mdWordDel')!.textContent).toBe('1')
    expect(root.querySelector('.mdWordAdd')!.textContent).toBe('2')
    expect(root.querySelector('p.mdDel')).toBeNull()
  })

  it('rule 7: the same block spans both columns, even when the shared row is only layout', () => {
    // An unrelated deleted row and added row: the double view lays them on one row by position, and the block
    // model still says "pure deletion + pure addition, one block" — both columns carry the SAME block index.
    const oldText = TABLE(['| x | 1 |'])
    const newText = TABLE(['| y | 2 |'])
    const holder = render('double', oldText, newText)
    const columns = [...holder.querySelectorAll<HTMLElement>('[data-diff-doc-side]')]
    expect(columns).toHaveLength(2)
    const oldRow = columns[0]!.querySelector<HTMLElement>('tbody tr.mdDel')!
    const newRow = columns[1]!.querySelector<HTMLElement>('tbody tr.mdAdd')!
    expect(oldRow, 'old column row').not.toBeNull()
    expect(newRow, 'new column row').not.toBeNull()
    expect(oldRow.getAttribute('data-md-block')).toBe(newRow.getAttribute('data-md-block'))
    expect(oldRow.getAttribute('data-md-block')).toBe('0')
    // …and they sit on the same LAYOUT row, which is exactly what rule 7 says must not be read as matching.
    const gridRow = (row: HTMLElement): string | undefined =>
      (row.closest('[style*="grid-row"]') as HTMLElement | null)?.style.gridRow
    expect(gridRow(oldRow)).toBeDefined()
    expect(gridRow(oldRow)).toBe(gridRow(newRow))
    const blocks = previewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.merged).toBe(true)
  })
})
