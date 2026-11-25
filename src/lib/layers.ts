// Layers: a tab's stack of planes (see README → Layers). Pure helpers only —
// no store, no DOM — so the model rules live in one place:
//  • An element's `layer` is missing for the base layer, so single-layer
//    canvases (and every file from before layers) are unchanged.
//  • `ws.layers` is materialised only once a second layer exists.
//  • A layer may carry its own folder (`dir`) and remembers its own camera.
// The overview's accordion geometry is at the bottom: pure arithmetic per frame, no DOM reads.

import type { Camera, CanvasElement, Layer, Workspace } from './types'
import type { AgentStatus } from './agents'
import { boundsOfMany, clamp } from './geometry'

export const BASE_LAYER_ID = 'base'
/** the digit keys jump to layers, so the stack stops at nine */
export const MAX_LAYERS = 9

const BASE: Layer = { id: BASE_LAYER_ID, name: 'base' }

/** The tab's layers, bottom first. A tab without any is one implicit base layer. */
export function layersOf(ws: Workspace): Layer[] {
  return ws.layers && ws.layers.length ? ws.layers : [BASE]
}

export const hasLayers = (ws: Workspace) => !!ws.layers && ws.layers.length >= 2

/** The layer being shown. Falls back to the bottom layer if the id is stale. */
export function activeLayerId(ws: Workspace): string {
  const ls = layersOf(ws)
  return ws.activeLayerId && ls.some((l) => l.id === ws.activeLayerId)
    ? ws.activeLayerId
    : ls[0].id
}

export const layerOf = (el: CanvasElement): string => el.layer ?? BASE_LAYER_ID

export const onLayer = (el: CanvasElement, id: string) => layerOf(el) === id

/** Elements on the layer being shown. */
export function activeLayerElements(ws: Workspace): CanvasElement[] {
  if (!hasLayers(ws)) return ws.elements
  const id = activeLayerId(ws)
  return ws.elements.filter((e) => layerOf(e) === id)
}

export function layerIndex(ws: Workspace, id: string): number {
  return layersOf(ws).findIndex((l) => l.id === id)
}

export function findLayer(ws: Workspace, id: string): Layer | undefined {
  return layersOf(ws).find((l) => l.id === id)
}

/** "02" for the second layer from the bottom. */
export const layerNumber = (i: number) => String(i + 1).padStart(2, '0')

/** The folder new widgets on this layer open in: the layer's, else the tab's. */
export function layerDir(ws: Workspace, id: string = activeLayerId(ws)): string | undefined {
  return findLayer(ws, id)?.dir ?? ws.dir
}

const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')
/** Is `path` the folder `dir` or inside it? */
export function pathWithin(dir: string, path: string): boolean {
  const d = trimSlash(dir)
  const p = trimSlash(path)
  return p === d || p.startsWith(d + '/') || p.startsWith(d + '\\')
}

/**
 * The layer whose own folder contains `cwd` (the deepest such folder wins), or
 * null when none does. Used to sort desktop mirrors onto their project's layer.
 */
export function layerForPath(ws: Workspace, cwd: string | undefined): string | null {
  if (!cwd || !hasLayers(ws)) return null
  let best: Layer | null = null
  for (const l of layersOf(ws))
    if (l.dir && pathWithin(l.dir, cwd) && (!best || l.dir.length > best.dir!.length)) best = l
  return best?.id ?? null
}

/**
 * Repair a tab's layer list after loading: every layer id that elements use
 * gets an entry (an older build may have dropped `layers` while keeping the
 * elements' ids), and the active id is clamped. A tab left with fewer than two
 * layers goes back to having none, so it saves exactly as before layers.
 */
