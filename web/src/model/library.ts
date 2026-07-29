// The server-side project library (REQUIREMENTS §5.1, §6.11).
//
// localStorage stays the offline cache and the source of last-opened state; this
// is the shared copy. One shared password means one shared library, so there is no
// per-user namespace and last write wins.
//
// Auth is the browser's own Basic auth session, so `credentials: 'same-origin'` is
// all that is needed — never a token in the app.

import { sanitiseProject } from './storage'
import type { Project } from './types'

export type LibrarySync = 'idle' | 'loading' | 'saving' | 'synced' | 'offline'

const BASE = '/api/projects'

/** Requests fail fast: the editor must never be gated behind the network (§6.1). */
const TIMEOUT_MS = 8000

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

/** Every project on the server, or null if it could not be reached. */
export async function fetchLibrary(): Promise<Project[] | null> {
  try {
    const res = await request(BASE)
    if (!res.ok) return null
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return null
    const projects = (body as { projects?: unknown }).projects
    if (!Array.isArray(projects)) return null
    return projects.map(sanitiseProject)
  } catch {
    return null
  }
}

/** True if the server took it. */
export async function putProject(project: Project): Promise<boolean> {
  try {
    const res = await request(`${BASE}/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(project),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteProjectOnServer(id: string): Promise<boolean> {
  try {
    const res = await request(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    // A project that was never pushed is already absent, which is the wanted state.
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

/**
 * Union by id, newer `updatedAt` wins. Crude but right for this app: there are no
 * accounts, edits are whole-project, and the alternative is a merge UI nobody
 * wants to use in the dark with one hand.
 */
export function mergeLibraries(local: Project[], remote: Project[]): Project[] {
  const byId = new Map<string, Project>()
  for (const p of local) byId.set(p.id, p)
  for (const p of remote) {
    const existing = byId.get(p.id)
    if (!existing || p.updatedAt > existing.updatedAt) byId.set(p.id, p)
  }
  return [...byId.values()]
}
