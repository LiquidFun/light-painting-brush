import { useEffect, useState } from 'react'

import { isHex, normaliseHex } from '../model/color'
import {
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  formatBytes,
  formatSeconds,
  frameCount,
  maxDurationForBytes,
  payloadBytes,
} from '../model/project'
import { COLOR_SPACES, MAX_FPS, MIN_FPS } from '../model/types'
import type { Project } from '../model/types'
import { Field, Panel, Slider, Stat, Toggle } from './primitives'

export function ProjectPanel({
  project,
  maxAnimationBytes,
  night,
  onNightChange,
  onPatch,
}: {
  project: Project
  maxAnimationBytes: number | null
  night: boolean
  onNightChange: (value: boolean) => void
  onPatch: (patch: Partial<Project>, push?: boolean) => void
}) {
  const [hex, setHex] = useState(project.background)
  // Follow the project when it changes underneath us — a different project
  // opened, an undo, or the colour picker being dragged.
  useEffect(() => setHex(project.background), [project.background])
  const frames = frameCount(project)
  const bytes = payloadBytes(project)

  // Bound the slider by what the device says it can hold, so a design that
  // cannot fit is hard to make in the first place.
  const durationCeiling =
    maxAnimationBytes === null
      ? MAX_DURATION_MS
      : Math.max(
          MIN_DURATION_MS,
          Math.min(
            MAX_DURATION_MS,
            maxDurationForBytes(maxAnimationBytes, project.fps, project.ledCount),
          ),
        )

  return (
    <>
      <Panel title="Project">
        <Field label="Name">
          <input
            type="text"
            value={project.name}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </Field>

        <Slider
          label="Duration"
          value={Math.min(project.durationMs, durationCeiling)}
          min={MIN_DURATION_MS}
          max={durationCeiling}
          step={100}
          display={formatSeconds(project.durationMs)}
          onCommitStart={() => onPatch({}, true)}
          onChange={(v) => onPatch({ durationMs: v }, false)}
        />

        <Slider
          label="Frame rate"
          value={project.fps}
          min={MIN_FPS}
          max={MAX_FPS}
          display={`${project.fps} fps`}
          hint="Sets the detail along the sweep. Match it to your sweep speed: at
            7 mm per frame the photograph resolves as finely along time as it does
            across the LEDs. Costs payload in proportion."
          onCommitStart={() => onPatch({}, true)}
          onChange={(fps) => onPatch({ fps }, false)}
        />

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Frames" value={String(frames)} />
          <Stat label="Payload" value={formatBytes(bytes)} />
          <Stat
            label="Ceiling"
            value={maxAnimationBytes === null ? '—' : formatBytes(maxAnimationBytes)}
          />
        </div>

        <Field label="Colour mixing" hint={COLOR_SPACES.find((c) => c.id === project.colorSpace)?.note}>
          <select
            value={project.colorSpace}
            onChange={(e) => onPatch({ colorSpace: e.target.value as Project['colorSpace'] })}
          >
            {COLOR_SPACES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <Slider
          label="Falloff power"
          value={project.falloffPower}
          min={0.5}
          max={6}
          step={0.1}
          display={project.falloffPower.toFixed(1)}
          hint="Which keyframe's colour wins where they overlap. Low lets distant ones
            bleed in; high keeps each colour local. It does not change the edges —
            that is Softness, on the keyframe itself."
          onCommitStart={() => onPatch({}, true)}
          onChange={(v) => onPatch({ falloffPower: v }, false)}
        />

        <Field label="Background" hint="The base of the layer stack, and what keyframe layers decay toward.">
          <div className="flex gap-2">
            <input
              type="color"
              className="shrink-0"
              style={{ width: 56 }}
              value={project.background}
              onChange={(e) => onPatch({ background: e.target.value })}
            />
            <input
              type="text"
              className="min-w-0 flex-1"
              value={hex}
              spellCheck={false}
              placeholder="#000000"
              onChange={(e) => {
                // Kept as a draft while typing. Committing only valid hex is
                // right, but binding the field to the committed value meant a
                // half-typed "#ff" was rejected and instantly reverted, so the
                // field could not be typed into at all.
                setHex(e.target.value)
                if (isHex(e.target.value)) onPatch({ background: normaliseHex(e.target.value) })
              }}
              onBlur={() => setHex(project.background)}
            />
          </div>
        </Field>

        <Toggle
          label="Loop"
          hint="Repeat until Stop."
          checked={project.playback.loop}
          onChange={(loop) => onPatch({ playback: { ...project.playback, loop } })}
        />
        <Toggle
          label="Ping-pong"
          hint="Play forward, then backward."
          checked={project.playback.pingPong}
          onChange={(pingPong) => onPatch({ playback: { ...project.playback, pingPong } })}
        />
        <Toggle
          label="Night mode"
          hint="Lower luminance, chrome shifted to deep red. For actual darkness."
          checked={night}
          onChange={onNightChange}
        />
      </Panel>

    </>
  )
}
