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
import { createSweepWarp } from './sweep'
import type { RGBA, Sampler } from './patterns'

/**
 * Coverage: how much of this cell a keyframe claims, 0..1.
 *
 * Alpha used to come from the inverse-distance weights themselves, as
 * `total / (total + BACKGROUND_WEIGHT)`. Those weights are unbounded at a
 * keyframe's own position, so that saturated at 1 across essentially the whole
 * radius and then fell off a cliff — every keyframe rendered as a hard disc
 * however wide its radius or gentle its easing.
 *
 * Coverage is derived from the falloff shape instead, so radius, easing and
 * softness all become visible. The distance weights still decide which colour
 * wins where, which is what they are actually good at.
 */

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
  const inner = new Float64Array(n)
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
    // Where the fade starts, as a fraction of the radius. softness 0 puts it at
    // the rim (a hard disc), softness 1 at the centre.
    inner[i] = 1 - clamp01(k.softness)
    bright[i] = k.brightness
    hard[i] = k.hard ? 1 : 0
    ease[i] = easingFn(k.easing)
    space.encode(hexToRgb(k.color), comps, i * 3)
  }

  const mixed: RGB = [0, 0, 0]

  return (u, v, out) => {
    let total = 0
    let coverage = 0

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

      // Full strength inside the hard core, then eased out across the soft band.
      const edge = inner[i]
      const t = edge >= 1 ? 0 : (d / r - edge) / (1 - edge)
      const cover = t <= 0 ? 1 : 1 - ease[i](t)
      coverage += cover - coverage * cover  // soft union of overlapping keyframes

      // Distance weights still choose the colour; they no longer set the alpha.
      const w = Math.pow(Math.max(cover, 1e-6), p) / Math.pow(Math.max(d, 1e-6), p)
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
      alpha = clamp01(coverage)
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

/**
 * Raster row for a normalised time, for the two samplers that read a raster
 * sized to the grid being evaluated.
 *
 * The two axes do not share a convention and must not be written as if they did.
 * `u` is an endpoint: LED 0 sits at 0 and LED ledCount-1 sits at 1, so it maps
 * onto `width - 1`. `v` is a cell centre: the evaluators hand out `y / height`,
 * which reaches (height-1)/height and never 1, and FieldCanvas draws the field
 * from `vToY(0) - rowH/2` to match. Mapping `v` onto `height - 1` the way `u` is
 * mapped therefore squashed the whole time axis by one row — the last frame was
 * unreachable, so a stroke painted on it never rendered and never reached the
 * strip, and half the remaining rows drew one row low.
 *
 * `round`, not `floor`: `(y / height) * height` is not exactly `y` in floating
 * point, and flooring 96.99999999999999 silently loses another row.
 */
function rowAt(v: number, height: number): number {
  const y = Math.round(clamp01(v) * height)
  return y < height ? y : height - 1
}

function createImageSampler(layer: ImageLayer, width: number, height: number): Sampler {
  const sample = getImage(layer.src, width, height, layer.fit, {
    rotation: layer.rotation,
    flipX: layer.flipX,
    flipY: layer.flipY,
  })
  if (!sample) {
    // Still decoding, or failed. Contribute nothing; useField re-runs on notify.
    return (_u, _v, out) => {
      out[3] = 0
    }
  }
  const { data } = sample
  const xMax = width - 1
  // Samples are stored as bytes; the field works in 0..1.
  const S = 1 / 255
  return (u, v, out) => {
    const x = Math.round(clamp01(u) * xMax)
    const y = rowAt(v, height)
    const i = (y * width + x) * 4
    out[0] = data[i] * S
    out[1] = data[i + 1] * S
    out[2] = data[i + 2] * S
    out[3] = data[i + 3] * S
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
  // Indexed against the surface, not the grid being sampled, so a coarse preview
  // reads the same authoritative pixels instead of forcing a second copy.
  const xMax = surface.width - 1
  return (u, v, out) => {
    const x = Math.round(clamp01(u) * xMax)
    const y = rowAt(v, surface.height)
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

/**
 * `sampleSize` is the grid the result will actually be read on. It only affects
 * image layers, which resample: a 44x30 thumbnail asking for a full-resolution
 * resample allocated megabytes per image and thrashed the cache, which showed up
 * as the whole library flickering.
 */
export function createEvaluator(
  project: Project,
  sampleSize?: { width: number; height: number },
): Evaluator {
  const { ledCount } = project
  const frames = frameCount(project)
  const imageWidth = sampleSize?.width ?? ledCount
  const imageHeight = sampleSize?.height ?? frames
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
              ? createImageSampler(l, imageWidth, imageHeight)
              : createPaintSampler(l, ledCount, frames)
      return { sample, opacity: l.opacity, blend: l.blend }
    })

  const rgba: RGBA = [0, 0, 0, 0]

  // Applied to the coordinates *before* the layers are sampled, so everything is
  // authored undistorted and the warp is purely a matter of where each LED
  // physically lands. The brightness curves below stay on the real coordinates:
  // they are an envelope over the strip and the timeline, not part of the
  // picture being drawn.
  const warp = project.sweep.enabled ? createSweepWarp(project.sweep) : null
  const warped: [number, number] = [0, 0]

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

      let su = u
      let sv = v
      if (warp) {
        warp(u, v, warped)
        su = warped[0]
        sv = warped[1]
        // The stick is somewhere the design does not cover, which happens
        // whenever the sweep's fill is below 100. Leave the cell at the
        // background: clamping instead would smear the design's edge pixels out
        // across the rest of the arc as long streaks.
        // Negated rather than written as the out-of-range test, so a NaN — which
        // compares false against everything — is treated as out of range instead
        // of being passed down to the layers.
        if (!(su >= 0 && su <= 1 && sv >= 0 && sv <= 1)) return
      }

      for (const layer of layers) {
        rgba[3] = 0
        layer.sample(su, sv, rgba)
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
  const w = Math.max(1, Math.min(width, project.ledCount))
  const h = Math.max(1, Math.min(height, frameCount(project)))
  const ev = createEvaluator(project, { width: w, height: h })
  const data = new Float32Array(w * h * 3)
  const cell: RGB = [0, 0, 0]
  const uDiv = w > 1 ? w - 1 : 1
  // `h`, not `h - 1`: the same cell-centre convention evaluateField uses, so a
  // thumbnail is a coarse sample of the same picture rather than one stretched
  // by a row. With `h - 1` a feature at the very end of the timeline showed up
  // in the library panel and nowhere else.
  const vDiv = h

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
