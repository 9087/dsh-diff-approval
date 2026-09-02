// @vitest-environment jsdom
// selectedPlainText: rebuild the copied text so auto-wrap's visual line breaks
// (rendered as separate block sub-lines) are not copied as newlines.

import { describe, expect, it } from 'vitest'
import { selectedPlainText } from '../src/client/PendingPanel.tsx'

describe('selectedPlainText', () => {
  it('joins a wrapped line sub-lines without a wrap newline', () => {
    document.body.innerHTML = `
      <div data-diff-row="0">
        <span class="gutter">1</span><span class="gutter">1</span>
        <span data-diff-code><div class="subline">foo bar</div><div class="subline">baz qux</div></span>
      </div>`
    const code = document.querySelector('[data-diff-code]')!
    const range = document.createRange()
    range.selectNodeContents(code)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    // The two visual sub-lines are one logical line: no newline between them.
    expect(selectedPlainText()).toBe('foo barbaz qux')
  })

  it('keeps the real newline between diff rows', () => {
    document.body.innerHTML = '<div data-diff-row="0"><span data-diff-code>aaa</span></div><div data-diff-row="1"><span data-diff-code>bbb</span></div>'
    const rows = document.querySelectorAll('[data-diff-row]')
    const firstCode = rows[0]!.querySelector('[data-diff-code]')!
    const lastCode = rows[1]!.querySelector('[data-diff-code]')!
    const range = document.createRange()
    range.setStart(firstCode, 0)
    range.setEnd(lastCode, lastCode.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('aaa\nbbb')
  })

  it('returns undefined for a collapsed selection', () => {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const range = document.createRange()
    range.collapse(document.body, 0)
    sel.addRange(range)
    expect(selectedPlainText()).toBeUndefined()
  })
})
