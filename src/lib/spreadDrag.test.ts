import { describe, expect, it } from 'vitest'
import { spreadRects } from './stacks'
import {
  PULL_PTR_ENTER,
  SWAP_HYST,
  boundsOf,
  distOutside,
  dropOrigin,
  isPulling,
  moveTo,
  outsideFraction,
  previewSlots,
  targetSlot,
  type Rect,
} from './spreadDrag'

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const VW = 1440
const VH = 900
const slotsFor = (n: number) => spreadRects(n, VW, VH, 16 / 10)

describe('targetSlot', () => {
  it('stays put over its own slot and takes a slot it is clearly over', () => {
    const slots = slotsFor(3)
    expect(targetSlot(slots, center(slots[0]), 0)).toBe(0)
    expect(targetSlot(slots, center(slots[2]), 0)).toBe(2)
  })

  it('needs to get past the halfway line by the dead band before swapping', () => {
    const slots = slotsFor(2)
    const a = center(slots[0])
    const b = center(slots[1])
    const mid = (a.x + b.x) / 2
    const band = SWAP_HYST * Math.min(slots[0].w, slots[0].h)
    // just past halfway: still slot 0
    expect(targetSlot(slots, { x: mid + band / 2 - 2, y: a.y }, 0)).toBe(0)
    // clearly past: slot 1
    expect(targetSlot(slots, { x: mid + band / 2 + 2, y: a.y }, 0)).toBe(1)
    // and the same band on the way back
    expect(targetSlot(slots, { x: mid - band / 2 + 2, y: a.y }, 1)).toBe(1)
    expect(targetSlot(slots, { x: mid - band / 2 - 2, y: a.y }, 1)).toBe(0)
  })

  it('picks the nearest slot outright when coming back from a pull-out', () => {
    const slots = slotsFor(3)
    const a = center(slots[0])
    const b = center(slots[1])
    expect(targetSlot(slots, { x: (a.x + b.x) / 2 + 1, y: a.y }, null)).toBe(1)
  })

  // A pointer jiggling a few px either side of every boundary, for every
  // layout the spread uses: the target may change at most once per boundary.
  for (const n of [2, 3, 5, 8]) {
    it(`never ping-pongs on a boundary with ${n} cards`, () => {
      const slots = slotsFor(n)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          if (i === j) continue
          const a = center(slots[i])
          const b = center(slots[j])
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
          for (const start of [i, j]) {
            let cur = start
            let flips = 0
            for (let t = 0; t < 200; t++) {
              const wiggle = Math.sin(t * 1.7) * 6 + Math.cos(t * 0.9) * 3
              const next = targetSlot(slots, { x: mid.x + u.x * wiggle, y: mid.y + u.y * wiggle }, cur)
              if (next !== cur) flips++
              cur = next
            }
            expect(flips).toBeLessThanOrEqual(1)
          }
        }
    })

    it(`always takes a slot once over its centre with ${n} cards`, () => {
      const slots = slotsFor(n)
      for (let cur = 0; cur < n; cur++)
        for (let dest = 0; dest < n; dest++) expect(targetSlot(slots, center(slots[dest]), cur)).toBe(dest)
    })
  }
})

describe('pull-out threshold', () => {
  const grid: Rect = { x: 100, y: 100, w: 800, h: 400 }
  const card = (x: number, y: number): Rect => ({ x, y, w: 200, h: 100 })

  it('measures how much of the card is off the grid', () => {
    expect(outsideFraction(card(200, 200), grid)).toBe(0)
    expect(outsideFraction(card(800, 200), grid)).toBeCloseTo(0.5)
    expect(outsideFraction(card(1000, 200), grid)).toBe(1)
    expect(distOutside({ x: 500, y: 300 }, grid)).toBe(0)
    expect(distOutside({ x: 950, y: 300 }, grid)).toBe(50)
  })

  it('pulls out once half the card is off, and only goes back once mostly in', () => {
    const ptr = { x: 850, y: 250 } // inside the grid
    expect(isPulling(card(760, 200), ptr, grid, false)).toBe(false) // 30% out
    expect(isPulling(card(800, 200), ptr, grid, false)).toBe(true) // 50% out
    // back to 40% out: still pulling (hysteresis)…
    expect(isPulling(card(780, 200), ptr, grid, true)).toBe(true)
    // …until under the exit threshold
    expect(isPulling(card(740, 200), ptr, grid, true)).toBe(false)
  })

  it('pulls out when the pointer is well outside, even if the card is big', () => {
    const big: Rect = { x: 100, y: 100 - 60, w: 800, h: 400 } // 15% out
    expect(isPulling(big, { x: 500, y: 100 - PULL_PTR_ENTER - 1 }, grid, false)).toBe(true)
    expect(isPulling(big, { x: 500, y: 100 - 20 }, grid, false)).toBe(false)
  })

  it('stays steady when jiggling at the threshold', () => {
    const ptr = { x: 850, y: 250 }
    let pulled = false
    let flips = 0
    for (let t = 0; t < 200; t++) {
      // card's left edge wiggling around 50% out (x = 800)
      const next = isPulling(card(800 + Math.sin(t * 1.3) * 12, 200), ptr, grid, pulled)
      if (next !== pulled) flips++
      pulled = next
    }
    expect(flips).toBeLessThanOrEqual(1)
  })

  it('takes the bounds of the slots', () => {
    expect(boundsOf([card(0, 0), card(300, 200)])).toEqual({ x: 0, y: 0, w: 500, h: 300 })
  })
})

describe('dropOrigin', () => {
  it('keeps the held point under the pointer at the same size', () => {
    expect(dropOrigin({ x: 500, y: 300 }, { x: 40, y: 12 }, { w: 600, h: 400 }, { w: 600, h: 400 })).toEqual({
      x: 460,
      y: 288,
    })
  })

  it('scales the held point to the size the widget goes back to', () => {
    // held at the middle of a 600×400 box, restored to 300×200
    expect(dropOrigin({ x: 500, y: 300 }, { x: 300, y: 200 }, { w: 600, h: 400 }, { w: 300, h: 200 })).toEqual({
      x: 350,
      y: 200,
    })
  })

  it('clamps a grab point outside the box', () => {
    expect(dropOrigin({ x: 0, y: 0 }, { x: -10, y: 900 }, { w: 600, h: 400 }, { w: 600, h: 400 })).toEqual({
      x: 0,
      y: -400,
    })
  })
})

describe('preview order', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves an id to an index', () => {
    expect(moveTo(ids, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTo(ids, 'b', 9)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('lays the others out around the target; the dragged card keeps its own base', () => {
    const m = previewSlots(ids, { id: 'a', to: 2 })
    expect(m.get('b')).toEqual({ base: 0, slot: 0 })
    expect(m.get('c')).toEqual({ base: 1, slot: 1 })
    expect(m.get('d')).toEqual({ base: 3, slot: 3 })
    expect(m.get('a')).toEqual({ base: 0, slot: 2 })
  })

  it('closes up the gap while pulling out', () => {
    const m = previewSlots(ids, { id: 'b', to: null })
    expect([m.get('a')!.slot, m.get('c')!.slot, m.get('d')!.slot]).toEqual([0, 1, 2])
    expect(m.get('b')!.base).toBe(1)
  })

  it('is the plain order with no drag', () => {
    const m = previewSlots(ids, null)
    ids.forEach((id, i) => expect(m.get(id)).toEqual({ base: i, slot: i }))
  })
})
