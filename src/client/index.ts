/** Pending-edit review panel, browser half: footer action, pending list, and whole-file diff viewer. */

import type { ComponentProps, ReactNode } from 'react'
import { createElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: brings the `settings.section` SlotMap entry into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PendingPanel, SIDEBAR_AUTO_COLLAPSE_PX } from './PendingPanel.tsx'
import type { PendingPanelProps } from './PendingPanel.tsx'
import { PanelBoundary } from './boundary.tsx'
import { DiffApprovalSettingsTab } from './SettingsTab.tsx'
import { createDiffApprovalPort } from './port.ts'
import { createPendingDiffStore } from './store.ts'
import { attachReferenceRemap } from './remap-sync.ts'
import { conversationAccess } from './conversation-access.ts'
import { OPEN_FILE_EVENT, startProducedDiffInjection } from './produced-diff.ts'
import type { PendingPanelFace } from './slots.ts'
import { attachDiffDock, createDockState, DIFF_DOCK_ID, DiffDockBody, DiffDockTitle } from './dock.tsx'
import type { DockHostContext } from './dock.tsx'
import { DiffApprovalHeaderEntry } from './header-entry.tsx'
import { en, NS, zh } from './locales.ts'

export type { PendingPanelProps } from './PendingPanel.tsx'
export type { PendingDiffSnapshot, PendingPanelFace } from './slots.ts'
export type { DiffApprovalKey } from './locales.ts'
export { DIFF_APPROVAL_CHANNEL } from './port.ts'

/**
 * The footer seat's registrant: the panel inside its own error boundary, so a
 * crash there cannot retire the entry for the life of the page (see
 * {@link PanelBoundary}).
 * @param props - the seat's runtime props, this plugin's face, and the locale `t`.
 * @returns the boundary-wrapped panel.
 */
function PendingPanelEntry(props: PendingPanelProps): ReactNode {
  // `createElement` rather than JSX: this module is plain `.ts`.
  return createElement(PanelBoundary, { t: props.t }, createElement(PendingPanel, props))
}

/**
 * The header seat's registrant: the entry button inside the same boundary, so a
 * crash costs a visible note rather than the whole button for the page's life.
 * @param props - the seat's runtime props, the face's hooks, and the locale `t`.
 * @returns the boundary-wrapped entry.
 */
function HeaderEntry(props: ComponentProps<typeof DiffApprovalHeaderEntry>): ReactNode {
  return createElement(PanelBoundary, { t: props.t }, createElement(DiffApprovalHeaderEntry, props))
}

/** Required services: locale, slots, the wire channel, the current session, and
 * the layout controller (this plugin collapses the sidebar before its modal opens). */
export const inject = ['slots', 'locale', 'connection', 'sessions', 'layout']

/**
 * Fill one slot, with the failure contained: a registration runs inside the
 * client's boot (or, for a seat declared later, inside the slot machinery), so a
 * throw here would take down more than this panel. A refused seat costs that one
 * surface, and the reason goes to the console rather than being swallowed.
 * @param slots - the client slot service.
 * @param name - the SlotMap key to fill.
 * @param register - the registration, run when the seat's declaration is live.
 */
function seat(
  slots: { inject(name: string, callback: () => unknown): void },
  name: string,
  register: () => unknown,
): void {
  try {
    slots.inject(name, () => register())
  } catch (error) {
    console.error(`diff-approval could not fill ${name}:`, error)
  }
}

