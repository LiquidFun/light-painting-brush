// The field evaluator. This is the whole interpolation and compositing model
// (REQUIREMENTS §4.4, §6.2).
//
// X is LED index, Y is time. The project background is the base, and each layer
// is sampled as RGBA and composited over it bottom to top with its own opacity
// and blend mode.
//
// A keyframe layer is an inverse-distance-weighted mean of the keyframes whose
// radius reaches the cell. Its alpha falls off toward the edge of every radius,
// via a small constant background weight, so regions outside every radius decay
// to whatever is underneath rather than being colonised by the nearest distant
// keyframe.
//
// Output is gamma-encoded sRGB in 0..1 — correct for the screen. Gamma for the
// LEDs is applied later, in payload.ts, at the very end of the pipeline.

import { easingFn } from '../model/easing'
import { clamp01, hexToRgb, mixSpace } from '../model/color'
import type { RGB } from '../model/color'
import { frameCount, isFlatCurve, sampleCurve } from '../model/project'
import type {
  BlendMode,
  ImageLayer,
  KeyframeLayer,
  Keyframe,
  PaintLayer,
  Project,
} from '../model/types'
import { getImage } from './imageCache'
import { getPaintSurface } from './paintCache'
import { createSampler } from './patterns'
import type { RGBA, Sampler } from './patterns'

/** Weight of the "nothing here" sample that pulls a keyframe layer's alpha down. */
export const BACKGROUND_WEIGHT = 1e-3

const KIND_POINT = 0
const KIND_ROW = 1
const KIND_COLUMN = 2

export type Evaluator = {
  width: number
  height: number
  /** Time in ms of pixel row `y`. */
  timeAt(y: number): number
  /** Evaluate one cell. `u` and `v` are normalised to [0,1]. */
  cell(u: number, v: number, out: RGB): void
}

function createKeyframeSampler(layer: KeyframeLayer, project: Project): Sampler {
  const { ledCount, durationMs, falloffPower: p } = project
  const keyframes = layer.keyframes
  const n = keyframes.length

  const kind = new Uint8Array(n)
  const uk = new Float64Array(n)
  const vk = new Float64Array(n)
  const radius = new Float64Array(n)
  const bright = new Float64Array(n)
  const hard = new Uint8Array(n)
  const ease: ((t: number) => number)[] = new Array(n)
  const comps = new Float64Array(n * 3)
  const weights = new Float64Array(n)

  const space = mixSpace(project.colorSpace)
  const uDiv = ledCount > 1 ? ledCount - 1 : 1
  const vDiv = durationMs > 0 ? durationMs : 1

  for (let i = 0; i < n; i++) {
    const k: Keyframe = keyframes[i]
    kind[i] = k.kind === 'row' ? KIND_ROW : k.kind === 'column' ? KIND_COLUMN : KIND_POINT
    uk[i] = k.led / uDiv
    vk[i] = k.timeMs / vDiv
    radius[i] = Math.max(k.radius, 1e-4)
    bright[i] = k.brightness
    hard[i] = k.hard ? 1 : 0
    ease[i] = easingFn(k.easing)
    space.encode(hexToRgb(k.color), comps, i * 3)
  }

  const mixed: RGB = [0, 0, 0]

  return (u, v, out) => {
    let total = 0

    // A hard keyframe wins outright inside its radius; nearest one takes it.
    // Without this the tool can only make soft washes.
    let hardWinner = -1
    let hardDist = Infinity

    for (let i = 0; i < n; i++) {
      const r = radius[i]
      let d: number
      if (kind[i] === KIND_ROW) {
        d = Math.abs(v - vk[i])
      } else if (kind[i] === KIND_COLUMN) {
        d = Math.abs(u - uk[i])
      } else {
        d = Math.hypot(u - uk[i], v - vk[i])
      }

      if (d >= r) {
        weights[i] = 0
        continue
      }

      if (hard[i] === 1 && d < hardDist) {
        hardDist = d
        hardWinner = i
      }

      const t = d / r
      const falloff = 1 - ease[i](t)
      const w = falloff <= 0 ? 0 : Math.pow(falloff, p) / Math.pow(Math.max(d, 1e-6), p)
      weights[i] = w
      total += w
    }

    if (total <= 0) {
      out[3] = 0
      return
    }

    let alpha: number
    if (hardWinner >= 0) {
      for (let i = 0; i < n; i++) weights[i] = 0
      weights[hardWinner] = 1
      total = 1
      // A hard keyframe means a crisp line, so it must be fully opaque.
      alpha = 1
    } else {
      alpha = total / (total + BACKGROUND_WEIGHT)
    }

    space.mix(comps, weights, n, total, mixed)

    // Brightness is its own scalar field, interpolated with the same weights.
    let b = 0
    for (let i = 0; i < n; i++) {
      const w = weights[i]
      if (w !== 0) b += w * bright[i]
    }
    b = clamp01(b / total)

    out[0] = clamp01(mixed[0]) * b
    out[1] = clamp01(mixed[1]) * b
    out[2] = clamp01(mixed[2]) * b
    out[3] = alpha
  }
}

function createImageSampler(layer: ImageLayer, width: number, height: number): Sampler {
  const sample = getImage(layer.src, width, height, layer.fit)
  if (!sample) {
    // Still decoding, or failed. Contribute nothing; useField re-runs on notify.
    return (_u, _v, out) => {
      out[3] = 0
    }
  }
  const { data } = sample
  const xMax = width - 1
  const yMax = height - 1
  return (u, v, out) => {
    const x = Math.round(clamp01(u) * xMax)
    const y = Math.round(clamp01(v) * yMax)
    const i = (y * width + x) * 4
    out[0] = data[i]
    out[1] = data[i + 1]
    out[2] = data[i + 2]
    out[3] = data[i + 3]
  }
}

