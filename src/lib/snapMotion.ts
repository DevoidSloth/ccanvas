// Spring motion for snap-to-stack. While a widget is dragged over another, its
// stored position keeps following the pointer; what you see is a visual offset
// on top of that, driven here frame by frame:
//   • snapped  → the widget springs onto the target's box (one small overshoot)
//               and leans a little toward the pointer (SNAP_HOLD)
//   • released → it springs back to its own box (after a drop, that box *is*
//               the stack's, so it just settles)
// Nothing here touches the store, so a drop elsewhere needs no undo. Live
// widgets (terminals, agents, VS Code, web) are scaled, never resized, so xterm
// doesn't reflow mid-drag; the real resize happens once, when the stack forms.

import { useStore, selectActive } from '../store/workspace'
import type { WidgetElement } from './types'
import { SNAP_HOLD } from './stacks'

type Rect = { x: number; y: number; w: number; h: number }

const SNAP = { k: 380, zeta: 0.72 }
const RELEASE = { k: 700, zeta: 0.9 }

let id: string | null = null
let vis: Rect | null = null
let vel: Rect = { x: 0, y: 0, w: 0, h: 0 }
let raf = 0
let last = 0

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Kinds whose content would reflow (or reload) if their box changed size. */
const isLive = (w: WidgetElement) =>
  w.kind === 'terminal' ||
  w.kind === 'agent' ||
  w.kind === 'vscode' ||
  w.kind === 'web' ||
  w.kind === 'claude' ||
  w.kind === 'video'

const nodeOf = (wid: string) =>
  document.querySelector<HTMLElement>(`.widget[data-widget-id="${CSS.escape(wid)}"]`)

/** Start (or keep) animating this widget. Safe to call every pointer move. */
export function trackSnap(widgetId: string) {
  if (id === widgetId && raf) return
  if (id && id !== widgetId) clearNode(id)
  id = widgetId
  vis = null
  vel = { x: 0, y: 0, w: 0, h: 0 }
  last = performance.now()
  if (!raf) raf = requestAnimationFrame(tick)
}

function clearNode(wid: string) {
  const node = nodeOf(wid)
  if (!node) return
  node.style.transform = ''
  node.style.transformOrigin = ''
  const el = selectActive(useStore.getState()).elements.find((e) => e.id === wid)
  if (el && el.type === 'widget') node.style.height = `${el.h}px`
}

function stop() {
  if (id) clearNode(id)
  id = null
  vis = null
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function tick(now: number) {
  raf = 0
  if (!id) return
  const st = useStore.getState()
  const els = selectActive(st).elements
  const el = els.find((e) => e.id === id)
  const node = nodeOf(id)
  if (!el || el.type !== 'widget' || !node) return stop()

  const base: Rect = { x: el.x, y: el.y, w: el.w, h: el.h }
  const drop = st.stackDrop
  const target =
    drop?.phase === 'snap' && drop.sourceIds[0] === id
      ? els.find((e) => e.id === drop.targetId)
      : undefined
  const snapped = !!target && target.type === 'widget'
  const goal: Rect =
    snapped && target.type === 'widget'
      ? {
          x: target.x + (base.x - target.x) * SNAP_HOLD,
          y: target.y + (base.y - target.y) * SNAP_HOLD,
          w: target.w,
          h: target.h,
        }
      : base

  if (!vis) vis = { ...base }
  if (reduceMotion()) {
    vis = { ...goal }
  } else {
    const { k, zeta } = snapped ? SNAP : RELEASE
    const c = 2 * zeta * Math.sqrt(k)
    const dt = Math.min(0.034, (now - last) / 1000)
    const steps = 4
    for (let i = 0; i < steps; i++) {
      const h = dt / steps
      for (const p of ['x', 'y', 'w', 'h'] as const) {
        const a = -k * (vis[p] - goal[p]) - c * vel[p]
        vel[p] += a * h
        vis[p] += vel[p] * h
      }
    }
  }
  last = now

  // settled back on its own box and nothing is pulling it → done
  const still =
    Math.abs(vis.x - base.x) < 0.3 &&
    Math.abs(vis.y - base.y) < 0.3 &&
    Math.abs(vis.w - base.w) < 0.3 &&
    Math.abs(vis.h - base.h) < 0.3 &&
    Math.hypot(vel.x, vel.y, vel.w, vel.h) < 2
  if (!snapped && !drop && still) return stop()

  // live widgets keep their size and are scaled to fit inside the goal box;
  // the rest take the goal's height outright (their content just re-flows)
  const live = isLive(el)
  const sx = vis.w / base.w
  const s = live ? Math.min(sx, vis.h / base.h) : sx
  node.style.transformOrigin = '0 0'
  node.style.transform = `translate(${vis.x - base.x}px, ${vis.y - base.y}px) scale(${s})`
  node.style.height = live ? `${base.h}px` : `${vis.h / s}px`
  raf = requestAnimationFrame(tick)
}
