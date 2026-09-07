/** A compact HSV color picker (saturation/value square + hue bar + hex/RGB
 *  input). Avoids the browser-native color dialog, which cannot be themed, so
 *  it matches DSH. Pure helpers are exported for testing. */

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import css from './PendingPanel.module.css'

/** Clamp `n` to `[min, max]`. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** Parse `#rrggbb` / `#rgb` / `rrggbb` / `rgb(r,g,b)` into a normalised
 *  `#rrggbb`, or `undefined` when the text is not a color. */
export function parseColor(input: string): string | undefined {
  const text = input.trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(text)
  if (m !== null) return `#${m[1]!.toLowerCase()}`
  m = /^#?([0-9a-f]{3})$/i.exec(text)
  if (m !== null) return `#${m[1]!.split('').map(c => c + c).join('').toLowerCase()}`
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+\s*)?\)$/i.exec(text)
  if (m !== null) {
    const r = Math.min(255, Number(m[1]))
    const g = Math.min(255, Number(m[2]))
    const b = Math.min(255, Number(m[3]))
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
  }
  return undefined
}

/** Convert a `#rrggbb` hex to HSV (h 0-360, s 0-1, v 0-1). */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const int = m === null ? 0x22c55e : Number.parseInt(m[1]!, 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

/** Convert HSV (h 0-360, s 0-1, v 0-1) to a `#rrggbb` hex. */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs((((h % 360) + 360) % 360) / 60 % 2 - 1))
  const m = v - c
  const hp = ((h % 360) + 360) % 360
  let r = 0
  let g = 0
  let b = 0
  if (hp < 60) { r = c; g = x; b = 0 }
  else if (hp < 120) { r = x; g = c; b = 0 }
  else if (hp < 180) { r = 0; g = c; b = x }
  else if (hp < 240) { r = 0; g = x; b = c }
  else if (hp < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const to8 = (n: number): string => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to8(r)}${to8(g)}${to8(b)}`
}

/** A draggable HSV picker: saturation/value square + hue bar + a hex/RGB text
 *  input. `onChange` reports a normalised `#rrggbb`; `onClose` fires after a
 *  committed text value so the caller can close the popover. */
export function ColorPicker({
  value, onChange, onClose, ariaLabel,
}: {
  value: string
  onChange: (hex: string) => void
  onClose?: () => void
  ariaLabel: string
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [text, setText] = useState(() => value.toUpperCase())
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setHsv(hexToHsv(value))
    setText(value.toUpperCase())
  }, [value])

  const hueColor = `hsl(${hsv.h.toFixed(1)}, 100%, 50%)`

  const commit = (next: string): void => {
    const normalized = parseColor(next)
    if (normalized !== undefined && normalized.toLowerCase() !== value.toLowerCase()) {
      onChange(normalized)
      onClose?.()
    }
  }

  const updateSv = (clientX: number, clientY: number): void => {
    const el = svRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const s = clamp((clientX - rect.left) / rect.width, 0, 1)
    const v = 1 - clamp((clientY - rect.top) / rect.height, 0, 1)
    const hex = hsvToHex(hsv.h, s, v)
    setHsv(prev => ({ h: prev.h, s, v }))
    setText(hex.toUpperCase())
    onChange(hex)
  }

  const updateHue = (clientX: number): void => {
    const el = hueRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const h = clamp((clientX - rect.left) / rect.width, 0, 1) * 360
    const hex = hsvToHex(h, hsv.s, hsv.v)
    setHsv(prev => ({ h, s: prev.s, v: prev.v }))
    setText(hex.toUpperCase())
    onChange(hex)
  }

  const onSvPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    updateSv(e.clientX, e.clientY)
  }
  const onSvPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.buttons > 0) updateSv(e.clientX, e.clientY)
  }
  const onHuePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    updateHue(e.clientX)
  }
  const onHuePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.buttons > 0) updateHue(e.clientX)
  }

  return (
    <div className={css.colorPickerPanel}>
      <div className={css.colorPickerInputRow}>
        <span className={css.colorPickerPreview} style={{ background: value }} aria-hidden="true" />
        <input
          className={css.colorPickerInput}
          value={text}
          aria-label={ariaLabel}
          data-diff-color-input
          onChange={(e) => { setText(e.target.value.toUpperCase()) }}
          onBlur={() => { commit(text) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
        />
      </div>
      <div
        className={css.colorSv}
        ref={svRef}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
        onPointerDown={onSvPointerDown}
        onPointerMove={onSvPointerMove}
        role="slider"
        aria-label={`${ariaLabel} color`}
        aria-valuetext={value}
      >
        <span className={css.colorSvCursor} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} aria-hidden="true" />
      </div>
      <div
        className={css.colorHue}
        ref={hueRef}
        style={{ background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)' }}
        onPointerDown={onHuePointerDown}
        onPointerMove={onHuePointerMove}
        role="slider"
        aria-label={`${ariaLabel} hue`}
      >
        <span className={css.colorHueCursor} style={{ left: `${(hsv.h / 360) * 100}%` }} aria-hidden="true" />
      </div>
    </div>
  )
}
