// Device panel (§4.8). startDelayMs lives here rather than in project settings:
// it is a shooting parameter, not a design one.

import { DeviceState, stateLabel } from '../ble/protocol'
import type { Device } from '../ble/useDevice'
import { describeOverBudget, formatBytes, formatSeconds, payloadBytes } from '../model/project'
import type { Project } from '../model/types'
import { Button, Field, Panel, Row, Slider, Stat, Toggle } from './primitives'

export function DevicePanel({
  device,
  project,
  autoPlay,
  onAutoPlayChange,
  onPatchProject,
  onUpload,
}: {
  device: Device
  project: Project
  /** Sets the autoPlayOnUpload header flag. A shooting option, so not saved with the design. */
  autoPlay: boolean
  onAutoPlayChange: (value: boolean) => void
  onPatchProject: (patch: Partial<Project>, push?: boolean) => void
  onUpload: () => void
}) {
  const bytes = payloadBytes(project)
  const ceiling = device.maxAnimationBytes
  const overBudget = ceiling !== null ? describeOverBudget(project, ceiling) : null
  const connected = device.connection === 'connected'
  const state = device.status?.state ?? DeviceState.IDLE
  const progress = device.progress

  return (
    <Panel title="Device">
      {!device.supported && (
        <p className="text-sm text-dim">
          This browser has no Web Bluetooth, so it cannot connect. Everything else —
          designing, previewing, saving, exporting — works.
        </p>
      )}

      <Row>
        {connected ? (
          <>
            <Button onClick={device.disconnect}>Disconnect</Button>
            <Button onClick={device.identify} title="Flash the strip white">
              Identify
            </Button>
          </>
        ) : (
          <Button
            strong
            full
            disabled={!device.supported || device.connection === 'connecting'}
            onClick={() => void device.connect()}
          >
            {device.connection === 'connecting' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Stick" value={connected ? (device.deviceName ?? 'LightStick') : '—'} />
        <Stat label="State" value={connected ? stateLabel(state) : 'Not connected'} />
        <Stat label="This animation" value={formatBytes(bytes)} />
        <Stat
          label="Device limit"
          value={ceiling === null ? '—' : formatBytes(ceiling)}
          note={ceiling === null ? 'Reported on connect' : undefined}
        />
      </div>

      {device.error && (
        <p className="rounded border border-line-strong bg-raised p-2 text-sm text-fg">
          {device.error}{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={device.clearError}
          >
            Dismiss
          </button>
        </p>
      )}

      {overBudget && <p className="text-sm text-fg">{overBudget}</p>}

      {progress && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded bg-line">
            <div
              className="h-full bg-fg transition-[width] duration-100"
              style={{ width: `${(progress.sent / Math.max(1, progress.total)) * 100}%` }}
            />
          </div>
          <div className="num flex justify-between text-xs text-mute">
            <span>
              {formatBytes(progress.sent)} / {formatBytes(progress.total)}
            </span>
            <span>{Math.round((progress.sent / Math.max(1, progress.total)) * 100)}%</span>
          </div>
        </div>
      )}

      {!progress && device.lastUpload && (
        <p className="num text-xs text-mute">
          Last upload {(device.lastUpload.bytes / device.lastUpload.wallMs).toFixed(1)} kB/s ·{' '}
          {device.lastUpload.writes} writes of {device.lastUpload.chunkSize} B ·{' '}
          {device.lastUpload.msPerWrite.toFixed(0)} ms each ·{' '}
          {Math.round(device.lastUpload.writeShare * 100)}% in writes
        </p>
      )}

      <Row>
        <Button
          strong
          disabled={!connected || device.uploading || overBudget !== null}
          onClick={onUpload}
        >
          {device.uploading ? 'Uploading…' : device.error ? 'Retry upload' : 'Upload'}
        </Button>
        {device.uploading ? (
          <Button onClick={device.cancelUpload}>Cancel</Button>
        ) : (
          <>
            <Button disabled={!connected || state === DeviceState.IDLE} onClick={device.play}>
              Play
            </Button>
            <Button disabled={!connected} onClick={device.stop}>
              Stop
            </Button>
          </>
        )}
      </Row>

      <Slider
        label="Master brightness"
        value={device.masterBrightness}
        min={0}
        max={255}
        display={String(device.masterBrightness)}
        disabled={!connected}
        onChange={device.setMasterBrightness}
      />

      <Field
        label="Start delay"
        hint="Time between the trigger and the first frame — long enough to steady the stick."
      >
        <input
          type="number"
          min={0}
          max={65535}
          step={100}
          value={project.playback.startDelayMs}
          onChange={(e) =>
            onPatchProject({
              playback: { ...project.playback, startDelayMs: Number(e.target.value) },
            })
          }
        />
      </Field>

      <Toggle
        label="Play on upload"
        hint="Fires as soon as the transfer verifies."
        checked={autoPlay}
        onChange={onAutoPlayChange}
      />

      <p className="text-xs text-mute">
        Trigger from here, or press the BOOT button on the stick. Nothing is stored on
        the stick: it holds one animation in RAM and loses it on power cycle, so upload
        again before each shot. At {project.fps} fps this animation runs for{' '}
        {formatSeconds(project.durationMs)}.
      </p>
    </Panel>
  )
}
