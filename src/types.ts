/**
 * Client-safe wire vocabulary shared by this package's host half and browser
 * half. Type-only and Node-free.
 * @module dsh-diff-approval/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CommentLineRange } from './comment-lines.ts'

/**
 * Where a session sits in the lineage a merged view groups by.
 *
 * Read off the session's own header when an entry is CAPTURED (`SessionHeader.parentSession`, `.origin`,
 * `.delegationDepth`, `.cwd`) and carried on the entry, so a client can group without a second wire
 * field. Every part is optional and absent when the header — or that one field of it — was not
 * available: an ordinary root session has no parent by design, and a host older than these header
 * fields reports none of them. An unknown lineage is recorded as unknown; guessing a root would file a
 * session under the wrong one. Nothing reads this yet: the record is written for the merged view to use.
 */
export interface SessionLineage {
  /** The session this one was forked from, or absent for an ordinary root. */
  parentSessionId?: SessionId | undefined
  /** The header's coarse product classification — `'subagent'` for a subagent child. */
  origin?: string | undefined
  /** How deep below its root the session was delegated, when the shell reports it. */
  delegationDepth?: number | undefined
  /** The session's own working directory, when its header names one. */
  cwd?: string | undefined
}

/**
 * One file's pending entry, global and unique per `path`: the complete set of
 * unhandled changes folded into a single cumulative span across every session
 * and workspace that touched the file. `oldText` is the earliest captured basis
 * and `newText` the latest captured content, so Keep/Revert decides the whole
 * file at once.
 */
export interface PendingEntry {
  /** Stable per-entry id, equal to the path (the global key). */
  id: string
  /** Backend-resolved display path (the tool's output `path`). */
  path: string
  /**
   * Whether there is an earlier version of the file to restore: `'file'` when
   * the whole-file action writes the earlier text back, `'none'` when the file
   * did not exist, so the whole-file action deletes it.
   */
  earlierVersion: PendingEntryKind
  /** File content before the first captured operation (empty for a creation). */
  oldText: string
  /** File content after the latest captured operation. */
  newText: string
  /** Epoch milliseconds of the latest capture. */
  updatedAt: number
  /** The most recent session whose agent touched the file (back-compat). */
  sessionId: SessionId
  /** Every session that touched the file (drives the per-session list filter). */
  sessionIds: SessionId[]
  /**
   * Where this entry's session sits in its lineage, as the shell reported it when the entry was
   * CAPTURED — display-only data for a merged view. The entry keeps its real `sessionId`/`sessionIds`
   * either way: grouping by lineage never rewrites who did the work. Absent on a record written before
   * this field existed, on a session whose header carried none of it, and on an ordinary root (which
   * has no parent by design) — so a reader must treat absent as "not known", never as "a root".
   */
  lineage?: SessionLineage | undefined
  /**
   * Whether a change the reader has not looked at yet arrived on this path — the dot beside its row. Set
   * when an agent operation (or an agent-side admission) changes the entry, cleared when the reader opens
   * the file or acts on the row, and deliberately NOT part of an undo snapshot: a snapshot restores
   * CONTENT, and having seen something is not content.
   */
  unseen?: boolean | undefined
}

/** Whether an entry has an earlier version of its file to restore. */
export type PendingEntryKind = 'file' | 'none'

/**
 * Which way a row's other contributor sits relative to the session LISTING it, walked from the recorded
 * subagent parent links (see `lineageView` on the host).
 *
 * `child` — the other session descends from the lister (the lister is on the other's upward chain).
 * `parent` — the other session is ABOVE the lister (the lister descends from it). It means an ANCESTOR,
 *   possibly more than one hop up, not only the direct parent: the Chinese 上级 says exactly that without
 *   ambiguity, so the English copy and this name keep that meaning.
 * `sibling` — same lineage root, neither is on the other's chain (two children of one parent, say).
 * `mixed` — non-requester owners of DIFFERENT directions: never one of them, and never a guess at one.
 */
