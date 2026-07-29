// Legacy NimBLE GATT server (v1). Transport only: it parses nothing, it just hands
// Control and Data writes to the handler and serialises Status notifications.
//
// Superseded by net.{h,cpp}. It stays until the WiFi path has been flashed and
// proven on real hardware (REQUIREMENTS §7, M4), and is only compiled by the
// `esp32dev_ble` environment. Do not extend it.
//
// NimBLE rather than Bluedroid: ~40-60 KB more free heap, and heap is the direct
// limiter on animation length.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "protocol.h"
#include "transport.h"

class BleService : public Transport {
 public:
  void begin(TransportHandler* handler) override;

  // BLE is driven entirely by NimBLE's own task, so there is nothing to pump.
  void poll(bool exposing) override { (void)exposing; }

  // Serialise and notify a 16-byte Status payload. Also updates the readable
  // value so a fresh connection can read state immediately.
  void publishStatus(const StatusSnapshot& s) override;

  bool linked() const override;

  // Derived from the negotiated MTU, never a constant: MTU negotiation can land
  // lower than requested and a hardcoded 512 would silently truncate.
  uint16_t chunkSize() const override;

  const char* name() const override { return "ble"; }

  uint16_t mtu() const { return mtu_; }
  void setMtu(uint16_t mtu) { mtu_ = mtu; }

  void startAdvertising();

  TransportHandler* handler() const { return handler_; }

 private:
  TransportHandler* handler_ = nullptr;
  uint16_t mtu_ = 23;  // BLE default until the peer negotiates up
};
