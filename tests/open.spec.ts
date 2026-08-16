// The platform launcher: command selection per platform and argument shape.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => {
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} })
    queueMicrotask(() => { child.emit('spawn') })
    return child
  })
  return { spawn }
})

vi.mock('node:child_process', () => ({ spawn, default: { spawn } }))

import { defaultOpenPath } from '../src/open.ts'

afterEach(() => { spawn.mockClear() })

/** Run `body` with `process.platform` faked to one OS, restoring it after. */
async function withPlatform(platform: string, body: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    await body()
  } finally {
    if (descriptor === undefined) delete (process as { platform?: string }).platform
    else Object.defineProperty(process, 'platform', descriptor)
  }
}

describe('defaultOpenPath', () => {
  it('opens a file with the default handler on win32', async () => {
    await withPlatform('win32', async () => {
      await defaultOpenPath('C:\\repo\\a b.txt', 'open')
      expect(spawn).toHaveBeenCalledWith(
        'cmd', ['/c', 'start', '', 'C:\\repo\\a b.txt'], expect.anything(),
      )
    })
  })

  it('reveals a file in explorer on win32 through cmd start with the path attached to the switch', async () => {
    await withPlatform('win32', async () => {
      await defaultOpenPath('C:\\repo\\a b.txt', 'reveal')
      expect(spawn).toHaveBeenCalledWith(
        'cmd', ['/c', 'start', '', 'explorer.exe', '/select,C:\\repo\\a b.txt'], expect.anything(),
      )
    })
  })

  it('opens and reveals through the mac open command on darwin', async () => {
    await withPlatform('darwin', async () => {
      await defaultOpenPath('/repo/a b.txt', 'open')
      await defaultOpenPath('/repo/a b.txt', 'reveal')
      expect(spawn).toHaveBeenNthCalledWith(1, 'open', ['/repo/a b.txt'], expect.anything())
      expect(spawn).toHaveBeenNthCalledWith(2, 'open', ['-R', '/repo/a b.txt'], expect.anything())
    })
  })

  it('opens through xdg-open and reveals the parent directory on linux', async () => {
    await withPlatform('linux', async () => {
      await defaultOpenPath('/repo/a b.txt', 'open')
      await defaultOpenPath('/repo/a b.txt', 'reveal')
      expect(spawn).toHaveBeenNthCalledWith(1, 'xdg-open', ['/repo/a b.txt'], expect.anything())
      expect(spawn).toHaveBeenNthCalledWith(2, 'xdg-open', ['/repo'], expect.anything())
    })
  })
})
