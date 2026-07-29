// Power estimate (§4.7).
//
// This mirrors the firmware's own FastLED clamp, so the user sees on screen what
// the hardware would otherwise silently do to their exposure.

import { applyGamma } from '../model/color'
import type { Field } from './field'

/** Assumed draw of one fully-lit channel. */
export const MA_PER_CHANNEL = 20

/** Matches FastLED.setMaxPowerInVoltsAndMilliamps(5, 2200) in the firmware. */
export const POWER_BUDGET_MA = 2200

export type PowerEstimate = {
  peakMa: number
  meanMa: number
  /** Frame index where the peak occurs. */
  peakFrame: number
}

export function estimatePower(field: Field, brightnessScale = 1): PowerEstimate {
  const { width, height, data } = field
  const perFrame = width * 3
  let peak = 0
  let peakFrame = 0
  let total = 0

  for (let y = 0; y < height; y++) {
    let frameMa = 0
    const start = y * perFrame
    for (let i = start; i < start + perFrame; i++) {
      // Current follows the byte the LED actually receives, so gamma first.
      frameMa += applyGamma(data[i] * brightnessScale) * MA_PER_CHANNEL
    }
    total += frameMa
    if (frameMa > peak) {
      peak = frameMa
      peakFrame = y
    }
  }

  return { peakMa: peak, meanMa: height > 0 ? total / height : 0, peakFrame }
}

/**
 * Largest global brightness multiplier that keeps peak current under `budgetMa`.
 * Peak current is monotonic in the multiplier, so a bisection is exact enough.
 * Returns 1 if the animation already fits.
 */
export function findBrightnessScale(field: Field, budgetMa = POWER_BUDGET_MA): number {
  if (estimatePower(field, 1).peakMa <= budgetMa) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (estimatePower(field, mid).peakMa <= budgetMa) lo = mid
    else hi = mid
  }
  return lo
}
