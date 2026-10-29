/**
 * The reader's own edits to a pending change: the version a keep accepts, and the diff the agent is
 * handed on its next call.
 *
 * This is the host half of the panel's edit mode, and it answers two questions the panel cannot:
 *
 * 1. WHAT THE FILE NOW HOLDS. A keep of an edited row writes the reader's version to disk and makes it
 *    the entry's after-content, so the row stays listed showing what the reader wrote rather than what
 *    the agent wrote (see `keep-edited` in `index.ts`).
 * 2. WHAT THE AGENT IS TOLD. The reader's change — a unified diff PER FILE, against the content the
 *    agent itself produced — is queued here and rendered into the agent's dynamic runtime context. That
 *    context is assembled fresh before each model call, so the diff is picked up by the agent's NEXT
 *    call and never starts one: no prompt is submitted, no turn is begun, and nothing is written to the
 *    transcript by this module. A request then consumes the queue (see `markDelivered`), so the
 *    snapshot returns to its own baseline afterwards while the appended message stays in the history
 *    exactly where the loop put it.
 *
 * Why the queue is durable: the keep happens in the panel, and the call that reads it may be a turn the
 * reader has not typed yet — or one after a host restart. A record that only lived in memory would be
 * lost in both cases, and the reader would be left believing the agent had been told.
 *
 * Why a SECOND keep on one path before delivery replaces the first instead of queueing beside it: the
 * diff has to say what the reader changed about what the agent wrote, not how the reader's own draft
 * moved between two presses. The first keep's `agentText` is therefore kept as the baseline, so two
 * edits before the next call still arrive as one cumulative diff against the agent's version — "exactly
 * what the user changed, and nothing it already wrote".
 *
 * The records live in one JSON file per session, a sibling of `workspaces/` and `comments/` (see
 * {@link keptEditsDirFor}), staged and atomically renamed like every other store here.
 *
 * @module dsh-diff-approval/src/kept-edits
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { structuredPatch } from 'diff'
import { writeJsonAtomic } from './atomic-write.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** On-disk envelope of one session's undelivered kept edits. */
const KEPT_EDITS_FILE_VERSION = 1

/** This state directory's name, a sibling of `workspaces/` and `comments/`. */
const KEPT_EDITS_SUBDIR = 'kept-edits'

/** Lines of context each hunk of an appended diff carries on both sides. */
export const UNIFIED_DIFF_CONTEXT_LINES = 3

/**
 * The longest diff one file may append to the agent's context, in characters.
 *
 * A bounded context is the difference between a review that works and a turn that cannot be sent: a
 * reader who rewrote a very large file would otherwise append its whole diff to every following call,
 * and the token budget is not this plugin's to spend. The cut is said IN the text, so the model is told
 * what it is not seeing rather than quietly handed a partial diff as if it were the whole change.
 */
export const MAX_KEPT_EDIT_DIFF_CHARS = 40_000

/** What the appended block says before the diffs: one sentence of provenance, nothing else. */
const KEPT_EDITS_LEAD_IN = 'The user edited and kept the pending change(s) below while reviewing them. '
  + 'Each diff is the user\'s version against the content you produced for that file, and the files on '
  + 'disk now hold the user\'s version.'

/** One file's kept edit, as the store holds it. */
export interface KeptEditRecord {
  /** The file, as the pending entry's own key (its absolute path). */
  path: string
  /** The path the diff's own headers print: workspace-relative when the file is inside the workspace. */
  displayPath: string
  /**
   * The content the agent had produced when the reader STARTED editing: the diff's before side.
   *
   * Kept per path so a second keep before the next call stays a diff against the agent's version
   * (see the module note).
   */
  agentText: string
  /** The reader's kept version: the diff's after side, and what the file now holds. */
  userText: string
  /** The rendered unified diff, ready to append to the agent's context. */
  diff: string
  /** Epoch milliseconds of the latest keep for this path. */
  at: number
}

/** One keep's input: the file, its display path, and the two sides of the diff. */
export interface KeptEditKeep {
  /** The pending entry's key (its absolute path). */
  path: string
  /** The workspace-relative path the diff's headers print. */
  displayPath: string
  /** The after-content the entry carried before the reader's edit. */
  agentText: string
  /** The reader's kept version. */
  userText: string
}

