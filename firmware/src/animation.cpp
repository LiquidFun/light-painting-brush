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

uint16_t readU16(const uint8_t* p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }

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

// --- on-flash directory layout ---------------------------------------------
constexpr size_t DIR_MAGIC = 0;     // u32
constexpr size_t DIR_VERSION = 4;   // u8
constexpr size_t DIR_SELECTED = 5;  // i8
constexpr size_t DIR_SEQUENCE = 8;  // u32
constexpr size_t DIR_CURSOR = 12;   // u32
constexpr size_t DIR_SLOTS = 16;

constexpr size_t SLOT_SIZE = 48;
constexpr size_t SL_USED = 0;         // u8
constexpr size_t SL_FLAGS = 1;        // u8
constexpr size_t SL_FRAMES = 2;       // u16
constexpr size_t SL_FPS = 4;          // u16
constexpr size_t SL_START_DELAY = 6;  // u16
constexpr size_t SL_OFFSET = 8;       // u32
constexpr size_t SL_BYTES = 12;       // u32
constexpr size_t SL_CRC = 16;         // u32
constexpr size_t SL_COLOUR = 20;      // u8[LS_SLOT_COLOURS][3], then pad to 32
constexpr size_t SL_NAME = 32;        // char[16]
static_assert(SL_COLOUR + LS_SLOT_COLOURS * 3 <= SL_NAME, "colours overrun the name");

constexpr size_t DIR_SIZE = DIR_SLOTS + LS_MAX_SLOTS * SLOT_SIZE + 4;  // + self crc
static_assert(DIR_SIZE <= LS_FLASH_SECTOR, "directory must fit one sector");

/**
 * Rounds up to a 64 KB block, not a 4 KB sector.
 *
 * eraseThrough can only use a block erase where a whole block lies inside the
 * animation's extent, so a sector-aligned extent meant most uploads never got
 * one: a 54 KB animation did fourteen sector erases, which is several times the
 * flash time of the single block erase it needs. Every one of those runs inside
 * ws.loop(), so it is also time the socket is not being serviced.
 *
 * The padding is free in practice: the partition is 38 blocks of payload
 * against twelve slots, so even twelve tiny animations fit with room to spare.
 */
uint32_t alignUp(uint32_t v) {
  return (v + LS_FLASH_BLOCK - 1) & ~(LS_FLASH_BLOCK - 1);
}

bool overlaps(uint32_t aStart, uint32_t aEnd, uint32_t bStart, uint32_t bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

}  // namespace

bool Animation::mount() {
  partition_ = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY,
                                        LS_ANIMATION_PARTITION);
  if (!partition_) {
    Serial.println("[flash] no '" LS_ANIMATION_PARTITION "' partition. Is the board "
                   "flashed with partitions_lightstick.csv?");
    return false;
  }
  Serial.printf("[flash] %s: %u bytes at 0x%06X\n", LS_ANIMATION_PARTITION,
                (unsigned)part(partition_)->size, (unsigned)part(partition_)->address);
  readDirectory();
  Serial.printf("[flash] %u of %u slots used, selected %d\n", used(), LS_MAX_SLOTS,
                (int)selected_);
  return true;
}

uint32_t Animation::maxAnimationBytes() const {
  if (!partition_) return 0;
  return part(partition_)->size - LS_PAYLOAD_OFFSET;
}

uint8_t Animation::used() const {
  uint8_t n = 0;
  for (uint8_t i = 0; i < LS_MAX_SLOTS; i++) {
    if (slots_[i].used) n++;
  }
  return n;
}

// --- directory --------------------------------------------------------------

void Animation::loadHeader(const Slot& s) {
  header_.flags = s.flags;
  header_.ledCount = LED_COUNT;
  header_.frameCount = s.frameCount;
  header_.fps = s.fps;
  header_.startDelayMs = s.startDelayMs;
  header_.crc32 = s.crc32;
}

