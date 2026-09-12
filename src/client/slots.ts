/** The panel's injected business face and its observable snapshot. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DockSnapshot } from './dock.tsx'
import type { DiffApprovalAddValue, DiffApprovalBlockRange, DiffApprovalBrowseValue, DiffApprovalOpenAction, DiffApprovalRefreshValue, PendingFileDiff, VcsImportValue } from '../types.ts'

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
  /** Latched when an external change created a fresh undo checkpoint that
   * superseded the redo history; the panel surfaces it once (deferred if the
   * panel is closed) via a bottom-right notice. */
  redoCleared?: boolean
}

/** The injected face the panel component receives from the plugin body. */
export interface PendingPanelFace {
  hooks: {
    /** Live pending-diff snapshot for the current page. */
    pending: HostObservable<PendingDiffSnapshot>
    /** The dock's state (whether our right-sidebar tab is showing), or absent
     *  when this build has no right sidebar to dock into. */
    dock?: HostObservable<DockSnapshot>
  }
  /** Reveal the panel in the app's right sidebar, opening its tab if needed.
   *  Absent when this build has no right sidebar: the panel then opens floating
   *  whatever the remembered presentation says. */
  onOpenDock?: (() => void) | undefined
  /** The docked tab body's own visibility, so the footer entry can light up
   *  while the panel lives in the sidebar. */
  onDockShowing?: ((showing: boolean) => void) | undefined
  /** Close the docked panel: the docked tab's own close, published by its chip.
   *  `undefined` while no dock tab exists. */
  onDockClose?: ((close: (() => void) | undefined) => void) | undefined
  /** Close the docked tab now, when one exists (the quick-summon chord's job
   *  while the panel lives in the sidebar). */
  closeDock?: (() => void) | undefined
  /** Read the pending list for the current session into the snapshot. */
  onRefresh: (sessionId: SessionId | undefined) => void
  /** Keep one operation. `keepListed` leaves the resolved entry in the list. */
  onKeep: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** Revert one operation (restore its prior content, or remove a created file).
   *  `keepListed` leaves the resolved entry in the list. */
  onRevert: (sessionId: SessionId, id: string, keepListed?: boolean) => Promise<void>
  /** Keep one diff block (accept its change into the tracked baseline). */
  onBlockKeep: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean) => Promise<void>
  /** Revert one diff block (restore its old lines in the file). */
  onBlockRevert: (sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean) => Promise<void>
  /** Open one file with its default application or reveal it in the folder. */
  onOpen: (sessionId: SessionId, id: string, action: DiffApprovalOpenAction) => Promise<void>
  /** Inline one workspace image as a base64 data URI for the Markdown preview
   * (empty when the host cannot read it). */
  onPreviewImage: (sessionId: SessionId, path: string) => Promise<string | undefined>
  /** Paste a copied reference into the session's chat input and focus it. */
  onPasteReference: (sessionId: SessionId, reference: string) => void
  /** Undo the session's last keep/revert, then refresh the list; resolves to the affected entry id when it is still pending. */
  onUndo: (sessionId: SessionId) => Promise<string | undefined>
  /** Redo the session's last undone keep/revert, then refresh the list; resolves to the affected entry id when it is still pending. */
  onRedo: (sessionId: SessionId) => Promise<string | undefined>
  /** Import the workspace's local VCS changes as pending entries (detection included). */
  onImportVcs: (sessionId: SessionId, includeUntracked: boolean) => Promise<VcsImportValue>
  /** Replace one entry's diff with the file's current local VCS change, then
   *  refresh the list; resolves to what the scan found. */
  onRefreshVcs: (sessionId: SessionId, id: string, includeUntracked: boolean) => Promise<DiffApprovalRefreshValue>
  /** List one workspace directory level for the add-path dialog. */
  onBrowse: (sessionId: SessionId, path?: string) => Promise<DiffApprovalBrowseValue>
  /** Add one named path (a file, or a directory's whole subtree) to the list. */
  onAddPath: (sessionId: SessionId, path: string, includeUnchanged: boolean) => Promise<DiffApprovalAddValue>
  /** Keep every pending entry of one session in a single host call (bulk). */
  onKeepAll: (sessionId: SessionId) => Promise<void>
  /** Revert every pending entry of one session in a single host call (bulk). */
  onRevertAll: (sessionId: SessionId) => Promise<void>
  /** Acknowledge the redo-cleared notice so it is only surfaced once. */
  onAckRedoCleared: () => void
  /** Collapse the DSH sidebar (no-op when already collapsed) before the floating
   *  modal opens on a narrow window, so the sidebar can't overlap it. */
  collapseSidebar: () => void
}
