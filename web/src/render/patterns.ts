// Pattern layers (REQUIREMENTS §6.2). Stripes, waves, gradients and noise are
// procedural: they cannot be expressed as scattered keyframes, so each one is a
// pure `(u, v) -> RGBA` sampler with no state of its own.
//
// `u` is LED index and `v` is time, both normalised to [0,1]. Output is
// gamma-encoded sRGB in 0..1, the same space the keyframe field works in, so the
// compositor can treat every layer alike.

import { clamp01, hexToRgb, mixSpace } from '../model/color'
import type { MixSpace, RGB } from '../model/color'
import type { ColorRamp, ColorSpace, Pattern } from '../model/types'

export type RGBA = [number, number, number, number]

export type Sampler = (u: number, v: number, out: RGBA) => void

const TAU = Math.PI * 2

/** Hermite smoothstep on an already-normalised t. */
function smooth(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/**
 * Interpolates a two-stop ramp in the project's mix space, so a pattern and a
 * keyframe layer blend their colours the same way.
 */
function rampSampler(ramp: ColorRamp, space: MixSpace): (t: number, out: RGB) => void {
  const comps = new Float64Array(6)
  const weights = new Float64Array(2)
  space.encode(hexToRgb(ramp.from), comps, 0)
  space.encode(hexToRgb(ramp.to), comps, 3)
  return (t, out) => {
    const x = clamp01(t)
    weights[0] = 1 - x
    weights[1] = x
    space.mix(comps, weights, 2, 1, out)
  }
}

// --- value noise -----------------------------------------------------------

/** Deterministic hash of a lattice point; returns 0..1. */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695041
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const tx = smooth(x - xi)
  const ty = smooth(y - yi)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

// --- samplers --------------------------------------------------------------

/**
 * `dims` is the field size in pixels — LEDs across, frames down. Patterns work in
 * normalised u/v, so anything the user specifies in pixels is converted here,
 * once, rather than at every sample.
 */
export function createSampler(
  pattern: Pattern,
  colorSpace: ColorSpace,
  dims: { width: number; height: number },
): Sampler {
  const space = mixSpace(colorSpace)
  const rgb: RGB = [0, 0, 0]
  // u and v run 0..1 across (n - 1) steps, so one pixel is 1/(n - 1).
  const pixelU = 1 / Math.max(1, dims.width - 1)
  const pixelV = 1 / Math.max(1, dims.height - 1)

  switch (pattern.kind) {
    case 'solid': {
      const c = hexToRgb(pattern.color)
      return (_u, _v, out) => {
        out[0] = c[0]
        out[1] = c[1]
        out[2] = c[2]
        out[3] = 1
      }
    }

    case 'stripes': {
      const { axis, duty, phase } = pattern
      // periodPx is in pixels of the chosen axis; convert once to normalised.
      const period = Math.max(pattern.periodPx, 1) * (axis === 'led' ? pixelU : pixelV)
      // Softness is a share of the narrower band, so the edge can never eat more
      // than half of it and invert the duty cycle.
      const edge = Math.max(pattern.softness * Math.min(duty, 1 - duty), 1e-6)
      const ramp = rampSampler(pattern.ramp, space)
      return (u, v, out) => {
        const c = axis === 'led' ? u : v
        let x = ((c - phase) / period) % 1
        if (x < 0) x += 1
        // Symmetric blend around whichever edge is nearest: at the edge itself
        // the two stops meet at their midpoint.
        const d = Math.min(Math.abs(x - duty), Math.min(x, 1 - x))
        const t = 0.5 * smooth(d / edge)
        ramp(x < duty ? 0.5 - t : 0.5 + t, rgb)
        out[0] = rgb[0]
        out[1] = rgb[1]
        out[2] = rgb[2]
        out[3] = 1
      }
    }

    case 'wave': {
      const { axis, amplitude, phase, speed } = pattern
      // Pixels of the chosen axis, like the stripe period; converted once here.
      const wavelength =
        Math.max(pattern.wavelengthPx, 1) * (axis === 'led' ? pixelU : pixelV)
      const ramp = rampSampler(pattern.ramp, space)
      return (u, v, out) => {
        const c = axis === 'led' ? u : v
        // `speed` drifts the wave along time, in cycles over the whole animation.
        const s = 0.5 + 0.5 * Math.sin(TAU * ((c - phase) / wavelength - speed * v))
        ramp(s, rgb)
        // Amplitude is a brightness envelope: 0 leaves a flat ramp, 1 swings the
        // troughs all the way to black.
        const b = 1 - amplitude + amplitude * s
        out[0] = rgb[0] * b
        out[1] = rgb[1] * b
        out[2] = rgb[2] * b
        out[3] = 1
      }
    }

    case 'gradient': {
      const rad = (pattern.angle * Math.PI) / 180
      const cx = Math.cos(rad)
      const cy = Math.sin(rad)
      // Normalise by the projection's range over the unit square, so every angle
      // uses the full ramp.
      const lo = Math.min(0, cx) + Math.min(0, cy)
      const span = Math.abs(cx) + Math.abs(cy) || 1
      const ramp = rampSampler(pattern.ramp, space)
      return (u, v, out) => {
        ramp((u * cx + v * cy - lo) / span, rgb)
        out[0] = rgb[0]
        out[1] = rgb[1]
        out[2] = rgb[2]
        out[3] = 1
      }
    }

    case 'noise': {
      const { scale, speed, seed } = pattern
      const ramp = rampSampler(pattern.ramp, space)
      return (u, v, out) => {
        // speed = 0 freezes the pattern in time, which is what a shimmering
        // static strip needs.
        ramp(valueNoise(u * scale, v * scale * speed, seed), rgb)
        out[0] = rgb[0]
        out[1] = rgb[1]
        out[2] = rgb[2]
        out[3] = 1
      }
    }
  }
}
