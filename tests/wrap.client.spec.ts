// wrapInto: the panel's own Unicode line-break model — CJK per-character,
// Latin word atomic, East Asian kinsoku, and tab stops.

import { describe, expect, it } from 'vitest'
import { wrapInto } from '../src/client/PendingPanel.tsx'

// Each character is 1 unit wide, so wrap arithmetic reduces to char count.
const m = (s: string): number => s.length
const TAB = 4 // one tab stop, in spaces

describe('wrapInto', () => {
  it('returns a single empty line for empty text', () => {
    expect(wrapInto('', 10, m, TAB)).toEqual([''])
  })

  it('keeps a Latin word atomic, breaking only at a space', () => {
    expect(wrapInto('hello world', 10, m, TAB)).toEqual(['hello ', 'world'])
  })

  it('wraps CJK per character and fills each line (no over-split)', () => {
    expect(wrapInto('中文测试', 2, m, TAB)).toEqual(['中文', '测试'])
  })

  it('does not start a line with a closing/terminal punctuation (kinsoku)', () => {
    expect(wrapInto('中文。', 2, m, TAB)).toEqual(['中', '文。'])
  })

  it('does not end a line right after an opening punctuation (kinsoku)', () => {
    expect(wrapInto('（中文', 2, m, TAB)).toEqual(['（中', '文'])
  })

  it('splits an overlong Latin word at character boundaries as a fallback', () => {
    expect(wrapInto('abcdef', 3, m, TAB)).toEqual(['abc', 'def'])
  })

  it('advances a tab to the tab stop', () => {
    expect(wrapInto('a\tb', 6, m, TAB)).toEqual(['a\tb'])
  })
})
