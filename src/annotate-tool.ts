/**
 * The tool the agent calls to annotate code: one card, on the lines it names.
 *
 * This is the half a model reads. The rule it applies lives in `annotate.ts` and is a pure function of
 * the entry, the stored comments and the request; what is here is the model-facing surface — the name,
 * the argument schema, the sentence each outcome is handed back as — plus the two lookups that only
 * exist at run time (which session is calling, and which of ITS pending files the caller means).
 *
 * Why a tool at all, when the reader can already annotate: the reader annotates what they are looking
 * at, and the agent annotates what it is EXPLAINING. A call chain the reader asked to have walked, a
 * piece of code the agent wants to point at, a review finding with its evidence beside it — all of those
 * are "quote these lines and say something about them", which is exactly the card the panel already
 * draws. The card is the shared object: the agent's note is its first turn, the reader answers it in the
 * card, and that answer comes back to the agent as an ordinary `[评论]` message.
 *
 * The refusal the caller is most likely to meet is the one that makes the feature coherent: those lines
 * already belong to a card. Two cards hanging off the same lines cannot be told apart in the panel, so
 * the annotation is refused and the refusal NAMES the card holding them — the agent can then say its
 * piece in its own reply, or annotate other lines.
 *
 * The definition is built BY HAND rather than with the harness's `defineTool`: the host half of this
 * plugin imports nothing from the harness at runtime (its harness packages are services it asks for by
 * name, and types), the registry asks only for `name`, `description`, a raw argument schema and an
 * `output` with a schema and a `render`, and this way a build whose harness has no `dsh-tools` at all
 * still loads the plugin — the tool is simply never registered.
 *
 * @module dsh-diff-approval/src/annotate-tool
 */

import { annotateLines, refusalSummary } from './annotate.ts'
import type { AnnotationRefusal } from './annotate.ts'
import type { CommentRecord, PendingEntry } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The name the agent calls this by. Prefixed with the package: tool names share one flat namespace. */
export const ANNOTATE_TOOL_NAME = 'diff_approval_annotate'

/**
 * The routing line the model always sees, which has to carry the two things that decide whether it calls
 * this at all: what appears for the reader, and that the lines must be free.
 */
export const ANNOTATE_TOOL_DESCRIPTION = 'Annotate a few lines of a file in the review panel: the note '
  + 'becomes a card the user sees on those exact lines, and they can reply to it there. Use it to explain '
  + 'code the user is reading (a call chain is one card per step), to point at a piece of code while '
  + 'discussing it, or to record a review finding on the lines it is about. A file the panel is not '
  + 'showing yet is added to it, so this works whether or not anything in that file has changed. '
  + 'The card shows exactly the text you write, so how the note is worded — including any numbering the '
  + 'user needs to read it in order — is yours. '
  + 'The lines must not already be inside an existing card: that case is refused, and the refusal names '
  + 'the card holding them, so say it in your reply instead of annotating those lines again.'

/** One call's arguments, as the raw schema declares them. */
export interface AnnotateToolArgs {
  /** The file to annotate: a path of a file with pending changes, as the panel shows it. */
  path: string
  /** First line to annotate, 1-based, counted in the file as it reads now. */
  startLine: number
  /** Last line, inclusive. Absent means the one line `startLine` names. */
  endLine?: number | undefined
  /** What the card says. Kept short: the card is drawn line by line beside the code. */
  note: string
  /** Optional guard: the exact text the caller believes those lines hold (newline-joined). */
  quote?: string | undefined
}

/** What one call needs from the harness around it: whose session it belongs to, and the caller's life. */
export interface AnnotateToolContext {
  /** The session whose panel will show the annotation, or `undefined` when the call has no agent. */
  sessionId: SessionId | undefined
  /** Caller-owned cancellation. */
  signal: AbortSignal | undefined
}

/** What the plugin body does for one call: the sentence the model reads. */
export type AnnotateToolRun = (
  args: AnnotateToolArgs,
  context: AnnotateToolContext,
) => Promise<string>

/**
 * The argument schema, as raw JSON Schema.
 *
 * Raw rather than the harness's author DSL because the definition is hand-built (see the module
 * comment): the registry validates a hand-built definition's arguments against this subset, and the
 * model reads the same descriptions either way.
 */
export const ANNOTATE_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'startLine', 'note'],
  properties: {
    path: {
      type: 'string',
      description: 'The file to annotate: a path of a file with pending changes, as the review panel '
        + 'shows it (the path you read is fine too — the tail is matched).',
    },
    startLine: {
      type: 'integer',
      description: 'First line to annotate, 1-based, counted in the file as it reads NOW.',
    },
    endLine: {
      type: 'integer',
      description: 'Last line, inclusive. Omit to annotate the single line startLine names.',
    },
    note: {
      type: 'string',
      description: 'What the card says. Keep it to a few lines: the card is drawn line by line next to '
        + 'the code, and the reader can reply to it there.',
    },
    quote: {
      type: 'string',
      description: 'Optional guard: the exact text you believe those lines hold (newline-joined). A '
        + 'mismatch is refused with the text that is actually there, which catches a file that moved '
        + 'between your read and this call.',
    },
  },
} as const

