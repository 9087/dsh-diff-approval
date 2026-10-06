/**
 * "Is a newer release published?" — the host's half of the panel's update notice.
 *
 * The check lives on the host because the browser cannot make it: `registry.npmjs.org`
 * sends no CORS header, and only the host knows which version of this package is
 * actually installed (it reads its own `package.json`). The client asks once through
 * this plugin's existing channel and renders whatever comes back.
 *
 * Everything here FAILS SOFT: a timeout, a refused connection, a registry answer that
 * is not JSON, a package with no `version` — all of them end as `undefined`, never as a
 * throw. A reader on a plane must not see a network error in their review panel, and the
 * panel must never wait on this to draw.
 *
 * The dialog shows NOTHING but the versions and a button, so this module asks for nothing
 * but the version: there is no changelog to slice and no URL to hand over.
 *
 * @module dsh-diff-approval/version
 */

import { readFile } from 'node:fs/promises'
import type { DiffApprovalUpdateValue } from './types.ts'

/** The published name this check asks the registry about. */
export const UPDATE_PACKAGE = 'dsh-diff-approval'
/** The registry's "latest" document for this package: `{ version, … }`. */
export const UPDATE_REGISTRY = 'https://registry.npmjs.org/dsh-diff-approval/latest'
/**
 * How long the request may take. Short on purpose: this is a nicety in a status bar,
 * and the client-side request is issued in the background — but the host's own worker
 * should not be held by a hanging socket either.
 */
export const UPDATE_TIMEOUT_MS = 3000
/**
 * How long a registry answer may be reused before asking again: TEN MINUTES.
 *
 * The cache exists for the network cost of the REMOTE answer only (see {@link createUpdateCheck}), so this is
 * the one staleness a reader can be shown. Ten minutes because a release cadence is measured in days: the
 * figure is far shorter than any release gap, so a genuinely new release reaches an already-running host
 * without a restart, and far longer than a page load, so reloading a page — or opening a second seat — does
 * not hammer a public registry. It is deliberately NOT permanent: the process-lifetime memo this replaced
 * kept serving a verdict computed before an upgrade, which is exactly how a reader saw "a new version" for a
 * version they had already installed.
 */
export const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000

/** A parsed `major.minor.patch`. */
export type Version = readonly [number, number, number]

/** One HTTP answer, as much of it as this module reads. */
export interface FetchResponseFace {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** The one call this module makes on the network, injected so tests need no socket. */
export type FetchFace = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponseFace>

/** Where to ask, and how. Every field has a production default. */
export interface UpdateProbe {
  /** Registry `latest` document. */
  registryUrl?: string
  /** Per-request budget, in ms. */
  timeoutMs?: number
  /** The transport; defaults to the runtime's global `fetch`. */
  fetchImpl?: FetchFace
}

/** How {@link createUpdateCheck} reads and asks; every field has a production default. */
export interface UpdateCheckOptions {
  /** The manifest the INSTALLED version is read from; the package's own `package.json` by default. */
  manifestUrl?: URL
  /** Registry `latest` document. */
  registryUrl?: string
  /** Per-request budget, in ms. */
  timeoutMs?: number
  /** The transport; defaults to the runtime's global `fetch`. */
  fetchImpl?: FetchFace
  /** How long a fetched registry answer may be reused, in ms; {@link UPDATE_CACHE_TTL_MS} by default. */
  ttlMs?: number
  /**
   * The clock, in ms since the epoch; `Date.now` by default. Injected so a test can age the cached REMOTE
   * answer without waiting ten real minutes — the TTL is the one thing here a test cannot otherwise reach.
   */
  now?: () => number
}

/**
 * Parse `major.minor.patch`, and NOTHING else.
 *
 * Deliberately strict, because the alternative is a bogus "newer": a pre-release
 * (`0.31.0-rc.1`), a range (`^0.31.0`), a dist-tag (`latest`) or a stray suffix all
 * answer `undefined`, and an unparsable side of a comparison is never allowed to look
 * newer. A leading `v` is tolerated because tags carry one.
 *
 * @param text - the candidate, from a registry document or a `package.json`.
 * @returns the three numbers, or `undefined` when the text is not exactly that shape.
 */
export function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(text.trim())
  if (match === null) return undefined
  // The regex allows leading zeros; `Number` normalizes them, and a version whose parts
  // overflow a float is not a version anyone published.
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (parts.some(part => !Number.isSafeInteger(part))) return undefined
  return parts
}

/**
 * Is `latest` strictly newer than `current`?
 *
 * Strictly: equal versions are NOT newer, and neither side parsing means NOT newer —
 * the rule the code above exists to make safe. Comparison is component-wise on the
 * three numbers, so `0.9.0` precedes `0.10.0` (string comparison would get that wrong).
 *
 * @param latest - the published version.
 * @param current - the installed version.
 * @returns whether a notice is warranted.
 */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  const next = parseVersion(latest)
  const here = parseVersion(current)
  if (next === undefined || here === undefined) return false
  return compareVersions(next, here) > 0
}

