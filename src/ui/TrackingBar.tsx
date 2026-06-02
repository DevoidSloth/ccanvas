import { useStore, selectActive } from '../store/workspace'
import type { WidgetElement } from '../lib/types'
import { IconTrack } from './icons'
import '../styles/agent-tools.css'

// Status pill shown while the tracking camera is following an agent. The orbit
// count is derived from the document (widgets tagged trackOf), so it stays live.
export function TrackingBar() {
  const trackingId = useStore((s) => s.trackingAgentId)
  const ws = useStore(selectActive)
  const stopTrackingAgent = useStore((s) => s.stopTrackingAgent)

  if (!trackingId) return null
  const agent = ws.elements.find(
    (e): e is WidgetElement => e.type === 'widget' && e.id === trackingId,
  )
  const count = ws.elements.filter((e) => e.type === 'widget' && e.trackOf === trackingId).length

  return (
    <div className="track-bar">
      <span className="track-bar__icon">
        <IconTrack size={15} />
      </span>
      <span className="track-bar__label">
        Tracking <b>{agent?.title ?? 'agent'}</b>
      </span>
      <span className="track-bar__count">
        {count} file{count === 1 ? '' : 's'}
      </span>
      <button className="track-bar__btn" title="Stop, keep the files" onClick={() => stopTrackingAgent(false)}>
        Stop
      </button>
      <button
        className="track-bar__btn track-bar__btn--danger"
        title="Stop and remove the orbit (satellite widgets + arrows)"
        onClick={() => stopTrackingAgent(true)}
      >
        Stop &amp; clear
      </button>
    </div>
  )
}
