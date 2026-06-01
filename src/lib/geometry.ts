import type { ArrowElement, Camera, CanvasElement, Point } from './types'

export type Rect = { x: number; y: number; w: number; h: number }

// ---------- camera transforms ----------
// world -> screen:  s = w * zoom + offset
// screen -> world:  w = (s - offset) / zoom

export function screenToWorld(p: Point, cam: Camera): Point {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom }
}

export function worldToScreen(p: Point, cam: Camera): Point {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y }
}

/** Zoom toward a screen-space anchor so the world point under it stays put. */
export function zoomAt(cam: Camera, anchor: Point, nextZoom: number): Camera {
  const z = clamp(nextZoom, 0.05, 8)
  const world = screenToWorld(anchor, cam)
  return { zoom: z, x: anchor.x - world.x * z, y: anchor.y - world.y * z }
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

// ---------- distances / hit testing ----------

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Shortest distance from point p to segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = clamp(t, 0, 1)
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  )
}

/** Normalize a rect that may have negative w/h (drawn in any direction). */
export function normRect(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  }
}

// ---------- element bounds ----------

export function elementBounds(el: CanvasElement): Rect {
  switch (el.type) {
    case 'draw': {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (let i = 0; i < el.points.length; i += 2) {
        const x = el.points[i]
        const y = el.points[i + 1]
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
    case 'arrow': {
      const r = normRect({ x: el.x1, y: el.y1, w: el.x2 - el.x1, h: el.y2 - el.y1 })
      if (!el.bend) return r
      // a curve bows past the chord — grow the box to include the apex
      const ap = arrowApex({ x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }, el.bend)
      const minX = Math.min(r.x, ap.x)
      const minY = Math.min(r.y, ap.y)
      const maxX = Math.max(r.x + r.w, ap.x)
      const maxY = Math.max(r.y + r.h, ap.y)
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
    case 'text':
      // approximate; refined by the DOM measurement at render time
      return {
        x: el.x,
        y: el.y,
        w: Math.max(20, el.text.length * el.fontSize * 0.6),
        h: el.fontSize * 1.4,
      }
    case 'rect':
    case 'ellipse':
    case 'image':
    case 'frame':
    case 'widget':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
  }
}

/** World-space hit test with a screen-space tolerance (px). */
export function hitTest(
  el: CanvasElement,
  p: Point,
  tolWorld: number,
): boolean {
  switch (el.type) {
    case 'draw': {
      for (let i = 0; i < el.points.length - 2; i += 2) {
        const a = { x: el.points[i], y: el.points[i + 1] }
        const b = { x: el.points[i + 2], y: el.points[i + 3] }
        if (distToSegment(p, a, b) <= tolWorld + el.size) return true
      }
      // single-point dabs
      if (el.points.length === 2) {
        return (
          dist(p, { x: el.points[0], y: el.points[1] }) <= tolWorld + el.size
        )
      }
      return false
    }
    case 'arrow': {
      const p1 = { x: el.x1, y: el.y1 }
      const p2 = { x: el.x2, y: el.y2 }
      if (!el.bend) return distToSegment(p, p1, p2) <= tolWorld + el.size
      // sample the curve and test the polyline
      const c = arrowControl(p1, p2, el.bend)
      let prev = p1
      for (let i = 1; i <= 12; i++) {
        const cur = quadAt(p1, c, p2, i / 12)
        if (distToSegment(p, prev, cur) <= tolWorld + el.size) return true
        prev = cur
      }
      return false
    }
    case 'ellipse': {
      const cx = el.x + el.w / 2
      const cy = el.y + el.h / 2
      const rx = el.w / 2
      const ry = el.h / 2
      if (rx === 0 || ry === 0) return false
      const v = (p.x - cx) ** 2 / rx ** 2 + (p.y - cy) ** 2 / ry ** 2
      return v <= 1.1
    }
    case 'rect':
    case 'text':
    case 'image':
    case 'frame':
    case 'widget':
      return pointInRect(p, elementBounds(el))
  }
}

/** Center point of an element's bounds. */
export function centerOf(el: CanvasElement): Point {
  const b = elementBounds(el)
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/**
 * Where a line aimed at `toward` crosses the rectangle `r`'s edge, starting
 * from its center. Used to dock bound connector endpoints onto widget edges
 * instead of burying them in the middle.
 */
export function edgePoint(r: Rect, toward: Point): Point {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const hw = r.w / 2
  const hh = r.h / 2
  // scale the direction vector to the nearest edge
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

// ---------- connection anchors ----------

/**
 * Normalized connection points a connector endpoint can dock to: the four
 * corners and the four edge midpoints. Coordinates are fractions of the
 * element bounds. (Dropping inside, away from any of these, auto-docks.)
 */
export const ANCHORS: { nx: number; ny: number }[] = [
  { nx: 0, ny: 0 }, // top-left
  { nx: 0.5, ny: 0 }, // top
  { nx: 1, ny: 0 }, // top-right
  { nx: 1, ny: 0.5 }, // right
  { nx: 1, ny: 1 }, // bottom-right
  { nx: 0.5, ny: 1 }, // bottom
  { nx: 0, ny: 1 }, // bottom-left
  { nx: 0, ny: 0.5 }, // left
]

/** World position of a normalized anchor on an element. */
export function anchorPoint(el: CanvasElement, a: { nx: number; ny: number }): Point {
  const b = elementBounds(el)
  return { x: b.x + a.nx * b.w, y: b.y + a.ny * b.h }
}

// ---------- curved connectors (quadratic Bézier) ----------
// An arrow's `bend` is the signed perpendicular distance of its apex from the
// chord midpoint. The control point that realizes that apex sits twice as far
// out (since a quadratic curve passes through the midpoint of mid↔control).

/** Control point of the quadratic that realizes an arrow's bend. */
export function arrowControl(p1: Point, p2: Point, bend?: number): Point {
  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  if (!bend) return { x: mx, y: my }
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  return { x: mx + (-dy / len) * bend * 2, y: my + (dx / len) * bend * 2 }
}

/** The apex (draggable midpoint) of a possibly-curved arrow. */
export function arrowApex(p1: Point, p2: Point, bend?: number): Point {
  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  if (!bend) return { x: mx, y: my }
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  return { x: mx + (-dy / len) * bend, y: my + (dx / len) * bend }
}

/** Signed bend implied by dragging the apex handle to world point `h`. */
export function bendFromApex(p1: Point, p2: Point, h: Point): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  const mx = (p1.x + p2.x) / 2
  const my = (p1.y + p2.y) / 2
  // project (h - mid) onto the unit perpendicular (-dy, dx)/len
  return ((h.x - mx) * (-dy / len) + (h.y - my) * (dx / len))
}

/** Point on a quadratic Bézier at parameter t. */
export function quadAt(p1: Point, c: Point, p2: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * p1.x + 2 * u * t * c.x + t * t * p2.x,
    y: u * u * p1.y + 2 * u * t * c.y + t * t * p2.y,
  }
}

/** Return a copy of `el` translated by (dx, dy), handling every element type. */
export function translated<T extends CanvasElement>(el: T, dx: number, dy: number): T {
  if (el.type === 'draw') {
    return {
      ...el,
      points: el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
    }
  }
  if (el.type === 'arrow') {
    return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy }
  }
  return { ...el, x: (el as { x: number }).x + dx, y: (el as { y: number }).y + dy }
}

export function boundsOfMany(els: CanvasElement[]): Rect | null {
  if (els.length === 0) return null
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const el of els) {
    const b = elementBounds(el)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Resolve a connector's endpoints. Any endpoint bound to an element is docked
 * onto that element's edge, aimed at the other end. Unbound endpoints keep
 * their stored coordinates. Returns the arrow unchanged when nothing is bound.
 */
export function resolvedArrow(
  a: ArrowElement,
  byId: Map<string, CanvasElement>,
): ArrowElement {
  const fromEl = a.from ? byId.get(a.from.id) : undefined
  const toEl = a.to ? byId.get(a.to.id) : undefined
  if (!fromEl && !toEl) return a
  const fromCenter = fromEl ? centerOf(fromEl) : { x: a.x1, y: a.y1 }
  const toCenter = toEl ? centerOf(toEl) : { x: a.x2, y: a.y2 }
  // an explicit anchor pins the endpoint; otherwise dock to the edge nearest
  // the other end
  const p1 = fromEl
    ? a.from?.anchor
      ? anchorPoint(fromEl, a.from.anchor)
      : edgePoint(elementBounds(fromEl), toCenter)
    : { x: a.x1, y: a.y1 }
  const p2 = toEl
    ? a.to?.anchor
      ? anchorPoint(toEl, a.to.anchor)
      : edgePoint(elementBounds(toEl), fromCenter)
    : { x: a.x2, y: a.y2 }
  return { ...a, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
}

// ---------- alignment-guide snapping ----------

export type SnapResult = {
  dx: number
  dy: number
  /** world x of the vertical guide line to draw, if any */
  vx: number | null
  /** world y of the horizontal guide line to draw, if any */
  hy: number | null
}

/** All candidate snap lines (left/center/right, top/center/bottom) of rects. */
export function edgeLines(rects: Rect[]): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const r of rects) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w)
    ys.push(r.y, r.y + r.h / 2, r.y + r.h)
  }
  return { xs, ys }
}

