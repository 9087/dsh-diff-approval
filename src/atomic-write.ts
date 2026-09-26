/**
 * Stage a JSON envelope beside its target and rename it into place, retrying the rename.
 *
 * Both stores in this plugin persist the same way — write a sibling temp file, `rename` it over the
 * real one — because a crash must leave either the old file or the new one and never a torn one. What
 * neither of them did was survive the rename itself being refused, and on Windows that is not rare:
 * replacing a file another process has open at that instant answers `EPERM`, and the readers here are
 * everyone — a second panel, a backup agent, an antivirus, the user's own editor, or this suite's own
 * 50ms `readFile` loop waiting for the write. The refusal is transient by construction (the handle that
 * caused it closes within a tick), but the write it killed was the ONLY copy of that update: the
 * pending list or a session's comment file simply kept its previous content, and the failure was
 * reported as "your threads will not survive a restart" without ever being retried.
 *
 * So the rename is attempted a few times with a short, growing pause. Measured on this machine with a
 * concurrent reader, the retry turns 6 lost writes in 12 into 0 — see `tests/atomic-write.spec.ts` for
 * the deterministic shape (an injected rename that fails once) and the commit message for the numbers.
 *
 * Failures that are NOT about a held handle (a missing directory, a full disk, a read-only mount) are
 * rethrown on the first attempt: retrying those only delays the report the caller has to make.
 *
 * The directory is `node:path`'s own `dirname`, not a scan for the last separator: on Windows the
 * storage root is `C:\Users\<user>\.dsh\diff-approval\workspaces`, which holds no forward slash at all —
 * a scan answered `.`, the `mkdir` before each write became a no-op, and the write threw ENOENT, so
 * nothing was ever persisted there.
 *
 * @module dsh-diff-approval/src/atomic-write
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The file verbs one atomic write uses, injectable so the retry can be tested without a real race. */
export interface AtomicWriteFs {
  /** Create the target's directory, missing parents included. */
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>
  /** Write the staged bytes. */
  writeFile: (file: string, data: string, encoding: 'utf8') => Promise<unknown>
  /** Replace the target with the staged file. */
  rename: (from: string, to: string) => Promise<void>
  /** Remove a staged file that will not be renamed. */
  remove: (file: string) => Promise<unknown>
}

/** How hard a refused rename is tried, and how long to wait between attempts. */
export interface AtomicWriteRetry {
  /** Total attempts, the first one included. */
  attempts: number
  /** Pause before the second attempt, in milliseconds; each further attempt doubles it. */
  delayMs: number
}

/**
 * The default policy: five attempts, 25ms then 50, 100, 200 — a little over a third of a second in all.
 *
 * Long enough for the handle that refused the rename to be closed (a reader gets its next turn of the
 * loop, an antivirus finishes its scan), and short enough that a caller who is waiting on the write
 * — the panel's keep, a comment being added — cannot tell it retried at all.
 */
export const ATOMIC_WRITE_RETRY: AtomicWriteRetry = { attempts: 5, delayMs: 25 }

/**
 * Whether one rename error is the transient "somebody else has this file open" refusal.
 *
 * Windows answers `EPERM` for a replace whose target is open; `EACCES` and `EBUSY` are the same
 * situation seen through a network share or a mapped drive. Nothing else is retried.
 *
 * @param error - whatever the rename threw.
 * @returns whether another attempt is worth making.
 */
export function isHeldOpen(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * Write one JSON envelope atomically, retrying a rename that a held handle refused.
 *
 * @param file - the file to replace.
 * @param value - the value to serialise into it.
 * @param options - the fs verbs and the retry policy, for tests.
 * @throws the rename's own error when the attempts run out, or at once when it is not a held handle.
 */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  options: { fs?: Partial<AtomicWriteFs> | undefined; retry?: AtomicWriteRetry | undefined } = {},
): Promise<void> {
  const io: AtomicWriteFs = {
    mkdir,
    writeFile,
    rename,
    remove: staged => rm(staged, { force: true }),
    ...options.fs,
  }
  const retry = options.retry ?? ATOMIC_WRITE_RETRY
  await io.mkdir(dirname(file), { recursive: true })
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`
  await io.writeFile(staged, JSON.stringify(value), 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      await io.rename(staged, file)
      return
    } catch (error: unknown) {
      if (attempt >= retry.attempts || !isHeldOpen(error)) {
        // The staged bytes are this write's own and nothing else points at them: leaving them behind
        // would litter the state directory with files nothing reads (and `loadAll` skips `.tmp`).
        await io.remove(staged).catch(() => {})
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, retry.delayMs * 2 ** (attempt - 1)))
    }
  }
}
