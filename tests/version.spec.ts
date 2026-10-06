// The host's half of the "newer version" notice, without a socket: the parse, the comparison, the
// registry fetch fed by a stub transport, and the check's own cache policy.
//
// The rules pinned here are the ones a reader would notice being wrong: a pre-release or a dist-tag
// must never make the panel claim a newer release exists, an offline host must answer "nothing to
// show" rather than throwing into the status bar, and a verdict must never outlive the version it
// was computed from.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_CACHE_TTL_MS, compareVersions, createUpdateCheck, fetchLatestVersion, installedVersion, isNewerVersion,
  parseVersion,
} from '../src/version.ts'
import type { FetchFace, FetchResponseFace } from '../src/version.ts'

/** One stub answer: what the transport returns for any URL. */
function answer(body: string, ok = true): FetchFace {
  return async (): Promise<FetchResponseFace> => ({ ok, status: ok ? 200 : 500, text: async () => body })
}

describe('parseVersion', () => {
  it('reads exactly three numbers, and tolerates the v a tag carries', () => {
    expect(parseVersion('0.30.1')).toEqual([0, 30, 1])
    expect(parseVersion('v0.30.1')).toEqual([0, 30, 1])
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('refuses everything that is not that shape, so none of it can look newer', () => {
    // A pre-release, a range, a dist-tag, a two-part version, a number, nothing at all.
    for (const text of ['0.31.0-rc.1', '^0.31.0', 'latest', '0.31', '0.31.0.1', '', ' ', 3, undefined, null]) {
      expect(parseVersion(text), `${JSON.stringify(text)} must not parse`).toBeUndefined()
    }
  })

  it('normalizes leading zeros rather than refusing them', () => {
    expect(parseVersion('00.01.002')).toEqual([0, 1, 2])
  })
})

describe('isNewerVersion', () => {
  it('is strict, and component-wise rather than textual', () => {
    expect(isNewerVersion('0.30.2', '0.30.1')).toBe(true)
    expect(isNewerVersion('0.31.0', '0.30.9')).toBe(true)
    // The pair a string comparison gets wrong.
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
  })

  it('is false for equal, older, and either side unparsable', () => {
    expect(isNewerVersion('0.30.1', '0.30.1')).toBe(false)
    expect(isNewerVersion('0.30.0', '0.30.1')).toBe(false)
    expect(isNewerVersion('0.31.0-rc.1', '0.30.1')).toBe(false)
    expect(isNewerVersion('0.31.0', 'not-a-version')).toBe(false)
    expect(isNewerVersion(undefined, '0.30.1')).toBe(false)
  })

  it('orders parsed versions the same way', () => {
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0)
    expect(compareVersions([0, 9, 0], [0, 10, 0])).toBeLessThan(0)
    expect(compareVersions([0, 30, 1], [0, 30, 1])).toBe(0)
  })
})

describe('the registry fetch', () => {
  it('reads the registry version, and refuses an answer that is not one', async () => {
    expect(await fetchLatestVersion({ fetchImpl: answer('{"version":"0.31.0"}') })).toBe('0.31.0')
    expect(await fetchLatestVersion({ fetchImpl: answer('{"version":"0.31.0-rc.1"}') })).toBeUndefined()
    expect(await fetchLatestVersion({ fetchImpl: answer('{"name":"x"}') })).toBeUndefined()
    expect(await fetchLatestVersion({ fetchImpl: answer('not json') })).toBeUndefined()
  })

  it('answers undefined for every failure, and never rejects', async () => {
    // A refused request, a transport that throws, and a host with no fetch at all.
    expect(await fetchLatestVersion({ fetchImpl: answer('nope', false) })).toBeUndefined()
    const throwing: FetchFace = async () => { throw new Error('ECONNREFUSED') }
    expect(await fetchLatestVersion({ fetchImpl: throwing })).toBeUndefined()
    await expect(fetchLatestVersion({ fetchImpl: throwing })).resolves.toBeUndefined()
  })

  it('gives up on its own timeout instead of holding the answer forever', async () => {
    // A transport that only ever settles when the signal aborts: the module's own timer is the abort.
    const hanging: FetchFace = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const started = Date.now()
    await expect(fetchLatestVersion({ fetchImpl: hanging, timeoutMs: 20 })).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('asks the URL it was given, so a test can point it somewhere else', async () => {
    const seen: string[] = []
    const spy: FetchFace = async (url) => {
      seen.push(url)
      return { ok: true, status: 200, text: async () => '{"version":"9.9.9"}' }
    }
    expect(await fetchLatestVersion({ fetchImpl: spy, registryUrl: 'http://127.0.0.1:1/stub' })).toBe('9.9.9')
    expect(seen).toEqual(['http://127.0.0.1:1/stub'])
  })
})

describe('installedVersion', () => {
  it('reads this package\'s own version, which is what the comparison is against', async () => {
    // The manifest is passed explicitly: a test runner serves this module over an `http` URL, where the
    // module's own `../package.json` default cannot be resolved. The DEFAULT is what production uses, and
    // the end-to-end case is what proves it (the real host answers with the installed version).
    const manifestUrl = pathToFileURL(resolve(process.cwd(), 'package.json'))
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version: string }
    expect(await installedVersion(manifestUrl)).toBe(manifest.version)
    // And that version is parseable, so the comparison has something real on both sides.
    expect(parseVersion(manifest.version)).toBeDefined()
    // A manifest that cannot be read answers undefined rather than throwing.
    expect(await installedVersion(pathToFileURL(resolve(process.cwd(), 'no-such-manifest.json')))).toBeUndefined()
  })
})

describe('the module never throws on a bad day', () => {
  it('answers undefined even when the transport itself misbehaves', async () => {
    // `text()` rejecting is the odd case a fetch wrapper can produce: still no throw outward.
    const broken: FetchFace = async (): Promise<FetchResponseFace> => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error('stream died')),
    })
    await expect(fetchLatestVersion({ fetchImpl: broken })).resolves.toBeUndefined()
  })
})

