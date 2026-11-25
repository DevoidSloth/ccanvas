import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hostOf, resolveAddress } from '../lib/weburl'
import { isDesktopMirror, forkIntoTerminal, openInClaude } from '../lib/desktopSessions'
import { useStore, selectActive, withGroupSiblings } from '../store/workspace'
import type {
  ArrowElement,
  Camera,
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
import { IconExternal, IconLayers } from '../ui/icons'
import { FocusStrip, FocusDividers } from '../ui/FocusStrip'
import { focusBox } from '../lib/view'
import { ElementView } from './ElementView'
import { TextElement } from './TextElement'
import {
  activeLayerElements,
  activeLayerId,
  hasLayers,
  layerNumber,
  layerOf,
  layersOf,
  MAX_LAYERS,
} from '../lib/layers'
import { previewSlots } from '../lib/spreadDrag'
import { WidgetFrame, pullOutOfSpread, type SpreadCard } from '../widgets/WidgetFrame'
import {
  SNAP_ENTER,
  SNAP_EXIT,
  SNAP_NEAR,
  overlapRatio,
  isHiddenMember,
  spreadCols,
  spreadRects,
  reuseStacks,
  stacksOf,
  stackOfId,
  withStackSiblings,
  type Stack,
} from '../lib/stacks'
import { trackSnap } from '../lib/snapMotion'
import { inEmacs } from '../lib/terminal'
import { IconStack } from '../ui/icons'

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
  { name: 'diff', target: 'diff', desc: 'git panel', aliases: ['git'] },
  { name: 'editor', target: 'editor', desc: 'file editor', aliases: ['edit', 'code'] },
  { name: 'note', target: 'note', desc: 'markdown note', aliases: ['md', 'markdown'] },
  { name: 'web', target: 'web', desc: 'web page', aliases: ['browser', 'url', 'site'] },
  { name: 'music', target: 'nowplaying', desc: 'now playing', aliases: ['nowplaying', 'spotify', 'song'] },
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

// a 12px "+" in the top-left of each 140px tile, centred on a grid dot
const REGISTRATION_CROSS = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><path d='M7 1v12M1 7h12' stroke='rgb(250,249,245)' stroke-opacity='0.09' stroke-width='1'/></svg>",
)}")`

/** a terminal/agent widget that isn't the one currently clicked into */
function isIdleTerminal(node: HTMLElement | null): boolean {
  const id = node?.dataset.widgetId
  if (!id) return false
  const st = useStore.getState()
  if (st.activeWidgetId === id) return false
  const ws = selectActive(st)
  const el = ws.elements.find((e) => e.id === id)
  return (
    el?.type === 'widget' &&
    (el.kind === 'terminal' || el.kind === 'agent') &&
    layerOf(el) === activeLayerId(ws)
  )
}

/** set while a spread card's wheel is re-sent to its content, so the canvas lets it by */
let forwardingWheel = false
/** the scroller a forwarded gesture last moved: momentum stays on it, as native scrolling latches */
let wheelLatch: { node: Element; t: number } | null = null

const SCROLLS = /^(auto|scroll|overlay)$/
function canScroll(n: Element, dx: number, dy: number): boolean {
  const s = getComputedStyle(n)
  const y =
    dy !== 0 &&
    SCROLLS.test(s.overflowY) &&
    (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)
  const x =
    dx !== 0 &&
    SCROLLS.test(s.overflowX) &&
    (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0)
  return x || y
}

/** A spread card's hit layer sits over its body (clicks choose, drags reorder),
 *  so the wheel lands there instead of on the widget. Re-send it to what's under
 *  the pointer: widgets that scroll themselves (xterm, Monaco) cancel the copy;
 *  otherwise move the nearest native scroller, as the browser would have. */
