// Light Painting Stick — firmware entry point and state machine.
//
// IDLE -> RECEIVING -> READY -> PLAYING -> READY  (PROTOCOL.md §4)
//
// The firmware is a dumb player: all interpolation, colour maths and gamma
// happen in the browser and arrive as fully-rendered RGB frames (§1).
//
// Which link delivers them sits behind Transport, so nothing below this line
// knows whether it is talking to the WiFi relay or the legacy BLE service.
//
// The stick holds several animations and can pick between them from the button
// alone, so a shoot needs no phone once they are loaded.

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
//
// A queue rather than a single slot. A peer can send two commands back to back —
// `select` then `play` is the obvious one — and the transport hands both over
// before loop() next runs. With one slot the first was silently overwritten, so
// a select-then-play played whatever had been selected before.
struct PendingControl {
  uint8_t op = 0;
  size_t len = 0;
  uint8_t payload[LS_HEADER_SIZE] = {0};
  /** Carried per command, so a name cannot attach itself to the wrong `begin`. */
  char name[LS_SLOT_NAME] = {0};
};

constexpr uint8_t PENDING_MAX = 4;
PendingControl pendingQueue[PENDING_MAX];
volatile uint8_t pendingHead = 0;  // next to run
volatile uint8_t pendingTail = 0;  // next free

// Written by onName, which always arrives immediately before its own `begin`.
char stagedName[LS_SLOT_NAME] = {0};
// The name belonging to the command currently being executed.
char pendingName[LS_SLOT_NAME] = {0};

// Set by the Data callback when a progress/completion notification is due.
volatile bool statusDue = false;
// Set when a chunk could not be stored. Acted on in loop(), like everything else
// the transport hands over.
volatile bool dataFailed = false;
// When the current transfer began, for the absolute ceiling.
uint32_t receiveStartedMs = 0;
uint32_t lastProgressNotifyBytes = 0;
volatile uint32_t lastDataMs = 0;

// When the current playback started, for bounding the radio-quiet window.
uint32_t playStartedMs = 0;

// Animation::revision() as last published. The sentinel forces one publish at
// boot, so a stick that comes up with a full directory still announces it.
uint32_t lastSlotRevision = 0xFFFFFFFFu;

uint32_t lastButtonMs = 0;
bool lastButtonLevel = HIGH;
uint32_t buttonDownMs = 0;
bool longPressFired = false;

// The animation picker, driven entirely from the button. Playback stops while it
// is open and the strip belongs to it.
bool picking = false;
uint32_t pickerFrameMs = 0;
uint16_t pickerFrame = 0;
/** The slot being pointed at. Only committed when the choice is confirmed. */
int8_t pickIndex = -1;

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

/** READY when something is stored and playable, IDLE when the set is empty. */
void settle() { setState(animation.loaded() ? STATE_READY : STATE_IDLE, lastError); }

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

void startPlayback() {
  if (!animation.loaded()) {
    reportBadState(OP_PLAY);
    return;
  }
  const AnimationHeader& h = animation.header();
  Serial.printf("[play] slot %d, %u frames @ %u fps, delay %u ms, loop=%d pingPong=%d\n",
                (int)animation.selected(), h.frameCount, h.fps, h.startDelayMs, h.loop(),
                h.pingPong());
  player.play(&animation);  // restarts from frame 0 if already playing (§3.1)
  playStartedMs = millis();
  setState(STATE_PLAYING);
}

// An upload is always accepted, from any state. There is no lock and no
// ownership (§3.7): a second person's upload cancels whatever is in progress,
// and refusing during playback only meant a wasted trip back to the phone.
//
// It cannot destroy the stored set. The new animation is written to space the
// directory has already released, and only becomes findable once its CRC checks
// out — so a failed transfer costs nothing but the slots it landed on.
void handleBeginUpload(const uint8_t* payload, size_t len) {
  player.stop();
  picking = false;

  ErrorCode err = animation.begin(payload, len, pendingName);
  if (err != LS_ERR_NONE) {
    Serial.printf("[upload] rejected, err 0x%02X, capacity %u\n", err,
                  (unsigned)animation.maxAnimationBytes());
    setState(STATE_ERROR, err);
    return;
  }

  const AnimationHeader& h = animation.header();
  Serial.printf("[upload] begin '%s': %u frames x %u LEDs = %u bytes, chunk %u\n",
                pendingName, h.frameCount, h.ledCount, (unsigned)animation.expected(),
                transport.chunkSize());
  lastProgressNotifyBytes = 0;
  lastDataMs = millis();
  receiveStartedMs = millis();
  dataFailed = false;
  setState(STATE_RECEIVING);
}

