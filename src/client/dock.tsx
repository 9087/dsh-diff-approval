/**
 * The app's right sidebar (the docking surface) as a host for the review panel.
 *
 * The sidebar is an extensible tab system: a tab type registers its static face
 * with the `sidebarRightTabs` service, its body in the keyed `sidebar.right.pane.tab`
 * seat under the same `id`, and is opened by `kind` through `sidebarRight`. The
 * harness documents this as the path a *package outside the product* takes (its
 * own document preview ships that way), so nothing here imports the sidebar's
 * package as a runtime value: the shapes below are the structural minimum, which
 * is exactly what lets this plugin keep loading on releases that have no right
 * sidebar at all — the type is simply never registered there.
 *
 * @module dsh-diff-approval/client/dock
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PendingPanel.module.css'
import { PanelBoundary } from './boundary.tsx'
import { PendingPanel } from './PendingPanel.tsx'
import type { PendingPanelProps } from './PendingPanel.tsx'
import { PresentationMenu } from './presentation-menu.tsx'
import { setPanelPresentation } from './settings.ts'
import type { DiffApprovalPresentation } from './settings.ts'
import type { PendingDiffSnapshot } from './slots.ts'

/** The tab type's `kind`: what `openTab` names. */
export const DIFF_DOCK_KIND = 'diff-approval'
/** The registration's `id`: the key its body and title register under. The
 *  registry wants a name unique across implementations, and the package name is
 *  the natural value. */
export const DIFF_DOCK_ID = 'dsh-diff-approval'

/** Window event a docked panel dispatches to move the panel back to the overlay.
 *  The docked tab and the footer entry are separate mounts, so the ask travels as
 *  an event — the same bridge the produced-file buttons use. */
export const SHOW_PANEL_EVENT = 'diff-approval:show-panel'

// The panel's cross-mount channel: the floating panel, the docked tab, and the
// Session header's entry are separate mounts in different slot trees, so there is
// no common owner to lift the panel's open state into — instructions and state
// travel as window events, the same bridge SHOW_PANEL_EVENT above, the settings
// section, and the produced-file buttons all use.
/** Ask the panel to toggle: what the header entry's button does. It runs the same
 *  action as the footer badge, so the two entries can never disagree about what a
 *  press means — including for a docked panel, whose tab the chip still closes. */
export const TOGGLE_PANEL_EVENT = 'diff-approval:toggle-panel'
/** The floating panel's own visibility, published on every change so a second
 *  entry can light up while the panel is open (`detail.open`). */
export const PANEL_STATE_EVENT = 'diff-approval:panel-state'
/** Name a file for the panel to show, from a mount that is not the panel itself
 *  (the produced-file chip): every mounted panel instance switches to it and lands
 *  on its first change — the ask is "show me this diff", not "put me back where I
 *  was". The file is also recorded as the last one, so an instance that only
 *  appears afterwards (the docked tab) opens the same file the same way. */
export const OPEN_PANEL_FILE_EVENT = 'diff-approval:panel-file'

/** Payload of {@link OPEN_PANEL_FILE_EVENT}. */
export interface PanelFileDetail {
  /** The pending entry to show. */
  fileId: string
}

/** Payload of {@link PANEL_STATE_EVENT}. */
export interface PanelStateDetail {
  /** Whether the floating panel is showing right now. */
  open: boolean
}

/** What the footer entry needs to know about the dock. */
export interface DockSnapshot {
  /** Whether this build has a right sidebar to dock into at all. */
  readonly available: boolean
  /** Whether our tab is currently showing: reported by the docked tab body
   *  itself, because the sidebar's controller exposes no observable. */
  readonly open: boolean
  /** Why it is unavailable, when it is: the lookup result, for the user to report. */
  readonly reason: string | undefined
}

/** The dock's face to the panel: an observable for the entry, the reveal the
 *  entry calls, the close the chip publishes, and the visibility the docked body
 *  reports. All exist from apply time — see {@link createDockState}. */
