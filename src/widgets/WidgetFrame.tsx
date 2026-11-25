import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useFocusSlot, stopCanvas } from '../ui/focusSlots'
import type { WidgetElement } from '../lib/types'
import { WIDGET_ACCENT, AGENT_COLORS, claudeColorName } from '../lib/types'
import { useShallow } from 'zustand/react/shallow'
import { useStore, selectActive, type FocusState } from '../store/workspace'
import { paneBoxes } from '../lib/focusPanes'
import { elementBounds, edgeLines, snapValue } from '../lib/geometry'
import {
  IconClose,
  IconTrash,
  IconLock,
  IconTag,
  IconSettings,
  IconPullOut,
  IconExternal,
  IconFocus,
  IconMinus,
  IconDesktop,
} from '../ui/icons'
import { flyFocus, cancelFlight } from '../lib/focusMotion'
import { toggleFocus } from '../lib/view'
import { WidgetGlyph, WidgetSlotIcon, showsStatus } from './widgetIcons'
import { useAgents, useDisplayStatus, sendTo, sendPrompt, isLive as isSessionLive, type AgentMetrics } from '../lib/agents'
import { useAgentContext } from '../lib/context'
import { useNowPlaying } from '../lib/nowplaying'
import { useSyncSessionTitle } from '../lib/sessionTitle'
import { FAR_ZOOM, focusWidget, passesLabelFilter } from '../lib/view'
import { NoteBody } from './NoteBody'
import { WebBody } from './WebBody'
import { TerminalBody } from './TerminalBody'
import { FilesBody } from './FilesBody'
import { DiffBody } from './DiffBody'
import { EditorBody } from './EditorBody'
import { VsCodeBody } from './VsCodeBody'
import { DocBody } from './DocBody'
import { LogBody } from './LogBody'
import { PrBody } from './PrBody'
import { IssuesBody } from './IssuesBody'
import { RunsBody } from './RunsBody'
import { RunnerBody } from './RunnerBody'
import { SqlBody } from './SqlBody'
import { DataBody } from './DataBody'
import { PlotBody } from './PlotBody'
import { TranscriptBody } from './TranscriptBody'
import { VideoBody } from './VideoBody'
import { MediaInfoBody } from './MediaInfoBody'
import { ClaudeBody } from './ClaudeBody'
import { NowPlayingBody } from './NowPlayingBody'
import { MirrorAsk, MirrorWaitChip } from './MirrorStatus'
import { openInClaude } from '../lib/desktopSessions'
import { WidgetErrorBoundary } from '../ui/WidgetErrorBoundary'
import { stacksOf, type Stack } from '../lib/stacks'
import { longestWord, widgetGlyph, widgetType } from '../lib/layers'
import { StackRail, StackEdges } from './StackRail'
import { useSpreadCardDrag, isSpreadDragging } from './useSpreadCardDrag'

/** Where a stack member sits while its stack is spread out (world units). */
export type SpreadCard = {
  /** translate from the member's own box to its card */
  tx: number
  ty: number
  /** uniform scale from the member's box to its card */
  k: number
  /** 0-based position in the stack */
  index: number
  /** the slot it shows in (moves while another card is dragged; shown 1-based) */
  slot: number
  /** the highlighted card */
  hi: boolean
  /** cards are flying back into the stack */
  closing: boolean
  /** this member will be the front once the spread closes */
  front: boolean
}


const MIN_W = 220
const MIN_H = 150
type Corner = 'nw' | 'ne' | 'sw' | 'se'
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

