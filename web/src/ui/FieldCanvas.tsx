// The canvas is a preview of the photograph.
//
// X is LED index — left is LED 0 at the base of the stick, right is the tip.
// Y is time — top is t=0, downward is later. Sweep the stick sideways at
// constant speed with the shutter open and the image on the sensor is this
// canvas. Editing and previewing are the same view, deliberately: there is no
// separate preview mode because the thing being edited *is* the output.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createKeyframe } from '../model/project'
import type { Keyframe, Project, Tool } from '../model/types'
import { fieldToImageData } from '../render/field'
import type { Field } from '../render/field'

const GUTTER_TOP = 22
const GUTTER_LEFT = 36
const HANDLE_HIT = 22
const PLAYHEAD_HIT = 14
const LONG_PRESS_MS = 500
const MIN_SCALE = 1
const MAX_SCALE = 12

type View = { scale: number; panX: number; panY: number }

type Drag =
  | { kind: 'none' }
  | { kind: 'point' | 'row' | 'column'; id: string; pushed: boolean }
  | { kind: 'playhead' }
  | { kind: 'pan'; startX: number; startY: number; from: View }
  | { kind: 'pinch'; startDist: number; startCentre: { x: number; y: number }; from: View }

export type CanvasProps = {
  project: Project
  field: Field
  playheadMs: number
  selectedId: string | null
  tool: Tool
  defaultColor: string
  onAdd: (keyframe: Keyframe) => void
  onSelect: (id: string | null) => void
  onMove: (id: string, patch: Partial<Keyframe>, push: boolean) => void
  onScrub: (timeMs: number) => void
  onOpenEditor: () => void
  onContextMenu: (id: string, clientX: number, clientY: number) => void
}

