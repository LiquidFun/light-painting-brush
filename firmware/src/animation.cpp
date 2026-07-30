#include "animation.h"

#include <Arduino.h>
#include <esp_partition.h>
#include <string.h>

// Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — the same algorithm
// as crc32() in web/src/transport/protocol.ts.
uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
  }
  return crc;
}

uint32_t crc32(const uint8_t* data, size_t len) {
  return ~crc32Update(0xFFFFFFFFu, data, len);
}

namespace {

const esp_partition_t* part(const void* p) {
  return static_cast<const esp_partition_t*>(p);
}

uint16_t readU16(const uint8_t* p) {
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

uint32_t readU32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

void writeU16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)(v >> 8);
}

void writeU32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}

// The record that survives a reboot. It carries its own CRC because a write torn
// by a power cut could otherwise look plausible and send the player into
// unerased flash.
constexpr size_t REC_SIZE = 32;
constexpr size_t REC_MAGIC = 0;         // u32
constexpr size_t REC_VERSION = 4;       // u8
constexpr size_t REC_FLAGS = 5;         // u8
constexpr size_t REC_LED_COUNT = 6;     // u16
constexpr size_t REC_FRAME_COUNT = 8;   // u16
constexpr size_t REC_FPS = 10;          // u16
constexpr size_t REC_START_DELAY = 12;  // u16
constexpr size_t REC_CRC32 = 16;        // u32, of the payload
constexpr size_t REC_BYTES = 20;        // u32
constexpr size_t REC_SELF_CRC = 24;     // u32, of bytes 0..23

}  // namespace

bool Animation::mount() {
  partition_ = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                        ESP_PARTITION_SUBTYPE_ANY,
                                        LS_ANIMATION_PARTITION);
  if (!partition_) {
    Serial.println("[flash] no '" LS_ANIMATION_PARTITION "' partition. Is the board "
                   "flashed with partitions_lightstick.csv?");
    return false;
  }
  Serial.printf("[flash] %s: %u bytes at 0x%06X\n", LS_ANIMATION_PARTITION,
                (unsigned)part(partition_)->size, (unsigned)part(partition_)->address);
  return true;
}

uint32_t Animation::maxAnimationBytes() const {
  if (!partition_) return 0;
  return part(partition_)->size - LS_PAYLOAD_OFFSET;
}

bool Animation::restore() {
  loaded_ = false;
  if (!partition_) return false;

  uint8_t rec[REC_SIZE];
  if (esp_partition_read(part(partition_), LS_RECORD_OFFSET, rec, sizeof(rec)) != ESP_OK) {
    return false;
  }
  if (readU32(rec + REC_MAGIC) != LS_RECORD_MAGIC) return false;
  if (crc32(rec, REC_SELF_CRC) != readU32(rec + REC_SELF_CRC)) {
    Serial.println("[flash] stored record is corrupt, ignoring");
    return false;
  }
  if (rec[REC_VERSION] != LS_VERSION) {
    Serial.println("[flash] stored animation is a different protocol version");
    return false;
  }

  AnimationHeader h;
  h.flags = rec[REC_FLAGS];
  h.ledCount = readU16(rec + REC_LED_COUNT);
  h.frameCount = readU16(rec + REC_FRAME_COUNT);
  h.fps = readU16(rec + REC_FPS);
  h.startDelayMs = readU16(rec + REC_START_DELAY);
  h.crc32 = readU32(rec + REC_CRC32);
  const uint32_t bytes = readU32(rec + REC_BYTES);

  if (h.ledCount != LED_COUNT || h.frameCount == 0 || h.fps == 0) return false;
  if (bytes != (uint32_t)h.frameCount * h.ledCount * 3u) return false;
  if (bytes > maxAnimationBytes()) return false;

  // Verify before trusting it. A pass over 2.4 MB of flash costs a couple of
  // hundred milliseconds at boot, which is nothing against playing back noise.
  const uint32_t started = millis();
  uint32_t crc = 0xFFFFFFFFu;
  static uint8_t buf[LS_FLASH_SECTOR];
  for (uint32_t off = 0; off < bytes; off += sizeof(buf)) {
    const uint32_t n = bytes - off < sizeof(buf) ? bytes - off : sizeof(buf);
    if (esp_partition_read(part(partition_), LS_PAYLOAD_OFFSET + off, buf, n) != ESP_OK) {
      return false;
    }
    crc = crc32Update(crc, buf, n);
  }
  if (~crc != h.crc32) {
    Serial.println("[flash] stored animation failed CRC, ignoring");
    return false;
  }

  header_ = h;
  expected_ = bytes;
  received_ = bytes;
  running_ = h.crc32;
  loaded_ = true;
  Serial.printf("[flash] restored %u frames (%u bytes), verified in %u ms\n", h.frameCount,
                (unsigned)bytes, (unsigned)(millis() - started));
  return true;
}

