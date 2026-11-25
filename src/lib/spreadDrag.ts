// Dragging a card in a stack's spread view. Pure geometry, no DOM or store:
// the hook in widgets/useSpreadCardDrag.ts feeds it pointer positions and the
// spread's slots and applies what comes back.
//
// The slots are captured once, when the drag starts, and never move while it
// lasts. The order is only a preview (which slot the dragged card would take)
// until the card is let go, so a card sliding aside can never end up under the
// pointer and swap straight back.

export type Pt = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

/** how far past the halfway line to the next slot the card has to go before
 *  it takes that slot, as a fraction of a slot's shorter side */
export const SWAP_HYST = 0.24

/** share of the card outside the grid at which it turns into a pull-out */
export const PULL_ENTER = 0.5
/** ... and below which it goes back to reordering (hysteresis) */
export const PULL_EXIT = 0.32
/** a pointer this far outside the grid (screen px) also pulls the card out,
 *  so a big card grabbed by its title bar doesn't need dragging off-screen */
export const PULL_PTR_ENTER = 56
export const PULL_PTR_EXIT = 28
/** a card being pulled out shrinks a little, lifting off the grid */
export const PULL_SCALE = 0.88

const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * The slot a card centred at `p` should take. It only leaves `current` once
 * `p` is clearly nearer another slot: the halfway line between two slots has a
 * dead band of `hyst` × the slot's shorter side, so a hand jiggling on the
 * line never flips the order back and forth. `current` null (coming back in
 * from a pull-out) picks the nearest slot outright.
 */
export function targetSlot(slots: Rect[], p: Pt, current: number | null, hyst = SWAP_HYST): number {
  if (!slots.length) return 0
  let best = 0
  let bestD = Infinity
  slots.forEach((s, i) => {
    const d = dist(p, center(s))
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  if (current == null || current < 0 || current >= slots.length || best === current) return best
  const cur = slots[current]
  const band = hyst * Math.min(cur.w, cur.h)
  return dist(p, center(cur)) - bestD > band ? best : current
}

/** Bounding box of some rects. */
export function boundsOf(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Share of `card`'s area that lies outside `box` (0..1). */
export function outsideFraction(card: Rect, box: Rect): number {
  const area = card.w * card.h
  if (area <= 0) return 0
  const ix = Math.max(0, Math.min(card.x + card.w, box.x + box.w) - Math.max(card.x, box.x))
  const iy = Math.max(0, Math.min(card.y + card.h, box.y + box.h) - Math.max(card.y, box.y))
  return 1 - (ix * iy) / area
}

/** How far a point is outside a box (0 inside). */
export function distOutside(p: Pt, box: Rect): number {
  const dx = Math.max(box.x - p.x, 0, p.x - (box.x + box.w))
  const dy = Math.max(box.y - p.y, 0, p.y - (box.y + box.h))
  return Math.hypot(dx, dy)
}

/**
 * Is the drag a pull-out (the card leaves the stack on release)? It turns into
 * one once half the card (at its spread size) is off the grid, or the pointer
 * is well outside it, and only turns back once the card is mostly back in.
 */
export function isPulling(card: Rect, pointer: Pt, grid: Rect, was: boolean): boolean {
  const frac = outsideFraction(card, grid)
  const off = distOutside(pointer, grid)
  return was
    ? frac >= PULL_EXIT || off >= PULL_PTR_EXIT
    : frac >= PULL_ENTER || off >= PULL_PTR_ENTER
}

/**
 * Where a pulled-out widget lands (world, top-left): at its own size, with the
 * point you held it by still under the pointer. `grab` is that point in the
 * stacked box's local units (`box`), `own` the size it goes back to.
 */
export function dropOrigin(pointerWorld: Pt, grab: Pt, box: { w: number; h: number }, own: { w: number; h: number }): Pt {
  const fx = box.w > 0 ? Math.min(1, Math.max(0, grab.x / box.w)) : 0
  const fy = box.h > 0 ? Math.min(1, Math.max(0, grab.y / box.h)) : 0
  return { x: Math.round(pointerWorld.x - fx * own.w), y: Math.round(pointerWorld.y - fy * own.h) }
}

/** `ids` with `id` moved to index `to`. */
export function moveTo(ids: string[], id: string, to: number): string[] {
  const out = ids.filter((x) => x !== id)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, id)
  return out
}

/**
 * Which slot each member shows in while a card is dragged. The dragged card
 * keeps its own slot as a base (it is moved from there by the pointer); the
 * rest fill the other slots in order around its target, or close up the gap
 * when it is being pulled out (`to` null).
 */
export function previewSlots(
  ids: string[],
  drag: { id: string; to: number | null } | null | undefined,
): Map<string, { base: number; slot: number }> {
  const out = new Map<string, { base: number; slot: number }>()
  const from = drag ? ids.indexOf(drag.id) : -1
  if (!drag || from < 0) {
    ids.forEach((id, i) => out.set(id, { base: i, slot: i }))
    return out
  }
  const order = drag.to == null ? ids.filter((x) => x !== drag.id) : moveTo(ids, drag.id, drag.to)
  order.forEach((id, i) => out.set(id, { base: i, slot: i }))
  out.set(drag.id, { base: from, slot: drag.to ?? from })
  return out
}