void finishUpload() {
  if (animation.verifyCrc() && animation.finish()) {
    Serial.printf("[upload] stored in slot %d, %u of %u slots used, heap %u\n",
                  (int)animation.selected(), (unsigned)animation.used(),
                  (unsigned)animation.slotCount(), (unsigned)ESP.getFreeHeap());
    bool autoPlay = animation.header().autoPlay();
    setState(STATE_READY);
    if (autoPlay) startPlayback();
  } else {
    Serial.println("[upload] CRC MISMATCH, discarding");
    animation.abort();
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
      picking = false;
      startPlayback();
      break;

    case OP_STOP:
      // Blank and return to READY with the animation intact (§3.1).
      player.stop();
      settle();
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

    case OP_SELECT:
      if (len < 1 || !animation.select((int8_t)payload[0])) {
        reportBadState(op);
        break;
      }
      player.stop();
      picking = false;
      settle();
      break;

    case OP_DELETE:
      if (len < 1 || !animation.remove(payload[0])) {
        reportBadState(op);
        break;
      }
      player.stop();
      // The picker may have been pointing at the slot that just went away.
      picking = false;
      settle();
      break;

    case OP_CLEAR:
      // Drops the selected animation, not the whole set.
      player.stop();
      if (animation.selected() >= 0) animation.remove((uint8_t)animation.selected());
      picking = false;
      settle();
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
      animation.abort();
      settle();
      break;

    default:
      reportBadState(op);
      break;
  }
}

class Handler : public TransportHandler {
  void onControl(const uint8_t* data, size_t len) override {
    if (len < 1) return;
    const uint8_t next = (uint8_t)((pendingTail + 1) % PENDING_MAX);
    if (next == pendingHead) {
      // Four commands deep without loop() getting a turn means something is very
      // wrong. Dropping the newest keeps the ones already queued intact.
      Serial.println("[ctrl] queue full, command dropped");
      return;
    }
    PendingControl& p = pendingQueue[pendingTail];
    p.op = data[0];
    p.len = len - 1 > LS_HEADER_SIZE ? LS_HEADER_SIZE : len - 1;
    memcpy(p.payload, data + 1, p.len);
    memcpy(p.name, stagedName, sizeof(p.name));
    pendingTail = next;
  }

  // Sanitised here rather than on the way out, so flash never holds a byte that
  // would have to be escaped again later: the name is echoed back as JSON, and a
  // quote or a backslash in it would break that frame for every browser.
  void onName(const char* name) override {
    size_t n = 0;
    for (const char* p = name; p && *p && n + 1 < sizeof(stagedName); p++) {
      if (*p >= 0x20 && *p < 0x7F && *p != '"' && *p != '\\') stagedName[n++] = *p;
    }
    stagedName[n] = 0;
  }

  void onData(const uint8_t* data, size_t len) override {
    if (state != STATE_RECEIVING) return;
    lastDataMs = millis();
    if (!animation.append(data, len)) {
      // Either the peer sent more than the header promised or a flash write
      // failed. Both are fatal to this transfer, and reporting nothing left it
      // to hit the 10 s idle timeout instead — which reads as a dead stick.
      dataFailed = true;
      return;
    }
    if (animation.complete() ||
        animation.received() - lastProgressNotifyBytes >= LS_PROGRESS_INTERVAL_BYTES) {
      statusDue = true;
    }
  }