// Memoised: the canvas re-renders on every camera move, and re-rendering every
// widget body (terminals, long transcripts) per frame made pan/zoom stutter.
// Props are stable between frames: el only changes when that widget does.
export const WidgetFrame = memo(function WidgetFrame({
  el,
  selected,
  onStartMove,
  visible = true,
  tabShown = visible,
  stack,
  spreadCard,
}: {
  el: WidgetElement
  selected: boolean
  onStartMove: (e: React.PointerEvent, id: string) => void
  /** is this widget shown (its tab and its layer are the current ones)?
   *  When not, the card is hidden on its own (`widget--offlayer`) but stays
   *  mounted, so its shell or agent keeps running. */
  visible?: boolean
  /** is its tab shown? (terminals on a hidden layer of it still connect) */
  tabShown?: boolean
  /** the stack this widget sits in (only stacks of two or more) */
  stack?: Stack
  /** set while this widget's stack is spread out */
  spreadCard?: SpreadCard
}) {
  const tool = useStore((s) => s.tool)
  const activeWidgetId = useStore((s) => s.activeWidgetId)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const removeElements = useStore((s) => s.removeElements)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const openAgentWizard = useStore((s) => s.openAgentWizard)

  const setLabelingWidget = useStore((s) => s.setLabelingWidget)
  const labeling = useStore((s) => s.labelingWidgetId === el.id)
  // zoomed far out, terminals swap their unreadable text for a summary card
  const far = useStore((s) => selectActive(s).camera.zoom < FAR_ZOOM)
  const dimmed = useStore((s) => !passesLabelFilter(el, s.labelFilter))
  useSyncSessionTitle(el)

  const active = activeWidgetId === el.id
  const stackFront = !!stack && stack.front.id === el.id
  // stacked behind another member: stays mounted (live) but out of sight
  // (a member split into a focus pane of its own shows)
  const inFocusPane = useStore((s) => !!s.focus?.panes.includes(el.id))
  const stackHidden = !!stack && !stackFront && !spreadCard && !inFocusPane
  // untagged terminals/agents follow the palette's accent
  const accent =
    el.color ?? (el.kind === 'terminal' || el.kind === 'agent' ? 'var(--accent)' : WIDGET_ACCENT[el.kind])
  // terminals/agents are live: drag the block, click to enter (see pressBlock)
  const isTerminal = el.kind === 'terminal' || el.kind === 'agent'
  // zoomed far out, every widget becomes a status card
  const hasCard = true
  // a user-chosen colour tints the whole faceplate so it reads when zoomed out
  const tagged = isTerminal && !!el.color
  // app-like panels work the same way, without a shield over their content
  const isLive =
    isTerminal ||
    el.kind === 'files' ||
    el.kind === 'diff' ||
    el.kind === 'editor' ||
    el.kind === 'vscode' ||
    el.kind === 'doc' ||
    el.kind === 'log' ||
    el.kind === 'pr' ||
    el.kind === 'issues' ||
    el.kind === 'runs' ||
    el.kind === 'runner' ||
    el.kind === 'sql' ||
    el.kind === 'data' ||
    el.kind === 'plot' ||
    el.kind === 'transcript' ||
    el.kind === 'claude' ||
    el.kind === 'video' ||
    el.kind === 'mediainfo' ||
    el.kind === 'nowplaying'
  // notes are also single-click, but manage their own pointer handling
  // (toggle a checkbox vs. enter edit) so they don't use the generic capture
  const isNote = el.kind === 'note'
  // a folder means nothing to the music widget
  const folder = el.cwd && el.kind !== 'nowplaying'
    ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    : null

  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(el.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => setName(el.title), [el.title])
  useEffect(() => {
    if (renaming) {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [renaming])

  const select = () => {
    setSelection([el.id])
    bringToFront([el.id])
  }

  // Start a move. If this widget is already part of a (multi) selection, keep
  // that selection so everything drags together; shift toggles membership;
  // otherwise select just this one. Mirrors the canvas vector-drag behaviour.
  const grab = (e: React.PointerEvent) => {
    e.stopPropagation()
    // a focused widget is pinned to the view: its bar selects, never drags
    if (useStore.getState().focus?.panes.includes(el.id)) {
      useStore.getState().swapFocus(el.id)
      setSelection([el.id])
      return
    }
    const cur = useStore.getState().selection
    if (e.shiftKey) {
      setSelection(cur.includes(el.id) ? cur.filter((x) => x !== el.id) : [...cur, el.id])
    } else if (!cur.includes(el.id)) {
      setSelection([el.id])
    }
    bringToFront([el.id])
    // grabbing another widget's title bar counts as clicking out of a terminal
    if (useStore.getState().activeWidgetId !== el.id) setActiveWidget(null)
    onStartMove(e, el.id)
  }

  // only widgets that aren't live or self-managed (i.e. web) keep the shield,
  // and never while focused (it's the one thing on screen to work in)
  const focusedHere = useStore((s) => !!s.focus?.panes.includes(el.id))
  const shielded = !isLive && !isNote && !focusedHere && (!active || tool !== 'select')

  // live bodies: a single click selects + focuses the widget and keeps the
  // event from reaching the canvas (which would deselect / start a marquee)
  const onLiveBodyCapture = () => {
    if (tool !== 'select') return
    select()
    setActiveWidget(el.id)
  }
  const onLiveBodyDown = (e: React.PointerEvent) => {
    if (tool === 'select') e.stopPropagation()
  }

  // A widget you haven't clicked into is a block: pressing its body and
  // dragging moves it, and a click (no drag) enters it. Once entered it gets
  // every event (text selection, scrolling, typing, its own buttons) until
  // you click somewhere else (the canvas, another widget).
  const pressBlock = (e: React.PointerEvent) => {
    grab(e)
    if (tool !== 'select' || e.button !== 0) return
    const start = { x: e.clientX, y: e.clientY }
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId === e.pointerId && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= 4) moved = true
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (moved || ev.type !== 'pointerup') return
      // from far out, a click on a status card flies in to it instead of typing blind
      if (hasCard && selectActive(useStore.getState()).camera.zoom < FAR_ZOOM) focusWidget(el.id)
      else onLiveBodyCapture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  // live bodies (terminals, agents, app-like panels) render their content
  // under the pointer, so the block press is taken in the capture phase,
  // before the content sees it
  // Now playing is all controls and a handle: its buttons and sliders always
  // work, and the rest of it (artwork, titles, background) always drags.
  const handleBody = el.kind === 'nowplaying'
  const blocks = (e: React.SyntheticEvent) => {
    if (spreadCard) return false
    if (handleBody) return !(e.target as Element).closest?.('button, input, select, a, [role="slider"]')
    return !active
  }
  const onBlockCapture = (e: React.PointerEvent) => {
    if (tool !== 'select') return
    if (e.button !== 0 || !blocks(e)) return onLiveBodyCapture()
    // keep the content from seeing this press (preventDefault also suppresses
    // the compatibility mousedown it would start a text selection with)
    e.preventDefault()
    e.stopPropagation()
    pressBlock(e)
  }
  // belt-and-braces for engines that still fire mousedown after a prevented
  // pointerdown: a block you haven't entered must not start a text selection
  const onBlockMouseCapture = (e: React.MouseEvent) => {
    if (tool === 'select' && e.button === 0 && blocks(e)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // drop onto an agent/terminal to feed it context: a file (dragged from a
  // file-tree or diff widget) becomes an @-mention; a prompt (from the prompt
  // library) is pasted in as text. Both ride the same native DnD channel.
  const onBodyDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types
    if (
      t.includes('application/x-ccanvas-file') ||
      t.includes('application/x-ccanvas-prompt')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onBodyDrop = (e: React.DragEvent) => {
    const path = e.dataTransfer.getData('application/x-ccanvas-file')
    const prompt = e.dataTransfer.getData('application/x-ccanvas-prompt')
    if (!path && !prompt) return
    e.preventDefault()
    e.stopPropagation()
    if (path) {
      const base = el.cwd ? el.cwd.replace(/[\\/]+$/, '') : ''
      let rel = base && path.startsWith(base) ? path.slice(base.length + 1) : path
      rel = rel.replace(/\\/g, '/')
      sendTo(el.id, `@${rel} `)
    } else {
      // paste the snippet without auto-submitting, so it can be reviewed/edited
      sendPrompt(el.id, prompt, false)
    }
    select()
    setActiveWidget(el.id)
  }

  const commitName = () => {
    const t = name.trim() || el.title
    if (t !== el.title) {
      beginHistory()
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).title = t
      })
      // tell a live claude agent its new name
      if (el.kind === 'agent' && isSessionLive(el.id)) sendTo(el.id, `/rename ${t}\r`)
    }
    setRenaming(false)
  }

  // ---- resize (a grip on each corner; the opposite corner stays put) ----
  const resizeRef = useRef<{
    corner: Corner
    px: number
    py: number
    x: number
    y: number
    w: number
    h: number
    zoom: number
  } | null>(null)

  const onResizeDown = (e: React.PointerEvent, corner: Corner) => {
    if (el.locked) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    select()
    beginHistory()
    const zoom = selectActive(useStore.getState()).camera.zoom
    resizeRef.current = { corner, px: e.clientX, py: e.clientY, x: el.x, y: el.y, w: el.w, h: el.h, zoom }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const right = r.corner === 'se' || r.corner === 'ne'
    const bottom = r.corner === 'se' || r.corner === 'sw'
    const dw = ((e.clientX - r.px) / r.zoom) * (right ? 1 : -1)
    const dh = ((e.clientY - r.py) / r.zoom) * (bottom ? 1 : -1)
    let w = Math.max(MIN_W, r.w + dw)
    let h = Math.max(MIN_H, r.h + dh)
    // snap the dragged edges to other elements' edges/centers
    const st = useStore.getState()
    const others = selectActive(st)
      .elements.filter((o) => o.id !== el.id && !(stack && (o as WidgetElement).stackId === stack.id))
      .map(elementBounds)
    const { xs, ys } = edgeLines(others)
    const tol = 6 / r.zoom
    const sx = snapValue(right ? r.x + w : r.x + r.w - w, xs, tol)
    const sy = snapValue(bottom ? r.y + h : r.y + r.h - h, ys, tol)
    if (sx != null) w = Math.max(MIN_W, right ? sx - r.x : r.x + r.w - sx)
    if (sy != null) h = Math.max(MIN_H, bottom ? sy - r.y : r.y + r.h - sy)
    st.setSnapGuides({ vx: sx, hy: sy })
    const x = right ? r.x : r.x + r.w - w
    const y = bottom ? r.y : r.y + r.h - h
    // every member of a stack shares one box
    st.mutateElements(stack ? stack.members.map((m) => m.id) : [el.id], (wd) => {
      const ww = wd as WidgetElement
      ww.x = x
      ww.y = y
      ww.w = w
      ww.h = h
    })
  }
  const onResizeUp = (e: React.PointerEvent) => {
    resizeRef.current = null
    useStore.getState().setSnapGuides(null)
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  // snap-to-stack: the widget being held over a target, and the target itself
  const snapRole = useStore((s) => {
    const d = s.stackDrop
    if (!d || d.phase !== 'snap') return null
    if (d.sourceIds[0] === el.id) return 'held'
    if (d.targetId === el.id) return 'target'
    return null
  })
  // while held, this widget's bar previews the stack's rail with its own tab(s)
  // dashed in — it's about to be the front, so its bar is the rail you'll get
  let snapPreview: { stack: Stack; ghostIds: string[] } | null = null
  if (snapRole === 'held') {
    const st = useStore.getState()
    const d = st.stackDrop!
    const els = selectActive(st).elements
    const stacksNow = stacksOf(els)
    const tgt = els.find((e) => e.id === d.targetId)
    if (tgt && tgt.type === 'widget') {
      const tStack = tgt.stackId ? stacksNow.get(tgt.stackId) : undefined
      const sources = d.sourceIds
        .map((id) => els.find((e) => e.id === id))
        .filter((e): e is WidgetElement => !!e && e.type === 'widget')
      // a dragged stack keeps its own tab order
      const srcStack = el.stackId ? stacksNow.get(el.stackId) : undefined
      const incoming = srcStack ? srcStack.members : sources
      snapPreview = {
        stack: {
          id: 'snap-preview',
          title: tStack?.title ?? srcStack?.title ?? tgt.title,
          members: [...(tStack ? tStack.members : [tgt]), ...incoming],
          front: el,
        },
        ghostIds: incoming.map((m) => m.id),
      }
    }
  }
  // ---- focus mode ----
  // 'on': fills the view; 'back': flying home. Either way it is laid out at
  // the focus box at 100% scale (counter-scaled against the camera) and
  // lib/focusMotion animates the way in and out.
  const focusRole = useStore((s) =>
    s.focus?.panes.includes(el.id) ? 'on' : s.focus?.returning.includes(el.id) ? 'back' : null,
  )
  // split focus: every pane keeps its own title bar (the strip carries the
  // header only when one widget fills the view)
  const split = useStore((s) => (s.focus?.panes.length ?? 0) > 1)
  const inStrip = focusRole === 'on' && !split
  // the pane you're working in, when split
  const paneOn = useStore((s) => split && s.focus?.id === el.id)
  // collapsed to its title bar (never while focused or spread out)
  const minimized = !!el.minimized && !focusRole && !spreadCard
  // the status lamp its far card is drawn in
  const sessionStatus = useDisplayStatus(el.id)
  const lampStatus = showsStatus(el) ? (sessionStatus ?? 'off') : 'kind'
  // far out, a status card stands in for the session's content
  const carded = hasCard && far && visible && !focusRole && !minimized
  // zooming back in past the threshold, the card fades off over the content
  // (which shows again at once, under it) instead of popping away
  const cardOut = useCardFadeOut(carded, hasCard && !far && visible && !focusRole && !minimized)
  // this widget's own box: its pane of the focus box (where it flies home
  // from, once it has left the panes)
  const lastPaneBox = useRef<FocusState['box'] | null>(null)
  const focusBoxNow = useStore(
    useShallow((s) => (focusRole ? paneBoxOf(s.focus, el.id, lastPaneBox.current) : null)),
  )
  if (focusRole === 'on' && focusBoxNow) lastPaneBox.current = focusBoxNow
  const focusCam = useStore((s) => (focusRole ? selectActive(s).camera : null))
  const nodeRef = useRef<HTMLDivElement>(null)
  // spread view: click a card to focus it, drag to reorder or pull it out
  const { onCardDown, cardClass } = useSpreadCardDrag(el, stack, spreadCard, nodeRef, () =>
    useStore.getState().closeSpread(el.id),
  )
  const prevFocusRole = useRef<typeof focusRole>(null)
  useLayoutEffect(() => {
    const node = nodeRef.current
    const prev = prevFocusRole.current
    prevFocusRole.current = focusRole
    if (!node) return
    const st = useStore.getState()
    const cam = selectActive(st).camera
    const box = paneBoxOf(st.focus, el.id, lastPaneBox.current)
    const home = { x: el.x * cam.zoom + cam.x, y: el.y * cam.zoom + cam.y, w: el.w * cam.zoom, h: el.h * cam.zoom }
    if (focusRole === 'on' && prev !== 'on' && box) {
      // a stack tab switched while focused swaps in place, no flight
      if (st.focus?.instant) return
      flyFocus(el.id, 'in', node, home, box, cam.zoom)
    } else if (focusRole === 'back' && prev === 'on' && box) {
      flyFocus(el.id, 'out', node, home, box, cam.zoom, () =>
        useStore.getState().finishFocusReturn(el.id),
      )
    } else if (!focusRole && prev) {
      cancelFlight(el.id)
      node.style.clipPath = ''
    }
    // el geometry is read once, when the role changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRole])
  const focusStyle: React.CSSProperties =
    focusRole && focusBoxNow && focusCam
      ? {
          left: (focusBoxNow.x - focusCam.x) / focusCam.zoom,
          top: (focusBoxNow.y - focusCam.y) / focusCam.zoom,
          width: focusBoxNow.w,
          height: focusBoxNow.h,
          transform: `scale(${1 / focusCam.zoom})`,
          transformOrigin: '0 0',
          zIndex: focusRole === 'on' ? 20002 : 20001,
        }
      : {}

  const spreadStyle: React.CSSProperties = spreadCard
    ? {
        transform: spreadCard.closing
          ? undefined
          : `translate(${spreadCard.tx}px, ${spreadCard.ty}px) scale(${spreadCard.k})`,
        zIndex: 10001 + (spreadCard.closing && spreadCard.front ? 100 : spreadCard.index),
      }
    : {}

  // the title bar's parts: in the bar on the canvas, in the focus strip while
  // focused (FocusHeader), so focus mode has one bar
  const titleBits = (
    <>
      <span className="widget__icon">
        <WidgetSlotIcon el={el} />
      </span>
      {renaming ? (
        <input
          ref={titleRef}
          className="widget__title"
          style={{ background: 'transparent', border: 'none' }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitName()
            if (e.key === 'Escape') {
              setName(el.title)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <span
          className="widget__title"
          onDoubleClick={(e) => {
            e.stopPropagation()
            setRenaming(true)
          }}
        >
          {el.title}
        </span>
      )}
      {!renaming && folder && (
        <span className="widget__cwd" title={el.cwd}>
          {folder}
        </span>
      )}
      {el.kind === 'agent' && <AgentMeter id={el.id} />}
      {el.mirrorOf === 'desktop' && (
        <span
          className="dsk-badge"
          title="Read-only mirror of a Claude desktop-app session. Open it in Claude to reply, or right-click to fork it into a terminal."
        >
          Desktop
        </span>
      )}
      {el.mirrorOf === 'desktop' && <MirrorWaitChip el={el} />}
      {(el.kind === 'agent' || el.mirrorOf === 'desktop') && <ContextMeter el={el} />}
    </>
  )
  const actionButtons = (
    <>
      {el.mirrorOf === 'desktop' && el.desktopId && (
        <button
          className="widget__btn"
          title="Open in the Claude app (reply, answer, approve)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openInClaude(el)}
        >
          <IconExternal />
        </button>
      )}
      {el.kind === 'agent' && (
        <button
          className="widget__btn"
          title="Agent settings"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() =>
            openAgentWizard({ x: el.x + el.w / 2, y: el.y + el.h / 2, editId: el.id })
          }
        >
          <IconSettings />
        </button>
      )}
      {isTerminal && (
        <button
          className={`widget__btn${labeling ? ' widget__btn--on' : ''}`}
          title="Label"
          data-label-toggle
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setLabelingWidget(labeling ? null : el.id)}
        >
          <IconTag />
        </button>
      )}
      <button
        className={`widget__btn${el.locked ? ' widget__btn--on' : ''}`}
        title={el.locked ? 'Unlock' : 'Lock position'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          beginHistory()
          mutateElement(el.id, (w) => {
            w.locked = !w.locked
          })
        }}
      >
        <IconLock />
      </button>
      <button
        className="widget__btn widget__btn--danger"
        title="Delete widget"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          beginHistory()
          removeElements([el.id])
        }}
      >
        <IconTrash />
      </button>
      {!focusRole && (
        <button
          className="widget__btn"
          title={el.minimized ? 'Restore' : 'Minimize to the title bar'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => useStore.getState().toggleMinimized(el.id)}
        >
          <IconMinus />
        </button>
      )}
      {/* X leaves where you've zoomed in to: a split pane closes, focus
          returns to the canvas */}
      {focusRole === 'on' && (
        <button
          className="widget__btn"
          title={split ? 'Close this pane' : 'Back to canvas (Esc)'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => (split ? useStore.getState().closePane(el.id) : useStore.getState().exitFocus())}
        >
          <IconClose />
        </button>
      )}
    </>
  )

  return (
    <>
    {stackFront && !spreadCard && !focusRole && !minimized && visible && <StackEdges el={el} stack={stack!} />}
    <div
      className={`widget${selected && !spreadCard ? ' widget--selected' : ''}${
        active ? ' widget--active' : ''
      }${tagged ? ' widget--tagged' : ''}${isTerminal ? ' widget--term' : ''}${
        dimmed ? ' widget--dimmed' : ''
      }${visible ? '' : ' widget--offlayer'}${stackFront && !spreadCard ? ' widget--stack-front' : ''}${
        stackHidden ? ' widget--stack-hidden' : ''
      }${spreadCard ? ' widget--spread' : ''}${spreadCard?.hi && !spreadCard.closing ? ' widget--spread-hi' : ''}${cardClass}${
        snapRole ? ` widget--snap-${snapRole}` : ''
      }${focusRole ? ` widget--focus widget--focus-${focusRole}` : ''}${minimized ? ' widget--min' : ''}${
        paneOn ? ' widget--pane-on' : ''
      }`}
      ref={nodeRef}
      data-widget-id={el.id}
      data-st={lampStatus}
      aria-hidden={stackHidden || undefined}
      style={
        {
          left: el.x,
          top: el.y,
          width: el.w,
          height: el.h,
          zIndex: el.z,
          '--k': accent,
          // the body keeps its full height under the collapsed frame, so a
          // terminal never reflows (or resizes its pty) for a minimize
          '--body-h': minimized ? `${el.h - 2 - HEAD_H}px` : undefined,
          ...spreadStyle,
          ...focusStyle,
        } as React.CSSProperties
      }
    >
      {spreadCard ? (
        <div
          className="widget__bar spread-bar"
          onPointerDown={onCardDown}
        >
          <span className="spread-bar__num">{spreadCard.slot + 1}</span>
          <span className="widget__icon">
            <WidgetSlotIcon el={el} />
          </span>
          <span className="widget__title">{el.title}</span>
          {folder && <span className="widget__cwd">{folder}</span>}
          <span className="widget__bar-spacer" />
          {spreadCard.front && <span className="spread-bar__front">front</span>}
          <button
            className="widget__btn"
            title="Pull out of the stack (X)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => pullOutOfSpread(el.id)}
          >
            <IconPullOut />
          </button>
          <button
            className="widget__btn"
            title="Close the spread (Esc)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => useStore.getState().closeSpread(null)}
          >
            <IconClose />
          </button>
        </div>
      ) : snapPreview ? (
        <StackRail stack={snapPreview.stack} ghostIds={snapPreview.ghostIds} onGrab={grab} />
      ) : (
      // focused, the header tucks away as the widget flies in (its parts show
      // in the focus strip instead) and grows back as it flies home
      <div className={`widget__head${inStrip ? ' widget__head--tucked' : ''}`}>
      <div className="widget__head-in">
      {inStrip ? (
        <div className="widget__bar" aria-hidden>
          <span className="widget__icon">
            <WidgetSlotIcon el={el} />
          </span>
          <span className="widget__title">{el.title}</span>
        </div>
      ) : focusRole === 'on' ? (
        // a pane of split focus: its own bar, pinned in place
        <div className="widget__bar widget__bar--pane" onPointerDown={grab}>
          {titleBits}
          <span className="widget__bar-spacer" />
          <div className="widget__actions">{actionButtons}</div>
        </div>
      ) : stackFront ? (
        <StackRail stack={stack!} onGrab={grab} />
      ) : (
      <div
        className="widget__bar"
        onPointerDown={grab}
        onDoubleClick={(e) => {
          // double-click the empty part of a title bar to focus it (as a Mac
          // window zooms), or to open it back up when minimized; the title
          // itself still renames
          const t = e.target as HTMLElement
          if (t.closest('button, input, .widget__title')) return
          if (el.minimized) useStore.getState().toggleMinimized(el.id)
          else toggleFocus(el.id)
        }}
      >
        {titleBits}
        <span className="widget__bar-spacer" />
        <div className="widget__actions">
          <button
            className="widget__btn"
            title="Focus (⌘⇧↵)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleFocus(el.id)}
          >
            <IconFocus />
          </button>
          {actionButtons}
        </div>
      </div>
      )}
      </div>
      </div>
      )}
      {inStrip && (
        <FocusHeader accent={accent}>
          {{
            title: stackFront ? <StackRail stack={stack!} onGrab={() => {}} /> : titleBits,
            actions: actionButtons,
          }}
        </FocusHeader>
      )}
      {labeling && <LabelPopover el={el} onClose={() => setLabelingWidget(null)} />}

      <div
        className={`widget__body${carded ? ' widget__body--carded' : ''}`}
        style={
          isLive || isNote
            ? { pointerEvents: tool === 'select' ? 'auto' : 'none' }
            : undefined
        }
        onPointerDownCapture={isLive ? onBlockCapture : undefined}
        onMouseDownCapture={isLive ? onBlockMouseCapture : undefined}
        onPointerDown={isLive ? onLiveBodyDown : undefined}
        data-drop-term={isTerminal ? '' : undefined}
        onDragOver={isTerminal ? onBodyDragOver : undefined}
        onDrop={isTerminal ? onBodyDrop : undefined}
      >
        <WidgetErrorBoundary>
          <WidgetBody el={el} active={active} visible={visible} tabShown={tabShown} hidden={stackHidden} />
          {(carded || cardOut) && <FarCard el={el} leaving={!carded} />}
        </WidgetErrorBoundary>

        {spreadCard && (
          <div
            className="widget__spread-hit"
            onPointerDown={onCardDown}
            onPointerEnter={() => {
              if (!isSpreadDragging()) useStore.getState().setSpreadHi(spreadCard.index)
            }}
          />
        )}
        {shielded && !spreadCard && (
          <div
            className="widget__shield"
            onPointerDown={pressBlock}
          >
            <span className="widget__shield-hint">click to interact</span>
          </div>
        )}
      </div>

      {el.mirrorOf === 'desktop' && <MirrorAsk el={el} />}

      {!el.locked &&
        !spreadCard &&
        !focusRole &&
        !minimized &&
        CORNERS.map((c) => (
          <div
            key={c}
            className={`widget__resize widget__resize--${c}`}
            title="Resize"
            onPointerDown={(e) => onResizeDown(e, c)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
          />
        ))}
    </div>
    </>
  )
})

/** Height of a widget's title bar (the stack rail is the same), px. */
const HEAD_H = 30

/** A widget's box in focus mode: its pane's column of the focus box, or
 *  (flying home, no longer a pane) the last pane box it had. */
function paneBoxOf(
  f: FocusState | null,
  id: string,
  last: FocusState['box'] | null,
): FocusState['box'] | null {
  if (!f) return null
  const i = f.panes.indexOf(id)
  if (i >= 0) return paneBoxes(f.box, f.sizes)[i]
  return last ?? f.box
}

/** Take a member out of a spread stack; the spread stays open while 2+ remain. */
export function pullOutOfSpread(id: string) {
  const st = useStore.getState()
  const sp = st.spread
  st.beginHistory()
  st.unstackWidget(id)
  const left = sp ? selectActive(useStore.getState()).elements.filter(
    (e) => e.type === 'widget' && e.stackId === sp.stackId,
  ).length : 0
  if (sp && left < 2) useStore.setState({ spread: null })
  else if (sp) st.setSpreadHi(Math.max(0, Math.min(sp.hi, left - 1)))
}

// Label popover: name + colour tag for a terminal/agent. Colour applies live;
// the name commits on Enter / click-away and reverts on Escape. A live claude
// agent is told its new name and colour, same as the agent wizard does.
function LabelPopover({ el, onClose }: { el: WidgetElement; onClose: () => void }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const [name, setName] = useState(el.title)
  const startColor = useRef(el.color)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const isAgent = el.kind === 'agent'

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // one undo step for the whole edit, taken only once something changes
  const dirty = useRef(false)
  const edit = (fn: (w: WidgetElement) => void) => {
    if (!dirty.current) beginHistory()
    dirty.current = true
    mutateElement(el.id, (w) => fn(w as WidgetElement))
  }
  const setColor = (hex: string | undefined) =>
    edit((w) => {
      w.color = hex
    })

  const commit = () => {
    const t = name.trim() || el.title
    if (t !== el.title)
      edit((w) => {
        w.title = t
      })
    if (isAgent && isSessionLive(el.id)) {
      if (t !== el.title) sendTo(el.id, `/rename ${t}\r`)
      if (el.color !== startColor.current) sendTo(el.id, `/color ${claudeColorName(el.color)}\r`)
    }
    onClose()
  }
  const cancel = () => {
    if (el.color !== startColor.current) setColor(startColor.current)
    onClose()
  }

  // click-away commits (the tag button toggles the popover itself)
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (boxRef.current?.contains(t) || t.closest?.('[data-label-toggle]')) return
      commitRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  return (
    <div
      ref={boxRef}
      className="label-pop"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') cancel()
      }}
    >
      <input
        ref={inputRef}
        className="label-pop__input"
        value={name}
        placeholder="Label"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="label-pop__swatches">
        {!isAgent && (
          <button
            className={`label-pop__swatch label-pop__swatch--none${
              !el.color ? ' label-pop__swatch--on' : ''
            }`}
            title="No colour"
            onClick={() => setColor(undefined)}
          />
        )}
        {AGENT_COLORS.map((c) => (
          <button
            key={c.name}
            className={`label-pop__swatch${
              el.color?.toLowerCase() === c.hex.toLowerCase() ? ' label-pop__swatch--on' : ''
            }`}
            style={{ background: c.hex }}
            title={c.name}
            onClick={() => setColor(c.hex)}
          />
        ))}
      </div>
    </div>
  )
}

// The widget's content. Memoised apart from the frame, and blind to where the
// widget sits: dragging or stacking moves a widget every frame, and that
// re-rendered a whole transcript or terminal each time for nothing.
type BodyProps = { el: WidgetElement; active: boolean; visible: boolean; tabShown: boolean; hidden: boolean }
const PLACE_KEYS = new Set(['x', 'y', 'z'])
function sameBesidesPlace(a: WidgetElement, b: WidgetElement) {
  if (a === b) return true
  const ka = Object.keys(a) as (keyof WidgetElement)[]
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => PLACE_KEYS.has(k) || a[k] === b[k])
}
const WidgetBody = memo(
  function WidgetBody({ el, active, visible, tabShown, hidden }: BodyProps) {
    return (
      <>
      {el.kind === 'note' && <NoteBody el={el} active={active} />}
      {el.kind === 'web' && (
        <WebBody el={el} active={active} onScreen={visible && tabShown !== false && !hidden && !el.minimized} />
      )}
      {el.kind === 'video' && <VideoBody el={el} active={active} />}
      {el.kind === 'mediainfo' && <MediaInfoBody el={el} />}
      {el.kind === 'claude' && <ClaudeBody el={el} />}
      {el.kind === 'nowplaying' && (
        <NowPlayingBody el={el} visible={visible} active={active} />
      )}
      {(el.kind === 'terminal' || el.kind === 'agent') && (
        <TerminalBody el={el} active={active} visible={visible} tabShown={tabShown} hidden={hidden} />
      )}
      {el.kind === 'files' && <FilesBody el={el} />}
      {el.kind === 'diff' && <DiffBody el={el} />}
      {el.kind === 'editor' && <EditorBody el={el} active={active} />}
      {el.kind === 'vscode' && <VsCodeBody el={el} active={active} />}
      {el.kind === 'doc' && <DocBody el={el} />}
      {el.kind === 'log' && <LogBody el={el} />}
      {el.kind === 'pr' && <PrBody el={el} />}
      {el.kind === 'issues' && <IssuesBody el={el} />}
      {el.kind === 'runs' && <RunsBody el={el} />}
      {el.kind === 'runner' && <RunnerBody el={el} />}
      {el.kind === 'sql' && <SqlBody el={el} active={active} />}
      {el.kind === 'data' && <DataBody el={el} />}
      {el.kind === 'plot' && <PlotBody el={el} />}
      {el.kind === 'transcript' && <TranscriptBody el={el} />}
      </>
    )
  },
  (a, b) =>
    a.active === b.active &&
    a.visible === b.visible &&
    a.tabShown === b.tabShown &&
    a.hidden === b.hidden &&
    sameBesidesPlace(a.el, b.el),
)

