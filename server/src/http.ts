// Static hosting for the SPA plus the library API (REQUIREMENTS §5.1).
//
// No auth here by design: Caddy enforces Basic auth on every route in front of
// this process (§5.2), so the application never sees an unauthenticated request.
// Do not add a second, weaker check that could disagree with the first.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { MAX_PROJECT_BYTES, isValidId } from './library.ts'
import type { Library } from './library.ts'

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Rejects a body over the cap without buffering it, so a bad client cannot OOM us. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleProjects(
  req: IncomingMessage,
  res: ServerResponse,
  library: Library,
  rest: string,
): Promise<void> {
  if (rest === '' && req.method === 'GET') {
    json(res, 200, { projects: await library.list() })
    return
  }

  const id = decodeURIComponent(rest.replace(/^\//, ''))
  if (!isValidId(id)) {
    json(res, 400, { error: 'That project id is not usable as a filename.' })
    return
  }

  if (req.method === 'PUT') {
    let body: string
    try {
      body = await readBody(req, MAX_PROJECT_BYTES)
    } catch {
      json(res, 413, {
        error: `That project is over ${Math.round(MAX_PROJECT_BYTES / 1024 / 1024)} MB. Remove or shrink an image layer.`,
      })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      json(res, 400, { error: 'That project is not valid JSON.' })
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { id?: unknown }).id !== id) {
      json(res, 400, { error: 'The project id in the body does not match the URL.' })
      return
    }
    await library.put(id, body)
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'DELETE') {
    const removed = await library.remove(id)
    json(res, removed ? 200 : 404, { ok: removed })
    return
  }

  json(res, 405, { error: 'Method not allowed.' })
}

/**
 * Serves a built SPA. Anything that is not a file and has no extension falls back
 * to index.html so client-side routes survive a reload.
 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed.' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const requested = decodeURIComponent(url.pathname)
  // Resolving and then checking containment is what stops `../` traversal; do not
  // replace this with a string test on the raw path.
  let file = path.resolve(root, `.${path.posix.normalize(requested)}`)
  if (file !== root && !file.startsWith(root + path.sep)) {
    json(res, 403, { error: 'Forbidden.' })
    return
  }

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = path.join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) {
    if (path.extname(requested) !== '') {
      json(res, 404, { error: 'Not found.' })
      return
    }
    file = path.join(root, 'index.html')
    info = await stat(file).catch(() => null)
    if (!info?.isFile()) {
      json(res, 404, {
        error: 'The SPA is not built. Run `npm run build` in web/ or set STATIC_DIR.',
      })
      return
    }
  }

  // Vite fingerprints everything under /assets/, so those are immutable. The
  // entry document must not be, or a deploy never reaches an open tab.
  const immutable = file.startsWith(path.join(root, 'assets') + path.sep)
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  // `pipeline`, never `.pipe()`. Two reasons, both of which have taken the whole
  // relay down or leaked it away:
  //
  // A read stream that fails *after* the headers are out — a file removed or
  // chmodded between the stat above and the open here, which `rsync --delete`
  // during a deploy does routinely — emits 'error' with no listener attached.
  // That is an uncaught exception, so the process dies and every device and
  // browser socket dies with it. A stick then sees the relay refuse connections
  // and, if the crash repeats, systemd's start limit stops the unit for good.
  //
  // And `.pipe()` unpipes when the destination closes but never destroys the
  // source, so every aborted download leaked an fd and its read-ahead buffer.
  try {
    await pipeline(createReadStream(file), res)
  } catch (err) {
    // Navigating away mid-download is not a fault and must not be logged as one.
    if (!isClientAbort(err)) console.error('[http] while sending', file, err)
    res.destroy()
  }
}

/** The response went away under us, rather than the file failing to be read. */
function isClientAbort(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'EPIPE' || code === 'ECONNRESET'
}

export function createRequestHandler(library: Library, staticDir: string) {
  const root = path.resolve(staticDir)

  return (req: IncomingMessage, res: ServerResponse): void => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const work =
      pathname === '/api/projects' || pathname.startsWith('/api/projects/')
        ? handleProjects(req, res, library, pathname.slice('/api/projects'.length))
        : serveStatic(req, res, root)

    work.catch((err: unknown) => {
      console.error('[http]', err)
      if (!res.headersSent) json(res, 500, { error: 'The server failed to handle that.' })
      else res.end()
    })
  }
}
