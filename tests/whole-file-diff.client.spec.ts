// computeWholeFileDiff: whole-file rows, change marking, and terminator rules.

import { describe, expect, it } from 'vitest'
import { computeWholeFileDiff } from '../src/client/whole-file-diff.ts'

describe('computeWholeFileDiff', () => {
  it('renders every line of both sides with changed lines marked', () => {
    const diff = computeWholeFileDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'B', oldLine: undefined, newLine: 2 },
      { kind: 'context', text: 'c', oldLine: 3, newLine: 3 },
    ])
    expect(diff.removed).toBe(1)
    expect(diff.added).toBe(1)
  })

  it('marks a pure addition and a pure deletion', () => {
    const added = computeWholeFileDiff('a\n', 'a\nb\n')
    expect(added.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'add', text: 'b', oldLine: undefined, newLine: 2 },
    ])
    expect(added.added).toBe(1)
    expect(added.removed).toBe(0)

    const removed = computeWholeFileDiff('a\nb\n', 'a\n')
    expect(removed.rows).toEqual([
      { kind: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'b', oldLine: 2, newLine: undefined },
    ])
    expect(removed.removed).toBe(1)
  })

  it('treats a single trailing newline as a terminator, not an empty line', () => {
    const diff = computeWholeFileDiff('old\n', 'new\n')
    expect(diff.rows).toEqual([
      { kind: 'del', text: 'old', oldLine: 1, newLine: undefined },
      { kind: 'add', text: 'new', oldLine: undefined, newLine: 1 },
    ])
  })

  it('handles empty sides', () => {
    expect(computeWholeFileDiff('', 'x\n').rows)
      .toEqual([{ kind: 'add', text: 'x', oldLine: undefined, newLine: 1 }])
    expect(computeWholeFileDiff('x\n', '').rows)
      .toEqual([{ kind: 'del', text: 'x', oldLine: 1, newLine: undefined }])
    expect(computeWholeFileDiff('', '').rows).toEqual([])
  })

  it('drops the no-newline patch marker', () => {
    const diff = computeWholeFileDiff('x', 'x\ny')
    expect(diff.rows).toEqual([
      { kind: 'del', text: 'x', oldLine: 1, newLine: undefined },
      { kind: 'add', text: 'x', oldLine: undefined, newLine: 1 },
      { kind: 'add', text: 'y', oldLine: undefined, newLine: 2 },
    ])
  })
})
