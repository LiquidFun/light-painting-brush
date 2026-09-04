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
enforced by the reverse proxy in front of the application; the application
implements no auth of its own and never sees an unauthenticated request.

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
| `slots` | `selected`, `slots` | Right after `hello`, and whenever the stored set changes |

`deviceId` is stable across reboots — the ESP32's MAC address formatted as
`lightstick-xxxxxxxxxxxx`. It is the identity the relay routes on, so it must not
be random per boot.

Each entry of `slots` is
`{ i, name, frames, fps, bytes, crc32, startDelayMs, loop, pingPong, colours }`.
`i` is the slot index and is sent explicitly, because unused slots are omitted
and the set can have holes. `selected` is the index that `play` will start, or
`-1` when nothing is stored.

`crc32` and `bytes` identify the payload, and the playback fields alongside them
complete the picture, so a client can tell that an animation it is about to
upload is **already in flash** and send `select` instead. At 60–80 kB/s a large
animation is half a minute, so this is worth doing — but only on an exact match,
since the failure mode is shooting with the wrong animation. The playback fields
have to be part of that comparison because they travel in the upload header
rather than in the payload: without them, toggling `loop` and pressing upload
would appear to do nothing.

`autoPlay` is not reported, deliberately. The device consults it once, when a
transfer completes, and never again, so a stored slot has no meaningful value for
it. A client skipping an upload should honour its own current setting by sending
`play` after `select`.

`colours` holds one average per equal slice of the payload — three of them, so
start, middle and end — computed on the device as the upload streamed past. One
average over a whole animation drifts toward mud and made two quite different
animations look alike; three samples separate a colour cycle from a static wash.

Each average is weighted by **chroma**, not brightness, and then scaled up until
one channel is full. Weighting by brightness let the pale majority of a frame
outvote the few saturated pixels that actually characterise it, so everything
came back near-white; scaling holds the hue and discards the brightness, which is
what makes a dim animation identifiable. An animation with no chroma anywhere
reports white, honestly rather than as a fallback.

These are exactly what that slot's LEDs show in the on-stick picker, so the
browser's swatch and the strip agree. Readers should take the length from the
array rather than assume three.

`slots` is a separate message rather than fields on `status` because `status`
goes out several times a second during an upload and this is a kilobyte.

### 3.2 Client → server

| `t` | Fields | Meaning |
|---|---|---|
| `subscribe` | — | Begin receiving `devices` and `status` |
| `begin` | `proto`, `deviceId`, `name`, `ledCount`, `frameCount`, `fps`, `startDelayMs`, `loop`, `pingPong`, `autoPlay`, `bytes`, `crc32` | Followed by binary frames totalling `bytes` |
| `play` | `deviceId` | Play the selected animation |
| `stop` | `deviceId` | Stop, blank the strip, keep everything stored |
| `clear` | `deviceId` | Delete the selected animation |
| `select` | `deviceId`, `slot` | Make that slot the one `play` starts |
| `deleteSlot` | `deviceId`, `slot` | Delete one stored animation |
| `identify` | `deviceId` | Flash the strip white briefly, ~200 ms |
| `brightness` | `deviceId`, `value` (0–255) | Master brightness |

`name` is what the animation is filed under in flash. It is truncated to 15
characters on the device and is the only label the on-stick picker has.

`select` verifies the slot's CRC before accepting it, so a slot whose payload has
been overwritten is dropped rather than played. That read costs tens of
milliseconds per stored megabyte.

A client's binary frames are routed to the device named in its **most recent
`begin`**. Binary arriving from a client that has not sent `begin` is dropped and
answered with `error`.

### 3.3 Server → client

| `t` | Fields | When |
|---|---|---|
| `devices` | `devices`: array of `hello` payloads plus `online`, the last known `status` fields, and the last known `slots`/`selected` | On `subscribe`, and whenever the set or a device's presence changes |
| `status` | `deviceId` plus the device's `status` fields | Broadcast to every subscribed client |
| `slots` | `deviceId`, `selected`, `slots` | Broadcast to every subscribed client |
| `error` | `message` | Human-readable, safe to display verbatim |

