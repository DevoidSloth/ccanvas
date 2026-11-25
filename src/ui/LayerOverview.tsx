import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, RECENT_FINISH_MS } from '../lib/agents'
import type { Camera, CanvasElement, WidgetElement } from '../lib/types'
import {
  OV,
  BASE_LAYER_ID,
  MAX_LAYERS,
  activeLayerId,
  clamp01,
  coveredLabels,
  easeOut,
  labelYs,
  landingCamera,
  layerDir,
  layerNumber,
  layerOf,
  layerStatus,
  layersOf,
  lerp,
  lerpCam,
  matchesQuery,
  midEllipsis,
  mixPose,
  ovAnchor,
  ovFit,
  ovFlat,
  ovLayout,
  ovPoses,
  ovText,
  readingOrder,
  shortPath,
  springStep,
  type LedStatus,
  type OvLayout,
  type Pose,
} from '../lib/layers'
import { StatusGlyph } from '../widgets/widgetIcons'
import { IconLayers } from './icons'
import {
  layersPerf,
  PERF_TOOLS,
  runBench,
  sampleTransition,
  setPerfOn,
  subscribePerf,
  summary,
  type PerfRun,
} from '../lib/layersPerf'
import { isHiddenMember, stacksOf } from '../lib/stacks'
import { LayerProxy, type ProxyMode } from './LayerProxy'
import '../styles/layers.css'

// The layers overview: the canvas pulls back into a deck of every layer on
// this tab, which opens into an accordion. Mounted only while open (App.tsx), so it costs
// nothing otherwise: no listeners, timers or rAF.
//
// One float, the open position, follows a spring and drives every sheet: each
// sheet's pose is a function of its distance from it (lib/layers.ts →
// ovPose). React renders the structure (sheets, tiles, rail text); a rAF loop
// writes transforms and opacities to refs, and only while something moves.
// Nothing else animates: no layout, no filters.
//
// Phases: fly → live → dive → handover → unmount, or live → fly → unmount.
// Fly is opening and closing as one reversible move (see `fly`): each tile
// fades in over its live widget, at the same pixel spot and looking like it,
// so the canvas stands still while its widgets dim to blocks; then the
// canvas pulls back into the accordion and, as it settles, its text washes
// in. Closing runs back down the same path, ending with the tiles
// crossfading into the real, already-mounted (and already painted) widgets
// under them: one opacity on the sheet's content, after the backdrop has
// gone, so nothing on the canvas repaints and nothing dips. L turns it
// around at any moment, from wherever it is. A dive flies the chosen sheet
// flat, then hands over the same way.
//
// Text arrives and leaves as a wash, never all at once: each tile's text
// fades in turn (--w, in reading order), and out the same way (layers.css).

const T = {
  preroll: 80, // the tiles crossfade in over the widgets (and back, uncovering)
  intro: 340, // the pull-back, the whole way (shorter from part way)
  outro: 300,
  washIn: 180,
  washOut: 90,
  uncover: 100, // a reopen takes the crossfade back
  dive: 320,
  handover: 180, // the tiles crossfade into the real widgets
  fade: 120, // reduced motion: crossfades only
  hover: 70,
  snap: 140,
  born: 380,
}
const PROXY_CAP = 60 // per sheet; past this, blocks only
const RAIL_W0 = 214
const VIEW_KEY = 'ccanvas:layers:view'
/** localStorage: a slow-motion factor for judging the motion (e.g. "4") */
const SLOW_KEY = 'ccanvas:layers:slow'
function slowFactor(): number {
  if (!PERF_TOOLS) return 1
  try {
    const v = parseFloat(localStorage.getItem(SLOW_KEY) ?? '')
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 20) : 1
  } catch {
    return 1
  }
}

type Phase = 'fly' | 'live' | 'dive' | 'handover' | 'gone'

type Rec = {
  sheet?: HTMLDivElement | null
  base?: HTMLDivElement | null
  face?: HTMLDivElement | null
  glass?: HTMLDivElement | null
  world?: HTMLDivElement | null
  lab?: HTMLDivElement | null
  lead?: HTMLDivElement | null
  ring?: HTMLDivElement | null
  shadow?: HTMLDivElement | null
  /** the tiles, cached for the morph and the hand-over */
  tiles?: HTMLElement[] | null
  // last values written, so a frame touches only what changed
  txt?: number
  m?: number
  w?: number
  /** the content's opacity (it fades in over the canvas) */
  x?: number
  open?: boolean
  /** the accent edge and the shadow, as last written */
  ringOp?: number
  shadowOp?: number
  /** the accent edge when a dive or close began, which it fades from */
  ring0?: number
  surf?: number
  tz?: number
  labOpen?: boolean
  flying?: boolean
  /** the label's last opacity, and what it was when a dive began */
  lop?: number
  lop0?: number
}

function camT(c: Camera): string {
  const d = window.devicePixelRatio || 1
  const sn = (v: number) => Math.round(v * d) / d
  return `translate(${sn(c.x)}px, ${sn(c.y)}px) scale(${c.zoom})`
}
const poseT = (p: Pose) =>
  `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, ${p.z.toFixed(2)}px) rotateX(${p.tilt.toFixed(3)}deg) scale(${p.scale.toFixed(5)})`

function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
function textScale(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ts'))
  return Number.isFinite(v) && v > 0 ? v : 1.1
}
const toggle = (node: Element | null | undefined, cls: string, on: boolean) => node?.classList.toggle(cls, on)
/** The hand-over, at `u` (0 → 1): the backdrop goes first, while the cards
 *  still cover their widgets (it is the canvas's own grid, so nothing
 *  shows), then the cards crossfade into the real widgets. Overlapping the
 *  two would let the backdrop dim the widgets mid-fade. */
const handBg = (u: number) => 1 - clamp01(u / 0.25)
const handFade = (u: number) => easeOut(clamp01((u - 0.2) / 0.8))

