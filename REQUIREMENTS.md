# Light Painting Stick — Requirements

A 1 m addressable LED bar for long-exposure light painting. Animations are designed
in a browser, sent to an ESP32 over WiFi, held in RAM, and played back while the
camera shutter is open.

This document is the contract between the three parts of the system. Sections 1–3
are binding for all of them; sections 4–6 are per-part.

> **v2.** v1 pushed animations from the browser over Bluetooth LE. That worked, but
> it was Chrome-only, required re-pairing before every shot, could only serve one
> person at a time, and topped out at ~4 kB/s — a 5 s animation took 14 s to send.
> The BLE implementation is in git history at the initial commit and its wire format
> is preserved in `PROTOCOL.md` history. Do not extend it.

---

## 0. Hardware target

| Item | Detail |
|---|---|
| MCU | ESP32-WROOM-32 (classic dual-core Xtensa), 30- or 38-pin DevKit board, CH340 USB-serial |
| LED strip | BTF-LIGHTING WS2812B, 144 LEDs, 1 m, 5 V, single data line |
| Data pin | `GPIO 13` |
| Trigger button | `GPIO 0` — the on-board **BOOT** button |
| Power | USB power bank, 5 V, ~3 A, feeding both strip and ESP32 `5V` pin from a common rail |
| Host OS | Linux (Ubuntu-family) for development |

There is **no flash persistence** on the device. The animation lives in RAM and is
lost on power cycle. The library lives on the server instead, so this costs a
re-upload rather than the work.

**RAM is the ceiling on animation length**, and WiFi does not change that. At 432
bytes per frame the WROOM's usable heap holds roughly 460 frames: 18 s at 25 fps,
30 s at 15 fps. A module with PSRAM (ESP32-WROVER) raises this to minutes and is the
correct fix when animations need to be longer than that. Streaming (§3.6) is the
alternative and is deliberately deferred — it makes network jitter visible in the
photograph.

---

## 1. System shape

Three parts, and the split is forced rather than chosen:

```
   browser  ──wss──▶  server  ◀──wss──  ESP32
   (SPA)              (relay)           (device)
```

A page served over HTTPS **cannot** open a connection directly to an ESP32 on the
local network: `ws://` from an HTTPS origin is blocked as mixed content, `wss://`
would need a certificate the device cannot have, and Chrome's Private Network Access
rules block HTTPS→private-IP regardless. So a hosted SPA must reach the device
through the server. This is not a design preference; there is no flag-free way
around it.

The device therefore **dials out** to the server rather than listening. That also
means no port forwarding, and it works identically on a home network and a phone
hotspot.

Consequences to accept knowingly:

- **No internet, no shooting.** The SPA and the relay are both remote. This is
  accepted for the alpha on the basis that shoots happen in populated areas. The
  escape hatch, if it ever becomes necessary, is the device serving its own copy of
  the UI over SoftAP — a *separate origin*, not a fallback path in the hosted app.
- **The server is a single point of failure.** If it is down, nothing works.

---

## 2. Repo layout

```
lightstick/
├── README.md              # setup for all three parts, wiring diagram, quickstart
├── REQUIREMENTS.md        # this file
├── PROTOCOL.md            # extracted copy of §3, the single source of truth
├── firmware/
│   ├── platformio.ini
│   ├── src/
│   │   ├── main.cpp
│   │   ├── protocol.h     # shared constants — must match web/src/transport/protocol.ts
│   │   ├── net.{h,cpp}    # WiFi provisioning + WebSocket client
│   │   ├── animation.{h,cpp}
│   │   └── player.{h,cpp}
│   └── README.md
├── server/                # relay + static hosting + project library
│   ├── src/
│   └── README.md
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── model/         # project, keyframes, layers, pure types
        ├── render/        # field evaluation → frame buffer
        ├── transport/     # WebSocket client + protocol.ts
        ├── ui/            # components
        └── main.tsx
```

**Use PlatformIO, not the Arduino IDE.** It builds from the CLI, pins library
versions in `platformio.ini`, and lives in the repo as text.

`firmware/src/protocol.h`, `web/src/transport/protocol.ts` and `PROTOCOL.md` describe
the same messages. A protocol change touches all three in one commit.

---

## 3. Shared contract

### 3.1 Animation payload

Unchanged from v1, and deliberately so. An animation is a flat array of
fully-rendered RGB frames. **All interpolation happens in the browser.** The
firmware is a dumb player — no easing, no colour maths, no keyframe evaluation.

