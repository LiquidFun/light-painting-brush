// Brightness multiplier curves (REQUIREMENTS §6.2).
//
// Two of these flank the canvas: one across LED index, one down time. They
// multiply together into a 2D envelope over the finished composite, so the pair
// is a vignette for the photograph rather than a property of any one layer.
//
// Painted rather than dragged by control points. There is nothing to grab and
// nothing to miss, which is what makes it usable one-handed on a phone in the
// dark — and it is the same gesture whichever axis you are on.

import { useCallback, useEffect, useRef } from 'react'

import { flatCurve, sampleCurve } from '../model/project'
import { BRIGHTNESS_POINTS } from '../model/types'

/** Matches GUTTER_TOP/GUTTER_LEFT worth of chrome; enough to paint in, small enough to keep. */
const THICKNESS = 56

export type CurveAxis = 'x' | 'y'

export function BrightnessCurve({
  axis,
  values,
  /** Distance from this element's start to the image area, i.e. the ruler gutter. */
  origin,
  /** Pan and zoomed extent, so the curve tracks the canvas exactly. */
  pan,
  span,
  onChange,
}: {
  axis: CurveAxis
  values: number[]
  origin: number
  pan: number
  span: number
  /** `push` false coalesces a whole paint stroke into one undo step. */
  onChange: (values: number[], push?: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const paintingRef = useRef(false)
  const pushedRef = useRef(false)
  const lastIndexRef = useRef(-1)
  const horizontal = axis === 'x'

  // --- drawing --------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (w === 0 || h === 0) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const style = getComputedStyle(canvas)
    const line = style.getPropertyValue('--line').trim() || '#333'
    const fg = style.getPropertyValue('--fg').trim() || '#eee'

    // `t` runs along the axis the curve applies to; `k` is the multiplier, drawn
    // toward the canvas so the fullest part of the curve touches the image.
    const along = horizontal ? w : h
    const across = horizontal ? h : w
    const at = (t: number) => origin + pan + t * span
    const level = (k: number) => across * (1 - k)

    // The strip only means anything next to the image, so clip to it.
    ctx.save()
    ctx.beginPath()
    if (horizontal) ctx.rect(origin, 0, along - origin, across)
    else ctx.rect(0, origin, across, along - origin)
    ctx.clip()

    // Baseline at 100%, so it is obvious when a curve does nothing.
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath()
    if (horizontal) {
      ctx.moveTo(origin, level(1) + 0.5)
      ctx.lineTo(along, level(1) + 0.5)
    } else {
      ctx.moveTo(level(1) + 0.5, origin)
      ctx.lineTo(level(1) + 0.5, along)
    }
    ctx.stroke()

    // The preview: fill under the curve with the brightness it produces, so the
    // strip shows the effect and not only the numbers.
    const gradient = horizontal
      ? ctx.createLinearGradient(0, across, 0, 0)
      : ctx.createLinearGradient(across, 0, 0, 0)
    gradient.addColorStop(0, 'rgba(255,255,255,0.04)')
    gradient.addColorStop(1, 'rgba(255,255,255,0.30)')

    // One step per on-screen pixel of the curve, capped so a deep zoom cannot
    // turn a repaint into thousands of segments.
    const steps = Math.min(512, Math.max(2, Math.ceil(Math.abs(span))))
    ctx.beginPath()
    if (horizontal) ctx.moveTo(at(0), across)
    else ctx.moveTo(across, at(0))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const k = sampleCurve(values, t)
      if (horizontal) ctx.lineTo(at(t), level(k))
      else ctx.lineTo(level(k), at(t))
    }
    if (horizontal) ctx.lineTo(at(1), across)
    else ctx.lineTo(across, at(1))
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.strokeStyle = fg
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const k = sampleCurve(values, t)
      const x = horizontal ? at(t) : level(k)
      const y = horizontal ? level(k) : at(t)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.restore()
  }, [values, origin, pan, span, horizontal])

  // --- painting -------------------------------------------------------------

  const paint = useCallback(
    (clientX: number, clientY: number) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const alongPx = horizontal ? clientX - rect.left : clientY - rect.top
      const acrossPx = horizontal ? clientY - rect.top : clientX - rect.left
      const acrossMax = horizontal ? rect.height : rect.width

      const t = span === 0 ? 0 : (alongPx - origin - pan) / span
      if (t < 0 || t > 1) return
      const k = clamp01(1 - acrossPx / acrossMax)
      const index = Math.round(t * (BRIGHTNESS_POINTS - 1))

      const next = [...values]
      const from = lastIndexRef.current
      if (from >= 0 && from !== index) {
        // Fill in the samples a fast sweep jumped over, so the stroke is
        // continuous rather than a row of spikes.
        const step = from < index ? 1 : -1
        for (let i = from + step; i !== index; i += step) {
          const f = (i - from) / (index - from)
          next[i] = next[from] * (1 - f) + k * f
        }
      }
      next[index] = k
      lastIndexRef.current = index

      onChange(next, !pushedRef.current)
      pushedRef.current = true
    },
    [values, origin, pan, span, horizontal, onChange],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    paintingRef.current = true
    pushedRef.current = false
    lastIndexRef.current = -1
    paint(e.clientX, e.clientY)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!paintingRef.current) return
    paint(e.clientX, e.clientY)
  }

  const endPaint = () => {
    paintingRef.current = false
    lastIndexRef.current = -1
  }

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0 touch-none bg-panel"
      style={horizontal ? { height: THICKNESS } : { width: THICKNESS }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPaint}
      onPointerCancel={endPaint}
      title={
        horizontal
          ? 'Brightness across the LEDs — drag to paint'
          : 'Brightness over time — drag to paint'
      }
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      <button
        type="button"
        // The strip captures the pointer to paint, and a captured pointer
        // retargets the click to the capture element — so without this the
        // button was painting a dab and never firing its own onClick.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onChange(flatCurve())}
        className="absolute right-1 top-1 rounded border border-line-strong bg-panel px-1.5 py-0.5 text-[10px] text-dim active:bg-raised"
      >
        Reset
      </button>
    </div>
  )
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export { THICKNESS as CURVE_THICKNESS }
