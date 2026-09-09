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

  it('excludes the line-number gutter cells when the selection spans the gutter', () => {
    // Selecting across the rows (including their line-number gutters) must drop
    // the gutter digits: only the code cells are the diff content.
    document.body.innerHTML = '<div data-diff-row="0"><span class="gutter" data-diff-gutter>10</span><span class="gutter" data-diff-gutter>10</span><span data-diff-code>aaa</span></div><div data-diff-row="1"><span class="gutter" data-diff-gutter>11</span><span class="gutter" data-diff-gutter>11</span><span data-diff-code>bbb</span></div>'
    const rows = document.querySelectorAll('[data-diff-row]')
    const range = document.createRange()
    range.setStart(rows[0]!, 0)
    range.setEnd(rows[1]!, rows[1]!.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('aaa\nbbb')
  })

  it('skips deleted (old) rows so the copy is the current code, not the diff', () => {
    // A del row holds the removed (old) line; context and add rows are the
    // current file's lines. Copying must yield only the current code.
    document.body.innerHTML = '<div data-diff-row="0" data-diff-line="context"><span data-diff-code>keep</span></div><div data-diff-row="1" data-diff-line="del"><span data-diff-code>old</span></div><div data-diff-row="2" data-diff-line="add"><span data-diff-code>new</span></div>'
    const rows = document.querySelectorAll('[data-diff-row]')
    const range = document.createRange()
    range.setStart(rows[0]!, 0)
    range.setEnd(rows[2]!, rows[2]!.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('keep\nnew')
  })

  it('skips a deleted row from its code cell even when only the cell is selected', () => {
    // A selection confined to a code cell may not include the row wrapper, so
    // the del marker must live on the code cell too.
    document.body.innerHTML = '<div data-diff-row="0"><span data-diff-code data-diff-code-line="context">keep</span></div><div data-diff-row="1"><span data-diff-code data-diff-code-line="del">old</span></div><div data-diff-row="2"><span data-diff-code data-diff-code-line="add">new</span></div>'
    const rows = document.querySelectorAll('[data-diff-row]')
    const range = document.createRange()
    range.setStart(rows[0]!, 0)
    range.setEnd(rows[2]!, rows[2]!.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('keep\nnew')
  })

  it('copies only the right (current) column of a split view', () => {
    // Split view renders the old revision in the left column; copying a
    // selection must give the current (right) code, not the old left side.
    document.body.innerHTML = '<div data-diff-split-row data-diff-split-side="left"><span data-diff-code data-diff-code-side="left">oldA</span></div>' + '<div data-diff-split-row data-diff-split-side="right"><span data-diff-code data-diff-code-side="right">newA</span></div>' + '<div data-diff-split-row data-diff-split-side="left"><span data-diff-code data-diff-code-side="left">oldB</span></div>' + '<div data-diff-split-row data-diff-split-side="right"><span data-diff-code data-diff-code-side="right">newB</span></div>'
    const rows = document.querySelectorAll('[data-diff-split-row]')
    const range = document.createRange()
    range.setStart(rows[0]!, 0)
    range.setEnd(rows[3]!, rows[3]!.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('newA\nnewB')
  })

  it('drops the non-breaking-space placeholder used to keep blank rows tall', () => {
    // A blank row renders as a lone NBSP to hold its height; that is layout, not
    // content, so it must not be copied — and the blank line is preserved.
    document.body.innerHTML = '<div data-diff-row="0" data-diff-line="context"><span data-diff-code>a</span></div><div data-diff-row="1" data-diff-line="context"><span data-diff-code>\u00a0</span></div><div data-diff-row="2" data-diff-line="context"><span data-diff-code>b</span></div>'
    const rows = document.querySelectorAll('[data-diff-row]')
    const range = document.createRange()
    range.setStart(rows[0]!, 0)
    range.setEnd(rows[2]!, rows[2]!.childNodes.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectedPlainText()).toBe('a\n\nb')
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
