// Pre-distortion for a rotated sweep (REQUIREMENTS §6.4).
//
// Walking the stick sideways makes the photograph a plain raster: LED index
// across, time down, which is what the canvas shows. Rotating it instead — which
// is far easier to do smoothly, and the only way to draw something like a pair of
// wings — makes the photograph polar. LED index becomes radius and time becomes
// angle, so a rectangle on the canvas comes out as an annular sector.
//
// This warps the design the other way. For every LED at every moment it works out
// where that LED physically lands, and samples the design at that point instead.
// Sweep the stick as described and the photograph shows the drawing undistorted.
//
// Pure geometry, no rendering: it maps canvas coordinates to design coordinates.

export type SweepCorrection = {
  enabled: boolean
  /** Degrees. Where the stick starts, measured from the positive X axis. */
  startAngle: number
  /** Degrees swept. The sign is the direction: negative turns the other way. */
  sweep: number
  /**
   * Fraction along the strip that sits at the centre of rotation. 0 pivots on
   * LED 0 — a hand at the base — and 0.5 pivots on the middle.
   */
  pivot: number
  /**
   * How much of the shot the design is stretched to fill, 0 to 100.
   *
   * The swept region is a sector, and a sector does not fill its own bounding
   * box. So there is a choice, and it is the same one as `contain` versus
   * `cover`:
   *
   * - `0` fits the design entirely inside the arc. Nothing is lost — the tips of
   *   a pair of wings stay in the picture — and the parts of the arc outside it
   *   stay dark.
   * - `100` fits it to the bounding box, so it fills the shot, and whatever
   *   falls outside the arc is never painted. This loses the corners.
   *
   * In between scales smoothly. It defaults to 0 because silently dropping part
   * of the drawing is the worse surprise.
   */
  fill: number
}

export const DEFAULT_SWEEP: SweepCorrection = {
  enabled: false,
  startAngle: 0,
  sweep: 180,
  pivot: 0,
  fill: 0,
}

/**
 * Maps a canvas cell to the design point that should be shown there.
 *
 * The result can fall outside [0,1] when `fill` is below 100: that cell is a
 * place the stick reaches but the design does not cover, and the caller must
 * leave it unpainted rather than clamping, which would smear the edge pixels
 * around the rest of the arc.
 */
export type Warp = (u: number, v: number, out: [number, number]) => void

const DEG = Math.PI / 180
const TWO_PI = Math.PI * 2

/**
 * Whether the stick can put an LED on this point.
 *
 * The strip runs from `-pivot` to `1 - pivot`, so it extends both sides of the
 * hand and a point can be reached either by the far half at angle `phi` or by
 * the near half pointing the opposite way.
 */
function createReach(start: number, span: number, pivot: number) {
  const behind = pivot // how far the strip reaches backwards
  const ahead = 1 - pivot
  const whole = Math.abs(span) >= TWO_PI

  const inSector = (theta: number): boolean => {
    if (whole) return true
    // Distance travelled from the start in the direction of the sweep.
    const d = span >= 0 ? theta - start : start - theta
    return ((d % TWO_PI) + TWO_PI) % TWO_PI <= Math.abs(span) + 1e-9
  }

  return (x: number, y: number): boolean => {
    const rad = Math.hypot(x, y)
    const ang = Math.atan2(y, x)
    return (
      (rad <= ahead + 1e-9 && inSector(ang)) ||
      (rad <= behind + 1e-9 && inSector(ang + Math.PI))
    )
  }
}

/**
 * The largest the design rectangle can be scaled about its centre while staying
 * entirely inside the reachable region, as a fraction of the bounding box.
 *
 * Binary searched over the rectangle's perimeter rather than solved. Testing the
 * perimeter is enough: the region is star-shaped about the pivot, so along any
 * ray from it the distance grows monotonically and the furthest point of the
 * rectangle in any direction is on its edge. Sampling suits this file, which
 * already brackets the sector numerically for the same reason.
 */