// Zoomed far out, a widget's summary card: its colour, glyph, name and
// status (or what it is), sized in screen pixels (via its --z) so it stays
// readable however far out you are. Sits over the widget, which keeps
// running underneath. The layers overview draws the same card (LayerProxy).
const STATUS_LABEL: Record<string, string> = {
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  done: 'just finished',
  connecting: 'connecting',
  off: 'offline',
}
/** How long a far card takes to fade in or out (global.css: .term-card). */
const CARD_FADE = 160

/** True for CARD_FADE after `carded` turns off for a reason the card should
 *  fade for (`fadeFor`: zoomed back in; not a focus, a minimize or a layer
 *  switch, where it just goes). */
function useCardFadeOut(carded: boolean, fadeFor: boolean): boolean {
  const [out, setOut] = useState(false)
  const was = useRef(carded)
  useLayoutEffect(() => {
    const leaving = was.current && !carded && fadeFor
    was.current = carded
    if (!leaving || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOut(false)
      return
    }
    setOut(true)
    const t = window.setTimeout(() => setOut(false), CARD_FADE)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carded])
  return out
}

function FarCard({ el, leaving }: { el: WidgetElement; leaving?: boolean }) {
  const live = showsStatus(el)
  const st = useDisplayStatus(el.id) ?? 'off'
  // a widget without a session status is tinted with its own accent
  const status = live ? st : 'kind'
  // the card sizes itself in screen px from the zoom. Set here rather than on
  // the world layer: a custom property changed on the world restyled every
  // element on the canvas on each zoom frame
  const zoom = useStore((s) => selectActive(s).camera.zoom)
  const folder = el.cwd ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null
  const glyph = widgetGlyph(el) === 'mirror' ? IconDesktop : undefined
  // the music player's card names the song, with the artist (or paused) under it
  const np = useNowPlaying((s) => (el.kind === 'nowplaying' && s.np.kind === 'track' ? s.np.track : null))
  const name = np?.title || el.title
  const line = np ? (np.playing ? np.artist || 'playing' : 'paused') : live ? (STATUS_LABEL[st] ?? st) : widgetType(el)
  return (
    <div
      className={`term-card${el.color ? ' term-card--tagged' : ''}${leaving ? ' term-card--out' : ''}`}
      data-st={status}
      style={{
        ['--z' as string]: zoom,
        ['--chars' as string]: Math.max(6, name.length),
        ['--lw' as string]: longestWord(name),
        ['--k' as string]: el.color ?? WIDGET_ACCENT[el.kind],
      }}
    >
      <div className="term-card__screen">
        <div className="term-card__lamp">
          <WidgetGlyph el={el} status={live ? st : undefined} glyph={glyph} className="term-card__glyph" />
          <div className="term-card__name">{name}</div>
          <div className="term-card__status">{line}</div>
          <div className="term-card__sub">
            {folder && <span className="term-card__folder">{folder}</span>}
            {(el.kind === 'agent' || el.mirrorOf === 'desktop') && <CardContext el={el} />}
          </div>
        </div>
      </div>
    </div>
  )
}
function CardContext({ el }: { el: WidgetElement }) {
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  if (!ctx) return null
  const pct = Math.round(ctx.pct)
  return (
    <span className={`term-card__ctx${pct >= 85 ? ' term-card__ctx--hot' : ''}`}>
      {pct}% context
    </span>
  )
}


