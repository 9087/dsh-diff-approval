// A LARGE, many-shaped document (see `tests/fixtures/rich-markdown`) run through the structure renderer.
//
// Small hand-written cases miss combinations: the bugs this file exists for were a paragraph swallowed by a GFM
// table (rendered, yet reported as "invisible content"), a split phantom block joining a removal and an addition,
// and a replaced code fence merged line-by-line into one unreadable program. This fixture puts every shape a
// real file has into one document — front matter, headings, merged and split paragraphs, a table with
// added/removed rows and a paragraph directly under it, lists with rewrites and ticks, quotes, fenced code
// (language and body changes), links (text, target, reference definitions), images, HTML comments, a horizontal
// rule, a heading level change, an inline-HTML attribute change and a long line.
//
// The invariant asserted on BOTH layouts is the one that would have caught the reported bugs:
//
//   A change whose text IS on the page must be reachable — some element in the document must carry its unit
//   number, so it can be hovered, kept and reverted. A unit that is unreachable is allowed only when its own
//   text is NOT visible (a syntax-only rewrite, a URL that only lives in an attribute, front matter).
//
// Plus three shapes: an invisible change is ONE block per side (never a split block), a changed code fence is
// diffed INSIDE one code block (light edits word by word, a wholesale replacement line by line), and a
// heading-level change draws both levels, old struck above new.

// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewBlocks, previewUnits, renderMarkdownPreview, type PreviewBlock, type PreviewUnit } from '../src/client/markdown-preview.ts'

// Vitest runs from the repository root; the jsdom environment makes `import.meta.url` non-file, so the fixture
// directory is resolved from the working directory like `manifest.spec.ts` resolves the package manifest.
const OLD = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'old.md'), 'utf8')
const NEW = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'rich-markdown', 'new.md'), 'utf8')
const LABELS = { invisible: '不可见内容' } as const
/** The same blocks the panel numbers, for reachability of merged-block units. */
const BLOCKS: readonly PreviewBlock[] = previewBlocks(OLD, NEW)

/** The renderer's own match normalization (markup characters dropped, whitespace folded). */
function normalize(text: string): string {
  let out = ''
  let space = false
  for (const character of text) {
    if (character === '*' || character === '`' || character === '_' || character === '\\') continue
    if (/\s/.test(character)) {
      if (!space && out !== '') {
        out += ' '
        space = true
      }
      continue
    }
    out += character
    space = false
  }
  return out.trim()
}

function draw(mode: 'single' | 'double', oldText = OLD, newText = NEW): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = renderMarkdownPreview(oldText, newText, mode, 'structure', LABELS)
  return holder
}

function tagsIn(root: Element): Set<string> {
  return new Set([...root.querySelectorAll('[data-md-unit]')].map(element => element.getAttribute('data-md-unit')!))
}

/** The unit's text on one side, when that side actually carries characters for it. */
function sideText(unit: PreviewUnit, side: 'old' | 'new'): string {
  return side === 'old' ? unit.oldText : unit.newText
}

/**
 * Assert the reachability invariant for one reading of the document: a unit whose own text appears in the
 * rendered words must be carried by an element.
 */
function expectReachable(root: Element, units: readonly PreviewUnit[], side: 'old' | 'new' | 'both', where: string): void {
  const tags = tagsIn(root)
  // A unit inside a MERGED block is not drawn per character (the whole paragraph/list/table is one tinted
  // block): its block's mark is what makes it reachable.
  const blockTags = new Set([...root.querySelectorAll('[data-md-block]')].map(element => element.getAttribute('data-md-block')!))
  const blockOf = new Map<number, number>()
  for (const block of BLOCKS) for (const unit of block.units) blockOf.set(unit.index, block.index)
  const visible = normalize(root.textContent ?? '')
  const missing: string[] = []
  for (const unit of units) {
    const sides: ('old' | 'new')[] = side === 'both' ? ['old', 'new'] : [side]
    const oldNormalized = normalize(unit.oldText)
    const newNormalized = normalize(unit.newText)
    // A spelling-only rewrite (`**x**` as `__x__`) renders the same words: the renderer deliberately draws no
    // change for it, so it is not demanded to be reachable.
    if (unit.oldText !== unit.newText && oldNormalized !== '' && oldNormalized === newNormalized) continue
    const wanted = sides.map(which => normalize(sideText(unit, which))).filter(text => text !== '')
    // Syntax-only units (a `**` rewritten as `__`) carry no visible word of their own: nothing to demand.
    if (wanted.length === 0) continue
    if (!wanted.some(text => visible.includes(text))) continue
    const block = blockOf.get(unit.index)
    if (!tags.has(String(unit.index)) && (block === undefined || !blockTags.has(String(block)))) {
      missing.push(`unit ${unit.index} (${JSON.stringify(sides.map(which => sideText(unit, which).slice(0, 40)))})`)
    }
  }
  expect(missing, where).toEqual([])
}

