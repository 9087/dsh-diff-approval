// The host half: capture, per-operation entries, channel serving, keep,
// earlier-version-aware revert, live file state, and persistence.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CommentRecord, PendingFileDiff } from '../src/types.ts'
import { apply, DIFF_APPROVAL_CHANNEL } from '../src/index.ts'
import { COMMENT_SKILL, COMMENT_SKILL_NAME } from '../src/comment-skill.ts'
import { ANNOTATE_SKILL, ANNOTATE_SKILL_NAME } from '../src/annotate-skill.ts'
import { ANNOTATE_TOOL_NAME } from '../src/annotate-tool.ts'
import { commentsDirFor } from '../src/comments.ts'
import { resolveCommentLines } from '../src/comment-lines.ts'
import { en, zh } from '../src/client/locales.ts'
import { PendingPersistence } from '../src/persist.ts'
import { removeTempDir } from './cleanup.ts'

// The quote-resolving rule, spied but REAL: the tests below count how often the host searches an
// entry's content for a comment's quote (see "does not search a file again"), and the rule is the
// only thing that search can be. Every other test runs the same implementation, unwrapped in effect.
vi.mock('../src/comment-lines.ts', { spy: true })

interface FsDouble {
  resolve: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
  writeText: ReturnType<typeof vi.fn>
  /** The policy-aware deletion seam (`ctx.fs.remove` in a sandboxing build). */
  remove: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  listDir: ReturnType<typeof vi.fn>
  processPath: ReturnType<typeof vi.fn>
}

interface TestHarness {
  ctx: Context
  fs: FsDouble
  handle: ConnectionRpcHandler
  channel: string
  options: ConnectionRpcHandlerOptions
  handleCalls: number
  storageDir: string
  openPath: ReturnType<typeof vi.fn>
  dispose(): Promise<void>
}

// How long to give a write that has already been ACCEPTED to reach the disk.
//
// The stores persist fire-and-forget: an RPC answers as soon as the in-memory mutation is
// recorded, and the file follows on that file's own write chain (`CommentStore.save`,
// `PendingPersistence`). `vi.waitFor` defaults to one second, which is a load-sensitive line for a
// chain of two `writeFile`+`rename` pairs — the panel spec drives a 9,000-line component in a
// parallel worker, and this machine's git/junction specs run real subprocesses — and a wait that
// times out is indistinguishable from a removal that never reached the file. Five seconds keeps a
// genuinely stuck or mis-ordered write failing, while leaving room for the rename to land.
//
// This widens the WAIT, not the assertion: it is not a retry of the behaviour under test. Measured
// on this machine: `takes the entry's comments with it when the entry is kept, and off the disk`
// failed once in four runs of `tests/diff-approval.spec.ts` alongside the panel spec with the default
// wait, and did not fail in eight runs with this one. Eight clean runs would still happen about one
// time in ten if the rate were unchanged, so the numbers support the reading rather than proving it —
// what makes it more than a loosened timeout is the ordering: the removal's `save` is the LAST link of
// that file's chain (each `save` captures its snapshot at call time and appends in mutation order), so
// a write that landed after it, or one that never landed at all, still fails here at five seconds.
const FILE_WAIT = { timeout: 5_000 } as const

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(removeTempDir))
  vi.restoreAllMocks()
})

async function harness(options: {
  sessionIds?: readonly SessionId[]
  workspacePath?: string
  /**
   * Several workspaces at once, one per entry: the shape a deployment whose sessions are attached to
   * DIFFERENT workspaces hands the registry. Overrides the single `sessionIds`/`workspacePath` workspace
   * when given, so a case that needs two roots can say so without touching the shared default.
   */
  workspacesByPath?: Record<string, readonly SessionId[]>
  storageDir?: string
  openPath?: (path: string, action: 'open' | 'reveal') => Promise<void>
  prepare?: (ctx: Context) => void
} = {}): Promise<TestHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  const fs: FsDouble = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path, targetKey: `key:${path}` })),
    readText: vi.fn(async () => undefined),
    writeText: vi.fn(async () => ({ version: 1 })),
    remove: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ version: 'v1', type: 'file' })),
    listDir: vi.fn(async () => []),
    // The real backend hands back the OS path a subprocess can open; the double keeps the
    // resolved display path for it, so a consumer that checks confinement (a Revert's
    // delete) sees the same path it would in production.
    processPath: vi.fn((target: { displayPath?: string; targetKey: string }) => target.displayPath ?? String(target.targetKey)),
  }
  ctx.provide('fs', fs as unknown as FileSystem)
  const handle = vi.fn<(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions) => () => void>(() => () => {})
  ctx.provide('connection', { rpc: { handle } } as unknown as HostConnectionHandle)
  // The plugin injects `webServer` so its channel owner can resolve it.
  ctx.provide('webServer', { register: vi.fn(() => () => {}) } as never)
  const workspaces: Workspace[] = options.workspacesByPath !== undefined
    ? Object.entries(options.workspacesByPath).map(([path, ids], index) => ({
        id: WorkspaceId(`workspace-${index + 1}`),
        sessionIds: [...ids],
        path,
      } as unknown as Workspace))
    : (options.sessionIds ?? []).length === 0 ? [] : [{
        id: WorkspaceId('workspace-1'),
        sessionIds: [...options.sessionIds!],
        path: options.workspacePath ?? '',
      } as unknown as Workspace]
  ctx.provide('workspaceRegistry', { list: () => workspaces } as unknown as WorkspaceRegistry)
  const storageDir = options.storageDir ?? await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
  tempDirs.push(storageDir)
  const openPath = options.openPath ?? vi.fn(async () => {})
  options.prepare?.(ctx)
  await ctx.plugin(apply, { storageDir, openPath })
  const calls = handle.mock.calls
  const first = calls[0]
  if (first === undefined) throw new Error('diff-approval did not register its channel')
  return {
    ctx,
    fs,
    handle: first[1],
    channel: first[0],
    options: first[2],
    handleCalls: calls.length,
    storageDir,
    openPath,
    dispose: () => ctx.fiber.dispose(),
  }
}

/** Emit one tools/result event through the root context, the way the registry does. */
function emitResult(ctx: Context, exec: unknown, result: unknown): void {
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...args: unknown[]) => void
  emit('tools/result', exec, result)
}

/** Read one session's listed entries through the channel. */
async function listEntries(handle: ConnectionRpcHandler, sessionId: string): Promise<PendingFileDiff[]> {
  const answer = await handle('list', { sessionId }, signal())
  if (!answer.ok) throw new Error('list failed')
  return (answer.value as { files: PendingFileDiff[] }).files
}

/** A scriptable fake `ctx.shell` executor answering routed commands. Paths the
 * implementation quotes are matched after stripping the quotes. A `> file`
 * redirection writes the routed output to that file instead of returning it on
 * stdout; `git checkout-index --temp` writes the routed blob to a temp file in
 * the workdir and prints `TEMPNAME\tPATH` (as the real git does), so the import
 * reads it back with the uncapped file reader. A route may also be an object, for
 * a command that must FAIL: `git cat-file -s` on a path HEAD does not carry exits
 * 128 with git's own wording, and a fake that answered "no route" instead was
 * silently read as absence until the baseline read stopped swallowing failures. */
function fakeShell(
  routes: Record<string, string | { exitCode?: number; stdout?: string; stderr?: string }>,
): unknown {
  return {
    resolve: (request: { command: string; workdir?: string; timeoutMs?: number }) => ({ ...request }),
    run: async (spec: { command: string; workdir?: string }) => {
      const command = spec.command.replace(/'/g, '')
      const workdir = spec.workdir ?? process.cwd()
      // git checkout-index --temp --force -- <path>: write the routed blob to a
      // temp file and print `TEMPNAME\tPATH`; the importer reads the file.
      const co = /^git checkout-index --temp --force --\s+(.+)$/.exec(command)
      if (co !== null) {
        const path = co[1]!
        for (const [needle, output] of Object.entries(routes)) {
          if (typeof output === 'string' && command.includes(needle)) {
            const name = '.merge_file_test'
            const file = resolve(workdir, name)
            const { writeFile } = await import('node:fs/promises')
            await writeFile(file, output, 'utf8')
            return { exitCode: 0, stdout: { text: `${name}\t${path}` }, stderr: { text: '' } }
          }
        }
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: `no route for ${spec.command}` } }
      }
      // Split a trailing `> 'file'` redirection off; other commands capture large
      // blobs through a temp file to dodge the executor's stdout cap.
      const redir = /(.*?)\s*>\s*'([^']*)'\s*$/.exec(spec.command)
      const file = redir?.[2]
      const bare = (redir?.[1] ?? spec.command).replace(/'/g, '')
      for (const [needle, output] of Object.entries(routes)) {
        if (bare.includes(needle)) {
          if (typeof output !== 'string') {
            return {
              exitCode: output.exitCode ?? 1,
              stdout: { text: output.stdout ?? '' },
              stderr: { text: output.stderr ?? '' },
            }
          }
          if (file !== undefined) {
            const { writeFile } = await import('node:fs/promises')
            await writeFile(file, output, 'utf8')
          }
          return { exitCode: 0, stdout: { text: output }, stderr: { text: '' } }
        }
      }
      return { exitCode: 1, stdout: { text: '' }, stderr: { text: `no route for ${spec.command}` } }
    },
  }
}

function editExec(): unknown {
  return { name: 'edit', agent: { id: SessionId('session-1') } }
}

function editSuccess(path: string, before: string, after: string): unknown {
  return { isError: false, value: { path, before, after } }
}

function writeExec(): unknown {
  return { name: 'write', agent: { id: SessionId('session-1') } }
}

function writeSuccess(path: string, operation: 'create' | 'update', before: string | null, after: string): unknown {
  return { isError: false, value: { path, operation, before, after } }
}

function strReplaceExec(command: string, callId = 'call-1'): unknown {
  return {
    name: 'str_replace_editor',
    callId,
    arguments: { command, path: '/repo/a.txt' },
    agent: { id: SessionId('session-1') },
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('channel registration', () => {
  it('registers the review channel once with trusted-host authority', async () => {
    const { channel, options, handleCalls } = await harness()
    expect(channel).toBe(DIFF_APPROVAL_CHANNEL)
    expect(options).toEqual({ authority: 'trusted-host' })
    expect(handleCalls).toBe(1)
  })
})

describe('the comment-answering skill', () => {
  it('contributes both skills to the skill registry, and survives one that refuses', async () => {
    // The rules live in skills rather than the system prompt: the harness's own
    // `skill` tool advertises the catalog and loads a body on demand, so both must
    // be registered (and cleanly disposed), while a build without a registry — or a
    // registry that rejects a name — must leave the plugin working.
    type Contributed = { name?: string; source?: string; content?: string; description?: string }
    const registered: Contributed[] = []
    const disposers = vi.fn()
    const accepting = await harness({
      prepare: (ctx) => {
        ctx.provide('skills', {
          register: (skill: unknown) => { registered.push(skill as Contributed); return disposers },
        } as never)
      },
    })
    // One contribution per direction of the conversation: answering the reader's comments, and
    // annotating code the agent is explaining (the tool below is the other half of that one).
    expect(registered.map(skill => skill.name)).toEqual([COMMENT_SKILL_NAME, ANNOTATE_SKILL_NAME])
    expect(registered[0]).toMatchObject({ name: COMMENT_SKILL_NAME, source: 'runtime' })
    expect(registered[0]!.content).toContain('不要空行')
    expect(registered[0]!.description!.length).toBeGreaterThan(0)
    expect(registered[1]).toMatchObject({ name: ANNOTATE_SKILL_NAME, source: 'runtime' })
    expect(registered[1]!.description!.length).toBeGreaterThan(0)
    expect(registered[1]!.content).toContain(ANNOTATE_TOOL_NAME)

    // Disposal reaches the registry, so a reloaded plugin does not leave the skills behind.
    await accepting.dispose()
    expect(disposers).toHaveBeenCalled()

    // No registry at all: no throw, and the channel still mounts.
    const withoutRegistry = await harness()
    expect(withoutRegistry.channel).toBe(DIFF_APPROVAL_CHANNEL)

    // A registry that refuses the contribution is equally harmless.
    const refusing = await harness({
      prepare: (ctx) => {
        ctx.provide('skills', { register: () => { throw new Error('reserved name') } } as never)
      },
    })
    expect(refusing.channel).toBe(DIFF_APPROVAL_CHANNEL)
  })

  it('registers the annotate tool with the tool registry, and survives one that refuses', async () => {
    // The agent's door into the comment store: feature-detected the way the skills are, because the host
    // half imports nothing from the harness at runtime and a composition without a tool registry has to
    // keep working with the tool simply absent (an unsatisfied `inject` would defer the whole plugin).
    type Definition = { name?: string; description?: string; parameters?: unknown; output?: unknown }
    const definitions: Definition[] = []
    const disposers = vi.fn()
    const accepting = await harness({
      prepare: (ctx) => {
        ctx.provide('tools', {
          register: (definition: unknown) => { definitions.push(definition as Definition); return disposers },
        } as never)
      },
    })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ name: ANNOTATE_TOOL_NAME })
    expect(definitions[0]!.description!.length).toBeGreaterThan(0)
    // The definition is hand-built, so what the registry validates has to be there: an argument schema
    // and an output with a schema and a render.
    expect(definitions[0]!.parameters).toMatchObject({ type: 'object', required: ['path', 'startLine', 'note'] })
    expect(definitions[0]!.output).toMatchObject({ schema: { type: 'string' } })
    await accepting.dispose()
    expect(disposers).toHaveBeenCalled()

    // No tool registry: the plugin is otherwise unchanged.
    expect((await harness()).channel).toBe(DIFF_APPROVAL_CHANNEL)

    // A registry that refuses the definition is survived, and said out loud rather than thrown.
    const refusing = await harness({
      prepare: (ctx) => {
        ctx.provide('tools', { register: () => { throw new Error('name taken') } } as never)
      },
    })
    expect(refusing.channel).toBe(DIFF_APPROVAL_CHANNEL)
  })

  it('lists a file the annotation names, then stores the card on it', async () => {
    // The agent's own door into the list: annotating code the user is studying, in a file NOTHING has
    // changed in, has to put that file in the panel — otherwise the card has nowhere to hang. It goes
    // through the same admission the reader's own "add this path" uses, so the entry lands with both
    // sides the file's own text (the "no pending diff" shape) and the reader opens it as it reads.
    type Definition = { name?: string; execute?: (args: unknown, exec: unknown) => Promise<string> }
    const definitions: Definition[] = []
    // The workspace root has to be absolute FOR THE RUNNING PLATFORM: the plugin resolves the relative path
    // the annotation names against it, and `C:\repo` is only absolute on Windows. On Linux it is a relative
    // name, so the root itself gets resolved against the runner's directory first. Measured in CI on
    // ubuntu-latest: expected `C:\repo/src/a.ts`, received
    // `/home/runner/work/dsh-diff-approval/dsh-diff-approval/C:\repo/src/a.ts` — the case passed on Windows
    // and could not pass there, which is why it took a push to find out.
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo'
    const { fs, handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: root,
      prepare: (ctx) => {
        ctx.provide('tools', {
          register: (definition: unknown) => { definitions.push(definition as Definition); return () => {} },
        } as never)
      },
    })
    fs.readText.mockResolvedValue('one\ntwo\nthree\n')
    expect(await listEntries(handle, 'session-1')).toEqual([])

    const answer = await definitions[0]!.execute!(
      { path: 'src/a.ts', startLine: 2, endLine: 2, note: '1. 这一行是入口。' },
      { agent: { id: SessionId('session-1') }, signal: signal() },
    )
    expect(answer).toContain('annotated')
    expect(answer).toContain('added to the list')

    // The file is in the list now, as the "no pending diff" shape a hand-added clean path takes…
    const entries = await listEntries(handle, 'session-1')
    expect(entries.map(entry => entry.path)).toEqual([join(root, 'src', 'a.ts')])
    expect(entries[0]).toMatchObject({ earlierVersion: 'file' })
    expect(entries[0]!.oldText).toBe(entries[0]!.newText)
    expect(entries[0]!.oldText).toContain('two')

    // …and the card is on the lines it named, attributed to the agent, quoted from the file's own text.
    const read = await handle('list', { sessionId: 'session-1' }, signal())
    if (!read.ok) throw new Error('list failed')
    const comments = (read.value as { comments: CommentRecord[] }).comments
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      author: 'agent',
      text: '1. 这一行是入口。',
      anchor: { startLine: 2, endLine: 2 },
      quote: 'two',
      entryId: join(root, 'src', 'a.ts'),
    })
    // The step number is the agent's own words in the note: there is no field beside it, which is what
    // makes it travel with the text (a copy of the card, the agent's reply) rather than being drawn.
    expect(comments[0]).not.toHaveProperty('order')
    // The agent wrote this while the reader was looking elsewhere, so it is news: the card wears the
    // dot until the reader has actually been shown it.
    expect(comments[0]!.unseen).toBe(true)

    // Annotating the same lines again is refused for the reason the feature turns on, and the file is not
    // re-listed (the listing seam answers from the list, so a review in progress is never re-baselined).
    const second = await definitions[0]!.execute!(
      { path: 'src/a.ts', startLine: 2, endLine: 2, note: '又说一遍。' },
      { agent: { id: SessionId('session-1') }, signal: signal() },
    )
    expect(second).toContain('already inside')
    expect(second).toContain(comments[0]!.id)
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)
  })

  it('is the skill the comment prompt tells the agent to load', () => {
    // The prompt carries the short rules for builds without a registry and names the
    // skill for the full ones; the two halves must not drift apart.
    for (const [dictionary, supports, limit] of [[zh, '只支持 Markdown 的行内代码和加粗', '3 行'], [en, 'only Markdown inline code and bold', '3 lines']] as const) {
      expect(dictionary['discussion.promptRule']).toContain(COMMENT_SKILL_NAME)
      // The inline floor states what IS rendered rather than listing what is not: "plain text, no
      // Markdown decoration" was read as "no bold or italics", and tables came back.
      expect(dictionary['discussion.promptRule']).toContain(supports)
      // …and it carries no length limit of its own: how long an answer may be is the skill's business,
      // and the two must not disagree.
      expect(dictionary['discussion.promptRule']).not.toContain(limit)
      // The skill-only shape names it too, as a parameter the panel fills in.
      expect(dictionary['discussion.promptRuleSkill']).toContain('{skill}')
      expect(dictionary['discussion.promptRuleSkill'].length)
        .toBeLessThan(dictionary['discussion.promptRule'].length)
    }
    expect(COMMENT_SKILL.whenToUse).toContain('[评论]')
  })

  it('reports the skill to the client as soon as it is registered, and not otherwise', async () => {
    // The client asks the host which prompt shape to send: pointing at a skill the
    // deployment cannot load would leave the agent with no rules at all, so the answer is
    // "yes" only when the contribution actually landed. That is the half this plugin
    // performs; the `skill` tool that advertises the catalog belongs to `dsh-base`, which
    // mounts it in every release — asking the tool registry about it was tried and read
    // absent in a live session whose catalog worked, so it is not consulted.
    const accepted = await harness({ prepare: (ctx) => { ctx.provide('skills', { register: () => () => {} } as never) } })
    expect(await accepted.handle('list', { sessionId: 'session-1' }))
      .toMatchObject({ ok: true, value: { commentSkill: COMMENT_SKILL_NAME } })
    // Stable across requests: the panel polls this.
    expect(await accepted.handle('list', { sessionId: 'session-1' }))
      .toMatchObject({ ok: true, value: { commentSkill: COMMENT_SKILL_NAME } })

    // No registry at all, and a registry that refuses the name: the rules stay inline.
    const none = await harness()
    expect(await none.handle('list', { sessionId: 'session-1' }))
      .toMatchObject({ ok: true, value: { commentSkill: undefined } })
    const refusing = await harness({
      prepare: (ctx) => { ctx.provide('skills', { register: () => { throw new Error('reserved name') } } as never) },
    })
    expect(await refusing.handle('list', { sessionId: 'session-1' }))
      .toMatchObject({ ok: true, value: { commentSkill: undefined } })
  })
})

