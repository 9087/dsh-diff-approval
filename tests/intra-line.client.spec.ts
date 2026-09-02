// computeIntraLineDiff: per-pair inline (intra-line) highlighting runs.

import { describe, expect, it } from 'vitest'
import { computeIntraLineDiff, computeWholeFileDiff } from '../src/client/whole-file-diff.ts'

const joined = (runs: { text: string }[] | undefined): string | undefined =>
  runs === undefined ? undefined : runs.map(r => r.text).join('')

describe('computeIntraLineDiff', () => {
  it('annotates a similar 1:1 del/add pair, reassembling both sides', () => {
    const diff = computeWholeFileDiff('foo bar\n', 'foo baz\n')
    // rows: del 'foo bar' (row 0), add 'foo baz' (row 1)
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('foo bar')
    expect(joined(intra.get(1))).toBe('foo baz')
    expect(intra.get(0)!.some(r => r.kind === 'del')).toBe(true)
    expect(intra.get(1)!.some(r => r.kind === 'add')).toBe(true)
  })

  it('skips a pair that is too dissimilar to be a modification', () => {
    const diff = computeWholeFileDiff('hello world here\n', 'completely different text now\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(intra.size).toBe(0)
  })

  it('does not annotate a pure addition or a pure deletion', () => {
    const added = computeWholeFileDiff('a\n', 'a\nb\n')
    expect(computeIntraLineDiff(added.rows).size).toBe(0)

    const removed = computeWholeFileDiff('a\nb\n', 'a\n')
    expect(computeIntraLineDiff(removed.rows).size).toBe(0)
  })

  it('has nothing to annotate for identical content', () => {
    const diff = computeWholeFileDiff('a\nb\n', 'a\nb\n')
    expect(computeIntraLineDiff(diff.rows).size).toBe(0)
  })

  it('pairs one-to-many by order, leaving the excess add unannotated', () => {
    const diff = computeWholeFileDiff('foo bar\n', 'foo baz\nqux\n')
    // rows: del 'foo bar' (0), add 'foo baz' (1), add 'qux' (2)
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('foo bar')
    expect(joined(intra.get(1))).toBe('foo baz')
    expect(intra.get(2)).toBeUndefined()
  })

  it('annotates two separate 1:1 modifications independently', () => {
    const diff = computeWholeFileDiff('foo bar\nmid\nold one\n', 'foo baz\nmid\nold two\n')
    const intra = computeIntraLineDiff(diff.rows)
    // rows: del 'foo bar' (0), add 'foo baz' (1), context 'mid' (2),
    //       del 'old one' (3), add 'old two' (4)
    expect(joined(intra.get(0))).toBe('foo bar')
    expect(joined(intra.get(1))).toBe('foo baz')
    expect(intra.get(2)).toBeUndefined()
    expect(joined(intra.get(3))).toBe('old one')
    expect(joined(intra.get(4))).toBe('old two')
  })

  it('highlights a whole edited token as one word-level run', () => {
    // Word-granularity for Latin: a changed identifier is one run, not per-char,
    // with the unchanged words around it as context.
    const diff = computeWholeFileDiff('get user by abcXYdef\n', 'get user by abcZWdef\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('get user by abcXYdef')
    expect(joined(intra.get(1))).toBe('get user by abcZWdef')
    expect(intra.get(0)!.filter(r => r.kind === 'del').map(r => r.text)).toEqual(['abcXYdef'])
    expect(intra.get(1)!.filter(r => r.kind === 'add').map(r => r.text)).toEqual(['abcZWdef'])
  })

  it('skips a single-token rewrite (no unchanged word to anchor an inline diff)', () => {
    const diff = computeWholeFileDiff('abcXYdef\n', 'abcZWdef\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(intra.size).toBe(0)
  })

  it('diffs punctuation atomically, one character per run', () => {
    // `(a).` → `(b).`: the parens/period stay context, only the letter changes —
    // punctuation is not merged into a single coarse run.
    const diff = computeWholeFileDiff('foo (a).\n', 'foo (b).\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('foo (a).')
    expect(joined(intra.get(1))).toBe('foo (b).')
    expect(intra.get(0)!.filter(r => r.kind === 'del').map(r => r.text)).toEqual(['a'])
    expect(intra.get(1)!.filter(r => r.kind === 'add').map(r => r.text)).toEqual(['b'])
  })

  it('isolates a change in a short CJK run with no spaces', () => {
    const diff = computeWholeFileDiff('AAAAA改成X然后继续BBBBB\n', 'AAAAA改成Y然后继续BBBBB\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('AAAAA改成X然后继续BBBBB')
    expect(joined(intra.get(1))).toBe('AAAAA改成Y然后继续BBBBB')
    expect(intra.get(0)!.some(r => r.kind === 'del')).toBe(true)
    expect(intra.get(1)!.some(r => r.kind === 'add')).toBe(true)
  })

  it('annotates a pure extension (the del line is a strict prefix of the add line)', () => {
    // The reported README case: the old line gains an appended tail. The del
    // side has no removed run, so a guard keyed on the del side alone would drop
    // the pair; the add side must still be highlighted.
    const diff = computeWholeFileDiff('foo bar\n', 'foo bar baz\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('foo bar')
    expect(joined(intra.get(1))).toBe('foo bar baz')
    expect(intra.get(0)!.some(r => r.kind === 'del')).toBe(false)
    expect(intra.get(1)!.some(r => r.kind === 'add')).toBe(true)
  })

  it('annotates a pure truncation (the add line is a strict prefix of the del line)', () => {
    const diff = computeWholeFileDiff('foo bar baz\n', 'foo bar\n')
    const intra = computeIntraLineDiff(diff.rows)
    expect(joined(intra.get(0))).toBe('foo bar baz')
    expect(joined(intra.get(1))).toBe('foo bar')
    expect(intra.get(0)!.some(r => r.kind === 'del')).toBe(true)
    expect(intra.get(1)!.some(r => r.kind === 'add')).toBe(false)
  })

  it('aligns a 1-del/2-add block by similarity for the intra-line highlight', () => {
    // The deletion "old line A" should highlight against "modified old line A"
    // (its most-similar addition), not against the unrelated first addition.
    const diff = computeWholeFileDiff('old line A\n', 'brand new unrelated\nmodified old line A\n')
    const intra = computeIntraLineDiff(diff.rows, true)
    // rows: del 0, add 1 (unrelated), add 2 (the true modification).
    expect(joined(intra.get(0))).toBe('old line A')
    expect(intra.get(1)).toBeUndefined()
    expect(joined(intra.get(2))).toBe('modified old line A')
    expect(intra.get(2)!.some(r => r.kind === 'add')).toBe(true)
  })

  it('skips alignment and highlighting together for a block too large to match', () => {
    // A whole-file rewrite (one 100×100 block) exceeds the similarity-alignment
    // cell cap, so it falls back to by-order pairing and skips the intra-line
    // highlight too — alignment and highlighting are all-or-nothing.
    const big = computeWholeFileDiff('a\n'.repeat(100), 'b\n'.repeat(100))
    const intra = computeIntraLineDiff(big.rows, true)
    expect(intra.size).toBe(0)
  })
})
