# Light Painting Stick

A 1 m addressable LED bar for long-exposure light painting. Animations are designed
in a browser, pushed to an ESP32 over Bluetooth LE, held in RAM, and played back on
a button press while the camera shutter is open.

The editor's canvas is a **preview of the photograph**: X is LED index, Y is time.
Sweep the stick sideways at constant speed with the shutter open and the image on
the sensor is the canvas. There is no separate preview mode, because the thing
being edited is the output.

```
web/  ── design, interpolate, gamma-correct ──BLE──▶ firmware/ ── play bytes
```

All interpolation, colour maths and gamma happen in the browser. The firmware is a
dumb player: it receives fully-rendered RGB frames and clocks them out.

| Document | Contents |
|---|---|
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | The contract for the whole project. |
| [`PROTOCOL.md`](PROTOCOL.md) | The BLE wire format. Single source of truth for both halves. |
| [`firmware/README.md`](firmware/README.md) | Build, upload, wiring, hardware gotchas. |

---

## Hardware

| Item | Detail |
|---|---|
| MCU | ESP32-WROOM-32 DevKit (30- or 38-pin), CH340 USB-serial |
| LED strip | WS2812B, 144 LEDs, 1 m, 5 V |
| Data pin | `GPIO 13` |
| Trigger | `GPIO 0` — the on-board **BOOT** button |
| Power | USB power bank, 5 V ~3 A, feeding strip and ESP32 from a common rail |

```
   power bank 5V ─┬──────────────────┬── strip +5V
                  │                  │
                  └── ESP32 5V pin   │
                                     │
   power bank GND ┬──────────────────┴── strip GND
                  └── ESP32 GND          (all grounds common)

   ESP32 GPIO 13 ───────────────────────  strip DIN
   ESP32 GPIO 0  ── on-board BOOT button (nothing to wire)
```

Data is 3.3 V into a 5 V strip. Out of spec, works anyway on most hardware; if LED 0
misbehaves or the strip shows confetti, that is the cause and not the code.

There is **no flash persistence**. The animation lives in RAM and dies with the
power — re-upload before each shot.

---

## Quickstart

### Firmware

```sh
cd firmware
pio run -e m1_selftest -t upload   # rainbow sweep, no BLE — proves the wiring first
pio run -e esp32dev -t upload      # the real firmware
pio device monitor                 # 115200 baud
```

Do the selftest first. It is the only cheap way to tell "my wiring is wrong" from
"my BLE code is wrong".

On Linux you need `dialout` group membership, and `brltty` must be removed or
`/dev/ttyUSB0` will vanish a second after appearing:

```sh
sudo usermod -aG dialout "$USER"   # log out and back in
sudo apt remove brltty
```

### Web app

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # static files in dist/
```

**Web Bluetooth requires a secure context.** `localhost` counts, so development
works out of the box. Anything else must be served over **HTTPS** — if the hosting
does not terminate TLS the app cannot connect at all. To test from a phone, put the
dev server behind an HTTPS tunnel rather than hitting the LAN IP directly.

Browser support is genuinely limited:

| Platform | Connect? |
|---|---|
| Chrome / Edge on Android | Yes |
| Chrome / Edge on Linux, macOS, Windows | Yes |
| Firefox, any platform | No |
| Safari, any platform | No |
| iOS, any browser | No — Bluefy is a third-party workaround |

Where it is unsupported the editor still works completely — design, preview, save,
export — and says so in a dismissible banner. The connection is never a gate.

---

## Shooting

1. Design in the browser. Watch the payload size against the stick's reported ceiling.
2. Connect, set a start delay long enough to steady the stick, upload.
3. Open the shutter (bulb or a few seconds).
4. Press BOOT, or hit Play, and sweep the stick sideways at constant speed.
5. Close the shutter.

Keep the sweep even: uneven speed stretches and squashes the time axis, which is
the same as stretching the canvas.

---

## Layout

```
firmware/
  platformio.ini            two envs: esp32dev, m1_selftest
  src/protocol.h            wire format + config constants
  src/animation.{h,cpp}     payload buffer, header parsing, CRC32
  src/player.{h,cpp}        FastLED output, non-blocking frame schedule
  src/ble_service.{h,cpp}   NimBLE GATT server
  src/main.cpp              state machine
  src/selftest_rainbow.cpp  M1 wiring check
web/
  src/model/                project, keyframes, colour, easing, persistence
  src/render/               field evaluation, payload build, power estimate
  src/ble/                  protocol.ts + Web Bluetooth client
  src/state/                editor state, undo/redo, playhead, field cache
  src/ui/                   components
```

`firmware/src/protocol.h`, `web/src/ble/protocol.ts` and `PROTOCOL.md` describe the
same bytes. A protocol change touches all three in one commit.