export function normalizeLayers(ws: Workspace): Workspace {
  const used = new Set<string>()
  for (const e of ws.elements) if (e.layer) used.add(e.layer)
  // well-formed entries only, first of any duplicate id, every one named
  const seen = new Set<string>()
  const have: Layer[] = []
  for (const l of ws.layers ?? []) {
    if (!l || typeof l.id !== 'string' || seen.has(l.id)) continue
    seen.add(l.id)
    have.push(typeof l.name === 'string' && l.name.trim() ? l : { ...l, name: l.id === BASE_LAYER_ID ? 'base' : `layer ${have.length + 1}` })
  }
  if (!have.length && ![...used].some((id) => id !== BASE_LAYER_ID)) {
    if (ws.layers === undefined && ws.activeLayerId === undefined) return ws
    const { layers: _l, activeLayerId: _a, ...rest } = ws
    return rest
  }
  const layers = have.some((l) => l.id === BASE_LAYER_ID) ? [...have] : [{ ...BASE }, ...have]
  for (const id of used)
    if (!layers.some((l) => l.id === id)) layers.push({ id, name: `layer ${layers.length + 1}` })
  if (layers.length < 2) {
    // just the base layer: back to no layer list at all
    const { layers: _l, activeLayerId: _a, ...rest } = ws
    return rest
  }
  const activeLayerId = layers.some((l) => l.id === ws.activeLayerId)
    ? ws.activeLayerId
    : layers[0].id
  return { ...ws, layers, activeLayerId }
}

/** "~/p/webapp" for a folder under the home directory. */
export function shortPath(p: string): string {
  return trimSlash(p).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
}

/** A fresh, unused layer id. */
export function newLayerId(ws: Workspace): string {
  const taken = new Set(layersOf(ws).map((l) => l.id))
  for (;;) {
    const id = 'L-' + Math.random().toString(36).slice(2, 7)
    if (!taken.has(id)) return id
  }
}

/** Where to land on a layer: its remembered view, else framing its content. */
export function landingCamera(ws: Workspace, id: string, vw: number, vh: number): Camera {
  const saved = findLayer(ws, id)?.camera
  if (saved) return saved
  const b = boundsOfMany(ws.elements.filter((e) => layerOf(e) === id))
  if (!b) return { x: vw / 2, y: vh / 2, zoom: 1 }
  const pad = 90
  const zoom = clamp(Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2)), 0.1, 1)
  return { zoom, x: vw / 2 - (b.x + b.w / 2) * zoom, y: vh / 2 - (b.y + b.h / 2) * zoom }
}

// ---------- what a widget is, at a glance ----------

/** The handful of kinds the overview tells apart, each with its own glyph. */
export type Glyph = 'agent' | 'mirror' | 'shell' | 'code' | 'git' | 'web' | 'note'

export function widgetGlyph(el: CanvasElement): Glyph | null {
  if (el.type !== 'widget') return null
  if (el.mirrorOf === 'desktop') return 'mirror'
  switch (el.kind) {
    case 'agent':
    case 'transcript':
    case 'claude':
      return 'agent'
    case 'terminal':
    case 'runner':
      return 'shell'
    case 'diff':
    case 'pr':
    case 'issues':
    case 'runs':
      return 'git'
    case 'web':
    case 'vscode':
    case 'video':
    case 'nowplaying':
      return 'web'
    case 'note':
      return 'note'
    default:
      return 'code'
  }
}

