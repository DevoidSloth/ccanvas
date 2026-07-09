import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, selectActive, withGroupSiblings } from '../store/workspace'
import type {
  ArrowElement,
  CanvasElement,
  FrameElement,
  ImageElement,
  Point,
  WidgetElement,
  WidgetKind,
} from '../lib/types'
import {
  screenToWorld,
  worldToScreen,
  zoomAt,
  clamp,
  dist,
  elementBounds,
  hitTest,
  pointInRect,
  rectsIntersect,
  resolvedArrow,
  snapBox,
  edgeLines,
  snapValue,
  ANCHORS,
  anchorPoint,
  arrowApex,
  bendFromApex,
  type Rect,
} from '../lib/geometry'
import { newId } from '../lib/id'
import { revealPath, fileManagerName } from '../lib/backend'
import {
  openContextMenu,
  isEditableTarget,
  type MenuItem,
} from '../ui/ContextMenu'
import { IconExternal } from '../ui/icons'
import { ElementView } from './ElementView'
import { TextElement } from './TextElement'
import { WidgetFrame } from '../widgets/WidgetFrame'

type ScreenRect = { x: number; y: number; w: number; h: number }
type Corner = 'nw' | 'ne' | 'sw' | 'se'

// movement (screen px) before a press becomes a drag — lets clicks and
// double-clicks (e.g. activate a widget, rename a tab) pass through cleanly.
const DRAG_THRESHOLD = 3

// no-op move handler for widgets on inactive (hidden) tabs
const NOOP = () => {}

// element types an arrow endpoint can bind to
const BINDABLE = new Set(['widget', 'image', 'frame', 'rect', 'ellipse', 'text'])

// ---- quick-insert (Space) commands ----
type QuickCommand = {
  name: string // canonical command shown in the menu
  target: WidgetKind
  desc: string
  aliases?: string[]
}

const QUICK_COMMANDS: QuickCommand[] = [
  { name: 'agent', target: 'agent', desc: 'Claude agent', aliases: ['claude', 'ai'] },
  { name: 'term', target: 'terminal', desc: 'shell terminal', aliases: ['terminal', 'sh', 'shell'] },
  { name: 'files', target: 'files', desc: 'file tree', aliases: ['tree', 'explorer'] },
  { name: 'diff', target: 'diff', desc: 'git diff', aliases: ['git'] },
  { name: 'editor', target: 'editor', desc: 'file editor', aliases: ['edit', 'code'] },
  { name: 'doc', target: 'doc', desc: 'live markdown', aliases: ['readme'] },
  { name: 'log', target: 'log', desc: 'log tail', aliases: ['tail'] },
  { name: 'runner', target: 'runner', desc: 'task runner', aliases: ['run', 'test'] },
  { name: 'data', target: 'data', desc: 'data viewer', aliases: ['csv', 'parquet', 'table', 'df'] },
  { name: 'plot', target: 'plot', desc: 'figure viewer', aliases: ['fig', 'figure', 'img', 'chart'] },
  { name: 'pr', target: 'pr', desc: 'pull requests', aliases: ['prs'] },
  { name: 'issues', target: 'issues', desc: 'github issues', aliases: ['issue'] },
  { name: 'actions', target: 'runs', desc: 'github actions / CI', aliases: ['runs', 'ci', 'gh'] },
  { name: 'web', target: 'web', desc: 'web preview', aliases: ['url', 'preview', 'browser'] },
  { name: 'video', target: 'video', desc: 'video player', aliases: ['movie', 'mp4', 'clip'] },
  { name: 'note', target: 'note', desc: 'markdown note', aliases: ['md', 'markdown'] },
]

// every trigger word (canonical + aliases) → target
const COMMAND_MAP: Record<string, WidgetKind> = Object.fromEntries(
  QUICK_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((w) => [w, c.target])),
)

/** Commands whose name or any alias starts with the typed token. */
function matchCommands(token: string): QuickCommand[] {
  const t = token.toLowerCase()
  return QUICK_COMMANDS.filter(
    (c) => c.name.startsWith(t) || (c.aliases ?? []).some((a) => a.startsWith(t)),
  )
}

/** A resolved connection target for an arrow endpoint. */
type Bind = { id: string; anchor?: { nx: number; ny: number }; point?: Point }

type Drag =
  | { kind: 'pan'; startCam: Point; startPtr: Point }
  | { kind: 'draw' }
  | { kind: 'arrow'; fromBind?: Bind }
  | { kind: 'arrowEnd'; id: string; end: 'from' | 'to'; began: boolean }
  | { kind: 'curveArrow'; id: string; began: boolean }
  | { kind: 'shape'; ox: number; oy: number }
  | { kind: 'move'; last: Point; startPtr: Point; began: boolean; captured: boolean }
  | { kind: 'marquee'; start: Point }
  | { kind: 'erase'; began: boolean }
  | {
      kind: 'resizeEl'
      id: string
      corner: Corner
      ox: number
      oy: number
      ow: number
      oh: number
      startWorld: Point
      aspect: number | null
      began: boolean
    }
  | null

