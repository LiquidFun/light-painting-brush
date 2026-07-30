import { useCallback, useEffect, useMemo, useState } from 'react'

import type { DeviceEntry, UploadOptions } from './protocol'
import { RelayClient } from './relay'
import type { LinkState, Transport, UploadProgress, UploadStats } from './types'

/**
 * The relay transport (REQUIREMENTS §6.10). Devices appear and disappear on the
 * relay's broadcast, so this holds no local assumption about their state: a stick
 * may enter RECEIVING because somebody else started an upload (§3.7).
 */
export function useRelay(enabled: boolean): Transport {
  const [link, setLink] = useState<LinkState>('offline')
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [lastUpload, setLastUpload] = useState<UploadStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const client = useMemo(
    () =>
      new RelayClient({
        onLink: setLink,
        onDevices: setDevices,
        onProgress: setProgress,
        onStats: setLastUpload,
        onError: setError,
      }),
    [],
  )

  useEffect(() => {
    if (!enabled) return
    client.connect()
    return () => client.close()
  }, [client, enabled])

  // Follow the relay rather than hold a stale id: a stick that has gone offline
  // must not stay selected, and the common case is exactly one stick.
  useEffect(() => {
    setSelectedId((current) => {
      if (current && devices.some((d) => d.deviceId === current && d.online)) return current
      return devices.find((d) => d.online)?.deviceId ?? null
    })
  }, [devices])

  const selected = useMemo(
    () => devices.find((d) => d.deviceId === selectedId) ?? null,
    [devices, selectedId],
  )

  const upload = useCallback(
    async (payload: Uint8Array, options: UploadOptions) => {
      if (!selectedId) {
        setError('No stick selected. Pick one from the list.')
        return false
      }
      setError(null)
      setUploading(true)
      try {
        await client.upload(selectedId, payload, options)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The upload failed.')
        return false
      } finally {
        setUploading(false)
        setProgress(null)
      }
    },
    [client, selectedId],
  )

  const command = useCallback(
    (fn: (deviceId: string) => void) => () => {
      if (selectedId) fn(selectedId)
    },
    [selectedId],
  )

  const setMasterBrightness = useCallback(
    (value: number) => {
      if (selectedId) client.setBrightness(selectedId, value)
    },
    [client, selectedId],
  )

  return {
    kind: 'relay',
    // The relay needs nothing exotic, which is the whole point of §6.1.
    supported: true,
    link,
    devices,
    selectedId,
    selected,
    select: setSelectedId,
    // Zero means the stick has not reported a ceiling yet, not that it has none —
    // treat it as unknown rather than telling the user everything is over budget.
    maxAnimationBytes: selected?.maxAnimationBytes || null,
    uploading,
    progress,
    lastUpload,
    error,
    clearError: () => setError(null),
    setMasterBrightness,
    upload,
    cancelUpload: () => client.cancelUpload(),
    play: command((id) => client.play(id)),
    stop: command((id) => client.stop(id)),
    clear: command((id) => client.clear(id)),
    identify: command((id) => client.identify(id)),
    pair: null,
    unpair: null,
  }
}
