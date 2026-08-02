import { formatBytes, formatSeconds, frameCount, payloadBytes } from '../model/project'
import type { Project } from '../model/types'
import { DeviceState, stateLabel } from '../transport/protocol'
import type { Transport } from '../transport/types'
import { IconButton } from './primitives'

export function Header({
  project,
  transport,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onOpenProject,
  onOpenLayers,
  onOpenDevice,
  view,
  onView,
  onUpload,
  onPlay,
  onStop,
}: {
  project: Project
  transport: Transport
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onOpenProject: () => void
  onOpenLayers: () => void
  onOpenDevice: () => void
  view: '2d' | '3d'
  onView: (view: '2d' | '3d') => void
  onUpload: () => void
  onPlay: () => void
  onStop: () => void
}) {
  const target = transport.selected
  const online = target?.online === true
  const ceiling = transport.maxAnimationBytes
  const bytes = payloadBytes(project)
  const overBudget = ceiling !== null && bytes > ceiling
  // The two things you do between every shot, without opening the sheet.
  const canUpload = online && !transport.uploading && !overBudget
  const playing = target?.state === DeviceState.PLAYING
  // Only READY and PLAYING can be triggered. IDLE has nothing loaded and
  // RECEIVING has only part of it, and the stick rejects both.
  const canPlay =
    online && (target.state === DeviceState.READY || playing)

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

      {/* The 2D canvas is the photograph for one specific sweep; 3D is the same
          animation swept the ways a stick actually moves. */}
      <div className="flex shrink-0 overflow-hidden rounded border border-line">
        {(['2d', '3d'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={[
              'h-11 w-9 text-xs uppercase',
              view === v ? 'bg-raised text-fg font-medium' : 'text-mute active:bg-raised',
            ].join(' ')}
          >
            {v}
          </button>
        ))}
      </div>

      <IconButton label={`Layers (${project.layers.length})`} onClick={onOpenLayers}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 1.5L14.5 5 8 8.5 1.5 5 8 1.5z" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 8l5.5 3 5.5-3M2.5 11l5.5 3 5.5-3" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </IconButton>

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

      <IconButton
        strong
        label={transport.uploading ? 'Uploading…' : 'Upload to the stick'}
        disabled={!canUpload}
        onClick={onUpload}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M8 11V2M4.5 5.5L8 2l3.5 3.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M2.5 10.5v3h11v-3" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
      {/* Follows the stick rather than the last thing this browser asked for, so
          it is right even when somebody else started the animation (§3.7).
          Stop, not pause: the protocol has no resume, and playing again starts
          from frame 0. */}
      <IconButton
        strong
        label={playing ? 'Stop the stick' : 'Play on the stick'}
        disabled={!canPlay}
        onClick={playing ? onStop : onPlay}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 2.5l9 5.5-9 5.5V2.5z" fill="currentColor" />
          </svg>
        )}
      </IconButton>

      <button
        type="button"
        onClick={onOpenDevice}
        className={[
          'min-h-11 shrink-0 rounded border px-2 text-xs',
          online ? 'border-fg text-fg' : 'border-line text-mute',
        ].join(' ')}
      >
        <span className="block max-w-24 truncate">{online ? target.name : 'No stick'}</span>
        <span className="num block text-[10px] text-mute">
          {online ? stateLabel(target.state) : transport.kind === 'ble' ? 'Pair' : 'Waiting'}
        </span>
      </button>
    </header>
  )
}
