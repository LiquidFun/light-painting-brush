import { MAX_BRUSH, MIN_BRUSH } from '../model/types'
import type { Tool } from '../model/types'
import { Segmented, Slider } from './primitives'

// Two rows of three rather than one of six. At six across, a 360 px phone gives
// each tool about 55 px and the longer labels simply cannot render. Split by what
// they do: freehand on top, keyframe placement below.
const PAINT_TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'brush', label: 'Brush' },
  { id: 'eraser', label: 'Eraser' },
]

const KEYFRAME_TOOLS: { id: Tool; label: string }[] = [
  { id: 'point', label: 'Point' },
  { id: 'row', label: 'Row' },
  { id: 'column', label: 'Column' },
]

export function ToolSelector({
  tool,
  brushSize,
  color,
  onChange,
  onBrushSize,
  onColor,
}: {
  tool: Tool
  /** Diameter in pixels — LEDs across, frames down. */
  brushSize: number
  /** The colour the brush lays down. Shared with the keyframe editor. */
  color: string
  onChange: (tool: Tool) => void
  onBrushSize: (size: number) => void
  onColor: (color: string) => void
}) {
  const painting = tool === 'brush' || tool === 'eraser'

  return (
    <div
      className="space-y-2 border-t border-line bg-panel p-2"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <Segmented label="Tool" options={PAINT_TOOLS} value={tool} onChange={onChange} />
      <Segmented label="Keyframe tool" options={KEYFRAME_TOOLS} value={tool} onChange={onChange} />

      {painting && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Slider
              label="Brush size"
              value={brushSize}
              min={MIN_BRUSH}
              max={MAX_BRUSH}
              display={`${brushSize} px`}
              onChange={onBrushSize}
            />
          </div>
          {/* The eraser ignores the colour, so offering one there would be a lie. */}
          {tool === 'brush' && (
            <input
              type="color"
              aria-label="Brush colour"
              className="shrink-0"
              style={{ width: 56 }}
              value={color}
              onChange={(e) => onColor(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  )
}
