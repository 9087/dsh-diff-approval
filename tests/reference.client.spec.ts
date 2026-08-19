// Reference labels: workspace-relative paths inside the workspace, absolute
// paths outside, each plus a line range.

import { describe, expect, it } from 'vitest'
import {
  basenameOf, lineRangeLabel, referenceOf, referencePathOf,
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
  it('combines the workspace-relative path and the range', () => {
    expect(referenceOf('/repo/src/a.txt', '/repo', 12, 34)).toBe('src/a.txt:12-34')
    expect(referenceOf('/repo/src/a.txt', '/repo', 12, 12)).toBe('src/a.txt:12')
  })

  it('uses the absolute path and the range for files outside the workspace', () => {
    expect(referenceOf('/elsewhere/a.ts', '/repo', 3, 7)).toBe('/elsewhere/a.ts:3-7')
  })
})
