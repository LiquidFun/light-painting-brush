# firmware

ESP32-WROOM-32 · FastLED · WiFi. Dials out to the relay described in
`PROTOCOL.md`, receives a fully-rendered animation, holds it in RAM, plays it back
on a trigger.

The firmware is deliberately dumb: no easing, no colour maths, no keyframes. It
plays byte arrays. All of that lives in `web/`.

The device connects *out* to the server rather than listening, which is why there
is no port forwarding, no certificate on the device, and no difference between a
home network and a phone hotspot.

## Build and upload

Credentials are compile-time for the alpha:

```sh
cp src/secrets.example.h src/secrets.h    # then fill in SSIDs, relay host, password
pio run -e esp32dev -t upload
pio device monitor                        # 115200 baud
```

`src/secrets.h` is gitignored. Rotating the relay password means reflashing every
stick, because it is compiled in — the accepted alpha trade-off, and the reason to
move to per-device tokens later.

### The legacy Bluetooth firmware

```sh
pio run -e esp32dev_ble -t upload
```

v1 pushed animations over BLE at ~4 kB/s. It is kept only until the WiFi path has
been flashed and proven on hardware (`REQUIREMENTS.md` §7, M4), then it goes.
Pick "Bluetooth (legacy)" in the editor's device panel to talk to it. Do not
extend it.

### Do M1 first

```sh
pio run -e m1_selftest -t upload
```

`src/selftest_rainbow.cpp` is a rainbow sweep with no networking at all. It exists
to separate "my wiring is wrong" from "my network code is wrong". If the strip does
not light up here, no amount of WiFi debugging will help. You should see a rainbow
scrolling from the base toward the tip, and an all-white pulse every four seconds
that must *not* reset the board.

## Wiring

| ESP32 | Strip / other |
|---|---|
| `GPIO 13` | strip `DIN` |
| `GND` | strip `GND` (and power bank ground — common rail) |
| `5V` | strip `+5V` (both fed from the power bank, not through USB data) |
| `GPIO 0` | on-board **BOOT** button — no external part needed |

Keep the strip's 5 V and ground going straight to the power rail, and tie all
grounds together. Data is 3.3 V into a 5 V strip, which is out of spec and works
anyway on most hardware — see gotchas.

## Layout

| File | Role |
|---|---|
| `src/protocol.h` | Message constants, opcodes, config. Mirror of `web/src/transport/protocol.ts`. |
| `src/transport.h` | One interface in front of both links, so `main.cpp` knows about neither. |
| `src/net.{h,cpp}` | WiFiMulti + WebSocket client. Translates relay JSON into opcode frames. |
| `src/ble_service.{h,cpp}` | Legacy NimBLE GATT server. Transport only. |
| `src/animation.{h,cpp}` | Payload buffer, header parsing, CRC32. Knows nothing about links or LEDs. |
| `src/player.{h,cpp}` | FastLED output, non-blocking frame schedule, status LED, identify flash. |
| `src/main.cpp` | State machine: `IDLE → RECEIVING → READY → PLAYING → READY`. |
| `src/secrets.example.h` | Template for the gitignored `src/secrets.h`. |

Both transports converge on the 20-byte upload header in `protocol.h`: over BLE it
is the wire format, and `net.cpp` builds it from the `begin` JSON. That is why
`animation.cpp` and `main.cpp` contain no transport code at all.

Protocol changes must land in `src/protocol.h`, `web/src/transport/protocol.ts`,
`server/src/protocol.ts` and `PROTOCOL.md` in the same commit.

## Configuration

All in `src/protocol.h`:

| Constant | Default | Notes |
|---|---|---|
| `LED_COUNT` | 144 | A mismatch with the uploaded header is error `0x04`. |
| `DATA_PIN` | 13 | |
| `BUTTON_PIN` | 0 | On-board BOOT button. |
| `MAX_MILLIAMPS` | 250 | LED budget only. 250 = PC USB 2.0 port, 600 = USB 3.0, 2200 = 5 V 3 A power bank (the shooting value). |
| `DEFAULT_BRIGHTNESS` | 80 | Master brightness at boot. |
| `HEAP_SAFETY_MARGIN` | 24576 | Subtracted from the largest free block to get `maxAnimationBytes`. |
| `STATUS_LED_ENABLED` | 1 | Set to 0 to guarantee nothing but the animation is ever lit. |
| `POWER_BANK_KEEPALIVE` | 0 | Set to 1 if the power bank keeps cutting out. |
| `LS_PROTO_VERSION` | 2 | Reported in `hello`; a mismatched `begin` is error `0x02`. |
| `LS_RECONNECT_MAX_MS` | 30000 | Cap on the relay reconnect backoff. |

WiFi credentials, relay host and the Basic auth password are in `src/secrets.h`
instead, because they must not be committed.

## Status LED

While idle, LED 0 alone is lit dim (brightness 8):

| Colour | Meaning |
|---|---|
| orange | no relay connection — the stick is fine, the network is not |
| blue | idle or receiving |
| green | animation loaded, ready |
| red | error — read the serial log for the code |

It is suppressed for the whole of `startDelayMs` and playback, so it cannot end
up in the photograph.

## Gotchas

**`GPIO 0` held low at power-on enters the serial bootloader.** It is a strapping
pin. If you are holding the BOOT button while plugging in the power bank, the
chip will sit in the bootloader and the strip will stay dark. This is expected,
not a fault: release the button and press `EN`/reset.

**RAM is the ceiling on animation length, and WiFi does not change that.** Expect
roughly 120–200 KB usable. At 432 bytes per frame that is about 11–18 s at 25 fps.
The real figure is reported in every `status` as `maxAnimationBytes`; the web app
trusts it over any local estimate. A module with PSRAM (ESP32-WROVER) is the fix
for minutes-long animations; streaming was rejected because a late frame stretches
the time axis of the photograph.

**WiFi radio activity can disturb WS2812 timing.** `Transport::poll()` is told when
the shutter could be open and does nothing that could block during an exposure — no
scan, no TCP connect, no TLS handshake. The animation is already in RAM and needs
no network to play. Test before trusting a shot anyway.

**No network is a supported state.** The stick keeps a loaded animation and keeps
playing it through a dropped socket, and the BOOT button still triggers. Only a
partial transfer is abandoned.

**There is no flash persistence.** The animation dies with the power. This is
intentional — re-upload before each shot.

**Power bank auto-shutoff.** Many banks cut output below ~50–100 mA. The ESP32's
own draw usually prevents it; if it happens, build with
`POWER_BANK_KEEPALIVE 1` to hold one LED at brightness 1 as a load.

**3.3 V data into a 5 V strip.** If LED 0 misbehaves or the strip shows
confetti, that is the cause, not the code. Rule it out before debugging software.

**CH340 on Linux.** You need `dialout` group membership:

```sh
sudo usermod -aG dialout "$USER"   # then log out and back in
```

and `brltty` must go, or `/dev/ttyUSB0` will appear and vanish a second later,
which looks exactly like a dead board:

```sh
sudo apt remove brltty
```
