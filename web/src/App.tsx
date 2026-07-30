import { useCallback, useEffect, useMemo, useState } from 'react'

import { frameCount } from './model/project'
import { loadPrefs, savePrefs } from './model/storage'
import { useEditor } from './state/useEditor'
import { useTransport } from './state/useTransport'
import { useField } from './state/useField'
import { usePlayback } from './state/usePlayback'
import { buildPayload } from './render/payload'
import { BrightnessCurve, CURVE_THICKNESS } from './ui/BrightnessCurve'
import type { CanvasGeometry } from './ui/FieldCanvas'
import { ContextMenu } from './ui/ContextMenu'
import type { ContextTarget } from './ui/ContextMenu'
import { DevicePanel } from './ui/DevicePanel'
import { FieldCanvas } from './ui/FieldCanvas'
import { Header } from './ui/Header'
import { KeyframeEditor } from './ui/KeyframeEditor'
import { LayerPanel } from './ui/LayerPanel'
import { PowerPanel } from './ui/PowerPanel'
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
  const [autoPlay, setAutoPlay] = useState(false)
  const [lastColor, setLastColor] = useState('#ffffff')
  const [showCurves, setShowCurves] = useState(false)
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
      autoPlay,
    })
  }, [autoPlay, transport, field, project])

  const selected = editor.selected
  const keyframes = editor.drawLayer?.keyframes ?? []
  const menuKeyframe = useMemo(
    () => (menu ? keyframes.find((k) => k.id === menu.id) ?? null : null),
    [menu, keyframes],
  )

  return (
    <div className="flex h-full flex-col lg:flex-row">
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
          onUpload={() => void upload()}
          onPlay={transport.play}
        />

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
            onOpenEditor={() => openSheet('keyframe')}
            onContextMenu={(id, x, y) => setMenu({ id, x, y })}
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
        <ToolSelector tool={editor.tool} onChange={editor.setTool} />
      </div>

      <Sheet
        open={sheetOpen}
        tab={sheetTab}
        onTab={setSheetTab}
        onClose={() => setSheetOpen(false)}
      >
        {sheetTab === 'keyframe' &&
          (selected ? (
            <KeyframeEditor
              keyframe={selected}
              project={project}
              onChange={(patch, push) => {
                if (patch.color) setLastColor(patch.color)
                editor.updateKeyframe(selected.id, patch, push)
              }}
              onDelete={() => editor.removeKeyframe(selected.id)}
              onDuplicate={() => editor.duplicateKeyframe(selected.id)}
            />
          ) : (
            <p className="text-sm text-mute">
              Nothing selected. Pick the Point, Row or Column tool and tap the canvas, or
              tap an existing handle.
            </p>
          ))}

        {sheetTab === 'layers' && (
          <LayerPanel
            project={project}
            activeLayerId={editor.activeLayerId}
            onSelect={editor.setActiveLayer}
            onAdd={editor.addLayer}
            onUpdate={editor.updateLayer}
            onRemove={editor.removeLayer}
            onMove={editor.moveLayer}
          />
        )}

        {sheetTab === 'device' && (
          <DevicePanel
            transport={transport}
            project={project}
            autoPlay={autoPlay}
            onAutoPlayChange={setAutoPlay}
            onPatchProject={editor.patchProject}
            onUpload={() => void upload()}
            onTransportKind={(kind) => setPrefs((p) => ({ ...p, transport: kind }))}
          />
        )}

        {sheetTab === 'project' && (
          <>
            <ProjectPanel
              project={project}
              library={editor.library}
              librarySync={editor.librarySync}
              maxAnimationBytes={transport.maxAnimationBytes}
              night={prefs.night}
              onNightChange={(night) => setPrefs((p) => ({ ...p, night }))}
              onPatch={editor.patchProject}
              onOpen={editor.openProject}
              onNew={editor.newProject}
              onDelete={editor.deleteProject}
              onImport={editor.importProjects}
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
