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
  // While `exposing`, do nothing that could block: the shutter is open, the
  // animation plays from RAM and needs no network, and a WiFi scan or TLS
  // handshake would stretch the time axis of the photograph (§4.2).
  virtual void poll(bool exposing) = 0;

  virtual void publishStatus(const StatusSnapshot& s) = 0;

  // True when a peer could receive a status right now.
  virtual bool linked() const = 0;

  // Bytes per inbound chunk, for the boot log. Derived from the negotiated MTU on
  // BLE; a constant on the relay.
  virtual uint16_t chunkSize() const = 0;

  virtual const char* name() const = 0;
};
