# server/

Static hosting, WebSocket relay and the shared project library. Small and boring
on purpose — see `REQUIREMENTS.md` §5 and `PROTOCOL.md`.

## Why a relay exists at all

A page served over HTTPS cannot open a socket to an ESP32 on the local network:
`ws://` from an HTTPS origin is mixed content, `wss://` needs a certificate the
device cannot have, and Chrome's Private Network Access rules block HTTPS →
private IP regardless. So the device dials *out* to this server and the browser
meets it here. This is forced, not chosen.

## Running it

Requires Node 22.18 or newer — the server is TypeScript that Node runs directly
by stripping types, so there is no build step.

```sh
npm install
cd ../web && npm install --include=dev && npm run build && cd ../server
npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Bind to localhost in production; the proxy is the only thing that should reach it |
| `DATA_DIR` | `server/data` | Library storage — one JSON file per project under `projects/` |
| `STATIC_DIR` | `web/dist` | The built SPA |

For editor development, run Vite instead and let it proxy `/api` and `/ws` here:

```sh
npm start              # this server, in one terminal
cd ../web && npm run dev
```

## Endpoints

| Route | Who |
|---|---|
| `GET /api/projects` | browser — the whole library |
| `PUT /api/projects/:id` | browser — one project, id must match the body |
| `DELETE /api/projects/:id` | browser |
| `ws /ws/client` | browser |
| `ws /ws/device` | ESP32 |
| everything else | static files, with an `index.html` fallback |

## Deployment

**This process must not be exposed directly.** It implements no authentication of
its own, by design (§5.2), and `PUT /api/projects/:id` will accept anything that
reaches it. It has to sit behind a reverse proxy that terminates TLS and enforces
auth on *every* route, both WebSocket endpoints included — the firmware expects
HTTP Basic and sends credentials from its `secrets.h`. Bind it to
`HOST=127.0.0.1` so the proxy is the only thing that can reach it.

No proxy or host config lives in this repo; it belongs to whatever manages the
machine.

Run the Node process under a supervisor (systemd unit, `Restart=always`). Two
things to get right in a unit file:

- Do **not** set `MemoryDenyWriteExecute=` — V8 maps pages writable and executable
  for the JIT, and node aborts at startup.
- Point `DATA_DIR` at a directory outside the deploy tree (systemd's
  `StateDirectory=` is the easy answer), so redeploying with `rsync --delete`
  cannot take the project library with it.

## CI

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | every push and PR | typechecks and builds `web/`, typechecks `server/`, runs `npm run smoke` |
| `deploy.yml` | CI succeeding on `main`, or `workflow_dispatch` | builds the SPA, rsyncs `server/` and `web/dist/`, `npm ci --omit=dev`, restarts the unit, checks it came up |

The deploy names no infrastructure. It reads three repo variables and one secret,
and skips itself entirely when `DEPLOY_HOST` is unset, so a fork neither deploys
nor reports a failure:

| Setting | Kind | Meaning |
|---|---|---|
| `DEPLOY_HOST` | variable | ssh target; unset disables the deploy |
| `DEPLOY_USER` | variable | ssh account, may `sudo systemctl restart lightstick` |
| `DEPLOY_ROOT` | variable | rsync destination, defaults to `/srv/lightstick` |
| `DEPLOY_SSH_KEY` | secret | private half of the key authorised for `DEPLOY_USER` |

```sh
ssh-keygen -t ed25519 -f deploy_key -N "" -C "lightstick-deploy"
```

## Things worth knowing

- **No accounts.** One shared Basic auth password means one shared library:
  everyone who can log in can edit everyone's projects. Acceptable among friends,
  and the first thing to revisit if the audience widens.
- **No locks.** Any client may upload to or play any online device at any time
  (§3.7). The relay broadcasts every device status to every client so that a
  second person's upload is visible rather than silent.
- **The relay streams.** It never buffers a whole payload; exactly one 4 KB chunk
  is in flight per client, and the client socket is paused until the device socket
  has taken it. That turns the stick's link speed into back-pressure on the
  browser with no protocol-level acknowledgement.
- **Offline devices stay in the list** with `online: false`, so the UI can show a
  stick that has gone away rather than silently forgetting it.
- **This is a single point of failure.** If it is down, nothing works. Accepted
  for the alpha.