/** The on-disk envelope of one session's queue. */
interface KeptEditsFile {
  version: number
  /** The session the file belongs to, so a load does not have to unescape a filename. */
  sessionId: string
  records: KeptEditRecord[]
}

/** One session's queue: its records, whether it was read yet, and that file's write chain. */
interface SessionQueue {
  records: KeptEditRecord[]
  loaded: boolean
  /** The load in flight, when one is; a second caller waits on it rather than reading twice. */
  loading: Promise<void> | undefined
  /** The file's own write chain, so writes land in mutation order. */
  tail: Promise<void>
}

/** The comment directory that belongs to a pending-storage root. */
export function keptEditsDirFor(storageRoot: string): string {
  return basename(storageRoot) === 'workspaces'
    ? join(dirname(storageRoot), KEPT_EDITS_SUBDIR)
    : join(storageRoot, KEPT_EDITS_SUBDIR)
}

/** The file one session's queue is stored in (the id, made filename-safe). */
function fileOf(root: string, sessionId: SessionId | string): string {
  return join(root, `${encodeURIComponent(String(sessionId))}.json`)
}

/**
 * One file's change as a unified diff, or `''` when the two sides are the same text.
 *
 * `diff`'s own `structuredPatch` does the line matching (and carries the `\ No newline at end of file`
 * marker in a hunk's lines, where a unified diff expects it); the header and hunk lines are written here
 * rather than through `createTwoFilesPatch` because that helper also emits its own `Index:` and `====`
 * preamble, which is a JavaScript convenience rather than part of the format the agent should read.
 *
 * @param displayPath - the path the diff's `---`/`+++` headers print.
 * @param before - the content the agent produced.
 * @param after - the reader's kept version.
 * @returns the unified diff, one hunk list per run of changes, or `''` for identical text.
 */
export function unifiedDiffFor(displayPath: string, before: string, after: string): string {
  if (before === after) return ''
  const patch = structuredPatch(
    `a/${displayPath}`,
    `b/${displayPath}`,
    before,
    after,
    '',
    '',
    { context: UNIFIED_DIFF_CONTEXT_LINES },
  )
  if (patch.hunks.length === 0) return ''
  const lines = [`--- a/${displayPath}`, `+++ b/${displayPath}`]
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    lines.push(...hunk.lines)
  }
  return lines.join('\n')
}

/**
 * Cut one diff down to the context budget, saying so in the text.
 *
 * The cut is on a LINE boundary, so a hunk header is never left claiming counts the visible lines no
 * longer have; the marker names how much was left out, and the model is expected to ask or read the
 * file rather than assume it has the whole change.
 *
 * @param diff - the rendered diff.
 * @returns the diff, or its head plus the truncation marker.
 */
export function boundedDiff(diff: string): string {
  if (diff.length <= MAX_KEPT_EDIT_DIFF_CHARS) return diff
  const head = diff.slice(0, MAX_KEPT_EDIT_DIFF_CHARS)
  const lastBreak = head.lastIndexOf('\n')
  const kept = lastBreak === -1 ? head : head.slice(0, lastBreak)
  const left = diff.length - kept.length
  return `${kept}\n… the rest of this diff (${left} more characters) is omitted; read the file for the full change.`
}

/**
 * The text one session's queue appends to the agent's context, or `''` when nothing is queued.
 *
 * A per-FILE section is what makes the block readable: the diff's own `---`/`+++` headers name the file,
 * but the model reads a block of several files more reliably when each one starts with a heading that
 * is not part of the patch.
 *
 * @param records - the undelivered kept edits, oldest first.
 * @returns the context block, or `''`.
 */
export function renderKeptEdits(records: readonly KeptEditRecord[]): string {
  if (records.length === 0) return ''
  const sections = records.map((record) => `### ${record.displayPath}\n${record.diff}`)
  return `${KEPT_EDITS_LEAD_IN}\n\n${sections.join('\n\n')}`
}

/** Narrow one stored record; a malformed row is skipped rather than failing the load. */
function recordOf(value: unknown): KeptEditRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const { path, displayPath, agentText, userText, diff, at } = row
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof displayPath !== 'string' || displayPath.length === 0) return undefined
  if (typeof agentText !== 'string' || typeof userText !== 'string') return undefined
  if (typeof diff !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return undefined
  return { path, displayPath, agentText, userText, diff, at }
}