/** A short type caption: "claude", "shell", "App.tsx", "git", "localhost:5173". */
export function widgetType(el: CanvasElement): string {
  if (el.type !== 'widget') return el.type
  if (el.mirrorOf === 'desktop') return 'desktop'
  switch (el.kind) {
    case 'agent':
      return 'claude'
    case 'terminal':
      return 'shell'
    case 'diff':
      return 'git'
    case 'vscode':
      return 'vs code'
    case 'nowplaying':
      return 'music'
    case 'web': {
      const u = (el.url ?? '').replace(/^\w+:\/\//, '').split('/')[0]
      return u || 'web'
    }
    default: {
      const p = el.path ? el.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : ''
      return p || el.kind
    }
  }
}

/** Does a widget match a find query? Title, type caption, path, folder and
 *  URL, case-insensitive; every word of the query must appear somewhere. */
export function matchesQuery(el: CanvasElement, q: string): boolean {
  if (el.type !== 'widget') return false
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [el.title, widgetType(el), el.kind, el.path, el.cwd, el.url].filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

const GLYPH_ORDER: Glyph[] = ['agent', 'mirror', 'shell', 'code', 'git', 'web', 'note']

/** Widget counts by glyph, in a fixed order, for the overview's rail. */
export function glyphCounts(els: CanvasElement[]): Array<[Glyph, number]> {
  const n = new Map<Glyph, number>()
  for (const e of els) {
    const g = widgetGlyph(e)
    if (g) n.set(g, (n.get(g) ?? 0) + 1)
  }
  return GLYPH_ORDER.filter((g) => n.has(g)).map((g) => [g, n.get(g)!])
}

// ---------- status roll-up ----------

export type LedStatus = AgentStatus | 'done'
export type LayerStats = { count: number; working: number; waiting: number; done: number; idle: number }

const isTerm = (e: CanvasElement) =>
  e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent')

/** Widget count and agent LEDs on one layer, for the chip and the overview. */
export function layerStatus(
  ws: Workspace,
  id: string,
  statusOf: (widgetId: string) => LedStatus | undefined,
): LayerStats {
  const st: LayerStats = { count: 0, working: 0, waiting: 0, done: 0, idle: 0 }
  for (const e of ws.elements) {
    if (e.type !== 'widget' || layerOf(e) !== id) continue
    st.count++
    if (!isTerm(e)) continue
    const s = statusOf(e.id)
    if (s === 'working') st.working++
    else if (s === 'waiting') st.waiting++
    else if (s === 'done') st.done++
    else if (s === 'idle') st.idle++
  }
  return st
}

/** The LED a whole layer shows: waiting beats working beats done. */
export function layerLed(st: LayerStats): LedStatus | null {
  return st.waiting ? 'waiting' : st.working ? 'working' : st.done ? 'done' : null
}

// ---------- overview geometry (the accordion) ----------
//
// Every layer is a viewport-sized sheet with its own transform (no shared 3D
// stage): one float, the open position, drives them all. A sheet's pose is a function of its
// distance from that position: the open sheet swings up to OPEN_TILT and
// lifts forward, the others fold to SLAT_TILT slats a fixed gap apart, darker
// with distance. Sheets only rotate and translate; their size never changes.
// Higher layers sit higher on screen (01, the base, is at the bottom).

export const OV = {
  OPEN_TILT: 12, // deg
  SLAT_TILT: 68,
  DECK_TILT: 40, // the closed deck the canvas pulls back into on open
  GAP: 26, // screen px between slats
  GAP_MIN: 16, // a tall stack tightens the gap before it shrinks the sheets
  LIFT: 56, // z of the open sheet
  SLAT_Z: -30,
  FAR_Z: 18, // further back per step past the first slat
  PERSP: 1700, // px
  /** the sheet height the z values and perspective are tuned
   *  at; larger sheets scale both so the stack keeps its depth */
  REF_H: 370,
  PO_X: 0.58, // perspective origin, of the width
  PO_Y: 0.3, // of the scene below the header
  HEAD_H: 52,
  FOOT_H: 52,
  RAIL_X: 16, // the rail's left edge
  TEXT_TILT: 24, // text shows only while a sheet is tilted less than this
  K: 170, // the open position's spring
  ZETA: 0.86,
} as const

const RAD = Math.PI / 180

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export type OvLayout = {
  n: number
  W: number
  H: number
  /** sheet scale: a sheet is the whole canvas (W × H) shown at s */
  s: number
  gap: number
  /** the stack's centre, relative to the root's centre */
  cx: number
  cy: number
  /** z and perspective scale (see REF_H) */
  zk: number
  persp: number
  /** perspective origin, root px */
  ox: number
  oy: number
}

/** Where one sheet is: translate3d(x, y, z) rotateX(tilt) scale(scale),
 *  about the sheet's centre (x, y relative to the root's centre). */
export type Pose = { x: number; y: number; z: number; tilt: number; scale: number; op: number; shade: number }

function makeLayout(n: number, W: number, H: number, cx: number, s: number, gap: number): OvLayout {
  const zk = Math.max(1, (s * H) / OV.REF_H)
  const sceneH = H - OV.HEAD_H - OV.FOOT_H
  return {
    n,
    W,
    H,
    s,
    gap,
    cx,
    cy: (OV.HEAD_H - OV.FOOT_H) / 2,
    zk,
    persp: OV.PERSP * zk,
    ox: W * OV.PO_X,
    oy: OV.HEAD_H + sceneH * OV.PO_Y,
  }
}

/** The accordion: a sheet's pose at distance d (layers) from the open position. */
export function ovPose(L: OvLayout, d: number): Pose {
  const ad = Math.abs(d)
  const a = Math.min(1, ad)
  const far = Math.max(0, ad - 1)
  const sgn = Math.sign(d)
  const openHalf = (L.s * L.H * Math.cos(OV.OPEN_TILT * RAD)) / 2
  return {
    x: L.cx,
    // up the stack is up the screen
    y: L.cy - sgn * (lerp(0, openHalf + L.gap * 1.6, a) + far * L.gap),
    z: (lerp(OV.LIFT, OV.SLAT_Z, a) - far * OV.FAR_Z) * L.zk,
    tilt: lerp(OV.OPEN_TILT, OV.SLAT_TILT, a),
    scale: L.s,
    op: 1,
    shade: Math.min(0.62, a * 0.28 + far * 0.1),
  }
}

/** A closed deck: every sheet pressed together, d layers from the current one. */
export function ovDeck(L: OvLayout, d: number, shift = 0): Pose {
  const ad = Math.abs(d)
  return {
    x: L.cx,
    y: L.cy + shift - d * 5,
    z: -ad * 6 * L.zk,
    tilt: OV.DECK_TILT,
    scale: L.s * 0.97,
    op: 1,
    shade: Math.min(0.6, ad * 0.12),
  }
}

/** The canvas: one sheet flat, exactly covering the live canvas. */
export const ovFlat = (on: boolean): Pose => ({ x: 0, y: 0, z: 0, tilt: 0, scale: 1, op: on ? 1 : 0, shade: 0 })

export function mixPose(a: Pose, b: Pose, t: number): Pose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    tilt: lerp(a.tilt, b.tilt, t),
    scale: lerp(a.scale, b.scale, t),
    op: lerp(a.op, b.op, t),
    shade: lerp(a.shade, b.shade, t),
  }
}

