/**
 * Connection-channel port: narrows `ctx.connection.rpc.call` to this
 * package's business verbs and validates the wire values it receives. The
 * host half owns the channel; this module is the browser's one caller.
 * @module dsh-diff-approval/client/port
 */

import type { ClientConnectionRpc, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  CommentAnchor, CommentAsk, CommentQuoteLine, CommentRecord,
  DiffApprovalActionValue, DiffApprovalAddValue, DiffApprovalBlockRange, DiffApprovalBrowseValue, DiffApprovalBulkValue,
  DiffApprovalCommentAddValue, DiffApprovalCommentAskValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue,
  DiffApprovalListCountValue,
  DiffApprovalListValue,
  DiffApprovalOpenAction, DiffApprovalOpenValue, DiffApprovalPreviewImageValue, DiffApprovalRefreshValue, PendingFileDiff, VcsImportValue,
} from '../types.ts'

/** The channel the host half registers and this port calls. */
export const DIFF_APPROVAL_CHANNEL = '/diff-approval'

/**
 * One annotation as the panel hands it over: what the reader wrote and where they
 * wrote it. The display path is not part of it — the entry a comment hangs off is the
 * host's authority on what the file is called.
 */
export interface CommentDraft {
  /** Caller-minted id, so a retried write lands on the same comment. */
  id: string
  /** The listed entry the annotation hangs off. */
  entryId: string
  /** The lines it was made on, as new-file line numbers. */
  anchor: CommentAnchor
  /** The anchored lines as they read then (the re-anchor fingerprint). */
  quote: string
  /** `quote` with one line of context on each side, as it read then. */
  quoteContext?: string | undefined
  /** The gutter numbers of `quote`'s lines, in the same order. */
  quoteLines?: CommentQuoteLine[] | undefined
  /** What the reader wrote. */
  text: string
}

