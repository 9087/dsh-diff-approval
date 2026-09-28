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
    && left.earlierVersion === right.earlierVersion
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
   * The content version of each entry: bumped whenever its tracked `newText` moves, and never for a
   * change that leaves the content alone (a block keep advances `oldText` only).
   *
   * It is what lets derived, content-dependent state — the lines a comment's quote resolves to, read
   * off `newText` — be cached and refreshed when the content moved rather than recomputed on every
   * read. The versions come from one monotonic counter and are never reused, so an entry that leaves
   * the list and comes back cannot hand back the number a stale cache was keyed to.
   */
  private readonly contentVersions = new Map<string, number>()
  /** The last version handed out; only ever climbs (see `contentVersions`). */
  private contentVersionCounter = 0

  /** Note that one path's tracked content moved, and give it a fresh version. */
  private bumpContent(path: string): void {
    this.contentVersions.set(pathKeyOf(path), ++this.contentVersionCounter)
  }

  /**
   * The version of one path's tracked content, or 0 while it has none.
   *
   * Two calls that return the same number describe the same `newText`: a caller caching something
   * derived from that content may serve its copy until the number changes.
   * @param path - the file path (the global entry key).
   * @returns the path's content version.
   */
  contentVersion(path: string): number {
    return this.contentVersions.get(pathKeyOf(path)) ?? 0
  }

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
    // A new entry is content that arrived; an existing one moved only when its `newText` did (a
    // capture whose content happens to be the same leaves the version — and every cache keyed to it
    // — alone).
    if (current === undefined || current.newText !== merged.newText) this.bumpContent(merged.path)
    return true
  }

  /**
   * Combine a stored entry and a new capture. `oldText` comes from the earlier capture (the file's
   * original basis) — except where that capture was the file's creation and this one edits it, when
   * the creation's own content becomes the basis — and `newText` from the later (latest content).
   * The session set is the union, so the entry always spans the whole pending change regardless of
   * which session contributed which part.
   */
  private mergeEntry(a: PendingEntry, b: PendingEntry): PendingEntry {
    const earlier = a.updatedAt <= b.updatedAt ? a : b
    const later = earlier === a ? b : a
    const sessionIds = [...new Set([...touchedBy(a), b.sessionId])]
    // A creation is the whole change only while creations are all there is: the entry is anchored at a
    // path that did not exist, and `earlierVersion: 'none'` is what makes a revert remove the file. As
    // soon as a later capture EDITS that file, the reader is reviewing rounds of work on a file that
    // exists, so the basis becomes the content it was created with and `回退` writes that back, keeping the
    // file. Freezing the field at 'none' (the rule from 2026-08-31 until now) left a file that had been
    // rewritten many times still tagged 新增 and still offering 删除.
    const onlyCreations = earlier.earlierVersion === 'none' && later.earlierVersion === 'none'
    return {
      ...later,
      // The global identity is the path; `id` must always equal it.
      id: later.path,
      // With no old side of the file's own to keep, the creation's content is the basis: `earlier.newText`
      // is the file as it stood right after it was created.
      oldText: onlyCreations ? '' : earlier.earlierVersion === 'none' ? earlier.newText : earlier.oldText,
      earlierVersion: onlyCreations ? 'none' : 'file',
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
    const key = pathKeyOf(path)
    const removed = this.entries.delete(key)
    // The version goes with the entry rather than being reused: an entry re-added under the same
    // path is different content, and a cache keyed to the old number must not read as current.
    if (removed) this.contentVersions.delete(key)
    return removed
  }

  /**
   * Advance one entry's tracked content after a block-level keep/revert. The
   * entry keeps its path; only the given side's text and capture time move.
   *
   * A keep that advances `oldText` also ends the entry's life as a creation. `earlierVersion` is the fact
   * "this file did not exist before", and once part of the file has been accepted there IS an earlier
   * version to restore — what the reader kept. The whole-file action must therefore become 回退, not 删除:
   * deleting would throw away the part they just accepted. (Leaving the field alone kept a partly-kept new
   * file offering to delete itself, which is what sent the reader here.)
   * @param path - the file path.
   * @param patch - the side to advance (`oldText` for keep, `newText` for revert).
   * @returns whether the entry changed.
   */
  update(path: string, patch: { oldText?: string; newText?: string }): boolean {
    const entry = this.entries.get(pathKeyOf(path))
    if (entry === undefined) return false
    const kept = patch.oldText !== undefined
    const next: PendingEntry = { ...entry, ...patch, ...(kept ? { earlierVersion: 'file' as const } : {}), updatedAt: Date.now() }
    this.entries.set(pathKeyOf(path), next)
    if (next.newText !== entry.newText) this.bumpContent(path)
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
    // An undo/redo replays a snapshot: when it carries different content (or puts the entry back),
    // that content is now what the path holds, so anything derived from it is stale.
    if (existing === undefined || existing.newText !== entry.newText) this.bumpContent(entry.path)
    return true
  }

  /**
   * Admit one entry into the list without the change guard {@link fold} applies.
   * A listed entry may carry no diff at all: a path the user added by hand has
   * no local change until one appears, and a fully-resolved file has already
   * folded its diff away. This is the guard-free put {@link restore} performs,
   * named for its other caller.
   * @param entry - the entry to insert or replace by path.
   * @returns whether the store changed.
   */
  insert(entry: PendingEntry): boolean {
    return this.restore(entry)
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
