// Power estimate (§4.7). This mirrors the firmware's FastLED clamp, so the user
// sees on screen what the hardware would otherwise silently do to them.

import { useMemo } from 'react'

import { formatMilliamps } from '../model/project'
import type { Project } from '../model/types'
import type { Field } from '../render/field'
import { POWER_BUDGET_MA, estimatePower, findBrightnessScale } from '../render/power'
import { Button, Panel, Stat } from './primitives'

export function PowerPanel({
  field,
  project,
  onPatch,
}: {
  field: Field
  project: Project
  onPatch: (patch: Partial<Project>) => void
}) {
  const estimate = useMemo(() => estimatePower(field), [field])
  const over = estimate.peakMa > POWER_BUDGET_MA
  const peakSeconds = (estimate.peakFrame * (1000 / project.fps)) / 1000

  const scaleToFit = () => {
    const scale = findBrightnessScale(field, POWER_BUDGET_MA)
    if (scale >= 1) return
    // Every layer has to come down together, or the mix between them changes.
    // Keyframes carry their own brightness; a pattern or image only has opacity.
    onPatch({
      layers: project.layers.map((l) =>
        l.kind === 'keyframes'
          ? {
              ...l,
              keyframes: l.keyframes.map((k) => ({ ...k, brightness: k.brightness * scale })),
            }
          : { ...l, opacity: l.opacity * scale },
      ),
    })
  }

  return (
    <Panel title="Power">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Peak current"
          value={formatMilliamps(estimate.peakMa)}
          note={`at ${peakSeconds.toFixed(2)} s`}
        />
        <Stat label="Mean current" value={formatMilliamps(estimate.meanMa)} />
      </div>

      {over ? (
        <>
          <p className="text-sm text-fg">
            Peak draw is over the {formatMilliamps(POWER_BUDGET_MA)} budget. The stick will
            scale those frames down itself, which dims the whole strip mid-exposure.
          </p>
          <Button strong full onClick={scaleToFit}>
            Scale brightness to fit
          </Button>
        </>
      ) : (
        <p className="text-xs text-mute">
          Within the {formatMilliamps(POWER_BUDGET_MA)} budget, assuming 20 mA per lit
          channel. Nothing will be clamped.
        </p>
      )}
    </Panel>
  )
}
