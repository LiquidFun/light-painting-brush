import { clamp } from './color'
import { DEFAULT_SWEEP } from '../render/sweep'
import type {
  Keyframe,
  KeyframeKind,
  KeyframeLayer,
  Layer,
  LayerKind,
  PaintLayer,
  Pattern,
  PatternKind,
  Project,
} from './types'
import { BRIGHTNESS_POINTS, DEFAULT_MASTER_BRIGHTNESS, MIN_FPS } from './types'

export const DEFAULT_LED_COUNT = 144
export const BYTES_PER_LED = 3

export const MIN_DURATION_MS = 200
export const MAX_DURATION_MS = 60_000
export const MIN_FALLOFF = 0.5
export const MAX_FALLOFF = 6

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function frameCount(p: Pick<Project, 'durationMs' | 'fps'>): number {
  return Math.max(1, Math.round((p.durationMs / 1000) * p.fps))
}

export function payloadBytes(p: Pick<Project, 'durationMs' | 'fps' | 'ledCount'>): number {
  return frameCount(p) * p.ledCount * BYTES_PER_LED
}

export function frameBytes(ledCount: number): number {
  return ledCount * BYTES_PER_LED
}

/** Longest duration in ms that still fits in `maxBytes` at this fps. */
export function maxDurationForBytes(
  maxBytes: number,
  fps: number,
  ledCount: number,
): number {
  const frames = Math.floor(maxBytes / frameBytes(ledCount))
  return Math.max(0, Math.floor((frames / fps) * 1000))
}

export function createProject(name = 'Untitled'): Project {
  return {
    id: uid(),
    name,
    ledCount: DEFAULT_LED_COUNT,
    durationMs: 5000,
    fps: 60,
    background: '#000000',
    colorSpace: 'oklab',
    falloffPower: 2,
    layers: [],
    brightnessX: flatCurve(),
    brightnessY: flatCurve(),
    sweep: { ...DEFAULT_SWEEP },
    // Loop and ping-pong on by default: a sweep usually wants the pattern to
    // keep coming, and stopping is the BOOT button. autoPlay because uploading
    // and then reaching for Play is two steps for one intention.
    playback: { loop: true, pingPong: true, startDelayMs: 0, autoPlay: true },
    brightness: DEFAULT_MASTER_BRIGHTNESS,
    updatedAt: Date.now(),
  }
}

export function createKeyframe(
  kind: KeyframeKind,
  led: number,
  timeMs: number,
  color = '#ffffff',
): Keyframe {
  return {
    id: uid(),
    kind,
    led: Math.round(led),
    timeMs: Math.round(timeMs),
    color,
    brightness: 1,
    radius: 0.35,
    softness: 0.35,
    easing: 'smoothstep',
    hard: false,
  }
}

/** Keeps a keyframe inside the project's bounds after edits or a resize. */
export function clampKeyframe(k: Keyframe, p: Project): Keyframe {
  return {
    ...k,
    led: Math.round(clamp(k.led, 0, p.ledCount - 1)),
    timeMs: Math.round(clamp(k.timeMs, 0, p.durationMs)),
    brightness: clamp(k.brightness, 0, 1),
    radius: clamp(k.radius, 0.01, 1),
  }
}

// --- layers ----------------------------------------------------------------

const DEFAULT_RAMP = { from: '#ff2d00', to: '#00d0ff' }

/** A brightness curve that does nothing: full brightness everywhere. */
export function flatCurve(): number[] {
  return new Array<number>(BRIGHTNESS_POINTS).fill(1)
}

export const isFlatCurve = (curve: number[]): boolean => curve.every((v) => v === 1)

/**
 * Reads a curve at `t` in 0..1, interpolating between samples. Out-of-range t
 * clamps rather than wrapping, so the ends of the strip hold their value.
 */
export function sampleCurve(curve: number[], t: number): number {
  const last = curve.length - 1
  if (last < 0) return 1
  const x = t <= 0 ? 0 : t >= 1 ? last : t * last
  const i = Math.floor(x)
  if (i >= last) return curve[last]
  const f = x - i
  return curve[i] * (1 - f) + curve[i + 1] * f
}

/** How many pixels a pattern axis spans: LEDs across, frames down. */
export function axisExtent(p: Project, axis: 'led' | 'time'): number {
  return axis === 'led' ? p.ledCount : frameCount(p)
}

