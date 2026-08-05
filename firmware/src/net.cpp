#include "net.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <string.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>

#include "animation.h"

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
constexpr uint32_t WIFI_RETRY_MS = 1500;
/** Direct re-joins to try before falling back to a full scan. */
constexpr uint32_t DIRECT_REJOIN_TRIES = 5;

uint32_t lastWifiAttemptMs = 0;
/** Index into NETWORKS of the AP we were last associated with, or -1. */
int lastNetwork = -1;
uint32_t directTries = 0;

/**
 * The access point we last joined, kept in NVS across reboots.
 *
 * Joining blind costs a full scan of every 2.4 GHz channel — seconds, every
 * time, including at boot. Given the exact BSSID and channel the radio can go
 * straight to it, which is the difference between a stick that is on the network
 * before you have finished picking it up and one you stand around waiting for.
 */
Preferences prefs;
uint8_t hintBssid[6] = {0};
int32_t hintChannel = 0;
bool haveHint = false;

void loadHint() {
  if (!prefs.begin("lightstick", true)) return;
  hintChannel = prefs.getInt("ch", 0);
  haveHint = prefs.getBytes("bssid", hintBssid, sizeof(hintBssid)) == sizeof(hintBssid) &&
             hintChannel > 0;
  lastNetwork = prefs.getInt("net", -1);
  prefs.end();
  if (haveHint) {
    Serial.printf("[wifi] remembered channel %d, going straight there\n", (int)hintChannel);
  }
}

void saveHint() {
  const uint8_t* bssid = WiFi.BSSID();
  if (!bssid) return;
  if (!prefs.begin("lightstick", false)) return;
  prefs.putBytes("bssid", bssid, 6);
  prefs.putInt("ch", WiFi.channel());
  prefs.putInt("net", lastNetwork);
  prefs.end();
  memcpy(hintBssid, bssid, 6);
  hintChannel = WiFi.channel();
  haveHint = true;
}

void forgetHint() {
  haveHint = false;
  if (!prefs.begin("lightstick", false)) return;
  prefs.remove("bssid");
  prefs.remove("ch");
  prefs.end();
}
uint32_t failedJoins = 0;
StatusSnapshot lastStatus;

// The last `slots` frame, rebuilt only when the set changes and resent verbatim
// on every reconnect. A browser that joins after the stick did must still see
// what is stored, and re-deriving it there would need the whole directory in the
// status message.
char slotsJson[2048] = {0};

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

/**
 * Ensures a WiFi association.
 *
 * Re-joining a network we have already been on is non-blocking: WiFi.begin()
 * returns immediately and a later poll notices the status. Only finding a
 * network from scratch needs wifiMulti.run(), which scans and blocks for
 * seconds — long enough to freeze an animation on one frame, so it is never
 * done while frames are going out.
 */