/** The unit numbers of every marked element, in reading order, with consecutive repeats collapsed. */
function unitReadingOrder(root: Element): number[] {
  const order: number[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-md-unit]')) {
    const index = Number(element.getAttribute('data-md-unit'))
    if (!Number.isFinite(index)) continue
    if (order[order.length - 1] !== index) order.push(index)
  }
  return order
}

/**
 * Assert the ORDER invariant: one reading of the document must present its changes in ascending number order.
 *
 * A change's number is its place in the source. If the drawn order runs backwards, a later change was placed
 * before an earlier one — the reported "deleted paragraph drawn above the merged paragraph" class of bug — and
 * the reader counts 9 before 8. Equal neighbours are allowed: one change is often drawn as several elements
 * (the old side and the new side of a replacement).
 */
function expectReadingOrder(root: Element, where: string): void {
  const order = unitReadingOrder(root)
  for (let index = 1; index < order.length; index++) {
    expect(order[index]!, `${where}: unit ${order[index]} drawn after unit ${order[index - 1]} (${JSON.stringify(order)})`)
      .toBeGreaterThanOrEqual(order[index - 1]!)
  }
}

/**
 * Assert the NESTING invariant: one change must not be drawn INSIDE another change.
 *
 * A unit nested in a differently-numbered unit means the outer one was numbered before its parts were folded in
 * (a link's text edit inside its retarget; the language tag and edited lines inside one replaced code fence) —
 * hover then reports the inner number on part of the outer element, and the two tints stack.
 */
function nestedUnitMarks(root: Element): string[] {
  const nested: string[] = []
  for (const mark of root.querySelectorAll<HTMLElement>('[data-md-unit]')) {
    const index = mark.getAttribute('data-md-unit')
    let parent = mark.parentElement
    while (parent !== null) {
      const outer = parent.closest('[data-md-unit]')
      if (outer !== null && outer.getAttribute('data-md-unit') !== index) {
        nested.push(`${mark.tagName} unit ${index} inside ${outer.tagName} unit ${outer.getAttribute('data-md-unit')}`)
      }
      parent = parent.parentElement
    }
  }
  return [...new Set(nested)]
}

