// Transport + scrub. The playhead is the only thing in the app that animates on
// its own.

import { IconButton } from './primitives'
import type { Playhead } from '../state/usePlayback'

export function Transport({
  playhead,
  durationMs,
  fps,
  frameCount,
}: {
  playhead: Playhead
  durationMs: number
  fps: number
  frameCount: number
}) {
  const frame = Math.round(playhead.timeMs / (1000 / fps))
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <IconButton
        label={playhead.playing ? 'Pause' : 'Play preview'}
        onClick={playhead.toggle}
        active={playhead.playing}
      >
        {playhead.playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <rect x="2" y="1" width="3.5" height="12" fill="currentColor" />
            <rect x="8.5" y="1" width="3.5" height="12" fill="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M2 1l11 6-11 6z" fill="currentColor" />
          </svg>
        )}
      </IconButton>
      <IconButton label="Previous frame" onClick={() => playhead.stepFrame(-1)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M12 1L3 7l9 6z" fill="currentColor" />
          <rect x="1" y="1" width="1.5" height="12" fill="currentColor" />
        </svg>
      </IconButton>
      <IconButton label="Next frame" onClick={() => playhead.stepFrame(1)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M2 1l9 6-9 6z" fill="currentColor" />
          <rect x="11.5" y="1" width="1.5" height="12" fill="currentColor" />
        </svg>
      </IconButton>

      <input
        type="range"
        min={0}
        max={durationMs}
        step={1000 / fps}
        value={playhead.timeMs}
        aria-label="Scrub"
        onChange={(e) => playhead.setTime(Number(e.target.value))}
        className="min-w-0 flex-1"
      />

      <span className="num shrink-0 text-xs text-dim">
        {(playhead.timeMs / 1000).toFixed(2)} s
        <span className="text-mute">
          {' '}
          · {frame}/{frameCount - 1}
        </span>
      </span>

      <IconButton
        label="Loop preview"
        active={playhead.loop}
        onClick={() => playhead.setLoop(!playhead.loop)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none">
          <path
            d="M3 6.5A3.5 3.5 0 016.5 3H12M13 9.5A3.5 3.5 0 019.5 13H4"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M10 1.5L12.5 3 10 4.5M6 10.5L3.5 13 6 14.5" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </IconButton>
    </div>
  )
}