/** Nearest candidate to `v` within `tol`, or null. Used to snap a moving edge. */
export function snapValue(v: number, candidates: number[], tol: number): number | null {
  let best: number | null = null
  let bestD = tol
  for (const c of candidates) {
    const d = Math.abs(c - v)
    if (d <= bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/**
 * Snap a moving box's edges/centers to those of nearby static rects. Returns
 * the correction (dx,dy) to apply plus the guide coordinates to render.
 */
export function snapBox(box: Rect, others: Rect[], tol: number): SnapResult {
  const mvX = [box.x, box.x + box.w / 2, box.x + box.w]
  const mvY = [box.y, box.y + box.h / 2, box.y + box.h]
  let bx: { d: number; at: number } | null = null
  let by: { d: number; at: number } | null = null
  for (const o of others) {
    const oX = [o.x, o.x + o.w / 2, o.x + o.w]
    const oY = [o.y, o.y + o.h / 2, o.y + o.h]
    for (const m of mvX)
      for (const ov of oX) {
        const d = ov - m
        if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d)))
          bx = { d, at: ov }
      }
    for (const m of mvY)
      for (const ov of oY) {
        const d = ov - m
        if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d)))
          by = { d, at: ov }
      }
  }
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, vx: bx?.at ?? null, hy: by?.at ?? null }
}

// ---------- stroke path (perfect-freehand output -> SVG path) ----------

export function strokeToPath(stroke: number[][]): string {
  if (!stroke.length) return ''
  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
      return acc
    },
    ['M', stroke[0][0], stroke[0][1], 'Q'] as (string | number)[],
  )
  d.push('Z')
  return d.join(' ')
}
