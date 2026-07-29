// NimBLE GATT server (§2.2). Transport only: it parses nothing, it just hands
// Control and Data writes to a handler and serialises Status notifications.
//
// NimBLE rather than Bluedroid: ~40-60 KB more free heap, and heap is the direct
// limiter on animation length (REQUIREMENTS §1).

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

struct StatusSnapshot {
  DeviceState state = STATE_IDLE;
  ErrorCode error = ERR_NONE;
  uint32_t bytesReceived = 0;
  uint32_t bytesExpected = 0;
  uint32_t maxAnimationBytes = 0;
};

class BleHandler {
 public:
  virtual void onControlWrite(const uint8_t* data, size_t len) = 0;
  virtual void onDataWrite(const uint8_t* data, size_t len) = 0;
  virtual void onPeerDisconnect() = 0;
};

class BleService {
 public:
  void begin(BleHandler* handler);

  // Serialise and notify a 16-byte Status payload (§2.5). Also updates the
  // readable value so a fresh connection can read state immediately.
  void publishStatus(const StatusSnapshot& s);

  bool connected() const;

  // Derived from the negotiated MTU, never a constant: MTU negotiation can land
  // lower than requested and a hardcoded 512 would silently truncate (§6).
  uint16_t chunkSize() const;
  uint16_t mtu() const { return mtu_; }
  void setMtu(uint16_t mtu) { mtu_ = mtu; }

  void startAdvertising();

  BleHandler* handler() const { return handler_; }

 private:
  BleHandler* handler_ = nullptr;
  uint16_t mtu_ = 23;  // BLE default until the peer negotiates up
};
