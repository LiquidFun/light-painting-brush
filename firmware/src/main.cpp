// Light Painting Stick — firmware entry point and state machine.
//
// IDLE -> RECEIVING -> READY -> PLAYING -> READY  (§3.1)
//
// The firmware is a dumb player: all interpolation, colour maths and gamma
// happen in the browser and arrive as fully-rendered RGB frames (§2.1).

#include <Arduino.h>

#include "animation.h"
#include "ble_service.h"
#include "player.h"
#include "protocol.h"

namespace {

Animation animation;
Player player;
BleService ble;

DeviceState state = STATE_IDLE;
ErrorCode lastError = ERR_NONE;

// Control writes arrive on the NimBLE task. They are parked here and executed
// from loop() so that only one context ever touches FastLED or the heap.
volatile bool pendingValid = false;
uint8_t pendingOp = 0;
uint8_t pendingPayload[LS_HEADER_SIZE];
size_t pendingLen = 0;

// Set by the Data callback when a progress/completion notification is due.
volatile bool statusDue = false;
uint32_t lastProgressNotifyBytes = 0;
volatile uint32_t lastDataMs = 0;

uint32_t lastButtonMs = 0;
bool lastButtonLevel = HIGH;

DeviceState ledShown = STATE_IDLE;
bool ledValid = false;

const char* stateName(DeviceState s) {
  switch (s) {
    case STATE_IDLE: return "IDLE";
    case STATE_RECEIVING: return "RECEIVING";
    case STATE_READY: return "READY";
    case STATE_PLAYING: return "PLAYING";
    case STATE_ERROR: return "ERROR";
  }
  return "?";
}

StatusSnapshot snapshot() {
  StatusSnapshot s;
  s.state = state;
  s.error = lastError;
  s.bytesReceived = animation.received();
  s.bytesExpected = animation.expected();
  s.maxAnimationBytes = Animation::maxAnimationBytes();
  return s;
}

void publish() { ble.publishStatus(snapshot()); }

void setState(DeviceState next, ErrorCode err = ERR_NONE) {
  if (state != next || lastError != err) {
    Serial.printf("[state] %s -> %s (err 0x%02X, heap %u)\n", stateName(state),
                  stateName(next), err, (unsigned)ESP.getFreeHeap());
  }
  state = next;
  lastError = err;
  publish();
}

// An opcode that makes no sense right now (§2.6 0x06). Reported as a one-off
// ERROR status; the real state is left intact so a loaded animation survives.
void reportBadState(uint8_t op) {
  Serial.printf("[ctrl] op 0x%02X rejected in %s\n", op, stateName(state));
  StatusSnapshot s = snapshot();
  s.state = STATE_ERROR;
  s.error = ERR_BAD_STATE;
  ble.publishStatus(s);
  publish();
}

// STATE_ERROR carries no animation, so it accepts a new upload just like IDLE.
bool acceptsUpload() {
  return state == STATE_IDLE || state == STATE_READY || state == STATE_ERROR;
}

void startPlayback() {
  if (!animation.loaded()) {
    reportBadState(OP_PLAY);
    return;
  }
  const AnimationHeader& h = animation.header();
  Serial.printf("[play] %u frames @ %u fps, delay %u ms, loop=%d pingPong=%d\n",
                h.frameCount, h.fps, h.startDelayMs, h.loop(), h.pingPong());
  player.play(&animation);  // restarts from frame 0 if already playing (§3.1)
  setState(STATE_PLAYING);
}

void handleBeginUpload(const uint8_t* payload, size_t len) {
  if (!acceptsUpload()) {
    reportBadState(OP_BEGIN_UPLOAD);
    return;
  }
  player.stop();

  ErrorCode err = animation.begin(payload, len);
  if (err != ERR_NONE) {
    Serial.printf("[upload] rejected, err 0x%02X, maxAlloc %u\n", err,
                  (unsigned)Animation::maxAnimationBytes());
    // No partial allocation is attempted; nothing is loaded (§3.1).
    setState(STATE_ERROR, err);
    return;
  }

  const AnimationHeader& h = animation.header();
  Serial.printf("[upload] begin: %u frames x %u LEDs = %u bytes, chunk %u\n",
                h.frameCount, h.ledCount, (unsigned)animation.expected(),
                ble.chunkSize());
  lastProgressNotifyBytes = 0;
  lastDataMs = millis();
  setState(STATE_RECEIVING);
}

void finishUpload() {
  if (animation.verifyCrc()) {
    Serial.printf("[upload] CRC ok, %u bytes, heap %u\n",
                  (unsigned)animation.expected(), (unsigned)ESP.getFreeHeap());
    bool autoPlay = animation.header().autoPlay();
    setState(STATE_READY);
    if (autoPlay) startPlayback();
  } else {
    Serial.println("[upload] CRC MISMATCH, discarding");
    animation.reset();
    setState(STATE_ERROR, ERR_CRC_MISMATCH);
  }
}

void handleControl(uint8_t op, const uint8_t* payload, size_t len) {
  switch (op) {
    case OP_BEGIN_UPLOAD:
      handleBeginUpload(payload, len);
      break;

    case OP_PLAY:
      startPlayback();
      break;

    case OP_STOP:
      // Blank and return to READY with the buffer intact (§3.1).
      player.stop();
      setState(animation.loaded() ? STATE_READY : STATE_IDLE, lastError);
      break;

    case OP_SET_BRIGHTNESS:
      if (len < 1) {
        reportBadState(op);
        break;
      }
      player.setBrightness(payload[0]);
      Serial.printf("[ctrl] brightness = %u\n", payload[0]);
      ledValid = false;
      publish();
      break;

    case OP_CLEAR:
      player.stop();
      animation.reset();
      setState(STATE_IDLE);
      break;

    case OP_IDENTIFY:
      if (player.exposing()) {
        reportBadState(op);
        break;
      }
      player.identify();
      break;

    case OP_ABORT_UPLOAD:
      if (state != STATE_RECEIVING) {
        reportBadState(op);
        break;
      }
      animation.reset();
      setState(STATE_IDLE);
      break;

    default:
      reportBadState(op);
      break;
  }
}

class Handler : public BleHandler {
  void onControlWrite(const uint8_t* data, size_t len) override {
    if (len < 1) return;
    pendingOp = data[0];
    pendingLen = len - 1 > LS_HEADER_SIZE ? LS_HEADER_SIZE : len - 1;
    memcpy(pendingPayload, data + 1, pendingLen);
    pendingValid = true;
  }

