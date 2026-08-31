/**
 * Durable pending-entry persistence under the harness home: one global JSON
 * file holding one entry per file path (across all sessions and workspaces), at
 * `<storageDir>/pending.json`; the default root is `<dshHome>/diff-approval/workspaces`
 * and the plugin's `storageDir` config relocates it. Saves rewrite the whole
 * file (the entry set is small), staged as a sibling temp file and atomically
 * renamed, so a crash leaves either the old or the new file. A missing file
 * reads as empty; corrupt content and unknown versions throw.
 *
 * Legacy layout: the pre-global schema stored one JSON file per workspace
 * (`<storageDir>/<workspaceId>.json`, `{ version: 2, sessions: { [sessionId]:
 * PendingEntry[] } }`). On first load without a global file, `loadAll` scans for
 * those files, flattens every session's entries, and reports them so the caller
 * can fold them into the global store once; `save` then writes the global file
 * and deletes the legacy files.
 * @module dsh-diff-approval/src/persist
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingEntry } from './types.ts'

/** Default persistence root: this plugin's own directory under the harness home. */
export function defaultStorageDir(): string {
  return dshHomePath('diff-approval', 'workspaces')
}

/** Global-file version (post per-workspace schema). */
const FILE_VERSION = 3
/** Legacy per-workspace-file version, accepted only for migration. */
const LEGACY_FILE_VERSION = 2

/** The global on-disk envelope: one entry per file path. */
interface GlobalFile {
  version: number
  entries: PendingEntry[]
}

/** Narrow one JSON value to a pending entry; malformed rows are skipped. */
function pendingEntryOf(value: unknown): PendingEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { id, path, kind, oldText, newText, updatedAt, sessionId, sessionIds } = value as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (kind !== 'edit' && kind !== 'create') return undefined
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (typeof updatedAt !== 'number') return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const ids = Array.isArray(sessionIds)
    ? sessionIds.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  return {
    id, path, kind, oldText, newText, updatedAt,
    sessionId: sessionId as SessionId,
    sessionIds: ids.length > 0 ? ids as SessionId[] : [sessionId as SessionId],
  }
}

/** Validate a parsed global file. */
function globalFileOf(file: string, value: unknown): GlobalFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`pending persistence file '${file}' is not a global file`)
  }
  const { version, entries } = value as Record<string, unknown>
  if (version !== FILE_VERSION) {
    throw new Error(`pending persistence file '${file}' has unsupported version ${JSON.stringify(version)}`)
  }
  if (!Array.isArray(entries)) {
    throw new Error(`pending persistence file '${file}' has no entry list`)
  }
  return { version, entries }
}

/** Read one file's content; `undefined` when absent (the normal empty state). */
async function readJson(file: string): Promise<unknown | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(
      `pending persistence file '${file}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Stage a JSON envelope as a sibling temp file and atomically rename it into place. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirName(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

function dirName(file: string): string {
  const index = file.lastIndexOf('/')
  return index < 0 ? '.' : file.slice(0, index)
}

/**
 * File-backed pending entries, one global file keyed by path.
 */
export class PendingPersistence {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly globalFile: string

  /**
   * @param root - directory holding the global `pending.json` (and, pre-migration,
   * one JSON file per workspace).
   */
  constructor(private readonly root: string) {
    this.globalFile = join(root, 'pending.json')
  }

  /**
   * Load every persisted entry. Returns the global file's entries, or — when the
   * global file is absent — flattens the legacy per-workspace files so the
   * caller can fold them once and then save (which clears the legacy files).
   * @returns the entries plus whether they came from the legacy layout (awaiting
   * a save to finalize the migration).
   */
  async loadAll(): Promise<{ entries: PendingEntry[]; migratedLegacy: boolean }> {
    const global = await readJson(this.globalFile)
    if (global !== undefined) {
      const parsed = globalFileOf(this.globalFile, global)
      const entries: PendingEntry[] = []
      for (const row of parsed.entries) {
        const entry = pendingEntryOf(row)
        if (entry !== undefined) entries.push(entry)
      }
      return { entries: entries.sort((l, r) => l.updatedAt - r.updatedAt), migratedLegacy: false }
    }
    const legacy = await collectLegacy(this.root)
    if (legacy.length > 0) {
      return { entries: legacy.sort((l, r) => l.updatedAt - r.updatedAt), migratedLegacy: true }
    }
    return { entries: [], migratedLegacy: false }
  }

  /**
   * Replace the persisted entry set durably. Saves to the one file are
   * serialized; a previous save's failure does not block the next one. On a
   * legacy migration this also removes the per-workspace files.
   * @param entries - the complete entry list, possibly empty.
   * @returns resolution after the file is durable.
   */
  save(entries: readonly PendingEntry[]): Promise<void> {
    const task = async () => {
      await writeJson(this.globalFile, { version: FILE_VERSION, entries })
      await removeLegacy(this.root)
    }
    const tail = this.tails.get(this.globalFile) ?? Promise.resolve()
    const run = tail.then(task, task)
    this.tails.set(this.globalFile, run.catch(() => {}))
    return run
  }
}

/** Flatten every legacy per-workspace file's entries (adding `sessionIds`). */
async function collectLegacy(root: string): Promise<PendingEntry[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: PendingEntry[] = []
  for (const name of names) {
    if (name === 'pending.json' || !name.endsWith('.json')) continue
    const file = join(root, name)
    const value = await readJson(file)
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null) continue
    const { version, sessions } = value as Record<string, unknown>
    if (version !== LEGACY_FILE_VERSION) continue
    if (typeof sessions !== 'object' || sessions === null) continue
    for (const sessionId of Object.keys(sessions)) {
      const rows = (sessions as Record<string, unknown>)[sessionId]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        const entry = pendingEntryOf(row)
        if (entry !== undefined) entries.push(entry)
      }
    }
  }
  return entries
}

/** Delete the legacy per-workspace files (post-migration cleanup). */
async function removeLegacy(root: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name === 'pending.json' || !name.endsWith('.json')) continue
    await rm(join(root, name), { force: true }).catch(() => {})
  }
}
