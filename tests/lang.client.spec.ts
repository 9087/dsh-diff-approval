// File-extension → Shiki language mapping.

import { describe, expect, it } from 'vitest'
import { langFromPath } from '../src/client/lang.ts'

describe('langFromPath', () => {
  it('maps common extensions to Shiki ids', () => {
    expect(langFromPath('/repo/src/a.ts')).toBe('typescript')
    expect(langFromPath('/repo/src/a.py')).toBe('python')
    expect(langFromPath('/repo/pkg.json')).toBe('json')
    expect(langFromPath('/repo/run.sh')).toBe('shellscript')
    expect(langFromPath('/repo/index.html')).toBe('html')
    expect(langFromPath('/repo/style.css')).toBe('css')
    expect(langFromPath('/repo/cfg.yaml')).toBe('yaml')
    expect(langFromPath('/repo/README.md')).toBe('markdown')
    expect(langFromPath('/repo/main.go')).toBe('go')
    expect(langFromPath('/repo/Main.java')).toBe('java')
    expect(langFromPath('/repo/main.lua')).toBe('lua')
  })

  it('accepts both separator styles and mixed case', () => {
    expect(langFromPath('C:\\repo\\src\\a.PY')).toBe('python')
    expect(langFromPath('C:\\repo\\src\\a.Tsx')).toBe('typescript')
  })

  it('returns undefined for unknown or missing extensions', () => {
    expect(langFromPath('/repo/noext')).toBeUndefined()
    expect(langFromPath('/repo/a.unknownxyz')).toBeUndefined()
    expect(langFromPath('/repo/.gitignore')).toBeUndefined()
  })
})
