// The relay (REQUIREMENTS §3, §5.2).
//
// Devices dial in and announce themselves; browsers subscribe and address devices
// by id. There is no lock and no ownership (§3.7) — any subscribed client may
// upload to or play any online device, and every status is broadcast to everyone
// so a second person's upload is visible rather than silent.
//
// Binary payloads are *streamed*: exactly one chunk is ever in flight per client,
// because a 200 KB animation times several clients is real memory and the server
// is meant to be boring.

import type { RawData, WebSocket } from 'ws'

import {
  CLIENT_COMMANDS,
  DeviceState,
  parseHello,
  parseMessage,
  parseStatus,
} from './protocol.ts'
import type { ClientCommand, DeviceEntry, DeviceHello, DeviceStatus } from './protocol.ts'

type DeviceRecord = {
  hello: DeviceHello
  status: DeviceStatus | null
  socket: WebSocket | null
}

type ClientRecord = {
  socket: WebSocket
  subscribed: boolean
  /** The device this client's binary frames belong to, from its last `begin`. */
  target: string | null
  remaining: number
}

const isCommand = (t: string): t is ClientCommand =>
  (CLIENT_COMMANDS as readonly string[]).includes(t)

/** A device that has gone offline still shows in the list, so the user can see it is gone. */
function entryOf(record: DeviceRecord): DeviceEntry {
  const { hello, status } = record
  return {
    deviceId: hello.deviceId,
    name: hello.name,
    ledCount: hello.ledCount,
    maxAnimationBytes: status?.maxAnimationBytes ?? hello.maxAnimationBytes,
    fw: hello.fw,
    proto: hello.proto,
    online: record.socket !== null,
    state: record.socket ? (status?.state ?? DeviceState.IDLE) : DeviceState.IDLE,
    error: status?.error ?? 0,
    bytesReceived: status?.bytesReceived ?? 0,
    bytesExpected: status?.bytesExpected ?? 0,
  }
}

export class Relay {
  private devices = new Map<string, DeviceRecord>()
  private clients = new Set<ClientRecord>()

  // --- devices --------------------------------------------------------------

  addDevice(socket: WebSocket): void {
    let id: string | null = null

    socket.on('message', (data: RawData, isBinary: boolean) => {
      // A device only ever speaks JSON. Binary from a device is meaningless.
      if (isBinary) return
      const msg = parseMessage(data.toString())
      if (!msg) return

      if (msg.t === 'hello') {
        const hello = parseHello(msg)
        if (!hello) {
          this.fail(socket, 'A device sent a hello with an unusable deviceId.')
          return
        }
        id = hello.deviceId
        // A reconnect replaces the old socket rather than making a second entry:
        // the id is stable across reboots precisely so this works.
        //
        // The old status goes with it. Carrying it over meant a stick that
        // dropped mid-upload came back still advertised as RECEIVING, which
        // disables Play in every browser and reads as a stick stuck uploading
        // forever — until the relay was restarted, which is exactly the symptom
        // that made this look like a server bug.
        const existing = this.devices.get(id)
        if (existing?.socket && existing.socket !== socket) existing.socket.close()
        this.devices.set(id, { hello, status: null, socket })
        console.log(`[device] ${id} online (${hello.name}, fw ${hello.fw})`)
        this.broadcastDevices()
        return
      }

      if (msg.t === 'status' && id) {
        const record = this.devices.get(id)
        if (!record) return
        record.status = parseStatus(msg)
        this.broadcast({ ...record.status, t: 'status', deviceId: id })
        return
      }
    })

    socket.on('close', () => {
      if (!id) return
      const record = this.devices.get(id)
      if (!record || record.socket !== socket) return
      record.socket = null
      console.log(`[device] ${id} offline`)
      // Clients mid-upload to this device must stop pushing at it.
      for (const client of this.clients) {
        if (client.target === id) {
          client.target = null
          client.remaining = 0
          this.send(client.socket, {
            t: 'error',
            message: 'The stick dropped off the network mid-upload. Upload again.',
          })
        }
      }
      this.broadcastDevices()
    })

    socket.on('error', (err) => console.warn(`[device] socket error: ${err.message}`))
  }

  // --- clients --------------------------------------------------------------

  addClient(socket: WebSocket): void {
    const client: ClientRecord = { socket, subscribed: false, target: null, remaining: 0 }
    this.clients.add(client)

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.forwardBinary(client, data)
        return
      }
      const msg = parseMessage(data.toString())
      if (!msg) return

      if (msg.t === 'subscribe') {
        client.subscribed = true
        this.send(socket, { t: 'devices', devices: this.entries() })
        return
      }

      if (!isCommand(msg.t)) return

      const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : ''
      const device = this.devices.get(deviceId)
      if (!device?.socket) {
        this.send(socket, {
          t: 'error',
          message: 'That stick is not connected. Pick one from the list.',
        })
        return
      }

      if (msg.t === 'begin') {
        const bytes = typeof msg.bytes === 'number' ? msg.bytes : 0
        if (!Number.isInteger(bytes) || bytes <= 0) {
          this.send(socket, { t: 'error', message: 'That upload declared no payload.' })
          return
        }
        client.target = deviceId
        client.remaining = bytes
      }

      device.socket.send(JSON.stringify(msg))
    })

    socket.on('close', () => this.clients.delete(client))
    socket.on('error', (err) => console.warn(`[client] socket error: ${err.message}`))
  }

  /**
   * One chunk in flight. The client socket is paused until the device socket has
   * handed the bytes to the kernel, which turns the device's link speed into
   * back-pressure on the browser without any protocol-level acknowledgement.
   */
  private forwardBinary(client: ClientRecord, data: RawData): void {
    if (!client.target) {
      this.send(client.socket, {
        t: 'error',
        message: 'Payload bytes arrived before a begin. Start the upload again.',
      })
      return
    }
    const device = this.devices.get(client.target)
    if (!device?.socket) {
      client.target = null
      return
    }

    const chunk = data as Buffer
    client.remaining -= chunk.length
    if (client.remaining <= 0) client.target = null

    client.socket.pause()
    device.socket.send(chunk, { binary: true }, () => client.socket.resume())
  }

  // --- fan-out --------------------------------------------------------------

  private entries(): DeviceEntry[] {
    return [...this.devices.values()].map(entryOf)
  }

  private broadcastDevices(): void {
    this.broadcast({ t: 'devices', devices: this.entries() })
  }

  private broadcast(message: Record<string, unknown>): void {
    const text = JSON.stringify(message)
    for (const client of this.clients) {
      if (client.subscribed) this.rawSend(client.socket, text)
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    this.rawSend(socket, JSON.stringify(message))
  }

  private rawSend(socket: WebSocket, text: string): void {
    if (socket.readyState === socket.OPEN) socket.send(text)
  }

  private fail(socket: WebSocket, message: string): void {
    console.warn(`[relay] ${message}`)
    this.send(socket, { t: 'error', message })
    socket.close()
  }
}