function forwardSpreadWheel(e: WheelEvent, card: HTMLElement) {
  const under = document
    .elementsFromPoint(e.clientX, e.clientY)
    .find((n) => card.contains(n) && !n.classList.contains('widget__spread-hit'))
  if (!under) return
  const copy = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    composed: true,
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    buttons: e.buttons,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
  })
  forwardingWheel = true
  let taken: boolean
  try {
    taken = !under.dispatchEvent(copy)
  } finally {
    forwardingWheel = false
  }
  if (taken) return
  let dx = e.deltaX
  let dy = e.deltaY
  if (e.deltaMode === 1) {
    dx *= 16
    dy *= 16
  } else if (e.deltaMode === 2) {
    dx *= card.clientWidth
    dy *= card.clientHeight
  }
  // the card is scaled down: scroll in its own pixels so content tracks the finger
  const k = card.getBoundingClientRect().width / (card.offsetWidth || 1) || 1
  dx /= k
  dy /= k
  const now = performance.now()
  let sc: Element | null =
    wheelLatch && now - wheelLatch.t < 150 && card.contains(wheelLatch.node) ? wheelLatch.node : null
  for (let n: Element | null = under; !sc && n && card.contains(n); n = n.parentElement) {
    if (canScroll(n, dx, dy)) sc = n
  }
  if (!sc) return
  wheelLatch = { node: sc, t: now }
  sc.scrollBy({ left: dx, top: dy, behavior: 'instant' })
}

/** The world layers' CSS transform. The translate is snapped to whole device
 *  pixels: a fractional offset puts every glyph between pixels, which blurs
 *  text, most visibly on 1x displays. (Under ½ px, so hit-testing is unaffected.) */
