# Light Painting Stick — Requirements

A 1 m addressable LED bar for long-exposure light painting. Animations are designed
in a browser, pushed to an ESP32 over Bluetooth LE, held in RAM, and played back on a
button press while the camera shutter is open.

This document is the contract between the two halves of the repo. Sections 1–2 are
binding for both; sections 3 and 4 are per-project.

---

## 0. Hardware target

| Item | Detail |
|---|---|
| MCU | ESP32-WROOM-32 (classic dual-core Xtensa), 30- or 38-pin DevKit board, CH340 USB-serial |
| LED strip | BTF-LIGHTING WS2812B, 144 LEDs, 1 m, 5 V, single data line |
| Data pin | `GPIO 13` |
| Trigger button | `GPIO 0` — the on-board **BOOT** button (no external button purchased) |
| Power | USB power bank, 5 V, ~3 A, feeding both strip and ESP32 `5V` pin from a common rail |
| Host OS | Linux (Ubuntu-family) for development |

There is **no flash persistence**. The animation lives in RAM and is lost on power
cycle. This is intentional — the phone is always present and re-uploads before each
shot.

---

## 1. Repo layout

```
lightstick/
├── README.md              # setup for both halves, wiring diagram, quickstart
├── REQUIREMENTS.md        # this file
├── PROTOCOL.md            # extracted copy of §2, the single source of truth
├── firmware/
│   ├── platformio.ini
│   ├── src/
│   │   ├── main.cpp
│   │   ├── protocol.h     # shared constants — must match web/src/ble/protocol.ts
│   │   ├── ble_service.{h,cpp}
│   │   ├── animation.{h,cpp}
│   │   └── player.{h,cpp}
│   └── README.md
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── model/         # project, keyframes, pure types
        ├── render/        # interpolation → frame buffer
        ├── ble/           # Web Bluetooth client + protocol.ts
        ├── ui/            # components
        └── main.tsx
```

**Use PlatformIO, not the Arduino IDE.** It builds from the CLI
(`pio run -t upload`), pins library versions in `platformio.ini`, and lives in the
repo as text — all of which matter when an agent is doing the editing. The Arduino
IDE is GUI-first and its dependency state lives outside the repo.

`platformio.ini` baseline:

```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
lib_deps =
    fastled/FastLED@^3.7.0
    h2zero/NimBLE-Arduino@^1.4.2
build_flags = -DCORE_DEBUG_LEVEL=1
```

**Use NimBLE, not the default Bluedroid stack.** Bluedroid costs roughly 40–60 KB
more heap, and heap is the direct limiter on how long an animation can be. This is
the single highest-leverage decision in the firmware.

---

## 2. Shared contract

### 2.1 Animation wire format

An animation is a flat array of fully-rendered RGB frames. **All interpolation
happens in the browser.** The firmware is a dumb player — it does no easing, no
colour maths, no keyframe evaluation. This keeps the firmware trivial and puts all
the complexity where floating point and iteration speed are free.

```
payload = frame[0] .. frame[frameCount-1]
frame   = led[0] .. led[ledCount-1]
led     = u8 R, u8 G, u8 B      # RGB order on the wire; firmware maps to GRB
```

Payload size is `frameCount × ledCount × 3` bytes. At 144 LEDs that is 432 bytes per
frame.

### 2.2 BLE GATT

Device name: `LightStick`

```
Service   9a1e0000-1b2c-4d3e-8f90-a1b2c3d4e5f6
  Control 9a1e0001-1b2c-4d3e-8f90-a1b2c3d4e5f6   write
  Data    9a1e0002-1b2c-4d3e-8f90-a1b2c3d4e5f6   write
  Status  9a1e0003-1b2c-4d3e-8f90-a1b2c3d4e5f6   read, notify
```

Firmware requests an MTU of 517 on connect. Chunk size is `MTU − 3`, capped at 512.

### 2.3 Control commands

Single write, first byte is the opcode.

