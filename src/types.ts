/**
 * Client-safe wire vocabulary shared by this package's host half and browser
 * half. Type-only and Node-free.
 * @module dsh-diff-approval/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One file's pending entry in one session: the complete set of unhandled
 * changes folded into a single cumulative span. `oldText` is the earliest
 * captured basis and `newText` the latest captured content, so Keep/Revert
 * decides the whole file at once.
 */
export interface PendingEntry {
  /** Stable per-entry id (generated at capture; persisted with the entry). */
  id: string
  /** The session whose agent ran the operation. */
  sessionId: SessionId
  /** Backend-resolved display path (the tool's output `path`). */
  path: string
  /** What the operation did: an in-place change or a file creation. */
  kind: PendingEntryKind
  /** File content before the operation (empty for a creation). */
  oldText: string
  /** File content after the operation. */
  newText: string
  /** Epoch milliseconds of the capture. */
  updatedAt: number
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
}

/** What the open endpoint asks the OS to do with a file. */
export type DiffApprovalOpenAction = 'open' | 'reveal'

/** Value returned by the channel's open endpoint. */
export interface DiffApprovalOpenValue {
  /** What the request did; `missing` means no pending entry existed. */
  outcome: 'opened' | 'missing'
}

/** Outcome of one keep/revert request. */
export type DiffApprovalActionOutcome = 'kept' | 'reverted' | 'missing'

/** Value returned by the channel's keep and revert endpoints. */
export interface DiffApprovalActionValue {
  /** What the request did; `missing` means no pending entry existed. */
  outcome: DiffApprovalActionOutcome
}
