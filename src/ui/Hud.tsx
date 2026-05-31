import { useStore, selectActive } from '../store/workspace'
import { zoomAt } from '../lib/geometry'
import { IconPlus, IconMinus, IconFit } from './icons'

// 82px = topbar + tabs; matches CHROME_H in App.tsx
const CHROME_H = 82
const center = () => ({
  x: window.innerWidth / 2,
  y: (window.innerHeight - CHROME_H) / 2,
})
const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight - CHROME_H })

export function Hud() {
  const zoom = useStore((s) => selectActive(s).camera.zoom)
  const setCamera = useStore((s) => s.setCamera)
  const homeView = useStore((s) => s.homeView)

  const bump = (factor: number) => {
    const cam = selectActive(useStore.getState()).camera
    setCamera(zoomAt(cam, center(), cam.zoom * factor))
  }
  const reset = () => {
    const cam = selectActive(useStore.getState()).camera
    setCamera(zoomAt(cam, center(), 1))
  }
  const home = () => {
    const { vw, vh } = viewport()
    homeView(vw, vh)
  }

  return (
    <div className="hud">
      <button className="hud__btn" title="Center / fit view" onClick={home}>
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
  )
}
