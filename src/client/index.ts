/** Pending-edit review panel, browser half: footer action, pending list, and whole-file diff viewer. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: brings the `settings.section` SlotMap entry into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PendingPanel } from './PendingPanel.tsx'
import { DiffApprovalSettingsTab } from './SettingsTab.tsx'
import { createDiffApprovalPort } from './port.ts'
import { createPendingDiffStore } from './store.ts'
import type { PendingPanelFace } from './slots.ts'
import { en, NS, zh } from './locales.ts'

export type { PendingPanelProps } from './PendingPanel.tsx'
export type { PendingDiffSnapshot, PendingPanelFace } from './slots.ts'
export type { DiffApprovalKey } from './locales.ts'
export { DIFF_APPROVAL_CHANNEL } from './port.ts'

/** Required services: locale, slots, the wire channel, and the current session. */
export const inject = ['slots', 'locale', 'connection', 'sessions']

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

  ctx.on('connection/reset', () => { store.reset() })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'diff-approval-panel',
    locale: NS,
    inject: (): PendingPanelFace => ({
      hooks: { pending: store },
      onRefresh: (sessionId) => { void store.refresh(sessionId) },
      onKeep: (sessionId, path) => store.keep(sessionId, path),
      onRevert: (sessionId, path) => store.revert(sessionId, path),
      onBlockKeep: (sessionId, id, block) => store.blockKeep(sessionId, id, block),
      onBlockRevert: (sessionId, id, block) => store.blockRevert(sessionId, id, block),
      onOpen: (sessionId, id, action) => store.open(sessionId, id, action),
      onUndo: (sessionId) => store.undo(sessionId),
      onRedo: (sessionId) => store.redo(sessionId),
      onImportVcs: (sessionId, includeUntracked) => store.importVcs(sessionId, includeUntracked),
      onAckRedoCleared: () => store.clearRedoCleared(),
      onPasteReference: (sessionId, reference) => {
        // The composer is reached through the session-scoped context: the
        // sessions service maps an id to its actx, whose conversation service
        // owns the input facade (`setDraft` is the single draft write path).
        const sessions = ctx.get('sessions') as { scope(id: SessionId): ClientContext | undefined } | undefined
        const actx = sessions?.scope(sessionId)
        if (actx === undefined) return
        const conversation = actx.get('conversation') as
          | { input?: { for(actx: unknown): { setDraft(text: string): void } } }
          | undefined
        if (conversation?.input === undefined) return
        // Append when the composer already holds a draft; replace when empty.
        const textarea = document.querySelector<HTMLTextAreaElement>('[data-composer-card] textarea')
        const base = textarea?.value ?? ''
        conversation.input.for(actx).setDraft(base === '' ? reference : `${base} ${reference}`)
        textarea?.focus()
      },
    }),
  }, PendingPanel))

  // Contribute this plugin's page as a top-level DSH Settings section.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'diff-approval',
    order: 100,
    label: () => t('settings.tabLabel'),
    locale: NS,
  }, DiffApprovalSettingsTab))
}