ErrorCode Animation::begin(const uint8_t* header, size_t len) {
  if (!partition_) return LS_ERR_OUT_OF_MEMORY;
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

  const uint32_t size = (uint32_t)h.frameCount * h.ledCount * 3u;
  if (size > maxAnimationBytes()) return LS_ERR_OUT_OF_MEMORY;

  // Drop the old record first: if the transfer dies half way the partition holds
  // a mix of two animations, and it must not look loadable on the next boot.
  reset();

  header_ = h;
  expected_ = size;
  received_ = 0;
  running_ = 0xFFFFFFFFu;
  staged_ = 0;
  erasedTo_ = LS_PAYLOAD_OFFSET;
  return LS_ERR_NONE;
}

/** Clears whole blocks until `offset` falls inside erased space. */
bool Animation::eraseThrough(uint32_t offset) {
  while (erasedTo_ < offset) {
    const uint32_t remaining = part(partition_)->size - erasedTo_;
    if (remaining == 0) return false;
    const uint32_t span = remaining < LS_FLASH_BLOCK ? remaining : LS_FLASH_BLOCK;
    if (esp_partition_erase_range(part(partition_), erasedTo_, span) != ESP_OK) return false;
    erasedTo_ += span;
  }
  return true;
}

bool Animation::flushStage() {
  if (staged_ == 0) return true;
  const uint32_t at = LS_PAYLOAD_OFFSET + received_ - staged_;
  // Pad to four bytes: esp_partition_write wants an aligned length, and the
  // trailing bytes are never read back because the record holds the exact size.
  while (staged_ % 4 != 0) stage_[staged_++] = 0;
  if (!eraseThrough(at + staged_)) return false;
  const bool ok = esp_partition_write(part(partition_), at, stage_, staged_) == ESP_OK;
  staged_ = 0;
  return ok;
}

bool Animation::append(const uint8_t* data, size_t len) {
  if (!partition_ || received_ + len > expected_) return false;
  running_ = crc32Update(running_, data, len);

  size_t done = 0;
  while (done < len) {
    const size_t room = LS_FLASH_SECTOR - staged_;
    const size_t take = len - done < room ? len - done : room;
    memcpy(stage_ + staged_, data + done, take);
    staged_ += take;
    done += take;
    received_ += take;

    if (staged_ == LS_FLASH_SECTOR) {
      const uint32_t at = LS_PAYLOAD_OFFSET + received_ - LS_FLASH_SECTOR;
      if (!eraseThrough(at + LS_FLASH_SECTOR)) return false;
      if (esp_partition_write(part(partition_), at, stage_, LS_FLASH_SECTOR) != ESP_OK) {
        return false;
      }
      staged_ = 0;
    }
  }
  return true;
}

bool Animation::finish() {
  if (!partition_ || !complete()) return false;
  if (!flushStage()) return false;

  uint8_t rec[REC_SIZE] = {0};
  writeU32(rec + REC_MAGIC, LS_RECORD_MAGIC);
  rec[REC_VERSION] = LS_VERSION;
  rec[REC_FLAGS] = header_.flags;
  writeU16(rec + REC_LED_COUNT, header_.ledCount);
  writeU16(rec + REC_FRAME_COUNT, header_.frameCount);
  writeU16(rec + REC_FPS, header_.fps);
  writeU16(rec + REC_START_DELAY, header_.startDelayMs);
  writeU32(rec + REC_CRC32, header_.crc32);
  writeU32(rec + REC_BYTES, expected_);
  writeU32(rec + REC_SELF_CRC, crc32(rec, REC_SELF_CRC));

  if (esp_partition_write(part(partition_), LS_RECORD_OFFSET, rec, sizeof(rec)) != ESP_OK) {
    return false;
  }
  loaded_ = true;
  return true;
}

void Animation::reset() {
  loaded_ = false;
  expected_ = 0;
  received_ = 0;
  running_ = 0;
  staged_ = 0;
  erasedTo_ = 0;
  header_ = AnimationHeader();
  // Only the record goes. Erasing the payload as well would cost seconds and
  // buys nothing: without a valid record it is unreachable.
  if (partition_) {
    esp_partition_erase_range(part(partition_), LS_RECORD_OFFSET, LS_FLASH_SECTOR);
  }
}

bool Animation::readFrame(uint16_t i, uint8_t* dst) const {
  if (!partition_ || !loaded_ || i >= header_.frameCount) return false;
  const uint32_t stride = (uint32_t)header_.ledCount * 3u;
  return esp_partition_read(part(partition_), LS_PAYLOAD_OFFSET + (uint32_t)i * stride, dst,
                            stride) == ESP_OK;
}
