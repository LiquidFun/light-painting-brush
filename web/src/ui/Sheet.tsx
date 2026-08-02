// The editor is a bottom sheet, not a sidebar or a modal: it has to be
// thumb-reachable on a phone and must not cover the canvas region being edited.
//
// On landscape and desktop the same element becomes a right-hand panel. Same
// component, different arrangement — there is only one UI here (§4.10).

import type { ReactNode } from 'react'

export type SheetTab = 'project' | 'library' | 'layers' | 'device'

export function Sheet({
  open,
  tab,
  onTab,
  onClose,
  children,
}: {
  open: boolean
  tab: SheetTab
  onTab: (tab: SheetTab) => void
  onClose: () => void
  children: ReactNode
}) {
  // Ordered by how often you reach for them, left to right.
  const tabs: { id: SheetTab; label: string }[] = [
    { id: 'project', label: 'Project' },
    { id: 'library', label: 'Library' },
    { id: 'layers', label: 'Layers' },
    { id: 'device', label: 'Device' },
  ]

  return (
    <aside
      aria-label="Editor"
      className={[
        'fixed inset-x-0 bottom-0 z-30 flex max-h-[62vh] flex-col border-t border-line bg-panel',
        'transition-transform duration-150 ease-out',
        open ? 'translate-y-0' : 'translate-y-full',
        'lg:static lg:z-0 lg:h-full lg:max-h-none lg:w-[380px] lg:shrink-0',
        'lg:translate-y-0 lg:border-l lg:border-t-0',
      ].join(' ')}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <header className="flex items-center gap-2 border-b border-line px-2 py-1">
        <div className="flex min-w-0 flex-1 gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => onTab(t.id)}
              className={[
                'min-h-11 flex-1 rounded px-2 text-sm',
                tab === t.id ? 'bg-raised text-fg font-medium' : 'text-mute active:bg-raised',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Close editor"
          onClick={onClose}
          className="size-11 shrink-0 grid place-items-center rounded text-dim active:bg-raised lg:hidden"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {children}
      </div>
    </aside>
  )
}
