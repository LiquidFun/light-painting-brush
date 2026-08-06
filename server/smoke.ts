// End-to-end smoke test: `npm run smoke`.
//
// Starts the real server against temporary directories, then drives it with a
// fake device and a fake browser over real WebSockets. This is the only cheap way
// to tell a relay routing bug from a firmware bug, since the ESP32 side cannot be
// exercised from a workstation.
//
// It also runs the browser's own parser over the bytes this server produces, which
// is the only automated check that the two halves of PROTOCOL.md agree.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { crc32, parseServerMessage } from '../web/src/transport/protocol.ts'

const results: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' ' + extra : ''}`)
}

const data = await mkdtemp(path.join(tmpdir(), 'ls-data-'))
const stat = await mkdtemp(path.join(tmpdir(), 'ls-static-'))
await mkdir(path.join(stat, 'assets'), { recursive: true })
await writeFile(path.join(stat, 'index.html'), '<!doctype html><title>spa</title>')
await writeFile(path.join(stat, 'assets', 'app.js'), 'console.log(1)')

const PORT = 8123
// Relative to this file, not to the caller's cwd, and process.execPath rather
// than "node" so the child is the same runtime that is running this test.
const child = spawn(process.execPath, [path.join(import.meta.dirname, 'src', 'index.ts')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, STATIC_DIR: stat },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', (b) => process.stderr.write(`[srv] ${b}`))
await new Promise<void>((resolve) => {
  child.stdout.on('data', (b: Buffer) => {
    if (b.toString().includes('http://')) resolve()
  })
})

const base = `http://127.0.0.1:${PORT}`
const open = (p: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${p}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
const next = (ws: WebSocket, test: (m: any) => boolean): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000)
    const on = (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return
      const m = JSON.parse(raw.toString())
      if (!test(m)) return
      clearTimeout(timer)
      ws.off('message', on)
      resolve(m)
    }
    ws.on('message', on)
  })

// --- static -----------------------------------------------------------------
const spa = await fetch(`${base}/some/deep/route`)
ok('SPA fallback serves index.html', spa.status === 200 && (await spa.text()).includes('spa'))
const asset = await fetch(`${base}/assets/app.js`)
ok('assets are immutable', asset.headers.get('cache-control')?.includes('immutable') === true)
const missing = await fetch(`${base}/nope.png`)
ok('missing file with extension is 404', missing.status === 404)
// These all normalise back inside the root, so they get the SPA fallback or a 404
// rather than a file. What matters is that nothing outside STATIC_DIR leaks.
for (const attempt of ['/../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/..%2f..%2fetc/hosts']) {
  const res = await fetch(`${base}${attempt}`)
  const body = res.status === 200 ? await res.text() : ''
  ok(`traversal refused ${attempt}`, !body.includes('root:') && !body.includes('localhost'), `${res.status}`)
}

// --- library ----------------------------------------------------------------
const project = { id: 'abc123', name: 'Test', layers: [] }
const put = await fetch(`${base}/api/projects/abc123`, {
  method: 'PUT',
  body: JSON.stringify(project),
})
ok('PUT project', put.status === 200)
const mismatch = await fetch(`${base}/api/projects/other`, {
  method: 'PUT',
  body: JSON.stringify(project),
})
ok('PUT rejects id mismatch', mismatch.status === 400)
const badId = await fetch(`${base}/api/projects/..%2Fescape`, {
  method: 'PUT',
  body: JSON.stringify(project),
})
ok('PUT rejects unusable id', badId.status === 400, `${badId.status}`)
const list = await fetch(`${base}/api/projects`).then((r) => r.json())
ok('GET lists the project', list.projects.length === 1 && list.projects[0].id === 'abc123')
const del = await fetch(`${base}/api/projects/abc123`, { method: 'DELETE' })
ok('DELETE project', del.status === 200)
const empty = await fetch(`${base}/api/projects`).then((r) => r.json())
ok('library is empty again', empty.projects.length === 0)

// --- relay ------------------------------------------------------------------
const client = await open('/ws/client')
// Kept so the browser's own parser can be run over the real bytes below.
const clientRaw: string[] = []
client.on('message', (raw: Buffer, isBinary: boolean) => {
  if (!isBinary) clientRaw.push(raw.toString())
})
const devicesEmpty = (client.send(JSON.stringify({ t: 'subscribe' })), await next(client, (m) => m.t === 'devices'))
ok('devices list starts empty', devicesEmpty.devices.length === 0)

const device = await open('/ws/device')
device.send(
  JSON.stringify({
    t: 'hello',
    proto: 2,
    deviceId: 'lightstick-aabbccddeeff',
    name: 'LightStick',
    ledCount: 144,
    maxAnimationBytes: 200000,
    fw: '2.0.0',
  }),
)
const devices = await next(client, (m) => m.t === 'devices' && m.devices.length === 1)
ok('hello reaches subscribed clients', devices.devices[0].deviceId === 'lightstick-aabbccddeeff')
ok('device reported online', devices.devices[0].online === true)
ok('ceiling relayed', devices.devices[0].maxAnimationBytes === 200000)

