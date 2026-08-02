// Image layers (REQUIREMENTS §6.2). An image is resampled once to exactly
// ledCount x frameCount, so the field evaluator can read it as a plain array
// without doing any filtering per cell.
//
// Decoding is asynchronous but the evaluator is not, so this module is a cache
// with a subscription: `getImage` returns null while the work is in flight and
// listeners are notified when a result lands.

import type { ImageFit, ImageRotation } from '../model/types'

export type ImageSample = {
  width: number
  height: number
  /**
   * width * height * 4, gamma-encoded sRGB + alpha, row-major, 0-255.
   *
   * Bytes rather than floats because the source is getImageData, which is 8-bit:
   * widening to Float32 stored quantised values in four times the space and
   * bought no precision. The sampler scales to 0..1, which is cheaper than the
   * cache misses the extra 12 bytes per pixel caused.
   */
  data: Uint8ClampedArray
}

/**
 * Bounded by bytes, not by entry count.
 *
 * A count was the wrong unit and caused a livelock. Entries differ in size by
 * three orders of magnitude — a full-resolution resample of a minute-long
 * project is megabytes, a library thumbnail is kilobytes — and the same image
 * legitimately occupies one entry per size it is read at. With a count of eight,
 * the canvas and the library kept evicting each other's entry, re-decoding, and
 * notifying, forever.
 */
const MAX_BYTES = 64 * 1024 * 1024
/** Never evict below this, however large the entries: something is in use. */
const MIN_ENTRIES = 4

/** A null value is a decode that failed, cached so it is not retried forever. */
const cache = new Map<string, ImageSample | null>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

const bytesOf = (sample: ImageSample | null) =>
  sample ? sample.data.byteLength : 0

let cachedBytes = 0

export type Orientation = { rotation: ImageRotation; flipX: boolean; flipY: boolean }

const keyOf = (src: string, width: number, height: number, fit: ImageFit, o: Orientation) =>
  `${width}x${height}|${fit}|${o.rotation}|${o.flipX ? 'x' : ''}${o.flipY ? 'y' : ''}|${src}`

// Coalesced: a library of N images produces N results, and firing per result
// made every listener re-evaluate its whole field N times.
let notifyPending = 0
function notify() {
  if (notifyPending) return
  notifyPending = requestAnimationFrame(() => {
    notifyPending = 0
    for (const fn of listeners) fn()
  })
}

export function subscribeImages(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * The resampled image, or null while it is still decoding. Kicks off the decode
 * on the first call for a given size and fit.
 */
export function getImage(
  src: string,
  width: number,
  height: number,
  fit: ImageFit,
  orientation: Orientation,
): ImageSample | null {
  if (!src) return null
  const key = keyOf(src, width, height, fit, orientation)
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null
    // Re-insert so Map order is least-recently-used. Without this, eviction
    // walks insertion order and happily drops the entry being read every frame.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  if (inFlight.has(key)) return null

  inFlight.add(key)
  void resample(src, width, height, fit, orientation)
    .then((sample) => store(key, sample))
    .catch(() => store(key, null))
  return null
}

function store(key: string, sample: ImageSample | null) {
  inFlight.delete(key)
  cache.set(key, sample)
  cachedBytes += bytesOf(sample)

  while (cachedBytes > MAX_BYTES && cache.size > MIN_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done || oldest.value === key) break
    cachedBytes -= bytesOf(cache.get(oldest.value) ?? null)
    cache.delete(oldest.value)
  }
  notify()
}

/**
 * A project is one self-contained JSON file kept in localStorage, so an image has
 * to be embedded as a data URL and has to be small. Nothing above this is useful:
 * the strip is 144 LEDs wide and a long animation is a few hundred frames tall.
 */
export const IMPORT_MAX_EDGE = 512

/** Decodes a picked file and re-encodes it as a compact data URL. */
export async function importImageFile(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })

  const img = await decode(original)
  const scale = Math.min(1, IMPORT_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  if (scale >= 1 && original.length < 512 * 1024) return original

  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas2d(w, h)
  ctx.drawImage(img, 0, 0, w, h)
  // WebP keeps alpha and is far smaller than PNG for photographs.
  return ctx.canvas.toDataURL('image/webp', 0.9)
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That file could not be decoded as an image.'))
    img.src = src
  })
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('This browser refused a 2D canvas, so images cannot be used.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * Source and destination rectangles for a fit mode. `contain` letterboxes with
 * transparent bands; `cover` crops the source.
 */
function rects(
  iw: number,
  ih: number,
  width: number,
  height: number,
  fit: ImageFit,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const full = { sx: 0, sy: 0, sw: iw, sh: ih, dx: 0, dy: 0, dw: width, dh: height }
  if (fit === 'stretch') return full

  const scale =
    fit === 'contain'
      ? Math.min(width / iw, height / ih)
      : Math.max(width / iw, height / ih)

  if (fit === 'contain') {
    const dw = iw * scale
    const dh = ih * scale
    return { ...full, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh }
  }

  const sw = width / scale
  const sh = height / scale
  return { ...full, sx: (iw - sw) / 2, sy: (ih - sh) / 2, sw, sh }
}

/**
 * Applies rotation and flips before anything else, so `fit` and the downscale
 * both see the orientation the user asked for. Doing it afterwards would fit the
 * wrong aspect ratio for a quarter turn.
 */
function orient(
  img: HTMLImageElement,
  { rotation, flipX, flipY }: Orientation,
): HTMLImageElement | HTMLCanvasElement {
  if (rotation === 0 && !flipX && !flipY) return img
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  const turned = rotation === 90 || rotation === 270
  const canvas = document.createElement('canvas')
  canvas.width = turned ? ih : iw
  canvas.height = turned ? iw : ih
  const ctx = canvas.getContext('2d')
  if (!ctx) return img
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  ctx.drawImage(img, -iw / 2, -ih / 2)
  return canvas
}

async function resample(
  src: string,
  width: number,
  height: number,
  fit: ImageFit,
  orientation: Orientation,
): Promise<ImageSample> {
  const decoded = await decode(src)
  const oriented = orient(decoded, orientation)
  const iw = 'naturalWidth' in oriented ? oriented.naturalWidth : oriented.width
  const ih = 'naturalHeight' in oriented ? oriented.naturalHeight : oriented.height
  if (iw === 0 || ih === 0) throw new Error('That image has no pixels.')

  const r = rects(iw, ih, width, height, fit)

  // A single big drawImage down to 144 px aliases badly whatever the smoothing
  // hint says. Halving repeatedly is an exact 2x2 box average under bilinear, so
  // pre-shrink until the last step is under 2x and let the browser finish.
  let source: HTMLImageElement | HTMLCanvasElement = oriented
  let sx = r.sx
  let sy = r.sy
  let sw = r.sw
  let sh = r.sh
  while (sw > r.dw * 2 && sh > r.dh * 2 && sw > 2 && sh > 2) {
    const hw = Math.max(1, Math.floor(sw / 2))
    const hh = Math.max(1, Math.floor(sh / 2))
    const half = canvas2d(hw, hh)
    half.drawImage(source, sx, sy, sw, sh, 0, 0, hw, hh)
    source = half.canvas
    sx = 0
    sy = 0
    sw = hw
    sh = hh
  }

  const ctx = canvas2d(width, height)
  ctx.drawImage(source, sx, sy, sw, sh, r.dx, r.dy, r.dw, r.dh)
  // Taken as-is: no conversion pass and no second allocation.
  const data = ctx.getImageData(0, 0, width, height).data
  return { width, height, data }
}