```
payload = frame[0] .. frame[frameCount-1]
frame   = led[0] .. led[ledCount-1]
led     = u8 R, u8 G, u8 B      # RGB order on the wire; firmware maps to GRB
```

Payload size is `frameCount × ledCount × 3`. At 144 LEDs that is 432 bytes per frame.

### 3.2 Connections

Both sides open a WebSocket to the server over TLS. Authentication is HTTP Basic,
enforced by Caddy in front of the application, with one shared password.

| Endpoint | Who | Notes |
|---|---|---|
| `wss://<host>/ws/device` | ESP32 | Credentials compiled into the firmware |
| `wss://<host>/ws/client` | Browser | Credentials supplied by the browser's Basic auth prompt |

The device reconnects with exponential backoff, capped at 30 s. Losing the socket
must not disturb an animation already loaded in RAM, and must not stop playback in
progress.

### 3.3 Message framing

Control messages are **JSON text frames**. Payload bytes are **binary frames**.
WebSocket already distinguishes them, so there is no envelope to parse.

Every JSON message has a `t` field naming the type. `proto` carries the protocol
version — `2` — and is what makes error `2` below reachable.

**Device → server**

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `proto`, `deviceId`, `name`, `ledCount`, `maxAnimationBytes`, `fw` | Sent immediately on connect |
| `status` | `state`, `error`, `bytesReceived`, `bytesExpected`, `maxAnimationBytes` | On every state change, and every ~64 KB while receiving |

**Client → server**

| `t` | Fields | Meaning |
|---|---|---|
| `subscribe` | — | Begin receiving `devices` and `status` |
| `begin` | `proto`, `deviceId`, `ledCount`, `frameCount`, `fps`, `startDelayMs`, `loop`, `pingPong`, `autoPlay`, `bytes`, `crc32` | Followed by binary frames totalling `bytes` |
| `play` / `stop` / `clear` / `identify` | `deviceId` | |
| `brightness` | `deviceId`, `value` (0–255) | |

**Server → client**

| `t` | Fields | Meaning |
|---|---|---|
| `devices` | array of `hello` payloads plus `online` | Sent on subscribe and whenever the set changes |
| `status` | `deviceId` plus the device's `status` fields | Broadcast to all subscribed clients |
| `error` | `message` | Human-readable, safe to display verbatim |

### 3.4 Device states

`IDLE` → `RECEIVING` → `READY` → `PLAYING` → `READY`

| Code | State |
|---|---|
| `0` | idle — no animation in RAM |
| `1` | receiving |
| `2` | ready — animation loaded and verified |
| `3` | playing |
| `4` | error |

### 3.5 Errors

| Code | Meaning |
|---|---|
| `0` | none |
| `1` | out of memory — payload exceeds `maxAnimationBytes` |
| `2` | unsupported protocol version |
| `3` | CRC mismatch |
| `4` | `ledCount` mismatch with firmware build |
| `5` | transfer timeout (no data for 10 s while `RECEIVING`) |
| `6` | unexpected message for current state |

### 3.6 Transfer

```
client                server                 esp32
  |-- begin --------->|-- begin ------------->|  allocate; status RECEIVING or error
  |                   |<----- status ---------|
  |-- binary chunk -->|-- binary chunk ------>|
  |   ...             |   ...                 |  status every ~64 KB
  |-- binary chunk -->|-- binary chunk ------>|  all bytes in → verify crc32
  |                   |<----- status ---------|  READY, or ERROR 3
  |-- play ---------->|-- play -------------->|
```

The server relays binary frames without buffering the whole payload; it must
stream, because a 460-frame animation is 200 KB and there may be several clients.

Chunk size is **4 KB**, chosen so the ESP32 never has to hold a large frame in
addition to the animation buffer. TCP already guarantees ordering and integrity;
the `crc32` is an end-to-end check against bugs, not against the network.

Deliberately absent: chunk acknowledgement, credit schemes, retransmission. TCP does
this. v1's per-chunk round trip is exactly what made it slow.

**Streaming playback is not in scope.** The design, if it is ever needed, is a ring
buffer on the device, a prebuffer threshold before playback starts, and a buffer-level
field in `status` so the sender can keep it topped up. The reason to avoid it is that
a late frame during a 30-second exposure stretches the time axis of the photograph in
exactly the way an uneven sweep does.

### 3.7 Multiple users

