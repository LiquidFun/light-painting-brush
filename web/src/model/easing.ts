import type { EasingName } from './types'

/**
 * Easing curves applied to normalised distance `t` in [0,1] before weighting.
 * Every curve must satisfy e(0) = 0 and e(1) = 1: the weight formula relies on
 * e(1) = 1 to drive a keyframe's influence to exactly zero at its radius.
 */
export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  smoothstep: (t) => t * t * (3 - 2 * t),
  step: (t) => (t < 0.5 ? 0 : 1),
}

export function easingFn(name: EasingName): (t: number) => number {
  return EASINGS[name] ?? EASINGS.linear
}
