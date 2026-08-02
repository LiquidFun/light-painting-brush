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
constexpr uint16_t MAX_MILLIAMPS = 250;
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

// One sector reserved at the front for the record that makes a stored animation
// findable after a reboot. The payload starts after it.
constexpr uint32_t LS_RECORD_OFFSET = 0;
// A whole block, not just a sector: starting the payload on a 64 KB boundary
// means every erase during a transfer is a block erase rather than sixteen
// sector erases. Costs 60 KB of 2.44 MB, and roughly halves the write time.
constexpr uint32_t LS_PAYLOAD_OFFSET = LS_FLASH_BLOCK;

// "LPS2" — bumped from the upload header's magic because this is a different
// structure with a different lifetime, and confusing the two would mean playing
// noise.
constexpr uint32_t LS_RECORD_MAGIC = 0x3253504C;

// How long the radio stays quiet once playback starts (§4.2).
//
// Bounded, because it must be. A looping animation never ends, so an unbounded
// window meant that a socket lost mid-playback could never be re-established:
// the stick played on, unreachable, until somebody pressed BOOT. No exposure
// runs longer than this, and past it an unreachable stick is the worse failure.
constexpr uint32_t LS_QUIESCE_MAX_MS = 60000;

constexpr uint32_t LS_BUTTON_DEBOUNCE_MS = 250;
constexpr uint32_t LS_IDENTIFY_MS = 200;
