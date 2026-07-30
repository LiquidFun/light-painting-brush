// Layer stack (REQUIREMENTS §6.2). The list is drawn top layer first, matching
// the compositing order the user sees on the canvas.

import { useRef, useState } from 'react'

import { formatBytes } from '../model/project'
import { BLEND_MODES } from '../model/types'
import type { BlendMode, ImageFit, Layer, LayerKind, Project } from '../model/types'
import { importImageFile } from '../render/imageCache'
import { PatternEditor } from './PatternEditor'
import { Button, Field, IconButton, Panel, Row, Segmented, Slider, Toggle } from './primitives'

const ADD: { kind: LayerKind; label: string }[] = [
  { kind: 'keyframes', label: 'Keyframes' },
  { kind: 'pattern', label: 'Pattern' },
  { kind: 'image', label: 'Image' },
]

const FITS: { id: ImageFit; label: string }[] = [
  { id: 'stretch', label: 'Stretch' },
  { id: 'contain', label: 'Contain' },
  { id: 'cover', label: 'Cover' },
]

function summarise(layer: Layer): string {
  switch (layer.kind) {
    case 'keyframes':
      return `${layer.keyframes.length} keyframe${layer.keyframes.length === 1 ? '' : 's'}`
    case 'pattern':
      return layer.pattern.kind
    case 'image':
      return layer.src ? `${formatBytes(layer.src.length)} · ${layer.fit}` : 'no image yet'
  }
}

export function LayerPanel({
  project,
  activeLayerId,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
}: {
  project: Project
  activeLayerId: string | null
  onSelect: (id: string) => void
  onAdd: (kind: LayerKind) => void
  /** `push` false coalesces a whole slider drag into one undo step. */
  onUpdate: (id: string, patch: Partial<Layer>, push?: boolean) => void
  onRemove: (id: string) => void
  onMove: (id: string, delta: number) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const active = project.layers.find((l) => l.id === activeLayerId) ?? null
  const top = project.layers.length - 1

  const pickImage = async (file: File | undefined, id: string) => {
    if (!file) return
    setImportError(null)
    try {
      onUpdate(id, { src: await importImageFile(file) })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'That image could not be loaded.')
    }
  }

  return (
    <>
      <Panel title="Layers">
        {project.layers.length === 0 && (
          <p className="text-sm text-mute">
            No layers. Add one — the canvas shows the project background until you do.
          </p>
        )}

        <ul className="space-y-1">
          {project.layers
            .map((layer, index) => ({ layer, index }))
            .reverse()
            .map(({ layer, index }) => (
              <li key={layer.id} className="flex items-center gap-1">
                <IconButton
                  label={layer.hidden ? `Show ${layer.name}` : `Hide ${layer.name}`}
                  active={!layer.hidden}
                  onClick={() => onUpdate(layer.id, { hidden: !layer.hidden })}
                >
                  {layer.hidden ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4zM3 13L13 3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
                    </svg>
                  )}
                </IconButton>
                <button
                  type="button"
                  aria-pressed={layer.id === activeLayerId}
                  onClick={() => onSelect(layer.id)}
                  className={[
                    'min-h-11 min-w-0 flex-1 truncate rounded border px-3 text-left text-sm',
                    layer.id === activeLayerId
                      ? 'border-fg bg-raised text-fg font-medium'
                      : 'border-line bg-panel text-dim active:bg-raised',
                    layer.hidden ? 'opacity-50' : '',
                  ].join(' ')}
                >
                  {layer.name}
                  <span className="num ml-2 text-xs text-mute">{summarise(layer)}</span>
                </button>
                <IconButton
                  label={`Move ${layer.name} up`}
                  disabled={index === top}
                  onClick={() => onMove(layer.id, 1)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M6 10V2M2 6l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </IconButton>
                <IconButton
                  label={`Move ${layer.name} down`}
                  disabled={index === 0}
                  onClick={() => onMove(layer.id, -1)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M6 2v8M2 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </IconButton>
              </li>
            ))}
        </ul>

        <Row>
          {ADD.map((a) => (
            <Button key={a.kind} onClick={() => onAdd(a.kind)}>
              + {a.label}
            </Button>
          ))}
        </Row>
      </Panel>

      {active && (
        <Panel title={active.kind}>
          <Field label="Name">
            <input
              type="text"
              value={active.name}
              onChange={(e) => onUpdate(active.id, { name: e.target.value }, false)}
            />
          </Field>

          <Slider
            label="Opacity"
            value={Math.round(active.opacity * 100)}
            min={0}
            max={100}
            display={`${Math.round(active.opacity * 100)}%`}
            onCommitStart={() => onUpdate(active.id, {}, true)}
            onChange={(v) => onUpdate(active.id, { opacity: v / 100 }, false)}
          />

          <Field
            label="Blend"
            hint={BLEND_MODES.find((b) => b.id === active.blend)?.note}
          >
            <select
              value={active.blend}
              onChange={(e) => onUpdate(active.id, { blend: e.target.value as BlendMode })}
            >
              {BLEND_MODES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>

          {active.kind === 'keyframes' && (
            <p className="text-xs text-mute">
              Selected, so the canvas tools draw into this layer. Its keyframes are the only
              ones showing handles.
            </p>
          )}

          {active.kind === 'pattern' && (
            <PatternEditor
              project={project}
              pattern={active.pattern}
              onChange={(pattern, push) => onUpdate(active.id, { pattern }, push)}
            />
          )}

          {active.kind === 'image' && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void pickImage(e.target.files?.[0], active.id)}
              />
              <Row>
                <Button strong onClick={() => fileRef.current?.click()}>
                  {active.src ? 'Replace image' : 'Choose image'}
                </Button>
                {active.src && (
                  <Button onClick={() => onUpdate(active.id, { src: '' })}>Clear</Button>
                )}
              </Row>
              {importError && <p className="text-sm text-fg">{importError}</p>}
              {active.src && (
                <img
                  src={active.src}
                  alt=""
                  className="max-h-40 w-full rounded border border-line object-contain"
                />
              )}
              <Segmented
                label="Image fit"
                options={FITS}
                value={active.fit}
                onChange={(fit) => onUpdate(active.id, { fit })}
              />
              <p className="text-xs text-mute">
                The image is resampled to {project.ledCount} LEDs across by the frame count
                down, so its aspect ratio has nothing to do with the photograph's.
              </p>
            </>
          )}

          <Toggle
            label="Hidden"
            hint="Keeps the layer in the project without rendering it."
            checked={active.hidden}
            onChange={(hidden) => onUpdate(active.id, { hidden })}
          />

          <Button
            full
            onClick={() => {
              if (window.confirm(`Delete layer "${active.name}"?`)) onRemove(active.id)
            }}
          >
            Delete layer
          </Button>
        </Panel>
      )}
    </>
  )
}
