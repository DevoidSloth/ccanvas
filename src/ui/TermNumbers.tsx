import { useEffect, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { orderedTerminals } from '../lib/view'

// Hold ⌘ for a moment and every terminal shows the number that ⌘1–9 jumps to.
// Any other key (or releasing ⌘) hides them again, so ⌘-shortcuts never flash.
const HOLD_MS = 450

export function TermNumbers() {
  const [shown, setShown] = useState(false)
  // re-render with the camera so badges stay pinned while panning
  const cam = useStore((s) => selectActive(s).camera)
  useStore((s) => selectActive(s).elements)
  const activeWidgetId = useStore((s) => s.activeWidgetId)

  useEffect(() => {
    let timer: number | undefined
    const cancel = () => {
      window.clearTimeout(timer)
      timer = undefined
      setShown(false)
    }
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Meta' && !e.repeat) {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => setShown(true), HOLD_MS)
      } else if (e.key !== 'Meta') cancel()
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta') cancel()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('pointerdown', cancel, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointerdown', cancel, true)
      window.clearTimeout(timer)
    }
  }, [])

  if (!shown) return null
  return (
    <div className="term-nums">
      {orderedTerminals()
        .slice(0, 9)
        .map((t, i) => (
          <span
            key={t.id}
            className={`term-num${t.id === activeWidgetId ? ' term-num--on' : ''}`}
            style={
              {
                left: t.x * cam.zoom + cam.x,
                top: t.y * cam.zoom + cam.y,
                '--k': t.color ?? 'var(--accent)',
              } as React.CSSProperties
            }
          >
            ⌘{i + 1}
          </span>
        ))}
    </div>
  )
}
