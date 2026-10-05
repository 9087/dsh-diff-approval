// @vitest-environment jsdom
// Applying the plugin: the registration shapes the runtime validates. A keyed
// seat dispatches by `key` and rejects a registration without one, which fails
// the whole plugin's load — so this pins the spelling of every seat we fill.

import { describe, expect, it, vi } from 'vitest'
import { DIFF_DOCK_ID } from '../src/client/dock.tsx'
import { apply } from '../src/client/index.ts'
import { CHIP_MENU_EVENT } from '../src/client/produced-diff.ts'

/** A client context just real enough for `apply`: services it reads, and a slot
 *  service that records every registration and fires `inject` callbacks (the real
 *  one only fires for seats that exist, which is exactly what makes the dock's
 *  registrations optional). */
function fakeContext() {
  const registrations: { config: Record<string, unknown>; component: unknown }[] = []
  const injections: string[] = []
  /** Every cleanup `apply` hands back through `ctx.effect` — the produced-file bridge's document listener
   *  among them, which a test that boots the real entry has to be able to take down again. */
  const effects: (() => void)[] = []
  const ctx = {
    effect: (callback: () => unknown) => {
      const result = callback()
      if (typeof result === 'function') effects.push(result as () => void)
    },
    on: () => {},
    get: (name: string) => (name === 'connection' ? { rpc: {} } : undefined),
    locale: { register: () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (name: string, callback: () => unknown) => { injections.push(name); callback() },
      register: (config: Record<string, unknown>, component: unknown) => {
        registrations.push({ config, component })
        return () => {}
      },
    },
    // The sidebar is absent here: the dock registers nothing and the plugin still
    // applies — the optionality the compat matrix depends on.
    inject: () => {},
  }
  return { ctx, registrations, injections, effects }
}

