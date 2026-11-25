import { describe, expect, it } from 'vitest'
import type { CanvasElement, Workspace } from './types'
import {
  BASE_LAYER_ID,
  OV,
  activeLayerElements,
  activeLayerId,
  hasLayers,
  landingCamera,
  layerDir,
  layerForPath,
  layerOf,
  layerStatus,
  layersOf,
  glyphCounts,
  coveredLabels,
  labelYs,
  midEllipsis,
  readingOrder,
  matchesQuery,
  widgetGlyph,
  widgetType,
  normalizeLayers,
  ovAnchor,
  ovExtent,
  ovFlat,
  ovLayout,
  ovPose,
  ovPoses,
  ovProject,
  ovText,
  springStep,
  pathWithin,
  shortPath,
} from './layers'
import { fromFile, toFile } from './persistence'

const note = (id: string, layer?: string, x = 0, y = 0): CanvasElement => ({
  id,
  type: 'widget',
  kind: 'note',
  x,
  y,
  w: 100,
  h: 80,
  z: 1,
  title: id,
  ...(layer ? { layer } : {}),
})
const term = (id: string, layer?: string): CanvasElement => ({ ...note(id, layer), kind: 'terminal' }) as CanvasElement

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 't',
  name: 't',
  elements: [],
  camera: { x: 0, y: 0, zoom: 1 },
  createdAt: 0,
  ...over,
})

const layered = () =>
  ws({
    dir: '/Users/me/p/main',
    layers: [
      { id: 'base', name: 'base' },
      { id: 'L-a', name: 'webapp', dir: '/Users/me/p/webapp' },
      { id: 'L-b', name: 'site' },
    ],
    activeLayerId: 'L-a',
    elements: [note('n1'), note('n2', 'L-a'), term('t1', 'L-a'), note('n3', 'L-b')],
  })

describe('layer basics', () => {
  it('a tab without layers is one implicit base layer', () => {
    const w = ws({ elements: [note('a')] })
    expect(layersOf(w).map((l) => l.id)).toEqual([BASE_LAYER_ID])
    expect(hasLayers(w)).toBe(false)
    expect(activeLayerId(w)).toBe(BASE_LAYER_ID)
    expect(activeLayerElements(w)).toBe(w.elements)
  })

  it('elements without a layer are on the base layer', () => {
    expect(layerOf(note('a'))).toBe(BASE_LAYER_ID)
    expect(layerOf(note('a', 'L-x'))).toBe('L-x')
  })

  it('filters to the active layer and falls back from a stale id', () => {
    const w = layered()
    expect(activeLayerElements(w).map((e) => e.id)).toEqual(['n2', 't1'])
    expect(activeLayerId({ ...w, activeLayerId: 'gone' })).toBe('base')
  })

  it("a layer's folder falls back to the tab's", () => {
    const w = layered()
    expect(layerDir(w, 'L-a')).toBe('/Users/me/p/webapp')
    expect(layerDir(w, 'L-b')).toBe('/Users/me/p/main')
    expect(layerDir(w)).toBe('/Users/me/p/webapp') // the active layer
  })
})

describe('layerForPath', () => {
  const w = ws({
    dir: '/Users/me/p',
    layers: [
      { id: 'base', name: 'base' },
      { id: 'a', name: 'p', dir: '/Users/me/p' },
      { id: 'b', name: 'webapp', dir: '/Users/me/p/webapp/' },
    ],
  })
  it('picks the deepest folder that contains the path', () => {
    expect(layerForPath(w, '/Users/me/p/webapp/src')).toBe('b')
    expect(layerForPath(w, '/Users/me/p/webapp')).toBe('b')
    expect(layerForPath(w, '/Users/me/p/other')).toBe('a')
  })
  it("doesn't match a sibling folder that only shares a prefix", () => {
    expect(layerForPath(w, '/Users/me/p/webapp-v2')).toBe('a')
    expect(pathWithin('/a/b', '/a/bc')).toBe(false)
    expect(pathWithin('/a/b', '/a/b/c')).toBe(true)
  })
  it('returns null with no match, no path, or no layers', () => {
    expect(layerForPath(w, '/elsewhere')).toBeNull()
    expect(layerForPath(w, undefined)).toBeNull()
    expect(layerForPath(ws(), '/Users/me/p')).toBeNull()
  })
})

