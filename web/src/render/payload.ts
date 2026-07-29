// Field -> device bytes.
//
// This is the only place gamma is applied: after all interpolation, immediately
// before quantising to u8 (§4.4). The wire format is RGB; the firmware maps to
// GRB (§2.1).

import { applyGamma } from '../model/color'
import type { Field } from './field'

/** frameCount x ledCount x 3 bytes, RGB, gamma-corrected, ready for the wire. */
export function buildPayload(field: Field, brightnessScale = 1): Uint8Array {
  const { data } = field
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.round(255 * applyGamma(data[i] * brightnessScale))
  }
  return out
}