/** Parse one stored session file; an unknown version or shape is refused, not guessed at. */
function fileOfJson(file: string, value: unknown): KeptEditsFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`kept-edits file '${file}' is not an object`)
  }
  const row = value as Record<string, unknown>
  if (row.version !== KEPT_EDITS_FILE_VERSION) {
    throw new Error(`kept-edits file '${file}' has unsupported version ${JSON.stringify(row.version)}`)
  }
  if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) {
    throw new Error(`kept-edits file '${file}' names no session`)
  }
  if (!Array.isArray(row.records)) {
    throw new Error(`kept-edits file '${file}' has no record list`)
  }
  return { version: KEPT_EDITS_FILE_VERSION, sessionId: row.sessionId, records: row.records.flatMap((entry) => recordOf(entry) ?? []) }
}

/**
 * The undelivered kept edits of every session, one JSON file per session.
 *
 * The class owns no logger: the host wires {@link KeptEditQueueOptions.onPersistError} to `ctx.logger`,
 * which is what turns "the queue could not be written" from a fact only the filesystem knew into
 * something the host's log says — a restart between the keep and the agent's next call would otherwise
 * lose the diff silently.
 */
export class KeptEditQueue {
  private readonly sessions = new Map<string, SessionQueue>()

  /**
   * @param root - directory holding one `<sessionId>.json` per session.
   * @param options - the failure seam.
   */
  constructor(private readonly root: string, private readonly options: KeptEditQueueOptions = {}) {}

