// The tab rail that replaces the front widget's title bar when it sits in a
// stack, plus the offset "depth edges" drawn behind a stack. See lib/stacks.ts.

import { useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, useDisplayStatus } from '../lib/agents'
import { stacksOf, type Stack } from '../lib/stacks'
import { IconStack, IconSpread, IconFocus, IconUnfocus, IconMinus } from '../ui/icons'
import { toggleFocus } from '../lib/view'
import { WidgetSlotIcon } from './widgetIcons'

const accentOf = (w: WidgetElement) =>
  w.color ?? (w.kind === 'terminal' || w.kind === 'agent' ? 'var(--accent)' : WIDGET_ACCENT[w.kind])

/** Focus / back-to-canvas for a stack's front (the spread is off while focused). */
function StackRailFocus({ stack }: { stack: Stack }) {
  const focused = useStore((s) => s.focus?.id === stack.front.id)
  return (
    <button
      className={`stack-rail__spread${focused ? ' stack-rail__spread--on' : ''}`}
      title={focused ? 'Back to canvas (⌘⇧↵)' : 'Focus (⌘⇧↵)'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => toggleFocus(stack.front.id)}
    >
      {focused ? <IconUnfocus /> : <IconFocus />}
    </button>
  )
}

/** Stop typing into any member of this stack: drop it as the active widget and
 *  take keyboard focus out of its terminal/editor. */
function leaveWidgetFocus(stack: Stack) {
  const st = useStore.getState()
  if (st.activeWidgetId && stack.members.some((m) => m.id === st.activeWidgetId)) st.setActiveWidget(null)
  const focused = document.activeElement as HTMLElement | null
  if (focused?.closest('.widget')) focused.blur()
}

/** How many of these widgets are waiting on the user right now. */
function useWaitingCount(ids: string[]): number {
  return useAgents((s) => ids.reduce((n, id) => n + (s.status[id] === 'waiting' ? 1 : 0), 0))
}

export function StackRail({
  stack,
  onGrab,
  ghostIds,
}: {
  stack: Stack
  /** start a move of the stack (the front widget's title-bar grab) */
  onGrab: (e: React.PointerEvent) => void
  /** snap preview: tabs that will join when the drag is released (drawn dashed) */
  ghostIds?: string[]
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(stack.title)

  const commit = () => {
    if (name.trim() && name.trim() !== stack.title) useStore.getState().renameStack(stack.id, name)
    setRenaming(false)
  }

  return (
    <div
      ref={railRef}
      className="widget__bar stack-rail"
      onPointerDown={(e) => {
        // the rail selects the stack: clicking it stops typing into the front
        // widget, so Space spreads the stack instead of landing in a terminal
        leaveWidgetFocus(stack)
        onGrab(e)
      }}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('.stack-rail__tab, .stack-rail__name, button, input')) return
        useStore.getState().openSpread(stack.id)
      }}
    >
      <span
        className="stack-rail__name"
        title="Double-click to rename the stack"
        onDoubleClick={(e) => {
          e.stopPropagation()
          setName(stack.title)
          setRenaming(true)
        }}
      >
        <span className="stack-rail__icon">
          <IconStack />
        </span>
        {renaming ? (
          <input
            className="stack-rail__input"
            autoFocus
            value={name}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="stack-rail__title">{stack.title}</span>
        )}
        <span className="stack-rail__count">{stack.members.length}</span>
      </span>
      <div className="stack-rail__tabs">
        {stack.members.map((m) => (
          <StackTab
            key={m.id}
            m={m}
            stack={stack}
            front={!ghostIds && m.id === stack.front.id}
            ghost={!!ghostIds?.includes(m.id)}
            railRef={railRef}
          />
        ))}
      </div>
      <StackRailFocus stack={stack} />
      <button
        className="stack-rail__spread"
        title="Spread the stack (Space)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useStore.getState().openSpread(stack.id)}
      >
        <IconSpread />
      </button>
      <button
        className="stack-rail__spread"
        title={stack.front.minimized ? 'Restore' : 'Minimize to the title bar'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useStore.getState().toggleMinimized(stack.front.id)}
      >
        <IconMinus />
      </button>
    </div>
  )
}

