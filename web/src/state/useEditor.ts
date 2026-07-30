// Editor state: the current project, the library, selection, and a bounded
// undo/redo stack. Everything the UI mutates goes through here.
//
// All state transitions read the previous value from a ref and write with a
// plain setState, never from inside an updater function: updaters run twice
// under StrictMode and a side effect in one would corrupt the history stack.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { clamp } from '../model/color'
import {
  deleteProjectOnServer,
  fetchLibrary,
  mergeLibraries,
  putProject,
} from '../model/library'
import type { LibrarySync } from '../model/library'
import {
  activeKeyframeLayer,
  activePaintLayer,
  clampKeyframe,
  createLayer,
  createProject,
  isKeyframeLayer,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  seedProject,
  uid,
} from '../model/project'
import {
  loadLastOpenedId,
  loadLibrary,
  saveLastOpenedId,
  saveLibrary,
} from '../model/storage'
import { forgetPaint } from '../render/paintCache'
import type { Keyframe, Layer, LayerKind, Project, Tool } from '../model/types'

const HISTORY_LIMIT = 80
const AUTOSAVE_DEBOUNCE_MS = 400
/**
 * Longer than the local autosave: a project with an image layer is megabytes, and
 * pushing one on every 400 ms of typing would saturate a phone's uplink.
 */
const SERVER_PUSH_DEBOUNCE_MS = 2000

type History = { past: Project[]; future: Project[] }

function initialProjects(): { library: Project[]; current: Project } {
  const library = loadLibrary()
  if (library.length === 0) {
    const first = seedProject(createProject('First light'))
    return { library: [first], current: first }
  }
  const lastId = loadLastOpenedId()
  const current = library.find((p) => p.id === lastId) ?? library[0]
  return { library, current }
}

export type Editor = ReturnType<typeof useEditor>

