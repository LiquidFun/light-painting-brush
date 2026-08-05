// The animations stored in flash, and the transfer that adds one.
//
// Up to LS_MAX_SLOTS animations live in the partition at once, so a shoot needs
// no phone: the stick holds the set and the BOOT button picks between them.
//
// Allocation is append-and-wrap, which sidesteps fragmentation rather than
// solving it. Each upload lands at a write cursor; if it will not fit before the
// end of the partition it starts again at the beginning; and whatever it lands
// on is evicted. There is no free list, no best fit and no compaction. An
// animation needing the whole partition simply evicts every other, and one
// needing a tenth evicts only what it overlaps.
//
// Uploads are atomic. The directory is written twice — once to drop the slots
// about to be overwritten, once to publish the finished one — to two sectors
// alternately, newest sequence winning. A power cut, a dropped socket or a
// failed CRC therefore leaves the previous set intact. Losing a working
// animation to a flaky upload in the field is exactly what this prevents.

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

struct Slot {
  bool used = false;
  uint8_t flags = 0;
  uint16_t frameCount = 0;
  uint16_t fps = 0;
  uint16_t startDelayMs = 0;
  uint32_t offset = 0;  // partition offset of the payload
  uint32_t bytes = 0;
  uint32_t crc32 = 0;
  /** Representative colour, for the on-stick picker. Computed while receiving. */
  uint8_t colour[3] = {0, 0, 0};
  char name[LS_SLOT_NAME] = {0};

  bool loop() const { return flags & FLAG_LOOP; }
  bool pingPong() const { return flags & FLAG_PING_PONG; }
  bool autoPlay() const { return flags & FLAG_AUTOPLAY; }
};

class Animation {
 public:
  // Finds the partition and reads the directory. Call once at boot; every other
  // method is a safe no-op if it fails.
  bool mount();

  uint32_t maxAnimationBytes() const;

  // --- the stored set -------------------------------------------------------

  uint8_t slotCount() const { return LS_MAX_SLOTS; }
  const Slot& slot(uint8_t i) const { return slots_[i < LS_MAX_SLOTS ? i : 0]; }
  uint8_t used() const;
  int8_t selected() const { return selected_; }

  // Bumped every time the directory is rewritten, which is every change to the
  // set — upload, select, delete, eviction. Watching one integer beats calling a
  // publish helper from the eight places that mutate the set and eventually
  // forgetting one.
  uint32_t revision() const { return revision_; }

  // Makes slot `i` the one that plays, verifying its CRC first. Returns false if
  // the slot is empty or its payload no longer checks out.
  bool select(int8_t i);

  // The next used slot after the current one, wrapping. -1 if none are used.
  int8_t nextUsed(int8_t from) const;

  bool remove(uint8_t i);

  // --- the loaded animation -------------------------------------------------

  bool loaded() const { return selected_ >= 0 && slots_[selected_].used; }
  const AnimationHeader& header() const { return header_; }
  uint16_t frameCount() const { return header_.frameCount; }

  // Reads frame `f` of slot `i` into `dst`, which must hold ledCount * 3 bytes.
  bool readFrameOf(uint8_t i, uint16_t f, uint8_t* dst) const;
  bool readFrame(uint16_t f, uint8_t* dst) const {
    return selected_ >= 0 && readFrameOf((uint8_t)selected_, f, dst);
  }

  // --- receiving ------------------------------------------------------------

  ErrorCode begin(const uint8_t* header, size_t len, const char* name);
  bool append(const uint8_t* data, size_t len);
  bool complete() const { return receiving_ && received_ == expected_; }
  bool verifyCrc() const { return ~running_ == header_.crc32; }
  bool finish();

  // Abandons a transfer in progress. The previous set is already safe.
  void abort();

  uint32_t received() const { return received_; }
  uint32_t expected() const { return expected_; }
  bool receiving() const { return receiving_; }

 private:
  bool readDirectory();
  bool writeDirectory();
  bool eraseThrough(uint32_t offset);
  bool flushStage();
  bool verify(const Slot& s) const;

  // Mirrors a slot's metadata into header_, which is what the player reads.
  // Assigned field by field rather than braced: AnimationHeader has default
  // member initialisers, which stop it being an aggregate under C++11.
  void loadHeader(const Slot& s);

  const void* partition_ = nullptr;  // esp_partition_t, kept opaque here
  Slot slots_[LS_MAX_SLOTS];
  int8_t selected_ = -1;
  uint32_t revision_ = 0;
  uint32_t sequence_ = 0;
  uint32_t cursor_ = LS_PAYLOAD_OFFSET;
  /** Which directory sector the live copy is in; the next write goes to the other. */
  uint8_t dirSlot_ = 0;

  // In-flight transfer.
  bool receiving_ = false;
  int8_t target_ = -1;
  AnimationHeader header_;
  uint32_t expected_ = 0;
  uint32_t received_ = 0;
  uint32_t running_ = 0;
  uint32_t start_ = 0;
  uint32_t extentEnd_ = 0;
  uint32_t erasedTo_ = 0;
  uint32_t staged_ = 0;
  // Colour accumulated over the payload, weighted by each pixel's own
  // brightness so dark frames do not drag it toward grey.
  uint64_t colourSum_[3] = {0, 0, 0};
  uint64_t colourWeight_ = 0;
  char name_[LS_SLOT_NAME] = {0};
  uint8_t stage_[LS_FLASH_SECTOR];
};

uint32_t crc32(const uint8_t* data, size_t len);
uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t len);
