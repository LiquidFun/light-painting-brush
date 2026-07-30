// A thumbnail of what a project would photograph, for the library list.
//
// Same evaluator as the canvas, sampled on a coarse grid — the library renders
// every project at once, and a preview needs a few thousand cells rather than
// ledCount x frameCount. Rendered off the paint path with an idle callback so
// opening the panel with a dozen projects does not stall the sheet animation.

import { useEffect, useRef } from 'react'

import type { Project } from '../model/types'
import { evaluatePreview, fieldToImageData } from '../render/field'

const W = 44
const H = 30

export function ProjectThumb({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    const render = () => {
      const canvas = ref.current
      if (cancelled || !canvas) return
      const field = evaluatePreview(project, W, H)
      canvas.width = field.width
      canvas.height = field.height
      canvas.getContext('2d')?.putImageData(fieldToImageData(field), 0, 0)
    }

    const idle = window.requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined
    if (idle) {
      const handle = idle(render, { timeout: 300 })
      return () => {
        cancelled = true
        window.cancelIdleCallback?.(handle)
      }
    }
    // Safari has no requestIdleCallback; a frame's delay is close enough.
    const raf = requestAnimationFrame(render)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
    // updatedAt covers every edit, and is cheaper to compare than the project.
  }, [project, project.updatedAt])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="shrink-0 rounded border border-line bg-bg"
      style={{ width: W, height: H, imageRendering: 'pixelated' }}
    />
  )
}