/** This package's business verbs over the review channel. */
export interface DiffApprovalPort {
  /** Read one session's pending entries (plus its workspace root), oldest capture first. */
  list(sessionId: SessionId): Promise<DiffApprovalListValue>
  /**
   * Ask HOW MANY rows a full `list` read would carry for this session, reading no file content.
   *
   * This is the badge's own question: the full read ships every visible entry's whole old/new text
   * (megabytes on a long-lived session), while the count costs one stat per visible row on the host and
   * puts a single number on the wire. It is the SAME visibility rule as `list` on the host's side.
   *
   * A host that predates the endpoint throws instead — its handler answers `unknown endpoint
   * "list-count"` — and the caller is expected to fall back to the full read (see
   * `PendingDiffStore.refreshCount`), which is exactly the behaviour a page had before this verb existed.
   */
  listCount(sessionId: SessionId): Promise<DiffApprovalListCountValue>
  /** Keep one operation. `keepListed` leaves the resolved entry in the list. */
  keep(sessionId: SessionId, id: string, keepListed?: boolean): Promise<DiffApprovalActionValue>
  /** Revert one operation. `keepListed` leaves the resolved entry in the list. */
  revert(sessionId: SessionId, id: string, keepListed?: boolean): Promise<DiffApprovalActionValue>
  /** Keep one diff block (accept its change into the tracked baseline). */
  blockKeep(sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean): Promise<DiffApprovalActionValue>
  /** Revert one diff block (restore its old lines in the file). */
  blockRevert(sessionId: SessionId, id: string, block: DiffApprovalBlockRange, removeWhenResolved?: boolean): Promise<DiffApprovalActionValue>
  /** Undo the session's last keep/revert (restore the before state). */
  undo(sessionId: SessionId): Promise<DiffApprovalActionValue>
  /** Redo the session's last undone keep/revert (re-apply the after state). */
  redo(sessionId: SessionId): Promise<DiffApprovalActionValue>
  /** Import the workspace's local VCS changes as pending entries. */
  importVcs(sessionId: SessionId, includeUntracked: boolean): Promise<VcsImportValue>
  /** Replace one entry's diff with the file's current local VCS change. */
  refreshVcs(sessionId: SessionId, id: string, includeUntracked: boolean): Promise<DiffApprovalRefreshValue>
  /** List one workspace directory level (workspace-relative; `''` is the root). */
  browse(sessionId: SessionId, path?: string): Promise<DiffApprovalBrowseValue>
  /**
   * Add one named path (a file, or a directory's whole subtree) to the list. With `exact`, the
   * path must be one regular file: a directory is refused instead of being scanned.
   */
  addPath(sessionId: SessionId, path: string, includeUnchanged: boolean, exact?: boolean): Promise<DiffApprovalAddValue>
  /** Tell the host the reader is looking at a file: the row's unseen dot goes out. */
  markSeen(sessionId: SessionId, id: string): Promise<void>
  /** Open one file with its default application or reveal it in the folder. */
  open(sessionId: SessionId, id: string, action: DiffApprovalOpenAction): Promise<DiffApprovalOpenValue>
  /** Keep every pending entry of one session in a single host call (one batch). */
  keepAll(sessionId: SessionId): Promise<DiffApprovalBulkValue>
  /** Revert every pending entry of one session in a single host call (one batch). */
  revertAll(sessionId: SessionId): Promise<DiffApprovalBulkValue>
  /**
   * Keep a PICK of entries in one host call: one request, one durable write and one undo step — the
   * host records the whole pick as a single batch, so one Ctrl+Z takes that one decision back instead
   * of peeling it apart file by file. `keepListed` says whether the resolved files stay listed.
   *
   * There is a `revertMany` beside it, and the pair is NOT symmetric: a keep writes nothing, while a
   * revert writes the baseline over each file — and DELETES the ones the agent created, which the host
   * cannot undo. The panel asks before sending a pick whose revert would delete anything.
   */
  keepMany(sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined): Promise<DiffApprovalBulkValue>
  /** Revert a PICK of entries in one host call: the same one request, one write, one undo step. The undo
   *  restores the entries the host could snapshot — see `keepMany` for the deletes it cannot. */
  revertMany(sessionId: SessionId, ids: readonly string[], keepListed: boolean | undefined): Promise<DiffApprovalBulkValue>
  /** Read one workspace image and inline it as a base64 data URI (for the Markdown preview). */
  previewImage(sessionId: SessionId, path: string): Promise<DiffApprovalPreviewImageValue>
  /**
   * Write one annotation down. The host refuses a comment whose entry is not in the
   * session's list, and the refusal is reported rather than retried.
   */
  commentAdd(sessionId: SessionId, comment: CommentDraft): Promise<DiffApprovalCommentAddValue>
  /** Drop one annotation (what "a comment dies with its entry" does by hand). */
  commentRemove(sessionId: SessionId, id: string): Promise<DiffApprovalCommentRemoveValue>
  /**
   * Drop several annotations in one host call: one request, one write of the session's comment file,
   * and one read afterwards (`store.commentRemoveMany`). A batch that is a loop of `commentRemove`
   * calls is a different thing — N requests, N writes — which is what this endpoint exists to avoid.
   */
  commentRemoveMany(sessionId: SessionId, ids: readonly string[]): Promise<DiffApprovalCommentRemoveManyValue>
  /** Asks one stored comment as its own turn of the session. */
  commentAsk(sessionId: SessionId, id: string, prompt: string, text: string): Promise<DiffApprovalCommentAskValue>
  /** Tell the host the reader is looking at a comment: the card's unseen dot goes out. */
  commentSeen(sessionId: SessionId, id: string): Promise<void>
}

/** Build the port over one generic RPC caller.
 * @param rpc - the connection's channel caller.
 * @returns the typed port.
 */
