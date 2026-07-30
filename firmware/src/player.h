// Drives the strip. Non-blocking: every timing decision is made in tick() from
// micros()/millis() so BLE and the button stay responsive (§3.1).

#pragma once

#include <stdint.h>

#include "animation.h"
#include "protocol.h"
#include "transport.h"

class Player {
 public:
  void begin();

  // Start playback of `anim` from frame 0, honouring startDelayMs. Calling this
  // during playback restarts from frame 0 (§3.1).
  void play(const Animation* anim);

  // Blank the strip and stop. The animation buffer is untouched.
  void stop();

  // Advance the schedule. Returns true on the tick where playback finished on
  // its own, so the caller can transition back to READY.
  bool tick();

  bool active() const { return phase_ != Phase::Off; }

  // True while playing or during startDelayMs — the window in which nothing
  // that is not part of the animation may be lit (§3.3).
  bool exposing() const { return phase_ != Phase::Off; }

  void setBrightness(uint8_t b) { brightness_ = b; }
  uint8_t brightness() const { return brightness_; }

  // Frames that missed their slot by a whole interval or more, and the worst
  // overshoot. Above ~150 fps the WS2812 shift-out alone eats most of the
  // budget, and falling behind stretches the photograph's time axis — which is
  // invisible in the picture unless something counts it.
  uint32_t lateFrames() const { return lateFrames_; }
  uint32_t worstLateUs() const { return worstLateUs_; }

  // Flash the whole strip white for ~200 ms (§2.3 IDENTIFY). Non-blocking.
  void identify();
  bool identifying() const { return identifyUntilMs_ != 0; }

  // Dim single-LED state indicator; no-op when STATUS_LED_ENABLED is 0 or while
  // exposing. Anything short of LS_LINK_UP gets its own colour, because in the
  // dark the LED is usually the only diagnostic available (§4.4).
  void showStatusLed(DeviceState state, LinkStage link);

 private:
  enum class Phase : uint8_t { Off, Delay, Running };

  void blank();
  void renderFrame(uint16_t index);
  bool advance();

  // One frame staged out of flash. 432 bytes at 144 LEDs — small enough that a
  // read-ahead buffer would be optimising before measuring: a read is well under
  // a millisecond against a 40 ms frame budget at 25 fps.
  uint8_t frame_[LED_COUNT * 3];

  const Animation* anim_ = nullptr;
  Phase phase_ = Phase::Off;
  uint8_t brightness_ = DEFAULT_BRIGHTNESS;
  int32_t index_ = 0;
  int8_t dir_ = 1;
  uint32_t frameIntervalUs_ = 0;
  uint32_t nextFrameUs_ = 0;
  uint32_t delayStartMs_ = 0;
  uint32_t identifyUntilMs_ = 0;
  uint32_t lateFrames_ = 0;
  uint32_t worstLateUs_ = 0;
};
