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

Pressing BOOT plays the loaded animation, and pressing it again during playback
stops it.

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
| `src/animation.{h,cpp}` | Flash partition, header parsing, streaming CRC32, boot restore. |
| `partitions_lightstick.csv` | 1.5 MB app (60% used), 2.44 MB animation. No OTA, no SPIFFS. |
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
| `STATUS_LED_ENABLED` | 1 | Set to 0 to guarantee nothing but the animation is ever lit. |
| `POWER_BANK_KEEPALIVE` | 0 | Set to 1 if the power bank keeps cutting out. |
| `LS_PROTO_VERSION` | 2 | Reported in `hello`; a mismatched `begin` is error `0x02`. |
| `LS_RECONNECT_MAX_MS` | 30000 | Cap on the relay reconnect backoff. |

WiFi credentials, relay host and the Basic auth password are in `src/secrets.h`
instead, because they must not be committed.

## Status LED

While idle, LED 0 alone is lit dim (brightness 8):

| Colour | Meaning | Where to look |
|---|---|---|
| magenta | never joined WiFi | SSID, 2.4 GHz vs 5 GHz, hidden network, password |
| orange | on WiFi, but the relay is not answering | relay host, TLS, Basic auth credentials, is the server up |
| blue | idle, or receiving an upload | — |
| green | animation loaded and verified, ready | — |
| red | error | serial log for the code |

Magenta and orange are the important pair: they split "the radio never got on
the network" from "the network is fine and the server is the problem", which are
completely different fixes and used to look identical. Over BLE, orange means
advertising with nothing paired.

It is suppressed for the whole of `startDelayMs` and playback — and then stays
dark after the animation ends, until the next command or BOOT press. A long
exposure outlasts the animation by design, so lighting the dot the moment
playback finishes paints it into the photograph at wherever the stick happened
to be. Any interaction means the shutter is shut, so that is what brings it back.

## Gotchas

**Anything lit on the board itself ends up in the photograph.** The firmware can
suppress LED 0 during an exposure, and does, but it has no reach beyond the
strip. The DevKit's red power LED is wired to the rail rather than to a pin, so
no software can turn it off, and the CH340 usually has an activity LED of its
own. Wrap the board in tape or heatshrink, leaving only the strip and the BOOT
button exposed. The USB shell and the regulator can glint too, so cover the lot
rather than picking off individual LEDs.

**`GPIO 0` held low at power-on enters the serial bootloader.** It is a strapping
pin. If you are holding the BOOT button while plugging in the power bank, the
chip will sit in the bootloader and the strip will stay dark. This is expected,
not a fault: release the button and press `EN`/reset.

**Flash is the ceiling on animation length.** 2.38 MB of payload after the record block,
so 5,764 frames — 3.8 minutes at 25 fps. The real figure is in every `status` as
`maxAnimationBytes`, and the web app trusts it over any local estimate.

Frames are read from flash one at a time during playback. That is safe where
streaming over the network was not: a read is well under a millisecond against a
40 ms frame budget, and flash latency is bounded where network latency is not.

**WiFi radio activity can disturb WS2812 timing.** `Transport::poll()` is told when
the shutter could be open and does nothing that could block during an exposure — no
scan, no TCP connect, no TLS handshake. The animation is already in RAM and needs
no network to play. Test before trusting a shot anyway.

**No network is a supported state.** The stick keeps a loaded animation and keeps
playing it through a dropped socket, and the BOOT button still triggers. Only a
partial transfer is abandoned.

**The animation is stored in flash and survives a power cycle.** The stick comes
up `READY` with the last upload still loaded, so a battery swap does not cost a
re-upload. Its CRC is verified at boot before it is trusted; a failure logs and
leaves the stick `IDLE`.

**Repartitioning wipes it.** Changing `partitions_lightstick.csv` needs
`pio run -t erase` and a fresh upload. Flash wear is not worth worrying about:
one rewrite per upload against 100k cycles is decades.

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