export function createDiffApprovalPort(rpc: ClientConnectionRpc): DiffApprovalPort {
  return {
    async list(sessionId) {
      return listValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'list', { sessionId }))
    },
    async listCount(sessionId) {
      // The same channel and the same payload shape as `list`: a host that has one has the other, and a
      // host that does not answers `unknown endpoint` here rather than inventing a number.
      return countValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'list-count', { sessionId }))
    },
    async keep(sessionId, id, keepListed) {
      // Omit the field entirely when unset, so the wire payload keeps its shape.
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'keep',
        keepListed === undefined ? { sessionId, id } : { sessionId, id, keepListed }))
    },
    async revert(sessionId, id, keepListed) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'revert',
        keepListed === undefined ? { sessionId, id } : { sessionId, id, keepListed }))
    },
    async blockKeep(sessionId, id, block, removeWhenResolved) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'block-keep', { sessionId, id, block, removeWhenResolved }))
    },
    async blockRevert(sessionId, id, block, removeWhenResolved) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'block-revert', { sessionId, id, block, removeWhenResolved }))
    },
    async undo(sessionId) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'undo', { sessionId }))
    },
    async redo(sessionId) {
      return actionOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'redo', { sessionId }))
    },
    async importVcs(sessionId, includeUntracked) {
      return importValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'vcs-import', { sessionId, includeUntracked }))
    },
    async refreshVcs(sessionId, id, includeUntracked) {
      return refreshValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'vcs-refresh', { sessionId, id, includeUntracked }))
    },
    async browse(sessionId, path) {
      // Omit the field entirely for the root, so the wire payload keeps its shape.
      return browseValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'list-path',
        path === undefined ? { sessionId } : { sessionId, path }))
    },
    async addPath(sessionId, path, includeUnchanged, exact) {
      return addValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'add-path', {
        sessionId,
        path,
        includeUnchanged,
        ...(exact === true ? { exact: true } : {}),
      }))
    },
    async markSeen(sessionId, id) {
      // Nothing to narrow: the host answers whether anything changed, and the dot's state arrives with the
      // next list read.
      await rpc.call(DIFF_APPROVAL_CHANNEL, 'seen', { sessionId, id })
    },
    async open(sessionId, id, action) {
      return openOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'open', { sessionId, id, action }))
    },
    async previewImage(sessionId, path) {
      return previewImageOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'preview-image', { sessionId, path }))
    },
    async keepAll(sessionId) {
      return bulkOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'keep-all', { sessionId }))
    },
    async revertAll(sessionId) {
      return bulkOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'revert-all', { sessionId }))
    },
    async keepMany(sessionId, ids, keepListed) {
      return bulkOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'keep-many', manyPayload(sessionId, ids, keepListed)))
    },
    async revertMany(sessionId, ids, keepListed) {
      return bulkOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'revert-many', manyPayload(sessionId, ids, keepListed)))
    },
    async commentAdd(sessionId, comment) {
      return commentAddValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'comment-add', { sessionId, ...comment }))
    },
    async commentRemove(sessionId, id) {
      return commentRemoveValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'comment-remove', { sessionId, id }))
    },
    async commentRemoveMany(sessionId, ids) {
      // The array is copied onto the wire: a caller's `Set` iteration or a live array must not be able
      // to move under the request it was read for.
      return commentRemoveManyValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'comment-remove-many',
        { sessionId, ids: [...ids] }))
    },
    async commentAsk(sessionId, id, prompt, text) {
      // `prompt` is what the agent is asked; `text` is the reader's own words inside it, which the
      // host stores on the question so the thread can draw what was written.
      return commentAskValueOf(await rpc.call(DIFF_APPROVAL_CHANNEL, 'comment-ask', { sessionId, id, prompt, text }))
    },
    async commentSeen(sessionId, id) {
      // Nothing to narrow: the host answers whether anything changed, and the dot's state arrives with
      // the next list read.
      await rpc.call(DIFF_APPROVAL_CHANNEL, 'comment-seen', { sessionId, id })
    },
  }
}

/** The pre-rename spelling of a file row's `earlierVersion`, or undefined for anything else. */
function legacyEarlierVersion(kind: unknown): 'file' | 'none' | undefined {
  if (kind === 'edit') return 'file'
  if (kind === 'create') return 'none'
  return undefined
}

