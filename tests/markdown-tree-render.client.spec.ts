// The TREE-FIRST renderer (single column): the syntax-tree match plan drawn onto the elements the nodes
// rendered as. These are the DOM contracts the panel's numbering/hover/keep and the styles rely on.
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TREE_DIFF_DEFAULT,
  TREE_DIFF_SETTING,
  previewBlocks,
  previewUnits,
  renderMarkdownPreview,
  renderTreeDocuments,
  renderTreeMerged,
  treeDiffEnabled,
} from '../src/client/markdown-preview.ts'
import { treePreviewModel } from '../src/client/markdown-tree-blocks.ts'

const bodyOf = (oldText: string, newText: string): HTMLElement => {
  const holder = document.createElement('div')
  holder.innerHTML = renderTreeMerged(oldText, newText)
  return holder
}

const blocksOf = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-md-block]')]

describe('tree-first renderer: pure changes', () => {
  it('wraps a wholly new document in ONE tinted union (no white gaps between blocks)', () => {
    const root = bodyOf('', '# H\n\nPara.\n')
    const blocks = blocksOf(root)
    // ONE carrier for the merged block: a tinted union div around the whole document's rendered elements.
    expect(blocks).toHaveLength(1)
    const wrapper = blocks[0]!
    expect(wrapper.tagName).toBe('DIV')
    expect(wrapper.classList.contains('mdAdd')).toBe(true)
    expect(wrapper.classList.contains('mdBlockUnion')).toBe(true)
    expect(wrapper.dataset.mdBlock).toBe('0')
    expect(wrapper.querySelector('h1')).not.toBeNull()
    expect(wrapper.querySelector('p')).not.toBeNull()
    // The children carry no block of their own (they cannot nest inside the merged block).
    expect(wrapper.querySelectorAll('[data-md-block]')).toHaveLength(0)
    expect(root.querySelectorAll('[data-md-block]')).toHaveLength(1)
  })

  it('a wholly new COMPLEX document is still ONE union, never a source fallback', () => {
    // Regression: a merged run whose nodes resolved to nested elements (list items, table rows) lost its
    // carrier and degraded to one whole-document source chip. It must paint the outermost siblings instead.
    const root = bodyOf('', [
      '# 标题',
      '',
      '一段正文。',
      '',
      '- 列表一',
      '- 列表二',
      '',
      '| 列 | 值 |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '> 引用。',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
    ].join('\n'))
    expect(root.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
    expect(root.querySelectorAll('.mdSourcePair')).toHaveLength(0)
    const unions = [...root.querySelectorAll<HTMLElement>('.mdBlockUnion')]
    expect(unions).toHaveLength(1)
    for (const tag of ['H1', 'P', 'UL', 'TABLE', 'BLOCKQUOTE', 'PRE']) {
      expect(unions[0]!.querySelector(tag), tag).not.toBeNull()
    }
    expect(blocksOf(root)).toHaveLength(1)
  })

  it('wraps adjacent wholly-added siblings in ONE union, keeping their order', () => {
    const root = bodyOf('Keep.\n', 'Keep.\n\nAdded one.\n\nAdded two.\n')
    const unions = [...root.querySelectorAll<HTMLElement>('.mdBlockUnion')]
    expect(unions).toHaveLength(1)
    const union = unions[0]!
    const added = [...union.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
    expect(added.map(element => element.tagName)).toEqual(['P', 'P'])
    expect(added[0]!.textContent).toContain('Added one.')
    expect(added[1]!.textContent).toContain('Added two.')
    for (const element of added) expect(element.dataset.mdBlock).toBeUndefined()
  })

  it('clones a deleted paragraph as a struck ghost above the paragraph that follows it', () => {
    const root = bodyOf('A.\n\nGone.\n\nB.\n', 'A.\n\nB.\n')
    const blocks = blocksOf(root)
    expect(blocks).toHaveLength(1)
    const ghost = blocks[0]!
    expect(ghost.tagName).toBe('P')
    expect(ghost.classList.contains('mdDel')).toBe(true)
    expect(ghost.textContent).toBe('Gone.')
    // In the new document's order: A, the ghost, then B.
    const paragraphs = [...root.querySelectorAll('p')].map(paragraph => paragraph.textContent)
    expect(paragraphs).toEqual(['A.', 'Gone.', 'B.'])
  })

  it('draws an unrelated type-matched replacement as the old element struck above the new one', () => {
    const root = bodyOf('English paragraph only.\n', '一段完全无关的中文内容。\n')
    const blocks = blocksOf(root)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.classList.contains('mdDel')).toBe(true)
    expect(blocks[1]!.classList.contains('mdAdd')).toBe(true)
    expect(blocks[0]!.dataset.mdBlock).toBe(blocks[1]!.dataset.mdBlock)
    expect(root.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
  })

  it('degrades an invisible change to a source twin at its document position', () => {
    const root = bodyOf('A.\n\n<!-- old -->\n\nB.\n', 'A.\n\n<!-- new -->\n\nB.\n')
    const blocks = blocksOf(root)
    // ONE block: old comment source above new comment source, no eye chips.
    expect(blocks.length).toBe(1)
    const pair = blocks[0]!
    expect(pair.classList.contains('mdSourcePair')).toBe(true)
    expect(pair.classList.contains('mdTwinStackPair')).toBe(true)
    expect(pair.textContent).toContain('<!-- old -->')
    expect(pair.textContent).toContain('<!-- new -->')
    const holders = [...pair.children].map(child => child.className)
    expect(holders[0]).toContain('mdTwinOld')
    expect(holders[1]).toContain('mdTwinNew')
    // Position: the source twin sits between A and B, not after the whole document.
    const children = [...root.children].map(child => child.tagName)
    const markerIndex = children.findIndex(tag => tag === 'DIV')
    expect(markerIndex).toBeGreaterThan(0)
    expect(markerIndex).toBeLessThan(children.length - 1)
  })

  it('syntax-highlights a source twin, keeping its text byte-identical', () => {
    const root = bodyOf(
      '---\ntitle: A\nversion: 1\n---\n\nBody\n',
      '---\ntitle: B\nversion: 2\n---\n\nBody\n',
    )
    const pair = blocksOf(root)[0]!
    expect(pair.classList.contains('mdSourcePair')).toBe(true)
    const sides = [...pair.querySelectorAll<HTMLElement>('.mdSourceText')]
    expect(sides).toHaveLength(2)
    // Exact source text is preserved while the tokens are coloured spans.
    expect(sides[0]!.textContent).toBe('---\ntitle: A\nversion: 1\n---')
    expect(sides[1]!.textContent).toBe('---\ntitle: B\nversion: 2\n---')
    for (const side of sides) {
      expect(side.querySelectorAll('span').length).toBeGreaterThan(0)
      expect([...side.querySelectorAll<HTMLElement>('span')].some(span => span.style.color !== '')).toBe(true)
    }
  })

  it('degrades an inline-HTML paragraph to its whole Markdown source twin', () => {
    const root = bodyOf(
      '<strong class="old-inline">内联 HTML</strong> 与 🎉 表情符号。\n',
      '<strong class="new-inline">内联 HTML</strong> 与 🎉 表情符号。\n',
    )
    const pairs = [...root.querySelectorAll<HTMLElement>('.mdSourcePair')]
    expect(pairs).toHaveLength(1)
    const pair = pairs[0]!
    // The WHOLE paragraph source, both versions — not just the changed tag.
    expect(pair.textContent).toContain('<strong class="old-inline">内联 HTML</strong> 与 🎉 表情符号。')
    expect(pair.textContent).toContain('<strong class="new-inline">内联 HTML</strong> 与 🎉 表情符号。')
    // The rendered paragraph is replaced, not left behind: the emoji text is not rendered separately.
    expect(root.querySelectorAll('p')).toHaveLength(0)
    expect(blocksOf(root)).toHaveLength(1)
    // Source is already on screen: no toolbar source row is attached to it.
    expect(pair.dataset.mdDiffOld).toBeUndefined()
    expect(pair.dataset.mdDiffNew).toBeUndefined()
    expect(root.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
  })
})

describe('tree-first renderer: character edits', () => {
  it('frames each changed word as its own hoverable block instead of the whole line', () => {
    const root = bodyOf('Old text here.\n', 'New text here.\n')
    const paragraph = root.querySelector<HTMLElement>('p')!
    const marks = [...paragraph.querySelectorAll<HTMLElement>('[data-md-block]')]
    // The struck old word AND the added new word both carry the block: hovering either frames the change.
    expect(marks.length).toBeGreaterThanOrEqual(2)
    for (const mark of marks) expect(mark.dataset.mdBlock).toBe('0')
    expect(paragraph.querySelectorAll('.mdWordDel').length).toBeGreaterThan(0)
    expect(paragraph.querySelectorAll('.mdWordAdd').length).toBeGreaterThan(0)
    expect(paragraph.textContent).toBe('OldNew text here.')
  })

  it('splits one line into one block per change, with the retargeted link as a red/green twin', () => {
    const root = bodyOf(
      '一段**普通**说明，其中有 **加粗重点**、`行内代码`，以及一个 [文档链接](https://example.com/v1/guide)。\n',
      '一段**新的**说明，其中有 **重点加粗**、`行内代码`，以及一个 [文档链接](https://example.com/v2/guide)。\n',
    )
    const paragraph = root.querySelector<HTMLElement>('p')!
    // Three differences on one line: the word swap, the strong-text swap, and the retargeted link — three
    // separate blocks (not one frame around the whole line).
    const blockIds = new Set([...paragraph.querySelectorAll<HTMLElement>('[data-md-block]')]
      .map(element => element.dataset.mdBlock))
    expect(blockIds.size).toBeGreaterThanOrEqual(3)
    // The link's own change: both versions visible, one red one green, with the source the toolbar shows.
    const twin = paragraph.querySelector<HTMLElement>('.mdTwin')!
    expect(twin).not.toBeNull()
    expect([...twin.querySelectorAll('a')].map(link => link.getAttribute('href')))
      .toEqual(['https://example.com/v1/guide', 'https://example.com/v2/guide'])
    expect(twin.dataset.mdDiffOld).toContain('example.com/v1/guide')
    expect(twin.dataset.mdDiffNew).toContain('example.com/v2/guide')
    expect(twin.dataset.mdBlock).toBeTruthy()
  })

  it('compares a LINK as a whole: changed link text draws the complete old and new links, no word runs', () => {
    const root = bodyOf('一个[旧链接文字](https://example.com/x)。\n', '一个[新链接文字](https://example.com/x)。\n')
    const twin = root.querySelector<HTMLElement>('.mdTwin')!
    expect(twin).not.toBeNull()
    // Both complete link versions, in order: old first, new second.
    expect([...twin.querySelectorAll('a')].map(link => link.textContent)).toEqual(['旧链接文字', '新链接文字'])
    expect(twin.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
    // ONE block, with no character units inside it.
    const model = treePreviewModel('一个[旧链接文字](https://example.com/x)。\n', '一个[新链接文字](https://example.com/x)。\n').blocks
    expect(model).toHaveLength(1)
    expect(model[0]!.kind).toBe('link')
    expect(model[0]!.units).toHaveLength(0)
  })

  it('draws an image path change as two frames, old red on the left and new green on the right', () => {
    const root = bodyOf('![截图](./old.png "标题")\n', '![截图](./new.png "标题")\n')
    const twin = root.querySelector<HTMLElement>('.mdTwin.mdTwinImages')
    expect(twin).not.toBeNull()
    const frames = [...twin!.querySelectorAll<HTMLElement>('.mdImageFrame')]
    expect(frames).toHaveLength(2)
    // Left is the old side, right the new one: each frame names the path it owns.
    expect(frames.map(frame => frame.querySelector('.mdImagePath')?.textContent)).toEqual(['./old.png', './new.png'])
    expect(frames[0]!.parentElement?.classList.contains('mdTwinOld')).toBe(true)
    expect(frames[1]!.parentElement?.classList.contains('mdTwinNew')).toBe(true)
    // Like a retargeted link: the toolbar's source row is on the twin.
    expect(twin!.dataset.mdDiffOld).toContain('./old.png')
    expect(twin!.dataset.mdDiffNew).toContain('./new.png')
    expect(twin!.dataset.mdBlock).toBeTruthy()
    // The paragraph itself is not tinted whole: the frames are the change.
    expect(root.querySelector('p.mdAdd, p.mdDel')).toBeNull()
  })

  it('draws a removed image as the compact frame, not the full-size placeholder paragraph', () => {
    const root = bodyOf('![截图](./removed-shot.png)\n', '')
    // The image-only block becomes the same compact tinted frame a changed image pair uses.
    expect(root.querySelector('p')).toBeNull()
    const twin = root.querySelector<HTMLElement>('.mdTwin.mdTwinImages')
    expect(twin).not.toBeNull()
    expect(twin!.classList.contains('mdImageOnlyPair')).toBe(true)
    const frame = twin!.querySelector<HTMLElement>('.mdImageFrame')!
    expect(frame.querySelector('.mdImagePath')?.textContent).toBe('./removed-shot.png')
    expect(frame.querySelector('.mdImageAlt')?.textContent).toBe('截图')
    // The real image and its path/title line live in the card (the host resolves the image; unreadable ones
    // degrade to the generic picture fallback).
    expect(frame.querySelector('img')?.getAttribute('src')).toBe('./removed-shot.png')
    expect(frame.querySelector('.mdImageFrame > .mdCodeTitlebar')).not.toBeNull()
    expect(blocksOf(root)).toHaveLength(1)
    // A wholly ADDED image is the same compact frame on the green side.
    const added = bodyOf('', '![新图](./added-shot.png)\n')
    expect(added.querySelector('p')).toBeNull()
    const addedFrame = added.querySelector<HTMLElement>('.mdImageOnlyPair .mdImageFrame')!
    expect(addedFrame.querySelector('.mdImagePath')?.textContent).toBe('./added-shot.png')
  })

  it('draws image alt and title changes in the frames too', () => {
    const root = bodyOf('![旧图](./pic.png "旧标题")\n', '![新图](./pic.png "新标题")\n')
    const twin = root.querySelector<HTMLElement>('.mdTwin.mdTwinImages')!
    const frames = [...twin.querySelectorAll<HTMLElement>('.mdImageFrame')]
    expect(frames[0]!.querySelector('.mdImageAlt')?.textContent).toBe('旧图')
    expect(frames[0]!.querySelector('.mdImageTitle')?.textContent).toBe('旧标题')
    expect(frames[1]!.querySelector('.mdImageAlt')?.textContent).toBe('新图')
    expect(frames[1]!.querySelector('.mdImageTitle')?.textContent).toBe('新标题')
    expect(twin.dataset.mdDiffOld).toContain('旧标题')
    expect(twin.dataset.mdDiffNew).toContain('新标题')
  })

  it('double column shows each image side in its own column frame', () => {
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeDocuments('![截图](./old.png)\n', '![截图](./new.png)\n')
    const columns = [...holder.querySelectorAll<HTMLElement>('.mdTwinColumn')]
    expect(columns).toHaveLength(2)
    const bySide = new Map(columns.map(column => [column.closest('[data-diff-doc-side]')?.getAttribute('data-diff-doc-side'), column]))
    expect(bySide.get('old')!.querySelector('.mdImagePath')?.textContent).toBe('./old.png')
    expect(bySide.get('new')!.querySelector('.mdImagePath')?.textContent).toBe('./new.png')
    expect(bySide.get('old')!.dataset.mdDiffOld).toContain('./old.png')
    expect(bySide.get('new')!.dataset.mdDiffNew).toContain('./new.png')
    // Both frames are the SAME block: one change, drawn in the two columns.
    expect(bySide.get('old')!.dataset.mdBlock).toBe(bySide.get('new')!.dataset.mdBlock)
  })

  it('keeps a rewritten sentence as ONE block and tags its runs, not the paragraph', () => {
    const root = bodyOf('待删除的一段：这段话在新版本里会被删掉。\n', '新增的一段说明。\n')
    // One block: the whole-line replacement is one difference, not one block per character run plus a duplicate.
    const ids = [...new Set(blocksOf(root).map(element => element.dataset.mdBlock))]
    expect(ids).toHaveLength(1)
    // The runs carry the block, so hovering the blank end of the line has nothing to raise (the paragraph
    // itself is NOT a block carrier).
    expect(root.querySelector('p')!.dataset.mdBlock).toBeUndefined()
    expect(root.querySelectorAll('.mdWordDel[data-md-block], .mdWordAdd[data-md-block]').length).toBeGreaterThan(0)
  })

  it('marks a changed table cell with word runs in that cell, leaving the row and other cells untouched', () => {
    const root = bodyOf(
      '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| b | TWO |\n',
    )
    const blocks = blocksOf(root)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    // One cell change = one block number, carried by the cell's own runs.
    expect(new Set(blocks.map(block => block.dataset.mdBlock)).size).toBe(1)
    expect(blocks[0]!.closest('td')?.textContent).toContain('TWO')
    expect(blocks[0]!.closest('tr')?.dataset.mdBlock).toBeUndefined()
    expect(root.querySelectorAll('tr[data-md-block]')).toHaveLength(0)
    // A paired cell edit is not a whole-row tint.
    expect(root.querySelector('tr.mdAdd, tr.mdDel')).toBeNull()
  })

  it('gives two changed cells of one row two separate blocks', () => {
    const root = bodyOf(
      '| k | v | w |\n|---|---|---|\n| a | 1 | x |\n',
      '| k | v | w |\n|---|---|---|\n| a | TWO | y |\n',
    )
    const blockIds = [...new Set(blocksOf(root).map(block => block.dataset.mdBlock))]
    expect(blockIds).toHaveLength(2)
    const row = root.querySelector<HTMLElement>('tbody tr')!
    const second = row.children[1]!
    const third = row.children[2]!
    expect(second.querySelector(`[data-md-block="${blockIds[0]!}"]`)).not.toBeNull()
    expect(third.querySelector(`[data-md-block="${blockIds[1]!}"]`)).not.toBeNull()
    // Neither cell is tinted whole: each change is drawn as its own word run inside its cell.
    expect(row.dataset.mdBlock).toBeUndefined()
    expect(row.classList.contains('mdAdd')).toBe(false)
  })

  it('marks a new table row as a whole-row addition (rule B)', () => {
    const root = bodyOf(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| x | 9 |\n',
    )
    const row = root.querySelector<HTMLElement>('tbody tr:last-child')!
    expect(row.classList.contains('mdAdd')).toBe(true)
    expect(row.dataset.mdWholeRow).toBe('')
    expect(row.querySelectorAll('.mdWordAdd, .mdWordDel')).toHaveLength(0)
  })

  it('marks a changed header cell on the header row with word runs', () => {
    const root = bodyOf(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| K! | v |\n|---|---|\n| a | 1 |\n',
    )
    const headRow = root.querySelector<HTMLElement>('thead tr')!
    expect(headRow.dataset.mdBlock).toBe('0')
    expect(headRow.querySelectorAll('.mdWordDel, .mdWordAdd').length).toBeGreaterThan(0)
    expect(root.querySelectorAll('tbody [data-md-block]')).toHaveLength(0)
  })

  it('merges a changed code line inside the fence', () => {
    const root = bodyOf('```ts\nconst a = 1\n```\n', '```ts\nconst a = 2\n```\n')
    const code = root.querySelector<HTMLElement>('code')!
    // The block lives on the changed line's runs inside the CODE element — not on the whole fence.
    expect(code.querySelectorAll('[data-md-block]').length).toBeGreaterThan(0)
    expect(code.querySelectorAll('.mdWordDel, .mdWordAdd').length).toBeGreaterThan(0)
  })

  it('stacks a fence-language change as two whole code blocks, old above new', () => {
    const root = bodyOf('```ts\nconst a = 1\n```\n', '```tsx\nconst a = 1\n```\n')
    // ONE block: two complete code fences, old red above new green, with the tight heading-pair gap.
    expect(blocksOf(root)).toHaveLength(1)
    const pair = root.querySelector<HTMLElement>('.mdTwin.mdTwinStackPair')
    expect(pair).not.toBeNull()
    // Two rounded version cards, each with its language label as the first line inside the card.
    const children = [...pair!.children] as HTMLElement[]
    expect(children).toHaveLength(2)
    expect(children[0]!.className).toContain('mdTwinOld')
    expect(children[1]!.className).toContain('mdTwinNew')
    const oldHolder = children[0]!
    const newHolder = children[1]!
    expect(oldHolder.querySelector('pre')?.textContent).toBe('const a = 1\n')
    expect(newHolder.querySelector('pre')?.textContent).toBe('const a = 1\n')
    // Each version shows the fence language inside its card (as declared, case kept).
    expect(oldHolder.querySelector('pre')?.dataset.codeLang).toBe('ts')
    expect(newHolder.querySelector('pre')?.dataset.codeLang).toBe('tsx')
    expect(oldHolder.querySelector(':scope > .mdCodeTitlebar')?.textContent).toBe('ts')
    expect(newHolder.querySelector(':scope > .mdCodeTitlebar')?.textContent).toBe('tsx')
    expect(oldHolder.querySelector(':scope > .mdCodeTitlebar')?.className).toContain('mdCodeTitlebarOld')
    expect(newHolder.querySelector(':scope > .mdCodeTitlebar')?.className).toContain('mdCodeTitlebarNew')
    // The language itself is invisible: the toolbar's source row has both complete fences.
    expect(pair!.dataset.mdDiffOld).toContain('```ts')
    expect(pair!.dataset.mdDiffNew).toContain('```tsx')
    // Double column: each column keeps its whole fence, tinted as a BLOCK, not line by line.
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeDocuments('```ts\nconst a = 1\n```\n', '```tsx\nconst a = 1\n```\n')
    const oldPre = holder.querySelector<HTMLElement>('[data-diff-doc-side="old"] pre')!
    const newPre = holder.querySelector<HTMLElement>('[data-diff-doc-side="new"] pre')!
    expect(oldPre.className).toContain('mdDel')
    expect(newPre.className).toContain('mdAdd')
    expect(oldPre.dataset.codeLang).toBe('ts')
    expect(newPre.dataset.codeLang).toBe('tsx')
    // The title bar is a SIBLING above the code (not inside PRE, so copying the code stays clean).
    expect(oldPre.textContent).toBe('const a = 1\n')
    expect(newPre.textContent).toBe('const a = 1\n')
    expect(oldPre.closest('.mdCodePane')?.querySelector('.mdCodeTitlebar')?.textContent).toBe('ts')
    expect(newPre.closest('.mdCodePane')?.querySelector('.mdCodeTitlebar')?.textContent).toBe('tsx')
    expect(oldPre.textContent).toBe('const a = 1\n')
    expect(newPre.textContent).toBe('const a = 1\n')
    expect(oldPre.querySelector('[data-md-block]')).toBeNull()
  })

  it('groups changed code lines: all old lines on top, all new lines below', () => {
    const root = bodyOf('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n', '```ts\nconst a = 10\nconst b = 20\nconst c = 3\n```\n')
    const lines = [...root.querySelectorAll<HTMLElement>('.mdCodeLine')]
    expect(lines.map(line => line.className.includes('mdWordDel') ? `del:${line.textContent}` : `add:${line.textContent}`))
      .toEqual(['del:const a = 1', 'del:const b = 2', 'add:const a = 10', 'add:const b = 20'])
    // The untouched line stays below the pair, unchanged (not part of the changed run).
    expect(root.querySelector('code')!.textContent).toContain('const c = 3')
  })

  it('double column: each side tinted its changed lines as full-width code-line blocks', () => {
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeDocuments('```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n', '```ts\nconst a = 10\nconst b = 20\nconst c = 3\n```\n')
    const oldLines = [...holder.querySelectorAll<HTMLElement>('[data-diff-doc-side="old"] .mdCodeLine')]
    const newLines = [...holder.querySelectorAll<HTMLElement>('[data-diff-doc-side="new"] .mdCodeLine')]
    expect(oldLines.map(line => line.textContent?.trim())).toEqual(['const a = 1', 'const b = 2'])
    expect(newLines.map(line => line.textContent?.trim())).toEqual(['const a = 10', 'const b = 20'])
    for (const line of oldLines) expect(line.className).toContain('mdWordDel')
    for (const line of newLines) expect(line.className).toContain('mdWordAdd')
    // The code's textContent keeps its newlines (the trailing line separator rides inside the block).
    expect(holder.querySelector<HTMLElement>('[data-diff-doc-side="old"] code')!.textContent)
      .toBe('const a = 1\nconst b = 2\nconst c = 3\n')
  })

  it('shows a heading LEVEL change as old heading ABOVE new heading with a tight gap', () => {
    const root = bodyOf('#### 标题\n', '### 标题\n')
    const pair = root.querySelector<HTMLElement>('.mdTwin.mdTwinStackPair')
    expect(pair).not.toBeNull()
    // Stacked, in document order: the OLD h4 first, the NEW h3 after it.
    const children = [...pair!.children] as HTMLElement[]
    expect(children[0]!.className).toContain('mdTwinOld')
    expect(children[1]!.className).toContain('mdTwinNew')
    expect(children[0]!.querySelector('h4')?.textContent).toBe('标题')
    expect(children[1]!.querySelector('h3')?.textContent).toBe('标题')
    expect(pair!.dataset.mdDiffOld).toContain('#### 标题')
    expect(pair!.dataset.mdDiffNew).toContain('### 标题')
    // One block, one hover target.
    expect(blocksOf(root)).toHaveLength(1)
    // Double column keeps one whole heading per column.
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeDocuments('#### 标题\n', '### 标题\n')
    expect(holder.querySelector('[data-diff-doc-side="old"] h4')).not.toBeNull()
    expect(holder.querySelector('[data-diff-doc-side="new"] h3')).not.toBeNull()
  })

  it('draws a nested item change where it sits, never tinting the whole parent item', () => {
    const root = bodyOf(
      '- 第二项：旧的描述\n  - 子项 A\n  - 子项 B\n- [ ] 待办：补测试\n',
      '- 第二项：新的描述\n  - 子项 A\n  - 子项 B（更新）\n- [x] 待办：补测试\n',
    )
    // No whole list item is tinted red/green: the changes are inside the items, where they read.
    expect(root.querySelectorAll('li.mdAdd, li.mdDel')).toHaveLength(0)
    const items = [...root.querySelectorAll('li')]
    const parent = items.find(item => (item.textContent ?? '').includes('第二项'))!
    expect(parent.querySelectorAll('.mdWordDel, .mdWordAdd').length).toBeGreaterThan(0)
    const nested = items.find(item => (item.textContent ?? '').trim() === '子项 B（更新）')!
    expect(nested.querySelectorAll('.mdWordAdd').length).toBe(1)
    expect(nested.querySelector('.mdWordAdd')!.textContent).toBe('（更新）')
    // The checkbox state is drawn as the box itself: old unchecked struck, new checked green.
    const task = items.find(item => (item.textContent ?? '').includes('待办：补测试'))!
    const boxes = [...task.querySelectorAll('input[type="checkbox"]')]
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.hasAttribute('checked')).toBe(false)
    expect(boxes[1]!.hasAttribute('checked')).toBe(true)
    expect(task.querySelectorAll('.mdWordAdd, .mdWordDel').length).toBeGreaterThanOrEqual(2)
  })

  it('marks a changed list item and leaves the matched items unmarked', () => {
    const root = bodyOf('- alpha\n- beta\n', '- alpha\n- beta EDITED\n')
    const blocks = blocksOf(root)
    // The added words of the one changed item carry the block; the item and the matched sibling do not.
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    for (const block of blocks) expect(block.tagName).toBe('SPAN')
    expect(new Set(blocks.map(block => block.dataset.mdBlock)).size).toBe(1)
    expect(blocks[0]!.closest('li')?.textContent).toContain('EDITED')
    expect(root.querySelectorAll('li[data-md-block]')).toHaveLength(0)
  })
})

describe('tree-first renderer: unchanged parts', () => {
  it('draws nothing and marks nothing when the documents are identical', () => {
    const root = bodyOf('# T\n\nSame.\n\n- a\n- b\n', '# T\n\nSame.\n\n- a\n- b\n')
    expect(blocksOf(root)).toHaveLength(0)
    expect(root.querySelectorAll('.mdAdd, .mdDel, .mdWordAdd, .mdWordDel')).toHaveLength(0)
    expect(root.textContent).toContain('Same.')
  })
})

describe('tree-first renderer: opt-in wiring', () => {
  it('switches the panel model and the single-column renderer together when the setting is on', () => {
    localStorage.setItem(TREE_DIFF_SETTING, '1')
    try {
      // The model the panel numbers is the tree model: a whole new document is ONE merged block with no units.
      const blocks = previewBlocks('', '# H\n\nPara.\n')
      expect(blocks).toHaveLength(1)
      expect(blocks[0]!.merged).toBe(true)
      expect(blocks[0]!.units).toEqual([])
      expect(previewUnits('', '# H\n\nPara.\n')).toEqual([])
      // The renderer draws that same one block.
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownPreview('', '# H\n\nPara.\n', 'single')
      const drawn = [...holder.querySelectorAll<HTMLElement>('[data-md-block]')]
      // ONE tinted union div wraps the merged block's elements.
      expect(drawn).toHaveLength(1)
      expect(drawn[0]!.classList.contains('mdBlockUnion')).toBe(true)
      expect(new Set(drawn.map(element => element.dataset.mdBlock))).toEqual(new Set(['0']))
      // A changed paragraph is a tree block with its character unit.
      const edited = previewBlocks('Old text here.\n', 'New text here.\n')
      expect(edited).toHaveLength(1)
      expect(edited[0]!.units).toHaveLength(1)
      expect([edited[0]!.units[0]!.oldText, edited[0]!.units[0]!.newText]).toEqual(['Old', 'New'])
    } finally {
      localStorage.removeItem(TREE_DIFF_SETTING)
    }
  })

  it('keeps the line-hunk path as the default when the setting is off', () => {
    localStorage.removeItem(TREE_DIFF_SETTING)
    // The old path's creation block carries its line units; the tree path's merged block carries none.
    const blocks = previewBlocks('', '# H\n\nPara.\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.units.length).toBeGreaterThan(0)
  })

  it('legacy renderer: invisible content is its SOURCE text, never an eye icon', () => {
    localStorage.setItem(TREE_DIFF_SETTING, '0')
    try {
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownPreview(
        '---\ntitle: A\n---\n\n<!-- old -->\n\nBody\n',
        '---\ntitle: B\n---\n\n<!-- new -->\n\nBody\n',
        'single',
        'structure',
      )
      expect(holder.querySelectorAll('[data-md-twin-caption]')).toHaveLength(0)
      expect(holder.querySelectorAll('.mdTwinCaption svg')).toHaveLength(0)
      const sources = [...holder.querySelectorAll<HTMLElement>('.mdPhantomSource')].map(source => source.textContent ?? '')
      expect(sources.join('\n')).toContain('title: A')
      expect(sources.join('\n')).toContain('<!-- old -->')
      expect(sources.join('\n')).toContain('<!-- new -->')
    } finally {
      localStorage.removeItem(TREE_DIFF_SETTING)
    }
  })

  it('resolves the pipeline: forced values win, the shipped default is the tree path, tests default to legacy', () => {
    // What the browser ships with.
    expect(TREE_DIFF_DEFAULT).toBe(true)
    // The unit-test environment keeps the legacy path unless a spec opts in (the old regression specs).
    localStorage.removeItem(TREE_DIFF_SETTING)
    expect(treeDiffEnabled()).toBe(false)
    // Explicit overrides work in both directions.
    localStorage.setItem(TREE_DIFF_SETTING, '1')
    expect(treeDiffEnabled()).toBe(true)
    localStorage.setItem(TREE_DIFF_SETTING, '0')
    expect(treeDiffEnabled()).toBe(false)
    localStorage.setItem(TREE_DIFF_SETTING, '0')
    expect(previewBlocks('', '# H\n\nPara.\n')[0]!.units.length).toBeGreaterThan(0)
    localStorage.removeItem(TREE_DIFF_SETTING)
  })
})

describe('tree-first renderer: coverage', () => {
  const richOld = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'old.md'), 'utf8')
  const richNew = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'new.md'), 'utf8')

  const drawnBlocks = (root: HTMLElement): Set<number> =>
    new Set([...root.querySelectorAll<HTMLElement>('[data-md-block]')].map(element => Number(element.dataset.mdBlock)))

  it('draws EVERY block of the rich fixture in the single column', () => {
    localStorage.setItem(TREE_DIFF_SETTING, '1')
    try {
      const model = previewBlocks(richOld, richNew)
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownPreview(richOld, richNew, 'single')
      const drawn = drawnBlocks(holder)
      const missing = model.filter(block => !drawn.has(block.index)).map(block => `${block.index}:${block.kind}`)
      expect(missing).toEqual([])
    } finally {
      localStorage.removeItem(TREE_DIFF_SETTING)
    }
  })

  it('draws EVERY block of the rich fixture in the double column', () => {
    localStorage.setItem(TREE_DIFF_SETTING, '1')
    try {
      const model = previewBlocks(richOld, richNew)
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownPreview(richOld, richNew, 'double')
      const drawn = drawnBlocks(holder)
      const missing = model.filter(block => !drawn.has(block.index)).map(block => `${block.index}:${block.kind}`)
      expect(missing).toEqual([])
    } finally {
      localStorage.removeItem(TREE_DIFF_SETTING)
    }
  })
})

