// Reference labels: workspace-relative paths inside the workspace, absolute
// paths outside, each plus a line range.

import { describe, expect, it } from 'vitest'
import {
  basenameOf, lineRangeLabel, referenceOf, referencePathOf, remapReferenceRange, remapReferences,
} from '../src/client/reference.ts'

describe('basenameOf', () => {
  it('keeps the last segment for both separator styles', () => {
    expect(basenameOf('/repo/src/a.txt')).toBe('a.txt')
    expect(basenameOf('C:\\repo\\src\\a.txt')).toBe('a.txt')
    expect(basenameOf('a.txt')).toBe('a.txt')
  })
})

describe('referencePathOf', () => {
  it('returns the path relative to the workspace when the file is inside it', () => {
    expect(referencePathOf('/repo/src/a.txt', '/repo')).toBe('src/a.txt')
    expect(referencePathOf('C:\\repo\\src\\a.txt', 'C:\\repo')).toBe('src/a.txt')
  })

  it('handles a workspace root without a trailing separator', () => {
    expect(referencePathOf('/repo/src/a.txt', '/repo/')).toBe('src/a.txt')
  })

  it('keeps the absolute path when the file is outside the workspace', () => {
    expect(referencePathOf('/elsewhere/a.txt', '/repo')).toBe('/elsewhere/a.txt')
  })

  it('keeps the path unchanged without a workspace', () => {
    expect(referencePathOf('/repo/a.txt', undefined)).toBe('/repo/a.txt')
  })
})

describe('lineRangeLabel', () => {
  it('formats a single line and an inclusive range', () => {
    expect(lineRangeLabel(12, 12)).toBe('12')
    expect(lineRangeLabel(12, 34)).toBe('12-34')
  })
})

describe('referenceOf', () => {
  it('combines the workspace-relative path and the range, wrapped in parentheses', () => {
    expect(referenceOf('/repo/src/a.txt', '/repo', 12, 34)).toBe('(src/a.txt:12-34)')
    expect(referenceOf('/repo/src/a.txt', '/repo', 12, 12)).toBe('(src/a.txt:12)')
  })

  it('uses the absolute path and the range for files outside the workspace', () => {
    expect(referenceOf('/elsewhere/a.ts', '/repo', 3, 7)).toBe('(/elsewhere/a.ts:3-7)')
  })
})

describe('remapReferenceRange', () => {
  it('keeps unchanged lines at the same numbers', () => {
    expect(remapReferenceRange('a\nb\nc\n', 'a\nb\nc\n', 2, 2)).toEqual({ start: 2, end: 2 })
  })

  it('shifts a line when lines are inserted above it', () => {
    // 'a\nb\n' -> 'x\na\nb\n' inserts line 1, so old line 1 becomes new line 2.
    expect(remapReferenceRange('a\nb\n', 'x\na\nb\n', 1, 1)).toEqual({ start: 2, end: 2 })
  })

  it('returns undefined when the referenced line was removed', () => {
    expect(remapReferenceRange('a\nb\nc\n', 'a\nc\n', 2, 2)).toBeUndefined()
  })

  it('keeps the surviving lines of a partially-changed range', () => {
    // 'a\nb\nc\nd\n' -> 'a\nX\nc\nd\n': line 2 removed, 1/3/4 survive.
    expect(remapReferenceRange('a\nb\nc\nd\n', 'a\nX\nc\nd\n', 1, 4)).toEqual({ start: 1, end: 4 })
  })

  it('keeps a line when only the trailing newline changed', () => {
    expect(remapReferenceRange('a\nb\n', 'a\nb', 2, 2)).toEqual({ start: 2, end: 2 })
  })
})

describe('remapReferences', () => {
  it('remaps a single-line reference after an insertion above it', () => {
    expect(remapReferences('看 (a.txt:1) 这里', 'a.txt', 'a\nb\n', 'x\na\nb\n'))
      .toBe('看 (a.txt:2) 这里')
  })

  it('marks an expired single-line reference', () => {
    expect(remapReferences('(a.txt:2)', 'a.txt', 'a\nb\nc\n', 'a\nc\n'))
      .toBe('(a.txt:LINE_MISSING)')
  })

  it('remaps a range reference', () => {
    expect(remapReferences('(a.txt:2-3)', 'a.txt', 'a\nb\nc\n', 'x\na\nb\nc\n'))
      .toBe('(a.txt:3-4)')
  })

  it('leaves references to other files untouched', () => {
    expect(remapReferences('(a.txt:1) 和 (b.txt:2)', 'a.txt', 'a\n', 'x\na\n'))
      .toBe('(a.txt:2) 和 (b.txt:2)')
  })

  it('rewrites multiple occurrences of the same file', () => {
    expect(remapReferences('(a.txt:1) (a.txt:2)', 'a.txt', 'a\nb\n', 'x\na\nb\n'))
      .toBe('(a.txt:2) (a.txt:3)')
  })

  it('does not touch an unwrapped path:number', () => {
    expect(remapReferences('a.txt:1', 'a.txt', 'a\n', 'x\na\n'))
      .toBe('a.txt:1')
  })

  it('does not expire a reference when only the trailing newline changed', () => {
    expect(remapReferences('(a.txt:2)', 'a.txt', 'a\nb\n', 'a\nb'))
      .toBe('(a.txt:2)')
  })
})