/**
 * Compare two already-parsed versions.
 *
 * Component-wise, because a string comparison gets `0.9.0` vs `0.10.0` wrong — the reason both
 * callers go through here rather than comparing something textual.
 *
 * @param left - one version.
 * @param right - the other.
 * @returns negative, zero or positive, as a comparator should.
 */
export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!
  }
  return 0
}

/**
 * The version installed in this package, read from the `package.json` beside the built
 * `lib/` — the only authority on what the reader is running, and the value the registry
 * answer is compared against.
 *
 * Resolved relative to this module, so it holds for the bundled `lib/index.js`
 * (`../package.json` is the package root) and for the source under test (`../package.json`
 * is the repository root) alike.
 *
 * @param manifestUrl - the manifest to read; the package's own `package.json` unless a caller
 *   says otherwise. It is a parameter because a test runner can serve modules over a non-file
 *   URL, where the default cannot be resolved — the production path is the default, and the
 *   end-to-end case is what proves the default itself.
 * @returns the version, or `undefined` when the file is missing or has none.
 */
export async function installedVersion(
  manifestUrl: URL = new URL('../package.json', import.meta.url),
): Promise<string | undefined> {
  try {
    const text = await readFile(manifestUrl, 'utf8')
    const document = JSON.parse(text) as { version?: unknown }
    return typeof document.version === 'string' && document.version.length > 0 ? document.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the registry for the published version.
 *
 * @param probe - where to ask and how; every field defaults (see {@link UpdateProbe}).
 * @returns the version, or `undefined` on any failure — including an answer that is not
 *   a version, which must never become a notice.
 */
export async function fetchLatestVersion(probe: UpdateProbe = {}): Promise<string | undefined> {
  const body = await fetchText(probe.registryUrl ?? UPDATE_REGISTRY, probe)
  if (body === undefined) return undefined
  try {
    const document = JSON.parse(body) as { version?: unknown }
    return parseVersion(document.version) === undefined ? undefined : String(document.version)
  } catch {
    return undefined
  }
}

/**
 * Build the answer behind the `update-check` endpoint: one function a host calls per request.
 *
 * WHAT IS CACHED, AND FOR HOW LONG — the whole point of this factory:
 *
 * - The REMOTE answer (the registry's latest version) is cached, because that is the network cost. It is held
 *   for {@link UPDATE_CACHE_TTL_MS} and then fetched again, so a release published while the host is running
 *   still reaches the reader without a restart. A FAILED fetch is not cached at all: remembering a failure
 *   would hide the notice for the whole TTL after one offline moment, and there is no network cost to save.
 * - The INSTALLED version is read from the manifest on EVERY call. It is a file read, not a request, and it is
 *   the side that changes when the reader upgrades — so a verdict computed before that upgrade must never be
 *   replayed. Caching it was a real defect: a host that answered while an older version was installed kept
 *   announcing "a newer release" to every page until it was restarted.
 *
 * `newer` is therefore decided afresh on every call, from today's manifest against the cached registry answer.
 * NEVER THROWS: every failure — no manifest, an unreachable registry, a nonsense answer — ends as "nothing to
 * say" (`newer: false`), so a network problem can never become an error in the reader's status bar.
 *
 * @param options - where to read and how; every field defaults (see {@link UpdateCheckOptions}).
 * @returns the check itself; call it as often as you like.
 */
export function createUpdateCheck(options: UpdateCheckOptions = {}): () => Promise<DiffApprovalUpdateValue> {
  const ttl = options.ttlMs ?? UPDATE_CACHE_TTL_MS
  const now = options.now ?? ((): number => Date.now())
  const probe: UpdateProbe = {
    ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }
  const manifestUrl = options.manifestUrl ?? new URL('../package.json', import.meta.url)
  /** The cached REMOTE answer, with the moment it was fetched. */
  let remote: { version: string; at: number } | undefined
  return async (): Promise<DiffApprovalUpdateValue> => {
    const current = await installedVersion(manifestUrl)
    if (current === undefined) return { current: '', newer: false }
    const at = now()
    if (remote === undefined || at - remote.at >= ttl) {
      const fetched = await fetchLatestVersion(probe)
      // A version is cached; a failure is not (see the note above).
      if (fetched !== undefined) remote = { version: fetched, at }
    }
    const latest = remote?.version
    if (latest === undefined || !isNewerVersion(latest, current)) {
      return { current, ...(latest === undefined ? {} : { latest }), newer: false }
    }
    return { current, latest, newer: true }
  }
}

/** One `GET`, with the module's timeout, mapping every failure to `undefined`. */
async function fetchText(url: string, probe: UpdateProbe): Promise<string | undefined> {
  const implementation = probe.fetchImpl ?? (globalThis as { fetch?: FetchFace }).fetch
  if (implementation === undefined) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, probe.timeoutMs ?? UPDATE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await implementation(url, {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain, */*' },
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
