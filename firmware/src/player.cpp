#include "player.h"

#include <FastLED.h>

static CRGB leds[LED_COUNT];

void Player::begin() {
  // WS2812B is GRB; the wire format stays RGB and is mapped here only (§6).
  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, LED_COUNT);
  // Non-negotiable: FastLED scales any frame that would exceed the budget, so
  // an all-white frame cannot brown out the ESP32 mid-exposure (§3.4).
  FastLED.setMaxPowerInVoltsAndMilliamps(5, MAX_MILLIAMPS);
  FastLED.setBrightness(brightness_);
  blank();
}

void Player::play(const Animation* anim) {
  if (!anim || !anim->loaded() || anim->frameCount() == 0) return;
  anim_ = anim;
  index_ = 0;
  dir_ = 1;
  frameIntervalUs_ = 1000000u / anim->header().fps;
  identifyUntilMs_ = 0;

  if (anim->header().startDelayMs > 0) {
    phase_ = Phase::Delay;
    delayStartMs_ = millis();
    blank();  // nothing may be lit while the shutter is already open
  } else {
    phase_ = Phase::Running;
    nextFrameUs_ = micros() + frameIntervalUs_;
    renderFrame(0);
  }
}

void Player::stop() {
  phase_ = Phase::Off;
  anim_ = nullptr;
  blank();
}

bool Player::tick() {
  uint32_t nowMs = millis();

  if (identifyUntilMs_ != 0) {
    if ((int32_t)(nowMs - identifyUntilMs_) >= 0) {
      identifyUntilMs_ = 0;
      blank();
    }
    return false;
  }

  switch (phase_) {
    case Phase::Off:
      return false;

    case Phase::Delay:
      if (nowMs - delayStartMs_ >= anim_->header().startDelayMs) {
        phase_ = Phase::Running;
        nextFrameUs_ = micros() + frameIntervalUs_;
        renderFrame(0);
      }
      return false;

    case Phase::Running:
      // Signed comparison so the micros() rollover at ~71 minutes is harmless.
      if ((int32_t)(micros() - nextFrameUs_) >= 0) {
        nextFrameUs_ += frameIntervalUs_;
        if (!advance()) {
          // Neither loop nor pingPong: blank and hand back to READY (§3.1).
          phase_ = Phase::Off;
          anim_ = nullptr;
          blank();
          return true;
        }
        renderFrame((uint16_t)index_);
      }
      return false;
  }
  return false;
}

// Steps index_/dir_ to the next frame. Returns false when the animation is over.
bool Player::advance() {
  const AnimationHeader& h = anim_->header();
  int32_t last = (int32_t)h.frameCount - 1;
  int32_t next = index_ + dir_;

  if (next > last) {
    if (h.pingPong()) {
      dir_ = -1;
      next = last > 0 ? last - 1 : 0;
    } else if (h.loop()) {
      next = 0;
    } else {
      return false;
    }
  } else if (next < 0) {
    // Only reachable while ping-ponging back toward frame 0.
    if (h.loop()) {
      dir_ = 1;
      next = last > 0 ? 1 : 0;
    } else {
      return false;
    }
  }

  index_ = next;
  return true;
}

void Player::renderFrame(uint16_t frameIndex) {
  const uint8_t* src = anim_->frame(frameIndex);
  if (!src) return;
  for (uint16_t i = 0; i < LED_COUNT; i++) {
    leds[i] = CRGB(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
  }
  FastLED.setBrightness(brightness_);
  FastLED.show();
}

void Player::identify() {
  if (phase_ != Phase::Off) return;
  fill_solid(leds, LED_COUNT, CRGB::White);
  FastLED.setBrightness(brightness_);
  FastLED.show();
  identifyUntilMs_ = millis() + LS_IDENTIFY_MS;
  if (identifyUntilMs_ == 0) identifyUntilMs_ = 1;  // 0 means "not identifying"
}

void Player::blank() {
  fill_solid(leds, LED_COUNT, CRGB::Black);
#if POWER_BANK_KEEPALIVE
  // Minimum load so a power bank with auto-shutoff keeps the rail up, and with
  // it the animation in RAM (§6).
  leds[0] = CRGB(1, 1, 1);
  FastLED.setBrightness(1);
#endif
  FastLED.show();
}

void Player::showStatusLed(DeviceState state, LinkStage link) {
#if STATUS_LED_ENABLED
  // Must never be lit while the shutter could be open (§4.4).
  if (exposing() || identifying()) return;

  // Magenta and orange are far apart at brightness 8, which matters because
  // telling these two apart is the point of splitting them.
  CRGB c = CRGB::Magenta;  // LS_LINK_DOWN: never joined the network
  if (link == LS_LINK_NETWORK) {
    c = CRGB::Orange;  // on the network, relay not answering
  } else if (link == LS_LINK_UP) {
    switch (state) {
      case STATE_IDLE:
        c = CRGB::Blue;
        break;
      case STATE_RECEIVING:
        c = CRGB::Blue;
        break;
      case STATE_READY:
        c = CRGB::Green;
        break;
      case STATE_ERROR:
        c = CRGB::Red;
        break;
      default:
        c = CRGB::Black;
        break;
    }
  }
  fill_solid(leds, LED_COUNT, CRGB::Black);
  leds[0] = c;
  FastLED.setBrightness(8);  // dim: an indicator, not part of the picture
  FastLED.show();
#else
  (void)state;
  (void)link;
#endif
}