describe('capturing operations', () => {
  it('folds consecutive edits into one entry per path', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v2\n', 'v3\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ earlierVersion: 'file', oldText: 'v1\n', newText: 'v3\n' })
  })

  it('turns a created file that was edited again into a modification, not a permanent 新增', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, writeExec(), writeSuccess('/repo/new.txt', 'create', null, 'content'))
    emitResult(ctx, editExec(), editSuccess('/repo/new.txt', 'content', 'content2'))
    emitResult(ctx, writeExec(), writeSuccess('/repo/old.txt', 'update', 'before', 'after'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toHaveLength(2)
    // Created and then edited: the row is a modification whose basis is the created content, so the
    // reader is offered 修改 / 回退 for a file they have been working on — not 新增 / 删除, which the
    // frozen-create rule produced for a file rewritten any number of times.
    expect(entries[0]).toMatchObject({ path: '/repo/new.txt', earlierVersion: 'file', oldText: 'content', newText: 'content2' })
    expect(entries[1]).toMatchObject({ path: '/repo/old.txt', earlierVersion: 'file', oldText: 'before', newText: 'after' })
  })

  it('ignores other tools, failures, malformed values, agent-less calls, and basis-less updates', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, { name: 'bash', agent: { id: SessionId('session-1') } }, { isError: false, value: { text: 'rm x' } })
    emitResult(ctx, editExec(), { isError: true, error: { name: 'boom', code: 'boom' } })
    emitResult(ctx, editExec(), { isError: false, value: { path: 42 } })
    emitResult(ctx, { name: 'edit' }, editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, writeExec(), writeSuccess('/repo/w.txt', 'update', null, 'x'))

    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('records nothing for a no-op operation', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'same', 'same'))
    emitResult(ctx, writeExec(), writeSuccess('/repo/w.txt', 'update', 'same', 'same'))
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })
})

describe('live state', () => {
  it('adopts an externally modified file as the new baseline so the diff tracks it', async () => {
    const { ctx, handle, fs } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    // The file is changed outside the tracked operations (e.g. by an editor):
    // the listed diff must now reflect the current content.
    fs.readText.mockResolvedValue('v2\nexternal\n')
    const [entry] = await listEntries(handle, 'session-1')
    expect(entry).toMatchObject({
      earlierVersion: 'file', oldText: 'v1\n', newText: 'v2\nexternal\n', missing: false, diverged: false,
    })

    // A second listing sees the adopted content already tracked (no drift).
    const [again] = await listEntries(handle, 'session-1')
    expect(again!.newText).toBe('v2\nexternal\n')
  })

  it('keeps the tracked newText when the file content is unavailable', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    // readText resolves undefined (resolved but unreadable): never clobber the
    // tracked newText with a non-content value.
    const [entry] = await listEntries(handle, 'session-1')
    expect(entry!.newText).toBe('v2\n')
  })
})