function StackTab({
  m,
  stack,
  front,
  ghost = false,
  railRef,
}: {
  m: WidgetElement
  stack: Stack
  front: boolean
  /** previewed while snapping: joins the stack on release */
  ghost?: boolean
  railRef: React.RefObject<HTMLDivElement>
}) {
  const status = useDisplayStatus(m.id)
  const attn = !front && status === 'waiting'

  // click → bring to front; drag sideways → reorder; drag off the rail → pull
  // the widget out and keep dragging it
  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const start = { x: e.clientX, y: e.clientY }
    let mode: 'click' | 'reorder' | 'tear' = 'click'
    let last = start
    let began = false
    const history = () => {
      if (!began) useStore.getState().beginHistory()
      began = true
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      if (mode === 'click' && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return
      const s = useStore.getState()
      if (mode === 'tear') {
        const z = selectActive(s).camera.zoom
        s.moveSelection((ev.clientX - last.x) / z, (ev.clientY - last.y) / z)
        last = { x: ev.clientX, y: ev.clientY }
        return
      }
      const rail = railRef.current
      if (!rail) return
      const r = rail.getBoundingClientRect()
      if (ev.clientY < r.top - 24 || ev.clientY > r.bottom + 24) {
        // torn off: out of the stack, under the pointer at its own size
        const z = selectActive(s).camera.zoom
        const wx = stack.front.x + (ev.clientX - r.left) / z
        const wy = stack.front.y + (ev.clientY - r.top) / z
        const ownW = m.stackRestore?.w ?? m.w
        history()
        s.unstackWidget(m.id, { x: wx - Math.min(120, ownW / 2), y: wy - 14 })
        s.setSelection([m.id])
        s.setActiveWidget(null)
        mode = 'tear'
        last = { x: ev.clientX, y: ev.clientY }
        document.body.classList.add('is-panning')
        return
      }
      mode = 'reorder'
      const tabs = [...rail.querySelectorAll<HTMLElement>('.stack-rail__tab')]
      let idx = tabs.findIndex((t) => {
        const b = t.getBoundingClientRect()
        return ev.clientX < b.left + b.width / 2
      })
      if (idx < 0) idx = tabs.length
      const ids = stacksOf(selectActive(s).elements).get(stack.id)?.members.map((x) => x.id)
      if (!ids) return
      const cur = ids.indexOf(m.id)
      if (idx > cur) idx -= 1
      if (cur < 0 || idx === cur) return
      history()
      ids.splice(cur, 1)
      ids.splice(idx, 0, m.id)
      s.reorderStack(stack.id, ids)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-panning')
      if (mode === 'click' && ev.type === 'pointerup') {
        const s = useStore.getState()
        leaveWidgetFocus(stack)
        s.setActiveWidget(null)
        s.setSelection([m.id])
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      className={`stack-rail__tab${front ? ' stack-rail__tab--front' : ''}${attn ? ' stack-rail__tab--attn' : ''}${
        ghost ? ' stack-rail__tab--ghost' : ''
      }`}
      style={{ '--k': accentOf(m) } as React.CSSProperties}
      title={m.title}
      onPointerDown={onPointerDown}
    >
      <span className="stack-rail__tab-icon"><WidgetSlotIcon el={m} /></span>
      <span className="stack-rail__tab-title">{m.title}</span>
    </div>
  )
}

/** Offset edges behind a stack's front widget; amber when a hidden member needs you. */
export function StackEdges({ el, stack }: { el: WidgetElement; stack: Stack }) {
  const hiddenIds = stack.members.filter((m) => m.id !== stack.front.id).map((m) => m.id)
  const attn = useWaitingCount(hiddenIds) > 0
  return (
    <div
      className={`stack-edges${attn ? ' stack-edges--attn' : ''}`}
      // same z as the front widget, and drawn just before it, so the edges
      // sit right under it and above whatever lies lower
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, zIndex: el.z }}
    >
      {stack.members.length > 2 && <div className="stack-edges__e stack-edges__e2" />}
      <div className="stack-edges__e stack-edges__e1" />
    </div>
  )
}
