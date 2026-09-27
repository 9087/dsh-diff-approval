/**
 * Durable comment threads, one JSON file per session under
 * `<commentsDir>/<sessionId>.json`, beside the pending-entry storage but never in
 * the same file: a comment that outlived its entry is exactly the leak this
 * module exists to prevent, so a pending write that fails must not be able to
 * take comments with it (or the other way round).
 *
 * A comment belongs to ONE pending entry (`entryId`, which is the entry's path —
 * the store's global identity) and to ONE session. It carries the annotation and
 * the identity of the turn that answered it (`messageId`, `turn`); it does NOT
 * carry the answer's text, because the session transcript stays the single source
 * of truth for what the agent said — a client reads the answer out of the
 * transcript by that id. Saves rewrite the whole session file, staged as a sibling
 * temp file and atomically renamed, so a crash leaves either the old or the new
 * file. A missing file reads as empty; unknown versions and non-JSON content throw.
 * @module dsh-diff-approval/src/comments
 */

import { readFile, readdir, rename } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'
import { basename, dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CommentAsk, CommentQuoteLine, CommentRecord } from './types.ts'

/** On-disk envelope of one session's comments. */
const COMMENT_FILE_VERSION = 1

/** The on-disk envelope: one version plus every comment of one session. */
interface CommentFile {
  version: number
  comments: CommentRecord[]
}

/**
 * The comment directory that belongs to a pending-storage root.
 *
 * The plugin's own state directory is `<dshHome>/diff-approval`, and inside it the
 * pending file lives in `workspaces/` and comments in `comments/` — siblings, so a
 * write that fails on one side cannot take the other with it. Any OTHER root is a
 * self-contained state directory (a deployment's chosen location, a test's temp
 * dir) and keeps its comments INSIDE it: the sibling of an arbitrary directory can
 * be shared by two instances that were each pointed somewhere different, and two
 * instances writing one comment file is a leak rather than a layout choice.
 *
 * @param storageRoot - the resolved pending-storage root.
 * @returns the directory holding the comments that belong to that root.
 */
export function commentsDirFor(storageRoot: string): string {
  return basename(storageRoot) === 'workspaces'
    ? join(dirname(storageRoot), 'comments')
    : join(storageRoot, 'comments')
}

/** The file one session's comments are stored in (the id, made filename-safe). */
function fileOf(root: string, sessionId: SessionId): string {
  return join(root, `${encodeURIComponent(String(sessionId))}.json`)
}

/** Narrow one JSON value to a comment record; malformed rows are skipped. */
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
  if (typeof quote !== 'string') return undefined
  if (typeof text !== 'string') return undefined
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return undefined
  const context = row.quoteContext
  const quoteLines = Array.isArray(row.quoteLines)
    ? row.quoteLines.filter((entry): entry is CommentQuoteLine => typeof entry === 'object' && entry !== null)
    : []
  // The field an AGENT-authored annotation carries, validated here like every other one: this function is
  // the only door a stored row comes back through, so a field it does not copy is a field that survives
  // exactly until the next host restart — the card would come back drawn as the reader's own words.
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
    ...(author === undefined ? {} : { author }),
    ...(typeof context === 'string' && context !== '' ? { quoteContext: context } : {}),
    ...(quoteLines.length > 0 ? { quoteLines } : {}),
    ...(asksOf(row.asks).length > 0 ? { asks: asksOf(row.asks) } : {}),
  }
}

/** Narrow a stored thread's questions; malformed rows are skipped. */
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

/** Whether one thread holds a question with this request id that `wanted` still describes. */
function hasAsk(comment: CommentRecord, requestId: string, wanted: (ask: CommentAsk) => boolean): boolean {
  return (comment.asks ?? []).some(ask => ask.requestId === requestId && wanted(ask))
}