export type LineageDirection = 'child' | 'parent' | 'sibling' | 'mixed'

/**
 * One listed pending entry: the stored operation plus the live file state the
 * list endpoint computes by reading the file's current content.
 */
export interface PendingFileDiff extends PendingEntry {
  /**
   * Whether this row reached the list through the LINEAGE MERGE rather than because the LISTING session
   * itself touched it. The HOST computes it per read (`listWithState`), because only the host can walk a
   * lineage — the client cannot, and must not try: it is what lets the panel show a child session's row
   * without re-deriving the merge in the browser. Absent on a host older than the merge and absent on a
   * row this session touched, so a client that does not know the field behaves exactly as it did before.
   */
  viaLineage?: boolean | undefined
  /**
   * Whether some session OTHER than the listing one — and inside the listing session's lineage — also
   * contributed to this row, so a row the session touched itself still says a child had a hand in it. Kept
   * apart from `viaLineage` on purpose: that one answers "why is this row here" (visibility), this one
   * answers "whose change does it carry" (the mark). Only a session in the same lineage counts: entries are
   * keyed by path globally, so an unrelated session's touch of the same file must never be called a child's
   * work. Host-computed per read (`listWithState`), absent on a host older than the mark.
   */
  hasChildContribution?: boolean | undefined
  /**
   * WHICH WAY the row's other contributor stands, so the marker's sentence tells the truth from the seat it
   * is drawn in: the same row is a child's change in its parent's panel and a parent's change in its
   * child's. Host-computed per read from the SAME recorded parent links the merge walks, and carried to the
   * browser like `viaLineage` — the client never infers lineage.
   *
   * Absent whenever no mark applies (the lister is the only contributor), and absent on a host older than
   * this field — in which case the client says the neutral sentence rather than picking a direction.
   * `mixed` is likewise the honest answer when the row carries non-requester owners of different
   * directions; it is never resolved to one of them.
   */
  lineageDirection?: LineageDirection | undefined
  /**
   * Whether the file no longer exists (or cannot be resolved). Reverting a
   * missing entry restores its old content, which recreates the file.
   */
  missing: boolean
  /**
   * Whether the file's current content no longer equals the newest tracked
   * content for its path. The cause is not attributed: any writer — another
   * tool, an editor, a second process — may have changed it after the tracked
   * operations. A Revert on a diverged entry overwrites whatever the file now
   * holds.
   */
  diverged: boolean
}

/** Value returned by the channel's list endpoint. */
export interface DiffApprovalListValue {
  /** Pending entries for the requested session, oldest capture first. */
  files: PendingFileDiff[]
  /** The viewing session's workspace root (when it has one), for workspace-relative references. */
  workspacePath?: string | undefined
  /** Set when a detected external change created a fresh undo checkpoint while
   * redo history was pending, so the panel can surface that the redo stack was
   * superseded. */
  redoCleared?: boolean | undefined
  /**
   * The name of the answer-rules skill this deployment can actually deliver, or absent
   * when it cannot. The client sends a comment prompt that points at the skill when this
   * is set, and carries the same rules inline when it is not.
   */
  commentSkill?: string | undefined
  /**
   * The last failure to write the pending state to disk, or absent while writes are working. The
   * panel says so once: that file is what makes the list survive a restart, so a reader who is not
   * told about it simply finds the list gone later, with nothing to explain it (issue #6).
   */
  persistError?: string | undefined
  /**
   * The last failure to write a COMMENT file, or absent while those writes are working.
   * Separate from `persistError` because the two live in different files and one may be
   * writable while the other is not; a comment that only exists in memory is erased by a
   * restart exactly like an unpersisted list, and the panel says so once.
   */
  commentPersistError?: string | undefined
  /**
   * The requested session's comment threads, oldest first. They ride the list read
   * so a poll sees the entries and the comments that hang off them in one
   * consistent snapshot — a comment list that arrived on its own channel could
   * name an entry the same read had already dropped.
   */
  comments: CommentRecord[]
  /**
   * The new-file lines each comment sits on NOW, keyed by comment id — where its quote was found in
   * the entry's current content (see `resolveCommentLines`, which both halves import).
   *
   * DERIVED on every read and never persisted: a resolved line written to the comment file would
   * outlive the content it was true of, and a stale stored figure is worse than none. A comment the
   * host cannot place — its quote is gone from the content — is simply ABSENT here, and a caller
   * then falls back to `record.anchor`: the line the comment was WRITTEN on, which is what an
   * outdated thread shows anyway. Both panes draw this one map, so the list and the open card
   * cannot name two lines for one comment (issue: one comment read `[382]` in the list while its
   * card read 378, because only the open file's pane had resolved it).
   */
  commentLines: Record<string, CommentLineRange>
  /** Bumped on every comment change, so a poller can tell "nothing new" from "re-read". */
  commentsRevision: number
  /**
   * The answer text for the questions the session has answered, keyed by the
   * question's `requestId` (see `CommentAsk`). DERIVED on every read from the
   * session's own transcript and never stored: the transcript is the one source of
   * truth for what the agent said, so a stored copy could only ever disagree with it.
   */
  commentAnswers: Record<string, string>
}

