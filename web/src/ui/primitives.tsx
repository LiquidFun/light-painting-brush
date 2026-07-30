// Shared chrome. No accent colour anywhere: state is carried by weight, border
// and fill (§4.11). Every interactive element is at least 44 px tall.

import type { ReactNode } from 'react'

type ButtonProps = {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  title?: string
  full?: boolean
  /** Slightly heavier fill for the one obvious action in a panel. */
  strong?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
}

export function Button({
  children,
  onClick,
  disabled,
  active,
  title,
  full,
  strong,
  onPointerDown,
}: ButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={[
        'min-h-11 px-3 rounded border text-sm font-medium select-none',
        'transition-[background-color,border-color] duration-100',
        full ? 'w-full' : '',
        disabled
          ? 'border-line text-mute cursor-not-allowed'
          : active
            ? 'border-fg bg-raised text-fg'
            : strong
              ? 'border-line-strong bg-raised text-fg active:bg-line'
              : 'border-line bg-panel text-dim active:bg-raised',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        'size-11 shrink-0 grid place-items-center rounded border select-none',
        disabled
          ? 'border-line text-mute'
          : active
            ? 'border-fg bg-raised text-fg'
            : 'border-line bg-panel text-dim active:bg-raised',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-flow-col auto-cols-fr gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={[
            'min-h-11 px-2 rounded border text-sm select-none',
            value === o.id
              ? 'border-fg bg-raised text-fg font-medium'
              : 'border-line bg-panel text-dim active:bg-raised',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded border border-line bg-panel px-3 text-left active:bg-raised"
    >
      <span className="text-sm">
        <span className={checked ? 'text-fg font-medium' : 'text-dim'}>{label}</span>
        {hint && <span className="block text-xs text-mute">{hint}</span>}
      </span>
      <span
        className={[
          'relative h-6 w-10 shrink-0 rounded-full border',
          checked ? 'border-fg bg-raised' : 'border-line-strong bg-bg',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-1/2 size-4 -translate-y-1/2 rounded-full transition-[left] duration-100',
            checked ? 'left-[18px] bg-fg' : 'left-[2px] bg-mute',
          ].join(' ')}
        />
      </span>
    </button>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  hint,
  onChange,
  onCommitStart,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  display?: string
  /** One line under the track, for controls whose name does not explain them. */
  hint?: string
  onChange: (v: number) => void
  /** Called on pointer down so a whole drag becomes one undo step. */
  onCommitStart?: () => void
  disabled?: boolean
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-mute">{label}</span>
        <span className="num text-sm text-dim">{display ?? value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={onCommitStart}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <span className="block text-xs text-mute">{hint}</span>}
    </label>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs uppercase tracking-wide text-mute">{label}</span>
      {children}
      {hint && <span className="block text-xs text-mute">{hint}</span>}
    </label>
  )
}

export function Panel({
  title,
  children,
  actions,
}: {
  title?: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="rounded border border-line bg-panel">
      {title && (
        <header className="flex min-h-11 items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-dim">{title}</h2>
          {actions}
        </header>
      )}
      <div className="space-y-3 p-3">{children}</div>
    </section>
  )
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-mute">{label}</div>
      <div className="num truncate text-sm text-fg">{value}</div>
      {note && <div className="text-xs text-mute">{note}</div>}
    </div>
  )
}