export function Canvas() {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag>(null)
  const mouseRef = useRef<Point | null>(null)

  const ws = useStore(selectActive)
  const tabs = useStore((s) => s.tabs)
  const activeId = useStore((s) => s.activeTabId)
  const tool = useStore((s) => s.tool)
  const color = useStore((s) => s.color)
  const strokeWidth = useStore((s) => s.strokeWidth)
  const selection = useStore((s) => s.selection)

  const setCamera = useStore((s) => s.setCamera)
  const addElement = useStore((s) => s.addElement)
  const addImage = useStore((s) => s.addImage)
  const removeElements = useStore((s) => s.removeElements)
  const moveSelection = useStore((s) => s.moveSelection)
  const mutateElement = useStore((s) => s.mutateElement)
  const setSelection = useStore((s) => s.setSelection)
  const clearSelection = useStore((s) => s.clearSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const setEditingText = useStore((s) => s.setEditingText)
  const setTool = useStore((s) => s.setTool)
  const beginHistory = useStore((s) => s.beginHistory)
  const beginFrameDrag = useStore((s) => s.beginFrameDrag)
  const endFrameDrag = useStore((s) => s.endFrameDrag)
  const spawnWidget = useStore((s) => s.spawnWidget)
  const openAgentWizard = useStore((s) => s.openAgentWizard)
  const setSnapGuides = useStore((s) => s.setSnapGuides)
  const guides = useStore((s) => s.snapGuides)

  const [draft, setDraft] = useState<CanvasElement | null>(null)
  const [marquee, setMarquee] = useState<ScreenRect | null>(null)
  const [panning, setPanning] = useState(false)
  const [insertAt, setInsertAt] = useState<Point | null>(null)
  // element + active anchor an arrow endpoint would connect to right now (drives
  // the anchor dots shown while drawing / dragging a connector endpoint)
  const [bindHover, setBindHover] = useState<Bind | null>(null)
  // true while re-dragging an existing connector endpoint (so we show the
  // quick-connect dots on widgets even though the active tool is select)
  const [endpointDrag, setEndpointDrag] = useState(false)

  const cam = ws.camera
  const selSet = new Set(selection)
  const byId = new Map(ws.elements.map((e) => [e.id, e]))

  const getPt = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ---- Space → quick insert (text or /command widget) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement
      const typing =
        t.isContentEditable ||
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.closest('.xterm') != null
      if (typing) return
      // a focused widget wants the space for itself
      if (useStore.getState().activeWidgetId) return
      e.preventDefault()
      const r = rootRef.current?.getBoundingClientRect()
      const fallback = r ? { x: r.width / 2, y: r.height / 2 } : { x: 0, y: 0 }
      setInsertAt(mouseRef.current ?? fallback)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- native wheel (non-passive): smooth zoom + pan ----
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const onWheel = (e: WheelEvent) => {
      const zoomGesture = e.ctrlKey || e.metaKey
      const overWidget = !!(e.target as HTMLElement | null)?.closest?.('.widget')
      // plain scroll over a widget → let that widget scroll its own content
      if (overWidget && !zoomGesture) return
      e.preventDefault()
      // zooming while hovering a widget: don't also scroll the widget under it
      if (overWidget) e.stopPropagation()
      const live = selectActive(useStore.getState()).camera
      const pt = getPt(e)
      // normalise delta across line / page wheel modes
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      else if (e.deltaMode === 2) dy *= node.clientHeight
      if (zoomGesture) {
        // gentle per-event step, clamped so a single notch never jumps far
        const factor = Math.exp(-clamp(dy, -100, 100) * 0.0017)
        setCamera(zoomAt(live, pt, live.zoom * factor))
      } else {
        setCamera({ ...live, x: live.x - e.deltaX, y: live.y - e.deltaY })
      }
    }
    // capture phase so we can intercept before the widget when zooming
    node.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => node.removeEventListener('wheel', onWheel, { capture: true })
  }, [setCamera])

  // topmost vector under a world point (text/images/frames/widgets self-pick)
  const pickVector = (world: Point): CanvasElement | null => {
    const tol = 6 / cam.zoom
    let best: CanvasElement | null = null
    for (const el of ws.elements) {
      if (
        el.type === 'widget' ||
        el.type === 'text' ||
        el.type === 'image' ||
        el.type === 'frame'
      )
        continue
      if (hitTest(el, world, tol) && (!best || el.z > best.z)) best = el
    }
    return best
  }

  // topmost element of ANY type under a world point — for the right-click menu
  const pickTopForMenu = (world: Point): CanvasElement | null => {
    const tol = 6 / cam.zoom
    let best: CanvasElement | null = null
    for (const el of ws.elements) {
      const hit =
        el.type === 'widget' ||
        el.type === 'frame' ||
        el.type === 'text' ||
        el.type === 'image'
          ? pointInRect(world, elementBounds(el))
          : hitTest(el, world, tol)
      if (hit && (!best || el.z > best.z)) best = el
    }
    return best
  }

  const elementMenu = (selEls: CanvasElement[]): MenuItem[] => {
    const multi = selEls.length >= 2
    const anyLocked = selEls.some((e) => e.locked)
    const grouped = selEls.some((e) => e.groupId)
    const lone = selEls.length === 1 ? selEls[0] : undefined
    const s = () => useStore.getState()
    const items: MenuItem[] = []
    // a path-bearing widget (files/editor/doc/log/diff) → reveal it on disk
    if (lone?.type === 'widget') {
      const w = lone as WidgetElement
      const p = w.path || w.cwd
      if (p) {
        items.push({
          label: `Reveal in ${fileManagerName()}`,
          icon: <IconExternal />,
          onClick: () => void revealPath(p),
        })
        items.push({ separator: true })
      }
    }
    // an agent → tracking camera, transcript, and a labelled box
    if (lone?.type === 'widget' && (lone as WidgetElement).kind === 'agent') {
      const agent = lone as WidgetElement
      const tracking = useStore.getState().trackingAgentId === agent.id
      items.push({
        label: tracking ? 'Stop tracking camera' : 'Track this agent (orbit its files)',
        onClick: () =>
          tracking ? s().stopTrackingAgent(false) : void s().startTrackingAgent(agent.id),
      })
      if (tracking)
        items.push({
          label: 'Stop tracking & clear orbit',
          onClick: () => s().stopTrackingAgent(true),
        })
      items.push({
        label: 'Open transcript',
        onClick: () =>
          s().spawnWidget('transcript', agent.x + agent.w + 360, agent.y + 120, {
            agentId: agent.id,
            cwd: agent.cwd,
            title: `${agent.title} · transcript`,
          }),
      })
      const boxed = ws.elements.some((e) => e.labelFor === lone.id)
      items.push({
        label: boxed ? 'Remove label box' : 'Label box',
        onClick: () => s().labelAgent(lone.id),
      })
      items.push({ separator: true })
    }
    items.push({ label: 'Duplicate', hint: '⌘D', onClick: () => s().duplicateSelection() })
    items.push({ label: 'Copy', hint: '⌘C', onClick: () => s().copySelection() })
    items.push({
      label: anyLocked ? 'Unlock' : 'Lock',
      hint: '⌘L',
      onClick: () => s().toggleLock(),
    })
    if (multi)
      items.push({
        label: grouped ? 'Ungroup' : 'Group',
        hint: grouped ? '⌘⇧G' : '⌘G',
        onClick: () => (grouped ? s().ungroup() : s().group()),
      })
    items.push({ separator: true })
    items.push({ label: 'Bring to front', hint: '⌘]', onClick: () => s().bringToFront(s().selection) })
    items.push({ label: 'Send to back', hint: '⌘[', onClick: () => s().sendToBack(s().selection) })
    items.push({ separator: true })
    items.push({ label: 'Delete', hint: '⌫', danger: true, onClick: () => s().deleteSelection() })
    return items
  }

  const backgroundMenu = (world: Point): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: 'Paste here',
        hint: '⌘V',
        onClick: () => useStore.getState().pasteClipboard(world.x, world.y),
      },
      {
        label: 'Select all',
        hint: '⌘A',
        onClick: () => {
          const st = useStore.getState()
          st.setSelection(selectActive(st).elements.map((el) => el.id))
        },
      },
    ]
    if (ws.dir) {
      items.push({ separator: true })
      items.push({
        label: `Reveal folder in ${fileManagerName()}`,
        icon: <IconExternal />,
        onClick: () => void revealPath(ws.dir!),
      })
    }
    return items
  }

  const onContextMenu = (e: React.MouseEvent) => {
    // editable fields / the terminal keep their native copy-paste menu
    if (isEditableTarget(e.target)) return
    // ignore right-clicks fired mid-drag
    const drag = dragRef.current
    if (drag && 'began' in drag && drag.began) return
    const world = screenToWorld(getPt(e), cam)
    const picked = pickTopForMenu(world)
    if (picked) {
      const cur = useStore.getState().selection
      const selIds = cur.includes(picked.id)
        ? cur
        : withGroupSiblings(ws.elements, [picked.id])
      if (selIds !== cur) setSelection(selIds)
      const selEls = ws.elements.filter((el) => selIds.includes(el.id))
      openContextMenu(e, elementMenu(selEls))
    } else {
      openContextMenu(e, backgroundMenu(world))
    }
  }

  // What an arrow endpoint at `world` would connect to: snap to a specific
  // anchor when close to one, else auto-dock when dropped inside an element.
  // A small magnetic margin makes edge anchors catchable from just outside.
  const bindAt = (world: Point, excludeId?: string): Bind | null => {
    const anchorTol = 18 / cam.zoom
    const margin = 12 / cam.zoom
    let target: CanvasElement | null = null
    for (const el of ws.elements) {
      if (el.id === excludeId || !BINDABLE.has(el.type)) continue
      const b = elementBounds(el)
      const exp = { x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 }
      if (pointInRect(world, exp) && (!target || el.z > target.z)) target = el
    }
    if (!target) return null
    const b = elementBounds(target)
    let bestA: { nx: number; ny: number } | null = null
    let bestD = anchorTol
    for (const a of ANCHORS) {
      const d = dist(world, { x: b.x + a.nx * b.w, y: b.y + a.ny * b.h })
      if (d <= bestD) {
        bestD = d
        bestA = a
      }
    }
    if (bestA) return { id: target.id, anchor: bestA, point: anchorPoint(target, bestA) }
    if (pointInRect(world, b)) return { id: target.id } // inside but not near an anchor → auto-dock
    return null
  }

  /** Strip `point` (UI-only) from a Bind before persisting it on the arrow. */
  const toBinding = (b?: Bind | null) =>
    b ? (b.anchor ? { id: b.id, anchor: b.anchor } : { id: b.id }) : undefined

  const eraseAt = (world: Point) => {
    const tol = 8 / cam.zoom
    const hits = ws.elements
      .filter((el) => el.type !== 'widget' && el.type !== 'frame' && hitTest(el, world, tol))
      .map((el) => el.id)
    if (!hits.length) return
    const d = dragRef.current
    if (d?.kind === 'erase' && !d.began) {
      beginHistory()
      d.began = true
    }
    removeElements(hits)
  }

  // begin a (deferred) move — capture is taken only once the pointer moves,
  // so plain clicks / double-clicks still reach the element underneath
  const startMoveDrag = (e: React.PointerEvent) => {
    const pt = getPt(e)
    dragRef.current = {
      kind: 'move',
      last: screenToWorld(pt, cam),
      startPtr: pt,
      began: false,
      captured: false,
    }
    beginFrameDrag()
  }

  const onElementPointerDown = (e: React.PointerEvent, id: string) => {
    if (tool !== 'select') return
    e.stopPropagation()
    const additive = e.shiftKey
    const cur = useStore.getState().selection
    const next = additive
      ? cur.includes(id)
        ? cur.filter((x) => x !== id)
        : [...cur, id]
      : cur.includes(id)
        ? cur
        : [id]
    setSelection(withGroupSiblings(ws.elements, next))
    setActiveWidget(null)
    startMoveDrag(e)
  }

  // widget frames pre-select themselves, then ask us to begin the move drag
  const onWidgetStartMove = (e: React.PointerEvent) => {
    setActiveWidget(null)
    setSelection(withGroupSiblings(ws.elements, useStore.getState().selection))
    startMoveDrag(e)
  }

  // ---- transform handles ----
  const onHandleDown = (e: React.PointerEvent, id: string, corner: Corner) => {
    e.stopPropagation()
    rootRef.current?.setPointerCapture(e.pointerId)
    const el = byId.get(id)
    if (!el) return
    const b = elementBounds(el)
    const aspect = el.type === 'image' ? b.w / Math.max(1, b.h) : null
    dragRef.current = {
      kind: 'resizeEl',
      id,
      corner,
      ox: b.x,
      oy: b.y,
      ow: b.w,
      oh: b.h,
      startWorld: screenToWorld(getPt(e), cam),
      aspect,
      began: false,
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const pt = getPt(e)
    const world = screenToWorld(pt, cam)
    const panGesture = tool === 'pan' || e.button === 1

    if (panGesture) {
      dragRef.current = { kind: 'pan', startCam: { x: cam.x, y: cam.y }, startPtr: pt }
      rootRef.current?.setPointerCapture(e.pointerId)
      setPanning(true)
      return
    }
    if (e.button !== 0) return

    setActiveWidget(null)

    if (tool === 'select') {
      const hit = pickVector(world)
      if (hit) {
        const additive = e.shiftKey
        const base = additive
          ? selection.includes(hit.id)
            ? selection.filter((x) => x !== hit.id)
            : [...selection, hit.id]
          : // keep the group if this element is already part of it (drag-the-group)
            selection.includes(hit.id)
            ? selection
            : [hit.id]
        setSelection(withGroupSiblings(ws.elements, base))
        startMoveDrag(e)
      } else {
        if (!e.shiftKey) clearSelection()
        dragRef.current = { kind: 'marquee', start: pt }
        setMarquee({ x: pt.x, y: pt.y, w: 0, h: 0 })
        rootRef.current?.setPointerCapture(e.pointerId)
      }
      return
    }

    if (tool === 'text') {
      beginHistory()
      const id = newId()
      addElement({ id, type: 'text', x: world.x, y: world.y - 9, text: '', color, fontSize: 18, z: 0 })
      // setTool clears editingTextId, so switch tool *before* entering edit mode
      setTool('select')
      setEditingText(id)
      return
    }

    if (tool === 'eraser') {
      rootRef.current?.setPointerCapture(e.pointerId)
      dragRef.current = { kind: 'erase', began: false }
      eraseAt(world)
      return
    }

    // draw / arrow / rect / ellipse / frame
    rootRef.current?.setPointerCapture(e.pointerId)
    const id = newId()
    if (tool === 'pen') {
      setDraft({ id, type: 'draw', points: [world.x, world.y], color, size: strokeWidth, z: 0 })
      dragRef.current = { kind: 'draw' }
    } else if (tool === 'arrow') {
      // snap the start onto an anchor if pressed over a widget
      const fromBind = bindAt(world, id)
      const s = fromBind?.point ?? world
      setDraft({ id, type: 'arrow', x1: s.x, y1: s.y, x2: s.x, y2: s.y, color, size: strokeWidth, z: 0 })
      dragRef.current = { kind: 'arrow', fromBind: fromBind ?? undefined }
    } else if (tool === 'rect' || tool === 'ellipse') {
      setDraft({ id, type: tool, x: world.x, y: world.y, w: 0, h: 0, color, size: strokeWidth, z: 0 })
      dragRef.current = { kind: 'shape', ox: world.x, oy: world.y }
    } else if (tool === 'frame') {
      setDraft({ id, type: 'frame', x: world.x, y: world.y, w: 0, h: 0, title: 'frame', color: '#61605b', z: 0 })
      dragRef.current = { kind: 'shape', ox: world.x, oy: world.y }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const pt = getPt(e)
    mouseRef.current = pt
    const drag = dragRef.current
    if (!drag) {
      // preview connection anchors while the arrow tool hovers an element
      if (tool === 'arrow') {
        const b = bindAt(screenToWorld(pt, cam))
        setBindHover((prev) =>
          prev?.id === b?.id &&
          prev?.anchor?.nx === b?.anchor?.nx &&
          prev?.anchor?.ny === b?.anchor?.ny
            ? prev
            : b,
        )
      } else if (bindHover) {
        setBindHover(null)
      }
      return
    }
    const world = screenToWorld(pt, cam)

    switch (drag.kind) {
      case 'pan':
        setCamera({
          ...cam,
          x: drag.startCam.x + (pt.x - drag.startPtr.x),
          y: drag.startCam.y + (pt.y - drag.startPtr.y),
        })
        break
      case 'draw':
        setDraft((d) =>
          d?.type === 'draw' ? { ...d, points: [...d.points, world.x, world.y] } : d,
        )
        break
      case 'arrow': {
        const b = bindAt(world, draft?.id)
        setBindHover(b)
        const end = b?.point ?? world
        setDraft((d) => (d?.type === 'arrow' ? { ...d, x2: end.x, y2: end.y } : d))
        break
      }
      case 'arrowEnd': {
        if (!drag.began) {
          beginHistory()
          drag.began = true
        }
        const b = bindAt(world, drag.id)
        setBindHover(b)
        const p = b?.point ?? world
        // detach this end while dragging; rebind happens on pointer up
        mutateElement(drag.id, (a) => {
          const ar = a as ArrowElement
          if (drag.end === 'from') {
            ar.x1 = p.x
            ar.y1 = p.y
            ar.from = b ? toBinding(b) : undefined
          } else {
            ar.x2 = p.x
            ar.y2 = p.y
            ar.to = b ? toBinding(b) : undefined
          }
        })
        break
      }
      case 'curveArrow': {
        if (!drag.began) {
          beginHistory()
          drag.began = true
        }
        const a = byId.get(drag.id)
        if (a?.type === 'arrow') {
          const r = resolvedArrow(a, byId)
          const bend = bendFromApex({ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }, world)
          mutateElement(drag.id, (el) => {
            ;(el as ArrowElement).bend = Math.abs(bend) < 3 ? undefined : bend
          })
        }
        break
      }
      case 'shape':
        setDraft((d) =>
          d?.type === 'rect' || d?.type === 'ellipse' || d?.type === 'frame'
            ? {
                ...d,
                x: Math.min(drag.ox, world.x),
                y: Math.min(drag.oy, world.y),
                w: Math.abs(world.x - drag.ox),
                h: Math.abs(world.y - drag.oy),
              }
            : d,
        )
        break
      case 'move': {
        if (!drag.captured) {
          if (Math.hypot(pt.x - drag.startPtr.x, pt.y - drag.startPtr.y) < DRAG_THRESHOLD)
            break
          rootRef.current?.setPointerCapture(e.pointerId)
          drag.captured = true
        }
        if (!drag.began) {
          beginHistory()
          drag.began = true
        }
        let dx = world.x - drag.last.x
        let dy = world.y - drag.last.y
        // alignment-guide snapping against non-moving elements
        const movingIds = new Set(useStore.getState().selection)
        const moving = ws.elements.filter((el) => movingIds.has(el.id))
        if (moving.length) {
          const mb = unionBounds(moving)
          const target = { x: mb.x + dx, y: mb.y + dy, w: mb.w, h: mb.h }
          const others = ws.elements
            .filter((el) => !movingIds.has(el.id))
            .map(elementBounds)
          const snap = snapBox(target, others, 6 / cam.zoom)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides({ vx: snap.vx, hy: snap.hy })
        }
        moveSelection(dx, dy)
        drag.last = { x: drag.last.x + dx, y: drag.last.y + dy }
        break
      }
      case 'resizeEl': {
        if (!drag.began) {
          beginHistory()
          drag.began = true
        }
        const dx = world.x - drag.startWorld.x
        const dy = world.y - drag.startWorld.y
        const { ox, oy, ow, oh } = drag
        let nx = ox
        let ny = oy
        let nw = ow
        let nh = oh
        if (drag.corner === 'se') {
          nw = ow + dx
          nh = oh + dy
        } else if (drag.corner === 'sw') {
          nx = ox + dx
          nw = ow - dx
          nh = oh + dy
        } else if (drag.corner === 'ne') {
          ny = oy + dy
          nw = ow + dx
          nh = oh - dy
        } else {
          nx = ox + dx
          ny = oy + dy
          nw = ow - dx
          nh = oh - dy
        }
        if (drag.aspect) {
          nh = nw / drag.aspect
          if (drag.corner === 'nw' || drag.corner === 'ne') ny = oy + oh - nh
        } else {
          // snap the dragged corner's edges to nearby elements (no aspect lock)
          const tol = 6 / cam.zoom
          const others = ws.elements.filter((e) => e.id !== drag.id).map(elementBounds)
          const { xs, ys } = edgeLines(others)
          let vx: number | null = null
          let hy: number | null = null
          const right = drag.corner === 'se' || drag.corner === 'ne'
          const left = drag.corner === 'sw' || drag.corner === 'nw'
          const bottom = drag.corner === 'se' || drag.corner === 'sw'
          const top = drag.corner === 'ne' || drag.corner === 'nw'
          if (right) {
            const s = snapValue(nx + nw, xs, tol)
            if (s != null) {
              nw = s - nx
              vx = s
            }
          } else if (left) {
            const s = snapValue(nx, xs, tol)
            if (s != null) {
              nw += nx - s
              nx = s
              vx = s
            }
          }
          if (bottom) {
            const s = snapValue(ny + nh, ys, tol)
            if (s != null) {
              nh = s - ny
              hy = s
            }
          } else if (top) {
            const s = snapValue(ny, ys, tol)
            if (s != null) {
              nh += ny - s
              ny = s
              hy = s
            }
          }
          setSnapGuides({ vx, hy })
        }
        const MIN = 24
        nw = Math.max(MIN, nw)
        nh = Math.max(MIN, nh)
        mutateElement(drag.id, (el) => {
          const a = el as ImageElement | FrameElement
          a.x = nx
          a.y = ny
          a.w = nw
          a.h = nh
        })
        break
      }
      case 'marquee': {
        const x = Math.min(drag.start.x, pt.x)
        const y = Math.min(drag.start.y, pt.y)
        setMarquee({ x, y, w: Math.abs(pt.x - drag.start.x), h: Math.abs(pt.y - drag.start.y) })
        break
      }
      case 'erase':
        eraseAt(world)
        break
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    setPanning(false)
    setSnapGuides(null)
    endFrameDrag()
    try {
      rootRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    if (drag?.kind === 'draw' && draft?.type === 'draw') {
      if (draft.points.length >= 4) {
        beginHistory()
        addElement(draft)
      }
    } else if (drag?.kind === 'arrow' && draft?.type === 'arrow') {
      if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 6) {
        beginHistory()
        const from = toBinding(drag.fromBind)
        const to = toBinding(bindAt({ x: draft.x2, y: draft.y2 }, draft.id))
        addElement({
          ...draft,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        })
      }
    } else if (
      drag?.kind === 'shape' &&
      (draft?.type === 'rect' || draft?.type === 'ellipse' || draft?.type === 'frame')
    ) {
      if (draft.w > 4 && draft.h > 4) {
        beginHistory()
        addElement(draft)
      }
    } else if (drag?.kind === 'marquee' && marquee && (marquee.w > 3 || marquee.h > 3)) {
      const tl = screenToWorld({ x: marquee.x, y: marquee.y }, cam)
      const worldBox: Rect = { x: tl.x, y: tl.y, w: marquee.w / cam.zoom, h: marquee.h / cam.zoom }
      const hits = ws.elements
        .filter((el) => rectsIntersect(elementBounds(el), worldBox))
        .map((el) => el.id)
      const expanded = withGroupSiblings(ws.elements, hits)
      setSelection(e.shiftKey ? [...new Set([...selection, ...expanded])] : expanded)
    }

    setDraft(null)
    setMarquee(null)
    setBindHover(null)
    setEndpointDrag(false)
    dragRef.current = null
  }

  // begin dragging one endpoint of a selected arrow to (re)connect it
  const onArrowEndDown = (e: React.PointerEvent, id: string, end: 'from' | 'to') => {
    e.stopPropagation()
    rootRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { kind: 'arrowEnd', id, end, began: false }
    setEndpointDrag(true)
  }

  // begin dragging an arrow's midpoint handle to curve it
  const onCurveDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation()
    rootRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { kind: 'curveArrow', id, began: false }
  }

  // ---- drag-drop image files onto the canvas ----
  const onDrop = (e: React.DragEvent) => {
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    const world = screenToWorld(getPt(e), cam)
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result as string
      const img = new Image()
      img.onload = () => addImage(src, img.naturalWidth, img.naturalHeight, world.x, world.y)
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  // ---- quick insert (command launcher; leading slash optional) ----
  const handleInsert = (value: string, at: Point) => {
    const v = value.trim()
    if (!v) return
    const world = screenToWorld(at, cam)
    const body = v.startsWith('/') ? v.slice(1) : v
    const [head, ...restArr] = body.split(/\s+/)
    const rest = restArr.join(' ')
    const target = COMMAND_MAP[head.toLowerCase()]
    if (!target) return // unknown command → do nothing
    if (target === 'agent') {
      openAgentWizard({ x: world.x, y: world.y, agentPrompt: rest || undefined })
      return
    }
    const init: Partial<WidgetElement> = {}
    if (
      rest &&
      (target === 'editor' ||
        target === 'doc' ||
        target === 'log' ||
        target === 'data' ||
        target === 'plot')
    )
      init.path = rest
    if (rest && target === 'web') init.url = rest
    if (rest && target === 'runner') init.cmd = rest
    const id = spawnWidget(target, world.x, world.y, init)
    if (rest && target === 'note')
      mutateElement(id, (w) => {
        ;(w as WidgetElement).note = rest
      })
  }

  // screen-space selection rectangles for selected ink (widgets show their own border)
  const screenRectOf = (b: Rect): ScreenRect => {
    const tl = worldToScreen({ x: b.x, y: b.y }, cam)
    return { x: tl.x, y: tl.y, w: b.w * cam.zoom, h: b.h * cam.zoom }
  }
  const selBoxes = ws.elements
    .filter((el) => selSet.has(el.id) && el.type !== 'widget')
    .map((el) => ({ id: el.id, r: screenRectOf(elementBounds(el)) }))

  // a single selected resizable element gets corner transform handles
  const lone = selection.length === 1 ? byId.get(selection[0]) : undefined
  const handleEl =
    lone &&
    (lone.type === 'rect' ||
      lone.type === 'ellipse' ||
      lone.type === 'image' ||
      lone.type === 'frame') &&
    !lone.locked
      ? lone
      : undefined
  // a single selected connector gets draggable endpoints (to re-connect) and a
  // midpoint handle (to curve it)
  const arrowHandles =
    lone && lone.type === 'arrow' && !lone.locked ? resolvedArrow(lone, byId) : undefined
  // while wiring a connector (arrow tool, or re-dragging an endpoint), show
  // quick-connect anchor dots on every widget so targets are never a guess
  const showAnchors = tool === 'arrow' || endpointDrag
  const anchorWidgets = showAnchors
    ? ws.elements.filter((el): el is WidgetElement => el.type === 'widget')
    : []

  const vectorEls = ws.elements
    .filter(
      (el) =>
        el.type !== 'widget' && el.type !== 'text' && el.type !== 'image' && el.type !== 'frame',
    )
    .sort((a, b) => a.z - b.z)
    .map((el) => (el.type === 'arrow' ? resolvedArrow(el, byId) : el))
  const textImageEls = ws.elements
    .filter((el) => el.type === 'text' || el.type === 'image')
    .sort((a, b) => a.z - b.z)
  const frameEls = ws.elements.filter((el): el is FrameElement => el.type === 'frame')
  const draftFrame = draft?.type === 'frame' ? draft : null

  return (
    <div
      ref={rootRef}
      className={`canvas canvas--tool-${tool}${panning ? ' canvas--panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      style={{
        backgroundImage: 'radial-gradient(var(--grid-dot) 1px, transparent 1px)',
        backgroundSize: `${28 * cam.zoom}px ${28 * cam.zoom}px`,
        backgroundPosition: `${cam.x}px ${cam.y}px`,
      }}
    >
      {/* frames sit behind everything */}
      <div
        className="canvas__world canvas__frames"
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}
      >
        {[...frameEls, ...(draftFrame ? [draftFrame] : [])].map((f) => (
          <FrameView key={f.id} el={f} selected={selSet.has(f.id)} onPointerDown={onElementPointerDown} />
        ))}
      </div>

      {/* vector ink — full-size SVG so content always paints; the world
          transform lives on an inner <g> (a 0×0 svg + overflow doesn't render
          reliably in Chromium/WebView2) */}
      <svg className="canvas__vectors">
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.zoom})`}>
          {vectorEls.map((el) => (
            <ElementView key={el.id} el={el} />
          ))}
          {draft && draft.type !== 'frame' && <ElementView el={draft} />}
        </g>
      </svg>

      <div
        className="canvas__world"
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}
      >
        {textImageEls.map((el) =>
          el.type === 'text' ? (
            <TextElement
              key={el.id}
              el={el}
              selected={selSet.has(el.id)}
              onPointerDown={onElementPointerDown}
            />
          ) : el.type === 'image' ? (
            <ImageView key={el.id} el={el} onPointerDown={onElementPointerDown} />
          ) : null,
        )}
      </div>

      {/* widgets for every tab stay mounted so terminals/agents keep their
          live session across tab switches; only the active tab's layer shows */}
      {tabs.map((tab) => {
        const isActiveTab = tab.id === activeId
        const tabWidgets = tab.elements
          .filter((e): e is WidgetElement => e.type === 'widget')
          .sort((a, b) => a.z - b.z)
        if (!tabWidgets.length) return null
        return (
          <div
            key={tab.id}
            className="canvas__world"
            style={{
              transform: `translate(${tab.camera.x}px, ${tab.camera.y}px) scale(${tab.camera.zoom})`,
              // hidden (not display:none) so xterm keeps real dimensions and
              // renders correctly even on inactive tabs — it just stays invisible
              visibility: isActiveTab ? undefined : 'hidden',
            }}
          >
            {tabWidgets.map((el) => (
              <WidgetFrame
                key={el.id}
                el={el}
                selected={isActiveTab && selSet.has(el.id)}
                onStartMove={isActiveTab ? onWidgetStartMove : NOOP}
                visible={isActiveTab}
              />
            ))}
          </div>
        )
      })}

      {/* selection + marquee + handles + snap guides (screen space) */}
      <div className="overlay">
        {guides?.vx != null && (
          <div className="snap-guide snap-guide--v" style={{ left: worldToScreen({ x: guides.vx, y: 0 }, cam).x }} />
        )}
        {guides?.hy != null && (
          <div className="snap-guide snap-guide--h" style={{ top: worldToScreen({ x: 0, y: guides.hy }, cam).y }} />
        )}
        {selBoxes.map(({ id, r }) => (
          <div
            key={`sel-${id}`}
            className="sel-box"
            style={{ left: r.x - 3, top: r.y - 3, width: r.w + 6, height: r.h + 6 }}
          />
        ))}
        {handleEl &&
          (['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => {
            const b = screenRectOf(elementBounds(handleEl))
            const cx = corner === 'nw' || corner === 'sw' ? b.x : b.x + b.w
            const cy = corner === 'nw' || corner === 'ne' ? b.y : b.y + b.h
            return (
              <div
                key={corner}
                className={`sel-handle sel-handle--${corner}`}
                style={{ left: cx, top: cy }}
                onPointerDown={(e) => onHandleDown(e, handleEl.id, corner)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            )
          })}
        {/* quick-connect dots on every widget's corners + midpoints */}
        {anchorWidgets.map((el) =>
          ANCHORS.map((a, i) => {
            const s = worldToScreen(anchorPoint(el, a), cam)
            const active =
              bindHover?.id === el.id &&
              bindHover?.anchor?.nx === a.nx &&
              bindHover?.anchor?.ny === a.ny
            return (
              <div
                key={`anchor-${el.id}-${i}`}
                className={`arrow-anchor${active ? ' arrow-anchor--active' : ''}`}
                style={{ left: s.x, top: s.y }}
              />
            )
          }),
        )}

        {/* selected connector: endpoint handles + a midpoint curve handle */}
        {arrowHandles &&
          (() => {
            const p1 = worldToScreen({ x: arrowHandles.x1, y: arrowHandles.y1 }, cam)
            const p2 = worldToScreen({ x: arrowHandles.x2, y: arrowHandles.y2 }, cam)
            const apexW = arrowApex(
              { x: arrowHandles.x1, y: arrowHandles.y1 },
              { x: arrowHandles.x2, y: arrowHandles.y2 },
              arrowHandles.bend,
            )
            const ap = worldToScreen(apexW, cam)
            const id = arrowHandles.id
            return (
              <>
                <div
                  className="arrow-handle arrow-handle--end"
                  style={{ left: p1.x, top: p1.y }}
                  title="Drag to reconnect this end"
                  onPointerDown={(e) => onArrowEndDown(e, id, 'from')}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
                <div
                  className="arrow-handle arrow-handle--end"
                  style={{ left: p2.x, top: p2.y }}
                  title="Drag to reconnect this end"
                  onPointerDown={(e) => onArrowEndDown(e, id, 'to')}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
                <div
                  className="arrow-handle arrow-handle--curve"
                  style={{ left: ap.x, top: ap.y }}
                  title="Drag to curve"
                  onPointerDown={(e) => onCurveDown(e, id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </>
            )
          })()}

        {marquee && (
          <div
            className="sel-box sel-box--marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

      {insertAt && (
        <QuickInsert
          x={insertAt.x}
          y={insertAt.y}
          onSubmit={(value) => {
            handleInsert(value, insertAt)
            setInsertAt(null)
          }}
          onCancel={() => setInsertAt(null)}
        />
      )}
    </div>
  )
}

// union bounds of a set of elements (avoids importing boundsOfMany here)
function unionBounds(els: CanvasElement[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of els) {
    const b = elementBounds(el)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function ImageView({
  el,
  onPointerDown,
}: {
  el: ImageElement
  onPointerDown: (e: React.PointerEvent, id: string) => void
}) {
  return (
    <img
      className="image-el"
      src={el.src}
      draggable={false}
      alt=""
      style={{ left: el.x, top: el.y, width: el.w, height: el.h }}
      onPointerDown={(e) => onPointerDown(e, el.id)}
    />
  )
}

function FrameView({
  el,
  selected,
  onPointerDown,
}: {
  el: FrameElement
  selected: boolean
  onPointerDown: (e: React.PointerEvent, id: string) => void
}) {
  const setEditingText = useStore((s) => s.setEditingText)
  const editingId = useStore((s) => s.editingTextId)
  const mutate = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const editing = editingId === el.id
  return (
    <div
      className={`frame-el${selected ? ' frame-el--selected' : ''}`}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, borderColor: el.color }}
    >
      <div
        className="frame-el__label"
        style={{ color: el.color }}
        onPointerDown={(e) => onPointerDown(e, el.id)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          setEditingText(el.id)
        }}
      >
        {editing ? (
          <input
            className="frame-el__input"
            defaultValue={el.title}
            autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              beginHistory()
              mutate(el.id, (w) => {
                ;(w as FrameElement).title = e.target.value.trim() || 'frame'
              })
              setEditingText(null)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingText(null)
            }}
          />
        ) : (
          el.title
        )}
      </div>
    </div>
  )
}

function QuickInsert({
  x,
  y,
  onSubmit,
  onCancel,
}: {
  x: number
  y: number
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [hi, setHi] = useState(0)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  // show the menu while typing a command token (optional leading slash, no space yet)
  const tokenMatch = /^\/?(\S+)$/.exec(value)
  const matches = tokenMatch ? matchCommands(tokenMatch[1]) : []
  const active = matches.length ? Math.min(hi, matches.length - 1) : 0

  const choose = (cmd: QuickCommand, run: boolean) => {
    if (run) {
      onSubmit(cmd.name)
    } else {
      // complete to `<name> ` and keep editing (e.g. to add args)
      setValue(cmd.name + ' ')
      setHi(0)
      ref.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') return onCancel()
    if (matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        return setHi((active + 1) % matches.length)
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        return setHi((active - 1 + matches.length) % matches.length)
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        return choose(matches[active], false)
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        return choose(matches[active], true)
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onSubmit(value)
    }
  }

  return (
    <div className="quick-insert" style={{ left: x, top: y }}>
      <input
        ref={ref}
        className="quick-insert__input"
        placeholder="type a command — agent, term, files…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setHi(0)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={onCancel}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 && (
        <div className="quick-insert__menu">
          {matches.map((c, i) => (
            <div
              key={c.name}
              className={`quick-insert__item${i === active ? ' quick-insert__item--active' : ''}`}
              onMouseEnter={() => setHi(i)}
              // keep input focused (prevent blur) so onClick fires
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={() => choose(c, true)}
            >
              <span className="quick-insert__cmd">{c.name}</span>
              <span className="quick-insert__desc">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      <span className="quick-insert__hint">
        {matches.length ? '↑↓ select · ⇥ complete · ⏎ run · esc cancel' : '⏎ insert · esc cancel'}
      </span>
    </div>
  )
}
