// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { flowPreviewBlocks, renderFlowDouble, renderFlowMerged } from '../src/client/markdown-preview.ts'

/** One block's line ranges, as the panel's keep/revert sends them to the host. */
function rangesOf(oldText: string, newText: string): { kind: string; oldStart: number; oldEnd: number; newStart: number; newEnd: number }[] {
  return flowPreviewBlocks(oldText, newText).map(block => ({
    kind: (block as unknown as { kind: string }).kind,
    oldStart: block.oldStart,
    oldEnd: block.oldEnd,
    newStart: block.newStart,
    newEnd: block.newEnd,
  }))
}

describe('flow preview block ranges', () => {
  it('anchors a pure addition BETWEEN two paragraphs before the following old paragraph', () => {
    // old: 1 第一段。, 2 blank, 3 第三段。
    // new: 1 第一段。, 2 blank, 3 新增段。, 4 blank, 5 第三段。
    // The added hunk is lines 3-4 of the new file; on the old side it inserts before line 3 (the next
    // surviving content), NOT at line 0/1 and NOT before the blank separator at line 2.
    expect(rangesOf('第一段。\n\n第三段。\n', '第一段。\n\n新增段。\n\n第三段。\n')).toEqual([
      { kind: 'plain', oldStart: 3, oldEnd: 2, newStart: 3, newEnd: 4 },
    ])
  })

  it('anchors a pure deletion BEFORE the next surviving new paragraph and includes its trailing blank', () => {
    expect(rangesOf('第一段。\n\n旧段。\n\n第三段。\n', '第一段。\n\n第三段。\n')).toEqual([
      { kind: 'plain', oldStart: 3, oldEnd: 4, newStart: 3, newEnd: 2 },
    ])
  })

  it('anchors an addition at the top of the file at line 1', () => {
    expect(rangesOf('第三段。\n', '第一段。\n\n第三段。\n')).toEqual([
      { kind: 'plain', oldStart: 1, oldEnd: 0, newStart: 1, newEnd: 2 },
    ])
  })

  it('anchors an addition at the end of the file after the last old line', () => {
    expect(rangesOf('第一段。\n', '第一段。\n\n新增段。\n')).toEqual([
      { kind: 'plain', oldStart: 2, oldEnd: 1, newStart: 2, newEnd: 3 },
    ])
  })

  it('keeps both sides for a matched replacement', () => {
    expect(rangesOf('# 标题\n\n旧段落。\n', '# 标题\n\n新段落。\n')).toEqual([
      { kind: 'plain', oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 },
    ])
  })

  it('gives a changed table row real line ranges on both sides', () => {
    const blocks = rangesOf(
      '| A | B |\n| --- | --- |\n| r1 | 1 |\n| r2 | 2 |\n',
      '| A | B |\n| --- | --- |\n| r1 | 1 |\n| r2 | 3 |\n',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('table')
    expect(blocks[0]!.oldStart).toBeLessThanOrEqual(4)
    expect(blocks[0]!.oldEnd).toBeGreaterThanOrEqual(4)
    expect(blocks[0]!.newStart).toBeLessThanOrEqual(4)
    expect(blocks[0]!.newEnd).toBeGreaterThanOrEqual(4)
  })

  it('keeps the native banner/surface on an UNCHANGED fenced block', () => {
    const doc = '# 标题\n\n段落。\n\n```js\nconst a = 1\n```\n'
    const html = renderFlowMerged(doc, doc)
    expect(html).toContain('mdFlowCodeBanner')
    expect(html).toContain('mdFlowCodeBlock')
    expect(html).toContain('mdFlowCodeBannerLang')
  })

  it('keeps untouched list items in context when a sibling edit makes the list loose', () => {
    // An image inside one item makes `marked` wrap EVERY item of the list in a <p> (a loose list). That is a
    // list-layout change, not a change of the untouched items: only the item that gained the image and the
    // reworded one may be drawn as differences, and the untouched item must stay a single context row.
    const oldText = '## Features\n\n- alpha item\n- beta item\n- gamma item\n'
    const newText = '## Features\n\n- alpha item\n\n  ![shot](a.png)\n\n- beta item now reworded\n- gamma item\n'
    const blocks = flowPreviewBlocks(oldText, newText)
    expect(blocks).toHaveLength(1)
    const root = document.createElement('div')
    root.innerHTML = renderFlowMerged(oldText, newText)
    const rows = [...root.querySelectorAll('.mdFlowRow')]
    const gammaRows = rows.filter(row => row.textContent?.includes('gamma item'))
    expect(gammaRows).toHaveLength(1)
    expect(gammaRows[0]!.classList.contains('mdFlowRow-context')).toBe(true)
  })

  it('keeps a WHOLE new/deleted file as ONE block even across tables and fences', () => {
    const newDoc = '# 标题\n\n段落。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1\n```\n'
    const added = flowPreviewBlocks('', newDoc).map(block => ({
      oldStart: block.oldStart,
      oldEnd: block.oldEnd,
      newStart: block.newStart,
      newEnd: block.newEnd,
    }))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ oldStart: 1, oldEnd: 0, newStart: 1 })
    const removed = flowPreviewBlocks(newDoc, '')
    expect(removed).toHaveLength(1)
    expect(removed[0]!.newStart).toBe(1)
    expect(removed[0]!.newEnd).toBe(0)
    expect(removed[0]!.oldStart).toBe(1)
    // The renderer marks the whole document so ONE document-wide tint layer covers margins, table hairlines and
    // scrollbar strips too (per-segment tints would leave white gaps).
    expect(renderFlowMerged('', newDoc)).toContain('mdFlowDocWhole-new')
    expect(renderFlowMerged(newDoc, '')).toContain('mdFlowDocWhole-old')
  })

  it('anchors a whole new code block as an insertion on the old side', () => {
    const blocks = rangesOf('段落。\n', '段落。\n\n```js\nconst a = 1\n```\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('code')
    expect(blocks[0]!.oldEnd).toBe(blocks[0]!.oldStart - 1)
    expect(blocks[0]!.newStart).toBeLessThanOrEqual(3)
    expect(blocks[0]!.newEnd).toBeGreaterThanOrEqual(4)
  })
})

