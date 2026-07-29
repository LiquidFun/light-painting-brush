// The field evaluator. This is the whole interpolation model (REQUIREMENTS §4.4).
//
// X is LED index, Y is time. Every cell is an inverse-distance-weighted mean of
// the keyframes whose radius reaches it, plus the project background at a small
// constant weight so regions outside every radius decay to background rather
// than being colonised by the nearest distant keyframe.
//
// Output is gamma-encoded sRGB in 0..1 — correct for the screen. Gamma for the
// LEDs is applied later, in payload.ts, at the very end of the pipeline.

import { easingFn } from '../model/easing'
import { clamp01, hexToRgb, mixSpace } from '../model/color'
import type { RGB } from '../model/color'
import { frameCount } from '../model/project'
import type { Keyframe, Project } from '../model/types'

/** Weight of the background sample. Small, but never zero. */
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

export function createEvaluator(project: Project): Evaluator {
  const { ledCount, durationMs, falloffPower: p } = project
  const frames = frameCount(project)
  const keyframes = project.keyframes

  // Background is sample index `n`, a virtual keyframe with brightness 1.
  const n = keyframes.length
  const count = n + 1

  const kind = new Uint8Array(count)
  const uk = new Float64Array(count)
  const vk = new Float64Array(count)
  const radius = new Float64Array(count)
  const bright = new Float64Array(count)
  const hard = new Uint8Array(count)
  const ease: ((t: number) => number)[] = new Array(count)
  const comps = new Float64Array(count * 3)
  const weights = new Float64Array(count)

  const space = mixSpace(project.colorSpace)
  const uDiv = ledCount > 1 ? ledCount - 1 : 1
  const vDiv = durationMs > 0 ? durationMs : 1

  const load = (i: number, k: Keyframe) => {
    kind[i] = k.kind === 'row' ? KIND_ROW : k.kind === 'column' ? KIND_COLUMN : KIND_POINT
    uk[i] = k.led / uDiv
    vk[i] = k.timeMs / vDiv
    radius[i] = Math.max(k.radius, 1e-4)
    bright[i] = k.brightness
    hard[i] = k.hard ? 1 : 0
    ease[i] = easingFn(k.easing)
    space.encode(hexToRgb(k.color), comps, i * 3)
  }

  for (let i = 0; i < n; i++) load(i, keyframes[i])

  bright[n] = 1
  ease[n] = easingFn('linear')
  space.encode(hexToRgb(project.background), comps, n * 3)

  const mixed: RGB = [0, 0, 0]

  return {
    width: ledCount,
    height: frames,
    timeAt: (y) => (y * 1000) / project.fps,

    cell(u, v, out) {
      let total = BACKGROUND_WEIGHT
      weights[n] = BACKGROUND_WEIGHT

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

      if (hardWinner >= 0) {
        for (let i = 0; i < count; i++) weights[i] = 0
        weights[hardWinner] = 1
        total = 1
      }

      space.mix(comps, weights, count, total, mixed)

      // Brightness is its own scalar field, interpolated with the same weights.
      let b = 0
      for (let i = 0; i < count; i++) {
        const w = weights[i]
        if (w !== 0) b += w * bright[i]
      }
      b = clamp01(b / total)

      out[0] = clamp01(mixed[0]) * b
      out[1] = clamp01(mixed[1]) * b
      out[2] = clamp01(mixed[2]) * b
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