bool Animation::readDirectory() {
  static uint8_t buf[DIR_SIZE];
  bool found = false;
  uint32_t bestSeq = 0;

  for (uint8_t which = 0; which < 2; which++) {
    const uint32_t at = which == 0 ? LS_DIR_A_OFFSET : LS_DIR_B_OFFSET;
    if (esp_partition_read(part(partition_), at, buf, DIR_SIZE) != ESP_OK) continue;
    if (readU32(buf + DIR_MAGIC) != LS_DIR_MAGIC) continue;
    if (buf[DIR_VERSION] != LS_DIR_VERSION) continue;
    if (crc32(buf, DIR_SIZE - 4) != readU32(buf + DIR_SIZE - 4)) continue;
    const uint32_t seq = readU32(buf + DIR_SEQUENCE);
    // Both copies are valid most of the time; the newer one is the live set.
    if (found && seq <= bestSeq) continue;

    found = true;
    bestSeq = seq;
    sequence_ = seq;
    dirSlot_ = which;
    cursor_ = readU32(buf + DIR_CURSOR);
    selected_ = (int8_t)buf[DIR_SELECTED];
    for (uint8_t i = 0; i < LS_MAX_SLOTS; i++) {
      const uint8_t* r = buf + DIR_SLOTS + i * SLOT_SIZE;
      Slot& s = slots_[i];
      s.used = r[SL_USED] == 1;
      s.flags = r[SL_FLAGS];
      s.frameCount = readU16(r + SL_FRAMES);
      s.fps = readU16(r + SL_FPS);
      s.startDelayMs = readU16(r + SL_START_DELAY);
      s.offset = readU32(r + SL_OFFSET);
      s.bytes = readU32(r + SL_BYTES);
      s.crc32 = readU32(r + SL_CRC);
      memcpy(s.colour, r + SL_COLOUR, sizeof(s.colour));
      memcpy(s.name, r + SL_NAME, LS_SLOT_NAME);
      s.name[LS_SLOT_NAME - 1] = 0;
    }
  }

  if (!found) {
    for (uint8_t i = 0; i < LS_MAX_SLOTS; i++) slots_[i] = Slot();
    selected_ = -1;
    cursor_ = LS_PAYLOAD_OFFSET;
    sequence_ = 0;
    dirSlot_ = 1;  // so the first write lands in A
    return false;
  }

  if (selected_ >= 0 && (selected_ >= LS_MAX_SLOTS || !slots_[selected_].used)) {
    selected_ = nextUsed(-1);
  }
  if (selected_ >= 0) loadHeader(slots_[selected_]);
  return true;
}

bool Animation::writeDirectory() {
  static uint8_t buf[DIR_SIZE];
  memset(buf, 0, DIR_SIZE);
  writeU32(buf + DIR_MAGIC, LS_DIR_MAGIC);
  buf[DIR_VERSION] = LS_DIR_VERSION;
  buf[DIR_SELECTED] = (uint8_t)selected_;
  writeU32(buf + DIR_SEQUENCE, ++sequence_);
  writeU32(buf + DIR_CURSOR, cursor_);
  for (uint8_t i = 0; i < LS_MAX_SLOTS; i++) {
    uint8_t* r = buf + DIR_SLOTS + i * SLOT_SIZE;
    const Slot& s = slots_[i];
    r[SL_USED] = s.used ? 1 : 0;
    r[SL_FLAGS] = s.flags;
    writeU16(r + SL_FRAMES, s.frameCount);
    writeU16(r + SL_FPS, s.fps);
    writeU16(r + SL_START_DELAY, s.startDelayMs);
    writeU32(r + SL_OFFSET, s.offset);
    writeU32(r + SL_BYTES, s.bytes);
    writeU32(r + SL_CRC, s.crc32);
    memcpy(r + SL_COLOUR, s.colour, sizeof(s.colour));
    memcpy(r + SL_NAME, s.name, LS_SLOT_NAME);
  }
  writeU32(buf + DIR_SIZE - 4, crc32(buf, DIR_SIZE - 4));

  // Alternate. The copy we are not writing stays valid throughout, so a power
  // cut here leaves the previous set intact rather than no set at all.
  const uint8_t which = dirSlot_ == 0 ? 1 : 0;
  const uint32_t at = which == 0 ? LS_DIR_A_OFFSET : LS_DIR_B_OFFSET;
  if (esp_partition_erase_range(part(partition_), at, LS_FLASH_SECTOR) != ESP_OK) return false;
  if (esp_partition_write(part(partition_), at, buf, DIR_SIZE) != ESP_OK) return false;
  dirSlot_ = which;
  revision_++;
  return true;
}