describe('createUpdateCheck', () => {
  /**
   * A manifest in a temp directory, with a rewrite between calls.
   *
   * The INSTALLED side is read from a real FILE on every call, and that is exactly what this pins: the file is
   * rewritten rather than the reader stubbed, so a check that remembered the old value cannot pass.
   */
  function manifestDir(initial: string): { url: URL; write: (version: string) => void; clean: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-update-check-'))
    const path = join(dir, 'package.json')
    const write = (version: string): void => { writeFileSync(path, JSON.stringify({ name: 'x', version })) }
    write(initial)
    return { url: pathToFileURL(path), write, clean: () => { rmSync(dir, { recursive: true, force: true }) } }
  }

  it('documents the caching window as a finite ten minutes', () => {
    // The figure is part of the contract (a release appears without a restart), so it is pinned.
    expect(UPDATE_CACHE_TTL_MS).toBe(600_000)
    expect(Number.isFinite(UPDATE_CACHE_TTL_MS), 'a permanent cache was the defect').toBe(true)
  })

  it('reads the installed version EVERY call, and only the registry answer from the cache', async () => {
    const manifest = manifestDir('0.30.0')
    try {
      // A clock the test owns: the TTL is otherwise ten real minutes away.
      let clock = 1_000_000
      let fetches = 0
      const check = createUpdateCheck({
        manifestUrl: manifest.url,
        registryUrl: 'http://127.0.0.1:1/stub',
        now: () => clock,
        fetchImpl: async (): Promise<FetchResponseFace> => {
          fetches += 1
          return { ok: true, status: 200, text: async () => '{"version":"0.30.1"}' }
        },
      })

      // FIRST: the installed version decides against the registry's answer.
      expect(await check()).toEqual({ current: '0.30.0', latest: '0.30.1', newer: true })
      expect(fetches).toBe(1)

      // The manifest changes UNDER the running check — the reader upgraded, or a demo scaffold was taken away.
      // The next call must use the new value and flip `newer`, without asking the registry again.
      manifest.write('0.30.1')
      expect(await check(), 'the new installed version must be read, not remembered')
        .toEqual({ current: '0.30.1', latest: '0.30.1', newer: false })
      expect(fetches, 'the REMOTE answer is still the cached one').toBe(1)

      // And the other direction: something installed NEWER than the registry's latest is not "a new release".
      manifest.write('0.31.0')
      expect(await check()).toEqual({ current: '0.31.0', latest: '0.30.1', newer: false })
      expect(fetches).toBe(1)

      // THE TTL: the clock (not a sleep) leaves the window, so the registry is asked once more.
      clock += UPDATE_CACHE_TTL_MS
      manifest.write('0.30.1')
      expect(await check()).toEqual({ current: '0.30.1', latest: '0.30.1', newer: false })
      expect(fetches, 'the remote answer is refetched after the TTL').toBe(2)
    } finally {
      manifest.clean()
    }
  })

  it('does not remember a FAILED registry answer, and never throws', async () => {
    const manifest = manifestDir('0.30.0')
    try {
      let fetches = 0
      const check = createUpdateCheck({
        manifestUrl: manifest.url,
        registryUrl: 'http://127.0.0.1:1/stub',
        now: () => 0,
        fetchImpl: async (): Promise<FetchResponseFace> => {
          fetches += 1
          throw new Error('ECONNREFUSED')
        },
      })
      // A failure answers "nothing to say"…
      await expect(check()).resolves.toEqual({ current: '0.30.0', newer: false })
      // …and is NOT cached: remembering it would hide the notice for the whole TTL after one offline moment.
      await expect(check()).resolves.toEqual({ current: '0.30.0', newer: false })
      expect(fetches, 'a failure is retried, not remembered').toBe(2)
    } finally {
      manifest.clean()
    }
  })

  it('answers "nothing to say" when the manifest itself cannot be read, and does not ask at all', async () => {
    let fetches = 0
    const check = createUpdateCheck({
      manifestUrl: pathToFileURL(join(tmpdir(), 'no-such-manifest-for-the-update-check.json')),
      registryUrl: 'http://127.0.0.1:1/stub',
      now: () => 0,
      fetchImpl: async (): Promise<FetchResponseFace> => {
        fetches += 1
        return { ok: true, status: 200, text: async () => '{"version":"9.9.9"}' }
      },
    })
    await expect(check()).resolves.toEqual({ current: '', newer: false })
    expect(fetches, 'a host that does not know its own version has nothing to compare').toBe(0)
  })
})
