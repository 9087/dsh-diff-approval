/**
 * OS-level "open file" and "reveal in folder" launches for the host half's
 * `open` endpoint. The plugin's own tests inject a double instead of running
 * these; real profiles get the platform commands below.
 * @module dsh-diff-approval/open
 */

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** What the open endpoint asks the OS to do with a path. */
export type OpenAction = 'open' | 'reveal'

/** Run one detached command; resolves once the process spawns, never waits for exit. */
function launch(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}

/**
 * Launch a path through the current platform's default handler: `open` runs
 * the file with its default application, `reveal` selects it in the file
 * manager.
 * @param path - backend execution-world path to act on.
 * @param action - what to do with the path.
 * @returns resolution once the launcher process has spawned.
 */
export function defaultOpenPath(path: string, action: OpenAction): Promise<void> {
  switch (process.platform) {
    case 'win32':
      return action === 'open'
        ? launch('cmd', ['/c', 'start', '', path])
        // Explorer wants the target in the same token as the switch
        // (`/select,<path>`); launching it through `cmd start` is what makes
        // the window show in the interactive session — a direct explorer
        // spawn steals focus but never appears.
        : launch('cmd', ['/c', 'start', '', 'explorer.exe', `/select,${path}`])
    case 'darwin':
      return action === 'open' ? launch('open', [path]) : launch('open', ['-R', path])
    default:
      return action === 'open' ? launch('xdg-open', [path]) : launch('xdg-open', [dirname(path)])
  }
}
