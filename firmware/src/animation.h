// Owns the single in-RAM animation: header metadata, the payload buffer, and
// the incremental receive/verify state machine. Knows nothing about BLE or LEDs.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

struct AnimationHeader {
  uint8_t flags = 0;
  uint16_t ledCount = 0;
  uint16_t frameCount = 0;
  uint16_t fps = 0;
  uint16_t startDelayMs = 0;
  uint32_t crc32 = 0;

  bool loop() const { return flags & FLAG_LOOP; }
  bool pingPong() const { return flags & FLAG_PING_PONG; }
  bool autoPlay() const { return flags & FLAG_AUTOPLAY; }
};

class Animation {
 public:
  // Largest payload the device could accept right now: the largest free block,
  // less the safety margin, *plus* whatever is currently loaded.
  //
  // Counting the loaded animation is not optimism — begin() calls reset() before
  // it allocates, so that exact block is handed back first. Ignoring it made the
  // device report a ceiling that excluded the memory it was about to reuse, and
  // the editor greyed out Upload for a project the stick had just accepted.
  uint32_t maxAnimationBytes() const;

  // Validates a 20-byte BEGIN_UPLOAD header and allocates the payload buffer.
  // Frees any previously loaded animation first (§3.1: one animation at a time,
  // free before allocating). Returns LS_ERR_NONE on success.
  ErrorCode begin(const uint8_t* header, size_t len);

  // Appends a Data chunk. Returns false if it would overrun the buffer.
  bool append(const uint8_t* data, size_t len);

  // True once every expected byte has arrived.
  bool complete() const { return received_ == expected_; }

  // CRC32 of the received payload against the header value.
  bool verifyCrc() const;

  void reset();

  bool loaded() const { return buffer_ != nullptr && complete(); }
  const AnimationHeader& header() const { return header_; }
  uint32_t received() const { return received_; }
  uint32_t expected() const { return expected_; }

  // Pointer to frame `i`, or nullptr if out of range. Frame stride is
  // ledCount * 3 bytes, RGB order on the wire (§2.1).
  const uint8_t* frame(uint16_t i) const;
  uint16_t frameCount() const { return header_.frameCount; }

 private:
  uint8_t* buffer_ = nullptr;
  uint32_t expected_ = 0;
  uint32_t received_ = 0;
  AnimationHeader header_;
};

uint32_t crc32(const uint8_t* data, size_t len);
