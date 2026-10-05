// File-press bridge: a press that the shell would answer by opening a file in its OWN viewer is the
// panel's — for a file the review panel holds — and becomes a menu (default open / review panel, see
// CHIP_MENU_EVENT). Every other press is DSH's own and this bridge must not touch it; the menu's
// "default open" is that same press replayed. The presses measured in a shell are the produced-file
// card of 0.1.5, the presented-file card of 0.1.7, and a message's file link or `@file` chip.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { panelHolds, replayFilePress, startProducedChipMenu } from '../src/client/produced-diff.ts'
import { createPendingDiffStore } from '../src/client/store.ts'
import type { DiffApprovalPort } from '../src/client/port.ts'
import type { PendingFileDiff } from '../src/types.ts'

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

describe('panelHolds', () => {
  it('answers from the last FULL read, and says so about a row only a count has seen', async () => {
    // What the label means now that the press is not gated on it: it decides whether the menu's
    // "在审批面板中查看" opens the row directly or adds it first. It is answered from the views the page
    // holds, i.e. from each session's last FULL read — so a row edited since then is labelled NOT held, and
    // is what the ADVersarial case in `pending-panel.client.spec.tsx` covers: the add answers `duplicate`
    // for a path already listed and the item still opens the file. The label must never claim a row exists
    // that does not (that is the direction that would act on nothing).
    const S1 = 'session-1' as SessionId
    const older: PendingFileDiff = {
      id: '/repo/older.txt', sessionId: S1, path: '/repo/older.txt', earlierVersion: 'file',
      oldText: 'a', newText: 'b', updatedAt: 1, missing: false, diverged: false,
    }
    const seam = {
      list: vi.fn(async () => ({
        files: [older], comments: [], commentLines: {}, commentsRevision: 0, commentAnswers: {}, workspacePath: '/repo',
      })),
      listCount: vi.fn(async () => ({ count: 2 })),
    }
    const store = createPendingDiffStore(seam as unknown as DiffApprovalPort)
    await store.refresh(S1)

    expect(panelHolds(store.views(), '/repo/older.txt')).toBe(true)
    // …and the same file named the way a shell press names it: workspace-relative, forward-slashed.
    expect(panelHolds(store.views(), 'older.txt')).toBe(true)
    expect(panelHolds(store.views(), '/repo/never.txt')).toBe(false)

    // A count read does NOT invent a row: it carries a number, and the light read is deliberately not a
    // list. So a path only the count has seen is labelled not-held — which routes it through the add.
    await store.refreshCount(S1)
    expect(store.viewFor(S1).files.map(file => file.path)).toEqual(['/repo/older.txt'])
    expect(panelHolds(store.views(), '/repo/fresh.txt')).toBe(false)
  })
})

