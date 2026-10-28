// The tree path's preview MODEL: units (character-level highlights) and blocks (what the reader counts, hovers,
// keeps and reverts), derived from the syntax-tree match plan rather than from line hunks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { treePreviewModel } from '../src/client/markdown-tree-blocks.ts'

const richOld = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'old.md'), 'utf8')
const richNew = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'new.md'), 'utf8')

const modelOf = (oldText: string, newText: string): ReturnType<typeof treePreviewModel> => treePreviewModel(oldText, newText)

describe('tree preview model: blocks and units', () => {
  it('has no blocks when nothing changed', () => {
    const model = modelOf('# T\n\nSame.\n', '# T\n\nSame.\n')
    expect(model.blocks).toEqual([])
    expect(model.units).toEqual([])
  })

  it('merges a whole new document into ONE block, apart from invisible content', () => {
    const model = modelOf('', '# H\n\nPara.\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.merged).toBe(true)
    expect(block.kind).toBe('node')
    expect(block.newStart).toBe(1)
    expect(block.newEnd).toBe(3)
    // The absent old side is an empty range whose start is the insertion point (line 1).
    expect(block.oldStart).toBe(1)
    expect(block.oldEnd).toBe(0)

    const withFront = modelOf('', '---\ntitle: T\n---\n\n# H\n')
    expect(withFront.blocks).toHaveLength(2)
    // Front matter renders nothing: it degrades to a SOURCE twin (old above new, here new-only).
    expect(withFront.blocks[0]!.kind).toBe('source')
    expect(withFront.blocks[0]!.newNodes[0]!.type).toBe('front_matter')
    expect(withFront.blocks[0]!.newStart).toBe(1)
    expect(withFront.blocks[0]!.newEnd).toBe(3)
    expect(withFront.blocks[1]!.merged).toBe(true)
    expect(withFront.blocks[1]!.newStart).toBe(5)
  })

  it('makes a similar text edit one block with character units and its char ranges', () => {
    const model = modelOf('Old text here.\n', 'New text here.\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    // The block is the changed inline CHILD (the text run), not the paragraph around it: blocks never nest.
    expect(block.kind).toBe('text')
    expect(block.inlineContainer).toBeDefined()
    expect(block.merged).toBe(false)
    expect([block.oldStart, block.oldEnd]).toEqual([1, 1])
    expect([block.newStart, block.newEnd]).toEqual([1, 1])
    expect(block.units).toHaveLength(1)
    expect([block.units[0]!.oldText, block.units[0]!.newText]).toEqual(['Old', 'New'])
    // Exactly one unit and no invisible part: the block exposes character ranges for character-level keep.
    expect(block.oldChars).toEqual(block.units[0]!.oldChars)
    expect(block.newChars).toEqual(block.units[0]!.newChars)
    expect(model.units.map(unit => unit.index)).toEqual([0])
  })

  it('does NOT expose character ranges for a multi-line merged addition (keep must use whole lines)', () => {
    const model = modelOf('Keep.\n', 'Keep.\n\n- added one\n- added two\n')
    const added = model.blocks.find(block => block.oldNodes.length === 0 && block.newNodes.length > 0)!
    expect(added.merged).toBe(true)
    // Two added lines: a character-level keep would splice text into the middle of a line and corrupt the
    // baseline. The block must fall back to its whole line range.
    expect(added.oldChars).toBeUndefined()
    expect(added.newChars).toBeUndefined()
  })

  it('splits the changes of ONE line into one block each, keeping the text between them as context', () => {
    const oldText = '一段**普通**说明，其中有 **加粗重点**、`行内代码`，以及一个 [文档链接](https://example.com/v1/guide)。\n'
    const newText = '一段**新的**说明，其中有 **重点加粗**、`行内代码`，以及一个 [文档链接](https://example.com/v2/guide)。\n'
    const model = modelOf(oldText, newText)
    const lineBlocks = model.blocks.filter(block => block.inlineContainer !== undefined)
    // The two strong changes and the retargeted link are separate blocks — the unchanged words between them
    // are context, not something that glues them into one frame.
    expect(lineBlocks.length).toBeGreaterThanOrEqual(3)
    const link = lineBlocks.find(block =>
      block.oldNodes.some(node => node.raw.includes('example.com/v1/guide')))
    expect(link).toBeDefined()
    expect(link!.newNodes.some(node => node.raw.includes('example.com/v2/guide'))).toBe(true)
    for (const block of lineBlocks) expect(block.merged).toBe(false)
    // A one-unit block exposes its exact character ranges for character-level keep.
    for (const block of lineBlocks.filter(candidate => candidate.units.length === 1)) {
      expect(block.oldChars).toEqual(block.units[0]!.oldChars)
      expect(block.newChars).toEqual(block.units[0]!.newChars)
    }
  })

  it('keeps a rewritten sentence as ONE block instead of one block per character run', () => {
    // The two texts barely align: the renderer must draw the whole line as one replacement, so splitting the
    // char runs into two blocks would give one block the whole line and leave the other with nothing.
    const model = modelOf('待删除的一段：这段话在新版本里会被删掉。\n', '新增的一段说明。\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.kind).toBe('text')
    expect(block.units.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps a nested list item change OUT of its parent item, and makes a checkbox its own block', () => {
    const oldText = '- 第二项：旧的描述\n  - 子项 A\n  - 子项 B\n- [ ] 待办：补测试\n'
    const newText = '- 第二项：新的描述\n  - 子项 A\n  - 子项 B（更新）\n- [x] 待办：补测试\n'
    const model = modelOf(oldText, newText)
    const units = model.blocks.flatMap(block => block.units)
    // The parent item's own word change is one block.
    expect(units.some(unit => unit.oldText === '旧' && unit.newText === '新')).toBe(true)
    // The nested item's appended text is a block of its own, not flattened into the parent's unit.
    const nested = units.find(unit => unit.newText.includes('（更新）'))
    expect(nested).toBeDefined()
    expect(nested!.oldText).toBe('')
    // Unchanged nested item A is context: no unit mentions it.
    expect(units.some(unit => unit.oldText.includes('子项 A') || unit.newText.includes('子项 A'))).toBe(false)
    // The checkbox state change is its own block (marked by its box, not by a text unit).
    const checkbox = model.blocks.find(block => block.kind === 'checkbox')
    expect(checkbox).toBeDefined()
    expect(checkbox!.oldNodes[0]!.raw).toContain('[ ]')
    expect(checkbox!.newNodes[0]!.raw).toContain('[x]')
  })

  it('keeps exactly one block when the line has exactly one inline change', () => {
    const model = modelOf('Old text here.\n', 'New text here.\n')
    expect(model.blocks).toHaveLength(1)
    expect(model.blocks[0]!.kind).toBe('text')
    expect(model.blocks[0]!.units).toHaveLength(1)
  })

  it('draws an unrelated type-matched replacement as a whole merged block, not a character edit', () => {
    const model = modelOf('English paragraph only.\n', '一段完全无关的中文内容。\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.merged).toBe(true)
    expect(block.units).toEqual([])
    expect([block.oldStart, block.oldEnd]).toEqual([1, 1])
    expect([block.newStart, block.newEnd]).toEqual([1, 1])
  })

  it('blocks an inserted list item on its own and leaves the matched items as context', () => {
    const model = modelOf('- alpha\n- beta\n', '- alpha\n- inserted\n- beta\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.kind).toBe('list_item')
    expect(block.merged).toBe(true)
    expect([block.newStart, block.newEnd]).toEqual([2, 2])
    // Inserted before old line 2 (`- beta`).
    expect([block.oldStart, block.oldEnd]).toEqual([2, 1])
  })

  it('blocks an edited item as one TEXT block inside the item, and an unrelated item as a replacement', () => {
    const edited = modelOf('- alpha\n- beta\n', '- alpha\n- beta EDITED\n')
    expect(edited.blocks).toHaveLength(1)
    expect(edited.blocks[0]!.kind).toBe('text')
    expect(edited.blocks[0]!.inlineContainer?.old?.type).toBe('list_item')
    expect(edited.blocks[0]!.merged).toBe(false)
    expect(edited.blocks[0]!.units.length).toBeGreaterThan(0)
    const unrelated = modelOf('- alpha\n- English item here\n', '- alpha\n- 完全不同的一条中文\n')
    expect(unrelated.blocks).toHaveLength(1)
    expect(unrelated.blocks[0]!.merged).toBe(true)
    expect(unrelated.blocks[0]!.units).toEqual([])
  })

  it('blocks a changed table cell as an inline block INSIDE that cell', () => {
    const model = modelOf(
      '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| b | TWO |\n',
    )
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.kind).toBe('text')
    expect(block.inlineContainer?.new?.type).toBe('table_cell')
    expect(block.inlineContainer?.new?.raw.trim()).toBe('TWO')
    expect(block.merged).toBe(false)
    expect([block.oldStart, block.oldEnd]).toEqual([4, 4])
    expect(block.units.length).toBe(1)
    expect([block.units[0]!.oldText, block.units[0]!.newText]).toEqual(['2', 'TWO'])
  })

  it('blocks two changed cells of one row as TWO cell blocks, never one row block', () => {
    const model = modelOf(
      '| k | v | w |\n|---|---|---|\n| a | 1 | x |\n',
      '| k | v | w |\n|---|---|---|\n| a | TWO | y |\n',
    )
    expect(model.blocks).toHaveLength(2)
    const containers = model.blocks.map(block => block.inlineContainer?.new?.raw.trim())
    expect(containers).toEqual(['TWO', 'y'])
    for (const block of model.blocks) {
      expect(block.kind).toBe('text')
      expect(block.merged).toBe(false)
      expect(block.units).toHaveLength(1)
      expect(block.oldStart).toBe(3)
    }
    expect(model.blocks[0]!.units[0]!.newText).toBe('TWO')
    expect(model.blocks[1]!.units[0]!.newText).toBe('y')
  })

  it('blocks a row present on one side only as a whole-row block (B), and a changed header as its own row', () => {
    const added = modelOf(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| x | 9 |\n',
    )
    expect(added.blocks).toHaveLength(1)
    expect(added.blocks[0]!.kind).toBe('table_row')
    expect(added.blocks[0]!.merged).toBe(true)
    expect(added.blocks[0]!.wholeRow).toBe('add')
    expect([added.blocks[0]!.newStart, added.blocks[0]!.newEnd]).toEqual([4, 4])
    const header = modelOf(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| K! | v |\n|---|---|\n| a | 1 |\n',
    )
    expect(header.blocks).toHaveLength(1)
    expect(header.blocks[0]!.kind).toBe('table_header')
    expect([header.blocks[0]!.oldStart, header.blocks[0]!.oldEnd]).toEqual([1, 1])
    expect(header.blocks[0]!.units.length).toBe(1)
  })

  it('blocks a table whose column alignment changed as one container block, with no cell/row diff', () => {
    const model = modelOf(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| k | v |\n|:--|--:|\n| a | 1 |\n',
    )
    // Only the alignment of the columns changed; the row is untouched. That is the TABLE's own difference.
    expect(model.blocks).toHaveLength(1)
    expect(model.blocks[0]!.kind).toBe('table')
    expect(model.blocks[0]!.units).toEqual([])
  })

  it('blocks a code fence per changed LINE GROUP, with whole-line units', () => {
    const model = modelOf('```ts\nconst a = 1\nconst b = 2\n```\n', '```ts\nconst a = 1\nconst b = 3\n```\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.kind).toBe('code')
    expect([block.oldStart, block.oldEnd]).toEqual([1, 4])
    expect([block.newStart, block.newEnd]).toEqual([1, 4])
    expect(block.units.length).toBe(1)
    expect([block.units[0]!.oldText, block.units[0]!.newText]).toEqual(['const b = 2', 'const b = 3'])

    // Two edits on non-adjacent lines are two blocks, never one frame around the whole fence.
    const split = modelOf('```\nAA\nBB\nCC\nDD\n```\n', '```\nAA\nXX\nCC\nYY\n```\n')
    expect(split.blocks).toHaveLength(2)
    expect(split.blocks[0]!.kind).toBe('code')
    expect(split.blocks[0]!.units[0]!.newText).toBe('XX')
    expect(split.blocks[1]!.units[0]!.newText).toBe('YY')

    const language = modelOf('```ts\nconst a = 1\n```\n', '```tsx\nconst a = 1\n```\n')
    expect(language.blocks).toHaveLength(1)
    expect(language.blocks[0]!.kind).toBe('code')
    // Different languages: the fence pair is a whole replacement, never a line-by-line comparison.
    expect(language.blocks[0]!.merged).toBe(true)
  })

  it('blocks a deleted paragraph as a merged deletion whose empty new range inserts at its old position', () => {
    const model = modelOf('A.\n\nGone.\n\nB.\n', 'A.\n\nB.\n')
    expect(model.blocks).toHaveLength(1)
    const block = model.blocks[0]!
    expect(block.merged).toBe(true)
    expect([block.oldStart, block.oldEnd]).toEqual([3, 3])
    expect(block.newStart).toBe(3)
    expect(block.newEnd).toBe(2)
  })

  it('degrades invisible changes to source twins at their document position', () => {
    const comment = modelOf('A.\n\n<!-- old -->\n\nB.\n', 'A.\n\n<!-- new -->\n\nB.\n')
    expect(comment.blocks).toHaveLength(1)
    // A comment renders nothing: its whole Markdown source is the block (old and new versions).
    expect(comment.blocks[0]!.kind).toBe('source')
    expect(comment.blocks[0]!.invisible).toEqual([])
    expect(comment.blocks[0]!.oldNodes[0]!.raw).toContain('old')
    expect(comment.blocks[0]!.newNodes[0]!.raw).toContain('new')
    expect([comment.blocks[0]!.oldStart, comment.blocks[0]!.oldEnd]).toEqual([3, 3])
    const front = modelOf('---\ntitle: A\n---\n\nBody\n', '---\ntitle: B\n---\n\nBody\n')
    expect(front.blocks).toHaveLength(1)
    expect(front.blocks[0]!.kind).toBe('source')
    expect(front.blocks[0]!.oldNodes[0]!.raw).toContain('title: A')
    expect(front.blocks[0]!.newNodes[0]!.raw).toContain('title: B')
  })

  it('numbers blocks and units in reading order, each unit mapped to its block', () => {
    const model = modelOf(richOld, richNew)
    expect(model.blocks.length).toBeGreaterThan(20)
    expect(model.blocks.map(block => block.index)).toEqual(model.blocks.map((_block, index) => index))
    expect(model.units.map(unit => unit.index)).toEqual(model.units.map((_unit, index) => index))
    // Every block's unit lists are exactly the model's units, each listed once.
    const listed = model.blocks.flatMap(block => block.units.map(unit => unit.index)).sort((left, right) => left - right)
    expect(listed).toEqual(model.units.map(unit => unit.index))
    // Reading order: each block's new-side position (its insertion point, for a deletion) never moves backwards.
    let previous = 0
    for (const block of model.blocks) {
      expect(block.newStart).toBeGreaterThanOrEqual(previous)
      previous = block.newStart
    }
    // The kinds the tree path can produce are present: inline-child blocks (text/link/strong/…), element
    // blocks, and structure blocks.
    const kinds = new Set(model.blocks.map(block => block.kind))
    expect(kinds).toContain('text')
    expect(kinds).toContain('link')
    expect(kinds).toContain('code')
    expect(kinds).toContain('source')
    expect(model.blocks.filter(block => block.inlineContainer !== undefined).length).toBeGreaterThan(10)
  })
})
