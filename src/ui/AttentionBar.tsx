import { useState } from 'react'
import { viewCenter } from '../lib/view'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, sendTo } from '../lib/agents'
import type { WidgetElement } from '../lib/types'

// Global "agents need you" inbox. Lists agents currently waiting on input
// (detected from their output); clicking one jumps to it. Quick yes/enter
// lets you clear a prompt without leaving the inbox.


export function AttentionBar() {
  const status = useAgents((s) => s.status)
  const ws = useStore(selectActive)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const setCamera = useStore((s) => s.setCamera)
  const [open, setOpen] = useState(true)

  const waiting = ws.elements.filter(
    (e): e is WidgetElement =>
      e.type === 'widget' && e.kind === 'agent' && status[e.id] === 'waiting',
  )
  if (waiting.length === 0) return null

  const goto = (el: WidgetElement) => {
    const cam = ws.camera
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    setCamera({
      zoom: cam.zoom,
      x: viewCenter().x - cx * cam.zoom,
      y: viewCenter().y - cy * cam.zoom,
    })
    setSelection([el.id])
    setActiveWidget(el.id)
  }

  return (
    <div className="attn">
      <button
        className="attn__pill"
        onClick={() => setOpen((o) => !o)}
        title="Agents waiting on input"
      >
        <span className="attn__dot" />
        {waiting.length} waiting
      </button>
      {open && (
        <div className="attn__list">
          {waiting.map((el) => (
            <div key={el.id} className="attn__item">
              <button className="attn__name" onClick={() => goto(el)} title="Jump to agent">
                {el.title}
              </button>
              <button
                className="attn__yes"
                title="Send Enter"
                onClick={() => sendTo(el.id, '\r')}
              >
                ⏎
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