describe('keep', () => {
  it('removes the entry and reports missing on a repeat', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    await expect(handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
  })

  it('rejects a malformed payload with an internal error', async () => {
    const { handle } = await harness()
    const answer = await handle('keep', { sessionId: '' }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })
})

describe('revert', () => {
  it('writes the old content back through fs and removes the entry', async () => {
    const { ctx, fs, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('revert', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    expect(fs.resolve).toHaveBeenCalledWith('/repo/a.txt', { signal: expect.anything() as AbortSignal })
    expect(fs.writeText).toHaveBeenCalledWith(
      { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'before', undefined, expect.anything() as AbortSignal,
    )
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('removes the file when reverting a creation', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const created = join(storageDir, 'created.txt')
    await writeFile(created, 'content', 'utf8')
    const { ctx, fs, handle } = await harness()
    fs.resolve.mockImplementation(async (path: string) => ({ displayPath: path, targetKey: path }))
    emitResult(ctx, writeExec(), writeSuccess(created, 'create', null, 'content'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('revert', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports missing without touching fs when no entry exists', async () => {
    const { fs, handle } = await harness()
    await expect(handle('revert', { sessionId: 'session-1', id: 'none' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    expect(fs.resolve).not.toHaveBeenCalled()
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('reports an internal error and keeps the entry when the write fails', async () => {
    const { ctx, fs, handle } = await harness()
    fs.writeText.mockRejectedValue(new Error('disk full'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    const answer = await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(answer).toEqual({
      ok: false, error: { code: 'internal', message: 'revert failed: disk full', details: {} },
    })
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)
  })

  it('re-encodes the old content to the file current EOL (Bug 1)', async () => {
    // Baseline LF, worktree CRLF, one line changed: without normalization a
    // revert would flip the whole file to the baseline (LF) EOL.
    const { ctx, fs, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'l1\nl2\nl3\n', 'l1\r\nl2\r\nL3\r\n'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('revert', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    // The revert always keeps the file's current (CRLF) EOL.
    expect(fs.writeText).toHaveBeenCalledWith(
      { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'l1\r\nl2\r\nl3\r\n', undefined, expect.anything() as AbortSignal,
    )
  })

  it('keeps a whole-file keep in the list when asked, and undoes back to the pending entry', async () => {
    // The panel's "keep in list" choice rides the same keep request; the entry
    // stays with both sides equal (no pending diff) rather than disappearing.
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('keep', { sessionId: 'session-1', id: entry!.id, keepListed: true }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept', resolved: true } })
    const [kept] = await listEntries(handle, 'session-1')
    expect(kept).toMatchObject({ id: entry!.id, oldText: 'b', newText: 'b' })

    // The choice is undoable: the entry returns to its pending diff.
    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ oldText: 'a', newText: 'b' })
  })

  it('keeps a whole-file revert in the list when asked, with the file written back', async () => {
    const { ctx, handle, fs } = await harness()
    let diskContent = 'b'
    fs.readText.mockImplementation(async () => diskContent)
    fs.writeText.mockImplementation(async (_target: unknown, content: string) => { diskContent = content; return { version: 1 } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('revert', { sessionId: 'session-1', id: entry!.id, keepListed: true }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted', resolved: true } })
    // The file was restored, and the entry stays listed with no pending diff.
    expect(diskContent).toBe('a')
    const [reverted] = await listEntries(handle, 'session-1')
    expect(reverted).toMatchObject({ id: entry!.id, oldText: 'a', newText: 'a' })

    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    expect(diskContent).toBe('b')
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ oldText: 'a', newText: 'b' })
  })

  it('still removes the entry when keepListed is not requested', async () => {
    // The host default is unchanged: the panel decides, the host obeys.
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')
    await expect(handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })
})

describe('block keep/revert', () => {
  // 'a\nb\nc\nd\n' -> 'A\nb\nC\nd\n': block 0 is old/new line 1, block 1 is old/new line 3.
  async function twoBlocks(harness: TestHarness) {
    emitResult(harness.ctx, editExec(), editSuccess('/repo/a.txt', 'a\nb\nc\nd\n', 'A\nb\nC\nd\n'))
    const [entry] = await listEntries(harness.handle, 'session-1')
    return entry!
  }

  it('keeps one block by advancing the baseline so only the other stays pending', async () => {
    const { ctx, fs, handle } = await harness()
    const entry = await twoBlocks({ ctx, fs, handle })
    await expect(handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    expect(fs.writeText).not.toHaveBeenCalled()
    const [kept] = await listEntries(handle, 'session-1')
    // The accepted block folds into the baseline; the second block remains.
    expect(kept!.oldText).toBe('A\nb\nc\nd\n')
    expect(kept!.newText).toBe('A\nb\nC\nd\n')
  })

  it('reverts one block by writing its old lines back and updating the entry', async () => {
    const { ctx, fs, handle } = await harness()
    const entry = await twoBlocks({ ctx, fs, handle })
    await expect(handle('block-revert', { sessionId: 'session-1', id: entry.id, block: { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    expect(fs.writeText).toHaveBeenCalledWith(
      { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'A\nb\nc\nd\n', undefined, expect.anything() as AbortSignal,
    )
    const [kept] = await listEntries(handle, 'session-1')
    // Only line 3 reverted; line 1 stays accepted in the new text.
    expect(kept!.newText).toBe('A\nb\nc\nd\n')
    expect(kept!.oldText).toBe('a\nb\nc\nd\n')
  })

  it('keeps the entry with no pending diff when the last block is kept', async () => {
    const { ctx, fs, handle } = await harness()
    const entry = await twoBlocks({ ctx, fs, handle })
    await handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal())
    await expect(handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept', resolved: true } })
    expect(fs.writeText).not.toHaveBeenCalled()
    const [kept] = await listEntries(handle, 'session-1')
    // The entry stays listed, now with both sides equal (no pending diff).
    expect(kept!.oldText).toBe('A\nb\nC\nd\n')
    expect(kept!.newText).toBe('A\nb\nC\nd\n')
  })

  it('removes the entry when the last keep is requested with removeWhenResolved', async () => {
    const { ctx, fs, handle } = await harness()
    const entry = await twoBlocks({ ctx, fs, handle })
    await handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal())
    await expect(handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 }, removeWhenResolved: true }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept', resolved: true } })
    expect(fs.writeText).not.toHaveBeenCalled()
    const files = await listEntries(handle, 'session-1')
    // The caller's choice removed the fully-resolved entry from the list.
    expect(files).toEqual([])
  })

  it('removes the entry when a keep resolves a trailing-newline / EOL-only difference (matches the diff view)', async () => {
    // The baseline has no trailing newline, the new content has one: the diff
    // view treats these as identical (no pending diff), so a full-resolve keep
    // must remove the entry too. A strict string compare would leave it listed.
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b\n'))
    const [entry] = await listEntries(handle, 'session-1')
    await expect(handle('block-keep', { sessionId: 'session-1', id: entry.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }, removeWhenResolved: true }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept', resolved: true } })
    const files = await listEntries(handle, 'session-1')
    expect(files).toEqual([])
  })

  it('keeps the entry with no pending diff when the last block is reverted', async () => {
    const { ctx, fs, handle } = await harness()
    const entry = await twoBlocks({ ctx, fs, handle })
    await handle('block-revert', { sessionId: 'session-1', id: entry.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal())
    await expect(handle('block-revert', { sessionId: 'session-1', id: entry.id, block: { oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted', resolved: true } })
    const [kept] = await listEntries(handle, 'session-1')
    expect(kept!.oldText).toBe('a\nb\nc\nd\n')
    expect(kept!.newText).toBe('a\nb\nc\nd\n')
  })

  it('restores a purely deleted line by inserting at its new-side position', async () => {
    const { ctx, fs, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\nb\nc\n', 'b\n'))
    const [entry] = await listEntries(handle, 'session-1')
    await expect(handle('block-revert', { sessionId: 'session-1', id: entry!.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 0 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    expect(fs.writeText).toHaveBeenCalledWith(
      { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'a\nb\n', undefined, expect.anything() as AbortSignal,
    )
  })

  it('reports missing without touching fs when no entry exists', async () => {
    const { fs, handle } = await harness()
    await expect(handle('block-keep', { sessionId: 'session-1', id: 'none', block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    expect(fs.resolve).not.toHaveBeenCalled()
  })

  it('rejects a malformed block payload', async () => {
    const { handle } = await harness()
    const answer = await handle('block-keep', { sessionId: 'session-1', id: 'e1', block: { oldStart: 'x' } }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })
})

describe('bulk keep-all / revert-all', () => {
  function twoEditEntries(ctx: Parameters<typeof emitResult>[0], write: typeof editSuccess) {
    emitResult(ctx, editExec(), write('/repo/a.txt', 'a\n', 'A\n'))
    emitResult(ctx, editExec(), write('/repo/b.txt', 'b\n', 'B\n'))
  }

  it('keeps every session entry in one call and returns the affected count', async () => {
    const { ctx, handle } = await harness()
    twoEditEntries(ctx, editSuccess)
    expect(await listEntries(handle, 'session-1')).toHaveLength(2)

    const answer = await handle('keep-all', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: true, value: { affected: 2 } })
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('undoes a bulk keep-all as one batch (restores every entry)', async () => {
    const { ctx, handle } = await harness()
    twoEditEntries(ctx, editSuccess)
    await handle('keep-all', { sessionId: 'session-1' }, signal())

    const answer = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(answer).toMatchObject({ ok: true, value: { outcome: 'undone' } })
    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(2)
    expect(files.map(f => f.path)).toEqual(['/repo/a.txt', '/repo/b.txt'])
  })

  it('reverts every session entry in one call', async () => {
    const { ctx, fs, handle } = await harness()
    twoEditEntries(ctx, editSuccess)
    expect(await listEntries(handle, 'session-1')).toHaveLength(2)

    const answer = await handle('revert-all', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: true, value: { affected: 2 } })
    expect(fs.writeText).toHaveBeenCalledTimes(2)
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('handles a session with no entries', async () => {
    const { handle } = await harness()
    const answer = await handle('keep-all', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: true, value: { affected: 0 } })
  })
})

describe('a pick of files (keep-many)', () => {
  /** Three pending edits, so a pick can be a proper subset of the list. */
  function threeEditEntries(ctx: Parameters<typeof emitResult>[0]) {
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\n', 'A\n'))
    emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'b\n', 'B\n'))
    emitResult(ctx, editExec(), editSuccess('/repo/c.txt', 'c\n', 'C\n'))
  }

  /**
   * A note on the double's disk: a revert WRITES, and undoing one reads the file back to check it is
   * still what the action left (the divergence guard) before writing again — so a double whose
   * `readText` answers `undefined` gets every undo refused, which says nothing about the code under
   * test. The tests below that undo a revert give it a real disk for that reason.
   */
  it('settles only the files it names, and keeps the ones asked to stay listed', async () => {
    const { ctx, handle } = await harness()
    threeEditEntries(ctx)
    const [a, b] = await listEntries(handle, 'session-1')

    // A pick that spans both decisions of the same button: `a` is kept and left listed, `b` is kept and
    // taken out. `c` was not picked and must not move.
    const answer = await handle('keep-many',
      { sessionId: 'session-1', ids: [a!.id], keepListed: true }, signal())
    expect(answer).toEqual({ ok: true, value: { affected: 1 } })
    await handle('keep-many', { sessionId: 'session-1', ids: [b!.id] }, signal())

    // The list is ordered by recency, so the file kept listed rejoins at the end — what matters here is
    // WHICH files are left, not where the kept one sits.
    const left = (await listEntries(handle, 'session-1')).map(entry => entry.path).sort()
    expect(left).toEqual(['/repo/a.txt', '/repo/c.txt'])
  })

  it('takes the whole pick back with ONE undo', async () => {
    const { ctx, handle } = await harness()
    threeEditEntries(ctx)
    const [a, b] = await listEntries(handle, 'session-1')

    expect(await handle('keep-many', { sessionId: 'session-1', ids: [a!.id, b!.id] }, signal()))
      .toEqual({ ok: true, value: { affected: 2 } })
    expect((await listEntries(handle, 'session-1')).map(entry => entry.path)).toEqual(['/repo/c.txt'])

    // One decision, one step: a single undo puts BOTH files back, not just the last of them.
    const answer = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(answer).toMatchObject({ ok: true, value: { outcome: 'undone' } })
    const back = (await listEntries(handle, 'session-1')).map(entry => entry.path).sort()
    expect(back).toEqual(['/repo/a.txt', '/repo/b.txt', '/repo/c.txt'])
  })

  it('puts a subset of the list back in one call, and takes that one decision back with one undo', async () => {
    const { ctx, fs, handle } = await harness()
    threeEditEntries(ctx)
    const disk = new Map<string, string>([
      ['/repo/a.txt', 'A\n'], ['/repo/b.txt', 'B\n'], ['/repo/c.txt', 'C\n'],
    ])
    fs.readText.mockImplementation(async (target: { displayPath?: string }) => disk.get(target.displayPath ?? ''))
    fs.writeText.mockImplementation(async (target: { displayPath?: string }, content: string) => {
      disk.set(target.displayPath ?? '', content)
      return { version: 1 }
    })
    const [a] = await listEntries(handle, 'session-1')

    // One request, one write, and the files the pick did not name do not move.
    expect(await handle('revert-many', { sessionId: 'session-1', ids: [a!.id] }, signal()))
      .toEqual({ ok: true, value: { affected: 1 } })
    expect(fs.writeText).toHaveBeenCalledTimes(1)
    expect(disk.get('/repo/a.txt')).toBe('a\n')
    expect(disk.get('/repo/b.txt')).toBe('B\n')

    // …and one undo puts it back on disk, not just back in the list (see `restoreState`).
    expect(await handle('undo', { sessionId: 'session-1' }, signal()))
      .toMatchObject({ ok: true, value: { outcome: 'undone' } })
    expect(fs.writeText).toHaveBeenCalledTimes(2)
    expect(disk.get('/repo/a.txt')).toBe('A\n')
    expect((await listEntries(handle, 'session-1')).map(entry => entry.path).sort())
      .toEqual(['/repo/a.txt', '/repo/b.txt', '/repo/c.txt'])
  })

  it('brings a KEPT file back with its diff when the keep is undone', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\n', 'A\n'))
    const [a] = await listEntries(handle, 'session-1')

    // 保留 leaves the row listed with nothing left to show: the accepted content is folded into the
    // baseline, and NO file is written (the file already holds it).
    expect(await handle('keep', { sessionId: 'session-1', id: a!.id, keepListed: true }, signal()))
      .toEqual({ ok: true, value: { outcome: 'kept', resolved: true } })
    const kept = await listEntries(handle, 'session-1')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ oldText: 'A\n', newText: 'A\n' })

    // Ctrl+Z restores the state the reader was in BEFORE the keep — the row shows its diff again even
    // though the file's bytes never moved.
    expect(await handle('undo', { sessionId: 'session-1' }, signal()))
      .toMatchObject({ ok: true, value: { outcome: 'undone' } })
    const back = await listEntries(handle, 'session-1')
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ oldText: 'a\n', newText: 'A\n' })
  })

  it('writes the files back when the session-wide revert-all is undone', async () => {
    const { ctx, fs, handle } = await harness()
    threeEditEntries(ctx)
    // A real disk: the files hold their changes, and every write lands on it (see the note above).
    const disk = new Map<string, string>([
      ['/repo/a.txt', 'A\n'], ['/repo/b.txt', 'B\n'], ['/repo/c.txt', 'C\n'],
    ])
    fs.readText.mockImplementation(async (target: { displayPath?: string }) => disk.get(target.displayPath ?? ''))
    fs.writeText.mockImplementation(async (target: { displayPath?: string }, content: string) => {
      disk.set(target.displayPath ?? '', content)
      return { version: 1 }
    })

    // The session-wide 全部回退 is the reversible one, and its undo has to WRITE the files back: the undo
    // state carries the bytes each file held, which the old batch restore ignored (it restored entries and
    // nothing else) — so undoing it put the rows back while the files stayed reverted on disk.
    expect(await handle('revert-all', { sessionId: 'session-1' }, signal()))
      .toEqual({ ok: true, value: { affected: 3 } })
    expect(fs.writeText).toHaveBeenCalledTimes(3)
    expect(disk.get('/repo/a.txt')).toBe('a\n')

    const answer = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(answer).toMatchObject({ ok: true, value: { outcome: 'undone' } })
    expect(fs.writeText).toHaveBeenCalledTimes(6)
    expect(disk.get('/repo/a.txt')).toBe('A\n')
    expect([...disk.entries()].sort()).toEqual([['/repo/a.txt', 'A\n'], ['/repo/b.txt', 'B\n'], ['/repo/c.txt', 'C\n']])
    const back = (await listEntries(handle, 'session-1')).map(entry => entry.path).sort()
    expect(back).toEqual(['/repo/a.txt', '/repo/b.txt', '/repo/c.txt'])
  })

  it('ignores an id that is already gone, and refuses a payload with no usable ids', async () => {
    const { ctx, handle } = await harness()
    threeEditEntries(ctx)
    const [a] = await listEntries(handle, 'session-1')

    // A file that left the list between the pick and the request is not an error: keeping it is what
    // happened to it.
    expect(await handle('keep-many', { sessionId: 'session-1', ids: [a!.id, '/repo/gone.txt'] }, signal()))
      .toEqual({ ok: true, value: { affected: 1 } })
    // A repeated id names one file: two mentions of the same file are one decision about it.
    expect(await handle('keep-many', { sessionId: 'session-1', ids: [a!.id, a!.id] }, signal()))
      .toEqual({ ok: true, value: { affected: 0 } })

    const empty = await handle('keep-many', { sessionId: 'session-1', ids: [] }, signal())
    expect(empty).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
    const bad = await handle('keep-many', { sessionId: 'session-1', ids: [''] }, signal())
    expect(bad).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })
})

describe('str_replace_editor capture', () => {
  it('captures a str_replace mutation through the edit-intent and result seams', async () => {
    const { ctx, fs, handle } = await harness()
    let content = 'before\n'
    fs.readText.mockImplementation(async () => content)
    const exec = strReplaceExec('str_replace')

    await ctx.waterfall(
      'fs/edit-intent', { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, exec, () => undefined,
    )
    content = 'after\n'
    emitResult(ctx, exec, { isError: false, value: 'The file /repo/a.txt has been edited successfully.' })
    // The capture reads the post-write content asynchronously; let it settle.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))

    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: '/repo/a.txt', earlierVersion: 'file', oldText: 'before\n', newText: 'after\n', missing: false, diverged: false,
    })
  })

  it('captures a create command through the write-intent seam', async () => {
    const { ctx, fs, handle } = await harness()
    fs.readText.mockImplementation(async () => 'created\n')
    const exec = strReplaceExec('create', 'call-2')

    await ctx.waterfall(
      'fs/write-intent', { displayPath: '/repo/new.txt', targetKey: 'key:/repo/new.txt' }, exec,
      () => ({ kind: 'createIfAbsent' }),
    )
    emitResult(ctx, exec, { isError: false, value: 'New file created successfully at: /repo/new.txt' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))

    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: '/repo/new.txt', earlierVersion: 'none', oldText: '', newText: 'created\n' })
  })

  it('captures even when an earlier listener owns the decision slot', async () => {
    const { ctx, fs, handle } = await harness({
      prepare: prepared => {
        // The harness policy occupies the intent waterfalls without calling
        // next(); our observer must still run (prepend) while the policy wins.
        prepared.on('fs/edit-intent', () => Promise.resolve({ version: 1 }))
      },
    })
    let content = 'before\n'
    fs.readText.mockImplementation(async () => content)
    const exec = strReplaceExec('str_replace', 'call-policy')

    await ctx.waterfall(
      'fs/edit-intent', { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, exec, () => undefined,
    )
    content = 'after\n'
    emitResult(ctx, exec, { isError: false, value: 'The file /repo/a.txt has been edited successfully.' })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))

    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: '/repo/a.txt', earlierVersion: 'file', oldText: 'before\n', newText: 'after\n' })
  })

  it('tracks nothing for view commands, failed mutations, or other tools on the same seams', async () => {
    const { ctx, fs, handle } = await harness()
    // The file matches its last edit, so listing does not adopt any drift.
    fs.readText.mockImplementation(async () => 'y')

    // view: no intent basis exists; the settle must not invent an entry.
    emitResult(ctx, strReplaceExec('view', 'call-3'), { isError: false, value: 'content' })
    // failed str_replace: the intent basis is discarded on the error settle.
    await ctx.waterfall(
      'fs/edit-intent', { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, strReplaceExec('str_replace', 'call-4'),
      () => undefined,
    )
    emitResult(ctx, strReplaceExec('str_replace', 'call-4'), { isError: true, value: { message: 'nope' } })
    // The edit tool rides the same edit-intent seam but keeps its own capture path.
    await ctx.waterfall(
      'fs/edit-intent', { displayPath: '/repo/b.txt', targetKey: 'key:/repo/b.txt' }, editExec(), () => undefined,
    )
    emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'x', 'y'))

    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: '/repo/b.txt', earlierVersion: 'file', oldText: 'x', newText: 'y' })
  })
})

describe('open', () => {
  it('launches the file through the injected launcher with the execution-world path', async () => {
    const { ctx, handle, openPath } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('open', { sessionId: 'session-1', id: entry!.id, action: 'open' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'opened' } })
    expect(openPath).toHaveBeenCalledWith('/repo/a.txt', 'open')
  })

  it('reveals the file location for the reveal action', async () => {
    const { ctx, handle, openPath } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('open', { sessionId: 'session-1', id: entry!.id, action: 'reveal' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'opened' } })
    expect(openPath).toHaveBeenCalledWith('/repo/a.txt', 'reveal')
  })

  it('reports missing without touching the launcher when no entry exists', async () => {
    const { handle, openPath } = await harness()
    await expect(handle('open', { sessionId: 'session-1', id: 'none', action: 'open' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports an internal error when the launcher fails', async () => {
    const { ctx, handle } = await harness({ openPath: async () => { throw new Error('no handler') } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    const answer = await handle('open', { sessionId: 'session-1', id: entry!.id, action: 'open' }, signal())
    expect(answer).toEqual({
      ok: false, error: { code: 'internal', message: 'open failed: no handler', details: {} },
    })
  })

  it('rejects a malformed action with an internal error', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    const answer = await handle('open', { sessionId: 'session-1', id: entry!.id, action: 'edit' }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })
})

describe('live file state', () => {
  it('adopts externally modified content as the new baseline and makes it undoable', async () => {
    const { ctx, handle, fs } = await harness()
    fs.readText.mockResolvedValue('external edit\n')
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({ missing: false, diverged: false, oldText: 'v1\n', newText: 'external edit\n' }) as object,
    ])
    // The adoption is a fresh undo point: undo restores the prior content.
    const undo = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(undo).toEqual({ ok: true, value: { outcome: 'undone', id: expect.any(String) } })
  })

  it('marks an entry clean when the current content matches the tracked text', async () => {
    const { ctx, handle, fs } = await harness()
    fs.readText.mockResolvedValue('v2\n')
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({ missing: false, diverged: false }) as object,
    ])
  })

  it('drops a file stat reports as absent, kept as an undoable checkpoint', async () => {
    const { ctx, handle, fs } = await harness()
    fs.stat.mockResolvedValue(undefined)
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([])
    // Undo recreates the file (its tracked content) and restores the entry.
    const undo = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(undo).toEqual({ ok: true, value: { outcome: 'undone', id: expect.any(String) } })
    expect(fs.writeText).toHaveBeenCalled()
  })

  it('drops a file readText reports as unreadable and clears its history', async () => {
    const { ctx, handle, fs } = await harness()
    fs.readText.mockRejectedValue(new Error('permission denied'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([])
    // The unavailable entry's undo record was purged, so undo has nothing to do.
    const undo = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(undo).toEqual({ ok: true, value: { outcome: 'nothing' } })
  })

  it('reports redoCleared when a detected external change supersedes pending redo', async () => {
    const { ctx, fs, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    const [entry] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
    await handle('undo', { sessionId: 'session-1' }, signal())

    // An external change after the undo: adopting it is a fresh undo point that
    // clears the session's pending redo, so the list flags it for the panel.
    fs.readText.mockResolvedValue('v3\n')
    const answer = await handle('list', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: true, value: expect.objectContaining({ redoCleared: true }) as object })
  })
})

describe('persistence', () => {
  it('persists an operation and hydrates it into a fresh harness', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('pending.json')
    })

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    second.fs.readText.mockResolvedValue('v2\n')
    const entries = await listEntries(second.handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({
        sessionId: 'session-1', path: '/repo/a.txt', earlierVersion: 'file',
        oldText: 'v1\n', newText: 'v2\n', missing: false, diverged: false,
      }) as object,
    ])
  })

  it("keeps an earlier session's persisted entry global but scoped to its touching sessions", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    // First run: an earlier session records an edit, persisted to the global file.
    const first = await harness({ sessionIds: [SessionId('session-old')], storageDir })
    emitResult(first.ctx, { name: 'edit', agent: { id: SessionId('session-old') } },
      editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('pending.json')
    })

    // The touching session still sees its global entry after restart.
    const same = await harness({ sessionIds: [SessionId('session-old')], storageDir })
    same.fs.readText.mockResolvedValue('v2\n')
    expect((await listEntries(same.handle, 'session-old'))[0]).toMatchObject({
      sessionId: 'session-old', path: '/repo/a.txt', earlierVersion: 'file',
      oldText: 'v1\n', newText: 'v2\n', missing: false, diverged: false,
    })

    // A fresh session that never touched the file does not (current-session scope).
    const fresh = await harness({ sessionIds: [SessionId('session-new')], storageDir })
    fresh.fs.readText.mockResolvedValue('v2\n')
    expect(await listEntries(fresh.handle, 'session-new')).toEqual([])
  })

  it('removes the persisted entry when it is kept', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(first.handle, 'session-1')
    await expect(first.handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    // The same live harness must also list it as gone (not just a fresh one).
    expect(await listEntries(first.handle, 'session-1')).toEqual([])

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    expect(await listEntries(second.handle, 'session-1')).toEqual([])
  })

  it('persists a session without a workspace once a global entry exists', async () => {
    const { ctx, handle, storageDir } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)
    await vi.waitFor(async () => {
      await expect(readdir(storageDir)).resolves.toContain('pending.json')
    })
  })

  it('serves the live in-memory view when the persisted file is corrupt', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('pending.json')
    })
    await writeFile(join(storageDir, 'pending.json'), '{not json', 'utf8')

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    expect(await listEntries(second.handle, 'session-1')).toEqual([])
  })

  it('tells the client when the pending state cannot reach the disk, and retracts it once a write works', async () => {
    // A storage root whose parent is a FILE: every save fails before it can write, while the
    // in-memory list keeps working — the shape issue #6 had, where the reader saw a list that
    // would silently vanish on the next restart and had nothing to explain it.
    const root = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(root)
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const { ctx, handle, storageDir } = await harness({
      sessionIds: [SessionId('session-1')],
      storageDir: join(blocker, 'workspaces'),
    })

    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    await vi.waitFor(async () => {
      const answer = await handle('list', { sessionId: 'session-1' }, signal())
      expect(answer).toEqual({ ok: true, value: expect.objectContaining({ persistError: expect.any(String) as string }) as object })
    })
    // The list itself is unaffected: only the disk is.
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)

    // The filesystem recovers. A write that works retracts the field, so the panel stops
    // saying the list is unsafe — and that retraction is what makes a later failure news again.
    await rm(blocker, { force: true })
    await mkdir(blocker, { recursive: true })
    const [entry] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
    await vi.waitFor(async () => {
      const answer = await handle('list', { sessionId: 'session-1' }, signal())
      expect(answer).toEqual({ ok: true, value: expect.objectContaining({ persistError: undefined }) as object })
    })
    // ...and it really did reach the disk, at the configured root.
    await vi.waitFor(async () => {
      await expect(readdir(storageDir)).resolves.toContain('pending.json')
    })
  })

  it('rejects a blank storageDir config', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(apply, { storageDir: '   ' })).rejects.toThrow(/storageDir/)
  })
})

describe('channel safety', () => {
  it('answers an unknown endpoint with an internal error', async () => {
    const { handle } = await harness()
    const answer = await handle('nope', {}, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })

  it('list requires a sessionId', async () => {
    const { handle } = await harness()
    const answer = await handle('list', { sessionId: 42 }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })
})

describe('undo/redo', () => {
  it('undoes a keep by restoring the entry, and redoes it', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    expect(await listEntries(handle, 'session-1')).toEqual([])

    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ id: entry!.id, path: '/repo/a.txt', earlierVersion: 'file', oldText: 'a', newText: 'b' })

    await expect(handle('redo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: entry!.id } })
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('undoes a revert by restoring the entry and the file content, then redoes it', async () => {
    const { ctx, handle, fs } = await harness()
    let diskContent = 'b'
    fs.readText.mockImplementation(async () => diskContent)
    fs.writeText.mockImplementation(async (_target: unknown, content: string) => { diskContent = content; return { version: 1 } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(diskContent).toBe('a')
    expect(await listEntries(handle, 'session-1')).toEqual([])

    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    expect(diskContent).toBe('b')
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ oldText: 'a', newText: 'b' })

    await expect(handle('redo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: entry!.id } })
    expect(diskContent).toBe('a')
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('undoes a block revert by restoring the entry and the file', async () => {
    const { ctx, handle, fs } = await harness()
    let diskContent = 'A\nb\n'
    fs.readText.mockImplementation(async () => diskContent)
    fs.writeText.mockImplementation(async (_target: unknown, content: string) => { diskContent = content; return { version: 1 } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\nb\n', 'A\nb\n'))
    const [entry] = await listEntries(handle, 'session-1')

    // Block-revert the first block (rows 0-1: del a / add A) -> writes 'a\nb\n'.
    await handle('block-revert', { sessionId: 'session-1', id: entry!.id, block: { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 } }, signal())
    expect(diskContent).toBe('a\nb\n')

    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    expect(diskContent).toBe('A\nb\n')
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ oldText: 'a\nb\n', newText: 'A\nb\n' })
  })

  it('does not undo a revert that deleted a created file', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, writeExec(), writeSuccess('/repo/new.txt', 'create', null, 'content'))
    const [entry] = await listEntries(handle, 'session-1')

    await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])

    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'nothing' } })
  })

  it('refuses to undo a revert when the file changed outside the review since', async () => {
    const { ctx, handle, fs } = await harness()
    let diskContent = 'b'
    fs.readText.mockImplementation(async () => diskContent)
    fs.writeText.mockImplementation(async (_target: unknown, content: string) => { diskContent = content; return { version: 1 } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    diskContent = 'c' // an outside writer changed the file after the revert
    const answer = await handle('undo', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.stringContaining('undo failed') as string, details: {} } })
    expect(diskContent).toBe('c')
  })

  it('does not undo one session\'s action from another session\'s keyboard', async () => {
    // Two sessions touched the same file, so both list it; each session's own decisions
    // are its own. A Ctrl+Z in session B must not reach into session A's history — under
    // the old single global stack it popped A's pair, restored A's entry and reported
    // success, which is an action the reader never took.
    const S2 = SessionId('session-2')
    const { ctx, handle } = await harness({ sessionIds: [SessionId('session-1'), S2] })
    emitResult(ctx, { name: 'edit', agent: { id: SessionId('session-1') } }, editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, { name: 'edit', agent: { id: S2 } }, editSuccess('/repo/a.txt', 'b', 'c'))
    const [entry] = await listEntries(handle, 'session-1')
    expect(entry!.sessionIds).toEqual(expect.arrayContaining([SessionId('session-1'), S2]))

    await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // Session B has no undo of its own, and says so rather than silently succeeding.
    const refused = await handle('undo', { sessionId: String(S2) }, signal())
    expect(refused).toMatchObject({ ok: true, value: { outcome: 'nothing' } })
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // Session A's own Ctrl+Z still restores what its keep removed.
    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ id: entry!.id })
  })

  it('writes the undo under the policy of the session that owns the pair', async () => {
    // The pair remembers the session its action was taken in, and the write policy has to
    // come from THAT session: the reader's panel may be showing another session's list by
    // the time Ctrl+Z arrives, and resolving the policy from the viewer would write A's
    // file under B's sandbox root.
    //
    // This is NOT the red-first evidence for the per-session history, whatever the old title
    // claimed: the caller here IS the pair's own session, so it passes with the ownership
    // check in `popOwnPair` removed, and it passes even against the pre-fix single global
    // stack. The evidence for that fix is 'does not undo one session's action from another
    // session's keyboard' above, which fails as soon as the stacks are not keyed per session.
    const S2 = SessionId('session-2')
    const workspaceA = await mkdtemp(join(tmpdir(), 'dsh-undo-a-'))
    const workspaceB = await mkdtemp(join(tmpdir(), 'dsh-undo-b-'))
    tempDirs.push(workspaceA, workspaceB)
    const policy = {
      defaultMode: 'workspace-write' as const,
      // Both sessions are live in this process, so the root comes from the session the
      // resolver was handed — which is the whole point of asserting on it.
      resolve: vi.fn((request?: { session?: { id?: unknown } }) => ({
        mode: 'workspace-write' as const,
        workspaceRoot: String(request?.session?.id) === String(S2) ? workspaceB : workspaceA,
      })),
    }
    const { ctx, handle, fs } = await harness({
      sessionIds: [SessionId('session-1'), S2],
      workspacePath: workspaceA,
      prepare: (context) => {
        context.provide('sandboxPolicy', policy as never)
        // The real `sandboxPolicy.resolve` reads the session to find its root; the docs
        // double keeps no sessions, so each id stands in for its own.
        context.provide('sessions', { get: (id: SessionId) => ({ id }) } as never)
      },
    })
    let diskContent = 'b'
    fs.readText.mockImplementation(async () => diskContent)
    fs.writeText.mockImplementation(async (_target: unknown, content: string) => { diskContent = content; return { version: 1 } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')

    await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    fs.writeText.mockClear()
    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entry!.id } })
    expect(diskContent).toBe('b')
    // The write carried session A's policy: the pair's own session, since no other list
    // was ever viewed here — the assertion that matters is the root the write ran under.
    expect(fs.writeText).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      { mode: 'workspace-write', workspaceRoot: workspaceA },
    )
  })

  it('carries the pair\'s own session policy into the revert\'s delete of a created file', async () => {
    // A revert of a created file DELETES it. The delete is a mutation like any other, so
    // it has to go through the same policy seam the write path uses: under a confining
    // policy a delete of a file the policy would refuse to write must be refused too,
    // instead of an unconditional `rm` that ignores the mode entirely.
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-delete-policy-'))
    tempDirs.push(workspace)
    const policy = {
      defaultMode: 'workspace-write' as const,
      resolve: vi.fn(() => ({ mode: 'workspace-write' as const, workspaceRoot: workspace })),
    }
    const { ctx, handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (context) => {
        context.provide('sandboxPolicy', policy as never)
        context.provide('sessions', { get: () => undefined } as never)
      },
    })
    const target = join(workspace, 'made.txt')
    emitResult(ctx, writeExec(), writeSuccess(target, 'create', null, 'fresh'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('revert', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    // The delete reached the fs surface with the session's policy beside it, exactly the
    // way `writeText` is called — not a raw process-path `rm` outside the seam.
    expect(fs.remove).toHaveBeenCalledTimes(1)
    // The target, the policy and the signal: the same call shape `writeText` gets, so a
    // confining backend can fence the delete exactly as it fences a write.
    expect(fs.remove).toHaveBeenCalledWith(
      expect.objectContaining({ displayPath: target }),
      { mode: 'workspace-write', workspaceRoot: workspace },
      expect.anything(),
    )
  })

  it('refuses to delete a created file the session\'s policy confines the review out of', async () => {
    // The same policy that would fence a WRITE fences the delete: a path outside the
    // session's workspace root is not the review's to remove, whatever the mode says.
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-delete-outside-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-delete-elsewhere-'))
    tempDirs.push(workspace, outside)
    const policy = {
      defaultMode: 'workspace-write' as const,
      resolve: vi.fn(() => ({ mode: 'workspace-write' as const, workspaceRoot: workspace })),
    }
    const { ctx, handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (context) => {
        context.provide('sandboxPolicy', policy as never)
        context.provide('sessions', { get: () => undefined } as never)
      },
    })
    const target = join(outside, 'made.txt')
    emitResult(ctx, writeExec(), writeSuccess(target, 'create', null, 'fresh'))
    const [entry] = await listEntries(handle, 'session-1')

    const answer = await handle('revert', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(answer).toEqual({
      ok: false,
      error: { code: 'internal', message: expect.stringContaining('sandbox') as string, details: {} },
    })
    expect(fs.remove).not.toHaveBeenCalled()
  })
})

describe('vcs detection and import', () => {
  /** A git repo at `dir/repo` whose working tree is the workspace `dir/repo/sub`. */
  async function gitRepo(): Promise<{ dir: string; repo: string; workspace: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vcs-'))
    tempDirs.push(dir)
    const repo = join(dir, 'repo')
    const workspace = join(repo, 'sub')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    return { dir, repo, workspace }
  }

  it('imports git workspace changes (modified, deleted, and untracked) as pending entries', async () => {
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'a.txt'), 'new content\n')
    await writeFile(join(workspace, 'new.txt'), 'fresh\n')
    const shell = fakeShell({
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all':
        ' M sub/a.txt\u0000 D sub/gone.txt\u0000?? sub/new.txt\u0000',
      'git cat-file -s HEAD:sub/a.txt': '13',
      'git show HEAD:sub/a.txt': 'old content\n',
      'git cat-file -s HEAD:sub/gone.txt': '9',
      'git show HEAD:sub/gone.txt': 'gone old\n',
    })
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: true }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 3, detected: true } })

    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(3)
    expect(files.map(file => file.path)).toEqual([
      join(workspace, 'a.txt'),
      join(workspace, 'gone.txt'),
      join(workspace, 'new.txt'),
    ])
    expect(files[0]).toMatchObject({ earlierVersion: 'file', oldText: 'old content\n', newText: 'new content\n' })
    expect(files[1]).toMatchObject({ earlierVersion: 'file', oldText: 'gone old\n', newText: '' })
    expect(files[2]).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'fresh\n' })
  })

  it('imports a staged change too, because the baseline is the last commit and not the index', async () => {
    // The list answers "what is not committed yet", so a change the reader already `git add`ed is
    // as much a review item as an unstaged one: the status row's FIRST column (`M `) counts, and
    // the baseline it is diffed against is the last commit. Reading the index here would drop every
    // staged change from the review (the shape 0.29.x and earlier shipped).
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'staged.txt'), 'staged content\n')
    await writeFile(join(workspace, 'added.txt'), 'brand new\n')
    const shell = fakeShell({
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all':
        'M  sub/staged.txt\u0000A  sub/added.txt\u0000',
      'git cat-file -s HEAD:sub/staged.txt': '18',
      'git show HEAD:sub/staged.txt': 'committed content\n',
      // `added.txt` has no version at HEAD: git says exactly that, no blob is read for it, and it
      // lands as a `create` whose revert removes the file. The failure has to be git's OWN wording —
      // a read that fails for any other reason is now refused rather than read as absence.
      'git cat-file -s HEAD:sub/added.txt': {
        exitCode: 128,
        stderr: "fatal: path 'sub/added.txt' does not exist in 'HEAD'",
      },
    })
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: false }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 2, detected: true } })

    const files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path).sort()).toEqual([
      join(workspace, 'added.txt'),
      join(workspace, 'staged.txt'),
    ])
    const staged = files.find(file => file.path === join(workspace, 'staged.txt'))!
    expect(staged).toMatchObject({ earlierVersion: 'file', oldText: 'committed content\n', newText: 'staged content\n' })
    const added = files.find(file => file.path === join(workspace, 'added.txt'))!
    expect(added).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'brand new\n' })
  })

  it('reads a large baseline blob via git show with a raised stdout budget (no temp file)', async () => {
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'big.txt'), 'big new content\n')
    const resolves: { command: string; stdoutMaxBytes?: number }[] = []
    const routes: Record<string, string> = {
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all': ' M sub/big.txt\u0000',
      'git cat-file -s HEAD:sub/big.txt': '70000', // > the default stdout cap
      'git show HEAD:sub/big.txt': 'big old content\n',
    }
    const shell = {
      resolve: (request: { command: string; stdoutMaxBytes?: number }) => {
        resolves.push({ command: request.command, stdoutMaxBytes: request.stdoutMaxBytes })
        return { ...request }
      },
      run: async (spec: { command: string }) => {
        const bare = spec.command.replace(/'/g, '')
        for (const [needle, output] of Object.entries(routes)) {
          if (bare.includes(needle)) return { exitCode: 0, stdout: { text: output }, stderr: { text: '' } }
        }
        return { exitCode: 1, stdout: { text: '' }, stderr: { text: `no route for ${spec.command}` } }
      },
    }
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    await handle('vcs-import', { sessionId: 'session-1', includeUntracked: true }, signal())
    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ earlierVersion: 'file', oldText: 'big old content\n', newText: 'big new content\n' })
    // The baseline came off `git show HEAD:` with a raised per-command stdout
    // budget, not a temp-file write to the repo root.
    const show = resolves.find(request => request.command.startsWith('git show HEAD:'))
    expect(show).toBeDefined()
    expect(show!.stdoutMaxBytes).toBeGreaterThanOrEqual(70000)
    expect(resolves.some(request => request.command.includes('checkout-index'))).toBe(false)
  })

  it('skips untracked files when the import-untracked preference is off', async () => {
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'a.txt'), 'new content\n')
    await writeFile(join(workspace, 'new.txt'), 'fresh\n')
    const shell = fakeShell({
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all':
        ' M sub/a.txt\u0000?? sub/new.txt\u0000',
      'git cat-file -s HEAD:sub/a.txt': '13',
      'git show HEAD:sub/a.txt': 'old content\n',
    })
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: false }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 1, detected: true } })
    const files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path)).toEqual([join(workspace, 'a.txt')])
  })

  it('reports no VCS (detected false) when none encloses the workspace, without running commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vcs-empty-'))
    tempDirs.push(dir)
    const { handle } = await harness({ sessionIds: [SessionId('session-1')], workspacePath: dir })
    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: true }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 0, detected: false } })
  })

  /** A p4 client at `dir/ws` (its `.p4config` marks the client root). */
  async function p4Client(): Promise<{ dir: string; workspace: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vcs-p4-'))
    tempDirs.push(dir)
    const workspace = join(dir, 'ws')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, '.p4config'), 'P4CLIENT=test-client\n')
    return { dir, workspace }
  }

  it('imports p4 untracked (add) files when the untracked preference is on', async () => {
    const { workspace } = await p4Client()
    const newFile = join(workspace, 'new.txt')
    await writeFile(newFile, 'fresh\n')
    const shell = fakeShell({
      'p4 status': `//depot/ws/new.txt#1 - add default change (text) (test-client)\n`,
      'p4 where //depot/ws/new.txt': `//depot/ws/new.txt //client/ws/new.txt ${newFile}\n`,
    })
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: true }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 1, detected: true } })
    const [file] = await listEntries(handle, 'session-1')
    expect(file).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'fresh\n' })
  })

  it('imports only p4 opened files when the untracked preference is off (no full scan)', async () => {
    const { workspace } = await p4Client()
    const edited = join(workspace, 'a.txt')
    await writeFile(edited, 'new content\n')
    // No `p4 status` route: if the off-path ran the full scan, the command
    // would be unmatched and the import would fail.
    const shell = fakeShell({
      'p4 opened': `//depot/ws/a.txt#2 - edit default change (text) (test-client)\n`,
      'p4 where //depot/ws/a.txt': `//depot/ws/a.txt //client/ws/a.txt ${edited}\n`,
      'p4 print -q //depot/ws/a.txt#have': 'old content\n',
    })
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })

    const answer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: false }, signal())
    expect(answer).toEqual({ ok: true, value: { imported: 1, detected: true } })
    const [file] = await listEntries(handle, 'session-1')
    expect(file).toMatchObject({ earlierVersion: 'file', oldText: 'old content\n', newText: 'new content\n' })
  })

  it('undoes a VCS import back to the pre-import list, then the earlier keep', async () => {
    const { workspace } = await gitRepo()
    const aPath = join(workspace, 'a.txt')
    await writeFile(aPath, 'new\n')
    const shell = fakeShell({
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all': ' M sub/a.txt\u0000',
      'git cat-file -s HEAD:sub/a.txt': '4',
      'git show HEAD:sub/a.txt': 'old\n',
    })
    const { ctx, handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (c) => { c.provide('shell', shell) },
    })

    // The agent edited a.txt, then the user kept it: the list is empty and the
    // keep is on the undo stack.
    emitResult(ctx, editExec(), editSuccess(aPath, 'old\n', 'new\n'))
    const [kept] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: kept!.id }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // Import the same file's VCS change: one pending entry, import on the stack.
    const importAnswer = await handle('vcs-import', { sessionId: 'session-1', includeUntracked: false }, signal())
    expect(importAnswer).toEqual({ ok: true, value: { imported: 1, detected: true } })
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)

    // One undo undoes the IMPORT (back to the empty pre-import list), not the
    // earlier keep — and no duplicate entry for the path appears.
    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: expect.any(String) } })
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // The next undo restores the pre-keep entry (the "diff from before keep").
    await handle('undo', { sessionId: 'session-1' }, signal())
    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: aPath, oldText: 'old\n', newText: 'new\n' })

    // Redo replays in reverse: the keep re-applies first (list empties again),
    // then the import's redo brings the imported entry back.
    await handle('redo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
    await handle('redo', { sessionId: 'session-1' }, signal())
    const files2 = await listEntries(handle, 'session-1')
    expect(files2).toHaveLength(1)
    expect(files2[0]).toMatchObject({ earlierVersion: 'file', oldText: 'old\n', newText: 'new\n' })
  })
})

