#include "ble_service.h"

#include <Arduino.h>
#include <NimBLEDevice.h>

namespace {

NimBLEServer* server = nullptr;
NimBLECharacteristic* statusChar = nullptr;
BleService* self = nullptr;

void writeU16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)(v >> 8);
}

void writeU32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s) override {
    Serial.println("[ble] connected");
    // Keep advertising off while connected; one peer at a time is enough.
  }

  void onDisconnect(NimBLEServer* s) override {
    Serial.println("[ble] disconnected");
    if (self) {
      self->setMtu(23);
      if (self->handler()) self->handler()->onPeerDisconnect();
      self->startAdvertising();
    }
  }

  void onMTUChange(uint16_t mtu, ble_gap_conn_desc* desc) override {
    Serial.printf("[ble] MTU = %u\n", mtu);
    if (self) self->setMtu(mtu);
  }
};

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    NimBLEAttValue v = c->getValue();
    if (self && self->handler()) self->handler()->onControlWrite(v.data(), v.length());
  }
};

class DataCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    NimBLEAttValue v = c->getValue();
    if (self && self->handler()) self->handler()->onDataWrite(v.data(), v.length());
  }
};

ServerCallbacks serverCallbacks;
ControlCallbacks controlCallbacks;
DataCallbacks dataCallbacks;

}  // namespace

void BleService::begin(BleHandler* handler) {
  handler_ = handler;
  self = this;

  NimBLEDevice::init(LS_DEVICE_NAME);
  NimBLEDevice::setMTU(LS_REQUESTED_MTU);  // §2.2: request 517 on connect

  server = NimBLEDevice::createServer();
  server->setCallbacks(&serverCallbacks);

  NimBLEService* service = server->createService(LS_SERVICE_UUID);

  NimBLECharacteristic* control =
      service->createCharacteristic(LS_CONTROL_UUID, NIMBLE_PROPERTY::WRITE);
  control->setCallbacks(&controlCallbacks);

  // Write-with-response for data chunks in v1: back-pressure for free, no
  // flow-control logic to get wrong (§2.7).
  NimBLECharacteristic* data =
      service->createCharacteristic(LS_DATA_UUID, NIMBLE_PROPERTY::WRITE);
  data->setCallbacks(&dataCallbacks);

  statusChar = service->createCharacteristic(
      LS_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  service->start();
  startAdvertising();
}

void BleService::startAdvertising() {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(LS_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();
  Serial.println("[ble] advertising as " LS_DEVICE_NAME);
}

void BleService::publishStatus(const StatusSnapshot& s) {
  if (!statusChar) return;

  uint8_t buf[LS_STATUS_SIZE] = {0};
  buf[ST_STATE] = (uint8_t)s.state;
  buf[ST_ERROR] = (uint8_t)s.error;
  writeU16(buf + ST_VERSION, LS_PROTOCOL_VERSION);
  writeU32(buf + ST_BYTES_RECEIVED, s.bytesReceived);
  writeU32(buf + ST_BYTES_EXPECTED, s.bytesExpected);
  writeU32(buf + ST_MAX_BYTES, s.maxAnimationBytes);

  statusChar->setValue(buf, sizeof(buf));
  if (connected()) statusChar->notify();
}

bool BleService::connected() const {
  return server != nullptr && server->getConnectedCount() > 0;
}

uint16_t BleService::chunkSize() const {
  uint16_t usable = mtu_ > 3 ? mtu_ - 3 : 20;
  return usable > LS_MAX_CHUNK ? LS_MAX_CHUNK : usable;
}
