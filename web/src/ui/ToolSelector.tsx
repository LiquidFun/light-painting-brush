import { Segmented } from './primitives'
import { BRUSH_SIZES } from '../model/types'
import type { Tool } from '../model/types'

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'brush', label: 'Brush' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'point', label: 'Point' },
  { id: 'row', label: 'Row' },
  { id: 'column', label: 'Column' },
]

const sizeLabel = (r: number) => (r <= 0.5 ? '1' : String(Math.round(r * 2)))

export function ToolSelector({
  tool,
  brushRadius,
  color,
  onChange,
  onBrushRadius,
}: {
  tool: Tool
  brushRadius: number
  /** The colour the brush lays down — the same one the keyframe editor last set. */
  color: string
  onChange: (tool: Tool) => void
  onBrushRadius: (radius: number) => void
}) {
  const painting = tool === 'brush' || tool === 'eraser'

  return (
    <div
      className="space-y-2 border-t border-line bg-panel p-2"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <Segmented label="Tool" options={TOOLS} value={tool} onChange={onChange} />

      {painting && (
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-mute">Size</span>
          <div className="min-w-0 flex-1">
            <Segmented
              label="Brush size"
              value={String(brushRadius)}
              options={BRUSH_SIZES.map((r) => ({ id: String(r), label: sizeLabel(r) }))}
              onChange={(id) => onBrushRadius(Number(id))}
            />
          </div>
          {/* Eraser ignores the colour, so showing it there would be a lie. */}
          {tool === 'brush' && (
            <span
              aria-label="Brush colour"
              className="size-8 shrink-0 rounded border border-line-strong"
              style={{ background: color }}
            />
          )}
        </div>
      )}
    </div>
  )
}
