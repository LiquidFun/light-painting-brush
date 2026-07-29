// Drives the strip. Non-blocking: every timing decision is made in tick() from
// micros()/millis() so BLE and the button stay responsive (§3.1).

#pragma once

#include <stdint.h>

#include "animation.h"
#include "protocol.h"

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

  // Flash the whole strip white for ~200 ms (§2.3 IDENTIFY). Non-blocking.
  void identify();
  bool identifying() const { return identifyUntilMs_ != 0; }

  // Dim single-LED state indicator; no-op when STATUS_LED_ENABLED is 0 or while
  // exposing. `linked` false gets its own colour, because "no network" and "idle"
  // are the two states a user most needs to tell apart in the dark (§4.4).
  void showStatusLed(DeviceState state, bool linked);

 private:
  enum class Phase : uint8_t { Off, Delay, Running };

  void blank();
  void renderFrame(uint16_t index);
  bool advance();

  const Animation* anim_ = nullptr;
  Phase phase_ = Phase::Off;
  uint8_t brightness_ = DEFAULT_BRIGHTNESS;
  int32_t index_ = 0;
  int8_t dir_ = 1;
  uint32_t frameIntervalUs_ = 0;
  uint32_t nextFrameUs_ = 0;
  uint32_t delayStartMs_ = 0;
  uint32_t identifyUntilMs_ = 0;
};
