// The client bundle's CSS-module class map, and why its key order is pinned here.
//
// lightningcss hands `exports` back in an order that is NOT stable across runs, and the build emits
// that table verbatim as the module's default export — so the order leaked into the artifact's bytes,
// and two builds of identical sources produced different bundles (same length, same class names, same
// hashed values, merely permuted). `cssClassMap` sorts by the source class name to fix that at the
// source. These cases fail the moment that sort is dropped, which is the point: the emitted bytes have
// to be a function of the stylesheet.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { transform } from 'lightningcss'
import { cssClassMap } from '../build/css-class-map.ts'

describe('build: the CSS-module class map', () => {
  it('sorts by the source class name', () => {
    const table = {
      zeta: { name: 'HASH_zeta' },
      alpha: { name: 'HASH_alpha' },
      mid: { name: 'HASH_mid' },
    }
    expect(Object.keys(cssClassMap(table))).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('serializes one stylesheet identically however lightningcss happened to order it', () => {
    // Two reads of the SAME stylesheet, in two orders — exactly the difference between two builds.
    const one = { zeta: { name: 'HASH_zeta' }, alpha: { name: 'HASH_alpha' }, mid: { name: 'HASH_mid' } }
    const other = { mid: { name: 'HASH_mid' }, zeta: { name: 'HASH_zeta' }, alpha: { name: 'HASH_alpha' } }
    expect(JSON.stringify(cssClassMap(other))).toBe(JSON.stringify(cssClassMap(one)))
  })

  it('keeps every hashed value, and tolerates having no table at all', () => {
    expect(cssClassMap({ alpha: { name: 'HASH_alpha' } })).toEqual({ alpha: 'HASH_alpha' })
    expect(cssClassMap(undefined)).toEqual({})
  })

  it('sorts the map compiled from this repository own stylesheet', () => {
    // The real pipeline, not a fixture: the same call the build makes, over the file it compiles.
    const file = 'src/client/PendingPanel.module.css'
    const compiled = transform({
      filename: file,
      code: readFileSync(file),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const map = cssClassMap(compiled.exports)
    const keys = Object.keys(map)
    expect(keys.length).toBeGreaterThan(100)
    expect(keys).toEqual([...keys].sort())
    for (const [local, hashed] of Object.entries(map)) expect(hashed.endsWith(`_${local}`)).toBe(true)
  })
})
