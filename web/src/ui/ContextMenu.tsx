// Long-press menu for a keyframe handle.

import { useEffect, useRef } from 'react'

export type ContextTarget = { id: string; x: number; y: number }

export function ContextMenu({
  target,
  onClose,
  onDuplicate,
  onDelete,
  onCopyColor,
}: {
  target: ContextTarget
  onClose: () => void
  onDuplicate: () => void
  onDelete: () => void
  onCopyColor: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // Deferred so the pointerup that ended the long press does not close it.
    const timer = window.setTimeout(
      () => window.addEventListener('pointerdown', onDown),
      0,
    )
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  const items = [
    { label: 'Duplicate', run: onDuplicate },
    { label: 'Copy colour', run: onCopyColor },
    { label: 'Delete', run: onDelete },
  ]

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-40 w-44 overflow-hidden rounded border border-line-strong bg-panel"
      style={{
        left: Math.min(target.x, window.innerWidth - 190),
        top: Math.min(target.y, window.innerHeight - 160),
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            item.run()
            onClose()
          }}
          className="block min-h-11 w-full border-b border-line px-3 text-left text-sm text-dim last:border-b-0 active:bg-raised"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
