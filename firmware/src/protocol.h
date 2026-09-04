// Light Painting Stick — shared wire protocol.
//
// MUST stay in sync with web/src/transport/protocol.ts (v2, WiFi relay) and
// web/src/ble/protocol.ts (v1, legacy BLE).
// Authoritative description: PROTOCOL.md.
//
// All multi-byte fields are little-endian.
//
// Two transports converge on one internal representation: the 20-byte upload
// header below. Over BLE it is the wire format. Over the relay, net.cpp builds it
// from the `begin` JSON, so animation.cpp and main.cpp are transport-agnostic.

#pragma once

#include <stdint.h>

// Which transport this build speaks. Set by platformio.ini; the WiFi build is the
// default and the BLE build stays only until the WiFi path is proven on hardware
// (REQUIREMENTS §7, M4).
#ifndef LS_USE_WIFI
#define LS_USE_WIFI 1
#endif

// ---------------------------------------------------------------------------
// Hardware / build configuration (REQUIREMENTS §3.5)
// ---------------------------------------------------------------------------

constexpr uint16_t LED_COUNT = 144;
constexpr uint8_t DATA_PIN = 13;
constexpr uint8_t BUTTON_PIN = 0;  // on-board BOOT button, active low
// LED budget only — FastLED's estimator knows nothing about the ESP32's own
// draw, which is higher with WiFi than it was with BLE (REQUIREMENTS §4.5).
//   PC USB 2.0 port  (500 mA total) -> 250
//   PC USB 3.0 port  (900 mA total) -> 600
//   USB power bank   (5 V 3 A)      -> 2200  <- the value REQUIREMENTS §4.5 mandates
//
// Do not leave a bench value in here. FastLED scales the *whole frame* to fit the
// budget, and it does so per frame, from that frame's own content: at 250 mA an
// all-white frame comes out at brightness 10 of 255 while a dark one is untouched.
// That is an eight-fold, content-dependent brightness swing applied after all the
// browser's gamma and colour work, which is exactly what §2 says must not happen.
constexpr uint16_t MAX_MILLIAMPS = 2200;
constexpr uint8_t DEFAULT_BRIGHTNESS = 80;

// Light LED 0 dim as a state indicator while idle/ready/error.
// Suppressed during startDelayMs and playback so it cannot reach the sensor.
#define STATUS_LED_ENABLED 1

// Many USB power banks cut output below ~50-100 mA and RAM-only storage means
// the animation dies with them. Enable to hold one LED at brightness 1 as a
// keep-alive load. Costs a barely-visible dot in long exposures, so off by
// default (REQUIREMENTS §6).
#define POWER_BANK_KEEPALIVE 0

// ---------------------------------------------------------------------------
// WiFi relay (PROTOCOL.md §2-§6) — the v2 transport
// ---------------------------------------------------------------------------

#define LS_FIRMWARE_VERSION "2.0.0"

// Reported in `hello` and checked on every `begin`. A mismatch is error 0x02.
constexpr uint8_t LS_PROTO_VERSION = 2;

// Chunk size the browser uses (§6). The device never allocates per chunk, but the
// WebSocket library does, so this bounds that.
constexpr size_t LS_RELAY_CHUNK = 4096;

// Exponential backoff on a dropped relay socket, capped (§2).
constexpr uint32_t LS_RECONNECT_MIN_MS = 1000;
constexpr uint32_t LS_RECONNECT_MAX_MS = 30000;

// How often to say "still no relay socket" while the radio is associated.
//
// Polled rather than event-driven, because the library gives us no event for the
// case that matters: a TCP or TLS connect that simply fails calls
// connectFailedCb(), which is a bare DEBUG_WEBSOCKETS and compiles to nothing
// unless DEBUG_ESP_PORT is set. So the most common outage of all — relay process
// down, DNS not answering, port closed — printed absolutely nothing, and an
// orange status LED with a silent log looks exactly like a hung event loop.
constexpr uint32_t LS_RELAY_DOWN_LOG_MS = 10000;

// WebSocket keep-alive, for spotting a half-open socket after a roam.
//
// Suspended entirely while RECEIVING. Everything in the receive path runs inside
// ws.loop(), and a flash block erase stalls it for a second or more, so a
// perfectly healthy stick could not answer a ping in time and hung up on itself
// part-way through a large upload. Arriving bytes are better evidence of a live
// link than a pong is, and LS_TRANSFER_TIMEOUT_MS already catches a dead one —
// sooner than the heartbeat would have.
constexpr uint32_t LS_PING_INTERVAL_MS = 15000;
constexpr uint32_t LS_PONG_TIMEOUT_MS = 6000;
constexpr uint8_t LS_PONG_MISSES = 2;

