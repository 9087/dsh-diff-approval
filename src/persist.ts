/**
 * Durable pending-entry persistence under the harness home. One JSON file per
 * workspace holds every session's entries, at
 * `<storageDir>/<workspaceId>.json`; the default root is
 * `<dshHome>/diff-approval/workspaces` and the plugin's `storageDir` config
 * relocates it. `save` rewrites the whole workspace file so sibling sessions
 * survive; a session with no entries leaves the file, and a workspace with no
 * sessions loses its file. Writes are serialized per file, staged as a
 * sibling temp file, and atomically renamed, so a crash leaves either the old
 * or the new file. Missing files read as empty; corrupt content and unknown
 * versions throw so the caller can fail loud instead of silently dropping
 * persisted data.
 * @module dsh-diff-approval/src/persist
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingEntry } from './types.ts'

/** Default persistence root: this plugin's own directory under the harness home. */
export function defaultStorageDir(): string {
  return dshHomePath('diff-approval', 'workspaces')
}

/** On-disk envelope version; bumping it abandons older files (pre-release stance). */
const FILE_VERSION = 2

/** One workspace file on disk: every session's entries for that workspace. */
interface WorkspaceFile {
  version: number
  sessions: Record<string, PendingEntry[]>
}

/** Narrow one JSON value to a pending entry; malformed rows are skipped. */
function pendingEntryOf(value: unknown): PendingEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { id, sessionId, path, kind, oldText, newText, updatedAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (kind !== 'edit' && kind !== 'create') return undefined
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (typeof updatedAt !== 'number') return undefined
  return { id, sessionId: sessionId as SessionId, path, kind, oldText, newText, updatedAt }
}

/**
 * Validate a parsed workspace file. Missing files yield `undefined` (empty);
 * anything else that is not a current-version workspace file throws so a
 * later save cannot silently overwrite unreadable persisted data.
 * @param file - the file path, for the error message.
 * @param value - the parsed JSON value.
 * @returns the validated file, or `undefined` when the file does not exist.
 */
function workspaceFileOf(file: string, value: unknown): WorkspaceFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`pending persistence file '${file}' is not a workspace file`)
  }
  const { version, sessions } = value as Record<string, unknown>
  if (version !== FILE_VERSION) {
    throw new Error(`pending persistence file '${file}' has unsupported version ${JSON.stringify(version)}`)
  }
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    throw new Error(`pending persistence file '${file}' has no session map`)
  }
  return { version, sessions: sessions as Record<string, unknown> } as unknown as WorkspaceFile
}

/**
 * File-backed pending entries keyed by (workspace, session).
 */
export class PendingPersistence {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * @param root - directory holding one JSON file per workspace.
   */
  constructor(private readonly root: string) {}

  private fileOf(workspaceId: string): string {
    return join(this.root, `${workspaceId}.json`)
  }

  /** Read one workspace file; a missing file reads as empty. */
  private async readWorkspace(file: string): Promise<WorkspaceFile | undefined> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      // Absence is the normal empty state; every other fault propagates.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(
        `pending persistence file '${file}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return workspaceFileOf(file, parsed)
  }

  /** Stage the envelope as a sibling temp file and atomically rename it into place. */
  private async writeWorkspace(file: string, envelope: WorkspaceFile): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(envelope), 'utf8')
    try {
      await rename(tmp, file)
    } catch (error) {
      // Best-effort cleanup of the staged file; the write failure propagates.
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Load one session's entries from its workspace file, oldest capture first.
   * @param workspaceId - the owning workspace's stable id.
   * @param sessionId - the session whose entries to load.
   * @returns the persisted entries; empty when none were saved.
   */
  async load(workspaceId: string, sessionId: string): Promise<PendingEntry[]> {
    const envelope = await this.readWorkspace(this.fileOf(workspaceId))
    if (envelope === undefined) return []
    const rows = envelope.sessions[String(sessionId)]
    if (!Array.isArray(rows)) return []
    const entries: PendingEntry[] = []
    for (const row of rows) {
      const entry = pendingEntryOf(row)
      if (entry !== undefined) entries.push(entry)
    }
    return entries.sort((left, right) => left.updatedAt - right.updatedAt)
  }

  /**
   * Replace one session's entries durably. Saves to one file are serialized;
   * a previous save's failure does not block the next one.
   * @param workspaceId - the owning workspace's stable id.
   * @param sessionId - the session whose entries to replace.
   * @param entries - the session's complete entry list, possibly empty.
   * @returns resolution after the file is durable.
   */
  save(workspaceId: string, sessionId: string, entries: readonly PendingEntry[]): Promise<void> {
    const file = this.fileOf(workspaceId)
    const task = async () => {
      const envelope = await this.readWorkspace(file)
      if (entries.length === 0) {
        if (envelope === undefined) return
        delete envelope.sessions[String(sessionId)]
        if (Object.keys(envelope.sessions).length === 0) {
          await rm(file, { force: true })
          return
        }
        await this.writeWorkspace(file, envelope)
        return
      }
      const next: WorkspaceFile = envelope ?? { version: FILE_VERSION, sessions: {} }
      next.sessions[String(sessionId)] = [...entries]
      await this.writeWorkspace(file, next)
    }
    const tail = this.tails.get(file) ?? Promise.resolve()
    const run = tail.then(task, task)
    this.tails.set(file, run.catch(() => {}))
    return run
  }
}