function inscribedScale(
  reach: (x: number, y: number) => boolean,
  cx: number,
  cy: number,
  hx: number,
  hy: number,
): number {
  const STEPS = 128
  const fits = (s: number): boolean => {
    for (let i = 0; i < STEPS; i++) {
      // Once round the rectangle: t maps to a position along its perimeter.
      const t = (i / STEPS) * 4
      const side = Math.floor(t)
      const f = t - side
      const ex = s * hx
      const ey = s * hy
      const x = side === 0 ? -ex + 2 * ex * f : side === 1 ? ex : side === 2 ? ex - 2 * ex * f : -ex
      const y = side === 0 ? -ey : side === 1 ? -ey + 2 * ey * f : side === 2 ? ey : ey - 2 * ey * f
      if (!reach(cx + x, cy + y)) return false
    }
    return true
  }

  if (fits(1)) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }

  // Some sweeps admit no centred rectangle at all. A pivot part-way along the
  // strip with less than a half turn traces a bowtie — two opposite wedges
  // meeting at the hand — and any rectangle centred on it spans the gap between
  // them however small it gets. Shrinking toward that pinch point makes matters
  // worse rather than better: measured on a 95° sweep pivoted at the middle,
  // the full-size drawing has 62% of itself painted and a shrunken one 0.2%. So
  // when nothing useful fits, do not shrink.
  return lo < 0.2 ? 1 : lo
}

/**
 * The design is fitted to a rectangle centred on the region the sweep can reach,
 * sized by `fill` between one that fits entirely inside that region and its full
 * bounding box.
 *
 * At `fill` 100 every cell lands inside the design by construction and there is
 * nothing to clip, but the design's corners fall outside the arc and are never
 * painted — which is how the tips of a pair of wings went missing. Below that
 * the design shrinks until all of it is reachable, and cells outside it come
 * back out of range for the caller to leave dark.
 */
export function createSweepWarp(c: SweepCorrection): Warp {
  const start = c.startAngle * DEG
  const span = c.sweep * DEG
  const pivot = c.pivot

  // Solved, not sampled. r·cos(phi) and r·sin(phi) are extreme either at an end
  // of the sweep or where the axis is crossed, so those few angles are the whole
  // answer. Sampling 256 of them instead left the box short of the true extreme
  // by ~1e-4 whenever a crossing fell between two samples, which put cells a hair
  // outside the design — invisible, but it meant nothing downstream could assume
  // the range was exact.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const lo = Math.min(start, start + span)
  const hi = Math.max(start, start + span)
  const angles = [lo, hi]
  const QUARTER = Math.PI / 2
  for (let k = Math.ceil(lo / QUARTER); k * QUARTER <= hi; k++) angles.push(k * QUARTER)
  for (const phi of angles) {
    const cos = Math.cos(phi)
    const sin = Math.sin(phi)
    for (const r of [-pivot, 1 - pivot]) {
      const x = r * cos
      const y = r * sin
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const hx = (maxX - minX) / 2
  const hy = (maxY - minY) / 2

  // Between "all of the design is reachable" and "the design covers the whole
  // bounding box", which is the contain/cover choice this control exists for.
  const inscribed = inscribedScale(createReach(start, span, pivot), cx, cy, hx, hy)
  const t = Math.max(0, Math.min(1, c.fill / 100))
  const scale = inscribed + (1 - inscribed) * t

  const left = cx - scale * hx
  const top = cy + scale * hy
  const w = 2 * scale * hx
  const h = 2 * scale * hy
  const sx = Math.abs(w) < 1e-9 ? 0 : 1 / w
  const sy = Math.abs(h) < 1e-9 ? 0 : 1 / h

  return (u, v, out) => {
    const phi = start + span * v
    const r = u - pivot
    out[0] = (r * Math.cos(phi) - left) * sx
    // Y is inverted on purpose. The design is an image, so its row 0 is the top;
    // the world has +Y upward. Mapping (Py - minY) straight through put the
    // design's top row at the bottom of the shot and drew everything upside down.
    out[1] = (top - r * Math.sin(phi)) * sy
  }
}
