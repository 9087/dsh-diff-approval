// The id a comment is minted under, which has to be mintable where the reader is standing: a phone or
// tablet reaches this host over plain HTTP on the LAN, and `crypto.randomUUID` does not exist there.

import { describe, expect, it } from 'vitest'
import { newId } from '../src/client/ids.ts'

/** Put `crypto.randomUUID` back exactly as it was, own property or not. */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Run `body` with `crypto.randomUUID` absent, the way an insecure context has it.
 *
 * Defined as an OWN property holding undefined, so it shadows whatever the runtime put on the
 * prototype — which is what an insecure context looks like from inside the page.
 */
async function withoutRandomUUID(body: () => void): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true })
  try {
    body()
  } finally {
    if (had === undefined) delete (crypto as { randomUUID?: unknown }).randomUUID
    else Object.defineProperty(crypto, 'randomUUID', had)
  }
}

describe('newId', () => {
  it('mints a v4 UUID wherever it can', () => {
    expect(newId()).toMatch(V4)
  })

  it('still mints one where `randomUUID` does not exist, instead of throwing', async () => {
    await withoutRandomUUID(() => {
      const ids = new Set([newId(), newId(), newId()])
      // A unique id per call, in the same shape: `randomUUID` is the platform doing this, not the
      // contract. Calling it where it is absent used to throw, and the throw was outside the `try`
      // that reports a failed write — so writing a comment did nothing at all.
      expect(ids.size).toBe(3)
      for (const id of ids) expect(id).toMatch(V4)
    })
  })
})