// begin + binary
const total = 4096 * 3 + 100
const beginAtDevice = next(device, (m) => m.t === 'begin')
client.send(
  JSON.stringify({
    t: 'begin',
    proto: 2,
    deviceId: 'lightstick-aabbccddeeff',
    ledCount: 144,
    frameCount: 10,
    fps: 25,
    startDelayMs: 0,
    loop: false,
    pingPong: false,
    autoPlay: true,
    bytes: total,
    crc32: 123,
  }),
)
const begun = await beginAtDevice
ok('begin forwarded to the device', begun.bytes === total && begun.crc32 === 123)

let received = 0
device.on('message', (raw: Buffer, isBinary: boolean) => {
  if (isBinary) received += raw.length
})
for (let sent = 0; sent < total; sent += 4096) {
  client.send(Buffer.alloc(Math.min(4096, total - sent), 7))
}
await new Promise((r) => setTimeout(r, 400))
ok('all payload bytes relayed', received === total, `${received}/${total}`)

// stray binary after the declared length
const strayError = next(client, (m) => m.t === 'error')
client.send(Buffer.alloc(16))
const stray = await strayError
ok('stray binary answered with an error', typeof stray.message === 'string', stray.message)

// status broadcast
const statusAtClient = next(client, (m) => m.t === 'status')
device.send(
  JSON.stringify({
    t: 'status',
    state: 2,
    error: 0,
    bytesReceived: total,
    bytesExpected: total,
    maxAnimationBytes: 190000,
  }),
)
const status = await statusAtClient
ok('status broadcast carries deviceId', status.deviceId === 'lightstick-aabbccddeeff' && status.state === 2)

// --- the stored set ---------------------------------------------------------
const slotsAtClient = next(client, (m) => m.t === 'slots')
device.send(
  JSON.stringify({
    t: 'slots',
    selected: 1,
    slots: [
      {
        i: 0,
        name: 'Wings',
        frames: 125,
        fps: 60,
        bytes: 54000,
        crc32: 0xdeadbeef,
        startDelayMs: 500,
        loop: true,
        pingPong: false,
        colours: [[255, 0, 0], [200, 40, 0], [120, 90, 0]],
      },
      {
        i: 1,
        name: 'Sp"ike\\',
        frames: 60,
        fps: 25,
        bytes: 25920,
        // Out of range, short, and not an array at all: all three come from the
        // device and all three are rendered in a browser.
        colours: [[0, 300, -4], [10], 'nope'],
      },
    ],
  }),
)
const slots = await slotsAtClient
ok('slots broadcast carries deviceId', slots.deviceId === 'lightstick-aabbccddeeff')
ok('slots are relayed in order', slots.slots.map((s: any) => s.i).join() === '0,1')
ok('every sample is relayed', slots.slots[0].colours.length === 3)
// Without these the browser cannot tell "already on the stick" from "close
// enough", and would ship the wrong animation to a shoot.
ok(
  'the fields that identify an animation survive the relay',
  slots.slots[0].crc32 === 0xdeadbeef &&
    slots.slots[0].startDelayMs === 500 &&
    slots.slots[0].loop === true &&
    slots.slots[0].pingPong === false,
)
ok(
  'a device that omits them gets safe defaults, not undefined',
  slots.slots[1].crc32 === 0 &&
    slots.slots[1].startDelayMs === 0 &&
    slots.slots[1].loop === false &&
    slots.slots[1].pingPong === false,
)
ok('colours are clamped to bytes', slots.slots[1].colours[0].join() === '0,255,0')
ok('a short colour is padded', slots.slots[1].colours[1].join() === '10,0,0')
ok('a non-array colour becomes black', slots.slots[1].colours[2].join() === '0,0,0')
ok('selected must name a slot that exists', slots.selected === 1)

// A selection pointing at nothing is worse than no selection: the browser would
// highlight a row that is not there.
const strayedAtClient = next(client, (m) => m.t === 'slots' && m.selected === -1)
device.send(JSON.stringify({ t: 'slots', selected: 7, slots: [] }))
await strayedAtClient
ok('a selection with no matching slot becomes -1', true)
device.send(
  JSON.stringify({
    t: 'slots',
    selected: 1,
    slots: [
      { i: 0, name: 'Wings', frames: 125, fps: 60, bytes: 54000, colours: [[255, 0, 0]] },
      { i: 1, name: 'Spike', frames: 60, fps: 25, bytes: 25920, colours: [[0, 255, 0]] },
    ],
  }),
)
await next(client, (m) => m.t === 'slots' && m.selected === 1)