// --- the stored set ---------------------------------------------------------

bool Animation::verify(const Slot& s) const {
  static uint8_t buf[LS_FLASH_SECTOR];
  uint32_t crc = 0xFFFFFFFFu;
  for (uint32_t off = 0; off < s.bytes; off += sizeof(buf)) {
    const uint32_t n = s.bytes - off < sizeof(buf) ? s.bytes - off : sizeof(buf);
    if (esp_partition_read(part(partition_), s.offset + off, buf, n) != ESP_OK) return false;
    crc = crc32Update(crc, buf, n);
  }
  return ~crc == s.crc32;
}

bool Animation::select(int8_t i) {
  if (!partition_ || i < 0 || i >= LS_MAX_SLOTS || !slots_[i].used) return false;
  const Slot& s = slots_[i];
  // Checked here rather than at boot: verifying every slot would read the whole
  // partition, and only the one about to play actually matters.
  const uint32_t started = millis();
  if (!verify(s)) {
    Serial.printf("[flash] slot %d failed CRC, dropping it\n", (int)i);
    remove((uint8_t)i);
    return false;
  }
  selected_ = i;
  loadHeader(s);
  writeDirectory();
  Serial.printf("[flash] slot %d '%s': %u frames, verified in %u ms\n", (int)i, s.name,
                s.frameCount, (unsigned)(millis() - started));
  return true;
}

int8_t Animation::nextUsed(int8_t from) const {
  for (uint8_t step = 1; step <= LS_MAX_SLOTS; step++) {
    const int8_t i = (int8_t)(((from < 0 ? -1 : from) + step) % LS_MAX_SLOTS);
    if (slots_[i].used) return i;
  }
  return -1;
}

bool Animation::remove(uint8_t i) {
  if (!partition_ || i >= LS_MAX_SLOTS || !slots_[i].used) return false;
  slots_[i] = Slot();
  if (selected_ == (int8_t)i) selected_ = nextUsed((int8_t)i);
  return writeDirectory();
}

bool Animation::readFrameOf(uint8_t i, uint16_t f, uint8_t* dst) const {
  if (!partition_ || i >= LS_MAX_SLOTS) return false;
  const Slot& s = slots_[i];
  if (!s.used || f >= s.frameCount) return false;
  const uint32_t stride = (uint32_t)LED_COUNT * 3u;
  return esp_partition_read(part(partition_), s.offset + (uint32_t)f * stride, dst, stride) ==
         ESP_OK;
}

// --- receiving --------------------------------------------------------------

