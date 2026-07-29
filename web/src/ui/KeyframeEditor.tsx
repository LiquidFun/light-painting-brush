import { ColorWheel } from './ColorWheel'
import { Button, Field, Row, Slider, Toggle } from './primitives'
import type { Keyframe, Project } from '../model/types'
import { EASING_NAMES } from '../model/types'

export function KeyframeEditor({
  keyframe,
  project,
  onChange,
  onDelete,
  onDuplicate,
}: {
  keyframe: Keyframe
  project: Project
  /** `push` false coalesces a whole drag into the previous undo step. */
  onChange: (patch: Partial<Keyframe>, push?: boolean) => void
  onDelete: () => void
  onDuplicate: () => void
}) {
  const usesLed = keyframe.kind !== 'row'
  const usesTime = keyframe.kind !== 'column'

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium capitalize">{keyframe.kind}</h3>
        <span className="num text-xs text-mute">
          {usesLed && `LED ${keyframe.led}`}
          {usesLed && usesTime && ' · '}
          {usesTime && `${(keyframe.timeMs / 1000).toFixed(2)} s`}
        </span>
      </div>

      <ColorWheel
        value={keyframe.color}
        onChange={(hex) => onChange({ color: hex }, false)}
        onCommitStart={() => onChange({}, true)}
      />

      <Slider
        label="Brightness"
        value={Math.round(keyframe.brightness * 100)}
        min={0}
        max={100}
        display={`${Math.round(keyframe.brightness * 100)}%`}
        onCommitStart={() => onChange({}, true)}
        onChange={(v) => onChange({ brightness: v / 100 }, false)}
      />

      <Slider
        label="Radius"
        value={Math.round(keyframe.radius * 100)}
        min={1}
        max={100}
        display={`${Math.round(keyframe.radius * 100)}%`}
        onCommitStart={() => onChange({}, true)}
        onChange={(v) => onChange({ radius: v / 100 }, false)}
      />

      <Field label="Easing" hint="Shapes the falloff across the radius.">
        <select
          value={keyframe.easing}
          onChange={(e) => onChange({ easing: e.target.value as Keyframe['easing'] })}
        >
          {EASING_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>

      <Toggle
        label="Hard edge"
        hint="Wins outright inside its radius instead of blending."
        checked={keyframe.hard}
        onChange={(hard) => onChange({ hard })}
      />

      <div className="grid grid-cols-2 gap-3">
        {usesLed && (
          <Field label="LED index">
            <input
              type="number"
              min={0}
              max={project.ledCount - 1}
              value={keyframe.led}
              onChange={(e) => onChange({ led: Number(e.target.value) })}
            />
          </Field>
        )}
        {usesTime && (
          <Field label="Time (ms)">
            <input
              type="number"
              min={0}
              max={project.durationMs}
              step={Math.round(1000 / project.fps)}
              value={keyframe.timeMs}
              onChange={(e) => onChange({ timeMs: Number(e.target.value) })}
            />
          </Field>
        )}
      </div>

      <Row>
        <Button onClick={onDuplicate}>Duplicate</Button>
        <Button onClick={onDelete}>Delete</Button>
      </Row>
    </div>
  )
}