void ensureWifi(bool& wasUp, bool playing) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasUp) {
      wasUp = true;
      failedJoins = 0;
      directTries = 0;
      // Remember which one, so the next drop can re-join it without a scan.
      for (size_t i = 0; i < sizeof(NETWORKS) / sizeof(NETWORKS[0]); i++) {
        if (WiFi.SSID() == NETWORKS[i].ssid) lastNetwork = (int)i;
      }
      saveHint();
      Serial.printf("[wifi] %s, ip %s, rssi %d\n", WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return;
  }
  wasUp = false;
  uint32_t now = millis();
  if (now - lastWifiAttemptMs < WIFI_RETRY_MS) return;
  lastWifiAttemptMs = now;

  if (lastNetwork >= 0 && directTries < DIRECT_REJOIN_TRIES) {
    directTries++;
    if (haveHint) {
      // Channel and BSSID given, so the radio skips the scan entirely.
      WiFi.begin(NETWORKS[lastNetwork].ssid, NETWORKS[lastNetwork].password, hintChannel,
                 hintBssid);
    } else {
      WiFi.begin(NETWORKS[lastNetwork].ssid, NETWORKS[lastNetwork].password);
    }
    return;
  }
  // The remembered AP is not answering — it may have moved channel, or we may be
  // somewhere else entirely. Drop the hint so the scan below can find the truth.
  if (haveHint) {
    Serial.println("[wifi] remembered AP did not answer, falling back to a scan");
    forgetHint();
  }

  // From here on it blocks, so not while the strip is live.
  if (playing) return;

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
  // The SDK reconnects faster than our loop can notice and react.
  WiFi.setAutoReconnect(true);
  // Credentials come from secrets.h on every boot, so letting the SDK write its
  // own copy to flash buys nothing and costs a flash write per connect.
  WiFi.persistent(false);
  buildDeviceId();
  loadHint();

  for (const Network& n : NETWORKS) wifiMulti.addAP(n.ssid, n.password);
  Serial.printf("[net] %u network(s), device %s\n", (unsigned)(sizeof(NETWORKS) / sizeof(NETWORKS[0])),
                deviceIdBuf);

  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(LS_RECONNECT_MIN_MS);
  // Without this a half-open socket after a roam looks like a live one until the
  // next upload stalls for ten seconds. Suspended during a transfer — see
  // setHeartbeat below.
  ws.enableHeartbeat(LS_PING_INTERVAL_MS, LS_PONG_TIMEOUT_MS, LS_PONG_MISSES);

#if LS_RELAY_TLS
  ws.beginSSL(LS_RELAY_HOST, LS_RELAY_PORT, LS_RELAY_PATH);
#else
  ws.begin(LS_RELAY_HOST, LS_RELAY_PORT, LS_RELAY_PATH);
#endif

  // MUST come after begin*(): begin() clears base64Authorization and
  // plainAuthorization, so setting credentials first silently sends none and
  // every handshake comes back 401. onEvent, setReconnectInterval and the
  // heartbeat intervals survive begin(), which is why only this one moved.
  ws.setAuthorization(LS_RELAY_USER, LS_RELAY_PASSWORD);
  Serial.printf("[net] relay %s:%u%s (tls %d)\n", LS_RELAY_HOST, (unsigned)LS_RELAY_PORT,
                LS_RELAY_PATH, LS_RELAY_TLS);
}

void NetService::poll(bool quiesce, bool playing) {
  // §4.2: the radio must not disturb an exposure, so while `quiesce` is set this
  // does nothing that could block — no scan, no TCP connect, no TLS handshake.
  // An established socket is still serviced, so `stop` still lands promptly.
  //
  // The caller bounds the window. It has to: a looping animation never ends, and
  // an unbounded quiesce left a stick that lost its socket mid-playback unable
  // to rebuild it, playing on unreachable with nothing for an upload to arrive
  // over.
  if (quiesce && !linked_) return;
  if (!quiesce) ensureWifi(wifiWasUp_, playing);
  ws.loop();
}

