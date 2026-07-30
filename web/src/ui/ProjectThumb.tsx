// A thumbnail of what a project would photograph, for the library list.
//
// Same evaluator as the canvas, sampled on a coarse grid — the library renders
// every project at once, and a preview needs a few thousand cells rather than
// ledCount x frameCount.

import { useEffect, useRef } from 'react'

import type { Project } from '../model/types'
import { evaluatePreview, fieldToImageData } from '../render/field'

const W = 44
const H = 30

export function ProjectThumb({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawnFor = useRef<number | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = () => {
      if (drawnFor.current === project.updatedAt) return
      const field = evaluatePreview(project, W, H)
      canvas.width = field.width
      canvas.height = field.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.putImageData(fieldToImageData(field), 0, 0)
      drawnFor.current = project.updatedAt
    }

    // Drawn when the canvas is actually on screen, not when it mounts.
    //
    // The sheet is always mounted and merely translated off-screen when closed,
    // so mounting says nothing about visibility: every preview was being
    // computed on page load and painted into a canvas nobody had shown yet,
    // which is where they were being lost. Waiting for the element to appear
    // also means a closed sheet costs nothing.
    drawnFor.current = null
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) draw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
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
