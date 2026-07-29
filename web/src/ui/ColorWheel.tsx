// HSV wheel: hue around, saturation out from the centre, value on its own slider.
// The only saturated pixels in the chrome are in here and in the user's canvas,
// which is the point.

import { useEffect, useMemo, useRef, useState } from 'react'

import { hexToRgb, hsvToRgb, isHex, normaliseHex, rgbToHex, rgbToHsv } from '../model/color'

const SIZE = 168

export function ColorWheel({
  value,
  onChange,
  onCommitStart,
}: {
  value: string
  onChange: (hex: string) => void
  onCommitStart?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [text, setText] = useState(value)
  const [h, s, v] = useMemo(() => {
    const rgb = hexToRgb(value)
    return rgbToHsv(rgb[0], rgb[1], rgb[2])
  }, [value])

  useEffect(() => setText(value), [value])

  // The wheel bitmap only depends on `value` through its brightness.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const px = Math.round(SIZE * dpr)
    canvas.width = px
    canvas.height = px
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const image = ctx.createImageData(px, px)
    const r0 = px / 2
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const dx = x - r0 + 0.5
        const dy = y - r0 + 0.5
        const dist = Math.hypot(dx, dy) / r0
        const i = (y * px + x) * 4
        if (dist > 1) continue
        const hue = (Math.atan2(dy, dx) * 180) / Math.PI
        const rgb = hsvToRgb(hue, Math.min(1, dist), Math.max(v, 0.15))
        image.data[i] = rgb[0] * 255
        image.data[i + 1] = rgb[1] * 255
        image.data[i + 2] = rgb[2] * 255
        // Feather the rim so it does not alias into a cog shape.
        image.data[i + 3] = 255 * Math.min(1, (1 - dist) * r0 * 0.5)
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [v])

  const pick = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const r0 = rect.width / 2
    const dx = e.clientX - rect.left - r0
    const dy = e.clientY - rect.top - r0
    const dist = Math.min(1, Math.hypot(dx, dy) / r0)
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI
    onChange(rgbToHex(hsvToRgb(hue, dist, Math.max(v, 0.02))))
  }

  const markerX = SIZE / 2 + Math.cos((h * Math.PI) / 180) * s * (SIZE / 2)
  const markerY = SIZE / 2 + Math.sin((h * Math.PI) / 180) * s * (SIZE / 2)

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <canvas
            ref={canvasRef}
            className="touch-none rounded-full"
            style={{ width: SIZE, height: SIZE }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              onCommitStart?.()
              pick(e)
            }}
            onPointerMove={(e) => {
              if (e.buttons > 0) pick(e)
            }}
          />
          <span
            className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.8)]"
            style={{ left: markerX, top: markerY }}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div
            className="h-11 w-full rounded border border-line-strong"
            style={{ background: value }}
            aria-label="Selected colour"
          />
          <input
            type="text"
            inputMode="text"
            spellCheck={false}
            value={text}
            aria-label="Hex colour"
            onChange={(e) => {
              setText(e.target.value)
              if (isHex(e.target.value)) onChange(normaliseHex(e.target.value))
            }}
            onBlur={() => setText(value)}
          />
          <label className="block">
            <span className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-mute">Value</span>
              <span className="num text-sm text-dim">{Math.round(v * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(v * 100)}
              onPointerDown={onCommitStart}
              onChange={(e) =>
                onChange(rgbToHex(hsvToRgb(h, s, Number(e.target.value) / 100)))
              }
            />
          </label>
        </div>
      </div>
    </div>
  )
}