describe('startProducedChipMenu', () => {
  it('turns a press on a held file\'s chip into the menu, and keeps DSH out of that press', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    // The press names the press's own box, bottom edge: the menu hangs under what the reader hit.
    a.getBoundingClientRect = () => ({ left: 40, bottom: 96, right: 80, top: 80, width: 40, height: 16, x: 40, y: 80, toJSON: () => ({}) }) as DOMRect
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    a.click()

    // `held` rides the press: this file IS in the list, which is what decides what the menu's items do.
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 40, y: 96, held: true })
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
    expect(onMenu).toHaveBeenNthCalledWith(1, { path: '/repo/a.txt', x: 0, y: 0, held: true })
    expect(onMenu).toHaveBeenNthCalledWith(2, { path: '/repo/b.ts', x: 0, y: 0, held: true })
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
      held: true,
    })
    expect(opened).not.toHaveBeenCalled()
    stop()
  })

  it('becomes the menu for a changed-files row whose file the panel does NOT hold', () => {
    // THE READER'S BUG, at the press level: a row of the shell's changed-files card names a file whose
    // change was settled away (or was never imported), so the review list does not hold it. The press is
    // STILL taken over — that is what makes the menu appear at all — and `held: false` is what tells the
    // panel to add the file before opening it.
    const card = document.createElement('div')
    card.setAttribute('data-changed-files', '')
    document.body.appendChild(card)
    const opened = vi.fn()
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('title', '/repo/settled-away.ts')
    row.addEventListener('click', opened)
    card.appendChild(row)
    const { onMenu, stop } = bridge([])

    row.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/settled-away.ts', x: 0, y: 0, held: false })
    // The shell's own press is suppressed exactly as for a held file: the reader gets the menu, not DSH's
    // open (and, if the add then finds nothing, the notice — see `PendingPanel`).
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

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: true })
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

    expect(onMenu).toHaveBeenNthCalledWith(1, { path: '/repo/a.txt', x: 0, y: 0, held: true })
    expect(onMenu).toHaveBeenNthCalledWith(2, { path: 'src/a b.ts', x: 0, y: 0, held: true })
    stop()
  })

  it('compares a link without its line suffix, so a `#L24` link still names the file', () => {
    const anchor = document.createElement('a')
    anchor.setAttribute('href', '/repo/a.txt#L24')
    anchor.textContent = 'a.txt'
    document.body.appendChild(anchor)
    const { onMenu, stop } = bridge(['/repo/a.txt'])

    anchor.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: true })
    stop()
  })

  it('leaves a press that names no file alone: URLs, schemes, labels, in-page anchors', () => {
    // The negative set that keeps an ordinary web link out of this menu. Every one of these is matched by
    // the SELECTOR (`a[href]` / `button[title]`) and rejected by the PATH FILTER, which is the only thing
    // that can tell them apart — so this is the case that would regress the moment a scheme is trusted.
    const url = document.createElement('a')
    url.setAttribute('href', 'https://example.com/a.txt')
    url.textContent = 'docs'
    document.body.appendChild(url)
    const httpUrl = document.createElement('a')
    httpUrl.setAttribute('href', 'http://example.com/b.ts')
    httpUrl.textContent = 'plain http'
    document.body.appendChild(httpUrl)
    const mail = document.createElement('a')
    mail.setAttribute('href', 'mailto:someone@example.com')
    mail.textContent = 'mail'
    document.body.appendChild(mail)
    const schemeTitle = chip(document.body, 'dsh://settings')
    const urlTitle = chip(document.body, 'https://example.com/c.ts')
    const label = chip(document.body, 'Refresh')
    const fragment = document.createElement('a')
    fragment.setAttribute('href', '#section')
    fragment.textContent = 'section'
    document.body.appendChild(fragment)
    const query = document.createElement('a')
    query.setAttribute('href', '?tab=files')
    query.textContent = 'query'
    document.body.appendChild(query)
    // A Windows drive letter IS a path (the one exception the scheme rule makes) — held here so it stays
    // distinguishable from the schemes above.
    const drive = chip(document.body, 'C:\\repo\\a.txt')
    const { onMenu, stop } = bridge(['/repo/a.txt', 'Refresh', 'C:\\repo\\a.txt'])

    url.click()
    httpUrl.click()
    mail.click()
    schemeTitle.click()
    urlTitle.click()
    label.click()
    fragment.click()
    query.click()

    // Not one of them was taken over…
    expect(onMenu).not.toHaveBeenCalled()
    // …and the drive-letter path still is: the filter rejects schemes, not paths.
    drive.click()
    expect(onMenu).toHaveBeenCalledWith({ path: 'C:\\repo\\a.txt', x: 0, y: 0, held: true })
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

  it('pops the menu for a file LINK the panel does NOT hold, and suppresses the shell\'s own press', () => {
    // THE FLIP the reader asked for: a file link in a message is a file the reader pointed at, so "our list
    // does not hold it" is what the menu ANSWERS (view-in-panel adds it first), never a reason to leave the
    // press to the shell and show nothing. `held: false` is the label that makes the item add before opening.
    const opened = vi.fn()
    const a = document.createElement('button')
    a.type = 'button'
    a.setAttribute('title', '/repo/a.txt')
    a.addEventListener('click', opened)
    document.body.appendChild(a)
    const other = document.createElement('button')
    other.type = 'button'
    other.setAttribute('title', '/repo/b.ts')
    document.body.appendChild(other)
    const { onMenu, stop } = bridge(['/repo/b.ts'])

    a.click()

    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: false })
    // The shell's own handler never ran: the reader gets the menu instead of DSH's open, and that open is
    // still one click away as the menu's first item (see the replay case below).
    expect(opened).not.toHaveBeenCalled()

    // …and a link the panel DOES hold is the same menu with `held: true`.
    other.click()
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/b.ts', x: 0, y: 0, held: true })
    stop()
  })

  it('tells a row and a link apart in no way but the path: one detail shape, so no second route', () => {
    // The panel can only route on what the detail carries. A row and a link must produce the SAME fields —
    // same keys, same `held` semantics — or "view in panel" would need a per-shape branch and a second
    // add/open route. This pins the shape both ways round, with the panel NOT holding either path.
    const row = mountRow()
    const rowPress = chip(row, '/repo/from-row.txt')
    const link = document.createElement('button')
    link.type = 'button'
    link.setAttribute('title', '/repo/from-link.txt')
    document.body.appendChild(link)
    const { onMenu, stop } = bridge([])

    rowPress.click()
    link.click()

    expect(onMenu).toHaveBeenCalledTimes(2)
    const [fromRow, fromLink] = (onMenu as unknown as { mock: { calls: [{ path: string } & Record<string, unknown>][] } }).mock.calls
      .map(call => call[0])
    expect(Object.keys(fromRow!).sort()).toEqual(Object.keys(fromLink!).sort())
    expect(fromRow).toEqual({ path: '/repo/from-row.txt', x: 0, y: 0, held: false })
    expect(fromLink).toEqual({ path: '/repo/from-link.txt', x: 0, y: 0, held: false })
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

  it('replays a LINK press the same way it replays a row press', () => {
    // The Lead's question, answered by a test rather than by reading: `replayFilePress` looks a press up in
    // the same ONE selector list and clicks the same element with the same stand-down guard, so DSH's own
    // open — whatever it does — runs for a message link exactly as it does for a row. One path, not two.
    const opened = vi.fn()
    const link = document.createElement('button')
    link.type = 'button'
    link.setAttribute('title', '/repo/a.txt')
    link.addEventListener('click', opened)
    document.body.appendChild(link)
    const { onMenu, stop } = bridge([])

    link.click()
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: false })

    expect(replayFilePress('/repo/a.txt')).toBe(true)
    // The shell's handler ran once, on the reader's click being replayed — and the bridge stood down, so no
    // second menu was raised for the replay.
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).toHaveBeenCalledTimes(1)
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

  // The reader's setting: "文件菜单" off means this plugin mounts no menu at all, so the bridge must leave
  // the press exactly as DSH has it. `enabled` is asked at EVERY press rather than latched, because the
  // reader can switch the setting while the page is open.
  it('leaves the press entirely alone while the file menu is switched off, and takes it back once it is on', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const onMenu = vi.fn()
    const isPending = vi.fn(() => true)
    let enabled = false
    const stop = startProducedChipMenu({ isPending, onMenu, enabled: () => enabled })

    a.click()
    // The shell's own press ran, untouched — this is the same click a browser with the plugin uninstalled
    // would deliver — and the plugin did not even look at what the press named.
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).not.toHaveBeenCalled()
    expect(isPending).not.toHaveBeenCalled()

    // Switched back on, the very next press is the menu's again: the gate is read per press, not at start.
    enabled = true
    a.click()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: true })

    // ...and off again stops it mid-life, the same way.
    enabled = false
    a.click()
    expect(opened).toHaveBeenCalledTimes(2)
    expect(onMenu).toHaveBeenCalledTimes(1)
    stop()
  })

  it('is enabled when the host offers no setting at all: absent means the menu this bridge always had', () => {
    const row = mountRow()
    const opened = vi.fn()
    const a = chip(row, '/repo/a.txt', opened)
    const onMenu = vi.fn()
    const stop = startProducedChipMenu({ isPending: () => false, onMenu })

    a.click()

    expect(opened).not.toHaveBeenCalled()
    expect(onMenu).toHaveBeenCalledWith({ path: '/repo/a.txt', x: 0, y: 0, held: false })
    stop()
  })
})