export function LayerOverview() {
  const ws = useStore(selectActive)
  const layers = layersOf(ws)
  const n = layers.length
  const curId = activeLayerId(ws)
  const curIdx = Math.max(0, layers.findIndex((l) => l.id === curId))

  // agent LEDs for the rail's roll-ups (re-renders only while the overview is up)
  const status = useAgents((s) => s.status)
  const finishedAt = useAgents((s) => s.finishedAt)
  const statusOf = useCallback(
    (id: string): LedStatus | undefined => {
      const st = status[id]
      const f = finishedAt[id]
      return st === 'idle' && f != null && Date.now() - f < RECENT_FINISH_MS ? 'done' : st
    },
    [status, finishedAt],
  )

  // the layer the accordion is open on (rounded target): drives the chrome
  const [focus, setFocusState] = useState(curIdx)
  // 'map': tiles with a title, a meta line and a last line; 'detail' (V): a
  // few lines of each widget
  const [view, setView] = useState<ProxyMode>(() =>
    localStorage.getItem(VIEW_KEY) === 'detail' ? 'detail' : 'map',
  )
  // Your own layer's tiles are built with the overview; the others a ring
  // at a time from the next frame on (nearest first, as they fade in that
  // way), so no single frame builds every layer.
  const [built, setBuilt] = useState(0)
  useEffect(() => {
    if (built >= n) return
    const id = requestAnimationFrame(() => setBuilt((b) => b + 1))
    return () => cancelAnimationFrame(id)
  }, [built, n])
  // dragging a tile: the sheet (or rail label) it would drop on
  const [dropIdx, setDropIdx] = useState(-1)
  const [renaming, setRenaming] = useState<string | null>(null)
  // a one-line note above the key hints ("⌫ again to merge…", "the base layer stays")
  const [note, setNote] = useState<string | null>(null)
  // / finds across every layer: null = closed, '' = open and empty
  const [query, setQuery] = useState<string | null>(null)
  // ⌫ on a layer with widgets arms; a second ⌫ on the same layer removes it
  const armed = useRef<string | null>(null)
  // after a reorder or removal, the layer that should stay open
  const keepFocus = useRef<string | null>(null)

  // the first render's timestamp, for the perf readout (P)
  const renderAt = useRef(performance.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const recs = useRef(new Map<string, Rec>())
  const rec = (id: string) => {
    let r = recs.current.get(id)
    if (!r) recs.current.set(id, (r = {}))
    return r
  }

  // everything the loop shares; a ref, never state, so motion never re-renders
  const C = useRef({
    phase: 'fly' as Phase,
    /** fly: +1 opening, −1 closing */
    dir: 1 as 1 | -1,
    /** fly: the open amount (0 the canvas, 1 the accordion), eased along a
     *  decelerating segment from aFrom to aTo that restarts on a reversal */
    a: 0,
    aFrom: 0,
    aTo: 0,
    aT0: 0,
    aDur: 0,
    /** fly: the tiles' cover over the widgets, the closing wipe, the text wash */
    x: 0,
    H: 0,
    w: 0,
    /** the wash when a dive began, which it leaves from */
    w0: 1,
    t0: 0,
    pos: curIdx,
    vel: 0,
    target: curIdx,
    /** the layer the canvas is on: the deck forms around it */
    here: curIdx,
    /** the live camera the open starts from and the close lands on */
    startCam: ws.camera,
    L: null as OvLayout | null,
    /** the sheet scale on screen: eases to L.s when a layer is added or removed */
    sNow: 0,
    railW: RAIL_W0,
    fits: new Map<string, Camera>(),
    raf: 0,
    last: 0,
    reduced: prefersReduced(),
    slow: slowFactor(),
    timers: [] as number[],
    hoverT: 0,
    wheelT: 0,
    pinch: 0,
    lastMove: 0,
    /** per layer: a slide still settling after a reorder or removal (layers) */
    off: new Map<string, number>(),
    /** per layer: when it was added (it drops in) */
    born: new Map<string, number>(),
    /** per layer: measured rail label height; cleared when it changes */
    labH: new Map<string, number>(),
    labY: new Map<string, number>(),
    /** the last frame's poses and world cameras, by index: a dive starts there */
    poses: [] as Pose[],
    cams: [] as Camera[],
    /** the accordion the intro opens to, or the outro closes from */
    acc: [] as Pose[],
    diveTo: -1,
    diveCam: null as Camera | null,
    selectId: undefined as string | undefined,
    glide: { dx: 0, dy: 0 },
    committed: false,
    /** handover: which sheet lands, and on what camera */
    landIdx: -1,
    landCam: null as Camera | null,
    /** the header and footer's last opacity, and what it was when a dive began */
    chrome: 0,
    chrome0: 0,
    order: layers.map((l) => l.id).join(','),
    /** a dive asked for before it could start (a digit pressed while the
     *  overview is still covering the widgets, or while it lands): taken
     *  as soon as it can be, so no key press is lost */
    pendingDive: -1,
    pendingSelect: undefined as string | undefined,
  })
  const later = (fn: () => void, ms: number) => {
    C.current.timers.push(window.setTimeout(fn, ms))
  }

  // elements per layer, for the sheets and the rail
  const byLayer = useMemo(() => {
    const m = new Map<string, CanvasElement[]>()
    for (const l of layers) m.set(l.id, [])
    // in stacking order, like the live canvas (which stacks with z-index)
    for (const e of [...ws.elements].sort((a, b) => a.z - b.z)) m.get(layerOf(e))?.push(e)
    return m
  }, [ws.elements, layers])

  // ---------- geometry ----------
  const measure = (snap: boolean) => {
    const root = rootRef.current!
    const W = root.clientWidth
    const H = root.clientHeight
    const c = C.current
    const ls = live.current.layers
    c.railW = Math.round((RAIL_W0 * Math.min(textScale(), 1.4)) / 1.1)
    c.L = ovLayout(ls.length, W, H, c.railW)
    if (snap || !c.sNow) c.sNow = c.L.s
    root.style.setProperty('--lr-w', c.railW + 'px')
    const view = viewRef.current!
    view.style.perspective = `${c.L.persp}px`
    view.style.perspectiveOrigin = `${c.L.ox}px ${c.L.oy}px`
    // hairlines and radii stay screen-sized on a scaled sheet
    view.style.setProperty('--sk', String(1 / c.L.s))
    for (const l of ls) {
      const fit = ovFit(live.current.byLayer.get(l.id) ?? [], W, H)
      c.fits.set(l.id, fit)
      const w = rec(l.id).world
      if (w) {
        w.style.transition = 'none'
        w.style.transform = camT(fit)
        w.style.setProperty('--fs', String(fit.zoom * c.L.s))
      }
    }
    c.labH.clear()
  }
  /** Align the backdrop's grid with a camera, like the canvas's own. */
  const gridTo = (cam: Camera) => {
    const bg = bgRef.current
    if (!bg) return
    bg.style.backgroundSize = `${140 * cam.zoom}px ${140 * cam.zoom}px, ${28 * cam.zoom}px ${28 * cam.zoom}px`
    bg.style.backgroundPosition = `${cam.x - 7 * cam.zoom}px ${cam.y - 7 * cam.zoom}px, ${cam.x}px ${cam.y}px`
  }
  const fitOf = (id: string): Camera => C.current.fits.get(id) ?? { x: 0, y: 0, zoom: 1 }

  /** Start the loop if it isn't running. */
  const kick = () => {
    const c = C.current
    if (c.raf || c.phase === 'gone') return
    c.last = performance.now()
    c.raf = requestAnimationFrame((t) => frameRef.current(t))
  }

  const setPhase = (p: Phase, now = performance.now()) => {
    const c = C.current
    c.phase = p
    c.t0 = now
    if (p === 'dive') {
      // the chrome and labels fade out from where they are, so a dive taken
      // during the opening doesn't flash them up first (a close needs no
      // such care: it runs back down the opening's own path)
      c.chrome0 = c.chrome
      for (const r of recs.current.values()) r.lop0 = r.lop ?? 0
    }
    const root = rootRef.current
    toggle(root, 'lo--live', p === 'live')
  }

  /** The store side of a dive: switch layer (and select), show the canvas. */
  const commit = () => {
    const c = C.current
    if (c.committed) return
    c.committed = true
    const store = useStore.getState()
    if (c.diveTo >= 0) {
      const L = live.current
      const target = L.layers[c.diveTo]?.id
      if (target) {
        // switching drops focus and selection either way (the focus-leak rule)
        store.setActiveLayer(target, target === L.curId ? undefined : c.diveCam!)
        if (c.selectId) {
          store.setSelection([c.selectId])
          store.bringToFront([c.selectId])
        }
      }
    }
    // the live canvas paints again under the overview, which still covers it
    store.setLayerOverview('closing')
    if (c.diveCam && c.diveTo >= 0) gridTo(c.diveCam)
  }

  // ---------- the frame ----------
  const frame = (now: number) => {
    const c = C.current
    c.raf = 0
    const L0 = c.L
    if (!L0 || c.phase === 'gone') return
    const dt = Math.max(0, Math.min(0.034, (now - c.last) / 1000)) / c.slow
    c.last = now
    const { layers: ls } = live.current
    const N = ls.length
    let more = true

    // phase ends
    let el = (now - c.t0) / c.slow
    if (c.phase === 'fly' && fly(now, dt)) return
    if (c.pendingDive >= 0 && canDive()) {
      const [j, sel] = [c.pendingDive, c.pendingSelect]
      c.pendingDive = -1
      c.pendingSelect = undefined
      dive(j, sel)
      el = 0
    }
    if (c.phase === 'dive' && el >= T.dive) {
      commit()
      c.landIdx = c.diveTo
      c.landCam = c.diveCam
      setPhase('handover', now)
      el = 0
    }
    if (c.phase === 'handover' && el >= T.handover) {
      setPhase('gone', now)
      useStore.getState().setLayerOverview(false)
      return
    }

    // the sheet scale eases after a layer is added or removed
    if (c.sNow !== L0.s) {
      c.sNow += (L0.s - c.sNow) * (1 - Math.exp(-dt * 12))
      if (Math.abs(c.sNow - L0.s) < 1e-4) c.sNow = L0.s
    }
    const L = c.sNow === L0.s ? L0 : { ...L0, s: c.sNow }

    const phase = c.phase
    const poses: Pose[] = []
    const cams: Array<Camera | null> = ls.map(() => null)
    const morph = ls.map(() => 0)
    const surf = ls.map(() => 1) // the sheet's own surface (0 = see-through)
    const wash = ls.map(() => 1) // the text's wash (layers.css), per sheet
    const cover = ls.map(() => 1) // the sheet's content fades in over the canvas
    const ring = ls.map(() => 0) // the accent edge
    const shadow = ls.map(() => 0.75)
    let handIdx = -1 // the sheet handing over to the canvas
    let bgOp = 1
    let chromeOp = 1
    let labOp = 1
    let dist: number[] = [] // each sheet's distance from the open one, for labels
    let glideIdx = -1
    let glideT = 0
    // Tile text only while sheets hold their size: while one grows or shrinks
    // its text needs a new counter-scale every frame, and each one repaints
    // the whole canvas-sized sheet. So it washes in as the deck settles, and
    // washes out early on a dive (the title bars carry the names in).
    let textGate = 1

    if (phase === 'fly') {
      // One decelerating move, no swing, either way: the canvas settles
      // straight into the open sheet and the other layers spread a short way
      // out from behind it as they fade in, nearest first; back, the layer
      // you're on settles flat and the rest draw in and fade.
      const a = c.a
      textGate = c.w > 0 ? 1 : 0
      wash.fill(c.w)
      const home = c.acc[c.here]
      for (let i = 0; i < N; i++) {
        const to = c.acc[i]
        if (!to) {
          poses.push(ovFlat(false))
          continue
        }
        if (i === c.here) {
          poses.push(mixPose(ovFlat(true), to, a))
          continue
        }
        const d = i - c.here
        const b = clamp01((a - 0.06 - Math.min(Math.abs(d), 4) * 0.03) / 0.75)
        const from = { ...to, y: lerp(home?.y ?? to.y, to.y, 0.6), z: to.z - 20 * L.zk, op: 0 }
        poses.push(mixPose(from, to, b))
      }
      cams[c.here] = lerpCam(c.startCam, fitOf(ls[c.here].id), a)
      // the tiles fade in over the widgets, stand in for them in flight (the
      // widget look giving way to the block), and crossfade back into them
      // at the end of a close
      cover[c.here] = easeOut(c.x) * (1 - handFade(c.H))
      morph[c.here] = 1 - clamp01(a / 0.7)
      handIdx = c.here
      // the sheet's own surface fades in as it leaves the canvas
      surf[c.here] = clamp01(a / 0.5)
      for (let i = 0; i < N; i++) ring[i] = (rec(ls[i].id).ring0 ?? 0) * clamp01((a - 0.7) / 0.3)
      shadow[c.here] = 0.75 * clamp01(a / 0.4) + 0.25 * ring[c.here]
      // the backdrop is the canvas's own grid: it drops in once the tiles
      // cover the widgets, and goes before they crossfade away
      bgOp = c.H > 0 ? handBg(c.H) : a > 0 || c.x >= 1 ? 1 : 0
      chromeOp = clamp01((a - 0.3) / 0.5)
      labOp = clamp01((a - 0.5) / 0.45)
      dist = ls.map((_, i) => i - c.pos)
    } else if (phase === 'live') {
      let moving = false
      if (c.reduced) {
        c.pos = c.target
        c.vel = 0
      } else if (Math.abs(c.pos - c.target) > 5e-4 || Math.abs(c.vel) > 5e-4) {
        ;[c.pos, c.vel] = springStep(c.pos, c.vel, c.target, dt)
        moving = true
      } else {
        c.pos = c.target
        c.vel = 0
      }
      const decay = Math.exp(-dt * 14)
      for (const [id, o] of c.off) {
        const v = o * decay
        if (Math.abs(v) < 0.002 || c.reduced) c.off.delete(id)
        else c.off.set(id, v)
      }
      const at = ls.map((l, i) => i + (c.off.get(l.id) ?? 0))
      poses.push(...ovPoses(L, at, c.pos))
      // a new layer drops in from above
      for (const [id, t0] of c.born) {
        const i = ls.findIndex((l) => l.id === id)
        const k = c.reduced ? 1 : clamp01((now - t0) / c.slow / T.born)
        if (i >= 0) {
          const e = easeOut(k)
          poses[i] = { ...poses[i], y: poses[i].y - (1 - e) * 50, z: poses[i].z + (1 - e) * 90 * L.zk, op: e }
        }
        if (k >= 1) c.born.delete(id)
      }
      dist = at.map((e) => e - c.pos)
      // the open sheet's edge and deeper shadow: switched as a roll passes
      // (they share the sheet's own layer, so a fade would repaint it every
      // frame); they fade only as the overview opens, closes or dives
      for (let i = 0; i < N; i++) {
        ring[i] = Math.abs(dist[i]) < 0.5 ? 1 : 0
        shadow[i] = 0.75 + 0.25 * ring[i]
      }
      more = moving || c.off.size > 0 || c.born.size > 0 || c.sNow !== L0.s
    } else if (phase === 'dive') {
      // The overview still covers the canvas: switch layer at once, so the
      // real widgets do their one heavy repaint now, not as the sheet lands.
      commit()
      const t = clamp01(el / T.dive)
      const w = c.w0 * (1 - easeOut(clamp01(t / 0.22)))
      textGate = w > 0 ? 1 : 0
      wash.fill(w)
      const j = c.diveTo
      // no lift and no swing: the sheet eases flat onto the canvas, the rest
      // drift a little and fade
      const f = easeOut(clamp01(t / 0.85))
      for (let i = 0; i < N; i++) {
        const start = c.poses[i] ?? ovFlat(false)
        if (i === j) {
          poses.push(mixPose(start, ovFlat(true), f))
          cams[i] = lerpCam(c.cams[i] ?? fitOf(ls[i].id), c.diveCam!, f)
          continue
        }
        const d = i - j
        const away = { ...start, y: start.y - Math.sign(d) * 60, z: start.z - 40 * L.zk, op: 0 }
        poses.push(mixPose(start, away, easeOut(clamp01(t / 0.5))))
      }
      morph[j] = easeOut(clamp01((t - 0.42) / 0.45))
      // and the sheet becomes the canvas as it lands
      surf[j] = 1 - clamp01((t - 0.8) / 0.2)
      fadeRings(ring, t)
      shadow[j] = (1 - clamp01((t - 0.3) / 0.5)) * (0.75 + 0.25 * ring[j])
      chromeOp = c.chrome0 * (1 - clamp01(t / 0.4))
      labOp = 1 - clamp01(t / 0.3) // of each label's opacity when the dive began
      glideIdx = j
      glideT = f // the dived layer's name travels with its sheet
      dist = ls.map((_, i) => i - j)
    } else if (phase === 'handover') {
      textGate = 0
      const u = clamp01(el / T.handover)
      const j = c.landIdx
      for (let i = 0; i < N; i++) poses.push(ovFlat(i === j))
      if (j >= 0) {
        cams[j] = c.landCam
        // the cards crossfade into the real widgets under them
        cover[j] = 1 - handFade(u)
        morph[j] = 1
        surf[j] = 0
        shadow[j] = 0
      }
      handIdx = j
      bgOp = handBg(u)
      chromeOp = 0
      labOp = 0
      dist = ls.map((_, i) => i - j)
    }

    // ---- write the sheets ----
    const lastCams: Camera[] = []
    for (let i = 0; i < N; i++) {
      const id = ls[i].id
      const r = rec(id)
      const p = poses[i]
      if (!r.sheet || !p) continue
      r.sheet.style.transform = poseT(p)
      r.sheet.style.opacity = p.op.toFixed(3)
      const d = dist[i] ?? 0
      r.sheet.style.zIndex = String(
        (phase === 'dive' && i === c.diveTo) ||
          (phase === 'handover' && i === handIdx) ||
          (phase === 'fly' && i === c.here && c.a < 0.05)
          ? 200
          : 100 - Math.round(Math.abs(d) * 10),
      )
      if (r.face) {
        r.face.style.opacity = (1 - p.shade).toFixed(3)
        const txt = Math.round(ovText(p.tilt) * textGate * 50) / 50
        if (r.txt !== txt) {
          r.txt = txt
          r.face.style.setProperty('--txt', String(txt))
        }
      }
      const open = phase === 'live' && Math.abs(d) < 0.5
      if (r.open !== open) {
        r.open = open
        toggle(r.sheet, 'is-open', open)
      }
      const rg = Math.round(ring[i] * 50) / 50
      if (r.ringOp !== rg && r.ring) {
        r.ringOp = rg
        r.ring.style.opacity = String(rg)
      }
      const sh = Math.round(shadow[i] * 50) / 50
      if (r.shadowOp !== sh && r.shadow) {
        r.shadowOp = sh
        r.shadow.style.opacity = String(sh)
      }
      if (r.surf !== surf[i]) {
        r.surf = surf[i]
        if (r.base) r.base.style.opacity = surf[i].toFixed(3)
        if (r.glass) r.glass.style.opacity = surf[i].toFixed(3)
        toggle(r.sheet, 'is-handover', surf[i] < 1)
      }
      const cam = cams[i]
      if (cam && r.world) {
        r.world.style.transition = 'none'
        r.world.style.transform = camT(cam)
      }
      // a sheet's content moving on its own (its camera easing during the
      // opening or a dive) gets its own layer for that time, so the move
      // doesn't repaint the sheet; at rest it folds back into the sheet
      const flying = !!cam && phase !== 'live'
      if (r.flying !== flying && r.world) {
        r.flying = flying
        toggle(r.world, 'is-flying', flying)
      }
      // while a sheet grows to (or shrinks from) the canvas, its tile text
      // keeps the size it has in the accordion: a counter-scale, not a font size
      const fit = fitOf(id)
      const tz = cam ? Math.round(((fit.zoom * L.s) / Math.max(1e-3, cam.zoom * p.scale)) * 1000) / 1000 : 1
      // hidden text needs no counter-scale (and writing one restyles every tile)
      if (r.tz !== tz && r.world && (r.txt ?? 0) > 0) {
        r.tz = tz
        r.world.style.setProperty('--tz', String(tz))
      }
      lastCams[i] = cam ?? fitOf(id)
      // one opacity on the content's layer, not one per tile
      const cv = Math.round(cover[i] * 100) / 100
      if (r.x !== cv && r.world) {
        r.x = cv
        r.world.style.opacity = cv < 1 ? String(cv) : ''
      }
      // hidden tiles need no writes (each one restyles its tile)
      if (cv > 0) applyTiles(r, morph[i], wash[i])
    }
    c.poses = poses
    c.cams = lastCams

    // ---- the backdrop and the chrome ----
    if (bgRef.current) bgRef.current.style.opacity = bgOp.toFixed(3)
    c.chrome = chromeOp
    for (const node of [headRef.current, footRef.current]) if (node) node.style.opacity = chromeOp.toFixed(3)

    // ---- the rail: flat labels pushed apart, a leader to each sheet ----
    placeLabels(L, poses, dist, labOp, phase, glideIdx, glideT)

    if (more) kick()
  }
  /** A dive or close: every accent edge fades from where it was. */
  const fadeRings = (ring: number[], t: number) => {
    const k = 1 - easeOut(clamp01(t / 0.3))
    live.current.layers.forEach((l, i) => (ring[i] = (rec(l.id).ring0 ?? 0) * k))
  }
  const holdRings = () => {
    for (const r of recs.current.values()) r.ring0 = r.ringOp ?? 0
  }
  const frameRef = useRef(frame)
  frameRef.current = frame

  /** Blocks → widgets (--m) and the text's wash (--w), each in reading
   *  order. */
  const applyTiles = (r: Rec, m: number, w: number) => {
    // re-query after a render (tiles may have mounted); tiles that just
    // mounted already rest (m 0, w 1), so a sheet at rest needs no writes
    const rest = m === 0 && w === 1
    if (r.m === m && r.w === w && (r.tiles || rest)) return
    const root = r.world
    if (!root) return
    const fresh = !r.tiles
    const tiles = (r.tiles ??= Array.from(root.querySelectorAll<HTMLElement>('.pt')))
    const cnt = tiles.length
    const spread = 0.35
    const each = (v: number, ord: number, k = spread) =>
      v <= 0 ? 0 : v >= 1 ? 1 : clamp01((v - (ord / Math.max(1, cnt - 1)) * k) / (1 - k))
    for (const tile of tiles) {
      const ord = Number(tile.dataset.ord) || 0
      if (fresh || r.m !== m) tile.style.setProperty('--m', each(m, ord).toFixed(3))
      // the wash runs down the sheet in reading order
      if (fresh || r.w !== w) tile.style.setProperty('--w', each(w, ord, 0.4).toFixed(3))
    }
    r.m = m
    r.w = w
  }

  const placeLabels = (
    L: OvLayout,
    poses: Pose[],
    dist: number[],
    labOp: number,
    phase: Phase,
    glideIdx: number,
    glideT: number,
  ) => {
    const c = C.current
    const ls = live.current.layers
    const x0 = OV.RAIL_X + c.railW + 4
    if (phase === 'dive') {
      // the dived layer's name glides toward the layer chip, on the sheet's
      // own easing, and is gone a little before the sheet lands; the rest
      // (and every leader) fade sooner
      ls.forEach((l, i) => {
        const r = rec(l.id)
        if (!r.lab) return
        const op0 = r.lop0 ?? 0
        if (i === glideIdx) {
          const y = c.labY.get(l.id) ?? 0
          r.lab.style.transform = `translate3d(${c.glide.dx * glideT}px, ${y + c.glide.dy * glideT}px, 0) translateY(-50%)`
          r.lab.style.opacity = (op0 * (1 - clamp01((glideT - 0.4) / 0.5))).toFixed(3)
        } else r.lab.style.opacity = (op0 * labOp).toFixed(3)
        if (r.lead) r.lead.style.opacity = (op0 * labOp).toFixed(3)
      })
      return
    }
    // the open label is taller (two lines, folder, counts): toggle, then measure
    const marks = ls.map((l, i) => {
      const r = rec(l.id)
      const open = Math.abs(dist[i] ?? 9) < 0.5
      if (r.labOpen !== open) {
        r.labOpen = open
        toggle(r.lab, 'is-open', open)
        toggle(r.lead, 'is-open', open)
        c.labH.delete(l.id)
      }
      return { i, id: l.id, r, a: ovAnchor(L, poses[i]), d: dist[i] ?? 0 }
    })
    for (const m of marks) if (!c.labH.has(m.id) && m.r.lab) c.labH.set(m.id, m.r.lab.offsetHeight)
    marks.sort((p, q) => p.a.y - q.a.y)
    const ys = labelYs(
      marks.map((m) => m.a.y),
      marks.map((m) => c.labH.get(m.id) ?? 24),
    )
    marks.forEach((m, k) => {
      const y = ys[k]
      c.labY.set(m.id, y)
      const { lab, lead } = m.r
      // labels fade in as their sheet settles: nearest first during the opening
      const stagger = phase === 'fly' ? clamp01(labOp * 1.6 - Math.abs(m.d) * 0.15) : labOp
      const op = stagger * Math.max(0.35, 1 - Math.abs(m.d) * 0.18)
      m.r.lop = op
      if (lab) {
        lab.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0) translateY(-50%)`
        lab.style.opacity = op.toFixed(3)
      }
      if (lead) {
        const dx = Math.max(0, m.a.left - 6 - x0)
        const dy = m.a.y - y
        const len = Math.hypot(dx, dy)
        lead.style.transform = `translate3d(${x0}px, ${y.toFixed(1)}px, 0) rotate(${Math.atan2(dy, dx)}rad) scaleX(${(len / 100).toFixed(4)})`
        lead.style.opacity = op.toFixed(3)
      }
    })
  }

  /** One frame of opening or closing. The open amount heads for 1 or 0
   *  along a decelerating segment, restarted from where it is whenever L
   *  turns it around; the tiles' cover, the closing wipe and the text wash
   *  each step toward where `dir` says, in order: cover the widgets, then
   *  pull back, then the text; back, the text, the flight, then the wipe.
   *  Returns true once closed (the overview unmounts). */
  const fly = (now: number, dt: number): boolean => {
    const c = C.current
    const ms = dt * 1000
    if (c.dir > 0) {
      if (c.H > 0) c.H = Math.max(0, c.H - ms / T.uncover)
      else if (c.x < 1) c.x = Math.min(1, c.x + ms / T.preroll)
      if (c.x >= 1 && c.H <= 0 && c.aTo !== 1) aimA(1, now)
    } else {
      if (c.aTo !== 0) aimA(0, now)
      // flat on the canvas again: the tiles give way to the real widgets
      // (a close that never finished covering them just fades them back)
      if (c.a <= 0) {
        if (c.H > 0 || c.x >= 1) c.H = Math.min(1, c.H + ms / T.handover)
        else c.x = Math.max(0, c.x - ms / T.preroll)
      }
    }
    const k = c.aDur > 0 ? clamp01((now - c.aT0) / c.slow / c.aDur) : 1
    c.a = lerp(c.aFrom, c.aTo, easeOut(k))
    // the text washes in once the deck has nearly settled, and out at once
    const wTo = c.dir > 0 && c.a > 0.7 ? 1 : 0
    c.w = wTo > c.w ? Math.min(1, c.w + ms / T.washIn) : Math.max(0, c.w - ms / T.washOut)
    if (c.dir > 0 && c.aTo === 1 && k >= 1 && c.w >= 1) {
      setPhase('live', now)
      c.vel = 0
      useStore.getState().setLayerOverview('open')
    } else if (c.dir < 0 && (c.H >= 1 || (c.x <= 0 && c.a <= 0))) {
      setPhase('gone', now)
      useStore.getState().setLayerOverview(false)
      return true
    }
    return false
  }
  /** Start the open amount toward `to` from where it is: a whole move takes
   *  the full time, a part of one proportionally less (but never snaps). */
  const aimA = (to: number, now: number) => {
    const c = C.current
    c.aFrom = c.a
    c.aTo = to
    c.aT0 = now
    c.aDur = (to > c.a ? T.intro : T.outro) * Math.max(0.4, Math.abs(to - c.a))
  }

  // ---------- actions ----------
  const go = (i: number) => {
    const c = C.current
    // while it's still opening, the roll waits for the accordion to settle
    // (no key is dropped for being early)
    const opening = c.phase === 'fly' && c.dir > 0
    if (c.phase !== 'live' && !opening) return
    i = Math.max(0, Math.min(live.current.n - 1, Math.round(i)))
    c.target = i
    setFocusState(i)
    if (armed.current) {
      armed.current = null
      setNote(null)
    }
    kick()
  }

  /** Fade out and unmount (reduced motion). */
  const fadeOut = () => {
    const root = rootRef.current
    const store = useStore.getState()
    store.setLayerOverview('closing') // the live canvas shows again under the fade
    if (!root) return store.setLayerOverview(false)
    C.current.phase = 'gone'
    root.classList.remove('lo--live')
    root.style.transition = `opacity ${T.fade}ms ease`
    root.style.opacity = '0'
    later(() => useStore.getState().setLayerOverview(false), T.fade)
  }

  /** Esc / L / the backdrop: the opening, backwards, onto the layer you're
   *  on, from wherever it has got to. The live canvas repaints now, under
   *  the still-covering overview, rather than as the motion lands. */
  const close = () => {
    const c = C.current
    const L = live.current
    if (c.reduced) {
      if (c.phase === 'live') fadeOut()
      return
    }
    c.pendingDive = -1
    if (c.phase === 'fly') {
      if (c.dir < 0) return
      c.dir = -1
      commit()
      kick()
      return
    }
    if (c.phase !== 'live') return
    const now = performance.now()
    // the layer you're on may have changed (its layer removed)
    c.here = L.curIdx
    c.startCam = L.ws.camera
    // the accordion as it stands (rolled or not) is where it closes from
    c.acc = c.poses.map((p) => ({ ...p }))
    c.a = c.aFrom = c.aTo = 1
    c.aDur = 0
    c.x = 1
    c.H = 0
    c.w = 1
    c.diveTo = -1
    c.committed = false
    window.clearTimeout(c.hoverT)
    holdRings()
    c.dir = -1
    setPhase('fly', now)
    commit()
    sampleTransition('close', T.outro + T.handover)
    kick()
  }

  /** L while closing: back out to the overview, from wherever it is. */
  const reopen = () => {
    const c = C.current
    if (c.phase !== 'fly' || c.dir > 0) return
    c.dir = 1
    c.committed = false
    kick()
  }
  /** L (or a digit) while a dive is landing: turn it around into the
   *  opening, from where it has got to, around the layer it dived into (the
   *  canvas is already on it). Nothing waits for the landing to finish. */
  const reopenFromLanding = () => {
    const c = C.current
    if (c.phase !== 'dive' && c.phase !== 'handover') return
    const L = live.current
    const j = c.phase === 'dive' ? c.diveTo : c.landIdx
    const cam = c.phase === 'dive' ? c.diveCam : c.landCam
    if (j < 0 || !cam || !c.L) return
    const now = performance.now()
    const el = (now - c.t0) / c.slow
    // how far down the sheet has come, on the dive's own easing; a landing
    // hand-over is all the way down, part crossfaded
    const down = c.phase === 'dive' ? easeOut(clamp01(el / T.dive / 0.85)) : 1
    c.H = c.phase === 'handover' ? clamp01(el / T.handover) : 0
    c.here = j
    c.pos = c.target = j
    c.vel = 0
    setFocusState(j)
    c.startCam = cam
    c.acc = ovPoses(c.L, L.layers.map((_, i) => i), j)
    c.a = c.aFrom = c.aTo = 1 - down
    c.aDur = 0
    c.x = 1
    c.w = 0
    c.dir = 1
    c.diveTo = -1
    c.selectId = undefined
    c.committed = false
    for (const l of L.layers) rec(l.id).ring0 = l.id === L.layers[j]?.id ? 1 : 0
    setPhase('fly', now)
    kick()
  }
  const flip = () => {
    const c = C.current
    if (c.phase === 'dive' || c.phase === 'handover') return reopenFromLanding()
    return c.phase === 'fly' && c.dir < 0 ? reopen() : close()
  }
  /** A dive can start: from the accordion, or an opening that has the
   *  widgets covered. */
  const canDive = () => {
    const c = C.current
    return c.phase === 'live' || (c.phase === 'fly' && c.dir > 0 && c.x >= 1 && c.H <= 0 && c.a > 0)
  }

  /** Dive into layer j (and select one of its widgets). */
  const dive = (j: number, selectId?: string) => {
    const c = C.current
    if (!canDive()) {
      // too early (still covering the widgets) or landing: take it as soon as
      // it can be taken; a landing turns back first
      const opening = c.phase === 'fly' && c.dir > 0
      // the layer it is already landing on: nothing to do
      const landingOn = c.phase === 'dive' ? c.diveTo : c.phase === 'handover' ? c.landIdx : -1
      if (j === landingOn) return
      if (opening || c.phase === 'dive' || c.phase === 'handover') {
        c.pendingDive = j
        c.pendingSelect = selectId
        if (!opening) reopenFromLanding()
        kick()
      }
      return
    }
    const L = live.current
    j = Math.max(0, Math.min(L.n - 1, j))
    const target = L.layers[j].id
    const root = rootRef.current!
    const cam = target === L.curId ? L.ws.camera : landingCamera(L.ws, target, root.clientWidth, root.clientHeight)
    c.diveTo = j
    c.diveCam = cam
    c.selectId = selectId
    c.committed = false
    c.w0 = c.phase === 'live' ? 1 : c.w
    window.clearTimeout(c.hoverT)
    if (c.reduced) {
      commit()
      fadeOut()
      return
    }
    // where the name has to go: the layer chip in the top bar
    const nm = rec(target).lab?.querySelector('.lr__t') ?? rec(target).lab
    const chip = document.querySelector('.tb-layer__name') ?? document.querySelector('.tb-layer')
    if (nm && chip) {
      const a = nm.getBoundingClientRect()
      const b = chip.getBoundingClientRect()
      c.glide = { dx: b.left - a.left, dy: b.top + b.height / 2 - (a.top + a.height / 2) }
    } else c.glide = { dx: 0, dy: -40 }
    holdRings()
    setPhase('dive')
    sampleTransition('dive', T.dive + T.handover)
    kick()
  }

  /** ⇧↑ / ⇧↓: move the open layer up or down the stack. */
  const reorder = (dir: 1 | -1) => {
    const c = C.current
    if (c.phase !== 'live') return
    const L = live.current
    const i = Math.round(c.target)
    const j = i + dir
    if (j < 0 || j >= L.n) return
    keepFocus.current = L.layers[i].id
    useStore.getState().moveLayer(L.layers[i].id, j)
  }

  /** ⌫: remove the open layer. Its widgets merge into the layer below
   *  (nothing closes); with widgets on it, press twice. */
  const remove = () => {
    const c = C.current
    if (c.phase !== 'live') return
    const L = live.current
    const f = Math.round(c.target)
    const l = L.layers[f]
    if (l.id === BASE_LAYER_ID) {
      setNote('The base layer stays: rename it with R')
      return
    }
    const count = (L.byLayer.get(l.id) ?? []).length
    const intoIdx = f > 0 ? f - 1 : 1
    if (count && armed.current !== l.id) {
      armed.current = l.id
      setNote(
        `⌫ again to remove ${l.name}: its ${count} item${count > 1 ? 's' : ''} move to ${layerNumber(intoIdx)} ${L.layers[intoIdx].name}, and nothing closes`,
      )
      return
    }
    armed.current = null
    setNote(null)
    keepFocus.current = L.layers[intoIdx].id
    useStore.getState().removeLayer(l.id)
  }

  const newLayer = () => {
    if (C.current.phase !== 'live' || live.current.n >= MAX_LAYERS) return
    void useStore.getState().newLayerWithPicker()
  }

  const toggleView = () =>
    setView((v) => {
      const next = v === 'map' ? 'detail' : 'map'
      localStorage.setItem(VIEW_KEY, next)
      return next
    })

  // hovering waits a beat, so sweeping across the stack doesn't roll it
  // through every layer on the way
  const hoverGo = (i: number) => {
    const c = C.current
    if (c.phase !== 'live' || dragCleanup.current) return
    // only after a real pointer move: a sheet sliding under a still cursor
    // (after ↑/↓) must not steal the keyboard's choice
    if (performance.now() - c.lastMove > 60) return
    window.clearTimeout(c.hoverT)
    c.hoverT = window.setTimeout(() => go(i), T.hover)
  }

  // ---------- open ----------
  useLayoutEffect(() => {
    const c = C.current
    const root = rootRef.current!
    const commitAt = performance.now()
    measure(true)
    // the backdrop is the canvas (same colour and grid, at the same camera),
    // so dropping it in over the live canvas is invisible
    gridTo(ws.camera)
    if (c.reduced) {
      // reduced motion: an opacity crossfade to a resting accordion
      setBuilt(99)
      setPhase('live')
      c.pos = c.target = c.here
      frame(performance.now())
      root.style.opacity = '0'
      void root.offsetWidth
      root.style.transition = `opacity ${T.fade}ms ease`
      root.style.opacity = '1'
      useStore.getState().setLayerOverview('open')
      sampleTransition('open', T.fade, { render: renderAt.current, commit: commitAt, effectEnd: performance.now() })
      return
    }
    // frame 0: your sheet sits exactly over the live canvas, see-through, so
    // the live widgets show; then the tiles fade in over them
    c.acc = ovPoses(c.L!, live.current.layers.map((_, i) => i), c.here)
    for (const l of live.current.layers) rec(l.id).ring0 = l.id === live.current.curId ? 1 : 0
    setPhase('fly', commitAt)
    c.last = commitAt
    frame(commitAt)
    kick()
    // build the other sheets' content once the open is under way

    sampleTransition('open', T.preroll + T.intro, {
      render: renderAt.current,
      commit: commitAt,
      effectEnd: performance.now(),
    })
    return () => {
      for (const t of C.current.timers) window.clearTimeout(t)
      window.clearTimeout(C.current.hoverT)
      window.clearTimeout(C.current.wheelT)
      cancelAnimationFrame(C.current.raf)
      C.current.raf = 0
      C.current.phase = 'gone'
    }
    // mount only: the open sequence runs once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // after any render: classes React rewrote and label sizes may have changed,
  // and new tiles may have mounted, so the next frame re-applies everything
  useLayoutEffect(() => {
    for (const r of recs.current.values()) {
      r.open = r.labOpen = r.surf = undefined
      r.tiles = null
    }
    C.current.labH.clear()
    kick()
  })

  // what's on a sheet changed while open (a drag, a find jump, an agent's
  // satellite): re-fit the sheets whose content bounds moved, smoothly
  useEffect(() => {
    const c = C.current
    if (c.phase !== 'live' || !c.L) return
    const root = rootRef.current!
    for (const l of layers) {
      const f = ovFit(byLayer.get(l.id) ?? [], root.clientWidth, root.clientHeight)
      const old = c.fits.get(l.id)
      if (old && old.x === f.x && old.y === f.y && old.zoom === f.zoom) continue
      c.fits.set(l.id, f)
      const w = rec(l.id).world
      if (!w) continue
      w.style.transition = old ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none'
      w.style.transform = camT(f)
      w.style.setProperty('--fs', String(f.zoom * c.L.s))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byLayer])

  // a layer was added, moved or removed while open: the sheets slide to
  // their new places, the open position follows the layer it was on, and a
  // new layer drops in from above, open
  const order = layers.map((l) => l.id).join(',')
  useLayoutEffect(() => {
    const c = C.current
    if (c.order === order) return
    const prev = c.order.split(',')
    c.order = order
    if (!c.L) return
    const ids = order.split(',')
    const added = ids.filter((id) => !prev.includes(id))
    ids.forEach((id, i) => {
      const was = prev.indexOf(id)
      if (was < 0) return
      const o = was + (c.off.get(id) ?? 0) - i
      if (Math.abs(o) > 1e-3) c.off.set(id, o)
      else c.off.delete(id)
    })
    for (const id of prev) if (!ids.includes(id)) recs.current.delete(id)
    measure(false)
    let to = Math.min(Math.round(c.target), ids.length - 1)
    if (added.length && c.phase === 'live') {
      for (const id of added) c.born.set(id, performance.now())
      to = ids.indexOf(added[added.length - 1])
    } else if (keepFocus.current && ids.includes(keepFocus.current)) to = ids.indexOf(keepFocus.current)
    keepFocus.current = null
    if (c.phase === 'live') {
      c.target = to
      setFocusState(to)
    }
    // a pending "⌫ again" belonged to the stack as it was
    if (armed.current) {
      armed.current = null
      setNote(null)
    }
    kick()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order])

  // ---------- input: keys, wheel, pointer, resize ----------
  const live = useRef({ dive, go, close, flip, newLayer, toggleView, reorder, remove, curIdx, curId, n, layers, ws, byLayer, setRenaming, setQuery })
  live.current = { dive, go, close, flip, newLayer, toggleView, reorder, remove, curIdx, curId, n, layers, ws, byLayer, setRenaming, setQuery }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.isContentEditable) return
      const Lv = live.current
      const c = C.current
      const k = e.key
      const done = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      const at = Math.round(c.target)
      if (e.ctrlKey && e.metaKey && e.code === 'ArrowDown') return done(), Lv.dive(at)
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (k === '/' && c.phase === 'live') return done(), Lv.setQuery('')
      if (k === 'Escape') return done(), Lv.close()
      // L turns the move around at any moment: tap it fast, in and out
      if (k === 'l' || k === 'L') return done(), Lv.flip()
      if (/^[1-9]$/.test(k)) {
        done()
        if (+k <= Lv.n) Lv.dive(+k - 1)
        return
      }
      if (k === 'Enter' || k === ' ') return done(), Lv.dive(at)
      if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) return done(), Lv.reorder(k === 'ArrowUp' ? 1 : -1)
      if (k === 'Backspace' || k === 'Delete') return done(), Lv.remove()
      if (k === 'ArrowUp' || k === 'k' || k === 'K') return done(), Lv.go(at + 1)
      if (k === 'ArrowDown' || k === 'j' || k === 'J') return done(), Lv.go(at - 1)
      if (k === 'n' || k === 'N') return done(), Lv.newLayer()
      if (k === 'P' && PERF_TOOLS && layersPerf.on) return done(), void runBench(() => useStore.getState().setLayerOverview(true))
      if ((k === 'p' || k === 'P') && PERF_TOOLS) return done(), setPerfOn(!layersPerf.on)
      if (k === 'v' || k === 'V') return done(), Lv.toggleView()
      if ((k === 'r' || k === 'R') && c.phase === 'live') return done(), Lv.setRenaming(Lv.layers[at]?.id ?? null)
      // every other bare key stops here: nothing reaches the canvas underneath
      done()
    }
    const root = rootRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = C.current
      if (c.phase !== 'live') return
      if (e.ctrlKey || e.metaKey) {
        // pinch in dives into the open layer
        if (e.deltaY < 0) {
          c.pinch -= e.deltaY
          if (c.pinch > 60) {
            c.pinch = 0
            live.current.dive(Math.round(c.target))
          }
        }
        return
      }
      // the wheel moves the target (scroll up = up the stack), and it snaps
      // to a layer once the wheel rests
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      const n = live.current.n
      c.target = Math.max(0, Math.min(n - 1, c.target - dy * 0.004))
      setFocusState(Math.round(c.target))
      window.clearTimeout(c.wheelT)
      c.wheelT = window.setTimeout(() => {
        C.current.target = Math.round(C.current.target)
        kick()
      }, T.snap)
      kick()
    }
    const onMove = () => {
      C.current.lastMove = performance.now()
    }
    const onLeave = () => window.clearTimeout(C.current.hoverT)
    const onResize = () => {
      const c = C.current
      if (c.phase !== 'live') return
      measure(true)
      kick()
    }
    window.addEventListener('keydown', onKey, true)
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('pointermove', onMove, { passive: true })
    root.addEventListener('pointerleave', onLeave)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- drag a tile onto another sheet (or its rail label) ----------
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragEndedAt = useRef(0)
  // a drag in progress when the overview unmounts must not leave listeners
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])
  const tileAt = (x: number, y: number) =>
    // resolve from the full hit list: the sheet's own surface can come first
    document.elementsFromPoint(x, y).find((n) => n instanceof HTMLElement && !!n.dataset.pid) as
      | HTMLElement
      | undefined
  const onSheetDown = (i: number, e: React.PointerEvent) => {
    if (C.current.phase !== 'live' || e.button !== 0) return
    const tile = tileAt(e.clientX, e.clientY)
    const id = tile?.dataset.pid
    if (!tile || !id) return
    const sx = e.clientX
    const sy = e.clientY
    let on = false
    let over = -1
    const overAt = (x: number, y: number) => {
      for (const n of document.elementsFromPoint(x, y)) {
        const hit = (n as HTMLElement).closest?.('.lo-sheet, .lr') as HTMLElement | null
        if (!hit) continue
        const idx = Number(hit.dataset.idx)
        return Number.isFinite(idx) ? idx : -1
      }
      return -1
    }
    const move = (ev: PointerEvent) => {
      if (!on) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
        on = true
        window.clearTimeout(C.current.hoverT)
        tile.classList.add('is-lifted')
        const g = ghostRef.current
        if (g) {
          g.firstChild!.textContent = tile.querySelector('.pt__tt, .pt__bt')?.textContent ?? ''
          g.classList.add('lo-ghost--on')
        }
      }
      const g = ghostRef.current
      if (g) g.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`
      const next = overAt(ev.clientX, ev.clientY)
      if (next !== over) {
        over = next
        setDropIdx(over !== i ? over : -1)
        if (g) g.lastChild!.textContent = over >= 0 && over !== i ? `→ ${layerNumber(over)} ${live.current.layers[over].name}` : ''
        // no roll while dragging: it would slide the target out from under
        // the pointer, so the drop would miss it
      }
    }
    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      dragCleanup.current = null
    }
    const up = () => {
      detach()
      if (!on) return // a plain click: the sheet's click handler dives
      dragEndedAt.current = performance.now()
      tile.classList.remove('is-lifted')
      ghostRef.current?.classList.remove('lo-ghost--on')
      setDropIdx(-1)
      const ls = live.current.layers
      if (over >= 0 && over !== i) useStore.getState().moveToLayer([id], ls[over].id)
    }
    dragCleanup.current?.()
    dragCleanup.current = detach
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onSheetClick = (i: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (performance.now() - dragEndedAt.current < 80) return // the click that ends a drag
    dive(i, tileAt(e.clientX, e.clientY)?.dataset.pid)
  }

  // ---------- find (/) ----------
  const q = query?.trim() ?? ''
  const matches = useMemo(() => {
    if (!q) return null
    const m = new Set<string>()
    for (const e of ws.elements) if (matchesQuery(e, q)) m.add(e.id)
    return m
  }, [q, ws.elements])
  const matchCount = (id: string) => (byLayer.get(id) ?? []).filter((e) => matches?.has(e.id)).length
  // typing rolls to the first layer with a match (yours first)
  useEffect(() => {
    if (!matches || !matches.size) return
    const has = (i: number) => (byLayer.get(layers[i].id) ?? []).some((e) => matches.has(e.id))
    if (has(Math.round(C.current.target))) return
    const order = [curIdx, ...layers.map((_, i) => i).filter((i) => i !== curIdx)]
    const hit = order.find(has)
    if (hit != null) go(hit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])
  /** Enter in the find box: dive into the open layer, selecting its first match. */
  const diveToMatch = () => {
    const i = Math.round(C.current.target)
    const first = (byLayer.get(layers[i].id) ?? []).find((e) => matches?.has(e.id))
    dive(i, first?.id)
  }

  // ---------- render ----------
  const stats = layers.map((l) => layerStatus(ws, l.id, statusOf))
  const total = stats.reduce(
    (a, s) => ({ w: a.w + s.count, r: a.r + s.working, q: a.q + s.waiting }),
    { w: 0, r: 0, q: 0 },
  )
  const subMax = Math.max(14, Math.floor((C.current.railW - 52) / 7))

  return (
    <div
      className="lo"
      ref={rootRef}
      onClick={(e) => {
        // the click that ends a tile drag lands on the common ancestor: not a backdrop click
        if (performance.now() - dragEndedAt.current < 80) return
        // the backdrop: back to the layer you were on
        if (C.current.phase !== 'live') return
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lo-view')) close()
      }}
    >
      <div className="lo-bg" ref={bgRef} />
      <div className="lo-ghost" ref={ghostRef}>
        <span />
        <em />
      </div>
      <div className="lo-view" ref={viewRef}>
        {layers.map((l, i) => (
          <div
            key={l.id}
            ref={(node) => void (rec(l.id).sheet = node)}
            data-idx={i}
            className={`lo-sheet${i === curIdx ? ' is-current' : ''}${stats[i].waiting ? ' has-waiting' : ''}${
              i === dropIdx ? ' is-drop' : ''
            }`}
            onPointerEnter={() => hoverGo(i)}
            onPointerDown={(e) => onSheetDown(i, e)}
            onClick={(e) => onSheetClick(i, e)}
          >
            <div className="lo-shadow" ref={(node) => void (rec(l.id).shadow = node)} />
            <div className="lo-base" ref={(node) => void (rec(l.id).base = node)} />
            <div className="lo-face" ref={(node) => void (rec(l.id).face = node)}>
              <div className="lo-glass" ref={(node) => void (rec(l.id).glass = node)} />
              <div className="lo-world" ref={(node) => void (rec(l.id).world = node)}>
                {Math.abs(i - C.current.here) <= built && (
                  <SheetContent
                    els={byLayer.get(l.id) ?? []}
                    fs={Math.round(((C.current.fits.get(l.id)?.zoom ?? 0.5) * (C.current.L?.s ?? 0.45)) * 1000) / 1000}
                    mode={view}
                    matches={matches}
                    home={layerDir(ws, l.id)}
                  />
                )}
              </div>
            </div>
            <div className="lo-ring" ref={(node) => void (rec(l.id).ring = node)} />
            <div className="lo-attn" />
          </div>
        ))}
      </div>

      <div className="lo-rail">
        {layers.map((l, i) => {
          const st = stats[i]
          const here = i === curIdx
          const hits = matches ? matchCount(l.id) : 0
          return (
            <div
              key={l.id}
              ref={(node) => void (rec(l.id).lab = node)}
              data-idx={i}
              className={`lr${st.waiting ? ' has-waiting' : ''}${i === dropIdx ? ' is-drop' : ''}${
                matches ? (hits ? ' has-hits' : ' no-hits') : ''
              }`}
              onPointerEnter={() => hoverGo(i)}
              onClick={(e) => {
                e.stopPropagation()
                if (renaming === l.id || C.current.phase !== 'live') return
                if (Math.round(C.current.target) === i) dive(i)
                else go(i)
              }}
            >
              <span className="lr__n">{layerNumber(i)}</span>
              <span className="lr__nm">
                {renaming === l.id ? (
                  <input
                    className="lr__input"
                    defaultValue={l.name}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      useStore.getState().renameLayer(l.id, e.target.value)
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <span
                    className="lr__t"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenaming(l.id)
                    }}
                  >
                    {l.name}
                  </span>
                )}
                {here && <span className="lr__here">here</span>}
                {st.waiting > 0 && <span className="lr__dot" title="needs you" />}
                {matches && hits > 0 && <span className="lr__hits">{hits}</span>}
              </span>
              <span className="lr__sub" title={l.dir ?? ws.dir}>
                {l.dir || ws.dir ? midEllipsis(shortPath((l.dir ?? ws.dir)!), subMax) : 'no folder'}
              </span>
              <span className="lr__sum">
                {matches && <span className={hits ? 'lr__found' : ''}>{hits ? `${hits} found` : 'no match'}</span>}
                {st.waiting > 0 && (
                  <span className="lr__w">
                    <StatusGlyph status="waiting" title="needs you" /> {st.waiting}
                  </span>
                )}
                {st.working > 0 && (
                  <span>
                    <StatusGlyph status="working" title="working" /> {st.working}
                  </span>
                )}
                {st.done > 0 && (
                  <span className="lr__d">
                    <StatusGlyph status="done" title="just finished" /> {st.done}
                  </span>
                )}
                <span>{st.count ? `${st.count} widget${st.count === 1 ? '' : 's'}` : 'empty'}</span>
              </span>
            </div>
          )
        })}
        {layers.map((l) => (
          <div key={l.id} className="lr-lead" ref={(node) => void (rec(l.id).lead = node)} />
        ))}
      </div>

      <div className="lo-head" ref={headRef}>
        <span className="lo-head__t">
          <IconLayers />
          Layers
        </span>
        <span className="lo-head__s">
          <b>{ws.name}</b> · {n} layer{n > 1 ? 's' : ''} · {total.w} widgets · <b>{total.r}</b> running
          {total.q > 0 && (
            <>
              {' · '}
              <b className="lo-head__q">
                {total.q} need{total.q === 1 ? 's' : ''} you
              </b>
            </>
          )}
        </span>
        {query != null && (
          <input
            className="lo-find"
            autoFocus
            placeholder="find on every layer"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                setQuery(null)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                diveToMatch()
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                go(Math.round(C.current.target) + (e.key === 'ArrowUp' ? 1 : -1))
              }
            }}
          />
        )}
        <span className="lo-head__sp" />
        {n < MAX_LAYERS && (
          <button
            className="lo-btn"
            onClick={(e) => {
              e.stopPropagation()
              newLayer()
            }}
          >
            + new layer <span className="kbd">N</span>
          </button>
        )}
        {n > 1 && layers[focus]?.id !== BASE_LAYER_ID && (
          <button
            className="lo-btn"
            onClick={(e) => {
              e.stopPropagation()
              remove()
            }}
          >
            remove layer <span className="kbd">del</span>
          </button>
        )}
        <button
          className="lo-btn"
          onClick={(e) => {
            e.stopPropagation()
            toggleView()
          }}
        >
          tiles: {view === 'map' ? 'names' : 'cards'} <span className="kbd">V</span>
        </button>
      </div>
      <PerfReadout />
      {note && <div className="lo-note">{note}</div>}
      <div className="lo-foot" ref={footRef}>
        <div className="lo-keys">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>, hover or scroll · roll
          </span>
          <span>
            <span className="kbd">⏎</span> or click · dive in
          </span>
          <span>
            <span className="kbd">1</span>–<span className="kbd">9</span> · jump in
          </span>
          <span>
            <span className="kbd">/</span> · find
          </span>
          <span>
            <span className="kbd">V</span> · cards
          </span>
          <span>drag a tile · move it to another layer</span>
          <span>
            <span className="kbd">⇧↑</span>
            <span className="kbd">⇧↓</span> · reorder
          </span>
          <span>
            <span className="kbd">del</span> · remove
          </span>
          <span>
            <span className="kbd">R</span> · rename
          </span>
          <span>
            <span className="kbd">esc</span> · back
          </span>
        </div>
      </div>
    </div>
  )
}

