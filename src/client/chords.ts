/**
 * How a keybinding is spelled in a tooltip.
 *
 * Every hint reads the binding at render time rather than baking in a default, so
 * a rebind in Settings shows up everywhere the chord is advertised. That is also
 * why the strings live here: the panel's header, its diff toolbars, and the
 * coverage popover all advertise chords, and they must spell them the same way.
 *
 * @module dsh-diff-approval/client/chords
 */

import { SHELL_DRAWS_SHORTCUTS } from './dsh-icons.ts'
import type { Translator } from './locales.ts'
import { keybindingOf, quickSummonKey } from './settings.ts'

/** Arrow keys render as arrows in a hint (`Ctrl+↑`, not `Ctrl+ArrowUp`). */
const CHORD_KEY_GLYPHS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/**
 * One stored chord as a hint renders it: modifiers as written, arrow keys as
 * glyphs (`Ctrl+ArrowUp` → `Ctrl+↑`).
 * @param chord - the stored chord.
 * @returns the hint text; `''` for an unbound action.
 */
function chordHint(chord: string): string {
  return chord.split('+').map(part => CHORD_KEY_GLYPHS[part] ?? part).join('+')
}

/**
 * One action's chord as a hint.
 * @param action - the keybinding action id (see `DEFAULT_KEYBINDINGS`).
 * @returns the hint text; `''` when the action has no chord.
 */
export function chordLabel(action: string): string {
  return chordHint(keybindingOf(action))
}

/**
 * A tooltip label with the action's configured chord appended. The hint states
 * the binding the user actually has — including one rebound in Settings, or none
 * at all, which simply adds nothing.
 * @param label - the translated action label.
 * @param action - the keybinding action id (see `DEFAULT_KEYBINDINGS`).
 * @returns the label, with ` (chord)` appended when one is configured.
 */
export function withChord(label: string, action: string): string {
  const chord = chordLabel(action)
  return chord === '' ? label : `${label} (${chord})`
}

/** The ARIA spelling of a chord's parts: `aria-keyshortcuts` wants DOM key names, not our glyphs. */
const ARIA_KEY_NAMES: Record<string, string> = {
  Ctrl: 'Control',
  Cmd: 'Meta',
  Meta: 'Meta',
  Esc: 'Escape',
}

/** One chord in both the forms a tooltip needs, read from a single setting so the two cannot drift. */
export interface ChordShortcut {
  /**
   * The keycaps, in order, with a literal `'+'` between the parts: the shell renders one `<kbd>` per
   * entry and groups a combination into a single keycap when the array carries a separator (see the
   * primitives' `ShortcutKeys`).
   */
  keys: string[]
  /** The `aria-keyshortcuts` value: the same chord spelled in DOM key names. */
  aria: string
}

/**
 * One stored chord as the two forms above; `undefined` for an unbound action.
 * @param chord - the stored chord.
 * @returns the keycaps and the aria form, or `undefined` when there is no chord.
 */
function shortcutOfChord(chord: string): ChordShortcut | undefined {
  if (chord === '') return undefined
  const parts = chord.split('+')
  const keys: string[] = []
  parts.forEach((part, index) => {
    if (index > 0) keys.push('+')
    keys.push(CHORD_KEY_GLYPHS[part] ?? part)
  })
  return { keys, aria: parts.map(part => ARIA_KEY_NAMES[part] ?? part).join('+') }
}

/**
 * One action's shortcut, as a tooltip's `shortcutKeys` and the anchor's `aria-keyshortcuts`.
 * @param action - the keybinding action id (see `DEFAULT_KEYBINDINGS`).
 * @returns the two forms, or `undefined` when the action is unbound.
 */
export function shortcutOf(action: string): ChordShortcut | undefined {
  return shortcutOfChord(keybindingOf(action))
}

/**
 * The quick-summon chord: its own setting rather than one of `DEFAULT_KEYBINDINGS`, since it is the
 * one chord the panel is opened BY rather than one it answers inside.
 * @returns the two forms, or `undefined` when the chord is unbound.
 */
export function summonShortcut(): ChordShortcut | undefined {
  return shortcutOfChord(quickSummonKey())
}

/**
 * Escape alone: the key the INNERMOST dismissible answers to (the search bar, a dialog), which no
 * panel chord stands behind — the quick-summon chord closes the panel, not the bar inside it.
 * @returns the keycaps and the aria form.
 */
