/**
 * The plugin manifest's client half: which DSH client packages this plugin's browser half is
 * booted with (`package.json` → `dsh.client.inject`). The list is not decoration — it is what
 * has those packages loaded, and their seats declared, before this plugin registers into them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

/** The manifest's declared client packages. */
function declaredClientInject(): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dsh?: { client?: { inject?: string[] } }
  }
  return manifest.dsh?.client?.inject ?? []
}

/** This plugin's browser half, as it is written on disk. */
function clientSource(): string {
  return readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8')
}

describe('the manifest and the seats the client half fills', () => {
  /**
   * The settings seat is declared by another package (`dsh-client-ui-settings`), so a
   * registration into `settings.section` only finds a seat if that package is loaded. Every
   * DSH client plugin that contributes to that section declares it — the settings family,
   * the theme, locale, chat and the agent preset all do — and this plugin, which fills the
   * section with its own page, has to as well: without the declaration the section can be a
   * no-show, and the comment-mode switch that enables the whole comment feature lives in it.
   */
  it('declares the settings package while the client half fills the settings seat', () => {
    // Read the source rather than keeping a copy of the seat list here: the invariant is about
    // what the client half does, and a copied list would drift away from it.
    expect(clientSource()).toContain("'settings.section'")
    expect(declaredClientInject()).toContain('@deepseek-ai/dsh-client-ui-settings')
  })

  /** The services the client half names in its own `inject`, for the packages they come from. */
  it('declares the packages whose services the client half injects', () => {
    const source = clientSource()
    const services = /export const inject = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    expect(services).not.toBe('')
    // Each service this half requires has to arrive with a package it declared: locale and the
    // sidebar are the two that are named as packages (the rest are provided by the runtime).
    expect(services).toContain("'locale'")
    expect(declaredClientInject()).toContain('@deepseek-ai/dsh-client-locale')
    expect(declaredClientInject()).toContain('@deepseek-ai/dsh-client-ui-sidebar')
    expect(declaredClientInject()).toContain('@deepseek-ai/dsh-client-runtime')
  })
})
