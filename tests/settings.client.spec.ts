// Client settings: the diff tab-width preference.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_SUMMON, DIFF_FONT_SCALE_MAX, DIFF_LINE_HEIGHT_DEFAULT, DIFF_LINE_HEIGHT_MAX, DIFF_LINE_HEIGHT_MIN,
  currentDiffAddColor, currentDiffDelColor,
  diffAddColor, diffDelColor, diffFontScale, diffLineHeight, matchesShortcut, mdPreviewEnabled, quickSummonKey,
  setDiffAddColor, setDiffDelColor, setDiffFontScale, setDiffLineHeight, setMdPreviewEnabled, setQuickSummonKey, setTabWidth, tabWidth,
} from '../src/client/settings.ts'

const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const QUICK_SUMMON_KEY = 'diff-approval:quick-summon-key'
const DIFF_FONT_SCALE_KEY = 'diff-approval:diff-font-scale'
const DIFF_LINE_HEIGHT_KEY = 'diff-approval:diff-line-height'
const DIFF_ADD_COLOR_KEY = 'diff-approval:diff-add-color'
const DIFF_DEL_COLOR_KEY = 'diff-approval:diff-del-color'
const MD_PREVIEW_KEY = 'diff-approval:md-preview'

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

describe('settings.mdPreview', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to off (source diff shown)', () => {
    expect(mdPreviewEnabled()).toBe(false)
  })

  it('persists a chosen default and reads it back', () => {
    setMdPreviewEnabled(true)
    expect(localStorage.getItem(MD_PREVIEW_KEY)).toBe('1')
    expect(mdPreviewEnabled()).toBe(true)
  })
})

describe('settings.diffFontScale', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to 100% (current size)', () => {
    expect(diffFontScale()).toBe(100)
  })

  it('persists a chosen scale and reads it back', () => {
    setDiffFontScale(110)
    expect(localStorage.getItem(DIFF_FONT_SCALE_KEY)).toBe('110')
    expect(diffFontScale()).toBe(110)
  })

  it('clamps to the allowed range', () => {
    setDiffFontScale(DIFF_FONT_SCALE_MAX + 10)
    expect(diffFontScale()).toBe(DIFF_FONT_SCALE_MAX)
  })
})

describe('settings.diffLineHeight', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to the current row height (22)', () => {
    expect(diffLineHeight()).toBe(DIFF_LINE_HEIGHT_DEFAULT)
    expect(DIFF_LINE_HEIGHT_DEFAULT).toBe(22)
  })

  it('persists a chosen height and reads it back', () => {
    setDiffLineHeight(28)
    expect(localStorage.getItem(DIFF_LINE_HEIGHT_KEY)).toBe('28')
    expect(diffLineHeight()).toBe(28)
  })

  it('clamps to the allowed range', () => {
    setDiffLineHeight(DIFF_LINE_HEIGHT_MAX + 10)
    expect(diffLineHeight()).toBe(DIFF_LINE_HEIGHT_MAX)
    setDiffLineHeight(DIFF_LINE_HEIGHT_MIN - 10)
    expect(diffLineHeight()).toBe(DIFF_LINE_HEIGHT_MIN)
  })
})

describe('settings.diffColors', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to undefined (theme colors) when unset', () => {
    expect(diffAddColor()).toBeUndefined()
    expect(diffDelColor()).toBeUndefined()
  })

  it('persists a chosen base color and reads it back', () => {
    setDiffAddColor('#00ff00')
    setDiffDelColor('#ff0000')
    expect(localStorage.getItem(DIFF_ADD_COLOR_KEY)).toBe('#00ff00')
    expect(localStorage.getItem(DIFF_DEL_COLOR_KEY)).toBe('#ff0000')
    expect(diffAddColor()).toBe('#00ff00')
    expect(diffDelColor()).toBe('#ff0000')
  })
})

describe('settings.current color defaults', () => {
  beforeEach(() => localStorage.clear())

  it('falls back to sane colors when the theme token is unavailable', () => {
    expect(currentDiffAddColor()).toMatch(/^#[0-9a-f]{6}$/i)
    expect(currentDiffDelColor()).toMatch(/^#[0-9a-f]{6}$/i)
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
