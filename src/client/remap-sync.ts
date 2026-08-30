/**
 * Reference remapping sync: track each pending file's last-seen content and,
 * when it changes (an agent edit, a block revert, or an external adoption),
 * rewrite stale references in the current composer draft. Pure orchestration
 * over the pending store; the actual line remapping lives in `reference.ts`.
 * @module dsh-diff-approval/client/remap-sync
 */

import type { PendingDiffStore } from './store.ts'
import { referencePathOf, remapReferences } from './reference.ts'

/** One remapping sync's inputs; `readDraft`/`writeDraft` are the current composer's. */
export interface ReferenceRemapOpts {
  store: PendingDiffStore
  /** Read the current composer draft text (undefined when there is none). */
  readDraft: () => string | undefined
  /** Write the current composer draft text. */
  writeDraft: (text: string) => void
}

/**
 * Subscribe to the pending store and remap composer references as each file's
 * content changes. The first observation of a file only seeds the baseline; a
 * later `newText` change remaps and advances the baseline. Files that leave the
 * list drop their baseline so a future re-appearance re-baselines.
 * @param opts - the sync inputs.
 * @returns an unsubscribe function plus a direct remap verb for whole-file reverts.
 */
export function attachReferenceRemap(opts: ReferenceRemapOpts): {
  unsubscribe: () => void
  remapFile: (path: string, oldText: string, newText: string) => void
} {
  const { store, readDraft, writeDraft } = opts
  const lastContent = new Map<string, string>()

  const remap = (path: string, oldText: string, newText: string, workspacePath: string | undefined): void => {
    const draft = readDraft()
    if (draft === undefined || draft === '') return
    const referencePath = referencePathOf(path, workspacePath)
    const rewritten = remapReferences(draft, referencePath, oldText, newText)
    if (rewritten !== draft) writeDraft(rewritten)
  }

  const observe = (): void => {
    const snapshot = store.getSnapshot()
    for (const file of snapshot.files) {
      const previous = lastContent.get(file.path)
      if (previous === undefined) {
        lastContent.set(file.path, file.newText)
      } else if (previous !== file.newText) {
        remap(file.path, previous, file.newText, snapshot.workspacePath)
        lastContent.set(file.path, file.newText)
      }
    }
    // Drop baselines for files that left the list (whole-file keep/revert).
    for (const path of [...lastContent.keys()]) {
      if (!snapshot.files.some(file => file.path === path)) lastContent.delete(path)
    }
  }

  const unsubscribe = store.subscribe(observe)
  observe()
  return {
    unsubscribe,
    remapFile: (path, oldText, newText) => { remap(path, oldText, newText, store.getSnapshot().workspacePath) },
  }
}
