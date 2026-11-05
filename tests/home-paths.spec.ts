import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dshHomePath, expandHomePath, resolveDshHome } from '../src/home-paths.ts'

/** The environment the process started with, restored after every case (DSH_HOME is global state). */
const originalDshHome = process.env.DSH_HOME

afterEach(() => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

describe('local harness-home path helpers', () => {
  it('expands only the supported tilde prefixes against the OS home', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/a/b')).toBe(join(homedir(), 'a/b'))
    expect(expandHomePath('~\\a\\b')).toBe(join(homedir(), 'a\\b'))
    // Not a supported prefix: every other path is returned exactly as written.
    expect(expandHomePath('relative/path')).toBe('relative/path')
    expect(expandHomePath('~someone/a')).toBe('~someone/a')
    expect(expandHomePath('C:\\data')).toBe('C:\\data')
  })

  it('resolves the harness home as configured > non-empty $DSH_HOME > ~/.dsh', () => {
    delete process.env.DSH_HOME
    expect(resolveDshHome()).toBe(resolve(join(homedir(), '.dsh')))
    // A blank override is unset, never the current directory.
    process.env.DSH_HOME = '   '
    expect(resolveDshHome()).toBe(resolve(join(homedir(), '.dsh')))
    // A real override wins over the default, tilde expansion included.
    process.env.DSH_HOME = '~/custom-dsh-home'
    expect(resolveDshHome()).toBe(resolve(join(homedir(), 'custom-dsh-home')))
    // An explicit configured path wins over the environment.
    const configured = resolve(process.cwd(), 'explicit-home')
    expect(resolveDshHome(configured)).toBe(configured)
  })

  it('joins segments onto the resolved home', () => {
    const home = resolve(process.cwd(), 'fake-dsh-home')
    process.env.DSH_HOME = home
    expect(dshHomePath('diff-approval', 'workspaces')).toBe(join(home, 'diff-approval', 'workspaces'))
    expect(dshHomePath()).toBe(home)
  })
})
