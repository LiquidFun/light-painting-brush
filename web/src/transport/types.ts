// The interface the UI talks to, so the device panel does not know or care
// whether it is driving the WiFi relay or the legacy BLE link (REQUIREMENTS §7).
//
// The shape is the relay's — a list of devices addressed by id — because that is
// the richer model. BLE presents the single paired stick as a one-entry list.

import type { DeviceEntry, UploadOptions } from './protocol'

export type LinkState = 'offline' | 'connecting' | 'online'

export type UploadProgress = {
  /** Bytes handed to the socket. */
  sent: number
  total: number
  /** Bytes the device says it has, from its status broadcasts. */
  confirmed: number
}

/** Measured end to end, from an accepted `begin` to `READY` (§6.10). */
export type UploadStats = {
  bytes: number
  wallMs: number
  kbPerSecond: number
  /** Transport-specific breakdown. BLE's per-write cost was the v1 diagnosis. */
  note?: string
}

export type Transport = {
  /** Which implementation is live. The UI says so, because the two behave differently. */
  kind: 'relay' | 'ble'
  /** Can this transport work in this browser at all? */
  supported: boolean
  /** The link to the relay, or to the stick itself over BLE. */
  link: LinkState
  devices: DeviceEntry[]
  selectedId: string | null
  selected: DeviceEntry | null
  select: (deviceId: string | null) => void
  /** The selected device's reported ceiling, or null while unknown. Trusted over any local estimate. */
  maxAnimationBytes: number | null
  uploading: boolean
  progress: UploadProgress | null
  lastUpload: UploadStats | null
  error: string | null
  clearError: () => void
  setMasterBrightness: (value: number) => void
  upload: (payload: Uint8Array, options: UploadOptions) => Promise<boolean>
  cancelUpload: () => void
  play: () => void
  stop: () => void
  clear: () => void
  identify: () => void
  /**
   * BLE pairing needs a user gesture, so that transport shows a Connect button.
   * Null on the relay, where devices simply appear.
   */
  pair: (() => void) | null
  unpair: (() => void) | null
}
