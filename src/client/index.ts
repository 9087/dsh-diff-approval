/** Pending-edit review panel, browser half: footer action, pending list, and whole-file diff viewer. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PendingPanel } from './PendingPanel.tsx'
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
    }),
  }, PendingPanel))
}
