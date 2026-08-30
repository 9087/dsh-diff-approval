// Client settings: the diff tab-width preference.

import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_SUMMON, matchesShortcut, quickSummonKey, setQuickSummonKey, setTabWidth, tabWidth } from '../src/client/settings.ts'

const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const QUICK_SUMMON_KEY = 'diff-approval:quick-summon-key'

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

describe('settings.quickSummon', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to Ctrl+D', () => {
    expect(quickSummonKey()).toBe('Ctrl+D')
    expect(DEFAULT_QUICK_SUMMON).toBe('Ctrl+D')
  })

  it('persists a chosen chord and reads it back', () => {
    setQuickSummonKey('Ctrl+Shift+P')
    expect(localStorage.getItem(QUICK_SUMMON_KEY)).toBe('Ctrl+Shift+P')
    expect(quickSummonKey()).toBe('Ctrl+Shift+P')
  })
})

describe('matchesShortcut', () => {
  function event(partial: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: '',
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...partial,
    } as KeyboardEvent
  }

  it('matches the exact chord and case-insensitive key', () => {
    expect(matchesShortcut(event({ key: 'd', ctrlKey: true, altKey: true }), 'Ctrl+Alt+D')).toBe(true)
    expect(matchesShortcut(event({ key: 'D', ctrlKey: true, altKey: true }), 'ctrl+alt+d')).toBe(true)
  })

  it('requires the exact modifier set (extra modifiers do not match)', () => {
    expect(matchesShortcut(event({ key: 'd', ctrlKey: true }), 'Ctrl+Alt+D')).toBe(false)
    expect(matchesShortcut(event({ key: 'd', ctrlKey: true, altKey: true, shiftKey: true }), 'Ctrl+Alt+D')).toBe(false)
  })

  it('matches a modifier-alias and a bare-key chord', () => {
    expect(matchesShortcut(event({ key: 'p', metaKey: true }), 'Cmd+P')).toBe(true)
    expect(matchesShortcut(event({ key: 'F2' }), 'F2')).toBe(true)
  })
})