  void onDataWrite(const uint8_t* data, size_t len) override {
    if (state != STATE_RECEIVING) return;
    lastDataMs = millis();
    if (!animation.append(data, len)) {
      // Overrun: the peer sent more than the header promised.
      statusDue = true;
      return;
    }
    if (animation.complete() ||
        animation.received() - lastProgressNotifyBytes >= LS_PROGRESS_INTERVAL_BYTES) {
      statusDue = true;
    }
  }

  void onPeerDisconnect() override {
    // Mid-upload disconnect: drop the partial transfer so the next connection
    // starts clean and can simply retry from the beginning (§4.8).
    if (state == STATE_RECEIVING) {
      Serial.println("[upload] aborted by disconnect");
      animation.reset();
      setState(STATE_IDLE);
    }
  }
};

Handler handler;

void pollButton() {
  // GPIO 0 is the on-board BOOT button, active low with INPUT_PULLUP.
  //
  // NOTE: GPIO 0 is a strapping pin. If it is held low at power-on the ESP32
  // comes up in serial bootloader mode instead of running this sketch. That is
  // harmless, but it looks exactly like a dead board — just release the button
  // and reset. See firmware/README.md.
  bool level = digitalRead(BUTTON_PIN);
  uint32_t now = millis();
  if (lastButtonLevel == HIGH && level == LOW &&
      now - lastButtonMs >= LS_BUTTON_DEBOUNCE_MS) {
    lastButtonMs = now;
    Serial.println("[button] press");
    if (animation.loaded()) startPlayback();
  }
  lastButtonLevel = level;
}

void updateStatusLed() {
  bool canShow = !player.exposing() && !player.identifying();
  if (!canShow) {
    ledValid = false;
    return;
  }
  if (!ledValid || ledShown != state) {
    player.showStatusLed(state);
    ledShown = state;
    ledValid = true;
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println();
  Serial.println("[boot] LightStick");
  Serial.printf("[boot] %u LEDs on GPIO %u, %u mA budget, heap %u\n", LED_COUNT,
                DATA_PIN, MAX_MILLIAMPS, (unsigned)ESP.getFreeHeap());

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  player.begin();
  ble.begin(&handler);

  setState(STATE_IDLE);
}

void loop() {
  if (pendingValid) {
    pendingValid = false;
    handleControl(pendingOp, pendingPayload, pendingLen);
  }

  if (statusDue) {
    statusDue = false;
    lastProgressNotifyBytes = animation.received();
    if (state == STATE_RECEIVING && !animation.complete()) {
      Serial.printf("[upload] %u / %u\n", (unsigned)animation.received(),
                    (unsigned)animation.expected());
      publish();
    }
  }

  if (state == STATE_RECEIVING) {
    if (animation.complete()) {
      finishUpload();
    } else if (millis() - lastDataMs > LS_TRANSFER_TIMEOUT_MS) {
      Serial.println("[upload] timeout");
      animation.reset();
      setState(STATE_ERROR, ERR_TIMEOUT);
    }
  }

  if (player.tick()) {
    // Playback ended on its own.
    setState(STATE_READY);
  }

  pollButton();
  updateStatusLed();
}