export interface DockFace {
  readonly hooks: { readonly dock: HostObservable<DockSnapshot> }
  /** Expand the sidebar and focus our tab, opening it when it is missing; a
   *  no-op while no sidebar is attached. Throws when the sidebar is mounted but
   *  cannot act (no seat bound yet), which the panel reports. */
  readonly open: () => void
  /** The docked tab body's own visibility, so the footer entry can light up. */
  readonly setShowing: (showing: boolean) => void
  /** The chip's own close, so a chord can close the docked tab from anywhere —
   *  the tab is the only thing that knows how to close itself, and it is not
   *  mounted where the footer entry lives. `undefined` once the tab is gone. */
  readonly setClose: (close: (() => void) | undefined) => void
  /** Close our docked tab, when one exists. */
  readonly close: () => void
}

/** The dock's live state, independent of when the sidebar's services attach. */
export interface DockState {
  readonly face: DockFace
  /** Swap the live sidebar in (undefined when its services go away), with the
   *  reason to report while there is none; returns the detach function. */
  attach(sidebar: unknown, reason?: string): () => void
}

/** Structural view of the sidebar's navigation face (see the module note). The
 *  controller's real surface is these methods and nothing else: it has no
 *  observable, which is why "is our tab showing" is reported by the tab body. */
interface SidebarRightFace {
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void
}

/** Structural view of the tab-type registry (see the module note). */
export interface TabRegistryFace {
  register(definition: {
    id: string
    kind: string
    title: (address: string) => string
    guide?: readonly { order: number; title: () => string; description?: () => string }[]
  }): () => void
}

/** The tab seat's own tab hook, injected by the sidebar framework: the record
 *  being drawn (with the seat's verdict on whether it is on screen) and the
 *  actions that act on it. */
type TabInfoHook = () => {
  readonly tab: {
    readonly actions: { close(): void }
    /** Whether this record is actually on screen (expanded column, active tab). */
    readonly visible: boolean
  }
}

export interface DiffDockBodyProps extends PropsLocale<'diff-approval'> {
  /** The seat's own tab hook (the sidebar framework injects it). */
  readonly useTabInfo?: TabInfoHook
  /** This plugin's pending store hook, for the chip's count. */
  readonly usePending?: (select: (snapshot: PendingDiffSnapshot) => unknown) => unknown
  /** Whether the panel renders as the docked body (set by the tab seat's face). */
  readonly docked?: boolean
  /** Report this body's visibility to the dock state (see {@link DockFace}). */
  readonly onDockShowing?: ((showing: boolean) => void) | undefined
  /** Publish this tab's own close, so a chord can close the docked panel. */
  readonly onDockClose?: ((close: (() => void) | undefined) => void) | undefined
  [key: string]: unknown
}

/** One live dock adapter: the face, and the teardown that unsubscribes. */
export interface DiffDock {
  readonly face: DockFace
  dispose(): void
}

/** The cordis pieces this adapter uses, structurally: optional service lookup and
 *  a scoped effect. Both are what the plugin sandbox always forwards — its
 *  whitelist covers `effect`/`on`/timers but NOT cordis's dynamic `inject`, and it
 *  gates *direct* service access on the plugin's declared inject list (which must
 *  not name the sidebar: the panel has to keep working where there is none). `get`
 *  is the one lookup it never gates, so discovery goes through it. */
export interface DockHostContext {
  get(name: string): unknown
  effect(callback: () => unknown, label: string): void
}

/** How often the optional sidebar services are looked up, and for how long. The
 *  sidebar's plugin may attach after this one; ~15s of patience covers a slow
 *  boot, and finding them stops the timer. */
const DOCK_LOOKUP_INTERVAL_MS = 150
const DOCK_LOOKUP_ATTEMPTS = 100

