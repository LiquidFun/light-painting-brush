// Pure data types. No React, no DOM, no side effects.

/** `#rrggbb`, always lowercase, always 7 characters. */
export type Color = string

export type EasingName =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'smoothstep'
  | 'step'

export const EASING_NAMES: EasingName[] = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'smoothstep',
  'step',
]

export type ColorSpace = 'oklab' | 'srgb' | 'hsv-short' | 'hsv-long'

export const COLOR_SPACES: { id: ColorSpace; label: string; note: string }[] = [
  { id: 'oklab', label: 'OKLab', note: 'perceptual — no grey mush between complements' },
  { id: 'hsv-short', label: 'HSV short', note: 'shortest way round the hue circle' },
  { id: 'hsv-long', label: 'HSV long', note: 'the long way — full hue rotations' },
  { id: 'srgb', label: 'sRGB', note: 'naive, for comparison' },
]

export type KeyframeKind = 'point' | 'row' | 'column'

export type Keyframe = {
  id: string
  kind: KeyframeKind
  /** 0..ledCount-1 — used by `point` and `column`. */
  led: number
  /** 0..durationMs — used by `point` and `row`. */
  timeMs: number
  color: Color
  /** 0..1, interpolated as its own scalar field. */
  brightness: number
  /** 0..1, normalised influence radius. */
  radius: number
  /** Applied to normalised distance before weighting. */
  easing: EasingName
  /** Nearest-neighbour within radius, hard edge — the only way to get a crisp line. */
  hard: boolean
}

export type Playback = {
  loop: boolean
  pingPong: boolean
  /** Delay between trigger and first frame. A shooting parameter, not a design one. */
  startDelayMs: number
}

// --- layers (REQUIREMENTS §6.2) --------------------------------------------
//
// Stripes, waves and images cannot be expressed as scattered keyframes, so the
// inverse-distance field is one layer kind among several rather than the whole
// model. Layers are ordered bottom to top and composited over the project
// background.

export type BlendMode = 'normal' | 'add' | 'multiply' | 'screen'

export const BLEND_MODES: { id: BlendMode; label: string; note: string }[] = [
  { id: 'normal', label: 'Normal', note: 'covers what is under it' },
  { id: 'add', label: 'Add', note: 'light adds to light — the physical one' },
  { id: 'screen', label: 'Screen', note: 'like add, but cannot clip' },
  { id: 'multiply', label: 'Multiply', note: 'darkens — masks the layers below' },
]

/** Two stops is enough for every pattern here; more belongs in a gradient layer. */
export type ColorRamp = { from: Color; to: Color }

/** LED index across, or time downward. Every pattern needs to pick one. */
export type PatternAxis = 'led' | 'time'

export type Pattern =
  | { kind: 'solid'; color: Color }
  | {
      kind: 'stripes'
      axis: PatternAxis
      /** Stripe pair width, in normalised units of the axis. */
      /**
       * One full stripe cycle, in pixels of the chosen axis: LEDs when `axis` is
       * 'led', frames when it is 'time'. Pixels rather than a fraction because a
       * stripe you can count is the thing you are actually designing, and it
       * should not silently resize when the duration changes.
       */
      periodPx: number
      /** 0..1 share of the period given to `ramp.from`. */
      duty: number
      /** 0 = hard edge, 1 = fully soft. */
      softness: number
      phase: number
      ramp: ColorRamp
    }
  | {
      kind: 'wave'
      axis: PatternAxis
      /** One full wave cycle, in pixels of the chosen axis. Same units as stripes. */
      wavelengthPx: number
      /** 0..1 peak brightness of the wave envelope. */
      amplitude: number
      phase: number
      /** Cycles over the whole animation. 0 = static. */
      speed: number
      ramp: ColorRamp
    }
  | {
      kind: 'gradient'
      /** Degrees. 0 = along LED index, 90 = along time. */
      angle: number
      ramp: ColorRamp
    }
  | {
      kind: 'noise'
      scale: number
      speed: number
      seed: number
      ramp: ColorRamp
    }

export type PatternKind = Pattern['kind']

export const PATTERN_KINDS: { id: PatternKind; label: string }[] = [
  { id: 'stripes', label: 'Stripes' },
  { id: 'wave', label: 'Wave' },
  { id: 'gradient', label: 'Gradient' },
  { id: 'noise', label: 'Noise' },
  { id: 'solid', label: 'Solid' },
]

export type ImageFit = 'stretch' | 'contain' | 'cover'

type LayerBase = {
  id: string
  name: string
  /** 0..1, multiplies the layer's own alpha. */
  opacity: number
  blend: BlendMode
  hidden: boolean
}

export type KeyframeLayer = LayerBase & { kind: 'keyframes'; keyframes: Keyframe[] }
export type PatternLayer = LayerBase & { kind: 'pattern'; pattern: Pattern }
export type ImageLayer = LayerBase & {
  kind: 'image'
  /** Data URL, so a project stays one self-contained JSON file. */
  src: string
  fit: ImageFit
}

/**
 * A raster painted by hand, exactly ledCount x frameCount — one pixel per LED
 * per frame, so it is never resampled and what you paint is what the strip
 * shows. `src` is a PNG data URL; the live pixels live in render/paintCache.ts
 * while a stroke is in progress.
 */
export type PaintLayer = LayerBase & {
  kind: 'paint'
  src: string
}

export type Layer = KeyframeLayer | PatternLayer | ImageLayer | PaintLayer
export type LayerKind = Layer['kind']

/**
 * Brightness multiplier curves, sampled evenly across an axis and interpolated
 * between. A fixed-length array rather than control points because the editor
 * paints them with a finger: there is nothing to grab and nothing to miss.
 */
export const BRIGHTNESS_POINTS = 33

export type Project = {
  id: string
  name: string
  ledCount: number
  durationMs: number
  fps: number
  /** The base of the layer stack, and what keyframe layers decay toward. */
  background: Color
  colorSpace: ColorSpace
  /** IDW exponent, 0.5–6. */
  falloffPower: number
  /** Bottom to top. */
  layers: Layer[]
  /**
   * Brightness multipliers across LED index and down time, each
   * BRIGHTNESS_POINTS long and 0..1. They multiply with each other and with the
   * finished composite, so together they are a 2D envelope over the photograph.
   */
  brightnessX: number[]
  brightnessY: number[]
  playback: Playback
  /** Epoch ms, for sorting the library. */
  updatedAt: number
}

export const FPS_OPTIONS = [15, 20, 25, 30, 50] as const

export type Tool = 'select' | 'point' | 'row' | 'column' | 'brush' | 'eraser'

/** Brush radius in pixels — LEDs across, frames down. 0.5 is a single pixel. */
export const BRUSH_SIZES = [0.5, 1.5, 3, 6] as const
