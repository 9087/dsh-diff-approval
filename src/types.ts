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