| Op | Name | Payload | Effect |
|---|---|---|---|
| `0x01` | `BEGIN_UPLOAD` | 20-byte header (§2.4) | Allocate buffer, enter `RECEIVING` |
| `0x02` | `PLAY` | — | Play the loaded animation |
| `0x03` | `STOP` | — | Stop, blank the strip |
| `0x04` | `SET_BRIGHTNESS` | `u8` 0–255 | Global master brightness |
| `0x05` | `CLEAR` | — | Free buffer, back to `IDLE` |
| `0x06` | `IDENTIFY` | — | Flash the strip white briefly, ~200 ms |
| `0x07` | `ABORT_UPLOAD` | — | Discard partial transfer |

### 2.4 Upload header (20 bytes, little-endian)

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

### 2.5 Status notification (16 bytes, little-endian)

Emitted on every state change, and during upload at least every 4 KB received.

| Offset | Type | Field |
|---|---|---|
| 0 | `u8` | state — `0` idle, `1` receiving, `2` ready, `3` playing, `4` error |
| 1 | `u8` | errorCode (§2.6) |
| 2 | `u16` | protocol version |
| 4 | `u32` | bytes received this transfer |
| 8 | `u32` | bytes expected this transfer |
| 12 | `u32` | `maxAnimationBytes` — largest payload the device can currently accept |

`maxAnimationBytes` is computed from free heap at query time, with a safety margin.
The web app reads Status immediately on connect and uses this to bound the duration
slider before the user can design something that won't fit.

### 2.6 Error codes

| Code | Meaning |
|---|---|
| `0x00` | none |
| `0x01` | out of memory — requested payload exceeds `maxAnimationBytes` |
| `0x02` | bad magic or unsupported version |
| `0x03` | CRC mismatch |
| `0x04` | `ledCount` mismatch with firmware build |
| `0x05` | transfer timeout (no data for 5 s while `RECEIVING`) |
| `0x06` | unexpected opcode for current state |

### 2.7 Transfer sequence

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

Use **write-with-response** for data chunks in v1. At MTU 517 and a typical
connection interval this gives roughly 15–30 KB/s, which is fine — and it gives
back-pressure for free, so there is no flow-control logic to get wrong. Only move to
write-without-response plus a credit scheme if measured throughput proves
unacceptable.

`protocol.h` and `web/src/ble/protocol.ts` must define the same UUIDs, opcodes,
offsets and error codes. Add a comment at the top of each pointing at the other.

---

## 3. `firmware/`

### 3.1 Behaviour

**States:** `IDLE` → `RECEIVING` → `READY` → `PLAYING` → `READY`.

- On boot: init FastLED, blank the strip, start advertising as `LightStick`.
- Accept exactly **one** animation at a time. A new `BEGIN_UPLOAD` replaces the
  previous one — free the old buffer before allocating the new one.
- Allocate with a single `malloc`/`heap_caps_malloc` of the full payload. If it
  fails, report error `0x01` and stay `IDLE`; do not attempt partial allocation.
- **Trigger sources**, all equivalent: `PLAY` command over BLE, a press of the BOOT
  button on `GPIO 0`, or upload completion when the `autoPlayOnUpload` flag is set.
- Playback: honour `startDelayMs`, then step frames on a `micros()` schedule derived
  from `fps`. Do not use `delay()` — use a non-blocking timer in `loop()` so BLE and
  the button stay responsive.
- Respect `loop` and `pingPong` flags. When neither is set, blank the strip on
  completion and return to `READY`.
- A second trigger during playback restarts from frame 0. A `STOP` blanks and returns
  to `READY` with the buffer intact.

### 3.2 Button handling

`GPIO 0` with `INPUT_PULLUP`, active low, 250 ms debounce via `millis()`.

`GPIO 0` is a strapping pin: held low at power-on it puts the chip into bootloader
mode. That is harmless here but put a comment in the code saying so, and note it in
the firmware README, because it will look like a fault to anyone who hits it.

### 3.3 Status LED

When idle and not playing, light **LED 0 only**, dim (brightness ≤ 8), as a state
indicator: blue = idle, green = ready, red = error. This must be suppressed entirely
during playback and during `startDelayMs`, or it will appear in the photograph.
Make it compile-time toggleable via `#define STATUS_LED_ENABLED`.

### 3.4 Power safety

```cpp
FastLED.setMaxPowerInVoltsAndMilliamps(5, 2200);
```

Non-negotiable. FastLED will scale brightness down on any frame that would exceed
the budget, which makes it impossible for an all-white frame to brown out the ESP32
mid-exposure. Expose the milliamp figure as a `#define` so it can be raised if a
better power bank arrives.

