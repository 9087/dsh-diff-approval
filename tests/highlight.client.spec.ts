// The bundled Shiki highlighter: windowed per-line token runs and plain fallbacks.

import { describe, expect, it } from 'vitest'
import { highlightWindow } from '../src/client/highlight.ts'

/** Split source text into the line array `highlightWindow` takes (no trailing
 *  empty line for a terminated file, exactly as the caller's own array is). */
const lines = (text: string): string[] =>
  text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')

/** One line's visible text, from its runs. */
const textOf = (runs: { text: string }[]): string => runs.map(span => span.text).join('')
/** One line's colours, from its runs. */
const colorsOf = (runs: { style: { color?: string } }[]): string => runs.map(span => span.style.color).join('|')

describe('highlightWindow', () => {
  it('returns one span list per line with the css-variable color theme', () => {
    const source = lines('const answer: number = 42\nconsole.log(answer)\n')
    const window = highlightWindow(source, 'typescript', 0, source.length)
    expect(window).toBeDefined()
    expect(window!.runs).toHaveLength(2)
    const first = window!.runs[0]!
    expect(first.length).toBeGreaterThan(0)
    expect(textOf(first)).toBe('const answer: number = 42')
    for (const span of first) {
      expect(span.style.color).toMatch(/^var\(--shiki-/)
    }
  })

  it('highlights only the requested range, wherever it sits in the file', () => {
    const source = lines(Array.from({ length: 500 }, (_, index) => `const v${index}: number = ${index}`).join('\n'))
    const window = highlightWindow(source, 'typescript', 300, 310)
    expect(window).toBeDefined()
    expect(window!.runs).toHaveLength(10)
    expect(textOf(window!.runs[0]!)).toBe('const v300: number = 300')
    expect(textOf(window!.runs[9]!)).toBe('const v309: number = 309')
  })

  it('returns undefined for unknown languages and empty ranges', () => {
    expect(highlightWindow(lines('code'), undefined, 0, 1)).toBeUndefined()
    expect(highlightWindow(lines('code'), 'not-a-grammar', 0, 1)).toBeUndefined()
    expect(highlightWindow(lines('code'), 'typescript', 1, 1)).toBeUndefined()
  })

  it('clamps a range that runs past the end of the file', () => {
    const source = lines('x = 1\ny = 2')
    const window = highlightWindow(source, 'python', 1, 99)
    expect(window!.runs).toHaveLength(1)
    expect(textOf(window!.runs[0]!)).toBe('y = 2')
  })

  it('highlights several grammars from the static set', () => {
    const one = (code: string, lang: string): number =>
      highlightWindow(lines(code), lang, 0, 1)?.runs.length ?? 0
    expect(one('echo hi', 'shellscript')).toBe(1)
    expect(one('{"a":1}', 'json')).toBe(1)
    expect(one('<div/>', 'html')).toBe(1)
    expect(one('fn main() {}', 'rust')).toBe(1)
    expect(one('local x = 1', 'lua')).toBe(1)
  })

  it('keeps highlighting a window with one overlong line (degraded, not skipped)', () => {
    const wide = `x = 1\n${'y'.repeat(4000)}\nz = 2`
    const window = highlightWindow(lines(wide), 'python', 0, 3)
    expect(window).toBeDefined()
    expect(window!.runs).toHaveLength(3)
    // The overlong line degrades to a single plain span carrying its text.
    expect(textOf(window!.runs[1]!)).toBe('y'.repeat(4000))
  })

  it('continues exactly from a saved grammar state', () => {
    // A block comment makes the state matter: tokenizing line 3 on its own would
    // not know it is still inside the comment.
    const source = lines('/* a\n b\n c\n*/\nconst x: number = 1')
    const whole = highlightWindow(source, 'typescript', 0, source.length)!
    const head = highlightWindow(source, 'typescript', 0, 3)!
    expect(head.state).toBeDefined()
    const tail = highlightWindow(source, 'typescript', 3, source.length, { state: head.state })!
    expect(tail.runs.map(textOf)).toEqual(whole.runs.slice(3).map(textOf))
    expect(tail.runs.map(colorsOf)).toEqual(whole.runs.slice(3).map(colorsOf))
  })

  it('uses context lines so a window inside a construct still colours correctly', () => {
    const source = lines('/* a\n b\n c\n*/\nconst x: number = 1')
    const withContext = highlightWindow(source, 'typescript', 2, 4, { context: 40 })!
    const without = highlightWindow(source, 'typescript', 2, 4)!
    const whole = highlightWindow(source, 'typescript', 0, source.length)!
    // Without context the grammar starts fresh at line 3, so the comment body is
    // coloured as code; with context it agrees with the whole-file run.
    expect(colorsOf(withContext.runs[0]!)).not.toBe(colorsOf(without.runs[0]!))
    expect(withContext.runs.map(colorsOf)).toEqual(whole.runs.slice(2, 4).map(colorsOf))
  })

  it('serves repeated identical windows from the tokenize cache', () => {
    const source = lines('const answer: number = 42')
    const first = highlightWindow(source, 'typescript', 0, 1)
    const second = highlightWindow(source, 'typescript', 0, 1)
    expect(first).toBeDefined()
    expect(second!.runs).toBe(first!.runs)
  })

  it('degrades a window whose own text is enormous, without touching others', () => {
    // 400 lines × 2000 chars is over the window text cap; a normal window over the
    // same lines still highlights.
    const source = Array.from({ length: 400 }, () => 'y'.repeat(2000))
    expect(highlightWindow(source, 'python', 0, 400)).toBeUndefined()
    expect(highlightWindow(source, 'python', 0, 10)).toBeDefined()
  })
})