describe('normalizeLayers', () => {
  it('leaves a single-layer tab untouched (same object)', () => {
    const w = ws({ elements: [note('a')] })
    expect(normalizeLayers(w)).toBe(w)
  })
  it('drops a degenerate layer list so the tab saves as before', () => {
    const w = ws({ elements: [note('a')], layers: [{ id: 'base', name: 'base' }], activeLayerId: 'base' })
    const n = normalizeLayers(w)
    expect(n.layers).toBeUndefined()
    expect(n.activeLayerId).toBeUndefined()
  })
  it('rebuilds entries for ids an older build kept on elements', () => {
    const n = normalizeLayers(ws({ elements: [note('a'), note('b', 'L-x'), note('c', 'L-y')] }))
    expect(n.layers!.map((l) => [l.id, l.name])).toEqual([
      ['base', 'base'],
      ['L-x', 'layer 2'],
      ['L-y', 'layer 3'],
    ])
    expect(n.activeLayerId).toBe('base')
  })
  it('adds a missing base and clamps a stale active id', () => {
    const n = normalizeLayers(
      ws({ layers: [{ id: 'L-x', name: 'x' }], activeLayerId: 'nope', elements: [note('b', 'L-x')] }),
    )
    expect(n.layers!.map((l) => l.id)).toEqual(['base', 'L-x'])
    expect(n.activeLayerId).toBe('base')
  })
})

describe('persistence', () => {
  it('a single-layer canvas saves byte-identical to before layers', () => {
    const file = {
      format: 'ccnvs' as const,
      version: 1 as const,
      name: 'old',
      camera: { x: 1, y: 2, zoom: 0.5 },
      elements: [note('a')],
    }
    const text = JSON.stringify(file, null, 2)
    expect(JSON.stringify(toFile(fromFile(JSON.parse(text), 'old')), null, 2)).toBe(text)
  })
  it('a layered canvas round-trips, and writes layers only then', () => {
    const w = layered()
    const f = toFile(w)
    expect(f.layers).toHaveLength(3)
    expect(f.activeLayer).toBe('L-a')
    const back = toFile(fromFile(JSON.parse(JSON.stringify(f)), 'x'))
    expect(back).toEqual(f)
    expect(toFile(ws({ elements: [note('a')] }))).not.toHaveProperty('layers')
  })
})

describe('landingCamera', () => {
  it('prefers the remembered view, else frames the content, else centres', () => {
    const w = layered()
    w.layers![2].camera = { x: 5, y: 6, zoom: 0.7 }
    expect(landingCamera(w, 'L-b', 1000, 800)).toEqual({ x: 5, y: 6, zoom: 0.7 })
    const framed = landingCamera(w, 'L-a', 1000, 800)
    expect(framed.zoom).toBeGreaterThan(0)
    expect(framed.zoom).toBeLessThanOrEqual(1)
    expect(landingCamera(ws({ layers: [{ id: 'base', name: 'b' }, { id: 'e', name: 'e' }] }), 'e', 1000, 800)).toEqual({
      x: 500,
      y: 400,
      zoom: 1,
    })
  })
})

describe('layerStatus', () => {
  it('counts widgets and rolls up agent LEDs on one layer', () => {
    const w = layered()
    w.elements.push(term('t2', 'L-a'), term('t3', 'L-a'))
    const st = layerStatus(w, 'L-a', (id) => ({ t1: 'working', t2: 'waiting', t3: 'done' })[id] as never)
    expect(st).toEqual({ count: 4, working: 1, waiting: 1, done: 1, idle: 0 })
  })
})

