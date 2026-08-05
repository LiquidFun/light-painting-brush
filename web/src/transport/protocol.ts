// Relay message contract. Mirrors PROTOCOL.md, server/src/protocol.ts and
// firmware/src/protocol.h. A change here is a change in all of them.
//
// The device state and error tables, and crc32, are shared with the legacy BLE
// transport in web/src/ble/ — the numbers mean the same thing on both wires, and
// two copies would eventually disagree.
//
// Nothing here touches the DOM, so server/smoke.ts can import it directly and
// check the relay's real output against the browser's own parser.

export const PROTO_VERSION = 2

/**
 * 4 KB, per §3.6: small enough that the ESP32 never has to hold a large frame in
 * addition to the animation buffer. Unlike BLE, the chunk size is not the transfer
 * speed here — TCP coalesces — so there is nothing to tune.
 */
export const CHUNK_SIZE = 4096

/**
 * Stop feeding the socket above this much unsent data. The browser will happily
 * buffer a whole 200 KB payload in memory otherwise, which makes the progress bar
 * a lie and defeats the relay's back-pressure.
 */
export const SOCKET_HIGH_WATER = 64 * 1024

/** Matches DEFAULT_BRIGHTNESS in firmware/src/protocol.h, so the slider starts truthful. */
export const DEFAULT_MASTER_BRIGHTNESS = 80

// --- device state ----------------------------------------------------------

export const DeviceState = {
  IDLE: 0,
  RECEIVING: 1,
  READY: 2,
  PLAYING: 3,
  ERROR: 4,
} as const

export type DeviceStateValue = (typeof DeviceState)[keyof typeof DeviceState]

export function stateLabel(state: number): string {
  switch (state) {
    case DeviceState.IDLE:
      return 'Idle'
    case DeviceState.RECEIVING:
      return 'Receiving'
    case DeviceState.READY:
      return 'Ready'
    case DeviceState.PLAYING:
      return 'Playing'
    case DeviceState.ERROR:
      return 'Error'
    default:
      return 'Unknown'
  }
}

// --- error codes -----------------------------------------------------------

export const ErrorCode = {
  NONE: 0,
  OUT_OF_MEMORY: 1,
  BAD_VERSION: 2,
  CRC_MISMATCH: 3,
  LED_COUNT_MISMATCH: 4,
  TIMEOUT: 5,
  BAD_STATE: 6,
} as const

/** What happened, and what to do about it (§6.13). */
export function errorMessage(code: number): string {
  switch (code) {
    case ErrorCode.NONE:
      return ''
    case ErrorCode.OUT_OF_MEMORY:
      return 'The stick does not have enough free memory for this animation. Shorten it or drop the frame rate.'
    case ErrorCode.BAD_VERSION:
      return 'The stick is running a different protocol version. Reflash it from this checkout.'
    case ErrorCode.CRC_MISMATCH:
      return 'The transfer arrived corrupted. Upload again.'
    case ErrorCode.LED_COUNT_MISMATCH:
      return 'The stick is built for a different number of LEDs. Match the project LED count to the firmware.'
    case ErrorCode.TIMEOUT:
      return 'The transfer stalled and the stick gave up. Check its WiFi and upload again.'
    case ErrorCode.BAD_STATE:
      return 'The stick could not do that right now. Wait for it to finish and try again.'
    default:
      return `The stick reported error ${code}.`
  }
}

// --- messages --------------------------------------------------------------

export type Rgb = [number, number, number]

/** One animation stored in the stick's flash (§3.5). */
export type DeviceSlot = {
  /** Slot index. Sent explicitly because unused slots are omitted. */
  i: number
  name: string
  frames: number
  fps: number
  bytes: number
  /**
   * Representative colours sampled evenly across the payload, computed on the
   * device while the upload streamed past. One per picker LED, so the swatch in
   * the browser and the marker on the strip show the same thing.
   */
  colours: Rgb[]
}

/** Everything the device tells us about itself, as the relay presents it. */
export type DeviceEntry = {
  deviceId: string
  name: string
  ledCount: number
  maxAnimationBytes: number
  fw: string
  proto: number
  online: boolean
  state: DeviceStateValue
  error: number
  bytesReceived: number
  bytesExpected: number
  /** Empty until the device has announced its set; it does so right after `hello`. */
  slots: DeviceSlot[]
  /** Index of the animation that will play, or -1 when nothing is stored. */
  selected: number
}