// ---------------------------------------------------------------------------
// BLE GATT (v1, legacy)
// ---------------------------------------------------------------------------

#define LS_DEVICE_NAME "LightStick"

#define LS_SERVICE_UUID "9a1e0000-1b2c-4d3e-8f90-a1b2c3d4e5f6"
#define LS_CONTROL_UUID "9a1e0001-1b2c-4d3e-8f90-a1b2c3d4e5f6"
#define LS_DATA_UUID "9a1e0002-1b2c-4d3e-8f90-a1b2c3d4e5f6"
#define LS_STATUS_UUID "9a1e0003-1b2c-4d3e-8f90-a1b2c3d4e5f6"

constexpr uint16_t LS_PROTOCOL_VERSION = 1;
constexpr uint16_t LS_REQUESTED_MTU = 517;
constexpr uint16_t LS_MAX_CHUNK = 512;  // chunk size is min(MTU - 3, 512)

// ---------------------------------------------------------------------------
// Control opcodes (§2.3)
// ---------------------------------------------------------------------------

enum Opcode : uint8_t {
  OP_BEGIN_UPLOAD = 0x01,
  OP_PLAY = 0x02,
  OP_STOP = 0x03,
  OP_SET_BRIGHTNESS = 0x04,
  OP_CLEAR = 0x05,
  OP_IDENTIFY = 0x06,
  OP_ABORT_UPLOAD = 0x07,
  // Payload is one byte: the slot index. The stick holds several animations, so
  // playing one is now two decisions rather than one (§2.3).
  OP_SELECT = 0x08,
  OP_DELETE = 0x09,
};

// ---------------------------------------------------------------------------
// Upload header (§2.4) — 20 bytes, little-endian
// ---------------------------------------------------------------------------

constexpr size_t LS_HEADER_SIZE = 20;
constexpr uint32_t LS_MAGIC = 0x3153504C;  // "LPS1"

// The version byte carries whichever protocol version this build speaks, so
// Animation::begin rejects a mismatch as LS_ERR_BAD_HEADER — code 0x02, which both
// PROTOCOL.md and the browser read as "unsupported protocol version".
#if LS_USE_WIFI
constexpr uint8_t LS_VERSION = LS_PROTO_VERSION;
#else
constexpr uint8_t LS_VERSION = 1;
#endif

// Offsets into the header payload.
constexpr size_t HDR_MAGIC = 0;        // u32
constexpr size_t HDR_VERSION = 4;      // u8
constexpr size_t HDR_FLAGS = 5;        // u8
constexpr size_t HDR_LED_COUNT = 6;    // u16
constexpr size_t HDR_FRAME_COUNT = 8;  // u16
constexpr size_t HDR_FPS = 10;         // u16
constexpr size_t HDR_START_DELAY = 12; // u16
constexpr size_t HDR_CRC32 = 14;       // u32
constexpr size_t HDR_RESERVED = 18;    // u16, zero

constexpr uint8_t FLAG_LOOP = 1 << 0;
constexpr uint8_t FLAG_PING_PONG = 1 << 1;
constexpr uint8_t FLAG_AUTOPLAY = 1 << 2;

// ---------------------------------------------------------------------------
// Status notification (§2.5) — 16 bytes, little-endian
// ---------------------------------------------------------------------------

constexpr size_t LS_STATUS_SIZE = 16;

constexpr size_t ST_STATE = 0;          // u8
constexpr size_t ST_ERROR = 1;          // u8
constexpr size_t ST_VERSION = 2;        // u16
constexpr size_t ST_BYTES_RECEIVED = 4; // u32
constexpr size_t ST_BYTES_EXPECTED = 8; // u32
constexpr size_t ST_MAX_BYTES = 12;     // u32

enum DeviceState : uint8_t {
  STATE_IDLE = 0,
  STATE_RECEIVING = 1,
  STATE_READY = 2,
  STATE_PLAYING = 3,
  STATE_ERROR = 4,
};

// ---------------------------------------------------------------------------
// Error codes (PROTOCOL.md §5)
// ---------------------------------------------------------------------------
//
// LS_-prefixed because the WiFi build pulls in lwIP, whose err_enum_t already
// occupies ERR_TIMEOUT and a dozen neighbouring names in the global namespace.
// The numbers, not the names, are the contract.

enum ErrorCode : uint8_t {
  LS_ERR_NONE = 0x00,
  LS_ERR_OUT_OF_MEMORY = 0x01,
  LS_ERR_BAD_HEADER = 0x02,
  LS_ERR_CRC_MISMATCH = 0x03,
  LS_ERR_LED_COUNT_MISMATCH = 0x04,
  LS_ERR_TIMEOUT = 0x05,
  LS_ERR_BAD_STATE = 0x06,
};

