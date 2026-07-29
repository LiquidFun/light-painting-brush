import { useCallback, useEffect, useMemo, useState } from 'react'

import { LightStickClient, isSupported } from './client'
import type { ConnectionState, UploadProgress, UploadStats } from './client'
import type { Status, UploadHeader } from './protocol'

export const DEFAULT_MASTER_BRIGHTNESS = 80

export type Device = {
  supported: boolean
  connection: ConnectionState
  deviceName?: string
  status: Status | null
  progress: UploadProgress | null
  lastUpload: UploadStats | null
  error: string | null
  uploading: boolean
  masterBrightness: number
  /** Reported ceiling, or null while unknown. Trusted over any local estimate. */
  maxAnimationBytes: number | null
  connect: () => Promise<void>
  disconnect: () => void
  upload: (payload: Uint8Array, header: Omit<UploadHeader, 'crc32'>) => Promise<boolean>
  cancelUpload: () => void
  play: () => void
  stop: () => void
  identify: () => void
  setMasterBrightness: (value: number) => void
  clearError: () => void
}

export function useDevice(): Device {
  const supported = useMemo(isSupported, [])
  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [deviceName, setDeviceName] = useState<string | undefined>()
  const [status, setStatus] = useState<Status | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [lastUpload, setLastUpload] = useState<UploadStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [masterBrightness, setBrightnessValue] = useState(DEFAULT_MASTER_BRIGHTNESS)

  const client = useMemo(
    () =>
      new LightStickClient({
        onConnectionChange: (state, name) => {
          setConnection(state)
          setDeviceName(name)
          if (state === 'disconnected') {
            setStatus(null)
            setProgress(null)
            setUploading(false)
          }
        },
        onStatus: setStatus,
        onProgress: setProgress,
        onStats: setLastUpload,
        onError: setError,
      }),
    [],
  )

  useEffect(() => () => client.disconnect(), [client])

  const connect = useCallback(async () => {
    setError(null)
    try {
      await client.connect()
    } catch (err) {
      // A cancelled chooser is a normal outcome, not an error worth shouting about.
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      setError(err instanceof Error ? err.message : 'Could not connect.')
    }
  }, [client])

  const disconnect = useCallback(() => {
    client.disconnect()
  }, [client])

  const upload = useCallback(
    async (payload: Uint8Array, header: Omit<UploadHeader, 'crc32'>) => {
      setError(null)
      setUploading(true)
      try {
        await client.upload(payload, header)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The upload failed.')
        return false
      } finally {
        setUploading(false)
        setProgress(null)
      }
    },
    [client],
  )

  const cancelUpload = useCallback(() => {
    void client.abortUpload().catch(() => {})
  }, [client])

  const run = useCallback(
    (action: () => Promise<void>) => {
      action().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'The stick did not respond.')
      })
    },
    [],
  )

  const play = useCallback(() => run(() => client.play()), [client, run])
  const stop = useCallback(() => run(() => client.stop()), [client, run])
  const identify = useCallback(() => run(() => client.identify()), [client, run])

  const setMasterBrightness = useCallback(
    (value: number) => {
      setBrightnessValue(value)
      if (client.connected) run(() => client.setBrightness(value))
    },
    [client, run],
  )

  return {
    supported,
    connection,
    deviceName,
    status,
    progress,
    lastUpload,
    error,
    uploading,
    masterBrightness,
    maxAnimationBytes: status?.maxAnimationBytes ?? null,
    connect,
    disconnect,
    upload,
    cancelUpload,
    play,
    stop,
    identify,
    setMasterBrightness,
    clearError: () => setError(null),
  }
}
