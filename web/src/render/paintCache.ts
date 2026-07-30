// Live surfaces for paint layers.
//
// A paint layer is a raster exactly ledCount x frameCount — one pixel per LED
// per frame, no resampling, so what you paint is what the strip shows.
//
// It is stored in the project as a data URL, but a stroke cannot round-trip
// through one: encoding a PNG per pointer event would make painting unusable.
// So the pixels live here in a mutable ImageData, the evaluator reads that
// directly, and the layer is serialised once at the end of a stroke — which
// also makes one stroke exactly one undo step.

export type PaintSurface = {
  width: number
  height: number
  /** RGBA, straight (not premultiplied) alpha, row-major, y = time. */
  data: Uint8ClampedArray
}

type Entry = {
  surface: PaintSurface
  /** The `src` this was last loaded from or serialised to. */
  src: string
  /** Bumped on every mutation so React can tell it changed. */
  version: number
  loading: boolean
}

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()

export function subscribePaint(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const notify = () => listeners.forEach((fn) => fn())

/** Call after a burst of dabs to make the field re-evaluate. */
export const notifyPaint = notify

function blank(width: number, height: number): PaintSurface {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

/**
 * The surface for `layerId`, sized to the field. Returns blank immediately and
 * fills in asynchronously if `src` still has to be decoded; the caller is
 * expected to be subscribed.
 *
 * Resizing the project reallocates rather than resampling: a paint layer is
 * pixel art, and interpolating it would quietly blur every stroke.
 */
export function getPaintSurface(
  layerId: string,
  src: string,
  width: number,
  height: number,
): PaintSurface {
  const entry = cache.get(layerId)
  const sameSrc = entry !== undefined && entry.src === src
  const sameSize =
    entry !== undefined && entry.surface.width === width && entry.surface.height === height
  if (entry && sameSrc && sameSize) return entry.surface

  const fresh: Entry = {
    surface: blank(width, height),
    src,
    version: (entry?.version ?? 0) + 1,
    loading: false,
  }

  if (entry && sameSrc) {
    // A resize, not a different raster: keep whatever still fits, so changing
    // the duration trims or extends the painting instead of wiping it.
    const w = Math.min(entry.surface.width, width)
    const h = Math.min(entry.surface.height, height)
    for (let y = 0; y < h; y++) {
      const from = y * entry.surface.width * 4
      fresh.surface.data.set(entry.surface.data.subarray(from, from + w * 4), y * width * 4)
    }
  }

  cache.set(layerId, fresh)
  // A src we have not seen has to be decoded. This is also the undo path, where
  // the project hands back a raster older than the one we are holding.
  if (src && !sameSrc) void load(layerId, src, width, height)
  return fresh.surface
}

async function load(layerId: string, src: string, width: number, height: number): Promise<void> {
  const entry = cache.get(layerId)
  if (!entry || entry.loading) return
  entry.loading = true
  try {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(bitmap, 0, 0)
    const current = cache.get(layerId)
    if (!current || current.src !== src) return
    current.surface.data.set(ctx.getImageData(0, 0, width, height).data)
    current.version++
    notify()
  } catch {
    // A corrupt or missing data URL leaves the blank surface, which is a usable
    // state — the user can simply paint on it.
  } finally {
    const current = cache.get(layerId)
    if (current) current.loading = false
  }
}

/**
 * Paints one round dab. `color` is RGB 0-255; `erase` clears instead.
 *
 * Dabs rather than strokes because the caller interpolates between pointer
 * events itself — at this resolution a fast sweep would otherwise be a dotted
 * line.
 */
export function paintDab(
  layerId: string,
  cx: number,
  cy: number,
  radius: number,
  color: [number, number, number],
  erase: boolean,
): void {
  const entry = cache.get(layerId)
  if (!entry) return
  const { width, height, data } = entry.surface
  const r = Math.max(0.5, radius)
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(height - 1, Math.ceil(cy + r))

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > r * r) continue
      const i = (y * width + x) * 4
      if (erase) {
        data[i + 3] = 0
      } else {
        data[i] = color[0]
        data[i + 1] = color[1]
        data[i + 2] = color[2]
        data[i + 3] = 255
      }
    }
  }
  entry.version++
}

/** Bumped on every dab; a component watching this re-renders the field. */
export function paintVersion(layerId: string): number {
  return cache.get(layerId)?.version ?? 0
}

/** Encodes the surface for storage in the project. Called once per stroke. */
export function serialisePaint(layerId: string): string {
  const entry = cache.get(layerId)
  if (!entry) return ''
  const { width, height, data } = entry.surface
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return entry.src
  // A fresh view, because ImageData's type demands a plain-ArrayBuffer array.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
  // PNG, because the layer has real transparency and a stroke must not pick up
  // JPEG ringing. Sparse painting compresses to almost nothing.
  const src = canvas.toDataURL('image/png')
  entry.src = src
  return src
}

/** Drops a layer's surface, so deleting and recreating a layer starts clean. */
export function forgetPaint(layerId: string): void {
  cache.delete(layerId)
}
