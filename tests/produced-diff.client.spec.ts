// Produced-files chip bridge: a press on a chip whose file the review panel holds is the panel's and
// becomes a menu (default open / review panel, see CHIP_MENU_EVENT); every other press is DSH's own
// and this bridge must not touch it — the menu's "default open" is that same press replayed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { replayChipClick, startProducedChipMenu } from '../src/client/produced-diff.ts'

afterEach(() => { document.body.innerHTML = '' })

function mountRow(): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-produced-files-row', '')
  document.body.appendChild(row)
  return row
}

/** One produced-file chip, with the harness's own press handler on it (what the bridge must respect). */
function chip(parent: HTMLElement, path: string, opened: () => void = () => {}): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.setAttribute('title', path)
  el.textContent = path.split('/').pop() ?? path
  el.addEventListener('click', opened)
  parent.appendChild(el)
  return el
}

/** A bridge that holds `held` and nothing else, recording every press it is handed. */
function bridge(held: string[]) {
  const onMenu = vi.fn()
  const stop = startProducedChipMenu({
    isPending: (path) => held.includes(path),
    onMenu,
  })
  return { onMenu, stop }
}

describe('startProducedChipMenu', () => {
  it('turns a press on a held file\'s chip into the menu, and keeps DSH out of that press', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    // The press names the chip's own box, bottom edge: the menu hangs under the chip the reader hit.
    a.getBoundingClientRect = () => ({ left: 40, bottom: 96, right: 80, top: 80, width: 40, height: 16, x: 40, y: 80, toJSON: () => ({}) }) as DOMRect
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 40, y: 96 })
    // The harness's own handler is on the chip and never ran: the reader is getting the menu instead
    // of DSH's open, not in addition to it.
    expect(opened).not.toHaveBeenCalled()
    stop()
  })

  it('leaves a chip of a file the panel does not hold entirely alone', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const other = chip(row, '/repo/b.ts')
    const { onMenu, stop } = bridge(['/repo/b.ts'])

    a.click()

    // Not the panel's file: DSH's press, untouched.
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).not.toHaveBeenCalled()

    // …and the one it does hold is the menu's.
    other.click()
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/b.ts', x: 0, y: 0 })
    stop()
  })

  it('leaves a modifier press alone: that gesture is the harness\'s to grow', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifier }))
    }

    expect(opened).toHaveBeenCalledTimes(5)
    expect(onMenu).not.toHaveBeenCalled()
    stop()
  })

  it('ignores a press that is not on a produced-file chip', () => {
    const row = mountRow()
    row.appendChild(document.createElement('span'))
    const chipLike = document.createElement('button')
    chipLike.setAttribute('title', '/repo/a.txt')
    document.body.appendChild(chipLike)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    chipLike.click()
    row.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onMenu).not.toHaveBeenCalled()
    stop()
  })

  it('replays the chip\'s own press for the default open, without re-entering the menu', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()
    expect(onMenu).toHaveBeenCalledTimes(1)

    // The menu's first row: the very press the reader made, run again — and the bridge stands down for
    // it, so DSH's handler runs and the menu is not raised a second time.
    expect(replayChipClick('/repo/a.txt')).toBe(true)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).toHaveBeenCalledTimes(1)

    // A file with no chip on the page cannot be pressed: the menu's row reports it instead of guessing.
    expect(replayChipClick('/repo/gone.txt')).toBe(false)
    stop()
  })

  it('stops routing when it is cleaned up', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()
    expect(onMenu).toHaveBeenCalledTimes(1)

    stop()
    a.click()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).toHaveBeenCalledTimes(1)
  })
})