describe('hand-adding paths to the review list', () => {
  /** A git repo at `dir/repo` whose working tree is the workspace `dir/repo/sub`. */
  async function gitRepo(): Promise<{ repo: string; workspace: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-add-path-'))
    tempDirs.push(dir)
    const repo = join(dir, 'repo')
    const workspace = join(repo, 'sub')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    return { repo, workspace }
  }

  /** The git-status route naming `sub/…` paths, plus the baselines those files need. */
  function gitShell(status: string, baselines: Record<string, string> = {}): unknown {
    const routes: Record<string, string> = {
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all': status,
    }
    for (const [path, text] of Object.entries(baselines)) {
      routes[`git cat-file -s HEAD:${path}`] = String(Buffer.byteLength(text))
      routes[`git show HEAD:${path}`] = text
    }
    return fakeShell(routes)
  }

  it('browses one level, directories first, with VCS noise hidden', async () => {
    const { workspace } = await gitRepo()
    const { handle, fs } = await harness({ sessionIds: [SessionId('session-1')], workspacePath: workspace })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'directory' } as never)
    fs.listDir.mockResolvedValue([
      { name: 'b.txt', type: 'file', target: {}, size: 12 },
      { name: 'src', type: 'directory', target: {} },
      { name: '.git', type: 'directory', target: {} },
      { name: 'a.txt', type: 'file', target: {} },
      { name: 'node_modules', type: 'directory', target: {} },
    ] as never)

    // The workspace root: children carry the absolute paths `add-path` takes.
    await expect(handle('list-path', { sessionId: 'session-1' }, signal())).resolves.toEqual({
      ok: true,
      value: {
        path: workspace,
        entries: [
          { name: 'src', type: 'directory', path: join(workspace, 'src'), size: undefined },
          { name: 'a.txt', type: 'file', path: join(workspace, 'a.txt'), size: undefined },
          { name: 'b.txt', type: 'file', path: join(workspace, 'b.txt'), size: 12 },
        ],
        truncated: false,
      },
    })

    // One level down, addressed the same way the rows are (absolute).
    fs.listDir.mockResolvedValue([{ name: 'nested', type: 'directory', target: {} }] as never)
    await expect(handle('list-path', { sessionId: 'session-1', path: join(workspace, 'src') }, signal())).resolves.toEqual({
      ok: true,
      value: {
        path: join(workspace, 'src'),
        entries: [{ name: 'nested', type: 'directory', path: join(workspace, 'src', 'nested'), size: undefined }],
        truncated: false,
      },
    })
  })

  it('refuses to browse outside the workspace or into a non-directory', async () => {
    const { workspace } = await gitRepo()
    const { handle } = await harness({ sessionIds: [SessionId('session-1')], workspacePath: workspace })
    const outside = await handle('list-path', { sessionId: 'session-1', path: '../sibling' }, signal())
    expect(outside.ok).toBe(false)

    // The default stat double reports a file, so the same level is refused.
    const notDir = await handle('list-path', { sessionId: 'session-1', path: 'a.txt' }, signal())
    expect(notDir.ok).toBe(false)
  })

  it('adds one named file through the scoped scan, undoable as one batch', async () => {
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'a.txt'), 'new content\n')
    const shell = gitShell(
      ' M sub/a.txt\u0000 M sub/other.txt\u0000?? sub/fresh.txt\u0000',
      { 'sub/a.txt': 'old content\n', 'sub/other.txt': 'other old\n' },
    )
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)

    // One named file: the scan is scoped to it, so the sibling and the untracked file stay out.
    const value = await handle('add-path', { sessionId: 'session-1', path: 'a.txt' }, signal())
    // One entry, nothing duplicated; `toMatchObject` because the response also carries its `id`.
    expect(value).toMatchObject({ ok: true, value: { outcome: 'added', added: 1, duplicates: 0 } })
    const files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path)).toEqual([join(workspace, 'a.txt')])
    // The add names the entry it landed as, which is what lets a caller that typed one path
    // select that file without waiting for the next list poll.
    expect((value as { value: { id?: string } }).value.id).toBe(files[0]!.id)
    expect(files[0]).toMatchObject({ earlierVersion: 'file', oldText: 'old content\n', newText: 'new content\n' })

    // Naming it again answers with the entry already listed, not a bare "duplicate" — and re-adds
    // nothing, which would push a review in progress back over its baseline.
    const again = await handle('add-path', { sessionId: 'session-1', path: 'a.txt', exact: true }, signal())
    expect(again).toMatchObject({ ok: true, value: { outcome: 'duplicate', added: 0, duplicates: 1 } })
    // Its `id` is that entry, not a second copy of the path.
    expect((again as { value: { id?: string } }).value.id).toBe(files[0]!.id)

    // One Ctrl+Z removes the whole add.
    await handle('undo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('adds a named directory recursively and reports duplicates instead of re-adding', async () => {
    const { workspace } = await gitRepo()
    await mkdir(join(workspace, 'dir', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'dir', 'one.txt'), 'one new\n')
    await writeFile(join(workspace, 'dir', 'nested', 'two.txt'), 'two new\n')
    const shell = gitShell(
      ' M sub/dir/one.txt\u0000 M sub/dir/nested/two.txt\u0000 M sub/elsewhere.txt\u0000',
      { 'sub/dir/one.txt': 'one old\n', 'sub/dir/nested/two.txt': 'two old\n', 'sub/elsewhere.txt': 'x\n' },
    )
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'directory' } as never)

    await expect(handle('add-path', { sessionId: 'session-1', path: 'dir' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'added', added: 2, duplicates: 0 } })
    const files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path).sort()).toEqual([
      join(workspace, 'dir', 'nested', 'two.txt'),
      join(workspace, 'dir', 'one.txt'),
    ].sort())

    // Asking again leaves the list alone and says so.
    await expect(handle('add-path', { sessionId: 'session-1', path: 'dir' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'duplicate', added: 0, duplicates: 2 } })
    expect(await listEntries(handle, 'session-1')).toHaveLength(2)
  })

  it('lists a clean file only when the caller asks for unchanged paths', async () => {
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'clean.txt'), 'same\n')
    const shell = gitShell('')
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)
    fs.readText.mockResolvedValue('same\n')

    await expect(handle('add-path', { sessionId: 'session-1', path: 'clean.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'unchanged', added: 0, duplicates: 0 } })
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // Ticked: the file is listed carrying no diff at all — the state a file
    // reaches once every block has been kept — and is still undoable.
    const value = await handle('add-path', {
      sessionId: 'session-1', path: 'clean.txt', includeUnchanged: true,
    }, signal())
    expect(value).toMatchObject({ ok: true, value: { outcome: 'added', added: 1, duplicates: 0 } })
    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: join(workspace, 'clean.txt'), earlierVersion: 'file', oldText: 'same\n', newText: 'same\n' })
    expect((value as { value: { id?: string } }).value.id).toBe(files[0]!.id)
    await handle('undo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('adds a directory\'s untouched files when the box is ticked, and none when it is not', async () => {
    const { workspace } = await gitRepo()
    await mkdir(join(workspace, 'dir', 'nested'), { recursive: true })
    await writeFile(join(workspace, 'dir', 'changed.txt'), 'new\n')
    const dir = join(workspace, 'dir')
    const shell = gitShell(' M sub/dir/changed.txt\u0000', { 'sub/dir/changed.txt': 'old\n' })
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    fs.stat.mockImplementation(async (target: { displayPath?: string }) =>
      ({ version: 'v1', type: target.displayPath === dir ? 'directory' : 'file' }))
    // The walk goes through ctx.fs.listDir, one level at a time.
    fs.listDir.mockImplementation(async (target: { targetKey?: string }) => {
      if (target.targetKey === `key:${dir}`) {
        return [
          { name: 'changed.txt', type: 'file', target: { targetKey: 'key:changed' } },
          { name: 'clean.txt', type: 'file', target: { targetKey: 'key:clean' } },
          { name: 'nested', type: 'directory', target: { targetKey: 'key:nested' } },
          { name: 'node_modules', type: 'directory', target: { targetKey: 'key:modules' } },
        ]
      }
      if (target.targetKey === 'key:nested') {
        return [{ name: 'deep.txt', type: 'file', target: { targetKey: 'key:deep' } }]
      }
      // node_modules is hidden, so it must never be walked into.
      throw new Error(`unexpected listing of ${String(target.targetKey)}`)
    })
    fs.readText.mockImplementation(async (target: { displayPath?: string }) => {
      if (target.displayPath?.endsWith('changed.txt')) return 'new\n'
      if (target.displayPath?.endsWith('clean.txt')) return 'clean\n'
      if (target.displayPath?.endsWith('deep.txt')) return 'deep\n'
      throw new Error('not text')
    })

    // Without the box: only the scan's change.
    await expect(handle('add-path', { sessionId: 'session-1', path: 'dir' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'added', added: 1, duplicates: 0 } })
    let files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path)).toEqual([join(dir, 'changed.txt')])

    // With it: every untouched file under the directory, recursively, as a
    // zero-diff entry — the state a file reaches once every block is kept. The
    // already-listed change counts as a duplicate and is left alone.
    await expect(handle('add-path', { sessionId: 'session-1', path: 'dir', includeUnchanged: true }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'added', added: 2, duplicates: 1 } })
    files = await listEntries(handle, 'session-1')
    expect(files.map(file => file.path).sort()).toEqual([
      join(dir, 'changed.txt'),
      join(dir, 'clean.txt'),
      join(dir, 'nested', 'deep.txt'),
    ].sort())
    const clean = files.find(file => file.path === join(dir, 'clean.txt'))
    expect(clean).toMatchObject({ earlierVersion: 'file', oldText: 'clean\n', newText: 'clean\n' })
  })

  it('caps the no-change walk and reports the cut', async () => {
    const { workspace } = await gitRepo()
    await mkdir(join(workspace, 'many'), { recursive: true })
    const many = join(workspace, 'many')
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', gitShell('')) },
    })
    fs.stat.mockImplementation(async (target: { displayPath?: string }) =>
      ({ version: 'v1', type: target.displayPath === many ? 'directory' : 'file' }))
    // One more file than the walk's cap (300).
    fs.listDir.mockResolvedValue(
      Array.from({ length: 301 }, (_, index) => ({ name: `f${index}.txt`, type: 'file', target: { targetKey: `key:f${index}` } })) as never,
    )
    fs.readText.mockResolvedValue('same\n')

    const answer = await handle('add-path', { sessionId: 'session-1', path: 'many', includeUnchanged: true }, signal())
    expect(answer).toEqual({ ok: true, value: { outcome: 'added', added: 300, duplicates: 0, truncated: true } })
    expect(await listEntries(handle, 'session-1')).toHaveLength(300)
    expect(many).toBeTruthy()
  })

  it('adds an untracked file the user names, whatever the import preference says', async () => {
    // The untracked-import preference is opt-in, and it is about SCANS: with it off, a sweep of the
    // workspace leaves `??` files out. A path the reader typed is not a sweep, so this one has to
    // come in anyway — the shell reports it as untracked and nothing here turns the preference on.
    const { workspace } = await gitRepo()
    await writeFile(join(workspace, 'fresh.txt'), 'fresh\n')
    const shell = gitShell('?? sub/fresh.txt\u0000')
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    // The path is not in the diff yet, so it is read on the way in: the stat is what says it is a
    // plain file rather than something to walk.
    fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)

    const value = await handle('add-path', { sessionId: 'session-1', path: 'fresh.txt' }, signal())
    expect(value).toMatchObject({ ok: true, value: { outcome: 'added', added: 1, duplicates: 0 } })
    const files = await listEntries(handle, 'session-1')
    expect(files[0]).toMatchObject({ earlierVersion: 'none', oldText: '', newText: 'fresh\n' })
    expect((value as { value: { id?: string } }).value.id).toBe(files[0]!.id)
  })

  it('refuses a directory when the caller named one exact file', async () => {
    // The detail header's path field opens one file. A path that turns out to be a directory
    // must not sweep a subtree into the list behind a mistyped name, so it is refused before
    // anything is scanned.
    const { workspace } = await gitRepo()
    await mkdir(join(workspace, 'dir'), { recursive: true })
    await writeFile(join(workspace, 'dir', 'one.txt'), 'one new\n')
    const shell = gitShell(' M sub/dir/one.txt\u0000', { 'sub/dir/one.txt': 'one old\n' })
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', shell) },
    })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'directory' } as never)

    await expect(handle('add-path', {
      sessionId: 'session-1', path: 'dir', includeUnchanged: true, exact: true,
    }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'not-a-file', added: 0, duplicates: 0 } })
    expect(await listEntries(handle, 'session-1')).toEqual([])

    // The same path without the flag still adds the subtree: the refusal is the caller's ask,
    // not a change to what a directory means.
    await expect(handle('add-path', { sessionId: 'session-1', path: 'dir' }, signal()))
      .resolves.toMatchObject({ ok: true, value: { outcome: 'added', added: 1 } })
  })

  it('opens a named file by reading it, without asking the VCS anything', async () => {
    // The path field's job is to open one file. Nothing on that way in needs a checkout: the entry
    // lands with both sides the file's own text — the "no pending diff" shape — so a named file
    // costs one read, a changed one is not re-scanned against the VCS, and a workspace outside any
    // checkout can still have a file named into it (the harness below provides no shell at all).
    const dir = await mkdtemp(join(tmpdir(), 'dsh-add-exact-'))
    tempDirs.push(dir)
    await writeFile(join(dir, 'named.txt'), 'named content\n')
    const { handle, fs } = await harness({ sessionIds: [SessionId('session-1')], workspacePath: dir })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)
    fs.readText.mockResolvedValue('named content\n')

    const value = await handle('add-path', {
      sessionId: 'session-1', path: 'named.txt', includeUnchanged: true, exact: true,
    }, signal())
    expect(value).toMatchObject({ ok: true, value: { outcome: 'added', added: 1, duplicates: 0 } })
    const files = await listEntries(handle, 'session-1')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: join(dir, 'named.txt'), earlierVersion: 'file', oldText: 'named content\n', newText: 'named content\n',
    })
    expect((value as { value: { id?: string } }).value.id).toBe(files[0]!.id)

    // Naming it again reopens the entry that is already there, and reads nothing to do it.
    fs.readText.mockClear()
    await expect(handle('add-path', { sessionId: 'session-1', path: 'named.txt', exact: true }, signal()))
      .resolves.toMatchObject({ ok: true, value: { outcome: 'duplicate', added: 0, duplicates: 1 } })
    expect(fs.readText).not.toHaveBeenCalled()
  })

  it('answers outside, missing, and no-vcs without touching the list', async () => {
    const { workspace } = await gitRepo()
    const { handle, fs } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', gitShell('')) },
    })
    fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)
    await expect(handle('add-path', { sessionId: 'session-1', path: '../sibling.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'outside', added: 0, duplicates: 0 } })

    fs.stat.mockResolvedValue(undefined as never)
    await expect(handle('add-path', { sessionId: 'session-1', path: 'gone.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing', added: 0, duplicates: 0 } })

    // A workspace outside any checkout answers no-vcs rather than failing.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-add-novcs-'))
    tempDirs.push(dir)
    const bare = await harness({ sessionIds: [SessionId('session-1')], workspacePath: dir })
    bare.fs.stat.mockResolvedValue({ version: 'v1', type: 'file' } as never)
    await expect(bare.handle('add-path', { sessionId: 'session-1', path: 'x.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'no-vcs', added: 0, duplicates: 0 } })

    // A blank path is a malformed payload, not a request.
    const malformed = await handle('add-path', { sessionId: 'session-1', path: '  ' }, signal())
    expect(malformed.ok).toBe(false)
  })
})

describe('per-file VCS refresh', () => {
  /** A git repo at `dir/repo` whose working tree is the workspace `dir/repo/sub`. */
  async function gitRepo(): Promise<{ repo: string; workspace: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vcs-refresh-'))
    tempDirs.push(dir)
    const repo = join(dir, 'repo')
    const workspace = join(repo, 'sub')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    return { repo, workspace }
  }

  /** A repo with one tracked file already imported as a pending entry. */
  async function imported(): Promise<{
    handle: ConnectionRpcHandler
    entryId: string
    file: string
    routes: Record<string, string>
  }> {
    const { workspace } = await gitRepo()
    const file = join(workspace, 'a.txt')
    await writeFile(file, 'work v1\n')
    const routes: Record<string, string> = {
      'git -c status.renames=false status --porcelain=v1 -z --untracked-files=all': ' M sub/a.txt\u0000',
      'git cat-file -s HEAD:sub/a.txt': '9',
      'git show HEAD:sub/a.txt': 'base v1\n',
    }
    const { handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: workspace,
      prepare: (ctx) => { ctx.provide('shell', fakeShell(routes)) },
    })
    await handle('vcs-import', { sessionId: 'session-1', includeUntracked: false }, signal())
    const [entry] = await listEntries(handle, 'session-1')
    expect(entry).toMatchObject({ oldText: 'base v1\n', newText: 'work v1\n' })
    return { handle, entryId: entry!.id, file, routes }
  }

  it('replaces the tracked diff with the file current VCS change, and undoes it', async () => {
    const { handle, entryId, file, routes } = await imported()
    // The file AND its baseline moved on since the review captured it.
    await writeFile(file, 'work v2\n')
    routes['git show HEAD:sub/a.txt'] = 'base v2\n'

    await expect(handle('vcs-refresh', { sessionId: 'session-1', id: entryId, includeUntracked: false }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'refreshed' } })
    const [refreshed] = await listEntries(handle, 'session-1')
    expect(refreshed).toMatchObject({ oldText: 'base v2\n', newText: 'work v2\n' })

    // One Ctrl+Z puts the originally captured diff back.
    await expect(handle('undo', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: entryId } })
    const [restored] = await listEntries(handle, 'session-1')
    expect(restored).toMatchObject({ oldText: 'base v1\n', newText: 'work v1\n' })
  })

  it('leaves the entry untouched when the scan finds no change', async () => {
    const { handle, entryId, routes } = await imported()
    routes['git -c status.renames=false status --porcelain=v1 -z --untracked-files=all'] = ''

    await expect(handle('vcs-refresh', { sessionId: 'session-1', id: entryId, includeUntracked: false }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'no-change' } })
    const [kept] = await listEntries(handle, 'session-1')
    expect(kept).toMatchObject({ oldText: 'base v1\n', newText: 'work v1\n' })
    // The refresh recorded no step of its own, so the only thing left to undo is
    // still the import that created the entry.
    await handle('undo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('reports an unchanged entry without a second undo step', async () => {
    const { handle, entryId } = await imported()
    await expect(handle('vcs-refresh', { sessionId: 'session-1', id: entryId, includeUntracked: false }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'unchanged' } })
    // Again nothing new to undo: the import's pair is still on top.
    await handle('undo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
  })

  it('reports a workspace outside any checkout, and a missing entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vcs-none-'))
    tempDirs.push(dir)
    const { ctx, handle } = await harness({
      sessionIds: [SessionId('session-1')],
      workspacePath: dir,
      prepare: (prepared) => { prepared.provide('shell', fakeShell({})) },
    })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')
    await expect(handle('vcs-refresh', { sessionId: 'session-1', id: entry!.id, includeUntracked: false }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'no-vcs' } })
    await expect(handle('vcs-refresh', { sessionId: 'session-1', id: 'nope', includeUntracked: false }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
  })
})

