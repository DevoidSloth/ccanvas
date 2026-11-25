// Dragging a card in a stack's spread view.
//
// A click on a card focuses it. A drag picks it up: the card follows the
// pointer and the others slide to show where it would go. Drag it well off the
// grid and it turns into a pull-out: it lifts off (shrinks a little), the rest
// close up and the board brightens; let go there and the widget leaves the
// stack, landing on the canvas under the pointer at its own size, while the
// spread closes. Drag it back over the grid first and it is a reorder again.
//
// The slots are measured once, at the start; until the card is let go the new
// order is only a preview in the store (`spread.drag`), so no card ever moves
// under the pointer mid-drag. The geometry lives in lib/spreadDrag.ts.
//
// Motion is transforms only: the dragged card's `translate` and `scale` are set
// here each frame, the others ride their CSS transform transition, and the
// landing is a FLIP from the card to the widget's spot on the canvas.

import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { spreadRects, stacksOf, type Stack } from '../lib/stacks'
import {
  PULL_SCALE,
  boundsOf,
  dropOrigin,
  isPulling,
  moveTo,
  targetSlot,
  type Pt,
} from '../lib/spreadDrag'

/** true while a spread card is being dragged (hover shouldn't move the highlight) */
let active = false
export const isSpreadDragging = () => active

export type CardPhase = 'idle' | 'drag' | 'pull' | 'settle'

const PHASE_CLASS: Record<CardPhase, string> = {
  idle: '',
  drag: ' widget--spread-drag',
  pull: ' widget--spread-drag widget--spread-pull',
  settle: ' widget--spread-settle',
}
const ALL_CLASSES = ['widget--spread-drag', 'widget--spread-pull', 'widget--spread-settle']

/** matches the spread's CSS transition */
const SETTLE_MS = 340
const LAND_MS = 340
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Animate `node` from the screen rect it had (`from`) to where it is now. */
function flipFrom(node: HTMLElement, from: DOMRect, zoom: number, z: number) {
  if (reduceMotion() || typeof node.animate !== 'function') return
  const to = node.getBoundingClientRect()
  if (!to.width || !to.height || !from.width || !from.height) return
  const dx = (from.left - to.left) / zoom
  const dy = (from.top - to.top) / zoom
  const sx = from.width / to.width
  const sy = from.height / to.height
  node.animate(
    [
      { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, zIndex: z },
      { transformOrigin: '0 0', transform: 'none', zIndex: z },
    ],
    { duration: LAND_MS, easing: EASE },
  )
}

const widgetNode = (id: string) =>
  document.querySelector<HTMLElement>(`.widget[data-widget-id="${CSS.escape(id)}"]`)

