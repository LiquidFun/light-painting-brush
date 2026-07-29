// Web Bluetooth client.
//
// Web Bluetooth requires a secure context: localhost for development, HTTPS in
// production. It exists on Chrome/Edge (Android, Linux, macOS, Windows) and
// nowhere else — no Firefox, no Safari, no iOS. The editor must never be blocked
// behind this class; see isSupported().

import {
  DeviceState,
  ErrorCode,
  crc32,
  errorMessage,
} from '../transport/protocol'
import {
  CHUNK_SIZE,
  CONTROL_UUID,
  DATA_UUID,
  DEVICE_NAME,
  MIN_CHUNK_SIZE,
  Op,
  SERVICE_UUID,
  STATUS_UUID,
  controlFrame,
  decodeStatus,
  encodeHeader,
} from './protocol'
import type { Status, UploadHeader } from './protocol'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export type UploadProgress = {
  sent: number
  total: number
  /** Bytes the device has confirmed, from its Status notifications. */
  confirmed: number
}

/** Measured throughput of the last transfer, shown in the device panel. */
export type UploadStats = {
  bytes: number
  wallMs: number
  writes: number
  chunkSize: number
  /** Mean duration of one writeValueWithResponse round trip. */
  msPerWrite: number
  /** Share of wall time spent inside writes, 0-1. Low means we are the holdup. */
  writeShare: number
}

export type ClientHandlers = {
  onConnectionChange?: (state: ConnectionState, deviceName?: string) => void
  onStatus?: (status: Status) => void
  onProgress?: (progress: UploadProgress | null) => void
  onStats?: (stats: UploadStats) => void
  onError?: (message: string) => void
}

export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

export class DeviceError extends Error {
  code: number
  constructor(code: number) {
    super(errorMessage(code))
    this.code = code
    this.name = 'DeviceError'
  }
}

type Waiter = {
  test: (s: Status) => boolean
  resolve: (s: Status) => void
  reject: (e: Error) => void
  timer: number
}

export class LightStickClient {
  private handlers: ClientHandlers
  private device: BluetoothDevice | null = null
  private control: BluetoothRemoteGATTCharacteristic | null = null
  private data: BluetoothRemoteGATTCharacteristic | null = null
  private statusChar: BluetoothRemoteGATTCharacteristic | null = null
  private waiters = new Set<Waiter>()
  private chunkSize = CHUNK_SIZE
  private uploadToken = 0
  private lastStatus: Status | null = null

  constructor(handlers: ClientHandlers = {}) {
    this.handlers = handlers
  }

  get connected(): boolean {
    return !!this.device?.gatt?.connected
  }

  get deviceName(): string | undefined {
    return this.device?.name ?? undefined
  }

  get status(): Status | null {
    return this.lastStatus
  }

