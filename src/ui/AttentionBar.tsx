import { useState } from 'react'
import { viewCenter, revealLayerOf } from '../lib/view'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, sendTo } from '../lib/agents'
import { isDesktopMirror, openInClaude } from '../lib/desktopSessions'
import type { WidgetElement } from '../lib/types'
import { StatusGlyph } from '../widgets/widgetIcons'
import { IconExternal } from './icons'

// Global "agents need you" inbox. Lists agents currently waiting on input
// (detected from their output) and desktop-app mirrors waiting on a question
// or a stalled tool call; clicking one jumps to it. Quick yes/enter lets you
// clear an agent's prompt without leaving the inbox; a mirror is read-only, so
// its button opens the session in the Claude app to answer there instead.


export function AttentionBar() {
  const status = useAgents((s) => s.status)
  const focused = useStore((s) => s.focus?.id != null)
  const spread = useStore((s) => s.spread != null)
  const ws = useStore(selectActive)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const setCamera = useStore((s) => s.setCamera)
  const [open, setOpen] = useState(true)

  const waiting = ws.elements.filter(
    (e): e is WidgetElement =>
      e.type === 'widget' && (e.kind === 'agent' || isDesktopMirror(e)) && status[e.id] === 'waiting',
  )
  // in focus mode the strip's chip says who needs you, and this would sit on
  // it; a spread stack's header has the same corner
  if (waiting.length === 0 || focused || spread) return null

  const goto = (el: WidgetElement) => {
    revealLayerOf(el.id)
    const cam = selectActive(useStore.getState()).camera
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    setCamera({
      zoom: cam.zoom,
      x: viewCenter().x - cx * cam.zoom,
      y: viewCenter().y - cy * cam.zoom,
    })
    setSelection([el.id])
    // on top of anything it overlaps, as every other jump does
    useStore.getState().bringToFront([el.id])
    setActiveWidget(el.id)
  }

  return (
    <div className="attn">
      <button
        className="attn__pill"
        onClick={() => setOpen((o) => !o)}
        title="Agents waiting on input"
      >
        <StatusGlyph status="waiting" className="attn__icon" />
        {waiting.length} waiting
      </button>
      {open && (
        <div className="attn__list">
          {waiting.map((el) => (
            <div key={el.id} className="attn__item">
              <button className="attn__name" onClick={() => goto(el)} title="Jump to agent">
                {el.title}
              </button>
              {el.mirrorOf === 'desktop' ? (
                el.desktopId && (
                  <button
                    className="attn__yes"
                    title="Answer in the Claude app"
                    onClick={() => openInClaude(el)}
                  >
                    <IconExternal size={13} />
                  </button>
                )
              ) : (
                <button
                  className="attn__yes"
                  title="Send Enter"
                  onClick={() => sendTo(el.id, '\r')}
                >
                  ⏎
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
