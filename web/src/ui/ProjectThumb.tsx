// A thumbnail of what a project would photograph, for the library list.
//
// Same evaluator as the canvas, sampled on a coarse grid — the library renders
// every project at once, and a preview needs a few thousand cells rather than
// ledCount x frameCount.

import { useEffect, useRef } from 'react'

import type { Project } from '../model/types'
import { evaluatePreview, fieldToImageData } from '../render/field'
import { subscribeImages } from '../render/imageCache'
import { subscribePaint } from '../render/paintCache'

const W = 44
const H = 30

export function ProjectThumb({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawnFor = useRef<number | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let visible = false

    const draw = () => {
      const field = evaluatePreview(project, W, H)
      // Assigning width clears the canvas, so only do it when it actually
      // changed — otherwise every redraw is a visible blank-then-paint.
      if (canvas.width !== field.width) canvas.width = field.width
      if (canvas.height !== field.height) canvas.height = field.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.putImageData(fieldToImageData(field), 0, 0)
      drawnFor.current = project.updatedAt
    }

    // One redraw per frame at most. A library of N projects decoding N images
    // produces N notifications, and without this each one repaints every
    // thumbnail.
    let pending = 0
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        if (visible) draw()
      })
    }

    // Drawn when the canvas is on screen rather than when it mounts. The sheet
    // is always mounted and merely translated off-screen when closed, so
    // mounting says nothing about visibility, and a closed sheet should not cost
    // an evaluation per project.
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting)
      if (visible && drawnFor.current !== project.updatedAt) schedule()
    })
    observer.observe(canvas)

    // Image and paint layers decode asynchronously, so on a fresh page load they
    // contribute nothing to the first evaluation and a project made of them
    // renders black. useField watches these caches for the main canvas; without
    // the same here the thumbnail stayed black until an unrelated edit happened
    // to force a redraw.
    const unsubscribeImages = subscribeImages(schedule)
    const unsubscribePaint = subscribePaint(schedule)

    return () => {
      cancelAnimationFrame(pending)
      observer.disconnect()
      unsubscribeImages()
      unsubscribePaint()
    }
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
