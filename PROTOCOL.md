# Light Painting Stick — wire protocol

Single source of truth for the messages exchanged between `web/`, `server/` and
`firmware/`. Extracted from `REQUIREMENTS.md` §3.

Implementations that must agree with this document:

- `firmware/src/protocol.h`
- `web/src/transport/protocol.ts`
- `server/src/protocol.ts`

A change here is a change in all of them, in the same commit.

> **v2.** v1 used a BLE GATT service with binary opcodes. That contract is in git
> history at the initial commit; `firmware/src/ble_service.*` and `web/src/ble/`
> still implement it while the WiFi path is being proven on hardware. Do not
> extend it.

---

## 1. Animation payload

Unchanged from v1, and deliberately so. An animation is a flat array of
fully-rendered RGB frames. **All interpolation happens in the browser.** The
firmware does no easing, no colour maths and no keyframe evaluation — it plays
bytes.

```
payload = frame[0] .. frame[frameCount-1]
frame   = led[0] .. led[ledCount-1]
led     = u8 R, u8 G, u8 B      # RGB order on the wire; firmware maps to GRB
```

Payload size is `frameCount × ledCount × 3` bytes — 432 bytes per frame at 144
LEDs.

Gamma correction (γ ≈ 2.2) is applied by the browser immediately before
quantising to `u8`. The bytes on the wire are already in LED-linear space.

## 2. Connections

Both sides open a WebSocket to the server over TLS. Authentication is HTTP Basic,
enforced by Caddy in front of the application; the application implements no auth
of its own and never sees an unauthenticated request.

| Endpoint | Who | Credentials |
|---|---|---|
| `wss://<host>/ws/device` | ESP32 | Compiled into the firmware (`secrets.h`) |
| `wss://<host>/ws/client` | Browser | The browser's Basic auth session |

The device dials out; it never listens. It reconnects with exponential backoff
capped at 30 s. **Losing the socket must not disturb an animation already in RAM
and must not stop playback in progress.**

`protoVersion` is `2`. A `begin` carrying any other value is rejected with error
`2`.

## 3. Framing

Control messages are **JSON text frames**. Payload bytes are **binary frames**.
WebSocket already distinguishes the two, so there is no envelope to parse and no
length prefix to get wrong.

Every JSON message has a `t` field naming the type. Unknown `t` values are
ignored rather than treated as errors, so one side can be ahead of the other.

### 3.1 Device → server

| `t` | Fields | When |
|---|---|---|
| `hello` | `proto`, `deviceId`, `name`, `ledCount`, `maxAnimationBytes`, `fw` | Immediately on connect, before anything else |
| `status` | `state`, `error`, `bytesReceived`, `bytesExpected`, `maxAnimationBytes` | On every state change, and every ~64 KB while `RECEIVING` |

`deviceId` is stable across reboots — the ESP32's MAC address formatted as
`lightstick-xxxxxxxxxxxx`. It is the identity the relay routes on, so it must not
be random per boot.

### 3.2 Client → server

| `t` | Fields | Meaning |
|---|---|---|
| `subscribe` | — | Begin receiving `devices` and `status` |
| `begin` | `proto`, `deviceId`, `ledCount`, `frameCount`, `fps`, `startDelayMs`, `loop`, `pingPong`, `autoPlay`, `bytes`, `crc32` | Followed by binary frames totalling `bytes` |
| `play` | `deviceId` | Play the loaded animation |
| `stop` | `deviceId` | Stop, blank the strip, keep the buffer |
| `clear` | `deviceId` | Free the buffer, back to `IDLE` |
| `identify` | `deviceId` | Flash the strip white briefly, ~200 ms |
| `brightness` | `deviceId`, `value` (0–255) | Master brightness |

A client's binary frames are routed to the device named in its **most recent
`begin`**. Binary arriving from a client that has not sent `begin` is dropped and
answered with `error`.

### 3.3 Server → client

| `t` | Fields | When |
|---|---|---|
| `devices` | `devices`: array of `hello` payloads plus `online` and the last known `status` fields | On `subscribe`, and whenever the set or a device's presence changes |
| `status` | `deviceId` plus the device's `status` fields | Broadcast to every subscribed client |
| `error` | `message` | Human-readable, safe to display verbatim |

### 3.4 Server → device

`begin`, `play`, `stop`, `clear`, `identify` and `brightness` are forwarded
verbatim, `deviceId` included; the device ignores the field since it can only be
itself. Binary frames are forwarded as they arrive.

The relay **streams**: it never buffers a whole payload. A 460-frame animation is
200 KB and there may be several clients.

## 4. Device states

```
IDLE ──begin──▶ RECEIVING ──crc ok──▶ READY ──play──▶ PLAYING ──▶ READY
                     │                                    │
                     └──── error ────▶ ERROR ◀─────────────┘
```

| Code | State | Meaning |
|---|---|---|
| `0` | `IDLE` | No animation in RAM |
| `1` | `RECEIVING` | Buffer allocated, bytes arriving |
| `2` | `READY` | Animation loaded and CRC-verified |
| `3` | `PLAYING` | Frames going to the strip |
| `4` | `ERROR` | See `error` |

## 5. Error codes

| Code | Meaning |
|---|---|
| `0` | none |
| `1` | out of memory — payload exceeds `maxAnimationBytes` |
| `2` | unsupported protocol version |
| `3` | CRC mismatch |
| `4` | `ledCount` mismatch with the firmware build |
| `5` | transfer timeout — no data for 10 s while `RECEIVING` |
| `6` | unexpected message for the current state |

Error `6` is reported as a one-off `ERROR` status; the device's real state and any
loaded animation are left intact. The others leave the device with no animation
loaded, and the next `begin` or `clear` clears the error.

## 6. Transfer

```
client                server                 esp32
  |-- begin --------->|-- begin ------------->|  allocate; RECEIVING or error
  |                   |<----- status ---------|
  |-- binary chunk -->|-- binary chunk ------>|
  |   ...             |   ...                 |  status every ~64 KB
  |-- binary chunk -->|-- binary chunk ------>|  all bytes in → verify crc32
  |                   |<----- status ---------|  READY, or ERROR 3
  |-- play ---------->|-- play -------------->|
```

Chunk size is **4096 bytes**, chosen so the ESP32 never has to hold a large frame
in addition to the animation buffer. TCP already guarantees ordering and
integrity; `crc32` is an end-to-end check against bugs, not against the network.

`crc32` is CRC-32/ISO-HDLC: reflected, polynomial `0xEDB88320`, init `0xFFFFFFFF`,
final XOR `0xFFFFFFFF` — the same value `zlib.crc32` produces.

Deliberately absent: chunk acknowledgement, credit schemes, retransmission. TCP
does this. v1's per-chunk round trip is exactly what made it slow. The browser's
only flow control is `WebSocket.bufferedAmount`, which is enough.

A `begin` arriving while a device is `RECEIVING` cancels the transfer in progress
(§3.7). There is no lock and no ownership: the interrupted client sees the state
change on the broadcast and can retry.

## 7. Library API

Served by the same origin, behind the same Basic auth.

| Route | Meaning |
|---|---|
| `GET /api/projects` | `{ schema, projects: Project[] }` — the whole shared library |
| `PUT /api/projects/:id` | Body is one `Project`; `id` must match |
| `DELETE /api/projects/:id` | Remove one project |

The schema is the versioned export format the editor already uses, so files stay
interchangeable with local export/import. One shared password means one shared
library, and last write wins.