describe('Markdown preview · one large mixed document', () => {
  const units = previewUnits(OLD, NEW)

  it('keeps the document structured and marks every visible change, in the single column', () => {
    const root = draw('single')
    // The document's own structure survives: a table, list structures, quotes, both code fences and the new
    // paragraphs' words; the long line and the emoji are still content, not blanks.
    expect(root.querySelectorAll('table').length).toBeGreaterThanOrEqual(1)
    expect(root.querySelectorAll('ul').length).toBeGreaterThanOrEqual(2)
    expect(root.querySelectorAll('ol').length).toBeGreaterThanOrEqual(1)
    expect(root.querySelectorAll('blockquote').length).toBeGreaterThanOrEqual(2)
    // Two changed fences, so two code blocks — each carries its own diff inside (see the fence test below).
    expect(root.querySelectorAll('pre').length).toBe(2)
    // Every image whose PATH changed is drawn as a frame naming the path (the image itself is gone from the
    // merged reading); the deleted image is one more framed or struck picture.
    expect(root.querySelectorAll('.mdImageFrame').length + root.querySelectorAll('img').length)
      .toBeGreaterThanOrEqual(3)
    // The words an edit produced are on the page (merged runs show old and new side by side, so exact sentences
    // are not what the merged text contains — the new WORDS are).
    expect(root.textContent).toContain('已经改写')
    expect(root.textContent).toContain('，现在和第二段接在一起了')
    expect(root.textContent).toContain('新增的一段话')
    expect(root.textContent).toContain('🎉')
    expect(root.textContent).toContain('StructuredPreviewRichFixtureAlpha')
    expect(root.textContent).toContain('二版的超长行内容')
    // The lines written directly under the table (no blank line between them) are the paragraph they READ as:
    // GFM would swallow them as more table rows, and the preview reparses them as their own paragraph instead
    // (the reported "rendered inside the table" confusion). Their change is marked there.
    const table = root.querySelector('table') as HTMLElement
    expect(table, 'the table is rendered').not.toBeNull()
    expect(table.textContent).not.toContain('紧跟在表格后面')
    expect(table.textContent).not.toContain('已经改写')
    const swallowedParagraph = [...root.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('紧跟在表格后面'))
    expect(swallowedParagraph, 'the table-following lines are a paragraph of their own').toBeDefined()
    expect(swallowedParagraph!.textContent).toContain('已经改写')
    expect(swallowedParagraph!.querySelector('[data-md-unit]'), 'the paragraph is marked where it reads').not.toBeNull()
    const chipsNow = [...root.querySelectorAll<HTMLElement>('.mdTwinPhantom')]
    expect(chipsNow.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('紧跟在表格后面'))).toBe(false)
    expect(chipsNow.some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('已经改写'))).toBe(false)
    // A heading whose LEVEL changed (`####` → `###`) is a visible change — the size differs — so both versions
    // are drawn: the old level struck above the new one, sharing the change's number, and NOT as an
    // invisible-content block that hovers with a dashed frame but no tint.
    const demoted = [...root.querySelectorAll<HTMLElement>('h3, h4')]
      .filter(element => (element.textContent ?? '').includes('会被降级的小标题'))
    expect(demoted.length, 'both heading levels are drawn').toBe(2)
    const demotedOld = demoted.find(element => element.tagName === 'H4')
    const demotedNew = demoted.find(element => element.tagName === 'H3')
    expect(demotedOld, 'the old heading level').toBeDefined()
    expect(demotedNew, 'the new heading level').toBeDefined()
    expect(demotedOld!.classList.contains('mdDel')).toBe(true)
    expect(demotedNew!.classList.contains('mdAdd')).toBe(true)
    expect(demotedOld!.getAttribute('data-md-unit')).toBe(demotedNew!.getAttribute('data-md-unit'))
    expect(demotedOld!.compareDocumentPosition(demotedNew!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(chipsNow.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('会被降级的小标题'))).toBe(false)

    expectReachable(root, units, 'both', 'single column')
  })

  it('marks every visible change in each column of the double view', () => {
    const holder = draw('double')
    for (const side of ['old', 'new'] as const) {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      expect(column, side).not.toBeNull()
      expectReachable(column, units, side, `double ${side} column`)
    }
  })

  it('draws an invisible change as one block per side, never one split block', () => {
    const root = draw('single')
    const chips = [...root.querySelectorAll<HTMLElement>('.mdTwinPhantom')]
    expect(chips.length).toBeGreaterThanOrEqual(4)
    for (const chip of chips) {
      const oldText = chip.getAttribute('data-md-diff-old')
      const newText = chip.getAttribute('data-md-diff-new')
      // Exactly one side per block: the block is red (removal) or green (addition), not both. The mark is an
      // eye-with-a-slash icon whose accessible name is the caller's words.
      expect(oldText === null || newText === null, `chip ${chip.getAttribute('data-md-unit')}`).toBe(true)
      const icon = chip.querySelector('[data-md-twin-caption]') as HTMLElement
      expect(icon, `chip ${chip.getAttribute('data-md-unit')} icon`).not.toBeNull()
      expect(icon.querySelector('svg')).not.toBeNull()
      expect(icon.getAttribute('aria-label')).toBe('不可见内容')
    }
    // The front matter is a change the document cannot show. Its changed runs are TWO invisible changes (the
    // header lines, then the tag list with the added owner/note): each has a removal block and an addition block,
    // and both blocks of a change carry its number.
    const removed = chips.filter(chip => (chip.getAttribute('data-md-diff-old') ?? '') !== '')
    const added = chips.filter(chip => (chip.getAttribute('data-md-diff-new') ?? '') !== '')
    const oldFront = removed.find(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('version: 1'))
    expect(oldFront, 'front matter removal block').toBeDefined()
    expect(oldFront!.getAttribute('data-md-diff-old')).toContain('draftFlag: true')
    const newFront = added.find(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('version: 2'))
    expect(newFront, 'front matter addition block').toBeDefined()
    expect(newFront!.getAttribute('data-md-unit')).toBe(oldFront!.getAttribute('data-md-unit'))
    const addedTail = added.find(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('owner: 吴志伟'))
    expect(addedTail, 'added front-matter lines').toBeDefined()
    expect(addedTail!.getAttribute('data-md-diff-new')).toContain('多行说明第二行')
    expect(addedTail!.getAttribute('data-md-diff-old')).toBeNull()
    // The reference-definition edits are invisible too: the retargeted `[ref]` shows both sides, the removed
    // `[ref2]` only its removal.
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('[ref]: https://example.com/old-ref'))).toBe(true)
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('[ref]: https://example.com/new-ref'))).toBe(true)
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('[ref2]: https://example.com/remove-me'))).toBe(true)
    // HTML comments: modified (both sides) and the added one (new side only).
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('会被修改的旧注释'))).toBe(true)
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('会被修改的新注释'))).toBe(true)
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('新增加的注释'))).toBe(true)
    // A rule re-spelled from `---` to `***` shares nothing with the old line: by the block rules that is a pure
    // deletion plus a pure addition, merged into ONE block and drawn as two rules (the old struck, the new
    // tinted) — NOT a character-level rewrite and no invisible-content chip either.
    expect(chips.some(chip => chip.getAttribute('data-md-diff-old') === '---')).toBe(false)
    expect(chips.some(chip => chip.getAttribute('data-md-diff-new') === '***')).toBe(false)
    const oldRuleLine = OLD.split('\n').reduce((found, line, index) => (line.trim() === '---' ? index + 1 : found), 0)
    const ruleBlocks = previewBlocks(OLD, NEW).filter(block =>
      block.merged && block.oldStart <= oldRuleLine && block.oldEnd >= oldRuleLine)
    expect(ruleBlocks, 'the re-spelled rule is a merged block').toHaveLength(1)
    // A paragraph whose change is DRAWN must not get an invisible-content block: the first chapter's paragraph
    // carries both a word run and a same-reading link-target change (two units that read `old`→`new`). The
    // second unit used to stay unclaimed and its phantom chip then sat between the two columns' paragraphs,
    // wrecking the double column's row alignment (the reported bug).
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-old') ?? '').includes('这是第一版的一段普通文字'))).toBe(false)
    expect(chips.some(chip => (chip.getAttribute('data-md-diff-new') ?? '').includes('这是第二版的一段普通文字'))).toBe(false)
  })

  it('lines the double columns up by BLOCK, across the first chapter\'s merged paragraphs', () => {
    // The reported misalignment: a phantom block for a drawn change pushed the first chapter's paragraphs out of
    // step, so an old paragraph sat beside an empty cell while the new one appeared rows later. Unchanged blocks
    // must share a grid row — that is what makes the two columns readable side by side.
    const holder = draw('double')
    const rowOf = (side: 'old' | 'new', text: string): string | undefined => {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      const cell = [...column.children].find(child => (child.textContent ?? '').replace(/\s+/g, ' ').includes(text))
      return (cell?.getAttribute('style') ?? '').match(/grid-row:\s*(\d+)/)?.[1]
    }
    for (const anchor of ['第二章 表格', '第三章 列表', '第四章 引用', '第五章 代码', '第六章 链接与图片', '第七章 其他']) {
      const oldRow = rowOf('old', anchor)
      const newRow = rowOf('new', anchor)
      expect(oldRow, `row of ${anchor}`).toBeDefined()
      expect(newRow, `row of ${anchor}`).toBeDefined()
      expect(oldRow, `row of ${anchor}`).toBe(newRow)
    }
    // The first chapter's paragraphs pair up in order: the old and new versions of one paragraph on one row.
    expect(rowOf('old', '这是第一版的一段普通文字')).toBe(rowOf('new', '这是第二版的一段普通文字'))
    expect(rowOf('old', '这一段会被合并的第一段。')).toBe(rowOf('new', '这一段会被合并的第一段，现在和第二段接在一起了。'))
    // No chip for the drawn paragraph in either column.
    for (const side of ['old', 'new'] as const) {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      const chipTexts = [...column.querySelectorAll<HTMLElement>('.mdTwinPhantom')]
        .map(chip => `${chip.getAttribute('data-md-diff-old') ?? ''}${chip.getAttribute('data-md-diff-new') ?? ''}`)
      expect(chipTexts.some(text => text.includes('一段普通文字'))).toBe(false)
    }
  })

  it('draws a deleted paragraph where the DIFF puts it, not where its old line number points', () => {
    // The reported order bug: the deleted paragraph followed a merged paragraph in the source, but the ghost was
    // placed by its OLD line number among the NEW document's lines — lines had been added/removed, so the old
    // number pointed one block early and the red ghost appeared ABOVE the merged paragraph, out of step with its
    // own (later) number.
    const root = draw('single')
    const merged = [...root.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('这一段会被合并的第二段'))
    const removed = [...root.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('这一段在新版本里会被整段删除'))
    expect(merged).toBeDefined()
    expect(removed).toBeDefined()
    // Reading order: merged paragraph first, then the deleted ghost.
    const mergedFirst = merged!.compareDocumentPosition(removed!) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(mergedFirst).toBeTruthy()
    // …which is the order the units number them in.
    const mergedUnit = units.find(unit => unit.oldText.startsWith('这一段会被合并的第二段'))
    const removedUnit = units.find(unit => unit.oldText.startsWith('这一段在新版本里会被整段删除'))
    expect(mergedUnit).toBeDefined()
    expect(removedUnit).toBeDefined()
    expect(mergedUnit!.index).toBeLessThan(removedUnit!.index)
  })

  it('folds a link\'s text edit and its retarget into ONE change', () => {
    // A link is one thing: its text and its target are parts of the same `[text](target)` token, and the source
    // row for either shows the whole link. Diffing characters would report the inserted ` v2` and the retargeted
    // URL as two units — with the URL's (later in the line) wrapping the word's — so hovering the word and
    // hovering the link disagreed and a keep left the link half-changed. Both are one unit now.
    const root = draw('single')
    const paragraph = [...root.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('的一段普通文字'))
    expect(paragraph).toBeDefined()
    const linkUnit = units.find(unit =>
      unit.oldText.includes('example.com/old') && unit.newText.includes('example.com/new'))
    expect(linkUnit, 'one unit spans the link').toBeDefined()
    // No unit owns only the inserted ` v2` any more: inside a link, the word belongs to the link's change.
    expect(units.some(unit => unit.oldText === '' && unit.newText === ' v2')).toBe(false)
    // The twin wrapper (the retarget's two versions) and the `v2` run inside it carry the SAME number.
    const wrapper = paragraph!.querySelector('.mdTwin') as HTMLElement
    expect(wrapper).not.toBeNull()
    expect(wrapper.getAttribute('data-md-unit')).toBe(String(linkUnit!.index))
    const v2 = [...paragraph!.querySelectorAll<HTMLElement>('.mdWordAdd')].find(element => element.textContent === 'v2')
    expect(v2, 'the inserted v2 is drawn').toBeDefined()
    expect(v2!.getAttribute('data-md-unit')).toBe(String(linkUnit!.index))
    expect(paragraph!.querySelectorAll(`[data-md-unit="${linkUnit!.index}"]`).length).toBeGreaterThanOrEqual(2)
    // A change beside the link stays its own unit: the 一二 run is untouched by the fold.
    const word = units.find(unit => unit.oldText === '一' && unit.newText === '二')
    expect(word).toBeDefined()
    const wordParts = [...paragraph!.querySelectorAll<HTMLElement>(`[data-md-unit="${word!.index}"]`)]
    expect(wordParts.map(element => element.textContent)).toEqual(['一', '二'])
  })

  it('keeps one-unit-per-link numbering in the double column, and the code edit its own', () => {
    const holder = draw('double')
    const linkUnit = units.find(unit =>
      unit.oldText.includes('example.com/old') && unit.newText.includes('example.com/new'))
    expect(linkUnit).toBeDefined()
    for (const side of ['old', 'new'] as const) {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      const paragraph = [...column.querySelectorAll<HTMLElement>('p')]
        .find(element => (element.textContent ?? '').includes('的一段普通文字'))
      expect(paragraph, side).toBeDefined()
      const link = paragraph!.querySelector('a') as HTMLAnchorElement
      expect(link.getAttribute('data-md-unit'), side).toBe(String(linkUnit!.index))
      // The same line's inline-code edit is a change of its own, not part of the link's number. Each column
      // draws ITS side of it: the old column the struck `old`, the new column the added `new`.
      const codeRun = [...paragraph!.querySelectorAll<HTMLElement>('code .mdWordDel, code .mdWordAdd')]
        .find(element => element.textContent === (side === 'old' ? 'old' : 'new'))
      expect(codeRun, side).toBeDefined()
      expect(codeRun!.getAttribute('data-md-unit'), side).not.toBe(String(linkUnit!.index))
    }
  })

  it('compares each re-spelled inline style as its own two versions', () => {
    // The fixture re-spells `**加粗**`, `*斜体*` and a later `**拼写**` as `__…__` / `_…_`. The rendering is
    // identical, so the change can only be COMPARED: each styled word is drawn twice — the old spelling red, the
    // new green, both the same real element (bold stays bold, italic stays italic) — and each is its OWN change.
    const root = draw('single')
    const paragraph = [...root.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('下面是一段'))
    expect(paragraph, 'the re-spelled paragraph is rendered').toBeDefined()
    const twins = [...paragraph!.querySelectorAll<HTMLElement>('.mdTwin')]
    expect(twins.length, 'bold, italic and the later bold: three comparisons').toBe(3)
    const strongTwins = twins.filter(twin => twin.querySelector('strong') !== null)
    expect(strongTwins.length).toBe(2)
    for (const twin of strongTwins) expect(twin.querySelectorAll('strong').length).toBe(2)
    const emTwins = twins.filter(twin => twin.querySelector('em') !== null)
    expect(emTwins.length).toBe(1)
    expect(emTwins[0]!.querySelectorAll('em').length).toBe(2)
    // One number per comparison, in source order.
    const numbers = twins.map(twin => Number(twin.getAttribute('data-md-unit')))
    expect(new Set(numbers).size).toBe(3)
    expect(numbers).toEqual([...numbers].sort((left, right) => left - right))
  })

  it('presents every change in source order — single and both double columns', () => {
    expectReadingOrder(draw('single'), 'single column')
    const holder = draw('double')
    for (const side of ['old', 'new'] as const) {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      expect(column, side).not.toBeNull()
      expectReadingOrder(column, `double ${side} column`)
    }
  })

  it('never draws one change inside another change — single and both double columns', () => {
    expect(nestedUnitMarks(draw('single')), 'single column').toEqual([])
    const holder = draw('double')
    for (const side of ['old', 'new'] as const) {
      const column = holder.querySelector(`[data-diff-doc-side="${side}"]`) as HTMLElement
      expect(nestedUnitMarks(column), `double ${side} column`).toEqual([])
    }
  })

  it('diffs a changed code fence INSIDE one block, never as two code blocks', () => {
    const root = draw('single')
    const fences = [...root.querySelectorAll<HTMLElement>('pre')]
    // Two changed fences in the fixture, so two code blocks — not four: the old program is not a separate
    // code block above the new one any more.
    expect(fences.length).toBe(2)
    // The first fence is mostly the same program: its changed characters are marked INSIDE the block, on the
    // words of both versions (`1` struck → `2` added, `old` → `new`).
    const first = fences[0]!
    expect(first.textContent).toContain('const version = ')
    const firstDel = [...first.querySelectorAll<HTMLElement>('.mdWordDel')].map(run => run.textContent)
    const firstAdd = [...first.querySelectorAll<HTMLElement>('.mdWordAdd')].map(run => run.textContent)
    expect(firstDel).toContain('1')
    expect(firstDel).toContain('old')
    expect(firstAdd).toContain('2')
    expect(firstAdd).toContain('new')
    // The second fence is a wholesale replacement (python → bash): ONE block carries both programs — the old
    // lines struck, then the new ones added — instead of two stacked code blocks.
    const second = fences[1]!
    expect(second.querySelectorAll('.mdWordDel').length).toBeGreaterThan(0)
    expect(second.querySelectorAll('.mdWordAdd').length).toBeGreaterThan(0)
    expect(second.textContent).toContain('print("python block")')
    expect(second.textContent).toContain('echo "added block"')
    // Neither block interleaves the two programs on ONE line: every changed run is a whole line or word of one
    // version, and the old fence is not a block of its own.
    const lines = [...second.querySelectorAll<HTMLElement>('.mdWordDel, .mdWordAdd')].map(run => run.textContent ?? '')
    for (const line of lines) {
      expect(line.includes('python') && line.includes('echo'), JSON.stringify(line)).toBe(false)
    }
    expect(root.querySelectorAll('pre.mdDel').length).toBe(0)
  })
})
