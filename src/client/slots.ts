/** The panel's injected business face and its observable snapshot. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalOpenAction, PendingFileDiff } from '../types.ts'

/** What the panel reads and drives: the pending list plus in-flight entries. */
export interface PendingDiffSnapshot {
  /** Whether a list read has completed at least once. */
  read: boolean
  /** Pending entries, one per file, oldest capture first. */
  files: PendingFileDiff[]
  /** A read failure's message; absent while the latest read succeeded. */
  error?: string
  /** Entry ids whose keep/revert is in flight; their controls are disabled. */
  busy: ReadonlySet<string>
}

/** The injected face the panel component receives from the plugin body. */
export interface PendingPanelFace {
  hooks: {
    /** Live pending-diff snapshot for the current page. */
    pending: HostObservable<PendingDiffSnapshot>
  }
  /** Read the pending list for the current session into the snapshot. */
  onRefresh: (sessionId: SessionId | undefined) => void
  /** Keep one operation (remove it from the pending list). */
  onKeep: (sessionId: SessionId, id: string) => Promise<void>
  /** Revert one operation (restore its prior content, or remove a created file). */
  onRevert: (sessionId: SessionId, id: string) => Promise<void>
  /** Open one file with its default application or reveal it in the folder. */
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
}
