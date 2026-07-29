// localStorage persistence and JSON import/export.
//
// The schema is versioned from day one: every file carries `schema` and every
// read goes through sanitiseProject(), so an older or hand-edited file loads with
// defaults filled in rather than crashing the editor.

import { clamp, isHex, normaliseHex } from './color'
import { clampKeyframe, createProject, MAX_DURATION_MS, MIN_DURATION_MS, uid } from './project'
import { EASING_NAMES, FPS_OPTIONS } from './types'
import type { EasingName, Keyframe, KeyframeKind, Project } from './types'

export const SCHEMA_VERSION = 1

const KEY_PROJECTS = 'lightstick.v1.projects'
const KEY_LAST_OPENED = 'lightstick.v1.lastOpened'
const KEY_PREFS = 'lightstick.v1.prefs'

export type Prefs = {
  night: boolean
  bluetoothNoticeDismissed: boolean
}

const DEFAULT_PREFS: Prefs = { night: false, bluetoothNoticeDismissed: false }

export type ExportFile = {
  schema: number
  kind: 'lightstick-project' | 'lightstick-library'
  exportedAt: string
  projects: Project[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && isHex(v) ? normaliseHex(v) : fallback
}

function sanitiseKeyframe(raw: unknown, project: Project): Keyframe | null {
  if (!isObject(raw)) return null
  const kind = raw.kind
  if (kind !== 'point' && kind !== 'row' && kind !== 'column') return null
  const easing = EASING_NAMES.includes(raw.easing as EasingName)
    ? (raw.easing as EasingName)
    : 'smoothstep'
  return clampKeyframe(
    {
      id: str(raw.id, uid()),
      kind: kind as KeyframeKind,
      led: num(raw.led, 0),
      timeMs: num(raw.timeMs, 0),
      color: color(raw.color, '#ffffff'),
      brightness: num(raw.brightness, 1),
      radius: num(raw.radius, 0.35),
      easing,
      hard: bool(raw.hard, false),
    },
    project,
  )
}

export function sanitiseProject(raw: unknown): Project {
  const base = createProject()
  if (!isObject(raw)) return base

  const fps = FPS_OPTIONS.includes(num(raw.fps, 25) as (typeof FPS_OPTIONS)[number])
    ? num(raw.fps, 25)
    : 25
  const playback = isObject(raw.playback) ? raw.playback : {}

  const project: Project = {
    id: str(raw.id, base.id),
    name: str(raw.name, 'Untitled'),
    ledCount: Math.round(clamp(num(raw.ledCount, base.ledCount), 1, 2048)),
    durationMs: Math.round(
      clamp(num(raw.durationMs, base.durationMs), MIN_DURATION_MS, MAX_DURATION_MS),
    ),
    fps,
    background: color(raw.background, '#000000'),
    colorSpace:
      raw.colorSpace === 'srgb' ||
      raw.colorSpace === 'hsv-short' ||
      raw.colorSpace === 'hsv-long'
        ? raw.colorSpace
        : 'oklab',
    falloffPower: clamp(num(raw.falloffPower, 2), 0.5, 6),
    keyframes: [],
    playback: {
      loop: bool(playback.loop, false),
      pingPong: bool(playback.pingPong, false),
      startDelayMs: Math.round(clamp(num(playback.startDelayMs, 0), 0, 65535)),
    },
    updatedAt: num(raw.updatedAt, Date.now()),
  }

  const list = Array.isArray(raw.keyframes) ? raw.keyframes : []
  project.keyframes = list
    .map((k) => sanitiseKeyframe(k, project))
    .filter((k): k is Keyframe => k !== null)

  return project
}

// --- library ---------------------------------------------------------------

export function loadLibrary(): Project[] {
  try {
    const raw = localStorage.getItem(KEY_PROJECTS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitiseProject)
  } catch {
    return []
  }
}

export function saveLibrary(projects: Project[]): void {
  try {
    localStorage.setItem(KEY_PROJECTS, JSON.stringify(projects))
  } catch {
    // Quota exceeded or storage disabled: the editor keeps working in memory.
  }
}

export function loadLastOpenedId(): string | null {
  try {
    return localStorage.getItem(KEY_LAST_OPENED)
  } catch {
    return null
  }
}

export function saveLastOpenedId(id: string): void {
  try {
    localStorage.setItem(KEY_LAST_OPENED, id)
  } catch {
    /* ignore */
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY_PREFS)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw)
    if (!isObject(parsed)) return DEFAULT_PREFS
    return {
      night: bool(parsed.night, false),
      bluetoothNoticeDismissed: bool(parsed.bluetoothNoticeDismissed, false),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY_PREFS, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

// --- import / export -------------------------------------------------------

export function toExportFile(projects: Project[], single: boolean): ExportFile {
  return {
    schema: SCHEMA_VERSION,
    kind: single ? 'lightstick-project' : 'lightstick-library',
    exportedAt: new Date().toISOString(),
    projects,
  }
}

/** Accepts a single project, a library file, or a bare array of projects. */
export function parseImport(text: string): { projects: Project[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { projects: [], error: 'That file is not valid JSON.' }
  }

  if (Array.isArray(parsed)) {
    return { projects: parsed.map(sanitiseProject) }
  }
  if (!isObject(parsed)) {
    return { projects: [], error: 'That file does not contain a project.' }
  }
  if (Array.isArray(parsed.projects)) {
    if (num(parsed.schema, 1) > SCHEMA_VERSION) {
      return {
        projects: [],
        error: `That file was written by a newer version (schema ${parsed.schema}). Update the app first.`,
      }
    }
    return { projects: parsed.projects.map(sanitiseProject) }
  }
  if (isObject(parsed.project)) {
    return { projects: [sanitiseProject(parsed.project)] }
  }
  if (Array.isArray(parsed.keyframes)) {
    return { projects: [sanitiseProject(parsed)] }
  }
  return { projects: [], error: 'That file does not contain a project.' }
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'project'
  )
}
