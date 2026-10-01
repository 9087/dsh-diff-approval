/**
 * The shell's own icons and controls, fetched by every name the shells have given them.
 *
 * 0.1.7 renamed the whole product icon set: `IconCloseOutline16` and `IconChevronDownOutline14` became
 * `IconCloseOutlineMedium` and `IconChevronDownOutlineMedium` (the `Medium`/`Regular` stroke pair,
 * where the numbers used to say the size). A static import of the old name survives compilation and
 * then hands React `undefined` to render, which is a crash of the whole mount — React #130, measured
 * here on 0.1.7-rc.2: `DiffApprovalHeaderEntry` took the panel down with it, and nothing in the plugin
 * worked until the shell was changed again.
 *
 * So each glyph is resolved in two steps, and neither step can throw:
 *
 * 1. the NEW name, looked up on the module namespace at run time — present on 0.1.7 and later, and
 *    absent (harmlessly) anywhere else;
 * 2. the legacy name, imported statically, which is what every shell before 0.1.7 exports.
 *
 * A glyph no shell offers renders nothing rather than failing. That is the point of this module: a
 * rename in the shell becomes a shell that draws fewer icons, not a plugin that dies. The plugin's
 * peer floor stays `0.1.0-rc.5`.
 *
 * The exports carry the names this plugin's code already uses (`IconCloseOutline16` and the rest), so
 * a caller changes only where it imports from.
 *
 * @module dsh-diff-approval/client/dsh-icons
 */

import {
  IconBrowseOutline16 as LegacyBrowse,
  IconChevronDownOutline14 as LegacyChevronDown,
  IconChevronRightOutline14 as LegacyChevronRight,
  IconChevronUpOutline14 as LegacyChevronUp,
  IconCloseOutline16 as LegacyClose,
  IconEllipsisOutline16 as LegacyEllipsis,
  IconFolderClose16 as LegacyFolderClose,
  IconFolderOpenOutline16 as LegacyFolderOpen,
  IconListPenOutline16 as LegacyListPen,
  IconPanelLeftOutline16 as LegacyPanelLeft,
  IconPlusOutline16 as LegacyPlus,
  IconRefreshOutline14 as LegacyRefresh14,
  IconRefreshOutline16 as LegacyRefresh,
  IconSearchOutline16 as LegacySearch,
  IconSettingsOutline16 as LegacySettings,
} from '@deepseek-ai/dsh-client-ui-primitives'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'

/** One glyph in the shell's set: exactly the type the package's own icons carry, so a caller's
 *  props (including a `className` that may be `undefined`) typecheck here as they did there. */
type ShellIcon = typeof LegacyListPen

/** What a glyph falls back to when the running shell offers none of its names: an empty slot. */
const NoGlyph = (() => null) as unknown as ShellIcon

/**
 * One glyph, preferring the name the newer shells use.
 * @param legacy - the export every shell before 0.1.7 carries.
 * @param newNames - the names 0.1.7 and later use, most preferred first.
 * @returns the glyph the running shell offers, or one that draws nothing.
 */
function shellIcon(legacy: ShellIcon | undefined, ...newNames: readonly string[]): ShellIcon {
  const set = primitives as unknown as Record<string, ShellIcon | undefined>
  for (const name of newNames) {
    const found = set[name]
    if (found !== undefined) return found
  }
  return legacy ?? NoGlyph
}