/** What the open endpoint asks the OS to do with a file. */
export type DiffApprovalOpenAction = 'open' | 'reveal'

/** Value returned by the channel's open endpoint. */
export interface DiffApprovalOpenValue {
  /** What the request did; `missing` means no pending entry existed. */
  outcome: 'opened' | 'missing'
}

/**
 * One diff block's line ranges on the old and new sides, 1-based inclusive.
 * A side is empty when its start exceeds its end; an empty side's start is
 * the insertion point (the line before which content inserts) on that side.
 */
export interface DiffApprovalBlockRange {
  /** First old-file line this block spans; the insertion point for pure additions. */
  oldStart: number
  /** Last old-file line; `oldStart - 1` when the block has no old side. */
  oldEnd: number
  /** First new-file line this block spans; the insertion point for pure deletions. */
  newStart: number
  /** Last new-file line; `newStart - 1` when the block has no new side. */
  newEnd: number
}

/** Target of one block-level keep/revert: the entry plus the block range. */
export interface DiffApprovalBlockTarget {
  sessionId: SessionId
  id: string
  block: DiffApprovalBlockRange
  /** When true and this action clears the entry's last remaining change, remove
   *  the entry from the pending list as part of the same request. When false or
   *  absent, a fully-resolved entry stays listed (the panel's remove-and-keep
   *  prompt sets this from the user's choice). */
  removeWhenResolved?: boolean | undefined
}

/** Outcome of one keep/revert/undo/redo request. */
export type DiffApprovalActionOutcome = 'kept' | 'reverted' | 'missing' | 'undone' | 'redone' | 'nothing'

/** The version-control systems the import integration knows. */
export type VcsKind = 'git' | 'svn' | 'p4'

/** Value returned by the channel's vcs-import endpoint. */
export interface VcsImportValue {
  /** How many pending entries were created (0 when nothing was imported). */
  imported: number
  /** Whether a VCS root was found at all (false when the workspace is not in a git/svn/p4 checkout). */
  detected: boolean
}

/** Target of one preview-image read. */
export interface DiffApprovalPreviewImageTarget {
  sessionId: SessionId
  /** The backend resolution path of the image (workspace-relative or absolute display path). */
  path: string
}

/** Value returned by the channel's preview-image endpoint. */
export interface DiffApprovalPreviewImageValue {
  /** The image's base64 data URI (MIME from the file's extension), or `undefined`
   * when the host could not read the file (absent, outside the workspace, or
   * unreadable) — a missing value leaves the image unresolved in the preview. */
  dataUri?: string | undefined
}

