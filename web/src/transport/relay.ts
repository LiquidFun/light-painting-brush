// WebSocket client for the relay (PROTOCOL.md §2–§6).
//
// Works in every modern browser, including Safari and iOS — the relay exists
// precisely so that no Web Bluetooth is involved. Authentication is the browser's
// own Basic auth session, so there is nothing to do here.

import {
  CHUNK_SIZE,
  DeviceState,
  ErrorCode,
  PROTO_VERSION,
  SOCKET_HIGH_WATER,
  crc32,
  errorMessage,
  parseServerMessage,
} from './protocol'
import type { DeviceEntry, DeviceStatusFields, UploadOptions } from './protocol'
import type { LinkState, UploadProgress, UploadStats } from './types'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000
/** How long a `begin` may go unanswered before we give up on the device. */
const BEGIN_TIMEOUT_MS = 8000
/** Reset by every progress status, so a long upload is not killed by a deadline. */
const TRANSFER_IDLE_TIMEOUT_MS = 15_000

export type RelayHandlers = {
  onLink?: (link: LinkState) => void
  onDevices?: (devices: DeviceEntry[]) => void
  onProgress?: (progress: UploadProgress | null) => void
  onStats?: (stats: UploadStats) => void
  onError?: (message: string) => void
}

export class DeviceError extends Error {
  code: number
  constructor(code: number) {
    super(errorMessage(code))
    this.code = code
    this.name = 'DeviceError'
  }
}

type Status = { deviceId: string } & DeviceStatusFields

