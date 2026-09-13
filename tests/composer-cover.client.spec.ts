// @vitest-environment jsdom
// Whether the review panel is covering the composer: the copy-reference action asks
// before it moves the caret, so it must answer for every way the panel can sit.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { composerCoveredByPanel, pasteReferenceIntoComposer } from '../src/client/composer-cover.ts'

afterEach(cleanup)
afterEach(() => { document.body.innerHTML = '' })

/** A box in the viewport, in the order the helper reads them. */
function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** Mount the panel and the composer with the given boxes. */
function layout(panel: DOMRect | undefined, composer: DOMRect | undefined): void {
  if (panel !== undefined) {
    const element = document.createElement('section')
    element.setAttribute('data-diff-approval-panel', '')
    element.getBoundingClientRect = () => panel
    document.body.appendChild(element)
  }
  if (composer !== undefined) {
    const element = document.createElement('div')
    element.setAttribute('data-composer-input', '')
    element.getBoundingClientRect = () => composer
    document.body.appendChild(element)
  }
}

describe('composerCoveredByPanel', () => {
  it('is false without a panel, and without a composer to cover', () => {
    expect(composerCoveredByPanel()).toBe(false)
    layout(undefined, box(0, 700, 600, 90))
    expect(composerCoveredByPanel()).toBe(false)
    cleanup()
    document.body.innerHTML = ''
    layout(box(8, 8, 1184, 664), undefined)
    expect(composerCoveredByPanel()).toBe(false)
  })

  it('is false while the floating panel stops above the composer', () => {
    // The default: the composer edge is not covered, so the panel's bottom sits at
    // the composer's top (plus its gap) and the two boxes do not meet.
    layout(box(8, 8, 1184, 600), box(300, 700, 600, 90))
    expect(composerCoveredByPanel()).toBe(false)
  })

  it('is true when the composer edge is covered', () => {
    // `cover.composer` on, or the window too short for the panel's minimum height —
    // either way the panel's bottom is past the composer's top. Measured, not asked.
    layout(box(8, 8, 1184, 800), box(300, 700, 600, 90))
    expect(composerCoveredByPanel()).toBe(true)
  })

  it('ignores a graze, and needs more than half the composer', () => {
    // A box overlapping the composer's top edge by a pixel or two is not covering
    // it: the caret belongs there as much as ever. The line is half the composer's
    // area (see COMPOSER_COVERED_RATIO), so a majority hidden counts and a minority
    // does not.
    const composer = box(300, 700, 600, 100)
    layout(box(8, 8, 1184, 702), composer)          // 2px into the composer's top
    expect(composerCoveredByPanel()).toBe(false)
    cleanup()
    document.body.innerHTML = ''
    layout(box(8, 8, 1184, 741), composer)          // 49% of its height
    expect(composerCoveredByPanel()).toBe(false)
    cleanup()
    document.body.innerHTML = ''
    layout(box(8, 8, 1184, 743), composer)          // 51% of its height
    expect(composerCoveredByPanel()).toBe(true)
    cleanup()
    document.body.innerHTML = ''
    layout(box(300, 8, 300, 792), composer)         // half its width, all its height
    expect(composerCoveredByPanel()).toBe(false)
  })

  it('is true over an undocked composer inside the conversation', () => {
    // A hero (centred) composer lives *inside* the conversation the panel spans, so
    // the overlap is what says it is covered — there is no composer edge to read.
    layout(box(8, 8, 1184, 780), box(300, 320, 600, 120))
    expect(composerCoveredByPanel()).toBe(true)
  })

  it('is false for a docked pane beside the conversation', () => {
    layout(box(880, 8, 400, 780), box(300, 700, 560, 90))
    expect(composerCoveredByPanel()).toBe(false)
  })

  it('is true for a fullscreen docked sidebar', () => {
    // The pane spans the window, so the panel inside it does too, and the composer
    // is behind both.
    layout(box(0, 0, 1280, 800), box(300, 700, 600, 90))
    expect(composerCoveredByPanel()).toBe(true)
  })

  it('is false for boxes with no size, whatever their position says', () => {
    // A panel that has not been laid out (or a composer in a hidden tab) is not on
    // screen: an empty box must not read as "covering" by sitting at the origin.
    layout(box(0, 0, 0, 0), box(0, 0, 600, 90))
    expect(composerCoveredByPanel()).toBe(false)
  })

  it('reads the composer seat when the input and card are not rendered', () => {
    // A takeover replaces the card but keeps the seat: the caret would still land
    // in a hidden field, so the seat is measured as the last resort.
    const panel = document.createElement('section')
    panel.setAttribute('data-diff-approval-panel', '')
    panel.getBoundingClientRect = () => box(8, 8, 1184, 800)
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    seat.getBoundingClientRect = () => box(300, 700, 600, 90)
    document.body.append(panel, seat)
    expect(composerCoveredByPanel()).toBe(true)
  })
})

describe('pasteReferenceIntoComposer', () => {
  /** The composer, focusable and measured, plus a panel over it or above it. */
  function scene(overlap: boolean): { composer: HTMLElement; written: string[] } {
    const panel = document.createElement('section')
    panel.setAttribute('data-diff-approval-panel', '')
    panel.getBoundingClientRect = () => box(8, 8, 1184, overlap ? 800 : 600)
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.contentEditable = 'true'
    // jsdom focuses an element with a tab index; the real composer is a
    // contenteditable the harness makes focusable.
    composer.tabIndex = -1
    composer.getBoundingClientRect = () => box(300, 700, 600, 90)
    document.body.append(panel, composer)
    return { composer, written: [] }
  }

  it('writes the reference and moves the caret while the composer is visible', () => {
    const { composer, written } = scene(false)
    pasteReferenceIntoComposer((text) => { written.push(text) }, '(a.txt:1)')
    expect(written).toEqual(['(a.txt:1)'])
    expect(document.activeElement).toBe(composer)
  })

  it('writes the reference but keeps the caret away when the panel covers it', () => {
    // The reference is not lost — only the caret is left where the reader can see
    // it, instead of inside a field behind the panel.
    const { composer, written } = scene(true)
    const before = document.activeElement
    pasteReferenceIntoComposer((text) => { written.push(text) }, '(a.txt:2)')
    expect(written).toEqual(['(a.txt:2)'])
    expect(document.activeElement).toBe(before)
    expect(document.activeElement).not.toBe(composer)
  })

  it('takes the caret out of a covered composer that already had it', () => {
    // The reported case: the chord works with the caret wherever it is, and the caret
    // is usually in the composer — someone who was typing, then selected lines in the
    // diff with the mouse (a selection does not move the focus). Declining to focus
    // would leave them typing into a field they cannot see, so the caret leaves.
    const { composer, written } = scene(true)
    composer.focus()
    expect(document.activeElement).toBe(composer)
    pasteReferenceIntoComposer((text) => { written.push(text) }, '(a.txt:4)')
    expect(written).toEqual(['(a.txt:4)'])
    expect(document.activeElement).not.toBe(composer)
  })

  it('leaves the caret in the composer when it is visible', () => {
    const { composer } = scene(false)
    composer.focus()
    pasteReferenceIntoComposer(() => {}, '(a.txt:5)')
    expect(document.activeElement).toBe(composer)
  })

  it('writes the reference even when there is no composer to focus', () => {
    const written: string[] = []
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      pasteReferenceIntoComposer((text) => { written.push(text) }, '(a.txt:3)')
    } finally {
      focus.mockRestore()
    }
    expect(written).toEqual(['(a.txt:3)'])
    expect(focus).not.toHaveBeenCalled()
  })
})
