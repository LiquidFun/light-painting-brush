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
  void poll(bool exposing) override;
  void publishStatus(const StatusSnapshot& s) override;
  bool linked() const override;
  uint16_t chunkSize() const override { return (uint16_t)LS_RELAY_CHUNK; }
  const char* name() const override { return "wifi"; }

  // Stable across reboots, derived from the MAC: the relay routes on it, so it
  // must not be random per boot.
  const char* deviceId() const;

  TransportHandler* handler() const { return handler_; }

  // Called from the WebSocket event callback.
  void onConnected();
  void onDisconnected();
  void onText(const uint8_t* payload, size_t len);

 private:
  void sendHello();

  TransportHandler* handler_ = nullptr;
  bool linked_ = false;
  uint32_t backoffMs_ = LS_RECONNECT_MIN_MS;
  bool wifiWasUp_ = false;
};