export function FieldCanvas(props: CanvasProps) {
  const {
    project,
    field,
    playheadMs,
    selectedId,
    tool,
    defaultColor,
    onAdd,
    onSelect,
    onMove,
    onScrub,
    onOpenEditor,
    onContextMenu,
  } = props

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ scale: 1, panX: 0, panY: 0 })
  const dragRef = useRef<Drag>({ kind: 'none' })
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const longPressRef = useRef(0)
  const movedRef = useRef(false)

  // The field lives in its own bitmap and is only rebuilt when it changes; the
  // overlay redraws freely on top of it.
  const bitmap = useMemo(() => {
    const off = document.createElement('canvas')
    off.width = field.width
    off.height = field.height
    off.getContext('2d')?.putImageData(fieldToImageData(field), 0, 0)
    return off
  }, [field])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    observer.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  const geom = useMemo(() => {
    const area = {
      x: GUTTER_LEFT,
      y: GUTTER_TOP,
      w: Math.max(1, size.w - GUTTER_LEFT),
      h: Math.max(1, size.h - GUTTER_TOP),
    }
    const spanX = area.w * view.scale
    const spanY = area.h * view.scale
    return {
      area,
      spanX,
      spanY,
      uToX: (u: number) => area.x + view.panX + u * spanX,
      vToY: (v: number) => area.y + view.panY + v * spanY,
      xToU: (x: number) => (x - area.x - view.panX) / spanX,
      yToV: (y: number) => (y - area.y - view.panY) / spanY,
    }
  }, [size, view])

  const clampView = useCallback((next: View, area: { w: number; h: number }): View => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale))
    const spanX = area.w * scale
    const spanY = area.h * scale
    return {
      scale,
      panX: Math.min(0, Math.max(area.w - spanX, next.panX)),
      panY: Math.min(0, Math.max(area.h - spanY, next.panY)),
    }
  }, [])

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setView((prev) => {
        const area = {
          w: Math.max(1, size.w - GUTTER_LEFT),
          h: Math.max(1, size.h - GUTTER_TOP),
        }
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
        const k = scale / prev.scale
        // Keep the point under the fingers fixed.
        const ax = cx - GUTTER_LEFT
        const ay = cy - GUTTER_TOP
        return clampView(
          { scale, panX: ax - k * (ax - prev.panX), panY: ay - k * (ay - prev.panY) },
          area,
        )
      })
    },
    [clampView, size],
  )

  // --- drawing --------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(ctx, {
      size,
      geom,
      bitmap,
      project,
      playheadMs,
      selectedId,
    })
  }, [size, geom, bitmap, project, playheadMs, selectedId])

  // --- hit testing ----------------------------------------------------------

  const hitHandle = useCallback(
    (x: number, y: number): Keyframe | null => {
      const { uToX, vToY, area } = geom
      const uDiv = project.ledCount > 1 ? project.ledCount - 1 : 1
      let best: Keyframe | null = null
      let bestDist = HANDLE_HIT
      // Later keyframes sit on top, so walk backwards.
      for (let i = project.keyframes.length - 1; i >= 0; i--) {
        const k = project.keyframes[i]
        const hx = uToX(k.led / uDiv)
        const hy = vToY(k.timeMs / project.durationMs)
        let d: number
        if (k.kind === 'row') {
          // Grab it by the gutter handle, or anywhere along its line.
          d =
            x < area.x
              ? Math.hypot(x - (area.x - GUTTER_LEFT / 2), y - hy)
              : Math.abs(y - hy)
        } else if (k.kind === 'column') {
          d =
            y < area.y
              ? Math.hypot(x - hx, y - (area.y - GUTTER_TOP / 2))
              : Math.abs(x - hx)
        } else {
          d = Math.hypot(x - hx, y - hy)
        }
        if (d < bestDist) {
          bestDist = d
          best = k
        }
      }
      return best
    },
    [geom, project],
  )

  const localPoint = (e: PointerEvent | React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const clearLongPress = () => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current)
      longPressRef.current = 0
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const p = localPoint(e)
    pointersRef.current.set(e.pointerId, p)
    canvas.setPointerCapture(e.pointerId)
    movedRef.current = false

    if (pointersRef.current.size === 2) {
      // Second finger down: a pinch or a two-finger pan, never a drag.
      clearLongPress()
      const [a, b] = [...pointersRef.current.values()]
      dragRef.current = {
        kind: 'pinch',
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startCentre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        from: view,
      }
      return
    }
    if (pointersRef.current.size > 2) return

    const playY = geom.vToY(playheadMs / project.durationMs)
    const inGutter = p.x < geom.area.x || p.y < geom.area.y
    // With a create tool active, the image is for creating: existing handles and
    // the playhead can still be grabbed, but only by their gutter handles.
    // Otherwise a line drawn across the canvas would block every tap near it.
    const grabbable = tool === 'select' || inGutter
    const hit = grabbable ? hitHandle(p.x, p.y) : null

    if (hit) {
      onSelect(hit.id)
      dragRef.current = { kind: hit.kind, id: hit.id, pushed: false }
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = 0
        dragRef.current = { kind: 'none' }
        onContextMenu(hit.id, e.clientX, e.clientY)
      }, LONG_PRESS_MS)
      return
    }

    if (grabbable && Math.abs(p.y - playY) < PLAYHEAD_HIT) {
      dragRef.current = { kind: 'playhead' }
      onScrub(geom.yToV(p.y) * project.durationMs)
      return
    }

    if (inGutter) {
      // Empty gutter: scrub time / do nothing.
      if (p.x < geom.area.x && p.y >= geom.area.y) {
        dragRef.current = { kind: 'playhead' }
        onScrub(geom.yToV(p.y) * project.durationMs)
      }
      return
    }

    if (tool === 'select') {
      onSelect(null)
      dragRef.current = { kind: 'pan', startX: p.x, startY: p.y, from: view }
      return
    }

    const led = Math.round(geom.xToU(p.x) * (project.ledCount - 1))
    const timeMs = geom.yToV(p.y) * project.durationMs
    const created = createKeyframe(tool, led, timeMs, defaultColor)
    onAdd(created)
    onOpenEditor()
    dragRef.current = { kind: tool, id: created.id, pushed: true }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return
    const p = localPoint(e)
    const prev = pointersRef.current.get(e.pointerId)!
    pointersRef.current.set(e.pointerId, p)
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 2) {
      movedRef.current = true
      clearLongPress()
    }

    const drag = dragRef.current

    if (drag.kind === 'pinch') {
      const values = [...pointersRef.current.values()]
      if (values.length < 2) return
      const [a, b] = values
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const area = {
        w: Math.max(1, size.w - GUTTER_LEFT),
        h: Math.max(1, size.h - GUTTER_TOP),
      }
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, drag.from.scale * (dist / Math.max(drag.startDist, 1))),
      )
      const k = scale / drag.from.scale
      const ax = drag.startCentre.x - GUTTER_LEFT
      const ay = drag.startCentre.y - GUTTER_TOP
      setView(
        clampView(
          {
            scale,
            panX: ax - k * (ax - drag.from.panX) + (centre.x - drag.startCentre.x),
            panY: ay - k * (ay - drag.from.panY) + (centre.y - drag.startCentre.y),
          },
          area,
        ),
      )
      return
    }

    if (drag.kind === 'pan') {
      const area = {
        w: Math.max(1, size.w - GUTTER_LEFT),
        h: Math.max(1, size.h - GUTTER_TOP),
      }
      setView(
        clampView(
          {
            scale: drag.from.scale,
            panX: drag.from.panX + (p.x - drag.startX),
            panY: drag.from.panY + (p.y - drag.startY),
          },
          area,
        ),
      )
      return
    }

    if (drag.kind === 'playhead') {
      onScrub(geom.yToV(p.y) * project.durationMs)
      return
    }

    if (drag.kind === 'none') return

    // Points move in both axes; rows only in time; columns only in LED index.
    const patch: Partial<Keyframe> = {}
    if (drag.kind === 'point' || drag.kind === 'column') {
      patch.led = Math.round(geom.xToU(p.x) * (project.ledCount - 1))
    }
    if (drag.kind === 'point' || drag.kind === 'row') {
      patch.timeMs = Math.round(geom.yToV(p.y) * project.durationMs)
    }
    onMove(drag.id, patch, !drag.pushed)
    dragRef.current = { ...drag, pushed: true }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    clearLongPress()
    const drag = dragRef.current
    if (pointersRef.current.size === 0) dragRef.current = { kind: 'none' }
    if (
      !movedRef.current &&
      (drag.kind === 'point' || drag.kind === 'row' || drag.kind === 'column')
    ) {
      onOpenEditor()
    }
  }

  // Wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY / 300), x, y)
      } else {
        setView((prev) =>
          clampView(
            { ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY },
            {
              w: Math.max(1, size.w - GUTTER_LEFT),
              h: Math.max(1, size.h - GUTTER_TOP),
            },
          ),
        )
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt, clampView, size])

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-bg">
      <canvas
        ref={canvasRef}
        // touch-action: none, or panning turns into pull-to-refresh.
        className="h-full w-full touch-none select-none"
        style={{ width: '100%', height: '100%' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {view.scale > 1.01 && (
        <button
          type="button"
          onClick={() => setView({ scale: 1, panX: 0, panY: 0 })}
          className="num absolute right-2 top-[26px] rounded border border-line bg-panel/90 px-2 py-1 text-xs text-dim"
        >
          {view.scale.toFixed(1)}× · reset
        </button>
      )}
    </div>
  )
}

