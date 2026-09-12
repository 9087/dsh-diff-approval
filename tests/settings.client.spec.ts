// Client settings: the diff tab-width preference.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_QUICK_SUMMON, DIFF_FONT_SCALE_MAX, DIFF_LINE_HEIGHT_DEFAULT, DIFF_LINE_HEIGHT_MAX, DIFF_LINE_HEIGHT_MIN,
  MD_MAX_WIDTH_DEFAULT, MD_MAX_WIDTH_MAX, MD_MAX_WIDTH_MIN,
  currentDiffAddColor, currentDiffDelColor,
  diffAddColor, diffDelColor, diffFontScale, diffLineHeight, fileListFloat, languageForSuffix, matchesShortcut, mdMaxWidth, mdPreviewEnabled, quickSummonKey,
  panelCover, panelPresentation,
  setDiffAddColor, setDiffDelColor, setDiffFontScale, setDiffLineHeight, setFileListFloat, setLanguageForSuffix, setMdMaxWidth, setMdPreviewEnabled, setQuickSummonKey, setTabWidth, tabWidth,
  setPanelCover, setPanelPresentation,
} from '../src/client/settings.ts'
import { en, zh } from '../src/client/locales.ts'

const TAB_WIDTH_KEY = 'diff-approval:tab-size'
const QUICK_SUMMON_KEY = 'diff-approval:quick-summon-key'
const DIFF_FONT_SCALE_KEY = 'diff-approval:diff-font-scale'
const DIFF_LINE_HEIGHT_KEY = 'diff-approval:diff-line-height'
const DIFF_ADD_COLOR_KEY = 'diff-approval:diff-add-color'
const DIFF_DEL_COLOR_KEY = 'diff-approval:diff-del-color'
const MD_PREVIEW_KEY = 'diff-approval:md-preview'
const MD_MAX_WIDTH_KEY = 'diff-approval:md-max-width'
const LANG_BY_SUFFIX_KEY = 'diff-approval:lang-by-suffix'

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

describe('settings.mdMaxWidth', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to 800px (single column)', () => {
    expect(mdMaxWidth()).toBe(MD_MAX_WIDTH_DEFAULT)
    expect(MD_MAX_WIDTH_DEFAULT).toBe(800)
  })

  it('persists a chosen width and reads it back', () => {
    setMdMaxWidth(1200)
    expect(localStorage.getItem(MD_MAX_WIDTH_KEY)).toBe('1200')
    expect(mdMaxWidth()).toBe(1200)
  })

  it('clamps to the allowed range', () => {
    setMdMaxWidth(MD_MAX_WIDTH_MAX + 100)
    expect(mdMaxWidth()).toBe(MD_MAX_WIDTH_MAX)
    setMdMaxWidth(MD_MAX_WIDTH_MIN - 100)
    expect(mdMaxWidth()).toBe(MD_MAX_WIDTH_MIN)
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

describe('settings.languageBySuffix', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to auto for every suffix', () => {
    expect(languageForSuffix('md')).toBeUndefined()
    expect(localStorage.getItem(LANG_BY_SUFFIX_KEY)).toBeNull()
  })

  it('remembers one suffix without touching the others', () => {
    setLanguageForSuffix('md', 'typescript')
    setLanguageForSuffix('ts', 'python')
    expect(languageForSuffix('md')).toBe('typescript')
    expect(languageForSuffix('ts')).toBe('python')
    expect(languageForSuffix('txt')).toBeUndefined()
    expect(localStorage.getItem(LANG_BY_SUFFIX_KEY)).toBe('{"md":"typescript","ts":"python"}')
  })

  it('forgets a suffix when the choice goes back to auto', () => {
    setLanguageForSuffix('md', 'typescript')
    setLanguageForSuffix('md', null)
    expect(languageForSuffix('md')).toBeUndefined()
    expect(localStorage.getItem(LANG_BY_SUFFIX_KEY)).toBe('{}')
  })

  it('ignores a hand-edited or truncated stored value', () => {
    localStorage.setItem(LANG_BY_SUFFIX_KEY, '{"md":')
    expect(languageForSuffix('md')).toBeUndefined()
    localStorage.setItem(LANG_BY_SUFFIX_KEY, '{"md":42,"ts":"","rb":"ruby"}')
    expect(languageForSuffix('md')).toBeUndefined()
    expect(languageForSuffix('ts')).toBeUndefined()
    expect(languageForSuffix('rb')).toBe('ruby')
  })
})