### 3.5 Config constants

Top of `protocol.h`, all `constexpr`:
`LED_COUNT = 144`, `DATA_PIN = 13`, `BUTTON_PIN = 0`, `MAX_MILLIAMPS = 2200`,
`DEFAULT_BRIGHTNESS = 80`, `HEAP_SAFETY_MARGIN = 24576`.

### 3.6 Serial logging

Log state transitions, upload progress, CRC results and free heap at 115200 baud.
This is the only debugging channel in the field.

---

## 4. `web/`

### 4.1 Stack

Vite + React + TypeScript + Tailwind. No backend, no build-time secrets, deployable
as static files.

**Web Bluetooth requires a secure context.** It works on `localhost` for development
and requires HTTPS in production. If the hosting doesn't terminate TLS, the app
cannot connect — flag this in the README.

Browser support is genuinely limited and the app must handle it gracefully rather
than failing silently:

| Platform | Support |
|---|---|
| Chrome / Edge on Android | Yes |
| Chrome / Edge on Linux, macOS, Windows | Yes |
| Firefox, any platform | No |
| Safari, any platform | No |
| iOS, any browser | No (WebKit-only rule) — Bluefy is a third-party workaround |

On load, feature-detect `navigator.bluetooth`. If absent, the editor must still work
fully — design, preview, save, export — with a persistent, dismissible banner
explaining which browsers can connect. Never block the editor behind the connection.

### 4.2 Data model

```ts
type Project = {
  id: string
  name: string
  ledCount: number          // 144
  durationMs: number        // default 5000
  fps: number               // 25 default; options 15 | 20 | 25 | 30 | 50
  background: Color         // default black — what the field decays toward
  colorSpace: 'oklab' | 'srgb' | 'hsv-short' | 'hsv-long'
  falloffPower: number      // IDW exponent, 0.5–6, default 2
  keyframes: Keyframe[]
  playback: { loop: boolean; pingPong: boolean; startDelayMs: number }
}

type Keyframe = {
  id: string
  kind: 'point' | 'row' | 'column'
  led: number               // 0..ledCount-1   — used by 'point' and 'column'
  timeMs: number            // 0..durationMs   — used by 'point' and 'row'
  color: Color              // hue/sat, or hex
  brightness: number        // 0..1, interpolated as its own scalar field
  radius: number            // 0..1, normalised influence radius; default 0.35
  easing: EasingName        // applied to normalised distance before weighting
  hard: boolean             // true = nearest-neighbour within radius, hard edge
}
```

`frameCount = round(durationMs / 1000 * fps)`. Show it live in the UI alongside the
resulting payload size in KB and the device's reported ceiling.

### 4.3 The canvas — this is the product

A 2D field. **X is LED index** — left is LED 0 at the base of the stick, right is
LED 143 at the tip. **Y is time** — top is t=0, downward is later.

The single most important property of this design, and it should be stated in the
UI: **the canvas is a preview of the photograph.** Sweep the stick sideways at
constant speed with the shutter open and the image on the sensor is this canvas.
Editing and previewing are the same view. Do not bury this behind a separate
"preview" mode — the thing being edited *is* the output.

Render by evaluating the field into an `ImageData` of `ledCount × frameCount` and
`putImageData` onto a canvas scaled to fit. Debounce re-renders to animation frames;
for 144 × 375 cells this is a few hundred thousand operations and stays interactive
without WebGL. If it doesn't, move the evaluation to a Web Worker before reaching
for shaders.

Overlaid on the canvas:

- **Keyframe handles.** Points are circles. Rows are a horizontal line with a handle
  on the left gutter. Columns are a vertical line with a handle in the top gutter.
  Handles sit in the gutters, not on the image, so they never hide the colours they
  produce.
- **Playhead** — a horizontal line at the current preview time, draggable.
- **Rulers** — LED index along the top, seconds down the left side.

### 4.4 Interpolation

For each cell `(x, y)` normalise to `u = x/(ledCount-1)`, `v = timeMs/durationMs`,
both in `[0,1]`. For each keyframe `k`, distance is:

```
point:   d = hypot(u - u_k, v - v_k)
row:     d = |v - v_k|          // ignores u — the whole strip at one instant
column:  d = |u - u_k|          // ignores v — one LED for the whole animation
```

