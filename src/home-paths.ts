/**
 * The harness-home path helpers this plugin needs, kept LOCAL on purpose.
 *
 * They used to be imported from `@deepseek-ai/dsh-home-paths`, but that package is part of the HOST core, not a
 * library a plugin may ship: declaring it in `dependencies` makes pnpm hoist a second copy into the profile's
 * top-level `node_modules`, where the host's own row can resolve it instead of its matching copy — the host's
 * version gate then disables that row and every service injecting it (issue #10). These two helpers are a few
 * lines with a stable contract, so owning them here removes the shadowing risk entirely.
 *
 * Semantics mirror the host package (v0.1.0-rc):
 *  - the harness home is an explicit configured path, else a NON-EMPTY `$DSH_HOME`, else `~/.dsh`;
 *  - `~`, `~/…` and `~\…` expand against the operating-system home; any other path is returned untouched;
 *  - the result is normalized to an absolute path before joining.
 *
 * @module dsh-diff-approval/src/home-paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory name used for the default harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh'
/** Environment variable that overrides the default harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Expand the supported tilde prefixes against the operating-system home.
 * @param path - a configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root harness home.
 *
 * Precedence, highest first: an explicit configured path, a non-empty `$DSH_HOME`, then `~/.dsh`. A blank or
 * whitespace-only `$DSH_HOME` is treated as unset, so it can never resolve the home to the current directory.
 * @param configured - explicit harness-home override with the highest precedence.
 * @param env - environment mapping used to read `$DSH_HOME` (test seam; defaults to the process environment).
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const candidate = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(candidate))
}

/**
 * Join path segments onto the resolved harness home.
 * @param segments - path segments appended to the harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}
