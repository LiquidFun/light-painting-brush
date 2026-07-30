// Owns the single stored animation: header metadata, the flash partition it
// lives in, and the incremental receive/verify state machine. Knows nothing
// about the transport or the LEDs.
//
// The payload lives in flash rather than RAM. That buys two things at once: it
// survives a power cycle, so a shoot no longer needs a re-upload after every
// battery swap, and it lifts the length ceiling from ~460 frames to ~5900.
//
// Playing straight out of flash is safe in a way that playing off the network
// was not (PROTOCOL.md §6 rejects streaming for that reason): a frame is 432
// bytes against a 40 ms budget at 25 fps, and flash latency is microseconds and
// bounded, where network latency is milliseconds and is not.

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
  // Finds the animation partition. Call once at boot, before anything else
  // here; every other method is a safe no-op if it fails.
  bool mount();

  // Reads back whatever survived the last power cycle, verifying the CRC.
  // Returns true if a valid animation is now loaded.
  bool restore();

  // Largest payload the partition can hold, less the record sector. Unlike the
  // RAM version this is a constant: it does not move with free heap, and does
  // not have to account for the animation already stored.
  uint32_t maxAnimationBytes() const;

  // Validates a 20-byte BEGIN_UPLOAD header and prepares the partition.
  // Invalidates the stored animation immediately, so a transfer that fails half
  // way cannot leave a valid record pointing at a half-written payload.
  ErrorCode begin(const uint8_t* header, size_t len);

  // Appends a chunk. Erases lazily, one block ahead of the write cursor, so the
  // cost of clearing 2.4 MB is spread across the transfer rather than blocking
  // for seconds up front. Returns false on overrun or a flash error.
  bool append(const uint8_t* data, size_t len);

  bool complete() const { return received_ == expected_; }

  // The CRC is accumulated as the bytes go past, so this is a comparison rather
  // than a second pass over the payload.
  //
  // `running_` is the bare accumulator: CRC-32/ISO-HDLC finishes with a one's
  // complement, and leaving it out here compared two different numbers and
  // failed every single upload.
  bool verifyCrc() const { return ~running_ == header_.crc32; }

  // Flushes the last partial sector and writes the record that makes the
  // animation findable after a reboot. Only meaningful once `complete()`.
  bool finish();

  // Invalidates the stored animation. The payload is left alone: without a
  // valid record it is unreachable, and erasing it would cost seconds.
  void reset();

  bool loaded() const { return loaded_; }
  const AnimationHeader& header() const { return header_; }
  uint32_t received() const { return received_; }
  uint32_t expected() const { return expected_; }
  uint16_t frameCount() const { return header_.frameCount; }

  // Reads frame `i` into `dst`, which must hold ledCount * 3 bytes. RGB order
  // in storage; the player maps to GRB.
  bool readFrame(uint16_t i, uint8_t* dst) const;

 private:
  bool eraseThrough(uint32_t offset);
  bool flushStage();

  const void* partition_ = nullptr;  // esp_partition_t, kept opaque here
  AnimationHeader header_;
  uint32_t expected_ = 0;
  uint32_t received_ = 0;
  // CRC in progress, pre-final-XOR. Invariant: ~running_ is the finished value.
  uint32_t running_ = 0;
  uint32_t erasedTo_ = 0;  // partition offset cleared so far
  uint32_t staged_ = 0;    // bytes waiting in stage_
  bool loaded_ = false;
  // Flash wants 4-byte aligned writes and erases whole sectors, so incoming
  // chunks are gathered into one sector before they go down.
  uint8_t stage_[LS_FLASH_SECTOR];
};

uint32_t crc32(const uint8_t* data, size_t len);
uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t len);