describe('matchesShortcut', () => {
  it('binds the coverage edges to the Ctrl+Shift arrows by default', () => {
    // Each default is a distinct edge chord, and none of them collides with an
    // existing action's default.
    expect(DEFAULT_KEYBINDINGS.coverLeft).toBe('Ctrl+Shift+ArrowLeft')
    expect(DEFAULT_KEYBINDINGS.coverComposer).toBe('Ctrl+Shift+ArrowDown')
    expect(DEFAULT_KEYBINDINGS.coverRight).toBe('Ctrl+Shift+ArrowRight')
    expect(DEFAULT_KEYBINDINGS.coverTop).toBe('Ctrl+Shift+ArrowUp')
    const chords = Object.values(DEFAULT_KEYBINDINGS)
    expect(new Set(chords).size).toBe(chords.length)
  })

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

describe('settings.fileListFloat', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to off, where the width decides', () => {
    expect(fileListFloat()).toBe(false)
    setFileListFloat(true)
    expect(fileListFloat()).toBe(true)
    setFileListFloat(false)
    expect(fileListFloat()).toBe(false)
  })
})

describe('locale copy', () => {
  it('never bakes a rebindable chord into a string', () => {
    // Every chord a user can rebind is injected at render time (see withChord /
    // closeHint / summonHint), so a literal one in the copy would go stale the
    // moment it is rebound. Escape is the one key that is not rebindable.
    const rebindable = /Ctrl\+|Cmd\+|Alt\+|Shift\+|⌘|\bF\d\b/
    for (const [language, strings] of [['zh', zh], ['en', en]] as const) {
      for (const [key, value] of Object.entries(strings)) {
        if (key === 'action.closeHint' || key === 'action.closeHintEsc') {
          if (key === 'action.closeHint') expect(value).toContain('{chord}')
          continue
        }
        expect(value, `${language} ${key}`).not.toMatch(rebindable)
      }
    }
  })
})

describe('settings.panelPresentation', () => {
  beforeEach(() => localStorage.clear())

  it('remembers where the panel shows, defaulting to the floating overlay', () => {
    expect(panelPresentation()).toBe('float')
    setPanelPresentation('dock')
    expect(panelPresentation()).toBe('dock')
    setPanelPresentation('float')
    expect(panelPresentation()).toBe('float')
  })

  it('falls back to the floating overlay for a value it does not know', () => {
    localStorage.setItem('diff-approval:presentation', 'nonsense')
    expect(panelPresentation()).toBe('float')
  })

  it('reads the retired fullscreen state as floating, covering everything', () => {
    // Before coverage split it into switches, "fullscreen" was the panel filling
    // the window. Both readings must restore the same panel.
    localStorage.setItem('diff-approval:presentation', 'fullscreen')
    expect(panelPresentation()).toBe('float')
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: true })
  })
})

describe('settings.panelCover', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to the header and both sidebars, leaving the composer usable', () => {
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: false })
  })

  it('remembers each switch independently', () => {
    setPanelCover({ top: false, left: false, right: true, composer: true })
    expect(panelCover()).toEqual({ top: false, left: false, right: true, composer: true })
    setPanelCover({ top: true, left: true, right: false, composer: false })
    expect(panelCover()).toEqual({ top: true, left: true, right: false, composer: false })
  })

  it('fills in a missing or malformed switch from the default, never throwing', () => {
    // A cover stored before the header switch existed keeps the header covered.
    localStorage.setItem('diff-approval:float-cover', JSON.stringify({ composer: true }))
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: true })
    localStorage.setItem('diff-approval:float-cover', '{"left":"yes"}')
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: false })
    localStorage.setItem('diff-approval:float-cover', 'not json')
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: false })
    localStorage.setItem('diff-approval:float-cover', '[1,2]')
    expect(panelCover()).toEqual({ top: true, left: true, right: true, composer: false })
  })

  it('lets an explicit cover win over the retired fullscreen state', () => {
    localStorage.setItem('diff-approval:presentation', 'fullscreen')
    setPanelCover({ top: false, left: false, right: false, composer: false })
    expect(panelCover()).toEqual({ top: false, left: false, right: false, composer: false })
  })
})