describe('shortPath', () => {
  it('abbreviates the home folder', () => {
    expect(shortPath('/Users/me/p/webapp/')).toBe('~/p/webapp')
    expect(shortPath('/home/me')).toBe('~')
    expect(shortPath('/opt/x')).toBe('/opt/x')
  })
})

describe('overview accordion', () => {
  const RAIL = 214
  for (const [n, W, H] of [
    [2, 1280, 780],
    [3, 1440, 860],
    [5, 1440, 860],
    [9, 1280, 780],
    [9, 900, 600],
  ] as const) {
    it(`${n} layers in ${W}×${H} stay between header and footer at every open position`, () => {
      const L = ovLayout(n, W, H, RAIL)
      expect(L.s).toBeGreaterThan(0.17)
      expect(L.s).toBeLessThanOrEqual(0.5)
      // the sheets clear the rail
      const at = Array.from({ length: n }, (_, i) => i)
      for (let pos = 0; pos < n; pos += 0.5) {
        const poses = ovPoses(L, at, pos)
        const e = ovExtent(L, poses)
        expect(e.top).toBeGreaterThanOrEqual(OV.HEAD_H - 1)
        expect(e.bottom).toBeLessThanOrEqual(H - OV.FOOT_H + 1)
        for (const p of poses) expect(ovAnchor(L, p).left).toBeGreaterThan(OV.RAIL_X + RAIL)
      }
    })
  }

  it('opens one sheet nearly flat and folds the rest into slats, higher layers higher up', () => {
    const L = ovLayout(5, 1440, 860, RAIL)
    const p = [0, 1, 2, 3, 4].map((i) => ovPose(L, i - 2))
    expect(p[2].tilt).toBe(OV.OPEN_TILT)
    expect(p[0].tilt).toBe(OV.SLAT_TILT)
    expect(p[4].tilt).toBe(OV.SLAT_TILT)
    // up the stack is up the screen, a fixed gap apart past the first slat
    const ys = p.map((q) => q.y)
    expect(ys).toEqual([...ys].sort((a, b) => b - a))
    expect(ys[3] - ys[4]).toBeCloseTo(L.gap)
    // nearer is lighter, and every sheet is the same size
    expect(p[2].shade).toBeLessThan(p[3].shade)
    expect(p[3].shade).toBeLessThan(p[4].shade)
    expect(new Set(p.map((q) => q.scale)).size).toBe(1)
  })

  it('shows text only on a sheet that is nearly flat', () => {
    expect(ovText(OV.OPEN_TILT)).toBe(1)
    expect(ovText(OV.TEXT_TILT)).toBe(0)
    expect(ovText(OV.SLAT_TILT)).toBe(0)
  })

  it('projects a flat sheet exactly onto the canvas', () => {
    const L = ovLayout(3, 1280, 800, RAIL)
    const f = ovFlat(true)
    expect(ovProject(L, f, -640, -400)).toEqual({ x: 0, y: 0 })
    expect(ovProject(L, f, 640, 400)).toEqual({ x: 1280, y: 800 })
  })

  it('the spring settles on its target in about 350 ms without visible bounce', () => {
    let pos = 0
    let vel = 0
    let peak = 0
    for (let t = 0; t < 0.35; t += 1 / 60) {
      ;[pos, vel] = springStep(pos, vel, 1, 1 / 60)
      peak = Math.max(peak, pos)
    }
    expect(Math.abs(pos - 1)).toBeLessThan(0.03)
    expect(peak).toBeLessThan(1.02)
  })

  it('pushes rail labels apart so they never overlap', () => {
    const ys = labelYs([100, 104, 108, 300], [20, 60, 20, 20])
    expect(ys[0]).toBe(100)
    for (let i = 1; i < ys.length; i++) {
      const h = [20, 60, 20, 20]
      expect(ys[i] - h[i] / 2).toBeGreaterThanOrEqual(ys[i - 1] + h[i - 1] / 2)
    }
    expect(ys[3]).toBe(300) // room to spare: it stays on its sheet
  })

  it('middle-ellipsises long folders, keeping both ends', () => {
    expect(midEllipsis('~/p/webapp', 26)).toBe('~/p/webapp')
    const m = midEllipsis('~/p/webapp/.worktrees/webapp-v2-portrait', 26)
    expect(m).toHaveLength(26)
    expect(m.startsWith('~/p/webapp')).toBe(true)
    expect(m.endsWith('portrait')).toBe(true)
  })
})