describe('flow list task checkboxes', () => {
  it('reflects the marked checked/unchecked state instead of ticking every task', () => {
    const text = '- [x] 已完成任务\n- [ ] 未完成任务\n'
    document.body.innerHTML = renderFlowMerged(text, text)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.checked).toBe(true)
    expect(boxes[1]!.checked).toBe(false)
  })

  it('keeps a matched ticked item ticked inside a CHANGED task list', () => {
    const oldDoc = '- [x] 已完成任务\n- [ ] 旧任务\n'
    const newDoc = '- [x] 已完成任务\n- [ ] 新任务\n'
    document.body.innerHTML = renderFlowMerged(oldDoc, newDoc)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.mdFlowListItem input[type="checkbox"]')]
    expect(boxes.length).toBeGreaterThan(0)
    const completed = boxes.find(input => (input.closest('.mdFlowListItem')?.textContent ?? '').includes('已完成任务'))
    expect(completed?.checked).toBe(true)
    const open = boxes.find(input => (input.closest('.mdFlowListItem')?.textContent ?? '').includes('旧任务'))
    expect(open?.checked).toBe(false)
  })
})

describe('flow character-level runs', () => {
  const OLD = '# 标题\n\n这是第二段，旧文字。\n\n> 引用里的旧句子。\n\n| 名称 | 说明 |\n| --- | --- |\n| 旧词汇 | 不变 |\n'
  const NEW = '# 标题\n\n这是第二段，新文字。\n\n> 引用里的新句子。\n\n| 名称 | 说明 |\n| --- | --- |\n| 新词汇 | 不变 |\n'

  it('washes the changed words (not the whole element) in both layouts', () => {
    document.body.innerHTML = renderFlowMerged(OLD, NEW)
    const single = [...document.querySelectorAll('.mdWordDel, .mdWordAdd')].map(element => element.textContent)
    document.body.innerHTML = renderFlowDouble(OLD, NEW)
    const double = [...document.querySelectorAll('.mdWordDel, .mdWordAdd')].map(element => element.textContent)
    expect(single.filter(text => text === '旧')).toHaveLength(3)
    expect(single.filter(text => text === '新')).toHaveLength(3)
    expect(double).toHaveLength(single.length)
  })

  it('marks the changed word inside a blockquote paragraph', () => {
    document.body.innerHTML = renderFlowMerged(OLD, NEW)
    const quote = [...document.querySelectorAll('blockquote .mdWordDel')].map(element => element.textContent)
    expect(quote).toEqual(['旧'])
  })

  it('marks the changed word inside a matched table cell', () => {
    document.body.innerHTML = renderFlowMerged(OLD, NEW)
    const cells = [...document.querySelectorAll('td .mdWordAdd')].map(element => element.textContent)
    expect(cells).toEqual(['新'])
  })

  it('never paints a highlight for whitespace-only runs (added newlines bring no visible word)', () => {
    // Adding an indented image inside one item re-wraps the list and brings newline runs into the item's text
    // diff. Those are layout breaks: wrapping them paints an empty coloured box, which reads as a phantom diff.
    const oldText = '## 功能\n\n- Markdown 预览：旧说明。\n- 不变条目\n'
    const newText = '## 功能\n\n- Markdown 预览：新说明。\n\n  ![截图](a.png)\n\n- 不变条目\n'
    document.body.innerHTML = renderFlowMerged(oldText, newText)
    const texts = [...document.querySelectorAll('.mdWordDel, .mdWordAdd')]
      .map(element => element.textContent ?? '')
    // The visible change is still washed…
    expect(texts.some(text => text.includes('新'))).toBe(true)
    // …and no run is an invisible (whitespace-only) span.
    expect(texts.every(text => text.trim() !== '')).toBe(true)
  })

  it('levels wrapped rows of one double-column block slot by slot', () => {
    document.body.innerHTML = renderFlowDouble(OLD, NEW)
    const pairs = [...document.querySelectorAll<HTMLElement>('[data-double-pair]')]
    // The renderer numbers equal slots in both columns, so the panel can level their heights on wrap.
    expect(pairs.length).toBeGreaterThan(0)
    expect(new Set(pairs.map(element => element.dataset.doublePair)).size).toBeGreaterThan(0)
  })

  it('draws NO character runs on a whole-table replacement (column count change)', () => {
    const oldTable = '| 甲 | 乙 |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n'
    const newTable = '| 甲 | 乙 | 丙 |\n| --- | --- | --- |\n| A | 1 | x |\n| B | 2 | y |\n'
    document.body.innerHTML = renderFlowMerged(oldTable, newTable)
    expect(document.querySelectorAll('.mdWordDel, .mdWordAdd')).toHaveLength(0)
    document.body.innerHTML = renderFlowDouble(oldTable, newTable)
    expect(document.querySelectorAll('.mdWordDel, .mdWordAdd')).toHaveLength(0)
    // The table is still rendered as one table per column (no inline span foster-parented above it).
    expect(document.querySelectorAll('table')).toHaveLength(2)
  })
})