function worldTransform(cam: Camera): string {
  const dpr = window.devicePixelRatio || 1
  const snap = (v: number) => Math.round(v * dpr) / dpr
  return `translate(${snap(cam.x)}px, ${snap(cam.y)}px) scale(${cam.zoom})`
}

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
  // once the layers overview has settled, the live canvas is hidden (still
  // mounted). Not while it animates in: hiding every widget in the frame the
  // tilt starts made that frame slow, and the overview's backdrop covers it.
  const overview = useStore((s) => s.layerOverview === 'open')
  const spread = useStore((s) => s.spread)
  const focus = useStore((s) => s.focus)
  const stackDrop = useStore((s) => s.stackDrop)
  // snap-to-stack: one beat of "locked" brackets after a drop stacks
  const [snapLock, setSnapLock] = useState<{ box: Rect; label: string } | null>(null)

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
  // Promote the world layers to GPU textures only while the camera moves. A
  // permanently promoted layer is rasterized once and then scaled, so text
  // stayed blurry at any zoom but 100%; at rest it is now repainted crisp.
  const [camMoving, setCamMoving] = useState(false)
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstCam = useRef(true)
  useEffect(() => {
    if (firstCam.current) {
      firstCam.current = false
      return
    }
    setCamMoving(true)
    if (settleRef.current) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(() => setCamMoving(false), 200)
  }, [cam.x, cam.y, cam.zoom])
  useEffect(() => () => {
    if (settleRef.current) clearTimeout(settleRef.current)
  }, [])
  const worldCls = camMoving ? 'canvas__world canvas__world--moving' : 'canvas__world'

  // Camera writes are batched to one per animation frame: a trackpad sends
  // several wheel events per frame, and each store write re-renders the canvas.
  // `pendingCam` is the newest camera not yet written, so deltas accumulate.
  const pendingCam = useRef<Camera | null>(null)
  const camRaf = useRef(0)
  const scheduleCamera = useCallback(
    (c: Camera) => {
      pendingCam.current = c
      if (camRaf.current) return
      camRaf.current = requestAnimationFrame(() => {
        camRaf.current = 0
        const next = pendingCam.current
        pendingCam.current = null
        if (next) setCamera(next)
      })
    },
    [setCamera],
  )
  useEffect(() => () => cancelAnimationFrame(camRaf.current), [])
  const selSet = new Set(selection)
  // every element (arrows resolve their bound ends through this) …
  const byId = new Map(ws.elements.map((e) => [e.id, e]))
  // … but only the layer being shown is drawn, picked, snapped to or selected
  const els = activeLayerElements(ws)
  const layered = hasLayers(ws)
  const curLayer = activeLayerId(ws)
  // per tab: the stacks of its elements, reused while those elements are
  // unchanged, so memoised widgets see the same stack object frame to frame
  const stackCache = useRef(new Map<string, { elements: CanvasElement[]; stacks: Map<string, Stack> }>())
  const stacksFor = (tabId: string, elements: CanvasElement[]) => {
    const hit = stackCache.current.get(tabId)
    if (hit?.elements === elements) return hit.stacks
    const stacks = reuseStacks(hit?.stacks, stacksOf(elements))
    stackCache.current.set(tabId, { elements, stacks })
    return stacks
  }
  const stacks = stacksFor(ws.id, ws.elements)

  const getPt = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ---- Space → spread a selected stack, else quick insert ----
  useEffect(() => {
    // the stack to spread: the selected widget's, or the active one's. A
    // selection that is all one stack (a box-select picks up hidden members) counts.
    const stackToSpread = () => {
      const st = useStore.getState()
      const ids = st.selection.length ? st.selection : st.activeWidgetId ? [st.activeWidgetId] : []
      if (!ids.length) return null
      const stk = stackOfId(selectActive(st).elements, ids[0])
      if (!stk) return null
      const members = new Set(stk.members.map((m) => m.id))
      return ids.every((id) => members.has(id)) ? stk : null
    }
    // Is this keypress going to something you're typing in? Focus can linger in
    // a terminal or editor you've already clicked out of (its widget is no
    // longer active); that stale focus is dropped instead of eating the key.
    const typingIn = (t: HTMLElement, activeId: string | null) => {
      const editable =
        t.isContentEditable ||
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.closest('.xterm') != null
      if (!editable) return false
      // only terminals and code editors hold on to focus after you click away;
      // any other field you're in is real typing
      const sticky = t.closest('.xterm, .monaco-editor') != null
      const host = t.closest<HTMLElement>('[data-widget-id]')
      if (sticky && host && host.dataset.widgetId !== activeId) {
        t.blur()
        return false
      }
      return true
    }
    // ⌥Space spreads the stack you're in even while typing in it (capture, so
    // it beats the terminal); a terminal running emacs keeps the key
    const onAltSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !e.altKey || e.metaKey || e.ctrlKey) return
      const st = useStore.getState()
      if (st.spread || st.layerOverview || inEmacs(e.target)) return
      const stk = stackToSpread()
      if (!stk) return
      e.preventDefault()
      e.stopImmediatePropagation()
      st.openSpread(stk.id)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.altKey || e.metaKey || e.ctrlKey) return
      const st0 = useStore.getState()
      if (st0.spread || st0.layerOverview) return
      if (typingIn(e.target as HTMLElement, st0.activeWidgetId)) return
      const stk = stackToSpread()
      if (stk) {
        e.preventDefault()
        st0.openSpread(stk.id)
        return
      }
      // a focused widget wants the space for itself
      if (st0.activeWidgetId) return
      e.preventDefault()
      const r = rootRef.current?.getBoundingClientRect()
      const fallback = r ? { x: r.width / 2, y: r.height / 2 } : { x: 0, y: 0 }
      setInsertAt(mouseRef.current ?? fallback)
    }
    window.addEventListener('keydown', onAltSpace, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onAltSpace, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // ---- spread view: keys (capture, so nothing else sees them while it's open) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const sp = st.spread
      if (!sp || sp.closing || e.metaKey || e.ctrlKey) return
      const stk = stacksOf(selectActive(st).elements).get(sp.stackId)
      if (!stk) return
      const n = stk.members.length
      const cols = spreadCols(n, rootRef.current?.clientWidth ?? window.innerWidth)
      const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key]
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) st.closeSpread(stk.members[Number(e.key) - 1].id)
      else if (move && e.shiftKey) {
        // ⇧ + arrow carries the highlighted card to a new spot in the stack
        const to = clamp(sp.hi + move, 0, n - 1)
        if (to !== sp.hi) {
          const ids = stk.members.map((m) => m.id)
          const [id] = ids.splice(sp.hi, 1)
          ids.splice(to, 0, id)
          st.beginHistory()
          st.reorderStack(stk.id, ids)
          st.setSpreadHi(to)
        }
      } else if (move) st.setSpreadHi(clamp(sp.hi + move, 0, n - 1))
      else if (e.key === 'Enter' || e.key === ' ') st.closeSpread(stk.members[sp.hi]?.id ?? null)
      else if (e.key === 'Escape') st.closeSpread(null)
      else if (e.key === 'x' || e.key === 'X') pullOutOfSpread(stk.members[sp.hi].id)
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // focus mode: the focus box follows the window size
  useEffect(() => {
    const onResize = () => {
      if (useStore.getState().focus) useStore.getState().setFocusBox(focusBox())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // a spread whose stack vanished (undo, delete) just closes
  const spreadGone = !!spread && !stacksOf(ws.elements).has(spread.stackId)
  useEffect(() => {
    if (spreadGone) useStore.setState({ spread: null })
  }, [spreadGone])

  // ---- native wheel (non-passive): smooth zoom + pan ----
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const onWheel = (e: WheelEvent) => {
      // the spread view holds the camera still; a plain scroll over a card
      // scrolls that widget's content
      const sp = useStore.getState().spread
      if (sp) {
        if (forwardingWheel) return
        e.preventDefault()
        e.stopPropagation()
        if (e.ctrlKey || e.metaKey || sp.closing) return
        const card = (e.target as HTMLElement | null)?.closest?.('.widget--spread') as HTMLElement | null
        if (card) forwardSpreadWheel(e, card)
        return
      }
      // focus mode: the focused widget scrolls itself; the dimmed board doesn't move
      if (useStore.getState().focus) {
        if (!(e.target as HTMLElement | null)?.closest?.('.widget--focus')) e.preventDefault()
        return
      }
      const zoomGesture = e.ctrlKey || e.metaKey
      const widgetNode = (e.target as HTMLElement | null)?.closest?.('.widget') as HTMLElement | null
      const overWidget = !!widgetNode
      // plain scroll over a widget → let that widget scroll its own content,
      // except a terminal you haven't clicked into: that scroll moves the canvas
      if (overWidget && !zoomGesture && !isIdleTerminal(widgetNode)) return
      e.preventDefault()
      // zooming while hovering a widget: don't also scroll the widget under it
      if (overWidget) e.stopPropagation()
      const live = pendingCam.current ?? selectActive(useStore.getState()).camera
      const pt = getPt(e)
      // normalise delta across line / page wheel modes
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      else if (e.deltaMode === 2) dy *= node.clientHeight
      if (zoomGesture) {
        // gentle per-event step, clamped so a single notch never jumps far
        const factor = Math.exp(-clamp(dy, -100, 100) * 0.0017)
        scheduleCamera(zoomAt(live, pt, live.zoom * factor))
      } else {
        scheduleCamera({ ...live, x: live.x - e.deltaX, y: live.y - e.deltaY })
      }
    }
    // capture phase so we can intercept before the widget when zooming
    node.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => node.removeEventListener('wheel', onWheel, { capture: true })
  }, [scheduleCamera])

  // topmost vector under a world point (text/images/frames/widgets self-pick)
  const pickVector = (world: Point): CanvasElement | null => {
    const tol = 6 / cam.zoom
    let best: CanvasElement | null = null
    for (const el of els) {
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
    for (const el of els) {
      if (isHiddenMember(el, stacks)) continue
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
      if (w.kind === 'terminal' || w.kind === 'agent') {
        items.push({ label: 'Label…', onClick: () => s().setLabelingWidget(w.id) })
        items.push({ separator: true })
      }
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
      items.push({ separator: true })
    }
    // a desktop-app mirror → fork it into a terminal. Never `--resume` the id
    // itself: the desktop app is still writing that transcript.
    if (lone?.type === 'widget' && isDesktopMirror(lone)) {
      const mirror = lone
      if (mirror.desktopId)
        items.push({ label: 'Open in Claude app', onClick: () => void openInClaude(mirror) })
      items.push({
        label: 'Fork into terminal',
        onClick: () => void forkIntoTerminal(mirror),
      })
      items.push({ separator: true })
    }
    // stacks
    const selWidgets = selEls.filter((e): e is WidgetElement => e.type === 'widget')
    const loneStack = lone?.type === 'widget' ? stacks.get((lone as WidgetElement).stackId ?? '') : undefined
    if (loneStack) {
      items.push({ label: 'Spread stack', hint: 'Space', onClick: () => s().openSpread(loneStack.id) })
      items.push({
        label: 'Take out of stack',
        onClick: () => {
          s().beginHistory()
          s().unstackWidget(lone!.id)
        },
      })
      items.push({
        label: 'Unstack all',
        hint: 'U',
        onClick: () => {
          s().beginHistory()
          s().unstackAll(loneStack.id)
        },
      })
      items.push({ separator: true })
    } else if (selWidgets.length >= 2 && !anyLocked) {
      items.push({ label: 'Stack', hint: 'S', onClick: () => s().stackSelection() })
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
    // Move to layer ▸ (flat: the menu has no submenus). x/y stay put.
    const ids = selEls.map((e) => e.id)
    if (layered)
      layersOf(ws).forEach((l, i) => {
        if (l.id === curLayer) return
        items.push({
          label: `Move to ${layerNumber(i)} · ${l.name}`,
          icon: <IconLayers />,
          onClick: () => s().moveToLayer(ids, l.id),
        })
      })
    if (layersOf(ws).length < MAX_LAYERS)
      items.push({
        label: 'Move to new layer…',
        icon: <IconLayers />,
        onClick: () =>
          void s()
            .newLayerWithPicker()
            .then((id) => id && s().moveToLayer(ids, id)),
      })
    items.push({ separator: true })
    items.push({ label: 'Bring to front', hint: '⌘]', onClick: () => s().bringToFront(s().selection) })
    items.push({ label: 'Send to back', hint: '⌘[', onClick: () => s().sendToBack(s().selection) })
    items.push({ separator: true })
    // ⌫ never deletes a widget, so the hint only shows when it would do this
    const hasWidget = selectActive(s()).elements.some((e) => e.type === 'widget' && s().selection.includes(e.id))
    items.push({
      label: 'Delete',
      hint: hasWidget ? undefined : '⌫',
      danger: true,
      onClick: () => s().deleteSelection(),
    })
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
          st.setSelection(activeLayerElements(selectActive(st)).map((el) => el.id))
        },
      },
    ]
    items.push({ separator: true })
    items.push({
      label: 'Layers overview',
      hint: 'L',
      icon: <IconLayers />,
      onClick: () => useStore.getState().setLayerOverview(true),
    })
    if (layersOf(ws).length < MAX_LAYERS)
      items.push({
        label: 'New layer…',
        icon: <IconLayers />,
        onClick: () => void useStore.getState().newLayerWithPicker({ activate: true }),
      })
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
        : withGroupSiblings(els, [picked.id])
      if (selIds !== cur) setSelection(selIds)
      const selEls = els.filter((el) => selIds.includes(el.id))
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
    for (const el of els) {
      if (el.id === excludeId || !BINDABLE.has(el.type) || isHiddenMember(el, stacks)) continue
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
    const hits = els
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
    setSelection(withGroupSiblings(els, next))
    setActiveWidget(null)
    startMoveDrag(e)
  }

  // widget frames pre-select themselves, then ask us to begin the move drag.
  // Kept identity-stable (via a ref) so memoised WidgetFrames don't re-render.
  const startMoveRef = useRef<(e: React.PointerEvent) => void>(() => {})
  startMoveRef.current = (e: React.PointerEvent) => {
    setActiveWidget(null)
    setSelection(withGroupSiblings(els, useStore.getState().selection))
    startMoveDrag(e)
  }
  const onWidgetStartMove = useCallback((e: React.PointerEvent) => startMoveRef.current(e), [])

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
        setSelection(withGroupSiblings(els, base))
        startMoveDrag(e)
      } else if (e.shiftKey) {
        // shift-drag on empty canvas: box-select
        dragRef.current = { kind: 'marquee', start: pt }
        setMarquee({ x: pt.x, y: pt.y, w: 0, h: 0 })
        rootRef.current?.setPointerCapture(e.pointerId)
      } else {
        // plain drag on empty canvas moves the view
        clearSelection()
        dragRef.current = { kind: 'pan', startCam: { x: cam.x, y: cam.y }, startPtr: pt }
        rootRef.current?.setPointerCapture(e.pointerId)
        setPanning(true)
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
        scheduleCamera({
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
        // alignment-guide snapping against non-moving elements (a stack
        // moves as one, so its hidden members aren't snap targets)
        const movingIds = withStackSiblings(ws.elements, useStore.getState().selection)
        const moving = els.filter((el) => movingIds.has(el.id))
        if (moving.length) {
          const mb = unionBounds(moving)
          const target = { x: mb.x + dx, y: mb.y + dy, w: mb.w, h: mb.h }
          const others = els
            .filter((el) => !movingIds.has(el.id))
            .map(elementBounds)
          const snap = snapBox(target, others, 6 / cam.zoom)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides({ vx: snap.vx, hy: snap.hy })
        }
        moveSelection(dx, dy)
        drag.last = { x: drag.last.x + dx, y: drag.last.y + dy }
        // snap-to-stack (⌘ while dragging turns it off); a snapped widget
        // ignores the alignment guides
        if (updateStackDrop(e.metaKey || e.ctrlKey) === 'snap') setSnapGuides(null)
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
          const others = els.filter((e) => e.id !== drag.id).map(elementBounds)
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

  // ---- snap-to-stack ----
  // Dragging one widget (or one stack) mostly over another snaps it on (see
  // lib/stacks.ts for the thresholds, lib/snapMotion.ts for the motion);
  // releasing while snapped stacks them. Plain overlap stays plain overlap
  // below the threshold, and ⌘ turns snapping off for the drag.
  const clearStackDrop = () => useStore.getState().setStackDrop(null)
  const updateStackDrop = (noSnap: boolean): 'near' | 'snap' | null => {
    const st = useStore.getState()
    const tab = selectActive(st)
    const all = tab.elements
    const moving = withStackSiblings(all, st.selection)
    const movingEls = all.filter((el) => moving.has(el.id))
    const units = new Set(movingEls.map((el) => (el.type === 'widget' && el.stackId) || el.id))
    // only a single widget or a single stack can be stacked onto something
    if (noSnap || !movingEls.length || units.size !== 1 || movingEls.some((el) => el.type !== 'widget' || el.locked)) {
      clearStackDrop()
      return null
    }
    const stks = stacksOf(all)
    // the visible one first, so it stays in front after stacking
    const sourceEls = [...movingEls].sort(
      (a, b) => (isHiddenMember(a, stks) ? 1 : 0) - (isHiddenMember(b, stks) ? 1 : 0),
    ) as WidgetElement[]
    const src = sourceEls[0]
    let target: WidgetElement | null = null
    let best = 0
    for (const el of activeLayerElements(tab)) {
      if (el.type !== 'widget' || moving.has(el.id) || el.locked || isHiddenMember(el, stks)) continue
      const r = overlapRatio(src, el)
      if (r > best || (r === best && target && r > 0 && el.z > target.z)) {
        target = el
        best = r
      }
    }
    const cur = st.stackDrop
    const holding = cur?.phase === 'snap' && !!target && cur.targetId === target.id
    const sourceIds = sourceEls.map((el) => el.id)
    let phase: 'near' | 'snap' | null = null
    if (target && (best >= SNAP_ENTER || (holding && best >= SNAP_EXIT))) phase = 'snap'
    else if (target && best >= SNAP_NEAR) phase = 'near'
    if (!phase || !target) {
      clearStackDrop()
      return null
    }
    const progress = phase === 'snap' ? 1 : Math.min(1, (best - SNAP_NEAR) / (SNAP_ENTER - SNAP_NEAR))
    st.setStackDrop({ sourceIds, targetId: target.id, phase, progress })
    trackSnap(src.id)
    return phase
  }

  // ⌘ pressed/released mid-drag re-decides the snap; Esc cancels the drag
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const drag = dragRef.current
      if (drag?.kind !== 'move' || !drag.began) return
      if (e.key === 'Escape' && e.type === 'keydown') {
        e.preventDefault()
        e.stopImmediatePropagation()
        dragRef.current = null
        useStore.getState().setStackDrop(null)
        useStore.getState().setSnapGuides(null)
        useStore.getState().endFrameDrag()
        // the drag took an undo snapshot when it began: going back to it puts
        // everything where it started
        useStore.getState().undo()
        return
      }
      if (e.key === 'Meta' || e.key === 'Control') updateStackDrop(e.type === 'keydown')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  })

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const drop = useStore.getState().stackDrop
    clearStackDrop()
    // released while snapped → stack (the move already took the undo snapshot)
    if (drag?.kind === 'move' && drop?.phase === 'snap') {
      const st = useStore.getState()
      const tgt = byId.get(drop.targetId)
      const inStack = tgt?.type === 'widget' ? stacks.get(tgt.stackId ?? '') : undefined
      if (st.stackWidgets(drop.sourceIds, drop.targetId) && tgt?.type === 'widget') {
        setSnapLock({ box: { x: tgt.x, y: tgt.y, w: tgt.w, h: tgt.h }, label: inStack ? `Added to ${inStack.title}` : 'Stacked' })
        window.setTimeout(() => setSnapLock(null), 450)
      }
    }
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
      const hits = els
        .filter((el) => rectsIntersect(elementBounds(el), worldBox))
        .map((el) => el.id)
      const expanded = withGroupSiblings(els, hits)
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
    if (rest && target === 'web') {
      const a = resolveAddress(rest)
      if (a?.kind === 'file') init.path = a.path
      else if (a) {
        init.url = a.url
        init.title = a.search ?? hostOf(a.url)
      }
    }
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
  const selBoxes = els
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
    ? els.filter((el): el is WidgetElement => el.type === 'widget')
    : []

  // an arrow whose bound end sits on another layer isn't drawn (v1: no stubs)
  const endHere = (b?: { id: string }) => {
    const t = b && byId.get(b.id)
    return !t || layerOf(t) === curLayer
  }
  const vectorEls = els
    .filter(
      (el) =>
        el.type !== 'widget' &&
        el.type !== 'text' &&
        el.type !== 'image' &&
        el.type !== 'frame' &&
        (el.type !== 'arrow' || !layered || (endHere(el.from) && endHere(el.to))),
    )
    .sort((a, b) => a.z - b.z)
    .map((el) => (el.type === 'arrow' ? resolvedArrow(el, byId) : el))
  const textImageEls = els
    .filter((el) => el.type === 'text' || el.type === 'image')
    .sort((a, b) => a.z - b.z)
  const frameEls = els.filter((el): el is FrameElement => el.type === 'frame')

  // ---- stacks: spread view + drop pad ----
  const viewW = rootRef.current?.clientWidth ?? window.innerWidth
  const viewH = rootRef.current?.clientHeight ?? window.innerHeight
  const spreadStack: Stack | undefined = spread ? stacks.get(spread.stackId) : undefined
  const spreadCards = new Map<string, SpreadCard>()
  if (spread && spreadStack) {
    const f = spreadStack.front
    const n = spreadStack.members.length
    const aspect = f.w / Math.max(1, f.h)
    const rects = spreadRects(n, viewW, viewH, aspect)
    // while a card is dragged the others show where they'd go; the dragged
    // card keeps its own slot and is moved from there by the pointer. One
    // being pulled out leaves the rest to close up as a spread of their own.
    const drag = spread.drag
    const slots = previewSlots(spreadStack.members.map((m) => m.id), drag)
    const rest = drag && drag.to == null ? spreadRects(n - 1, viewW, viewH, aspect) : rects
    spreadStack.members.forEach((m, i) => {
      const at = slots.get(m.id)!
      const r = m.id === drag?.id ? rects[at.base] : rest[at.base]
      spreadCards.set(m.id, {
        tx: (r.x - cam.x) / cam.zoom - m.x,
        ty: (r.y - cam.y) / cam.zoom - m.y,
        k: r.w / cam.zoom / m.w,
        index: i,
        slot: at.slot,
        hi: i === spread.hi,
        closing: spread.closing,
        front: m.id === f.id,
      })
    })
  }
  const dropTarget =
    stackDrop && byId.get(stackDrop.targetId)?.type === 'widget'
      ? (byId.get(stackDrop.targetId) as WidgetElement)
      : null
  const draftFrame = draft?.type === 'frame' ? draft : null

  return (
    <div
      ref={rootRef}
      className={`canvas canvas--tool-${tool}${panning ? ' canvas--panning' : ''}${
        overview ? ' canvas--overview' : ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      style={{
        // fine dot grid, plus a registration cross every 5 cells
        backgroundImage: `${REGISTRATION_CROSS}, radial-gradient(var(--grid-dot) 1px, transparent 1px)`,
        backgroundSize: `${140 * cam.zoom}px ${140 * cam.zoom}px, ${28 * cam.zoom}px ${28 * cam.zoom}px`,
        backgroundPosition: `${cam.x - 7 * cam.zoom}px ${cam.y - 7 * cam.zoom}px, ${cam.x}px ${cam.y}px`,
      }}
    >
      {/* frames sit behind everything */}
      <div
        className={`${worldCls} canvas__frames`}
        style={{ transform: worldTransform(cam) }}
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
        className={worldCls}
        style={{ transform: worldTransform(cam) }}
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
        // kept in creation order and stacked with z-index (WidgetFrame), not
        // sorted by z: re-sorting would move a clicked widget's DOM node to the
        // end, which resets every scroll position inside it and reloads iframes
        const tabStacks = isActiveTab ? stacks : stacksFor(tab.id, tab.elements)
        const tabWidgets = tab.elements.filter((e): e is WidgetElement => e.type === 'widget')
        if (!tabWidgets.length) return null
        const tabLayer = activeLayerId(tab)
        return (
          <div
            key={tab.id}
            className={worldCls}
            style={{
              transform: worldTransform(tab.camera),
              // hidden (not display:none) so xterm keeps real dimensions and
              // renders correctly even on inactive tabs — it just stays invisible
              visibility: isActiveTab ? undefined : 'hidden',
            }}
          >
            {tabWidgets.map((el) => {
              // a widget on another layer stays mounted (its shell, agent or
              // iframe keeps running) and is hidden per card: switching layers
              // is a class toggle, never a re-parent or remount
              const shown = isActiveTab && layerOf(el) === tabLayer
              return (
                <WidgetFrame
                  key={el.id}
                  el={el}
                  selected={shown && selSet.has(el.id)}
                  onStartMove={shown ? onWidgetStartMove : NOOP}
                  visible={shown}
                  tabShown={isActiveTab}
                  stack={el.stackId ? tabStacks.get(el.stackId) : undefined}
                  spreadCard={shown ? spreadCards.get(el.id) : undefined}
                />
              )
            })}
            {isActiveTab && focus && (
              <>
                <div
                  className={`focus-scrim${focus.id ? '' : ' focus-scrim--closing'}`}
                  style={{
                    left: -cam.x / cam.zoom,
                    top: -cam.y / cam.zoom,
                    width: viewW / cam.zoom,
                    height: viewH / cam.zoom,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    if (e.button === 0) useStore.getState().exitFocus()
                  }}
                />
                {(() => {
                  // a dashed outline where the focused widget lives on the canvas
                  const home = focus.id ? byId.get(focus.id) : undefined
                  if (!home || home.type !== 'widget') return null
                  return (
                    <div
                      className="focus-socket"
                      style={{ left: home.x, top: home.y, width: home.w, height: home.h }}
                    />
                  )
                })()}
              </>
            )}
            {isActiveTab && spreadStack && (
              <div
                className={`stack-scrim${spread?.closing ? ' stack-scrim--closing' : ''}${
                  spread?.drag && spread.drag.to == null ? ' stack-scrim--pull' : ''
                }`}
                style={{
                  left: -cam.x / cam.zoom,
                  top: -cam.y / cam.zoom,
                  width: viewW / cam.zoom,
                  height: viewH / cam.zoom,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  useStore.getState().closeSpread(null)
                }}
                onWheel={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )
      })}

      {/* selection + marquee + handles + snap guides (screen space) */}
      <div className="overlay">
        <FocusStrip />
        <FocusDividers />
        {(dropTarget || snapLock) && (() => {
          const box = snapLock ? snapLock.box : dropTarget!
          const r = screenRectOf(box)
          const snapped = !!snapLock || stackDrop?.phase === 'snap'
          // near: brackets hover outside the target and close in as the overlap grows
          const near = !snapped ? (stackDrop?.progress ?? 0) : 1
          const inStack = dropTarget ? stacks.get(dropTarget.stackId ?? '') : undefined
          const label = snapLock
            ? snapLock.label
            : inStack
              ? `Add to ${inStack.title}`
              : `Stack on ${dropTarget!.title}`
          return (
            <div
              key="snap-frame"
              className={`snap-frame${snapped ? ' snap-frame--snap' : ''}${snapLock ? ' snap-frame--lock' : ''}`}
              style={
                {
                  left: r.x,
                  top: r.y,
                  width: r.w,
                  height: r.h,
                  '--o': `${snapped ? 4 : 18 - 12 * near}px`,
                  opacity: snapped ? 1 : 0.3 + 0.5 * near,
                } as React.CSSProperties
              }
            >
              <i className="snap-frame__c snap-frame__c--tl" />
              <i className="snap-frame__c snap-frame__c--tr" />
              <i className="snap-frame__c snap-frame__c--bl" />
              <i className="snap-frame__c snap-frame__c--br" />
              <span className="snap-frame__chip">
                <span className="snap-frame__chip-icon">
                  <IconStack />
                </span>
                {label}
              </span>
            </div>
          )
        })()}
        {spreadStack && (
          <div className={`spread-head${spread?.closing ? ' spread-head--closing' : ''}`}>
            <span className="spread-head__name">
              <span className="spread-head__icon">
                <IconStack />
              </span>
              {spreadStack.title}
              <small>{spreadStack.members.length} widgets</small>
            </span>
            <span className="spread-head__keys">
              <span><kbd>1</kbd>–<kbd>{Math.min(9, spreadStack.members.length)}</kbd> focus</span>
              <span><kbd>←</kbd><kbd>→</kbd> move</span>
              <span>drag or <kbd>⇧</kbd><kbd>←</kbd><kbd>→</kbd> reorder</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>X</kbd> pull out</span>
              <span><kbd>esc</kbd> close</span>
            </span>
          </div>
        )}
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
