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

import { keybindingOf } from './settings.ts'

/** Arrow keys render as arrows in a hint (`Ctrl+↑`, not `Ctrl+ArrowUp`). */
const CHORD_KEY_GLYPHS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/**
 * One stored chord as a hint renders it: modifiers as written, arrow keys as
 * glyphs (`Ctrl+ArrowUp` → `Ctrl+↑`).
 * @param chord - the stored chord.
 * @returns the hint text; `''` for an unbound action.
 */
export function chordHint(chord: string): string {
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