  void onPeerLost() override {
    // A dropped connection must not disturb a stored animation or playback in
    // progress (§2). Only a partial transfer is worth abandoning, and doing so
    // now costs nothing: the stored set was never at risk.
    if (state == STATE_RECEIVING) {
      Serial.printf("[upload] aborted by disconnect at %u of %u bytes, %u ms in\n",
                    (unsigned)animation.received(), (unsigned)animation.expected(),
                    (unsigned)(millis() - receiveStartedMs));
      animation.abort();
      settle();
    }
  }
};

Handler handler;

/** Confirms the picker's choice, or opens it. Fired while the button is held. */
void onLongPress() {
  if (picking) {
    picking = false;
    // The commit: a CRC pass over the payload and a directory write, so it
    // happens once per visit to the picker rather than once per step.
    if (pickIndex >= 0 && pickIndex != animation.selected()) animation.select(pickIndex);
    Serial.printf("[picker] chose slot %d\n", (int)animation.selected());
    ledValid = false;
    settle();
    return;
  }
  if (animation.used() == 0) {
    Serial.println("[picker] nothing stored");
    return;
  }
  picking = true;
  pickerFrame = 0;
  pickIndex = animation.selected() >= 0 ? animation.selected() : animation.nextUsed(-1);
  player.stop();
  Serial.printf("[picker] open, %u stored, on slot %d\n", (unsigned)animation.used(),
                (int)pickIndex);
}

void onShortPress() {
  ledBlackoutAfterShot = false;

  if (picking) {
    const int8_t next = animation.nextUsed(pickIndex);
    if (next >= 0) pickIndex = next;
    pickerFrame = 0;
    return;
  }

  if (state == STATE_RECEIVING) {
    // The one control you have in a field, and it used to do nothing here —
    // which is what made a stuck transfer feel like a dead stick.
    Serial.println("[button] abandoning the transfer");
    animation.abort();
    settle();
    return;
  }

  if (player.exposing()) {
    // Toggle, so the one button both starts a shot and aborts one. Restarting
    // from frame 0 instead — which is what `play` does — is useless here: your
    // hand is on the stick, so a restart just smears the exposure.
    Serial.println("[button] stop");
    player.stop();
    settle();
    return;
  }

  if (animation.loaded()) startPlayback();
}

void pollButton() {
  // GPIO 0 is the on-board BOOT button, active low with INPUT_PULLUP.
  //
  // NOTE: GPIO 0 is a strapping pin. If it is held low at power-on the ESP32
  // comes up in serial bootloader mode instead of running this sketch. That is
  // harmless, but it looks exactly like a dead board — just release the button
  // and reset. See firmware/README.md.
  const bool level = digitalRead(BUTTON_PIN);
  const uint32_t now = millis();

  // buttonDownMs != 0 means a press got past the debounce and is still held. A
  // bounce leaves it at 0, so the release that follows does nothing rather than
  // counting as a second press.
  if (lastButtonLevel == HIGH && level == LOW) {
    if (now - lastButtonMs >= LS_BUTTON_DEBOUNCE_MS) {
      lastButtonMs = now;
      buttonDownMs = now;
      longPressFired = false;
    }
  } else if (lastButtonLevel == LOW && level == HIGH) {
    if (buttonDownMs != 0 && !longPressFired) onShortPress();
    buttonDownMs = 0;
  } else if (level == LOW && buttonDownMs != 0 && !longPressFired &&
             now - buttonDownMs >= LS_LONG_PRESS_MS) {
    // Fired while still held rather than on release, so the picker opens under
    // your thumb instead of after you let go.
    longPressFired = true;
    onLongPress();
  }

  lastButtonLevel = level;
}

void updateStatusLed() {
  // The picker owns the whole strip while it is open.
  bool canShow =
      !player.exposing() && !player.identifying() && !ledBlackoutAfterShot && !picking;
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

  // Before the transport, so the first status already reports a real capacity
  // and whatever survived the last power cycle.
  animation.mount();

  transport.begin(&handler);

  setState(animation.loaded() ? STATE_READY : STATE_IDLE);
}

