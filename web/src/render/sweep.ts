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
}

export const DEFAULT_SWEEP: SweepCorrection = {
  enabled: false,
  startAngle: 0,
  sweep: 180,
  pivot: 0,
}

/** Maps a canvas cell to the design point that should be shown there. */
export type Warp = (u: number, v: number, out: [number, number]) => void

const DEG = Math.PI / 180

/**
 * The design is fitted to the bounding box of the region the sweep can actually
 * reach, so it fills the shot. Every cell therefore lands inside the design by
 * construction — there is nothing to clip. Parts of the design that fall where
 * the stick never goes simply never get painted, which is the honest answer
 * rather than a stretched one.
 */
export function createSweepWarp(c: SweepCorrection): Warp {
  const start = c.startAngle * DEG
  const span = c.sweep * DEG
  const pivot = c.pivot

  // Sampled rather than solved. The extremes of r cos(phi) over a sector fall on
  // the ends, the radius limits, or an axis crossing; enumerating those cases
  // correctly is fiddly and this is computed once per project change.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const STEPS = 256
  for (let i = 0; i <= STEPS; i++) {
    const phi = start + span * (i / STEPS)
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

  const w = maxX - minX
  const h = maxY - minY
  const sx = Math.abs(w) < 1e-9 ? 0 : 1 / w
  const sy = Math.abs(h) < 1e-9 ? 0 : 1 / h

  return (u, v, out) => {
    const phi = start + span * v
    const r = u - pivot
    out[0] = (r * Math.cos(phi) - minX) * sx
    // Y is inverted on purpose. The design is an image, so its row 0 is the top;
    // the world has +Y upward. Mapping (Py - minY) straight through put the
    // design's top row at the bottom of the shot and drew everything upside down.
    out[1] = (maxY - r * Math.sin(phi)) * sy
  }
}
