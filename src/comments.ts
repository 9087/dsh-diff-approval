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
// Type-only: what one transcript read found for a question is the shape the answer fold takes, and
// `comment-ask.ts` owns it. Nothing here reaches that module at run time.
import type { AskRead } from './comment-ask.ts'

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

/**
 * One answer map as a comment record keeps it: keys that name a question, values that are the text
 * read for it. Narrowed here like every other stored field, so a file that has drifted (or been
 * hand-edited) cannot put a non-string where an answer's text is expected.
 * @param value - the stored value.
 * @returns the map, or undefined when there is nothing usable in it.
 */
function answersOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const map: Record<string, string> = {}
  for (const [requestId, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string') map[requestId] = text
  }
  return Object.keys(map).length === 0 ? undefined : map
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
  // The class the calling agent named for this annotation (see `CommentRecord.category`), validated like
  // every other field: this function is the only door a stored row comes back through, so a field it does
  // not copy is a field that survives exactly until the next host restart — the reader's dot would
  // vanish on the first reload, while the annotation it belongs to stayed. Trimmed here as well as in the
  // tool rule, so a hand-edited store with padding reads the same colour on every side.
  const category = typeof row.category === 'string' ? row.category.trim() : ''
  const asks = asksOf(row.asks)
  const answerSeen = answersOf(row.answerSeen)
  const answerNow = answersOf(row.answerNow)
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
    // The attention flags are read the same way the pending store reads its own dot: only a stored
    // `true` raises one, and a file written before they existed simply has neither.
    ...(row.unseen === true ? { unseen: true } : {}),
    ...(author === undefined ? {} : { author }),
    ...(category === '' ? {} : { category }),
    ...(typeof context === 'string' && context !== '' ? { quoteContext: context } : {}),
    ...(quoteLines.length > 0 ? { quoteLines } : {}),
    ...(asks.length > 0 ? { asks } : {}),
    ...(answerSeen === undefined ? {} : { answerSeen }),
    ...(answerNow === undefined ? {} : { answerNow }),
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
    const sessionId = record.sessionId
    asks.push({
      requestId,
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId: sessionId as SessionId } : {}),
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

/**
 * The scope one request may act on: which comment AUTHORS its lineage covers.
 *
 * This module knows nothing about lineages — the host walks them — so the rule arrives as a predicate,
 * built once per request from the lineage view the endpoint already has (`sameRoot`). Every read and
 * every guard takes it, which is what lets the store answer for a whole lineage without a second
 * lineage rule living down here beside the first.
 */
export type CommentScope = (author: SessionId) => boolean

/**
 * The transcript one question's answer will be written in.
 *
 * `ask.sessionId` when the question recorded one — every question asked since a lineage could read more
 * than one seat's threads does — otherwise the comment's own session, which is where a question asked
 * before that field existed necessarily went: the only session that could ask it was the one that wrote
 * the thread. ONE definition, shared by the answer fold, the turn-end match and the asker's grouping,
 * so the three cannot disagree about which transcript a question belongs to.
 * @param ask - the question.
 * @param comment - the thread it was asked in.
 * @returns the session whose transcript holds its answer.
 */
export function askTranscript(ask: CommentAsk, comment: CommentRecord): SessionId {
  return ask.sessionId ?? comment.sessionId
}

/** Whether two answer maps say the same thing, key for key and text for text. */
function sameAnswers(left: Readonly<Record<string, string>> | undefined, right: Readonly<Record<string, string>> | undefined): boolean {
  const one = Object.entries(left ?? {})
  const two = right ?? {}
  if (one.length !== Object.keys(two).length) return false
  return one.every(([requestId, text]) => two[requestId] === text)
}

/**
 * What ONE transcript currently says about the questions it owns, and which questions those are.
 *
 * Only the questions asked in that transcript are taken: a read is one session's, and a thread that
 * stored every other transcript's answers would be a copy of the conversation rather than its own
 * state. A question the read found no answer for is left out rather than stored empty, so a turn that
 * has not written yet cannot look like an answer that changed.
 * @param comment - the thread, for the questions it asked.
 * @param sessionId - the transcript being read.
 * @param answers - that transcript's answer text per question id.
 * @returns the thread's own question ids there, and the answers it holds for them.
 */
function answersInTranscript(
  comment: CommentRecord,
  sessionId: SessionId,
  answers: Readonly<Record<string, AskRead>>,
): { own: string[]; now: Record<string, string> } {
  const own: string[] = []
  const now: Record<string, string> = {}
  for (const ask of comment.asks ?? []) {
    if (askTranscript(ask, comment) !== sessionId) continue
    own.push(ask.requestId)
    const text = answers[ask.requestId]?.answer
    if (text !== undefined) now[ask.requestId] = text
  }
  return { own, now }
}

/**
 * One thread as a read of ONE transcript leaves it: its questions' current answers, and the dot up if
 * those say something the reader has not been told about.
 *
 * "New" is a DIFFERENCE, not a presence: the transcript answers a question once and hands back the
 * same text on every read afterwards, so "is there an answer" would leave the dot up forever, and
 * "did it change since the last read" would lose the answer entirely on the restart that forgot the
 * previous read. The comparison is against `answerSeen` — the baseline the reader's own visit writes
 * down — and it is STICKY: an answer that arrived while the dot was already up does not need to raise
 * it again. A question the transcript shows no answer for is absent here, so a log this process cannot
 * read, or a turn that has not written yet, leaves the thread exactly as it was.
 *
 * A thread may hold questions asked in MORE THAN ONE transcript (one card, two seats, each asking from
 * its own conversation). This fold owns only its own transcript's entries: it updates those, clears the
 * ones that transcript no longer shows an answer for, and leaves every other group exactly as that
 * group's own fold left it. Replacing the map wholesale would erase a second transcript's answers on
 * the next poll — the reader would watch an answer appear and then vanish.
 * @param comment - the thread as it stands.
 * @param sessionId - the transcript being read.
 * @param answers - that transcript's answer text per question id.
 * @returns what the record should hold after this read.
 */
function answerStateOf(comment: CommentRecord, sessionId: SessionId, answers: Readonly<Record<string, AskRead>>): CommentRecord {
  const { own, now } = answersInTranscript(comment, sessionId, answers)
  const answerNow: Record<string, string> = { ...(comment.answerNow ?? {}) }
  for (const requestId of own) {
    const text = now[requestId]
    if (text === undefined) delete answerNow[requestId]
    else answerNow[requestId] = text
  }
  const seen = comment.answerSeen ?? {}
  const lit = comment.unseen === true
    || Object.entries(answerNow).some(([requestId, text]) => seen[requestId] !== text)
  const next: CommentRecord = { ...comment, answerNow, unseen: lit }
  // `unseen` is only ever stored as `true` (see `CommentRecord`), so a thread with nothing to say
  // carries no flag at all rather than `false` — that is what keeps an old file byte-identical
  // through a read that changed nothing.
  if (!lit) delete next.unseen
  return next
}

/** Whether a patch would leave a comment exactly as it stands (the check that keeps a read from saving). */
function sameRecord(before: CommentRecord, after: CommentRecord): boolean {
  return before.unseen === after.unseen && sameAnswers(before.answerNow, after.answerNow)
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

  /**
   * The comments one SCOPE may read, oldest first (the order threads are read in).
   *
   * The scope is the caller's lineage rule (`CommentScope`), so a seat reads every thread of the seats
   * it shares a lineage root with — not only the ones it wrote. The files do not move for that: each
   * comment still lives in its author's file (see `save`), and the fan-out happens here, in memory,
   * over the one map `loadAll` filled from every file. That is what keeps a teammate's already-written
   * threads visible, with no migration.
   * @param scope - which comment authors this caller may read.
   * @returns the comments those authors wrote, oldest first.
   */
  list(scope: CommentScope): CommentRecord[] {
    const listed: CommentRecord[] = []
    for (const comment of this.byId.values()) {
      if (scope(comment.sessionId)) listed.push(comment)
    }
    return listed.sort((left, right) => left.createdAt - right.createdAt)
  }

  /** One author's own comments, oldest first: the WRITE-SET of that author's file (see `save`). */
  private authoredBy(sessionId: SessionId): CommentRecord[] {
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
   * Fold what ONE transcript now says into the threads that asked there, so a thread whose answer has
   * arrived (or been rewritten) wears the dot.
   *
   * The answers are DERIVED on every list read and never trusted from the file (see
   * `CommentRecord.answerNow`): the read is the only moment the host knows what the agent has said, and
   * the comparison it makes is against a baseline that survives a restart — a restart must not light a
   * dot the reader already cleared, and a read that changed nothing must not light one at all. That is
   * what `answerSeen` is, and why this writes a baseline only when the text actually moved.
   *
   * A question the transcript shows no answer for goes back to ABSENT rather than looking like an
   * empty answer: a log this process cannot read (or a turn that has not written yet) then leaves the
   * dot exactly as it was, instead of raising it on every poll.
   *
   * The patch's own key is the TRANSCRIPT, not the comment's author: a thread written in one seat can
   * hold a question asked from another (see `askTranscript`), and this read is that other seat's log.
   * Only the questions whose answer lives in `sessionId` are folded; a thread that also holds questions
   * asked elsewhere keeps those exactly as that transcript's own fold left them.
   *
   * @param sessionId - the transcript being folded, which owns the questions it is handed.
   * @param answers - the answer text per question id, as that transcript read it.
   * @returns whether any thread changed.
   */
  syncAnswers(sessionId: SessionId, answers: Readonly<Record<string, AskRead>>): boolean {
    // The transcript guard is the patch's own: the read is one session's, and a patch keyed on the
    // request ids alone would fold a second transcript's answers into questions that never asked there.
    const lit = (comment: CommentRecord): CommentRecord | undefined => {
      if (!(comment.asks ?? []).some(ask => askTranscript(ask, comment) === sessionId)) return undefined
      const next = answerStateOf(comment, sessionId, answers)
      return sameRecord(comment, next) ? undefined : next
    }
    return this.patch(
      comment => lit(comment) !== undefined,
      comment => lit(comment) ?? comment,
    ) > 0
  }

  /**
   * Mark one comment as looked at: the dot goes out, and the answers it currently shows become the
   * baseline a later rewrite is measured against — otherwise the next read would find the same answer
   * "new" again and put the dot straight back up.
   *
   * Deliberately its own seam rather than something a read does: only a reader action (the card coming
   * into view) may clear attention, and a read that cleared it would make the dot impossible to see.
   *
   * @param id - the comment the reader has in front of them.
   * @returns whether the comment existed.
   */
  markSeen(id: string): boolean {
    const before = this.byId.get(id)
    if (before === undefined) return false
    // The answers the comment holds NOW are the ones being acknowledged, so the baseline is taken from
    // the record's own last read rather than from a second transcript walk at this seam.
    const seen = before.answerNow ?? {}
    const next: CommentRecord = { ...before, answerSeen: { ...seen } }
    // `unseen` is only ever stored as `true`: the dot is the presence of the flag, and leaving a
    // `false` behind would make the file say something it has no state for.
    delete next.unseen
    // Nothing to take down and nothing to record: a save here would rewrite the session's file for a
    // request that changed nothing.
    if (before.unseen !== true && sameAnswers(before.answerSeen, next.answerSeen)) return false
    this.byId.set(id, next)
    this.revision += 1
    this.save(before.sessionId)
    return true
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
    if (before === undefined) return record
    const merged: CommentRecord = {
      ...record,
      createdAt: before.createdAt,
      ...(before.asks === undefined ? {} : { asks: before.asks }),
      ...(record.answerSeen === undefined && before.answerSeen !== undefined ? { answerSeen: before.answerSeen } : {}),
    }
    // Attention is the LIVE value's, never the written record's: the re-add this most often is is an
    // undo/redo replaying a snapshot, and a snapshot restores CONTENT — whether the reader has looked
    // at a thread is not content, so a stored `unseen` must not raise a dot the reader already cleared
    // (nor take one down that a newer answer just raised).
    delete merged.unseen
    if (before.unseen === true) merged.unseen = true
    return merged
  }

  /**
   * Drop one comment the caller's scope covers.
   * @param scope - which comment authors the caller may act on.
   * @param id - the comment to drop.
   * @returns whether it was there (and was in scope).
   */
  remove(scope: CommentScope, id: string): boolean {
    return this.removeMany(scope, [id]).length === 1
  }

  /**
   * Drop several comments in one write PER FILE that holds them.
   *
   * This is what a batch action needs and what a loop of `remove` calls cannot give it: each
   * `remove` saves the file, so ending ten comments wrote that file ten times — ten chances for a
   * transient failure to leave the store and the disk disagreeing about an action the reader asked
   * for once. The save happens only when something was actually dropped, so a batch that matches
   * nothing does not rewrite a file.
   *
   * Each record is removed from the file that HOLDS it, which is its author's (`save`), not the
   * caller's: once a lineage reads every seat's threads, a batch can name comments written by several
   * seats, and routing them all to the caller's file would leave the real files holding records the
   * store no longer has — the next load would resurrect every one of them.
   *
   * An id outside the scope, or one that is not here at all, is skipped rather than refused:
   * a batch is one request and the comments it names are the ones it can act on, and a comment
   * another client already ended is the state the caller was asking for anyway.
   *
   * @param scope - which comment authors the caller may act on.
   * @param ids - the comments to drop; a repeated id is one comment.
   * @returns the ids that were dropped, in the order given.
   */
  removeMany(scope: CommentScope, ids: readonly string[]): string[] {
    const removed: string[] = []
    const sessions = new Set<SessionId>()
    for (const id of ids) {
      if (removed.includes(id)) continue
      const comment = this.byId.get(id)
      if (comment === undefined || !scope(comment.sessionId)) continue
      this.byId.delete(id)
      removed.push(id)
      sessions.add(comment.sessionId)
    }
    if (removed.length === 0) return removed
    this.revision += 1
    for (const sessionId of sessions) this.save(sessionId)
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
   * The orphan sweep: prune every comment whose entry is not in `entryIds`, in MEMORY ONLY.
   *
   * The explicit `removeForEntry` is the primary path and the ONLY one that erases; this is the view
   * filter that guarantees no read is ever handed a comment naming a file the list does not carry. Run it
   * when the store loads and on every list read.
   *
   * WHY IT DOES NOT SAVE (2026-10-06, a data loss measured on the live host). The sweep used to write the
   * pruned state to the files, on the assumption that an entry absent here had been removed while the host
   * was running. That is only one of two ways an entry can be missing; the other is that its ADD never
   * reached `pending.json` — a pending entry is folded in memory and persisted on a later flush — and then
   * the sweep deleted the comments hanging on it AND saved the deletion. Three real annotations were gone
   * from the disk after a restart, not merely hidden: the reader's cards were written first and their
   * entries never landed. An entry that exists but is not on disk yet is not an orphan.
   *
   * A write would not even help the case it was added for. A second client must never be handed a comment
   * naming a file the same read no longer lists — that is a VIEW requirement, and the prune satisfies it.
   * Erasure belongs to the paths where a removal was actually ASKED FOR: `removeForEntry` (what the panel's
   * own drop calls, and it removes the comments in the same tick), and `remove`/`removeMany` for one
   * thread. A genuine orphan therefore stays on the disk, hidden, until the next boot that sees the entry
   * again — a row nobody reads is a smaller price than a reader's annotation nobody can recover.
   *
   * @param entryIds - every entry id the pending store currently holds.
   * @returns how many comments the view dropped.
   */
  retain(entryIds: ReadonlySet<string>): number {
    let removed = 0
    for (const comment of [...this.byId.values()]) {
      if (entryIds.has(comment.entryId)) continue
      this.byId.delete(comment.id)
      removed += 1
    }
    if (removed > 0) this.revision += 1
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
   * The ASKING session is recorded on the question, not taken from the comment: a thread another
   * seat wrote can be asked from this one, and the prompt then goes into the seat the human is
   * using, so that session's transcript is where the answer will appear (see `askTranscript`).
   *
   * Matched by comment ID alone: the request id is minted here and is globally unique, and the
   * caller has already checked that the thread is in its scope.
   *
   * @param sessionId - the transcript the question was submitted into.
   * @param id - the comment that was asked in.
   * @param requestId - the identity the submission carries into the transcript.
   * @param turn - the turn that claimed it, when that is already known.
   * @param text - the reader's own words, without the prompt's wrapper.
   * @returns whether the comment existed.
   */
  recordAsk(sessionId: SessionId, id: string, requestId: string, turn: number | undefined, text: string): boolean {
    return this.patch(
      comment => comment.id === id,
      comment => ({
        ...comment,
        asks: [...(comment.asks ?? []), { requestId, sessionId, text, ...(turn === undefined ? {} : { turn }) }],
        updatedAt: Date.now(),
      }),
    ) > 0
  }

  /**
   * Record the turn that claimed one question, as the agent's inbox reported it. Two
   * questions claimed by the same turn were answered together, which is a fact the
   * panel can state instead of guessing from transcript positions.
   *
   * Matched by REQUEST ID alone: it is minted per submission and globally unique, so it names the
   * question on its own — and a thread another seat wrote can hold a question asked from this seat,
   * which the old `comment.sessionId === sessionId` guard would refuse to write down.
   * @param requestId - the request identity the inbox reported back.
   * @param turn - the turn that claimed it.
   * @returns how many threads the patch touched.
   */
  recordTurnForRequest(requestId: string, turn: number): number {
    return this.patch(
      comment => hasAsk(comment, requestId, ask => ask.turn !== turn),
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
   * Record that a session dropped one question before a turn claimed it: nothing is
   * coming, and the reader is told rather than left waiting.
   *
   * Matched by REQUEST ID alone, for the same reason as `recordTurnForRequest`.
   * @param requestId - the request identity the inbox reported back.
   * @returns how many threads the patch touched.
   */
  markDroppedForRequest(requestId: string): number {
    return this.patch(
      comment => hasAsk(comment, requestId, ask => ask.dropped !== true),
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
   * Matched by TURN **within one transcript** (`askTranscript`), never by the thread's author: turn
   * numbers are only unique inside a session, so two sessions can both have a turn 7, and a thread that
   * holds questions from both would otherwise have one session's ending mark the other's questions
   * over — the reader would be told a question was cut off while its answer was still coming.
   * @param sessionId - the transcript whose turn ended.
   * @param turn - the turn that stopped.
   * @returns how many threads the patch touched.
   */
  markTurnEnded(sessionId: SessionId, turn: number): number {
    const endedHere = (ask: CommentAsk, comment: CommentRecord): boolean =>
      askTranscript(ask, comment) === sessionId && ask.turn === turn
    return this.patch(
      // Matched by TURN, not by request id: the stopping event names a turn and nothing
      // else, so the questions that recorded that turn when the inbox claimed them are
      // the ones it is about.
      comment => (comment.asks ?? []).some(ask => endedHere(ask, comment) && ask.ended !== true),
      comment => ({
        ...comment,
        asks: (comment.asks ?? []).map(ask => (endedHere(ask, comment) ? { ...ask, ended: true } : ask)),
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
   *
   * The write-set is the AUTHOR's own comments (`authoredBy`), never the wider read scope
   * (`list`): a read spans the lineage, but a file must hold exactly the comments whose
   * author it is named for — writing the scope's comments into one seat's file would
   * duplicate every other seat's threads on disk and, on the next load, in memory.
   * @param sessionId - the author whose file to rewrite.
   */
  private save(sessionId: SessionId): void {
    const file = fileOf(this.root, sessionId)
    const refused = this.unmovable.get(file)
    if (refused !== undefined) {
      this.reportPersist(file, `'${file}' ${refused}, so this session's comments are kept in memory rather than written over it`)
      return
    }
    const comments = this.authoredBy(sessionId)
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
