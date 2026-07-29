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

export type Project = {
  id: string
  name: string
  ledCount: number
  durationMs: number
  fps: number
  /** What the field decays toward outside every keyframe's radius. */
  background: Color
  colorSpace: ColorSpace
  /** IDW exponent, 0.5–6. */
  falloffPower: number
  keyframes: Keyframe[]
  playback: Playback
  /** Epoch ms, for sorting the library. */
  updatedAt: number
}

export const FPS_OPTIONS = [15, 20, 25, 30, 50] as const

export type Tool = 'select' | 'point' | 'row' | 'column'