/** Narrow one pending entry from the wire; malformed rows are skipped. */
function pendingFileOf(value: unknown): PendingFileDiff | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { id, sessionId, sessionIds, path, oldText, newText, updatedAt, missing, diverged, viaLineage, hasChildContribution, lineageDirection } = record
  // A host built before the rename answers with `kind: 'edit' | 'create'`. Host and client ship together
  // (the host serves this bundle), but a tab can hold the previous client for a moment: reading only the
  // new name would blank the whole list for that moment instead of showing it.
  const earlierVersion = record.earlierVersion ?? legacyEarlierVersion(record.kind)
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (earlierVersion !== 'file' && earlierVersion !== 'none') return undefined
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (typeof updatedAt !== 'number') return undefined
  const touched = Array.isArray(sessionIds)
    ? sessionIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  return {
    id,
    sessionId: sessionId as SessionId,
    path,
    earlierVersion,
    oldText,
    newText,
    updatedAt,
    sessionIds: touched.length > 0 ? touched as SessionId[] : [sessionId as SessionId],
    // An absent flag keeps older hosts listable; the flags are host truth.
    missing: missing === true,
    diverged: diverged === true,
    // Whether the host scoped this row in through the lineage MERGE. Carried like the two flags above —
    // and this is the field the narrowing DROPPED once, which cost the merged row its mark and its very
    // presence in the list (the panel hides a row whose owner is not this session unless this says
    // otherwise). Only `true` is a merge; an older host's silence stays "not merged".
    viaLineage: viaLineage === true,
    // The row's own mark, which is a different question (see `PendingFileDiff.hasChildContribution`) and the
    // same trap: this function rebuilds each row field by field, so a field it does not name never reaches
    // the browser. Absent from an older host reads as "no child's change in it", the behaviour before it.
    hasChildContribution: hasChildContribution === true,
    // WHICH WAY that change came from, carried the same way and with the same trap: a direction the host
    // sent and this narrowing dropped would silently cost the mark its sentence and leave the neutral one.
    // Validated against the four literals rather than cast, so a malformed value from a hand-edited or
    // unknown host reads as "not known" (the neutral sentence) instead of reaching a switch that has no
    // case for it. Absent stays absent — there is no boolean default that means "no direction".
    ...(lineageDirection === 'child' || lineageDirection === 'parent'
      || lineageDirection === 'sibling' || lineageDirection === 'mixed'
      ? { lineageDirection }
      : {}),
    // The dot is host truth too, and dropping it here is invisible: everything upstream lights, and the row
    // simply never shows it. Only `true` is carried, so an older host's silence stays silence.
    ...(record.unseen === true ? { unseen: true } : {}),
  }
}

/** Narrow one comment record from the wire; malformed rows are skipped. */
function commentOf(value: unknown): CommentRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const { id, sessionId, entryId, path, anchor, quote, text, createdAt, updatedAt } = row
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof entryId !== 'string' || entryId.length === 0) return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof anchor !== 'object' || anchor === null) return undefined
  const lines = anchor as Record<string, unknown>
  if (typeof lines.startLine !== 'number' || typeof lines.endLine !== 'number') return undefined
  if (typeof quote !== 'string' || typeof text !== 'string') return undefined
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return undefined
  const context = row.quoteContext
  const quoteLines = Array.isArray(row.quoteLines)
    ? row.quoteLines.filter((line): line is CommentQuoteLine => typeof line === 'object' && line !== null)
    : []
  const asks = asksOf(row.asks)
  // The mark an AGENT-authored annotation carries, validated like every other field: this function is the
  // only door a comment record comes through on this side, so a field it does not copy is a field the
  // panel never sees — the card would be drawn as the reader's own words, in the reader's own bubble.
  const author = row.author === 'agent' ? 'agent' as const : undefined
  return {
    id,
    sessionId: sessionId as SessionId,
    entryId,
    path,
    anchor: { startLine: lines.startLine, endLine: lines.endLine },
    quote,
    text,
    createdAt,
    updatedAt,
    // The attention flag is host truth and rides this read: a field not copied here is a dot the panel
    // can never draw, exactly as `author` above is a card drawn in the wrong voice.
    ...(row.unseen === true ? { unseen: true } : {}),
    ...(author === undefined ? {} : { author }),
    ...(typeof context === 'string' && context !== '' ? { quoteContext: context } : {}),
    ...(quoteLines.length > 0 ? { quoteLines } : {}),
    ...(asks.length > 0 ? { asks } : {}),
  }
}