export function useEditor() {
  const initial = useMemo(initialProjects, [])
  const [library, setLibraryState] = useState<Project[]>(initial.library)
  const [project, setProjectState] = useState<Project>(initial.current)
  const [history, setHistory] = useState<History>({ past: [], future: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeLayerId, setActiveLayerId] = useState<string | null>(
    initial.current.layers[initial.current.layers.length - 1]?.id ?? null,
  )
  const [tool, setToolState] = useState<Tool>('select')
  const [librarySync, setLibrarySync] = useState<LibrarySync>('loading')

  const projectRef = useRef(project)
  const libraryRef = useRef(library)
  const activeLayerRef = useRef(activeLayerId)
  /** True once the user has changed anything, so the initial pull cannot clobber it. */
  const dirtyRef = useRef(false)

  const setProject = useCallback((next: Project) => {
    projectRef.current = next
    setProjectState(next)
  }, [])

  const setActiveLayer = useCallback((id: string | null) => {
    activeLayerRef.current = id
    setActiveLayerId(id)
  }, [])

  const setLibrary = useCallback((next: Project[]) => {
    libraryRef.current = next
    setLibraryState(next)
    saveLibrary(next)
  }, [])

  /**
   * `push` is what makes an edit undoable. Continuous gestures (dragging a
   * handle, sliding a slider) push once on the first change and then replace, so
   * one drag is one undo step.
   */
  const mutate = useCallback(
    (fn: (p: Project) => Project, push = true) => {
      const prev = projectRef.current
      const next = fn(prev)
      if (next === prev) return
      dirtyRef.current = true
      setProject({ ...next, updatedAt: Date.now() })
      if (push) {
        setHistory((h) => ({ past: [...h.past, prev].slice(-HISTORY_LIMIT), future: [] }))
      }
    },
    [setProject],
  )

  const undo = useCallback(() => {
    if (history.past.length === 0) return
    const target = history.past[history.past.length - 1]
    const current = projectRef.current
    setProject(target)
    setHistory({
      past: history.past.slice(0, -1),
      future: [...history.future, current].slice(-HISTORY_LIMIT),
    })
  }, [history, setProject])

  const redo = useCallback(() => {
    if (history.future.length === 0) return
    const target = history.future[history.future.length - 1]
    const current = projectRef.current
    setProject(target)
    setHistory({
      past: [...history.past, current].slice(-HISTORY_LIMIT),
      future: history.future.slice(0, -1),
    })
  }, [history, setProject])

  // Autosave to the localStorage cache on change, debounced.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const list = libraryRef.current
      const next = list.some((p) => p.id === project.id)
        ? list.map((p) => (p.id === project.id ? project : p))
        : [...list, project]
      setLibrary(next)
      saveLastOpenedId(project.id)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [project, setLibrary])

  // Pull the shared library once (§6.11: "save on desktop, open on phone"), then
  // push anything the server has an older copy of. Failure is not an error state:
  // the editor is fully usable with no server and no device.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const remote = await fetchLibrary()
      if (cancelled) return
      if (!remote) {
        setLibrarySync('offline')
        return
      }
      const merged = mergeLibraries(libraryRef.current, remote)
      setLibrary(merged)

      // The open project is whatever localStorage had. If the server has a newer
      // copy and the user has not touched anything yet, that copy is what they
      // came here for. Once they have edited, theirs wins and gets pushed.
      const server = remote.find((p) => p.id === projectRef.current.id)
      if (server && !dirtyRef.current && server.updatedAt > projectRef.current.updatedAt) {
        setProject(server)
        setHistory({ past: [], future: [] })
        setSelectedId(null)
        setActiveLayer(server.layers[server.layers.length - 1]?.id ?? null)
      }

      const onServer = new Map(remote.map((p) => [p.id, p.updatedAt]))
      for (const p of merged) {
        const there = onServer.get(p.id)
        if (there === undefined || there < p.updatedAt) await putProject(p)
      }
      if (!cancelled) setLibrarySync('synced')
    })()
    return () => {
      cancelled = true
    }
  }, [setLibrary, setProject, setActiveLayer])

  // Push the open project to the shared library, debounced well behind autosave.
  useEffect(() => {
    if (!dirtyRef.current) return
    const timer = window.setTimeout(() => {
      setLibrarySync('saving')
      void putProject(project).then((ok) => setLibrarySync(ok ? 'synced' : 'offline'))
    }, SERVER_PUSH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [project])

  // There is no keyboard on a phone, so this is a convenience on top of the
  // visible undo/redo buttons, not the only way in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // --- project-level edits --------------------------------------------------

  const patchProject = useCallback(
    (patch: Partial<Project>, push = true) => {
      mutate((p) => {
        const next = { ...p, ...patch }
        if (patch.durationMs !== undefined) {
          next.durationMs = Math.round(
            clamp(patch.durationMs, MIN_DURATION_MS, MAX_DURATION_MS),
          )
        }
        // A shorter project must not leave keyframes stranded past the end.
        next.layers = next.layers.map((l) =>
          isKeyframeLayer(l)
            ? { ...l, keyframes: l.keyframes.map((k) => clampKeyframe(k, next)) }
            : l,
        )
        return next
      }, push)
    },
    [mutate],
  )

  // --- layers ---------------------------------------------------------------

  /**
   * The layer keyframe tools draw into. Falls back to the topmost keyframe layer
   * when the selected layer is a pattern or an image, so the canvas is never
   * inert just because the panel selection moved.
   */
  const drawLayer = useMemo(
    () => activeKeyframeLayer(project, activeLayerId),
    [project, activeLayerId],
  )

  const addLayer = useCallback(
    (kind: LayerKind) => {
      const layer = createLayer(kind)
      mutate((p) => ({ ...p, layers: [...p.layers, layer] }))
      setActiveLayer(layer.id)
      return layer
    },
    [mutate, setActiveLayer],
  )

  /**
   * The patch has to be a partial of one arm of the Layer union, so the spread
   * needs a cast; callers pass properties that exist on the layer they name.
   */
  const updateLayer = useCallback(
    (id: string, patch: Partial<Layer>, push = true) => {
      mutate(
        (p) => ({
          ...p,
          layers: p.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)),
        }),
        push,
      )
    },
    [mutate],
  )

  const removeLayer = useCallback(
    (id: string) => {
      mutate((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== id) }))
      // Otherwise a new layer that happened to reuse the id would inherit the
      // old pixels, and the surface would leak for the rest of the session.
      forgetPaint(id)
      if (activeLayerRef.current === id) setActiveLayer(null)
    },
    [mutate, setActiveLayer],
  )

  /** The layer the brush writes into. Null until one exists. */
  const paintLayer = useMemo(
    () => activePaintLayer(project, activeLayerId),
    [project, activeLayerId],
  )

  /**
   * Picking up the brush creates a layer to paint on if there is not one yet,
   * because the alternative is a tool that silently does nothing.
   */
  const setTool = useCallback(
    (next: Tool) => {
      setToolState(next)
      if (next !== 'brush' && next !== 'eraser') return
      if (!activePaintLayer(projectRef.current, activeLayerRef.current)) addLayer('paint')
    },
    [addLayer],
  )

  /** Stores a finished stroke. One call per stroke, so one stroke is one undo step. */
  const commitPaint = useCallback(
    (id: string, src: string) => {
      mutate(
        (p) => ({
          ...p,
          layers: p.layers.map((l) => (l.id === id && l.kind === 'paint' ? { ...l, src } : l)),
        }),
        true,
      )
    },
    [mutate],
  )

  /** `delta` is in stacking order: +1 moves the layer up, toward the viewer. */
  const moveLayer = useCallback(
    (id: string, delta: number) => {
      mutate((p) => {
        const from = p.layers.findIndex((l) => l.id === id)
        const to = from + delta
        if (from < 0 || to < 0 || to >= p.layers.length) return p
        const layers = [...p.layers]
        const [moved] = layers.splice(from, 1)
        layers.splice(to, 0, moved)
        return { ...p, layers }
      })
    },
    [mutate],
  )

  // --- keyframe edits -------------------------------------------------------

  /** Applies `fn` to the keyframes of the draw layer, creating one if needed. */
  const mutateKeyframes = useCallback(
    (fn: (keyframes: Keyframe[], project: Project) => Keyframe[], push = true) => {
      let createdId: string | null = null
      mutate((p) => {
        const existing = activeKeyframeLayer(p, activeLayerRef.current)
        if (!existing) {
          const fresh = createLayer('keyframes')
          createdId = fresh.id
          if (!isKeyframeLayer(fresh)) return p
          return { ...p, layers: [...p.layers, { ...fresh, keyframes: fn([], p) }] }
        }
        return {
          ...p,
          layers: p.layers.map((l) =>
            l.id === existing.id && isKeyframeLayer(l)
              ? { ...l, keyframes: fn(l.keyframes, p) }
              : l,
          ),
        }
      }, push)
      if (createdId) setActiveLayer(createdId)
    },
    [mutate, setActiveLayer],
  )

  const addKeyframe = useCallback(
    (keyframe: Keyframe) => {
      mutateKeyframes((ks, p) => [...ks, clampKeyframe(keyframe, p)])
      setSelectedId(keyframe.id)
    },
    [mutateKeyframes],
  )

  const updateKeyframe = useCallback(
    (id: string, patch: Partial<Keyframe>, push = true) => {
      mutateKeyframes(
        (ks, p) => ks.map((k) => (k.id === id ? clampKeyframe({ ...k, ...patch }, p) : k)),
        push,
      )
    },
    [mutateKeyframes],
  )

  const removeKeyframe = useCallback(
    (id: string) => {
      mutateKeyframes((ks) => ks.filter((k) => k.id !== id))
      setSelectedId((current) => (current === id ? null : current))
    },
    [mutateKeyframes],
  )

  const duplicateKeyframe = useCallback(
    (id: string) => {
      const layer = activeKeyframeLayer(projectRef.current, activeLayerRef.current)
      const source = layer?.keyframes.find((k) => k.id === id)
      if (!source) return
      // Offset a little so the copy is grabbable rather than hidden underneath.
      const copy: Keyframe = {
        ...source,
        id: uid(),
        timeMs: source.timeMs + projectRef.current.durationMs * 0.05,
        led: source.led + 4,
      }
      mutateKeyframes((ks, p) => [...ks, clampKeyframe(copy, p)])
      setSelectedId(copy.id)
    },
    [mutateKeyframes],
  )

  // --- library --------------------------------------------------------------

  const openProject = useCallback(
    (id: string) => {
      const target = libraryRef.current.find((p) => p.id === id)
      if (!target) return
      setProject(target)
      setHistory({ past: [], future: [] })
      setSelectedId(null)
      setActiveLayer(target.layers[target.layers.length - 1]?.id ?? null)
      saveLastOpenedId(id)
    },
    [setProject, setActiveLayer],
  )

  const newProject = useCallback(() => {
    const created = seedProject(createProject(`Untitled ${libraryRef.current.length + 1}`))
    setLibrary([...libraryRef.current, created])
    void putProject(created)
    setProject(created)
    setHistory({ past: [], future: [] })
    setSelectedId(null)
    setActiveLayer(created.layers[created.layers.length - 1]?.id ?? null)
  }, [setLibrary, setProject, setActiveLayer])

  const deleteProject = useCallback(
    (id: string) => {
      const remaining = libraryRef.current.filter((p) => p.id !== id)
      const list =
        remaining.length > 0 ? remaining : [seedProject(createProject('First light'))]
      setLibrary(list)
      // The library is shared, so a delete has to reach the server or it comes back.
      void deleteProjectOnServer(id).then((ok) => {
        if (!ok) setLibrarySync('offline')
      })
      if (projectRef.current.id === id) {
        setProject(list[0])
        setHistory({ past: [], future: [] })
        setSelectedId(null)
        setActiveLayer(list[0].layers[list[0].layers.length - 1]?.id ?? null)
      }
    },
    [setLibrary, setProject, setActiveLayer],
  )

  const importProjects = useCallback(
    (imported: Project[]) => {
      if (imported.length === 0) return
      const taken = new Set(libraryRef.current.map((p) => p.id))
      const fresh = imported.map((p) => (taken.has(p.id) ? { ...p, id: uid() } : p))
      setLibrary([...libraryRef.current, ...fresh])
      for (const p of fresh) void putProject(p)
      setProject(fresh[0])
      setHistory({ past: [], future: [] })
      setSelectedId(null)
      setActiveLayer(fresh[0].layers[fresh[0].layers.length - 1]?.id ?? null)
    },
    [setLibrary, setProject, setActiveLayer],
  )

  const selected = useMemo(
    () => drawLayer?.keyframes.find((k) => k.id === selectedId) ?? null,
    [drawLayer, selectedId],
  )

  return {
    library,
    /** Where the shared library stands. `offline` means localStorage only. */
    librarySync,
    project,
    selected,
    selectedId,
    /** The layer selected in the layer list, which may be of any kind. */
    activeLayerId,
    /** The keyframe layer the canvas tools act on. Null only if none exists yet. */
    drawLayer,
    /** The raster the brush writes into. Null only if none exists yet. */
    paintLayer,
    commitPaint,
    tool,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setTool,
    select: setSelectedId,
    setActiveLayer,
    patchProject,
    addLayer,
    updateLayer,
    removeLayer,
    moveLayer,
    addKeyframe,
    updateKeyframe,
    removeKeyframe,
    duplicateKeyframe,
    undo,
    redo,
    openProject,
    newProject,
    deleteProject,
    importProjects,
  }
}
