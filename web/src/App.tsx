import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'

import { frameCount } from './model/project'
import { loadPrefs, savePrefs } from './model/storage'
import { useEditor } from './state/useEditor'
import { useTransport } from './state/useTransport'
import { useField } from './state/useField'
import { usePlayback } from './state/usePlayback'
import { buildPayload } from './render/payload'
import { serialisePaint } from './render/paintCache'
import { importImageFile } from './render/imageCache'
import { MIN_BRUSH } from './model/types'
import { BrightnessCurve, CURVE_THICKNESS } from './ui/BrightnessCurve'
// three.js is ~600 KB and most sessions never open the 3D view, so it is split
// into its own chunk and fetched the first time it is asked for.
const Preview3D = lazy(() =>
  import('./ui/Preview3D').then((m) => ({ default: m.Preview3D })),
)
import type { CanvasGeometry } from './ui/FieldCanvas'
import { ContextMenu } from './ui/ContextMenu'
import type { ContextTarget } from './ui/ContextMenu'
import { DevicePanel } from './ui/DevicePanel'
import { FieldCanvas } from './ui/FieldCanvas'
import { Header } from './ui/Header'
import { LayerPanel } from './ui/LayerPanel'
import { PowerPanel } from './ui/PowerPanel'
import { LibraryPanel } from './ui/LibraryPanel'
import { ProjectPanel } from './ui/ProjectPanel'
import { Sheet } from './ui/Sheet'
import type { SheetTab } from './ui/Sheet'
import { StripBar } from './ui/StripBar'
import { ToolSelector } from './ui/ToolSelector'
import { Transport } from './ui/Transport'