export type ServerMessage =
  | { t: 'devices'; devices: DeviceEntry[] }
  | ({ t: 'status'; deviceId: string } & DeviceStatusFields)
  | { t: 'slots'; deviceId: string; selected: number; slots: DeviceSlot[] }
  | { t: 'error'; message: string }

export type DeviceStatusFields = {
  state: DeviceStateValue
  error: number
  bytesReceived: number
  bytesExpected: number
  maxAnimationBytes: number
}

/** The animation metadata a `begin` carries. Shared with the BLE header (§4). */
export type UploadOptions = {
  /**
   * What to call this animation in the stick's flash. Trimmed to 15 characters
   * there, and the only label the on-stick picker has to work with.
   */
  name: string
  ledCount: number
  frameCount: number
  fps: number
  startDelayMs: number
  loop: boolean
  pingPong: boolean
  autoPlay: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const clampState = (v: unknown): DeviceStateValue => {
  const n = num(v, 0)
  return (n >= 0 && n <= 4 ? n : 4) as DeviceStateValue
}

const byte = (v: unknown): number => {
  const n = num(v, 0)
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n)
}

const rgb = (v: unknown): Rgb => {
  const a = Array.isArray(v) ? v : []
  return [byte(a[0]), byte(a[1]), byte(a[2])]
}

function parseSlots(raw: unknown): DeviceSlot[] {
  if (!Array.isArray(raw)) return []
  const out: DeviceSlot[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const i = num(item.i, -1)
    if (!Number.isInteger(i) || i < 0) continue
    out.push({
      i,
      name: typeof item.name === 'string' && item.name ? item.name : `Slot ${i + 1}`,
      frames: num(item.frames, 0),
      fps: num(item.fps, 0),
      bytes: num(item.bytes, 0),
      colours: (Array.isArray(item.colours) ? item.colours : []).map(rgb),
    })
  }
  return out
}

function parseEntry(raw: unknown): DeviceEntry | null {
  if (!isObject(raw) || typeof raw.deviceId !== 'string') return null
  return {
    deviceId: raw.deviceId,
    name: typeof raw.name === 'string' ? raw.name : raw.deviceId,
    ledCount: num(raw.ledCount, 0),
    maxAnimationBytes: num(raw.maxAnimationBytes, 0),
    fw: typeof raw.fw === 'string' ? raw.fw : 'unknown',
    proto: num(raw.proto, 0),
    online: raw.online === true,
    state: clampState(raw.state),
    error: num(raw.error, 0),
    bytesReceived: num(raw.bytesReceived, 0),
    bytesExpected: num(raw.bytesExpected, 0),
    slots: parseSlots(raw.slots),
    selected: num(raw.selected, -1),
  }
}

/** Anything unrecognised is dropped, so the server can be ahead of the client. */
export function parseServerMessage(text: string): ServerMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  if (parsed.t === 'devices' && Array.isArray(parsed.devices)) {
    return {
      t: 'devices',
      devices: parsed.devices
        .map(parseEntry)
        .filter((d): d is DeviceEntry => d !== null),
    }
  }
  if (parsed.t === 'status' && typeof parsed.deviceId === 'string') {
    return {
      t: 'status',
      deviceId: parsed.deviceId,
      state: clampState(parsed.state),
      error: num(parsed.error, 0),
      bytesReceived: num(parsed.bytesReceived, 0),
      bytesExpected: num(parsed.bytesExpected, 0),
      maxAnimationBytes: num(parsed.maxAnimationBytes, 0),
    }
  }
  if (parsed.t === 'slots' && typeof parsed.deviceId === 'string') {
    return {
      t: 'slots',
      deviceId: parsed.deviceId,
      selected: num(parsed.selected, -1),
      slots: parseSlots(parsed.slots),
    }
  }
  if (parsed.t === 'error' && typeof parsed.message === 'string') {
    return { t: 'error', message: parsed.message }
  }
  return null
}

// --- CRC-32 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** CRC-32/ISO-HDLC, matching crc32() in firmware/src/animation.cpp. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
