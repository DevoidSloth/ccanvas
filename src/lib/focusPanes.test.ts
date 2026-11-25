import { describe, expect, it } from 'vitest'
import { addPane, dragDivider, equalSizes, MIN_PANE_W, PANE_GAP, paneBoxes, removePane } from './focusPanes'

const box = { x: 16, y: 52, w: 1000, h: 600 }

describe('paneBoxes', () => {
  it('one pane fills the box', () => {
    expect(paneBoxes(box, [1])).toEqual([box])
  })
  it('splits into columns with a gap, ending flush', () => {
    const [a, b] = paneBoxes(box, equalSizes(2))
    expect(a.x).toBe(16)
    expect(b.x).toBeCloseTo(a.x + a.w + PANE_GAP)
    expect(b.x + b.w).toBeCloseTo(box.x + box.w)
    expect(a.w).toBeCloseTo(b.w)
    expect(a.h).toBe(600)
  })
})

describe('dragDivider', () => {
  it('trades width between neighbours', () => {
    const s = dragDivider([0.5, 0.5], 0, 100, box.w)
    expect(s[0] + s[1]).toBeCloseTo(1)
    expect(s[0]).toBeGreaterThan(0.5)
  })
  it('stops at the minimum width', () => {
    const s = dragDivider([0.5, 0.5], 0, 5000, box.w)
    const [, b] = paneBoxes(box, s)
    expect(b.w).toBeCloseTo(MIN_PANE_W)
  })
  it('ignores a divider that does not exist', () => {
    expect(dragDivider([1], 0, 10, box.w)).toEqual([1])
  })
})

describe('pane lists', () => {
  it('adds beside the given pane, once', () => {
    expect(addPane(['a', 'b'], 'a', 'c')).toEqual(['a', 'c', 'b'])
    expect(addPane(['a'], null, 'c')).toEqual(['a', 'c'])
    expect(addPane(['a', 'c'], 'a', 'c')).toEqual(['a', 'c'])
  })
  it('removes and renormalizes', () => {
    const r = removePane(['a', 'b', 'c'], [0.5, 0.25, 0.25], 'a')
    expect(r.panes).toEqual(['b', 'c'])
    expect(r.sizes).toEqual([0.5, 0.5])
    expect(removePane(['a'], [1], 'z').panes).toEqual(['a'])
  })
})
