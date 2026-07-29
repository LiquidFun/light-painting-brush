import { clamp } from './color'
import type { Keyframe, KeyframeKind, Project } from './types'
import { FPS_OPTIONS } from './types'

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
    fps: 25,
    background: '#000000',
    colorSpace: 'oklab',
    falloffPower: 2,
    keyframes: [],
    playback: { loop: false, pingPong: false, startDelayMs: 0 },
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

/**
 * A starter animation, so a new project is not a black rectangle. Brightness is
 * deliberately below 1 so the first thing a user sees is inside the power budget.
 */
export function seedProject(p: Project): Project {
  const mid = Math.floor((p.ledCount - 1) / 2)
  const seed = (led: number, timeMs: number, color: string) => ({
    ...createKeyframe('point', led, timeMs, color),
    radius: 0.45,
    brightness: 0.7,
  })
  return {
    ...p,
    keyframes: [
      seed(0, 0, '#ff2d00'),
      seed(mid, p.durationMs / 2, '#00d0ff'),
      seed(p.ledCount - 1, p.durationMs, '#ffd400'),
    ],
  }
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
  const lowerFps = FPS_OPTIONS.filter(
    (f) => f < p.fps && payloadBytes({ ...p, fps: f }) <= maxBytes,
  )
  const advice =
    fits >= MIN_DURATION_MS
      ? `Shorten to ${formatSeconds(fits)}` +
        (lowerFps.length ? ` or drop to ${lowerFps[lowerFps.length - 1]} fps.` : '.')
      : lowerFps.length
        ? `Drop to ${lowerFps[lowerFps.length - 1]} fps.`
        : 'Shorten the animation.'
  return `Animation is ${formatBytes(over)} over the device limit. ${advice}`
}