Weight, with `p = falloffPower` and `e` the keyframe's easing curve:

```
t = clamp(d / radius_k, 0, 1)
w = (1 - e(t))^p / max(d, 1e-6)^p
```

Result is the weighted mean of all keyframe colours, plus the project background at a
small constant weight so regions outside every keyframe's radius decay to background
rather than being colonised by the nearest distant keyframe. Brightness interpolates
as a separate scalar field using the same weights.

Where `hard` is set, that keyframe wins outright inside its radius instead of
blending — this is the only way to get a crisp edge out of a distance field, and
without it the tool can only make soft washes.

**Interpolate colour in OKLab by default.** Naive sRGB interpolation between
complementary colours passes through grey, which looks like a bug in a light-painting
tool. Offer `hsv-short` for rainbow sweeps and `hsv-long` for full hue rotations,
and keep `srgb` available so the difference is visible and learnable.

Easing options: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `smoothstep`, `step`.

Apply **gamma correction (γ ≈ 2.2) at the very end**, after interpolation and
immediately before quantising to `u8`. Interpolate in perceptual space, output in
LED-linear space. Getting this backwards makes every gradient bunch up at one end.

### 4.5 Interaction

A four-way segmented tool selector: **Select · Point · Row · Column**.

| Gesture | Result |
|---|---|
| Tap canvas with a create tool active | Add keyframe of that kind at the tapped position, select it, open the editor sheet |
| Tap a handle | Select, open the editor sheet |
| Drag a handle | Move. Points move in both axes; rows only in time; columns only in LED index |
| Long-press a handle | Context menu — duplicate, delete, copy colour |
| Pinch | Zoom the canvas |
| Two-finger drag | Pan |
| Tap empty space with Select active | Deselect |

The editor is a **bottom sheet**, not a sidebar or modal — it must be thumb-reachable
on a phone and must not cover the canvas region being edited. Contents: colour wheel
plus hex field, brightness slider, radius slider, easing dropdown, hard-edge toggle,
exact position fields (LED index and time in ms), delete.

Undo/redo with a bounded history stack. Bind `Ctrl/Cmd+Z` and expose visible buttons,
because there is no keyboard on a phone.

### 4.6 Preview

Three tiers, all live:

1. **The canvas itself** — the long-exposure preview, always visible.
2. **A 1D strip bar** — a horizontal bar of `ledCount` cells showing exactly what the
   physical strip displays at the playhead time. This is the honest "what the LEDs
   are doing right now" view.
3. **Play** — animates the playhead in real time at the project fps, driving the 1D
   bar. Play, pause, scrub, loop toggle.

### 4.7 Power estimate

Compute peak and mean current across the whole animation, assuming 20 mA per lit
channel. Display peak prominently. Warn above 2.2 A and offer a one-tap "scale
brightness to fit" that finds the largest global multiplier keeping peak under
budget. This mirrors the firmware's own clamp, so the user sees on screen what the
hardware would silently do to them otherwise.

### 4.8 Device panel

Connect · device name · state · `maxAnimationBytes` · upload with progress bar ·
Play · Stop · master brightness slider · Identify · Disconnect.

Disable Upload when the payload exceeds the reported ceiling, and say by how much.
Surface the `startDelayMs` control here rather than in project settings — it is a
shooting parameter, not a design one.

Handle disconnection mid-upload by returning to a clean state and offering a retry
that restarts the transfer from the beginning.

### 4.9 Persistence

`localStorage`: project list, last-opened project, autosave on change with a debounce.
JSON export and import for a single project, and for the whole library. Version the
JSON schema from day one.

### 4.10 Mobile

Portrait is the primary layout and should be designed first:

```
┌─────────────────────┐
│ project · device    │   compact header
├─────────────────────┤
│                     │
│      canvas         │   ~55% of viewport
│                     │
├─────────────────────┤
│ ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮  │   1D strip preview
├─────────────────────┤
│ ◀ ▶  ═══●═════      │   transport + scrub
├─────────────────────┤
│ Select Point Row Col│   tools
└─────────────────────┘
     ↑ bottom sheet slides over the lower half
```