ErrorCode Animation::begin(const uint8_t* header, size_t len, const char* name) {
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
  // The extent, not the payload, is what has to fit: an animation reserves whole
  // erase blocks. Comparing the payload here and reserving the extent below let
  // a transfer claim space past the end of the partition, and eraseThrough would
  // then have erased off the end of it.
  const uint32_t extent = alignUp(size);
  if (extent > maxAnimationBytes()) return LS_ERR_OUT_OF_MEMORY;

  const uint32_t end = part(partition_)->size;
  // Block-aligned start, not just a block-sized extent. eraseThrough tests
  // `erasedTo_ % LS_FLASH_BLOCK == 0`, so a whole-block extent starting part-way
  // into a block still gets erased a sector at a time — and a cursor left behind
  // by the previous sector-aligned firmware is exactly that.
  uint32_t at = cursor_ < LS_PAYLOAD_OFFSET ? LS_PAYLOAD_OFFSET : alignUp(cursor_);
  // Wrap rather than search for a gap. There is no allocator here on purpose.
  if (at + extent > end) at = LS_PAYLOAD_OFFSET;

  // Take a free slot, else the oldest thing we are about to overwrite anyway.
  int8_t target = -1;
  for (uint8_t i = 0; i < LS_MAX_SLOTS && target < 0; i++) {
    if (!slots_[i].used) target = (int8_t)i;
  }

  for (uint8_t i = 0; i < LS_MAX_SLOTS; i++) {
    Slot& s = slots_[i];
    if (!s.used) continue;
    if (!overlaps(at, at + extent, s.offset, s.offset + alignUp(s.bytes))) continue;
    Serial.printf("[flash] evicting slot %u '%s', overwritten by this upload\n", i, s.name);
    if (target < 0) target = (int8_t)i;
    s = Slot();
  }
  if (target < 0) {
    // Every slot is used and none is in the way: reuse the one furthest from
    // the cursor rather than refusing the upload.
    target = 0;
    slots_[0] = Slot();
  }

  // Publish the eviction *before* a byte is written, so the directory never
  // claims a slot whose payload is being overwritten underneath it.
  if (selected_ >= 0 && !slots_[selected_].used) selected_ = nextUsed(selected_);
  if (!writeDirectory()) return LS_ERR_OUT_OF_MEMORY;

  header_ = h;
  target_ = target;
  start_ = at;
  extentEnd_ = at + extent;
  erasedTo_ = at;
  expected_ = size;
  received_ = 0;
  running_ = 0xFFFFFFFFu;
  staged_ = 0;
  memset(colourSum_, 0, sizeof(colourSum_));
  memset(colourWeight_, 0, sizeof(colourWeight_));
  receiving_ = true;
  snprintf(name_, sizeof(name_), "%s", name && name[0] ? name : "Animation");
  return LS_ERR_NONE;
}

/** Clears up to `offset`, in blocks where a whole block belongs to us. */
bool Animation::eraseThrough(uint32_t offset) {
  while (erasedTo_ < offset) {
    // Block erase is far cheaper per byte, but only where the whole block is
    // inside this animation's extent — a neighbour must not be destroyed.
    const bool block = (erasedTo_ % LS_FLASH_BLOCK) == 0 &&
                       erasedTo_ + LS_FLASH_BLOCK <= extentEnd_;
    const uint32_t span = block ? LS_FLASH_BLOCK : LS_FLASH_SECTOR;
    if (esp_partition_erase_range(part(partition_), erasedTo_, span) != ESP_OK) return false;
    erasedTo_ += span;
  }
  return true;
}

bool Animation::flushStage() {
  if (staged_ == 0) return true;
  const uint32_t at = start_ + received_ - staged_;
  while (staged_ % 4 != 0) stage_[staged_++] = 0;
  if (!eraseThrough(at + staged_)) return false;
  const bool ok = esp_partition_write(part(partition_), at, stage_, staged_) == ESP_OK;
  staged_ = 0;
  return ok;
}

