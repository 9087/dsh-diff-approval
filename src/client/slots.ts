/** The panel's injected business face and its observable snapshot. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { DockSnapshot } from './dock.tsx'
import type { CommentDraft } from './port.ts'
import type { CommentLineRange } from '../comment-lines.ts'
import type {
  CommentRecord, DiffApprovalAddValue, DiffApprovalBlockRange, DiffApprovalBrowseValue, DiffApprovalCommentAddValue,
  DiffApprovalCommentAskValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue, DiffApprovalOpenAction, DiffApprovalRefreshValue, PendingFileDiff, VcsImportValue,
} from '../types.ts'

/** What the panel reads and drives: the pending list plus in-flight entries. */
export interface PendingDiffSnapshot {
  /** Whether a list read has completed at least once. */
  read: boolean
  /** Pending entries, one per file, oldest capture first. */
  files: PendingFileDiff[]
  /**
   * The session's comment threads, oldest first. They arrive on the same read as the
   * entries, from the host — the one copy every client of this session shares, so two
   * browsers show the same threads instead of two private ones.
   */
  comments: CommentRecord[]
  /**
   * The new-file lines each comment sits on NOW, keyed by comment id, as the HOST resolved them
   * against the entry's current content (see the wire type). One map for the whole panel: the list
   * pane's label, the card's own chip and the jump all draw it, so a comment cannot read one line in
   * the list and another in the code view — and a file nobody has opened is named just as rightly,
   * which is what the reader asked for. A comment the host could not place is absent, and its
   * callers fall back to `record.anchor`.
   */
  commentLines: Readonly<Record<string, CommentLineRange>>
  /** The host's comment revision counter, bumped on every comment change. */
  commentsRevision: number
  /** Derived answer text per comment id, read by the host from the session's transcript. */
  commentAnswers: Record<string, string>
  /** A read failure's message; absent while the latest read succeeded. */
  error?: string
  /** Entry ids whose keep/revert is in flight; their controls are disabled. */
  busy: ReadonlySet<string>
  /** Entry ids whose last keep/revert failed, mapped to the error message; the panel surfaces these inline (row tag + detail banner) instead of hiding the list. */
  failed?: ReadonlyMap<string, string> | undefined
  /** The viewing session's workspace root (when it has one); enables workspace-relative references. */
  workspacePath?: string | undefined
  /**
   * The answer-rules skill this host can deliver, or absent when it cannot (see the
   * wire type). A comment prompt points at the skill when it is here, and carries the
   * same rules inline when it is not.
   */
  commentSkill?: string | undefined
  /**
   * The last failure to write the pending state to disk, or absent while writes are working. The
   * panel says so once: the file is what makes the list survive a restart, so a reader who is never
   * told finds the list gone later with nothing to explain it (see the wire type).
   */
  persistError?: string | undefined
  /**
   * The last failure to write the session's COMMENT files, or absent while those writes are
   * working. Their own field (and their own copy) because they are their own files: a comment
   * that only exists in the host's memory is erased by a restart exactly like an unpersisted
   * list, and the panel says so once — the same way, and for the same reason, as `persistError`.
   */
  commentPersistError?: string | undefined
  /**
   * Why the last undo/redo was refused by the host, or absent when there is nothing to say.
   * The host answers a refused undo with its reason (the divergence guard's "the file changed
   * outside the review"), and the reader who pressed the key has to be told: the panel surfaces
   * this once as a toast and clears it, so the next refusal is news again.
   */
  undoNotice?: string | undefined
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
  onAddPath: (sessionId: SessionId, path: string, includeUnchanged: boolean, exact?: boolean) => Promise<DiffApprovalAddValue>
  /** Keep every pending entry of one session in a single host call (bulk). */
  onKeepAll: (sessionId: SessionId) => Promise<void>
  /** Revert every pending entry of one session in a single host call (bulk). */
  onRevertAll: (sessionId: SessionId) => Promise<void>
  /**
   * Keep a PICK of files in one host call. The pick is one decision the reader made, so it goes to the
   * host as one request — one durable write, one read back, and one undo step — rather than a loop of
   * per-file calls that undo would then peel apart.
   */
  onKeepMany: (sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined) => Promise<void>
  /**
   * Revert a PICK of files in one host call; the same one request, one write, one undo step. Unlike a
   * keep this writes over the files, and a file the agent created is DELETED with no undo — so the panel
   * puts a confirmation in front of a pick whose revert would delete (see the pick's menu).
   */
  onRevertMany: (sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined) => Promise<void>
  /**
   * Write one annotation down in the session's comment store. The host owns the
   * record from here on, so the next read is what shows it (and every other client
   * of this session sees it too).
   */
  onCommentAdd: (sessionId: SessionId, comment: CommentDraft) => Promise<DiffApprovalCommentAddValue>
  /** Drop one annotation from the session's comment store. */
  onCommentRemove: (sessionId: SessionId, id: string) => Promise<DiffApprovalCommentRemoveValue>
  /**
   * Drop several annotations in one host call. Ending a pick of comments is one action the reader
   * asked for, so it goes to the host as one request and comes back as one read — see
   * `DiffApprovalStore.commentRemoveMany`.
   */
  onCommentRemoveMany: (sessionId: SessionId, ids: readonly string[]) => Promise<DiffApprovalCommentRemoveManyValue>
  /**
   * Ask one stored comment as its own turn of the session; the answer arrives on the
   * next read, derived by the host from the transcript. `prompt` is what the agent is
   * asked and `text` is the reader's own words inside it, which the host stores on the
   * question so the thread can draw what was written.
   */
  onCommentAsk: (sessionId: SessionId, id: string, prompt: string, text: string) => Promise<DiffApprovalCommentAskValue>
  /** Acknowledge the redo-cleared notice so it is only surfaced once. */
  onAckRedoCleared: () => void
  /** Acknowledge a refused-undo notice once the panel has said it (see `undoNotice`). */
  onAckUndoNotice: () => void
  /** Collapse the DSH sidebar (no-op when already collapsed) before the floating
   *  modal opens on a narrow window, so the sidebar can't overlap it. */
  collapseSidebar: () => void
}