describe('plugin apply', () => {
  it('lets the reader switch the SHELL\'s own file press off, through the real entry point', () => {
    // THE WIRING, PINNED. `apply` is the only place that hands the produced-file bridge its answer
    // (`enabled: () => chipMenuEnabled()`, index.ts). Without this test, deleting that argument leaves the
    // whole suite green: the bridge's own spec passes `enabled` in itself, and the preview half of the
    // setting (jsdom + E2E s16) is the panel's own handler. The setting would then silently stop affecting
    // the two surfaces the reader actually uses — a file row in the shell's lists and a file link in a
    // message — which no browser fixture in this repo can stage. So: boot the real entry, press a real
    // chip, and read the difference the setting makes.
    const { ctx, effects } = fakeContext()
    const row = document.createElement('div')
    row.setAttribute('data-produced-files-row', '')
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.setAttribute('title', '/repo/a.txt')
    const opened = vi.fn()
    chip.addEventListener('click', opened)
    row.appendChild(chip)
    document.body.appendChild(row)
    const menus: unknown[] = []
    const onMenu = (event: Event): void => { menus.push((event as CustomEvent).detail) }
    window.addEventListener(CHIP_MENU_EVENT, onMenu)
    /** A press a browser would deliver, and `false` exactly when it was default-prevented (the shell's own
     *  behaviour suppressed) — `dispatchEvent` reports that, which a bare `.click()` does not. */
    const press = (): boolean => chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    try {
      localStorage.setItem('diff-approval:file-menu', '0')
      apply(ctx as never)

      // OFF: the press is DSH's own — its handler ran, the press was NOT taken over, and no menu appeared.
      expect(press(), 'with the file menu off the shell press must not be taken over').toBe(true)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(menus).toHaveLength(0)

      // ON: the same press, through the same booted entry, is the bridge's — suppressed for the shell, with
      // the menu event raised for the panel. Both halves are asserted, because a bridge that merely stopped
      // preventing the default without raising a menu would be a worse bug than either.
      localStorage.setItem('diff-approval:file-menu', '1')
      expect(press(), 'with the file menu on the press is ours').toBe(false)
      expect(opened).toHaveBeenCalledTimes(1)
      expect(menus).toHaveLength(1)
      expect(menus[0]).toMatchObject({ path: '/repo/a.txt' })
    } finally {
      for (const cleanup of effects) cleanup()
      window.removeEventListener(CHIP_MENU_EVENT, onMenu)
      row.remove()
      localStorage.clear()
    }
  })

  it('fills every seat it knows about, keyed ones by key', () => {
    const { ctx, registrations, injections } = fakeContext()
    apply(ctx as never)

    const byName = new Map(registrations.map(entry => [entry.config.name as string, entry.config]))
    // The seats this plugin fills. The two keyed ones must carry `key`: a keyed
    // seat validates it at registration time and throws without it. The header
    // utilities seat is named as a string because the conversation UI package is
    // not part of this program's SlotMap — the same optionality as the dock's.
    expect([...byName.keys()].sort()).toEqual([
      'conversation.session.header.utilities',
      'settings.section',
      'sidebar.footer.action',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
    ])
    expect(byName.get('sidebar.right.pane.tab')!.key).toBe(DIFF_DOCK_ID)
    expect(byName.get('sidebar.right.pane.tab.title')!.key).toBe(DIFF_DOCK_ID)
    for (const name of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
      expect(byName.get(name)!.id).toBeUndefined()
    }
    // Non-keyed seats keep their `id` (their spelling) and no `key`.
    expect(byName.get('sidebar.footer.action')!.id).toBe('diff-approval-panel')
    expect(byName.get('sidebar.footer.action')!.key).toBeUndefined()
    expect(byName.get('settings.section')!.id).toBe('diff-approval')
    // The header entry sorts before the app's own more-actions button (order 0),
    // so the cluster keeps the app's button last.
    expect(byName.get('conversation.session.header.utilities')!.id).toBe('diff-approval-entry')
    expect(byName.get('conversation.session.header.utilities')!.order).toBe(-5)
    expect(byName.get('conversation.session.header.utilities')!.key).toBeUndefined()
    expect(injections).toContain('sidebar.right.pane.tab')
    expect(injections).toContain('conversation.session.header.utilities')
  })

  it('keeps the other seats when the header utilities seat is refused', () => {
    // The header entry is the newest and most optional seat: it belongs to a UI
    // package this plugin does not depend on, so a host that rejects the seat —
    // or throws on the lookup — must cost that one button and nothing else.
    const { ctx, registrations } = fakeContext()
    const inject = ctx.slots.inject
    ctx.slots.inject = (name: string, callback: () => unknown) => {
      if (name === 'conversation.session.header.utilities') throw new Error('no such seat')
      inject(name, callback)
    }
    apply(ctx as never)

    const names = registrations.map(entry => entry.config.name)
    expect(names).not.toContain('conversation.session.header.utilities')
    expect(names).toContain('sidebar.footer.action')
    expect(names).toContain('sidebar.right.pane.tab')
  })

  it('never lets a refused seat throw out of apply', () => {
    // `apply` runs inside the client's boot: a seat that was already taken (a
    // reload racing the previous fiber) must cost that one surface, not the app.
    const { ctx, registrations } = fakeContext()
    const inject = ctx.slots.inject
    ctx.slots.inject = (name: string, callback: () => unknown) => {
      if (name === 'sidebar.footer.action') throw new Error('seat already filled')
      inject(name, callback)
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => { apply(ctx as never) }).not.toThrow()
      // The reason is said out loud rather than swallowed.
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    // …and the sections that do not depend on that seat are still registered.
    const names = registrations.map(entry => entry.config.name)
    expect(names).not.toContain('sidebar.footer.action')
    expect(names).toContain('settings.section')
    expect(names).toContain('sidebar.right.pane.tab')
  })

  it('discovers the right sidebar by lookup and registers the tab type', () => {
    const { ctx, registrations } = fakeContext()
    const sidebar = {
      openTab: vi.fn(),
      active: () => undefined,
      isExpanded: () => false,
      subscribe: () => () => {},
    }
    const registered: Record<string, unknown>[] = []
    ctx.get = (name: string) => {
      if (name === 'connection') return { rpc: {} }
      if (name === 'sidebarRight') return sidebar
      if (name === 'sidebarRightTabs') return { register: (definition: Record<string, unknown>) => { registered.push(definition); return () => {} } }
      return undefined
    }
    apply(ctx as never)

    // The tab type registers through the sidebar's registry, and the footer face
    // carries the reveal the panel's dock switch calls.
    expect(registered.map(definition => definition.kind)).toEqual(['diff-approval'])
    const face = registrations.find(entry => entry.config.name === 'sidebar.footer.action')!.config
    const injected = (face.inject as () => Record<string, unknown>)() as { onOpenDock?: () => void; hooks: Record<string, unknown> }
    expect(typeof injected.onOpenDock).toBe('function')
    expect(injected.hooks.dock).toBeDefined()
    injected.onOpenDock?.()
    expect(sidebar.openTab).toHaveBeenCalled()
  })
})