bool Animation::append(const uint8_t* data, size_t len) {
  if (!receiving_ || received_ + len > expected_) return false;
  running_ = crc32Update(running_, data, len);

  // Representative colours, accumulated as the bytes go past. Which sample a
  // pixel belongs to is its offset in the payload, so the three come out as the
  // start, the middle and the end of the animation.
  //
  // received_ has not been advanced yet, so it is the offset of data[0]. The +1
  // keeps the divisor non-zero and puts the last pixel in the last bucket rather
  // than one past it.
  const uint32_t span = expected_ / LS_SLOT_COLOURS + 1;
  // Start at the first whole pixel in this chunk, not at byte 0.
  //
  // A chunk is 4096 bytes and a pixel is 3, so only the first chunk begins on a
  // pixel boundary; the next starts one byte in and the one after that two. This
  // loop used to assume otherwise and read (G,B,R) as (R,G,B), then (B,R,G), so
  // the channels evened out across a transfer and every animation came back
  // pale. A solid red one reported (255,127,240). At most two bytes per chunk
  // are skipped here, which is nothing to an average over a megabyte.
  const size_t skip = (3 - (size_t)(received_ % 3)) % 3;
  for (size_t i = skip; i + 2 < len; i += 3) {
    const uint8_t r = data[i], g = data[i + 1], b = data[i + 2];
    const uint8_t peak = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (peak < 24) continue;
    const uint8_t dip = r < g ? (r < b ? r : b) : (g < b ? g : b);
    // Weighted by chroma, not by brightness.
    //
    // Brightness weighting made every animation the same washed-out grey: a
    // frame is mostly pale or near-white pixels, those carry the most weight,
    // and the handful of saturated ones that actually characterise the
    // animation get outvoted. Chroma is how *colourful* a pixel is, so a white
    // pixel contributes nothing and a vivid one dominates.
    const uint8_t w = (uint8_t)(peak - dip);
    if (w == 0) continue;
    uint32_t k = (received_ + (uint32_t)i) / span;
    if (k >= LS_SLOT_COLOURS) k = LS_SLOT_COLOURS - 1;
    colourSum_[k][0] += (uint32_t)r * w;
    colourSum_[k][1] += (uint32_t)g * w;
    colourSum_[k][2] += (uint32_t)b * w;
    colourWeight_[k] += w;
  }

  size_t done = 0;
  while (done < len) {
    const size_t room = LS_FLASH_SECTOR - staged_;
    const size_t take = len - done < room ? len - done : room;
    memcpy(stage_ + staged_, data + done, take);
    staged_ += take;
    done += take;
    received_ += take;

    if (staged_ == LS_FLASH_SECTOR) {
      const uint32_t at = start_ + received_ - LS_FLASH_SECTOR;
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
  if (!receiving_ || !complete() || target_ < 0) return false;
  if (!flushStage()) return false;

  Slot& s = slots_[target_];
  s.used = true;
  s.flags = header_.flags;
  s.frameCount = header_.frameCount;
  s.fps = header_.fps;
  s.startDelayMs = header_.startDelayMs;
  s.offset = start_;
  s.bytes = expected_;
  s.crc32 = header_.crc32;
  int8_t donor = -1;
  for (uint8_t k = 0; k < LS_SLOT_COLOURS; k++) {
    if (colourWeight_[k] == 0) continue;
    uint32_t c[3];
    for (uint8_t j = 0; j < 3; j++) c[j] = (uint32_t)(colourSum_[k][j] / colourWeight_[k]);
    // Scaled up until one channel is full. The marker is an identifier, not a
    // preview: a dim animation still deserves a legible one, and holding the
    // hue while discarding the brightness is what makes two of them tellable
    // apart across a dark field.
    const uint32_t top = c[0] > c[1] ? (c[0] > c[2] ? c[0] : c[2]) : (c[1] > c[2] ? c[1] : c[2]);
    for (uint8_t j = 0; j < 3; j++) {
      s.colour[k][j] = top > 0 ? (uint8_t)(c[j] * 255u / top) : 0;
    }
    if (donor < 0) donor = (int8_t)k;
  }
  // A stretch with no colour in it at all — dark, or genuinely white. Borrowing
  // from a stretch that has some beats showing grey, which would read as a third
  // kind of animation rather than as "nothing happens here".
  for (uint8_t k = 0; k < LS_SLOT_COLOURS; k++) {
    if (colourWeight_[k] > 0) continue;
    if (donor >= 0) {
      memcpy(s.colour[k], s.colour[donor], 3);
    } else {
      // Nothing anywhere in the payload had any chroma, so white is the honest
      // answer rather than a fallback.
      s.colour[k][0] = s.colour[k][1] = s.colour[k][2] = 255;
    }
  }
  memcpy(s.name, name_, LS_SLOT_NAME);
  s.name[LS_SLOT_NAME - 1] = 0;

  cursor_ = extentEnd_ >= part(partition_)->size ? LS_PAYLOAD_OFFSET : extentEnd_;
  selected_ = target_;
  receiving_ = false;
  target_ = -1;
  return writeDirectory();
}

void Animation::abort() {
  receiving_ = false;
  target_ = -1;
  received_ = 0;
  expected_ = 0;
  staged_ = 0;
  if (selected_ >= 0 && selected_ < LS_MAX_SLOTS && slots_[selected_].used) {
    loadHeader(slots_[selected_]);
  }
}
