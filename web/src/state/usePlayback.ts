// The playhead. Advances in real time but lands only on frame boundaries, so
// what the 1D strip shows is a frame the device would actually display.

import { useCallback, useEffect, useRef, useState } from 'react'

export type Playhead = {
  timeMs: number
  playing: boolean
  loop: boolean
  setTime: (ms: number) => void
  play: () => void
  pause: () => void
  toggle: () => void
  setLoop: (loop: boolean) => void
  stepFrame: (delta: number) => void
}

export function usePlayback(durationMs: number, fps: number): Playhead {
  const [timeMs, setTimeMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const frameMs = 1000 / fps
  const timeRef = useRef(timeMs)
  timeRef.current = timeMs

  const setTime = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(durationMs, ms))
      setTimeMs(Math.round(Math.round(clamped / frameMs) * frameMs))
    },
    [durationMs, frameMs],
  )

  // Duration or fps changed under us.
  useEffect(() => {
    if (timeRef.current > durationMs) setTime(durationMs)
  }, [durationMs, setTime])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const startWall = performance.now()
    const startTime = timeRef.current >= durationMs ? 0 : timeRef.current

    const step = (now: number) => {
      const elapsed = startTime + (now - startWall)
      if (elapsed >= durationMs) {
        if (loop) {
          const wrapped = elapsed % durationMs
          setTimeMs(Math.round(Math.floor(wrapped / frameMs) * frameMs))
        } else {
          setTimeMs(Math.round(Math.floor(durationMs / frameMs) * frameMs))
          setPlaying(false)
          return
        }
      } else {
        setTimeMs(Math.round(Math.floor(elapsed / frameMs) * frameMs))
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, loop, durationMs, frameMs])

  return {
    timeMs,
    playing,
    loop,
    setTime,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => !p),
    setLoop,
    stepFrame: (delta: number) => setTime(timeRef.current + delta * frameMs),
  }
}
