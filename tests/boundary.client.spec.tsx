// @vitest-environment jsdom
// A crash inside the panel has to be visible and recoverable: the app's own slot
// boundary retires a crashed entry for the life of the page, which reads as "the
// panel is gone" or as a blank surface with no explanation.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { PanelBoundary } from '../src/client/boundary.tsx'

afterEach(cleanup)
afterEach(() => { vi.restoreAllMocks() })

/** The boundary under test, mounted with a healthy child. */
function mount(): ReturnType<typeof createRef<PanelBoundary>> {
  const ref = createRef<PanelBoundary>()
  render(<PanelBoundary ref={ref} t={(key: string) => key}><p>panel body</p></PanelBoundary>)
  return ref
}

describe('PanelBoundary', () => {
  it('renders the panel as long as it works', () => {
    mount()
    expect(screen.getByText('panel body')).toBeDefined()
    expect(document.querySelector('[data-diff-approval-failed]')).toBeNull()
  })

  it('takes a child\'s throw as its own failure state, and says so on the console', () => {
    // What React calls on a child crash: the derived state is the failure, and the
    // error is reported (the panel's own note is on screen; this is the report a
    // bug comes from).
    expect(PanelBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ref = mount()
    act(() => { ref.current?.componentDidCatch(new Error('panel exploded'), { componentStack: 'at Body' }) })
    expect(logged).toHaveBeenCalled()
  })

  it('shows a note and a retry instead of a blank surface, and retries', () => {
    const ref = mount()
    // The failure state React would have set: the panel is gone, but not silently.
    act(() => { ref.current?.setState({ failed: true }) })
    expect(screen.queryByText('panel body')).toBeNull()
    expect(screen.getByText('panel.crashed')).toBeDefined()

    // One press re-renders the panel — the recovery the slot boundary cannot give,
    // since an abdicated entry is only restored by reloading the page.
    fireEvent.click(screen.getByText('action.retry'))
    expect(screen.getByText('panel body')).toBeDefined()
    expect(document.querySelector('[data-diff-approval-failed]')).toBeNull()
  })
})
