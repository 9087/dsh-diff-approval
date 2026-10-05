/**
 * Pending-edit review, host half. Captures every successful `edit` and `write`
 * tool result (an unscoped `tools/result` listener receives per-session tool
 * executions because scoped emissions route through the shared root hook
 * table) and every `str_replace_editor` mutation (whose result carries only a
 * success message, so its pre-write basis is snapshotted at the
 * `fs/edit-intent` / `fs/write-intent` seams and paired with the settle),
 * folds each operation into its file's entry in the
 * {@link PendingDiffStore} (one entry per path), serves the `/diff-approval`
 * connection RPC channel (list/keep/revert/open), and applies a revert by
 * writing the entry's `oldText` back through `ctx.fs` (a created file's
 * revert removes it, and a tracked file that has since disappeared is
 * restored by its revert). `open` launches the file with its default
 * application or reveals it in the file manager.
 *
 * Mount this row in any profile's `cordis.patch.yml`:
 *
 * ```yaml
 * - insert:
 *     - id: diff-approval
 *       name: 'dsh-diff-approval'
 *       # Optional: relocate durable pending state (defaults to
 *       # <dshHome>/diff-approval/workspaces).
 *       # config:
 *       #   storageDir: ~/.dsh/diff-approval/workspaces
 * ```
 *
 * Pending entries persist per (workspace, session) so an unhandled operation
 * survives a harness restart; the list endpoint hydrates the whole workspace
 * and merges every registered session's entries, so a fresh session after a
 * restart still reports the earlier sessions' pending changes, live-verified
 * exactly as it is mid-session.
 *
 * @module dsh-diff-approval
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
// Type-only: brings the `ctx.fs` Context merge into this program.
import type { FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: brings the `ctx.workspaceRegistry` Context merge into this program.
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { PendingDiffStore } from './pending.ts'
import { PendingPersistence, defaultStorageDir } from './persist.ts'
import { CommentStore, commentsDirFor } from './comments.ts'
import type { CommentScope } from './comments.ts'
import { CommentAsker } from './comment-ask.ts'
import type { TranscriptCache } from './comment-ask.ts'
import { resolveCommentLines } from './comment-lines.ts'
import type { CommentLineRange } from './comment-lines.ts'
import { defaultOpenPath } from './open.ts'
import type { OpenAction } from './open.ts'
import { COMMENT_SKILL, COMMENT_SKILL_NAME } from './comment-skill.ts'
import { ANNOTATE_SKILL } from './annotate-skill.ts'
import { annotateRun, annotateToolDefinition } from './annotate-tool.ts'
import type { AnnotateRunDeps, ListFileOutcome } from './annotate-tool.ts'
import { FONT_ASSET_DIR, FONT_ROUTE } from './font-slices.ts'
import type { FontSlice } from './font-slices.ts'
import { detectVcsRoot, listVcsChanges } from './vcs.ts'
import type { VcsChange, VcsImportInput, ShellExecutorLike } from './vcs.ts'
import type {
  DiffApprovalActionValue, DiffApprovalAddOutcome, DiffApprovalAddValue, DiffApprovalBlockTarget, DiffApprovalBrowseEntry, DiffApprovalBrowseValue,
  DiffApprovalBulkValue, DiffApprovalListCountValue, DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, DiffApprovalPreviewImageValue, DiffApprovalRefreshValue,
  CommentAnchor, CommentQuoteLine, CommentRecord, DiffApprovalCommentAddValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue,
  LineageDirection, PendingEntry, PendingEntryKind, PendingFileDiff, SessionLineage, VcsImportValue,
} from './types.ts'

export type {
  DiffApprovalActionOutcome, DiffApprovalActionValue, DiffApprovalBlockRange, DiffApprovalBlockTarget,
  DiffApprovalListCountValue, DiffApprovalListValue, DiffApprovalOpenAction, DiffApprovalOpenValue, DiffApprovalRefreshOutcome, DiffApprovalRefreshValue,
  CommentAnchor, CommentQuoteLine, CommentRecord, DiffApprovalCommentAddValue, DiffApprovalCommentRemoveManyValue, DiffApprovalCommentRemoveValue,
  LineageDirection, PendingEntry, PendingEntryKind, PendingFileDiff, SessionLineage,
} from './types.ts'
export { PendingDiffStore } from './pending.ts'
export { PendingPersistence, defaultStorageDir } from './persist.ts'
export { CommentStore, commentsDirFor } from './comments.ts'
export { CommentAsker, answerForRequest } from './comment-ask.ts'
export { defaultOpenPath } from './open.ts'

/** Stable Cordis plugin name. */
export const name = 'diff-approval'

/**
 * Services required before the review surface activates. `webServer` rides with
 * `connection` (both come from the web bundle), and is named explicitly because
 * the channel's owner context must be able to resolve it — see
 * `ConnectionServiceSurface`. `sessionController` and `agents` are what a comment is
 * asked through and what reports the turn that claimed it: both come from the same
 * base composition this plugin already requires for `sessions`, so a host that could
 * list pending changes at all has them.
 */
export const inject = ['fs', 'connection', 'webServer', 'workspaceRegistry', 'sessions', 'sessionController', 'agents']

/** The connection RPC channel this plugin serves. */
export const DIFF_APPROVAL_CHANNEL = '/diff-approval'

export { COMMENT_SKILL_NAME } from './comment-skill.ts'

/**
 * The skill to name in a comment prompt on this deployment, or `undefined` when the
 * harness cannot deliver it.
 *
 * The prompt has two shapes: the short rules inline (always works), or nothing but a
 * pointer at this skill (the rules then cost nothing until a comment is answered). Which
 * one the client sends is the HOST's answer, because the host is the only side that knows
 * whether the contribution landed.
 *
 * The answer turns on the registration alone — the half this plugin performs and can be
 * sure of. The other half, the `skill` tool that advertises the catalog and loads the
 * body, belongs to the harness: `dsh-base` mounts `@deepseek-ai/dsh-tool-skill` beside
 * `dsh-skill`, and both have shipped in every release since `0.0.1-rc.1`. Asking the tool
 * registry for it instead was tried and reads absent in a live session whose catalog was
 * demonstrably working — a false negative that kept the rules inline. The registration is
 * the honest signal.
 *
 * @param _ctx - the plugin's host context (kept for the shape of the question).
 * @param registered - whether {@link registerCommentSkill} got the skill in.
 * @returns the skill name to point the prompt at, or undefined for the inline rules.
 */
function commentSkillCapability(_ctx: Context, registered: boolean): string | undefined {
  return registered ? COMMENT_SKILL_NAME : undefined
}

/**
 * The answer to {@link commentSkillCapability}, asked no earlier than the first list
 * request — applying is too early for anything that reads another plugin's services. A
 * positive is kept; a negative is re-checked on the next request, since it costs two
 * property lookups.
 *
 * @param ctx - the plugin's host context.
 * @param registered - whether the skill is in the registry.
 * @returns a memo that answers with the skill name or undefined.
 */
function lazyCommentSkill(ctx: Context, registered: boolean): () => string | undefined {
  let resolved: string | undefined
  let reported = false
  return () => {
    if (resolved !== undefined) return resolved
    resolved = commentSkillCapability(ctx, registered)
    if (!reported) {
      // One line, once: whether this deployment's comment prompts point at the skill. A
      // deployment that keeps the rules inline is otherwise indistinguishable from one
      // whose client dropped the field.
      reported = true
      ctx.logger.info(`diff-approval: comment skill ${resolved ?? 'not used'} (registered=${registered})`)
    }
    return resolved
  }
}

/**
 * One runtime skill this plugin offers, in the shape `ctx.skills.register` takes.
 *
 * Two contributions are written in it — the comment-answering rules (`comment-skill.ts`) and the
 * annotating rules (`annotate-skill.ts`) — and they register the same way, so the shape lives here
 * rather than being repeated in each of them.
 */
interface RuntimeSkill {
  /** Kebab-case identity the agent loads by. */
  readonly name: string
  /** Catalog routing line. */
  readonly description: string
  /** Catalog routing guidance. */
  readonly whenToUse: string
  /** Instruction body. */
  readonly content: string
  /** Origin bucket: this plugin contributes it at runtime, not from disk. */
  readonly source: 'runtime'
}

/**
 * Register one of this plugin's skills with the harness's skill registry, when it has one. The
 * registry's own `skill` tool advertises the catalog and loads a body on demand, so this costs nothing
 * until the situation it is about comes up — and unlike a system-prompt section, a global registration
 * here cannot shape unrelated turns.
 *
 * Feature-detected and contained: a build without the registry, or a registry that refuses the
 * contribution, leaves whatever the prompts already carry as the whole policy (the comment prompt names
 * its skill inline; the annotating rules lose only their long form, and the tool description still says
 * what the tool is for).
 *
 * @param ctx - the plugin's host context.
 * @param skill - the contribution to register.
 * @returns whether the skill is now in the registry.
 */
function registerRuntimeSkill(ctx: Context, skill: RuntimeSkill): boolean {
  if (typeof (ctx.get('skills') as { register?: unknown } | undefined)?.register !== 'function') return false
  let registered = false
  ctx.effect(() => {
    const skills = ctx.get('skills') as { register?: (skill: unknown) => unknown } | undefined
    if (typeof skills?.register !== 'function') return () => {}
    try {
      const dispose = skills.register(skill)
      registered = true
      return typeof dispose === 'function' ? dispose as () => void : () => {}
    } catch {
      // A registry that rejects the name (a reserved or duplicate one) is not a reason
      // to fail the plugin: the prompt's inline rules still stand on their own.
      return () => {}
    }
  })
  return registered
}

/**
 * Register the annotate tool with the harness's tool registry, when it has one.
 *
 * Feature-detected like the skills, and deliberately NOT declared in `inject`: the host half of this
 * plugin imports nothing from the harness at runtime (its harness packages are services it asks for by
 * name, and types), so a composition without a tool registry keeps working with the tool simply absent
 * — where an unsatisfied `inject` would defer the whole plugin, the trap `src/index.ts` documents for
 * `sessionController`.
 *
 * @param ctx - the plugin's host context.
 * @param deps - what fulfils one call (see `annotate-tool.ts`).
 * @returns whether the tool is now in the registry.
 */
function registerAnnotateTool(ctx: Context, deps: AnnotateRunDeps): boolean {
  if (typeof (ctx.get('tools') as { register?: unknown } | undefined)?.register !== 'function') return false
  let registered = false
  ctx.effect(() => {
    const tools = ctx.get('tools') as { register?: (definition: unknown) => unknown } | undefined
    if (typeof tools?.register !== 'function') return () => {}
    try {
      const dispose = tools.register(annotateToolDefinition(annotateRun(deps)))
      registered = true
      return typeof dispose === 'function' ? dispose as () => void : () => {}
    } catch (error: unknown) {
      // A registry that refuses the definition (a name already taken, a shape it does not accept) must
      // not take the panel down with it: the reader's own comments are this plugin's job, and the tool
      // is an extra door into them.
      ctx.logger.warn(`diff-approval: the annotate tool was refused by the tool registry: ${errorMessage(error)}`)
      return () => {}
    }
  })
  return registered
}

/**
 * Plugin configuration overridable from the profile's `cordis.patch.yml`.
 */
export interface DiffApprovalConfig {
  /**
   * Root directory for durable pending state, defaulting to
   * `<dshHome>/diff-approval/workspaces`. Must be a non-empty string when set;
   * `~` prefixes expand to the OS home.
   */
  storageDir?: string
  /**
   * Launcher for the `open` endpoint, defaulting to the platform commands.
   * Injectable for tests; receives the backend execution-world path.
   */
  openPath?: (path: string, action: DiffApprovalOpenAction) => Promise<void>
}

/** One tool result's fields this plugin consumes, narrowed from the tool's JSON value. */
interface OperationOutcome {
  path: string
  earlierVersion: PendingEntryKind
  oldText: string
  newText: string
}

/**
 * Structural stand-in for the harness's `SandboxExecutionPolicy` (type-only;
 * avoids a hard dependency on `@deepseek-ai/dsh-sandbox`). `sessionId` is
 * intentionally omitted: the plugin's published `dsh-session` and the
 * harness's local one are distinct branded types, and the containment fence
 * only needs `mode` + `workspaceRoot`. A Revert write must carry the session's
 * workspace root, or the sandbox fences it against `process.cwd()` and denies
 * it.
 */
interface SandboxExecutionPolicyLike {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

/** One restorable snapshot of an entry plus its file, for undo/redo. */
interface DiffApprovalUndoState {
  /** Entry id (survives even when the entry is absent, so redo can remove it). */
  id: string
  /** The entry's path (for file writes even when the entry is absent). */
  path: string
  /** The store entry to restore (undefined = the entry is absent). */
  entry: PendingEntry | undefined
  /** The file content to write on restore (undefined = leave the file untouched).
   * This is the exact bytes the action wrote (already line-ending adjusted), so
   * restore writes it verbatim and reproduces the action independent of the
   * current line-ending-sensitivity setting. */
  fileText: string | undefined
  /** A batch of entries restored/removed together (one VCS import). Each item's
   * `entry` decides restore vs remove; present only on the import's pair. */
  batch?: readonly DiffApprovalUndoState[] | undefined
  /** What this side is ABOUT. Absent means the entry/file state every other
   * snapshot carries; `'comments'` means it is a set of comment threads. The two
   * kinds ride ONE pair type and ONE stack because undo is a single global LIFO:
   * Ctrl+Z takes back the reader's last action whether that action settled a file
   * or ended a comment, so a second stack would have to be merged back into this
   * one at every pop — and `popOwnPair` would have to know which kind goes first. */
  kind?: 'comments' | undefined
  /** The comment records this side holds (`kind === 'comments'` only): the ones a
   * restore installs, while the OTHER side's are the ones it removes. A record is
   * stored verbatim rather than rebuilt, which is what brings a thread back with
   * its id, its anchor and the questions it was asked in. */
  comments?: readonly CommentRecord[] | undefined
}

/** Before/after pair pushed on each undoable keep/revert action. */
interface DiffApprovalUndoPair {
  /**
   * The LINEAGE ROOT whose stack this pair sits on — the canonical session the stack is keyed by, so a
   * Ctrl+Z in any seat of one lineage reaches it (see `undoStackOf`). In memory only: the stacks are.
   */
  root: SessionId
  /**
   * The session that PRESSED the action, kept for diagnostics and attribution — and the session the undo
   * stack is filed under, because `pushUndo` canonicalizes it (see `undoStackOf`).
   */
  pressedBy: SessionId
  /**
   * The session whose workspace and sandbox policy the RESTORE writes under, RECORDED rather than
   * re-derived.
   *
   * This is the session that performed the forward action — the seat that pressed it — and a forward action
   * now resolves its own write from the REQUESTING session (see the three `revertEntryContent` call sites):
   * visibility already guarantees the requester shares a workspace with an owner, so the file is inside the
   * requester's workspace, and a press runs under the authority of the seat that pressed it rather than
   * borrowing another session's wider grant.
   *
   * It is a separate field because the restore cannot re-derive it: the stack is keyed by the LINEAGE ROOT,
   * so a DIFFERENT seat of the same lineage may pop this pair (`undo`/`redo` read it from here), and the
   * restore must still run under the seat that acted — never under the popper, and never again from the
   * entry's owner. Today every push records the presser, because that is what the forward write used; the
   * field is what makes that a fact about the ACTION rather than a guess about the popper.
   */
  policySession: SessionId
  before: DiffApprovalUndoState
  after: DiffApprovalUndoState
}

/** The dominant line ending of `text`: CRLF when `\r\n` meets or beats lone
 * `\n`, else LF; a text with no line breaks falls back to LF.
 * @param text - the content to inspect.
 * @returns the dominant line-ending sequence.
 */
function detectEol(text: string): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) { crlf++; i++ }
    } else if (c === 10) {
      lf++
    }
  }
  if (crlf === 0 && lf === 0) return '\n'
  return crlf >= lf ? '\r\n' : '\n'
}

/** Normalize any line ending (`\r\n`, `\r`) to `\n`. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Whether two contents are equal ignoring line endings and a trailing-newline
 *  difference — the same tolerance the whole-file diff uses, so a file that the
 *  diff view shows as "no pending diff" is treated as fully resolved here too. */
function contentEqual(a: string, b: string): boolean {
  return contentLinesOf(normalizeEol(a)).join('\n') === contentLinesOf(normalizeEol(b)).join('\n')
}

/** Re-encode `text`'s line endings to `eol` (its content is unchanged). */
function reencodeEol(text: string, eol: '\r\n' | '\n'): string {
  const normalized = normalizeEol(text)
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

/**
 * Narrow a successful `edit` result value to an operation outcome. The edit
 * tool's output schema declares exactly `{ path, before, after }`; anything
 * else is another tool's value or malformed data, which this recorder skips.
 * @param value - the successful result's JSON value.
 * @returns the outcome, or `undefined` when the value is not an edit outcome.
 */
function editOutcomeOf(value: unknown): OperationOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { path, before, after } = value as Record<string, unknown>
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof before !== 'string' || typeof after !== 'string') return undefined
  return { path, earlierVersion: 'file', oldText: before, newText: after }
}

/**
 * Narrow a successful `write` result value to an operation outcome. The write
 * tool's output schema declares `{ path, operation, before, after }`;
 * `operation: 'create'` becomes an entry with `earlierVersion: 'none'` (there is
 * no earlier version, so the whole-file action removes the file),
 * `operation: 'update'` one with `earlierVersion: 'file'`. An update whose
 * `before` is null carried no contextual basis, so it is skipped rather than
 * tracked as an un-revertable overwrite.
 * @param value - the successful result's JSON value.
 * @returns the outcome, or `undefined` when the value is not a trackable write.
 */
function writeOutcomeOf(value: unknown): OperationOutcome | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { path, operation, before, after } = value as Record<string, unknown>
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (operation !== 'create' && operation !== 'update') return undefined
  if (typeof after !== 'string') return undefined
  if (operation === 'create') return { path, earlierVersion: 'none', oldText: '', newText: after }
  if (typeof before !== 'string') return undefined
  return { path, earlierVersion: 'file', oldText: before, newText: after }
}

/** Human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Directories one browse level hides: VCS/build noise a review list never wants.
 *  The path box can still reach them by typing the path outright. */
const BROWSE_HIDDEN_NAMES = new Set(['.git', 'node_modules'])

/** Cap on one browse level's children: the panel renders a list, not a dump of a
 *  huge directory, and it reports `truncated` rather than silently cutting. */
const BROWSE_ENTRY_CAP = 500

/** Cap on the files one no-change walk reads: ticking the box on a directory
 *  asks for "everything under here", which must not mean reading a whole tree
 *  (every file's text) inside one call. */
const ADD_UNCHANGED_CAP = 300

/**
 * One absolute path as a workspace-relative path with `/` separators, or
 * `undefined` when it lies outside the root. `''` is the root itself.
 * @param root - the workspace root.
 * @param absolute - the path to express relative to it.
 * @returns the relative path, or undefined when outside.
 */
function workspaceRelativeOf(root: string, absolute: string): string | undefined {
  const rel = relative(resolve(root), resolve(absolute))
  if (rel === '') return ''
  // A different Windows drive comes back absolute; a sibling comes back as `..`.
  if (isAbsolute(rel)) return undefined
  const parts = rel.split(/[\\/]/)
  if (parts[0] === '..') return undefined
  return parts.join('/')
}

/**
 * Resolve one caller-supplied path against the workspace root. A relative path
 * is taken as workspace-relative; an absolute one must still land inside.
 * @param root - the workspace root.
 * @param input - the caller's path (absolute or workspace-relative).
 * @returns the absolute path, or undefined when it escapes the workspace.
 */
function resolveInsideWorkspace(root: string, input: string): string | undefined {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input)
  return workspaceRelativeOf(root, absolute) === undefined ? undefined : absolute
}

/** The workspace-relative parent of a relative directory path (`''` at the root). */

/** Fold one path for comparison: absolute, `/`-separated, case-folded on Windows.
 *  Entries are keyed by the path spelling their capture carried (a tool's display
 *  path or a scan's absolute one), so an equality test has to normalize first. */
