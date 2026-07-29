// Parameter editors for pattern layers (REQUIREMENTS §6.2). One panel per
// pattern kind; switching kind swaps in that kind's defaults rather than trying
// to carry parameters across, which would mean guessing at equivalences.

import { defaultPattern } from '../model/project'
import { PATTERN_KINDS } from '../model/types'
import type { ColorRamp, Pattern, PatternAxis, PatternKind } from '../model/types'
import { Field, Segmented, Slider } from './primitives'

const AXES: { id: PatternAxis; label: string }[] = [
  { id: 'led', label: 'Across LEDs' },
  { id: 'time', label: 'Along time' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

function RampField({
  ramp,
  onChange,
}: {
  ramp: ColorRamp
  onChange: (ramp: ColorRamp) => void
}) {
  return (
    <Field label="Ramp" hint="Interpolated in the project's colour space.">
      <div className="grid grid-cols-2 gap-2">
        <input
          type="color"
          aria-label="Ramp start"
          value={ramp.from}
          onChange={(e) => onChange({ ...ramp, from: e.target.value })}
        />
        <input
          type="color"
          aria-label="Ramp end"
          value={ramp.to}
          onChange={(e) => onChange({ ...ramp, to: e.target.value })}
        />
      </div>
    </Field>
  )
}

export function PatternEditor({
  pattern,
  onChange,
}: {
  pattern: Pattern
  /** `push` false coalesces a whole slider drag into one undo step. */
  onChange: (pattern: Pattern, push?: boolean) => void
}) {
  // Each arm narrows `pattern`, so the patch helper has to be built per arm.
  const start = () => onChange(pattern, true)

  return (
    <div className="space-y-4">
      <Field label="Pattern">
        <select
          value={pattern.kind}
          onChange={(e) => onChange(defaultPattern(e.target.value as PatternKind))}
        >
          {PATTERN_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>

      {pattern.kind === 'solid' && (
        <Field label="Colour">
          <input
            type="color"
            aria-label="Colour"
            value={pattern.color}
            onChange={(e) => onChange({ ...pattern, color: e.target.value })}
          />
        </Field>
      )}

      {pattern.kind === 'stripes' && (
        <>
          <Segmented
            label="Stripe axis"
            options={AXES}
            value={pattern.axis}
            onChange={(axis) => onChange({ ...pattern, axis })}
          />
          <Slider
            label="Period"
            value={Math.round(pattern.period * 100)}
            min={1}
            max={100}
            display={pct(pattern.period)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, period: v / 100 }, false)}
          />
          <Slider
            label="Duty"
            value={Math.round(pattern.duty * 100)}
            min={0}
            max={100}
            display={pct(pattern.duty)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, duty: v / 100 }, false)}
          />
          <Slider
            label="Softness"
            value={Math.round(pattern.softness * 100)}
            min={0}
            max={100}
            display={pattern.softness === 0 ? 'hard' : pct(pattern.softness)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, softness: v / 100 }, false)}
          />
          <Slider
            label="Phase"
            value={Math.round(pattern.phase * 100)}
            min={-100}
            max={100}
            display={pct(pattern.phase)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, phase: v / 100 }, false)}
          />
          <RampField ramp={pattern.ramp} onChange={(ramp) => onChange({ ...pattern, ramp })} />
        </>
      )}

      {pattern.kind === 'wave' && (
        <>
          <Segmented
            label="Wave axis"
            options={AXES}
            value={pattern.axis}
            onChange={(axis) => onChange({ ...pattern, axis })}
          />
          <Slider
            label="Wavelength"
            value={Math.round(pattern.wavelength * 100)}
            min={1}
            max={200}
            display={pct(pattern.wavelength)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, wavelength: v / 100 }, false)}
          />
          <Slider
            label="Amplitude"
            value={Math.round(pattern.amplitude * 100)}
            min={0}
            max={100}
            display={pct(pattern.amplitude)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, amplitude: v / 100 }, false)}
          />
          <Slider
            label="Speed"
            value={Math.round(pattern.speed * 10)}
            min={-100}
            max={100}
            display={
              pattern.speed === 0 ? 'static' : `${pattern.speed.toFixed(1)} cycles`
            }
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, speed: v / 10 }, false)}
          />
          <Slider
            label="Phase"
            value={Math.round(pattern.phase * 100)}
            min={-100}
            max={100}
            display={pct(pattern.phase)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, phase: v / 100 }, false)}
          />
          <RampField ramp={pattern.ramp} onChange={(ramp) => onChange({ ...pattern, ramp })} />
        </>
      )}

      {pattern.kind === 'gradient' && (
        <>
          <Slider
            label="Angle"
            value={pattern.angle}
            min={0}
            max={360}
            display={`${pattern.angle}°`}
            onCommitStart={start}
            onChange={(angle) => onChange({ ...pattern, angle }, false)}
          />
          <p className="text-xs text-mute">0° runs across the LEDs, 90° down the time axis.</p>
          <RampField ramp={pattern.ramp} onChange={(ramp) => onChange({ ...pattern, ramp })} />
        </>
      )}

      {pattern.kind === 'noise' && (
        <>
          <Slider
            label="Scale"
            value={Math.round(pattern.scale * 10)}
            min={5}
            max={400}
            display={`${pattern.scale.toFixed(1)} cells`}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, scale: v / 10 }, false)}
          />
          <Slider
            label="Speed"
            value={Math.round(pattern.speed * 10)}
            min={0}
            max={100}
            display={pattern.speed === 0 ? 'static' : pattern.speed.toFixed(1)}
            onCommitStart={start}
            onChange={(v) => onChange({ ...pattern, speed: v / 10 }, false)}
          />
          <Field label="Seed" hint="Same seed, same pattern — change it to reroll.">
            <input
              type="number"
              min={0}
              max={65535}
              value={pattern.seed}
              onChange={(e) => onChange({ ...pattern, seed: Number(e.target.value) })}
            />
          </Field>
          <RampField ramp={pattern.ramp} onChange={(ramp) => onChange({ ...pattern, ramp })} />
        </>
      )}
    </div>
  )
}