  async connect(): Promise<void> {
    if (!isSupported()) throw new Error('This browser cannot talk to Bluetooth devices.')

    this.handlers.onConnectionChange?.('connecting')
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME }],
        optionalServices: [SERVICE_UUID],
      })
      this.device = device
      device.addEventListener('gattserverdisconnected', this.onDisconnected)

      const server = await device.gatt!.connect()
      const service = await server.getPrimaryService(SERVICE_UUID)
      this.control = await service.getCharacteristic(CONTROL_UUID)
      this.data = await service.getCharacteristic(DATA_UUID)
      this.statusChar = await service.getCharacteristic(STATUS_UUID)

      this.statusChar.addEventListener('characteristicvaluechanged', this.onStatusChanged)
      await this.statusChar.startNotifications()

      // Read Status immediately on connect: maxAnimationBytes bounds the
      // duration slider before the user can design something that won't fit.
      const first = await this.statusChar.readValue()
      this.handleStatus(first)

      this.chunkSize = CHUNK_SIZE
      this.handlers.onConnectionChange?.('connected', device.name ?? DEVICE_NAME)
    } catch (err) {
      this.cleanup()
      this.handlers.onConnectionChange?.('disconnected')
      throw err
    }
  }

  disconnect(): void {
    const device = this.device
    this.cleanup()
    try {
      device?.gatt?.disconnect()
    } catch {
      /* already gone */
    }
    this.handlers.onConnectionChange?.('disconnected')
  }

  // --- commands ------------------------------------------------------------

  play() {
    return this.writeControl(Op.PLAY)
  }

  stop() {
    return this.writeControl(Op.STOP)
  }

  clear() {
    return this.writeControl(Op.CLEAR)
  }

  identify() {
    return this.writeControl(Op.IDENTIFY)
  }

  setBrightness(value: number) {
    const b = Math.max(0, Math.min(255, Math.round(value)))
    return this.writeControl(Op.SET_BRIGHTNESS, new Uint8Array([b]))
  }

  abortUpload() {
    this.uploadToken++
    this.handlers.onProgress?.(null)
    return this.writeControl(Op.ABORT_UPLOAD)
  }

  /**
   * Full transfer: header, chunks, CRC verification. Resolves when the device
   * reports READY. Rejects with DeviceError on a device-reported failure, or a
   * plain Error if the link drops — either way the caller can simply retry from
   * the beginning.
   */
  async upload(payload: Uint8Array, header: Omit<UploadHeader, 'crc32'>): Promise<void> {
    if (!this.control || !this.data) throw new Error('Not connected.')
    const token = ++this.uploadToken
    const total = payload.length

    const begin = this.waitForStatus(
      (s) => s.state === DeviceState.RECEIVING || s.state === DeviceState.ERROR,
      8000,
    )
    await this.writeControl(
      Op.BEGIN_UPLOAD,
      encodeHeader({ ...header, crc32: crc32(payload) }),
    )
    const started = await begin
    if (started.state === DeviceState.ERROR) throw new DeviceError(started.errorCode)

    this.handlers.onProgress?.({ sent: 0, total, confirmed: 0 })

    const done = this.waitForStatus(
      (s) => s.state === DeviceState.READY || s.state === DeviceState.ERROR,
      15000,
      // Every progress notification proves the transfer is alive.
      (s) => s.state === DeviceState.RECEIVING,
    )

    let offset = 0
    let writeMs = 0
    let writes = 0
    let lastProgress = 0
    const startedAt = performance.now()
    while (offset < total) {
      if (token !== this.uploadToken) throw new Error('Upload cancelled.')
      if (!this.connected) throw new Error('The stick disconnected during the upload.')

      const end = Math.min(offset + this.chunkSize, total)
      try {
        const t0 = performance.now()
        await this.data.writeValueWithResponse(payload.subarray(offset, end) as BufferSource)
        writeMs += performance.now() - t0
        writes++
      } catch (err) {
        // A too-long write is the likely cause: the negotiated MTU landed lower
        // than requested. Halve and retry the same offset.
        if (this.chunkSize > MIN_CHUNK_SIZE && this.connected) {
          this.chunkSize = Math.max(MIN_CHUNK_SIZE, this.chunkSize >> 1)
          continue
        }
        throw err
      }
      offset = end
      // Reporting every chunk re-renders the whole app inside the transfer loop.
      // 10 Hz is smooth enough for a progress bar and keeps React off the path.
      const now = performance.now()
      if (now - lastProgress > 100 || offset === total) {
        lastProgress = now
        this.handlers.onProgress?.({
          sent: offset,
          total,
          confirmed: this.lastStatus?.bytesReceived ?? 0,
        })
      }
    }
    const wallMs = performance.now() - startedAt
    this.handlers.onStats?.({
      bytes: total,
      wallMs,
      writes,
      chunkSize: this.chunkSize,
      msPerWrite: writes ? writeMs / writes : 0,
      writeShare: wallMs > 0 ? writeMs / wallMs : 0,
    })

    const final = await done
    this.handlers.onProgress?.(null)
    if (final.state === DeviceState.ERROR) throw new DeviceError(final.errorCode)
  }

  // --- internals -----------------------------------------------------------

  private async writeControl(op: number, payload?: Uint8Array): Promise<void> {
    if (!this.control) throw new Error('Not connected.')
    await this.control.writeValueWithResponse(controlFrame(op, payload) as BufferSource)
  }

  /**
   * Resolves on the next Status matching `test`. `keepAlive` matches
   * notifications that prove progress and restart the timeout, so a long upload
   * is not killed by a fixed deadline.
   */
  private waitForStatus(
    test: (s: Status) => boolean,
    timeoutMs: number,
    keepAlive?: (s: Status) => boolean,
  ): Promise<Status> {
    return new Promise<Status>((resolve, reject) => {
      const waiter: Waiter = {
        test,
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
      const originalTest = waiter.test
      waiter.test = (s) => {
        if (keepAlive?.(s)) {
          window.clearTimeout(waiter.timer)
          arm()
        }
        return originalTest(s)
      }
      arm()
      this.waiters.add(waiter)
    })
  }

  private onStatusChanged = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic
    if (target.value) this.handleStatus(target.value)
  }

  private handleStatus(view: DataView) {
    const status = decodeStatus(view)
    if (!status) return
    this.lastStatus = status
    this.handlers.onStatus?.(status)
    if (status.errorCode !== ErrorCode.NONE && status.state === DeviceState.ERROR) {
      this.handlers.onError?.(errorMessage(status.errorCode))
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.test(status)) waiter.resolve(status)
    }
  }

  private onDisconnected = () => {
    // Mid-upload drops land here: fail every waiter so upload() rejects and the
    // UI can offer a retry from the beginning.
    this.uploadToken++
    const dropped = new Error('The stick disconnected.')
    for (const waiter of [...this.waiters]) waiter.reject(dropped)
    this.cleanup()
    this.handlers.onProgress?.(null)
    this.handlers.onConnectionChange?.('disconnected')
  }

  private cleanup() {
    this.device?.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.statusChar?.removeEventListener('characteristicvaluechanged', this.onStatusChanged)
    for (const waiter of [...this.waiters]) {
      window.clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
    }
    this.device = null
    this.control = null
    this.data = null
    this.statusChar = null
    this.lastStatus = null
  }
}