export default function App() {
  const [prefs, setPrefs] = useState(loadPrefs)
  const editor = useEditor()
  const transport = useTransport(prefs.transport)
  const { project } = editor
  const field = useField(project)
  const playhead = usePlayback(project.durationMs, project.fps)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetTab, setSheetTab] = useState<SheetTab>('project')
  const [menu, setMenu] = useState<ContextTarget | null>(null)
  const [lastColor, setLastColor] = useState('#ffffff')
  const [showCurves, setShowCurves] = useState(false)
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [dropping, setDropping] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const [brushSize, setBrushSize] = useState(MIN_BRUSH * 3)
  // The curves are separate elements beside the canvas, so they need the
  // canvas's own gutter offset and pan/zoom to stay lined up with the axes.
  const [geometry, setGeometry] = useState<CanvasGeometry>({
    originX: 0,
    originY: 0,
    panX: 0,
    panY: 0,
    spanX: 0,
    spanY: 0,
  })

  useEffect(() => {
    savePrefs(prefs)
    document.documentElement.classList.toggle('night', prefs.night)
  }, [prefs])

  const openSheet = useCallback((tab: SheetTab) => {
    setSheetTab(tab)
    setSheetOpen(true)
  }, [])

  const upload = useCallback(async () => {
    const payload = buildPayload(field)
    await transport.upload(payload, {
      ledCount: project.ledCount,
      frameCount: field.height,
      fps: project.fps,
      startDelayMs: project.playback.startDelayMs,
      loop: project.playback.loop,
      pingPong: project.playback.pingPong,
      autoPlay: project.playback.autoPlay,
    })
    // The stick keeps whatever brightness it was last told; make it match the
    // project rather than the previous upload's.
    transport.setMasterBrightness(project.brightness)
  }, [transport, field, project])

  /**
   * Dropping a picture anywhere on the editor adds it as an image layer. Going
   * via the layer panel first is a lot of taps for the most obvious gesture
   * there is, and the file input stays for platforms without drag and drop.
   */
  const addImageLayer = useCallback(
    async (file: File, fallbackName: string) => {
      setDropError(null)
      if (!file.type.startsWith('image/')) {
        setDropError(`${file.name || 'That file'} is not an image.`)
        return
      }
      try {
        const src = await importImageFile(file)
        const layer = editor.addLayer('image')
        // Clipboard images arrive as "image.png" or with no name at all, which
        // makes for a uselessly generic layer.
        const stem = file.name.replace(/\.[^.]+$/, '')
        editor.updateLayer(layer.id, {
          src,
          name: stem && stem !== 'image' ? stem : fallbackName,
        })
        openSheet('layers')
      } catch {
        setDropError(`Could not read ${file.name || 'that image'}.`)
      }
    },
    [editor, openSheet],
  )

  // Pasting an image adds it as a layer, the same as dropping one.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      // Never hijack a paste aimed at a text field — the project name and the
      // background hex both want ordinary clipboard behaviour.
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const item = [...(event.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith('image/'),
      )
      const file = item?.getAsFile()
      if (!file) return
      event.preventDefault()
      void addImageLayer(file, 'Pasted image')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addImageLayer])

  const selected = editor.selected
  const keyframes = editor.drawLayer?.keyframes ?? []
  const menuKeyframe = useMemo(
    () => (menu ? keyframes.find((k) => k.id === menu.id) ?? null : null),
    [menu, keyframes],
  )

  return (
    <div
      className="relative flex h-full flex-col lg:flex-row"
      onDragOver={(e) => {
        // Only claim the drop if it is actually carrying files.
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(false)
        const file = e.dataTransfer.files[0]
        if (file) void addImageLayer(file, 'Image')
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center border-2 border-dashed border-fg bg-bg/80">
          <p className="text-sm text-fg">Drop an image to add it as a layer</p>
        </div>
      )}
      {dropError && (
        <p className="absolute inset-x-2 top-2 z-20 rounded border border-line-strong bg-raised p-2 text-center text-sm text-fg">
          {dropError}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => setDropError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <Header
          project={project}
          transport={transport}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onOpenProject={() => openSheet('project')}
          onOpenLayers={() => openSheet('layers')}
          onOpenDevice={() => openSheet('device')}
          view={view}
          onView={setView}
          onUpload={() => void upload()}
          onPlay={transport.play}
          onStop={transport.stop}
        />

        {view === '3d' ? (
          <Suspense
            fallback={
              <div className="grid min-h-0 flex-1 place-items-center text-sm text-mute">
                Loading the 3D view…
              </div>
            }
          >
            <Preview3D field={field} />
          </Suspense>
        ) : (
          <>
          <div className="flex min-h-0 flex-1">
            {showCurves && (
              <BrightnessCurve
                axis="y"
                values={project.brightnessY}
                origin={geometry.originY}
                pan={geometry.panY}
                span={geometry.spanY}
                onChange={(brightnessY, push) =>
                  editor.patchProject({ brightnessY }, push)
                }
              />
            )}
            <FieldCanvas
              onGeometry={setGeometry}
              project={project}
              keyframes={keyframes}
              field={field}
              playheadMs={playhead.timeMs}
              selectedId={editor.selectedId}
              tool={editor.tool}
              defaultColor={lastColor}
              onAdd={editor.addKeyframe}
              onSelect={editor.select}
              onMove={(id, patch, push) => editor.updateKeyframe(id, patch, push)}
              onScrub={(ms) => {
                playhead.pause()
                playhead.setTime(ms)
              }}
              onOpenEditor={() => openSheet('layers')}
              onContextMenu={(id, x, y) => setMenu({ id, x, y })}
              paintLayerId={editor.paintLayer?.id ?? null}
              brushRadius={brushSize / 2}
              onStrokeEnd={() => {
                const id = editor.paintLayer?.id
                if (id) editor.commitPaint(id, serialisePaint(id))
              }}
            />
          </div>

          {showCurves && (
            <div className="flex">
              <div className="shrink-0" style={{ width: CURVE_THICKNESS }} />
              <div className="min-w-0 flex-1">
                <BrightnessCurve
                  axis="x"
                  values={project.brightnessX}
                  origin={geometry.originX}
                  pan={geometry.panX}
                  span={geometry.spanX}
                  onChange={(brightnessX, push) =>
                    editor.patchProject({ brightnessX }, push)
                  }
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 px-2 py-1">
            <p className="num min-w-0 flex-1 truncate text-center text-[10px] text-mute">
              LED index across · time downward — this is what the photograph will look like
            </p>
            <button
              type="button"
              aria-pressed={showCurves}
              onClick={() => setShowCurves((v) => !v)}
              className={[
                'shrink-0 rounded border px-2 py-1 text-[10px]',
                showCurves ? 'border-fg text-fg' : 'border-line text-mute',
              ].join(' ')}
            >
              Brightness
            </button>
          </div>

          <StripBar field={field} timeMs={playhead.timeMs} fps={project.fps} />
          <Transport
            playhead={playhead}
            durationMs={project.durationMs}
            fps={project.fps}
            frameCount={frameCount(project)}
          />
          </>
        )}

        <ToolSelector
          tool={editor.tool}
          brushSize={brushSize}
          color={lastColor}
          onChange={editor.setTool}
          onBrushSize={setBrushSize}
          onColor={setLastColor}
        />
      </div>

      <Sheet
        open={sheetOpen}
        tab={sheetTab}
        onTab={setSheetTab}
        onClose={() => setSheetOpen(false)}
      >

        {sheetTab === 'layers' && (
          <LayerPanel
            project={project}
            activeLayerId={editor.activeLayerId}
            onSelect={editor.setActiveLayer}
            onAdd={editor.addLayer}
            onUpdate={editor.updateLayer}
            onRemove={editor.removeLayer}
            onMove={editor.moveLayer}
            selectedKeyframe={selected}
            onKeyframeChange={(patch, push) => {
              if (patch.color) setLastColor(patch.color)
              if (selected) editor.updateKeyframe(selected.id, patch, push)
            }}
            onKeyframeDelete={() => selected && editor.removeKeyframe(selected.id)}
            onKeyframeDuplicate={() => selected && editor.duplicateKeyframe(selected.id)}
          />
        )}

        {sheetTab === 'library' && (
          <LibraryPanel
            project={project}
            library={editor.library}
            librarySync={editor.librarySync}
            onOpen={editor.openProject}
            onNew={editor.newProject}
            onDelete={editor.deleteProject}
            onImport={editor.importProjects}
          />
        )}

        {sheetTab === 'device' && (
          <DevicePanel
            transport={transport}
            project={project}
            onPatchProject={editor.patchProject}
            onUpload={() => void upload()}
            onTransportKind={(kind) => setPrefs((p) => ({ ...p, transport: kind }))}
          />
        )}

        {sheetTab === 'project' && (
          <>
            <ProjectPanel
              project={project}
              maxAnimationBytes={transport.maxAnimationBytes}
              night={prefs.night}
              onNightChange={(night) => setPrefs((p) => ({ ...p, night }))}
              onPatch={editor.patchProject}
            />
            <PowerPanel field={field} project={project} onPatch={editor.patchProject} />
          </>
        )}
      </Sheet>

      {menu && menuKeyframe && (
        <ContextMenu
          target={menu}
          onClose={() => setMenu(null)}
          onDuplicate={() => editor.duplicateKeyframe(menu.id)}
          onDelete={() => editor.removeKeyframe(menu.id)}
          onCopyColor={() => setLastColor(menuKeyframe.color)}
        />
      )}
    </div>
  )
}
