import { useUpdate } from '../lib/updater'

// Bottom-right card shown once a new ccanvas version has been downloaded.
export function UpdateBanner() {
  const { ready, notes, installing, dismissed, install, dismiss } = useUpdate()
  if (!ready || dismissed) return null
  return (
    <div className="upd" role="status">
      <div className="upd__title">ccanvas {ready} is ready</div>
      <div className="upd__hint" title={notes || undefined}>
        Restarting ends running terminals; Claude agents resume their sessions.
      </div>
      <div className="upd__actions">
        <button className="upd__btn" onClick={dismiss} disabled={installing}>
          Later
        </button>
        <button className="upd__btn upd__btn--primary" onClick={() => void install()} disabled={installing}>
          {installing ? 'Updating…' : 'Restart to update'}
        </button>
      </div>
    </div>
  )
}