export function useSpreadCardDrag(
  el: WidgetElement,
  stack: Stack | undefined,
  card: { tx: number; ty: number; k: number; closing: boolean } | undefined,
  nodeRef: React.RefObject<HTMLDivElement>,
  onClick: () => void,
) {
  const [phase, setPhase] = useState<CardPhase>('idle')
  const cardRef = useRef(card)
  cardRef.current = card
  const settleTimer = useRef(0)

  const onCardDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0 || !stack) return
    const node = nodeRef.current
    const c0 = cardRef.current
    const root = node?.closest('.canvas') as HTMLElement | null
    if (!node || !c0 || !root || c0.closing) return
    const st0 = useStore.getState()
    const ws0 = selectActive(st0)
    const live = stacksOf(ws0.elements).get(stack.id)
    const me = live?.members.find((m) => m.id === el.id)
    if (!live || !me) return
    const ids = live.members.map((m) => m.id)
    const from = ids.indexOf(el.id)
    const cam = ws0.camera
    const zoom = cam.zoom
    const rootBox = root.getBoundingClientRect()
    // the spread's slots (canvas-local screen px), fixed for the whole drag
    const slots = spreadRects(ids.length, root.clientWidth, root.clientHeight, live.front.w / Math.max(1, live.front.h))
    const grid = boundsOf(slots)
    // the point you hold the card by, in the widget's own px
    const r0 = node.getBoundingClientRect()
    const perPx = r0.width / me.w || 1
    const grab: Pt = { x: (e.clientX - r0.left) / perPx, y: (e.clientY - r0.top) / perPx }
    const k = c0.k
    const base = { x: me.x + c0.tx, y: me.y + c0.ty } // the card's own slot, world
    const target = e.currentTarget as HTMLElement
    const pointerId = e.pointerId
    const start = { x: e.clientX, y: e.clientY }

    let started = false
    let ptr = start
    let to: number | null = from
    let pulling = false
    let s = 1
    let raf = 0
    let last = 0
    let unsub: (() => void) | null = null

    const local = (): Pt => ({ x: ptr.x - rootBox.left, y: ptr.y - rootBox.top })
    const world = (): Pt => {
      const p = local()
      return { x: (p.x - cam.x) / zoom, y: (p.y - cam.y) / zoom }
    }

    // where the pointer says the card is going: a slot, or out of the stack
    const evaluate = () => {
      const p = local()
      const kz = k * zoom
      const rect = { x: p.x - grab.x * kz, y: p.y - grab.y * kz, w: me.w * kz, h: me.h * kz }
      const pull = isPulling(rect, p, grid, pulling)
      if (pull !== pulling) {
        pulling = pull
        node.classList.toggle('widget--spread-pull', pull)
        setPhase(pull ? 'pull' : 'drag')
      }
      const next = pulling ? null : targetSlot(slots, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, to)
      if (next !== to) {
        to = next
        useStore.getState().setSpreadDrag({ id: el.id, to })
      }
    }

    // keep the held point under the pointer, at the card's current lift
    const paint = (now: number) => {
      const goal = pulling ? PULL_SCALE : 1
      if (reduceMotion()) s = goal
      else s += (goal - s) * (1 - Math.exp(-Math.min(50, now - last) / 70))
      if (Math.abs(goal - s) < 0.002) s = goal
      last = now
      const P = world()
      const tx = P.x - base.x - s * k * grab.x
      const ty = P.y - base.y - s * k * grab.y
      node.style.translate = `${tx}px ${ty}px`
      node.style.scale = s === 1 ? '' : String(s)
      return s !== goal
    }

    const frame = (now: number) => {
      raf = 0
      evaluate()
      if (paint(now)) raf = requestAnimationFrame(frame)
    }

    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      unsub?.()
      unsub = null
      active = false
      try {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
      } catch {
        /* the node may be gone */
      }
    }

    const clearInline = () => {
      node.style.translate = ''
      node.style.scale = ''
    }

    // the spread closed under us (Escape, undo, a layer switch): just let go
    const abort = () => {
      detach()
      node.classList.remove(...ALL_CLASSES)
      clearInline()
      setPhase('idle')
      useStore.getState().setSpreadDrag(null)
    }

    // back into a slot (maybe a new one): commit the order, glide home
    const settle = () => {
      node.classList.remove('widget--spread-drag', 'widget--spread-pull')
      node.classList.add('widget--spread-settle')
      flushSync(() => {
        setPhase('settle')
        const st = useStore.getState()
        if (to != null && to !== from) {
          st.beginHistory()
          st.reorderStack(stack.id, moveTo(ids, el.id, to))
          st.setSpreadHi(to)
        }
        st.setSpreadDrag(null)
      })
      // the slot's transform and this offset change in the same frame and
      // share one transition, so the card glides in a straight line
      clearInline()
      window.clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(
        () => setPhase((p) => (p === 'settle' ? 'idle' : p)),
        reduceMotion() ? 0 : SETTLE_MS,
      )
    }

    // out of the stack: land on the canvas under the pointer, close the spread
    const land = () => {
      const st = useStore.getState()
      const own = me.stackRestore ?? { w: me.w, h: me.h }
      const at = dropOrigin(world(), grab, { w: me.w, h: me.h }, own)
      const fromRect = node.getBoundingClientRect()
      const others = ids
        .filter((id) => id !== el.id)
        .map((id) => {
          const n = widgetNode(id)
          return n ? { n, r: n.getBoundingClientRect() } : null
        })
        .filter((o): o is { n: HTMLElement; r: DOMRect } => !!o)
      node.classList.remove(...ALL_CLASSES)
      flushSync(() => {
        setPhase('idle')
        st.setSpreadDrag(null)
        st.beginHistory()
        st.unstackWidget(el.id, at)
        st.closeSpread(null)
        st.setSelection([el.id])
      })
      clearInline()
      flipFrom(node, fromRect, zoom, 10450)
      // a stack of two dissolves at once: the one left behind has no spread
      // transition to ride home on, so it gets a flight of its own
      for (const o of others) if (!o.n.classList.contains('widget--spread')) flipFrom(o.n, o.r, zoom, 10300)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      ptr = { x: ev.clientX, y: ev.clientY }
      if (!started) {
        if (Math.hypot(ptr.x - start.x, ptr.y - start.y) < 5) return
        started = true
        active = true
        window.clearTimeout(settleTimer.current)
        // class set before React's next render, then kept by it
        node.classList.remove('widget--spread-settle')
        node.classList.add('widget--spread-drag')
        setPhase('drag')
        try {
          target.setPointerCapture(pointerId)
        } catch {
          /* not capturable: window listeners still follow it */
        }
        const st = useStore.getState()
        st.setSpreadHi(from)
        st.setSpreadDrag({ id: el.id, to })
        unsub = useStore.subscribe((s2) => {
          const sp = s2.spread
          if (!sp || sp.stackId !== stack.id || sp.closing) abort()
        })
        last = performance.now()
      }
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      detach()
      if (!started) {
        if (ev.type === 'pointerup') onClick()
        return
      }
      ptr = { x: ev.clientX, y: ev.clientY }
      if (ev.type === 'pointercancel') {
        to = from
        pulling = false
      } else evaluate()
      if (pulling) land()
      else settle()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return { onCardDown, phase, cardClass: card ? PHASE_CLASS[phase] : '' }
}
