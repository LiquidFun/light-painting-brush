// Colour conversions and the weighted mixers used by the field renderer.
//
// Convention: "srgb" means gamma-encoded sRGB in 0..1 — the numbers a screen
// wants. "linear" means linear-light in 0..1. LED bytes are produced by
// applyGamma() at the very end of the pipeline, never here.

import type { Color, ColorSpace } from './types'

export type RGB = [number, number, number]

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

export function hexToRgb(hex: Color): RGB {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h.length >= 6
        ? h.slice(0, 6)
        : '000000'
  const n = parseInt(full, 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const hex2 = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, '0')

export function rgbToHex([r, g, b]: RGB): Color {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

export function isHex(value: string): boolean {
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
}

export function normaliseHex(value: string): Color {
  return rgbToHex(hexToRgb(value.trim().toLowerCase()))
}

// --- transfer functions ----------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return clamp01(v)
}

/**
 * γ ≈ 2.2, applied at the very end of the pipeline immediately before
 * quantising to u8. Interpolate in perceptual space, output in LED-linear
 * space — getting this backwards makes every gradient bunch up at one end.
 */
export const GAMMA = 2.2

export function applyGamma(v: number): number {
  return Math.pow(clamp01(v), GAMMA)
}

// --- OKLab -----------------------------------------------------------------

export function linearToOklab(r: number, g: number, b: number): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabToLinear(L: number, a: number, bb: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb
  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

// --- HSV (over gamma-encoded sRGB, which is what a colour wheel shows) ------

/** Returns [hueDegrees, saturation, value]. Hue is 0 for greys. */
export function rgbToHsv(r: number, g: number, b: number): RGB {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 1e-9) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return [h, max <= 0 ? 0 : d / max, max]
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c
  let rgb: RGB
  if (hh < 60) rgb = [c, x, 0]
  else if (hh < 120) rgb = [x, c, 0]
  else if (hh < 180) rgb = [0, c, x]
  else if (hh < 240) rgb = [0, x, c]
  else if (hh < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [clamp01(rgb[0] + m), clamp01(rgb[1] + m), clamp01(rgb[2] + m)]
}

// --- mixers ----------------------------------------------------------------

/**
 * A mix space turns colours into three interpolable components and back.
 *
 * `mix` reads `comps` as a flat [c0,c1,c2] triple per sample and blends the
 * first `count` samples using `weights`, writing gamma-encoded sRGB into `out`.
 * OKLab is the default because naive sRGB interpolation between complementary
 * colours passes through grey, which looks like a bug in a light-painting tool.
 */
export type MixSpace = {
  encode(rgb: RGB, out: Float64Array, offset: number): void
  mix(
    comps: Float64Array,
    weights: Float64Array,
    count: number,
    total: number,
    out: RGB,
  ): void
}

const oklabSpace: MixSpace = {
  encode(rgb, out, o) {
    const lab = linearToOklab(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]))
    out[o] = lab[0]
    out[o + 1] = lab[1]
    out[o + 2] = lab[2]
  },
  mix(comps, weights, count, total, out) {
    let L = 0
    let a = 0
    let b = 0
    for (let i = 0; i < count; i++) {
      const w = weights[i]
      if (w === 0) continue
      L += w * comps[i * 3]
      a += w * comps[i * 3 + 1]
      b += w * comps[i * 3 + 2]
    }
    const lin = oklabToLinear(L / total, a / total, b / total)
    out[0] = linearToSrgb(Math.max(0, lin[0]))
    out[1] = linearToSrgb(Math.max(0, lin[1]))
    out[2] = linearToSrgb(Math.max(0, lin[2]))
  },
}

const srgbSpace: MixSpace = {
  encode(rgb, out, o) {
    out[o] = rgb[0]
    out[o + 1] = rgb[1]
    out[o + 2] = rgb[2]
  },
  mix(comps, weights, count, total, out) {
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < count; i++) {
      const w = weights[i]
      if (w === 0) continue
      r += w * comps[i * 3]
      g += w * comps[i * 3 + 1]
      b += w * comps[i * 3 + 2]
    }
    out[0] = clamp01(r / total)
    out[1] = clamp01(g / total)
    out[2] = clamp01(b / total)
  },
}

const hsvEncode = (rgb: RGB, out: Float64Array, o: number) => {
  const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2])
  out[o] = hsv[0]
  out[o + 1] = hsv[1]
  out[o + 2] = hsv[2]
}

const hsvShortSpace: MixSpace = {
  encode: hsvEncode,
  mix(comps, weights, count, total, out) {
    // Weighted circular mean: summing unit vectors always takes the short way
    // round the wheel.
    let x = 0
    let y = 0
    let s = 0
    let v = 0
    for (let i = 0; i < count; i++) {
      const w = weights[i]
      if (w === 0) continue
      const rad = (comps[i * 3] * Math.PI) / 180
      // Desaturated samples must not vote on hue.
      const hueWeight = w * comps[i * 3 + 1]
      x += hueWeight * Math.cos(rad)
      y += hueWeight * Math.sin(rad)
      s += w * comps[i * 3 + 1]
      v += w * comps[i * 3 + 2]
    }
    const h = (Math.atan2(y, x) * 180) / Math.PI
    const rgb = hsvToRgb(h, clamp01(s / total), clamp01(v / total))
    out[0] = rgb[0]
    out[1] = rgb[1]
    out[2] = rgb[2]
  },
}

const hsvLongSpace: MixSpace = {
  encode: hsvEncode,
  mix(comps, weights, count, total, out) {
    // "Long way round" is only defined pairwise, so generalise it: take the
    // heaviest sample as the reference hue and unwrap every other hue away from
    // it, forcing each delta to the >=180 degree path.
    let ref = 0
    let refW = -1
    for (let i = 0; i < count; i++) {
      if (weights[i] > refW) {
        refW = weights[i]
        ref = i
      }
    }
    const h0 = comps[ref * 3]
    let hSum = 0
    let hW = 0
    let s = 0
    let v = 0
    for (let i = 0; i < count; i++) {
      const w = weights[i]
      if (w === 0) continue
      let d = ((comps[i * 3] - h0) % 360 + 360) % 360
      if (d > 0 && d < 180) d -= 360
      const hueWeight = w * comps[i * 3 + 1]
      hSum += hueWeight * d
      hW += hueWeight
      s += w * comps[i * 3 + 1]
      v += w * comps[i * 3 + 2]
    }
    const h = h0 + (hW > 0 ? hSum / hW : 0)
    const rgb = hsvToRgb(h, clamp01(s / total), clamp01(v / total))
    out[0] = rgb[0]
    out[1] = rgb[1]
    out[2] = rgb[2]
  },
}

export function mixSpace(space: ColorSpace): MixSpace {
  switch (space) {
    case 'srgb':
      return srgbSpace
    case 'hsv-short':
      return hsvShortSpace
    case 'hsv-long':
      return hsvLongSpace
    case 'oklab':
    default:
      return oklabSpace
  }
}