Any subscribed client may upload to, or play, any online device at any time. There is
no lock and no ownership. Users are assumed cooperative and co-located — they can see
each other and the stick.

The server broadcasts `status` for every device to every client, so a second person
uploading is visible rather than silent. A `begin` arriving while a device is
`RECEIVING` cancels the transfer in progress; the interrupted client sees the state
change and can retry.

---

## 4. `firmware/`

### 4.1 Behaviour

- On boot: init FastLED, blank the strip, join WiFi, connect to the relay.
- Accept exactly **one** animation at a time. A new `begin` replaces the previous one
  — free the old buffer before allocating the new one.
- Allocate with a single `malloc`/`heap_caps_malloc` of the full payload. If it
  fails, report error `1` and stay `IDLE`; do not attempt partial allocation.
- **Trigger sources**, all equivalent: `play` from the relay, a press of the BOOT
  button on `GPIO 0`, or upload completion when `autoPlay` is set.
- Playback: honour `startDelayMs`, then step frames on a `micros()` schedule derived
  from `fps`. Never use `delay()` — a non-blocking timer in `loop()` keeps the socket
  and the button responsive.
- Respect `loop` and `pingPong`. When neither is set, blank the strip on completion
  and return to `READY`.
- A second `play` during playback restarts from frame 0. The BOOT button instead
  **toggles**: pressing it during playback stops. Restarting from frame 0 there is
  useless, because a hand is already on the stick and the restart only smears the
  exposure. `stop` blanks and returns to `READY` with the buffer intact.

### 4.2 Networking

`WiFiMulti` with several stored SSIDs, tried in order, so the same firmware joins the
home network or a phone hotspot without reflashing. Credentials, relay host and the
Basic auth password live in `secrets.h`, which is **gitignored**; commit a
`secrets.example.h`.

Provisioning is compile-time for the alpha. A captive portal is the right answer once
more than one person owns a stick, and is out of scope until then.

The radio must not disturb playback. If WiFi activity proves to cause visible
glitches on the strip, the fix is to quiesce the radio for the duration of the
exposure — the animation is already in RAM and needs no network to play.

### 4.3 Button handling

`GPIO 0` with `INPUT_PULLUP`, active low, 250 ms debounce via `millis()`.

`GPIO 0` is a strapping pin: held low at power-on it puts the chip into bootloader
mode. Harmless here, but comment it in the code and note it in the firmware README,
because it looks exactly like a fault.

### 4.4 Status LED

When idle and not playing, light **LED 0 only**, dim (brightness ≤ 8): blue = idle,
green = ready, red = error, and a distinct colour for "no network". Suppressed
entirely during playback and during `startDelayMs`, or it appears in the photograph.
Compile-time toggle via `#define STATUS_LED_ENABLED`.

### 4.5 Power safety

```cpp
FastLED.setMaxPowerInVoltsAndMilliamps(5, MAX_MILLIAMPS);
```

Non-negotiable. FastLED scales brightness down on any frame that would exceed the
budget, which makes it impossible for an all-white frame to brown out the board
mid-exposure.

`MAX_MILLIAMPS` is `2200` for a 5 V 3 A power bank. Lower it for bench work off a PC
USB port — 250 for USB 2.0, 600 for USB 3.0 — and restore it before shooting. The
figure covers the LEDs only; FastLED knows nothing about the ESP32's own draw, which
is higher with WiFi than it was with BLE.

### 4.6 Config constants

Top of `protocol.h`, all `constexpr`: `LED_COUNT = 144`, `DATA_PIN = 13`,
`BUTTON_PIN = 0`, `MAX_MILLIAMPS`, `DEFAULT_BRIGHTNESS = 80`,
`HEAP_SAFETY_MARGIN = 24576`.

### 4.7 Serial logging

State transitions, WiFi and socket events, upload progress, CRC results and free heap
at 115200 baud.

Note for anyone debugging: the serial monitor holds `/dev/ttyUSB*` exclusively, so
`pio run -t upload` fails while it is open. The ESP32 ROM bootloader prints at 74880
baud and looks like garbage at 115200 — that first unreadable line is expected.

---

## 5. `server/`

Small and boring on purpose. Three jobs:

1. **Serve the SPA** as static files.
2. **Relay** between clients and devices, per §3. Stream binary frames; do not buffer
   whole payloads.
3. **Store the project library** — the same JSON the editor already exports.

### 5.1 Library storage