/** Value returned by the channel's keep-all/revert-all endpoints. */
export interface DiffApprovalBulkValue {
  /** How many pending entries were kept/reverted (0 when the session had none). */
  affected: number
}

/** What one file's VCS refresh found. */
export type DiffApprovalRefreshOutcome =
  /** The tracked diff was replaced with the file's current VCS change. */
  | 'refreshed'
  /** A VCS change exists but matches what the entry already tracks. */
  | 'unchanged'
  /** The file has no local VCS change (untracked-and-excluded, or already clean). */
  | 'no-change'
  /** No pending entry existed for the id. */
  | 'missing'
  /** The workspace is not inside a git/svn/p4 checkout. */
  | 'no-vcs'

/** Value returned by the channel's vcs-refresh endpoint. */
export interface DiffApprovalRefreshValue {
  outcome: DiffApprovalRefreshOutcome
}

/** Value returned by the channel's keep and revert endpoints. */
export interface DiffApprovalActionValue {
  /** What the request did; `missing` means no pending entry existed. */
  outcome: DiffApprovalActionOutcome
  /** Entry id the undo/redo affected; absent for a no-op or a non-undo action. */
  id?: string | undefined
  /** Set when a block keep/revert just cleared the entry's last remaining
   * block (the entry stays listed with no pending diff). */
  resolved?: boolean | undefined
}

/** One row of a browsed directory level. */
export interface DiffApprovalBrowseEntry {
  /** Base name inside the listed directory. */
  name: string
  /** What the child is; `other` covers anything neither file nor directory. */
  type: 'file' | 'directory' | 'other'
  /** Absolute host path — the same value `add-path` takes, so the panel can show
   *  (and add) exactly what a row names. */
  path: string
  /** Byte size, present only for a regular file the backend reports. */
  size?: number | undefined
}

/** Value returned by the channel's list-path endpoint: one directory level. */
export interface DiffApprovalBrowseValue {
  /** The listed directory's absolute path. */
  path: string
  /** Direct children: directories first, then files, each name-sorted. */
  entries: DiffApprovalBrowseEntry[]
  /** The response hit the entry cap, so children are missing from `entries`. */
  truncated: boolean
}

/** What one hand-added path did. */
export type DiffApprovalAddOutcome =
  /** At least one entry landed in the list (a directory can add many). */
  | 'added'
  /** Everything scanned was already listed; nothing changed. */
  | 'duplicate'
  /** The path has no local VCS change and the caller did not ask to add those. */
  | 'unchanged'
  /** A directory scan found nothing to add and nothing was listed already. */
  | 'empty'
  /** The path does not exist (or is neither a file nor a directory). */
  | 'missing'
  /**
   * The caller named one exact file and the path is a directory. Refused before anything is
   * scanned, so a mistyped path cannot add a whole subtree.
   */
  | 'not-a-file'
  /** The path lies outside the session's workspace. */
  | 'outside'
  /** The workspace is not inside a git/svn/p4 checkout. */
  | 'no-vcs'
  /** The scan itself failed; `message` carries the reason. */
  | 'failed'

/** Value returned by the channel's add-path endpoint. */
export interface DiffApprovalAddValue {
  outcome: DiffApprovalAddOutcome
  /** How many entries the add put into the list. */
  added: number
  /** How many scanned paths were already listed (left untouched). */
  duplicates: number
  /**
   * The entry a single-file add landed as (the one already listed, for a duplicate). Absent
   * for a directory add, which is about many files. It is what lets a caller that named one
   * path select the file without waiting for the next list poll.
   */
  id?: string | undefined
  /** Whether the no-change walk hit its file cap, so some files were not added. */
  truncated?: boolean | undefined
  /** Failure detail for `outcome: 'failed'`. */
  message?: string | undefined
}

/** The rows a comment was written about, as new-file line numbers. */
export interface CommentAnchor {
  /** First new-file line of the annotation. */
  startLine: number
  /** Last new-file line of the annotation. */
  endLine: number
}

