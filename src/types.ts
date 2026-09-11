/**
 * Client-safe wire vocabulary shared by this package's host half and browser
 * half. Type-only and Node-free.
 * @module dsh-diff-approval/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

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
  /** What the operation did: an in-place change or a file creation. */
  kind: PendingEntryKind
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
}

/** What one captured operation did to the file. */
export type PendingEntryKind = 'edit' | 'create'

/**
 * One listed pending entry: the stored operation plus the live file state the
 * list endpoint computes by reading the file's current content.
 */
export interface PendingFileDiff extends PendingEntry {
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
  /** Whether the no-change walk hit its file cap, so some files were not added. */
  truncated?: boolean | undefined
  /** Failure detail for `outcome: 'failed'`. */
  message?: string | undefined
}
