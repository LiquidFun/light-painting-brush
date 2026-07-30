// Device panel (REQUIREMENTS §6.10). A *list*, not a connect button: sticks dial
// into the relay and appear on their own.
//
// Everything here reflects broadcast state rather than local assumption. A stick
// may enter RECEIVING because somebody else started an upload (§3.7), and the UI
// must show that rather than contradict it.
//
// startDelayMs lives here rather than in project settings: it is a shooting
// parameter, not a design one.

import { describeOverBudget, formatBytes, formatSeconds, payloadBytes } from '../model/project'
import type { Project } from '../model/types'
import { DeviceState, stateLabel } from '../transport/protocol'
import type { DeviceEntry } from '../transport/protocol'
import type { Transport } from '../transport/types'
import { Button, Field, Panel, Row, Slider, Stat, Toggle } from './primitives'

const LINK_LABEL = {
  offline: 'Relay unreachable',
  connecting: 'Connecting to the relay…',
  online: 'Connected to the relay',
} as const

function DeviceRow({
  device,
  active,
  onSelect,
}: {
  device: DeviceEntry
  active: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className={[
          'flex min-h-11 w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left',
          active
            ? 'border-fg bg-raised text-fg'
            : 'border-line bg-panel text-dim active:bg-raised',
          device.online ? '' : 'opacity-50',
        ].join(' ')}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{device.name}</span>
          <span className="num block truncate text-xs text-mute">
            {device.online ? stateLabel(device.state) : 'Offline'}
            {device.ledCount > 0 && ` · ${device.ledCount} LEDs`}
            {device.maxAnimationBytes > 0 && ` · ${formatBytes(device.maxAnimationBytes)} free`}
          </span>
        </span>
        <span
          aria-hidden
          className={[
            'size-2 shrink-0 rounded-full',
            device.online ? 'bg-fg' : 'border border-line-strong',
          ].join(' ')}
        />
      </button>
    </li>
  )
}

export function DevicePanel({
  transport,
  project,
  autoPlay,
  onAutoPlayChange,
  onPatchProject,
  onUpload,
  onTransportKind,
}: {
  transport: Transport
  project: Project
  /** Sets the autoPlay flag on the next upload. A shooting option, so not saved with the design. */
  autoPlay: boolean
  onAutoPlayChange: (value: boolean) => void
  onPatchProject: (patch: Partial<Project>, push?: boolean) => void
  onUpload: () => void
  onTransportKind: (kind: 'relay' | 'ble') => void
}) {
  const bytes = payloadBytes(project)
  const ceiling = transport.maxAnimationBytes
  const overBudget = ceiling !== null ? describeOverBudget(project, ceiling) : null
  const target = transport.selected
  const ready = target?.online === true
  const progress = transport.progress
  const busy = target?.state === DeviceState.RECEIVING && !transport.uploading

  return (
    <>
      <Panel title="Sticks">
        {transport.kind === 'relay' && (
          <p className="text-xs text-mute">{LINK_LABEL[transport.link]}</p>
        )}

        {transport.devices.length === 0 ? (
          <p className="text-sm text-dim">
            {transport.kind === 'ble'
              ? 'Nothing paired. Bluetooth needs a tap to open the browser chooser.'
              : transport.link === 'online'
                ? 'No stick has connected to the relay. Power one on and give it a few seconds to join WiFi.'
                : 'Waiting for the relay. Designing, previewing, saving and exporting all work without it.'}
          </p>
        ) : (
          <ul className="space-y-1">
            {transport.devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                active={device.deviceId === transport.selectedId}
                onSelect={() => transport.select(device.deviceId)}
              />
            ))}
          </ul>
        )}

        {transport.pair && (
          <Row>
            {transport.link === 'online' ? (
              <Button onClick={transport.unpair ?? undefined}>Disconnect</Button>
            ) : (
              <Button
                strong
                full
                disabled={!transport.supported || transport.link === 'connecting'}
                onClick={transport.pair}
              >
                {transport.link === 'connecting' ? 'Connecting…' : 'Pair over Bluetooth'}
              </Button>
            )}
          </Row>
        )}

        {transport.kind === 'ble' && !transport.supported && (
          <p className="text-sm text-dim">
            This browser has no Web Bluetooth. Switch back to the relay, which works
            everywhere.
          </p>
        )}

        <Field
          label="Transport"
          hint="The relay works in every browser. Bluetooth is the v1 path and only reaches a stick running the v1 firmware."
        >
          <select
            value={transport.kind}
            onChange={(e) => onTransportKind(e.target.value === 'ble' ? 'ble' : 'relay')}
          >
            <option value="relay">WiFi relay</option>
            <option value="ble">Bluetooth (legacy)</option>
          </select>
        </Field>
      </Panel>

      <Panel title="Upload">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="This animation" value={formatBytes(bytes)} />
          <Stat
            label="Device limit"
            value={ceiling === null ? '—' : formatBytes(ceiling)}
            note={ceiling === null ? 'Reported by the stick' : undefined}
          />
        </div>

        {transport.error && (
          <p className="rounded border border-line-strong bg-raised p-2 text-sm text-fg">
            {transport.error}{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={transport.clearError}
            >
              Dismiss
            </button>
          </p>
        )}

        {overBudget && <p className="text-sm text-fg">{overBudget}</p>}

        {busy && (
          <p className="text-sm text-dim">
            Somebody else is uploading to this stick. Wait for it to finish — starting
            now would cancel theirs.
          </p>
        )}

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

        {/* v1 shipped without this and the resulting performance problem took a
            whole debugging session to characterise (§6.10). */}
        {!progress && transport.lastUpload && (
          <p className="num text-xs text-mute">
            Last upload {transport.lastUpload.kbPerSecond.toFixed(1)} kB/s ·{' '}
            {formatBytes(transport.lastUpload.bytes)} in{' '}
            {(transport.lastUpload.wallMs / 1000).toFixed(1)} s
            {transport.lastUpload.note && ` · ${transport.lastUpload.note}`}
          </p>
        )}

        <Row>
          <Button
            strong
            disabled={!ready || transport.uploading || overBudget !== null}
            onClick={onUpload}
          >
            {transport.uploading ? 'Uploading…' : transport.error ? 'Retry upload' : 'Upload'}
          </Button>
          {transport.uploading ? (
            <Button onClick={transport.cancelUpload}>Cancel</Button>
          ) : (
            <>
              <Button
                disabled={!ready || target?.state === DeviceState.IDLE}
                onClick={transport.play}
              >
                Play
              </Button>
              <Button disabled={!ready} onClick={transport.stop}>
                Stop
              </Button>
              <Button disabled={!ready} onClick={transport.identify} title="Flash the strip white">
                Identify
              </Button>
            </>
          )}
        </Row>

        <Slider
          label="Master brightness"
          value={transport.masterBrightness}
          min={0}
          max={255}
          display={String(transport.masterBrightness)}
          disabled={!ready}
          onChange={transport.setMasterBrightness}
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
          Trigger from here, or press the BOOT button on the stick — a press during
          playback stops it. The stick keeps one animation in flash and still has it
          after a power cycle, so a battery swap does not cost a re-upload. At{' '}
          {project.fps} fps this animation runs for {formatSeconds(project.durationMs)}.
        </p>
      </Panel>
    </>
  )
}
