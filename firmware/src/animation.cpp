#include "animation.h"

#include <Arduino.h>
#include <string.h>

// Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — the same algorithm
// as web/src/ble/protocol.ts crc32().
uint32_t crc32(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
  }
  return ~crc;
}

static uint16_t readU16(const uint8_t* p) {
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t readU32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

uint32_t Animation::maxAnimationBytes() {
  uint32_t largest = ESP.getMaxAllocHeap();
  if (largest <= HEAP_SAFETY_MARGIN) return 0;
  return largest - HEAP_SAFETY_MARGIN;
}

ErrorCode Animation::begin(const uint8_t* header, size_t len) {
  if (len != LS_HEADER_SIZE) return LS_ERR_BAD_HEADER;
  if (readU32(header + HDR_MAGIC) != LS_MAGIC) return LS_ERR_BAD_HEADER;
  if (header[HDR_VERSION] != LS_VERSION) return LS_ERR_BAD_HEADER;

  AnimationHeader h;
  h.flags = header[HDR_FLAGS];
  h.ledCount = readU16(header + HDR_LED_COUNT);
  h.frameCount = readU16(header + HDR_FRAME_COUNT);
  h.fps = readU16(header + HDR_FPS);
  h.startDelayMs = readU16(header + HDR_START_DELAY);
  h.crc32 = readU32(header + HDR_CRC32);

  if (h.ledCount != LED_COUNT) return LS_ERR_LED_COUNT_MISMATCH;
  if (h.frameCount == 0 || h.fps == 0) return LS_ERR_BAD_HEADER;

  uint32_t size = (uint32_t)h.frameCount * h.ledCount * 3u;

  // Free the previous animation before sizing the new one, so the old buffer's
  // memory counts as available (§3.1).
  reset();

  if (size > maxAnimationBytes()) return LS_ERR_OUT_OF_MEMORY;

  // Single allocation of the full payload; no partial fallback (§3.1).
  buffer_ = (uint8_t*)malloc(size);
  if (!buffer_) return LS_ERR_OUT_OF_MEMORY;

  header_ = h;
  expected_ = size;
  received_ = 0;
  return LS_ERR_NONE;
}

bool Animation::append(const uint8_t* data, size_t len) {
  if (!buffer_ || received_ + len > expected_) return false;
  memcpy(buffer_ + received_, data, len);
  received_ += len;
  return true;
}

bool Animation::verifyCrc() const {
  if (!buffer_) return false;
  return crc32(buffer_, expected_) == header_.crc32;
}

void Animation::reset() {
  free(buffer_);
  buffer_ = nullptr;
  expected_ = 0;
  received_ = 0;
  header_ = AnimationHeader();
}

const uint8_t* Animation::frame(uint16_t i) const {
  if (!buffer_ || i >= header_.frameCount) return nullptr;
  return buffer_ + (size_t)i * header_.ledCount * 3u;
}