export function escapeShortcut(): ChordShortcut {
  return { keys: ['Esc'], aria: 'Escape' }
}

/**
 * The panel's close button: Escape always, plus the quick-summon chord while one is bound.
 *
 * This is the one place the shell's one-chord model needs a judgment: these are two WAYS out, not a
 * sequence, so they stay two keycaps (`['Esc', 'Ctrl+D']`) and two space-separated aria shortcuts —
 * grouping them into one cap with separators would read as "press Esc, then Ctrl+D".
 * @returns the keycaps and the aria form.
 */
export function closeShortcut(): ChordShortcut {
  const summon = summonShortcut()
  return summon === undefined
    ? { keys: ['Esc'], aria: 'Escape' }
    : { keys: ['Esc', summon.keys.join('')], aria: `Escape ${summon.aria}` }
}

/** What one tooltip site hands the shell, decided here so that no call site ever branches. */
export interface TooltipChord {
  /**
   * The label for the shell's `Tooltip`: the action's own name where the shell draws keycaps, and the
   * label this plugin spelled before the primitives' 0.1.7-rc.2 — chord glued in — where it cannot.
   */
  label: string
  /** The keycaps to pass, or `undefined` when there is no chord or this host cannot draw one. */
  shortcutKeys: readonly string[] | undefined
  /** The anchor's `aria-keyshortcuts`: plain text, and the same on every host. */
  aria: string | undefined
}

/**
 * The one decision of this module: the shell's keycaps where it can draw them, the glued label where
 * it cannot. A host older than the primitives' 0.1.7-rc.2 would otherwise drop the shortcut entirely
 * (an unknown prop is ignored), so the label keeps advertising it exactly as it did before.
 * @param label - the action's plain label.
 * @param glued - the same label as this plugin spelled it before that release, chord included.
 * @param shortcut - the chord, or `undefined` when the control has none.
 * @returns the label, the shortcut prop and the aria value, all from one read of the setting.
 */
function tooltipChord(label: string, glued: string, shortcut: ChordShortcut | undefined): TooltipChord {
  if (shortcut === undefined) return { label, shortcutKeys: undefined, aria: undefined }
  return SHELL_DRAWS_SHORTCUTS
    ? { label, shortcutKeys: shortcut.keys, aria: shortcut.aria }
    : { label: glued, shortcutKeys: undefined, aria: shortcut.aria }
}

/**
 * A tooltip for one action's chord.
 * @param label - the translated action label.
 * @param action - the keybinding action id, or `undefined` for a control that has no chord at all.
 * @returns the label, keycaps and aria; an unbound or absent action keeps the plain label.
 */
export function actionTooltip(label: string, action: string | undefined): TooltipChord {
  if (action === undefined) return { label, shortcutKeys: undefined, aria: undefined }
  return tooltipChord(label, withChord(label, action), shortcutOf(action))
}

/**
 * The entry buttons that open the panel (the session header's, the footer badge): what it holds, and
 * the chord that does the same. With the chord unbound the plain label is the whole hint.
 * @param t - the panel's translator.
 * @returns the label, keycaps and aria.
 */
export function summonTooltip(t: Translator): TooltipChord {
  const chord = chordHint(quickSummonKey())
  return tooltipChord(
    t('panel.aria'),
    chord === '' ? t('panel.aria') : t('action.summonHint', { chord }),
    summonShortcut(),
  )
}

/**
 * The panel's close button: Escape, plus the quick-summon chord while one is bound.
 * @param t - the panel's translator.
 * @returns the label, keycaps and aria.
 */
export function closeTooltip(t: Translator): TooltipChord {
  const chord = chordHint(quickSummonKey())
  return tooltipChord(
    t('action.close'),
    chord === '' ? t('action.closeHintEsc') : t('action.closeHint', { chord }),
    closeShortcut(),
  )
}

/**
 * A control only Escape dismisses — the search bar — which no panel chord stands behind.
 * @param t - the panel's translator.
 * @returns the label, keycaps and aria.
 */
export function escapeTooltip(t: Translator): TooltipChord {
  return tooltipChord(t('action.close'), t('action.closeHintEsc'), escapeShortcut())
}
