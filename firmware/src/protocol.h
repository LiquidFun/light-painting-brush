// Light Painting Stick — shared wire protocol.
//
// MUST stay byte-for-byte in sync with web/src/ble/protocol.ts
// Authoritative description: PROTOCOL.md (extracted from REQUIREMENTS.md §2).
//
// All multi-byte fields on the wire are little-endian.

#pragma once

#include <stdint.h>

// ---------------------------------------------------------------------------
// Hardware / build configuration (REQUIREMENTS §3.5)
// ---------------------------------------------------------------------------

constexpr uint16_t LED_COUNT = 144;
constexpr uint8_t DATA_PIN = 13;
constexpr uint8_t BUTTON_PIN = 0;  // on-board BOOT button, active low
// LED budget only — FastLED's estimator knows nothing about the ESP32's own
// draw (~120 mA average, ~250 mA peak while the BLE radio transmits).
//   PC USB 2.0 port  (500 mA total) -> 250
//   PC USB 3.0 port  (900 mA total) -> 600
//   USB power bank   (5 V 3 A)      -> 2200  <- the value REQUIREMENTS §3.5 mandates
constexpr uint16_t MAX_MILLIAMPS = 250;
constexpr uint8_t DEFAULT_BRIGHTNESS = 80;
constexpr uint32_t HEAP_SAFETY_MARGIN = 24576;

// Light LED 0 dim as a state indicator while idle/ready/error.
// Suppressed during startDelayMs and playback so it cannot reach the sensor.
#define STATUS_LED_ENABLED 1

// Many USB power banks cut output below ~50-100 mA and RAM-only storage means
// the animation dies with them. Enable to hold one LED at brightness 1 as a
// keep-alive load. Costs a barely-visible dot in long exposures, so off by
// default (REQUIREMENTS §6).
#define POWER_BANK_KEEPALIVE 0

// ---------------------------------------------------------------------------
// BLE GATT (§2.2)
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
constexpr uint8_t LS_VERSION = 1;

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
// Error codes (§2.6)
// ---------------------------------------------------------------------------

enum ErrorCode : uint8_t {
  ERR_NONE = 0x00,
  ERR_OUT_OF_MEMORY = 0x01,
  ERR_BAD_HEADER = 0x02,
  ERR_CRC_MISMATCH = 0x03,
  ERR_LED_COUNT_MISMATCH = 0x04,
  ERR_TIMEOUT = 0x05,
  ERR_BAD_STATE = 0x06,
};

// No Data write for this long while RECEIVING aborts the transfer (§2.6 0x05).
constexpr uint32_t LS_TRANSFER_TIMEOUT_MS = 5000;

// Notify upload progress at least this often (§2.5).
constexpr uint32_t LS_PROGRESS_INTERVAL_BYTES = 4096;

constexpr uint32_t LS_BUTTON_DEBOUNCE_MS = 250;
constexpr uint32_t LS_IDENTIFY_MS = 200;
