// The strip along the top of focus mode, and the only bar there: a way back to
// the canvas, the focused widget's own header and controls (its title bar is
// hidden while focused and renders in here, see focusSlots.ts), and a "jack"
// for every terminal and agent on the layer, numbered like ⌘1–9, with its live
// status, then one (unnumbered) for each desktop-app mirror. A jack swaps which
// widget is focused (⇧-click puts it beside instead). One that needs you
// lights its jack, and a chip on the right takes you to it. Nothing ever
// swaps in on its own.
//
// Split: the split button (⌘\) puts another widget beside the focused one,
// its stack-mates first, so a stack's tabs can sit side by side. Each pane
// then keeps its own title bar (with a button to close that pane), and the
// dividers between panes drag to resize (FocusDividers).

import { useEffect, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { useAgents } from '../lib/agents'
import { focusWidget, orderedMirrors, orderedTerminals, splitCandidates, FOCUS_STRIP_H } from '../lib/view'
import { MAX_PANES, PANE_GAP, dragDivider, paneBoxes } from '../lib/focusPanes'
import { StatusGlyph, StatusIcon, WidgetSlotIcon } from '../widgets/widgetIcons'
import { IconBack, IconClose, IconSplit } from './icons'
import { slotRef } from './focusSlots'

export function FocusStrip() {
  const focusId = useStore((s) => s.focus?.id ?? null)
  const paneCount = useStore((s) => s.focus?.panes.length ?? 0)
  const [menu, setMenu] = useState(false)
  // after focus ends the strip fades out while the widget flies home
  const leavingId = useStore((s) => (s.focus && !s.focus.id ? (s.focus.returning[s.focus.returning.length - 1] ?? null) : null))
  const shownId = focusId ?? leavingId
  // re-render when widgets come, go or are renamed
  const ws = useStore(selectActive)
  // terminals keep ⌘1–9's numbering; mirrors follow, unnumbered (read-only,
  // so not in the ⌘N / cycle order you type into)
  const terms = shownId ? orderedTerminals() : []
  const mirrors = shownId ? orderedMirrors() : []
  const numbered = Math.min(9, terms.length)
  const jacks = [...terms.slice(0, numbered), ...mirrors]
  const all = [...terms, ...mirrors]
  const allIds = all.map((t) => t.id)
  const waiting = useAgents((s) => allIds.filter((id) => id !== focusId && s.status[id] === 'waiting').join(','))
  if (!shownId) return null
  const el = ws.elements.find((e) => e.id === shownId)
  if (!el || el.type !== 'widget') return null
  const waitingIds = waiting ? waiting.split(',') : []
  const exit = () => useStore.getState().exitFocus()

  return (
    <div
      className={`focus-strip${focusId ? '' : ' focus-strip--leaving'}`}
      style={{ height: FOCUS_STRIP_H }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="focus-strip__back" title="Back to canvas (⌘⇧↵ or Esc)" onClick={exit}>
        <IconBack />
        Canvas
      </button>
      <span className="focus-strip__sep" />
      {/* the focused widget's own header and tools render into these (focusSlots.ts) */}
      <div className="focus-strip__title" ref={slotRef('title')} />
      <div className="focus-strip__tools" ref={slotRef('tools')} />
      <div className="focus-strip__jacks">
        {jacks.map((t, i) => (
          <button
            key={t.id}
            className={`focus-jack${t.id === focusId ? ' focus-jack--on' : ''}${
              waitingIds.includes(t.id) ? ' focus-jack--attn' : ''
            }${i >= numbered ? ' focus-jack--mirror' : ''}`}
            title={i < numbered ? `${t.title} (⌘${i + 1})` : `${t.title} (Claude app session)`}
            onClick={(e) =>
              e.shiftKey && t.id !== focusId ? useStore.getState().splitFocus(t.id) : focusWidget(t.id)
            }
          >
            {i < numbered && <span className="focus-jack__n">{i + 1}</span>}
            <StatusIcon id={t.id} kind={t.kind} />
            <span className="focus-jack__t">{t.title}</span>
          </button>
        ))}
      </div>
      {waitingIds.length > 0 && (
        <button className="focus-strip__attn" onClick={() => focusWidget(waitingIds[0])}>
          <StatusGlyph status="waiting" />
          {waitingIds.length === 1
            ? `${all.find((t) => t.id === waitingIds[0])?.title ?? 'an agent'} needs you`
            : `${waitingIds.length} need you`}
        </button>
      )}
      <div className="focus-strip__actions" ref={slotRef('actions')} />
      {focusId && paneCount < MAX_PANES && (
        <span className="focus-strip__split-wrap">
          <button
            className={`focus-strip__exit${menu ? ' focus-strip__exit--on' : ''}`}
            title="Split: put another widget beside this one (⌘\)"
            onClick={() => setMenu((m) => !m)}
          >
            <IconSplit />
          </button>
          {menu && <SplitMenu onClose={() => setMenu(false)} />}
        </span>
      )}
      <button className="focus-strip__exit" title="Back to canvas (Esc)" onClick={exit}>
        <IconClose />
      </button>
    </div>
  )
}

/** The split button's list: what can go beside the focused widget. */
function SplitMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const list = splitCandidates()
  const stackId = useStore((s) => {
    const cur = selectActive(s).elements.find((e) => e.id === s.focus?.id)
    return cur?.type === 'widget' ? cur.stackId : undefined
  })
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return (
    <div className="split-menu" ref={ref}>
      <div className="split-menu__head">Put beside</div>
      {list.length === 0 && <div className="split-menu__empty">Nothing else on this layer</div>}
      {list.slice(0, 12).map((w) => (
        <button
          key={w.id}
          className="split-menu__item"
          onClick={() => {
            onClose()
            useStore.getState().splitFocus(w.id)
          }}
        >
          <span className="split-menu__icon">
            <WidgetSlotIcon el={w} />
          </span>
          <span className="split-menu__t">{w.title}</span>
          {stackId && w.stackId === stackId && <span className="split-menu__tag">tab</span>}
        </button>
      ))}
    </div>
  )
}

/** The draggable gaps between split panes (screen space, over the canvas). */
export function FocusDividers() {
  const focus = useStore((s) => (s.focus?.id && s.focus.panes.length > 1 ? s.focus : null))
  if (!focus) return null
  const boxes = paneBoxes(focus.box, focus.sizes)
  return (
    <>
      {boxes.slice(0, -1).map((b, i) => (
        <div
          key={i}
          className="pane-divider"
          style={{ left: b.x + b.w, top: b.y, width: PANE_GAP, height: b.h }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            const el = e.currentTarget
            el.setPointerCapture(e.pointerId)
            el.classList.add('pane-divider--drag')
            const x0 = e.clientX
            const start = focus.sizes
            const move = (ev: PointerEvent) =>
              useStore.getState().setPaneSizes(dragDivider(start, i, ev.clientX - x0, focus.box.w))
            const up = () => {
              el.classList.remove('pane-divider--drag')
              el.removeEventListener('pointermove', move)
              el.removeEventListener('pointerup', up)
              el.removeEventListener('pointercancel', up)
            }
            el.addEventListener('pointermove', move)
            el.addEventListener('pointerup', up)
            el.addEventListener('pointercancel', up)
          }}
          onDoubleClick={() => useStore.getState().setPaneSizes(focus.sizes.map(() => 1 / focus.sizes.length))}
        />
      ))}
    </>
  )
}
