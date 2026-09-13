/**
 * A crash inside the panel must not take the review away for the rest of the page.
 *
 * The slot renderer wraps every seat in its own boundary, but a crash there
 * *abdicates* the entry: the footer row, the header button and the docked tab
 * disappear for the life of the page, with nothing on screen to say why and no way
 * back but a reload. This boundary keeps a failure inside our own tree instead —
 * the entry stays registered, it says what happened, and one press retries the
 * render — so a broken panel can never present as "the panel is gone" or as a
 * blank surface with no explanation.
 *
 * @module dsh-diff-approval/client/boundary
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { Translator } from './locales.ts'
import css from './PendingPanel.module.css'

/** Props of the boundary and of the face it shows in place of its children. */
export interface PanelBoundaryProps {
  /** The panel mount to keep contained. */
  children?: ReactNode
  /** The panel's translator, for the failure note's copy. */
  t: Translator
}

/** State: whether a child has thrown since the last retry. */
interface PanelBoundaryState {
  failed: boolean
}

/**
 * Keep one panel mount's crash inside its own slot entry, with a visible note and
 * a retry that re-renders it.
 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { failed: false }

  static getDerivedStateFromError(): PanelBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The app's own console stays the place a report comes from; this only makes
    // sure there *is* one, and that the screen says something.
    console.error('diff-approval panel crashed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { t } = this.props
    return (
      <div className={css.panelFailure} role="alert" data-diff-approval-failed>
        <span className={css.panelFailureText}>{t('panel.crashed')}</span>
        <button
          type="button"
          className={css.panelFailureRetry}
          data-diff-approval-failed-retry
          onClick={() => { this.setState({ failed: false }) }}
        >
          {t('action.retry')}
        </button>
      </div>
    )
  }
}
