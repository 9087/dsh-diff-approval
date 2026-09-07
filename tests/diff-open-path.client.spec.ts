// Produced-file chip path vs pending file path matching (open-from-chip).

import { describe, expect, it } from 'vitest'
import { diffPathsMatch, normalizeDiffPath } from '../src/client/PendingPanel.tsx'

describe('normalizeDiffPath', () => {
  it('unifies separators and drops a trailing slash', () => {
    expect(normalizeDiffPath('C:\\repo\\src\\foo.ts')).toBe('C:/repo/src/foo.ts')
    expect(normalizeDiffPath('C:/repo/src/foo.ts/')).toBe('C:/repo/src/foo.ts')
  })
})

describe('diffPathsMatch', () => {
  it('matches a workspace-relative chip path to the absolute pending path', () => {
    expect(diffPathsMatch('src/foo.ts', 'C:\\repo\\src\\foo.ts', 'C:\\repo')).toBe(true)
    expect(diffPathsMatch('src/foo.ts', 'C:/repo/src/foo.ts', 'C:/repo')).toBe(true)
  })

  it('matches an absolute chip path to an absolute pending path across separators', () => {
    expect(diffPathsMatch('C:/repo/src/foo.ts', 'C:\\repo\\src\\foo.ts', 'C:\\repo')).toBe(true)
  })

  it('is case-insensitive (Windows drives/dirs)', () => {
    expect(diffPathsMatch('src/Foo.ts', 'C:\\repo\\src\\foo.ts', 'C:\\repo')).toBe(true)
  })

  it('falls back to a normalized suffix match when no workspace root is known', () => {
    expect(diffPathsMatch('src/foo.ts', 'C:/repo/src/foo.ts', undefined)).toBe(true)
  })

  it('does not match a different file', () => {
    expect(diffPathsMatch('src/bar.ts', 'C:\\repo\\src\\foo.ts', 'C:\\repo')).toBe(false)
  })
})
