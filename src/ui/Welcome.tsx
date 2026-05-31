import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import { IconMark, IconFolder } from './icons'

// 82px = topbar + tabs; matches CHROME_H in App.tsx
const CHROME_H = 82

export function Welcome() {
  const ws = useStore(selectActive)
  const openAgentWizard = useStore((s) => s.openAgentWizard)
  const setActiveDir = useStore((s) => s.setActiveDir)
  if (ws.elements.length > 0) return null

  const spawnFirst = () => {
    const cam = selectActive(useStore.getState()).camera
    const world = screenToWorld(
      { x: window.innerWidth / 2, y: (window.innerHeight - CHROME_H) / 2 },
      cam,
    )
    openAgentWizard({ x: world.x, y: world.y })
  }

  return (
    <div className="welcome">
      <div className="welcome__inner fade-up">
        <div className="welcome__mark">
          <IconMark />
        </div>
        <h1 className="welcome__title">
          The canvas for coding with <b>agents</b>
        </h1>
        <p className="welcome__sub">
          Spawn terminals, Claude agents, and live previews on an infinite
          surface, then sketch the architecture around them. Every tab is a
          self-contained <span className="kbd">.ccnvs</span> workspace.
        </p>

        <div style={{ marginBottom: 24, display: 'flex', gap: 8, justifyContent: 'center' }}>
          {ws.dir ? (
            <button className="tb-btn tb-btn--accent" onClick={spawnFirst}>
              ✦ Spawn an agent in <span className="kbd">{ws.dir.split(/[\\/]/).pop()}</span>
            </button>
          ) : (
            <button className="tb-btn tb-btn--accent" onClick={() => void setActiveDir()}>
              <IconFolder /> Choose this canvas's folder
            </button>
          )}
        </div>

        <div className="welcome__hints">
          <div className="welcome__hint">
            <span className="kbd">Space</span> quick-insert text or
            <span className="kbd">/note /term /web /agent</span>
          </div>
          <div className="welcome__hint">
            <span className="kbd">H</span> / middle-drag pan
            <span className="kbd">⌘ scroll</span> zoom
          </div>
          <div className="welcome__hint">
            <span className="kbd">⌘S / ⌘O</span> save &amp; open .ccnvs
          </div>
        </div>
      </div>
    </div>
  )
}
