// Stacks: several widgets sharing one spot on the canvas. A stack has no
// element of its own — its members carry `stackId` (+ order, front flag and the
// stack's title) and all share the same box. Only the front member is shown;
// the others stay mounted behind it so terminals and agents keep running.
//
// These helpers are pure: they derive stacks from an element list and repair
// one that has drifted (a deleted member, a partial paste, an undo).

import type { CanvasElement, WidgetElement } from './types'

// ---- snap to stack ----
// Dragging one widget (or one stack) mostly over another snaps it on; letting
// go stacks them. Overlap is measured against the smaller of the two boxes.
/** overlap at which the target shows faint brackets (a heads-up) */
export const SNAP_NEAR = 0.2
/** overlap at which the dragged widget snaps onto the target */
export const SNAP_ENTER = 0.55
/** a snapped widget only lets go below this (hysteresis, so it doesn't flicker) */
export const SNAP_EXIT = 0.42
/** how far a snapped widget still leans toward the pointer (0 = pinned) */
export const SNAP_HOLD = 0.16

type Box = { x: number; y: number; w: number; h: number }

/** Shared area of two boxes as a fraction of the smaller one (0..1). */
export function overlapRatio(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const small = Math.min(a.w * a.h, b.w * b.h)
  return small > 0 ? (ix * iy) / small : 0
}

export type Stack = {
  id: string
  title: string
  /** members in tab order */
  members: WidgetElement[]
  front: WidgetElement
}

const isWidget = (e: CanvasElement): e is WidgetElement => e.type === 'widget'

/** Every stack with two or more members, keyed by stack id. */
export function stacksOf(elements: CanvasElement[]): Map<string, Stack> {
  const groups = new Map<string, WidgetElement[]>()
  for (const e of elements)
    if (isWidget(e) && e.stackId) groups.set(e.stackId, [...(groups.get(e.stackId) ?? []), e])
  const out = new Map<string, Stack>()
  for (const [id, members] of groups) {
    if (members.length < 2) continue
    members.sort((a, b) => (a.stackOrder ?? 0) - (b.stackOrder ?? 0))
    const front = members.find((m) => m.stackFront) ?? members[0]
    out.set(id, { id, title: front.stackTitle || members[0].stackTitle || 'stack', members, front })
  }
  return out
}

/** `next`, keeping each stack object from `prev` whose members, front and
 *  title are unchanged. The canvas rebuilds its stacks on every frame of a
 *  pan, zoom or drag; a fresh object each time re-rendered every stacked
 *  widget along with it. */
export function reuseStacks(
  prev: Map<string, Stack> | undefined,
  next: Map<string, Stack>,
): Map<string, Stack> {
  if (!prev) return next
  for (const [id, s] of next) {
    const p = prev.get(id)
    if (
      p &&
      p.front === s.front &&
      p.title === s.title &&
      p.members.length === s.members.length &&
      p.members.every((m, i) => m === s.members[i])
    )
      next.set(id, p)
  }
  return next
}

/** The stack a widget belongs to, if it is in a real (2+) stack. */
export function stackOfId(elements: CanvasElement[], id: string): Stack | null {
  const el = elements.find((e) => e.id === id)
  if (!el || !isWidget(el) || !el.stackId) return null
  return stacksOf(elements).get(el.stackId) ?? null
}

/** Is this widget stacked behind another one (so not visible on the canvas)? */
export function isHiddenMember(el: CanvasElement, stacks: Map<string, Stack>): boolean {
  if (!isWidget(el) || !el.stackId) return false
  const s = stacks.get(el.stackId)
  return !!s && s.front.id !== el.id
}

/** Expand a set of ids to include every member of any stack they touch. */
export function withStackSiblings(elements: CanvasElement[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const stackIds = new Set<string>()
  for (const e of elements) if (out.has(e.id) && isWidget(e) && e.stackId) stackIds.add(e.stackId)
  if (!stackIds.size) return out
  for (const e of elements) if (isWidget(e) && e.stackId && stackIds.has(e.stackId)) out.add(e.id)
  return out
}

/** Remove every stack field from a widget (returns a copy). */
export function stripStack(w: WidgetElement): WidgetElement {
  const c = { ...w }
  delete c.stackId
  delete c.stackOrder
  delete c.stackFront
  delete c.stackTitle
  delete c.stackRestore
  return c
}

/**
 * Repair stacks after members came or went: a stack left with one member
 * dissolves into a plain widget (keeping the stack's box), every stack has
 * exactly one front, and every member shares the front's box. Returns the same
 * array when nothing needed fixing.
 */
export function normalizeStacks(elements: CanvasElement[]): CanvasElement[] {
  const groups = new Map<string, WidgetElement[]>()
  for (const e of elements)
    if (isWidget(e) && e.stackId) groups.set(e.stackId, [...(groups.get(e.stackId) ?? []), e])
  if (!groups.size) return elements
  const fix = new Map<string, WidgetElement>()
  for (const members of groups.values()) {
    if (members.length < 2) {
      fix.set(members[0].id, stripStack(members[0]))
      continue
    }
    members.sort((a, b) => (a.stackOrder ?? 0) - (b.stackOrder ?? 0))
    const fronts = members.filter((m) => m.stackFront)
    const front = fronts[0] ?? members[0]
    const title = front.stackTitle || members.find((m) => m.stackTitle)?.stackTitle || front.title
    members.forEach((m, i) => {
      const isFront = m.id === front.id
      const ok =
        m.stackOrder === i &&
        !!m.stackFront === isFront &&
        m.stackTitle === title &&
        m.x === front.x &&
        m.y === front.y &&
        m.w === front.w &&
        m.h === front.h
      if (!ok)
        fix.set(m.id, {
          ...m,
          stackOrder: i,
          stackFront: isFront || undefined,
          stackTitle: title,
          x: front.x,
          y: front.y,
          w: front.w,
          h: front.h,
        })
    })
  }
  if (!fix.size) return elements
  return elements.map((e) => fix.get(e.id) ?? e)
}

/**
 * Screen rects for the spread view: up to three columns (two when narrow), the
 * last row centred, each card keeping the members' aspect ratio.
 */
export function spreadRects(
  n: number,
  vw: number,
  vh: number,
  aspect: number,
): { x: number; y: number; w: number; h: number }[] {
  const top = 64
  const bottom = 32
  const side = Math.max(24, vw * 0.04)
  const gap = 20
  const maxCols = vw < 720 ? 2 : 3
  const cols = n <= maxCols ? n : n === 4 ? 2 : maxCols
  const rows = Math.ceil(n / cols)
  const cellW = (vw - side * 2 - gap * (cols - 1)) / cols
  const cellH = (vh - top - bottom - gap * (rows - 1)) / rows
  const cw = Math.max(80, Math.min(cellW, cellH * aspect, 760))
  const ch = cw / aspect
  const totalH = rows * ch + (rows - 1) * gap
  const y0 = top + Math.max(0, (vh - top - bottom - totalH) / 2)
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols)
    const c = i % cols
    const inRow = r === rows - 1 ? n - (rows - 1) * cols : cols
    const x0 = (vw - (inRow * cw + (inRow - 1) * gap)) / 2
    return { x: x0 + c * (cw + gap), y: y0 + r * (ch + gap), w: cw, h: ch }
  })
}

/** Number of columns spreadRects uses (for arrow-key movement). */
export function spreadCols(n: number, vw: number): number {
  const maxCols = vw < 720 ? 2 : 3
  return n <= maxCols ? n : n === 4 ? 2 : maxCols
}
