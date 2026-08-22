/** The panel's injected business face and its observable snapshot. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DiffApprovalBlockRange, DiffApprovalOpenAction, PendingFileDiff } from '../types.ts'

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
  /** Entry ids whose last keep/revert failed, mapped to the error message; the panel surfaces these inline (row tag + detail banner) instead of hiding the list. */
  failed?: ReadonlyMap<string, string> | undefined
  /** The viewing session's workspace root (when it has one); enables workspace-relative references. */
  workspacePath?: string | undefined
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
  /** Keep one diff block (accept its change into the tracked baseline). */
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  /** Revert one diff block (restore its old lines in the file). */
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange) => Promise<void>
  /** Open one file with its default application or reveal it in the folder. */
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Paste a copied reference into the session's chat input and focus it. */
  onPasteReference: (sessionId: SessionId, reference: string) => void
  /** Undo the session's last keep/revert, then refresh the list; resolves to the affected entry id when it is still pending. */
  onUndo: (sessionId: SessionId) => Promise<string | undefined>
  /** Redo the session's last undone keep/revert, then refresh the list; resolves to the affected entry id when it is still pending. */
  onRedo: (sessionId: SessionId) => Promise<string | undefined>
}
