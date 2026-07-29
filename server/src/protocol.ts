// Relay message contract. Mirrors PROTOCOL.md §3, web/src/transport/protocol.ts
// and firmware/src/protocol.h. A change here is a change in all of them.
//
// The relay validates only what it has to route on. Field-level validation of a
// `begin` is the device's job — it is the only party that knows its own heap.

export const PROTO_VERSION = 2

export const DeviceState = {
  IDLE: 0,
  RECEIVING: 1,
  READY: 2,
  PLAYING: 3,
  ERROR: 4,
} as const

/** Commands a client may aim at a device. Forwarded verbatim. */
export const CLIENT_COMMANDS = [
  'begin',
  'play',
  'stop',
  'clear',
  'identify',
  'brightness',
] as const

export type ClientCommand = (typeof CLIENT_COMMANDS)[number]

export type DeviceHello = {
  t: 'hello'
  proto: number
  deviceId: string
  name: string
  ledCount: number
  maxAnimationBytes: number
  fw: string
}

export type DeviceStatus = {
  t: 'status'
  state: number
  error: number
  bytesReceived: number
  bytesExpected: number
  maxAnimationBytes: number
}

/** A `hello` payload plus presence and the last status the device reported. */
export type DeviceEntry = {
  deviceId: string
  name: string
  ledCount: number
  maxAnimationBytes: number
  fw: string
  proto: number
  online: boolean
  state: number
  error: number
  bytesReceived: number
  bytesExpected: number
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

export type Message = { t: string } & Record<string, unknown>

export function parseMessage(raw: string): Message | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) && typeof parsed.t === 'string' ? (parsed as Message) : null
  } catch {
    return null
  }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, 64) : fallback

/**
 * A `hello` is the device's identity claim. `deviceId` has to be usable as a
 * routing key and is echoed to browsers, so it is restricted rather than trusted.
 */
export function parseHello(msg: Record<string, unknown>): DeviceHello | null {
  const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return null
  return {
    t: 'hello',
    proto: num(msg.proto, 0),
    deviceId,
    name: str(msg.name, deviceId),
    ledCount: num(msg.ledCount, 0),
    maxAnimationBytes: num(msg.maxAnimationBytes, 0),
    fw: str(msg.fw, 'unknown'),
  }
}

export function parseStatus(msg: Record<string, unknown>): DeviceStatus {
  return {
    t: 'status',
    state: num(msg.state, DeviceState.IDLE),
    error: num(msg.error, 0),
    bytesReceived: num(msg.bytesReceived, 0),
    bytesExpected: num(msg.bytesExpected, 0),
    maxAnimationBytes: num(msg.maxAnimationBytes, 0),
  }
}
