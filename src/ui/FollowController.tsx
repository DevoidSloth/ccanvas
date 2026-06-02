import { useEffect, useRef } from 'react'
import { useStore } from '../store/workspace'
import { useAgents, type AgentStatus } from '../lib/agents'

const CHROME_H = 82

// Headless controller for "follow the active agent": when enabled, the camera
// pans to whichever agent most recently started working. Tracking-camera mode
// owns the camera itself, so we stand down while it's active.
function centerOnAgent(id: string) {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.elements.some((e) => e.id === id))
  if (!tab) return
  const agent = tab.elements.find((e) => e.id === id)
  if (!agent || agent.type !== 'widget') return
  if (s.activeTabId !== tab.id) s.switchTab(tab.id)
  const cam = tab.camera
  const cx = agent.x + agent.w / 2
  const cy = agent.y + agent.h / 2
  s.setCamera({
    zoom: cam.zoom,
    x: window.innerWidth / 2 - cx * cam.zoom,
    y: (window.innerHeight - CHROME_H) / 2 - cy * cam.zoom,
  })
  s.setSelection([id])
}

export function FollowController() {
  const prev = useRef<Record<string, AgentStatus>>({})
  useEffect(() => {
    const unsub = useAgents.subscribe((st) => {
      const cur = st.status
      const s = useStore.getState()
      if (s.followAgent && !s.trackingAgentId) {
        for (const id in cur) {
          if (cur[id] === 'working' && prev.current[id] !== 'working') {
            centerOnAgent(id)
            break
          }
        }
      }
      prev.current = { ...cur }
    })
    return unsub
  }, [])
  return null
}
