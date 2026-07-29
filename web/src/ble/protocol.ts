// Light Painting Stick — shared wire protocol.
//
// MUST stay byte-for-byte in sync with firmware/src/protocol.h
// Authoritative description: PROTOCOL.md (extracted from REQUIREMENTS.md §2).
//
// All multi-byte fields on the wire are little-endian.

export const DEVICE_NAME = 'LightStick'

export const SERVICE_UUID = '9a1e0000-1b2c-4d3e-8f90-a1b2c3d4e5f6'
export const CONTROL_UUID = '9a1e0001-1b2c-4d3e-8f90-a1b2c3d4e5f6'
export const DATA_UUID = '9a1e0002-1b2c-4d3e-8f90-a1b2c3d4e5f6'
export const STATUS_UUID = '9a1e0003-1b2c-4d3e-8f90-a1b2c3d4e5f6'

export const PROTOCOL_VERSION = 1

/**
 * Web Bluetooth does not expose the negotiated MTU, so the chunk size cannot be
 * derived from it here. The firmware requests 517 and accepts anything up to
 * `MTU - 3`, and Chrome rejects writes over 512 outright, so 512 is the highest
 * value worth attempting. Start there and let the client halve on failure until
 * a write lands: throughput is one chunk per connection interval, so the chunk
 * size *is* the transfer speed. Starting low costs a linear slowdown for the
 * whole upload; starting high costs a handful of failed writes once.
 */
export const CHUNK_SIZE = 512
export const MIN_CHUNK_SIZE = 20

// --- control opcodes -------------------------------------------------------

export const Op = {
  BEGIN_UPLOAD: 0x01,
  PLAY: 0x02,
  STOP: 0x03,
  SET_BRIGHTNESS: 0x04,
  CLEAR: 0x05,
  IDENTIFY: 0x06,
  ABORT_UPLOAD: 0x07,
} as const

// --- upload header: 20 bytes ----------------------------------------------

export const HEADER_SIZE = 20
export const MAGIC = 0x3153504c // "LPS1"
export const VERSION = 1

export const Flag = {
  LOOP: 1 << 0,
  PING_PONG: 1 << 1,
  AUTOPLAY: 1 << 2,
} as const

export type UploadHeader = {
  ledCount: number
  frameCount: number
  fps: number
  startDelayMs: number
  loop: boolean
  pingPong: boolean
  autoPlay: boolean
  crc32: number
}

export function encodeHeader(h: UploadHeader): Uint8Array {
  const buf = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(buf)
  let flags = 0
  if (h.loop) flags |= Flag.LOOP
  if (h.pingPong) flags |= Flag.PING_PONG
  if (h.autoPlay) flags |= Flag.AUTOPLAY

  view.setUint32(0, MAGIC, true)
  view.setUint8(4, VERSION)
  view.setUint8(5, flags)
  view.setUint16(6, h.ledCount, true)
  view.setUint16(8, h.frameCount, true)
  view.setUint16(10, h.fps, true)
  view.setUint16(12, h.startDelayMs, true)
  view.setUint32(14, h.crc32 >>> 0, true)
  view.setUint16(18, 0, true) // reserved
  return new Uint8Array(buf)
}

/** Opcode byte followed by its payload — the shape of every Control write. */
export function controlFrame(op: number, payload?: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + (payload?.length ?? 0))
  frame[0] = op
  if (payload) frame.set(payload, 1)
  return frame
}

// --- status notification: 16 bytes ----------------------------------------

export const STATUS_SIZE = 16

export const DeviceState = {
  IDLE: 0,
  RECEIVING: 1,
  READY: 2,
  PLAYING: 3,
  ERROR: 4,
} as const

export type DeviceStateValue = (typeof DeviceState)[keyof typeof DeviceState]

export type Status = {
  state: DeviceStateValue
  errorCode: number
  protocolVersion: number
  bytesReceived: number
  bytesExpected: number
  maxAnimationBytes: number
}

export function decodeStatus(view: DataView): Status | null {
  if (view.byteLength < STATUS_SIZE) return null
  const state = view.getUint8(0)
  return {
    state: (state <= 4 ? state : 4) as DeviceStateValue,
    errorCode: view.getUint8(1),
    protocolVersion: view.getUint16(2, true),
    bytesReceived: view.getUint32(4, true),
    bytesExpected: view.getUint32(8, true),
    maxAnimationBytes: view.getUint32(12, true),
  }
}

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
  NONE: 0x00,
  OUT_OF_MEMORY: 0x01,
  BAD_HEADER: 0x02,
  CRC_MISMATCH: 0x03,
  LED_COUNT_MISMATCH: 0x04,
  TIMEOUT: 0x05,
  BAD_STATE: 0x06,
} as const

/** What happened, and what to do about it. */
export function errorMessage(code: number): string {
  switch (code) {
    case ErrorCode.NONE:
      return ''
    case ErrorCode.OUT_OF_MEMORY:
      return 'The stick does not have enough free memory for this animation. Shorten it or drop the frame rate.'
    case ErrorCode.BAD_HEADER:
      return 'The stick rejected the upload header. The firmware is a different protocol version — reflash it.'
    case ErrorCode.CRC_MISMATCH:
      return 'The transfer arrived corrupted. Upload again.'
    case ErrorCode.LED_COUNT_MISMATCH:
      return 'The stick is built for a different number of LEDs. Match the project LED count to the firmware.'
    case ErrorCode.TIMEOUT:
      return 'The transfer stalled for 5 seconds and the stick gave up. Move closer and upload again.'
    case ErrorCode.BAD_STATE:
      return 'The stick could not do that right now. Wait for it to finish and try again.'
    default:
      return `The stick reported error 0x${code.toString(16).padStart(2, '0')}.`
  }
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
