/**
 * In-memory pending-diff store: one entry per (session, path), holding the
 * file's full set of unhandled changes as one cumulative span. Every later
 * operation to a tracked path folds into its entry — `oldText` stays the
 * earliest basis, `newText` takes the latest content — even when the chain
 * breaks (an outside writer changed the file between operations): the list
 * still shows one element per file. Pure state and transitions; the plugin
 * body owns the `tools/result` observation, the RPC surface, and the
 * filesystem I/O.
 * @module dsh-diff-approval/src/pending
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingEntry } from './types.ts'

/** Map key joining one session id and one entry id. */
function entryKey(sessionId: SessionId, id: string): string {
  return `${String(sessionId)}\u0000${id}`
}

/** Map key joining one session id and one path, indexing the path's current entry. */
function pathKey(sessionId: SessionId, path: string): string {
  return `${String(sessionId)}\u0000${path}`
}

/** Whether a merge changed nothing (a repeated operation is a no-op). */
function sameEntry(left: PendingEntry, right: PendingEntry): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.oldText === right.oldText
    && left.newText === right.newText
    && left.updatedAt === right.updatedAt
}

/**
 * The pending-diff store. Keep/Revert decides one whole file at a time.
 */
export class PendingDiffStore {
  private readonly entries = new Map<string, PendingEntry>()
  private readonly pathIndex = new Map<string, string>()

  /** Merge one operation into the store, keyed by (session, path). */
  private merge(entry: PendingEntry): boolean {
    const key = pathKey(entry.sessionId, entry.path)
    const currentId = this.pathIndex.get(key)
    const current = currentId === undefined ? undefined : this.entries.get(entryKey(entry.sessionId, currentId))
    // A later operation always folds into the existing entry: the entry keeps
    // its earliest basis, id, and kind (a created file stays a creation) and
    // only the latest content and capture time advance.
    const merged: PendingEntry = current === undefined
      ? { ...entry }
      : { ...current, newText: entry.newText, updatedAt: entry.updatedAt }
    if (current !== undefined && sameEntry(current, merged)) return false
    this.entries.set(entryKey(entry.sessionId, merged.id), merged)
    this.pathIndex.set(key, merged.id)
    return true
  }

  /**
   * Fold one captured operation into its file's entry. A no-op (equal before
   * and after) folds nothing.
   * @param entry - the captured operation (id assigned by the caller).
   * @returns whether the stored entry changed.
   */
  fold(entry: PendingEntry): boolean {
    if (entry.oldText === entry.newText) return false
    return this.merge(entry)
  }

  /**
   * Merge persisted entries into the store, one per path after folding. An
   * already-keyed live entry wins over a persisted one: the live entry is
   * newer by construction (it was captured after the persisted state was
   * written), so the path's whole persisted run is skipped.
   * @param sessionId - the session the entries belong to.
   * @param entries - persisted entries, oldest capture first, to fold in.
   */
  hydrate(sessionId: SessionId, entries: readonly PendingEntry[]): void {
    const livePaths = new Set(this.pathIndex.keys())
    for (const entry of entries) {
      const key = pathKey(sessionId, entry.path)
      if (livePaths.has(key)) continue
      this.merge({ ...entry, sessionId })
    }
  }

  /**
   * Copy the session's entries, oldest capture first.
   * @param sessionId - the session whose entries to list.
   * @returns detached entries in capture order.
   */
  list(sessionId: SessionId): PendingEntry[] {
    const found: PendingEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) found.push(entry)
    }
    return found.sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /**
   * Read one entry without removing it.
   * @param sessionId - the owning session.
   * @param id - the entry id.
   * @returns the entry, or `undefined` when the pair has none.
   */
  get(sessionId: SessionId, id: string): PendingEntry | undefined {
    return this.entries.get(entryKey(sessionId, id))
  }

  /**
   * Remove one entry.
   * @param sessionId - the owning session.
   * @param id - the entry id.
   * @returns whether an entry was removed.
   */
  remove(sessionId: SessionId, id: string): boolean {
    const removed = this.entries.delete(entryKey(sessionId, id))
    if (!removed) return false
    for (const [key, indexedId] of this.pathIndex) {
      if (indexedId === id) this.pathIndex.delete(key)
    }
    return true
  }

  /**
   * Advance one entry's tracked content after a block-level keep/revert. The
   * entry keeps its id and path; only the given side's text and capture time
   * move. When the caller decides the sides now match, it removes the entry
   * instead of updating it.
   * @param sessionId - the owning session.
   * @param id - the entry id.
   * @param patch - the side to advance (`oldText` for keep, `newText` for revert).
   * @returns whether the entry changed.
   */
  update(sessionId: SessionId, id: string, patch: { oldText?: string; newText?: string }): boolean {
    const key = entryKey(sessionId, id)
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    const next: PendingEntry = { ...entry, ...patch, updatedAt: Date.now() }
    this.entries.set(key, next)
    return true
  }

  /**
   * Restore one entry exactly as given (an undo/redo replays a snapshot). The
   * entry is inserted or replaced by id, and the path index points at it so a
   * later capture folds into the restored entry. The store keeps one entry per
   * path: restoring an entry for a path that a DIFFERENT entry currently owns
   * drops that occupant first, so an undo can never leave two list items for
   * the same file (e.g. an imported entry and a replayed keep of the same path).
   * @param sessionId - the owning session.
   * @param entry - the entry state to restore.
   * @returns whether the store changed.
   */
  restore(sessionId: SessionId, entry: PendingEntry): boolean {
    const key = entryKey(sessionId, entry.id)
    const existing = this.entries.get(key)
    if (existing !== undefined && sameEntry(existing, entry)) return false
    const pathKey_ = pathKey(sessionId, entry.path)
    const occupantId = this.pathIndex.get(pathKey_)
    if (occupantId !== undefined && occupantId !== entry.id) {
      this.entries.delete(entryKey(sessionId, occupantId))
    }
    this.entries.set(key, { ...entry, sessionId })
    this.pathIndex.set(pathKey_, entry.id)
    return true
  }

  /** Total entry count across all sessions. */
  get size(): number {
    return this.entries.size
  }
}
