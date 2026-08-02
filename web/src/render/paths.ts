// Sweep paths for the 3D preview (REQUIREMENTS §6.8).
//
// The 2D canvas answers "what does the photograph look like if I sweep at a
// constant speed in a straight line". This answers the same question for the
// ways people actually move a light stick: spinning it, corkscrewing it, walking
// with it. The stick is a 1 m line of LEDs, so at each frame it occupies a
// segment in space and the exposure accumulates every LED at every frame.
//
// Pure geometry, no three.js: a path returns where the stick is and which way it
// points at a given moment, and the viewer turns that into points.

export type PathKind = 'sweep' | 'circle' | 'corkscrew' | 'spiral' | 'pendulum' | 'wander'

/** The strip is 1 m. Every distance here is in metres. */
export const STICK_LENGTH = 1

export const PATH_KINDS: { id: PathKind; label: string; note: string }[] = [
  { id: 'sweep', label: 'Sweep', note: 'Straight and level — what the 2D canvas assumes' },
  { id: 'circle', label: 'Spin', note: 'Pivot on one end, tracing a disc' },
  { id: 'corkscrew', label: 'Corkscrew', note: 'Spin on the base while advancing — a cone helix' },
  {
    id: 'spiral',
    label: 'Spiral',
    note: 'Held at the middle and spun like a propeller while walking forward',
  },
  { id: 'pendulum', label: 'Pendulum', note: 'Swing back and forth about the base' },
  { id: 'wander', label: 'Wander', note: 'Hand-held drift, for how it really goes' },
]

export type PathParams = {
  kind: PathKind
  /** Metres travelled along the sweep, for the modes that advance. */
  distance: number
  /** Full revolutions over the animation. */
  turns: number
  /** Degrees of arc, for pendulum. */
  swing: number
  /** Tilt of the stick away from vertical, in degrees. */
  tilt: number
  /** Metres of hand wobble. */
  wobble: number
  seed: number
  /**
   * Where the motion starts. A phase offset for anything that rotates, and the
   * heading for anything that only travels.
   */
  startAngle: number
  /** Reflect the whole path, reversing travel and handedness. */
  mirror: boolean
}

export const DEFAULT_PATH: PathParams = {
  kind: 'circle',
  distance: 2,
  turns: 1,
  swing: 120,
  tilt: 0,
  wobble: 0.15,
  seed: 1,
  startAngle: 0,
  mirror: false,
}

/** Where the stick is at time `t` (0..1) and which way it points. */
export type Pose = {
  /** Position of LED 0, the base of the stick. */
  ox: number
  oy: number
  oz: number
  /** Unit vector from LED 0 toward the tip. */
  dx: number
  dy: number
  dz: number
}

/** Deterministic value noise, so a wander is the same every time you look at it. */
function noise(i: number, seed: number): number {
  let h = i * 374761393 + seed * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5
}

function smoothNoise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  return noise(i, seed) * (1 - s) + noise(i + 1, seed) * s
}

const TAU = Math.PI * 2

/**
 * The stick's pose at `t`. Y is up and is the stick's own axis at rest; the
 * animation's LED 0 is at the base, matching the hardware and the canvas.
 */
export function poseAt(p: PathParams, t: number, out: Pose): void {
  const tilt = (p.tilt * Math.PI) / 180
  const phase = (p.startAngle * Math.PI) / 180
  // Rest orientation: up, leant back by `tilt`.
  let dx = 0
  let dy = Math.cos(tilt)
  let dz = Math.sin(tilt)
  let ox = 0
  let oy = 0
  let oz = 0

  switch (p.kind) {
    case 'sweep':
      ox = (t - 0.5) * p.distance
      break

    case 'circle': {
      // Pivot about the base. The stick leans out by `tilt`, so a tilt of zero
      // traces a line and anything else traces a cone.
      const a = t * TAU * p.turns + phase
      const r = Math.sin(tilt)
      dx = Math.cos(a) * r
      dz = Math.sin(a) * r
      dy = Math.cos(tilt)
      break
    }

    case 'corkscrew': {
      const a = t * TAU * p.turns + phase
      const r = Math.sin(tilt)
      dx = Math.cos(a) * r
      dz = Math.sin(a) * r
      dy = Math.cos(tilt)
      // Advance along the axis it is spinning around.
      ox = (t - 0.5) * p.distance
      break
    }

    case 'spiral': {
      // Held at the middle and spun like a propeller about the direction of
      // travel, so both ends trace helices half a turn apart. Corkscrew pivots
      // on the base and keeps one end on the axis; this keeps the centre on it.
      const a = t * TAU * p.turns + phase
      const cx = (t - 0.5) * p.distance
      dx = 0
      dy = Math.cos(a)
      dz = Math.sin(a)
      // The path gives LED 0, and the pivot is half a stick along from it.
      ox = cx - dx * STICK_LENGTH * 0.5
      oy = STICK_LENGTH * 0.5 - dy * STICK_LENGTH * 0.5
      oz = -dz * STICK_LENGTH * 0.5
      break
    }

    case 'pendulum': {
      // Cosine rather than a sawtooth: a real swing is slowest at the ends,
      // which is where a long exposure piles up the most light.
      const half = (p.swing * Math.PI) / 360
      const a = Math.cos(t * TAU * Math.max(p.turns, 0.25) + phase) * half
      dx = Math.sin(a)
      dy = Math.cos(a)
      dz = 0
      break
    }

    case 'wander': {
      // A slow drift plus the stick never being held quite still.
      const k = 6
      ox = (t - 0.5) * p.distance + smoothNoise(t * k, p.seed) * p.wobble * 2
      oy = smoothNoise(t * k, p.seed + 17) * p.wobble
      oz = smoothNoise(t * k, p.seed + 31) * p.wobble * 2
      const lean = smoothNoise(t * k * 1.7, p.seed + 53) * 0.6
      const roll = smoothNoise(t * k * 1.3, p.seed + 71) * 0.6
      dx = Math.sin(lean)
      dz = Math.sin(roll)
      dy = Math.sqrt(Math.max(0, 1 - dx * dx - dz * dz))
      break
    }
  }

  // Modes that only travel have no rotation to offset, so the start angle turns
  // their heading instead.
  if (p.kind === 'sweep' || p.kind === 'wander') {
    const c = Math.cos(phase)
    const s = Math.sin(phase)
    const rx = ox * c - oz * s
    const rz = ox * s + oz * c
    const rdx = dx * c - dz * s
    const rdz = dx * s + dz * c
    ox = rx
    oz = rz
    dx = rdx
    dz = rdz
  }

  // A reflection through the YZ plane: travel reverses and every rotation
  // changes hand, which is what makes it read as a mirror image rather than as
  // the same path seen from behind.
  if (p.mirror) {
    ox = -ox
    dx = -dx
  }

  const len = Math.hypot(dx, dy, dz) || 1
  out.ox = ox
  out.oy = oy
  out.oz = oz
  out.dx = dx / len
  out.dy = dy / len
  out.dz = dz / len
}

/** Which parameters a mode actually uses, so the panel can hide the rest. */
export function usedParams(kind: PathKind): (keyof PathParams)[] {
  // startAngle and mirror apply to every mode and are listed separately.
  switch (kind) {
    case 'sweep':
      return ['distance', 'tilt']
    case 'circle':
      return ['turns', 'tilt']
    case 'corkscrew':
      return ['turns', 'tilt', 'distance']
    case 'spiral':
      return ['turns', 'distance']
    case 'pendulum':
      return ['swing', 'turns']
    case 'wander':
      return ['distance', 'wobble', 'seed']
  }
}
