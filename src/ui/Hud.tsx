import { useEffect, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { viewport, viewCenter } from '../lib/view'
import { zoomAt } from '../lib/geometry'
import { IconPlus, IconMinus, IconFit, IconTidy, IconMap } from './icons'
import { Minimap } from './Minimap'

const MAP_KEY = 'ccanvas.minimap'

function loadMapOpen() {
  try {
    return localStorage.getItem(MAP_KEY) === '1'
  } catch {
    return false
  }
}

// Bottom-right view controls: arrange terminals, fit, zoom, and the minimap
// (hidden until asked for, so the canvas stays clear).
export function Hud() {
  const zoom = useStore((s) => selectActive(s).camera.zoom)
  const hasTerms = useStore((s) =>
    selectActive(s).elements.some(
      (e) => e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent'),
    ),
  )
  const setCamera = useStore((s) => s.setCamera)
  const homeView = useStore((s) => s.homeView)
  const [mapOpen, setMapOpen] = useState(loadMapOpen)
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const arrangeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(MAP_KEY, mapOpen ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [mapOpen])

  useEffect(() => {
    if (!arrangeOpen) return
    const onDown = (e: PointerEvent) => {
      if (!arrangeRef.current?.contains(e.target as Node)) setArrangeOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [arrangeOpen])

  const bump = (factor: number) => {
    const cam = selectActive(useStore.getState()).camera
    setCamera(zoomAt(cam, viewCenter(), cam.zoom * factor))
  }
  const reset = () => {
    const cam = selectActive(useStore.getState()).camera
    setCamera(zoomAt(cam, viewCenter(), 1))
  }
  const fit = () => {
    const { vw, vh } = viewport()
    homeView(vw, vh)
  }
  const arrange = (by: 'label' | 'folder') => {
    const st = useStore.getState()
    st.arrangeTerminals(by)
    setArrangeOpen(false)
    fit()
  }

  return (
    <>
      {mapOpen && <Minimap />}
      <div className="hud">
        {hasTerms && (
          <div className="hud__menu-wrap" ref={arrangeRef}>
            <button
              className={`hud__btn${arrangeOpen ? ' hud__btn--on' : ''}`}
              title="Arrange terminals"
              onClick={() => setArrangeOpen((o) => !o)}
            >
              <IconTidy />
            </button>
            {arrangeOpen && (
              <div className="hud__menu">
                <div className="hud__menu-title">Arrange terminals</div>
                <button onClick={() => arrange('label')}>By label colour</button>
                <button onClick={() => arrange('folder')}>By folder</button>
                <div className="hud__menu-hint">Select 2+ to arrange just those</div>
              </div>
            )}
          </div>
        )}
        <button
          className={`hud__btn${mapOpen ? ' hud__btn--on' : ''}`}
          title={mapOpen ? 'Hide minimap' : 'Show minimap'}
          onClick={() => setMapOpen((o) => !o)}
        >
          <IconMap />
        </button>
        <button className="hud__btn" title="Fit everything (\)" onClick={fit}>
          <IconFit />
        </button>
        <span className="hud__sep" />
        <button className="hud__btn" title="Zoom out (⌘-)" onClick={() => bump(1 / 1.2)}>
          <IconMinus />
        </button>
        <button className="hud__zoom" title="Reset to 100% (⌘0)" onClick={reset}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="hud__btn" title="Zoom in (⌘+)" onClick={() => bump(1.2)}>
          <IconPlus />
        </button>
      </div>
    </>
  )
}