/** src * a over dst, in gamma-encoded sRGB. Both are 0..1. */
function blendChannel(mode: BlendMode, dst: number, src: number, a: number): number {
  switch (mode) {
    case 'add':
      return dst + src * a
    case 'screen':
      return 1 - (1 - dst) * (1 - src * a)
    case 'multiply':
      return dst * (1 - a) + dst * src * a
    case 'normal':
      return dst * (1 - a) + src * a
  }
}

/**
 * A paint layer is exactly one pixel per cell, so this is a lookup rather than a
 * resample — no filtering, no fit modes, nothing that could soften a stroke.
 */
function createPaintSampler(layer: PaintLayer, width: number, height: number): Sampler {
  const surface = getPaintSurface(layer.id, layer.src, width, height)
  const xMax = width - 1
  const yMax = height - 1
  return (u, v, out) => {
    const x = Math.round(clamp01(u) * xMax)
    const y = Math.round(clamp01(v) * yMax)
    const i = (y * surface.width + x) * 4
    const a = surface.data[i + 3] / 255
    if (a <= 0) {
      out[3] = 0
      return
    }
    out[0] = surface.data[i] / 255
    out[1] = surface.data[i + 1] / 255
    out[2] = surface.data[i + 2] / 255
    out[3] = a
  }
}

export function createEvaluator(project: Project): Evaluator {
  const { ledCount } = project
  const frames = frameCount(project)
  const background = hexToRgb(project.background)

  const layers = project.layers
    .filter((l) => !l.hidden && l.opacity > 0)
    .map((l) => {
      const sample: Sampler =
        l.kind === 'keyframes'
          ? createKeyframeSampler(l, project)
          : l.kind === 'pattern'
            ? createSampler(l.pattern, project.colorSpace, { width: ledCount, height: frames })
            : l.kind === 'image'
              ? createImageSampler(l, ledCount, frames)
              : createPaintSampler(l, ledCount, frames)
      return { sample, opacity: l.opacity, blend: l.blend }
    })

  const rgba: RGBA = [0, 0, 0, 0]

  // The two curves multiply into a 2D envelope over the finished composite.
  // Skipped entirely when both are flat, which is the common case.
  const { brightnessX, brightnessY } = project
  const shaped = !isFlatCurve(brightnessX) || !isFlatCurve(brightnessY)

  return {
    width: ledCount,
    height: frames,
    timeAt: (y) => (y * 1000) / project.fps,

    cell(u, v, out) {
      out[0] = background[0]
      out[1] = background[1]
      out[2] = background[2]

      for (const layer of layers) {
        rgba[3] = 0
        layer.sample(u, v, rgba)
        const a = rgba[3] * layer.opacity
        if (a <= 0) continue
        out[0] = clamp01(blendChannel(layer.blend, out[0], rgba[0], a))
        out[1] = clamp01(blendChannel(layer.blend, out[1], rgba[1], a))
        out[2] = clamp01(blendChannel(layer.blend, out[2], rgba[2], a))
      }

      // After compositing and before gamma, which happens in payload.ts. Scaling
      // the blended result is what makes this read as a dimmer, rather than as a
      // change to any one layer's colour.
      if (shaped) {
        const k = sampleCurve(brightnessX, u) * sampleCurve(brightnessY, v)
        out[0] *= k
        out[1] *= k
        out[2] *= k
      }
    },
  }
}

export type Field = {
  width: number
  height: number
  /** width * height * 3, gamma-encoded sRGB in 0..1, row-major, y = time. */
  data: Float32Array
}

/** Evaluates the whole field: ledCount x frameCount cells. */
export function evaluateField(project: Project): Field {
  const ev = createEvaluator(project)
  const { width, height } = ev
  const data = new Float32Array(width * height * 3)
  const cell: RGB = [0, 0, 0]
  const uDiv = width > 1 ? width - 1 : 1
  const vDiv = project.durationMs > 0 ? project.durationMs : 1

  for (let y = 0; y < height; y++) {
    const v = ev.timeAt(y) / vDiv
    const row = y * width * 3
    for (let x = 0; x < width; x++) {
      ev.cell(x / uDiv, v, cell)
      data[row + x * 3] = cell[0]
      data[row + x * 3 + 1] = cell[1]
      data[row + x * 3 + 2] = cell[2]
    }
  }

  return { width, height, data }
}

/** Quantises the field for the screen. No gamma: the screen wants sRGB. */
/**
 * A coarse sample of the same evaluator, for library thumbnails.
 *
 * Sampling the grid directly rather than evaluating the real field and scaling
 * it down: a preview needs a few thousand cells, not ledCount x frameCount, and
 * the library panel renders every project at once.
 */
export function evaluatePreview(project: Project, width: number, height: number): Field {
  const ev = createEvaluator(project)
  const w = Math.max(1, Math.min(width, ev.width))
  const h = Math.max(1, Math.min(height, ev.height))
  const data = new Float32Array(w * h * 3)
  const cell: RGB = [0, 0, 0]
  const uDiv = w > 1 ? w - 1 : 1
  const vDiv = h > 1 ? h - 1 : 1

  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    for (let x = 0; x < w; x++) {
      ev.cell(x / uDiv, y / vDiv, cell)
      data[row + x * 3] = cell[0]
      data[row + x * 3 + 1] = cell[1]
      data[row + x * 3 + 2] = cell[2]
    }
  }
  return { width: w, height: h, data }
}

export function fieldToImageData(field: Field): ImageData {
  const { width, height, data } = field
  const px = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    px[j] = data[i] * 255
    px[j + 1] = data[i + 1] * 255
    px[j + 2] = data[i + 2] * 255
    px[j + 3] = 255
  }
  return new ImageData(px, width, height)
}
