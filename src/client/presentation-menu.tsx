/**
 * The mode switch: where the panel shows — floating over the app, or docked as a
 * tab in the app's right sidebar. (What the floating panel *covers* is the
 * coverage control's business; see the panel's own header.)
 *
 * One implementation, two hosts. The floating panel draws it in its own header
 * beside the gear. A *docked* panel draws no header at all — the tab is the
 * frame, its chip already carries the title and a close button — so the chip
 * (`sidebar.right.pane.tab.title`, which is this plugin's own component) hosts
 * the same control instead: the seat's convention is a glyph *before* the title
 * text, and the chip's tail is masked for the kit's own close button.
 *
 * @module dsh-diff-approval/client/presentation-menu
 */

import { useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { IconChevronDownOutline14, IconPanelLeftOutline16, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PendingPanel.module.css'
import type { DiffApprovalPresentation } from './settings.ts'
import type { Translator } from './locales.ts'

/**
 * The floating-overlay glyph: a window with another peeking out behind it. The
 * product's icon set has no "float" mark, so this one is drawn to the set's
 * conventions — a 16px grid, ~1.4px ink, `currentColor`.
 * @param props - the drawn size in px.
 * @returns the glyph.
 */
function FloatWindowIcon({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      {/* The window behind, showing only the corner the floating one leaves. */}
      <path d="M5.4 3.2H3.2A1.2 1.2 0 0 0 2 4.4v6.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* The floating window in front. */}
      <rect x="5.4" y="5.4" width="9.4" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/**
 * The mode switch's mark: the state it currently shows, and the same glyph each
 * menu row leads with. The dock mark is the icon the app's own right sidebar uses
 * (`IconPanelLeftOutline16`, mirrored — see ui-sidebar-right's ExpandButton), so
 * "dock" points at the same affordance the column does.
 * @param props - the state, and the drawn size in px.
 * @returns the glyph.
 */
export function PresentationIcon({ state, size }: { state: DiffApprovalPresentation; size: number }): ReactNode {
  if (state === 'dock') return <IconPanelLeftOutline16 size={size} className={css.mirrored} />
  return <FloatWindowIcon size={size} />
}

export interface PresentationMenuProps {  t: Translator
  /** Where the panel is now: the checked row, and the mark on the trigger. */
  current: DiffApprovalPresentation
  onChoose: (next: DiffApprovalPresentation) => void
  /** Rows pinned below a hairline, for a host with no other way to reach them
   *  (the chip carries this plugin's Settings; a docked panel has no gear). */
  footer?: readonly MenuEntry[]
  /** Called for a `footer` row's id, which is not a presentation. */
  onFooter?: (id: string) => void
  /** The chip's variant: no room for the chevron, and a box the chip's 28px
   *  height can hold. */
  compact?: boolean
}

/**
 * The trigger's wrapper. The header's control says what it is on hover; the
 * chip's carries no tooltip, because that bubble renders exactly where the menu
 * list goes (both hang under the button) and would take the row clicks.
 * @param props - the label to show, when there is one, and the trigger.
 * @returns the trigger, wrapped or bare.
 */
function Trigger({ title, children }: { title: string | undefined; children: ReactElement }): ReactElement {
  if (title === undefined) return children
  return <Tooltip label={title} side="bottom" delayMs={500}>{children}</Tooltip>
}

/**
 * Render the trigger and its menu. The trigger carries
 * `data-diff-approval-presentation` in both hosts, so a test addresses whichever
 * one the presentation it is testing actually draws.
 * @param props - copy, the current state, what a choice does, and the extras.
 * @returns the trigger element with its dropdown.
 */
/** Stop one event from leaving this control (see the boundary note below). */
function stopAll(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

export function PresentationMenu({ t, current, onChoose, footer, onFooter, compact = false }: PresentationMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const host = compact ? 'chip' : 'header'
  const state = t(current === 'dock' ? 'action.presentationDocked' : 'action.presentationFloat')
  const title = t('action.presentationCurrent', { state })
  const items = useMemo<MenuEntry[]>(() => [
    { id: 'float', label: t('action.presentationFloat'), icon: <PresentationIcon state="float" size={16} /> },
    { id: 'dock', label: t('action.presentationDock'), icon: <PresentationIcon state="dock" size={16} /> },
  ], [t])
  return (
    // The list is portaled to `document.body`, but React events do not follow the
    // DOM: they bubble up the *React* tree, so a press on a row still reaches the
    // component that rendered this control. In the docked tab's chip that is the
    // kit's `role="tab"`, whose `pointerdown` starts a tab drag and cancels the
    // press's click — which is why the menu opened but no row could be picked.
    // Only the chip needs that boundary: in the panel's own header there is
    // nothing above this control to protect it from, and swallowing the press
    // there kept other popovers (the coverage one) from hearing it and closing.
    <span
      className={css.presentationHost}
      {...(compact
        ? { onPointerDown: stopAll, onPointerUp: stopAll, onClick: stopAll, onContextMenu: stopAll, onMouseDown: stopAll }
        : {})}
    >
      <Menu
      open={open}
      portal
      compact
      align="end"
      items={items}
      {...(footer === undefined ? {} : { footer })}
      selectedId={current}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'float' || id === 'dock') onChoose(id)
        else onFooter?.(id)
      }}
      onClose={() => { setOpen(false) }}
      anchor={(
        // The chip carries no tooltip: its popup renders exactly where the menu
        // list goes (both hang under the button), and a bubble that lands on the
        // rows turns every choice into a click on the bubble. The chip's button
        // keeps its accessible name, and the menu itself names the states.
        <Trigger title={compact ? undefined : title}>
          <button
            type="button"
            className={compact ? css.chipPresentation : css.presentationSelect}
            data-diff-approval-presentation
            data-diff-approval-presentation-host={host}
            aria-label={title}
            aria-haspopup="menu"
            aria-expanded={open}
            // Inside the docked tab's chip the container is a draggable tab that
            // focuses itself on a press, so a press on this button is the
            // button's alone — exactly what the kit's own close button does.
            onPointerDown={(event) => { event.stopPropagation() }}
            onClick={(event) => {
              event.stopPropagation()
              setOpen(value => !value)
            }}
          >
            <PresentationIcon state={current} size={compact ? 12 : 14} />
            {/* The chip's box is the close button's, so its mark is smaller and
                the triangle rides beside it — the same "opens a menu" cue the
                header's wider control carries. */}
            <IconChevronDownOutline14 size={compact ? 10 : 12} />
          </button>
        </Trigger>
      )}
      />
    </span>
  )
}