/** One sheet's tiles. Memoised on the layer's element list, so a roll (which
 *  never re-renders) and a focus change (which does) leave them alone. */
const SheetContent = memo(function SheetContent({
  els,
  mode,
  matches,
  fs,
  home,
}: {
  els: CanvasElement[]
  mode: ProxyMode
  matches: Set<string> | null
  /** screen px per world unit on this sheet (fit zoom × sheet scale) */
  fs: number
  home?: string
}) {
  // a stack shows only its front, as on the canvas (the members behind it
  // would otherwise draw in z order, and the last one would cover the front)
  const shown = useMemo(() => {
    const stacks = stacksOf(els)
    return stacks.size ? els.filter((e) => !isHiddenMember(e, stacks)) : els
  }, [els])
  const { ord, covered } = useMemo(() => {
    const ws = shown.filter((e): e is WidgetElement => e.type === 'widget')
    const rank = readingOrder(ws)
    const ord = new Map(ws.map((w, i) => [w.id, rank[i]]))
    const s = Math.max(0.02, fs)
    // the text block: about 200 × 64 screen px from the tile's top-left
    return { ord, covered: coveredLabels(ws, 200 / s, 64 / s) }
  }, [shown, fs])
  let widgets = 0
  return (
    <>
      {shown.map((e) => {
        const capped = e.type === 'widget' && ++widgets > PROXY_CAP
        return (
          <LayerProxy
            key={e.id}
            el={e}
            rect={capped}
            mode={mode}
            dim={!!matches && !matches.has(e.id)}
            ord={ord.get(e.id)}
            noText={covered.has(e.id)}
            home={home}
          />
        )
      })}
    </>
  )
})