// Context meter: a short fill bar + % of the context window, with a one-click
// /compact once the conversation is getting full.
const COMPACT_AT = 70
function fmtK(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}
function ContextMeter({ el }: { el: WidgetElement }) {
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  if (!ctx) return null
  const pct = Math.round(ctx.pct)
  // a desktop mirror is read-only: it shows the fill but never sends /compact
  const canCompact = el.kind === 'agent'
  const level = pct >= 85 ? 'hot' : pct >= COMPACT_AT ? 'warm' : 'ok'
  return (
    <span
      className={`ctx ctx--${level}`}
      title={`Context: ${fmtK(ctx.used)} of ${fmtK(ctx.window)} tokens (${pct}%)`}
    >
      <span className="ctx__bar">
        <span className="ctx__fill" style={{ width: `${ctx.pct}%` }} />
      </span>
      <span className="ctx__pct">{pct}%</span>
      {canCompact && pct >= COMPACT_AT && (
        <button
          className="ctx__compact"
          title="Summarize the conversation to free up context (/compact)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            sendPrompt(el.id, '/compact')
          }}
        >
          compact
        </button>
      )}
    </span>
  )
}

// Compact activity meter: turns · active time · scraped cost (run /cost to fill).
function fmtMeter(m: AgentMetrics): string {
  const time =
    m.activeMs >= 60000
      ? `${Math.round(m.activeMs / 60000)}m`
      : `${Math.round(m.activeMs / 1000)}s`
  const parts = [`${m.turns}t`, time]
  if (m.costUsd != null) parts.push(`$${m.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}
function AgentMeter({ id }: { id: string }) {
  const m = useAgents((s) => s.metrics[id])
  if (!m || (m.turns === 0 && m.costUsd == null)) return null
  return (
    <span className="widget__meter" title="turns · active time · cost (run /cost)">
      {fmtMeter(m)}
    </span>
  )
}

/** A focused widget's header, rendered into the focus strip (focusSlots.ts)
 *  in place of its own title bar. */
function FocusHeader({
  accent,
  children,
}: {
  accent: string
  children: { title: React.ReactNode; actions: React.ReactNode }
}) {
  const title = useFocusSlot('title')
  const actions = useFocusSlot('actions')
  const style = { '--k': accent } as React.CSSProperties
  return (
    <>
      {title &&
        createPortal(
          <div className="focus-strip__part focus-strip__part--title" style={style} {...stopCanvas}>
            {children.title}
          </div>,
          title,
        )}
      {actions &&
        createPortal(
          <div className="focus-strip__part" style={style} {...stopCanvas}>
            {children.actions}
          </div>,
          actions,
        )}
    </>
  )
}