`GET /api/projects`, `PUT /api/projects/:id`, `DELETE /api/projects/:id`. The schema
is the versioned export format the editor already uses, so files remain
interchangeable with local export/import.

**There are no user accounts.** One shared Basic auth password means one shared
library: everyone who can log in sees and can edit everyone's projects. This is a
consequence of the auth choice, acceptable among friends, and the thing to revisit
first if the audience widens.

Storage is a directory of JSON files. A database is not warranted.

### 5.2 Deployment

Caddy terminates TLS and enforces Basic auth for every route, including both
WebSocket endpoints. The application never sees an unauthenticated request and
implements no auth of its own.

Rotating the password requires reflashing every device, since it is compiled in.
Acceptable at one device; the reason to move to per-device tokens later.

---

## 6. `web/`

### 6.1 Stack

Vite + React + TypeScript + Tailwind, served as static files by the server.

Web Bluetooth is gone, and with it the browser restriction. **Every modern browser
works, including Safari and iOS.** Removing the compatibility banner is part of the
migration, not a follow-up.

The editor must remain fully usable with no device connected and no device ever
selected. Designing, previewing, saving and exporting are never gated behind
hardware.

### 6.2 Data model

```ts
type Project = {
  id: string
  name: string
  ledCount: number          // 144
  durationMs: number        // default 5000
  fps: number               // 25 default; any integer 5-60
  background: Color         // default black — what the field decays toward
  colorSpace: 'oklab' | 'srgb' | 'hsv-short' | 'hsv-long'
  falloffPower: number      // IDW exponent, 0.5–6, default 2
  layers: Layer[]           // bottom to top
  playback: { loop: boolean; pingPong: boolean; startDelayMs: number }
  updatedAt: number
}

type Layer =
  | { id: string; kind: 'keyframes'; opacity: number; blend: BlendMode; keyframes: Keyframe[] }
  | { id: string; kind: 'image';     opacity: number; blend: BlendMode; src: string; fit: 'stretch' | 'contain' | 'cover' }
  | { id: string; kind: 'pattern';   opacity: number; blend: BlendMode; pattern: Pattern }

type Keyframe = {
  id: string
  kind: 'point' | 'row' | 'column'
  led: number               // 0..ledCount-1   — used by 'point' and 'column'
  timeMs: number            // 0..durationMs   — used by 'point' and 'row'
  color: Color
  brightness: number        // 0..1, interpolated as its own scalar field
  radius: number            // 0..1, normalised influence radius; default 0.35
  easing: EasingName
  hard: boolean             // true = nearest-neighbour within radius, hard edge
}
```

**Layers are new and they are the reason the other new tools are possible.** v1 had a
single inverse-distance field, which is the right model for soft washes and the wrong
one for stripes, waves and images — none of which are expressible as scattered
keyframes. Adding generators to the existing field would have meant special-casing
the evaluator for every new tool. A layer stack keeps each generator independent and
composable, and the existing keyframe field becomes one layer kind among several.

Migration: a v1 project loads as a single `keyframes` layer. The storage schema
version increments and `sanitiseProject` handles the upgrade.

### 6.3 The canvas — this is the product

A 2D field. **X is LED index** — left is LED 0 at the base of the stick, right is
LED 143 at the tip. **Y is time** — top is t=0, downward is later.

The single most important property of this design, and it should be stated in the
UI: **the canvas is a preview of the photograph.** Sweep the stick sideways at
constant speed with the shutter open and the image on the sensor is this canvas.
Editing and previewing are the same view. Do not bury this behind a separate
"preview" mode — the thing being edited *is* the output.

Render by evaluating the composited layer stack into an `ImageData` of
`ledCount × frameCount` and `putImageData` onto a canvas scaled to fit. Debounce
re-renders to animation frames. Longer animations make this heavier than v1; move
evaluation to a Web Worker before reaching for WebGL.

Overlaid: keyframe handles in the gutters (points are circles, rows a horizontal line
with a left-gutter handle, columns a vertical line with a top-gutter handle), a
draggable playhead, and rulers — LED index along the top, seconds down the left.

### 6.4 Interpolation

Within a `keyframes` layer, for each cell `(x, y)` normalise to
`u = x/(ledCount-1)`, `v = timeMs/durationMs`, both in `[0,1]`. Distance:

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
small constant weight so regions outside every radius decay to background rather than
being colonised by the nearest distant keyframe. Brightness interpolates as a separate
scalar field using the same weights.

