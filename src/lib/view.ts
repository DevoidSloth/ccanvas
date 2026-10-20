// Viewport + terminal navigation helpers shared by the chrome, the keyboard
// shortcuts, and the canvas. The canvas fills `.app__main`, so its size is
// read from the DOM instead of hard-coding the chrome height everywhere.

import { useStore, selectActive } from '../store/workspace'
import { clamp } from './geometry'
import type { CanvasElement, WidgetElement } from './types'

/** Below this zoom, terminals render as readable summary cards. */
export const FAR_ZOOM = 0.5

/** Size of the canvas area in px (the window minus the slim top bar). */
export function viewport(): { vw: number; vh: number } {
  const main = typeof document !== 'undefined' ? document.querySelector('.app__main') : null
  if (main) return { vw: main.clientWidth, vh: main.clientHeight }
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280
  const h = typeof window !== 'undefined' ? window.innerHeight - 38 : 720
  return { vw: w, vh: h }
}

/** Centre of the canvas area, in canvas-local screen px. */
export function viewCenter(): { x: number; y: number } {
  const { vw, vh } = viewport()
  return { x: vw / 2, y: vh / 2 }
}

export const isTermWidget = (e: CanvasElement): e is WidgetElement =>
  e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent')

/** Does a widget pass the active label filter? (no filter → everything does) */
export function passesLabelFilter(el: WidgetElement, filter: string[] | null): boolean {
  if (!filter || filter.length === 0) return true
  return filter.includes((el.color ?? '').toLowerCase())
}

/**
 * The active tab's terminals + agents in reading order (rows top→bottom, then
 * left→right). Widgets whose vertical centres sit within half a height of a
 * row's first member count as the same row. Respects the label filter.
 */
export function orderedTerminals(): WidgetElement[] {
  const st = useStore.getState()
  const terms = selectActive(st)
    .elements.filter(isTermWidget)
    .filter((t) => passesLabelFilter(t, st.labelFilter))
  const byY = [...terms].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
  const rows: WidgetElement[][] = []
  for (const t of byY) {
    const row = rows[rows.length - 1]
    const cy = t.y + t.h / 2
    if (row && Math.abs(cy - (row[0].y + row[0].h / 2)) < Math.min(row[0].h, t.h) / 2) row.push(t)
    else rows.push([t])
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x))
}

/**
 * Bring a widget into view and click into it. The camera only moves when it
 * has to: a widget that's already fully on screen at a readable zoom stays put;
 * otherwise it's centred, zooming in (up to 100%) far enough to fit.
 */
export function focusWidget(id: string) {
  const st = useStore.getState()
  const el = selectActive(st).elements.find((e) => e.id === id)
  if (!el || el.type !== 'widget') return
  const cam = selectActive(st).camera
  const { vw, vh } = viewport()
  const pad = 48
  const left = el.x * cam.zoom + cam.x
  const top = el.y * cam.zoom + cam.y
  const onScreen =
    left >= 0 &&
    top >= 0 &&
    left + el.w * cam.zoom <= vw &&
    top + el.h * cam.zoom <= vh
  if (!onScreen || cam.zoom < FAR_ZOOM) {
    const fit = Math.min((vw - pad * 2) / el.w, (vh - pad * 2) / el.h)
    const zoom = clamp(cam.zoom < FAR_ZOOM ? Math.min(1, fit) : Math.min(cam.zoom, fit), 0.1, 1)
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    st.setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
  }
  st.setSelection([id])
  st.bringToFront([id])
  st.setActiveWidget(id)
}

/** Step the active terminal forward/back through reading order (wraps). */
export function cycleTerminal(dir: 1 | -1) {
  const list = orderedTerminals()
  if (!list.length) return
  const st = useStore.getState()
  const cur = list.findIndex((t) => t.id === (st.activeWidgetId ?? st.selection[0]))
  const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length
  focusWidget(list[next].id)
}

/** Leave the terminal you're typing in (keystrokes stop going to it). */
export function exitTerminal() {
  const st = useStore.getState()
  st.setActiveWidget(null)
  ;(document.activeElement as HTMLElement | null)?.blur?.()
}
