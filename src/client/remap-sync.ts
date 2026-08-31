/**
 * Reference remapping sync: track each pending file's last-seen content and,
 * when it changes (an agent edit, a block revert, or an external adoption),
 * rewrite stale references in the current composer draft and the pending queue.
 * Pure orchestration over the pending store; the actual line remapping lives in
 * `reference.ts`.
 * @module dsh-diff-approval/client/remap-sync
 */

import type { PendingDiffStore } from './store.ts'
import { referencePathOf, remapReferences } from './reference.ts'
import { contentKey } from './whole-file-diff.ts'

/** One queued message's minimal content block; text blocks carry `text`, and every other kind passes through verbatim. */
interface QueueBlock { type: string; text?: string }
/** A queued message's minimal shape for reference remapping. */
interface QueueMessage {
  id: string
  content: readonly QueueBlock[]
}

/** One remapping sync's inputs; `readDraft`/`writeDraft` address the current composer. */
export interface ReferenceRemapOpts {
  store: PendingDiffStore
  /** Read the current composer draft text (undefined when there is none). */
  readDraft: () => string | undefined
  /** Write the current composer draft text. */
  writeDraft: (text: string) => void
  /** Read the current session's still-queued messages (full content blocks). */
  readQueue: () => readonly QueueMessage[]
  /** Apply an edit mutation to one queued message's full content. */
  writeQueue: (itemId: string, content: readonly QueueBlock[]) => void
}

/**
 * Subscribe to the pending store and remap references as each file's content
 * changes. The first observation of a file only seeds the baseline; a later
 * `newText` change remaps (draft + queue) and advances the baseline. Files that
 * leave the list drop their baseline so a future re-appearance re-baselines.
 * @param opts - the sync inputs.
 * @returns an unsubscribe function plus a direct remap verb for whole-file reverts.
 */
export function attachReferenceRemap(opts: ReferenceRemapOpts): {
  unsubscribe: () => void
  remapFile: (path: string, oldText: string, newText: string) => void
} {
  const { store, readDraft, writeDraft, readQueue, writeQueue } = opts
  const lastContent = new Map<string, string>()

  const remap = (path: string, oldText: string, newText: string, workspacePath: string | undefined): void => {
    const referencePath = referencePathOf(path, workspacePath)

    const draft = readDraft()
    if (draft !== undefined && draft !== '') {
      const rewritten = remapReferences(draft, referencePath, oldText, newText)
      if (rewritten !== draft) writeDraft(rewritten)
    }

    for (const message of readQueue()) {
      let changed = false
      const content = message.content.map((block) => {
        if (block.type !== 'text' || block.text === undefined) return block
        const rewritten = remapReferences(block.text, referencePath, oldText, newText)
        if (rewritten !== block.text) {
          changed = true
          return { ...block, text: rewritten }
        }
        return block
      })
      if (changed) writeQueue(message.id, content)
    }
  }

  const observe = (): void => {
    const snapshot = store.getSnapshot()
    // @deprecated The host now returns one entry per path (the list is globally
    // unique), so this newest-by-updatedAt dedup is a safety net for any stale
    // client transport that still delivers duplicate path entries. It is kept
    // harmless, not load-bearing.
    const newestByPath = new Map<string, { newText: string; updatedAt: number }>()
    for (const file of snapshot.files) {
      const current = newestByPath.get(file.path)
      if (current === undefined || file.updatedAt >= current.updatedAt) {
        newestByPath.set(file.path, { newText: file.newText, updatedAt: file.updatedAt })
      }
    }
    for (const [path, { newText }] of newestByPath) {
      const previous = lastContent.get(path)
      // Remap only on a real content change, not a representation drift (an EOL
      // re-encode or a trailing-newline flip), which must never expire a live
      // reference. The baseline always advances so a later real change remaps
      // from the right old content.
      if (previous !== undefined && contentKey(previous) !== contentKey(newText)) {
        remap(path, previous, newText, snapshot.workspacePath)
      }
      lastContent.set(path, newText)
    }
    // Drop baselines for files that left the list (whole-file keep/revert).
    for (const path of [...lastContent.keys()]) {
      if (!newestByPath.has(path)) lastContent.delete(path)
    }
  }

  const unsubscribe = store.subscribe(observe)
  observe()
  return {
    unsubscribe,
    remapFile: (path, oldText, newText) => { remap(path, oldText, newText, store.getSnapshot().workspacePath) },
  }
}
