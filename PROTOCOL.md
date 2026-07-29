# Light Painting Stick — wire protocol

Single source of truth for the BLE contract between `web/` and `firmware/`.
Extracted from `REQUIREMENTS.md` §2.

Implementations that must agree byte-for-byte with this document:

- `firmware/src/protocol.h`
- `web/src/ble/protocol.ts`

A change here is a change in all three files, in the same commit.

All multi-byte fields are **little-endian**.

---

## 1. Animation wire format

An animation is a flat array of fully-rendered RGB frames. **All interpolation
happens in the browser.** The firmware does no easing, no colour maths and no
keyframe evaluation — it plays bytes.

```
payload = frame[0] .. frame[frameCount-1]
frame   = led[0] .. led[ledCount-1]
led     = u8 R, u8 G, u8 B      # RGB order on the wire; firmware maps to GRB
```

Payload size is `frameCount × ledCount × 3` bytes — 432 bytes per frame at 144
LEDs.

Gamma correction (γ ≈ 2.2) is applied by the browser immediately before
quantising to `u8`. The bytes on the wire are already in LED-linear space.

## 2. GATT

Device name: `LightStick`

```
Service   9a1e0000-1b2c-4d3e-8f90-a1b2c3d4e5f6
  Control 9a1e0001-1b2c-4d3e-8f90-a1b2c3d4e5f6   write
  Data    9a1e0002-1b2c-4d3e-8f90-a1b2c3d4e5f6   write
  Status  9a1e0003-1b2c-4d3e-8f90-a1b2c3d4e5f6   read, notify
```

Firmware requests an MTU of 517 on connect. Chunk size is `MTU − 3`, capped at
512, and **must be derived from the negotiated MTU** — negotiation can land lower
than requested and a hardcoded 512 then silently truncates every write.

## 3. Control commands

Single write. First byte is the opcode, the rest is the payload.

| Op | Name | Payload | Effect |
|---|---|---|---|
| `0x01` | `BEGIN_UPLOAD` | 20-byte header (§4) | Allocate buffer, enter `RECEIVING` |
| `0x02` | `PLAY` | — | Play the loaded animation |
| `0x03` | `STOP` | — | Stop, blank the strip |
| `0x04` | `SET_BRIGHTNESS` | `u8` 0–255 | Global master brightness |
| `0x05` | `CLEAR` | — | Free buffer, back to `IDLE` |
| `0x06` | `IDENTIFY` | — | Flash the strip white briefly, ~200 ms |
| `0x07` | `ABORT_UPLOAD` | — | Discard partial transfer |

## 4. Upload header — 20 bytes

| Offset | Type | Field |
|---|---|---|
| 0 | `u32` | magic `0x3153504C` (`"LPS1"`) |
| 4 | `u8` | version = `1` |
| 5 | `u8` | flags — bit0 `loop`, bit1 `pingPong`, bit2 `autoPlayOnUpload` |
| 6 | `u16` | `ledCount` |
| 8 | `u16` | `frameCount` |
| 10 | `u16` | `fps` |
| 12 | `u16` | `startDelayMs` — delay between trigger and first frame |
| 14 | `u32` | `crc32` of the payload |
| 18 | `u16` | reserved, zero |

`crc32` is CRC-32/ISO-HDLC: reflected, polynomial `0xEDB88320`, init
`0xFFFFFFFF`, final XOR `0xFFFFFFFF` — the same value `zlib.crc32` produces.

## 5. Status notification — 16 bytes

Emitted on every state change, and during upload at least every 4 KB received.

| Offset | Type | Field |
|---|---|---|
| 0 | `u8` | state — `0` idle, `1` receiving, `2` ready, `3` playing, `4` error |
| 1 | `u8` | errorCode (§6) |
| 2 | `u16` | protocol version |
| 4 | `u32` | bytes received this transfer |
| 8 | `u32` | bytes expected this transfer |
| 12 | `u32` | `maxAnimationBytes` — largest payload the device can currently accept |

`maxAnimationBytes` is computed from free heap at query time, less a safety
margin. The web app reads Status immediately on connect and uses it to bound the
duration slider before the user can design something that will not fit. The web
app trusts this number over any hardcoded estimate.

## 6. Error codes

| Code | Meaning |
|---|---|
| `0x00` | none |
| `0x01` | out of memory — requested payload exceeds `maxAnimationBytes` |
| `0x02` | bad magic or unsupported version |
| `0x03` | CRC mismatch |
| `0x04` | `ledCount` mismatch with firmware build |
| `0x05` | transfer timeout (no data for 5 s while `RECEIVING`) |
| `0x06` | unexpected opcode for current state |

Error `0x06` is reported as a one-off ERROR status; the device's real state and
any loaded animation are left intact. The other codes leave the device with no
animation loaded, and a new `BEGIN_UPLOAD` or `CLEAR` clears the error.

## 7. Transfer sequence

```
web                              esp32
 |-- BEGIN_UPLOAD + header ------->|  allocate; notify RECEIVING or error
 |<------------- Status ----------|
 |-- chunk 0 (Data, w/ response)-->|
 |-- chunk 1 --------------------->|
 |   ...                           |  notify progress every ~4 KB
 |<------------- Status ----------|
 |-- chunk N --------------------->|  all bytes in → verify CRC32
 |<------------- Status ----------|  READY, or ERROR 0x03
 |-- PLAY ------------------------>|
```

Data chunks use **write-with-response** in v1. At MTU 517 this gives roughly
15–30 KB/s and provides back-pressure for free, so there is no flow-control logic
to get wrong. Only move to write-without-response plus a credit scheme if
measured throughput proves unacceptable.
