// REQUIREMENT CONTRACTS for the ONE comprehensive sample pair the user reviews
// (`tests/fixtures/md-block-spec/demo-old.md` → `demo-new.md`, the merged demo/rich document):
//   1. blocks never nest and never overlap: a hover can only frame its own block;
//   2. the DOM order of block numbers is the syntax tree's preorder (left to right, top to bottom);
//   3. a changed code line / table cell / inline child is a block of its own;
//   4. syntax-only changes give element twins, not a tinted container.
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { treePreviewModel } from '../src/client/markdown-tree-blocks.ts'
import { renderTreeDocuments, renderTreeMerged } from '../src/client/markdown-preview.ts'

const fixture = (name: string): string => readFileSync(join(process.cwd(), 'tests', 'fixtures', 'md-block-spec', name), 'utf8')

const blocksOfText = (oldText: string, newText: string): ReturnType<typeof treePreviewModel>['blocks'] =>
  treePreviewModel(oldText, newText).blocks

interface Case {
  name: string
  oldText: string
  newText: string
}

const CASES: Case[] = [
  { name: 'demo.md (comprehensive)', oldText: fixture('demo-old.md'), newText: fixture('demo-new.md') },
]

/** Every element carrying a block number, and whether it sits inside a DIFFERENT block's element. */
const blockElements = (root: HTMLElement): { element: HTMLElement; nested: string | undefined }[] =>
  [...root.querySelectorAll<HTMLElement>('[data-md-block]')].map(element => {
    const ancestor = element.parentElement?.closest<HTMLElement>('[data-md-block]') ?? null
    const nested = ancestor !== null && ancestor !== element && ancestor.dataset.mdBlock !== element.dataset.mdBlock
      ? `${element.dataset.mdBlock} inside ${ancestor.dataset.mdBlock}`
      : undefined
    return { element, nested }
  })

/** The document order of unique block numbers. */
const domOrder = (root: HTMLElement): number[] => {
  const order: number[] = []
  for (const { element } of blockElements(root)) {
    const index = Number(element.dataset.mdBlock)
    if (!order.includes(index)) order.push(index)
  }
  return order
}

const expectPreorder = (order: number[]): void => {
  const bad: number[] = []
  for (let index = 1; index < order.length; index++) if (order[index]! < order[index - 1]!) bad.push(order[index]!)
  expect(bad).toEqual([])
}

