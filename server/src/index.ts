// Entry point. Three jobs and nothing else (REQUIREMENTS §5): serve the SPA,
// relay between browsers and devices, store the shared project library.
//
// TLS and Basic auth belong to Caddy in front of this process, so this listens on
// plain HTTP — bind it to localhost in production.

import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { WebSocketServer } from 'ws'

import { createRequestHandler } from './http.ts'
import { Library } from './library.ts'
import { Relay } from './relay.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? '127.0.0.1'
const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data')
const staticDir = process.env.STATIC_DIR ?? path.join(here, '..', '..', 'web', 'dist')

const library = new Library(dataDir)
await library.init()

const relay = new Relay()
const server = createServer(createRequestHandler(library, staticDir))

// `noServer` rather than two listening servers: the upgrade path decides which
// registry a socket joins, and anything else gets refused rather than upgraded.
const devices = new WebSocketServer({ noServer: true })
const clients = new WebSocketServer({ noServer: true })

devices.on('connection', (socket) => relay.addDevice(socket))
clients.on('connection', (socket) => relay.addClient(socket))

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (pathname === '/ws/device') {
    devices.handleUpgrade(req, socket, head, (ws) => devices.emit('connection', ws, req))
  } else if (pathname === '/ws/client') {
    clients.handleUpgrade(req, socket, head, (ws) => clients.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

server.listen(port, host, () => {
  console.log(`[server] http://${host}:${port}`)
  console.log(`[server] static ${staticDir}`)
  console.log(`[server] library ${dataDir}`)
})
