// The preview-image host endpoint: reads a workspace image and inlines it as a
// base64 data URI, confined to the session's workspace.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ConnectionRpcHandler, HostConnectionHandle, ConnectionRpcHandlerOptions } from '@deepseek-ai/dsh-client-connection'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { DiffApprovalPreviewImageValue } from '../src/types.ts'
import { apply, DIFF_APPROVAL_CHANNEL } from '../src/index.ts'
import { removeTempDir } from './cleanup.ts'

interface FsDouble {
  resolve: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
  writeText: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  processPath: ReturnType<typeof vi.fn>
}

interface Harness {
  handle: ConnectionRpcHandler
  wsRoot: string
  dispose(): Promise<void>
}

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(removeTempDir))
  vi.restoreAllMocks()
})

function signal(): AbortSignal {
  return new AbortController().signal
}

/**
 * Build a harness whose `ctx.fs` maps the display paths of a single `/repo`
 * workspace onto a real temp directory, so the endpoint's containment check and
 * file read run against actual bytes.
 */
async function harness(): Promise<Harness> {
  const wsRoot = await mkdtemp(join(tmpdir(), 'dsh-img-'))
  tempDirs.push(wsRoot)
  const ctx = new Context()
  contexts.push(ctx)

  // '/repo/details/photo.png' -> '<wsRoot>/details/photo.png'. A path with `..`
  // escapes wsRoot (join normalises upward), so the endpoint's containment
  // check can be exercised.
  const toOs = (display: string): string => {
    if (display === '/repo' || display === '/repo/') return wsRoot
    const rel = display.startsWith('/repo/') ? display.slice('/repo/'.length) : display
    return join(wsRoot, rel)
  }
  const fs: FsDouble = {
    resolve: vi.fn(async (path: string) => ({ displayPath: path, targetKey: path })),
    readText: vi.fn(async () => undefined),
    writeText: vi.fn(async () => ({ version: 1 })),
    stat: vi.fn(async () => ({ version: 'v1', type: 'file' })),
    processPath: vi.fn((target: { targetKey: string }) => toOs(target.targetKey)),
  }
  ctx.provide('fs', fs as unknown as FileSystem)
  const handle = vi.fn<(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions) => () => void>(() => () => {})
  ctx.provide('connection', { rpc: { handle } } as unknown as HostConnectionHandle)
  // The plugin injects `webServer` so its channel owner can resolve it.
  ctx.provide('webServer', { register: vi.fn(() => () => {}) } as never)
  const workspace: Workspace = {
    id: WorkspaceId('workspace-1'),
    sessionIds: [SessionId('session-1')],
    path: '/repo',
  } as unknown as Workspace
  ctx.provide('workspaceRegistry', { list: () => [workspace] } as unknown as WorkspaceRegistry)
  await ctx.plugin(apply, { storageDir: join(wsRoot, '.diff-approval') })
  const calls = handle.mock.calls
  const first = calls[0]
  if (first === undefined) throw new Error('diff-approval did not register its channel')
  return {
    handle: first[1],
    wsRoot,
    dispose: () => ctx.fiber.dispose(),
  }
}

async function readPreview(handle: ConnectionRpcHandler, path: string): Promise<DiffApprovalPreviewImageValue> {
  const answer = await handle('preview-image', { sessionId: 'session-1', path }, signal())
  if (!answer.ok) throw new Error(`preview-image failed: ${answer.error.message}`)
  return answer.value as DiffApprovalPreviewImageValue
}

describe('preview-image endpoint', () => {
  it('inlines a workspace image as a base64 data URI with its MIME type', async () => {
    const { handle, wsRoot } = await harness()
    await mkdir(join(wsRoot, 'details'), { recursive: true })
    const bytes = Buffer.from('PNGDATA1234')
    await writeFile(join(wsRoot, 'details', 'photo.png'), bytes)

    const value = await readPreview(handle, '/repo/details/photo.png')
    expect(value.dataUri).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
  })

  it('refuses a reference that escapes the workspace', async () => {
    const { handle } = await harness()
    // `..` climbs out of the workspace root; the containment check refuses it
    // regardless of whether the file exists.
    const value = await readPreview(handle, '/repo/../../outside.png')
    expect(value.dataUri).toBeUndefined()
  })

  it('answers with no data URI for an absent image', async () => {
    const { handle } = await harness()
    const value = await readPreview(handle, '/repo/details/missing.png')
    expect(value.dataUri).toBeUndefined()
  })

  it('rejects a payload without a path', async () => {
    const { handle } = await harness()
    const answer = await handle('preview-image', { sessionId: 'session-1' }, signal())
    expect(answer.ok).toBe(false)
  })
})