// --- painting ---------------------------------------------------------------

type DrawArgs = {
  size: { w: number; h: number }
  geom: {
    area: { x: number; y: number; w: number; h: number }
    uToX: (u: number) => number
    vToY: (v: number) => number
  }
  bitmap: HTMLCanvasElement
  project: Project
  playheadMs: number
  selectedId: string | null
}

const TICK_STEPS_LED = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 144]
const TICK_STEPS_MS = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 30_000]

function pickStep(steps: number[], pxPerUnit: number, minPx: number): number {
  for (const step of steps) if (step * pxPerUnit >= minPx) return step
  return steps[steps.length - 1]
}

function draw(ctx: CanvasRenderingContext2D, args: DrawArgs) {
  const { size, geom, bitmap, project, playheadMs, selectedId } = args
  const { area, uToX, vToY } = geom
  const css = getComputedStyle(document.documentElement)
  const fg = css.getPropertyValue('--chrome-fg').trim() || '#e6e9ec'
  const mute = css.getPropertyValue('--chrome-mute').trim() || '#6c757c'
  const line = css.getPropertyValue('--chrome-line').trim() || '#262b30'
  const bg = css.getPropertyValue('--chrome-bg').trim() || '#0c0e10'

  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, size.w, size.h)

  // --- the field ---
  ctx.save()
  ctx.beginPath()
  ctx.rect(area.x, area.y, area.w, area.h)
  ctx.clip()
  // Nearest-neighbour: the strip really is 144 discrete LEDs and pretending
  // otherwise would flatter the preview.
  ctx.imageSmoothingEnabled = false
  const uDiv = project.ledCount > 1 ? project.ledCount - 1 : 1
  // Cell centres, not cell edges: LED 0 sits at u=0, so the bitmap overhangs the
  // span by half a cell at each end. Without this the image and the handles
  // disagree by half an LED.
  const spanX = uToX(1) - uToX(0)
  const spanY = vToY(1) - vToY(0)
  const cellW = spanX / uDiv
  const rowH = (spanY * (1000 / project.fps)) / project.durationMs
  ctx.drawImage(
    bitmap,
    uToX(0) - cellW / 2,
    vToY(0) - rowH / 2,
    bitmap.width * cellW || 1,
    bitmap.height * rowH || 1,
  )

  // --- keyframe geometry inside the image ---
  for (const k of project.keyframes) {
    const selected = k.id === selectedId
    ctx.lineWidth = selected ? 2 : 1
    ctx.setLineDash(selected ? [] : [4, 4])
    ctx.strokeStyle = selected ? fg : 'rgba(255,255,255,0.35)'
    if (k.kind === 'row') {
      const y = vToY(k.timeMs / project.durationMs)
      strokeLine(ctx, area.x, y, area.x + area.w, y)
    } else if (k.kind === 'column') {
      const x = uToX(k.led / uDiv)
      strokeLine(ctx, x, area.y, x, area.y + area.h)
    } else {
      // Rings, not discs: a handle must never hide the colour it produces.
      const x = uToX(k.led / uDiv)
      const y = vToY(k.timeMs / project.durationMs)
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(x, y, selected ? 11 : 8, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = selected ? 4 : 3
      ctx.stroke()
      ctx.strokeStyle = selected ? fg : 'rgba(255,255,255,0.75)'
      ctx.lineWidth = selected ? 2 : 1.5
      ctx.stroke()
      if (selected) {
        ctx.setLineDash([2, 3])
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'
        ctx.lineWidth = 1
        strokeLine(ctx, x, area.y, x, area.y + area.h)
        strokeLine(ctx, area.x, y, area.x + area.w, y)
      }
    }
  }
  ctx.setLineDash([])

  // --- playhead ---
  const py = vToY(playheadMs / project.durationMs)
  ctx.strokeStyle = 'rgba(0,0,0,0.8)'
  ctx.lineWidth = 3
  strokeLine(ctx, area.x, py, area.x + area.w, py)
  ctx.strokeStyle = fg
  ctx.lineWidth = 1
  strokeLine(ctx, area.x, py, area.x + area.w, py)
  ctx.restore()

  // --- gutters ---
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, size.w, area.y)
  ctx.fillRect(0, 0, area.x, size.h)
  ctx.strokeStyle = line
  ctx.lineWidth = 1
  strokeLine(ctx, area.x - 0.5, 0, area.x - 0.5, size.h)
  strokeLine(ctx, 0, area.y - 0.5, size.w, area.y - 0.5)

  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillStyle = mute
  ctx.textBaseline = 'middle'

  // LED ruler along the top.
  const pxPerLed = (uToX(1) - uToX(0)) / uDiv
  const ledStep = pickStep(TICK_STEPS_LED, pxPerLed, 44)
  ctx.textAlign = 'center'
  for (let led = 0; led < project.ledCount; led += ledStep) {
    const x = uToX(led / uDiv)
    if (x < area.x - 1 || x > size.w) continue
    strokeLine(ctx, x, area.y - 4, x, area.y - 1)
    ctx.fillText(String(led), x, area.y / 2)
  }

  // Seconds down the left side.
  const pxPerMs = (vToY(1) - vToY(0)) / project.durationMs
  const msStep = pickStep(TICK_STEPS_MS, pxPerMs, 32)
  ctx.textAlign = 'right'
  for (let ms = 0; ms <= project.durationMs; ms += msStep) {
    const y = vToY(ms / project.durationMs)
    if (y < area.y - 1 || y > size.h) continue
    strokeLine(ctx, area.x - 4, y, area.x - 1, y)
    ctx.fillText((ms / 1000).toFixed(msStep < 1000 ? 1 : 0), area.x - 6, y)
  }

  // --- gutter handles ---
  for (const k of project.keyframes) {
    const selected = k.id === selectedId
    ctx.fillStyle = selected ? fg : mute
    ctx.strokeStyle = bg
    ctx.lineWidth = 2
    if (k.kind === 'row') {
      const y = vToY(k.timeMs / project.durationMs)
      if (y >= area.y - 1) handleBox(ctx, area.x - GUTTER_LEFT / 2, y, selected)
    } else if (k.kind === 'column') {
      const x = uToX(k.led / uDiv)
      if (x >= area.x - 1) handleBox(ctx, x, area.y - GUTTER_TOP / 2, selected)
    } else if (selected) {
      // A selected point also gets gutter ticks, so its coordinates are readable
      // against the rulers.
      const x = uToX(k.led / uDiv)
      const y = vToY(k.timeMs / project.durationMs)
      ctx.fillRect(x - 1, area.y - 6, 2, 5)
      ctx.fillRect(area.x - 6, y - 1, 5, 2)
    }
  }

  // Playhead handle in the left gutter.
  ctx.fillStyle = fg
  ctx.beginPath()
  ctx.moveTo(area.x - 1, py)
  ctx.lineTo(area.x - 9, py - 5)
  ctx.lineTo(area.x - 9, py + 5)
  ctx.closePath()
  ctx.fill()
}

function strokeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function handleBox(ctx: CanvasRenderingContext2D, x: number, y: number, selected: boolean) {
  const r = selected ? 6 : 5
  ctx.beginPath()
  ctx.rect(x - r, y - r, r * 2, r * 2)
  ctx.stroke()
  ctx.fill()
}