/** Narrow a thread's questions from the wire; malformed rows are skipped. */
function asksOf(value: unknown): CommentAsk[] {
  if (!Array.isArray(value)) return []
  const asks: CommentAsk[] = []
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const record = row as Record<string, unknown>
    const requestId = record.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) continue
    const turn = record.turn
    const text = record.text
    asks.push({
      requestId,
      ...(typeof text === 'string' && text !== '' ? { text } : {}),
      ...(typeof turn === 'number' ? { turn } : {}),
      ...(record.dropped === true ? { dropped: true } : {}),
      ...(record.ended === true ? { ended: true } : {}),
    })
  }
  return asks
}

/** Narrow the map of derived answers, dropping entries that carry no text. */
function answersOf(value: unknown): Record<string, string> {
  const answers: Record<string, string> = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return answers
  for (const [id, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text !== '') answers[id] = text
  }
  return answers
}

/**
 * Narrow the list endpoint's value; a malformed wire value is a read failure.
 */
function listValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalListValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('list returned a malformed value')
  }
  const rows = (value as Record<string, unknown>).files
  if (!Array.isArray(rows)) throw new Error('list returned a malformed value')
  const workspace = (value as Record<string, unknown>).workspacePath
  const workspacePath = typeof workspace === 'string' && workspace.length > 0 ? workspace : undefined
  const files: PendingFileDiff[] = []
  for (const row of rows) {
    const file = pendingFileOf(row)
    if (file !== undefined) files.push(file)
  }
  const redoCleared = (value as Record<string, unknown>).redoCleared
  // The skill this host can deliver. Narrowing rebuilds the value field by field, so a
  // new host field is invisible until it is read here — which is exactly how the skill
  // pointer stayed out of the comment prompt after the host started sending it.
  const skill = (value as Record<string, unknown>).commentSkill
  const commentSkill = typeof skill === 'string' && skill.length > 0 ? skill : undefined
  // The host's last persistence failure, said once by the panel: a list that will not survive a
  // restart is something the reader cannot find out from the list itself.
  const persisted = (value as Record<string, unknown>).persistError
  const persistError = typeof persisted === 'string' && persisted.length > 0 ? persisted : undefined
  // …and the comment files' own, which are separate files: one may be writable while the
  // other is not, so the two never share a report.
  const commentsPersisted = (value as Record<string, unknown>).commentPersistError
  const commentPersistError = typeof commentsPersisted === 'string' && commentsPersisted.length > 0
    ? commentsPersisted : undefined
  // The comments ride this same read, so the entries and the comments that hang off
  // them are one snapshot; the answers are derived by the host on every read.
  const comments: CommentRecord[] = []
  const rawComments = (value as Record<string, unknown>).comments
  if (Array.isArray(rawComments)) {
    for (const row of rawComments) {
      const comment = commentOf(row)
      if (comment !== undefined) comments.push(comment)
    }
  }
  const revision = (value as Record<string, unknown>).commentsRevision
  // The lines the host resolved each comment to, keyed by comment id. Narrowed row by row like the
  // comments themselves: a malformed figure is dropped rather than trusted, and the caller then
  // falls back to the record's own anchor (`commentLines` in `slots.ts`).
  const commentLines: Record<string, { start: number; end: number }> = {}
  const rawLines = (value as Record<string, unknown>).commentLines
  if (typeof rawLines === 'object' && rawLines !== null && !Array.isArray(rawLines)) {
    for (const [id, row] of Object.entries(rawLines as Record<string, unknown>)) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      const { start, end } = row as Record<string, unknown>
      if (typeof start !== 'number' || !Number.isFinite(start)) continue
      if (typeof end !== 'number' || !Number.isFinite(end)) continue
      commentLines[id] = { start, end }
    }
  }
  return {
    files,
    comments,
    commentLines,
    commentsRevision: typeof revision === 'number' && Number.isFinite(revision) ? revision : 0,
    commentAnswers: answersOf((value as Record<string, unknown>).commentAnswers),
    workspacePath,
    commentSkill,
    persistError,
    commentPersistError,
    ...(redoCleared === true ? { redoCleared: true } : {}),
  }
}

