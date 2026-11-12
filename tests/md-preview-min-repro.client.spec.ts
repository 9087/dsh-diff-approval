// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderFlowMerged, renderMarkdownPreview } from '../src/client/markdown-preview.ts'

/** Cell texts of the rendered table, header and body in document order. */
function tableCells(html: string): { head: string[]; body: string[] } {
  document.body.innerHTML = html
  return {
    head: [...document.querySelectorAll('th')].map(cell => cell.textContent ?? ''),
    body: [...document.querySelectorAll('td')].map(cell => cell.textContent ?? ''),
  }
}

describe('markdown preview table rendering regressions', () => {
  it('locates multi-line tokens in a CRLF document (table after another block survives)', () => {
    // CRLF looks like one block plus a table; marked lexes token.raw with LF, so the renderer must not search
    // that LF raw in the raw CRLF document after a preceding block (indexOf returns -1 and shifts everything).
    const text = '# H\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n'
    const cells = tableCells(renderFlowMerged(text, text))
    expect(cells.head).toEqual(['A', 'B'])
    expect(cells.body).toEqual(['x', 'y'])
  })

  it('places an empty table cell on its own row, not on the table header', () => {
    // The empty cells have no text to search; their line must come from the table's row offset (row 2 of the
    // table for the first body row), not from the table's start line (the header).
    const text = '| A | B | C |\n| --- | --- | --- |\n| x |  |  |\n'
    const cells = tableCells(renderFlowMerged(text, text))
    expect(cells.head).toEqual(['A', 'B', 'C'])
    expect(cells.body).toEqual(['x', '', ''])
  })

  it('renders the CRLF table in the line-hunk (non-tree) renderer too', () => {
    // The annotated renderer is shared by both pipelines, so force the old blocks path and check it as well.
    localStorage.setItem('diff-approval:tree-diff', '0')
    try {
      const text = '# H\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n'
      const cells = tableCells(renderMarkdownPreview(text, text, 'single', 'structure'))
      expect(cells.head).toEqual(['A', 'B'])
      expect(cells.body).toEqual(['x', 'y'])
    } finally {
      localStorage.removeItem('diff-approval:tree-diff')
    }
  })
})