describe('requirement contract: the real rich/demo documents', () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('has a preordered, non-nesting block model with no whitespace-only units', () => {
        const model = blocksOfText(testCase.oldText, testCase.newText)
        expect(model.length).toBeGreaterThan(3)
        // Preorder: the model's block numbers follow the new document from top to bottom (and, within one
        // line, from left to right).
        let previousLine = 0
        for (const block of model) {
          expect(block.newStart).toBeGreaterThanOrEqual(previousLine)
          previousLine = block.newStart
        }
        // A whitespace-only "difference" is the residue of a Markdown marker respelling: it is never a block.
        for (const block of model) {
          for (const unit of block.units) {
            expect(unit.oldText === unit.newText && unit.oldText !== '').toBe(false)
            expect(unit.oldText.trim() === '' && unit.newText.trim() === '').toBe(false)
          }
        }
        // Every block has at least one of: units, single-side nodes, an invisible diff.
        for (const block of model) {
          expect(block.units.length + block.oldNodes.length + block.newNodes.length + block.invisible.length).toBeGreaterThan(0)
        }
      })

      it('renders in preorder without nested blocks (single column)', () => {
        const holder = document.createElement('div')
        holder.innerHTML = renderTreeMerged(testCase.oldText, testCase.newText)
        const elements = blockElements(holder)
        expect(elements.filter(entry => entry.nested !== undefined).map(entry => entry.nested)).toEqual([])
        expectPreorder(domOrder(holder))
      })

      it('renders in preorder without nested blocks (double column, per side)', () => {
        const holder = document.createElement('div')
        holder.innerHTML = renderTreeDocuments(testCase.oldText, testCase.newText)
        const sides = [...holder.querySelectorAll<HTMLElement>('[data-diff-doc-side]')]
        expect(sides.length).toBe(2)
        for (const side of sides) {
          expect(blockElements(side).filter(entry => entry.nested !== undefined)).toEqual([])
          expectPreorder(domOrder(side))
        }
      })
    })
  }

  it('reference-style links: the retargeted link is a twin, the paragraph is not tinted, blocks do not nest', () => {
    const rich = CASES[0]!
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged(rich.oldText, rich.newText)
    const paragraph = [...holder.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('参考式链接'))
    expect(paragraph).toBeDefined()
    // The visible rendering of the reference-style link is the same, so the change is the LINK TARGET: a twin.
    const twin = paragraph!.querySelector<HTMLElement>('.mdTwin a[href*="example.com/new-ref"]')
    expect(twin).not.toBeNull()
    // The paragraph itself is not washed: its blocks are the inline children, and they do not nest.
    expect(paragraph!.classList.contains('mdAdd') || paragraph!.classList.contains('mdDel')).toBe(false)
    const ids = [...new Set([...paragraph!.querySelectorAll<HTMLElement>('[data-md-block]')].map(element => element.dataset.mdBlock))]
    expect(ids.length).toBeGreaterThanOrEqual(1)
    expect(blockElements(paragraph!).filter(entry => entry.nested !== undefined)).toEqual([])
  })

  it('syntax-only Markdown changes are element twins, not a tinted paragraph', () => {
    const rich = CASES[0]!
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged(rich.oldText, rich.newText)
    const paragraph = [...holder.querySelectorAll<HTMLElement>('p')]
      .find(element => (element.textContent ?? '').includes('Markdown 写法变化'))
    expect(paragraph).toBeDefined()
    expect(paragraph!.classList.contains('mdAdd') || paragraph!.classList.contains('mdDel')).toBe(false)
    // The re-spelled strong/em elements are drawn as their own red/green pairs.
    expect(paragraph!.querySelectorAll('.mdTwin strong, .mdTwin em').length).toBeGreaterThanOrEqual(2)
    // No leftover whitespace blocks.
    const model = blocksOfText(rich.oldText, rich.newText)
    const whitespaceOnly = model.filter(block => block.units.length > 0
      && block.units.every(unit => unit.oldText.trim() === '' && unit.newText.trim() === ''))
    expect(whitespaceOnly).toEqual([])
  })

  it('code: non-adjacent changed lines are separate blocks; adjacent lines share one', () => {
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged('```\nAA\nBB\nCC\nDD\n```\n', '```\nAA\nXX\nCC\nYY\n```\n')
    const code = holder.querySelector('code')!
    const ids = [...new Set([...code.querySelectorAll<HTMLElement>('[data-md-block]')].map(element => element.dataset.mdBlock))]
    // The two edits are two blocks; each run belongs to exactly one block.
    expect(ids).toHaveLength(2)
    for (const id of ids) {
      expect(code.querySelectorAll<HTMLElement>(`[data-md-block="${id}"]`).length).toBeGreaterThan(0)
    }
    // Adjacent changed lines stay ONE block.
    const adjacent = blocksOfText('```\nAA\nBB\n```\n', '```\nXX\nYY\n```\n')
    expect(adjacent).toHaveLength(1)
    expect(adjacent[0]!.units).toHaveLength(2)
  })

  it('code: changed lines are compared top to bottom (old line above new line)', () => {
    const demo = CASES[0]!
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged(demo.oldText, demo.newText)
    const pre = holder.querySelector('pre code')?.closest('pre') ?? null
    expect(pre).not.toBeNull()
    const code = pre!.querySelector('code')!
    const text = code.textContent ?? ''
    // The change is shown as LINE blocks: the two struck old lines, then the two green replacements.
    const lineRuns = [...code.querySelectorAll<HTMLElement>('.mdCodeLine')]
    expect(lineRuns).toHaveLength(4)
    expect(lineRuns[0]!.className).toContain('mdWordDel')
    expect(lineRuns[0]!.textContent).toBe('const version = 1')
    expect(lineRuns[1]!.className).toContain('mdWordDel')
    expect(lineRuns[1]!.textContent).toBe("console.log('old')")
    expect(lineRuns[2]!.className).toContain('mdWordAdd')
    expect(lineRuns[2]!.textContent).toBe('const version = 2')
    expect(lineRuns[3]!.className).toContain('mdWordAdd')
    expect(lineRuns[3]!.textContent).toBe("console.log('new')")
    // No inline half-line comparison and no fence leakage; the untouched line is intact.
    expect(text).toContain("console.log('old')")
    expect(text).toContain("console.log('new')")
    expect(text).not.toContain('```')
    expect(text).not.toContain('const const')
    // Double column: each column keeps its own complete code.
    const doubleHolder = document.createElement('div')
    doubleHolder.innerHTML = renderTreeDocuments(demo.oldText, demo.newText)
    const oldCode = doubleHolder.querySelector<HTMLElement>('[data-diff-doc-side="old"] pre code')!.textContent
    const newCode = doubleHolder.querySelector<HTMLElement>('[data-diff-doc-side="new"] pre code')!.textContent
    expect(oldCode).toBe("const version = 1\nconsole.log('old')\n")
    expect(newCode).toBe("const version = 2\nconsole.log('new')\n")
  })

  it('demo table: two changed cells are two blocks, each inside its own cell; the row is not a block', () => {
    const demo = CASES[0]!
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged(demo.oldText, demo.newText)
    // The `All` row changes TWO cells (true→false, 弹窗→弹窗确认).
    const row = [...holder.querySelectorAll<HTMLElement>('tbody tr')].find(candidate => (candidate.textContent ?? '').includes('All'))!
    const cells = [...row.children].filter((cell): cell is HTMLElement => cell instanceof HTMLElement)
    const idsByCell = cells.map(cell => [...new Set([...cell.querySelectorAll<HTMLElement>('[data-md-block]')].map(element => element.dataset.mdBlock))])
    expect(row.dataset.mdBlock).toBeUndefined()
    expect(idsByCell[1]).toHaveLength(1)
    expect(idsByCell[2]).toHaveLength(1)
    expect(idsByCell[1]).not.toEqual(idsByCell[2])
  })

  it('demo image: path/title change is a pair of frames with the old/new source', () => {
    const demo = CASES[0]!
    const holder = document.createElement('div')
    holder.innerHTML = renderTreeMerged(demo.oldText, demo.newText)
    const twin = holder.querySelector<HTMLElement>('.mdTwin.mdTwinImages')!
    expect(twin).not.toBeNull()
    const paths = [...twin.querySelectorAll('.mdImagePath')].map(path => path.textContent)
    expect(paths).toEqual(['./old-shot.png', './new-shot.png'])
    expect(twin.dataset.mdDiffOld).toContain('old-shot.png')
    expect(twin.dataset.mdDiffNew).toContain('new-shot.png')
  })

  it('shows NO eye icons: fallback content is its source text', () => {
    const demo = CASES[0]!
    const single = document.createElement('div')
    single.innerHTML = renderTreeMerged(demo.oldText, demo.newText)
    const double = document.createElement('div')
    double.innerHTML = renderTreeDocuments(demo.oldText, demo.newText)
    for (const root of [single, double]) {
      expect(root.querySelectorAll('[data-md-twin-caption]')).toHaveLength(0)
      expect(root.querySelectorAll('.mdTwinCaption svg')).toHaveLength(0)
    }
    // The deleted inline link is still readable as content; the tree path needs no eye fallback here.
    expect(single.textContent).toContain('会消失的链接')
    expect(single.querySelectorAll('.mdTwinPhantom')).toHaveLength(0)
  })
})