// select / deleteSlot reach the device
const selectAtDevice = next(device, (m) => m.t === 'select')
client.send(JSON.stringify({ t: 'select', deviceId: 'lightstick-aabbccddeeff', slot: 0 }))
ok('select is forwarded', (await selectAtDevice).slot === 0)
const deleteAtDevice = next(device, (m) => m.t === 'deleteSlot')
client.send(JSON.stringify({ t: 'deleteSlot', deviceId: 'lightstick-aabbccddeeff', slot: 1 }))
ok('deleteSlot is forwarded', (await deleteAtDevice).slot === 1)

// command to an unknown device
const unknownError = next(client, (m) => m.t === 'error')
client.send(JSON.stringify({ t: 'play', deviceId: 'nope' }))
ok('play to unknown device errors', typeof (await unknownError).message === 'string')

// device disconnect
const offline = next(client, (m) => m.t === 'devices' && m.devices[0]?.online === false)
device.close()
const wentOffline = await offline
ok('offline device stays in the list', true)
// Folded into the entry, so a browser that connects later does not have to ask
// the stick to repeat itself.
ok(
  'the device entry carries the stored set',
  wentOffline.devices[0].slots.length === 2 && wentOffline.devices[0].selected === 1,
)

// --- the browser's parser against the server's real output -------------------
const parsed = clientRaw.map(parseServerMessage)
ok('every server frame parses in the browser', parsed.every((m) => m !== null), `${parsed.length} frames`)
const parsedDevices = parsed.find((m) => m?.t === 'devices' && m.devices.length === 1)
ok(
  'browser reads the device entry',
  parsedDevices?.t === 'devices' &&
    parsedDevices.devices[0].deviceId === 'lightstick-aabbccddeeff' &&
    parsedDevices.devices[0].ledCount === 144 &&
    parsedDevices.devices[0].fw === '2.0.0' &&
    parsedDevices.devices[0].online === true,
)
const parsedStatus = parsed.find((m) => m?.t === 'status')
ok(
  'browser reads the status broadcast',
  parsedStatus?.t === 'status' &&
    parsedStatus.deviceId === 'lightstick-aabbccddeeff' &&
    parsedStatus.state === 2 &&
    parsedStatus.maxAnimationBytes === 190000,
)
const parsedSlots = parsed.find((m) => m?.t === 'slots' && m.slots.length === 2)
ok(
  'browser reads the slot list',
  parsedSlots?.t === 'slots' &&
    parsedSlots.selected === 1 &&
    parsedSlots.slots[0].name === 'Wings' &&
    parsedSlots.slots[0].frames === 125 &&
    parsedSlots.slots[0].colours.length === 3 &&
    parsedSlots.slots[0].colours[2].join() === '120,90,0',
)
ok('browser drops unknown frames', parseServerMessage('{"t":"future"}') === null)
ok('browser drops malformed frames', parseServerMessage('not json') === null)

// The value the firmware's crc32() must agree with (firmware/src/animation.cpp).
ok(
  'crc32 matches the reference vector',
  crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
  crc32(new TextEncoder().encode('123456789')).toString(16),
)


// --- a device that drops mid-upload must not come back stuck ---------------
{
  const dev2 = await open('/ws/device')
  const hello = {
    t: 'hello', proto: 2, deviceId: 'lightstick-stuck', name: 'Stuck',
    ledCount: 144, maxAnimationBytes: 200000, fw: '2.0.0',
  }
  dev2.send(JSON.stringify(hello))
  await next(client, (m: any) => m.t === 'devices' && m.devices.some((d: any) => d.deviceId === 'lightstick-stuck'))

  // Mid-upload, then the link dies.
  dev2.send(JSON.stringify({
    t: 'status', state: 1, error: 0, bytesReceived: 4096, bytesExpected: 54000,
    maxAnimationBytes: 200000,
  }))
  await next(client, (m: any) => m.t === 'status' && m.deviceId === 'lightstick-stuck' && m.state === 1)
  dev2.close()
  await next(client, (m: any) => m.t === 'devices' &&
    m.devices.find((d: any) => d.deviceId === 'lightstick-stuck')?.online === false)

  // It reboots and reconnects. RECEIVING must not survive: it disables Play in
  // every browser and reads as a stick stuck uploading forever.
  const dev3 = await open('/ws/device')
  dev3.send(JSON.stringify(hello))
  const back = await next(client, (m: any) => m.t === 'devices' &&
    m.devices.find((d: any) => d.deviceId === 'lightstick-stuck')?.online === true)
  const entry = back.devices.find((d: any) => d.deviceId === 'lightstick-stuck')
  ok('a reconnecting device does not keep a stale RECEIVING', entry.state === 0, `state ${entry.state}`)
  ok('and its byte counters are cleared', entry.bytesReceived === 0 && entry.bytesExpected === 0)
  // The flash may have been reflashed while it was away, so the set is not
  // remembered either. The device republishes it right after `hello`.
  ok('and the stored set is not remembered', entry.slots.length === 0 && entry.selected === -1)
  dev3.close()
}

client.close()
child.kill()
console.log(results.join('\n'))
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`)
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