function pathIdentity(absolute: string): string {
  const unified = resolve(absolute).split(/[\\/]/).join('/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** Narrow a tool-execution-shaped value to its name, call id, and agent. */
function actorOf(value: unknown): { name: unknown; callId: unknown; agent: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { name, callId, agent } = value as Record<string, unknown>
  return { name, callId, agent }
}

/** Narrow an agent-shaped value to its session id. */
function sessionOfAgent(agent: unknown): SessionId | undefined {
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? SessionId(id) : undefined
}

/**
 * The MIME type for an image path by its lowercased extension. An unknown or
 * non-image extension falls back to the generic binary type, which browsers
 * still render when the bytes decode; the common Markdown image formats are
 * covered so a preview inlines as the right content type.
 * @param path - the image's OS path.
 * @returns the MIME type.
 */
function imageMimeOf(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

/**
 * Build one channel error in the closed RPC error vocabulary. `internal` is
 * the catch-all: business misses ride the success branch as `outcome: 'missing'`.
 * @param message - the handler-side description.
 * @returns the error branch.
 */
function rpcError(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/**
 * The slice of the Host connection service this plugin mounts its channel with.
 *
 * `rpc.handle` is the published surface, but it hardcodes the *service's* own
 * context as the registration owner, and the method it delegates to reads
 * `owner.webServer` from that context. dsh-client-connection moved `webServer`
 * out of that plugin's `inject` into a nested scope, so `handle` throws
 * `cannot get property "webServer" without inject` there and takes the whole
 * plugin tree down at boot. Declaring `webServer` on the *caller* does not help:
 * the owner is the provider's context, so `handle` fails no matter what this
 * plugin injects. `register` takes the owner as a parameter, so naming our own
 * `webServer`-injecting context restores the documented intent — "channel
 * registrations belong to the caller fiber" — and mounts regardless. Upstream
 * report: https://github.com/deepseek-ai/deepseek-harness/discussions/5926 ;
 * drop this once `connection`'s own inject lists `webServer` again. The
 * published types mark `register` private, hence this local declaration.
 */
interface ConnectionServiceSurface {
  /** Published channel registry, kept as the fallback path. */
  readonly rpc: {
    handle: (
      channel: string,
      handler: ConnectionRpcHandler,
      options?: { readonly authority: 'trusted-host' | 'loopback' },
    ) => () => Promise<void>
  }
  /**
   * Mount one channel for an explicit owner; absent on some builds. The trailing
   * options carry the channel's trust policy: releases in the 0.1.0 line read
   * `options.authority` unconditionally, so it must be passed.
   */
  register?: (
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options?: { readonly authority: 'trusted-host' | 'loopback' },
  ) => () => Promise<void>
}

/**
 * Mount the pending-edit review surface.
 * @param ctx - Cordis context carrying the filesystem, connection, and workspace registry services.
 * @param config - optional plugin configuration (`storageDir` relocates durable state).
 */
export function apply(ctx: Context, config?: DiffApprovalConfig): void {
  const storageDir = config?.storageDir
  if (storageDir !== undefined && (typeof storageDir !== 'string' || storageDir.trim().length === 0)) {
    throw new Error('diff-approval: storageDir must be a non-empty string')
  }
  const store = new PendingDiffStore()
  const storageRoot = resolve(expandHomePath(storageDir ?? defaultStorageDir()))
  const persistence = new PendingPersistence(storageRoot)
  // Comments live in their own directory, never in the pending file: an entry that
  // left the list and a comment that outlived it are exactly what this pairing has
  // to keep apart (see `CommentStore`).
  //
  // Its two failure seams are wired here because the store owns no logger: a comment
  // write that fails is the same trap as a pending list that will not survive a restart
  // (the reader finds the thread gone later with nothing to explain it), and a file the
  // load had to skip has to be named rather than left as a silently shorter thread.
  const comments = new CommentStore(commentsDirFor(storageRoot), {
    onLoadSkipped: (file, error) => {
      ctx.logger.warn(`diff-approval: skipping unreadable comment file '${file}' (moved to '.corrupt'): ${errorMessage(error)}`)
    },
    onPersistError: (message) => {
      if (message === undefined) return
      ctx.logger.error(`diff-approval: writing comments failed, so the threads will not survive a restart: ${message}`)
    },
  })
  // Asks a comment's question through the session's own prompt API and reads the
  // answer back out of the transcript (see `CommentAsker`).
  const commentAsker = new CommentAsker(ctx, comments)

  /**
   * The lines each comment sits on now, resolved from the entry content it hangs off and held
   * against the version of that content it was resolved at (see `resolveCommentLines` for the rule
   * and `PendingDiffStore.contentVersion` for the versions).
   *
   * The list read is the hot path — every client of the session asks once a second — so a figure
   * that costs a search of the entry's whole content is computed when the content can have changed
   * and reused until it has. Nothing is written to the comment record: a resolved line is DERIVED,
   * and a persisted one would outlive the content it was true of.
   */
  const commentLines = new Map<string, {
    /** The entry the comment hangs off, so the figure can be dropped with that entry. */
    entryId: string
    /** The entry content version the range was resolved against. */
    version: number
    /** The record fields it was resolved from, so an edited comment re-resolves. */
    quote: string
    context: string | undefined
    startLine: number
    endLine: number
    /** The resolved range, or `undefined` when the quote is nowhere in that content. */
    range: CommentLineRange | undefined
  }>()

  /**
   * The new-file lines this session's comments sit on now, keyed by comment id.
   *
   * This is the whole point of resolving in the host: the list pane, the code view's own card and
   * the jump that opens it draw ONE figure, and they draw it without anything having been opened —
   * a comment used to be corrected by the open file's pane and published back to the list, so the
   * list read `382` while the card read `378` until the reader opened the file.
   *
   * A comment whose quote is gone from the content is ABSENT from the map rather than guessed at:
   * the caller then falls back to `record.anchor`, the line the comment was written on, which is
   * the same answer an outdated thread shows.
   * @param listed - the comments this read is handing over: the caller took ONE scoped list and reuses it
   *   here, because resolving lines is derived from a record's own fields (`quote`, `anchor`, `entryId`),
   *   none of which a fold touches — so the pre-fold and post-fold lists resolve identically.
   * @returns the resolved lines per comment id; comments that do not resolve are left out.
   */
  function resolvedCommentLines(listed: readonly CommentRecord[]): Record<string, CommentLineRange> {
    const resolved: Record<string, CommentLineRange> = {}
    for (const comment of listed) {
      const entry = store.get(comment.entryId)
      if (entry === undefined) continue
      const version = store.contentVersion(comment.entryId)
      const cached = commentLines.get(comment.id)
      if (cached !== undefined
        && cached.entryId === comment.entryId
        && cached.version === version
        && cached.quote === comment.quote
        && cached.context === comment.quoteContext
        && cached.startLine === comment.anchor.startLine
        && cached.endLine === comment.anchor.endLine) {
        if (cached.range !== undefined) resolved[comment.id] = cached.range
        continue
      }
      const range = resolveCommentLines(entry.newText, comment)
      commentLines.set(comment.id, {
        entryId: comment.entryId,
        version,
        quote: comment.quote,
        context: comment.quoteContext,
        startLine: comment.anchor.startLine,
        endLine: comment.anchor.endLine,
        range,
      })
      if (range !== undefined) resolved[comment.id] = range
    }
    return resolved
  }

  /**
   * Drop the resolved lines of every comment that hangs off one entry. They are what an entry takes
   * with it when it leaves the list (`dropEntry` removes those comments), so their figures go too.
   * @param entryId - the entry that left the list.
   */
  function forgetCommentLinesForEntry(entryId: string): void {
    for (const [id, row] of commentLines) {
      if (row.entryId === entryId) commentLines.delete(id)
    }
  }

  /** Drop the resolved lines of the comments the store no longer holds (the orphan sweep's leavings). */
  function forgetOrphanedCommentLines(): void {
    for (const id of commentLines.keys()) {
      if (comments.get(id) === undefined) commentLines.delete(id)
    }
  }

  const launchPath = config?.openPath ?? defaultOpenPath
  // What a comment prompt may point the agent at. Asked lazily, on the first list
  // request: the tool registry is still filling up while plugins mount (see
  // `lazyCommentSkill`).
  const commentSkill = lazyCommentSkill(ctx, registerRuntimeSkill(ctx, COMMENT_SKILL))
  // The annotating rules, and the tool they are about: both optional, both feature-detected the way the
  // comment skill is. Registered here so the catalog and the tool appear together — an agent that can
  // see the tool should be able to load the long form, and one whose harness has neither is unharmed.
  registerRuntimeSkill(ctx, ANNOTATE_SKILL)
  /** Hydrate the globally-unique store once from the single persistence file. */
  let loadPromise: Promise<void> | undefined
  const ensureLoaded = (): Promise<void> => {
    loadPromise ??= (async () => {
      try {
        const { entries, migratedLegacy } = await persistence.loadAll()
        if (entries.length > 0) store.hydrate(entries)
        // A legacy per-workspace layout: fold once, then drop the old files.
        if (migratedLegacy) await persistence.save(store.all())
      } catch (error: unknown) {
        ctx.logger.error(`diff-approval: loading persisted state failed, so the list starts empty: ${errorMessage(error)}`)
      }
      try {
        // The orphan sweep at load: an entry the store does not hold here may have been removed while this
        // host was running, or its add may simply not have reached `pending.json` (an entry is folded in
        // memory and its file write rides a later flush — `foldBatch` now awaits it, see
        // `listFileForAnnotation`). The two are indistinguishable at boot, and the second one must not cost
        // the reader a comment, so `retain` prunes the VIEW and never writes: a boot that does see the
        // entry brings its comments back instead of finding them erased. Skipped when any file could not be
        // read: the comments that file held are absent from the store, and sweeping on that incomplete set
        // would hide the good files' orphans too — a corrupt file must not be able to destroy data it never
        // touched (the bad file itself is moved aside, see `CommentStore.loadAll`).
        const loaded = await comments.loadAll()
        if (loaded > 0 && comments.skippedFiles().length === 0) {
          comments.retain(new Set(store.all().map(entry => entry.id)))
        }
      } catch (error: unknown) {
        // Only the readdir-level failures reach here now; a bad file is skipped and named
        // rather than taking every session's comments with it.
        ctx.logger.error(`diff-approval: loading comment state failed, so the comments start empty: ${errorMessage(error)}`)
      }
    })()
    return loadPromise
  }

  // The agent's own door into the same store the panel writes to: `diff_approval_annotate`, registered
  // after `ensureLoaded` exists because a call has to hydrate the stores before it reads them, exactly
  // as the panel's own handlers do. Both halves of that store are the ones the panel uses — the pending
  // list decides which files a card can hang on, and the comment store takes the record — so an
  // agent's annotation IS a comment: the reader sees it, replies to it, and ends it like any other.
  //
  // Both reads are the LINEAGE's, like the panel's own: an agent in a child session must see the same rows
  // and threads its panel shows, or it would annotate a path it cannot see (refused) or open a second
  // thread beside one it cannot read. The view is built per call — this seam is a tool invocation, not a
  // poll — and `addComment` still files the record under the AUTHOR.
  registerAnnotateTool(ctx, {
    ready: ensureLoaded,
    entriesOf: (sessionId) => {
      const view = lineageView()
      return store.all().filter(entry => view.sees(sessionId, entry))
    },
    commentsOf: sessionId => comments.list(commentScopeOf(sessionId, lineageView())),
    // An AGENT authored this card while the reader was looking elsewhere, so it is news and wears the
    // dot. The reader's own write goes through `comment-add` below and lights nothing — they are the
    // one who made it, and it is on screen as they make it.
    addComment: (record) => { comments.add(record.author === 'agent' ? { ...record, unseen: true } : record) },
    listFile: (sessionId, asked, signal) => listFileForAnnotation(sessionId, asked, signal),
    log: message => ctx.logger.info(`diff-approval: ${message}`),
  })

  /**
   * Admit one file into a session's list, so an annotation can hang on it.
   *
   * The panel lists what the workspace has pending; an agent that wants to explain a file nobody is
   * reviewing has nowhere to put the card until the file is listed. This is the same admission the
   * reader's own "add this path" performs (`add-path`), reached by the agent instead of by hand: both
   * sides of the entry are the file's own text — the "no pending diff" shape a scanned-clean file
   * already lands with — so the file opens at its own content and the card sits on the lines it names.
   *
   * It is deliberately that ROUTE and not a raw insert: a path already listed is answered from the list
   * (so annotating twice never re-baselines a review in progress), a path outside the workspace is
   * refused here rather than confined later, and what lands goes through the same fold + persist + undo
   * bookkeeping as every other admission.
   *
   * @param sessionId - the session whose list gains the file.
   * @param asked - the path the agent named, workspace-relative or absolute.
   * @param signal - the caller's lifetime, for the read.
   * @returns the listed entry (and whether this call is what listed it), or why it could not be listed.
   */
  async function listFileForAnnotation(
    sessionId: SessionId,
    asked: string,
    signal: AbortSignal | undefined,
  ): Promise<ListFileOutcome> {
    await ensureLoaded()
    const workspace = workspaceOf(sessionId)
    if (workspace === undefined) return { kind: 'no-workspace' }
    const absolute = resolveInsideWorkspace(workspace.path, asked)
    if (absolute === undefined) return { kind: 'outside' }
    const listed = store.list(sessionId).find(entry => pathIdentity(entry.path) === pathIdentity(absolute))
    if (listed !== undefined) return { kind: 'listed', entry: listed, added: false }
    const content = await readTextOrNone(absolute, signal ?? new AbortController().signal)
    if (content === undefined) return { kind: 'missing' }
    const now = Date.now()
    await foldBatch(sessionId, [{
      id: absolute,
      sessionId,
      path: absolute,
      earlierVersion: 'file',
      oldText: content,
      newText: content,
      updatedAt: now,
      sessionIds: [sessionId],
      // The AGENT put this file in the list (to hang a comment on it) while the reader was elsewhere: the
      // row is news. The reader's own add-path goes through `add-path` instead and lights nothing.
      unseen: true,
    }], true)
    // The fold above awaited its write: by the time this returns, the entry that the caller is about to
    // hang a comment on is readable at the next boot (see `foldBatch` and `persistSession`).
    const landed = store.list(sessionId).find(entry => pathIdentity(entry.path) === pathIdentity(absolute))
    // `undefined` here means the insert did NOT apply — the store already held an identical entry for this
    // path, and that entry is another session's row, so this session's list still does not show the file.
    // The answer stays "not listed" rather than claiming an add that did not happen: the tool refuses
    // (see `unlistedText`) and writes no card, which is the safe half of this seam — a comment is only
    // ever hung on an entry this session's list actually carries.
    return landed === undefined ? { kind: 'missing' } : { kind: 'listed', entry: landed, added: true }
  }

  /**
   * Drop one entry from its session's list, ALONG WITH THE COMMENTS it carries.
   *
   * The comments go in the same tick as the entry — rather than being swept on some later read —
   * because a second client polling in between must never be handed a comment naming a file the same
   * read no longer lists. Synchronous: the comment store applies changes to memory as it goes and
   * persists on its own chain.
   *
   * This call is the DESTRUCTION the undo pair of every dropping action has to be able to reverse, so
   * each of those actions snapshots the entry's comments into its `before` side first (see
   * `droppingComments`). The panel still asks before a press that drops an entry carrying comments
   * (see the `remove-one` / `remove-*` prompts): undo covers the paths that have a pair, and the ask
   * covers the reader's intent either way.
   * @param id - the entry id (= path) leaving the list.
   * @returns whether the entry was there.
   */
  function dropEntry(id: string): boolean {
    const removed = store.remove(id)
    comments.removeForEntry(id)
    // …and the lines those comments resolved to, which are about content this path no longer lists.
    forgetCommentLinesForEntry(id)
    // The live-file observation goes with the entry: it exists to answer for a TRACKED path, and keeping it
    // would let a path re-tracked much later (with a token that happens to match) be answered from a read
    // taken before it left.
    liveObservations.delete(id)
    return removed
  }

  /** Pre-write bases captured at the intent seams, keyed by the tool call id. */
  const editorIntents = new Map<string, IntentBasis>()

  /**
   * Snapshot one str_replace_editor mutation's basis at its intent seam. A file
   * creation has no earlier version, so its basis is empty; an edit reads the
   * pre-write content. Any failure tracks nothing — the settle-side pairing then
   * sees no basis.
   * @param target - the resolved target about to be written.
   * @param actor - the tool execution running the mutation.
   * @param earlierVersion - whether the mutation creates the file (`'none'`: no earlier version) or edits it (`'file'`).
   */
  async function stashEditorIntent(target: FsTarget, actor: object | undefined, earlierVersion: PendingEntryKind): Promise<void> {
    const shaped = actorOf(actor)
    if (shaped === undefined || shaped.name !== 'str_replace_editor') return
    if (typeof shaped.callId !== 'string') return
    const sessionId = sessionOfAgent(shaped.agent)
    if (sessionId === undefined) return
    if (earlierVersion === 'none') {
      editorIntents.set(shaped.callId, { target, earlierVersion, before: '', sessionId })
      return
    }
    try {
      const before = await ctx.fs.readText(target, undefined) ?? ''
      editorIntents.set(shaped.callId, { target, earlierVersion, before, sessionId })
    } catch {
      // Unreadable at intent time: no trustworthy basis to revert to.
    }
  }

  /**
   * Fold one str_replace_editor mutation into its file's entry. The tool's
   * result carries only a success message, so the settle reads the post-write
   * content and pairs it with the basis snapshotted at the intent seam.
   * @param exec - the settled str_replace_editor execution.
   * @param result - its outcome.
   */
  async function captureEditorMutation(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    const basis = editorIntents.get(exec.callId)
    editorIntents.delete(exec.callId)
    if (basis === undefined || basis.sessionId === undefined || result.isError) return
    const argumentsValue = exec.arguments
    const command = typeof argumentsValue === 'object' && argumentsValue !== null
      ? (argumentsValue as Record<string, unknown>).command : undefined
    const mutates = basis.earlierVersion === 'none'
      ? command === 'create'
      : command === 'str_replace' || command === 'insert'
    if (!mutates) return
    let after: string
    try {
      after = await ctx.fs.readText(basis.target, undefined) ?? ''
    } catch {
      return
    }
    if (basis.earlierVersion === 'file' && after === basis.before) return
    const sessionId = basis.sessionId
    const path = basis.target.displayPath
    const entry: PendingEntry = {
      id: path,
      sessionId,
      path,
      earlierVersion: basis.earlierVersion,
      oldText: basis.before,
      newText: after,
      updatedAt: Date.now(),
      sessionIds: [sessionId],
      // Where this session sits in its lineage, for the merged view — read here, where the mutation is
      // captured, and off the execution that carried it (see `lineageOf`).
      lineage: lineageOf(sessionId, exec.agent),
      // An agent changed the file: the reader has not seen this yet, so its row wears the dot.
      unseen: true,
    }
    await ensureLoaded()
    if (store.fold(entry)) persistSession()
  }

  /** One observation of a tracked path's live file. Existence is decided solely
   * by `stat` (`undefined` means the target is absent); a present-but-unreadable
   * file is `unavailable` so the panel can disable its operations. */
  type LiveFileState =
    | { kind: 'present'; content: string }
    | { kind: 'deleted' }
    | { kind: 'unavailable' }

  /** What one `stat` said about a tracked path, and nothing read from it (see `probePath`). */
  type PathProbe =
    | { kind: 'present'; target: FsTarget; version: string | undefined; size: number | undefined }
    | { kind: 'deleted' }
    | { kind: 'unavailable' }

  /**
   * What was last READ from one tracked path, and the freshness token that read was taken at.
   *
   * `ctx.fs.stat` returns no `mtimeMs` (see `FsStat`): its freshness signal is `version`, an opaque token
   * the backend documents as "the freshness token a write/edit guards against" and derives from the file's
   * identity and times — the local backend builds it as `dev:ino:size:mtimeNs:ctimeNs`, so it moves when
   * the size or either timestamp does, which is exactly the `mtimeMs`+`size` signal wanted here. `size` is
   * carried beside it as a second, plain-text field.
   *
   * In memory only, one entry per tracked path: a restart has read nothing, so it observes afresh.
   */
  const liveObservations = new Map<string, { version: string; size: number; content: string }>()

  /** The stable `FsError.code`, when the thrown value carries one. */
  function fsErrorCodeOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }

  /**
   * Ask the backend where one tracked path is and what it is, reading NOTHING.
   *
   * This is the whole liveness test, shared by the full read (`liveStateOf`) and the light count
   * (`list-count`): `resolve` + `stat`, with `undefined` from `stat` meaning the target is absent, and a
   * thrown `FS_NOT_FOUND` meaning the same one step earlier. `version`/`size` come back as `undefined` when
   * the backend does not report them, which is what tells `liveStateOf` it has no freshness evidence.
   * @param path - backend display path to probe through `ctx.fs`.
   * @returns what the backend says, and the target a caller may then read.
   */
  async function probePath(path: string): Promise<PathProbe> {
    let target
    try {
      target = await ctx.fs.resolve(path, {})
    } catch (error) {
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
    let info
    try {
      info = await ctx.fs.stat(target, undefined)
    } catch (error) {
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
    if (info === undefined) return { kind: 'deleted' }
    return {
      kind: 'present',
      target,
      version: typeof info.version === 'string' && info.version.length > 0 ? info.version : undefined,
      size: typeof info.size === 'number' ? info.size : undefined,
    }
  }

  /**
   * Read one path's live state. The only existence test is `stat`: it returns
   * `undefined` for an absent target (gone), so a deleted file never falls into
   * the unreadable bucket. A file that exists but cannot be read is `unavailable`.
   *
   * The CONTENT is not re-read when the backend's own freshness evidence says the file has not moved since
   * the last observation: an identical `version` AND an identical numeric `size`, both reported. The stat
   * still runs — it is the cheap half, and it is what notices a file that has gone — so a deleted file is
   * still `deleted`, a moved one is read again, and `diverged`/`missing` are computed from real content
   * either way. The skip needs BOTH fields: a stat that reports no size is a weaker observation than the
   * contract allows, so it falls back to reading rather than trusting a token alone.
   * @param path - backend display path to probe through `ctx.fs`.
   * @returns the live state.
   */
  async function liveStateOf(path: string): Promise<LiveFileState> {
    const probe = await probePath(path)
    if (probe.kind !== 'present') {
      // No content to remember for a path that is gone or unreadable, so a re-created file is read again.
      liveObservations.delete(path)
      return probe
    }
    const { target, version, size } = probe
    const trustable = version !== undefined && size !== undefined
    if (trustable) {
      const observed = liveObservations.get(path)
      if (observed !== undefined && observed.version === version && observed.size === size) {
        return { kind: 'present', content: observed.content }
      }
    }
    try {
      const content = await ctx.fs.readText(target, undefined)
      if (trustable) liveObservations.set(path, { version, size, content })
      return { kind: 'present', content }
    } catch (error) {
      liveObservations.delete(path)
      return fsErrorCodeOf(error) === 'FS_NOT_FOUND' ? { kind: 'deleted' } : { kind: 'unavailable' }
    }
  }

  /**
   * Attach the live file state to each listed entry. Reading runs once per
   * path (the panel polls once a second and the review set stays small).
   * @param entries - the store's entries for one session.
   * @returns entries with `missing` and `diverged` set from the live file.
   */
  /** Drop every undo/redo pair that belongs to a removed file, so the LIFO
   * queue stays traversable without ever trying to restore an unreadable file. */
  function purgeForEntry(path: string): void {
    const clean = (stack: DiffApprovalUndoPair[]): void => {
      const kept = stack.filter(pair => {
        const batch = pair.before.batch ?? pair.after.batch
        if (batch !== undefined) return !batch.some(item => item.path === path)
        return pair.before.path !== path && pair.after.path !== path
      })
      stack.length = 0
      stack.push(...kept)
    }
    for (const stack of undoStacks.values()) clean(stack)
    for (const stack of redoStacks.values()) clean(stack)
  }

  /**
   * Settle each listed entry against its live file. Existence is decided by the
   * live state alone: a deleted file leaves the list as an undoable checkpoint
   * (Ctrl+Z recreates it and restores the entry), an unavailable one leaves the
   * list and has its undo/redo records dropped, and externally changed content
   * is adopted as the new baseline with its own checkpoint.
   * @param sessionId - the session being listed (its session-scoped view).
   * @param view - the request's lineage view: the caller builds it once and hands it here, because the
   *   list read needs the same view for the comment scope, the answer fold and the undo keys, and a
   *   second `lineageView()` would walk the store again for nothing.
   * @param entries - that request's ONE `store.all()` snapshot (see `lineageView`).
   * @returns the listed entries plus whether an external change cleared redo.
   */
  async function listWithState(
    sessionId: SessionId,
    view: LineageView,
    entries: readonly PendingEntry[],
  ): Promise<{ files: PendingFileDiff[]; redoCleared: boolean }> {
    const listed: PendingFileDiff[] = []
    let redoCleared = false
    for (const entry of entries) {
      if (!view.sees(sessionId, entry)) continue
      // The undo pair a READ produces belongs to the session that read — whoever pressed — and that same
      // session is the policy its restore replays (see `DiffApprovalUndoPair.policySession`).
      const live = await liveStateOf(entry.path)
      if (live.kind === 'deleted') {
        // The file is gone: remove it from the list, keeping an undoable
        // checkpoint that recreates the file (its tracked content) and restores
        // the entry to the list. The comments the file carried ride the checkpoint's `before` side, so
        // this checkpoint means the same thing as a button's drop: one Ctrl+Z gives back the file, the
        // row and the threads written on it. It is snapshotted BEFORE the drop, which is what that call
        // is about to take away.
        const checkpoint = droppingComments({ id: entry.path, path: entry.path, entry, fileText: entry.newText })
        dropEntry(entry.path)
        pushUndo(sessionId, checkpoint,
          { id: entry.path, path: entry.path, entry: undefined, fileText: undefined }, view)
        persistSession()
        continue
      }
      if (live.kind === 'unavailable') {
        // Present but unreadable: no operation is safe, so drop the entry and
        // purge its undo/redo records so the LIFO queue stays traversable.
        dropEntry(entry.path)
        purgeForEntry(entry.path)
        persistSession()
        continue
      }
      // Present. A file changed outside the tracked operations (another tool,
      // an editor, a second process) is adopted as the new baseline so the
      // panel tracks the file as it is now; the entry keeps its pre-change
      // `oldText`, and the adoption itself is a fresh undo checkpoint.
      const content = live.content as string | undefined
      let adopted = entry.newText
      const hasContent = typeof content === 'string'
      if (hasContent && content !== entry.newText) {
        adopted = content
        const beforeText = entry.newText
        const redoWasPresent = redoStackOf(sessionId).length > 0
        store.update(entry.path, { newText: content })
        // The file moved without the reader asking (another tool, an editor, a second process): the row is
        // news again, and `update` — which is the reader acting — had just taken the dot down.
        store.markUnseen(entry.path)
        pushUndo(sessionId,
          { id: entry.path, path: entry.path, entry, fileText: beforeText },
          { id: entry.path, path: entry.path, entry: { ...entry, newText: content, updatedAt: Date.now() }, fileText: content },
          view)
        persistSession()
        if (redoWasPresent) redoCleared = true
      }
      const state = { missing: false, diverged: hasContent ? content !== adopted : true }
      // The one thing the client cannot work out for itself: that this row is in the listing session's view
      // through the MERGE rather than because the session touched it (see `PendingFileDiff.viaLineage`).
      // Absent — never `false` — for a row the session did touch, so an older client reads it as it always
      // did, and the wire stays tolerant of a host that does not know the field at all.
      const viaLineage = ownersOf(entry).includes(sessionId) ? undefined : true
      // A DIFFERENT question, and deliberately a different field (see `PendingFileDiff.hasChildContribution`):
      // whether an owner other than the requester sits inside the requester's lineage, so a row the requester
      // touched AS WELL still says a child's change shares it. It asks the view's own ROOT walk (`sameRoot`)
      // and NOT the workspace term the merge adds: this is a claim about who wrote the row, which a child in
      // another workspace really did, so answering it with the visibility rule would make the copy lie. A
      // session OUTSIDE that lineage never counts: entries are keyed by path globally, and calling an
      // unrelated session's touch a child's contribution would make the copy lie.
      const hasChildContribution = ownersOf(entry)
        .some(owner => owner !== sessionId && view.sameRoot(owner, sessionId))
      // …and WHICH WAY that other contributor stands, so the marker's sentence is true from THIS seat
      // (see `LineageDirection`): the same row is a child's change in its parent's panel and a parent's
      // change in its child's, and two teammates' rows are a sibling's. Absent when nothing but the
      // requester touched the row, which is exactly when there is no mark to word.
      const lineageDirection = view.directionOf(sessionId, entry)
      listed.push({ ...entry, newText: adopted, ...state, viaLineage, hasChildContribution, lineageDirection })
    }
    return { files: listed, redoCleared }
  }

  /**
   * Fold a batch of entries into one session's list as a single undoable action.
   * Nothing touches the files, so the batch is undone by restoring each affected
   * path's pre-fold entry (or removing it when the path was not listed), which is
   * what the import and the hand-add path both want.
   * @param sessionId - the session whose list gains the entries.
   * @param entries - the entries to fold, in capture order.
   * @param admitNoDiff - also admit entries that carry no diff at all (the
   *        guard-free insert), which is how a hand-added clean path is listed.
   * @returns how many entries landed; 0 leaves the store, persistence, and the
   *          undo queue untouched.
   */
  async function foldBatch(sessionId: SessionId, entries: readonly PendingEntry[], admitNoDiff = false): Promise<number> {
    await ensureLoaded()
    const before = new Map(store.list(sessionId).map(entry => [entry.path, entry]))
    let folded = 0
    const changedPaths: string[] = []
    for (const entry of entries) {
      const applied = entry.oldText === entry.newText
        ? admitNoDiff && store.insert(entry)
        : store.fold(entry)
      if (applied) {
        folded += 1
        changedPaths.push(entry.path)
      }
    }
    if (folded === 0) return 0
    // AWAITED on purpose. The entries are in memory now, and the caller (the annotate tool's add) is
    // about to write a comment NAMING one of them: letting the tool answer before this write has landed
    // is what let a restart leave the comment on disk and its entry not, after which the load-time sweep
    // hid the comment (see `CommentStore.retain`). The fold's own bookkeeping is synchronous; only the
    // durability waits here. `persistSession` never rejects — a write that fails is logged, not thrown —
    // so an unwritable directory cannot turn an accepted fold into a failed tool call.
    await persistSession(true)
    const after = new Map(store.list(sessionId).map(entry => [entry.path, entry]))
    const batchBefore: DiffApprovalUndoState[] = []
    const batchAfter: DiffApprovalUndoState[] = []
    for (const path of changedPaths) {
      const final = after.get(path)
      if (final === undefined) continue
      const pre = before.get(path)
      batchAfter.push({ id: final.id, path, entry: final, fileText: undefined })
      batchBefore.push({ id: final.id, path, entry: pre, fileText: undefined })
    }
    if (batchBefore.length > 0) {
      pushBatchUndo(sessionId, batchBefore, batchAfter)
    }
    return folded
  }

  /**
   * One path's text, or `undefined` when it is absent or not readable as text
   * (a binary, an unreadable permission). An empty file reads as `''`, which is
   * a value: a listed entry may carry no content at all.
   * @param absolute - the path to read.
   * @param signal - caller lifetime.
   * @returns the text, or undefined.
   */
  async function readTextOrNone(absolute: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await ctx.fs.readText(await ctx.fs.resolve(absolute, { signal }), signal)
    } catch {
      return undefined
    }
  }

  /**
   * Every regular file under one directory, with its text. Breadth-first in the
   * backend's name order, hiding the browse's noise names, skipping whatever is
   * not readable as text, and stopping at {@link ADD_UNCHANGED_CAP} files so
   * "include paths with no change" cannot read an unbounded tree in one call.
   * Symlinked directories are followed once, so a cycle ends rather than loops.
   * @param root - the resolved directory target to walk.
   * @param rootAbsolute - that directory's absolute path.
   * @param signal - caller lifetime.
   * @returns the files found and whether the cap cut the walk short.
   */
  async function collectFilesUnder(
    root: FsTarget,
    rootAbsolute: string,
    signal: AbortSignal,
  ): Promise<{ files: { path: string; content: string | undefined }[]; truncated: boolean }> {
    const files: { path: string; content: string | undefined }[] = []
    const visited = new Set<string>()
    // A backend always names its targets, but the guard must not treat two
    // unnamed ones as the same directory.
    if (typeof root.targetKey === 'string' && root.targetKey !== '') visited.add(root.targetKey)
    const queue: { absolute: string; target: FsTarget }[] = [{ absolute: rootAbsolute, target: root }]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      let children
      try {
        children = await ctx.fs.listDir(current.target, signal)
      } catch {
        // An unreadable subdirectory is skipped, not fatal to the whole add.
        continue
      }
      for (const child of children) {
        if (BROWSE_HIDDEN_NAMES.has(child.name)) continue
        const absolute = resolve(current.absolute, child.name)
        if (child.type === 'directory') {
          const key = child.target.targetKey
          if (typeof key === 'string' && key !== '') {
            if (visited.has(key)) continue
            visited.add(key)
          }
          queue.push({ absolute, target: child.target })
          continue
        }
        if (child.type !== 'file') continue
        if (files.length >= ADD_UNCHANGED_CAP) return { files, truncated: true }
        files.push({ path: absolute, content: await readTextOrNone(absolute, signal) })
      }
    }
    return { files, truncated: false }
  }

  /**
   * The workspace whose session account holds `sessionId`. Web sessions are
   * attached to a workspace at creation, so an unowned session is the
   * memory-only edge (its entries never persist).
   * @param sessionId - the session to locate.
   * @returns the owning workspace, or `undefined` when none accounts it.
   */
  function workspaceOf(sessionId: SessionId): Workspace | undefined {
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (workspace.sessionIds.includes(sessionId)) return workspace
    }
    return undefined
  }

  /**
   * The identity one session's workspace is compared by, or `undefined` when this
   * deployment does not account the session.
   *
   * The merged view needs it because the pending list is NOT scoped by workspace: the store is one map
   * keyed by absolute path (`pending.ts`) persisted to one `pending.json` under the storage root
   * (`persist.ts`), and that root comes from the plugin's `storageDir` alone — the `workspaces/`
   * component of the default path is the LEGACY per-workspace layout whose files are folded in and
   * deleted on load. Nothing else in the list path consults the workspace, so a row recorded by a
   * session in another one would otherwise be listed under this session's view.
   *
   * `resolve` folds separators and `.`/`..`; Windows additionally compares case-insensitively, the same
   * way `withinSandboxRoot` and the backend's own containment do (`C:\Repo` and `c:\repo` are one
   * directory there). An ABSENT workspace, or one the registry records with no path, answers
   * `undefined` — "not known", never a guess: the caller keeps the pre-workspace behaviour for it
   * rather than refusing a row it cannot show to be elsewhere.
   * @param sessionId - the session whose workspace is wanted.
   * @returns the comparison key, or `undefined` when it is not known.
   */
  function workspaceKeyOf(sessionId: SessionId): string | undefined {
    const path = workspaceOf(sessionId)?.path
    if (typeof path !== 'string' || path.length === 0) return undefined
    const resolved = resolve(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * Whether two workspaces, already reduced to comparison keys by {@link workspaceKeyOf}, are the same
   * one as far as this deployment can say.
   *
   * TRUE when either side is unknown, which is the whole point: an unknown workspace must not turn into
   * a refusal. The pending list is not scoped by workspace (see `workspaceKeyOf`), so a session the
   * registry does not account — a memory-only session, a row from a host that named no workspace, a
   * deployment whose registry the plugin cannot read — would otherwise lose rows it has always shown.
   * The check is for the case this code can actually see: two KNOWN roots that differ.
   * @param left - one session's key, or `undefined` when unknown.
   * @param right - the other's.
   * @returns whether they can be shown to share a workspace.
   */
  function sameWorkspaceKey(left: string | undefined, right: string | undefined): boolean {
    return left === undefined || right === undefined || left === right
  }

  /**
   * Resolve the file-sandbox policy for one session's Revert write, or
   * undefined when no confining backend is mounted. A live session carries
   * its workspace root through `ctx.sessions`; a persisted entry from a
   * session not live in this process falls back to the session's workspace
   * path (else the deployment default). Without this the sandbox fences the
   * write against the process cwd and denies it with "file access denied
   * under workspace-write mode".
   */
  function sandboxPolicyOf(sessionId: SessionId): SandboxExecutionPolicyLike | undefined {
    const policy = ctx.get('sandboxPolicy') as
      | { resolve(request?: { session?: Session }): SandboxExecutionPolicyLike; defaultMode: SandboxExecutionPolicyLike['mode'] }
      | undefined
    if (policy === undefined) return undefined
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) return policy.resolve({ session })
    const workspace = workspaceOf(sessionId)
    return workspace === undefined
      ? policy.resolve({})
      : { mode: policy.defaultMode, workspaceRoot: workspace.path }
  }

  /**
   * The session header entry lineage is read from.
   *
   * Two routes, in the order a capture can answer them. The live one is the tool execution's own agent:
   * `Agent` is AUGMENTED at run time with `session` (dsh-agent's `runtime-types`), and the DSH's own
   * bundled plugins read exactly that on a `tools/*` execution — `dsh-tool-present` uses
   * `exec.agent.session.header.cwd` and `dsh-experimental-agent-team` reads
   * `agent.session.header.parentSession` for precisely the lineage question this records. `Agent` is typed
   * `{ id }` in the types this package compiles against (the augmentation is not among them), so the field
   * is read structurally — the same way `sessionOfAgent` reads `id` off the same object.
   *
   * The fallback is this plugin's own session registry, which `sandboxPolicyOf` already consults
   * (`ctx.sessions.get(id)`); it is what answers when the agent carries no `session`, and it is also the
   * only route at a capture site that has no execution in hand (the editor-intent seam, version control,
   * a hand-added path). It is read through `ctx.get`, the way this file reads every optional service
   * (`sandboxPolicy`, `shell`): the capture must never fail because the lineage could not be asked for,
   * and a context that was never handed a session service throws on the plain property instead.
   * @param sessionId - the session whose header is wanted.
   * @param agent - the live agent of a tool execution, when the caller has one.
   * @returns the header, or `undefined` when neither route has one.
   */
  function headerOf(sessionId: SessionId, agent?: unknown): SessionHeader | undefined {
    if (typeof agent === 'object' && agent !== null) {
      const session = (agent as Record<string, unknown>).session
      if (typeof session === 'object' && session !== null) {
        const header = (session as Record<string, unknown>).header
        if (typeof header === 'object' && header !== null) return header as SessionHeader
      }
    }
    const sessions = sessionRegistry()
    return sessions?.get(sessionId)?.header
  }

  /**
   * The lineage one entry records for its session, read off that session's own header.
   *
   * Every part is taken on its own and only when it is there, and NO lineage is recorded when the header
   * held none of it. Absence is the honest value: an ordinary root session has no parent by design, and a
   * host older than these header fields reports none of them — while a merged view has to be able to tell
   * "this session is a root" from "this host could not say", and guessing a root would file a session
   * under the wrong one.
   * @param sessionId - the session the entry belongs to.
   * @param agent - the live agent, when the capture has one (see `headerOf`).
   * @returns the lineage to store, or `undefined` when the header named none of it.
   */
  function lineageOf(sessionId: SessionId, agent?: unknown): SessionLineage | undefined {
    const header = headerOf(sessionId, agent)
    if (header === undefined) return undefined
    const parent = header.parentSession
    const depth = header.delegationDepth
    const lineage: SessionLineage = {
      parentSessionId: typeof parent === 'string' && parent.length > 0 ? SessionId(parent) : undefined,
      origin: typeof header.origin === 'string' && header.origin.length > 0 ? header.origin : undefined,
      delegationDepth: typeof depth === 'number' && Number.isFinite(depth) ? depth : undefined,
      cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined,
    }
    const known = lineage.parentSessionId !== undefined || lineage.origin !== undefined
      || lineage.delegationDepth !== undefined || lineage.cwd !== undefined
    return known ? lineage : undefined
  }

  /** The session registry, read the way this file reads every optional service (see `headerOf`). */
  function sessionRegistry(): { get(id: SessionId): Session | undefined } | undefined {
    return ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
  }

  /** The most lineage hops one walk will take: a bound, not a depth anyone should reach. */
  const MAX_LINEAGE_DEPTH = 16

  /** Every session that touched an entry (its own fallback, the way the store reads an old row).
   *
   *  PROVENANCE, and the merge's basis: it is who WROTE the row, which is what the row's mark and its
   *  `viaLineage` flag are made of. It is deliberately NOT the write policy any more — an action's write
   *  runs under the REQUESTING session (see `DiffApprovalUndoPair.policySession` and the
   *  `revertEntryContent` call sites), so nothing here decides who may write.
   */
  function ownersOf(entry: PendingEntry): SessionId[] {
    return Array.isArray(entry.sessionIds) && entry.sessionIds.length > 0 ? entry.sessionIds : [entry.sessionId]
  }

  /**
   * What one session is known by when a lineage is walked: the lineage STEP 1 recorded for it, and
   * otherwise the live header.
   *
   * Recorded first is deliberate: it is what the row itself says, it survives a session that is no longer
   * live, and it is the same answer the entry carries — so the walk and the row cannot disagree. The
   * registry is the fallback for a session that recorded nothing (a row written before this step, or a
   * session whose entries have all been settled away).
   *
   * `subagent` is the only field the walk trusts for a LINK: `parentSession` alone is not one. The header
   * documents it as "the session this one was forked from (seed lineage)", so a host fork or a seeded
   * continuation carries it while being an INDEPENDENT ROOT — the Team package reads exactly that
   * distinction (`dsh-experimental-agent-team/lib/types/roster.js:76-81`: "Ordinary host forks are
   * independent roots"). `origin: 'subagent'` is the header's own marker for a session "created as a
   * subagent child", and the one function that builds a child's meta sets it together with `parentSession`
   * and `delegationDepth` (`dsh-subagent/lib/types/child-agent.js:111-125`).
   * @param sessionId - the session being asked about.
   * @param recorded - the lineages step 1 recorded, read once per request.
   * @returns whether the session is a subagent child, and the parent it names when it is.
   */
  function knownLineageOf(
    sessionId: SessionId,
    recorded: ReadonlyMap<SessionId, SessionLineage>,
  ): { parent: SessionId | undefined; subagent: boolean } {
    const entry = recorded.get(sessionId)
    if (entry !== undefined) return { parent: entry.parentSessionId, subagent: entry.origin === 'subagent' }
    const header = sessionRegistry()?.get(sessionId)?.header
    const parent = header?.parentSession
    return {
      parent: typeof parent === 'string' && parent.length > 0 ? SessionId(parent) : undefined,
      subagent: header?.origin === 'subagent',
    }
  }

  /**
   * The lineage view one request is answered from — which sessions' entries the requester may SEE, and
   * therefore act on.
   *
   * The rule is ROOT-EQUAL **AND SAME-WORKSPACE**: an entry is visible when any session that touched it
   * walks to the same lineage root as the requester AND can be shown to sit in the requester's workspace.
   * Walking is `knownLineageOf` links only, so a teammate's rows appear in the lead's list (both walk to
   * the lead) and the lead's appear in the teammate's — while a host fork, which names a parent but is not
   * a subagent child, stays an independent root and shares nothing.
   *
   * The workspace half is not redundant with the lineage half, because NOTHING ELSE IN THE LIST PATH
   * SCOPES BY WORKSPACE: the store is one map keyed by absolute path persisted to one `pending.json` under
   * the storage root (`pending.ts`, `persist.ts` — the `workspaces/` component of the default path is the
   * legacy per-workspace layout, folded in and deleted on load). So without this a row recorded by a
   * session in ANOTHER workspace would be listed here whenever the two share a lineage root — which is a
   * real shape: this view merges every subagent child (see the KNOWN LIMIT below), and the harness's
   * out-of-process shape lets a child run under a configured `cwd` of its own, its cwd being documented as
   * the child's "workspace identity" (`dsh-subagent/lib/types/out-of-process.js`:
   * `resolveChildCwd`/`assertUsableCwd`). An in-process child copies its parent's cwd verbatim
   * (`…/child-agent.js:childSessionMeta`), so the two agree there; this rule is what makes the plugin's
   * answer independent of which of those two shapes it is handed.
   *
   * A session the registry does not account is NOT refused: `sameWorkspace` answers true when either
   * side's workspace is unknown, so an unaccounted or memory-only session keeps exactly the view it had
   * before this term existed. UNKNOWN DEGRADES TO SELF on the lineage half and TO THE OLD ANSWER here —
   * never to a guess, and never to a refusal the reader cannot see the reason for.
   *
   * UNKNOWN DEGRADES TO SELF, never to a guess: with no recorded lineage and no header facts every
   * session is its own root, so only the requester matches — byte-for-byte today's behaviour. A cycle
   * (which no shell should produce) stops at the first repeat, and the walk is bounded by
   * {@link MAX_LINEAGE_DEPTH}.
   *
   * TWO THINGS A MERGED VIEW DOES NOT MERGE, so the next reader does not expect them:
   * comments stay per-session (`comments` is read with the requester's id, so a merged list shows the
   * requester's threads only), and undo stacks stay per-lineage — every ACTION records its pair under the
   * canonical session of the seat that PRESSED it, so the seats of one lineage share one history and a
   * different lineage cannot reach into it (`undoStackOf`/`popOwnPair` are keyed by that root). The
   * session-scoped thing a merged press does NOT take from the ROW is the write policy: an action's file
   * write runs under the REQUESTING session's own workspace and sandbox (see
   * `DiffApprovalUndoPair.policySession`), never the owner's.
   *
   * THE MARK (`hasChildContribution`) IS A DIFFERENT QUESTION and keeps asking only the lineage half: it
   * claims an owner other than the requester WROTE part of the row, which a child in another workspace
   * really did. Adding the workspace term there would make that copy lie, so it deliberately does not ask
   * it (see `sameRoot` below).
   *
   * KNOWN LIMIT: a teammate child cannot be told from ANY OTHER subagent child by its header. Both are
   * built by the one `childSessionMeta` above, and the Team spawner adds nothing to the child — it passes
   * only `childId`/`provider`/`label` into `ctx.subagents.startContinuable`
   * (`dsh-experimental-agent-team/lib/types/roster.js:253-262`) and records membership in the LEAD's own
   * journal (`:249`), which this plugin cannot read. So this view merges every subagent child, not only
   * teammates; narrowing it to the roster would need a service the plugin does not inject.
   * @param entries - the store's entries, when the caller already took ONE snapshot for the whole request
   *   (`store.all()` rebuilds and re-sorts the array, so a read takes it once and hands it down). Defaults
   *   to a fresh snapshot for the callers that only need the walk.
   * @returns the view: `sees` answers the visibility question for one entry, `sameRoot` answers whether two
   * sessions share a lineage root (the question the row's mark asks about its other owners), `directionOf`
   * says WHICH WAY that other owner stands for the sentence the mark wears, and `rootOf` is the CANONICAL
   * session — the lineage root, or the session itself when its lineage is unknown — that every
   * session-scoped store is keyed by (see `canonicalOf`).
   */
  function lineageView(entries: readonly PendingEntry[] = store.all()): {
    sees: (sessionId: SessionId, entry: PendingEntry) => boolean
    sameRoot: (a: SessionId, b: SessionId) => boolean
    directionOf: (sessionId: SessionId, entry: PendingEntry) => LineageDirection | undefined
    rootOf: (sessionId: SessionId) => SessionId
  } {
    const recorded = new Map<SessionId, SessionLineage>()
    for (const entry of entries) {
      if (entry.lineage !== undefined && !recorded.has(entry.sessionId)) recorded.set(entry.sessionId, entry.lineage)
    }
    const facts = new Map<SessionId, { parent: SessionId | undefined; subagent: boolean }>()
    /**
     * One session's UPWARD CHAIN: itself, then each recorded subagent parent above it, in order.
     *
     * This is the one walk the whole view is made of. `rootOf` is its last element, and the mark's
     * DIRECTION is a membership question over two of these chains — so the merge, the root and the
     * direction can never be computed from different links. The links are `knownLineageOf`'s, which reads
     * the lineage the entry RECORDED before it asks the live header (see that function), and only an
     * `origin: 'subagent'` link is followed: a host fork names a parent while being an independent root.
     *
     * Memoized per view like `roots` was, because the list read asks this per entry per owner on a path
     * every client repeats once a second. The walk stops at a repeat (`walked`) and at
     * {@link MAX_LINEAGE_DEPTH}, so a malformed cycle cannot hang it — the same two guards the root walk
     * has always had.
     */
    const chains = new Map<SessionId, readonly SessionId[]>()
    /**
     * Each session's workspace key, resolved once per view.
     *
     * Memoized for the same reason `chains` is: this runs inside `sees`, which the list read calls once per
     * entry per owner (`listWithState`), on a path every client repeats once a second — and the registry
     * lookup walks the deployment's workspace list. `has` rather than a truthy check so "known to be
     * unknown" is cached as such instead of being asked again for an unaccounted session.
     */
    const workspaceKeys = new Map<SessionId, string | undefined>()
    const workspaceKey = (sessionId: SessionId): string | undefined => {
      if (workspaceKeys.has(sessionId)) return workspaceKeys.get(sessionId)
      const key = workspaceKeyOf(sessionId)
      workspaceKeys.set(sessionId, key)
      return key
    }
    const chainOf = (sessionId: SessionId): readonly SessionId[] => {
      const known = chains.get(sessionId)
      if (known !== undefined) return known
      const chain: SessionId[] = [sessionId]
      const walked = new Set<SessionId>([sessionId])
      let current = sessionId
      for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
        let fact = facts.get(current)
        if (fact === undefined) {
          fact = knownLineageOf(current, recorded)
          facts.set(current, fact)
        }
        if (!fact.subagent || fact.parent === undefined || walked.has(fact.parent)) break
        walked.add(fact.parent)
        chain.push(fact.parent)
        current = fact.parent
      }
      chains.set(sessionId, chain)
      return chain
    }
    /** The top of one session's chain: the lineage root both `sees` and `sameRoot` compare. */
    const rootOf = (sessionId: SessionId): SessionId => {
      const chain = chainOf(sessionId)
      return chain[chain.length - 1]!
    }
    return {
      sees: (sessionId, entry) => {
        const root = rootOf(sessionId)
        const mine = workspaceKey(sessionId)
        return ownersOf(entry).some((owner) => {
          if (rootOf(owner) !== root) return false
          // A row the requester TOUCHED is its own, whatever the registry says about anyone else on it:
          // the store keys entries by absolute path, so the requester's own path is in its own workspace.
          if (owner === sessionId) return true
          return sameWorkspaceKey(workspaceKey(owner), mine)
        })
      },
      // The mark's question, and DELIBERATELY not the visibility question above: it asks whether another
      // owner walks to the same lineage root, which is a claim about who WROTE the row, not about whether
      // the row is in this view. A cross-workspace child that really did edit the path has really
      // contributed to it, and saying otherwise would make the copy lie — while the merge above is about
      // what the reader may see and act on, which is exactly where the workspace belongs. The two share
      // this one root walk (and `sameWorkspace` is the only addition to the other), so the sessions they
      // call "kin" cannot drift; the questions they answer are different on purpose.
      sameRoot: (a, b) => rootOf(a) === rootOf(b),
      // The CANONICAL session: the one session-scoped state is keyed by (see `canonicalOf`). Exposed off
      // the view rather than recomputed, so an endpoint that already walks a lineage for visibility does
      // not walk it a second time for the key.
      rootOf,
      /**
       * Which way the row's other contributors stand, for the marker's sentence.
       *
       * Read off the SAME recorded links `rootOf` walks, never guessed and never inferred from a name: an
       * owner is the requester's CHILD when the requester sits on that owner's upward chain, its PARENT
       * when that owner sits on the requester's chain, and a SIBLING when the two merely share a root.
       * `parent` therefore means ANCESTOR, however many hops up — which is exactly what the Chinese 上级
       * says and what the English copy is written to mean.
       *
       * Owners of DIFFERENT directions answer `mixed`: the row carries two different relationships and
       * picking one would state a fact about the row that is only true of part of it. The set is
       * unresolvable in the honest direction too — "another session" is true of every member — which is
       * why `mixed` is a real answer and not a failure. `undefined` when no other same-root owner
       * contributed, i.e. when there is no mark to word.
       *
       * The criterion is `hasChildContribution`'s exactly (non-requester, same root) — the workspace term
       * belongs to visibility, not to this claim (see `sameRoot`).
       * @param sessionId - the session listing the row.
       * @param entry - the row being listed.
       * @returns the direction, or `undefined` when nothing but the lister touched the row.
       */
      directionOf: (sessionId, entry): LineageDirection | undefined => {
        const root = rootOf(sessionId)
        const mine = chainOf(sessionId)
        const seen = new Set<LineageDirection>()
        for (const owner of ownersOf(entry)) {
          if (owner === sessionId) continue
          if (rootOf(owner) !== root) continue
          const theirs = chainOf(owner)
          // Child first, so a malformed pair of cycles that walk through each other still answers
          // deterministically rather than by iteration order.
          if (theirs.includes(sessionId)) seen.add('child')
          else if (mine.includes(owner)) seen.add('parent')
          else seen.add('sibling')
        }
        if (seen.size === 0) return undefined
        return seen.size === 1 ? [...seen][0] : 'mixed'
      },
    }
  }

  /** The lineage view one request is answered from (see `lineageView`). */
  type LineageView = ReturnType<typeof lineageView>

  /**
   * THE CANONICALIZATION SEAM: the one session-scoped state of a request belongs to.
   *
   * The lineage ROOT, because the seats of one lineage read one list — so the undo history they share and
   * the comment threads they read must be keyed by the lineage, not by whichever seat is looking. A
   * session whose lineage is unknown (no recorded link, no header facts) is its own root, which is
   * byte-for-byte the behaviour before any of this existed.
   *
   * Every session-scoped seam goes through this function, and the endpoints that already hold a view pass
   * it so the walk is done once per request (`view` is optional only so a push deep inside a helper cannot
   * forget to canonicalize; it never means "do not canonicalize").
   * @param sessionId - the session the request came from.
   * @param view - the request's lineage view, when the caller already built one.
   * @returns the canonical session: the lineage root, or `sessionId` itself when it has none.
   */
  function canonicalOf(sessionId: SessionId, view?: LineageView): SessionId {
    return (view ?? lineageView()).rootOf(sessionId)
  }

  /**
   * The comment scope of one request: which comment AUTHORS this lineage may read and act on.
   *
   * `sameRoot` is the view's own question, so the scope and the merge cannot disagree about who is kin —
   * and it is the same predicate for reading, removing, marking seen and asking, so no verb can widen or
   * narrow the lineage on its own.
   * @param sessionId - the session the request came from.
   * @param view - the request's lineage view.
   * @returns the predicate the comment store's `CommentScope` takes.
   */
  function commentScopeOf(sessionId: SessionId, view: LineageView): CommentScope {
    return author => view.sameRoot(author, sessionId)
  }

  /**
   * The entry one id names, when the requesting session may act on it; `undefined` otherwise.
   *
   * Every action path resolves its entry through this, so an id outside the requester's lineage is
   * answered exactly like an id that names nothing — `missing` — and no action can reach a row the
   * requester cannot see.
   * @param view - the request's lineage view.
   * @param sessionId - the requesting session.
   * @param id - the entry id (its path).
   * @returns the entry, or `undefined` when it is absent or outside the view.
   */
  function actionableEntryOf(
    view: { sees: (sessionId: SessionId, entry: PendingEntry) => boolean },
    sessionId: SessionId,
    id: string,
  ): PendingEntry | undefined {
    const entry = store.get(id)
    return entry !== undefined && view.sees(sessionId, entry) ? entry : undefined
  }

  /**
   * Write a Revert through `ctx.fs`, carrying the session's sandbox policy
   * only when a confining backend is mounted (so the plain 4-arg call shape is
   * preserved for the unsandboxed composition).
   * @param target - the resolved target to write.
   * @param content - the restored file content.
   * @param sessionId - the entry's session, for the per-session policy.
   * @param signal - aborts before atomic publication takes effect.
   * @returns the write outcome.
   */
  async function writeRevert(target: FsTarget, content: string, sessionId: SessionId, signal: AbortSignal): Promise<unknown> {
    const policy = sandboxPolicyOf(sessionId)
    return policy === undefined
      ? ctx.fs.writeText(target, content, undefined, signal)
      : ctx.fs.writeText(target, content, undefined, signal, policy)
  }

  /**
   * Delete one file as a Revert, under the same session sandbox policy the write
   * path carries.
   *
   * A Revert of a created file removes it, and a removal is a mutation like any
   * other: going through a raw `processPath` + `rm` bypassed the confinement
   * entirely, so a `workspace-write` session could delete a file the very same
   * policy would refuse to write. The mode is therefore checked here, against the
   * target's own path, and the backend that does confine is handed the policy as
   * well: the check is what a build with no confining backend still enforces, and
   * passing the policy through is what lets a confining one enforce its own,
   * stricter rules. The plain `rm` remains the last resort for a deployment whose
   * `ctx.fs` has no delete verb of its own.
   * @param target - the resolved target to delete.
   * @param sessionId - the session whose policy governs the delete.
   * @param signal - aborts before the delete is issued.
   */
  async function removeRevert(target: FsTarget, sessionId: SessionId, signal: AbortSignal): Promise<void> {
    const policy = sandboxPolicyOf(sessionId)
    const osPath = processPathOf(target)
    if (policy !== undefined && !withinSandboxRoot(osPath, policy)) {
      throw new Error(sandboxDenial(osPath, policy))
    }
    const fs = ctx.fs as unknown as { remove?: (target: FsTarget, policy: SandboxExecutionPolicyLike, signal: AbortSignal) => Promise<unknown> }
    if (policy !== undefined && typeof fs.remove === 'function') {
      await fs.remove(target, policy, signal)
      return
    }
    await rm(osPath, { force: true })
  }

  /** The OS path a resolved target names, as the confinement check reads it. */
  function processPathOf(target: FsTarget): string {
    return ctx.fs.processPath(target)
  }

  /**
   * Whether a path lies inside the policy's workspace root (or IS it). Paths are
   * compared case-insensitively on Windows for the same reason the backend's own
   * containment is: `C:\Repo` and `c:\repo` are one directory there.
   * @param path - the OS path the delete would touch.
   * @param policy - the session's resolved policy.
   * @returns true when the mode permits the delete at that path.
   */
  function withinSandboxRoot(path: string, policy: SandboxExecutionPolicyLike): boolean {
    if (policy.mode !== 'read-only' && policy.mode !== 'workspace-write') return true
    if (policy.mode === 'read-only') return false
    if (policy.workspaceRoot === '') return true
    const target = process.platform === 'win32' ? path.toLowerCase() : path
    const root = process.platform === 'win32' ? policy.workspaceRoot.toLowerCase() : policy.workspaceRoot
    if (target === root) return true
    const rel = relative(root, target)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /**
   * The sentence a confining policy uses when it refuses one path, wherever it is produced.
   *
   * ONE producer, so the check a delete performs, the preflight a restore runs and the message a reader is
   * handed can never describe the refusal differently.
   * @param path - the OS path the policy refused.
   * @param policy - the session's resolved policy.
   * @returns the refusal sentence.
   */
  function sandboxDenial(path: string, policy: SandboxExecutionPolicyLike): string {
    return `file access denied under ${policy.mode} mode: '${path}' is outside the sandbox workspace root '${policy.workspaceRoot}'`
  }

  /**
   * Whether a thrown write error is the session's own AUTHORITY refusing it, rather than the file being
   * gone, changed, or unreadable.
   *
   * Exactly two shapes qualify, and nothing else does: a confining backend raises `FS_SANDBOX_DENIED` (the
   * `FsErrorCode` the fs package owns for "the policy layer said no"), and this file's own containment
   * check in `removeRevert` raises a plain Error saying the path is outside the sandbox workspace root.
   * Everything else keeps its own answer: `FS_NOT_FOUND` is a missing file, the divergence guard's "changed
   * outside the review" is a diverged one, `FS_PERMISSION_DENIED` is the FILE SYSTEM refusing (a fact about
   * the file, not about this session's grant) and the rest are IO or aborted faults. The predicate is
   * deliberately this narrow: widening it is how a reader loses the difference between "I may not write
   * there" and "that file is gone".
   * @param error - the value a write path threw.
   * @returns whether the sandbox/policy refused the write.
   */
  function isPolicyRefusal(error: unknown): boolean {
    if (fsErrorCodeOf(error) === 'FS_SANDBOX_DENIED') return true
    return /outside the sandbox workspace root/i.test(errorMessage(error))
  }

  /**
   * The answer for a write the session's authority refused: a sentence that NAMES THE PATH and says, in
   * words, that this session may not write there, carrying the sandbox's own reason with it.
   *
   * Why TEXT and not a code: the RPC error vocabulary this channel answers in is closed and owned by the
   * vendor (`RpcErrorDetailsMap` in `@deepseek-ai/dsh-host-apiproxy` — `internal` is its catch-all, and a
   * new code needs a row in that table), so this package cannot mint a `permission` code of its own. The
   * reader still gets the sentence: the port folds a failed call into `Error(code: message)` and the
   * panel's failed-row notice prints that message verbatim, so the refusal arrives as words on the path the
   * panel already has for a failed action. A LOCALIZED route would need a client-side classifier over the
   * message plus new locale keys — a copy change across the host/client seam — for no difference the reader
   * can see, since every other message on this channel is host English too.
   * @param path - the file the refused write was about (the entry's own path).
   * @param error - what the write threw.
   * @returns the error branch to answer with.
   */
  function policyRefusal(path: string, error: unknown): RpcResult<unknown> {
    return rpcError(refusalText(path, error))
  }

  /** The refusal sentence itself, shared by every path that answers with one. */
  function refusalText(path: string, error: unknown): string {
    return `'${path}' is outside this session's write authority: the workspace this session may write does not cover it.`
      + ` The sandbox refused the write: ${errorMessage(error)}`
  }

  /** One file write a restore will make: the entry path, and the bytes its counterpart expects to find. */
  interface RestoreWrite {
    path: string
    /** What the OTHER side's snapshot says the file holds, or undefined when there is no divergence check. */
    expected: string | undefined
  }

  /** How far a restore got: the writes it completed, how many it had to make, and the file it was on. */
  interface RestoreProgress {
    written: number
    total: number
    /** The path of the write being attempted, so a mid-way failure can name the file it stopped on. */
    path: string
  }

  /**
   * Every file write a restore will make, in the order it will make them.
   *
   * Mirrors `restoreState`'s own walk, index-aligned with the counterpart side, so the preflight below and
   * the writer can never disagree about WHICH files a restore touches. A state with no `fileText` writes
   * nothing: it puts an entry back in the list (or takes it out) and never opens a file.
   * @param state - the side being installed.
   * @param expectedFile - the other side, whose per-index `fileText` is the divergence snapshot.
   * @returns the writes, in order.
   */
  function restoreWritesOf(state: DiffApprovalUndoState, expectedFile: DiffApprovalUndoState | undefined): RestoreWrite[] {
    const writes: RestoreWrite[] = []
    if (state.batch !== undefined) {
      const counterpart = expectedFile?.batch
      for (const [index, item] of state.batch.entries()) {
        writes.push(...restoreWritesOf({ ...item, batch: undefined }, counterpart?.[index]))
      }
      return writes
    }
    if (state.fileText !== undefined) writes.push({ path: state.path, expected: expectedFile?.fileText })
    return writes
  }

  /**
   * Check EVERY write a restore will make before it makes the first one, and refuse the whole restore if any
   * of them would be refused.
   *
   * WHAT IS GUARANTEED, and what is not (this is the honest half of the design):
   *
   * - AUTHORITY is guaranteed all-or-nothing. Each target is checked with the SAME predicate the write path
   *   enforces (`withinSandboxRoot`, the one `removeRevert` refuses with and the policy `writeRevert` hands
   *   the backend), under `pair.policySession` — the seat the action ran under. A refusal anywhere means no
   *   file is written at all, so an undo can never take back half of a decision. This is a check made before
   *   the first byte, so it is a guarantee rather than a hope.
   * - DIVERGENCE is also preflighted, because it is cheap and detectable up front: a target whose
   *   counterpart snapshot no longer matches the file refuses the whole restore rather than stopping
   *   half-way through it.
   * - A RUNTIME failure is NOT preflightable and is not promised away: a file that vanishes between this
   *   check and the write, or an IO fault on the third of five files, can still leave the earlier writes
   *   applied. When that happens the caller reports exactly how far the restore got (`RestoreProgress`)
   *   instead of claiming nothing happened. Do not read this function as an atomicity promise; it is a
   *   permission and staleness promise, and the mid-way case is reported as the partial state it is.
   * @param writes - the plan, from `restoreWritesOf`.
   * @param policySession - the session whose policy the write runs under (the pair's recorded seat).
   * @param signal - aborts the checks too.
   * @returns the first refusal (its path and the reason to report), or undefined when the plan may run.
   */
  async function preflightRestore(
    writes: readonly RestoreWrite[],
    policySession: SessionId,
    signal: AbortSignal,
  ): Promise<{ path: string; error: unknown } | undefined> {
    const policy = sandboxPolicyOf(policySession)
    for (const write of writes) {
      let resolved: FsTarget
      try {
        // `resolve` only: it is the path half of the write's own prologue, and a failure here is a refusal
        // for the whole restore rather than a mid-way surprise.
        resolved = await ctx.fs.resolve(write.path, { signal })
      } catch (error: unknown) {
        return { path: write.path, error }
      }
      if (policy !== undefined && !withinSandboxRoot(processPathOf(resolved), policy)) {
        return { path: write.path, error: new Error(sandboxDenial(processPathOf(resolved), policy)) }
      }
      if (write.expected !== undefined) {
        const current = await ctx.fs.readText(resolved, undefined)
        if (current !== write.expected) {
          return { path: write.path, error: new Error('the file changed outside the review after the action; undo is unavailable') }
        }
      }
    }
    return undefined
  }

  /**
   * The answer for a restore that did not finish: the refusal sentence when the sandbox was the reason, the
   * ordinary `undo failed:`/`redo failed:` text otherwise — and in EVERY case, when the restore had already
   * written something, how far it got. "Never that nothing happened": a partial restore is reported as the
   * partial state it is.
   * @param action - which direction was running.
   * @param path - the file the failure is about.
   * @param error - what the restore threw.
   * @param progress - the writes it completed, and how many it had to make.
   * @returns the error branch to answer with.
   */
  function restoreFailure(action: 'undo' | 'redo', path: string, error: unknown, progress: RestoreProgress): RpcResult<unknown> {
    if (isPolicyRefusal(error)) {
      const far = progress.written === 0
        ? ''
        : ` The ${action} had already written ${progress.written} of ${progress.total} files before that.`
      return rpcError(refusalText(path, error) + far)
    }
    const far = progress.written === 0 ? '' : ` after writing ${progress.written} of ${progress.total} files`
    return rpcError(`${action} failed${far}: ${errorMessage(error)}`)
  }

  /**
   * Revert one entry's file back to its baseline (the shared per-entry logic
   * behind both the single `revert` endpoint and the bulk `revert-all`). An
   * entry with no earlier version (`earlierVersion: 'none'`) has its file
   * deleted (not undoable: the file is gone); one that has an earlier version
   * (`'file'`) writes it back and yields the before/after undo snapshot.
   * @param entry - the entry to revert.
   * @param sessionId - the entry's session (for the per-session write policy).
   * @param signal - aborts before atomic publication takes effect.
   * @returns the undo snapshot, or `undefined` when the revert is not undoable.
   */
  async function revertEntryContent(entry: PendingEntry, sessionId: SessionId, signal: AbortSignal): Promise<{ before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined> {
    const resolved = await ctx.fs.resolve(entry.path, { signal })
    if (entry.earlierVersion === 'none') {
      await removeRevert(resolved, sessionId, signal)
      return undefined
    }
    const preWrite = await ctx.fs.readText(resolved, undefined) ?? entry.newText
    const content = reencodeEol(entry.oldText, detectEol(entry.newText))
    await writeRevert(resolved, content, sessionId, signal)
    return {
      before: { id: entry.id, path: entry.path, entry, fileText: preWrite },
      after: { id: entry.id, path: entry.path, entry: undefined, fileText: content },
    }
  }

  // Undo/redo stacks, in memory only (lost on restart). Every undoable
  // keep/revert/block action pushes its before/after pair; undo restores
  // `before`, redo re-applies `after`. Actions that delete a file (revert of a
  // created file, block-revert to empty) are not pushed.
  //
  // PER LINEAGE ROOT, not per session and not global: an entry's id is globally unique (it is the path),
  // and a single LIFO queue across every session meant session B's Ctrl+Z could pop session A's keep and
  // report success — an action the reader never took, on a file they may not even be looking at.
  //
  // The key is the requester's CANONICAL session — its lineage root, `canonicalOf` — because the seats of
  // one lineage read ONE list: a row a teammate recorded is the lead's row, and the human who supervises
  // the root is the one who presses Ctrl+Z. So the ACCEPTED consequence, and the point of the change
  // rather than an accident of it: a teammate's Ctrl+Z can take back the root's last action, and the
  // root's can take back a teammate's — one history per lineage, taken back from wherever it is read.
  //
  // The POLICY a restore writes under is canonicalized in the opposite direction: the pair RECORDS the
  // session the action ran under (`policySession`) and the restore replays exactly that — never the seat
  // that popped the pair, and never the entry's owner re-derived at restore time. That is what makes a
  // cross-seat Ctrl+Z safe: the popper's wider (or narrower) grant cannot leak into a write the presser
  // made, and a lineage whose seats do NOT share a workspace still writes each file under the seat that
  // actually acted on it.
  const undoStacks = new Map<SessionId, DiffApprovalUndoPair[]>()
  const redoStacks = new Map<SessionId, DiffApprovalUndoPair[]>()

  /** The undo stack of one lineage root, created on first use. Its key is a CANONICAL session. */
  function undoStackOf(root: SessionId): DiffApprovalUndoPair[] {
    let stack = undoStacks.get(root)
    if (stack === undefined) {
      stack = []
      undoStacks.set(root, stack)
    }
    return stack
  }

  /** The redo stack of one lineage root, created on first use. Its key is a CANONICAL session. */
  function redoStackOf(root: SessionId): DiffApprovalUndoPair[] {
    let stack = redoStacks.get(root)
    if (stack === undefined) {
      stack = []
      redoStacks.set(root, stack)
    }
    return stack
  }

  /**
   * One entry as an undo target sees it, for the "did this really change?" comparison.
   *
   * `updatedAt` is deliberately NOT in the key: every action stamps it with `Date.now()`, so including it
   * would make every recorded target look changed — the exact false positive the comparison exists to stop.
   */
  function entryKeyOf(entry: PendingEntry | undefined): string {
    if (entry === undefined) return '(no entry)'
    return JSON.stringify(entry, (key, value) => (key === 'updatedAt' ? undefined : value))
  }

  /** One side's comment records as a comparable key (a pair that carries threads changes when they do). */
  function commentsKeyOf(comments: readonly CommentRecord[] | undefined): string {
    return (comments ?? []).map(comment => `${comment.id}@${comment.anchor.startLine}-${comment.anchor.endLine}:${comment.text}`).join('|')
  }

  /**
   * Whether one target of a forward action really changed anything.
   *
   * THE RULE the reader asked for: a pair records only what changed. `before` is what the action found and
   * `after` is what it left — which is also what the file and the entry hold NOW, since the action has just
   * finished — so comparing the two sides is comparing the target against the world. Three things can
   * differ and each counts on its own: the file bytes (`fileText`, with `undefined` meaning "no write"), the
   * entry (its content-bearing fields; see `entryKeyOf`), and a comment pair's records. A target where none
   * of them differs is not a change and is not recorded, so Ctrl+Z cannot walk a file the action never
   * moved.
   *
   * A BATCH state is not compared here: its members are filtered one by one in `pushBatchUndo`, which is
   * where the index alignment lives.
   * @param before - the state the action found.
   * @param after - the state it left.
   * @returns whether recording this target would give the reader something to take back.
   */
  function stateChanged(before: DiffApprovalUndoState, after: DiffApprovalUndoState): boolean {
    if (before.batch !== undefined || after.batch !== undefined) return true
    if (before.kind === 'comments' || after.kind === 'comments') {
      return commentsKeyOf(before.comments) !== commentsKeyOf(after.comments)
    }
    if (before.fileText !== after.fileText) return true
    return entryKeyOf(before.entry) !== entryKeyOf(after.entry)
  }

  /**
   * Record one undoable action in its lineage's history. A fresh action invalidates that lineage's redo
   * history (and only that lineage's).
   *
   * THE RULE: the pair is filed under the CANONICAL session, so every seat of one lineage shares one
   * history and any of them can take the action back; the session that pressed is remembered on the pair
   * (`pressedBy` for attribution, and `policySession` for the write the RESTORE runs) — and the write
   * policy is recorded rather than re-derived, because the seat that POPS a pair need not be the seat that
   * made it. Canonicalizing HERE rather than at the call site is what makes the rule unforgettable: every
   * push in this file goes through this function.
   *
   * `policySession` is the presser because the forward action's own write is the requester's (see the
   * `revertEntryContent` call sites) — so every push here records the seat whose authority the action ran
   * under, and the restore replays exactly that.
   * @param sessionId - the session that pressed the action.
   * @param before - the state the action found, and what a restore puts back.
   * @param after - the state the action left, and what a redo re-applies.
   * @param view - the request's lineage view, when the caller already built one.
   */
  function pushUndo(sessionId: SessionId, before: DiffApprovalUndoState, after: DiffApprovalUndoState, view?: LineageView): void {
    // ONLY WHAT REALLY CHANGED is recorded (see `stateChanged`): an action that left the file and the entry
    // exactly as it found them has nothing to take back, and filing a pair for it would let a Ctrl+Z report
    // an undo the reader never made. The ACTION's own answer is untouched — it did what was asked of the
    // list — and the absence shows up honestly as `nothing` when the undo is pressed.
    if (!stateChanged(before, after)) return
    const root = canonicalOf(sessionId, view)
    undoStackOf(root).push({ root, pressedBy: sessionId, policySession: sessionId, before, after })
    redoStackOf(root).length = 0
  }

  /**
   * Record several entries' worth of ONE decision as a single undo step.
   *
   * The reader asked once — a VCS import, or a keep/revert over a pick of files — so one Ctrl+Z has to
   * take the whole thing back. A loop of single actions would push one step per entry instead, and undo
   * would then peel that one decision apart file by file.
   *
   * @param sessionId - the session that pressed.
   * @param before - one state per entry, in the order the decision touched them.
   * @param after - the same entries as the decision left them; the two arrays are index-aligned, which
   *   is also what the divergence guard on a restore reads (see `restoreState`).
   * @param view - the request's lineage view, when the caller already built one.
   */
  function pushBatchUndo(sessionId: SessionId, before: DiffApprovalUndoState[], after: DiffApprovalUndoState[], view?: LineageView): void {
    // ONLY THE MEMBERS THAT REALLY CHANGED (see `stateChanged`), filtered index-aligned so each kept member
    // still carries its own other side. A pick or an import routinely includes a row already in the state
    // this action would leave it in; recording those would make one Ctrl+Z walk files it never moved — and,
    // through the restore's preflight, would let a permission question about such a row refuse an undo that
    // would never have touched it.
    const changedBefore: DiffApprovalUndoState[] = []
    const changedAfter: DiffApprovalUndoState[] = []
    for (const [index, item] of before.entries()) {
      const counterpart = after[index]
      if (counterpart === undefined || !stateChanged(item, counterpart)) continue
      changedBefore.push(item)
      changedAfter.push(counterpart)
    }
    if (changedBefore.length === 0) return
    pushUndo(sessionId,
      { id: changedBefore[0]!.id, path: changedBefore[0]!.path, entry: undefined, fileText: undefined, batch: changedBefore },
      { id: changedAfter[0]!.id, path: changedAfter[0]!.path, entry: undefined, fileText: undefined, batch: changedAfter },
      view)
  }

  /** Drop the top pair of one lineage root's stack, when it belongs to that root; otherwise the
   *  stack is left exactly as it was, so another lineage's action is untouched.
   * @param stack - the root's stack (undo or redo).
   * @param root - the canonical session the request is for.
   * @returns the pair to move, or undefined when this lineage has nothing to move.
   */
  function popOwnPair(stack: DiffApprovalUndoPair[], root: SessionId): DiffApprovalUndoPair | undefined {
    const pair = stack[stack.length - 1]
    // The stack is already keyed by the root, so this is a belt: a pair pushed under some other root
    // (a bug, or a stack a caller reached by hand) is refused rather than taken back from here.
    if (pair === undefined || pair.root !== root) return undefined
    stack.pop()
    return pair
  }

  /**
   * One side of a comment pair: the records it holds, and the entry they hang off.
   *
   * The pair's `id`/`path` are that ENTRY's id (= its path, the store's global identity), which is the
   * one field that makes a comment pair behave like a file pair everywhere the stack is walked:
   * `purgeForEntry` filters by paths, so a comment whose file left the review cannot be restored onto
   * it. A pick of comments can span several files, in which case the pair names its first record's
   * entry — each record still carries its own `entryId`, which is where the restore puts it back.
   * @param entryId - the entry the pair's comments hang off.
   * @param records - the threads this side holds.
   * @returns the snapshot for `pushUndo`.
   */
  function commentState(entryId: string, records: readonly CommentRecord[]): DiffApprovalUndoState {
    return { id: entryId, path: entryId, entry: undefined, fileText: undefined, kind: 'comments', comments: records }
  }

  /**
   * The `before` side of an action that DROPS its entry, with the comments that drop is about to
   * delete riding along.
   *
   * Undo means one thing to the reader — their last action, taken back — so a pair whose action takes
   * a file out of the list has to bring back the threads that went with it, exactly as the pair for a
   * closed card brings the card back. Without this, Ctrl+Z gave the row back empty and the same
   * gesture meant two different things depending on whether the action was about a file or a comment.
   *
   * The snapshot goes on the `before` side ONLY: `after` carries none, which is what makes a redo the
   * same drop again rather than something that reinstalls a thread.
   *
   * Only the paths that really drop take one. A keep asked to leave its entry listed never deletes a
   * comment, and a snapshot there would re-add what the store still holds — and worse, would make the
   * undo of that keep resurrect comments the reader wrote after it.
   *
   * Must be called BEFORE `dropEntry`: the snapshot is of what that call is about to take away.
   * @param state - the `before` side as the action's own bookkeeping built it.
   * @returns that side, carrying the entry's records when it has any (absent rather than empty, so
   *   "this pair is about comments too" is one check for the restore).
   */
  function droppingComments(state: DiffApprovalUndoState): DiffApprovalUndoState {
    const carried = comments.forEntry(state.path)
    return carried.length === 0 ? state : { ...state, comments: carried }
  }

  /**
   * Install one side of a comment pair: the comments that side holds go back into the store, and the
   * ones only the other side holds are what this restore removes.
   *
   * The records go in VERBATIM (`CommentStore.add` stores a record it has never seen exactly as it
   * arrived), which is the whole point of snapshotting them: a rebuilt record would come back as a new
   * comment, with a fresh id, a fresh `createdAt` and no questions, and the reader's thread would be
   * gone behind a look-alike.
   *
   * The resolved lines of the entry are forgotten afterwards, because a range resolved against the
   * content the comment was written on is not a fact about the content it is being restored onto: the
   * file may have moved on while the thread was closed, so the next read has to place the quote again.
   *
   * Nothing here touches `ctx.fs` or the pending store: a comment is not a change to a file, and a
   * restore that also wrote one would turn "take the comment back" into "take the edit back".
   * @param state - the side to install.
   * @param expectedFile - the other side; the comments only it lists are the ones to remove.
   * @param scope - which comment authors this restore may remove: the undo's lineage. The stale side is
   *   the comments the OTHER side held, and they belong to whichever seats wrote them, so the removal has
   *   to be allowed to reach every file the pair's records live in (see `CommentStore.removeMany`).
   */
  function restoreComments(
    state: DiffApprovalUndoState,
    expectedFile: DiffApprovalUndoState | undefined,
    scope: CommentScope,
  ): void {
    const installing = state.comments ?? []
    const installed = new Set(installing.map(record => record.id))
    const stale = (expectedFile?.comments ?? [])
      .map(record => record.id)
      .filter(id => !installed.has(id))
    if (stale.length > 0) {
      comments.removeMany(scope, stale)
      for (const id of stale) commentLines.delete(id)
    }
    // One write for the whole side, not one per record: a pick of twenty comments is one undo, and it
    // must not become twenty saves of the session's file (see `CommentStore.addMany`).
    if (installing.length > 0) comments.addMany(installing)
    forgetCommentLinesForEntry(state.path)
  }

  /**
   * Restore one snapshot (the before/after side of an undo pair). File writes
   * carry the session sandbox policy; a divergence guard refuses to overwrite
   * a file an outside writer has since changed. The store change is applied
   * only after the write succeeds, keeping the restore all-or-nothing — and the
   * comments a dropping action removed are the LAST thing put back, so a refused
   * restore cannot leave a thread on a row that did not come back.
   * @param sessionId - the session the policy is resolved from (the pair's presser — see `undoStackOf`).
   * @param state - the snapshot to restore.
   * @param expectedFile - the other side's file content, checked before a write.
   * @param signal - aborts before atomic publication takes effect.
   * @param scope - which comment authors this restore may remove (the undo request's lineage).
   * @param progress - counts the file writes as they land, so a mid-way failure can report exactly how far
   *   it got instead of claiming nothing happened (see `restoreFailure`). Omitted where the caller has no
   *   use for it; a restore that gets no `progress` is unchanged.
   */
  async function restoreState(
    sessionId: SessionId,
    state: DiffApprovalUndoState,
    expectedFile: DiffApprovalUndoState | undefined,
    signal: AbortSignal,
    scope: CommentScope,
    progress?: RestoreProgress,
  ): Promise<void> {
    // A comment pair carries no file and no entry, so it takes the one branch that has neither.
    // Dispatching on the pair's own kind is what keeps ONE stack honest: the top of it decides what
    // the pop means, and everything below this line is about files.
    if (state.kind === 'comments') {
      restoreComments(state, expectedFile, scope)
      return
    }
    if (state.fileText !== undefined) {
      const resolved = await ctx.fs.resolve(state.path, { signal })
      if (expectedFile?.fileText !== undefined) {
        const current = await ctx.fs.readText(resolved, undefined)
        if (current !== expectedFile.fileText) {
          throw new Error('the file changed outside the review after the action; undo is unavailable')
        }
      }
      // The snapshot is the exact bytes the action wrote (line-endings already
      // adjusted), so restore writes it verbatim — reproducing the action
      // regardless of the current line-ending-sensitivity setting.
      if (progress !== undefined) progress.path = state.path
      await writeRevert(resolved, state.fileText, sessionId, signal)
      if (progress !== undefined) progress.written += 1
    }
    if (state.batch !== undefined) {
      // A batch is ONE decision over several entries — one VCS import, or one keep/revert asked of a
      // pick of files — so restoring it is restoring each item in turn. An item that carries `fileText`
      // writes its file exactly as a lone state does: the session-wide 全部回退 has always put the bytes
      // each file held into its undo states, and this branch used to ignore them, so undoing it brought
      // the rows back while the files stayed reverted on disk. The counterpart item is the same index on
      // the other side, so a single restore's divergence guard applies here too.
      const counterpart = expectedFile?.batch
      for (const [index, item] of state.batch.entries()) {
        await restoreState(sessionId, { ...item, batch: undefined }, counterpart?.[index], signal, scope, progress)
      }
      return
    }
    if (state.entry !== undefined) store.restore(state.entry)
    else dropEntry(state.path)
    // The comments come back LAST, and only for a restore that got this far: everything above can
    // refuse (a divergence guard, a write the sandbox denies), and a refused restore must not leave
    // behind the threads of a row that did not come back — a comment on a file the list does not hold
    // is exactly the orphan the store's guards exist to prevent, and the panel would draw a card
    // pointing at nothing.
    //
    // `comments` is present only on a pair whose action DROPPED the entry, so this also covers the
    // batch case: `pushBatchUndo` hands each item to this same path, item by item.
    if (state.comments !== undefined && state.comments.length > 0) {
      comments.addMany(state.comments)
      // Their resolved lines were computed against the content the thread was written on, which is not
      // a fact about the content it is coming back onto; the next read places the quote again (the same
      // reason `restoreComments` forgets them).
      forgetCommentLinesForEntry(state.path)
    }
  }

  /**
   * Mirror the whole (globally-unique) entry set to disk. A write fault logs a
   * warning and leaves the in-memory view intact: the review flow must not
   * break on a storage fault, and the next successful mutation rewrites the
   * file.
   * @returns resolution after the write settles (successful or logged).
   */
  // Persistence writes are throttled: coalesce to at most one durable write per
  // PERSIST_THROTTLE_MS. A write runs immediately when the store has been idle
  // longer than the window (write-through for a single change), so a lone
  // capture persists without delay; a burst of agent captures coalesces to one
  // write per window instead of one per event — the fix for the I/O/CPU storm.
  // User actions (keep/revert/undo/redo) pass `force` so their outcome is
  // durable immediately, not left in a throttled window.
  const PERSIST_THROTTLE_MS = 1000
  let persistDirty = false
  let persistScheduled = false
  let lastPersistAt = 0
  let persistTimer: ReturnType<typeof setTimeout> | undefined

  /** The last persist failure reported, so a writer that keeps failing says so once (cleared by a
   *  write that works, which is what makes a later, different failure report again). */
  let persistFailureReported: string | undefined

  /** Actually write the (dirty) store to disk; one coalesced write. */
  async function flushPersist(): Promise<void> {
    if (!persistDirty) return
    persistDirty = false
    lastPersistAt = Date.now()
    try {
      await ensureLoaded()
      await persistence.save(store.all())
      persistFailureReported = undefined
    } catch (error: unknown) {
      const message = errorMessage(error)
      // Not a detail to file away. This file is what makes the list survive a restart, and a filesystem
      // that refuses the write — no permission, no space, a directory this host cannot create (issue #6:
      // a hand-rolled split of the path answered `.` for a Windows path, so the write threw ENOENT; the
      // atomic write's `dirname(file)` is what fixed it) — leaves the reader with a list that silently
      // disappears, which is the one failure nobody can diagnose from the outside. At
      // error level, once per distinct message, so a writer retrying every second cannot bury it.
      if (persistFailureReported !== message) {
        persistFailureReported = message
        ctx.logger.error(`diff-approval: persisting pending changes failed, so the list will not survive a restart: ${message}`)
      }
    }
  }

  /** Mark the store dirty and schedule one throttled, coalesced write. Pass
   * `force` to write immediately (user actions need durable, immediate results). */
  /**
   * Mark the list dirty and start its write. The throttle is for the panel's own churn; `force` writes
   * NOW and, since 2026-10-06, RETURNS the write's promise.
   *
   * That return value is a durability guarantee, not a convenience: a caller that is about to write
   * something NAMING an entry — the annotate tool's comment — has to know the entry is readable at the
   * next boot first. Folded in memory and written on a later flush, an entry can be lost to a host that
   * stops in between, and the load-time sweep then hides (and used to delete) the comments that named
   * it. Awaiting here is what makes "the comment exists" imply "its entry was on disk first".
   *
   * @param force - write immediately rather than on the throttle's schedule.
   * @returns a promise that settles when the write this call started has finished (never rejects: a
   * failure is logged and reported through `persistFailureReported`, because a store that cannot write
   * must keep answering reads).
   */
  function persistSession(force = false): Promise<void> {
    persistDirty = true
    if (force) {
      if (persistScheduled) { clearTimeout(persistTimer); persistScheduled = false }
      return flushPersist()
    }
    if (persistScheduled) return Promise.resolve()
    const delay = PERSIST_THROTTLE_MS - (Date.now() - lastPersistAt)
    if (delay <= 0) {
      return flushPersist()
    }
    persistScheduled = true
    persistTimer = setTimeout(() => {
      persistScheduled = false
      void flushPersist()
    }, delay)
    // Do not hold the process open just for this timer.
    persistTimer.unref?.()
    return Promise.resolve()
  }

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (exec.name === 'str_replace_editor') {
      void captureEditorMutation(exec, result)
      return
    }
    if (result.isError || exec.agent === undefined) return
    const outcome = exec.name === 'edit' ? editOutcomeOf(result.value) : exec.name === 'write' ? writeOutcomeOf(result.value) : undefined
    if (outcome === undefined || outcome.oldText === outcome.newText) return
    const sessionId = exec.agent.id
    const entry: PendingEntry = { id: outcome.path, sessionId, ...outcome, updatedAt: Date.now(), sessionIds: [sessionId], lineage: lineageOf(sessionId, exec.agent), unseen: true }
    // Fold synchronously so the very next list sees the capture; persistence
    // (hydration + save) rides the same turn asynchronously.
    if (store.fold(entry)) persistSession()
  })

  const handle: ConnectionRpcHandler = async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    switch (endpoint) {
      case 'list': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        // ONE snapshot of the store for the whole read. `store.all()` copies and re-sorts the entry array,
        // and this read wants the same one for the lineage walk, the settlement below and the comment sweep
        // — three calls became one. It is a snapshot either way (settlement mutates the STORE, not this
        // array), and the sweep's ids are equivalents: an entry dropped during settlement had its comments
        // removed with it by `dropEntry`, so retaining its id here can keep nothing alive.
        const entries = store.all()
        // ONE view for the whole read: the merge, the comment scope and the undo keys are the same
        // question, and `lineageView` walks the store to answer it — so it is built here and handed on.
        const view = lineageView(entries)
        // The sweep on every read, so a comment a crash left behind its entry is gone before any client can
        // be handed it. It prunes the VIEW only: removing the entry already took its comments with it
        // (`dropEntry` → `removeForEntry`, the erase), and this normally removes nothing. Writing the prune
        // here is what made a restart permanent for a card whose entry had never reached `pending.json` —
        // the boot hid it and this read would have erased it — so erasure stays with the explicit removal
        // (see `CommentStore.retain`).
        if (comments.retain(new Set(entries.map(entry => entry.id))) > 0) {
          // What it did remove may have lines cached against content it never hung off.
          forgetOrphanedCommentLines()
        }
        const { files, redoCleared } = await listWithState(sessionId, view, entries)
        // The threads of this LINEAGE — every seat's, not only the reader's — read ONCE and reused for the
        // gate, the fold, the resolved lines and the wire below. It is re-read only when the fold actually
        // replaced a record (see `folded`), because `patch` swaps the object in the store.
        const scope = commentScopeOf(sessionId, view)
        const visibleComments = comments.list(scope)
        let folded = false
        // Nothing to derive when the lineage carries no comments, and the derivation is the expensive half
        // of this read: the answer fold and the turn-end read each walk a session's WHOLE event log (a long
        // session is >100k events), and every client repeats that once a second. A question exists only
        // inside a comment — `ask` looks the comment up first and refuses an id the store does not hold,
        // and `recordAsk` writes onto that comment — so an empty list here means no answer and no turn is
        // worth reading out of any log. The skip also skips `answersFor`'s re-arming of the inbox watcher,
        // which is safe for the same reason: the ask that would need the watcher arms it itself.
        const commentAnswers: Record<string, string> = {}
        if (visibleComments.length > 0) {
          // ONE walk per TRANSCRIPT that holds a question, not one per read: a lineage's threads can carry
          // questions asked from several seats, and an answer lives in the transcript it was submitted
          // into (`askTranscript`). `answerGroups` is empty when nothing was ever asked there.
          const transcripts: TranscriptCache = new Map()
          for (const [transcript, requestIds] of commentAsker.answerGroups(visibleComments)) {
            // Derived here, on every read, from that session's own event log: the log is the only place an
            // answer is written down, and the turn that claimed a question is the only thing that bounds
            // it. The read writes nothing, so the turn's end is recorded beside it first — the log is
            // durable where `agent/turn-stopping` is a live event, so this is what marks a question over
            // for a session whose ending this process never watched (a resume, a later client).
            const answers = commentAsker.answersFor(transcript, requestIds, transcripts)
            for (const [requestId, read] of Object.entries(answers)) {
              // The transcript names the turn too, so a question asked while this process was not watching
              // still learns it — which is what lets `markTurnEnded` below, and the panel, find it at all.
              // Recording is a no-op once the inbox has written the same number down. Keyed by the request
              // id alone: it names the question wherever it was asked from.
              if (read.turn !== undefined && comments.recordTurnForRequest(requestId, read.turn) > 0) folded = true
            }
            // The turn's end is per TRANSCRIPT, and turn numbers are only unique within one: this is the
            // session whose log was just read, which is what `markTurnEnded` matches against.
            for (const turn of commentAsker.endedTurns(transcript, transcripts)) {
              if (comments.markTurnEnded(transcript, turn) > 0) folded = true
            }
            // An answer that has arrived (or been rewritten) is news the reader has not looked at yet, so
            // this fold is what raises the card's dot — and it raises nothing on a read that found the same
            // text as last time (see `CommentStore.syncAnswers`). It folds ONLY this transcript's questions
            // and leaves the ones asked elsewhere alone, so a thread asked from two seats keeps both
            // answers (see `answerStateOf`). Runs before the list below is taken, because the flag rides
            // the records this read hands over.
            if (comments.syncAnswers(transcript, answers)) folded = true
            for (const [requestId, read] of Object.entries(answers)) {
              if (read.answer !== undefined) commentAnswers[requestId] = read.answer
            }
          }
        }
        // The records handed over below: the list read at the top, unless the fold above replaced one in the
        // store (`patch` swaps the object, so a touched record is only in a fresh read). Nothing else in this
        // value depends on the difference: `resolvedCommentLines` works off a record's own quote and anchor,
        // which no fold touches.
        const listedComments = folded ? comments.list(scope) : visibleComments
        const value: DiffApprovalListValue = {
          files,
          // The comments ride this read rather than a channel of their own, so the
          // entries and the comments that hang off them arrive as one snapshot.
          comments: listedComments,
          // The lines each of those comments sits on in the entry's CURRENT content, resolved here
          // and shipped with the records: the list pane, the code view's own card and the jump all
          // draw one figure, and none of them needs the file to have been opened first. A comment
          // the host cannot place is absent from the map, and its callers keep `record.anchor`.
          commentLines: resolvedCommentLines(listedComments),
          commentsRevision: comments.commentsRevision(),
          commentAnswers,
          workspacePath: workspaceOf(sessionId)?.path,
          redoCleared: redoCleared || undefined,
          // The skill a comment prompt may point at, so the client knows which prompt
          // shape to send (see `lazyCommentSkill`).
          commentSkill: commentSkill(),
          // The last failure to write the pending state, so the panel can say that the list will not
          // survive a restart — the one thing a reader cannot find out from the panel itself.
          persistError: persistFailureReported,
          // …and the same for the comment files, which are their own files: a thread written
          // to memory while its file refuses the write is erased by a restart just as silently.
          commentPersistError: comments.persistError(),
        }
        return { ok: true, value }
      }
      case 'list-count': {
        // The badge's own read: the same visibility rule as `list`, over one snapshot and one view, and
        // NOTHING read from any file. `list` ships every visible entry's whole `oldText`+`newText` (measured
        // at 6.77 MB for 302 entries), which is the latency this verb exists to avoid — see
        // `DiffApprovalListCountValue` for what it deliberately leaves out and what that costs the caller.
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        const entries = store.all()
        const view = lineageView(entries)
        let count = 0
        for (const entry of entries) {
          if (!view.sees(sessionId, entry)) continue
          // A stat, and nothing else. It is what keeps a file that is GONE out of the number — the one drop
          // `list` also makes without reading — while a present-but-unreadable row is counted here and
          // dropped by the next full read, which is the accepted cost of not reading.
          if ((await probePath(entry.path)).kind !== 'present') continue
          count += 1
        }
        const value: DiffApprovalListCountValue = { count }
        return { ok: true, value }
      }
      case 'comment-seen': {
        // The reader has this card in front of them in the diff: its dot goes out, and the answers it
        // shows become the baseline a later rewrite is measured against. A reader action, which is why
        // it is an endpoint of its own rather than something the list read does.
        const seen = targetOf(payload)
        if (seen === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded()
        const record = comments.get(seen.id)
        // Any seat of the lineage may mark a thread it can SEE: the dot is one fact about one comment,
        // not a per-seat copy of it. `markSeen` itself is already id-keyed, and writes the file that
        // holds the record.
        if (record === undefined || !commentScopeOf(seen.sessionId, lineageView())(record.sessionId)) {
          return { ok: true, value: { outcome: 'missing' as const } }
        }
        comments.markSeen(seen.id)
        return { ok: true, value: { outcome: 'seen' as const } }
      }
      case 'comment-add': {
        const input = commentAddOf(payload)
        if (input === undefined) return rpcError('sessionId, entryId, anchor, quote and text must be valid')
        await ensureLoaded()
        // The entry has to be in THIS session's VIEW — its own or one the lineage merged in. A comment on
        // a file that has left the list is refused rather than stored: it is the one way a comment could
        // be born already outliving its entry. Guarded rather than `store.list(input.sessionId)`, which is
        // self-only and refused every merged row the panel legitimately shows (see `actionableEntryOf`).
        const view = lineageView()
        const entry = actionableEntryOf(view, input.sessionId, input.entryId)
        if (entry === undefined) {
          const value: DiffApprovalCommentAddValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        const now = Date.now()
        const record: CommentRecord = {
          // The caller's id when it named one, so a retried request lands on the same
          // comment instead of writing a second copy of it.
          id: input.id ?? randomUUID(),
          // The AUTHOR — the seat that wrote it, and therefore the file it lives in (`save`). Provenance
          // is the capture data and stays honest; the lineage is what makes it readable elsewhere.
          sessionId: input.sessionId,
          entryId: entry.id,
          path: entry.path,
          anchor: input.anchor,
          quote: input.quote,
          text: input.text,
          createdAt: now,
          updatedAt: now,
          ...(input.quoteContext === undefined ? {} : { quoteContext: input.quoteContext }),
          ...(input.quoteLines === undefined ? {} : { quoteLines: input.quoteLines }),
        }
        comments.add(record)
        // Writing a comment is an action the reader took, so it joins the same history as their file
        // decisions — as an empty → {it} pair, because the comment IS the change. Nothing about the
        // conversation goes near this: `comment-ask` and the answer arriving patch the thread, and a
        // Ctrl+Z that took a question back would be rewinding a conversation rather than an action.
        pushUndo(input.sessionId, commentState(entry.path, []), commentState(entry.path, [record]), view)
        const value: DiffApprovalCommentAddValue = { outcome: 'added', comment: record }
        return { ok: true, value }
      }
      case 'comment-remove': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded()
        // Read the record BEFORE the removal: `remove` keeps nothing, so a pair built afterwards could
        // only put an id back with no thread behind it.
        const view = lineageView()
        const record = comments.get(target.id)
        const removed = comments.remove(commentScopeOf(target.sessionId, view), target.id)
        const value: DiffApprovalCommentRemoveValue = { outcome: removed ? 'removed' : 'missing' }
        if (removed && record !== undefined) {
          pushUndo(target.sessionId, commentState(record.entryId, [record]), commentState(record.entryId, []), view)
        }
        // The comment is gone, so the lines it resolved to are about nothing: a later comment reusing
        // the id (the client mints them, and a retry may) must not read as already resolved.
        commentLines.delete(target.id)
        return { ok: true, value }
      }
      case 'comment-remove-many': {
        const request = commentRemoveManyOf(payload)
        if (request === undefined) return rpcError('sessionId and a non-empty ids array of strings must be given')
        await ensureLoaded()
        // ONE write PER FILE that holds a record of the batch (see `CommentStore.removeMany`), which is
        // the whole reason this endpoint exists beside `comment-remove`.
        // The snapshot is taken first, and in the order given: `removeMany` reports the ids it actually
        // dropped under the same scope rule (it is here, and its author is in this lineage), so the
        // records below are exactly the ones that left.
        const view = lineageView()
        const scope = commentScopeOf(request.sessionId, view)
        const snapshot = request.ids
          .map(id => comments.get(id))
          .filter((record): record is CommentRecord => record !== undefined && scope(record.sessionId))
        const removed = comments.removeMany(scope, request.ids)
        for (const id of removed) commentLines.delete(id)
        // ONE pair for the whole batch, like the pick that asked for it: a step per comment would make
        // the reader press Ctrl+Z once per thread to take back one decision. The pair goes on the
        // LINEAGE's stack (`pushUndo` canonicalizes), so any seat of it can take the batch back.
        const first = snapshot[0]
        if (first !== undefined) {
          pushUndo(request.sessionId, commentState(first.entryId, snapshot), commentState(first.entryId, []), view)
        }
        const value: DiffApprovalCommentRemoveManyValue = { removed: removed.length }
        return { ok: true, value }
      }
      case 'comment-ask': {
        const input = commentAskOf(payload)
        if (input === undefined) return rpcError('sessionId, id, prompt and text must be valid')
        await ensureLoaded()
        // The prompt is submitted into `input.sessionId` — the seat the human is using, which is where the
        // answer will appear — while the THREAD may belong to any seat of the lineage, so the scope is
        // what the asker checks (`not mine` becomes `not my lineage's`).
        const view = lineageView()
        const value = await commentAsker.ask(input.sessionId, input.id, input.prompt, input.text, signal, commentScopeOf(input.sessionId, view))
        return { ok: true, value }
      }
      case 'keep': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        // Remove synchronously: once the user acts, the entry must be gone for
        // any concurrent list. (The store is hydrated by the time an action
        // runs, since the panel lists first.)
        // Resolved through the request's merged view, so a row the reader can see is actionable and a row
        // outside its lineage answers `missing` — the same answer an id that names nothing gets.
        const lineage = lineageView()
        let entry = actionableEntryOf(lineage, target.sessionId, target.id)
        if (entry === undefined) {
          await ensureLoaded()
          entry = actionableEntryOf(lineage, target.sessionId, target.id)
          if (entry === undefined) {
            const value: DiffApprovalActionValue = { outcome: 'missing' }
            return { ok: true, value }
          }
        }
        // The file already holds the accepted content, so nothing is written:
        // folding `newText` into the baseline clears the diff. The panel asks
        // whether to also drop the resolved entry, and rides the answer here.
        if ((payload as Record<string, unknown>).keepListed === true) {
          store.update(target.id, { oldText: entry.newText })
          const afterEntry: PendingEntry = { ...entry, oldText: entry.newText, updatedAt: Date.now() }
          pushUndo(target.sessionId,
            { id: entry.path, path: entry.path, entry, fileText: undefined },
            { id: entry.path, path: entry.path, entry: afterEntry, fileText: undefined })
          persistSession(true)
          const value: DiffApprovalActionValue = { outcome: 'kept', resolved: true }
          return { ok: true, value }
        }
        // Snapshotted BEFORE the drop: the threads are what that call is about to take away.
        const beforeDrop = droppingComments({ id: entry.path, path: entry.path, entry, fileText: undefined })
        dropEntry(target.id)
        pushUndo(target.sessionId, beforeDrop,
          { id: entry.path, path: entry.path, entry: undefined, fileText: undefined })
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'kept' }
        return { ok: true, value }
      }
      case 'revert': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        // Resolved through the request's merged view, so a row the reader can see is actionable and a row
        // outside its lineage answers `missing` — the same answer an id that names nothing gets.
        const lineage = lineageView()
        let entry = actionableEntryOf(lineage, target.sessionId, target.id)
        if (entry === undefined) {
          await ensureLoaded()
          entry = actionableEntryOf(lineage, target.sessionId, target.id)
          if (entry === undefined) {
            const value: DiffApprovalActionValue = { outcome: 'missing' }
            return { ok: true, value }
          }
        }
        // The REQUESTER governs the WRITE: the sandbox and workspace a revert runs under are the pressing
        // seat's own, never another session's (see `DiffApprovalUndoPair.policySession`). Visibility has
        // already established that this session shares a workspace with an owner of the row, so the file is
        // inside this session's workspace — and a press runs under the authority of the seat that pressed it
        // rather than silently borrowing a wider grant from whoever touched the file last. The undo pair
        // below is filed under that same pressing session (`pushUndo` canonicalizes the STACK, not this).
        // A revert that deletes a created file is not undoable (the file is
        // gone); a revert that writes keeps a snapshot for Ctrl+Z.
        let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
        try {
          undo = await revertEntryContent(entry, target.sessionId, signal)
        } catch (error: unknown) {
          // A refusal by this session's own authority says so, and names the file; every other failure
          // (a missing file, a diverged one, an IO fault) keeps its own answer.
          if (isPolicyRefusal(error)) return policyRefusal(entry.path, error)
          return rpcError(`revert failed: ${errorMessage(error)}`)
        }
        // The file now holds its old content; folding that into `newText` clears
        // the diff while the entry stays listed (the panel asked to keep it).
        // A deleted created file folds to empty, exactly as a block revert that
        // empties one does.
        if ((payload as Record<string, unknown>).keepListed === true) {
          const content = undo?.after.fileText ?? ''
          store.update(target.id, { newText: content })
          const afterEntry: PendingEntry = { ...entry, newText: content, updatedAt: Date.now() }
          if (undo !== undefined) {
            pushUndo(target.sessionId,
              { id: entry.path, path: entry.path, entry, fileText: undo.before.fileText },
              { id: entry.path, path: entry.path, entry: afterEntry, fileText: content })
          }
          persistSession(true)
          const value: DiffApprovalActionValue = { outcome: 'reverted', resolved: true }
          return { ok: true, value }
        }
        // The snapshot happens BEFORE the drop takes the comments away. A revert of a created file has
        // no undo state at all (the file is deleted, so there is nothing to go back to) and therefore
        // no pair for a snapshot to ride — the one revert whose threads cannot come back, which is the
        // same "this action is not undoable" the file itself already is.
        const pair = undo === undefined ? undefined : { before: droppingComments(undo.before), after: undo.after }
        dropEntry(target.id)
        // The session that PRESSED, which is also the session whose policy the write above ran under: undo
        // is retrieved from the requester's own lineage stack (`undoStackOf`/`popOwnPair` are keyed
        // canonically, and the pop refuses a pair tagged with another root), so the pair and the write it
        // replays name one and the same seat (see `DiffApprovalUndoPair.policySession`).
        if (pair !== undefined) pushUndo(target.sessionId, pair.before, pair.after)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'reverted' }
        return { ok: true, value }
      }
      case 'keep-all': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        // A whole-list press acts on every row this session can SEE — its own plus those of the sessions it
        // shares a lineage root with (see `lineageView`). The pairs belong to the session that PRESSED.
        const lineage = lineageView()
        const entries = store.all().filter(entry => lineage.sees(sessionId, entry))
        const before: DiffApprovalUndoState[] = []
        const after: DiffApprovalUndoState[] = []
        for (const entry of entries) {
          before.push(droppingComments({ id: entry.id, path: entry.path, entry, fileText: undefined }))
          after.push({ id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          dropEntry(entry.id)
        }
        if (before.length > 0) pushBatchUndo(sessionId, before, after)
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected: before.length }
        return { ok: true, value }
      }
      case 'revert-all': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        await ensureLoaded()
        const lineage = lineageView()
        const entries = store.all().filter(entry => lineage.sees(sessionId, entry))
        const batchBefore: DiffApprovalUndoState[] = []
        const batchAfter: DiffApprovalUndoState[] = []
        /** How many files this press had already put back when it stopped: said, never hidden (see 3c). */
        let reverted = 0
        for (const entry of entries) {
          // The REQUESTER's own policy for the WRITE, like the single revert: every row this batch touches
          // is one this session can see, which puts it inside this session's workspace, and the press runs
          // under the authority of the seat that pressed it (see `DiffApprovalUndoPair.policySession`).
          let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
          try {
            undo = await revertEntryContent(entry, sessionId, signal)
          } catch (error: unknown) {
            // A refusal by this session's own authority names the file and says so, and says how far the
            // press got when it got anywhere; every other failure keeps the answer it has always had.
            const far = reverted === 0 ? '' : ` (this press had already reverted ${reverted} of ${entries.length} files)`
            if (isPolicyRefusal(error)) return rpcError(refusalText(entry.path, error) + far)
            // An unreadable file is left listed (the caller sees it as a failed
            // entry) rather than silently dropped; stop the bulk here.
            return rpcError(`revert-all failed for ${entry.path}${far}`)
          }
          reverted += 1
          if (undo !== undefined) {
            batchBefore.push(droppingComments(undo.before))
            batchAfter.push(undo.after)
          }
          dropEntry(entry.id)
        }
        if (batchBefore.length > 0) pushBatchUndo(sessionId, batchBefore, batchAfter)
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected: entries.length }
        return { ok: true, value }
      }
      case 'keep-many': {
        const request = manyTargetsOf(payload)
        if (request === undefined) return rpcError('sessionId and a non-empty ids array of strings must be given')
        await ensureLoaded()
        // A pick acts only on rows this session can SEE (see `lineageView`); an id outside the lineage is
        // skipped exactly like an id that names nothing.
        const lineage = lineageView()
        const before: DiffApprovalUndoState[] = []
        const after: DiffApprovalUndoState[] = []
        for (const id of request.ids) {
          const entry = actionableEntryOf(lineage, request.sessionId, id)
          // An id that is already gone is not an error: the file left the list between the reader's pick
          // and this request, which is exactly what keeping it means.
          if (entry === undefined) continue
          if (request.keepListed === true) {
            // The same fold the single keep does: the accepted content is already in the file, so the
            // entry stays listed with nothing left to show.
            store.update(id, { oldText: entry.newText })
            before.push({ id: entry.id, path: entry.path, entry, fileText: undefined })
            after.push({
              id: entry.id, path: entry.path,
              entry: { ...entry, oldText: entry.newText, updatedAt: Date.now() },
              fileText: undefined,
            })
            continue
          }
          // Snapshotted before the drop below takes them away (the keep-list branch above returns
          // first, and must NOT snapshot: its entry never leaves the list, so nothing was deleted).
          before.push(droppingComments({ id: entry.id, path: entry.path, entry, fileText: undefined }))
          after.push({ id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          dropEntry(id)
        }
        pushBatchUndo(request.sessionId, before, after)
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected: before.length }
        return { ok: true, value }
      }
      case 'revert-many': {
        const request = manyTargetsOf(payload)
        if (request === undefined) return rpcError('sessionId and a non-empty ids array of strings must be given')
        await ensureLoaded()
        const lineage = lineageView()
        const before: DiffApprovalUndoState[] = []
        const after: DiffApprovalUndoState[] = []
        let affected = 0
        for (const id of request.ids) {
          const entry = actionableEntryOf(lineage, request.sessionId, id)
          if (entry === undefined) continue
          affected += 1
          // The REQUESTER's own policy for the WRITE, like the single revert; the pair below stays on the
          // pressing session's stack (see `DiffApprovalUndoPair.policySession`).
          let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
          try {
            undo = await revertEntryContent(entry, request.sessionId, signal)
          } catch (error: unknown) {
            // A refusal by this session's own authority names the file and says so, plus how far the pick
            // got when it got anywhere; every other failure keeps the answer it has always had.
            const far = affected - 1 === 0 ? '' : ` (this pick had already reverted ${affected - 1} of ${request.ids.length} files)`
            if (isPolicyRefusal(error)) return rpcError(refusalText(entry.path, error) + far)
            // An unreadable file is left listed (the caller sees it as a failed entry) rather than
            // silently dropped; stop the pick here, the way the session-wide revert does — what the
            // batch has already put back is what the reader sees.
            return rpcError(`revert-many failed for ${entry.path}${far}`)
          }
          if (request.keepListed === true) {
            // The file holds its old content again and the entry stays listed with the diff gone — the
            // same pair the single revert+keepListed records, with the file content in the pair.
            const content = undo?.after.fileText ?? ''
            store.update(id, { newText: content })
            if (undo !== undefined) {
              before.push({ id: entry.path, path: entry.path, entry, fileText: undo.before.fileText })
              after.push({
                id: entry.path, path: entry.path,
                entry: { ...entry, newText: content, updatedAt: Date.now() },
                fileText: content,
              })
            }
            continue
          }
          // A file the agent created has no undo state at all: putting it back DELETED it (see
          // `revertEntryContent`). The panel asks before sending a pick into this — the delete is the one
          // thing here that cannot be taken back, so the batch's undo covers only what it can.
          // The snapshot is taken here, before the drop below; `keepListed` returned above without one.
          if (undo !== undefined) {
            before.push(droppingComments(undo.before))
            after.push(undo.after)
          }
          dropEntry(id)
        }
        pushBatchUndo(request.sessionId, before, after)
        persistSession(true)
        const value: DiffApprovalBulkValue = { affected }
        return { ok: true, value }
      }
      case 'block-keep': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded()
        // Guarded by the same merged view `list` reads through: a row outside the requester's lineage
        // answers `missing`, exactly like an id that names nothing.
        const lineage = lineageView()
        const entry = actionableEntryOf(lineage, blockTarget.sessionId, blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Accept this block: fold its new side into the tracked baseline so
        // the entry's diff no longer shows it. The file already holds the
        // accepted content, so nothing is written. When this clears the file's
        // last change and the caller asked to remove it, the entry leaves the
        // list now (the panel's prompt rides this same request); otherwise it
        // stays listed with no pending diff, removed by a later keep/revert.
        const accepted = contentRangeOf(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd)
        const updatedOld = replaceContentLines(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd, accepted)
        store.update(blockTarget.id, { oldText: updatedOld })
        const afterEntry: PendingEntry = { ...entry, oldText: updatedOld, updatedAt: Date.now() }
        pushUndo(blockTarget.sessionId,
          { id: entry.id, path: entry.path, entry, fileText: undefined },
          { id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined })
        persistSession()
        const fullyResolved = contentEqual(updatedOld, entry.newText)
        if (fullyResolved && blockTarget.removeWhenResolved === true) {
          // Snapshotted before the drop: an entry whose last block just resolved leaves the list here,
          // and it takes its threads with it.
          const resolvedDrop = droppingComments({ id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined })
          dropEntry(blockTarget.id)
          pushUndo(blockTarget.sessionId, resolvedDrop,
            { id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          persistSession(true)
        }
        const kept: DiffApprovalActionValue = fullyResolved ? { outcome: 'kept', resolved: true } : { outcome: 'kept' }
        return { ok: true, value: kept }
      }
      case 'block-revert': {
        const blockTarget = blockTargetOf(payload)
        if (blockTarget === undefined) return rpcError('sessionId, id, and block must be valid')
        await ensureLoaded()
        // Guarded by the same merged view `list` reads through: a row outside the requester's lineage
        // answers `missing`, exactly like an id that names nothing.
        const lineage = lineageView()
        const entry = actionableEntryOf(lineage, blockTarget.sessionId, blockTarget.id)
        if (entry === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Undo this block: restore its old side into the new text and write
        // the file back. The entry stays even when now fully reverted
        // (newText === oldText): the file stays listed with no pending diff.
        const restored = contentRangeOf(entry.oldText, blockTarget.block.oldStart, blockTarget.block.oldEnd)
        const updatedNew = replaceContentLines(entry.newText, blockTarget.block.newStart, blockTarget.block.newEnd, restored)
        // Write the file in the entry's current EOL (uniform), and keep the
        // store's newText in step with the bytes actually written, so a later
        // read never sees a line-ending-only drift.
        const content = reencodeEol(updatedNew, detectEol(entry.newText))
        store.update(blockTarget.id, { newText: content })
        const afterEntry: PendingEntry = { ...entry, newText: content, updatedAt: Date.now() }
        // A block-revert that empties a created file deletes it and is not
        // undoable; one that writes keeps a snapshot for Ctrl+Z.
        let undo: { before: DiffApprovalUndoState; after: DiffApprovalUndoState } | undefined
        try {
          const target = await ctx.fs.resolve(entry.path, { signal })
          if (entry.earlierVersion === 'none' && content === '') {
            await removeRevert(target, blockTarget.sessionId, signal)
          } else {
            const preWrite = await ctx.fs.readText(target, undefined) ?? entry.newText
            await writeRevert(target, content, blockTarget.sessionId, signal)
            undo = {
              before: { id: entry.id, path: entry.path, entry, fileText: preWrite },
              after: { id: entry.id, path: entry.path, entry: afterEntry, fileText: content },
            }
          }
        } catch (error: unknown) {
          // A refusal by this session's own authority names the file and says so; every other failure
          // keeps the answer it has always had.
          if (isPolicyRefusal(error)) return policyRefusal(entry.path, error)
          return rpcError(`block revert failed: ${errorMessage(error)}`)
        }
        // The pair goes to the session that PRESSED, like every other branch here — and the write above ran
        // under that same seat's policy, so the pair's `policySession` is the one the restore replays. The
        // drop branch just below is the same action's second half and must file its pair the same way, or
        // one gesture would be undoable from one view and not another.
        if (undo !== undefined) pushUndo(blockTarget.sessionId, undo.before, undo.after)
        persistSession()
        const fullyResolved = contentEqual(updatedNew, entry.oldText)
        if (fullyResolved && blockTarget.removeWhenResolved === true) {
          // Snapshotted before the drop: an entry whose last block just resolved leaves the list here,
          // and it takes its threads with it.
          const resolvedDrop = droppingComments({ id: entry.id, path: entry.path, entry: afterEntry, fileText: undefined })
          dropEntry(blockTarget.id)
          pushUndo(blockTarget.sessionId, resolvedDrop,
            { id: entry.id, path: entry.path, entry: undefined, fileText: undefined })
          persistSession(true)
        }
        const reverted: DiffApprovalActionValue = fullyResolved ? { outcome: 'reverted', resolved: true } : { outcome: 'reverted' }
        return { ok: true, value: reverted }
      }
      case 'undo': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        // ONE history per LINEAGE: the key is the requester's canonical session, so a Ctrl+Z in any seat
        // of a lineage moves the same stack and `nothing` honestly means "this lineage has nothing to take
        // back". That is the point of the change, not an accident of it: a teammate's Ctrl+Z can take back
        // the root's last action, and the root's can take back a teammate's.
        const view = lineageView()
        const root = canonicalOf(sessionId, view)
        const pair = popOwnPair(undoStackOf(root), root)
        if (pair === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'nothing' }
          return { ok: true, value }
        }
        // EVERY write this undo will make is checked BEFORE the first one, under the pair's RECORDED seat:
        // a refusal anywhere means no file is touched, so a Ctrl+Z can never take back half a decision (see
        // `preflightRestore`). A refused undo leaves the pair exactly where it was — it is still takeable.
        const writes = restoreWritesOf(pair.before, pair.after)
        const refused = await preflightRestore(writes, pair.policySession, signal)
        if (refused !== undefined) {
          undoStackOf(root).push(pair)
          return restoreFailure('undo', refused.path, refused.error, { written: 0, total: writes.length, path: refused.path })
        }
        const progress: RestoreProgress = { written: 0, total: writes.length, path: pair.before.path }
        try {
          // The write policy is the pair's OWN recorded session — the seat that PERFORMED the action — never
          // the seat that popped it and never re-derived from the entry: the stack is keyed by the lineage
          // root, so any seat of that lineage may take this pair back, and a restore must not silently run
          // under a wider grant than the action did (see `DiffApprovalUndoPair.policySession`). The comment
          // scope stays the presser's for the same reason: it is the pair's own attribution.
          await restoreState(pair.policySession, pair.before, pair.after, signal, commentScopeOf(pair.pressedBy, view), progress)
        } catch (error: unknown) {
          // Keep the pair on the stack so a later, still-valid undo works.
          undoStackOf(root).push(pair)
          return restoreFailure('undo', progress.path, error, progress)
        }
        redoStackOf(root).push(pair)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'undone', id: pair.after.id }
        return { ok: true, value }
      }
      case 'redo': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const view = lineageView()
        const root = canonicalOf(sessionId, view)
        const pair = popOwnPair(redoStackOf(root), root)
        if (pair === undefined) {
          const value: DiffApprovalActionValue = { outcome: 'nothing' }
          return { ok: true, value }
        }
        // A redo re-applies what the action left, under the same RECORDED seat and through the same
        // whole-set preflight as the undo (see the undo above): a redo that would be refused anywhere
        // writes nothing at all.
        const writes = restoreWritesOf(pair.after, pair.before)
        const refused = await preflightRestore(writes, pair.policySession, signal)
        if (refused !== undefined) {
          redoStackOf(root).push(pair)
          return restoreFailure('redo', refused.path, refused.error, { written: 0, total: writes.length, path: refused.path })
        }
        const progress: RestoreProgress = { written: 0, total: writes.length, path: pair.after.path }
        try {
          await restoreState(pair.policySession, pair.after, pair.before, signal, commentScopeOf(pair.pressedBy, view), progress)
        } catch (error: unknown) {
          redoStackOf(root).push(pair)
          return restoreFailure('redo', progress.path, error, progress)
        }
        undoStackOf(root).push(pair)
        persistSession(true)
        const value: DiffApprovalActionValue = { outcome: 'redone', id: pair.after.id }
        return { ok: true, value }
      }
      case 'vcs-import': {
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const workspace = workspaceOf(sessionId)
        if (workspace === undefined) return rpcError('import unavailable: the session has no workspace')
        // Detection lives inside the import: the button is the only trigger, so
        // a workspace outside any git/svn/p4 checkout answers with no VCS found
        // rather than needing a separate probe.
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) return { ok: true, value: { imported: 0, detected: false } }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('import unavailable: the deployment has no shell executor')
        const includeUntracked = (payload as Record<string, unknown>).includeUntracked === true
        const input: VcsImportInput = {
          kind: root.kind,
          root: root.root,
          workspaceRoot: workspace.path,
          includeUntracked,
          shell,
          readText: (path) => readFile(path, 'utf8').catch(() => undefined),
          signal,
        }
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges(input)
        } catch (error: unknown) {
          return rpcError(`import failed: ${errorMessage(error)}`)
        }
        const imported = await foldBatch(sessionId, changes.map(change => ({
          id: change.path,
          sessionId,
          path: change.path,
          earlierVersion: change.earlierVersion,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: Date.now(),
          sessionIds: [sessionId],
          lineage: lineageOf(sessionId),
        })))
        const value: VcsImportValue = { imported, detected: true }
        return { ok: true, value }
      }
      case 'vcs-refresh': {
        const target = targetOf(payload)
        if (target === undefined) return rpcError('sessionId and id must be non-empty strings')
        await ensureLoaded()
        const lineage = lineageView()
        const entry = actionableEntryOf(lineage, target.sessionId, target.id)
        if (entry === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        const workspace = workspaceOf(target.sessionId)
        if (workspace === undefined) return rpcError('refresh unavailable: the session has no workspace')
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'no-vcs' }
          return { ok: true, value }
        }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('refresh unavailable: the deployment has no shell executor')
        // Scope the scan to this one file: a full workspace sweep would make a
        // per-file refresh as slow as an import on a large tree.
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges({
            kind: root.kind,
            root: root.root,
            workspaceRoot: workspace.path,
            includeUntracked: (payload as Record<string, unknown>).includeUntracked === true,
            scope: entry.path,
            shell,
            readText: (path) => readFile(path, 'utf8').catch(() => undefined),
            signal,
          })
        } catch (error: unknown) {
          return rpcError(`refresh failed: ${errorMessage(error)}`)
        }
        const change = changes.find(candidate => pathIdentity(candidate.path) === pathIdentity(entry.path))
        // Nothing to replace it with: leave the entry exactly as the review found
        // it and let the panel say so. Silently blanking the diff here would
        // discard a review in progress over a scan that simply saw no change
        // (an untracked new file, for instance, when untracked imports are off).
        if (change === undefined) {
          const value: DiffApprovalRefreshValue = { outcome: 'no-change' }
          return { ok: true, value }
        }
        if (change.earlierVersion === entry.earlierVersion && change.oldText === entry.oldText && change.newText === entry.newText) {
          const value: DiffApprovalRefreshValue = { outcome: 'unchanged' }
          return { ok: true, value }
        }
        const refreshed: PendingEntry = {
          ...entry,
          earlierVersion: change.earlierVersion,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: Date.now(),
        }
        store.restore(refreshed)
        // The reader asked for this refresh, so the row's dot goes out with it.
        store.markSeen(entry.path)
        // The refresh is undoable as one action: the entry's tracked diff moves
        // from what the review captured to what the VCS reports now. The pair belongs to the session
        // that pressed, like every other.
        pushUndo(target.sessionId,
          { id: entry.path, path: entry.path, entry, fileText: undefined },
          { id: entry.path, path: entry.path, entry: refreshed, fileText: undefined })
        persistSession(true)
        const value: DiffApprovalRefreshValue = { outcome: 'refreshed' }
        return { ok: true, value }
      }
      case 'list-path': {
        // One directory level for the panel's add-path browser. The level is
        // addressed the way `add-path` is (workspace-relative, `''` for the
        // root) so the browser and the add agree on what a row means.
        const sessionId = sessionOf(payload)
        if (sessionId === undefined) return rpcError('sessionId must be a non-empty string')
        const workspace = workspaceOf(sessionId)
        if (workspace === undefined) return rpcError('browse unavailable: the session has no workspace')
        const requested = pathFieldOf(payload) ?? ''
        const absolute = resolveInsideWorkspace(workspace.path, requested)
        if (absolute === undefined) return rpcError('browse failed: the path is outside the workspace')
        let children
        try {
          const target = await ctx.fs.resolve(absolute, { signal })
          const info = await ctx.fs.stat(target, signal)
          if (info === undefined || info.type !== 'directory') return rpcError('browse failed: not a directory')
          children = await ctx.fs.listDir(target, signal)
        } catch (error: unknown) {
          return rpcError(`browse failed: ${errorMessage(error)}`)
        }
        const entries: DiffApprovalBrowseEntry[] = []
        for (const child of children) {
          if (BROWSE_HIDDEN_NAMES.has(child.name)) continue
          const childAbsolute = resolve(absolute, child.name)
          // Confine the level to the workspace: a symlink pointing out of it must
          // not become a row the caller can add.
          if (workspaceRelativeOf(workspace.path, childAbsolute) === undefined) continue
          entries.push({
            name: child.name,
            type: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
            path: childAbsolute,
            size: child.type === 'file' ? child.size : undefined,
          })
        }
        // Directories first, then files, each name-sorted, so the browser reads
        // like a file manager instead of the backend's own order.
        entries.sort((left, right) => {
          const rank = (value: DiffApprovalBrowseEntry): number => value.type === 'directory' ? 0 : 1
          const byKind = rank(left) - rank(right)
          return byKind !== 0 ? byKind : left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        })
        const truncated = entries.length > BROWSE_ENTRY_CAP
        const value: DiffApprovalBrowseValue = {
          path: absolute,
          entries: truncated ? entries.slice(0, BROWSE_ENTRY_CAP) : entries,
          truncated,
        }
        return { ok: true, value }
      }
      case 'add-path': {
        // Add one path the user named by hand. The path is scanned the way an
        // import scans, restricted to that one file or directory subtree, so a
        // directory add is recursive by construction and a single file never
        // sweeps the workspace.
        const target = addTargetOf(payload)
        if (target === undefined) return rpcError('sessionId and path must be non-empty strings')
        const workspace = workspaceOf(target.sessionId)
        if (workspace === undefined) return rpcError('add unavailable: the session has no workspace')
        const absolute = resolveInsideWorkspace(workspace.path, target.path)
        if (absolute === undefined) {
          const value: DiffApprovalAddValue = { outcome: 'outside', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        await ensureLoaded()
        // The kind comes from `stat`, not from a read: a directory and an
        // unreadable binary file both fail `readText`, and only one of them is a
        // subtree to scan.
        let info
        try {
          const target = await ctx.fs.resolve(absolute, { signal })
          info = await ctx.fs.stat(target, signal)
        } catch (error: unknown) {
          return rpcError(`add failed: ${errorMessage(error)}`)
        }
        if (info === undefined || info.type === 'other') {
          const value: DiffApprovalAddValue = { outcome: 'missing', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        const isDirectory = info.type === 'directory'
        // A caller that named one exact file means that file, never a subtree: a path that
        // turns out to be a directory is refused here, before anything is scanned or listed.
        if (target.exact && isDirectory) {
          const value: DiffApprovalAddValue = { outcome: 'not-a-file', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        /**
         * Admit what the add found and answer the wire value. Shared by the two ways in — the
         * one file a reader named, and the scan of a path — so a named file is listed, counted
         * and identified exactly like a scanned one.
         *
         * @param candidates - the entries to admit (already built, in order).
         * @param directory - whether the named path was a directory (its own outcome wording).
         * @param cut - whether the walk hit its cap.
         * @returns the channel's answer for this add.
         */
        const admitNamed = async (
          candidates: PendingEntry[],
          directory: boolean,
          cut: boolean,
        ): Promise<{ ok: true; value: DiffApprovalAddValue }> => {
          // Already-listed paths are left exactly as they are: the panel toasts
          // that the path is in the list rather than silently re-baselining a
          // review that is already in progress.
          const listed = new Set(store.list(target.sessionId).map(entry => pathIdentity(entry.path)))
          const fresh = candidates.filter(entry => !listed.has(pathIdentity(entry.path)))
          const duplicates = candidates.length - fresh.length
          const added = await foldBatch(target.sessionId, fresh, true)
          const outcome: DiffApprovalAddOutcome = added > 0
            ? 'added'
            : duplicates > 0
              ? 'duplicate'
              // A single file that is simply clean is `unchanged` (the caller may
              // tick the box and add it anyway); a directory that contributed
              // nothing had nothing to contribute.
              : directory ? 'empty' : 'unchanged'
          // One named file's entry, so the caller can select it now rather than after the next
          // poll: the fresh one just folded, or the one that was already listed for a duplicate.
          const single = directory
            ? undefined
            : (fresh[0] ?? store.list(target.sessionId).find(entry => pathIdentity(entry.path) === pathIdentity(absolute)))
          const value: DiffApprovalAddValue = {
            outcome,
            added,
            duplicates,
            ...(single === undefined ? {} : { id: single.id }),
            ...(cut ? { truncated: true } : {}),
          }
          return { ok: true, value }
        }
        const now = Date.now()
        // One file the reader named, and nothing else: the field's job is to OPEN that file, so
        // nothing on this way in asks the VCS anything — it does not even need a VCS to exist. The
        // entry lands with both sides the file's own text, which is the "no pending diff" shape the
        // scan already produces for a file it found nothing in.
        if (target.exact) {
          // A path that is already listed is answered from the list, without reading the file:
          // naming it again is how the reader reopens it, and a duplicate is a duplicate.
          const existing = store.list(target.sessionId)
            .find(entry => pathIdentity(entry.path) === pathIdentity(absolute))
          if (existing !== undefined) return await admitNamed([existing], false, false)
          const content = await readTextOrNone(absolute, signal)
          const named: PendingEntry[] = content === undefined ? [] : [{
            id: absolute,
            sessionId: target.sessionId,
            path: absolute,
            earlierVersion: 'file',
            oldText: content,
            newText: content,
            updatedAt: now,
            sessionIds: [target.sessionId],
            lineage: lineageOf(target.sessionId),
          }]
          return await admitNamed(named, false, false)
        }
        const root = detectVcsRoot(workspace.path)
        if (root === undefined) {
          const value: DiffApprovalAddValue = { outcome: 'no-vcs', added: 0, duplicates: 0 }
          return { ok: true, value }
        }
        const shell = ctx.get('shell') as ShellExecutorLike | undefined
        if (shell === undefined) return rpcError('add unavailable: the deployment has no shell executor')
        let changes: VcsChange[]
        try {
          changes = await listVcsChanges({
            kind: root.kind,
            root: root.root,
            workspaceRoot: workspace.path,
            // Naming the path is the user's opt-in: a new file it points at is
            // wanted even while the workspace-wide import leaves untracked files
            // alone (that preference exists to bound a whole-tree scan).
            includeUntracked: true,
            scope: absolute,
            shell,
            readText: (path) => readFile(path, 'utf8').catch(() => undefined),
            signal,
          })
        } catch (error: unknown) {
          const value: DiffApprovalAddValue = { outcome: 'failed', added: 0, duplicates: 0, message: errorMessage(error) }
          return { ok: true, value }
        }
        const candidates: PendingEntry[] = changes.map(change => ({
          id: change.path,
          sessionId: target.sessionId,
          path: change.path,
          earlierVersion: change.earlierVersion,
          oldText: change.oldText,
          newText: change.newText,
          updatedAt: now,
          sessionIds: [target.sessionId],
          lineage: lineageOf(target.sessionId),
        }))
        // Ticking "include paths with no change" asks for the paths the scan did
        // not report: the named file itself, or every regular file under the named
        // directory. Each lands as a zero-diff entry — the state a file reaches
        // once every block is kept — and is undoable with the rest of the batch.
        let truncated = false
        if (target.includeUnchanged) {
          const scanned = new Set(candidates.map(entry => pathIdentity(entry.path)))
          const found = isDirectory
            ? await collectFilesUnder(await ctx.fs.resolve(absolute, { signal }), absolute, signal)
            : { files: [{ path: absolute, content: await readTextOrNone(absolute, signal) }], truncated: false }
          truncated = found.truncated
          for (const file of found.files) {
            if (file.content === undefined) continue
            if (scanned.has(pathIdentity(file.path))) continue
            scanned.add(pathIdentity(file.path))
            candidates.push({
              id: file.path,
              sessionId: target.sessionId,
              path: file.path,
              earlierVersion: 'file',
              oldText: file.content,
              newText: file.content,
              updatedAt: now,
              sessionIds: [target.sessionId],
              lineage: lineageOf(target.sessionId),
            })
          }
        }
        return await admitNamed(candidates, isDirectory, truncated)
      }
      case 'seen': {
        // The reader has this file in front of them in the panel: the row's dot goes out. Deliberately NOT
        // `open`, which launches the file with the OS — the panel's own way of opening a file is selecting
        // its row, and that is the signal this carries.
        const seen = (payload ?? {}) as Record<string, unknown>
        if (typeof seen.id !== 'string' || seen.id.length === 0) return rpcError('id must be a non-empty string')
        await ensureLoaded()
        if (store.markSeen(seen.id)) persistSession()
        return { ok: true, value: { outcome: 'seen' } }
      }
      case 'open': {
        const target = openTargetOf(payload)
        if (target === undefined) return rpcError('sessionId, id, and action must be valid')
        await ensureLoaded()
        // Guarded by the same merged view the other entry-naming actions read through, so an `open` can
        // only reach a row the requester can SEE. Without it this endpoint was the one hole in the rule:
        // a session that never had the row in its list could still launch the file AND take the row's
        // unseen dot down (`markSeen` below), which is exactly the cross-session effect the guard exists
        // to refuse. A refusal answers `missing`, the same as the other actions, so it discloses nothing
        // about a row the requester cannot see.
        const lineage = lineageView()
        let entry = actionableEntryOf(lineage, target.sessionId, target.id)
        if (entry === undefined) {
          // The list may only now have hydrated (`ensureLoaded` above is what folds it in), so the view is
          // asked once more with the same shape the actions use rather than reading absence as a refusal.
          await ensureLoaded()
          entry = actionableEntryOf(lineage, target.sessionId, target.id)
        }
        if (entry === undefined) {
          const value: DiffApprovalOpenValue = { outcome: 'missing' }
          return { ok: true, value }
        }
        // Opening the file is the reader looking at it: the row's dot goes out before the launch is even
        // attempted, because the intent to look is what the dot was waiting for.
        if (store.markSeen(entry.path)) persistSession()
        try {
          const resolved = await ctx.fs.resolve(entry.path, { signal })
          await launchPath(ctx.fs.processPath(resolved), target.action)
        } catch (error: unknown) {
          return rpcError(`${target.action} failed: ${errorMessage(error)}`)
        }
        const value: DiffApprovalOpenValue = { outcome: 'opened' }
        return { ok: true, value }
      }
      case 'preview-image': {
        const image = previewImageTargetOf(payload)
        if (image === undefined) return rpcError('sessionId and path must be valid')
        await ensureLoaded()
        // Inline one workspace image for the Markdown preview. Reads are confined
        // to the session's workspace: a reference that resolves outside it (a
        // `..` escape, an absolute path elsewhere, or a different workspace) is
        // refused, and an absent/unreadable file answers with no data URI.
        const workspace = workspaceOf(image.sessionId)
        if (workspace === undefined) return rpcError('image unavailable: the session has no workspace')
        let dataUri: string | undefined
        try {
          const target = await ctx.fs.resolve(image.path, { signal })
          const workspaceTarget = await ctx.fs.resolve(workspace.path, {})
          const osPath = ctx.fs.processPath(target)
          const workspaceOs = ctx.fs.processPath(workspaceTarget)
          const inside = relative(workspaceOs, osPath)
          if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
            const bytes = await readFile(osPath)
            if (bytes.length > 0) dataUri = `data:${imageMimeOf(osPath)};base64,${bytes.toString('base64')}`
          }
        } catch {
          // Unresolvable, outside the workspace, or unreadable: leave it undefined.
        }
        const value: DiffApprovalPreviewImageValue = { dataUri }
        return { ok: true, value }
      }
      default:
        return rpcError(`unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  }

  // Mount the review channel. `register` is preferred so the registration owner
  // is this plugin's own context — the one that injects `webServer` (see
  // `ConnectionServiceSurface`). `rpc.handle` stays as the fallback for a build
  // that no longer exposes `register`. The trust policy rides along because the
  // 0.1.0 line reads it from the options argument.
  ctx.effect(() => {
    const service = ctx.connection as unknown as ConnectionServiceSurface
    return typeof service.register === 'function'
      ? service.register(ctx, DIFF_APPROVAL_CHANNEL, handle, { authority: 'trusted-host' })
      : service.rpc.handle(DIFF_APPROVAL_CHANNEL, handle, { authority: 'trusted-host' })
  }, 'diff-approval: review channel')

  // Serve the bundled code font's slices. The panel asks for a family whose one
  // CJK glyph is exactly twice one Latin glyph, and the files that back it ship
  // with the plugin: a CDN is not an option (Google Fonts is unreachable in
  // mainland China, and a handful of sliced woff2 files is not what any font CDN
  // distributes) and asking the reader to install a font is not one either.
  ctx.effect(() => {
    const route = fontRoute((message) => ctx.logger.warn(message))
    const server = ctx.get('webServer') as WebServerSurface | undefined
    if (typeof server?.register !== 'function') {
      ctx.logger.debug('diff-approval: no web server, so the bundled code font is not served')
      return () => {}
    }
    return server.register(route)
  }, 'diff-approval: code font slices')

  // Observe the mutation intent seams without owning the decision: capture
  // the pre-write basis, then hand the chain on untouched so policy plugins
  // and the tool's default remain in charge. `prepend` matters: the harness
  // policy occupies these single-slot waterfalls and never calls `next()`, so
  // a later-registered listener would never run.
  ctx.effect(() => ctx.on('fs/edit-intent', async (target, actor, next) => {
    await stashEditorIntent(target, actor, 'file')
    return next()
  }, { prepend: true }), 'diff-approval: str_replace_editor edit basis')
  ctx.effect(() => ctx.on('fs/write-intent', async (target, actor, next) => {
    await stashEditorIntent(target, actor, 'none')
    return next()
  }, { prepend: true }), 'diff-approval: str_replace_editor create basis')
}

/** One mutation's basis captured at its intent seam. */
interface IntentBasis {
  target: FsTarget
  earlierVersion: PendingEntryKind
  before: string
  sessionId: SessionId | undefined
}

/** Narrow a wire payload's `sessionId` field to a branded session id. */
function sessionOf(payload: unknown): SessionId | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as Record<string, unknown>).sessionId
  return typeof value === 'string' && value.length > 0 ? SessionId(value) : undefined
}

/** The content lines of `text`, matching the diff's line numbering (a single
    trailing newline is a terminator, not an extra empty line). */
function contentLinesOf(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Rebuild text from content lines, keeping `original`'s trailing-newline convention. */
function fromContentLines(original: string, lines: string[]): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + (original.endsWith('\n') ? '\n' : '')
}

/** The content lines [start..end] (1-based inclusive) of `text`; empty when start > end. */
function contentRangeOf(text: string, start: number, end: number): string[] {
  if (start > end) return []
  return contentLinesOf(text).slice(start - 1, end)
}

/**
 * Replace the content lines [start..end] (1-based) of `text` with `replacement`
 * lines. An empty range (`start > end`) inserts before line `start`. Out-of-range
 * bounds clamp; the trailing-newline convention of `text` is preserved.
 */
function replaceContentLines(text: string, start: number, end: number, replacement: string[]): string {
  const lines = contentLinesOf(text)
  const count = lines.length
  if (start > end) {
    const at = Math.min(Math.max(start, 1), count + 1)
    return fromContentLines(text, [...lines.slice(0, at - 1), ...replacement, ...lines.slice(at - 1)])
  }
  const s = Math.min(Math.max(start, 1), count + 1)
  const e = Math.min(Math.max(end, 1), count)
  if (s > e) return text
  return fromContentLines(text, [...lines.slice(0, s - 1), ...replacement, ...lines.slice(e)])
}

/** Narrow a wire payload to one block keep/revert target. */
function blockTargetOf(payload: unknown): DiffApprovalBlockTarget | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const block = (payload as Record<string, unknown>).block
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return undefined
  const { oldStart, oldEnd, newStart, newEnd } = block as Record<string, unknown>
  const numbers = [oldStart, oldEnd, newStart, newEnd]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined
  const removeWhenResolved = (payload as Record<string, unknown>).removeWhenResolved
  return {
    ...target,
    block: { oldStart, oldEnd, newStart, newEnd } as DiffApprovalBlockTarget['block'],
    removeWhenResolved: typeof removeWhenResolved === 'boolean' ? removeWhenResolved : undefined,
  }
}

/** Narrow a wire payload to one keep/revert target. */
function targetOf(payload: unknown): { sessionId: SessionId; id: string } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const id = (payload as Record<string, unknown>).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  return { sessionId, id }
}

/**
 * Narrow a wire payload to one keep/revert over a PICK of files: one session, the files to act on, and
 * whether the resolved ones stay listed.
 *
 * The ids are all-or-nothing, like the pick itself: a payload with one unusable id is not a pick, so the
 * whole request is refused rather than half-honoured (the ids themselves are still only acted on where
 * they exist, which is the endpoint's business). A repeated id names one file, so it is kept once.
 *
 * @param payload - the wire payload.
 * @returns the request, or undefined when it is not one.
 */
function manyTargetsOf(payload: unknown): { sessionId: SessionId; ids: string[]; keepListed: boolean | undefined } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const ids = record.ids
  if (!Array.isArray(ids) || ids.length === 0) return undefined
  const wanted: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    if (!wanted.includes(id)) wanted.push(id)
  }
  return { sessionId, ids: wanted, keepListed: record.keepListed === true ? true : undefined }
}

/**
 * Narrow a wire payload to one batch comment removal: one session, and the comments to drop.
 *
 * The ids are all-or-nothing: a payload with one unusable id is not a batch, so the whole request
 * is refused rather than half-honoured (the ids themselves are still only dropped where they exist,
 * which is `CommentStore.removeMany`'s business). A repeated id names one comment, so it is kept once.
 *
 * @param payload - the wire payload.
 * @returns the request, or undefined when it is not one.
 */
function commentRemoveManyOf(payload: unknown): { sessionId: SessionId; ids: string[] } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const ids = (payload as Record<string, unknown>).ids
  if (!Array.isArray(ids) || ids.length === 0) return undefined
  const wanted: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    if (!wanted.includes(id)) wanted.push(id)
  }
  return { sessionId, ids: wanted }
}

/**
 * Narrow a wire payload to one comment-ask request: a target, the prompt to send, and the
 * reader's own words that prompt wraps.
 *
 * Both strings are required. The prompt is what the agent is asked; `text` is what the
 * thread shows as the question, and it cannot be recovered from the prompt (which carries
 * the marker, the reference and the rules around it) — a request without it would store a
 * question nobody can read, so it is refused instead.
 *
 * @param payload - the wire payload.
 * @returns the request, or undefined when it is not one.
 */
function commentAskOf(payload: unknown): { sessionId: SessionId; id: string; prompt: string; text: string } | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  const record = payload as Record<string, unknown>
  const prompt = record.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return undefined
  const text = record.text
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  return { ...target, prompt, text }
}

/** One comment-add request, narrowed from the wire. */
interface CommentAddInput {
  sessionId: SessionId
  /** An id the caller supplied, so a retry after a dropped response is the same comment. */
  id: string | undefined
  entryId: string
  anchor: CommentAnchor
  quote: string
  quoteContext: string | undefined
  quoteLines: CommentQuoteLine[] | undefined
  text: string
}

/**
 * Narrow a wire payload to one comment-add request.
 *
 * The display path is deliberately NOT read from the wire: the entry a comment
 * hangs off is the authority on what that file is called, so a client cannot pin a
 * comment to a path the list disagrees with.
 *
 * @param payload - the request body.
 * @returns the narrowed request, or `undefined` when a required field is missing.
 */
function commentAddOf(payload: unknown): CommentAddInput | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  const { entryId, anchor, quote, text } = body
  if (typeof entryId !== 'string' || entryId.length === 0) return undefined
  if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) return undefined
  const { startLine, endLine } = anchor as Record<string, unknown>
  if (typeof startLine !== 'number' || !Number.isFinite(startLine)) return undefined
  if (typeof endLine !== 'number' || !Number.isFinite(endLine)) return undefined
  if (typeof quote !== 'string') return undefined
  // An annotation with nothing in it is not a comment; the reader's own panel refuses to
  // send one, so a blank here is a broken caller rather than an empty thread to store.
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  const id = body.id
  const quoteContext = body.quoteContext
  const quoteLines: CommentQuoteLine[] = []
  if (Array.isArray(body.quoteLines)) {
    for (const line of body.quoteLines) {
      if (typeof line !== 'object' || line === null || Array.isArray(line)) continue
      const { old, new: side, kind } = line as Record<string, unknown>
      quoteLines.push({
        ...(typeof old === 'number' && Number.isFinite(old) ? { old } : {}),
        ...(typeof side === 'number' && Number.isFinite(side) ? { new: side } : {}),
        ...(kind === 'add' || kind === 'del' || kind === 'context' ? { kind } : {}),
      })
    }
  }
  return {
    sessionId,
    id: typeof id === 'string' && id.length > 0 ? id : undefined,
    entryId,
    anchor: { startLine, endLine },
    quote,
    quoteContext: typeof quoteContext === 'string' && quoteContext !== '' ? quoteContext : undefined,
    quoteLines: quoteLines.length > 0 ? quoteLines : undefined,
    text,
  }
}

/** Narrow a wire payload to one preview-image target. */
function previewImageTargetOf(payload: unknown): { sessionId: SessionId; path: string } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const path = (payload as Record<string, unknown>).path
  if (typeof path !== 'string' || path.length === 0) return undefined
  return { sessionId, path }
}

/** One payload's optional `path` field; absent (or not a string) is undefined. */
function pathFieldOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const path = (payload as Record<string, unknown>).path
  return typeof path === 'string' ? path : undefined
}

/** Narrow a wire payload to one hand-added path. */
function addTargetOf(payload: unknown):
{ sessionId: SessionId; path: string; includeUnchanged: boolean; exact: boolean } | undefined {
  const sessionId = sessionOf(payload)
  if (sessionId === undefined) return undefined
  const path = pathFieldOf(payload)?.trim()
  if (path === undefined || path === '') return undefined
  const record = payload as Record<string, unknown>
  return {
    sessionId,
    path,
    includeUnchanged: record.includeUnchanged === true,
    exact: record.exact === true,
  }
}

/** Narrow a wire payload to one open target: the keep/revert pair plus the action. */
function openTargetOf(payload: unknown): { sessionId: SessionId; id: string; action: OpenAction } | undefined {
  const target = targetOf(payload)
  if (target === undefined) return undefined
  const action = (payload as Record<string, unknown>).action
  if (action !== 'open' && action !== 'reveal') return undefined
  return { ...target, action }
}

/**
 * The `webServer` surface this plugin uses: one prefix route whose handler owns
 * the whole response. Structural on purpose — the service ships with the web
 * bundle, and a non-web composition (Electron, the SDK profile) has neither, so
 * the font is simply not served there and the panel keeps the system stack.
 */
interface WebServerSurface {
  register(route: { kind: 'prefix'; path: string; handler: (req: WebServerRequest, res: WebServerResponse) => void | Promise<void> }): () => void
}

/** The parts of node's request the font handler reads. */
interface WebServerRequest {
  readonly url?: string | undefined
  readonly method?: string | undefined
}

/** The parts of node's response the font handler writes. */
interface WebServerResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: Uint8Array | string): unknown
}

/** The font slices the host is willing to serve, read once from the manifest. */
let fontSlicesPromise: Promise<Map<string, FontSlice> | undefined> | undefined

/** Read `assets/fonts/manifest.json` next to the built bundle. */
async function loadFontSlices(): Promise<Map<string, FontSlice> | undefined> {
  try {
    const dir = fileURLToPath(new URL(FONT_ASSET_DIR, import.meta.url))
    const text = await readFile(join(dir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(text) as { slices?: FontSlice[] }
    const slices = new Map<string, FontSlice>()
    for (const slice of manifest.slices ?? []) slices.set(slice.file, slice)
    return slices
  } catch {
    return undefined
  }
}

/**
 * The manifest, cached for the life of the host — but only once it has been
 * read. A missing `assets/fonts` is deliberately not cached: a deployment that
 * puts the assets beside a running bundle (a profile reinstall after the
 * package's file list grew) starts serving slices on the next request instead
 * of needing a restart, at the cost of one failed read per request until then.
 */
async function fontSlices(): Promise<Map<string, FontSlice> | undefined> {
  if (fontSlicesPromise === undefined) {
    const pending = loadFontSlices()
    fontSlicesPromise = pending
    const slices = await pending
    if (slices === undefined) fontSlicesPromise = undefined
    return slices
  }
  return fontSlicesPromise
}

/**
 * Drop the cached slice list, so the next request reads the manifest again.
 *
 * The cache exists so a served page costs one read, which makes it state that
 * outlives a test: tests that need the "no manifest" path call this between
 * cases. Nothing in the app calls it.
 */
export function resetFontSlicesForTests(): void {
  fontSlicesPromise = undefined
}

/**
 * Answer one font request. Exported so the route's behaviour is testable
 * without a listening server: the manifest itself is answered from the parsed
 * list, only files that list names are ever read, and everything else —
 * including a path traversal attempt — is a 404.
 *
 * @param req - the request, for its path.
 * @param res - the response, whose lifecycle this owns.
 * @param nominate - how to report a missing manifest, called at most once per
 *   route by {@link fontRoute}. Without the manifest every slice is a 404, and
 *   that is a deployment problem the reader cannot see from the panel: the
 *   switch is on, the font is simply absent, and nothing else says why.
 */
export async function serveFontSlice(
  req: WebServerRequest,
  res: WebServerResponse,
  nominate?: (message: string) => void,
): Promise<void> {
  const slices = await fontSlices()
  if (slices === undefined) {
    nominate?.(
      `diff-approval: no code-font manifest at ${join(fileURLToPath(new URL(FONT_ASSET_DIR, import.meta.url)), 'manifest.json')}, ` +
      'so the bundled font cannot be served (reinstall the plugin so its assets arrive, then restart the host)',
    )
    res.statusCode = 404
    res.end('font unavailable')
    return
  }
  const name = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').split('/').pop() ?? ''
  // The client's first request, and the only one that tells it which slices the
  // bundled face has and what unicode-range each covers. Built from the parsed
  // map rather than from the file, so the list a reader receives is exactly the
  // set this route will serve; the two cannot drift.
  if (name === 'manifest.json') {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    // The client re-reads it on every page load, and a plugin upgrade changes it.
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({
      slices: [...slices.values()].map(({ file, unicodeRange, weight }) => ({ file, unicodeRange, weight })),
    }))
    return
  }
  const slice = slices.get(name)
  if (slice === undefined || !/^[a-z]+-[a-z0-9-]*\.woff2$/.test(name)) {
    res.statusCode = 404
    res.end('no such font slice')
    return
  }
  try {
    const path = join(fileURLToPath(new URL(FONT_ASSET_DIR, import.meta.url)), slice.file)
    const info = await stat(path)
    const body = await readFile(path)
    res.statusCode = 200
    res.setHeader('content-type', 'font/woff2')
    res.setHeader('content-length', String(info.size))
    // The file name carries the face and the slice; a rebuild that changes a
    // slice changes the bytes the manifest pins, and the panel re-reads the
    // manifest on every page load, so a long cache is safe for the files.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('font slice missing')
  }
}

/**
 * The route serving the bundled font.
 *
 * @param warn - where the once-per-route "no manifest beside the bundle" line
 *   goes. It is the only signal a reader's switch gives when the deployment,
 *   not the switch, is what is missing.
 * @returns the prefix route.
 */
export function fontRoute(warn: (message: string) => void): { kind: 'prefix'; path: string; handler: (req: WebServerRequest, res: WebServerResponse) => Promise<void> } {
  let reported = false
  return {
    kind: 'prefix',
    path: FONT_ROUTE,
    handler: (req, res) => serveFontSlice(req, res, (message) => {
      if (reported) return
      reported = true
      warn(message)
    }),
  }
}
