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
 * Mount the pending-edit review panel.
 * @param ctx - Client Cordis context carrying the wire and slot services.
 */
export function apply(ctx: ClientContext): void {
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
      onUndo: (sessionId) => { void store.undo(sessionId) },
      onRedo: (sessionId) => { void store.redo(sessionId) },
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