/** The pending-changes glyph: the sidebar's badge and the header entry carry it. */
export const IconListPenOutline16 = shellIcon(LegacyListPen, 'IconListPenOutlineMedium')
/** The list's fold chevrons. */
export const IconChevronDownOutline14 = shellIcon(LegacyChevronDown, 'IconChevronDownOutlineMedium')
export const IconChevronUpOutline14 = shellIcon(LegacyChevronUp, 'IconChevronUpOutlineMedium')
/** The path picker's tree disclosure. */
export const IconChevronRightOutline14 = shellIcon(LegacyChevronRight, 'IconChevronRightOutlineMedium')
/** Closing a card, a dialog or a search bar. */
export const IconCloseOutline16 = shellIcon(LegacyClose, 'IconCloseOutlineMedium')
/** The thread's own overflow menu. */
export const IconEllipsisOutline16 = shellIcon(LegacyEllipsis, 'IconEllipsisOutlineMedium')
/** The add-path dialog's browse button. */
export const IconBrowseOutline16 = shellIcon(LegacyBrowse, 'IconBrowseOutlineMedium')
/** A folder in the picker's tree, open and closed. */
export const IconFolderOpenOutline16 = shellIcon(LegacyFolderOpen, 'IconFolderOpenOutlineMedium')
export const IconFolderOpen16 = IconFolderOpenOutline16
export const IconFolderClose16 = shellIcon(LegacyFolderClose, 'IconFolderCloseMedium')
/** The presentation switch: dock the panel in the sidebar. */
export const IconPanelLeftOutline16 = shellIcon(LegacyPanelLeft, 'IconPanelLeftOutlineMedium')
/** The settings tab's refresh, which the older set spelled with the small size. */
export const IconRefreshOutline14 = shellIcon(LegacyRefresh14, 'IconRefreshOutlineMedium')
/** Adding a path, the diff refresh, the search box, and Settings. */
export const IconPlusOutline16 = shellIcon(LegacyPlus, 'IconPlusOutlineMedium')
export const IconRefreshOutline16 = shellIcon(LegacyRefresh, 'IconRefreshOutlineMedium')
export const IconSearchOutline16 = shellIcon(LegacySearch, 'IconSearchOutlineMedium')
export const IconSettingsOutline16 = shellIcon(LegacySettings, 'IconSettingsOutlineMedium')

/**
 * The package's own menus, toasts and clipboard helper.
 *
 * Re-exported so one module names everything this plugin takes from the shell's primitives: these
 * names have survived both releases, and a caller has no reason to reach past this file.
 */
export { Menu, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
export type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** The tooltip props this plugin uses, including the one the installed types do not know yet. */
export interface ShellTooltipProps {
  label: string
  side?: 'right' | 'bottom' | 'top' | undefined
  delayMs?: number | undefined
  maxWidth?: number | undefined
  disabled?: boolean | undefined
  /**
   * The keycaps the bubble renders AFTER its label, one `<kbd>` per entry, with a literal `'+'`
   * between the parts so the shell groups a combination into a single keycap. `undefined` (or an
   * empty array) renders no keycaps at all — which is what an unbound action passes.
   */
  shortcutKeys?: readonly string[] | undefined
  children: ReactElement
}

/**
 * The primitives' `Tooltip`, typed with the props above.
 *
 * `shortcutKeys` arrived in the primitives' 0.1.7-rc.2 — the release the host runs — while what this
 * repo COMPILES against is 0.1.0-rc.6, whose `Tooltip.d.ts` predates it. Passing the prop at a call
 * site is therefore a type error even though the running component accepts it (and an older one simply
 * ignores an unknown prop). The cast lives here, once, at the same boundary this module already uses
 * to bridge shell versions, rather than at every call site.
 */
export const Tooltip = primitives.Tooltip as unknown as (props: ShellTooltipProps) => ReactElement

/**
 * Whether the running shell can draw a shortcut beside a tooltip's label.
 *
 * `ShortcutKeys` and the `Tooltip.shortcutKeys` prop shipped together in the primitives'
 * **0.1.7-rc.2**: across all 24 installed versions this plugin is tested against, the component is
 * absent from every release up to and including 0.1.7-rc.1 (`lib/index.js` does not contain the name
 * at all, and `Tooltip.d.ts` takes no `shortcutKeys`) and present from 0.1.7-rc.2 on (`function
 * ShortcutKeys(...)`, exported, and `shortcutKeys?: readonly string[]` on `Tooltip`) — the same
 * release the prop arrived in, so the two can never disagree. An older host ignores an unknown prop
 * silently, which is why a caller must not rely on the prop alone (see `chords.ts`).
 */
export const SHELL_DRAWS_SHORTCUTS
  = typeof (primitives as unknown as { ShortcutKeys?: unknown }).ShortcutKeys === 'function'