/** The perf readout (P): the last few opens, dives and closes, newest first. */
function PerfReadout() {
  const [, tick] = useState(0)
  useEffect(() => subscribePerf(() => tick((x) => x + 1)), [])
  if (!layersPerf.on) return null
  const f = (v?: number) => (v == null ? '·' : v.toFixed(1))
  const row = (r: PerfRun, i: number) => (
    <div key={i} className="lo-perf__row">
      {r.kind} · key→render {f(r.render)} · commit {f(r.commit)} · effect {f(r.effect)} · frame0{' '}
      {f(r.frame0)} · first {f(r.first)} · p50 {f(r.p50)} · p95 {f(r.p95)} · max {f(r.max)} · drops{' '}
      {r.drops}/{r.n}
    </div>
  )
  return (
    <div className="lo-perf">
      <div className="lo-perf__row">
        perf (P to hide, ⇧P to bench) · ms · {document.hidden ? 'HIDDEN: throttled' : 'visible'}
      </div>
      {(['open', 'dive', 'close'] as const).map((k) => {
        const a = summary(k, 'frame0')
        const b = summary(k, 'first')
        const c = summary(k, 'p95')
        const d = summary(k, 'max')
        return a && b && c && d ? (
          <div key={k} className="lo-perf__row lo-perf__sum">
            {k} ×{a.n} · frame0 {Math.round(a.median)}/{Math.round(a.worst)} · first {Math.round(b.median)}/
            {Math.round(b.worst)} · p95 {Math.round(c.median)}/{Math.round(c.worst)} · max {Math.round(d.median)}/
            {Math.round(d.worst)} (median/worst)
          </div>
        ) : null
      })}
      {layersPerf.runs.map(row)}
    </div>
  )
}