void NetService::onConnected() {
  linked_ = true;
  backoffMs_ = LS_RECONNECT_MIN_MS;
  ws.setReconnectInterval(backoffMs_);
  Serial.printf("[net] relay connected, heap %u\n", (unsigned)ESP.getFreeHeap());
  // Re-applied rather than assumed: a reconnect rebuilds the library's client
  // state, and a socket that came back while the last transfer was still marked
  // RECEIVING would otherwise be left with no keep-alive at all.
  setHeartbeat(lastStatus.state != STATE_RECEIVING, true);
  sendHello();
  publishStatus(lastStatus);
  if (slotsJson[0]) ws.sendTXT(slotsJson);
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
    // Before the control frame, because handling that one is what consumes it.
    handler_->onName(doc["name"] | "");
    handler_->onControl(frame, sizeof(frame));
    return;
  }

  if (strcmp(t, "select") == 0 || strcmp(t, "deleteSlot") == 0) {
    const long slot = doc["slot"] | -1L;
    if (slot < 0 || slot >= LS_MAX_SLOTS) return;
    const uint8_t frame[2] = {(uint8_t)(strcmp(t, "select") == 0 ? OP_SELECT : OP_DELETE),
                              (uint8_t)slot};
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

void NetService::setHeartbeat(bool on, bool force) {
  if (on == heartbeat_ && !force) return;
  heartbeat_ = on;
  if (on) {
    ws.enableHeartbeat(LS_PING_INTERVAL_MS, LS_PONG_TIMEOUT_MS, LS_PONG_MISSES);
  } else {
    ws.disableHeartbeat();
  }
}

void NetService::publishStatus(const StatusSnapshot& s) {
  // Cached even when offline, so the next `hello` reports a real ceiling.
  lastStatus = s;
  // Every state change comes through here, so this is the one place that knows
  // when a transfer starts and ends without a second callback for it.
  setHeartbeat(s.state != STATE_RECEIVING);
  if (!linked_) return;

  char buf[224];
  snprintf(buf, sizeof(buf),
           "{\"t\":\"status\",\"state\":%u,\"error\":%u,\"bytesReceived\":%lu,"
           "\"bytesExpected\":%lu,\"maxAnimationBytes\":%lu}",
           (unsigned)s.state, (unsigned)s.error, (unsigned long)s.bytesReceived,
           (unsigned long)s.bytesExpected, (unsigned long)s.maxAnimationBytes);
  ws.sendTXT(buf);
}

void NetService::publishSlots(const Animation& store) {
  // Only the used slots. The index travels with each entry, so the browser can
  // still address a hole in the middle of the set.
  int n = snprintf(slotsJson, sizeof(slotsJson), "{\"t\":\"slots\",\"selected\":%d,\"slots\":[",
                   (int)store.selected());
  bool first = true;
  for (uint8_t i = 0; i < store.slotCount(); i++) {
    const Slot& s = store.slot(i);
    if (!s.used) continue;
    if (n < 0 || (size_t)n >= sizeof(slotsJson)) break;
    n += snprintf(slotsJson + n, sizeof(slotsJson) - n,
                  "%s{\"i\":%u,\"name\":\"%s\",\"frames\":%u,\"fps\":%u,\"bytes\":%lu,"
                  "\"colours\":[",
                  first ? "" : ",", (unsigned)i, s.name, (unsigned)s.frameCount,
                  (unsigned)s.fps, (unsigned long)s.bytes);
    for (uint8_t k = 0; k < LS_SLOT_COLOURS; k++) {
      if (n < 0 || (size_t)n >= sizeof(slotsJson)) break;
      n += snprintf(slotsJson + n, sizeof(slotsJson) - n, "%s[%u,%u,%u]", k ? "," : "",
                    (unsigned)s.colour[k][0], (unsigned)s.colour[k][1],
                    (unsigned)s.colour[k][2]);
    }
    if (n < 0 || (size_t)n >= sizeof(slotsJson)) break;
    n += snprintf(slotsJson + n, sizeof(slotsJson) - n, "]}");
    first = false;
  }
  if (n < 0 || (size_t)n + 3 > sizeof(slotsJson)) {
    // Truncated, so the JSON is not valid. Better to send nothing than a frame
    // the browser will drop anyway with no explanation.
    slotsJson[0] = 0;
    Serial.println("[net] slot list too long to serialise");
    return;
  }
  snprintf(slotsJson + n, sizeof(slotsJson) - n, "]}");
  if (linked_) ws.sendTXT(slotsJson);
}

LinkStage NetService::linkStage() const {
  if (linked_) return LS_LINK_UP;
  // Distinguishing these two is the whole point: no association means the SSID,
  // the band or the password; associated but not connected means the relay, the
  // hostname, TLS or the Basic auth credentials.
  return WiFi.status() == WL_CONNECTED ? LS_LINK_NETWORK : LS_LINK_DOWN;
}

const char* NetService::deviceId() const { return deviceIdBuf; }
