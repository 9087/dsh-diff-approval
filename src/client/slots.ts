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

/** One filter over one session's view of the pending list; the shape every view hook takes. */
export type PendingViewSelector<T> = (view: PendingDiffSnapshot) => T

/** Function shape of {@link PendingViewHooks.pendingView}; named so a seat can call it directly. */
export type PendingViewReader = <T>(sessionId: SessionId | undefined, select: PendingViewSelector<T>) => T

/**
 * How a seat reads pending state for the session it is actually about.
 *
 * The page runs several seats at once — the sidebar footer's badge, the Session header's entry, the
 * docked tab's chip and body — and they can belong to different sessions. Reading the ONE page-wide
 * snapshot is what let a badge show another session's count, so a seat that knows its session reads
 * that session's own view through {@link PendingViewHooks.pendingView} and nothing else.
 *
 * This lives BESIDE the face's `hooks`, not inside it: that compartment is a map of observables
 * (`HooksSources`), and the framework binds each one onto the component props as a `use<Name>` selector
 * hook. Folding a non-observable in there would stop the whole compartment from matching, and the panel
 * would lose `usePending` and `useDock` with it. `pendingView` is a read, not an observable: the panel's
 * `usePending` subscription is what re-renders it.
 *
 * The hook is optional because the shapes are read structurally: a host (or a test) that offers only
 * `pending` still renders, with the panel falling back to the page-wide snapshot.
 */
export interface PendingViewHooks {
  /**
   * Read one session's own view, with `select` applied inside the subscription.
   *
   * `sessionId === undefined` means "I have no session of my own": the answer is then the page-wide
   * view (the newest session read), which is what a whole-page caller wants. A session that has never
   * been read answers an unread empty view — never another session's list.
   * @param sessionId - the session whose view to read.
   * @param select - what to take out of that view.
   * @returns the selected value.
   */
  pendingView?: PendingViewReader | undefined
}

/** The injected face the panel component receives from the plugin body. */
export interface PendingPanelFace extends PendingViewHooks {
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
  /** The reader is looking at this file now: its row's unseen dot goes out. */
  onMarkSeen?: ((sessionId: SessionId | undefined, id: string) => void) | undefined
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
  /**
   * The reader has this comment's card in view: its unseen dot goes out, and the answers on it become
   * the baseline a later rewrite is measured against. A reader action, so it is its own call rather
   * than something a read does — a read that cleared attention would make the dot impossible to see.
   */
  onCommentSeen?: ((sessionId: SessionId, id: string) => void) | undefined
  /** Acknowledge the redo-cleared notice so it is only surfaced once. */
  onAckRedoCleared: () => void
  /** Acknowledge a refused-undo notice once the panel has said it (see `undoNotice`). */
  onAckUndoNotice: () => void
  /** Collapse the DSH sidebar (no-op when already collapsed) before the floating
   *  modal opens on a narrow window, so the sidebar can't overlap it. */
  collapseSidebar: () => void
}
