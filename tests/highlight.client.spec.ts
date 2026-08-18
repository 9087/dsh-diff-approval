// The bundled Shiki highlighter: per-line token runs and plain fallbacks.

import { describe, expect, it } from 'vitest'
import { highlightLines } from '../src/client/highlight.ts'

describe('highlightLines', () => {
  it('returns one span list per line with the css-variable color theme', () => {
    const runs = highlightLines('const answer: number = 42\nconsole.log(answer)\n', 'typescript')
    expect(runs).toBeDefined()
    expect(runs).toHaveLength(2)
    const first = runs![0]!
    expect(first.length).toBeGreaterThan(0)
    expect(first.map(span => span.text).join('')).toBe('const answer: number = 42')
    for (const span of first) {
      expect(span.style.color).toMatch(/^var\(--shiki-/)
    }
  })

  it('drops the trailing terminator line shiki appends', () => {
    const runs = highlightLines('x = 1\n', 'python')
    expect(runs).toHaveLength(1)
    expect(runs![0]!.map(span => span.text).join('')).toBe('x = 1')
  })

  it('returns undefined for unknown languages and empty code', () => {
    expect(highlightLines('code', undefined)).toBeUndefined()
    expect(highlightLines('code', 'not-a-grammar')).toBeUndefined()
    expect(highlightLines('', 'typescript')).toBeUndefined()
  })

  it('highlights several grammars from the static set', () => {
    expect(highlightLines('echo hi', 'shellscript')).toBeDefined()
    expect(highlightLines('{"a":1}', 'json')).toBeDefined()
    expect(highlightLines('<div/>', 'html')).toBeDefined()
    expect(highlightLines('fn main() {}', 'rust')).toBeDefined()
    expect(highlightLines('local x = 1', 'lua')).toBeDefined()
  })

  it('skips highlighting whole files above the size cap', () => {
    const huge = 'a = 1\n'.repeat(40_000) // > MAX_HIGHLIGHT_CHARS (300k)
    expect(highlightLines(huge, 'python')).toBeUndefined()
    // A file under the char cap but over the line cap also degrades.
    const manyLines = 'a = 1\n'.repeat(11_000) // > MAX_HIGHLIGHT_LINES (10k)
    expect(highlightLines(manyLines, 'python')).toBeUndefined()
  })

  it('keeps highlighting a file with one overlong line (degraded, not skipped)', () => {
    const wide = `x = 1\n${'y'.repeat(4000)}\nz = 2\n` // line > MAX_LINE_LENGTH
    const runs = highlightLines(wide, 'python')
    expect(runs).toBeDefined()
    expect(runs).toHaveLength(3)
    // The overlong line degrades to a single plain span carrying the text.
    expect(runs![1]!.length).toBeGreaterThanOrEqual(1)
    expect(runs![1]!.map(span => span.text).join('')).toBe('y'.repeat(4000))
  })

  it('serves repeated identical requests from the tokenize cache', () => {
    const code = 'const answer: number = 42\n'
    const first = highlightLines(code, 'typescript')
    const second = highlightLines(code, 'typescript')
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })
})
