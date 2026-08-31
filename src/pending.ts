/**
 * In-memory pending-diff store: one entry per file path, globally, holding the
 * file's full set of unhandled changes as one cumulative span (earliest basis →
 * latest content) across every session and workspace that touched it. Every
 * later operation to a tracked path folds into its entry — `oldText` stays the
 * earliest basis, `newText` takes the latest content, and the touching sessions
 * accumulate in `sessionIds` — even when the chain breaks (an outside writer
 * changed the file between operations). Pure state and transitions; the plugin
 * body owns the `tools/result` observation, the RPC surface, and the
 * filesystem I/O.
 * @module dsh-diff-approval/src/pending
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingEntry } from './types.ts'

/** Map key: the file path (the single global identity of a pending change). */
function pathKeyOf(path: string): string {
  return path
}

/** The session ids an entry was touched by (tolerant of legacy rows without the field). */
function touchedBy(entry: PendingEntry): SessionId[] {
  if (Array.isArray(entry.sessionIds) && entry.sessionIds.length > 0) return entry.sessionIds
  return [entry.sessionId]
}

/** Whether a merge changed nothing (a repeated operation is a no-op). */
function sameEntry(left: PendingEntry, right: PendingEntry): boolean {
  const lIds = touchedBy(left)
  const rIds = touchedBy(right)
  return left.path === right.path
    && left.kind === right.kind
    && left.oldText === right.oldText
    && left.newText === right.newText
    && left.updatedAt === right.updatedAt
    && left.sessionId === right.sessionId
    && lIds.length === rIds.length
    && lIds.every((id, index) => id === rIds[index])
}

/**
 * The pending-diff store: one entry per file path across all sessions. Keep /
 * Revert decides one whole file at a time.
 */
export class PendingDiffStore {
  private readonly entries = new Map<string, PendingEntry>()

  /**
   * Merge one captured operation into its file's entry. A no-op (equal before
   * and after) folds nothing.
   * @param entry - the captured operation (id assigned by the caller).
   * @returns whether the stored entry changed.
   */
  fold(entry: PendingEntry): boolean {
    if (entry.oldText === entry.newText) return false
    return this.merge(entry)
  }

  /** Fold a captured entry into the path's single global entry. */
  private merge(entry: PendingEntry): boolean {
    const current = this.entries.get(pathKeyOf(entry.path))
    const merged = current === undefined ? { ...entry } : this.mergeEntry(current, entry)
    if (current !== undefined && sameEntry(current, merged)) return false
    this.entries.set(pathKeyOf(merged.path), merged)
    return true
  }

  /**
   * Combine a stored entry and a new capture. `oldText` comes from the earlier
   * capture (the file's original basis), `newText` from the later (latest
   * content), and the session set is the union — so the entry always spans the
   * whole pending change regardless of which session contributed which part.
   */
  private mergeEntry(a: PendingEntry, b: PendingEntry): PendingEntry {
    const earlier = a.updatedAt <= b.updatedAt ? a : b
    const later = earlier === a ? b : a
    const sessionIds = [...new Set([...touchedBy(a), b.sessionId])]
    return {
      ...later,
      oldText: earlier.oldText,
      // A creation always keeps kind 'create', so a revert removes the file.
      kind: earlier.kind === 'create' || later.kind === 'create' ? 'create' : 'edit',
      sessionIds,
    }
  }

  /**
   * Copy every entry touching a session (the session's view), oldest capture
   * first. The file list is session-scoped: an entry appears for each session
   * that touched it, so a session only sees files it worked on.
   * @param sessionId - the viewing session.
   * @returns detached entries in capture order.
   */
  list(sessionId: SessionId): PendingEntry[] {
    const found: PendingEntry[] = []
    for (const entry of this.entries.values()) {
      if (touchedBy(entry).includes(sessionId)) found.push(entry)
    }
    return found.sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /** Every entry (all paths, all sessions), oldest capture first. */
  all(): PendingEntry[] {
    return [...this.entries.values()].sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /**
   * Read one path's entry without removing it.
   * @param path - the file path (the global entry key).
   * @returns the entry, or `undefined` when none is tracked.
   */
  get(path: string): PendingEntry | undefined {
    return this.entries.get(pathKeyOf(path))
  }

  /**
   * Remove one path's entry.
   * @param path - the file path.
   * @returns whether an entry was removed.
   */
  remove(path: string): boolean {
    return this.entries.delete(pathKeyOf(path))
  }

  /**
   * Advance one entry's tracked content after a block-level keep/revert. The
   * entry keeps its path; only the given side's text and capture time move.
   * @param path - the file path.
   * @param patch - the side to advance (`oldText` for keep, `newText` for revert).
   * @returns whether the entry changed.
   */
  update(path: string, patch: { oldText?: string; newText?: string }): boolean {
    const entry = this.entries.get(pathKeyOf(path))
    if (entry === undefined) return false
    const next: PendingEntry = { ...entry, ...patch, updatedAt: Date.now() }
    this.entries.set(pathKeyOf(path), next)
    return true
  }

  /**
   * Restore one entry exactly as given (an undo/redo replays a snapshot). The
   * entry is inserted or replaced by path.
   * @param entry - the entry state to restore.
   * @returns whether the store changed.
   */
  restore(entry: PendingEntry): boolean {
    const key = pathKeyOf(entry.path)
    const existing = this.entries.get(key)
    if (existing !== undefined && sameEntry(existing, entry)) return false
    this.entries.set(key, { ...entry })
    return true
  }

  /**
   * Merge persisted entries into the store, one per path after folding. A live
   * entry wins over a persisted one only when its time is newer (folders are
   * applied in capture order, so a later persisted capture is strictly newer).
   * @param entries - persisted entries, oldest capture first, to fold in.
   */
  hydrate(entries: readonly PendingEntry[]): void {
    for (const entry of entries) this.merge({ ...entry })
  }

  /** Total entry count (one per tracked file path). */
  get size(): number {
    return this.entries.size
  }
}
