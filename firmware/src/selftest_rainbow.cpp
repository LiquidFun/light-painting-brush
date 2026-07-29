// M1: hardcoded rainbow sweep, no BLE (REQUIREMENTS §5).
//
// Built only by `pio run -e m1_selftest`. Its whole purpose is to prove the
// wiring, the colour order and the power rail before any BLE code is suspected.
// If this does not light the strip, the problem is hardware.
//
// Expected: a rainbow scrolling from LED 0 (base) toward LED 143 (tip), plus a
// white pulse every few seconds to load the rail.

#include <Arduino.h>
#include <FastLED.h>

#include "protocol.h"

static CRGB leds[LED_COUNT];

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.printf("[m1] rainbow selftest, %u LEDs on GPIO %u\n", LED_COUNT, DATA_PIN);

  FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, LED_COUNT);
  FastLED.setMaxPowerInVoltsAndMilliamps(5, MAX_MILLIAMPS);
  FastLED.setBrightness(DEFAULT_BRIGHTNESS);
}

void loop() {
  static uint8_t hue = 0;
  static uint32_t lastPulseMs = 0;

  uint32_t now = millis();
  if (now - lastPulseMs < 4000) {
    fill_rainbow(leds, LED_COUNT, hue, 255 / LED_COUNT + 1);
  } else {
    // All-white load test: FastLED's power clamp should hold the current under
    // MAX_MILLIAMPS instead of browning out the board.
    fill_solid(leds, LED_COUNT, CRGB::White);
    if (now - lastPulseMs > 4300) lastPulseMs = now;
  }

  hue++;
  FastLED.show();
  FastLED.delay(16);
}