/** Read one file's JSON; `undefined` when absent (the normal empty state). */
async function readJson(file: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `comment file '${file}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Validate a parsed comment file. */
function commentFileOf(file: string, value: unknown): CommentFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`comment file '${file}' is not a comment file`)
  }
  const { version, comments } = value as Record<string, unknown>
  if (version !== COMMENT_FILE_VERSION) {
    throw new Error(`comment file '${file}' has unsupported version ${JSON.stringify(version)}`)
  }
  if (!Array.isArray(comments)) throw new Error(`comment file '${file}' has no comment list`)
  return { version, comments }
}

/** One thrown value's human text, whatever shape it arrived in. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How a caller hears about the two ways a comment file can go wrong.
 *
 * The store reads and writes plain JSON files and owns no logger, so both halves are
 * callbacks: the host wires them to `ctx.logger` and to the list read the panel draws,
 * which is what turns "the write failed" from a fact only the filesystem knew into
 * something the reader is told (and something a test can assert without a disk).
 */
export interface CommentStoreOptions {
  /**
   * One session's comments could not be read, and that file was skipped. Called once per
   * skipped file, with the file's path, because the caller's warning has to name it.
   */
  onLoadSkipped?: (file: string, error: unknown) => void
  /**
   * A save failed (`message` is the reason) or a session's failure cleared (`undefined`).
   * Called only when the report CHANGES, so a writer retrying every second cannot bury
   * the log; the same value also rides the list read as `persistError()`. One session's
   * healthy write does not clear another's failure — see `persistError`.
   */
  onPersistError?: (message: string | undefined) => void
}

/**
 * File-backed comment threads, one file per session.
 *
 * Every mutation is applied to memory synchronously and schedules that session's
 * file write on its own chain, so a caller removing an entry can drop its comments
 * in the same tick as the entry itself without awaiting anything — the same
 * fire-and-forget persistence the pending store uses.
 */
export class CommentStore {
  private readonly byId = new Map<string, CommentRecord>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private revision = 0
  /** Files `loadAll` could not read, in the order it met them (see `skippedFiles`). */
  private readonly skipped = new Set<string>()
  /**
   * The save failure of every session that has one, keyed by that session's file and in the
   * order the failures happened (see `persistError`). Empty while every write works.
   */
  private readonly persistFailures = new Map<string, string>()
  /**
   * Sessions whose unreadable file could not even be moved aside, keyed by that file: the
   * reason their writes are refused rather than allowed to truncate the bytes (see `save`).
   */
  private readonly unmovable = new Map<string, string>()

  /**
   * @param root - directory holding one `<sessionId>.json` per session.
   * @param options - the error seam (see {@link CommentStoreOptions}).
   */
  constructor(private readonly root: string, private readonly options: CommentStoreOptions = {}) {}

  /**
   * Load every session's comments. A malformed row is skipped rather than
   * failing the load: one bad comment must not cost the whole workspace's
   * comments (or the plugin's activation).
   *
   * A file that cannot be READ is skipped the same way, because the alternative is
   * worse in both directions: the old all-or-nothing load threw, the caller logged
   * once and carried on with an EMPTY store, and the next save then wrote that
   * emptiness back over every good file. One unreadable file therefore cost every
   * session's comments. Skipping keeps the other sessions' threads, and the skipped
   * file is moved aside (`.corrupt`) rather than dropped: it is not deleted — the
   * bytes may be the only copy — but it is also not left where the next save for
   * that session would silently overwrite it, which would destroy them for good.
   *
   * When even that fails — the file cannot be moved aside — that session's writes are
   * refused from then on (see `save`) rather than allowed to truncate the only copy.
   * "Skipped but still writable" is exactly the shape that turns a read failure into
   * data loss: the store would answer "added", write the memory-only view over bytes
   * nobody could read, and lose what the skip had just refused to guess at.
   * @returns how many comments were loaded.
   */
  async loadAll(): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      const file = join(this.root, name)
      let value: unknown
      let comments: CommentRecord[]
      try {
        value = await readJson(file)
        if (value === undefined) continue
        comments = commentFileOf(file, value).comments
      } catch (error: unknown) {
        await this.skip(file, error)
        continue
      }
      for (const row of comments) {
        const comment = commentOf(row)
        if (comment !== undefined) this.byId.set(comment.id, comment)
      }
    }
    this.revision += 1
    return this.byId.size
  }

  /**
   * The files a load skipped, so the caller can say what went missing instead of
   * reporting a session whose comments silently vanished.
   * @returns the skipped files' paths, in load order.
   */
  skippedFiles(): string[] {
    return [...this.skipped]
  }

  /**
   * The failure the reader has to be told about, or `undefined` while every write works.
   * This is what rides the list read so the panel can say the threads are memory-only;
   * a later successful save retracts it, mirroring the pending half's own report.
   *
   * Per SESSION, not one global slot: a deployment where one session's file cannot be
   * written and another's can is the ordinary case (a locked file, a full quota, a
   * directory that vanished), and letting the healthy write retract the broken one's
   * report would say the threads are safe while that session's live in memory only —
   * the same "a failure that looks like a success" trap, one session over. A session's
   * own success is what retracts its own entry (see `reportPersist`).
   * @returns the most recent outstanding failure's message, or undefined.
   */
  persistError(): string | undefined {
    let message: string | undefined
    for (const failure of this.persistFailures.values()) message = failure
    return message
  }

  /**
   * Record a skipped file: keep it for the caller, name it, and move it aside so a later
   * save for that session writes a fresh file rather than overwriting the unreadable
   * bytes. A quarantine that itself fails is still a skip — the store must not be the
   * reason a single bad file takes the whole load down — but that session's file is then
   * the only copy of its threads, so its writes are refused (see `save`) instead of being
   * allowed to truncate it.
   * @param file - the file that could not be read.
   * @param error - why it could not be read.
   */
  private async skip(file: string, error: unknown): Promise<void> {
    this.skipped.add(file)
    const quarantined = `${file}.corrupt`
    try {
      await rename(file, quarantined)
    } catch (failure: unknown) {
      this.unmovable.set(
        file,
        `could not be read at load (${reasonOf(error)}) and could not be moved aside to '${quarantined}' (${reasonOf(failure)})`,
      )
    }
    this.options.onLoadSkipped?.(file, error)
  }

  /** One session's comments, oldest first (the order threads are read in). */
  list(sessionId: SessionId): CommentRecord[] {
    const listed: CommentRecord[] = []
    for (const comment of this.byId.values()) {
      if (comment.sessionId === sessionId) listed.push(comment)
    }
    return listed.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** A comment by id, whatever session it belongs to. */
  get(id: string): CommentRecord | undefined {
    return this.byId.get(id)
  }

  /**
   * A counter bumped on every change, so a poller can tell "nothing new" from
   * "re-read": the list endpoint ships the session's comments anyway, and this is
   * what says whether anything moved since the last read.
   */
  commentsRevision(): number {
    return this.revision
  }

  /**
   * Record one annotation.
   *
   * Writing a comment that is already here is the SAME comment written again — a client
   * retrying a request whose response was dropped, or a second client sending the id it
   * was handed — so the questions already asked in it are kept and only the annotation's
   * own fields move. Overwriting the whole record would erase the identity of a question
   * that is in flight, and its answer could then never be matched back to this thread;
   * `createdAt` is kept for the same reason, since it is what a list read orders by.
   *
   * @param record - the comment to store.
   * @returns the stored comment, which is the existing one when the id was already here.
   */
  add(record: CommentRecord): CommentRecord {
    const stored = this.mergeOf(record)
    this.byId.set(record.id, stored)
    this.revision += 1
    this.save(record.sessionId)
    return stored
  }

  /**
   * Record several annotations at once, as ONE write per affected session.
   *
   * This is what putting a batch of restored comments back needs and what a loop of `add` calls
   * cannot give it: each `add` saves its session's file, so an undo that restored ten threads wrote
   * that file ten times — ten chances for a transient failure to leave the store and the disk
   * disagreeing about an action the reader already watched happen. The records are stored by the SAME
   * rule as `add` (a new id verbatim, an existing one merged with its `createdAt` and its questions
   * kept), which is what lets a restore be an ordinary write rather than a special case: a snapshot
   * that came back as a new comment, with a fresh id and no questions, would be a look-alike of the
   * reader's thread.
   *
   * A batch that carries nothing changes nothing, so a no-op restore does not rewrite a file.
   *
   * @param records - the comments to store, in the caller's order.
   * @returns the stored record for each input, index-aligned: what landed, which is not always what
   *   was handed over (a merge keeps the fields the existing comment owns). A count would drop that,
   *   and a caller needing it would have to `get` each id back and race a later change.
   */
  addMany(records: readonly CommentRecord[]): CommentRecord[] {
    const stored: CommentRecord[] = []
    const sessions = new Set<SessionId>()
    for (const record of records) {
      // Read through `mergeOf` per record, so a batch that names one id twice behaves exactly as two
      // `add` calls do (the second merges against the first).
      const merged = this.mergeOf(record)
      this.byId.set(record.id, merged)
      stored.push(merged)
      sessions.add(record.sessionId)
    }
    if (records.length === 0) return stored
    this.revision += 1
    for (const sessionId of sessions) this.save(sessionId)
    return stored
  }

  /**
   * The record as the store keeps it: a new id VERBATIM, an id already here merged.
   *
   * The one place the merge rule lives, so `add` and `addMany` cannot drift: writing a comment that
   * is already here is the same comment written again — a client retrying a request whose response
   * was dropped, or a second client sending the id it was handed — so the questions already asked in
   * it are kept and only the annotation's own fields move. Overwriting the whole record would erase
   * the identity of a question that is in flight, and its answer could then never be matched back to
   * this thread; `createdAt` is kept for the same reason, since it is what a list read orders by.
   * @param record - the comment as the caller wrote it.
   * @returns the record to store under its id.
   */
  private mergeOf(record: CommentRecord): CommentRecord {
    const before = this.byId.get(record.id)
    return before === undefined ? record : {
      ...record,
      createdAt: before.createdAt,
      ...(before.asks === undefined ? {} : { asks: before.asks }),
    }
  }

  /**
   * Drop one comment.
   * @param sessionId - the session the caller believes the comment belongs to.
   * @param id - the comment to drop.
   * @returns whether it was there (and belonged to that session).
   */
  remove(sessionId: SessionId, id: string): boolean {
    return this.removeMany(sessionId, [id]).length === 1
  }

  /**
   * Drop several comments of one session in ONE write.
   *
   * This is what a batch action needs and what a loop of `remove` calls cannot give it: each
   * `remove` saves the session's file, so ending ten comments wrote that file ten times — ten
   * chances for a transient failure to leave the store and the disk disagreeing about an action
   * the reader asked for once. The save happens only when something was actually dropped, so a
   * batch that matches nothing does not rewrite the file.
   *
   * An id of another session, or one that is not here at all, is skipped rather than refused:
   * a batch is one request and the comments it names are the ones it can act on, and a comment
   * another client already ended is the state the caller was asking for anyway.
   *
   * @param sessionId - the session the caller believes the comments belong to.
   * @param ids - the comments to drop; a repeated id is one comment.
   * @returns the ids that were dropped, in the order given.
   */
  removeMany(sessionId: SessionId, ids: readonly string[]): string[] {
    const removed: string[] = []
    for (const id of ids) {
      if (removed.includes(id)) continue
      const comment = this.byId.get(id)
      if (comment === undefined || comment.sessionId !== sessionId) continue
      this.byId.delete(id)
      removed.push(id)
    }
    if (removed.length === 0) return removed
    this.revision += 1
    this.save(sessionId)
    return removed
  }

  /**
   * Every comment one pending entry carries, oldest first.
   *
   * The read half of `removeForEntry` and kept beside it, because they are two answers about the same
   * fact: which comments an entry owns. A caller that is about to drop the entry asks this first, so
   * the undo pair can carry them back; the two must agree on that set, or a restore would put back
   * fewer (or more) threads than the drop took.
   * @param entryId - the entry id (= path).
   * @returns that entry's comments, in list order.
   */
  forEntry(entryId: string): CommentRecord[] {
    const listed: CommentRecord[] = []
    for (const comment of this.byId.values()) {
      if (comment.entryId === entryId) listed.push(comment)
    }
    return listed.sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Drop every comment of one pending entry. This is what "a comment dies with
   * its entry" means, and the entry knows nothing about comments, so the caller
   * runs it beside the entry's own removal.
   * @param entryId - the entry id (= path) that left the list.
   * @returns how many comments went with it.
   */
  removeForEntry(entryId: string): number {
    const sessions = new Set<SessionId>()
    let removed = 0
    for (const comment of [...this.byId.values()]) {
      if (comment.entryId !== entryId) continue
      this.byId.delete(comment.id)
      sessions.add(comment.sessionId)
      removed += 1
    }
    if (removed > 0) {
      this.revision += 1
      for (const sessionId of sessions) this.save(sessionId)
    }
    return removed
  }

  /**
   * The orphan sweep: drop every comment whose entry is not in `entryIds`.
   *
   * The explicit `removeForEntry` is the primary path; this is the backstop that
   * catches a comment left behind by a crash between the two writes. Run it when
   * the store loads and on every list read, and the one race it could lose — an
   * entry re-added after its comments were already swept — cannot happen: entries
   * only leave through this host, so an entry absent at load time was removed
   * while the host was running, and the sweep at load runs before anything can
   * add it back.
   * @param entryIds - every entry id the pending store currently holds.
   * @returns how many orphaned comments were dropped.
   */
  retain(entryIds: ReadonlySet<string>): number {
    const sessions = new Set<SessionId>()
    let removed = 0
    for (const comment of [...this.byId.values()]) {
      if (entryIds.has(comment.entryId)) continue
      this.byId.delete(comment.id)
      sessions.add(comment.sessionId)
      removed += 1
    }
    if (removed > 0) {
      this.revision += 1
      for (const sessionId of sessions) this.save(sessionId)
    }
    return removed
  }

  /**
   * Record one question asked in a thread. The answer itself is never stored, and the
   * request id is minted by the caller before it submits, so this runs as part of the
   * ask rather than waiting for the session to answer. A thread keeps its questions in
   * order: the first is the annotation's own, and each follow-up appends.
   *
   * The reader's own words are stored WITH the question (`text`), because they exist
   * nowhere else: the transcript holds the prompt, which is those words wrapped in the
   * marker, the reference and the rules, and a thread that showed the prompt would show
   * the scaffolding rather than the question.
   *
   * @param sessionId - the session the comment belongs to.
   * @param id - the comment that was asked in.
   * @param requestId - the identity the submission carries into the transcript.
   * @param turn - the turn that claimed it, when that is already known.
   * @param text - the reader's own words, without the prompt's wrapper.
   * @returns whether the comment existed.
   */
  recordAsk(sessionId: SessionId, id: string, requestId: string, turn: number | undefined, text: string): boolean {
    return this.patch(
      comment => comment.sessionId === sessionId && comment.id === id,
      comment => ({
        ...comment,
        asks: [...(comment.asks ?? []), { requestId, text, ...(turn === undefined ? {} : { turn }) }],
        updatedAt: Date.now(),
      }),
    ) > 0
  }

  /**
   * Record the turn that claimed one question, as the agent's inbox reported it. Two
   * questions claimed by the same turn were answered together, which is a fact the
   * panel can state instead of guessing from transcript positions.
   * @param sessionId - the session the submission belongs to.
   * @param requestId - the request identity the inbox reported back.
   * @param turn - the turn that claimed it.
   * @returns how many threads the patch touched.
   */
  recordTurnForRequest(sessionId: SessionId, requestId: string, turn: number): number {
    return this.patch(
      comment => comment.sessionId === sessionId && hasAsk(comment, requestId, ask => ask.turn !== turn),
      comment => ({
        ...comment,
        // The question is the record's OWN (`text`, and whatever else it carries): this only
        // writes the turn down beside it, so the thread keeps the words it was asked in.
        asks: (comment.asks ?? []).map(ask => (
          ask.requestId === requestId ? { ...ask, turn } : ask
        )),
        updatedAt: Date.now(),
      }),
    )
  }

  /**
   * Record that the session dropped one question before a turn claimed it: nothing is
   * coming, and the reader is told rather than left waiting.
   * @param sessionId - the session the submission belongs to.
   * @param requestId - the request identity the inbox reported back.
   * @returns how many threads the patch touched.
   */
  markDroppedForRequest(sessionId: SessionId, requestId: string): number {
    return this.patch(
      comment => comment.sessionId === sessionId && hasAsk(comment, requestId, ask => ask.dropped !== true),
      comment => ({
        ...comment,
        asks: (comment.asks ?? []).map(ask => (
          ask.requestId === requestId ? { ...ask, dropped: true } : ask
        )),
        updatedAt: Date.now(),
      }),
    )
  }

  /**
   * Record that a turn is over, so the questions it claimed stop looking pending.
   *
   * The turn number is the only handle the stopping event carries — no message, no
   * request id — so the questions that were claimed by that turn are the ones patched
   * (see `recordTurnForRequest`, which wrote the number down when the inbox claimed
   * them). A question whose turn is over and that the transcript shows no answer for
   * was cut off; the client says so instead of waiting forever. Nothing here decides
   * that: whether an answer exists is read from the transcript on each list read, so a
   * turn that stopped AFTER writing its answer keeps showing the answer.
   *
   * @param sessionId - the session whose turn ended.
   * @param turn - the turn that stopped.
   * @returns how many threads the patch touched.
   */
  markTurnEnded(sessionId: SessionId, turn: number): number {
    return this.patch(
      // Matched by TURN, not by request id: the stopping event names a turn and nothing
      // else, so the questions that recorded that turn when the inbox claimed them are
      // the ones it is about.
      comment => comment.sessionId === sessionId
        && (comment.asks ?? []).some(ask => ask.turn === turn && ask.ended !== true),
      comment => ({
        ...comment,
        asks: (comment.asks ?? []).map(ask => (ask.turn === turn ? { ...ask, ended: true } : ask)),
        updatedAt: Date.now(),
      }),
    )
  }

  /**
   * Apply one patch to every comment it matches, and schedule the affected sessions'
   * writes. The one mutation seam, so no caller has to remember to bump the revision
   * or to save: a patch that matches nothing changes nothing.
   * @param match - which comments to patch.
   * @param patch - the change to apply.
   * @returns how many comments changed.
   */
  private patch(match: (comment: CommentRecord) => boolean, patch: (comment: CommentRecord) => CommentRecord): number {
    const sessions = new Set<SessionId>()
    let changed = 0
    for (const comment of [...this.byId.values()]) {
      if (!match(comment)) continue
      this.byId.set(comment.id, patch(comment))
      sessions.add(comment.sessionId)
      changed += 1
    }
    if (changed > 0) {
      this.revision += 1
      for (const sessionId of sessions) this.save(sessionId)
    }
    return changed
  }

  /**
   * Wait for every scheduled write to settle.
   *
   * The mutators return as soon as a change is in memory — that is what lets an
   * entry's removal take its comments with it in the same tick — so this is how a
   * caller that must not lose the write (a dispose path, a test asserting the file)
   * waits for the disk.
   * @returns resolution after every session file's write chain has drained.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.tails.values()])
  }

  /**
   * Write one session's comments, serialized against that file's own writes.
   *
   * A rejected write is reported, not swallowed: the mutation already answered
   * "added" and the panel is drawing the thread from memory, so a silent failure means
   * the reader keeps writing into a thread that a restart will erase. The report rides
   * the list read (`persistError`) and the caller's logger, and a later write that works
   * retracts it the way the pending half retracts its own.
   *
   * A session whose file could not be read at load AND could not be moved aside is not
   * written at all: the only copy of that session's threads is the bytes the load could
   * not parse, and the store's memory holds just what has been added since. Writing the
   * memory-only view would TRUNCATE that copy — turning a read failure into a permanent
   * loss — so the save is refused and reported instead, which is what tells the reader
   * those comments are memory-only.
   * @param sessionId - the session whose file to rewrite.
   */
  private save(sessionId: SessionId): void {
    const file = fileOf(this.root, sessionId)
    const refused = this.unmovable.get(file)
    if (refused !== undefined) {
      this.reportPersist(file, `'${file}' ${refused}, so this session's comments are kept in memory rather than written over it`)
      return
    }
    const comments = this.list(sessionId)
    const task = async (): Promise<void> => {
      await writeJsonAtomic(file, { version: COMMENT_FILE_VERSION, comments })
    }
    const tail = this.tails.get(file) ?? Promise.resolve()
    const run = tail.then(task, task)
    this.tails.set(file, run.then(
      () => { this.reportPersist(file, undefined) },
      (error: unknown) => { this.reportPersist(file, `${file}: ${reasonOf(error)}`) },
    ))
  }

  /**
   * Publish the write state of one session's file, once per distinct report. Kept as its own
   * step so both the success and the failure of the chain above land in one place — the
   * retraction is what arms a later failure to be reported again.
   *
   * Keyed per file, so a healthy session's write cannot retract a broken one's report (see
   * `persistError`); the callback sees the aggregate, which is what rides the list read.
   * @param file - the session file the write was for.
   * @param message - the failure's text, or undefined when the write worked.
   */
  private reportPersist(file: string, message: string | undefined): void {
    const before = this.persistError()
    // Removed before (re-)inserting, so the map's order is the failures' order and the
    // last one is the most recent: that is the message `persistError` hands the reader.
    this.persistFailures.delete(file)
    if (message !== undefined) this.persistFailures.set(file, message)
    const after = this.persistError()
    if (before === after) return
    this.options.onPersistError?.(after)
  }
}
