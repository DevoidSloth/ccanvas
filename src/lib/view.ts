// Viewport + terminal navigation helpers shared by the chrome, the keyboard
// shortcuts, and the canvas. The canvas fills `.app__main`, so its size is
// read from the DOM instead of hard-coding the chrome height everywhere.

import { useStore, selectActive, setSpreadFocusHandler } from '../store/workspace'
import { clamp } from './geometry'
import type { CanvasElement, WidgetElement } from './types'
import { activeLayerElements, activeLayerId, hasLayers, layerOf } from './layers'

/** Below this zoom, widgets render as readable status cards (well out, so a
 *  widget you can still read stays itself). */
export const FAR_ZOOM = 0.3

/** A widget as it is now. Widget bodies are not re-rendered when only their
 *  position changes, so a handler placing something beside one reads it here. */
export function livePlace(el: WidgetElement): WidgetElement {
  const cur = selectActive(useStore.getState()).elements.find((e) => e.id === el.id)
  return cur && cur.type === 'widget' ? cur : el
}

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
  // the active layer only: ⌘1–9 means "the Nth terminal I can see"
  return inReadingOrder(isTermWidget)
}

const isMirrorWidget = (e: CanvasElement): e is WidgetElement =>
  e.type === 'widget' && e.kind === 'transcript' && e.mirrorOf === 'desktop'

/** The active layer's desktop-app mirrors in reading order (label filter
 *  respected). Not part of ⌘1–9: those are for terminals you type into. */
export function orderedMirrors(): WidgetElement[] {
  return inReadingOrder(isMirrorWidget)
}

function inReadingOrder(pick: (e: CanvasElement) => e is WidgetElement): WidgetElement[] {
  const st = useStore.getState()
  const terms = activeLayerElements(selectActive(st))
    .filter(pick)
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
  // in focus mode a jump swaps which widget fills the view (same layer only;
  // a widget on another layer leaves focus and goes there)
  const f0 = useStore.getState().focus
  if (f0?.id) {
    const ws = selectActive(useStore.getState())
    const el = ws.elements.find((e) => e.id === id)
    if (el && el.type === 'widget' && layerOf(el) === activeLayerId(ws)) {
      useStore.getState().setSelection([id])
      useStore.getState().setActiveWidget(id)
      return
    }
  }
  revealLayerOf(id)
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

/**
 * If `id` sits on another layer of the active tab, switch to that layer first
 * (restoring its view). Call before computing a camera for a jump: roster,
 * search and attention clicks all land on the right layer this way.
 * Returns true if the layer changed.
 */
export function revealLayerOf(id: string): boolean {
  const st = useStore.getState()
  const ws = selectActive(st)
  if (!ws || !hasLayers(ws)) return false
  const el = ws.elements.find((e) => e.id === id)
  if (!el || layerOf(el) === activeLayerId(ws)) return false
  st.setActiveLayer(layerOf(el))
  return true
}

// picking a card in a stack's spread view focuses that widget once the
// cards have flown back
setSpreadFocusHandler((id) => focusWidget(id))

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

// ---------- focus mode ----------

/** Height of the focus strip above a focused widget, and the margins around it. */
export const FOCUS_STRIP_H = 36
const FOCUS_MARGIN = 16

/** The canvas-local screen box a focused widget fills: flush under the focus
 *  strip, which is its only bar while focused. */
export function focusBox(): { x: number; y: number; w: number; h: number } {
  const { vw, vh } = viewport()
  const top = FOCUS_MARGIN + FOCUS_STRIP_H
  return {
    x: FOCUS_MARGIN,
    y: top,
    w: Math.max(240, vw - FOCUS_MARGIN * 2),
    h: Math.max(160, vh - top - FOCUS_MARGIN),
  }
}

/** Focus the widget you're in (or the one selected), or leave focus. */
export function toggleFocus(id?: string) {
  const st = useStore.getState()
  if (st.focus?.id) {
    st.exitFocus()
    return
  }
  const target = id ?? st.activeWidgetId ?? (st.selection.length === 1 ? st.selection[0] : null)
  if (!target) return
  const el = selectActive(st).elements.find((e) => e.id === target)
  if (!el || el.type !== 'widget') return
  st.enterFocus(target, focusBox())
}

// ---------- split focus ----------

/** What can go beside the focused widget(s): the active pane's stack-mates
 *  first (in tab order), then every other widget on the layer in reading
 *  order. Nothing already in a pane. */
export function splitCandidates(): WidgetElement[] {
  const st = useStore.getState()
  const f = st.focus
  if (!f?.id) return []
  const ws = selectActive(st)
  const cur = ws.elements.find((e) => e.id === f.id)
  const stackId = cur?.type === 'widget' ? cur.stackId : undefined
  const free = (e: CanvasElement): e is WidgetElement => e.type === 'widget' && !f.panes.includes(e.id)
  const mates = stackId
    ? ws.elements
        .filter(free)
        .filter((e) => e.stackId === stackId)
        .sort((a, b) => (a.stackOrder ?? 0) - (b.stackOrder ?? 0))
    : []
  const rest = inReadingOrder((e): e is WidgetElement => free(e) && (!stackId || e.stackId !== stackId))
  return [...mates, ...rest]
}

/** ⌘\: put the next candidate beside the focused widget (its stack-mate
 *  first). Returns false when there's nothing to add. */
export function splitNext(): boolean {
  const next = splitCandidates()[0]
  if (!next) return false
  useStore.getState().splitFocus(next.id)
  return true
}