/**
 * Narrow the light count endpoint's value; a malformed wire value is a read failure.
 *
 * A host that predates the endpoint does not answer `{ count }` at all: its channel handler falls through
 * to `unknown endpoint "list-count"` (`code: 'internal'`), which the line below turns into an Error whose
 * message carries those words. The store detects exactly that and falls back to the full read — see
 * `PendingDiffStore.refreshCount`.
 */
function countValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalListCountValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('list-count returned a malformed value')
  }
  const count = (value as Record<string, unknown>).count
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    throw new Error('list-count returned a malformed count')
  }
  return { count }
}

/** Narrow one action endpoint's value; a malformed wire value is an action failure. */
function actionOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalActionValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the action returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'kept' && outcome !== 'reverted' && outcome !== 'missing'
    && outcome !== 'undone' && outcome !== 'redone' && outcome !== 'nothing') {
    throw new Error('the action returned a malformed outcome')
  }
  const id = (value as Record<string, unknown>).id
  const entryId = typeof id === 'string' && id.length > 0 ? id : undefined
  const resolved = (value as Record<string, unknown>).resolved
  return resolved === true ? { outcome, id: entryId, resolved: true } : { outcome, id: entryId }
}

/** Narrow the vcs-import endpoint's value; a malformed wire value is a failure. */
function importValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): VcsImportValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the import returned a malformed value')
  const imported = (value as Record<string, unknown>).imported
  const detected = (value as Record<string, unknown>).detected
  if (typeof imported !== 'number' || typeof detected !== 'boolean') {
    throw new Error('the import returned a malformed value')
  }
  return { imported, detected }
}

/** Narrow the vcs-refresh endpoint's value; a malformed wire value is a failure. */
function refreshValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalRefreshValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the refresh returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'refreshed' && outcome !== 'unchanged' && outcome !== 'no-change'
    && outcome !== 'missing' && outcome !== 'no-vcs') {
    throw new Error('the refresh returned a malformed outcome')
  }
  return { outcome }
}

/** Narrow the list-path endpoint's value; a malformed wire value is a browse failure. */
function browseValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalBrowseValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the browse returned a malformed value')
  }
  const record = value as Record<string, unknown>
  const path = record.path
  if (typeof path !== 'string') throw new Error('the browse returned a malformed value')
  const rows = record.entries
  if (!Array.isArray(rows)) throw new Error('the browse returned a malformed value')
  const entries: DiffApprovalBrowseValue['entries'] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const { name, type, path: childPath, size } = row as Record<string, unknown>
    if (typeof name !== 'string' || typeof childPath !== 'string') continue
    if (type !== 'file' && type !== 'directory' && type !== 'other') continue
    entries.push({
      name,
      type,
      path: childPath,
      size: typeof size === 'number' && Number.isFinite(size) ? size : undefined,
    })
  }
  const truncated = record.truncated === true
  return { path, entries, truncated }
}

