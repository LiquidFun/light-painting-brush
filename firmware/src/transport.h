// One interface in front of both links, so main.cpp's state machine does not know
// whether commands arrived over the WiFi relay or the legacy BLE GATT service
// (REQUIREMENTS §7, M4).
//
// Both deliver the same two things: an opcode-prefixed control frame and raw
// payload bytes. net.cpp translates the relay's JSON into that shape rather than
// forcing the state machine to understand two encodings.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

// Only ever passed by reference, and animation.h has no business being pulled
// into every transport's translation unit.
class Animation;

// How far the stick has got toward being reachable. Split out from a plain bool
// because "the radio never joined" and "joined, but the relay did not answer"
// need completely different fixes, and the status LED is often the only
// diagnostic available in a field (§4.4).
//
// LS_-prefixed for the same reason as the error codes: lwIP is in the global
// namespace on the WiFi build and is generous with names like LINK_UP.
enum LinkStage : uint8_t {
  LS_LINK_DOWN = 0,     // no network association at all
  LS_LINK_NETWORK = 1,  // on the network, but not talking to the relay
  LS_LINK_UP = 2,       // relay connected
};

struct StatusSnapshot {
  DeviceState state = STATE_IDLE;
  ErrorCode error = LS_ERR_NONE;
  uint32_t bytesReceived = 0;
  uint32_t bytesExpected = 0;
  uint32_t maxAnimationBytes = 0;
};

class TransportHandler {
 public:
  virtual ~TransportHandler() = default;

  // `data[0]` is the opcode; the rest is its payload. For OP_BEGIN_UPLOAD that
  // payload is the 20-byte header from protocol.h.
  virtual void onControl(const uint8_t* data, size_t len) = 0;

  // The name to file the next upload under. Separate from onControl because the
  // 20-byte header has no room for it and widening it would break the BLE build;
  // the relay sends it alongside `begin`, immediately before the control frame.
  // Transports that cannot carry a name simply never call this.
  virtual void onName(const char* name) { (void)name; }

  virtual void onData(const uint8_t* data, size_t len) = 0;

  // The link went away. Must not disturb a loaded animation or playback in
  // progress (§3.2) — only a partial transfer is worth abandoning.
  virtual void onPeerLost() = 0;
};

class Transport {
 public:
  virtual ~Transport() = default;

  virtual void begin(TransportHandler* handler) = 0;

  // Called every loop(). Drives the socket, reconnection and WiFi state.
  //
  // `quiesce`: the shutter may be open and this must not block at all — a WiFi
  // scan or TLS handshake would stretch the photograph's time axis (§4.2). The
  // caller bounds how long that lasts, since a looping animation never ends.
  //
  // `playing`: frames are going out, so even past the quiet window nothing here
  // may block for long. A scan takes seconds and freezes the animation solid.
  virtual void poll(bool quiesce, bool playing) = 0;

  virtual void publishStatus(const StatusSnapshot& s) = 0;

  // The stored set, whenever it changes. Kept out of the status message because
  // that one goes out several times a second during an upload and this one is a
  // kilobyte. Transports that have no way to express it ignore it — the picker
  // works from the button alone, so a browser view of the set is a convenience.
  virtual void publishSlots(const Animation& store) { (void)store; }

  virtual LinkStage linkStage() const = 0;

  // True when a peer could receive a status right now.
  bool linked() const { return linkStage() == LS_LINK_UP; }

  // Bytes per inbound chunk, for the boot log. Derived from the negotiated MTU on
  // BLE; a constant on the relay.
  virtual uint16_t chunkSize() const = 0;

  virtual const char* name() const = 0;
};