/** Text only where it can't be skewed: 1 when flat-ish, 0 by TEXT_TILT. */
export const ovText = (tilt: number) => clamp01((OV.TEXT_TILT - tilt) / 12)

/** Screen point (root px) of sheet-local point (u, v), px from the sheet's
 *  centre, replicating the CSS transform and the root's perspective. */
export function ovProject(L: OvLayout, p: Pose, u: number, v: number) {
  const c = Math.cos(p.tilt * RAD)
  const sn = Math.sin(p.tilt * RAD)
  const X = L.W / 2 + p.x + u * p.scale
  const Y = L.H / 2 + p.y + v * p.scale * c
  const Z = p.z + v * p.scale * sn
  const f = L.persp / (L.persp - Z)
  return { x: L.ox + (X - L.ox) * f, y: L.oy + (Y - L.oy) * f }
}

/** A sheet's rail anchor: its centre line's y and its left edge's x. */
export function ovAnchor(L: OvLayout, p: Pose) {
  const q = ovProject(L, p, -L.W / 2, 0)
  return { y: q.y, left: q.x }
}

/** Top and bottom (root px) of a set of poses on screen. */
export function ovExtent(L: OvLayout, poses: Pose[]) {
  let top = Infinity
  let bottom = -Infinity
  for (const p of poses) {
    top = Math.min(top, ovProject(L, p, 0, -L.H / 2).y)
    bottom = Math.max(bottom, ovProject(L, p, 0, L.H / 2).y)
  }
  return { top, bottom }
}

/** How far to move the stack so it stays between the header and footer:
 *  0 while it fits with the open sheet centred (the default look), else
 *  the least shift that keeps it in, or centred if it can't fit at all. */
export function ovShift(L: OvLayout, poses: Pose[]): number {
  if (!poses.length) return 0
  const e = ovExtent(L, poses)
  const lo = OV.HEAD_H + 4 - e.top // shift down at least this much
  const hi = L.H - OV.FOOT_H - 4 - e.bottom // and at most this much
  if (lo > hi) return (lo + hi) / 2
  return Math.min(Math.max(0, lo), hi)
}

/** Accordion poses for sheets at effective positions `at` (index plus any
 *  slide still settling), open position `pos`, kept inside the scene. */
export function ovPoses(L: OvLayout, at: number[], pos: number): Pose[] {
  const poses = at.map((e) => ovPose(L, e - pos))
  // twice: perspective moves near sheets a little more than the shift
  for (let k = 0; k < 2; k++) {
    const dy = ovShift(L, poses)
    if (Math.abs(dy) < 0.25) break
    for (const p of poses) p.y += dy
  }
  return poses
}

/**
 * Size the stack once per open, resize or layer count: the largest sheets
 * (up to half the scene's height, and 80% of the width right of the rail)
 * whose stack, at its tallest as it rolls, fits the scene. A tall stack
 * tightens the slat gap before it shrinks the sheets.
 */
