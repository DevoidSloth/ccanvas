import { useStore, selectActive } from '../store/workspace'
import type { WidgetElement } from '../lib/types'
import { ClaudeBody } from '../widgets/ClaudeBody'
import { IconClose } from './icons'
import '../styles/agent-tools.css'

// Claude's memory graph for the active canvas's folder, shown in the side dock
// rather than as its own tab.
export function MemoryPanel() {
  const ws = useStore(selectActive)
  const setOpenPanel = useStore((s) => s.setOpenPanel)
  // ClaudeBody renders from a widget element; only its folder matters here
  const el = {
    id: `memory-${ws.id}`,
    type: 'widget',
    kind: 'claude',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    z: 0,
    title: 'Memory',
    cwd: ws.dir,
  } as WidgetElement

  return (
    <div className="panel panel--wide">
      <div className="panel__head">
        <span className="panel__title">Memory</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>
      <div className="panel__graph">
        <ClaudeBody key={ws.dir ?? 'none'} el={el} />
      </div>
    </div>
  )
}
