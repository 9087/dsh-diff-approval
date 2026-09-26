import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MAX_ANNOTATION_CHARS, MAX_ANNOTATION_LINES, annotateLines, annotationQuote, refusalSummary,
} from '../src/annotate.ts'
import { ANNOTATE_TOOL_NAME, annotateRun, annotateToolDefinition, foldPath, lookupEntry, refusalText, unlistedText } from '../src/annotate-tool.ts'
import type { ListFileOutcome } from '../src/annotate-tool.ts'
import { ANNOTATE_SKILL, ANNOTATE_SKILL_NAME } from '../src/annotate-skill.ts'
import type { CommentRecord, PendingEntry } from '../src/types.ts'

const S1 = SessionId('session-1')
const S2 = SessionId('session-2')

/** The file the agent is annotating: ten numbered lines, so a range is easy to read in an assertion. */
const LINES = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`)
const NEW_TEXT = `${LINES.join('\n')}\n`

/** One pending entry, as the store holds it (the shape the tool resolves a path against). */
function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    id: 'C:\\repo\\a.ts',
    sessionId: S1,
    path: 'C:\\repo\\a.ts',
    kind: 'edit',
    oldText: '',
    newText: NEW_TEXT,
    updatedAt: 1,
    sessionIds: [S1],
    ...overrides,
  }
}

/** One stored comment, quoting whatever range it is given. */
function comment(overrides: Partial<CommentRecord> & { startLine: number; endLine: number }): CommentRecord {
  const { startLine, endLine, ...rest } = overrides
  return {
    id: 'c-1',
    sessionId: S1,
    entryId: 'C:\\repo\\a.ts',
    path: 'C:\\repo\\a.ts',
    anchor: { startLine, endLine },
    quote: LINES.slice(startLine - 1, endLine).join('\n'),
    quoteContext: LINES.slice(Math.max(0, startLine - 2), endLine + 1).join('\n'),
    quoteLines: LINES.slice(startLine - 1, endLine).map((_line, index) => ({ new: startLine + index })),
    text: '这一行要注意。',
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  }
}

describe('the annotate rule', () => {
  it('writes the record the panel draws: quote, context, gutter numbers and the agent as author', () => {
    // The host holds the file's current text, not a diff, so the quote is read from the entry — never
    // taken from the caller — and the old-file side is left absent rather than guessed. `author` is what
    // makes the panel draw this as the agent's turn instead of putting the words in the reader's mouth.
    const result = annotateLines({
      sessionId: S1, entry: entry(), startLine: 3, endLine: 4,
      note: '  这两行是一次调用链的入口。  ', id: 'c-new', now: 42,
    }, [])
    expect(result).toMatchObject({
      outcome: 'annotated',
      comment: {
        id: 'c-new',
        sessionId: S1,
        entryId: 'C:\\repo\\a.ts',
        path: 'C:\\repo\\a.ts',
        anchor: { startLine: 3, endLine: 4 },
        quote: 'line-3\nline-4',
        quoteContext: 'line-2\nline-3\nline-4\nline-5',
        quoteLines: [{ new: 3 }, { new: 4 }],
        text: '这两行是一次调用链的入口。',
        author: 'agent',
        createdAt: 42,
        updatedAt: 42,
      },
    })
  })

  it('clamps the context at the file\'s own edges, as the client\'s row lookup does', () => {
    // One line at the very top has no line before it: the fingerprint is the quote plus the line after,
    // which is what the client's `contextAt` produces for the first row too.
    expect(annotationQuote(LINES, 1, 1)).toMatchObject({ quote: 'line-1', quoteContext: 'line-1\nline-2' })
    expect(annotationQuote(LINES, 10, 10)).toMatchObject({ quote: 'line-10', quoteContext: 'line-9\nline-10' })
  })

  it('refuses a note that says nothing, one that is too long, and a range that makes no sense', () => {
    const base = { sessionId: S1, entry: entry(), startLine: 2, note: '看这里' }
    expect(annotateLines({ ...base, note: '   ' }, [])).toEqual({ outcome: 'empty-note' })
    expect(annotateLines({ ...base, note: 'x'.repeat(MAX_ANNOTATION_CHARS + 1) }, []))
      .toEqual({ outcome: 'note-too-long', limit: MAX_ANNOTATION_CHARS, length: MAX_ANNOTATION_CHARS + 1 })
    expect(annotateLines({ ...base, startLine: 5, endLine: 4 }, []))
      .toEqual({ outcome: 'range-too-wide', limit: MAX_ANNOTATION_LINES, lines: 0 })
    expect(annotateLines({ ...base, startLine: 1, endLine: MAX_ANNOTATION_LINES + 1 }, []))
      .toEqual({ outcome: 'range-too-wide', limit: MAX_ANNOTATION_LINES, lines: MAX_ANNOTATION_LINES + 1 })
  })

  it('refuses a range the file does not have, and says how long the file is', () => {
    const result = annotateLines({ sessionId: S1, entry: entry(), startLine: 9, endLine: 12, note: '看这里' }, [])
    expect(result).toEqual({ outcome: 'out-of-range', lines: 10, startLine: 9, endLine: 12 })
  })

  it('refuses a quote guard that no longer matches, and hands back what is there now', () => {
    // The guard is what catches a file that moved between the agent's read and this call: the refusal
    // carries the text that IS there, so the caller can retry with the right lines in one step.
    const result = annotateLines({
      sessionId: S1, entry: entry(), startLine: 3, endLine: 3,
      note: '看这里', quote: 'line-3 as I read it',
    }, [])
    expect(result).toEqual({ outcome: 'quote-mismatch', actual: 'line-3' })
  })

  it('refuses the lines an existing comment already holds, and names that comment', () => {
    // The requirement this feature turns on: two cards cannot hang off the same lines, because the panel
    // cannot tell them apart. The refusal carries the holder's id, its lines, and its words.
    const held = comment({ startLine: 4, endLine: 6, id: 'c-held', text: '这里的顺序要改' })
    const result = annotateLines({
      sessionId: S1, entry: entry(), startLine: 6, endLine: 7, note: '看这里',
    }, [held])
    expect(result).toEqual({ outcome: 'already-annotated', comment: held, start: 4, end: 6 })
    expect(refusalText(result as never, 'C:\\repo\\a.ts')).toContain('is already inside an existing comment')
    expect(refusalText(result as never, 'C:\\repo\\a.ts')).toContain('c-held')
    expect(refusalText(result as never, 'C:\\repo\\a.ts')).toContain('4-6')
  })

  it('lets an outdated comment\'s lines be annotated, because it owns none', () => {
    // A comment whose quote is nowhere in the file is outdated: the panel draws it by the lines it was
    // written on and says so, and the code standing there now is free to annotate — the same rule the
    // panel applies to a selection (`discussionOverlapping`).
    const outdated = comment({ startLine: 2, endLine: 2, quote: 'line-2 as it was then' })
    expect(annotateLines({ sessionId: S1, entry: entry(), startLine: 2, endLine: 2, note: '看这里' }, [outdated]))
      .toMatchObject({ outcome: 'annotated' })
  })

  it('ignores comments of other entries, and ranges that merely touch', () => {
    const other = comment({ startLine: 3, endLine: 3, entryId: 'C:\\repo\\b.ts' })
    expect(annotateLines({ sessionId: S1, entry: entry(), startLine: 3, endLine: 3, note: '看这里' }, [other]))
      .toMatchObject({ outcome: 'annotated' })
    // Touching is not overlapping: the ranges are inclusive, so 1-3 and 4-5 are neighbours.
    const neighbour = comment({ startLine: 1, endLine: 3 })
    expect(annotateLines({ sessionId: S1, entry: entry(), startLine: 4, endLine: 5, note: '看这里' }, [neighbour]))
      .toMatchObject({ outcome: 'annotated' })
  })

  it('summarises a refusal for the host log in one tellable line', () => {
    expect(refusalSummary({ outcome: 'quote-mismatch', actual: 'x' })).toBe('quote-mismatch')
    expect(refusalSummary({ outcome: 'out-of-range', lines: 10, startLine: 9, endLine: 12 })).toBe('out-of-range(9-12 of 10)')
  })
})

describe('resolving the file the caller meant', () => {
  it('matches the path the caller read, however it is spelled, and refuses an ambiguous tail', () => {
    const one = entry()
    expect(lookupEntry([one], 'C:\\repo\\a.ts')).toMatchObject({ kind: 'one' })
    expect(lookupEntry([one], 'c:/repo/a.ts')).toMatchObject({ kind: 'one' })
    expect(lookupEntry([one], 'repo\\a.ts')).toMatchObject({ kind: 'one' })
    expect(lookupEntry([one], 'b.ts')).toEqual({ kind: 'none' })
    expect(lookupEntry([one], '')).toEqual({ kind: 'none' })
    // Two files can end the same way: guessing one of them would annotate the wrong file's lines.
    const second = entry({ id: 'C:\\other\\a.ts', path: 'C:\\other\\a.ts' })
    expect(lookupEntry([one, second], 'a.ts')).toEqual({ kind: 'many', paths: ['C:\\repo\\a.ts', 'C:\\other\\a.ts'] })
    expect(foldPath('C:\\Repo\\a.ts')).toBe('c:/repo/a.ts')
  })
})

describe('the annotate tool', () => {
  /** The definition, narrowed to what one call needs. */
  function tool(run: Parameters<typeof annotateToolDefinition>[0]) {
    return annotateToolDefinition(run) as {
      name: string
      description: string
      parameters: { required?: readonly string[]; properties?: Record<string, unknown> }
      output: { schema: unknown; render: (args: unknown, value: string) => unknown }
      execute: (args: unknown, exec: unknown) => Promise<string>
    }
  }

  it('declares itself the way the registry reads it', () => {
    // The registry only checks the name, the shape of `parameters` and an `output` with a schema and a
    // render; the model reads the same descriptions the schema carries.
    const definition = tool(async () => 'x')
    expect(definition.name).toBe(ANNOTATE_TOOL_NAME)
    expect(definition.description).toContain('is added to it')
    expect(definition.parameters.required).toEqual(['path', 'startLine', 'note'])
    expect(Object.keys(definition.parameters.properties ?? {})).toEqual(['path', 'startLine', 'endLine', 'note', 'quote'])
    expect(definition.output.schema).toEqual({ type: 'string' })
    expect(definition.output.render({}, 'done')).toEqual([{ type: 'text', text: 'done' }])
  })

  it('reads the calling session and the cancellation out of the execution it is handed', async () => {
    const run = vi.fn(async () => 'ok')
    const signal = new AbortController().signal
    await tool(run).execute({ path: 'a.ts', startLine: 1, note: 'n' }, { agent: { id: S1 }, signal })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts' }), { sessionId: S1, signal })
    // The session comes from the AGENT's id, not its session object: that id is the session the panel
    // is the panel of (`Agent.id`).
    await tool(run).execute({ path: 'a.ts', startLine: 1, note: 'n' }, {})
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { sessionId: undefined, signal: undefined })
  })

  it('stores the record and answers with where the card is', async () => {
    const added: CommentRecord[] = []
    const run = annotateRun({
      ready: async () => {},
      entriesOf: () => [entry()],
      listFile: async () => ({ kind: 'missing' }),
      commentsOf: () => [],
      addComment: (record) => { added.push(record) },
    })
    const answer = await run({ path: 'C:\\repo\\a.ts', startLine: 3, endLine: 4, note: '这两行是入口。' }, { sessionId: S1, signal: undefined })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ anchor: { startLine: 3, endLine: 4 }, text: '这两行是入口。', author: 'agent' })
    expect(answer).toContain('annotated C:\\repo\\a.ts:3-4')
    expect(answer).toContain(added[0]!.id)
  })

  it('hydrates the stores before it reads them', async () => {
    // A call can arrive before the panel has listed anything, so the comment store has to be loaded
    // first — otherwise the overlap check runs against an empty store and the card lands on top of one.
    const order: string[] = []
    const run = annotateRun({
      ready: async () => { order.push('ready') },
      entriesOf: () => { order.push('entries'); return [entry()] },
      listFile: async () => { order.push('list'); return { kind: 'missing' } },
      commentsOf: () => { order.push('comments'); return [] },
      addComment: () => { order.push('add') },
    })
    await run({ path: 'C:\\repo\\a.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(order).toEqual(['ready', 'entries', 'comments', 'add'])
  })

  it('lists the file it was asked about, and says so, when the panel is not showing it yet', async () => {
    // The case the tool exists for: the user is reading a file nothing has changed in, and the agent
    // annotates the code they are studying. There is no row in the panel to hang a card on until the file
    // is listed, so the tool asks the host to list it — the reader's own "add this path", by the agent —
    // and the answer says the file was added, because the reader is about to see a new row appear.
    const asked: Array<{ path: string; signal: AbortSignal | undefined }> = []
    const listed = entry({ id: 'C:\\repo\\notes.ts', path: 'C:\\repo\\notes.ts' })
    const added: CommentRecord[] = []
    const run = annotateRun({
      entriesOf: () => [entry()],
      listFile: async (_sessionId, path, signal) => {
        asked.push({ path, signal })
        return { kind: 'listed', entry: listed, added: true }
      },
      commentsOf: () => [],
      addComment: (record) => { added.push(record) },
    })
    const signal = new AbortController().signal
    const answer = await run(
      { path: 'notes.ts', startLine: 2, endLine: 2, note: '这里是入口。' },
      { sessionId: S1, signal },
    )
    expect(asked).toEqual([{ path: 'notes.ts', signal }])
    expect(answer).toContain('annotated C:\\repo\\notes.ts:2')
    expect(answer).toContain('added to the list')
    expect(added[0]).toMatchObject({ entryId: 'C:\\repo\\notes.ts', anchor: { startLine: 2, endLine: 2 } })
  })

  it('does not list anything when the file is already in the panel', async () => {
    // Annotating twice must never re-baseline a review in progress: a listed file is answered from the
    // list, and the listing seam is not even reached.
    const listFile = vi.fn(async () => ({ kind: 'missing' as const }))
    const run = annotateRun({
      entriesOf: () => [entry()],
      listFile,
      commentsOf: () => [],
      addComment: () => {},
    })
    const answer = await run({ path: 'C:\\repo\\a.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(answer).toContain('annotated C:\\repo\\a.ts:1')
    expect(answer).not.toContain('added to the list')
    expect(listFile).not.toHaveBeenCalled()
  })

  it('refuses what the workspace cannot list, in the workspace\'s own terms', async () => {
    // These are not annotation rules but workspace ones, so the sentences have to say which rule failed:
    // the agent can then pick another file instead of retrying the same call.
    const of = (outcome: ListFileOutcome) => annotateRun({
      entriesOf: () => [],
      listFile: async () => outcome,
      commentsOf: () => [],
      addComment: () => { throw new Error('nothing may be stored') },
    })
    const outside = await of({ kind: 'outside' })({ path: 'C:\\other\\x.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(outside).toContain('not inside this session\'s workspace')
    const missing = await of({ kind: 'missing' })({ path: 'C:\\repo\\x.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(missing).toContain('could not be read as a text file')
    const none = await of({ kind: 'no-workspace' })({ path: 'C:\\repo\\x.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(none).toContain('no workspace')
    // The three sentences are the exported surface, so they are also asserted directly.
    expect(unlistedText('outside', 'x.ts')).toContain('x.ts')
    expect(unlistedText('missing', 'x.ts')).toContain('x.ts')
    expect(unlistedText('no-workspace', 'x.ts')).toContain('x.ts')
  })

  it('still refuses an ambiguous path, and a call with no session, without listing anything', async () => {
    const listFile = vi.fn(async () => ({ kind: 'missing' as const }))
    const run = annotateRun({
      entriesOf: () => [entry(), entry({ id: 'C:\\other\\a.ts', path: 'C:\\other\\a.ts' })],
      listFile,
      commentsOf: () => [],
      addComment: () => {},
    })
    expect(await run({ path: 'a.ts', startLine: 1, note: 'n' }, { sessionId: S1, signal: undefined }))
      .toContain('matches more than one pending file')
    expect(await run({ path: 'a.ts', startLine: 1, note: 'n' }, { sessionId: undefined, signal: undefined }))
      .toContain('did not come from a session')
    expect(listFile).not.toHaveBeenCalled()
  })

  it('hands the refusal back as an answer rather than an error, and logs it', async () => {
    // A refusal is an answer about the code ("those lines belong to a card"), not a broken call: text
    // keeps the turn going so the agent can act on it in the same step.
    const logged: string[] = []
    const run = annotateRun({
      entriesOf: () => [entry()],
      listFile: async () => ({ kind: 'missing' }),
      commentsOf: () => [comment({ startLine: 2, endLine: 2, id: 'c-held' })],
      addComment: () => { throw new Error('must not store a refused call') },
      log: (message) => { logged.push(message) },
    })
    const answer = await run({ path: 'C:\\repo\\a.ts', startLine: 2, endLine: 3, note: 'n' }, { sessionId: S1, signal: undefined })
    expect(answer).toContain('refused')
    expect(answer).toContain('c-held')
    expect(logged).toEqual(['annotate: already-annotated(c-held 2-2) (C:\\repo\\a.ts)'])
  })
})

describe('the annotating skill', () => {
  it('is the catalog entry the tool description points at, in the registry\'s own name grammar', () => {
    // The catalog is what the agent sees before deciding to load the body: one line that says when this
    // is for. The name has to satisfy `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` or the registry throws on register.
    expect(ANNOTATE_SKILL_NAME).toBe('dsh-diff-approval-annotate')
    expect(ANNOTATE_SKILL.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(ANNOTATE_SKILL.description.length).toBeGreaterThan(0)
    expect(ANNOTATE_SKILL.whenToUse).toContain(ANNOTATE_TOOL_NAME)
    expect(ANNOTATE_SKILL.source).toBe('runtime')
    // The body is the long form: the calls the tool description cannot carry. It has to name the tool,
    // the refusal, and the companion skill whose rules the reader's reply arrives under.
    expect(ANNOTATE_SKILL.content).toContain(ANNOTATE_TOOL_NAME)
    expect(ANNOTATE_SKILL.content).toContain('refused')
    expect(ANNOTATE_SKILL.content).toContain('dsh-diff-approval-comment')
    expect(ANNOTATE_SKILL.content).toContain(String(MAX_ANNOTATION_LINES))
    expect(ANNOTATE_SKILL.content).toContain(String(MAX_ANNOTATION_CHARS))
    // …and the numbering rule a flow needs, which is the one thing the tool description cannot carry: the
    // number is the AGENT's own words in the note (there is no parameter for it), it goes on every step of
    // one flow, repeats are nobody's problem, and the agent's reply uses the same numbers.
    expect(ANNOTATE_SKILL.content).toContain('最前面')
    expect(ANNOTATE_SKILL.content).toContain('不需要唯一')
    expect(ANNOTATE_SKILL.content).not.toContain('order')
  })

  it('keeps the two skills distinct, so the catalog can tell them apart', () => {
    expect(S2).toBe(SessionId('session-2'))
    expect(ANNOTATE_SKILL_NAME).not.toBe('dsh-diff-approval-comment')
  })
})
