import { DeviceState, stateLabel } from '../ble/protocol'
import type { Device } from '../ble/useDevice'
import { formatBytes, formatSeconds, frameCount, payloadBytes } from '../model/project'
import type { Project } from '../model/types'
import { IconButton } from './primitives'

export function Header({
  project,
  device,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onOpenProject,
  onOpenDevice,
}: {
  project: Project
  device: Device
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onOpenProject: () => void
  onOpenDevice: () => void
}) {
  const connected = device.connection === 'connected'
  const state = device.status?.state
  const ceiling = device.maxAnimationBytes
  const bytes = payloadBytes(project)
  const overBudget = ceiling !== null && bytes > ceiling

  return (
    <header
      className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1"
      style={{ paddingTop: 'max(4px, env(safe-area-inset-top))' }}
    >
      <button
        type="button"
        onClick={onOpenProject}
        className="min-h-11 min-w-0 flex-1 rounded px-2 text-left active:bg-raised"
      >
        <span className="block truncate text-sm font-medium">{project.name}</span>
        <span className="num block truncate text-xs text-mute">
          {frameCount(project)} frames · {formatSeconds(project.durationMs)} ·{' '}
          <span className={overBudget ? 'text-fg' : undefined}>{formatBytes(bytes)}</span>
          {ceiling !== null && ` / ${formatBytes(ceiling)}`}
        </span>
      </button>

      <IconButton label="Undo" disabled={!canUndo} onClick={onUndo}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M6 3L2.5 6.5 6 10" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2.5 6.5H9a4 4 0 010 8H6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
      <IconButton label="Redo" disabled={!canRedo} onClick={onRedo}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M10 3l3.5 3.5L10 10" stroke="currentColor" strokeWidth="1.5" />
          <path d="M13.5 6.5H7a4 4 0 000 8h3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>

      <button
        type="button"
        onClick={onOpenDevice}
        className={[
          'min-h-11 shrink-0 rounded border px-2 text-xs',
          connected ? 'border-fg text-fg' : 'border-line text-mute',
        ].join(' ')}
      >
        <span className="block">{connected ? 'Stick' : 'No stick'}</span>
        <span className="num block text-[10px] text-mute">
          {connected ? stateLabel(state ?? DeviceState.IDLE) : 'Connect'}
        </span>
      </button>
    </header>
  )
}