void loop() {
  // Before the state machine, so a command that arrived this tick is acted on in
  // the same pass rather than one loop late.
  //
  // The radio stays quiet during an exposure (§4.2), but only for a bounded
  // window: a looping animation never finishes, and without the bound a socket
  // dropped mid-playback could never be rebuilt — the stick played on forever,
  // unreachable, and uploads had nothing to arrive over.
  const bool quiesce =
      player.exposing() && (millis() - playStartedMs) < LS_QUIESCE_MAX_MS;
  transport.poll(quiesce, player.exposing());

  // One per pass. The queue drains in microseconds at loop() rates, and running
  // the whole of it here would let a burst of commands each doing flash work
  // block the socket for as long as they take.
  if (pendingHead != pendingTail) {
    const PendingControl& p = pendingQueue[pendingHead];
    memcpy(pendingName, p.name, sizeof(pendingName));
    handleControl(p.op, p.payload, p.len);
    pendingHead = (uint8_t)((pendingHead + 1) % PENDING_MAX);
  }

  // The set changed — uploaded, selected, deleted or evicted. Watching the
  // revision rather than calling publishSlots from each of those places means a
  // new way to mutate the directory cannot silently stop updating the browser.
  if (animation.revision() != lastSlotRevision) {
    lastSlotRevision = animation.revision();
    transport.publishSlots(animation);
  }

  if (statusDue) {
    statusDue = false;
    lastProgressNotifyBytes = animation.received();
    if (state == STATE_RECEIVING && !animation.complete()) {
      // Elapsed and rate, not just a byte count. A transfer that dies at the
      // same *time* every attempt is the socket giving up on itself; one that
      // dies at the same *offset* is the flash. The byte count alone cannot
      // tell those apart, and guessing between them wasted a session.
      const uint32_t ms = millis() - receiveStartedMs;
      Serial.printf("[upload] %u / %u after %u ms (%u B/s)\n",
                    (unsigned)animation.received(), (unsigned)animation.expected(),
                    (unsigned)ms, (unsigned)(ms ? animation.received() * 1000u / ms : 0));
      publish();
    }
  }

  if (state == STATE_RECEIVING) {
    if (dataFailed) {
      dataFailed = false;
      Serial.printf("[upload] failed at %u of %u bytes\n", (unsigned)animation.received(),
                    (unsigned)animation.expected());
      animation.abort();
      setState(STATE_ERROR, LS_ERR_OUT_OF_MEMORY);
    } else if (animation.complete()) {
      finishUpload();
    } else if (millis() - lastDataMs > LS_TRANSFER_TIMEOUT_MS) {
      Serial.println("[upload] timeout: no data");
      animation.abort();
      setState(STATE_ERROR, LS_ERR_TIMEOUT);
    } else if (millis() - receiveStartedMs >
               LS_TRANSFER_GRACE_MS +
                   animation.expected() / LS_TRANSFER_MIN_BYTES_PER_MS) {
      // A trickle keeps lastDataMs fresh forever, and RECEIVING blocks playback
      // and the button. Better to fail than to sit there unusable.
      Serial.printf("[upload] timeout: %u of %u bytes after %u ms\n",
                    (unsigned)animation.received(), (unsigned)animation.expected(),
                    (unsigned)(millis() - receiveStartedMs));
      animation.abort();
      setState(STATE_ERROR, LS_ERR_TIMEOUT);
    }
  }

  if (player.tick()) {
    if (player.lateFrames() > 0) {
      // Silent otherwise: the animation simply takes longer than it was designed
      // to, and the photograph comes out stretched along the sweep.
      Serial.printf("[play] %u frames missed their slot, worst %u us late — "
                    "the frame rate is higher than this strip can clock out\n",
                    (unsigned)player.lateFrames(), (unsigned)player.worstLateUs());
    }
    // Playback ended on its own. The strip is already blank; keep it that way
    // until the next command or button press, so the indicator cannot reach the
    // sensor while the exposure is still running.
    ledBlackoutAfterShot = true;
    setState(STATE_READY);
  }

  pollButton();

  if (picking) {
    if (millis() - pickerFrameMs >= 1000 / LS_PICKER_FPS) {
      pickerFrameMs = millis();
      player.showPicker(animation, pickIndex, pickerFrame++);
    }
    return;
  }

  updateStatusLed();
}
