import { useEffect, useRef, useState } from 'react'

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
import { downloadJson, parseImport, slug, toExportFile } from '../model/storage'
import type { LibrarySync } from '../model/library'
import { COLOR_SPACES, FPS_OPTIONS } from '../model/types'
import type { Project } from '../model/types'
import { Button, Field, Panel, Row, Slider, Stat, Toggle } from './primitives'
import { ProjectThumb } from './ProjectThumb'

const SYNC_NOTE: Record<LibrarySync, string> = {
  loading: 'Checking the shared library on the server…',
  saving: 'Saving to the shared library…',
  synced: 'Saved here and in the shared library on the server.',
  offline:
    'Saved in this browser only — the server could not be reached. It will not sync until you reload with a connection.',
  idle: 'Saved in this browser.',
}

export function ProjectPanel({
  project,
  library,
  librarySync,
  maxAnimationBytes,
  night,
  onNightChange,
  onPatch,
  onOpen,
  onNew,
  onDelete,
  onImport,
}: {
  project: Project
  library: Project[]
  librarySync: LibrarySync
  maxAnimationBytes: number | null
  night: boolean
  onNightChange: (value: boolean) => void
  onPatch: (patch: Partial<Project>, push?: boolean) => void
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onImport: (projects: Project[]) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
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

  const importFile = async (file: File) => {
    const { projects, error } = parseImport(await file.text())
    if (error) {
      window.alert(error)
      return
    }
    onImport(projects)
  }

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

        {/* Indexed rather than continuous: only these rates divide evenly into
            the frame schedule the firmware clocks out. */}
        <Slider
          label="Frame rate"
          value={Math.max(0, FPS_OPTIONS.indexOf(project.fps as (typeof FPS_OPTIONS)[number]))}
          min={0}
          max={FPS_OPTIONS.length - 1}
          display={`${project.fps} fps`}
          hint="Higher is smoother and proportionally bigger. 25 is plenty for a sweep."
          onChange={(i) => onPatch({ fps: FPS_OPTIONS[i] })}
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
          hint="How sharply a keyframe's influence drops with distance. Low spreads
            colour into soft washes that blend far apart; high keeps each keyframe
            tight and local. Affects keyframe layers only."
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

      <Panel title="Library">
        <ul className="space-y-1">
          {library.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpen(p.id)}
                className={[
                  'flex min-h-11 flex-1 items-center gap-2 rounded border px-2 py-1 text-left text-sm',
                  p.id === project.id
                    ? 'border-fg bg-raised text-fg font-medium'
                    : 'border-line bg-panel text-dim active:bg-raised',
                ].join(' ')}
              >
                <ProjectThumb project={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="num block truncate text-xs text-mute">
                    {formatSeconds(p.durationMs)} · {p.layers.length} layers
                  </span>
                </span>
              </button>
              <Button
                onClick={() => {
                  if (window.confirm(`Delete "${p.name}"? This cannot be undone.`)) {
                    onDelete(p.id)
                  }
                }}
                title={`Delete ${p.name}`}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>

        <Row>
          <Button onClick={onNew}>New</Button>
          <Button
            onClick={() =>
              downloadJson(`${slug(project.name)}.lightstick.json`, toExportFile([project], true))
            }
          >
            Export
          </Button>
          <Button
            onClick={() =>
              downloadJson('lightstick-library.json', toExportFile(library, false))
            }
          >
            Export all
          </Button>
          <Button onClick={() => fileRef.current?.click()}>Import</Button>
        </Row>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importFile(file)
            e.target.value = ''
          }}
        />
        <p className="text-xs text-mute">
          One shared library: everybody with the password sees and can edit these.
          {' '}
          {SYNC_NOTE[librarySync]}
        </p>
      </Panel>
    </>
  )
}
