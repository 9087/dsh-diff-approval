/**
 * The floating panel's coverage control: one header button, and a popover of
 * three glyph buttons — cover the left sidebar, the composer below, the right
 * sidebar. All three on is what the panel used to call "fullscreen".
 *
 * Each glyph is the same rounded rectangle with one band highlighted, drawn to
 * the product's icon conventions (16px grid, ~1.4px ink, `currentColor`): the
 * band is filled while that side is covered and hollow while it is not, so the
 * shape says *which* edge and the fill says whether it is on. The popover is a
 * row rather than the kit's vertical menu because these are three independent
 * switches, not a list of choices.
 *
 * @module dsh-diff-approval/client/coverage-control
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PendingPanel.module.css'
import type { DiffApprovalCover } from './settings.ts'
import type { Translator } from './locales.ts'

/** One coverage switch: its key, and the edge its glyph highlights. */
type CoverKey = keyof DiffApprovalCover

/** The switches in the popover, in the order the panel names them: left, top,
 *  right, bottom. */
const COVER_ROWS: readonly { key: CoverKey; label: 'cover.top' | 'cover.left' | 'cover.composer' | 'cover.right' }[] = [
  { key: 'left', label: 'cover.left' },
  { key: 'top', label: 'cover.top' },
  { key: 'right', label: 'cover.right' },
  { key: 'composer', label: 'cover.composer' },
]

/** The rectangle every coverage glyph is built on: a wide panel in the 16 grid. */
const FRAME = { x: 1.4, y: 3, w: 13.2, h: 10, r: 1.6 }
/** How thick the highlighted band is, along the edge it marks. */
const BAND = 3.4

/**
 * One coverage glyph: the frame, with the edge named by `side` marked — filled
 * while that side is covered, hollow while it is not.
 * @param props - which edge, whether it is on, and the drawn size in px.
 * @returns the glyph.
 */
function CoverEdgeIcon({ side, on, size }: { side: CoverKey; on: boolean; size: number }): ReactNode {
  const { x, y, w, h } = FRAME
  // The band hugs the inside of the edge it marks.
  const band = side === 'left'
    ? { x, y, width: BAND, height: h }
    : side === 'right'
      ? { x: x + w - BAND, y, width: BAND, height: h }
      : side === 'top'
        ? { x, y, width: w, height: BAND }
        : { x, y: y + h - BAND, width: w, height: BAND }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x={x} y={y} width={w} height={h} rx={FRAME.r} stroke="currentColor" strokeWidth="1.4" />
      <rect
        x={band.x}
        y={band.y}
        width={band.width}
        height={band.height}
        rx={side === 'composer' || side === 'top' ? 0.8 : FRAME.r - 0.4}
        {...(on
          ? { fill: 'currentColor' }
          : { stroke: 'currentColor', strokeWidth: '1.4' })}
      />
    </svg>
  )
}

/**
 * The coverage control's own mark: a frame with its four corners drawn, reading
 * as "how much of the frame the panel takes" — distinct from the two-arrow
 * fullscreen glyph the product ships.
 * @param props - the drawn size in px.
 * @returns the glyph.
 */
function CoverFrameIcon({ size }: { size: number }): ReactNode {
  const arm = 4.2
  const near = 2.2
  const far = 13.8
  const corners = [
    // Top-left, top-right, bottom-right, bottom-left.
    `M${near} ${near + arm}V${near + 1}h${arm - 1}`,
    `M${far - arm} ${near + 1}h${arm - 1}v${arm - 1}`,
    `M${far - 1} ${far - arm}h-${arm - 1}v-${arm - 1}`,
    `M${near + arm} ${far - 1}H${near + 1}v-${arm - 1}`,
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      {corners.map(d => (
        <path key={d} d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

export interface CoverageControlProps {
  t: Translator
  cover: DiffApprovalCover
  onToggle: (key: CoverKey) => void
}

/** How long the chord's on-screen echo stays up, matching its CSS animation. */
export const COVER_NOTICE_MS = 1250

/**
 * The chord's echo: the same row of glyphs the popover shows, centred on screen,
 * shown the moment a coverage chord flips a switch and fading out after a second.
 * It is a report, not a control — nothing in it is pressable — so a keyboard flip
 * is as visible as a click, without a pointer target appearing under the mouse.
 * @param props - copy, the coverage after the flip, and which edge just changed.
 * @returns the notice.
 */
export function CoverageNotice({ t, cover, changed }: { t: Translator; cover: DiffApprovalCover; changed: CoverKey }): ReactNode {
  const label = COVER_ROWS.find(row => row.key === changed)
  return createPortal(
    <div className={css.coverNotice} data-diff-approval-cover-notice role="status" aria-live="polite">
      <div className={`${css.coverCard} ${css.coverNoticeCard}`} aria-hidden>
        {COVER_ROWS.map(({ key }) => (
          <span
            key={key}
            className={css.coverNoticeGlyph}
            data-on={cover[key] ? '' : undefined}
            data-changed={key === changed ? '' : undefined}
            data-diff-approval-cover-notice-glyph={key}
          >
            <CoverEdgeIcon side={key} on={cover[key]} size={28} />
          </span>
        ))}
      </div>
      <span className={css.coverNoticeText}>
        {t('cover.notice', {
          label: t(label?.label ?? 'cover.left'),
          state: t(cover[changed] ? 'cover.on' : 'cover.off'),
        })}
      </span>
    </div>,
    document.body,
  )
}

/**
 * The trigger and its popover. Marked with `data-diff-approval-cover`, and each
 * switch with `data-diff-approval-cover-<key>`, so the two halves are addressable
 * apart.
 * @param props - copy, the current coverage, and what a switch does.
 * @returns the header control.
 */
export function CoverageControl({ t, cover, onToggle }: CoverageControlProps): ReactElement {
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLSpanElement | null>(null)
  // The popover is a press-away dismissible, like the kit's menus: a press
  // outside it (or Escape) closes it, and the panel's own Escape handling yields
  // while it is up so one press never closes two things. The press is taken in the
  // *capture* phase: controls that stop their presses from bubbling (the mode
  // switch's own handler does) would otherwise leave this popover open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && hostRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  return (
    <span className={css.coverHost} ref={hostRef}>
      <Tooltip label={t('action.cover')} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.expand}
          data-diff-approval-cover
          aria-label={t('action.cover')}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <CoverFrameIcon size={14} />
        </button>
      </Tooltip>
      {open && (
        <div className={`${css.coverCard} ${css.coverPopover}`} data-diff-approval-cover-popover role="group" aria-label={t('action.cover')}>
          {COVER_ROWS.map(({ key, label }) => (
            <Tooltip key={key} label={t(label)} side="bottom" delayMs={0}>
              <button
                type="button"
                className={css.coverButton}
                data-diff-approval-cover-switch={key}
                data-on={cover[key] ? '' : undefined}
                aria-label={t(label)}
                aria-pressed={cover[key]}
                onClick={() => { onToggle(key) }}
              >
                <CoverEdgeIcon side={key} on={cover[key]} size={20} />
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </span>
  )
}
