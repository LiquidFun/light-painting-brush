// WiFi + WebSocket client (REQUIREMENTS §4.2, PROTOCOL.md §2-§6).
//
// The device dials out to the relay; it never listens. That means no port
// forwarding, no certificate on the device, and identical behaviour on a home
// network and a phone hotspot.
//
// Transport only: it parses no animation data. JSON commands are translated into
// the opcode frames in protocol.h and handed to the state machine in main.cpp.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "transport.h"

class NetService : public Transport {
 public:
  void begin(TransportHandler* handler) override;
  void poll(bool quiesce, bool playing) override;
  void publishStatus(const StatusSnapshot& s) override;
  void publishSlots(const Animation& store) override;
  LinkStage linkStage() const override;
  uint16_t chunkSize() const override { return (uint16_t)LS_RELAY_CHUNK; }
  const char* name() const override { return "wifi"; }

  // Stable across reboots, derived from the MAC: the relay routes on it, so it
  // must not be random per boot.
  const char* deviceId() const;

  TransportHandler* handler() const { return handler_; }

  // Called from the WebSocket event callback. `reason` is the library's own
  // description of the drop and is not NUL-terminated; it carries the HTTP status
  // when a handshake was refused, which is the difference between a wrong
  // password, a wrong path and a relay that is not running.
  void onConnected();
  void onDisconnected(const uint8_t* reason, size_t len);
  void onText(const uint8_t* payload, size_t len);

 private:
  void sendHello();

  // Says something, periodically, while the radio is on the network but the relay
  // socket is not up. See the definition for why this cannot be event-driven.
  void reportRelayDown();

  // Keep-alive on or off. Off during a transfer: flash writes stall ws.loop()
  // for seconds, so a busy stick could not answer a ping and disconnected
  // itself part-way through a large upload. `force` re-applies it after a
  // reconnect, where the library has rebuilt its client state.
  void setHeartbeat(bool on, bool force = false);

  TransportHandler* handler_ = nullptr;
  bool linked_ = false;
  bool heartbeat_ = true;
  uint32_t backoffMs_ = LS_RECONNECT_MIN_MS;
  bool wifiWasUp_ = false;

  // For reportRelayDown: when the relay socket went away, and when we last said
  // so. `relayDown_` rather than a zero sentinel on the timestamps, because
  // millis() is legitimately 0 for the first millisecond after boot.
  bool relayDown_ = false;
  uint32_t relayDownSinceMs_ = 0;
  uint32_t relayGripedAtMs_ = 0;
};