/** A service this plugin already depends on, probed through the same lookup the
 *  sidebar is found with. If it reads "ok" while the sidebar's do not, the lookup
 *  itself works and the sidebar's services are simply not reachable from this
 *  plugin's context — a different bug from "not loaded yet". */
const PROBE_SERVICES = ['slots'] as const

/** How one lookup result reads in the diagnostic string. Never throws: a probe
 *  that fails says so instead of taking the whole dock wiring down with it. */
function shape(ctx: DockHostContext, name: string): string {
  try {
    const value = ctx.get(name)
    if (value === undefined) return 'missing'
    return typeof value === 'object' || typeof value === 'function' ? 'ok' : typeof value
  } catch (error) {
    return `threw(${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * What the lookup can see, for the "why is there no dock" message: the sidebar's
 * two services first (the decisive fact), then the services this plugin already
 * uses, then whether the tab seat exists at all — a seat without services means
 * the sidebar's plugin is loaded but its services are not reachable from here.
 * @param ctx - the client context (structurally, see {@link DockHostContext}).
 * @returns a one-line description, safe to show and to report.
 */
function diagnose(ctx: DockHostContext): string {
  const probed = PROBE_SERVICES.map(name => `${name}=${shape(ctx, name)}`).join(' ')
  let seat = 'unknown'
  try {
    const slots = ctx.get('slots') as { spec?(name: string): unknown } | undefined
    seat = slots?.spec?.('sidebar.right.pane.tab') === undefined ? 'missing' : 'ok'
  } catch (error) {
    seat = `probe threw: ${error instanceof Error ? error.message : String(error)}`
  }
  return `sidebarRight=${shape(ctx, 'sidebarRight')} sidebarRightTabs=${shape(ctx, 'sidebarRightTabs')}, ${probed}, seat(sidebar.right.pane.tab)=${seat}`
}

/** Where the guide page lists the panel, relative to the product's own entries. */
const DIFF_DOCK_GUIDE_ORDER = 40

/**
 * The dock's live state, created at apply time rather than when the sidebar's
 * services appear. The footer entry is seated once, so a face captured before the
 * sidebar attaches would freeze on "no dock" and the panel would never offer the
 * switch — the state below is therefore always present, and `attach` swaps the
 * live sidebar underneath it while `open` resolves the current one per call.
 * @returns the state; `attach` reports availability and the tab's own visibility.
 */
export function createDockState(): DockState {
  let sidebar: SidebarRightFace | undefined
  let reason: string | undefined
  /** Reported by the docked tab body: see {@link DockFace.setShowing}. */
  let showing = false
  /** Published by the docked tab's chip: see {@link DockFace.setClose}. */
  let closeTab: (() => void) | undefined
  let snapshot: DockSnapshot = { available: false, open: false, reason: undefined }
  const listeners = new Set<() => void>()
  const read = (): DockSnapshot => sidebar === undefined
    ? { available: false, open: false, reason }
    : { available: true, open: showing, reason: undefined }
  const publish = (): void => {
    const next = read()
    if (next.available === snapshot.available && next.open === snapshot.open && next.reason === snapshot.reason) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return {
    face: {
      hooks: {
        dock: {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      },
      open: () => { sidebar?.openTab(DIFF_DOCK_KIND, { revealIfOpened: true }) },
      setShowing: (next) => {
        if (showing === next) return
        showing = next
        publish()
      },
      setClose: (close) => { closeTab = close },
      close: () => { closeTab?.() },
    },
    attach(next, why) {
      reason = why
      sidebar = next as SidebarRightFace | undefined
      if (sidebar === undefined) showing = false
      publish()
      return () => {
        sidebar = undefined
        showing = false
        publish()
      }
    },
  }
}

/**
 * The tab body: the review panel, docked. The panel's content is one portaled
 * block, so instead of restructuring it this hands it a host element of the
 * sidebar's own making to portal into — the tab body owns the element it fills.
 * @param props - the seat's runtime props, this plugin's face, and `useTabInfo`.
 * @returns the host element and, once it exists, the docked panel inside it.
 */
/** Keeps a failure inside the tab from taking the app's tree down with it, and
 *  from leaving the pane blank: {@link PanelBoundary} says what happened and can
 *  re-render the panel without a reload. */

export function DiffDockBody(props: DiffDockBodyProps): ReactNode {
  const { t, useTabInfo, onDockShowing, ...panelProps } = props
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const tab = useTabInfo?.()
  // The tab framework's own verdict on whether this body is on screen (expanded
  // column, active tab) — the sidebar's controller exposes no observable, so the
  // body is what tells the footer entry the panel is docked and in view.
  const visible = tab?.tab.visible === true
  useEffect(() => {
    onDockShowing?.(visible)
    return () => { onDockShowing?.(false) }
  }, [visible, onDockShowing])
  return (
    <>
      <div ref={setHost} className={css.dockHost} data-diff-approval-dock />
      {host !== null && (
        <PanelBoundary t={t}>
          <PendingPanel
            {...(panelProps as unknown as PendingPanelProps)}
            t={t}
            docked
            dockHost={host}
          />
        </PanelBoundary>
      )}
    </>
  )
}

/**
 * The tab chip: the mode switch, then the panel's title with the pending count —
 * read live from the store so the chip tracks the list without re-registering the
 * tab. The glyph leads because that is this seat's convention (the document tab
 * puts its file-type icon there), and because the chip's tail is masked for the
 * kit's own close button.
 *
 * A docked panel draws no header of its own, so this chip is where the panel is
 * named *and* where it is told to leave: the mode switch offers the two overlay
 * states, and its menu footer keeps this plugin's Settings one click away, which
 * the docked panel has no gear for.
 * @param props - the same face the body gets; the count and the switch are drawn.
 * @returns the chip content.
 */
export function DiffDockTitle(props: DiffDockBodyProps): ReactNode {
  const { t, usePending, useTabInfo, onDockClose } = props
  // A chip that cannot read the list must still render a title: the tab is the
  // only way back to a docked panel.
  let count = 0
  try {
    count = (usePending?.((snapshot: PendingDiffSnapshot) => snapshot.files.length) as number | undefined) ?? 0
  } catch {
    count = 0
  }
  const tab = useTabInfo?.()
  // The latest tab actions, read at close time: the hook's own object is fresh on
  // every render, and the registration below must not churn with it.
  const tabRef = useRef(tab)
  tabRef.current = tab
  // Publish this tab's close to the dock state for as long as the tab exists, so
  // a chord pressed anywhere (the footer entry's listener) can close the docked
  // panel — the tab is the only thing that knows how to close itself.
  useEffect(() => {
    onDockClose?.(() => { tabRef.current?.tab.actions.close() })
    return () => { onDockClose?.(undefined) }
  }, [onDockClose])
  /** Leave the dock for an overlay: remember it, close this tab, and let the
   *  footer entry (a separate mount) show the panel in the overlay. */
  const leaveDock = (next: DiffApprovalPresentation): void => {
    if (next === 'dock') return
    setPanelPresentation(next)
    tabRef.current?.tab.actions.close()
    window.dispatchEvent(new CustomEvent(SHOW_PANEL_EVENT))
  }
  return (
    <span className={css.chip} data-diff-approval-chip>
      <span className={css.chipLabel}>{count > 0 ? `${t('panel.title')} · ${count}` : t('panel.title')}</span>
      <PresentationMenu t={t} current="dock" onChoose={leaveDock} compact />
    </span>
  )
}

/**
 * Find the sidebar's services and, once they are there, attach the panel to them:
 * register the tab type (with a guide entry, so the panel is discoverable from the
 * sidebar's own guide page) and hand the live sidebar to `attach`. Where they are
 * never provided — an older app, or a composition without the right sidebar —
 * nothing is registered and nothing attaches, which is what makes the whole
 * feature optional rather than required.
 *
 * Discovery is a timed optional lookup rather than cordis's dynamic `inject`,
 * because the plugin sandbox forwards `effect`/`on`/timers but not `inject`, and
 * the sidebar may attach after this plugin does. Timers are the window's own (the
 * sandbox's ctx timer verbs want a `timer` declaration, and a host that withholds
 * the verb must not take the panel down with it).
 * @param ctx - the client context (structurally, see {@link DockHostContext}).
 * @param copy - the tab's copy, read per call so a language change needs no
 *   re-registration.
 * @param attach - takes the live sidebar; returns its detach.
 */
export function attachDiffDock(
  ctx: DockHostContext,
  copy: { title: () => string; guideDescription: () => string },
  attach: (sidebar: unknown, reason?: string) => () => void,
): void {
  let timer: number | undefined
  let attached = false
  /** The last lookup's shape, kept so "no dock" can say which half was missing. */
  let detail = 'not looked up yet'
  /** The shape already reported to `attach`, so the poll reports once per result
   *  rather than forty times. */
  let reported = ''
  const stop = (): void => {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
  }
  /** Hand "no sidebar, and here is what the lookup saw" to the state — once per
   *  distinct shape, so a 100-tick poll reports once and then only on a change.
   *  The panel surfaces it when the user asks for the dock. */
  const report = (): void => {
    if (detail === reported) return
    reported = detail
    attach(undefined, detail)
  }
  const look = (): boolean => {
    if (attached) return true
    // Everything below is inside one guard: this runs from the plugin's apply,
    // and a throw here used to abort the whole wiring silently — no poll, no
    // reason, no tab, and nothing in the panel to explain it.
    try {
      let sidebar: SidebarRightFace | undefined
      let registry: TabRegistryFace | undefined
      try {
        sidebar = ctx.get('sidebarRight') as SidebarRightFace | undefined
        registry = ctx.get('sidebarRightTabs') as TabRegistryFace | undefined
      } catch (error) {
        detail = `ctx.get threw: ${error instanceof Error ? error.message : String(error)}`
        report()
        return false
      }
      detail = diagnose(ctx)
      if (sidebar === undefined || registry === undefined) {
        // Report the current shape as soon as it is known, not only once the lookup
        // gives up: the user can ask for the dock within seconds of the page load,
        // and "why is there no dock" has to be answerable right then.
        report()
        return false
      }
      // Set before registering: a retry must never register the same tab id twice
      // (the registry throws on a duplicate id).
      attached = true
      ctx.effect(() => attach(sidebar), 'diff-approval: dock sidebar')
      ctx.effect(() => registry.register({
        id: DIFF_DOCK_ID,
        kind: DIFF_DOCK_KIND,
        title: () => copy.title(),
        guide: [{
          order: DIFF_DOCK_GUIDE_ORDER,
          title: () => copy.title(),
          description: () => copy.guideDescription(),
        }],
      }), 'diff-approval: right-sidebar tab type')
      return true
    } catch (error) {
      detail = `dock wiring threw: ${error instanceof Error ? error.message : String(error)}`
      report()
      return false
    }
  }
  // The teardown rides the plugin's fiber — the one verb the sandbox always
  // forwards — so an unloaded plugin leaves no timer behind.
  ctx.effect(() => stop, 'diff-approval: dock lookup')
  if (look()) return
  let attempts = 0
  const tick = (): void => {
    timer = undefined
    if (look()) {
      stop()
      return
    }
    if (++attempts >= DOCK_LOOKUP_ATTEMPTS) {
      stop()
      // Give up loudly enough to be reportable: the panel surfaces this when the
      // user asks for the dock.
      attach(undefined, `no right sidebar after ${DOCK_LOOKUP_ATTEMPTS} looks: ${detail}`)
      return
    }
    timer = window.setTimeout(tick, DOCK_LOOKUP_INTERVAL_MS)
  }
  timer = window.setTimeout(tick, DOCK_LOOKUP_INTERVAL_MS)
}