describe('tree-first renderer: double column', () => {
  const renderWithTree = (oldText: string, newText: string): HTMLElement => {
    localStorage.setItem(TREE_DIFF_SETTING, '1')
    try {
      const holder = document.createElement('div')
      holder.innerHTML = renderMarkdownPreview(oldText, newText, 'double')
      return holder
    } finally {
      localStorage.removeItem(TREE_DIFF_SETTING)
    }
  }

  const columnOf = (root: HTMLElement, side: 'old' | 'new'): HTMLElement => {
    const column = root.querySelector<HTMLElement>(`[data-diff-doc-side="${side}"]`)
    if (column === null) throw new Error(`no ${side} column`)
    return column
  }

  it('tints a wholly new document in the new column only, as ONE continuous union', () => {
    const root = renderWithTree('', '# H\n\nPara.\n')
    const oldColumn = columnOf(root, 'old')
    const newColumn = columnOf(root, 'new')
    expect(oldColumn.querySelectorAll('[data-md-block]')).toHaveLength(0)
    // ONE union in the new column: the tint is continuous across the merged run, exactly like single column.
    const union = newColumn.querySelector<HTMLElement>('.mdBlockUnion')!
    expect(union).not.toBeNull()
    expect(union.dataset.mdBlock).toBe('0')
    expect(union.querySelectorAll('h1, p').length).toBeGreaterThanOrEqual(2)
    // The children carry no block of their own; the union is the block/hover target.
    expect(union.querySelectorAll('[data-md-block]')).toHaveLength(0)
  })

  it('shows a paired edit with its own changed characters in each column, on the same row', () => {
    const root = renderWithTree('Old text here.\n', 'New text here.\n')
    const oldColumn = columnOf(root, 'old')
    const newColumn = columnOf(root, 'new')
    const oldMark = oldColumn.querySelector<HTMLElement>('[data-md-block]')!
    const newMark = newColumn.querySelector<HTMLElement>('[data-md-block]')!
    expect(oldMark.dataset.mdBlock).toBe(newMark.dataset.mdBlock)
    expect(oldMark.classList.contains('mdWordDel')).toBe(true)
    expect(newMark.classList.contains('mdWordAdd')).toBe(true)
    // Each column's element sits in one grid row of the shared layout.
    const oldCell = oldMark.closest<HTMLElement>('.mdDoubleCellOld')!
    const newCell = newMark.closest<HTMLElement>('.mdDoubleCellNew')!
    expect(oldCell.style.gridRow).toBe(newCell.style.gridRow)
    expect(oldCell.style.gridRow).not.toBe('')
  })

  it('a deleted NESTED list stays in the old column, never a phantom source chip in the new one', () => {
    // Regression: a removed nested list resolved to no old element (it is covered by no single source span), so
    // the reachability net put its source chip in the NEW column, under the YAML card. It must tint the nested
    // UL in the old column — the side that actually loses it.
    const root = renderWithTree(
      '- 第一项：保持\n- 第二项：描述\n  - 子项 A\n  - 子项 B（更新）\n- [x] 待办\n\n结尾段落。\n',
      '- 第一项：保持\n- 第二项：描述\n- [x] 待办\n\n结尾段落。\n',
    )
    const oldColumn = columnOf(root, 'old')
    const newColumn = columnOf(root, 'new')
    expect(newColumn.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
    expect((newColumn.textContent ?? '')).not.toContain('子项 A')
    // The nested list itself is the red carrier in the old column.
    const deletedList = [...oldColumn.querySelectorAll<HTMLElement>('ul.mdDel, ol.mdDel')]
      .find(list => (list.textContent ?? '').includes('子项 A'))
    expect(deletedList).toBeDefined()
    expect(deletedList!.closest<HTMLElement>('[data-diff-doc-side]')?.dataset.diffDocSide).toBe('old')
    expect(deletedList!.dataset.mdBlock).toBeDefined()
    expect(oldColumn.querySelectorAll(`[data-md-block="${deletedList!.dataset.mdBlock}"]`).length).toBeGreaterThan(0)
  })

  it('draws an inline TYPE change in place (old element red, new element green), not as source chips', () => {
    const root = renderWithTree(
      '一段说明，其中有 **加粗**、以及收尾。\n',
      '一段说明，其中有 [项目文档](https://example.com/old)、以及收尾。\n',
    )
    const oldColumn = columnOf(root, 'old')
    const newColumn = columnOf(root, 'new')
    expect(root.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
    const oldStrong = oldColumn.querySelector<HTMLElement>('strong.mdDel')
    expect(oldStrong).not.toBeNull()
    expect(oldStrong!.textContent).toBe('加粗')
    expect(oldStrong!.dataset.mdBlock).toBeDefined()
    const newLink = newColumn.querySelector<HTMLElement>('a.mdAdd')
    expect(newLink).not.toBeNull()
    expect(newLink!.textContent).toBe('项目文档')
    expect(newLink!.dataset.mdBlock).toBe(oldStrong!.dataset.mdBlock)
  })

  it('aligns matched list items row by row even when the other list gains an item', () => {
    const root = renderWithTree(
      '- 第一项：旧\n- 第二项：保持不变\n- 第三项：旧\n',
      '- 第一项：新\n- 第二项：保持不变\n- 新增的一条\n- 第三项：新\n',
    )
    const rowsByBlock = new Map<string, { old?: string; new?: string }>()
    for (const side of ['old', 'new'] as const) {
      for (const element of columnOf(root, side).querySelectorAll<HTMLElement>('[data-md-block]')) {
        const block = element.dataset.mdBlock ?? '?'
        const row = element.closest<HTMLElement>('.mdDoubleCellOld, .mdDoubleCellNew')?.style.gridRow
        const current = rowsByBlock.get(block) ?? {}
        current[side] = row
        rowsByBlock.set(block, current)
      }
    }
    const matched = [...rowsByBlock].filter(([, rows]) => rows.old !== undefined && rows.new !== undefined)
    expect(matched.length).toBeGreaterThanOrEqual(2)
    for (const [block, rows] of matched) {
      expect(rows.old, `block ${block}`).toBe(rows.new)
    }
  })

  it('marks a new table row as a row in the new column only', () => {
    const root = renderWithTree(
      '| k | v |\n|---|---|\n| a | 1 |\n',
      '| k | v |\n|---|---|\n| a | 1 |\n| x | 9 |\n',
    )
    const oldColumn = columnOf(root, 'old')
    const newColumn = columnOf(root, 'new')
    expect(oldColumn.querySelectorAll('[data-md-block]')).toHaveLength(0)
    const row = newColumn.querySelector<HTMLElement>('tbody tr:last-child')!
    expect(row.dataset.mdWholeRow).toBe('')
    expect(row.classList.contains('mdAdd')).toBe(true)
  })

  it('puts a source twin into each column at its own position', () => {
    const root = renderWithTree('A.\n\n<!-- old -->\n\nB.\n', 'A.\n\n<!-- new -->\n\nB.\n')
    const oldSources = [...columnOf(root, 'old').querySelectorAll<HTMLElement>('.mdSourcePair')]
    const newSources = [...columnOf(root, 'new').querySelectorAll<HTMLElement>('.mdSourcePair')]
    expect(oldSources).toHaveLength(1)
    expect(newSources).toHaveLength(1)
    expect(oldSources[0]!.textContent).toContain('<!-- old -->')
    expect(oldSources[0]!.textContent).not.toContain('<!-- new -->')
    expect(newSources[0]!.textContent).toContain('<!-- new -->')
    expect(newSources[0]!.textContent).not.toContain('<!-- old -->')
    // Both sides of the change share ONE alignment anchor, so the source rows sit on the same grid row.
    expect(oldSources[0]!.dataset.mdMatch).toBeDefined()
    expect(oldSources[0]!.dataset.mdMatch).toBe(newSources[0]!.dataset.mdMatch)
    expect(oldSources[0]!.dataset.mdBlock).toBe('0')
    expect(newSources[0]!.dataset.mdBlock).toBe('0')
  })

  it('merges the adjacent fully-matched siblings into ONE layout row in both columns', () => {
    const root = renderWithTree(
      'A.\n\nB.\n\nC.\n\nOld edit.\n',
      'A.\n\nB.\n\nC.\n\nNew edit.\n',
    )
    const runs = [...root.querySelectorAll<HTMLElement>('.mdTreeRun')]
    // One merged run per column, holding A./B./C. — the changed paragraph stays outside.
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      expect(run.textContent).toContain('A.')
      expect(run.textContent).toContain('B.')
      expect(run.textContent).toContain('C.')
      expect(run.textContent).not.toContain('edit.')
    }
    const oldCell = runs
      .map(run => run.closest<HTMLElement>('.mdDoubleCellOld'))
      .find((cell): cell is HTMLElement => cell !== null)!
    const newCell = runs
      .map(run => run.closest<HTMLElement>('.mdDoubleCellNew'))
      .find((cell): cell is HTMLElement => cell !== null)!
    expect(oldCell.style.gridRow).toBe(newCell.style.gridRow)
  })

  it('puts a wholly unchanged document in one shared row', () => {
    const text = 'A.\n\nB.\n\nC.\n'
    const root = renderWithTree(text, text)
    expect(root.querySelectorAll('.mdTreeRun')).toHaveLength(2)
    expect(root.querySelectorAll('.mdDoubleCell')).toHaveLength(2)
    const oldCell = root.querySelector<HTMLElement>('.mdDoubleCellOld')!
    const newCell = root.querySelector<HTMLElement>('.mdDoubleCellNew')!
    expect(oldCell.style.gridRow).toBe(newCell.style.gridRow)
  })
})
