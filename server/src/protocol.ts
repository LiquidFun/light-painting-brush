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
  // The stick holds several animations, so choosing one and dropping one are
  // commands in their own right (§3.4).
  'select',
  'deleteSlot',
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

export type Rgb = [number, number, number]

/** One animation stored in the stick's flash. */
export type DeviceSlot = {
  /** Slot index. Sent explicitly because unused slots are omitted. */
  i: number
  name: string
  frames: number
  fps: number
  bytes: number
  /** Of the payload. With `bytes`, this is what identifies an animation exactly. */
  crc32: number
  startDelayMs: number
  loop: boolean
  pingPong: boolean
  /**
   * Representative colours sampled evenly across the payload, computed on the
   * device while the upload streamed past. One per picker LED.
   */
  colours: Rgb[]
}

export type DeviceSlots = {
  t: 'slots'
  /** Index of the animation that will play, or -1 when nothing is stored. */
  selected: number
  slots: DeviceSlot[]
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
  /** Empty until the device has announced its set; it does so right after `hello`. */
  slots: DeviceSlot[]
  selected: number
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

const MAX_SLOTS = 32
/** Enough for a wider picker without letting a device dictate an array length. */
const MAX_COLOURS = 8

const byte = (v: unknown): number => {
  const n = num(v, 0)
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n)
}

const rgb = (v: unknown): Rgb => {
  const a = Array.isArray(v) ? v : []
  return [byte(a[0]), byte(a[1]), byte(a[2])]
}

/**
 * The device's own view of its flash. Clamped rather than trusted: it is echoed
 * to every browser, and a name is rendered as text there.
 */
export function parseSlots(msg: Record<string, unknown>): DeviceSlots {
  const raw = Array.isArray(msg.slots) ? msg.slots.slice(0, MAX_SLOTS) : []
  const slots: DeviceSlot[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const i = num(item.i, -1)
    if (!Number.isInteger(i) || i < 0 || i >= MAX_SLOTS) continue
    const colours = Array.isArray(item.colours) ? item.colours.slice(0, MAX_COLOURS) : []
    slots.push({
      i,
      name: str(item.name, `Slot ${i + 1}`),
      frames: num(item.frames, 0),
      fps: num(item.fps, 0),
      bytes: num(item.bytes, 0),
      crc32: num(item.crc32, 0),
      startDelayMs: num(item.startDelayMs, 0),
      loop: item.loop === true,
      pingPong: item.pingPong === true,
      colours: colours.map(rgb),
    })
  }
  const selected = num(msg.selected, -1)
  return {
    t: 'slots',
    selected: slots.some((s) => s.i === selected) ? selected : -1,
    slots,
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