/** Narrow the add-path endpoint's value; a malformed wire value is an add failure. */
function addValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalAddValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the add returned a malformed value')
  }
  const record = value as Record<string, unknown>
  const outcome = record.outcome
  if (outcome !== 'added' && outcome !== 'duplicate' && outcome !== 'unchanged' && outcome !== 'empty'
    && outcome !== 'missing' && outcome !== 'outside' && outcome !== 'no-vcs' && outcome !== 'failed'
    && outcome !== 'not-a-file') {
    throw new Error('the add returned a malformed outcome')
  }
  const added = record.added
  const duplicates = record.duplicates
  if (typeof added !== 'number' || typeof duplicates !== 'number') {
    throw new Error('the add returned a malformed value')
  }
  const message = record.message
  return {
    outcome,
    added,
    duplicates,
    id: typeof record.id === 'string' ? record.id : undefined,
    truncated: record.truncated === true ? true : undefined,
    message: typeof message === 'string' && message.length > 0 ? message : undefined,
  }
}

/** Narrow the open endpoint's value; a malformed wire value is an open failure. */
function openOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalOpenValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the action returned a malformed value')
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'opened' && outcome !== 'missing') {
    throw new Error('the action returned a malformed outcome')
  }
  return { outcome }
}

/** Narrow the preview-image endpoint's value; a malformed wire value is a failure. */
function previewImageOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalPreviewImageValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the preview image returned a malformed value')
  const dataUri = (value as Record<string, unknown>).dataUri
  return typeof dataUri === 'string' && dataUri.length > 0 ? { dataUri } : {}
}

/** Narrow the keep-all/revert-all endpoint's value; a malformed wire value is a failure. */
function bulkOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalBulkValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null) throw new Error('the bulk action returned a malformed value')
  const affected = (value as Record<string, unknown>).affected
  if (typeof affected !== 'number' || !Number.isFinite(affected)) {
    throw new Error('the bulk action returned a malformed value')
  }
  return { affected }
}

/** The wire payload of a pick: the ids copied on, and `keepListed` only when it was actually asked for. */
function manyPayload(
  sessionId: SessionId,
  ids: readonly string[],
  keepListed: boolean | undefined,
): Record<string, unknown> {
  return keepListed === undefined ? { sessionId, ids: [...ids] } : { sessionId, ids: [...ids], keepListed }
}

/** Narrow the comment-add endpoint's value; a malformed wire value is a write failure. */
function commentAddValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalCommentAddValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the comment add returned a malformed value')
  }
  const outcome = (value as Record<string, unknown>).outcome
  // `missing` is a real answer — the entry left the list before the write — and the
  // caller reports it rather than pretending the comment was stored.
  if (outcome === 'missing') return { outcome }
  if (outcome !== 'added') throw new Error('the comment add returned a malformed outcome')
  const comment = commentOf((value as Record<string, unknown>).comment)
  if (comment === undefined) throw new Error('the comment add returned a malformed value')
  return { outcome, comment }
}

/** Narrow the comment-remove endpoint's value. */
function commentRemoveValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalCommentRemoveValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the comment remove returned a malformed value')
  }
  const outcome = (value as Record<string, unknown>).outcome
  if (outcome !== 'removed' && outcome !== 'missing') {
    throw new Error('the comment remove returned a malformed outcome')
  }
  return { outcome }
}

/** Narrow the comment-remove-many endpoint's value. */
function commentRemoveManyValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalCommentRemoveManyValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the comment batch remove returned a malformed value')
  }
  const removed = (value as Record<string, unknown>).removed
  if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0) {
    throw new Error('the comment batch remove returned a malformed count')
  }
  return { removed }
}

/** Narrow the comment-ask endpoint's value. */
function commentAskValueOf(result: Awaited<ReturnType<ClientConnectionRpc['call']>>): DiffApprovalCommentAskValue {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const value: unknown = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the comment ask returned a malformed value')
  }
  const record = value as Record<string, unknown>
  const outcome = record.outcome
  if (outcome !== 'asked' && outcome !== 'missing' && outcome !== 'no-agent' && outcome !== 'failed') {
    throw new Error('the comment ask returned a malformed outcome')
  }
  const requestId = record.requestId
  const message = record.message
  return {
    outcome,
    requestId: typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined,
    message: typeof message === 'string' && message.length > 0 ? message : undefined,
  }
}