export function defaultPattern(kind: PatternKind): Pattern {
  switch (kind) {
    case 'solid':
      return { kind: 'solid', color: '#00d0ff' }
    case 'stripes':
      return {
        kind: 'stripes',
        axis: 'led',
        periodPx: 24,
        duty: 0.5,
        softness: 0.1,
        phase: 0,
        ramp: DEFAULT_RAMP,
      }
    case 'wave':
      return {
        kind: 'wave',
        axis: 'led',
        wavelengthPx: 72,
        amplitude: 1,
        phase: 0,
        speed: 1,
        ramp: DEFAULT_RAMP,
      }
    case 'gradient':
      return { kind: 'gradient', angle: 90, ramp: DEFAULT_RAMP }
    case 'noise':
      return { kind: 'noise', scale: 6, speed: 1, seed: 1, ramp: DEFAULT_RAMP }
  }
}

const DEFAULT_LAYER_NAME: Record<LayerKind, string> = {
  keyframes: 'Keyframes',
  pattern: 'Pattern',
  image: 'Image',
  paint: 'Paint',
}

export function createLayer(kind: LayerKind, name?: string): Layer {
  const base = {
    id: uid(),
    name: name ?? DEFAULT_LAYER_NAME[kind],
    opacity: 1,
    blend: 'normal' as const,
    hidden: false,
  }
  switch (kind) {
    case 'keyframes':
      return { ...base, kind: 'keyframes', keyframes: [] }
    case 'pattern':
      return { ...base, kind: 'pattern', pattern: defaultPattern('stripes') }
    case 'image':
      return {
        ...base,
        kind: 'image',
        src: '',
        fit: 'stretch',
        rotation: 0,
        flipX: false,
        flipY: false,
      }
    case 'paint':
      return { ...base, kind: 'paint', src: '' }
  }
}

export function isKeyframeLayer(layer: Layer): layer is KeyframeLayer {
  return layer.kind === 'keyframes'
}

/** The layer keyframe tools draw into: the requested one, else the topmost. */
export function activeKeyframeLayer(p: Project, id: string | null): KeyframeLayer | null {
  const named = p.layers.find((l) => l.id === id)
  if (named && isKeyframeLayer(named)) return named
  for (let i = p.layers.length - 1; i >= 0; i--) {
    const l = p.layers[i]
    if (isKeyframeLayer(l)) return l
  }
  return null
}

export function isPaintLayer(layer: Layer): layer is PaintLayer {
  return layer.kind === 'paint'
}

/** The layer the brush writes into: the requested one, else the topmost paint layer. */
export function activePaintLayer(p: Project, id: string | null): PaintLayer | null {
  const named = p.layers.find((l) => l.id === id)
  if (named && isPaintLayer(named)) return named
  for (let i = p.layers.length - 1; i >= 0; i--) {
    const l = p.layers[i]
    if (isPaintLayer(l)) return l
  }
  return null
}

/**
 * A starter animation, so a new project is not a black rectangle. Brightness is
 * deliberately below 1 so the first thing a user sees is inside the power budget.
 */
/**
 * A new project starts with one empty keyframe layer and nothing in it.
 *
 * It used to seed three coloured points, on the theory that a black rectangle is
 * an unhelpful first impression. In practice they were something to delete
 * before every single new project, which is worse.
 */
export function seedProject(p: Project): Project {
  return { ...p, layers: [createLayer('keyframes')] }
}

// --- formatting (copy rules from REQUIREMENTS §4.11) ------------------------

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function formatMilliamps(ma: number): string {
  return ma >= 1000 ? `${(ma / 1000).toFixed(2)} A` : `${Math.round(ma)} mA`
}

/**
 * Errors state what happened and what to do:
 * "Animation is 34 KB over the device limit. Shorten to 4.1 s or drop to 20 fps."
 */
export function describeOverBudget(p: Project, maxBytes: number): string | null {
  const bytes = payloadBytes(p)
  if (bytes <= maxBytes) return null
  const over = bytes - maxBytes
  const fits = maxDurationForBytes(maxBytes, p.fps, p.ledCount)
  // The highest rate that would fit at this duration, rather than the best of a
  // fixed list — the rate is a free integer now.
  const framesThatFit = Math.floor(maxBytes / (p.ledCount * BYTES_PER_LED))
  const fpsThatFits = Math.floor(framesThatFit / (p.durationMs / 1000))
  const lowerFps = fpsThatFits >= MIN_FPS && fpsThatFits < p.fps ? fpsThatFits : null
  const advice =
    fits >= MIN_DURATION_MS
      ? `Shorten to ${formatSeconds(fits)}` +
        (lowerFps ? ` or drop to ${lowerFps} fps.` : '.')
      : lowerFps
        ? `Drop to ${lowerFps} fps.`
        : 'Shorten the animation.'
  return `Animation is ${formatBytes(over)} over the device limit. ${advice}`
}
