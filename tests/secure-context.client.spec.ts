// APIs that exist only in a SECURE CONTEXT, checked over the whole browser half.
//
// The reader is not always on `localhost`: a phone or tablet reaches this host over plain HTTP on the
// LAN, where `crypto.randomUUID` and `crypto.subtle` do not exist and `navigator.clipboard` is absent.
// Writing a comment used to call `crypto.randomUUID` straight from its submit path, so on a tablet the
// click threw a TypeError before the request and outside the reporting path: the composer stayed open
// with the reader's words in it and NOTHING happened — no write, no message, no toast. Desktop never
// saw it, because `localhost` is a secure context.
//
// So the rule is: a secure-context API may be named only in `ids.ts`, which feature-detects it and
// falls back to `crypto.getRandomValues` (allowed in an insecure context). A new call site elsewhere
// fails here instead of failing silently on the reader's tablet.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The browser half, scanned as source: this is about what a call site may name. */
const CLIENT_DIR = resolve(process.cwd(), 'src', 'client')

/** The one file allowed to name a secure-context API, because it checks for it first. */
const ALLOWED_FILE = 'ids.ts'

/** The APIs that are missing outside a secure context. */
const SECURE_CONTEXT_APIS = ['crypto.randomUUID', 'crypto.subtle', 'navigator.clipboard']

/** Every `.ts`/`.tsx` under the browser half. */
function clientSources(dir: string = CLIENT_DIR): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...clientSources(path))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path)
  }
  return found
}

describe('secure-context APIs in the browser half', () => {
  it('are named only in the helper that feature-detects them', () => {
    const offenders: string[] = []
    for (const file of clientSources()) {
      if (file.endsWith(ALLOWED_FILE)) continue
      const text = readFileSync(file, 'utf8')
      for (const api of SECURE_CONTEXT_APIS) {
        if (text.includes(api)) offenders.push(`${file.replace(CLIENT_DIR, 'src/client')} names ${api}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('are feature-detected in that helper, so a context without them still works', () => {
    const text = readFileSync(join(CLIENT_DIR, ALLOWED_FILE), 'utf8')
    // Not decoration: without the check the helper would be the same silent failure, one level down.
    expect(text).toContain("typeof crypto.randomUUID === 'function'")
    expect(text).toContain("typeof crypto.getRandomValues === 'function'")
  })
})
