import { Segmented } from './primitives'
import type { Tool } from '../model/types'

const TOOLS: { id: Tool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'point', label: 'Point' },
  { id: 'row', label: 'Row' },
  { id: 'column', label: 'Column' },
]

export function ToolSelector({
  tool,
  onChange,
}: {
  tool: Tool
  onChange: (tool: Tool) => void
}) {
  return (
    <div
      className="border-t border-line bg-panel p-2"
      style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      <Segmented label="Tool" options={TOOLS} value={tool} onChange={onChange} />
    </div>
  )
}