  /**
   * Read every session's queue into memory.
   *
   * Run at start-up by the host as well as from the first read, because a CONTEXT provider is
   * synchronous: the assembly that asks for the text cannot wait for a read, so what is on disk has to
   * be in memory before the first model call. A file that cannot be read is reported and skipped — one
   * bad queue must not cost every session's — and the queue then starts empty for that session, which
   * is the same state a reader who never edited anything has.
   * @returns how many records were loaded.
   */
  async loadAll(): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let loaded = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(this.root, name)
      let value: unknown
      let parsed: KeptEditsFile | undefined
      try {
        value = await readJson(file)
        if (value === undefined) continue
        parsed = fileOfJson(file, value)
      } catch (error: unknown) {
        this.options.onLoadSkipped?.(file, reasonOf(error))
        continue
      }
      if (parsed === undefined) continue
      const state = this.stateOf(parsed.sessionId)
      state.records = parsed.records
      state.loaded = true
      loaded += parsed.records.length
    }
    return loaded
  }

  /**
   * Make one session's queue readable, reading it if it never was.
   * @param sessionId - the session whose queue is wanted.
   * @returns resolution once the records are in memory.
   */
  async ensureLoaded(sessionId: SessionId): Promise<void> {
    const state = this.stateOf(sessionId)
    if (state.loaded) return
    state.loading ??= (async () => {
      const file = fileOf(this.root, sessionId)
      try {
        const value = await readJson(file)
        const parsed = value === undefined ? undefined : fileOfJson(file, value)
        if (parsed !== undefined) state.records = parsed.records
      } catch (error: unknown) {
        this.options.onLoadSkipped?.(file, reasonOf(error))
      }
      state.loaded = true
    })()
    await state.loading
  }

  /**
   * One session's queued records, oldest first.
   *
   * Synchronous by design: the agent's dynamic context is assembled by a provider that cannot await, so
   * the host preloads ({@link loadAll}) and this is what that provider reads.
   * @param sessionId - the session whose queue is wanted.
   * @returns the records, or an empty list when nothing was ever kept.
   */
  recordsOf(sessionId: SessionId | string): readonly KeptEditRecord[] {
    return this.sessions.get(String(sessionId))?.records ?? []
  }

  /**
   * The context block one session's queue appends, or `''` when it has nothing queued.
   * @param sessionId - the session whose queue is wanted.
   * @returns the rendered block.
   */
  textFor(sessionId: SessionId | string): string {
    return renderKeptEdits(this.recordsOf(sessionId))
  }

  /**
   * Queue one kept edit, replacing an earlier one for the same path so the diff stays cumulative.
   *
   * The baseline is the FIRST keep's `agentText` for that path, which is the content the agent produced
   * before the reader touched it — a second keep's own `agentText` is the reader's previous version, and
   * using it would turn one user change into a chain of increments the agent has to reassemble.
   * @param sessionId - the session whose agent will be told.
   * @param keep - the keep.
   * @returns the record as stored (its `diff` and `at` are the store's).
   */
  async keep(sessionId: SessionId, keep: KeptEditKeep): Promise<KeptEditRecord> {
    await this.ensureLoaded(sessionId)
    const state = this.stateOf(sessionId)
    const index = state.records.findIndex(record => record.path === keep.path)
    const agentText = index === -1 ? keep.agentText : state.records[index]!.agentText
    const record: KeptEditRecord = {
      path: keep.path,
      displayPath: keep.displayPath,
      agentText,
      userText: keep.userText,
      diff: boundedDiff(unifiedDiffFor(keep.displayPath, agentText, keep.userText)),
      at: Date.now(),
    }
    if (index === -1) state.records.push(record)
    else state.records[index] = record
    this.save(sessionId)
    return record
  }

  /**
   * Drop one session's queue after a model request has been assembled with it.
   *
   * Called at the request, not at the assembly: an assembly that is never sent (a rejected step, a turn
   * that stops before its request) has told the agent nothing, so the diff has to stay queued for the
   * call that does happen.
   * @param sessionId - the session the request belongs to.
   */
  async markDelivered(sessionId: SessionId | string): Promise<void> {
    const state = this.sessions.get(String(sessionId))
    if (state === undefined || state.records.length === 0) return
    state.records = []
    this.save(sessionId)
  }

  /**
   * Drop what is queued about one path, in every session, because the path's own content moved.
   *
   * A revert, a bulk revert, a deleted file: the reader's version no longer on disk means the queued diff
   * would announce a change that is gone. Only the drops need this; a change that merely REWRITES the
   * file to something else is filtered at assembly, where the pending entry itself can be asked whether
   * it still holds the recorded version.
   * @param path - the entry path whose records leave the queues.
   * @returns whether anything was queued for it.
   */
  withdraw(path: string): boolean {
    let removed = false
    for (const [key, state] of this.sessions) {
      const kept = state.records.filter(record => record.path !== path)
      if (kept.length === state.records.length) continue
      state.records = kept
      removed = true
      this.save(key)
    }
    return removed
  }

  /**
   * Wait for every queued write to drain. A mutator answers as soon as the change is in memory; this is
   * how a caller that must not lose the write (a dispose path, a test asserting the file) waits for disk.
   * @returns resolution after every session file's write chain has drained.
   */
  async settled(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(state => state.tail))
  }

  /** One session's queue state, created on first use. */
  private stateOf(sessionId: SessionId | string): SessionQueue {
    const key = String(sessionId)
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = { records: [], loaded: false, loading: undefined, tail: Promise.resolve() }
      this.sessions.set(key, state)
    }
    return state
  }

  /**
   * Write one session's queue, serialized against that file's own writes.
   * @param sessionId - the session whose file to rewrite.
   */
  private save(sessionId: SessionId | string): void {
    const state = this.stateOf(sessionId)
    const file = fileOf(this.root, sessionId)
    const payload: KeptEditsFile = {
      version: KEPT_EDITS_FILE_VERSION,
      sessionId: String(sessionId),
      records: state.records,
    }
    const task = async (): Promise<void> => {
      await writeJsonAtomic(file, payload)
    }
    state.tail = state.tail.then(task, task).then(
      () => { this.options.onPersistError?.(undefined) },
      (error: unknown) => { this.options.onPersistError?.(`${file}: ${reasonOf(error)}`) },
    )
  }
}

/** How a caller hears about an unreadable or unwritable queue file. */
export interface KeptEditQueueOptions {
  /** One session's file could not be read; the queue starts empty for it. */
  onLoadSkipped?: ((file: string, reason: string) => void) | undefined
  /** The last write state, or `undefined` once a write works again. */
  onPersistError?: ((message: string | undefined) => void) | undefined
}

/** Read one JSON file, with a missing file read as `undefined`. */
async function readJson(file: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as unknown
}

/** One error as the sentence a log or a report can carry. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
