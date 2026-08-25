// Client settings: the diff tab-width preference.

import { beforeEach, describe, expect, it } from 'vitest'
import { setTabWidth, tabWidth } from '../src/client/settings.ts'

const TAB_WIDTH_KEY = 'diff-approval:tab-size'

describe('settings.tabWidth', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to 4', () => {
    expect(tabWidth()).toBe(4)
  })

  it('persists a chosen width and reads it back', () => {
    setTabWidth(8)
    expect(localStorage.getItem(TAB_WIDTH_KEY)).toBe('8')
    expect(tabWidth()).toBe(8)
  })

  it('falls back to 4 for a missing or invalid stored value', () => {
    localStorage.setItem(TAB_WIDTH_KEY, 'abc')
    expect(tabWidth()).toBe(4)
  })
})