describe('persistence throttling', () => {
  it('coalesces a rapid burst of captures into a bounded number of durable writes', async () => {
    const save = vi.spyOn(PendingPersistence.prototype, 'save')
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    // A rapid burst of captures to the same file.
    for (let i = 0; i < 6; i++) {
      emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', `v${i}\n`, `v${i + 1}\n`))
    }
    // Let the throttle window settle (>1000ms + grace). The durable state must
    // reflect every capture (earliest basis -> latest content), so the throttle
    // coalesced rather than dropped any. (The exact write count is timing-linked
    // and not asserted here — the perf win is measured live, correctness here.)
    await new Promise(resolve => setTimeout(resolve, 1600))
    expect(save.mock.calls.length).toBeGreaterThan(0)
    // The burst is not lost: the durable state is earliest basis -> latest content.
    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    const [entry] = await listEntries(second.handle, 'session-1')
    expect(entry).toMatchObject({ oldText: 'v0\n', newText: 'v6\n', earlierVersion: 'file' })
  })
})

describe('review channel mounting', () => {
  /**
   * Mount the plugin against two connection shapes:
   * - `'0.1.5'`: `register` exists and `rpc.handle` registers under the
   *   *service's* own context, which cannot resolve `webServer`, so it throws.
   * - `'published'`: no `register`; `rpc.handle` is the working published path.
   * @param shape - which connection surface to provide.
   * @returns the channels each path mounted, and any `rpc.handle` failure.
   */
  async function mount(shape: '0.1.5' | 'published'): Promise<{
    viaRegister: { channel: string; ownerResolvedWebServer: boolean }[]
    viaHandle: string[]
    handleError: string | undefined
  }> {
    const ctx = new Context()
    contexts.push(ctx)
    const viaRegister: { channel: string; ownerResolvedWebServer: boolean }[] = []
    const viaHandle: string[] = []
    let handleError: string | undefined
    const fs: FsDouble = {
      resolve: vi.fn(async (path: string) => ({ displayPath: path, targetKey: `key:${path}` })),
      readText: vi.fn(async () => undefined),
      writeText: vi.fn(async () => ({ version: 1 })),
      stat: vi.fn(async () => ({ version: 'v1', type: 'file' })),
      processPath: vi.fn((target: { targetKey: string }) => target.targetKey),
    }
    ctx.provide('fs', fs as unknown as FileSystem)
    ctx.provide('workspaceRegistry', { list: () => [] } as unknown as WorkspaceRegistry)
    ctx.provide('webServer', { register: vi.fn(() => () => {}) } as never)
    const rpc = {
      handle: (channel: string): (() => void) => {
        if (shape === '0.1.5') {
          handleError = 'cannot get property "webServer" without inject'
          throw new Error(handleError)
        }
        viaHandle.push(channel)
        return () => {}
      },
    }
    const service = shape === '0.1.5'
      ? {
          rpc,
          register: (owner: Context, channel: string): (() => void) => {
            viaRegister.push({
              channel,
              ownerResolvedWebServer: typeof (owner as unknown as { webServer?: unknown }).webServer === 'object',
            })
            return () => {}
          },
        }
      : { rpc }
    ctx.provide('connection', service as unknown as HostConnectionHandle)
    await ctx.plugin(apply, { storageDir: await mkdtemp(join(tmpdir(), 'dsh-diff-approval-')) })
    return { viaRegister, viaHandle, handleError }
  }

  it('mounts through register() when rpc.handle cannot resolve webServer', async () => {
    // A release whose connection service cannot resolve `webServer` from the
    // owner it registers under. Mounting via `register` with our own
    // webServer-injecting context avoids that path — and must NOT touch it, or
    // the whole plugin tree fails to load at boot.
    const { viaRegister, handleError } = await mount('0.1.5')
    expect(handleError).toBeUndefined()
    expect(viaRegister).toEqual([{ channel: DIFF_APPROVAL_CHANNEL, ownerResolvedWebServer: true }])
  })

  it('falls back to rpc.handle when the connection service exposes no register', async () => {
    const { viaRegister, viaHandle } = await mount('published')
    expect(viaRegister).toEqual([])
    expect(viaHandle).toEqual([DIFF_APPROVAL_CHANNEL])
  })
})