export function ovLayout(n: number, W: number, H: number, railW: number): OvLayout {
  const regionLeft = OV.RAIL_X + railW + 28
  const cx = regionLeft / 2
  const sceneH = H - OV.HEAD_H - OV.FOOT_H
  const s0 = Math.max(0.12, Math.min(((W - regionLeft) * 0.8) / W, (0.5 * sceneH) / H))
  const span = (L: OvLayout) => {
    let worst = 0
    for (let pos = 0; pos <= n - 1; pos += 0.5) {
      const e = ovExtent(L, Array.from({ length: n }, (_, i) => ovPose(L, i - pos)))
      worst = Math.max(worst, e.bottom - e.top)
    }
    return worst
  }
  for (let gap = OV.GAP; gap >= OV.GAP_MIN; gap -= 2)
    for (let s = s0; s >= Math.min(s0, 0.18); s -= 0.01) {
      const L = makeLayout(n, W, H, cx, s, gap)
      if (span(L) <= sceneH - 8) return L
    }
  return makeLayout(n, W, H, cx, Math.min(s0, 0.18), OV.GAP_MIN)
}

/** One step of the open position's spring (k 170, ζ 0.86), in 4 substeps. */
export function springStep(pos: number, vel: number, target: number, dt: number): [number, number] {
  const c = 2 * OV.ZETA * Math.sqrt(OV.K)
  const h = dt / 4
  for (let i = 0; i < 4; i++) {
    const a = -OV.K * (pos - target) - c * vel
    vel += a * h
    pos += vel * h
  }
  return [pos, vel]
}

/** Rail labels, top to bottom: each at its sheet's centre line, pushed down
 *  just enough not to overlap the one above. Returns each label's centre. */
export function labelYs(anchors: number[], heights: number[]): number[] {
  let prevBottom = -Infinity
  return anchors.map((cy, i) => {
    const h = heights[i]
    const y = Math.max(cy, prevBottom + h / 2 + 2)
    prevBottom = y + h / 2
    return y
  })
}

/** "~/p/webapp/.worktr…ortrait": keeps both ends of a long path. */
export function midEllipsis(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.ceil((max - 1) * 0.45)) + '…' + s.slice(-Math.floor((max - 1) * 0.55))
}

/** Fit a layer's content into a sheet (90% × 84% of the viewport). */
export function ovFit(els: CanvasElement[], W: number, H: number): Camera {
  const b = boundsOfMany(els)
  if (!b) return { x: W / 2, y: H / 2, zoom: 1 }
  const zoom = Math.min((W * 0.9) / Math.max(1, b.w), (H * 0.84) / Math.max(1, b.h), 1.4)
  return { zoom, x: W / 2 - (b.x + b.w / 2) * zoom, y: H / 2 - (b.y + b.h / 2) * zoom }
}

export const lerpCam = (a: Camera, b: Camera, t: number): Camera => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  zoom: lerp(a.zoom, b.zoom, t),
})

// ---------- tiles: reading order and covered labels ----------

type Box = { x: number; y: number; w: number; h: number }

/** Each box's place in reading order (rows top to bottom, then left to right;
 *  tops within `row` world px count as one row). For the dive's sweep. */
export function readingOrder(els: Box[], row = 48): number[] {
  const idx = els.map((_, i) => i)
  idx.sort((a, b) => Math.round(els[a].y / row) - Math.round(els[b].y / row) || els[a].x - els[b].x)
  const rank = new Array<number>(els.length)
  idx.forEach((i, r) => (rank[i] = r))
  return rank
}

/**
 * Tiles whose text (drawn from the top-left corner, at most `lw` × `lh`
 * world units) a tile stacked above them covers: their text hides rather
 * than showing half a name. `els` must be in stacking order.
 */
export function coveredLabels(els: Array<Box & { id: string }>, lw: number, lh: number): Set<string> {
  const out = new Set<string>()
  els.forEach((e, i) => {
    const w = Math.min(lw, e.w)
    const h = Math.min(lh, e.h)
    for (let j = i + 1; j < els.length; j++) {
      const a = els[j]
      if (e.x < a.x + a.w && e.x + w > a.x && e.y < a.y + a.h && e.y + h > a.y) {
        out.add(e.id)
        break
      }
    }
  })
  return out
}

/** The longest word in a name, in characters: names on far cards and tiles
 *  are fitted so no word is broken across lines. */
export const longestWord = (s: string) => Math.max(3, ...s.split(/\s+/).map((w) => w.length))
