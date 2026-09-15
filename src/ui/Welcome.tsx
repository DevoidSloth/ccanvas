import { useEffect, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import { makeGreeting, loadFirstName, type Greeting } from '../lib/greeting'
import { IconFolder, IconAgent } from './icons'

// 82px = topbar + tabs; matches CHROME_H in App.tsx
const CHROME_H = 82

export function Welcome() {
  const ws = useStore(selectActive)
  const openAgentWizard = useStore((s) => s.openAgentWizard)
  const setActiveDir = useStore((s) => s.setActiveDir)
  // chosen once per launch, after the user's name is known
  const [greeting, setGreeting] = useState<Greeting | null>(null)
  useEffect(() => {
    let live = true
    loadFirstName().then((name) => live && setGreeting(makeGreeting(name)))
    return () => {
      live = false
    }
  }, [])
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
      <div className={`welcome__inner${greeting ? ' fade-up' : ' welcome__inner--pending'}`}>
        <h1 className="welcome__title">
          <span className="welcome__spark" aria-hidden="true">
            ✻
          </span>
          {greeting?.title ?? ' '}
        </h1>
        <p className="welcome__sub">{greeting?.subtitle ?? ' '}</p>

        <div style={{ marginBottom: 26, display: 'flex', gap: 8, justifyContent: 'center' }}>
          {ws.dir ? (
            <button className="launcher launcher--agent" onClick={spawnFirst}>
              <IconAgent />
              <span className="launcher__label">
                Start Claude in {ws.dir.split(/[\\/]/).pop()}
              </span>
            </button>
          ) : (
            <button className="launcher launcher--agent" onClick={() => void setActiveDir()}>
              <IconFolder />
              <span className="launcher__label">Choose a project folder</span>
            </button>
          )}
        </div>

        <div className="welcome__hints">
          <div className="welcome__hint">
            <span className="kbd">⌘⇧T</span> new Claude agent
            <span className="kbd">⌘T</span> new terminal
          </div>
          <div className="welcome__hint">
            <span className="kbd">⌘W</span> close the focused box
            <span className="kbd">⌘K</span> all commands
          </div>
        </div>
      </div>
    </div>
  )
}
