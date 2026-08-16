/**
 * Temp-directory cleanup shared by host-side test suites. Windows transient
 * locks (an open handle on a just-written file) make a single `rm` fail with
 * EPERM; cleanup retries briefly and never fails the suite on its final
 * attempt — a leaked temp dir under the OS temp root is harmless residue.
 * @module @wuzhiwei/dsh-diff-approval/tests/cleanup
 */

import { rm } from 'node:fs/promises'

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

/**
 * Remove a temp dir with brief retries for Windows transient lock errors.
 * @param dir - the directory to remove recursively.
 * @returns resolution once the directory is gone (or the final failure is accepted).
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch {
      // A transient EPERM/EACCES/EBUSY (or any other fault) retries; the
      // final failure is accepted so a leaked temp dir cannot fail a suite.
      if (attempt === 4) return
      await sleep(10 * (attempt + 1))
    }
  }
}
