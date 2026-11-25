import { describe, expect, it } from 'vitest'
import { reuseStacks, stacksOf } from './stacks'
import type { WidgetElement } from './types'

const w = (id: string, stackId: string, stackOrder: number, x = 0): WidgetElement =>
  ({ id, type: 'widget', kind: 'note', title: id, x, y: 0, w: 100, h: 100, z: 0, stackId, stackOrder }) as WidgetElement

describe('reuseStacks', () => {
  it('keeps a stack object while its members are the same', () => {
    const a = w('a', 's', 0)
    const b = w('b', 's', 1)
    const c = w('c', 't', 0)
    const d = w('d', 't', 1)
    const first = stacksOf([a, b, c, d])
    // one widget of the second stack moves: only that stack is rebuilt
    const next = reuseStacks(first, stacksOf([a, b, c, { ...d, x: 10 }]))
    expect(next.get('s')).toBe(first.get('s'))
    expect(next.get('t')).not.toBe(first.get('t'))
  })
  it('rebuilds a stack whose members changed', () => {
    const a = w('a', 's', 0)
    const b = w('b', 's', 1)
    const first = stacksOf([a, b])
    const next = reuseStacks(first, stacksOf([a, b, w('e', 's', 2)]))
    expect(next.get('s')).not.toBe(first.get('s'))
    expect(next.get('s')!.members).toHaveLength(3)
  })
})
