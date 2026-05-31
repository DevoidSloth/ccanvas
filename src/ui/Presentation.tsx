import { useEffect, useMemo, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { clamp } from '../lib/geometry'
import type { FrameElement } from '../lib/types'

// Presentation mode: step through the canvas's frames like slides, zooming the
// camera to each. Arrow keys / space navigate; Esc exits.

const CHROME_H = 82

export function Presentation() {
  const presenting = useStore((s) => s.presenting)
  const setPresenting = useStore((s) => s.setPresenting)
  const setCamera = useStore((s) => s.setCamera)
  const ws = useStore(selectActive)
  const [i, setI] = useState(0)

  const frames = useMemo(
    () =>
      ws.elements
        .filter((e): e is FrameElement => e.type === 'frame')
        .sort((a, b) => a.y - b.y || a.x - b.x),
    [ws.elements],
  )

  useEffect(() => {
    if (presenting) setI(0)
  }, [presenting])

  // zoom the camera to the current frame
  useEffect(() => {
    if (!presenting || !frames.length) return
    const f = frames[Math.min(i, frames.length - 1)]
    const pad = 70
    const vw = window.innerWidth
    const vh = window.innerHeight - CHROME_H
    const zoom = clamp(Math.min(vw / (f.w + pad * 2), vh / (f.h + pad * 2)), 0.1, 2)
    const cx = f.x + f.w / 2
    const cy = f.y + f.h / 2
    setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
  }, [presenting, i, frames, setCamera])

  useEffect(() => {
    if (!presenting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        setI((x) => Math.min(frames.length - 1, x + 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setI((x) => Math.max(0, x - 1))
      } else if (e.key === 'Escape') {
        setPresenting(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [presenting, frames.length, setPresenting])

  if (!presenting) return null
  if (!frames.length) {
    return (
      <div className="present">
        <span>no frames to present — draw a frame (F) first</span>
        <button className="present__btn" onClick={() => setPresenting(false)}>
          exit
        </button>
      </div>
    )
  }
  const idx = Math.min(i, frames.length - 1)
  return (
    <div className="present">
      <button
        className="present__btn"
        onClick={() => setI((x) => Math.max(0, x - 1))}
        disabled={idx === 0}
      >
        ‹
      </button>
      <span className="present__label">
        {idx + 1} / {frames.length} · {frames[idx].title}
      </span>
      <button
        className="present__btn"
        onClick={() => setI((x) => Math.min(frames.length - 1, x + 1))}
        disabled={idx >= frames.length - 1}
      >
        ›
      </button>
      <button className="present__btn present__btn--exit" onClick={() => setPresenting(false)}>
        exit
      </button>
    </div>
  )
}
