#include "net.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <string.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy firmware/src/secrets.example.h to firmware/src/secrets.h and fill it in."
#endif

namespace {

struct Network {
  const char* ssid;
  const char* password;
};

const Network NETWORKS[] = {LS_WIFI_NETWORKS};

WiFiMulti wifiMulti;
WebSocketsClient ws;
NetService* self = nullptr;

char deviceIdBuf[32] = "lightstick-000000000000";

/** How long to sit in wifiMulti.run() before giving up on this pass. */
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 6000;
constexpr uint32_t WIFI_RETRY_MS = 5000;

uint32_t lastWifiAttemptMs = 0;
uint32_t failedJoins = 0;
StatusSnapshot lastStatus;

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

void buildDeviceId() {
  String mac = WiFi.macAddress();  // "AA:BB:CC:DD:EE:FF"
  mac.replace(":", "");
  mac.toLowerCase();
  snprintf(deviceIdBuf, sizeof(deviceIdBuf), "lightstick-%s", mac.c_str());
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (!self) return;
  switch (type) {
    case WStype_CONNECTED:
      self->onConnected();
      break;
    case WStype_DISCONNECTED:
      self->onDisconnected();
      break;
    case WStype_TEXT:
      self->onText(payload, length);
      break;
    case WStype_BIN:
      if (self->handler()) self->handler()->onData(payload, length);
      break;
    case WStype_ERROR:
      Serial.println("[net] websocket error");
      break;
    default:
      // Ping/pong and fragment events need nothing from us.
      break;
  }
}

const char* wifiStatusName(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS: return "idle";
    case WL_NO_SSID_AVAIL: return "no such SSID in range";
    case WL_SCAN_COMPLETED: return "scan completed";
    case WL_CONNECTED: return "connected";
    case WL_CONNECT_FAILED: return "connect failed (wrong password?)";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED: return "disconnected";
    default: return "?";
  }
}

/**
 * Lists what the radio can actually see. This is the diagnostic that separates
 * "wrong password" from "that SSID is 5 GHz or hidden" — the ESP32 is 2.4 GHz
 * only, so a 5 GHz network simply never appears here, and WiFiMulti cannot join
 * a hidden one because it picks from scan results.
 */
void logVisibleNetworks() {
  int n = WiFi.scanNetworks();
  if (n <= 0) {
    Serial.println("[wifi] scan found nothing — is the antenna connected?");
    return;
  }
  Serial.printf("[wifi] %d network(s) visible on 2.4 GHz:\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("[wifi]   %-32s ch%-3d %4d dBm %s\n", WiFi.SSID(i).c_str(),
                  WiFi.channel(i), WiFi.RSSI(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "encrypted");
  }
  WiFi.scanDelete();
}

/** Ensures a WiFi association. Blocks while scanning, so never call mid-exposure. */
void ensureWifi(bool& wasUp) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasUp) {
      wasUp = true;
      failedJoins = 0;
      Serial.printf("[wifi] %s, ip %s, rssi %d\n", WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return;
  }
  wasUp = false;
  uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) return;
  lastWifiAttemptMs = now;

  wl_status_t status = (wl_status_t)wifiMulti.run(WIFI_CONNECT_TIMEOUT_MS);
  if (status == WL_CONNECTED) return;

  Serial.printf("[wifi] join failed: %s (status %d)\n", wifiStatusName(status), status);
  // On the first failure, and then rarely, dump the scan. Once is usually enough
  // to spot the problem; repeating it every 5 s would bury everything else.
  if (failedJoins == 0 || failedJoins % 12 == 0) logVisibleNetworks();
  failedJoins++;
}

}  // namespace

void NetService::begin(TransportHandler* handler) {
  handler_ = handler;
  self = this;

  WiFi.mode(WIFI_STA);
  // Modem sleep saves power but adds tens of milliseconds of latency to every
  // packet, which shows up as a stalled upload rather than as savings.
  WiFi.setSleep(false);
  buildDeviceId();

  for (const Network& n : NETWORKS) wifiMulti.addAP(n.ssid, n.password);
  Serial.printf("[net] %u network(s), device %s\n", (unsigned)(sizeof(NETWORKS) / sizeof(NETWORKS[0])),
                deviceIdBuf);

  ws.setAuthorization(LS_RELAY_USER, LS_RELAY_PASSWORD);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(LS_RECONNECT_MIN_MS);
  // Without this a half-open socket after a roam looks like a live one until the
  // next upload stalls for ten seconds.
  ws.enableHeartbeat(15000, 3000, 2);

#if LS_RELAY_TLS
  ws.beginSSL(LS_RELAY_HOST, LS_RELAY_PORT, LS_RELAY_PATH);
#else
  ws.begin(LS_RELAY_HOST, LS_RELAY_PORT, LS_RELAY_PATH);
#endif
  Serial.printf("[net] relay %s:%u%s (tls %d)\n", LS_RELAY_HOST, (unsigned)LS_RELAY_PORT,
                LS_RELAY_PATH, LS_RELAY_TLS);
}

void NetService::poll(bool exposing) {
  // §4.2: the radio must not disturb playback. The animation is already in RAM and
  // needs no network to play, so during an exposure this does nothing that could
  // block — no WiFi scan, no TCP connect, no TLS handshake. An established socket
  // is still serviced, so `stop` still lands promptly.
  if (exposing && !linked_) return;
  if (!exposing) ensureWifi(wifiWasUp_);
  ws.loop();
}

