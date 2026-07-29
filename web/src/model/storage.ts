// localStorage persistence and JSON import/export.
//
// The schema is versioned from day one: every file carries `schema` and every
// read goes through sanitiseProject(), so an older or hand-edited file loads with
// defaults filled in rather than crashing the editor.

import { clamp, isHex, normaliseHex } from './color'
import {
  clampKeyframe,
  createLayer,
  createProject,
  defaultPattern,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  uid,
} from './project'
import { BLEND_MODES, EASING_NAMES, FPS_OPTIONS, PATTERN_KINDS } from './types'
import type {
  BlendMode,
  ColorRamp,
  EasingName,
  ImageFit,
  Keyframe,
  KeyframeKind,
  Layer,
  Pattern,
  PatternAxis,
  PatternKind,
  Project,
} from './types'

/**
 * 2 introduced layers. A schema 1 file has a flat `keyframes` array, which
 * upgrades to a single keyframe layer — see `sanitiseLayers`.
 */
export const SCHEMA_VERSION = 2

const KEY_PROJECTS = 'lightstick.v1.projects'
const KEY_LAST_OPENED = 'lightstick.v1.lastOpened'
const KEY_PREFS = 'lightstick.v1.prefs'

export type Prefs = {
  night: boolean
  /**
   * Which transport drives the device panel. The relay works everywhere; BLE is
   * the v1 path, kept until the WiFi firmware is proven on hardware (§7, M4).
   */
  transport: 'relay' | 'ble'
}

const DEFAULT_PREFS: Prefs = { night: false, transport: 'relay' }

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

function ramp(raw: unknown, fallback: ColorRamp): ColorRamp {
  if (!isObject(raw)) return fallback
  return { from: color(raw.from, fallback.from), to: color(raw.to, fallback.to) }
}

function axis(raw: unknown): PatternAxis {
  return raw === 'time' ? 'time' : 'led'
}

function sanitisePattern(raw: unknown): Pattern {
  const fallbackKind: PatternKind = 'stripes'
  if (!isObject(raw)) return defaultPattern(fallbackKind)
  const kind = PATTERN_KINDS.some((k) => k.id === raw.kind)
    ? (raw.kind as PatternKind)
    : fallbackKind
  const base = defaultPattern(kind)

  switch (base.kind) {
    case 'solid':
      return { kind: 'solid', color: color(raw.color, base.color) }
    case 'stripes':
      return {
        kind: 'stripes',
        axis: axis(raw.axis),
        period: clamp(num(raw.period, base.period), 0.01, 2),
        duty: clamp(num(raw.duty, base.duty), 0, 1),
        softness: clamp(num(raw.softness, base.softness), 0, 1),
        phase: clamp(num(raw.phase, base.phase), -1, 1),
        ramp: ramp(raw.ramp, base.ramp),
      }
    case 'wave':
      return {
        kind: 'wave',
        axis: axis(raw.axis),
        wavelength: clamp(num(raw.wavelength, base.wavelength), 0.01, 2),
        amplitude: clamp(num(raw.amplitude, base.amplitude), 0, 1),
        phase: clamp(num(raw.phase, base.phase), -1, 1),
        speed: clamp(num(raw.speed, base.speed), -10, 10),
        ramp: ramp(raw.ramp, base.ramp),
      }
    case 'gradient':
      return {
        kind: 'gradient',
        angle: clamp(num(raw.angle, base.angle), 0, 360),
        ramp: ramp(raw.ramp, base.ramp),
      }
    case 'noise':
      return {
        kind: 'noise',
        scale: clamp(num(raw.scale, base.scale), 0.5, 40),
        speed: clamp(num(raw.speed, base.speed), -10, 10),
        seed: Math.round(clamp(num(raw.seed, base.seed), 0, 65535)),
        ramp: ramp(raw.ramp, base.ramp),
      }
  }
}

function sanitiseLayer(raw: unknown, project: Project): Layer | null {
  if (!isObject(raw)) return null
  const kind = raw.kind
  if (kind !== 'keyframes' && kind !== 'pattern' && kind !== 'image') return null

  const base = {
    id: str(raw.id, uid()),
    name: str(raw.name, 'Layer'),
    opacity: clamp(num(raw.opacity, 1), 0, 1),
    blend: BLEND_MODES.some((b) => b.id === raw.blend)
      ? (raw.blend as BlendMode)
      : ('normal' as BlendMode),
    hidden: bool(raw.hidden, false),
  }

  if (kind === 'pattern') return { ...base, kind, pattern: sanitisePattern(raw.pattern) }

  if (kind === 'image') {
    // Only data URLs: a project must stay one self-contained file, and a remote
    // src would taint the canvas we read pixels back from.
    const src = typeof raw.src === 'string' && raw.src.startsWith('data:image/') ? raw.src : ''
    const fit: ImageFit =
      raw.fit === 'contain' || raw.fit === 'cover' ? raw.fit : 'stretch'
    return { ...base, kind, src, fit }
  }

  const list = Array.isArray(raw.keyframes) ? raw.keyframes : []
  return {
    ...base,
    kind,
    keyframes: list
      .map((k) => sanitiseKeyframe(k, project))
      .filter((k): k is Keyframe => k !== null),
  }
}

/** Reads schema 2 layers, or upgrades a schema 1 flat keyframe array. */
function sanitiseLayers(raw: Record<string, unknown>, project: Project): Layer[] {
  if (Array.isArray(raw.layers)) {
    return raw.layers
      .map((l) => sanitiseLayer(l, project))
      .filter((l): l is Layer => l !== null)
  }
  if (!Array.isArray(raw.keyframes)) return []
  const keyframes = raw.keyframes
    .map((k) => sanitiseKeyframe(k, project))
    .filter((k): k is Keyframe => k !== null)
  const layer = createLayer('keyframes')
  return [{ ...layer, kind: 'keyframes', keyframes }]
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
    layers: [],
    playback: {
      loop: bool(playback.loop, false),
      pingPong: bool(playback.pingPong, false),
      startDelayMs: Math.round(clamp(num(playback.startDelayMs, 0), 0, 65535)),
    },
    updatedAt: num(raw.updatedAt, Date.now()),
  }

  project.layers = sanitiseLayers(raw, project)

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
      transport: parsed.transport === 'ble' ? 'ble' : 'relay',
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
  // A bare project: schema 2 has `layers`, schema 1 had `keyframes`.
  if (Array.isArray(parsed.layers) || Array.isArray(parsed.keyframes)) {
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
