// Reference labels: short names when unambiguous, full paths on clashes.

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PendingFileDiff } from '../src/types.ts'
import {
  basenameOf, copyDisplayPath, lineRangeLabel, referenceOf,
} from '../src/client/reference.ts'

const S1 = 'session-1' as SessionId

function file(path: string): PendingFileDiff {
  return {
    id: `id:${path}`, sessionId: S1, path, kind: 'edit',
    oldText: '', newText: '', updatedAt: 0, missing: false, diverged: false,
  }
}

describe('basenameOf', () => {
  it('keeps the last segment for both separator styles', () => {
    expect(basenameOf('/repo/src/a.txt')).toBe('a.txt')
    expect(basenameOf('C:\\repo\\src\\a.txt')).toBe('a.txt')
    expect(basenameOf('a.txt')).toBe('a.txt')
  })
})

describe('copyDisplayPath', () => {
  it('uses the short name when no other listed file shares it', () => {
    expect(copyDisplayPath('/repo/src/a.txt', [file('/repo/src/a.txt'), file('/repo/other.txt')])).toBe('a.txt')
  })

  it('falls back to the full path when another listed file shares the name', () => {
    expect(copyDisplayPath('/repo/src/a.txt', [file('/repo/src/a.txt'), file('/repo/test/a.txt')])).toBe('/repo/src/a.txt')
  })
})

describe('lineRangeLabel', () => {
  it('formats a single line and an inclusive range', () => {
    expect(lineRangeLabel(12, 12)).toBe('12')
    expect(lineRangeLabel(12, 34)).toBe('12-34')
  })
})

describe('referenceOf', () => {
  it('combines the display path and the range', () => {
    expect(referenceOf('/repo/a.txt', [file('/repo/a.txt')], 12, 34)).toBe('a.txt:12-34')
    expect(referenceOf('/repo/a.txt', [file('/repo/a.txt')], 12, 12)).toBe('a.txt:12')
  })

  it('uses the full path when the short name clashes', () => {
    const files = [file('/repo/src/a.ts'), file('/repo/tests/a.ts')]
    expect(referenceOf('/repo/src/a.ts', files, 3, 7)).toBe('/repo/src/a.ts:3-7')
  })
})