Where `hard` is set, that keyframe wins outright inside its radius instead of
blending — the only way to get a crisp edge out of a distance field.

**Interpolate colour in OKLab by default.** Naive sRGB interpolation between
complementary colours passes through grey, which looks like a bug in a light-painting
tool. Offer `hsv-short` for rainbow sweeps and `hsv-long` for full hue rotations, and
keep `srgb` available so the difference is visible and learnable.

Easings: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `smoothstep`, `step`.

Apply **gamma correction (γ ≈ 2.2) at the very end**, after compositing and
immediately before quantising to `u8`. Interpolate in perceptual space, output in
LED-linear space. Getting this backwards makes every gradient bunch up at one end.

### 6.5 Pattern layers

Each pattern is a pure function of `(u, v)` returning colour and brightness, so it
costs nothing to add another.

| Pattern | Parameters |
|---|---|
| `stripes` | axis (LED or time), period, duty, two colours, edge softness |
| `wave` | axis, wavelength, amplitude, phase, speed, colour ramp |
| `gradient` | angle, colour stops |
| `noise` | scale, speed, colour ramp |
| `solid` | colour |

Colour ramps interpolate in the project's colour space, like everything else.

### 6.6 Image layers

Import a bitmap and map it onto `ledCount × frameCount`. The image's X becomes LED
index and its Y becomes time, which means **the imported picture is what the
photograph will look like** — the same promise the canvas makes.

- Resample with area averaging, not nearest neighbour; the target is usually much
  smaller than the source and nearest neighbour aliases badly.
- Decode as sRGB and convert to the working space before compositing. Do not feed
  gamma-encoded bytes into the field.
- Offer `stretch`, `contain` and `cover` fitting.
- Store the image in the project as a data URL so a project remains one
  self-contained JSON file, and warn when this makes the file large.

### 6.7 Interaction

A segmented tool selector: **Select · Point · Row · Column**, plus a layer list for
adding pattern and image layers.

| Gesture | Result |
|---|---|
| Tap canvas with a create tool active | Add keyframe of that kind, select it, open the editor sheet |
| Tap a handle | Select, open the editor sheet |
| Drag a handle | Move. Points move in both axes; rows only in time; columns only in LED index |
| Long-press a handle | Context menu — duplicate, delete, copy colour |
| Pinch | Zoom |
| Two-finger drag | Pan |
| Tap empty space with Select active | Deselect |

The editor is a **bottom sheet**, not a sidebar or modal — thumb-reachable on a
phone, and it must not cover the canvas region being edited.

Undo/redo with a bounded history stack. Bind `Ctrl/Cmd+Z` and expose visible buttons,
because there is no keyboard on a phone.

### 6.8 Preview

Three tiers, all live: the canvas itself; a 1D strip bar showing exactly what the
physical strip displays at the playhead time; and play, which animates the playhead
at the project fps and drives the bar.

### 6.9 Power estimate

Peak and mean current across the whole animation at 20 mA per lit channel. Display
peak prominently, warn above the device's configured budget, and offer a one-tap
"scale brightness to fit". This mirrors the firmware's own clamp, so the user sees on
screen what the hardware would otherwise do to them silently.

### 6.10 Device panel

A **list** of devices reported by the relay, not a connect button: name, online
state, current device state, `maxAnimationBytes`. Selecting one targets it.

Per device: upload with progress, Play, Stop, Identify, master brightness,
`startDelayMs`. Disable Upload when the payload exceeds the reported ceiling and say
by how much.

Because any client may act at any time (§3.7), the panel reflects broadcast state
rather than local assumption: a device may enter `RECEIVING` because somebody else
started an upload, and the UI must show that rather than contradict it.

Show measured upload throughput after each transfer. v1 shipped without it and the
resulting performance problem took a full debugging session to characterise.

### 6.11 Persistence

Server-side library per §5.1, with `localStorage` as an offline cache and for
last-opened state. JSON export and import for a single project and for the whole
library. Version the schema.

### 6.12 Mobile

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
- No hover-only affordances.
- `touch-action: none` on the canvas so panning doesn't trigger pull-to-refresh.
- Respect `env(safe-area-inset-*)`.
- Landscape and desktop: canvas grows, the bottom sheet becomes a right-hand panel,
  the same components rearranged. Do not build two UIs.

### 6.13 Design direction

