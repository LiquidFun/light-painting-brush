// Legacy BLE transport, presented through the same interface as the relay so the
// device panel does not branch on which one is live (REQUIREMENTS §7, M4).
//
// BLE pairs with exactly one stick, so the device list has at most one entry and
// pairing needs a user gesture. It goes once the WiFi path is proven on hardware.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { DeviceState } from '../transport/protocol'
import type { DeviceEntry, UploadOptions } from '../transport/protocol'
import type { LinkState, Transport, UploadProgress, UploadStats } from '../transport/types'
import { LightStickClient, isSupported } from './client'
import type { ConnectionState } from './client'
import type { Status } from './protocol'

/** BLE addresses one paired stick, so the id is a constant rather than a MAC. */
const BLE_DEVICE_ID = 'ble'

const LINK: Record<ConnectionState, LinkState> = {
  disconnected: 'offline',
  connecting: 'connecting',
  connected: 'online',
}

function entryOf(name: string | undefined, status: Status | null): DeviceEntry {
  return {
    deviceId: BLE_DEVICE_ID,
    name: name ?? 'LightStick',
    // BLE status carries no ledCount; the firmware only ever rejects a mismatch.
    ledCount: 0,
    maxAnimationBytes: status?.maxAnimationBytes ?? 0,
    fw: 'v1 (BLE)',
    proto: status?.protocolVersion ?? 0,
    online: true,
    state: status?.state ?? DeviceState.IDLE,
    error: status?.errorCode ?? 0,
    bytesReceived: status?.bytesReceived ?? 0,
    bytesExpected: status?.bytesExpected ?? 0,
  }
}

export function useDevice(): Transport {
  const supported = useMemo(isSupported, [])
  const [connection, setConnection] = useState<ConnectionState>('disconnected')
  const [deviceName, setDeviceName] = useState<string | undefined>()
  const [status, setStatus] = useState<Status | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [lastUpload, setLastUpload] = useState<UploadStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

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
        onStats: (s) =>
          setLastUpload({
            bytes: s.bytes,
            wallMs: s.wallMs,
            kbPerSecond: s.wallMs > 0 ? s.bytes / s.wallMs : 0,
            note: `${s.writes} writes of ${s.chunkSize} B · ${s.msPerWrite.toFixed(0)} ms each · ${Math.round(s.writeShare * 100)}% in writes`,
          }),
        onError: setError,
      }),
    [],
  )

  useEffect(() => () => client.disconnect(), [client])

  const pair = useCallback(() => {
    setError(null)
    client.connect().catch((err: unknown) => {
      // A cancelled chooser is a normal outcome, not an error worth shouting about.
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      setError(err instanceof Error ? err.message : 'Could not connect.')
    })
  }, [client])

  const upload = useCallback(
    async (payload: Uint8Array, options: UploadOptions) => {
      setError(null)
      setUploading(true)
      try {
        await client.upload(payload, options)
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

  const run = useCallback((action: () => Promise<void>) => {
    action().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'The stick did not respond.')
    })
  }, [])

  const connected = connection === 'connected'
  const devices = useMemo(
    () => (connected ? [entryOf(deviceName, status)] : []),
    [connected, deviceName, status],
  )

  return {
    kind: 'ble',
    supported,
    link: LINK[connection],
    devices,
    selectedId: connected ? BLE_DEVICE_ID : null,
    selected: devices[0] ?? null,
    // There is nothing to choose between: BLE pairs with one stick.
    select: () => {},
    maxAnimationBytes: status?.maxAnimationBytes || null,
    uploading,
    progress,
    lastUpload,
    error,
    clearError: () => setError(null),
    setMasterBrightness: (value: number) => {
      if (client.connected) run(() => client.setBrightness(value))
    },
    upload,
    cancelUpload: () => void client.abortUpload().catch(() => {}),
    play: () => run(() => client.play()),
    stop: () => run(() => client.stop()),
    clear: () => run(() => client.clear()),
    identify: () => run(() => client.identify()),
    pair,
    unpair: () => client.disconnect(),
  }
}
