// The in-file search matcher: substring by default, narrowed by case and by
// whole word. Both the unified rows and the split view count through it, so its
// behavior is the contract they share.

import { describe, expect, it } from 'vitest'
import { matchRangesOf } from '../src/client/search.ts'

const CASE = { caseSensitive: true, wholeWord: false }
const WORD = { caseSensitive: false, wholeWord: true }
const BOTH = { caseSensitive: true, wholeWord: true }

describe('matchRangesOf', () => {
  it('matches case-insensitively by default', () => {
    expect(matchRangesOf('Foo foo', 'foo')).toEqual([[0, 3], [4, 7]])
  })

  it('matches letter case exactly when asked', () => {
    expect(matchRangesOf('Foo foo', 'foo', CASE)).toEqual([[4, 7]])
    expect(matchRangesOf('Foo foo', 'Foo', CASE)).toEqual([[0, 3]])
  })

  it('reports every occurrence, left to right', () => {
    expect(matchRangesOf('a b a', 'a')).toEqual([[0, 1], [4, 5]])
  })

  it('matches nothing for an empty query', () => {
    expect(matchRangesOf('abc', '')).toEqual([])
    expect(matchRangesOf('abc', '', WORD)).toEqual([])
  })

  it('skips occurrences embedded in a longer word', () => {
    expect(matchRangesOf('foo foobar barfoo foo', 'foo', WORD)).toEqual([[0, 3], [18, 21]])
  })

  it('treats a match at either string edge as a whole word', () => {
    expect(matchRangesOf('foo', 'foo', WORD)).toEqual([[0, 3]])
    expect(matchRangesOf('a foo', 'foo', WORD)).toEqual([[2, 5]])
  })

  it('counts underscores and digits as word characters', () => {
    // _foo, foo_ and foo1 are all one word; only the trailing standalone matches.
    expect(matchRangesOf('_foo foo_ foo1 bar foo', 'foo', WORD)).toEqual([[19, 22]])
  })

  it('applies case and whole word together', () => {
    expect(matchRangesOf('Foo foo FOO', 'foo', BOTH)).toEqual([[4, 7]])
  })
})
