import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasElement, Workspace } from '../lib/types'
import { useStore } from './workspace'

const widget = (id: string, layer?: string, extra: Partial<CanvasElement> = {}): CanvasElement =>
  ({
    id,
    type: 'widget',
    kind: 'terminal',
    x: 10,
    y: 20,
    w: 100,
    h: 80,
    z: 1,
    title: id,
    ...(layer ? { layer } : {}),
    ...extra,
  }) as CanvasElement

const arrow = (id: string, from: string, to: string, layer?: string): CanvasElement =>
  ({
    id,
    type: 'arrow',
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 1,
    color: '#fff',
    size: 2,
    z: 1,
    from: { id: from },
    to: { id: to },
    ...(layer ? { layer } : {}),
  }) as CanvasElement

function load(ws: Partial<Workspace>) {
  const tab: Workspace = {
    id: 'tab',
    name: 'tab',
    elements: [],
    camera: { x: 0, y: 0, zoom: 1 },
    createdAt: 0,
    ...ws,
  }
  useStore.setState({ tabs: [tab], activeTabId: 'tab', selection: [], activeWidgetId: null })
}
const ws = () => useStore.getState().active()!
const el = (id: string) => ws().elements.find((e) => e.id === id)!

beforeEach(() =>
  load({
    layers: [
      { id: 'base', name: 'base' },
      { id: 'L-a', name: 'a' },
      { id: 'L-b', name: 'b' },
    ],
    activeLayerId: 'base',
    elements: [
      widget('w1'),
      widget('w2', undefined, { groupId: 'g' }),
      widget('w3', undefined, { groupId: 'g' }),
      widget('lbl', undefined, { labelFor: 'w1' }),
      arrow('ar-both', 'w1', 'w2'),
      arrow('ar-half', 'w1', 'w9'),
      widget('w9'),
      widget('wa', 'L-a'),
    ],
  }),
)

describe('moveToLayer', () => {
  it('keeps x/y and carries group siblings, label boxes and arrows with both ends', () => {
    useStore.getState().setSelection(['w1', 'w2'])
    useStore.getState().moveToLayer(['w1', 'w2'], 'L-b')
    for (const id of ['w1', 'w2', 'w3', 'lbl', 'ar-both']) expect(el(id).layer).toBe('L-b')
    expect(el('ar-half').layer).toBeUndefined() // one end stays behind
    expect(el('w9').layer).toBeUndefined()
    expect(el('w1')).toMatchObject({ x: 10, y: 20 })
    // what left the layer you're on is no longer selected
    expect(useStore.getState().selection).toEqual([])
  })

  it('moving back to base removes the field, and undo restores', () => {
    useStore.getState().moveToLayer(['wa'], 'base')
    expect(el('wa')).not.toHaveProperty('layer')
    useStore.getState().undo()
    expect(el('wa').layer).toBe('L-a')
  })

  it('ignores an unknown layer', () => {
    useStore.getState().moveToLayer(['w1'], 'nope')
    expect(el('w1').layer).toBeUndefined()
  })
})

describe('addLayer and stamping', () => {
  it('materialises the base layer on first use and stamps new elements', () => {
    load({ elements: [widget('x')] })
    const id = useStore.getState().addLayer({ name: 'proj', dir: '/tmp/proj', activate: true })!
    expect(ws().layers!.map((l) => l.id)).toEqual(['base', id])
    useStore.getState().addElement(widget('new'))
    expect(el('new').layer).toBe(id)
    useStore.getState().setActiveLayer('base')
    useStore.getState().addElement(widget('new2'))
    expect(el('new2')).not.toHaveProperty('layer')
  })

  it('spawnWidget opens in the layer folder', () => {
    load({ dir: '/tmp/tab', elements: [] })
    useStore.getState().addLayer({ name: 'proj', dir: '/tmp/proj', activate: true })
    const id = useStore.getState().spawnWidget('terminal', 0, 0)
    expect((el(id) as { cwd?: string }).cwd).toBe('/tmp/proj')
  })
})

describe('setActiveLayer', () => {
  it('drops focus state and swaps cameras per layer', () => {
    useStore.setState({ selection: ['w1'], activeWidgetId: 'w1', editingTextId: 'w1' })
    useStore.getState().setCamera({ x: 5, y: 6, zoom: 0.5 })
    useStore.getState().setActiveLayer('L-a')
    const s = useStore.getState()
    expect(s.selection).toEqual([])
    expect(s.activeWidgetId).toBeNull()
    expect(s.editingTextId).toBeNull()
    expect(ws().layers!.find((l) => l.id === 'base')!.camera).toEqual({ x: 5, y: 6, zoom: 0.5 })
    useStore.getState().setCamera({ x: 1, y: 1, zoom: 1 })
    useStore.getState().setActiveLayer('base')
    expect(ws().camera).toEqual({ x: 5, y: 6, zoom: 0.5 })
  })
})

describe('moveLayer and removeLayer', () => {
  it('reorders the stack', () => {
    useStore.getState().moveLayer('L-b', 0)
    expect(ws().layers!.map((l) => l.id)).toEqual(['L-b', 'base', 'L-a'])
  })

  it('removing a layer merges its widgets into the one below and keeps them', () => {
    useStore.getState().setActiveLayer('L-a')
    const into = useStore.getState().removeLayer('L-a')
    expect(into).toBe('base')
    expect(el('wa')).not.toHaveProperty('layer') // now on base
    expect(ws().activeLayerId).toBe('base')
    expect(ws().layers!.map((l) => l.id)).toEqual(['base', 'L-b'])
  })

  it('the base layer stays', () => {
    expect(useStore.getState().removeLayer('base')).toBeNull()
    expect(ws().layers).toHaveLength(3)
  })

  it('back to one layer, the tab is a plain single-layer canvas again', () => {
    useStore.getState().removeLayer('L-b')
    useStore.getState().removeLayer('L-a')
    expect(ws().layers).toBeUndefined()
    expect(ws().activeLayerId).toBeUndefined()
    expect(ws().elements.every((e) => e.layer === undefined)).toBe(true)
  })
})

describe('history and the focus-leak rule', () => {
  it('redo that moves the active widget off the shown layer drops it', () => {
    useStore.getState().moveToLayer(['w9'], 'L-a') // undoable
    useStore.getState().undo() // w9 back on base, where you are
    useStore.setState({ activeWidgetId: 'w9' }) // you click into it
    useStore.getState().redo() // it leaves the layer again
    expect(el('w9').layer).toBe('L-a')
    expect(useStore.getState().activeWidgetId).toBeNull()
  })
  it('undo after removing a layer brings its widgets back to a real layer', () => {
    useStore.getState().moveToLayer(['w9'], 'L-b')
    useStore.getState().moveToLayer(['w9'], 'L-b') // its history snapshot has w9 on L-b
    useStore.getState().removeLayer('L-b') // w9 merges into L-a
    useStore.getState().undo() // restores a snapshot where w9 is on L-b
    const w = ws()
    expect(w.layers!.some((l) => l.id === el('w9').layer)).toBe(true)
  })
})

describe('undoing a layer removal', () => {
  it('puts the widgets back on their own (re-created) layer', () => {
    useStore.getState().removeLayer('L-a')
    expect(el('wa')).not.toHaveProperty('layer')
    useStore.getState().undo()
    expect(el('wa').layer).toBe('L-a')
    expect(ws().layers!.some((l) => l.id === 'L-a')).toBe(true)
  })
})