// No payload bytes for this long while RECEIVING aborts the transfer (error
// 0x05). The relay's budget is looser than BLE's because a WiFi stall is usually a
// roaming event rather than a dead link.
#if LS_USE_WIFI
constexpr uint32_t LS_TRANSFER_TIMEOUT_MS = 10000;
constexpr uint32_t LS_PROGRESS_INTERVAL_BYTES = 65536;
#else
constexpr uint32_t LS_TRANSFER_TIMEOUT_MS = 5000;
constexpr uint32_t LS_PROGRESS_INTERVAL_BYTES = 4096;
#endif

// ---------------------------------------------------------------------------
// Flash storage (partitions_lightstick.csv)
// ---------------------------------------------------------------------------

// The partition is found by name, so its subtype can stay a private one.
#define LS_ANIMATION_PARTITION "animation"

constexpr uint32_t LS_FLASH_SECTOR = 4096;
// Erase granularity. Erasing a 64 KB block is far cheaper per byte than sixteen
// sector erases, and this is done while a transfer is in flight.
constexpr uint32_t LS_FLASH_BLOCK = 65536;

// How many animations the stick holds. The picker shows one LED per slot at the
// base of the strip, so this also has to leave room for a preview.
constexpr uint8_t LS_MAX_SLOTS = 12;
/** Including the terminator. Long enough to tell two animations apart. */
constexpr size_t LS_SLOT_NAME = 16;

// Representative colours per animation, sampled evenly across the payload, and
// one picker LED each.
//
// One average over a whole animation drifts toward mud, so two quite different
// animations came out the same colour and the marker identified nothing. Three
// samples — start, middle, end — separate a colour cycle from a static wash.
// They are chroma-weighted and normalised; see Animation::finish.
constexpr uint8_t LS_SLOT_COLOURS = 3;

// Dark LEDs between the slot markers and the preview, so the two do not read as
// one picture. Markers themselves are separated by a single dark LED.
constexpr uint16_t LS_PICKER_GAP = 10;
/** Hold BOOT this long to enter or leave the picker. */
constexpr uint32_t LS_LONG_PRESS_MS = 700;
/** Preview frame rate in the picker. */
constexpr uint32_t LS_PICKER_FPS = 20;

// The directory is written to two sectors alternately, newest sequence wins. A
// power cut during a directory write therefore leaves the previous one intact,
// which is what makes an upload atomic.
constexpr uint32_t LS_DIR_A_OFFSET = 0;
constexpr uint32_t LS_DIR_B_OFFSET = LS_FLASH_SECTOR;

// Payloads start on a 64 KB boundary so the bulk of an erase is block-sized.
// Each one is sector-aligned within that, so animations can sit next to each
// other without one erase destroying its neighbour.
constexpr uint32_t LS_PAYLOAD_OFFSET = LS_FLASH_BLOCK;

// "LPS3" — the directory replaced the single record, so an old stick's flash
// must not be mistaken for a new one's.
constexpr uint32_t LS_DIR_MAGIC = 0x3353504C;
// 2: a slot carries LS_SLOT_COLOURS samples instead of one average. A directory
// written by version 1 is ignored rather than misread, so its animations are
// unreachable and have to be uploaded again.
constexpr uint8_t LS_DIR_VERSION = 2;

// Hard ceiling on a single transfer, however steadily bytes arrive. The idle
// timeout above only fires when they stop; a slow trickle could hold RECEIVING
// open forever, and RECEIVING blocks playback and the button.
//
// Proportional to the payload rather than flat. A flat 90 s was a ceiling on
// animation *length* in disguise: now that a 1.7 MB upload is a normal thing to
// do, a perfectly healthy transfer would have been killed for being big.
constexpr uint32_t LS_TRANSFER_GRACE_MS = 20000;
/** Slower than this, sustained, and the transfer is not going to finish. */
constexpr uint32_t LS_TRANSFER_MIN_BYTES_PER_MS = 8;  // 8 kB/s

// How long the radio stays quiet once playback starts (§4.2).
//
// Bounded, because it must be. A looping animation never ends, so an unbounded
// window meant that a socket lost mid-playback could never be re-established:
// the stick played on, unreachable, until somebody pressed BOOT. No exposure
// runs longer than this, and past it an unreachable stick is the worse failure.
constexpr uint32_t LS_QUIESCE_MAX_MS = 60000;

constexpr uint32_t LS_BUTTON_DEBOUNCE_MS = 250;
constexpr uint32_t LS_IDENTIFY_MS = 200;
