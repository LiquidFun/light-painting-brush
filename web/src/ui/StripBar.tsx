// The honest preview: a horizontal bar of ledCount cells showing exactly what
// the physical strip displays at the playhead. Sampled from the same frame the
// device would play, not from a smoothed curve (§4.6).

import { useEffect, useRef } from 'react'

import type { Field } from '../render/field'

export function StripBar({
  field,
  timeMs,
  fps,
}: {
  field: Field
  timeMs: number
  fps: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const frame = Math.max(0, Math.min(field.height - 1, Math.round(timeMs / (1000 / fps))))

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement
    const cssWidth = parent?.clientWidth ?? field.width
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(cssWidth * dpr))
    canvas.height = Math.round(28 * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const cell = canvas.width / field.width
    const row = frame * field.width * 3
    for (let x = 0; x < field.width; x++) {
      const r = Math.round(field.data[row + x * 3] * 255)
      const g = Math.round(field.data[row + x * 3 + 1] * 255)
      const b = Math.round(field.data[row + x * 3 + 2] * 255)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      // Half-pixel gaps at this size read as dirt, so cells are drawn flush.
      ctx.fillRect(Math.floor(x * cell), 0, Math.ceil(cell), canvas.height)
    }
  }, [field, frame])

  return (
    <div className="w-full border-y border-line bg-bg px-0">
      <canvas ref={ref} className="block h-7 w-full" aria-label="Strip at the playhead" />
    </div>
  )
}