**The interface has no accent colour.** Every saturated pixel on screen belongs to
the user's animation. Chrome is neutral — a dark, slightly cool grey scale, with
state carried by weight, border and fill rather than hue. Any brand colour would
compete with the artwork and corrupt the user's read of their own gradient, which in
a colour-editing tool is a functional defect rather than a stylistic preference. This
constraint is the app's signature; hold it everywhere.

Dark by default, and not as a trend: this gets used outdoors at night, and a bright
screen destroys both night vision and the exposure. Include a **night mode** that
drops luminance further and shifts chrome toward deep red.

Typography: a technical grotesque for UI, monospace for all numerics — LED indices,
frame counts, milliseconds, byte sizes. Numbers here are coordinates, and tabular
figures let the eye compare them down a column.

Motion: only where it explains something. The playhead moves, the sheet slides,
progress advances. Nothing else animates. Respect `prefers-reduced-motion`.

Copy: name things by what the user controls. "LED 47" not "index 47". "2.4 s" not
"frame 60". Errors state what happened and what to do — "Animation is 34 KB over the
device limit. Shorten to 4.1 s or drop to 20 fps."

---

## 7. Build order

Each milestone independently verifiable. The ordering puts the transport-independent
features first, because they carry none of the migration risk and deliver most of the
value — and they keep working if the migration stalls.

| # | Deliverable | Verified by |
|---|---|---|
| M0 | Layer model, v1 project migration | Existing projects load unchanged as one keyframe layer |
| M1 | Pattern layers — stripes, wave, gradient | Design a striped sweep with no keyframes |
| M2 | Image layers | Import a photo, see it on the canvas and the strip bar |
| M3 | `server/`: static hosting, Caddy Basic auth, project library API | Save on desktop, open on phone |
| M4 | `server/`: relay; `web/`: transport swap behind an interface | Device list appears; BLE code deleted |
| M5 | Firmware: WiFi + WebSocket client, upload, CRC, play | Full loop from phone to stick over WiFi |
| M6 | Throughput measurement, longer durations, power/night polish | Measured upload rate shown in the UI |

Keep the BLE transport working until M4 lands. Put a `Transport` interface in front
of it at M4 rather than editing call sites twice, and delete BLE only once WiFi
carries a real upload.

M5 needs a wiring sanity check to remain available: keep the `m1_selftest`
environment that lights a rainbow with no networking at all. It is the only cheap way
to tell "my wiring is wrong" from "my network code is wrong".

---

## 8. Known constraints and gotchas

**RAM is the ceiling on animation length.** Roughly 460 frames on a WROOM — 18 s at
25 fps. The firmware reports its real figure in `maxAnimationBytes`; the web app must
trust that number over any local estimate. PSRAM is the fix for minutes-long
animations.

**Compression is available if the wire ever becomes the constraint again.** Measured
on real payloads: deflate gives 8.3× on a 5 s animation and 16.8× on a 20 s one;
frame-to-frame delta plus deflate gives 9.6× and 29.4×. It does **not** extend
animation length, because the device must hold the decompressed frames to play them.
On WiFi it is unlikely to be needed.

**3.3 V data into a 5 V strip is out of spec** and works anyway on most hardware. If
LED 0 misbehaves or the strip shows confetti, that is the cause, not the code.

**WS2812B is GRB.** FastLED handles it via the template parameter; the wire format in
§3.1 stays RGB. Don't swap it in two places.

**`GPIO 0` held low at power-on** enters bootloader mode. Expected, documented, still
confusing the first time.

**CH340 on Linux needs `dialout` group membership**, and `brltty` must be removed or
its udev rule disabled — it claims CH340 devices and makes `/dev/ttyUSB0` vanish a
second after appearing. This looks exactly like a dead board.

**Power bank auto-shutoff will lose the animation.** Many banks cut output below
~50–100 mA. The ESP32's own draw usually prevents it, and WiFi makes that draw
higher, so this is less likely than it was with BLE.

**WiFi radio activity can disturb WS2812 timing.** Test before trusting a shot.

---

## 9. Out of scope for the alpha

Recorded here so they are decisions rather than omissions:

- **SoftAP offline mode.** Accepted risk: no internet means no shooting.
- **Per-user accounts.** One shared password, one shared library.
- **Session locks.** Users are assumed cooperative.
- **Per-device tokens.** One password compiled into every stick.
- **Streaming playback.** Deferred in favour of PSRAM (§0).
- **Runtime WiFi provisioning.** Credentials are compile-time.
- **Compression.** Unnecessary at WiFi speeds.
