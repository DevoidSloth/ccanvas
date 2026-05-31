import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { boundsOfMany, elementBounds, screenToWorld } from '../lib/geometry'
import { WIDGET_ACCENT } from '../lib/types'

// Overview map of the whole canvas with the current viewport outlined.
// Click anywhere to recenter the camera there.

const CHROME_H = 82
const MAP_W = 184
const MAP_H = 132
const PAD = 8

export function Minimap() {
  const ws = useStore(selectActive)
  const setCamera = useStore((s) => s.setCamera)
  const [collapsed, setCollapsed] = useState(false)

  const world = boundsOfMany(ws.elements)
  if (!world || ws.elements.length === 0) return null

  // viewport rectangle in world coords
  const cam = ws.camera
  const vw = window.innerWidth
  const vh = window.innerHeight - CHROME_H
  const tl = screenToWorld({ x: 0, y: 0 }, cam)
  const br = screenToWorld({ x: vw, y: vh }, cam)
  const view = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }

  // union of content + viewport so the viewport box is always visible
  const minX = Math.min(world.x, view.x)
  const minY = Math.min(world.y, view.y)
  const maxX = Math.max(world.x + world.w, view.x + view.w)
  const maxY = Math.max(world.y + world.h, view.y + view.h)
  const span = { x: minX, y: minY, w: maxX - minX || 1, h: maxY - minY || 1 }

  const scale = Math.min((MAP_W - PAD * 2) / span.w, (MAP_H - PAD * 2) / span.h)
  const toMap = (wx: number, wy: number) => ({
    x: PAD + (wx - span.x) * scale,
    y: PAD + (wy - span.y) * scale,
  })

  const navigate = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const wx = span.x + (mx - PAD) / scale
    const wy = span.y + (my - PAD) / scale
    setCamera({ zoom: cam.zoom, x: vw / 2 - wx * cam.zoom, y: vh / 2 - wy * cam.zoom })
  }

  if (collapsed) {
    return (
      <button className="minimap__toggle" title="Show minimap" onClick={() => setCollapsed(false)}>
        map
      </button>
    )
  }

  const vp = toMap(view.x, view.y)
  return (
    <div className="minimap">
      <div className="minimap__head">
        <span>map</span>
        <button className="minimap__btn" title="Hide" onClick={() => setCollapsed(true)}>
          ×
        </button>
      </div>
      <div
        className="minimap__canvas"
        style={{ width: MAP_W, height: MAP_H }}
        onPointerDown={navigate}
      >
        {ws.elements.map((el) => {
          const b = elementBounds(el)
          const p = toMap(b.x, b.y)
          const color =
            el.type === 'widget'
              ? WIDGET_ACCENT[el.kind]
              : el.type === 'frame'
                ? '#61605b'
                : el.type === 'image'
                  ? '#7fc7c0'
                  : '#4a4d57'
          return (
            <div
              key={el.id}
              className="minimap__el"
              style={{
                left: p.x,
                top: p.y,
                width: Math.max(2, b.w * scale),
                height: Math.max(2, b.h * scale),
                background: color,
              }}
            />
          )
        })}
        <div
          className="minimap__view"
          style={{
            left: vp.x,
            top: vp.y,
            width: Math.max(4, view.w * scale),
            height: Math.max(4, view.h * scale),
          }}
        />
      </div>
    </div>
  )
}
