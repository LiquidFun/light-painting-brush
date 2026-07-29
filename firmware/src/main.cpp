// Light Painting Stick — firmware entry point and state machine.
//
// IDLE -> RECEIVING -> READY -> PLAYING -> READY  (PROTOCOL.md §4)
//
// The firmware is a dumb player: all interpolation, colour maths and gamma
// happen in the browser and arrive as fully-rendered RGB frames (§1).
//
// Which link delivers them sits behind Transport, so nothing below this line
// knows whether it is talking to the WiFi relay or the legacy BLE service.

#include <Arduino.h>

#include "animation.h"
#include "player.h"
#include "protocol.h"
#include "transport.h"

#if LS_USE_WIFI
#include "net.h"
#else
#include "ble_service.h"
#endif

namespace {

Animation animation;
Player player;

#if LS_USE_WIFI
NetService transport;
#else
BleService transport;
#endif

DeviceState state = STATE_IDLE;
ErrorCode lastError = LS_ERR_NONE;

// Control messages arrive on the network or NimBLE task. They are parked here and
// executed from loop() so that only one context ever touches FastLED or the heap.
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
LinkStage ledLink = LS_LINK_DOWN;
bool ledValid = false;

// The shutter is almost always still open when an animation ends — that is the
// whole point of a long exposure. Lighting the status dot the moment playback
// finishes therefore paints it into the photograph, at wherever the stick
// happened to be. So after a shot the indicator stays dark until the user does
// something, which is the only reliable signal that the exposure is over.
bool ledBlackoutAfterShot = false;

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
  s.maxAnimationBytes = animation.maxAnimationBytes();
  return s;
}

void publish() { transport.publishStatus(snapshot()); }

void setState(DeviceState next, ErrorCode err = LS_ERR_NONE) {
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
  s.error = LS_ERR_BAD_STATE;
  transport.publishStatus(s);
  publish();
}

// STATE_ERROR carries no animation, so it accepts a new upload just like IDLE.
//
// STATE_RECEIVING accepts one too: there is no lock and no ownership (§3.7), so a
// second person's upload cancels the transfer in progress rather than being
// refused. Animation::begin frees the old buffer before sizing the new one, and
// the interrupted client sees the state change on the broadcast and can retry.
// It is also how a cancelled upload is retried without waiting out the timeout.
bool acceptsUpload() { return state != STATE_PLAYING; }

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
  if (err != LS_ERR_NONE) {
    Serial.printf("[upload] rejected, err 0x%02X, maxAlloc %u\n", err,
                  (unsigned)animation.maxAnimationBytes());
    // No partial allocation is attempted; nothing is loaded (§3.1).
    setState(STATE_ERROR, err);
    return;
  }

  const AnimationHeader& h = animation.header();
  Serial.printf("[upload] begin: %u frames x %u LEDs = %u bytes, chunk %u\n",
                h.frameCount, h.ledCount, (unsigned)animation.expected(),
                transport.chunkSize());
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
    setState(STATE_ERROR, LS_ERR_CRC_MISMATCH);
  }
}

void handleControl(uint8_t op, const uint8_t* payload, size_t len) {
  // Any command means somebody is back at the controls, so the shutter is shut.
  ledBlackoutAfterShot = false;
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

class Handler : public TransportHandler {
  void onControl(const uint8_t* data, size_t len) override {
    if (len < 1) return;
    pendingOp = data[0];
    pendingLen = len - 1 > LS_HEADER_SIZE ? LS_HEADER_SIZE : len - 1;
    memcpy(pendingPayload, data + 1, pendingLen);
    pendingValid = true;
  }

  void onData(const uint8_t* data, size_t len) override {
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

  void onPeerLost() override {
    // A dropped connection must not disturb a loaded animation or playback in
    // progress (§2). Only a partial transfer is worth abandoning: the next
    // connection then starts clean and the client retries from the beginning.
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
    ledBlackoutAfterShot = false;
    if (animation.loaded()) startPlayback();
  }
  lastButtonLevel = level;
}

void updateStatusLed() {
  bool canShow = !player.exposing() && !player.identifying() && !ledBlackoutAfterShot;
  if (!canShow) {
    ledValid = false;
    return;
  }
  LinkStage link = transport.linkStage();
  if (!ledValid || ledShown != state || ledLink != link) {
    player.showStatusLed(state, link);
    ledShown = state;
    ledLink = link;
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
  Serial.printf("[boot] transport %s, protocol %u, fw %s\n", transport.name(),
                (unsigned)LS_VERSION, LS_FIRMWARE_VERSION);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  player.begin();
  transport.begin(&handler);

  setState(STATE_IDLE);
}

void loop() {
  // Before the state machine, so a command that arrived this tick is acted on in
  // the same pass rather than one loop late.
  transport.poll(player.exposing());

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
      setState(STATE_ERROR, LS_ERR_TIMEOUT);
    }
  }

  if (player.tick()) {
    // Playback ended on its own. The strip is already blank; keep it that way
    // until the next command or button press, so the indicator cannot reach the
    // sensor while the exposure is still running.
    ledBlackoutAfterShot = true;
    setState(STATE_READY);
  }

  pollButton();
  updateStatusLed();
}