/** The gutter pair of one quoted line, kept so an outdated thread can lay its quote out. */
export interface CommentQuoteLine {
  /** Old-file number, absent on a row the old side does not have (an added line). */
  old?: number | undefined
  /** New-file number — the second gutter — absent on a removed line. */
  new?: number | undefined
  /** Which side of the change the row was on when the thread quoted it. */
  kind?: 'add' | 'del' | 'context' | undefined
}

/** One question asked inside a comment thread, and what became of it. */
export interface CommentAsk {
  /**
   * The identity of the prompt request this question was submitted as. The session
   * persists it on the exact user message it accepted (`source.rpcId`), so it is the
   * join key between the question and its message in the transcript — and it is the
   * idempotency key: a request carrying it again is the same submission, not a second
   * one. Minted by this plugin, so a question knows its own message before the session
   * has admitted anything.
   */
  requestId: string
  /**
   * The SESSION THIS QUESTION WAS SUBMITTED INTO — the transcript that will carry its answer.
   *
   * It is not always the comment's own `sessionId`: once a lineage reads every seat's threads (`list`
   * fans the read out across the lineage root), any seat may ask a question on a thread another seat
   * wrote, and the prompt goes into the seat the human is using. The answer fold then has to know which
   * transcript to read for which question, and turn numbers are only unique WITHIN one session — so this
   * is what `markTurnEnded` matches on as well.
   *
   * Absent on a question asked before this field existed, when the only session a question could have
   * gone to was the comment's own: the fold reads the comment's `sessionId` for those (see
   * `askTranscript` in the comment store), which is exactly where their answers already are.
   */
  sessionId?: SessionId | undefined
  /**
   * The question's own words, as the reader typed them — without the marker, the
   * `(path:lines)` reference and the answer rules that wrap them in the submitted
   * prompt. The prompt is what the agent is asked; this is what the thread shows, so a
   * follow-up is drawn as the words that were written. Set for every question asked
   * now; absent only on a record written before this field existed, whose words are
   * not recoverable from anywhere.
   */
  text?: string | undefined
  /** The turn that claimed the message, when the session reported one. */
  turn?: number | undefined
  /**
   * The session discarded the message before any turn claimed it (a stopped turn, a
   * cancelled queue). Nothing is coming, and the reader is told so rather than left
   * waiting — this is what the client used to infer from its own queue snapshot.
   */
  dropped?: boolean | undefined
  /**
   * The turn that claimed this question has stopped. A question whose turn is over and
   * that the transcript shows no answer for was cut off: the reader is told that and
   * offered another try, instead of a block that waits forever on a turn that ended.
   * Only ever set when true.
   */
  ended?: boolean | undefined
}

/**
 * One comment thread's durable record: the annotation, where it was written, and the
 * questions asked inside it.
 *
 * The ANSWER's text is deliberately absent: `asks[].requestId` names each question's
 * message, and the session transcript stays the one source of truth for what the agent
 * said — a client renders an answer by reading the transcript at that id, and the list
 * read carries the derived text keyed by the same id. Row indices are absent too: they
 * are model-relative and meaningless after a reload, so the record keeps new-file LINE
 * numbers plus the quote the reader was looking at, which is what a re-anchor needs.
 */
