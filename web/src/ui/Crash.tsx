// Turns a blank page into a bug report.
//
// A crash during the first render leaves #root empty, which on a dark page is
// indistinguishable from a hang, a failed deploy, or a browser that simply does
// not support something. That is unreportable: the one device that fails is
// usually the one you cannot attach a debugger to.
//
// Everything here uses inline styles and no imports beyond React, so it still
// renders if the stylesheet is what failed.

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

const box: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  overflow: 'auto',
  padding: 16,
  background: '#140a08',
  color: '#e6e9ec',
  font: '13px/1.5 ui-monospace, SFMono-Regular, monospace',
}

export function CrashReport({ error, where }: { error: unknown; where: string }) {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  const report = [
    `${where}: ${message}`,
    stack ?? '',
    `${navigator.userAgent}`,
  ].join('\n\n')

  return (
    <div style={box}>
      <p style={{ margin: '0 0 12px', fontWeight: 600 }}>The editor failed to start.</p>
      <p style={{ margin: '0 0 12px', color: '#a3abb2' }}>
        Nothing has been lost — projects are saved in this browser and on the server.
        Copy this and send it on.
      </p>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(report)}
        style={{
          minHeight: 44,
          padding: '0 12px',
          marginBottom: 12,
          border: '1px solid #48211a',
          borderRadius: 4,
          background: '#1b1f23',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        Copy report
      </button>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{report}</pre>
    </div>
  )
}

type Props = { children: ReactNode }
type State = { error: unknown }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[lightstick] render failed', error, info.componentStack)
  }

  render() {
    if (this.state.error) return <CrashReport error={this.state.error} where="Render" />
    return this.props.children
  }
}