The stored set appears twice on purpose: as its own message for a browser that is
already open, and folded into each `devices` entry for one that connects later —
otherwise a late arrival would have to ask the stick to repeat itself.

A device that reconnects starts with **no** remembered status and **no**
remembered set. It may have been reflashed while it was away, and a set carried
over from before a reboot would be a guess.

### 3.4 Server → device

Everything in §3.2 except `subscribe` is forwarded verbatim, `deviceId` included;
the device ignores the field since it can only be itself. Binary frames are
forwarded as they arrive.

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
| `0` | `IDLE` | Nothing stored |
| `1` | `RECEIVING` | Space claimed in flash, bytes arriving |
| `2` | `READY` | An animation is selected and CRC-verified |
| `3` | `PLAYING` | Frames going to the strip |
| `4` | `ERROR` | See `error` |

## 5. Error codes

| Code | Meaning |
|---|---|
| `0` | none |
| `1` | out of space — payload exceeds `maxAnimationBytes` |
| `2` | unsupported protocol version |
| `3` | CRC mismatch |
| `4` | `ledCount` mismatch with the firmware build |
| `5` | transfer timeout — no data for 10 s while `RECEIVING` |
| `6` | unexpected message for the current state |

Error `6` is reported as a one-off `ERROR` status; the device's real state and the
stored set are left intact.

No error costs the previously stored animations. A failed transfer only loses the
slots its bytes happened to land on, which the directory released before the
first byte was written (§8).

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

A client that recognises its animation in the device's `slots` should skip the
transfer entirely and send `select` — see §3.1. Commands sent back to back like
that are safe: the device queues control frames rather than holding one at a
time, so a `select` immediately followed by a `play` cannot lose the `select` and
play the previous animation instead.

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

## 8. On-device storage

Not strictly wire protocol, but it is what `slots`, `select` and `deleteSlot`
describe. The implementation is `firmware/src/animation.cpp`.

Animations live in a dedicated 2.44 MB flash partition, up to twelve at once, so
a shoot needs no phone once they are loaded. Allocation is **append-and-wrap**:
each upload lands at a write cursor, restarts at the beginning if it will not
fit before the end, and evicts whatever it overlaps. There is no free list, no
best fit and no compaction — an animation needing the whole partition evicts
every other, one needing a tenth evicts only what it lands on. `bytes` in a
`slots` entry is the payload size, not the space consumed; each animation is
padded to a 4 KB boundary so a neighbour's erase cannot destroy it.

Uploads are atomic. A directory of the twelve slots is written to two sectors
alternately, newest sequence number winning, and it is rewritten **before** the
first payload byte to release the slots about to be overwritten. A power cut, a
dropped socket or a failed CRC therefore leaves the previous set intact.

### 8.1 The on-stick picker

The BOOT button is the whole interface when there is no phone.

| Gesture | While playing or idle | While the picker is open |
|---|---|---|
| Short press | Play, or stop what is playing | Step to the next stored animation |
| Long press (≥700 ms) | Open the picker | Confirm the highlighted one and close |

With the picker open the strip shows, at the base, one marker per stored
animation: three LEDs carrying that slot's `colours`, at full brightness for the
highlighted one and dimmed for the rest, with a single dark LED between markers.
Then ten dark LEDs, then the highlighted animation previewing across the rest of
the strip.

Only stored slots get a marker and they are packed together, so counting them
tells you how many are on the stick. Leaving a hole where a slot is empty made
the row unreadable, because the hole looks exactly like the separator.

The preview takes whatever the row does not, so a stick holding two animations
gets a longer one than a stick holding twelve. It is what actually identifies an
animation — colour alone cannot.

Stepping only moves the highlight. The choice is committed on the confirming long
press, because committing costs a CRC pass over the payload and a directory
write.
