// File-press bridge: a press that the shell would answer by opening a file in its OWN viewer is the
// panel's — for a file the review panel holds — and becomes a menu (default open / review panel, see
// CHIP_MENU_EVENT). Every other press is DSH's own and this bridge must not touch it; the menu's
// "default open" is that same press replayed. The presses measured in a shell are the produced-file
// card of 0.1.5, the presented-file card of 0.1.7, and a message's file link or `@file` chip.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { replayFilePress, startProducedChipMenu } from '../src/client/produced-diff.ts'

afterEach(() => { document.body.innerHTML = '' })

function mountRow(attribute = 'data-presented-files-row'): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute(attribute, '')
  document.body.appendChild(row)
  return row
}

/** One file press, with the shell's own press handler on it (what the bridge must respect). */
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
    // The press names the press's own box, bottom edge: the menu hangs under what the reader hit.
    a.getBoundingClientRect = () => ({ left: 40, bottom: 96, right: 80, top: 80, width: 40, height: 16, x: 40, y: 80, toJSON: () => ({}) }) as DOMRect
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 40, y: 96 })
    // The shell's own handler is on the chip and never ran: the reader is getting the menu instead of
    // DSH's open, not in addition to it.
    expect(opened).not.toHaveBeenCalled()
    stop()
  })

  it('routes both shells\' produced-file cards: 0.1.5\'s row and 0.1.7\'s presented row', () => {
    const old = mountRow('data-produced-files-row')
    const current = mountRow()
    const inOld = chip(old, '/repo/a.txt')
    const inCurrent = chip(current, '/repo/b.ts')
    const { onMenu, stop } = bridge(['/repo/a.txt', '/repo/b.ts'])

    inOld.click()
    inCurrent.click()

    // The 0.1.7 rename is what silently stopped the menu from appearing at all: the cards kept their
    // `title` and their own press, and only the attribute around them changed.
    expect(onMenu).toHaveBeenNthCalledWith(1, { path: '/repo/a.txt', x: 0, y: 0 })
    expect(onMenu).toHaveBeenNthCalledWith(2, { path: '/repo/b.ts', x: 0, y: 0 })
    stop()
  })

  it('routes a changed-files row, which keeps its path in the description it points at', () => {
    const card = document.createElement('div')
    card.setAttribute('data-changed-files', '')
    document.body.appendChild(card)
    const list = document.createElement('ul')
    card.appendChild(list)
    const item = document.createElement('li')
    list.appendChild(item)
    const opened = vi.fn()
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('aria-describedby', 'changed-path-0')
    row.addEventListener('click', opened)
    row.appendChild(document.createElement('span')).textContent = 'produced-diff.ts'
    item.appendChild(row)
    // 0.1.7 keeps the resolved path in a visually hidden span, NOT in the row's `title`: the row says
    // only "view the diff of <name>" in its `aria-label`, in whatever language the shell is in.
    const described = document.createElement('span')
    described.id = 'changed-path-0'
    described.hidden = true
    described.textContent = 'C:\\PROJECTS\\dsh-diff-approval\\src\\client\\produced-diff.ts'
    item.appendChild(described)
    const { onMenu, stop } = bridge(['C:\\PROJECTS\\dsh-diff-approval\\src\\client\\produced-diff.ts'])

    row.click()

    expect(onMenu).toHaveBeenCalledWith({
      path: 'C:\\PROJECTS\\dsh-diff-approval\\src\\client\\produced-diff.ts',
      x: 0,
      y: 0,
    })
    expect(opened).not.toHaveBeenCalled()
    stop()
  })

  it('leaves the shell\'s own review pane alone: its file picker switches files, it opens nothing', () => {
    const picker = document.createElement('div')
    picker.setAttribute('data-review-view', '')
    document.body.appendChild(picker)
    const opened = vi.fn()
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-review-file', '/repo/a.txt')
    button.setAttribute('title', '/repo/a.txt')
    button.addEventListener('click', opened)
    picker.appendChild(button)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    button.click()

    // Its press opens the shell's file menu inside the review pane; taking it over would leave the
    // reader unable to change which file that pane is showing.
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).not.toHaveBeenCalled()
    stop()
  })

  it('routes a message\'s file link, which 0.1.7 draws as a button carrying the path in `title`', () => {
    const opened = vi.fn()
    const link = document.createElement('button')
    link.type = 'button'
    link.setAttribute('title', '/repo/a.txt')
    link.addEventListener('click', opened)
    document.body.appendChild(link)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    link.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0 })
    expect(opened).not.toHaveBeenCalled()
    stop()
  })

  it('reads an @file chip\'s raw token as the path it names', () => {
    const reference = document.createElement('button')
    reference.type = 'button'
    reference.setAttribute('data-ref-chip', 'file')
    reference.setAttribute('title', '@/repo/a.txt')
    document.body.appendChild(reference)
    const quoted = document.createElement('button')
    quoted.type = 'button'
    quoted.setAttribute('data-ref-chip', 'file')
    quoted.setAttribute('title', '@"src/a b.ts"')
    document.body.appendChild(quoted)
    const { onMenu, stop } = bridge(['/repo/a.txt', 'src/a b.ts'])

    reference.click()
    quoted.click()

    expect(onMenu).toHaveBeenNthCalledWith(1, { path: '/repo/a.txt', x: 0, y: 0 })
    expect(onMenu).toHaveBeenNthCalledWith(2, { path: 'src/a b.ts', x: 0, y: 0 })
    stop()
  })

  it('compares a link without its line suffix, so a `#L24` link still names the file', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', '/repo/a.txt#L24')
    anchor.textContent = 'a.txt'
    document.body.appendChild(anchor)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    anchor.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0 })
    stop()
  })

  it('leaves a press that names no file alone: a URL, a label, an in-page anchor', () => {
    const url = document.createElement('a')
    url.setAttribute('href', 'https://example.com/a.txt')
    url.textContent = 'docs'
    document.body.appendChild(url)
    const schemeTitle = chip(document.body, 'dsh://settings')
    const label = chip(document.body, 'Refresh')
    const fragment = document.createElement('a')
    fragment.setAttribute('href', '#section')
    fragment.textContent = 'section'
    document.body.appendChild(fragment)
    const { onMenu, stop } = bridge(['/repo/a.txt', 'Refresh'])

    url.click()
    schemeTitle.click()
    label.click()
    fragment.click()

    expect(onMenu).not.toHaveBeenCalled()
    stop()
  })

  it('leaves this plugin\'s own surface alone: the panel\'s buttons are the panel\'s', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-diff-approval-panel', '')
    document.body.appendChild(panel)
    const inPanel = chip(panel, '/repo/a.txt')
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    inPanel.click()

    // The panel is already showing this file, and its own press opens it its own way: routing it here
    // would take the click away from the surface that raised the file in the first place.
    expect(onMenu).not.toHaveBeenCalled()
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

  it('replays the press itself for the default open, without re-entering the menu', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()
    expect(onMenu).toHaveBeenCalledTimes(1)

    // The menu's first row: the very press the reader made, run again — and the bridge stands down for
    // it, so the shell's handler runs and the menu is not raised a second time.
    expect(replayFilePress('/repo/a.txt')).toBe(true)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).toHaveBeenCalledTimes(1)

    // A file with no press on the page cannot be replayed: the menu's row reports it instead of guessing.
    expect(replayFilePress('/repo/gone.txt')).toBe(false)
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