/**
 * The dsh web-react renderer gives `div[data-slot="sidebar.footer.action"]` an
 * inline `display: contents`, so every plugin's footer entry root participates
 * directly in the `.footerActions` flex row — several plugins (e.g. this one
 * plus a file-browser) get crammed into one row and a full-width badge
 * overflows. Stack the slot entries vertically instead (the same fix the
 * dsh-footer-order plugin injects), so each plugin gets its own row.
 *
 * We defer to the dedicated dsh-footer-order plugin when it is present, so the
 * two never fight.
 *
 * Why we detect it by its injected stylesheet's `--dsh-footer-order-gap` custom
 * property rather than by `ctx.slots.entriesOfSlot('settings.plugin.item')`
 * (where footer-order registers its settings card, id `footer-order`): that slot
 * key is not in our SlotMap type (would need a cast) and, more importantly, it
 * may not be an active slot in this dsh version at all — footer-order targets a
 * newer dsh settings API, so the detection could miss footer-order and we would
 * then both inject, fighting over the same `!important` rule. The CSS marker is
 * footer-order's own, and its presence is exactly "footer-order's rule is really
 * applied", which is what decides the layout. So only when the marker is absent
 * do we inject our own rule.
 */
function injectFooterStackStyle(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-diff-approval-footer-stack]') !== null) return
  const CSS = 'div[data-slot="sidebar.footer.action"]{display:flex!important;flex-direction:column!important;flex:1 1 auto!important;align-items:stretch!important;}'
  const footerOrderInstalled = (): boolean => {
    // footer-order's injected rule carries this marker; scan every stylesheet.
    for (const style of document.querySelectorAll('style')) {
      if ((style.textContent ?? '').includes('--dsh-footer-order-gap')) return true
    }
    return false
  }
  const inject = (): void => {
    if (document.querySelector('style[data-diff-approval-footer-stack]') !== null) return
    if (footerOrderInstalled()) return  // dsh-footer-order is managing this slot
    const style = document.createElement('style')
    style.setAttribute('data-diff-approval-footer-stack', '')
    style.textContent = CSS
    document.head.appendChild(style)
  }
  if (document.querySelector('div[data-slot="sidebar.footer.action"]') !== null) {
    inject()
    return
  }
  // The footer renders after the app boots; watch for the anchor and check once
  // it appears (footer-order's stylesheet is injected at boot, so its marker
  // would already be present then).
  const observer = new MutationObserver(() => {
    if (document.querySelector('div[data-slot="sidebar.footer.action"]') !== null) {
      observer.disconnect()
      inject()
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

/**
 * Mount the pending-edit review panel.
 * @param ctx - Client Cordis context carrying the wire and slot services.
 */
export function apply(ctx: ClientContext): void {
  injectFooterStackStyle()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-diff-approval: dictionaries')
  const t = ctx.locale.bind(NS)

  const connection = ctx.get('connection') as ConnectionHandle
  const store = createPendingDiffStore(createDiffApprovalPort(connection.rpc))

  // The current session, latched from the panel's `onRefresh` so the reference
  // remap can address the visible composer.
  let currentSessionId: SessionId | undefined

  // Rewrite stale references in the current composer when a pending file's
  // content changes (agent edit, block revert, or an external adoption).
  // `remapFile` is also called directly after a whole-file revert (whose entry
  // leaves the list, so the observation loop cannot see its content change).
  let remapFile: (path: string, oldText: string, newText: string) => void = () => {}
  const access = conversationAccess(ctx, () => currentSessionId)
  ctx.effect(() => {
    const attached = attachReferenceRemap({
      store,
      readDraft: () => document.querySelector<HTMLTextAreaElement>('[data-composer-card] textarea')?.value,
      writeDraft: access.writeDraft,
      readQueue: access.readQueue,
      writeQueue: access.writeQueue,
    })
    remapFile = attached.remapFile
    return attached.unsubscribe
  }, 'diff-approval: reference remap')

  // Collapse the DSH sidebar before this plugin's modal opens, but only on the
  // narrow (auto-collapse) breakpoint: a wide expanded sidebar is fine (the
  // modal covers it) and must NOT be auto-collapsed. Narrow + manually
  // re-expanded is the overlap case we collapse. The shell marks a closed
  // sidebar with `data-sidebar-collapsed` on `.frame`; we only toggle when it
  // is currently expanded, and guard the toggle so an unwired layout service
  // never crashes the panel.
  const collapseSidebar = (): void => {
    if (window.innerWidth >= SIDEBAR_AUTO_COLLAPSE_PX) return
    const ctxLayout = (ctx as unknown as { layout?: { toggleSidebar(): void } }).layout
    if (ctxLayout === undefined) return
    if (document.querySelector('[data-sidebar-collapsed]') !== null) return
    try {
      ctxLayout.toggleSidebar()
    } catch {
      // The layout face may not be attached yet; the panel still opens.
    }
  }

  ctx.on('connection/reset', () => { store.reset() })

  // The right sidebar as a host for the panel: its state exists from here on, so
  // the footer entry (seated once, below) can carry an observable that flips to
  // "available" whenever the sidebar's services show up. In a build without a
  // right sidebar it simply stays unavailable and the panel keeps opening as the
  // floating overlay. The wiring itself happens *after* the essential
  // registrations: this feature is optional and must never be able to take the
  // panel down with it.
  const dock = createDockState()

  /** The face both the footer panel and the docked tab render with. */
  const buildFace = (): PendingPanelFace => ({
      hooks: { pending: store, dock: dock.face.hooks.dock },
      onOpenDock: dock.face.open,
      onDockShowing: dock.face.setShowing,
      onDockClose: dock.face.setClose,
      closeDock: dock.face.close,
      onRefresh: (sessionId) => { currentSessionId = sessionId; void store.refresh(sessionId) },
      onKeep: (sessionId, path, keepListed) => store.keep(sessionId, path, keepListed),
      onRevert: (sessionId, path, keepListed) => {
        const entry = store.getSnapshot().files.find(file => file.id === path)
        const before = entry?.newText
        const after = entry?.oldText
        const filePath = entry?.path
        return store.revert(sessionId, path, keepListed).then(() => {
          // A whole-file revert writes the old text back, so references to the
          // file shift from `newText` to `oldText`.
          if (filePath !== undefined && before !== undefined && after !== undefined) {
            remapFile(filePath, before, after)
          }
        })
      },
      onBlockKeep: (sessionId, id, block, removeWhenResolved) => store.blockKeep(sessionId, id, block, removeWhenResolved),
      onBlockRevert: (sessionId, id, block, removeWhenResolved) => store.blockRevert(sessionId, id, block, removeWhenResolved),
      onOpen: (sessionId, id, action) => store.open(sessionId, id, action),
      onPreviewImage: (sessionId, path) => store.previewImage(sessionId, path),
      onUndo: (sessionId) => store.undo(sessionId),
      onRedo: (sessionId) => store.redo(sessionId),
      onImportVcs: (sessionId, includeUntracked) => store.importVcs(sessionId, includeUntracked),
      onRefreshVcs: (sessionId, id, includeUntracked) => store.refreshVcs(sessionId, id, includeUntracked),
      onBrowse: (sessionId, path) => store.browse(sessionId, path),
      onAddPath: (sessionId, path, includeUnchanged) => store.addPath(sessionId, path, includeUnchanged),
      onKeepAll: (sessionId) => store.keepAll(sessionId),
      onRevertAll: (sessionId) => store.revertAll(sessionId),
      onAckRedoCleared: () => store.clearRedoCleared(),
      onPasteReference: (sessionId, reference) => {
        // Append the reference to the session's composer draft (replace only
        // when empty), addressed explicitly to the copied reference's session
        // rather than the current-session accessor used by the remap sync.
        conversationAccess(ctx, () => sessionId).appendDraft(reference)
        // The composer surface is a contenteditable div (`[data-composer-input]`),
        // not a <textarea>, so bring it into focus there.
        document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
      },
      collapseSidebar,
  })

  // The two seats this plugin cannot work without — its footer entry and its
  // Settings section — are seated under a guard each. A refused or failing
  // registration must cost that one surface, never the plugin's load: `apply`
  // runs inside the client's boot, and a throw here (a seat that was already
  // taken, a registration racing a reload) would take the app down with it rather
  // than just this panel. The failure is said on the console instead of swallowed.
  seat(ctx.slots, 'sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'diff-approval-panel',
    locale: NS,
    inject: buildFace,
  }, PendingPanelEntry))

  // The docked panel's body and chip live in the sidebar's keyed seats. Both
  // registrations are harmless where those seats do not exist (an older app):
  // `ctx.slots.inject` simply never fires. The seat names are strings here
  // because the sidebar's package is not part of this program's SlotMap — the
  // same reason the whole feature is optional.
  const looseSlots = ctx.slots as unknown as {
    inject(name: string, callback: () => unknown): void
    register(config: Record<string, unknown>, component: unknown): unknown
  }
  // The Session header's entry: the same action as the footer's, seated in the
  // header's right-aligned utilities — the cluster the app puts its own
  // more-actions button in (behind which the session-log export lives), and the
  // one place a session's controls stay visible with the sidebar collapsed or
  // hidden. `order: -5` keeps the app's more-actions button last, as its own
  // design has it: the cluster runs ascending, and the app's sits at the default
  // 0, after "open in app" at -10.
  //
  // Guarded on its own: like the docked seats, this slot belongs to a UI package
  // that is not part of this program's SlotMap (so the name is a string), and a
  // host without it must cost the header entry only — never the footer entry.
  try {
    looseSlots.inject('conversation.session.header.utilities', () => looseSlots.register({
      name: 'conversation.session.header.utilities',
      id: 'diff-approval-entry',
      order: -5,
      locale: NS,
      inject: () => ({ ...buildFace() }),
    }, HeaderEntry))
  } catch {
    // No header utilities in this host.
  }

  // Guarded as a whole: a seat whose contract differs from the one this was
  // written against costs the docked tab, never the footer entry seated above.
  try {
    looseSlots.inject('sidebar.right.pane.tab', () => looseSlots.register({
      name: 'sidebar.right.pane.tab',
      // A keyed seat dispatches by `key` — here the tab type's own id, which is
      // what the seat looks the body up under. (`id` is the non-keyed seats'
      // spelling; passing it here fails the registration.)
      key: DIFF_DOCK_ID,
      locale: NS,
      inject: () => ({ ...buildFace(), docked: true }),
    }, DiffDockBody))
    looseSlots.inject('sidebar.right.pane.tab.title', () => looseSlots.register({
      name: 'sidebar.right.pane.tab.title',
      key: DIFF_DOCK_ID,
      locale: NS,
      inject: () => ({ ...buildFace() }),
    }, DiffDockTitle))
  } catch {
    // No docked tab in this host.
  }

  // Inject a "查看差异" button beside every DSH produced-file chip so the panel
  // can be opened on that file directly from the turn's deliverables. This is a
  // DOM-injection bridge (the harness's ProducedFiles component is untouched):
  // clicking dispatches a window event the panel listens for, which opens and
  // selects the file when it is still pending, or toasts otherwise.
  if (typeof window !== 'undefined') {
    ctx.effect(() => startProducedDiffInjection(
      t('panel.viewDiff'),
      (path) => window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: { path } })),
    ), 'diff-approval: produced-files diff buttons')
  }

  // Now the optional part: discover the right sidebar, register the tab type, and
  // let it host the panel. Guarded as a whole — the panel above is already seated,
  // so a host that rejects any of this (a sandbox, an unexpected service shape)
  // costs the dock, never the panel.
  try {
    attachDiffDock(ctx as unknown as DockHostContext, {
      title: () => t('panel.title'),
      guideDescription: () => t('panel.dockGuide'),
    }, (sidebar, reason) => dock.attach(sidebar, reason))
  } catch {
    // No dock; the footer entry keeps working as the floating overlay.
  }

  // Contribute this plugin's page as a top-level DSH Settings section.
  seat(ctx.slots, 'settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'diff-approval',
    order: 100,
    label: () => t('settings.tabLabel'),
    locale: NS,
  }, DiffApprovalSettingsTab))
}
