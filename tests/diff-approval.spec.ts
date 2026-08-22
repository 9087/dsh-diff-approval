// The host half: capture, per-operation entries, channel serving, keep,
// kind-aware revert, live file state, and persistence.

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ConnectionRpcHandler, ConnectionRpcHandlerOptions, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { PendingFileDiff } from '../src/types.ts'
import { apply, DIFF_APPROVAL_CHANNEL } from '../src/index.ts'
import { removeTempDir } from './cleanup.ts'

interface FsDouble {
  resolve: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
  writeText: ReturnType<typeof vi.fn>
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

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(removeTempDir))
})

async function harness(options: {
  sessionIds?: readonly SessionId[]
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
    processPath: vi.fn((target: { targetKey: string }) => target.targetKey),
  }
  ctx.provide('fs', fs as unknown as FileSystem)
  const handle = vi.fn<(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions) => () => void>(() => () => {})
  ctx.provide('connection', { rpc: { handle } } as unknown as HostConnectionHandle)
  const workspaces: Workspace[] = (options.sessionIds ?? []).length === 0 ? [] : [{
    id: WorkspaceId('workspace-1'),
    sessionIds: [...options.sessionIds!],
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

describe('capturing operations', () => {
  it('folds consecutive edits into one entry per path', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v2\n', 'v3\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'edit', oldText: 'v1\n', newText: 'v3\n' })
  })

  it('records a write create as a create entry and folds later edits into it', async () => {
    const { ctx, handle } = await harness()
    emitResult(ctx, writeExec(), writeSuccess('/repo/new.txt', 'create', null, 'content'))
    emitResult(ctx, editExec(), editSuccess('/repo/new.txt', 'content', 'content2'))
    emitResult(ctx, writeExec(), writeSuccess('/repo/old.txt', 'update', 'before', 'after'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ path: '/repo/new.txt', kind: 'create', oldText: '', newText: 'content2' })
    expect(entries[1]).toMatchObject({ path: '/repo/old.txt', kind: 'edit', oldText: 'before', newText: 'after' })
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
      kind: 'edit', oldText: 'v1\n', newText: 'v2\nexternal\n', missing: false, diverged: false,
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
      path: '/repo/a.txt', kind: 'edit', oldText: 'before\n', newText: 'after\n', missing: false, diverged: false,
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
    expect(files[0]).toMatchObject({ path: '/repo/new.txt', kind: 'create', oldText: '', newText: 'created\n' })
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
    expect(files[0]).toMatchObject({ path: '/repo/a.txt', kind: 'edit', oldText: 'before\n', newText: 'after\n' })
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
    expect(files[0]).toMatchObject({ path: '/repo/b.txt', kind: 'edit', oldText: 'x', newText: 'y' })
  })
})

describe('open', () => {
  it('launches the file through the injected launcher with the execution-world path', async () => {
    const { ctx, handle, openPath } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('open', { sessionId: 'session-1', id: entry!.id, action: 'open' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'opened' } })
    expect(openPath).toHaveBeenCalledWith('key:/repo/a.txt', 'open')
  })

  it('reveals the file location for the reveal action', async () => {
    const { ctx, handle, openPath } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'before', 'after'))
    const [entry] = await listEntries(handle, 'session-1')

    await expect(handle('open', { sessionId: 'session-1', id: entry!.id, action: 'reveal' }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'opened' } })
    expect(openPath).toHaveBeenCalledWith('key:/repo/a.txt', 'reveal')
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
  it('adopts externally modified content as the new baseline so the diff tracks it', async () => {
    const { ctx, handle, fs } = await harness()
    fs.readText.mockResolvedValue('external edit\n')
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({ missing: false, diverged: false, oldText: 'v1\n', newText: 'external edit\n' }) as object,
    ])
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

  it('marks entries missing when the path no longer resolves', async () => {
    const { ctx, handle, fs } = await harness()
    fs.resolve.mockRejectedValue(new Error('not found'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({ missing: true, diverged: false }) as object,
    ])
  })

  it('marks entries diverged when the file resolves but cannot be read', async () => {
    const { ctx, handle, fs } = await harness()
    fs.readText.mockRejectedValue(new Error('permission denied'))
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))

    const entries = await listEntries(handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({ missing: false, diverged: true }) as object,
    ])
  })
})

describe('persistence', () => {
  it('persists an operation and hydrates it into a fresh harness', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('workspace-1.json')
    })

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    second.fs.readText.mockResolvedValue('v2\n')
    const entries = await listEntries(second.handle, 'session-1')
    expect(entries).toEqual([
      expect.objectContaining({
        sessionId: 'session-1', path: '/repo/a.txt', kind: 'edit',
        oldText: 'v1\n', newText: 'v2\n', missing: false, diverged: false,
      }) as object,
    ])
  })

  it("surfaces an earlier session's persisted entries to a fresh session after restart", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    // First run: an earlier session in the workspace records an edit, which
    // is persisted under that session's id in the workspace file.
    const first = await harness({ sessionIds: [SessionId('session-old')], storageDir })
    emitResult(first.ctx, { name: 'edit', agent: { id: SessionId('session-old') } },
      editSuccess('/repo/a.txt', 'v1\n', 'v2\n'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('workspace-1.json')
    })

    // Second run: a fresh session id in the same workspace must still list
    // the earlier session's persisted change (workspace-level hydration).
    const second = await harness({ sessionIds: [SessionId('session-new')], storageDir })
    second.fs.readText.mockResolvedValue('v2\n')
    const entries = await listEntries(second.handle, 'session-new')
    expect(entries).toEqual([
      expect.objectContaining({
        sessionId: 'session-old', path: '/repo/a.txt', kind: 'edit',
        oldText: 'v1\n', newText: 'v2\n', missing: false, diverged: false,
      }) as object,
    ])
  })

  it('removes the persisted entry when it is kept', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    const [entry] = await listEntries(first.handle, 'session-1')
    await expect(first.handle('keep', { sessionId: 'session-1', id: entry!.id }, signal()))
      .resolves.toEqual({ ok: true, value: { outcome: 'kept' } })

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    expect(await listEntries(second.handle, 'session-1')).toEqual([])
  })

  it('leaves a session without a workspace in memory only', async () => {
    const { ctx, handle, storageDir } = await harness()
    emitResult(ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    expect(await listEntries(handle, 'session-1')).toHaveLength(1)
    await expect(readdir(storageDir)).resolves.toEqual([])
  })

  it('serves the live in-memory view when the persisted file is corrupt', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-diff-approval-'))
    tempDirs.push(storageDir)
    const first = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    emitResult(first.ctx, editExec(), editSuccess('/repo/a.txt', 'a', 'b'))
    await vi.waitFor(async () => {
      await expect(readdir(first.storageDir)).resolves.toContain('workspace-1.json')
    })
    await writeFile(join(storageDir, 'workspace-1.json'), '{not json', 'utf8')

    const second = await harness({ sessionIds: [SessionId('session-1')], storageDir })
    expect(await listEntries(second.handle, 'session-1')).toEqual([])
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
    expect(restored).toMatchObject({ id: entry!.id, path: '/repo/a.txt', kind: 'edit', oldText: 'a', newText: 'b' })

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
})