type Waiter = {
  test: (s: Status) => boolean
  resolve: (s: Status) => void
  reject: (e: Error) => void
  timer: number
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

/**
 * Same origin as the page, since the SPA is served by the relay. `VITE_RELAY_URL`
 * overrides it for editor development against a relay on another host.
 */
function relayUrl(): string {
  const override = import.meta.env.VITE_RELAY_URL
  if (typeof override === 'string' && override.length > 0) return override
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/ws/client`
}

export class RelayClient {
  private handlers: RelayHandlers
  private socket: WebSocket | null = null
  private closed = false
  private backoff = RECONNECT_MIN_MS
  private retry = 0
  private waiters = new Set<Waiter>()
  private uploadToken = 0
  private devices: DeviceEntry[] = []

  constructor(handlers: RelayHandlers = {}) {
    this.handlers = handlers
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.closed = false
    if (this.socket) return
    this.open()
  }

  close(): void {
    this.closed = true
    window.clearTimeout(this.retry)
    this.failWaiters(new Error('The connection was closed.'))
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.handlers.onLink?.('offline')
  }

  // --- commands ------------------------------------------------------------

  play(deviceId: string): void {
    this.send({ t: 'play', deviceId })
  }

  stop(deviceId: string): void {
    this.send({ t: 'stop', deviceId })
  }

  clear(deviceId: string): void {
    this.send({ t: 'clear', deviceId })
  }

  identify(deviceId: string): void {
    this.send({ t: 'identify', deviceId })
  }

  /** Makes a stored animation the one that plays. The device verifies its CRC first. */
  selectSlot(deviceId: string, slot: number): void {
    this.send({ t: 'select', deviceId, slot })
  }

  deleteSlot(deviceId: string, slot: number): void {
    this.send({ t: 'deleteSlot', deviceId, slot })
  }

  setBrightness(deviceId: string, value: number): void {
    this.send({
      t: 'brightness',
      deviceId,
      value: Math.max(0, Math.min(255, Math.round(value))),
    })
  }

  /** Abandons the transfer in progress. The device times out on its own after 10 s. */
  cancelUpload(): void {
    this.uploadToken++
    this.handlers.onProgress?.(null)
  }

  /**
   * Full transfer: `begin`, binary chunks, then wait for the device to verify.
   * Resolves when it reports READY. Rejects with DeviceError on a device-reported
   * failure and a plain Error if the link drops — either way the caller retries
   * from the beginning, which is why there is no resume logic.
   */
  async upload(
    deviceId: string,
    payload: Uint8Array,
    options: UploadOptions,
  ): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to the relay.')
    }
    const token = ++this.uploadToken
    const total = payload.length

    const accepted = this.waitFor(
      deviceId,
      (s) => s.state === DeviceState.RECEIVING || s.state === DeviceState.ERROR,
      BEGIN_TIMEOUT_MS,
    )
    socket.send(
      JSON.stringify({
        t: 'begin',
        proto: PROTO_VERSION,
        deviceId,
        ...options,
        bytes: total,
        crc32: crc32(payload),
      }),
    )
    const started = await accepted
    if (started.state === DeviceState.ERROR) throw new DeviceError(started.error)

    const verified = this.waitFor(
      deviceId,
      (s) => s.state === DeviceState.READY || s.state === DeviceState.ERROR,
      TRANSFER_IDLE_TIMEOUT_MS,
      // Every progress status proves the transfer is alive and rearms the deadline.
      (s) => s.state === DeviceState.RECEIVING,
    )

    this.handlers.onProgress?.({ sent: 0, total, confirmed: 0 })
    const startedAt = performance.now()
    let sent = 0
    let lastReport = 0

    while (sent < total) {
      if (token !== this.uploadToken) throw new Error('Upload cancelled.')
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('The connection dropped during the upload.')
      }
      // The only flow control the browser gives us. Without it the whole payload
      // sits in the tab's memory and the progress bar reports fiction.
      if (socket.bufferedAmount > SOCKET_HIGH_WATER) {
        await sleep(4)
        continue
      }

      const end = Math.min(sent + CHUNK_SIZE, total)
      socket.send(payload.subarray(sent, end))
      sent = end

      // Reporting every chunk re-renders the app inside the transfer loop.
      const now = performance.now()
      if (now - lastReport > 100 || sent === total) {
        lastReport = now
        this.handlers.onProgress?.({
          sent,
          total,
          confirmed: this.deviceById(deviceId)?.bytesReceived ?? 0,
        })
      }
    }

    const final = await verified
    // Measured to READY rather than to the last send: the honest end-to-end rate
    // includes the device writing and CRC-checking the buffer.
    const wallMs = performance.now() - startedAt
    this.handlers.onStats?.({
      bytes: total,
      wallMs,
      kbPerSecond: wallMs > 0 ? total / wallMs : 0,
    })
    this.handlers.onProgress?.(null)
    if (final.state === DeviceState.ERROR) throw new DeviceError(final.error)
  }

  // --- internals -----------------------------------------------------------

  private open(): void {
    this.handlers.onLink?.('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(relayUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.onopen = () => {
      this.backoff = RECONNECT_MIN_MS
      this.handlers.onLink?.('online')
      socket.send(JSON.stringify({ t: 'subscribe' }))
    }

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') return
      this.handle(event.data)
    }

    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.devices = []
      this.handlers.onDevices?.([])
      this.failWaiters(new Error('The connection to the relay dropped.'))
      this.handlers.onProgress?.(null)
      this.scheduleReconnect()
    }

    // onclose always follows onerror, so reconnection is handled in one place.
    socket.onerror = () => {}
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    this.handlers.onLink?.('offline')
    window.clearTimeout(this.retry)
    const wait = this.backoff
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2)
    this.retry = window.setTimeout(() => this.open(), wait)
  }

  private handle(text: string): void {
    const msg = parseServerMessage(text)
    if (!msg) return

    if (msg.t === 'devices') {
      this.devices = msg.devices
      this.handlers.onDevices?.(msg.devices)
      return
    }

    if (msg.t === 'error') {
      this.handlers.onError?.(msg.message)
      return
    }

    if (msg.t === 'slots') {
      this.devices = this.devices.map((d) =>
        d.deviceId === msg.deviceId ? { ...d, slots: msg.slots, selected: msg.selected } : d,
      )
      this.handlers.onDevices?.(this.devices)
      return
    }

    // A status is authoritative for that device, so fold it into the cached list
    // rather than waiting for the next `devices` broadcast.
    const { deviceId, ...fields } = msg
    this.devices = this.devices.map((d) =>
      d.deviceId === deviceId
        ? { ...d, ...fields, maxAnimationBytes: fields.maxAnimationBytes || d.maxAnimationBytes }
        : d,
    )
    this.handlers.onDevices?.(this.devices)

    if (msg.state === DeviceState.ERROR && msg.error !== ErrorCode.NONE) {
      this.handlers.onError?.(errorMessage(msg.error))
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.test(msg)) waiter.resolve(msg)
    }
  }

  private deviceById(deviceId: string): DeviceEntry | undefined {
    return this.devices.find((d) => d.deviceId === deviceId)
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.handlers.onError?.('Not connected to the relay.')
      return
    }
    this.socket.send(JSON.stringify(message))
  }

  /** Resolves on the next status for `deviceId` matching `test`. */
  private waitFor(
    deviceId: string,
    test: (s: Status) => boolean,
    timeoutMs: number,
    keepAlive?: (s: Status) => boolean,
  ): Promise<Status> {
    return new Promise<Status>((resolve, reject) => {
      const waiter: Waiter = {
        test: () => false,
        resolve: (s) => {
          window.clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve(s)
        },
        reject: (e) => {
          window.clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          reject(e)
        },
        timer: 0,
      }
      const arm = () => {
        waiter.timer = window.setTimeout(
          () => waiter.reject(new Error('The stick stopped responding.')),
          timeoutMs,
        )
      }
      waiter.test = (s) => {
        if (s.deviceId !== deviceId) return false
        if (keepAlive?.(s)) {
          window.clearTimeout(waiter.timer)
          arm()
        }
        return test(s)
      }
      arm()
      this.waiters.add(waiter)
    })
  }

  private failWaiters(error: Error): void {
    this.uploadToken++
    for (const waiter of [...this.waiters]) waiter.reject(error)
  }
}