export interface CommentRecord {
  /** Stable comment id, minted by the host when the annotation is written. */
  id: string
  /** The session the comment belongs to: comments never cross sessions. */
  sessionId: SessionId
  /** The pending entry the comment hangs off (its id, which is its path). */
  entryId: string
  /** The entry's display path when the comment was written. */
  path: string
  /** The lines the annotation was made on, as NEW-file line numbers: the numbers every label,
   *  jump and reference shows, and the ones the host resolves the quote against. */
  anchor: CommentAnchor
  /** The anchored lines as they read then (the re-anchor fingerprint). */
  quote: string
  /** `quote` with one row of context on each side, as it read then. */
  quoteContext?: string | undefined
  /** The gutter numbers of `quote`'s lines, in the same order. */
  quoteLines?: CommentQuoteLine[] | undefined
  /** The annotation itself: what the reader wrote. */
  text: string
  /**
   * Who wrote `text`, when it was not the reader.
   *
   * The panel draws a thread's first turn as the reader's own words, which is what it is for every
   * comment the reader makes. An AGENT-authored annotation is the other direction (see
   * `annotate-tool.ts`): the panel is showing the agent's explanation on those lines, and drawing it as
   * something the reader said would put words in their mouth. Absent means the reader.
   */
  author?: 'agent' | undefined
  /** Epoch milliseconds the comment was written. */
  createdAt: number
  /** Epoch milliseconds of the last change to this record. */
  updatedAt: number
  /** The questions asked in this thread, oldest first; empty until one is asked. */
  asks?: CommentAsk[] | undefined
  /**
   * Whether something the reader has not looked at yet arrived in this thread — the dot beside its
   * card. Set when an agent-authored annotation is written or when an answer lands in the thread,
   * cleared when the card comes into view, and deliberately NOT part of an undo snapshot: a snapshot
   * restores CONTENT, and having seen something is not content.
   */
  unseen?: boolean | undefined
  /**
   * The answer text the reader has already been told about, keyed by question id.
   *
   * The answer's text is deliberately absent from this record (see the doc above) — the transcript is
   * the one source
   * of truth for what the agent said — but "is this the answer I have already seen?" cannot be
   * answered from the transcript alone, because a read has nothing to compare against. This is the
   * baseline the comparison takes: the host writes the current answer here when the card goes out of
   * the reader's way, and an answer whose text differs from this is news. Persisted rather than held
   * in memory, so a restart does not light a dot the reader had already cleared.
   */
  answerSeen?: Record<string, string> | undefined
  /**
   * The latest answer text the host has observed for each question, keyed by question id.
   *
   * The other half of the comparison above, and kept apart from it on purpose: this follows what the
   * agent said, while `answerSeen` follows what the reader has looked at. An answer whose text differs
   * from its stored `answerSeen` entry is what lights the dot — and an answer that disappears leaves
   * this empty rather than looking like a change, so a transcript that cannot be read never re-lights
   * a thread the reader already read.
   */
  answerNow?: Record<string, string> | undefined
}

/** Value returned by the channel's comment-add endpoint. */
export interface DiffApprovalCommentAddValue {
  /**
   * What the request did. `missing` means the named entry is not in the session's
   * list — a comment on a file that has left it is refused rather than stored,
   * which is the first of the two guards against a comment outliving its entry.
   */
  outcome: 'added' | 'missing'
  /** The stored comment; present only when `outcome` is `added`. */
  comment?: CommentRecord | undefined
}

/** Value returned by the channel's comment-remove endpoint. */
export interface DiffApprovalCommentRemoveValue {
  /** What the request did; `missing` means no such comment in that session. */
  outcome: 'removed' | 'missing'
}

/** Value returned by the channel's comment-remove-many endpoint. */
export interface DiffApprovalCommentRemoveManyValue {
  /**
   * How many of the named comments the request dropped.
   *
   * The ids that were not there are not named back: the reader asked for those comments to be
   * gone, and one that another client already ended is gone. What is left to say is how many
   * the request itself did, which is what a test and a log can hold on to.
   */
  removed: number
}

/** Value returned by the channel's comment-ask endpoint. */
export interface DiffApprovalCommentAskValue {
  /**
   * What the request did. `missing` means no such comment in that session;
   * `no-agent` means the session has no live agent to ask (it ended, or this host
   * drives no agent for it), and `failed` carries `message`.
   */
  outcome: 'asked' | 'missing' | 'no-agent' | 'failed'
  /** The request identity the comment now carries (present when `outcome` is `asked`). */
  requestId?: string | undefined
  /** Failure detail for `outcome: 'failed'`. */
  message?: string | undefined
}