/**
 * The definition to hand to `ctx.tools.register`.
 *
 * The canonical value is the sentence itself: this tool answers with prose because that is all the model
 * needs from it, and a one-field schema keeps the wire contract trivial.
 *
 * @param run - what fulfils one call; it never throws for a refusal (see below), only for a call that
 *        could not be carried out at all.
 * @returns the definition object.
 */
export function annotateToolDefinition(run: AnnotateToolRun): Record<string, unknown> {
  return {
    name: ANNOTATE_TOOL_NAME,
    description: ANNOTATE_TOOL_DESCRIPTION,
    parameters: ANNOTATE_TOOL_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: AnnotateToolArgs, exec: unknown): Promise<string> {
      const execution = exec as { agent?: { id?: SessionId } | undefined; signal?: AbortSignal } | undefined
      return run(args, {
        sessionId: execution?.agent?.id,
        signal: execution?.signal,
      })
    },
  }
}

/** How a path the caller wrote resolved against the session's pending files. */
export type EntryLookup =
  | { kind: 'one'; entry: PendingEntry }
  | { kind: 'none' }
  | { kind: 'many'; paths: readonly string[] }

/**
 * One path, folded to the form two spellings of the same file share: separators unified, trailing slash
 * dropped, case dropped (the panel and the agent can each write `C:\a\b.ts`, `C:/a/b.ts` or `c:\A\B.TS`).
 *
 * @param path - the path as written.
 * @returns the comparable form.
 */
export function foldPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * Which pending file the caller means by `path`.
 *
 * A model writing this argument usually hands back the path it just read — absolute, workspace-relative,
 * or with a slash style of its own. Exact match first, then a trailing-segment match; an AMBIGUOUS tail
 * is reported as such rather than guessed, because annotating the wrong file's lines is the one mistake
 * the reader would see as a bug in the panel.
 *
 * @param entries - the session's pending files.
 * @param path - the path the caller wrote.
 * @returns the one entry, or why it could not be picked.
 */
export function lookupEntry(entries: readonly PendingEntry[], path: string): EntryLookup {
  const asked = foldPath(path)
  if (asked === '') return { kind: 'none' }
  const exact = entries.filter(file => foldPath(file.path) === asked)
  if (exact.length === 1) return { kind: 'one', entry: exact[0]! }
  const byTail = entries.filter(file => {
    const folded = foldPath(file.path)
    return folded.endsWith(`/${asked}`) || asked.endsWith(`/${folded}`)
  })
  const candidates = exact.length > 1 ? exact : byTail
  if (candidates.length === 1) return { kind: 'one', entry: candidates[0]! }
  if (candidates.length === 0) return { kind: 'none' }
  return { kind: 'many', paths: candidates.map(file => file.path) }
}

/**
 * The sentence a refusal is handed back as.
 *
 * Every one of these is written for a model that has to choose what to do next, so each says what was
 * wrong AND what it can do instead. The lines are named back in the panel's own form (`path:from-to`),
 * which is the reference the reader sees in a card's header.
 *
 * @param refusal - what the rule refused.
 * @param path - the file the request named, for the reference.
 * @returns the sentence the caller reads.
 */
export function refusalText(refusal: AnnotationRefusal, path: string): string {
  switch (refusal.outcome) {
    case 'already-annotated': {
      const held = refusal.comment.text.replace(/\s+/g, ' ').slice(0, 60)
      const who = refusal.comment.author === 'agent' ? 'your own earlier annotation' : 'an existing comment'
      return `refused: ${path}:${refusal.start}-${refusal.end} is already inside ${who} `
        + `(id ${refusal.comment.id}, "${held}"). Two cards cannot hang off the same lines, so annotate `
        + 'different lines — or say this in your reply to the user, and mention that card if what you are '
        + 'saying is about it.'
    }
    case 'out-of-range':
      return `refused: ${path} has ${refusal.lines} lines, so ${refusal.startLine}-${refusal.endLine} is `
        + 'not in it. Read the file and use the line numbers it has now.'
    case 'quote-mismatch':
      return `refused: those lines do not read what "quote" said they do. They read:\n${refusal.actual}\n`
        + 'Read the file again and either drop "quote" or pass the text that is there now.'
    case 'range-too-wide':
      return `refused: ${refusal.lines} lines is more than the ${refusal.limit} one annotation may name. `
        + 'A card is a note on a few lines; a walkthrough is several cards, one per step.'
    case 'note-too-long':
      return `refused: the note is ${refusal.length} characters, over the ${refusal.limit} a card may `
        + 'carry. Put the long form in your reply to the user and keep the card to its point.'
    default:
      return 'refused: the note is empty, so the card would say nothing.'
  }
}

/**
 * What the host answers when the tool asks for a file to be listed.
 *
 * Listing is the host's job, not the tool's: only the host knows the session's workspace, its file
 * service, and the admission bookkeeping every listed entry goes through (this reuses the very seam the
 * panel's own "add this path" uses).
 */
