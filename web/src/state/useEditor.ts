// Editor state: the current project, the library, selection, and a bounded
// undo/redo stack. Everything the UI mutates goes through here.
//
// All state transitions read the previous value from a ref and write with a
// plain setState, never from inside an updater function: updaters run twice
// under StrictMode and a side effect in one would corrupt the history stack.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { clamp } from '../model/color'
import {
  clampKeyframe,
  createProject,
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
import type { Keyframe, Project, Tool } from '../model/types'

const HISTORY_LIMIT = 80
const AUTOSAVE_DEBOUNCE_MS = 400

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
  const [tool, setTool] = useState<Tool>('select')

  const projectRef = useRef(project)
  const libraryRef = useRef(library)

  const setProject = useCallback((next: Project) => {
    projectRef.current = next
    setProjectState(next)
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

  // Autosave on change, debounced.
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
        next.keyframes = next.keyframes.map((k) => clampKeyframe(k, next))
        return next
      }, push)
    },
    [mutate],
  )

  // --- keyframe edits -------------------------------------------------------

  const addKeyframe = useCallback(
    (keyframe: Keyframe) => {
      mutate((p) => ({ ...p, keyframes: [...p.keyframes, clampKeyframe(keyframe, p)] }))
      setSelectedId(keyframe.id)
    },
    [mutate],
  )

  const updateKeyframe = useCallback(
    (id: string, patch: Partial<Keyframe>, push = true) => {
      mutate(
        (p) => ({
          ...p,
          keyframes: p.keyframes.map((k) =>
            k.id === id ? clampKeyframe({ ...k, ...patch }, p) : k,
          ),
        }),
        push,
      )
    },
    [mutate],
  )

  const removeKeyframe = useCallback(
    (id: string) => {
      mutate((p) => ({ ...p, keyframes: p.keyframes.filter((k) => k.id !== id) }))
      setSelectedId((current) => (current === id ? null : current))
    },
    [mutate],
  )

  const duplicateKeyframe = useCallback(
    (id: string) => {
      const source = projectRef.current.keyframes.find((k) => k.id === id)
      if (!source) return
      // Offset a little so the copy is grabbable rather than hidden underneath.
      const copy: Keyframe = {
        ...source,
        id: uid(),
        timeMs: source.timeMs + projectRef.current.durationMs * 0.05,
        led: source.led + 4,
      }
      mutate((p) => ({ ...p, keyframes: [...p.keyframes, clampKeyframe(copy, p)] }))
      setSelectedId(copy.id)
    },
    [mutate],
  )

  // --- library --------------------------------------------------------------

  const openProject = useCallback(
    (id: string) => {
      const target = libraryRef.current.find((p) => p.id === id)
      if (!target) return
      setProject(target)
      setHistory({ past: [], future: [] })
      setSelectedId(null)
      saveLastOpenedId(id)
    },
    [setProject],
  )

  const newProject = useCallback(() => {
    const created = seedProject(createProject(`Untitled ${libraryRef.current.length + 1}`))
    setLibrary([...libraryRef.current, created])
    setProject(created)
    setHistory({ past: [], future: [] })
    setSelectedId(null)
  }, [setLibrary, setProject])

  const deleteProject = useCallback(
    (id: string) => {
      const remaining = libraryRef.current.filter((p) => p.id !== id)
      const list =
        remaining.length > 0 ? remaining : [seedProject(createProject('First light'))]
      setLibrary(list)
      if (projectRef.current.id === id) {
        setProject(list[0])
        setHistory({ past: [], future: [] })
        setSelectedId(null)
      }
    },
    [setLibrary, setProject],
  )

  const importProjects = useCallback(
    (imported: Project[]) => {
      if (imported.length === 0) return
      const taken = new Set(libraryRef.current.map((p) => p.id))
      const fresh = imported.map((p) => (taken.has(p.id) ? { ...p, id: uid() } : p))
      setLibrary([...libraryRef.current, ...fresh])
      setProject(fresh[0])
      setHistory({ past: [], future: [] })
      setSelectedId(null)
    },
    [setLibrary, setProject],
  )

  const selected = useMemo(
    () => project.keyframes.find((k) => k.id === selectedId) ?? null,
    [project.keyframes, selectedId],
  )

  return {
    library,
    project,
    selected,
    selectedId,
    tool,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setTool,
    select: setSelectedId,
    patchProject,
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
