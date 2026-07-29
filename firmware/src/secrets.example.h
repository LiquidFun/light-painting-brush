// Copy to secrets.h and fill in. secrets.h is gitignored (REQUIREMENTS §4.2).
//
// Provisioning is compile-time for the alpha. A captive portal is the right answer
// once more than one person owns a stick, and is out of scope until then.

#pragma once

// Tried in order by WiFiMulti, so the same firmware joins the home network or a
// phone hotspot without reflashing. Add as many as you need.
#define LS_WIFI_NETWORKS                 \
  {"home-ssid", "home-password"},        \
  {"phone-hotspot", "hotspot-password"}

// The relay. Host only — no scheme, no path.
#define LS_RELAY_HOST "lightstick.example.com"
#define LS_RELAY_PORT 443
#define LS_RELAY_PATH "/ws/device"

// 1 for wss:// through Caddy, which is the deployment PROTOCOL.md describes. Set
// to 0 only to talk to a plain-HTTP relay on your own bench.
#define LS_RELAY_TLS 1

// HTTP Basic auth, enforced by Caddy on every route. One shared password for every
// stick, so rotating it means reflashing all of them.
#define LS_RELAY_USER "lightstick"
#define LS_RELAY_PASSWORD "the-shared-password"

// Shown in the browser's device list. Leave empty to fall back to the deviceId.
#define LS_DEVICE_LABEL "LightStick"
