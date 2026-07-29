// Browser support for Web Bluetooth is genuinely limited. Say so plainly and get
// out of the way: the editor is never blocked behind the connection (§4.1).

export function BluetoothNotice({ onDismiss }: { onDismiss: () => void }) {
  const secure = window.isSecureContext

  return (
    <div className="flex items-start gap-3 border-b border-line bg-raised px-3 py-2 text-xs text-dim">
      <p className="min-w-0 flex-1">
        {secure ? (
          <>
            This browser cannot connect to the stick. Web Bluetooth works in Chrome and
            Edge on Android, Linux, macOS and Windows. Firefox and Safari do not support
            it, and on iOS no browser can. Designing, previewing, saving and exporting all
            work here regardless.
          </>
        ) : (
          <>
            This page is not in a secure context, so Web Bluetooth is unavailable. Serve it
            over HTTPS, or use <span className="num">localhost</span> during development.
            Everything except connecting still works.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-11 shrink-0 px-2 text-fg underline underline-offset-2"
      >
        Dismiss
      </button>
    </div>
  )
}