- Minimum 44 px touch targets throughout.
- No hover-only affordances — everything reachable by tap.
- `touch-action: none` on the canvas so panning doesn't trigger pull-to-refresh.
- Respect `env(safe-area-inset-*)`.
- Landscape and desktop: canvas grows, the bottom sheet becomes a right-hand panel,
  the same components in a different arrangement. Do not build two UIs.

### 4.11 Design direction

**The interface has no accent colour.** Every saturated pixel on screen belongs to
the user's animation. Chrome is neutral — a dark, slightly cool grey scale, with
state carried by weight, border and fill rather than hue. Any brand colour would
compete with the artwork and corrupt the user's read of their own gradient, which
in a colour-editing tool is a functional defect rather than a stylistic preference.
This constraint is the app's signature; hold it everywhere.

Dark by default, and not as a trend: this gets used outdoors at night, and a bright
screen destroys both night vision and the exposure. Include a **night mode** that
drops overall luminance further and shifts chrome toward deep red — genuinely useful
on a shoot, and a natural extension of the same reasoning.

Typography: a technical grotesque for UI, and a monospace for all numerics — LED
indices, frame counts, milliseconds, byte sizes. Numbers in this tool are coordinates,
and tabular figures let the eye compare them down a column. Avoid Inter as the
display face; consider Archivo, Space Grotesk or Basis if available, paired with
JetBrains Mono.

Motion: only where it explains something. The playhead moves, the bottom sheet
slides, upload progress advances. Nothing else animates. Respect
`prefers-reduced-motion`.

Copy: name things by what the user controls. "LED 47" not "index 47". "2.4 s" not
"frame 60". Errors state what happened and what to do — "Animation is 34 KB over the
device limit. Shorten to 4.1 s or drop to 20 fps."

---

## 5. Build order

Each milestone should be independently verifiable, because the failure modes are
hardware and browser quirks that are much easier to isolate one at a time.

| # | Deliverable | Verified by |
|---|---|---|
| M0 | Repo scaffold, `PROTOCOL.md`, both projects building empty | `pio run` and `npm run build` both pass |
| M1 | Firmware: hardcoded rainbow sweep on `GPIO 13`, no BLE | Strip lights up — proves wiring, colour order, power |
| M2 | Firmware: BLE service, upload, CRC, play on BOOT press | A throwaway HTML page that uploads a 2-frame animation |
| M3 | Web: model, interpolation, canvas, keyframe editing, no BLE | Design a gradient, see it render, save and reload it |
| M4 | Web: device panel, real upload, play | Full loop from phone to stick |
| M5 | Power estimate, night mode, undo, export/import, polish | — |

M1 exists specifically to separate "my wiring is wrong" from "my BLE code is wrong".
Do not skip it.

---

## 6. Known constraints and gotchas

**RAM is the ceiling on animation length.** With NimBLE and FastLED, expect roughly
120–160 KB of usable heap. At 432 bytes per frame that is 280–370 frames — about
11–15 seconds at 25 fps. The firmware reports its real figure in `maxAnimationBytes`;
the web app must trust that number over any hardcoded estimate.

**Power bank auto-shutoff will lose the animation.** Many banks cut output below
~50–100 mA, and RAM-only storage means the animation dies with it. The ESP32's own
draw usually prevents this, but if it happens in the field the fix is a keep-alive:
one LED lit at brightness 1. Worth a firmware `#define`. If it becomes a recurring
annoyance, NVS persistence is the real fix — deliberately out of scope for v1.

**3.3 V data into a 5 V strip is out of spec** and works anyway on most hardware. If
LED 0 misbehaves or the strip shows confetti, that is the cause, not the code. Rule
it out before debugging software.

**WS2812B is GRB.** FastLED handles it via the template parameter; the wire format in
§2.1 stays RGB. Don't swap it in two places.

**`GPIO 0` held low at power-on** enters bootloader mode. Expected, documented, still
confusing the first time.

**CH340 on Linux needs `dialout` group membership**, and `brltty` must be removed or
its udev rule disabled — it claims CH340 devices and makes `/dev/ttyUSB0` vanish a
second after appearing. This looks exactly like a dead board.

**Chunk size must derive from the negotiated MTU**, not a constant. MTU negotiation
can fail or land lower than requested; a hardcoded 512 will then silently truncate
every write.