void NetService::onConnected() {
  linked_ = true;
  backoffMs_ = LS_RECONNECT_MIN_MS;
  ws.setReconnectInterval(backoffMs_);
  Serial.printf("[net] relay connected, heap %u\n", (unsigned)ESP.getFreeHeap());
  sendHello();
  publishStatus(lastStatus);
}

void NetService::onDisconnected() {
  bool wasLinked = linked_;
  linked_ = false;
  // Exponential backoff capped at 30 s (§3.2). arduinoWebSockets retries on a
  // fixed interval, so the growth has to be applied here.
  backoffMs_ = backoffMs_ * 2 > LS_RECONNECT_MAX_MS ? LS_RECONNECT_MAX_MS : backoffMs_ * 2;
  ws.setReconnectInterval(backoffMs_);
  if (wasLinked) {
    Serial.printf("[net] relay lost, retrying in %u ms\n", (unsigned)backoffMs_);
    if (handler_) handler_->onPeerLost();
  } else {
    // A socket that never came up at all used to log nothing, which looks
    // identical to the event loop not running. Rate-limited by the backoff.
    Serial.printf("[net] relay connect failed: %s%s:%u%s, retrying in %u ms\n",
                  LS_RELAY_TLS ? "wss://" : "ws://", LS_RELAY_HOST,
                  (unsigned)LS_RELAY_PORT, LS_RELAY_PATH, (unsigned)backoffMs_);
  }
}

void NetService::onText(const uint8_t* payload, size_t len) {
  if (!handler_) return;

  JsonDocument doc;
  if (deserializeJson(doc, (const char*)payload, len)) {
    Serial.println("[net] unparseable message");
    return;
  }
  const char* t = doc["t"] | "";

  if (strcmp(t, "begin") == 0) {
    uint8_t frame[1 + LS_HEADER_SIZE] = {0};
    frame[0] = OP_BEGIN_UPLOAD;
    uint8_t* h = frame + 1;
    writeU32(h + HDR_MAGIC, LS_MAGIC);
    // The relay's protocol version goes in the header's version byte, so a
    // mismatch comes back as error 0x02 without a second code path.
    h[HDR_VERSION] = (uint8_t)(doc["proto"] | 0);
    uint8_t flags = 0;
    if (doc["loop"] | false) flags |= FLAG_LOOP;
    if (doc["pingPong"] | false) flags |= FLAG_PING_PONG;
    if (doc["autoPlay"] | false) flags |= FLAG_AUTOPLAY;
    h[HDR_FLAGS] = flags;
    writeU16(h + HDR_LED_COUNT, (uint16_t)(doc["ledCount"] | 0));
    writeU16(h + HDR_FRAME_COUNT, (uint16_t)(doc["frameCount"] | 0));
    writeU16(h + HDR_FPS, (uint16_t)(doc["fps"] | 0));
    writeU16(h + HDR_START_DELAY, (uint16_t)(doc["startDelayMs"] | 0));
    writeU32(h + HDR_CRC32, doc["crc32"] | 0u);
    handler_->onControl(frame, sizeof(frame));
    return;
  }

  if (strcmp(t, "brightness") == 0) {
    long value = doc["value"] | 0;
    uint8_t frame[2] = {OP_SET_BRIGHTNESS,
                        (uint8_t)(value < 0 ? 0 : value > 255 ? 255 : value)};
    handler_->onControl(frame, sizeof(frame));
    return;
  }

  uint8_t op = 0;
  if (strcmp(t, "play") == 0) op = OP_PLAY;
  else if (strcmp(t, "stop") == 0) op = OP_STOP;
  else if (strcmp(t, "clear") == 0) op = OP_CLEAR;
  else if (strcmp(t, "identify") == 0) op = OP_IDENTIFY;
  // Anything else is a message type this firmware predates. Ignoring it lets the
  // server run ahead of the stick.
  if (op != 0) handler_->onControl(&op, 1);
}

void NetService::sendHello() {
  char buf[256];
  const char* label = sizeof(LS_DEVICE_LABEL) > 1 ? LS_DEVICE_LABEL : deviceIdBuf;
  snprintf(buf, sizeof(buf),
           "{\"t\":\"hello\",\"proto\":%u,\"deviceId\":\"%s\",\"name\":\"%s\","
           "\"ledCount\":%u,\"maxAnimationBytes\":%lu,\"fw\":\"%s\"}",
           (unsigned)LS_PROTO_VERSION, deviceIdBuf, label, (unsigned)LED_COUNT,
           (unsigned long)lastStatus.maxAnimationBytes, LS_FIRMWARE_VERSION);
  ws.sendTXT(buf);
}

void NetService::publishStatus(const StatusSnapshot& s) {
  // Cached even when offline, so the next `hello` reports a real ceiling.
  lastStatus = s;
  if (!linked_) return;

  char buf[224];
  snprintf(buf, sizeof(buf),
           "{\"t\":\"status\",\"state\":%u,\"error\":%u,\"bytesReceived\":%lu,"
           "\"bytesExpected\":%lu,\"maxAnimationBytes\":%lu}",
           (unsigned)s.state, (unsigned)s.error, (unsigned long)s.bytesReceived,
           (unsigned long)s.bytesExpected, (unsigned long)s.maxAnimationBytes);
  ws.sendTXT(buf);
}

LinkStage NetService::linkStage() const {
  if (linked_) return LS_LINK_UP;
  // Distinguishing these two is the whole point: no association means the SSID,
  // the band or the password; associated but not connected means the relay, the
  // hostname, TLS or the Basic auth credentials.
  return WiFi.status() == WL_CONNECTED ? LS_LINK_NETWORK : LS_LINK_DOWN;
}

const char* NetService::deviceId() const { return deviceIdBuf; }
