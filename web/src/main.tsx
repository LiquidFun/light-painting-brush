import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { CrashReport, ErrorBoundary } from './ui/Crash'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// Three layers, because a blank dark page is indistinguishable from a hang, a
// failed deploy, or an unsupported browser, and tells nobody anything. A render
// error is caught by the boundary; a failure before React gets going is caught
// here; anything thrown later, from a handler or a rejected promise, at least
// reaches the console with a findable prefix.
try {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
} catch (error) {
  root.render(<CrashReport error={error} where="Startup" />)
}

window.addEventListener('error', (event) => {
  console.error('[lightstick] uncaught', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[lightstick] unhandled rejection', event.reason)
})