describe('glyphs, types and find', () => {
  const ed = { ...note('e'), kind: 'editor', title: 'editor', path: 'src/ui/LayerOverview.tsx' } as CanvasElement
  const mirror = { ...note('m'), kind: 'transcript', title: 'Build Layers', mirrorOf: 'desktop' } as CanvasElement
  const web = { ...note('w'), kind: 'web', title: 'preview', url: 'http://localhost:5173/app' } as CanvasElement
  it('names what a widget is at a glance', () => {
    expect(widgetGlyph(term('t'))).toBe('shell')
    expect(widgetGlyph(mirror)).toBe('mirror')
    expect(widgetType(ed)).toBe('LayerOverview.tsx')
    expect(widgetType(web)).toBe('localhost:5173')
    expect(glyphCounts([term('a'), term('b'), ed, mirror])).toEqual([
      ['mirror', 1],
      ['shell', 2],
      ['code', 1],
    ])
  })
  it('find matches every word across title, type, path and url', () => {
    expect(matchesQuery(ed, 'overview')).toBe(true)
    expect(matchesQuery(ed, 'editor tsx')).toBe(true)
    expect(matchesQuery(ed, 'editor rust')).toBe(false)
    expect(matchesQuery(web, '5173')).toBe(true)
    expect(matchesQuery(mirror, 'desktop')).toBe(true)
  })
})

describe('tiles', () => {
  const box = (id: string, x: number, y: number, w = 400, h = 300) => ({ id, x, y, w, h })
  it('orders tiles in reading order: rows top to bottom, then left to right', () => {
    const r = readingOrder([box('c', 0, 400), box('b', 500, 10), box('a', 0, 0)])
    expect(r).toEqual([2, 1, 0])
  })
  it('hides the text of a tile whose top-left corner another covers', () => {
    const s = coveredLabels([box('a', 0, 0), box('b', 20, 20), box('c', 600, 0)], 150, 50)
    expect([...s]).toEqual(['a'])
  })
  it('keeps the text when only the bottom of a tile is covered', () => {
    const s = coveredLabels([box('a', 0, 0), box('b', 0, 200)], 150, 50)
    expect(s.size).toBe(0)
  })
})

describe('loading odd layer lists', () => {
  it('keeps the first of duplicate ids and names unnamed layers', () => {
    const n = normalizeLayers(
      ws({
        layers: [{ id: 'base', name: 'base' }, { id: 'L-a', name: 'a' }, { id: 'L-a', name: 'dup' }, { id: 'L-b' } as never],
        elements: [note('x', 'L-a')],
      }),
    )
    expect(n.layers!.map((l) => [l.id, l.name])).toEqual([
      ['base', 'base'],
      ['L-a', 'a'],
      ['L-b', 'layer 3'],
    ])
  })
  it('an unknown active layer falls back to the bottom; an empty layer survives a round trip', () => {
    const f = toFile(ws({ layers: [{ id: 'base', name: 'base' }, { id: 'L-e', name: 'empty' }], activeLayerId: 'L-e' }))
    const back = fromFile({ ...JSON.parse(JSON.stringify(f)), activeLayer: 'gone' }, 'x')
    expect(back.layers!.map((l) => l.id)).toEqual(['base', 'L-e'])
    expect(back.activeLayerId).toBe('base')
  })
})
