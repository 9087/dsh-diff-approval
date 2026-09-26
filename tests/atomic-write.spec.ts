// AtomicWrite: the retry that keeps a write from being LOST when the rename is refused.
//
// Measured on this machine (2026-09-26): a `readFile` loop 50ms apart on the same file — exactly what
// `vi.waitFor` does in the host spec — made `rename` fail with `EPERM` in 6 of 12 rounds, and because the
// writer never retried, the update was gone: the file kept the comment that had just been removed. Hence
// the injected fs here rather than a real race: this is deterministic.

import { describe, expect, it, vi } from 'vitest'
import { ATOMIC_WRITE_RETRY, isHeldOpen, writeJsonAtomic } from '../src/atomic-write.ts'
import type { AtomicWriteFs } from '../src/atomic-write.ts'

/** An fs double that renames into a map, failing the first `refusals` attempts the way a held handle does. */
function fakeFs(options: { refusals?: number; code?: string } = {}): {
  io: AtomicWriteFs
  files: Map<string, string>
  attempts: () => number
} {
  const files = new Map<string, string>()
  let attempts = 0
  const refusals = options.refusals ?? 0
  const code = options.code ?? 'EPERM'
  const io: AtomicWriteFs = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (file: string, data: string) => { files.set(file, data) }),
    rename: vi.fn(async (from: string, to: string) => {
      attempts += 1
      if (attempts <= refusals) {
        const error = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
        error.code = code
        throw error
      }
      const data = files.get(from)
      files.delete(from)
      files.set(to, data ?? '')
    }),
    remove: vi.fn(async (file: string) => { files.delete(file) }),
  }
  return { io, files, attempts: () => attempts }
}

describe('writeJsonAtomic', () => {
  it('retries a rename a held handle refused, and the update lands', async () => {
    // The bug this exists for: one `EPERM` from a reader holding the file open used to lose the write
    // outright — the store reported "not written" and the file kept its previous content for good.
    const fs = fakeFs({ refusals: 2 })
    await writeJsonAtomic('C:/state/a.json', { version: 1, comments: [] }, { fs: fs.io, retry: { attempts: 5, delayMs: 1 } })
    expect(fs.attempts()).toBe(3)
    expect(fs.files.get('C:/state/a.json')).toBe('{"version":1,"comments":[]}')
    // Nothing is left staged: the temp file was renamed, not copied.
    expect([...fs.files.keys()]).toEqual(['C:/state/a.json'])
  })

  it('gives up after its attempts, cleans the staged file up, and rethrows', async () => {
    // A file that stays held open is not this write's problem to solve forever: the caller reports it, and
    // the staged bytes go away so the state directory does not fill with files nothing reads.
    const fs = fakeFs({ refusals: 99 })
    await expect(writeJsonAtomic('C:/state/a.json', { version: 1 }, { fs: fs.io, retry: { attempts: 3, delayMs: 1 } }))
      .rejects.toThrow(/EPERM/)
    expect(fs.attempts()).toBe(3)
    expect([...fs.files.keys()]).toEqual([])
  })

  it('does not retry a failure that is not about a held handle', async () => {
    // A missing directory, a full disk, a read-only mount: retrying delays the report the caller has to
    // make, so the first attempt is the last one.
    const fs = fakeFs({ refusals: 99, code: 'ENOSPC' })
    await expect(writeJsonAtomic('C:/state/a.json', { version: 1 }, { fs: fs.io, retry: { attempts: 5, delayMs: 1 } }))
      .rejects.toThrow(/ENOSPC/)
    expect(fs.attempts()).toBe(1)
    expect([...fs.files.keys()]).toEqual([])
  })

  it('creates the target directory before staging, and names each refusal it retries', () => {
    expect(ATOMIC_WRITE_RETRY.attempts).toBeGreaterThan(1)
    expect(isHeldOpen(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true)
    expect(isHeldOpen(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true)
    expect(isHeldOpen(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true)
    expect(isHeldOpen(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
    expect(isHeldOpen(new Error('no code at all'))).toBe(false)
  })

  it('makes the directory the file needs, missing parents included', async () => {
    const fs = fakeFs()
    await writeJsonAtomic('C:/state/deep/a.json', { version: 1 }, { fs: fs.io })
    expect(fs.io.mkdir).toHaveBeenCalledWith('C:/state/deep', { recursive: true })
  })
})
