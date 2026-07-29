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
| `HOST` | `127.0.0.1` | Bind to localhost in production; Caddy is the only thing that should reach it |
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

`Caddyfile` terminates TLS and enforces HTTP Basic auth on every route, both
WebSocket endpoints included. This process implements no auth of its own and must
never be exposed directly.

```sh
caddy hash-password              # paste the hash into the Caddyfile
sudo caddy run --config Caddyfile
```

Run the Node process under a supervisor (systemd unit, `Restart=always`) with
`HOST=127.0.0.1`. If you write your own unit, do **not** set
`MemoryDenyWriteExecute=` — V8 maps pages writable and executable for the JIT and
node will abort at startup.

### The deployment this repo actually uses

`light.brutenis.net`, managed by ansible in a separate private repo, which owns
the Caddy site, the `lightstick.service` unit on `127.0.0.1:8012`, the
`deploy-lightstick` CI user and `/var/lib/lightstick` as the library directory.
The `Caddyfile` here is the standalone equivalent, kept so this repo documents
its own deployment requirement.

`.github/workflows/` does the rest:

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | every push and PR | typechecks and builds `web/`, typechecks `server/`, runs `npm run smoke` |
| `deploy.yml` | CI succeeding on `main`, or `workflow_dispatch` | builds the SPA, rsyncs `server/` and `web/dist/`, `npm ci --omit=dev`, restarts the unit, checks it came up |

One repo secret is required: **`DEPLOY_SSH_KEY`**, the private half of the key
whose public half is in the ansible repo's
`files/deploy-lightstick.authorized_keys`.

```sh
ssh-keygen -t ed25519 -f deploy_key -N "" -C "lightstick-deploy"
```

The deploy never touches the project library: it lives in `/var/lib/lightstick`
under systemd's `StateDirectory=`, so `rsync --delete` on `/srv/lightstick` is
safe.

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
