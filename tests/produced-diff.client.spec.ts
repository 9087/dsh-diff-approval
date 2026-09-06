// Produced-files "查看差异" DOM-injection bridge: it watches the harness's
// produced-files row for file chips and injects a diff button after each one,
// driving the openPath callback from the chip's title (path).

import { describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { startProducedDiffInjection } from '../src/client/produced-diff.ts'

function mountRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-produced-files-row', '')
  document.body.appendChild(row)
  return row
}

function chip(parent: HTMLElement, path: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.setAttribute('title', path)
  el.textContent = path.split('/').pop() ?? path
  parent.appendChild(el)
  return el
}

describe('startProducedDiffInjection', () => {
  it('injects a diff button after each produced-file chip and drives openPath with its title', () => {
    const row = mountRow()
    const a = chip(row, '/repo/a.txt')
    const b = chip(row, '/repo/sub/b.ts')

    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)

    const buttons = row.querySelectorAll<HTMLButtonElement>('[data-diff-approval-produced-diff-btn]')
    expect(buttons.length).toBe(2)
    // The button is an icon-only control; the tooltip names the exact file.
    expect(buttons[0]!.getAttribute('aria-label')).toBe('查看差异: /repo/a.txt')
    expect(buttons[0]!.getAttribute('title')).toBe('查看差异: /repo/a.txt')
    expect(buttons[0]!.querySelector('svg')).not.toBeNull()
    // The chip→button gap is a -4px left margin against the row's 8px gap.
    expect(buttons[0]!.style.marginLeft).toBe('-4px')
    // The icon rides the chip's gray text (inlined so it is not overridden).
    expect(buttons[0]!.style.color).toBe('var(--dsw-alias-label-secondary)')
    // Each injected button sits right after its chip.
    expect(a.nextElementSibling).toBe(buttons[0])
    expect(b.nextElementSibling).toBe(buttons[1])

    act(() => { buttons[0]!.click() })
    expect(openPath).toHaveBeenCalledWith('/repo/a.txt')

    act(() => { buttons[1]!.click() })
    expect(openPath).toHaveBeenCalledWith('/repo/sub/b.ts')

    stop()
  })

  it('does not inject twice on the same chip, and re-injects chips added later', async () => {
    const row = mountRow()
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)

    const a = chip(row, '/repo/a.txt')
    await Promise.resolve()
    // First pass saw `a`; a subsequent call must not add a second button.
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(1)
    // A chip added later (e.g. a new turn settled) gets its own button.
    const c = chip(row, '/repo/c.txt')
    await Promise.resolve()
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(2)
    expect(c.nextElementSibling).not.toBeNull()

    stop()
  })

  it('skips chips without a title path', () => {
    const row = mountRow()
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)
    const noPath = document.createElement('button')
    row.appendChild(noPath)
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(0)
    stop()
  })

  it('does not inject a second button when a chip is re-rendered for the same path', async () => {
    const row = mountRow()
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)
    const a = chip(row, '/repo/a.txt')
    await Promise.resolve()
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(1)

    // A React re-render hands the row a fresh chip without the marker, but a
    // button for the same path already exists — must not add a second one.
    chip(row, '/repo/a.txt')
    await Promise.resolve()
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(1)

    stop()
  })

  it('always shows the injected button even when its chip is hidden', async () => {
    // The harness's narrow-screen container queries hide some `.file` chips with
    // `display: none`; we deliberately do NOT hide the button alongside them —
    // that aggressive mirroring made the button vanish and read as "gone". The
    // button is the affordance to open the diff, so it must stay visible.
    const row = mountRow()
    const a = chip(row, '/repo/a.txt')
    a.style.display = 'none'
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)
    await Promise.resolve()
    const btn = row.querySelector('[data-diff-approval-produced-diff-btn]') as HTMLElement
    expect(btn).not.toBeNull()
    expect(btn.style.display).toBe('inline-flex')
    stop()
  })

  it('installs a stylesheet rule carrying the rest + hover colors (inline can\'t hold :hover)', () => {
    mountRow()
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)
    const style = document.querySelector('style[data-diff-approval-produced-diff]') as HTMLStyleElement
    expect(style).not.toBeNull()
    expect(style!.textContent).toContain(`[${'data-diff-approval-produced-diff-btn'}]`)
    expect(style!.textContent).toContain(':hover')
    expect(style!.textContent).toContain('rgba(38, 49, 72, 0.06)')
    expect(style!.textContent).toContain('rgba(38, 49, 72, 0.14)')
    stop()
  })

  it('cleanup removes the injected buttons and stops watching', async () => {
    const row = mountRow()
    const openPath = vi.fn()
    const stop = startProducedDiffInjection('查看差异', openPath)
    chip(row, '/repo/a.txt')
    await Promise.resolve()
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(1)
    stop()
    expect(row.querySelectorAll('[data-diff-approval-produced-diff-btn]').length).toBe(0)
  })
})