export type ListFileOutcome =
  | { kind: 'listed'; entry: PendingEntry; added: boolean }
  | { kind: 'outside' }
  | { kind: 'missing' }
  | { kind: 'no-workspace' }

/** What the plugin body needs from the host, so one call can be fulfilled (and tested) without one. */
export interface AnnotateRunDeps {
  /**
   * Hydrate the host's stores before they are read: a call can arrive before the panel has ever listed
   * anything, and the comment store's own file has to be loaded before its contents can be checked for
   * an overlap. The same call the panel's own handlers make (see the `comment-add` seam).
   */
  ready?: (() => Promise<void>) | undefined
  /**
   * The pending entries of one session — the files that session's panel is showing.
   */
  entriesOf: (sessionId: SessionId) => readonly PendingEntry[]
  /**
   * Put one file into that session's list, when the panel is not showing it yet.
   *
   * A card hangs in the diff the reader is looking at, so a file has to be listed before it can carry
   * one — and an agent annotating the code a reader is studying is exactly the case where nothing in
   * that file has changed. This is the reader's own "add this path", reached by the agent instead.
   */
  listFile: (sessionId: SessionId, asked: string, signal: AbortSignal | undefined) => Promise<ListFileOutcome>
  /** Every comment the store holds for that session; the rule narrows them to the entry itself. */
  commentsOf: (sessionId: SessionId) => readonly CommentRecord[]
  /** Store the record: the comment store's own `add`, so the card is the same object as any other. */
  addComment: (record: CommentRecord) => unknown
  /** The plugin's logger, for the one line a refusal leaves behind on the host. */
  log?: ((message: string) => void) | undefined
}

/**
 * The sentence a file that could not be listed is refused with.
 *
 * All three are the workspace's rules rather than the annotation's: the panel can only show what the
 * session's workspace contains and the file service can read, and naming which one failed is what lets
 * the agent pick another file, or stop annotating that one.
 *
 * @param kind - why listing failed.
 * @param path - the path the caller named.
 * @returns the sentence the caller reads.
 */
export function unlistedText(kind: 'outside' | 'missing' | 'no-workspace', path: string): string {
  switch (kind) {
    case 'outside':
      return `refused: "${path}" is not inside this session's workspace, so the review panel cannot `
        + 'list it. Annotate a file of the workspace the user is working in.'
    case 'no-workspace':
      return `refused: this session has no workspace, so there is no file list to add "${path}" to.`
    default:
      return `refused: "${path}" could not be read as a text file, so there is nothing to annotate. `
        + 'Check the path (a workspace-relative path is fine) and try again.'
  }
}

/**
 * Build the body one tool call runs: resolve the file, apply the rule, store the record.
 *
 * A refusal is NOT an error: "those lines belong to a card" is an answer about the code, not a broken
 * call, and returning it as text keeps the turn going so the agent can act on it in the same step.
 * Throwing is left for what it means to the registry: the call could not be carried out at all.
 *
 * @param deps - the host lookups and the store write.
 * @returns the body to hand to {@link annotateToolDefinition}.
 */
export function annotateRun(deps: AnnotateRunDeps): AnnotateToolRun {
  return async (args, context) => {
    if (context.sessionId === undefined) {
      return 'refused: this call did not come from a session, so there is no panel to annotate in.'
    }
    await deps.ready?.()
    const sessionId = context.sessionId
    const lookup = lookupEntry(deps.entriesOf(sessionId), args.path)
    if (lookup.kind === 'many') {
      return `refused: "${args.path}" matches more than one pending file: ${lookup.paths.join(', ')}. `
        + 'Pass the full path of the one you mean.'
    }
    // Not in the panel's list yet: list it, the way the reader's own "add this path" does. An agent
    // explaining code the user is studying is exactly the case where NOTHING in the file has changed, so
    // the file has to be admitted before a card has anywhere to hang — and the agent is the one that
    // knows which file it means. The panel picks the new row up on its next read.
    let entry: PendingEntry
    let added = false
    if (lookup.kind === 'one') {
      entry = lookup.entry
    } else {
      const outcome = await deps.listFile(sessionId, args.path, context.signal)
      if (outcome.kind !== 'listed') {
        deps.log?.(`annotate: not-listed(${outcome.kind}) (${args.path})`)
        return unlistedText(outcome.kind, args.path)
      }
      entry = outcome.entry
      added = outcome.added
    }
    const result = annotateLines(
      {
        sessionId,
        entry,
        startLine: args.startLine,
        endLine: args.endLine,
        note: args.note,
        quote: args.quote,
      },
      deps.commentsOf(sessionId),
    )
    if (result.outcome !== 'annotated') {
      deps.log?.(`annotate: ${refusalSummary(result)} (${entry.path})`)
      return refusalText(result, entry.path)
    }
    deps.addComment(result.comment)
    const { startLine, endLine } = result.comment.anchor
    const span = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
    const listed = added ? ', and the file was added to the list' : ''
    return `annotated ${entry.path}:${span} (card ${result.comment.id}${listed}). The user sees it in the `
      + 'review panel now; they can reply to it there, and their reply reaches you as a [评论] message.'
  }
}