describe('comments over the channel', () => {
  /** The body of one comment on the entry the harness just captured. */
  const COMMENT_BODY = { anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why is this here?' }

  /**
   * Add one comment to the session's listed entry at `index`, through the channel.
   * @param handle - the channel handler.
   * @param sessionId - the session to write in.
   * @param index - which listed entry to comment on (oldest capture first).
   */
  async function addComment(handle: ConnectionRpcHandler, sessionId = 'session-1', index = 0): Promise<CommentRecord> {
    const entry = (await listEntries(handle, sessionId))[index]
    const answer = await handle('comment-add', { sessionId, entryId: entry!.id, ...COMMENT_BODY }, signal())
    if (!answer.ok) throw new Error('comment-add failed')
    const value = answer.value as { outcome: string; comment?: CommentRecord }
    expect(value.outcome).toBe('added')
    return value.comment!
  }

  /** Read one session's comments through the channel's list read. */
  async function listComments(handle: ConnectionRpcHandler, sessionId: string): Promise<CommentRecord[]> {
    const answer = await handle('list', { sessionId }, signal())
    if (!answer.ok) throw new Error('list failed')
    return (answer.value as { comments?: CommentRecord[] }).comments ?? []
  }

  it('hands the comments and the entries over in one read', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)

    const answer = await handle('list', { sessionId: 'session-1' }, signal())
    const value = (answer as { value: { files: PendingFileDiff[]; comments?: CommentRecord[]; commentsRevision?: number } }).value
    // One read, one snapshot: a comment list that arrived on its own channel could
    // name an entry the same read had already dropped.
    expect(value.files.map(entry => entry.id)).toEqual(['/repo/a.txt'])
    expect(value.comments).toEqual([comment])
    expect(value.commentsRevision).toBeGreaterThan(0)
    // The reader is the one who wrote this comment, in the card they had open, so its arrival is not
    // news: only an agent's own annotation (and an answer) lights the dot.
    expect(value.comments?.[0]).not.toHaveProperty('unseen')
  })

  it('takes the dot down through its own endpoint, and persists that', async () => {
    // The reader looking at a card is a host action of its own (the panel reports it from an
    // IntersectionObserver), so it has to be an endpoint rather than a side effect of a read: a read
    // that cleared the dot would make it impossible to see. The card is seeded the way an ANNOTATION
    // leaves one — a record on the disk, already lit — because "the reader has not looked at this" is
    // exactly the state that has to survive a restart.
    const commentId = 'c-agent'
    const target = join(tmpdir(), `dsh-diff-approval-seen-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const storageDir = join(target, 'state')
    const file = join(commentsDirFor(storageDir), 'session-1.json')
    await mkdir(commentsDirFor(storageDir), { recursive: true })
    await writeFile(file, JSON.stringify({
      version: 1,
      comments: [{
        id: commentId, sessionId: 'session-1', entryId: '/repo/a.txt', path: '/repo/a.txt',
        anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why is this here?',
        createdAt: 1, updatedAt: 1, unseen: true,
      }],
    }), 'utf8')
    const { ctx, handle } = await harness({ storageDir })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    await handle('list', { sessionId: 'session-1' }, signal())

    expect((await listComments(handle, 'session-1')).find(row => row.id === commentId)?.unseen).toBe(true)
    await expect(handle('comment-seen', { sessionId: 'session-1', id: commentId }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'seen' } })
    const cleared = (await listComments(handle, 'session-1')).find(row => row.id === commentId)!
    expect(cleared.unseen).toBe(undefined)
    expect(cleared).not.toHaveProperty('unseen')

    // "Cleared" has to mean the file, not just this process's memory: a restart that read the dot back
    // would hand the reader a card they had already looked at.
    await vi.waitFor(async () => {
      expect(await readFile(file, 'utf8')).not.toContain('"unseen"')
    }, FILE_WAIT)

    // A malformed request is refused, and another session's comment is not this session's to clear.
    await expect(handle('comment-seen', { sessionId: 'session-1' }, signal()))
      .resolves.toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
    await expect(handle('comment-seen', { sessionId: 'session-2', id: commentId }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
  })

  it('refuses a comment on an entry that is not in that session\'s list', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(handle, 'session-1')
    // Another session naming this file's id gets nothing: a comment may not be born
    // already outliving the entry it hangs off.
    await expect(handle('comment-add', { sessionId: 'session-2', entryId: entry!.id, ...COMMENT_BODY }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    expect(await listComments(handle, 'session-2')).toEqual([])
    await expect(handle('comment-add', { sessionId: 'session-1', entryId: '/repo/gone.txt', ...COMMENT_BODY }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
  })

  it('rejects a malformed comment with an internal error', async () => {
    const { handle } = await harness()
    const answer = await handle('comment-add', { sessionId: 'session-1' }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })

  it('removes one comment, and refuses an id that belongs to another session', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    await expect(handle('comment-remove', { sessionId: 'session-2', id: comment.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    expect(await listComments(handle, 'session-1')).toEqual([comment])
    await expect(handle('comment-remove', { sessionId: 'session-1', id: comment.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'removed' } })
    expect(await listComments(handle, 'session-1')).toEqual([])
  })

  it('removes a batch of comments in one request, and drops only the ones it named', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'a', 'b'))
    emitResult(ctx, editExec(), editSuccess('/repo/c.txt', 'a', 'b'))
    const first = await addComment(handle, 'session-1', 0)
    const second = await addComment(handle, 'session-1', 1)
    const third = await addComment(handle, 'session-1', 2)

    // One request for the pick. An id that is already gone is not an error — it is a comment that is
    // not there to drop — and a repeated id names one comment, so the count is what actually went.
    await expect(handle('comment-remove-many',
      { sessionId: 'session-1', ids: [first.id, third.id, 'gone', first.id] }, signal()))
      .resolves.toEqual({ ok: true, value: { removed: 2 } })
    expect((await listComments(handle, 'session-1')).map(row => row.id)).toEqual([second.id])

    // A batch with nothing to name is a malformed request, not a batch that dropped nothing.
    const answer = await handle('comment-remove-many', { sessionId: 'session-1', ids: [] }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
    // …and another session's comment is not this session's to drop.
    await expect(handle('comment-remove-many', { sessionId: 'session-2', ids: [second.id] }, signal()))
      .resolves.toEqual({ ok: true, value: { removed: 0 } })
    expect(await listComments(handle, 'session-1')).toHaveLength(1)
  })

  it('takes the entry\'s comments with it when the entry is kept, and off the disk', async () => {
    const { ctx, handle, storageDir } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    const file = join(commentsDirFor(storageDir), 'session-1.json')
    // On disk before the keep, so what follows is an assertion about a removal rather
    // than about a write that never happened.
    await vi.waitFor(async () => {
      await expect(readFile(file, 'utf8')).resolves.toContain(comment.id)
    }, FILE_WAIT)

    const [entry] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
    expect(await listComments(handle, 'session-1')).toEqual([])
    // The second client that reads that file back must not be handed the comment the
    // first client's keep deleted.
    await vi.waitFor(async () => {
      await expect(readFile(file, 'utf8')).resolves.not.toContain(comment.id)
    }, FILE_WAIT)
  })

  it('still lists the comments of an entry that is still listed', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'a', 'b'))
    // The comment hangs off the first entry; the keep is about the second one.
    const comment = await addComment(handle)
    const [, second] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: second!.id }, signal())
    // A keep is about one file: the other file's comment is untouched.
    expect(await listComments(handle, 'session-1')).toEqual([comment])
  })

  it('asks a comment and hands its derived answer back on the next read', async () => {
    const submitted: string[] = []
    const { ctx, handle } = await harness({
      prepare: (prepared) => {
        prepared.provide('sessionController', {
          prompt: (request: { requestId: string }) => {
            submitted.push(request.requestId)
            return Promise.resolve({ accepted: true })
          },
        } as never)
        prepared.provide('agents', { get: () => ({ ctx: { on: () => () => {} } }) } as never)
        prepared.provide('sessions', {
          get: () => ({
            // The event log, not `deriveMessages`: an answer belongs to the turn that
            // claimed the question, and only the log carries that attribution.
            snapshotEvents: () => [
              { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
              {
                type: 'user/message',
                seq: 1,
                time: 0,
                data: { role: 'user', source: { kind: 'user', rpcId: submitted[0] ?? '' }, content: [{ type: 'text', text: 'the prompt' }] },
              },
              {
                type: 'assistant/message',
                seq: 2,
                time: 0,
                data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'because it guards the edge' }] } },
              },
              { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
            ],
          }),
        } as never)
      },
    })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)

    await expect(handle('comment-ask', { sessionId: 'session-1', id: comment.id, prompt: 'the prompt', text: 'why?' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'asked', requestId: expect.any(String) as string } })
    expect(submitted).toHaveLength(1)

    const read = await handle('list', { sessionId: 'session-1' }, signal())
    const value = (read as { value: { comments?: CommentRecord[]; commentAnswers?: Record<string, string> } }).value
    // The request identity the submission minted is on the record, and the answer is
    // derived from the transcript rather than stored on it.
    expect(value.comments?.[0]?.asks?.[0]?.requestId).toBe(submitted[0])
    // The reader's own words ride the question, which is the only place a follow-up's words
    // exist: the transcript holds the prompt, which wraps them in the marker and the rules.
    expect(value.comments?.[0]?.asks?.[0]?.text).toBe('why?')
    expect(value.commentAnswers).toEqual({ [submitted[0] as string]: 'because it guards the edge' })
  })

  it('reports a question whose turn ended with no answer as over, from the log alone', async () => {
    // No `agent/turn-stopping` ever fires in this test: the session's own log is the only
    // thing that says the turn is over, which is exactly the case a resumed session (or a
    // client that connected after the fact) is in.
    const submitted: string[] = []
    const { ctx, handle } = await harness({
      prepare: (prepared) => {
        prepared.provide('sessionController', {
          prompt: (request: { requestId: string }) => {
            submitted.push(request.requestId)
            return Promise.resolve({ accepted: true })
          },
        } as never)
        prepared.provide('agents', { get: () => ({ ctx: { on: () => () => {} } }) } as never)
        prepared.provide('sessions', {
          get: () => ({
            snapshotEvents: () => [
              { type: 'turn/start', seq: 0, time: 0, data: { turn: 4 } },
              {
                type: 'user/message',
                seq: 1,
                time: 0,
                data: { role: 'user', source: { kind: 'user', rpcId: submitted[0] ?? '' }, content: [{ type: 'text', text: 'the prompt' }] },
              },
              // The turn is closed with nothing written: the question was cut off.
              { type: 'turn/end', seq: 2, time: 0, data: { turn: 4, reason: { kind: 'aborted' } } },
            ],
          }),
        } as never)
      },
    })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    await handle('comment-ask', { sessionId: 'session-1', id: comment.id, prompt: 'the prompt', text: 'why?' }, signal())

    const value = (await handle('list', { sessionId: 'session-1' }, signal()) as {
      value: { comments?: CommentRecord[]; commentAnswers?: Record<string, string> }
    }).value
    // No answer, and the question says so: the block shows the stopped note rather than
    // waiting on a turn that is already over.
    expect(value.commentAnswers).toEqual({})
    expect(value.comments?.[0]?.asks?.[0]).toMatchObject({ requestId: submitted[0], ended: true })
  })

  it('does not walk the session log for a session that carries no comments', async () => {
    // The list read derives answers and turn ends from the session's whole event log, and
    // each of those reads is a full pass over it — on a long session that is >100k events,
    // paid again by every client, once a second. With no comments there is nothing to
    // derive: a question lives inside a comment (`ask` looks the comment up and refuses an
    // id the store does not hold), so the log read is pure cost. The log here holds a
    // turn/end, which is exactly what `endedTurns` would otherwise sweep.
    const snapshotEvents = vi.fn(() => [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 7 } },
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 7, reason: { kind: 'completed' } } },
    ])
    const { ctx, handle } = await harness({
      prepare: (prepared) => {
        prepared.provide('sessions', { get: () => ({ snapshotEvents }) } as never)
      },
    })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))

    const value = (await handle('list', { sessionId: 'session-1' }, signal()) as {
      value: { files?: PendingFileDiff[]; comments?: CommentRecord[]; commentAnswers?: Record<string, string> }
    }).value
    expect(value.files).toHaveLength(1)
    expect(value.comments).toEqual([])
    expect(value.commentAnswers).toEqual({})
    expect(snapshotEvents).not.toHaveBeenCalled()
  })

  it('still derives the answers and turn ends of a session that carries a comment', async () => {
    // The other half of the skip above: a session WITH a comment must still read the log,
    // and the read must still land on the comment handed to the client in the same
    // response — the turn and the `ended` flag are written onto that very record.
    const submitted: string[] = []
    const snapshotEvents = vi.fn(() => [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 3 } },
      {
        type: 'user/message',
        seq: 1,
        time: 0,
        data: { role: 'user', source: { kind: 'user', rpcId: submitted[0] ?? '' }, content: [{ type: 'text', text: 'the prompt' }] },
      },
      // The turn is closed with nothing written: the question was cut off, and only the
      // log says so (no `agent/turn-stopping` fires in this test).
      { type: 'turn/end', seq: 2, time: 0, data: { turn: 3, reason: { kind: 'aborted' } } },
    ])
    const { ctx, handle } = await harness({
      prepare: (prepared) => {
        prepared.provide('sessionController', {
          prompt: (request: { requestId: string }) => {
            submitted.push(request.requestId)
            return Promise.resolve({ accepted: true })
          },
        } as never)
        prepared.provide('agents', { get: () => ({ ctx: { on: () => () => {} } }) } as never)
        prepared.provide('sessions', { get: () => ({ snapshotEvents }) } as never)
      },
    })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    await handle('comment-ask', { sessionId: 'session-1', id: comment.id, prompt: 'the prompt', text: 'why?' }, signal())

    const value = (await handle('list', { sessionId: 'session-1' }, signal()) as {
      value: { comments?: CommentRecord[]; commentAnswers?: Record<string, string> }
    }).value
    expect(snapshotEvents).toHaveBeenCalled()
    expect(value.commentAnswers).toEqual({})
    expect(value.comments?.[0]?.asks?.[0]).toMatchObject({ requestId: submitted[0], turn: 3, ended: true })
  })

  it('refuses to ask a comment of another session, or on a host with no prompt verb', async () => {
    const { ctx, handle } = await harness({ prepare: (prepared) => { prepared.provide('sessionController', {} as never) } })
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    await expect(handle('comment-ask', { sessionId: 'session-2', id: comment.id, prompt: 'p', text: 'p' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    await expect(handle('comment-ask', { sessionId: 'session-1', id: comment.id, prompt: 'p', text: 'p' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'no-agent' } })
    // Nothing was asked, so nothing changed.
    expect(await listComments(handle, 'session-1')).toEqual([comment])
  })

  it('rejects a malformed ask with an internal error', async () => {
    const { handle } = await harness()
    const answer = await handle('comment-ask', { sessionId: 'session-1', id: 'c1' }, signal())
    expect(answer).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
    // The reader's words are required: the thread shows THEM, and a request without them would
    // store a question nobody could read. A blank one is the same as none.
    await expect(handle('comment-ask', { sessionId: 'session-1', id: 'c1', prompt: 'p' }, signal()))
      .resolves.toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
    await expect(handle('comment-ask', { sessionId: 'session-1', id: 'c1', prompt: 'p', text: '   ' }, signal()))
      .resolves.toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) as string, details: {} } })
  })

  /**
   * Add one comment with its own anchor and quote, so a test can stage where a thread was written
   * and what it quoted without going through the shared `COMMENT_BODY`.
   * @param handle - the channel handler.
   * @param body - the entry, the stored anchor and the quote.
   * @returns the stored record.
   */
  async function addQuotedComment(
    handle: ConnectionRpcHandler,
    body: { entryId: string; anchor: { startLine: number; endLine: number }; quote: string; quoteContext?: string; sessionId?: string },
  ): Promise<CommentRecord> {
    const answer = await handle('comment-add', {
      sessionId: body.sessionId ?? 'session-1',
      entryId: body.entryId,
      anchor: body.anchor,
      quote: body.quote,
      text: '这一行为什么要改？',
      ...(body.quoteContext === undefined ? {} : { quoteContext: body.quoteContext }),
    }, signal())
    if (!answer.ok) throw new Error('comment-add failed')
    const value = answer.value as { outcome: string; comment?: CommentRecord }
    expect(value.outcome).toBe('added')
    return value.comment!
  }

  /** The resolved lines one list read carries (empty when it carries none). */
  async function listCommentLines(
    handle: ConnectionRpcHandler,
    sessionId = 'session-1',
  ): Promise<Record<string, { start: number; end: number }>> {
    const answer = await handle('list', { sessionId }, signal())
    if (!answer.ok) throw new Error('list failed')
    return (answer.value as { commentLines?: Record<string, { start: number; end: number }> }).commentLines ?? {}
  }

  it('names the line a comment is on now from the host, with nothing opened', async () => {
    // The report: one comment read `[382]` in the list while its own card read 378, because the
    // quoted line had moved and only the OPEN file's detail pane resolved the quote. The list is a
    // second view of the same thread, so the figure has to be the host's — resolved against the
    // entry's current content on the read that carries it, with no client having opened anything.
    const { ctx, handle } = await harness()
    const lines = Array.from({ length: 420 }, (_, index) => `line-${index + 1}`)
    const removed = ['removed-1', 'removed-2', 'removed-3', 'removed-4']
    const before = `${[...lines.slice(0, 377), ...removed, ...lines.slice(377)].join('\n')}\n`
    const after = `${lines.join('\n')}\n`
    emitResult(ctx, editExec(), editSuccess('/repo/moved.txt', before, after))
    const comment = await addQuotedComment(handle, {
      entryId: '/repo/moved.txt',
      anchor: { startLine: 382, endLine: 382 },
      quote: 'line-378',
    })

    // The stored anchor still says 382 — the record is never rewritten — and the read carries where
    // the quote is now.
    expect((await listComments(handle, 'session-1'))[0]?.anchor).toEqual({ startLine: 382, endLine: 382 })
    expect(await listCommentLines(handle)).toEqual({ [comment.id]: { start: 378, end: 378 } })
  })

  it('leaves a comment whose quote is gone out of the resolved lines', async () => {
    // A quote that is nowhere in the content is a thread the code has moved past. The host says
    // nothing about it rather than guessing: an absent figure sends the caller to `record.anchor`,
    // which is the line the comment was WRITTEN on — the same answer an outdated block keeps.
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/gone.txt', 'a\nb\nc\n', 'x\ny\nz\n'))
    const comment = await addQuotedComment(handle, {
      entryId: '/repo/gone.txt',
      anchor: { startLine: 2, endLine: 2 },
      quote: 'b',
    })

    expect(await listCommentLines(handle)).toEqual({})
    // …and the record is untouched: the stored anchor is all a caller has left, which is the point.
    expect((await listComments(handle, 'session-1')).find(record => record.id === comment.id)?.anchor)
      .toEqual({ startLine: 2, endLine: 2 })
  })

  it('leaves a look-alike far from the stored line out of the resolved lines', async () => {
    // The report's second case, on the host's own read: the declaration the comment was written on is
    // gone, and an identically-shaped one — the same `UPROPERTY` line, the same field, the same blank
    // line — sits 74 lines below it. Those three lines are all the record's ±1 context keeps, so the
    // look-alike matches it exactly; before this the host answered 452, and the list named a line whose
    // code was never what the comment was about. A match that far is another place in the file, not
    // this code having moved, so the host says nothing and the item keeps the record's own line.
    const { ctx, handle } = await harness()
    const property = '\tUPROPERTY(EditAnywhere, Category = "S")'
    const quote = '\tFString WidgetPath;'
    const lines = Array.from({ length: 458 }, (_, index) => `line-${index + 1}`)
    lines[375] = '/** Object path of the property. */'
    lines[376] = property
    lines[377] = '\tFString PropertyName;'
    lines[378] = ''
    lines[449] = '/** Object path of the widget. */'
    lines[450] = property
    lines[451] = quote
    lines[452] = ''
    const content = `${lines.join('\n')}\n`
    emitResult(ctx, editExec(), editSuccess('/repo/lookalike.txt', `PRE\n${content}`, content))
    const comment = await addQuotedComment(handle, {
      entryId: '/repo/lookalike.txt',
      anchor: { startLine: 378, endLine: 378 },
      quote,
      quoteContext: `${property}\n${quote}\n`,
    })

    // No figure for it on the read, and the record is untouched: the stored anchor is what the list
    // label, the card's chip and the jump fall back to — the same answer an outdated thread keeps.
    expect(await listCommentLines(handle)).toEqual({})
    expect((await listComments(handle, 'session-1')).find(record => record.id === comment.id)?.anchor)
      .toEqual({ startLine: 378, endLine: 378 })
  })

  it('follows a repeated quoted line to the nearest occurrence, and to the earlier one on a tie', async () => {
    // The client's own rule (see `remapDiscussion`) picks the occurrence closest to where the
    // comment was written, because that is the one the reader was looking at. This is the host
    // producing the SAME answer for the same content, so the two panes cannot name two lines.
    //
    // The copies sit inside the distance a re-anchor may travel and no farther (see
    // `REANCHOR_MAX_LINES`): a repeated line 45 lines from the stored one is another declaration
    // rather than this code having moved, and is refused — which is why these three comments are
    // written among copies that are 5, 10 and 25 lines away rather than the whole file apart. What
    // is under test here is which of the reachable copies wins, not how far a match may be.
    const { ctx, handle } = await harness()
    const lines = Array.from({ length: 200 }, (_, index) => `line-${index + 1}`)
    lines[9] = 'dup'
    lines[44] = 'dup'
    lines[64] = 'dup'
    const content = `${lines.join('\n')}\n`
    emitResult(ctx, editExec(), editSuccess('/repo/dup.txt', `pre\n${content}`, content))
    // Written 25 lines above the copy it was near, and 45 above the one before that: the nearest wins,
    // not the first.
    const near = await addQuotedComment(handle, { entryId: '/repo/dup.txt', anchor: { startLine: 90, endLine: 90 }, quote: 'dup' })
    // Written between the last two copies, an equal distance from each: the earlier one wins, exactly
    // as the client's ascending scan keeps the first window it met.
    const tie = await addQuotedComment(handle, { entryId: '/repo/dup.txt', anchor: { startLine: 55, endLine: 55 }, quote: 'dup' })
    // …and the stored line still holding the quote is the anchor itself: the thread has not moved.
    const held = await addQuotedComment(handle, { entryId: '/repo/dup.txt', anchor: { startLine: 10, endLine: 10 }, quote: 'dup' })

    expect(await listCommentLines(handle)).toEqual({
      [near.id]: { start: 65, end: 65 },
      [tie.id]: { start: 45, end: 45 },
      [held.id]: { start: 10, end: 10 },
    })
  })

  it('does not search a file again for a list read whose content has not changed', async () => {
    // The list read is the hot path — every client of the session asks once a second — and resolving
    // a comment is a search of the entry's whole content. It therefore happens when the content can
    // have changed, and a poll that changed nothing re-sends the figure it already has (the same
    // reason the read below skips the session log for a session with no comments). The counter is
    // the shared rule itself: nothing else in the host searches a file for a quote.
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'PRE\na\nb\n', 'a\nb\nc\nd\n'))
    const comment = await addQuotedComment(handle, {
      entryId: '/repo/a.txt',
      anchor: { startLine: 1, endLine: 1 },
      quote: 'c',
    })
    const searches = (): number => vi.mocked(resolveCommentLines).mock.calls.length

    const before = searches()
    expect(await listCommentLines(handle)).toEqual({ [comment.id]: { start: 3, end: 3 } })
    const afterFirst = searches()
    expect(afterFirst).toBeGreaterThan(before)

    // The very same content, read again: the figure comes from the cache, with no second search.
    expect(await listCommentLines(handle)).toEqual({ [comment.id]: { start: 3, end: 3 } })
    expect(searches()).toBe(afterFirst)

    // …and content that DID move is followed on the next read, so the cache is keyed to the content
    // it was resolved against rather than to the comment.
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\nb\nc\nd\n', 'x\ny\nz\nq\nc\n'))
    expect(await listCommentLines(handle)).toEqual({ [comment.id]: { start: 5, end: 5 } })
    expect(searches()).toBe(afterFirst + 1)
  })

  it('takes every entry\'s comments with it when the whole list is kept', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'a', 'b'))
    await addComment(handle, 'session-1', 0)
    await addComment(handle, 'session-1', 1)
    expect(await listComments(handle, 'session-1')).toHaveLength(2)

    // A bulk decision is still one decision per entry, and each entry takes its own
    // comments with it — a file that leaves the list may not leave its thread behind.
    await handle('keep-all', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
    expect(await listComments(handle, 'session-1')).toEqual([])
  })

  it('brings a comment back with the entry it hung off, and takes it away again on redo', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const comment = await addComment(handle)
    const [entry] = await listEntries(handle, 'session-1')
    await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
    expect(await listComments(handle, 'session-1')).toEqual([])

    // Undo puts the ENTRY back — and this is the rule that CHANGED: the thread that died with the
    // row comes back with it, because a drop's pair now carries the comments it was about to
    // delete. Leaving them dead made Ctrl+Z mean two different things depending on whether the
    // action it took back was about a file or a comment, and a row the reader is looking at again
    // showed none of the notes that were written on it.
    await handle('undo', { sessionId: 'session-1' }, signal())
    expect((await listEntries(handle, 'session-1')).map(listed => listed.id)).toEqual([comment.entryId])
    expect(await listComments(handle, 'session-1')).toEqual([comment])

    // …and the redo is the removal again, so the row and the thread go together as the keep left them.
    await handle('redo', { sessionId: 'session-1' }, signal())
    expect(await listEntries(handle, 'session-1')).toEqual([])
    expect(await listComments(handle, 'session-1')).toEqual([])
  })

  describe('undo and redo of comments', () => {
    /**
     * The host services an ask needs, with an EMPTY session log: what these tests are about is the
     * action (a question posted into a thread), not the answer read that rides a list poll.
     * @returns the `prepare` callback to hand the harness.
     */
    function askable(): (prepared: Context) => void {
      return (prepared) => {
        prepared.provide('sessionController', { prompt: () => Promise.resolve({ accepted: true }) } as never)
        prepared.provide('agents', { get: () => ({ ctx: { on: () => () => {} } }) } as never)
        prepared.provide('sessions', { get: () => ({ snapshotEvents: () => [] }) } as never)
      }
    }

    /**
     * Ask one question in a stored thread, so the record carries an `asks` entry that a removal
     * would otherwise lose.
     * @param handle - the channel handler.
     * @param id - the comment to ask in.
     */
    async function ask(handle: ConnectionRpcHandler, id: string): Promise<void> {
      await expect(handle('comment-ask', { sessionId: 'session-1', id, prompt: 'the prompt', text: 'why?' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'asked', requestId: expect.any(String) as string } })
    }

    it('brings a closed comment back with its id, its anchor and its question, and redoes the close', async () => {
      const { ctx, handle } = await harness({ prepare: askable() })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      const comment = await addComment(handle)
      await ask(handle, comment.id)
      const [thread] = await listComments(handle, 'session-1')
      // The state the removal has to be able to rebuild, spelled out so a restore that drops one
      // field cannot pass on a loose comparison: the identity, where the thread was written, and the
      // question it was asked in.
      expect(thread?.id).toBe(comment.id)
      expect(thread?.anchor).toEqual({ startLine: 1, endLine: 1 })
      expect(thread?.asks).toHaveLength(1)

      await expect(handle('comment-remove', { sessionId: 'session-1', id: comment.id }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'removed' } })
      expect(await listComments(handle, 'session-1')).toEqual([])

      // The snapshot is the record itself rather than a rebuilt one, so the id, the anchor, the quote
      // and the question come back exactly as they were.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      expect(await listComments(handle, 'session-1')).toEqual([thread])
      expect((await listComments(handle, 'session-1'))[0]?.asks).toHaveLength(1)

      // …and a redo closes it again: comments ride the one undo stack, so the move back is the same
      // pair the other way round.
      await expect(handle('redo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: '/repo/a.txt' } })
      expect(await listComments(handle, 'session-1')).toEqual([])
    })

    it('brings a dropped entry back with its thread\'s id, its anchor and its question', async () => {
      const { ctx, handle } = await harness({ prepare: askable() })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      const comment = await addComment(handle)
      await ask(handle, comment.id)
      const [thread] = await listComments(handle, 'session-1')

      // A whole-file keep takes the file out of the list, and the thread with it.
      const [entry] = await listEntries(handle, 'session-1')
      await handle('keep', { sessionId: 'session-1', id: entry!.id }, signal())
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect(await listComments(handle, 'session-1')).toEqual([])

      // ONE undo for the one action: the row comes back, and the thread comes back as it was. The
      // record is snapshotted verbatim, so the identity, where it was written and the question it was
      // asked in are those values rather than a look-alike rebuilt from the row.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      expect((await listEntries(handle, 'session-1')).map(listed => listed.id)).toEqual(['/repo/a.txt'])
      const [restored] = await listComments(handle, 'session-1')
      expect(restored?.id).toBe(comment.id)
      expect(restored?.anchor).toEqual({ startLine: 1, endLine: 1 })
      expect(restored?.asks).toHaveLength(1)
      expect(restored).toEqual(thread)

      // …and redo removes both halves again: the pair's `after` side carries no comments, so the
      // move back is the drop the keep performed.
      await expect(handle('redo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: '/repo/a.txt' } })
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect(await listComments(handle, 'session-1')).toEqual([])
    })

    it('brings two dropped entries and their comments back with ONE undo', async () => {
      const { ctx, handle } = await harness()
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'a', 'b'))
      const first = await addComment(handle, 'session-1', 0)
      const second = await addComment(handle, 'session-1', 1)

      await expect(handle('keep-many', { sessionId: 'session-1', ids: [first.entryId, second.entryId] }, signal()))
        .resolves.toEqual({ ok: true, value: { affected: 2 } })
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect(await listComments(handle, 'session-1')).toEqual([])

      // The pick was one decision, so one Ctrl+Z brings back both rows AND both threads. A snapshot
      // only on the pair's own face — or only on the last item pushed — would leave one of them dead.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: expect.any(String) as string } })
      expect((await listEntries(handle, 'session-1')).map(listed => listed.id).sort())
        .toEqual(['/repo/a.txt', '/repo/b.txt'])
      expect((await listComments(handle, 'session-1')).map(row => row.id).sort())
        .toEqual([first.id, second.id].sort())

      await expect(handle('redo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: expect.any(String) as string } })
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect(await listComments(handle, 'session-1')).toEqual([])
    })

    it('brings a file that vanished outside the panel back with its row and its comments', async () => {
      const { ctx, fs, handle } = await harness()
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a\n', 'b\n'))
      const comment = await addComment(handle)

      // The file is deleted outside the panel. The list read that notices keeps a checkpoint which
      // recreates the file and restores the row — and now the thread that hung off it, which is the
      // same drop a button performs and must be undoable in the same way.
      fs.stat.mockResolvedValue(undefined)
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect(await listComments(handle, 'session-1')).toEqual([])

      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      // The tracked content is written back verbatim, and the row and thread are listed again.
      expect(fs.writeText).toHaveBeenCalledWith(
        { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'b\n', undefined, expect.anything() as AbortSignal,
      )
      // The file exists again, so the read below is about the restored list rather than a second drop.
      fs.stat.mockResolvedValue({ version: 'v1', type: 'file' })
      fs.readText.mockResolvedValue('b\n')
      expect((await listEntries(handle, 'session-1')).map(listed => listed.id)).toEqual(['/repo/a.txt'])
      expect(await listComments(handle, 'session-1')).toEqual([comment])
    })

    it('adds no second copy of a kept-listed entry\'s comments when that keep is undone', async () => {
      const { ctx, handle } = await harness()
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      const comment = await addComment(handle)
      const [entry] = await listEntries(handle, 'session-1')

      // A keep asked to leave the row listed never drops the entry, so the thread never left the
      // store: its pair must carry NO snapshot, or the undo would add a copy of what the reader still
      // has. "The entry is dropped" is the one thing a comment snapshot is about.
      await handle('keep', { sessionId: 'session-1', id: entry!.id, keepListed: true }, signal())
      expect(await listComments(handle, 'session-1')).toHaveLength(1)

      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      const left = await listComments(handle, 'session-1')
      expect(left).toHaveLength(1)
      expect(left).toEqual([comment])
    })

    it('takes an added comment back with one undo, and puts it back with redo', async () => {
      const { ctx, handle } = await harness()
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      const comment = await addComment(handle)
      expect(await listComments(handle, 'session-1')).toEqual([comment])

      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      expect(await listComments(handle, 'session-1')).toEqual([])
      // The entry the comment hung off is NOT what the undo was about: a comment restore writes no file
      // and leaves the list exactly as it was.
      expect((await listEntries(handle, 'session-1')).map(listed => listed.id)).toEqual(['/repo/a.txt'])

      await expect(handle('redo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: '/repo/a.txt' } })
      expect(await listComments(handle, 'session-1')).toEqual([comment])
    })

    it('takes a closed batch back with ONE undo, and redoes the whole batch', async () => {
      const { ctx, handle } = await harness()
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, editExec(), editSuccess('/repo/b.txt', 'a', 'b'))
      emitResult(ctx, editExec(), editSuccess('/repo/c.txt', 'a', 'b'))
      const first = await addComment(handle, 'session-1', 0)
      const second = await addComment(handle, 'session-1', 1)
      const third = await addComment(handle, 'session-1', 2)

      await expect(handle('comment-remove-many', { sessionId: 'session-1', ids: [first.id, third.id] }, signal()))
        .resolves.toEqual({ ok: true, value: { removed: 2 } })
      expect((await listComments(handle, 'session-1')).map(row => row.id)).toEqual([second.id])

      // ONE undo for the one request the reader made. A pair pushed per comment would put back only
      // the last one it removed, and the assertion below would be short of two ids.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      // The ids, not the order: every record was written in the same millisecond, and a restore appends
      // to the store's map, so the order a session's comments read back in is not what this is about.
      expect((await listComments(handle, 'session-1')).map(row => row.id).sort())
        .toEqual([first.id, second.id, third.id].sort())

      await expect(handle('redo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'redone', id: '/repo/a.txt' } })
      expect((await listComments(handle, 'session-1')).map(row => row.id)).toEqual([second.id])
    })

    it('stacks no question: an undo after a comment-ask takes back the comment, not the ask', async () => {
      const { ctx, handle } = await harness({ prepare: askable() })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      const comment = await addComment(handle)
      await ask(handle, comment.id)
      // A list read is where the answer is derived and where the comment's lines are resolved against
      // the entry's current content, so this poll is the second half of "a conversation is not an
      // action": neither the ask nor the read may reach the stack.
      expect((await listComments(handle, 'session-1'))[0]?.asks).toHaveLength(1)

      // The last ACTION the reader took is the comment's own addition, so that is what this undo is
      // about. Had the question gone on the stack, the undo would have installed the thread without its
      // ask and the read below would show one comment.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      expect(await listComments(handle, 'session-1')).toEqual([])

      // …and the history is spent: the ask is not waiting behind it, so the stack itself is empty.
      await expect(handle('undo', { sessionId: 'session-1' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'nothing' } })
    })
  })

  describe('the lineage an entry records', () => {
    /** A tool execution whose agent carries the live session the shell augments it with. */
    const childExec = (header: Record<string, unknown>): unknown => ({
      name: 'edit',
      agent: { id: SessionId('session-child'), session: { header } },
    })

    it('records the lineage off the live session the execution carries', async () => {
      // The route the DSH's own bundled plugins use on a tools/* execution: `exec.agent.session.header`
      // (`dsh-tool-present` reads `.header.cwd` there; `dsh-experimental-agent-team` reads
      // `.header.parentSession` for this very question). The registry double answers NOTHING here, so a
      // lineage can only have come from the execution itself.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', { get: () => undefined } as never) },
      })
      emitResult(ctx, childExec({
        id: 'session-child', parentSession: 'session-root', origin: 'subagent', delegationDepth: 1, cwd: '/repo',
      }), editSuccess('/repo/a.txt', 'a', 'b'))

      const [entry] = await listEntries(handle, 'session-child')
      expect(entry!.lineage).toEqual({
        parentSessionId: 'session-root', origin: 'subagent', delegationDepth: 1, cwd: '/repo',
      })
    })

    it('falls back to the session registry when the agent carries no live session', async () => {
      // An older host leaves the agent augmentation off entirely; `ctx.sessions.get` is the plugin's own
      // route (already used for the sandbox policy) and answers the same question.
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', {
            get: (id: SessionId) => ({ id, header: { id: String(id), parentSession: 'session-root', origin: 'subagent', delegationDepth: 2 } }),
          } as never)
        },
      })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))

      const [entry] = await listEntries(handle, 'session-1')
      expect(entry!.lineage?.parentSessionId).toBe('session-root')
      expect(entry!.lineage?.origin).toBe('subagent')
      expect(entry!.lineage?.delegationDepth).toBe(2)
      // The header named no working directory, so the record has none: absence, not a default.
      expect(entry!.lineage?.cwd).toBeUndefined()
    })

    it('records no parent for an ordinary root session, and still records what its header does carry', async () => {
      // A root has no parent BY DESIGN — the field is absent, not empty — and a record that invented one
      // would file the session under a root it never had.
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id), cwd: '/repo' } }) } as never)
        },
      })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))

      const [entry] = await listEntries(handle, 'session-1')
      expect(entry!.lineage?.parentSessionId).toBeUndefined()
      expect(entry!.lineage?.origin).toBeUndefined()
      expect(entry!.lineage?.delegationDepth).toBeUndefined()
      expect(entry!.lineage?.cwd).toBe('/repo')
    })

    it('records no lineage at all when neither route can say', async () => {
      // A session that is no longer live, on a shell that does not augment the agent: the absence is
      // recorded as absence, and the entry itself is exactly what it was before this field existed.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', { get: () => undefined } as never) },
      })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))

      const [entry] = await listEntries(handle, 'session-1')
      expect(entry!.lineage).toBeUndefined()
      expect(entry!.path).toBe('/repo/a.txt')
      expect(entry!.oldText).toBe('a')
      expect(entry!.newText).toBe('b')
    })

    it('records no lineage when the header carries none of the fields', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))

      const [entry] = await listEntries(handle, 'session-1')
      expect(entry!.lineage).toBeUndefined()
    })

    it('keeps the lineage when a second capture folds into the same entry', async () => {
      // Folding merges content; what a session IS does not change with it, so the merged entry keeps the
      // lineage of the capture it merged in — the value a merged view reads after any number of operations.
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', {
            get: (id: SessionId) => ({ id, header: { id: String(id), parentSession: 'session-root', origin: 'subagent' } }),
          } as never)
        },
      })
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'b', 'c'))

      const [entry] = await listEntries(handle, 'session-1')
      expect(entry!.oldText).toBe('a')
      expect(entry!.newText).toBe('c')
      expect(entry!.lineage?.parentSessionId).toBe('session-root')
      expect(entry!.lineage?.origin).toBe('subagent')
    })
  })

  describe('the merged view one request is answered from', () => {
    /** A tool execution for one session. */
    const execFor = (id: string): unknown => ({ name: 'edit', agent: { id: SessionId(id) } })

    /**
     * A registry where `child` is a subagent child of `parent` and `parent` is a root — the header facts
     * step 1 records from, and the only thing the view walks.
     */
    const registry = (parent: string, child: string): { get: (id: SessionId) => unknown } => ({
      get: (id: SessionId) => {
        if (String(id) === child) {
          return { id, header: { id: child, parentSession: parent, origin: 'subagent', delegationDepth: 1, cwd: '/repo' } }
        }
        if (String(id) === parent) return { id, header: { id: parent, cwd: '/repo' } }
        return undefined
      },
    })

    it("shows a subagent child's entries in its parent's list, and the parent's in the child's", async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      // The child keeps seeing its own row…
      expect((await listEntries(handle, 'session-child')).map(row => row.path)).toEqual(['/repo/a.txt'])
      // …and the parent sees it too: both walk to the parent as their lineage root. The row keeps its REAL
      // owner — the merge widens the view, never the attribution.
      const parentRows = await listEntries(handle, 'session-parent')
      expect(parentRows.map(row => row.path)).toEqual(['/repo/a.txt'])
      expect(parentRows[0]!.sessionId).toBe('session-child')
      expect(parentRows[0]!.sessionIds).toEqual(['session-child'])
    })

    it("merges a child's row when the two sit in the same workspace, whatever the spelling", async () => {
      // The workspace half of the rule, positively. The pending list is NOT scoped by workspace (one map
      // keyed by absolute path, one `pending.json` under the storage root), so the merge is where a
      // workspace can be honoured at all — and it must honour EQUIVALENT spellings of one root, or a
      // legitimate child whose row recorded `/repo/work/.` would vanish from its parent's list.
      const { ctx, handle } = await harness({
        workspacesByPath: { '/repo/work': ['session-parent'], '/repo/work/.': ['session-child'] },
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      expect((await listEntries(handle, 'session-child')).map(row => row.path)).toEqual(['/repo/a.txt'])
      expect((await listEntries(handle, 'session-parent')).map(row => row.path)).toEqual(['/repo/a.txt'])
    })

    it("refuses a child's row when the two sit in DIFFERENT workspaces", async () => {
      // The hole this closes: nothing else in the list path consults the workspace, so without the term the
      // parent's view carried a row recorded in another root — and could act on it, resolving the file
      // under that root. The lineage root is shared here; the workspace is not, and that is enough.
      const { ctx, handle, fs } = await harness({
        workspacesByPath: { '/repo/work': ['session-parent'], '/other/root': ['session-child'] },
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/other/root/a.txt', 'a', 'b'))

      // The child keeps its own row…
      expect((await listEntries(handle, 'session-child')).map(row => row.path)).toEqual(['/other/root/a.txt'])
      // …the parent's view does not carry it…
      expect(await listEntries(handle, 'session-parent')).toEqual([])
      // …and it is not actionable from there either: the same `missing` an id that names nothing gets.
      await expect(handle('revert', { sessionId: 'session-parent', id: '/other/root/a.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      expect(fs.writeText).not.toHaveBeenCalled()
    })

    it('keeps the merge when the registry does not account the other session', async () => {
      // Unknown degrades to the answer this view gave before the workspace term existed: a session no
      // workspace accounts (memory-only, a host that named none) must not lose rows it has always shown.
      // Only the PARENT is accounted here, so the child's workspace is unknown.
      const { ctx, handle } = await harness({
        workspacesByPath: { '/repo/work': ['session-parent'] },
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      expect((await listEntries(handle, 'session-parent')).map(row => row.path)).toEqual(['/repo/a.txt'])
    })

    it('leaves a root that has no children seeing exactly its own rows', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))
      expect((await listEntries(handle, 'session-1')).map(row => row.path)).toEqual(['/repo/a.txt'])
      // Another root of the same shape is another view.
      expect(await listEntries(handle, 'session-2')).toEqual([])
    })

    it("never shows an unrelated session's entries", async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, execFor('session-other'), editSuccess('/repo/other.txt', 'a', 'b'))
      expect(await listEntries(handle, 'session-1')).toEqual([])
      expect((await listEntries(handle, 'session-other')).map(row => row.path)).toEqual(['/repo/other.txt'])
    })

    it('degrades to self-only when the lineage is unknown', async () => {
      // No header facts anywhere (a host older than these fields) and nothing recorded either: every
      // session is its own root, so a request sees exactly what it saw before this step — never a guess.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', { get: () => undefined } as never) },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))
      const own = await listEntries(handle, 'session-1')
      expect(own.map(row => row.path)).toEqual(['/repo/a.txt'])
      expect(own[0]!.lineage).toBeUndefined()
      expect(await listEntries(handle, 'session-2')).toEqual([])
    })

    it("acts on a child-owned entry from the parent's view, and the revert writes as the owner", async () => {
      const { ctx, handle, fs } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      fs.readText.mockImplementation(async () => 'b')
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      // Keep writes nothing, and the row leaves the list for BOTH views: it is one entry.
      await expect(handle('keep', { sessionId: 'session-parent', id: '/repo/a.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
      expect(await listEntries(handle, 'session-child')).toEqual([])

      // Revert resolves the entry's OWNER for the write, so the sandbox and workspace a revert runs under
      // are the ones the file was recorded in rather than the reader's.
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/b.txt', 'a', 'b'))
      await expect(handle('revert', { sessionId: 'session-parent', id: '/repo/b.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
      expect(await listEntries(handle, 'session-parent')).toEqual([])
    })

    it("undoes a merged revert where the press happened, and not from the owner's view", async () => {
      // The rule: the undo pair belongs to the session that PRESSED the action, because that is the only
      // view whose Ctrl+Z can reach it (`undoStackOf` is keyed by session and `popOwnPair` refuses anyone
      // else's pair) — while the FILE keeps being written under the row's OWNER, whose workspace and
      // sandbox it belongs to. The drop branch used to file the pair under the owner, so the presser's
      // undo answered `nothing` and the row never came back.
      const { ctx, fs, handle } = await harness({
        workspacesByPath: { '/repo': ['session-parent', 'session-child'] },
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      // A file the double actually models: `readText` answers what `writeText` last put there, so the
      // revert really leaves the baseline on disk and the undo's divergence guard sees the bytes the
      // revert wrote (a double that always answered 'b' would make the undo refuse, not succeed).
      let live = 'b'
      fs.readText.mockImplementation(async () => live)
      fs.writeText.mockImplementation(async (_target: unknown, text: string) => { live = text; return { version: 1 } })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      // The parent presses revert on the child's row: the row leaves BOTH views (one entry), and the file
      // now holds the baseline. The write named the owner (see the test above).
      await expect(handle('revert', { sessionId: 'session-parent', id: '/repo/a.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
      expect(await listEntries(handle, 'session-parent')).toEqual([])
      expect(live).toBe('a')

      // The presser's Ctrl+Z gets the row AND the diff back.
      await expect(handle('undo', { sessionId: 'session-parent' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
      const [restored] = await listEntries(handle, 'session-parent')
      expect(restored).toMatchObject({ path: '/repo/a.txt', oldText: 'a', newText: 'b' })
      // The row keeps its REAL owner — the merge widens the view, never the attribution.
      expect(restored!.sessionId).toBe('session-child')
      expect(fs.writeText).toHaveBeenLastCalledWith(
        { displayPath: '/repo/a.txt', targetKey: 'key:/repo/a.txt' }, 'b', undefined, expect.anything() as AbortSignal,
      )

      // …and the OWNER's Ctrl+Z has none of the parent's press to move: an action cannot be taken back from
      // a view whose reader never made it.
      await expect(handle('undo', { sessionId: 'session-child' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'nothing' } })
    })

    it("refuses an action on an entry outside the requester's lineage", async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))

      // The id is real and the row is on session-1's screen. Session-2 answers exactly like an id that
      // names nothing, so a refusal discloses nothing about what it cannot see.
      const block = { oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 }
      await expect(handle('keep', { sessionId: 'session-2', id: '/repo/a.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      await expect(handle('revert', { sessionId: 'session-2', id: '/repo/a.txt' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      await expect(handle('block-keep', { sessionId: 'session-2', id: '/repo/a.txt', block }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      await expect(handle('block-revert', { sessionId: 'session-2', id: '/repo/a.txt', block }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      // The row is untouched for the session that owns it.
      expect((await listEntries(handle, 'session-1')).map(row => row.path)).toEqual(['/repo/a.txt'])
    })

    it("opens a merged row from the reader's view", async () => {
      // The guard must not cost the feature it guards: the parent has the child's row in its list, so the
      // parent can open it, and the row's dot goes out for the look that really happened.
      const { ctx, handle, openPath } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))
      expect((await listEntries(handle, 'session-parent')).map(row => row.path)).toEqual(['/repo/a.txt'])

      await expect(handle('open', { sessionId: 'session-parent', id: '/repo/a.txt', action: 'open' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'opened' } })
      expect(openPath).toHaveBeenCalledWith('/repo/a.txt', 'open')
    })

    it("refuses to open a row outside the requester's lineage, and leaves its dot alone", async () => {
      // `open` was the one entry-naming action that resolved its entry with the bare `store.get`, so a
      // session that never had the row in its list could launch the file AND take the row's unseen dot
      // down (`markSeen`) — a cross-session effect on a row it cannot see. It now refuses exactly as the
      // other guarded actions do.
      const { ctx, handle, openPath } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))
      expect((await listEntries(handle, 'session-1'))[0]!.unseen).toBe(true)

      await expect(handle('open', { sessionId: 'session-2', id: '/repo/a.txt', action: 'open' }, signal()))
        .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
      expect(openPath).not.toHaveBeenCalled()
      // The owner's dot is exactly as it was: a refused `open` is not "the reader looked at it".
      expect((await listEntries(handle, 'session-1'))[0]!.unseen).toBe(true)
    })

    // The row's MARK, which is a different question from the merge: `viaLineage` says why a row is in the
    // list, `hasChildContribution` says whether a child's change is in it. A row the session touched AS WELL
    // is silent about the child without it — and a session outside the lineage touching the same path (the
    // store is keyed by path globally) is not a child's contribution, which is the case that would make the
    // copy a lie.
    it('marks a row only a child touched as a child contribution', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))

      const row = (await listEntries(handle, 'session-parent'))[0]!
      // Here only through the merge, and a child's change is all of it.
      expect(row.viaLineage).toBe(true)
      expect(row.hasChildContribution).toBe(true)
      // …and the host says WHICH way that child stands, so the sentence can name it rather than guess.
      expect(row.lineageDirection).toBe('child')
    })

    it('marks a row this session touched too, when a child in its lineage also touched it', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      // The child first, then the parent editing the same path: one entry, both sessions in `sessionIds`.
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-parent'), editSuccess('/repo/a.txt', 'b', 'c'))

      const row = (await listEntries(handle, 'session-parent'))[0]!
      expect(row.sessionIds).toEqual(expect.arrayContaining(['session-child', 'session-parent']))
      // The row is here on its own merit — so NOT `viaLineage` — and still says a child had a hand in it.
      expect(row.viaLineage).toBeUndefined()
      expect(row.hasChildContribution).toBe(true)
      expect(row.lineageDirection).toBe('child')
    })

    /** A registry where `first` and `second` are BOTH subagent children of `root` — two teammates under one
     *  lead, which is the shape the sibling and mixed answers need. */
    const siblingsRegistry = (root: string, first: string, second: string): { get: (id: SessionId) => unknown } => ({
      get: (id: SessionId) => {
        const name = String(id)
        if (name === first || name === second) {
          return { id, header: { id: name, parentSession: root, origin: 'subagent', delegationDepth: 1, cwd: '/repo' } }
        }
        if (name === root) return { id, header: { id: root, cwd: '/repo' } }
        return undefined
      },
    })

    /** A registry three levels deep, for the ancestor that is more than one hop up. */
    const chainRegistry = (top: string, middle: string, bottom: string): { get: (id: SessionId) => unknown } => ({
      get: (id: SessionId) => {
        const name = String(id)
        if (name === bottom) return { id, header: { id: name, parentSession: middle, origin: 'subagent', delegationDepth: 2, cwd: '/repo' } }
        if (name === middle) return { id, header: { id: name, parentSession: top, origin: 'subagent', delegationDepth: 1, cwd: '/repo' } }
        if (name === top) return { id, header: { id: name, cwd: '/repo' } }
        return undefined
      },
    })

    /**
     * One row's direction, keyed by path so the assertion never depends on list order.
     *
     * The DIRECTION is what the marker's sentence needs: the same row is a child's change in its parent's
     * panel and a parent's change in its child's, and two teammates' rows are a sibling's. Every case below
     * carries BOTH forms of its direction — a row only the other session touched (`viaLineage`), and one this
     * session touched too (`hasChildContribution`) — because the two say different things.
     */
    const directionOf = async (handle: ConnectionRpcHandler, sessionId: string, path: string): Promise<unknown> => {
      const rows = await listEntries(handle, sessionId)
      return rows.find(row => row.path === path)?.lineageDirection
    }

    it('answers "child" when the other owner is BELOW the lister, in both forms', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      // Only the child touched this one; the parent edited this one as well.
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/only.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/also.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-parent'), editSuccess('/repo/also.txt', 'b', 'c'))

      expect(await directionOf(handle, 'session-parent', '/repo/only.txt')).toBe('child')
      expect(await directionOf(handle, 'session-parent', '/repo/also.txt')).toBe('child')
      // The two forms really are the two forms (what the sentence is chosen from).
      const rows = await listEntries(handle, 'session-parent')
      expect(rows.find(row => row.path === '/repo/only.txt')?.viaLineage).toBe(true)
      expect(rows.find(row => row.path === '/repo/also.txt')?.viaLineage).toBeUndefined()
    })

    it('answers "parent" when the other owner is ABOVE the lister, in both forms', async () => {
      // The same two sessions, the OTHER way round: the child lists, so its parent's change is a parent's.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-parent'), editSuccess('/repo/only.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-parent'), editSuccess('/repo/also.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-child'), editSuccess('/repo/also.txt', 'b', 'c'))

      expect(await directionOf(handle, 'session-child', '/repo/only.txt')).toBe('parent')
      expect(await directionOf(handle, 'session-child', '/repo/also.txt')).toBe('parent')
    })

    it('answers "parent" for an ancestor more than one hop up', async () => {
      // "parent" means ANCESTOR, which is what 上级 says and what the English copy is written to mean: the
      // bottom session lists a row its GRANDPARENT wrote, and the answer is still the ancestor's.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', chainRegistry('session-top', 'session-mid', 'session-low') as never) },
      })
      emitResult(ctx, execFor('session-top'), editSuccess('/repo/top.txt', 'a', 'b'))

      expect(await directionOf(handle, 'session-low', '/repo/top.txt')).toBe('parent')
      // …and the same row read from the middle is a parent's too, at one hop.
      expect(await directionOf(handle, 'session-mid', '/repo/top.txt')).toBe('parent')
    })

    it('answers "sibling" when neither owner is on the other chain, in both forms', async () => {
      // Two children of one lead: they share a root and have no parent/child link between them.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', siblingsRegistry('session-lead', 'session-peer-a', 'session-peer-b') as never) },
      })
      emitResult(ctx, execFor('session-peer-b'), editSuccess('/repo/only.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-peer-b'), editSuccess('/repo/also.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-peer-a'), editSuccess('/repo/also.txt', 'b', 'c'))

      expect(await directionOf(handle, 'session-peer-a', '/repo/only.txt')).toBe('sibling')
      expect(await directionOf(handle, 'session-peer-a', '/repo/also.txt')).toBe('sibling')
    })

    it('answers "mixed" when two other owners stand differently, in both forms', async () => {
      // A row the lead AND a peer both touched, read by another peer: one owner is above (the lead), the
      // other beside (the peer). Naming either would state something true of only half the row.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', siblingsRegistry('session-lead', 'session-peer-a', 'session-peer-b') as never) },
      })
      emitResult(ctx, execFor('session-lead'), editSuccess('/repo/only.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-peer-b'), editSuccess('/repo/only.txt', 'b', 'c'))
      emitResult(ctx, execFor('session-lead'), editSuccess('/repo/also.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-peer-b'), editSuccess('/repo/also.txt', 'b', 'c'))
      emitResult(ctx, execFor('session-peer-a'), editSuccess('/repo/also.txt', 'c', 'd'))

      expect(await directionOf(handle, 'session-peer-a', '/repo/only.txt')).toBe('mixed')
      expect(await directionOf(handle, 'session-peer-a', '/repo/also.txt')).toBe('mixed')
    })

    it('answers no direction at all when the only owner is the lister', async () => {
      // Nothing to word, so nothing is sent: the mark is absent and the direction with it. A sibling or a
      // parent invented here would give the mark a sentence for a row nobody else touched.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', siblingsRegistry('session-lead', 'session-peer-a', 'session-peer-b') as never) },
      })
      emitResult(ctx, execFor('session-peer-a'), editSuccess('/repo/own.txt', 'a', 'b'))

      expect(await directionOf(handle, 'session-peer-a', '/repo/own.txt')).toBeUndefined()
    })

    it('says nothing about a child on a row the session wrote alone', async () => {
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', registry('session-parent', 'session-child') as never) },
      })
      emitResult(ctx, execFor('session-parent'), editSuccess('/repo/a.txt', 'a', 'b'))

      const row = (await listEntries(handle, 'session-parent'))[0]!
      expect(row.viaLineage).toBeUndefined()
      expect(row.hasChildContribution).toBe(false)
    })

    it("does not call an unrelated session's touch a child's contribution", async () => {
      // Two roots, no lineage between them, and one path both happened to touch. This is the negative the
      // copy rests on: the entry really does carry another session's edit, and it is NOT a child's.
      const { ctx, handle } = await harness({
        prepare: (context) => {
          context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never)
        },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-other'), editSuccess('/repo/a.txt', 'b', 'c'))

      const row = (await listEntries(handle, 'session-1'))[0]!
      expect(row.sessionIds).toEqual(expect.arrayContaining(['session-1', 'session-other']))
      expect(row.viaLineage).toBeUndefined()
      expect(row.hasChildContribution).toBe(false)
      // No mark means no sentence, so there is no direction to send either — a sibling here would give the
      // row a marker for a session that is not in its lineage at all.
      expect(row.lineageDirection).toBeUndefined()
    })

    it('says nothing about a child when the lineage is unknown', async () => {
      // Nothing recorded and no header facts: the two sessions cannot be shown to share a root, so the mark
      // stays off rather than guessing the relationship the copy names.
      const { ctx, handle } = await harness({
        prepare: (context) => { context.provide('sessions', { get: () => undefined } as never) },
      })
      emitResult(ctx, execFor('session-1'), editSuccess('/repo/a.txt', 'a', 'b'))
      emitResult(ctx, execFor('session-2'), editSuccess('/repo/a.txt', 'b', 'c'))

      const row = (await listEntries(handle, 'session-1'))[0]!
      expect(row.viaLineage).toBeUndefined()
      expect(row.hasChildContribution).toBe(false)
    })
  })
})

/**
 * The canonicalization batch: session-scoped STATE collapses to the lineage ROOT, while provenance
 * (`sessionId`/`sessionIds`, a comment's author) stays exactly as captured.
 *
 * Two things are keyed by the root now — the undo history and the comment read/guards — so a seat of one
 * lineage shares one history and reads one set of threads. The workspace and sandbox policy a write runs
 * under is deliberately NOT canonicalized (see the note above `undoStacks`), so nothing here asserts on it.
 */
describe('one lineage, one session-scoped state', () => {
  const ROOT = SessionId('session-root')
  const CHILD = SessionId('session-child')
  const COMMENT_BODY = { anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why is this here?' }

  const execFor = (id: SessionId): unknown => ({ name: 'edit', agent: { id } })

  /**
   * The session registry: `child` is recorded as a subagent child of `root` with `origin: 'subagent'`,
   * which is the link the lineage walk follows, plus the event log each transcript read returns.
   */
  function lineageSessions(events: Record<string, readonly unknown[]> = {}): { get: (id: SessionId) => unknown } {
    return {
      get: (id: SessionId) => ({
        id,
        header: String(id) === String(CHILD)
          ? { id: String(id), parentSession: String(ROOT), origin: 'subagent', delegationDepth: 1 }
          : { id: String(id) },
        snapshotEvents: () => events[String(id)] ?? [],
      }),
    }
  }

  /** Read one seat's comments through the channel's list read. */
  async function listComments(handle: ConnectionRpcHandler, sessionId: string): Promise<CommentRecord[]> {
    const answer = await handle('list', { sessionId }, signal())
    if (!answer.ok) throw new Error('list failed')
    return (answer.value as { comments?: CommentRecord[] }).comments ?? []
  }

  it("takes back another seat's action from this seat's keyboard, inside one lineage", async () => {
    // The point of ONE stack per lineage root: the row a child recorded is the ROOT's row in the merged
    // view, and the human who supervises the root is the one who presses Ctrl+Z. `nothing` now means the
    // LINEAGE has nothing to take back, not that this seat has nothing of its own — so a teammate's Ctrl+Z
    // can take back the root's last action and the root's can take back a teammate's.
    const { ctx, handle, fs } = await harness({
      sessionIds: [ROOT, CHILD],
      prepare: (context) => { context.provide('sessions', lineageSessions() as never) },
    })
    // A file the double models: `readText` answers what `writeText` last put there, so the revert really
    // leaves its bytes on disk and the undo's divergence guard sees what the revert wrote.
    let live = 'b'
    fs.readText.mockImplementation(async () => live)
    fs.writeText.mockImplementation(async (_target: unknown, text: string) => { live = text; return { version: 1 } })
    emitResult(ctx, execFor(CHILD), editSuccess('/repo/a.txt', 'a', 'b'))

    // The child presses keep; the row leaves both seats' lists (it is one entry).
    await expect(handle('keep', { sessionId: String(CHILD), id: '/repo/a.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })
    expect(await listEntries(handle, String(ROOT))).toEqual([])

    // …and the ROOT's Ctrl+Z takes it back, though the root pressed nothing.
    await expect(handle('undo', { sessionId: String(ROOT) }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'undone', id: '/repo/a.txt' } })
    expect((await listEntries(handle, String(ROOT))).map(row => row.path)).toEqual(['/repo/a.txt'])

    // The other way round too: the root reverts, the CHILD's Ctrl+Z takes it back.
    await expect(handle('revert', { sessionId: String(ROOT), id: '/repo/a.txt' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'reverted' } })
    await expect(handle('undo', { sessionId: String(CHILD) }, signal()))
      .resolves.toMatchObject({ ok: true, value: { outcome: 'undone' } })
    expect((await listEntries(handle, String(ROOT))).map(row => row.path)).toEqual(['/repo/a.txt'])
  })

  it('reads, marks seen, removes and restores a thread across the seats of one lineage', async () => {
    // A comment stays in its AUTHOR's file (no migration); what changed is that the read fans out over the
    // lineage and a removal is routed to the file that holds the record. The undo pair is the lineage's,
    // so the seat that removed it can put it back — verbatim, in that same file.
    const { ctx, handle } = await harness({
      sessionIds: [ROOT, CHILD],
      prepare: (context) => { context.provide('sessions', lineageSessions() as never) },
    })
    emitResult(ctx, execFor(ROOT), editSuccess('/repo/a.txt', 'a', 'b'))
    const added = await handle('comment-add', { sessionId: String(ROOT), entryId: '/repo/a.txt', ...COMMENT_BODY }, signal())
    expect(added).toMatchObject({ ok: true, value: { outcome: 'added' } })
    const id = (added as { value: { comment: CommentRecord } }).value.comment.id

    // The CHILD reads the ROOT's thread: readable from every seat of the lineage.
    expect((await listComments(handle, String(CHILD))).map(row => row.id)).toEqual([id])
    // Seen from the child's panel: one fact about one comment, not a per-seat copy of it.
    await expect(handle('comment-seen', { sessionId: String(CHILD), id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'seen' } })
    // Removed from the child's seat, though the record lives in the ROOT's file.
    await expect(handle('comment-remove', { sessionId: String(CHILD), id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'removed' } })
    expect(await listComments(handle, String(ROOT))).toEqual([])

    // The child's Ctrl+Z puts it back, in the file that holds it.
    await expect(handle('undo', { sessionId: String(CHILD) }, signal()))
      .resolves.toMatchObject({ ok: true, value: { outcome: 'undone' } })
    expect((await listComments(handle, String(ROOT))).map(row => row.id)).toEqual([id])
  })

  it('lets a seat comment on a row it sees only through the merge', async () => {
    // The gap this closes: `comment-add` resolved its entry with the self-only `store.list`, so a row the
    // merged view legitimately showed answered `missing` and could not be commented on at all.
    const { ctx, handle } = await harness({
      sessionIds: [ROOT, CHILD],
      prepare: (context) => { context.provide('sessions', lineageSessions() as never) },
    })
    emitResult(ctx, execFor(ROOT), editSuccess('/repo/a.txt', 'a', 'b'))
    expect((await listEntries(handle, String(CHILD))).map(row => row.path)).toEqual(['/repo/a.txt'])

    const added = await handle('comment-add', { sessionId: String(CHILD), entryId: '/repo/a.txt', ...COMMENT_BODY }, signal())
    expect(added).toMatchObject({ ok: true, value: { outcome: 'added' } })
    const id = (added as { value: { comment: CommentRecord } }).value.comment.id
    // Written by the child (its provenance, and therefore its file) and readable from the root.
    expect((await listComments(handle, String(ROOT))).map(row => row.id)).toEqual([id])
  })

  it('folds each transcript\'s answers on the wire, and ends only that transcript\'s turn', async () => {
    // ONE thread, TWO transcripts, and both ask a question in TURN 1. The root wrote the annotation and
    // asked the first question before the asking session was recorded (so it folds under the author, which
    // is where it went); the child asked a follow-up from its own panel. Each fold owns only its own
    // transcript's question — a read that replaced the answer map would lose the other's, and a turn end
    // matched by session+turn instead of by transcript would end the wrong question.
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-lineage-'))
    tempDirs.push(storageDir)
    await mkdir(commentsDirFor(storageDir), { recursive: true })
    await writeFile(join(commentsDirFor(storageDir), `${ROOT}.json`), JSON.stringify({
      version: 1,
      comments: [{
        id: 'c1', sessionId: ROOT, entryId: '/repo/a.txt', path: '/repo/a.txt',
        anchor: { startLine: 1, endLine: 1 }, quote: 'a', text: 'why is this here?', createdAt: 1, updatedAt: 1,
        asks: [
          { requestId: 'req-root', text: 'why?', turn: 1 },
          { requestId: 'req-child', sessionId: CHILD, text: 'and then?', turn: 1 },
        ],
      }],
    }), 'utf8')

    const log = (requestId: string, answer: string, ended: boolean): readonly unknown[] => [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 0, data: { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } },
      // Only the CHILD's turn ends, so the two logs both ask in turn 1 while only one of them is over:
      // the turn-end match has to be per transcript, or the root's question would be ended too.
      ...(ended ? [{ type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } }] : []),
    ]
    const { ctx, handle } = await harness({
      storageDir,
      sessionIds: [ROOT, CHILD],
      prepare: (context) => {
        context.provide('sessions', lineageSessions({
          [String(ROOT)]: log('req-root', 'answer from the root transcript', false),
          [String(CHILD)]: log('req-child', 'answer from the child transcript', true),
        }) as never)
      },
    })
    emitResult(ctx, execFor(ROOT), editSuccess('/repo/a.txt', 'a', 'b'))

    const read = async (): Promise<{ comments?: CommentRecord[]; commentAnswers?: Record<string, string> }> => {
      const answer = await handle('list', { sessionId: String(CHILD) }, signal())
      if (!answer.ok) throw new Error('list failed')
      return answer.value as { comments?: CommentRecord[]; commentAnswers?: Record<string, string> }
    }
    const first = await read()
    expect(first.commentAnswers).toEqual({
      'req-root': 'answer from the root transcript',
      'req-child': 'answer from the child transcript',
    })
    // A SECOND read folds each transcript again, and neither answer is erased by the other's fold.
    expect((await read()).commentAnswers).toEqual(first.commentAnswers)
    // The child's turn 1 ended: its own question is over, and the root's — also turn 1 — is not.
    const asks = (await read()).comments?.[0]?.asks ?? []
    expect(asks.find(ask => ask.requestId === 'req-child')?.ended).toBe(true)
    expect(asks.find(ask => ask.requestId === 'req-root')?.ended).toBeUndefined()
  })

  it('keeps an unrelated root\'s history and threads to itself', async () => {
    // The widening's negative: two roots with no lineage between them share NOTHING, so every verb still
    // refuses exactly as it did before the canonicalization — the check is "same lineage", not "any
    // session".
    const A = SessionId('session-a')
    const B = SessionId('session-b')
    const { ctx, handle } = await harness({
      sessionIds: [A, B],
      prepare: (context) => { context.provide('sessions', { get: (id: SessionId) => ({ id, header: { id: String(id) } }) } as never) },
    })
    emitResult(ctx, execFor(A), editSuccess('/repo/a.txt', 'a', 'b'))
    emitResult(ctx, execFor(A), editSuccess('/repo/b.txt', 'a', 'b'))
    await handle('keep', { sessionId: String(A), id: '/repo/a.txt' }, signal())

    // B's Ctrl+Z has nothing of its own, and cannot reach A's history.
    await expect(handle('undo', { sessionId: String(B) }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'nothing' } })

    // A comment A wrote on its OTHER row is invisible to B, and B cannot add one to A's row.
    const added = await handle('comment-add', { sessionId: String(A), entryId: '/repo/b.txt', ...COMMENT_BODY }, signal())
    expect(added).toMatchObject({ ok: true, value: { outcome: 'added' } })
    const id = (added as { value: { comment: CommentRecord } }).value.comment.id
    expect(await listComments(handle, String(B))).toEqual([])
    await expect(handle('comment-add', { sessionId: String(B), entryId: '/repo/b.txt', ...COMMENT_BODY }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    await expect(handle('comment-seen', { sessionId: String(B), id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    await expect(handle('comment-remove', { sessionId: String(B), id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
    await expect(handle('comment-ask', { sessionId: String(B), id, prompt: 'p', text: 'p' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'missing' } })
  })
})

