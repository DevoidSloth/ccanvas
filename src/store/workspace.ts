import { create } from 'zustand'
import type {
  Camera,
  CanvasElement,
  FrameElement,
  TextElement,
  Tool,
  Workspace,
  WidgetElement,
  WidgetKind,
  Template,
  Prompt,
} from '../lib/types'
import { DEFAULT_CAMERA, PALETTE, WIDGET_ACCENT } from '../lib/types'
import { boundsOfMany, clamp, elementBounds, translated } from '../lib/geometry'
import { newId } from '../lib/id'
import {
  loadSession,
  openWorkspace as fsOpen,
  saveSession,
  saveWorkspace as fsSave,
  toFile,
  fromFile,
  loadTemplates,
  saveTemplates,
  loadPrompts,
  savePrompts,
} from '../lib/persistence'
import {
  backendOnline,
  pickDir,
  pickFile,
  saveFile,
  baseName,
  dirName,
  joinPath,
} from '../lib/backend'
import { resetFlowState } from '../lib/flow'
import { startTracking, stopTracking } from '../lib/tracker'
import { killPty } from '../lib/terminal'

let zCounter = 1
const nextZ = () => zCounter++

// clipboard + frame-drag bookkeeping live outside the reactive store
let clipboard: CanvasElement[] = []
let frameDragChildren: Set<string> | null = null

// ---------- per-tab undo history (kept out of the reactive store) ----------
type Snapshot = CanvasElement[]
const history = new Map<string, { past: Snapshot[]; future: Snapshot[] }>()
const histOf = (id: string) => {
  let h = history.get(id)
  if (!h) {
    h = { past: [], future: [] }
    history.set(id, h)
  }
  return h
}

function makeWorkspace(name: string, dir?: string): Workspace {
  return {
    id: newId(),
    name,
    elements: [],
    camera: { ...DEFAULT_CAMERA },
    createdAt: Date.now(),
    dir,
    dirty: false,
  }
}

// ---------- widget defaults ----------
const WIDGET_SIZE: Record<WidgetKind, { w: number; h: number }> = {
  terminal: { w: 520, h: 340 },
  agent: { w: 540, h: 380 },
  web: { w: 480, h: 360 },
  note: { w: 320, h: 240 },
  files: { w: 300, h: 420 },
  diff: { w: 680, h: 460 },
  editor: { w: 560, h: 440 },
  doc: { w: 420, h: 420 },
  log: { w: 520, h: 320 },
  pr: { w: 460, h: 360 },
  issues: { w: 460, h: 360 },
  runs: { w: 500, h: 360 },
  runner: { w: 520, h: 360 },
  sql: { w: 760, h: 500 },
  data: { w: 680, h: 460 },
  plot: { w: 520, h: 440 },
  transcript: { w: 460, h: 520 },
  video: { w: 560, h: 380 },
  mediainfo: { w: 340, h: 440 },
  claude: { w: 1120, h: 720 },
}
const WIDGET_TITLE: Record<WidgetKind, string> = {
  terminal: 'terminal',
  agent: 'claude agent',
  web: 'web preview',
  note: 'note',
  files: 'files',
  diff: 'git diff',
  editor: 'editor',
  doc: 'doc',
  log: 'log',
  pr: 'pull requests',
  issues: 'issues',
  runs: 'actions',
  runner: 'runner',
  sql: 'sql editor',
  data: 'data',
  plot: 'figure',
  transcript: 'transcript',
  video: 'video',
  mediainfo: 'media info',
  claude: 'claude workspace',
}

/** Expand a set of ids to include every sibling sharing a groupId. */
export function withGroupSiblings(
  elements: CanvasElement[],
  ids: string[],
): string[] {
  const groups = new Set<string>()
  const sel = new Set(ids)
  for (const el of elements)
    if (sel.has(el.id) && el.groupId) groups.add(el.groupId)
  if (!groups.size) return ids
  const out = new Set(ids)
  for (const el of elements)
    if (el.groupId && groups.has(el.groupId)) out.add(el.id)
  return [...out]
}

/** Ask the backend (or the user) for an absolute folder path. */
async function chooseDir(current?: string): Promise<string | null | undefined> {
  if (await backendOnline()) return pickDir() // string | null (null = cancelled)
  const typed = window.prompt(
    'Folder for this canvas (absolute path).\n' +
      'Tip: run `npm run server` for a native folder picker + real terminals.',
    current ?? '',
  )
  if (typed == null) return null // cancelled
  return typed.trim() || undefined
}

export type AlignMode =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom'

/** Context for the new/edit-agent wizard modal. */
export type AgentWizardCtx = {
  x: number
  y: number
  editId?: string // editing an existing agent rather than creating
  model?: string
  cwd?: string
  worktree?: string
  title?: string
  agentPrompt?: string
}

/** Side panels that share the right-hand dock (only one open at a time). */
export type SidePanel = 'roster' | 'prompts' | 'checkpoints'

export type Store = {
  tabs: Workspace[]
  activeTabId: string | null
  tool: Tool
  color: string
  strokeWidth: number
  selection: string[]
  /** widget whose body currently receives pointer input (iframe/terminal) */
  activeWidgetId: string | null
  editingTextId: string | null
  templates: Template[]
  /** reusable prompt snippets (prompt library) */
  prompts: Prompt[]
  paletteOpen: boolean
  agentWizard: AgentWizardCtx | null
  /** which docked side panel is open (roster / prompts / checkpoints), if any */
  openPanel: SidePanel | null
  /** the canvas-wide content search overlay */
  searchOpen: boolean
  /** auto-pan the camera to whichever agent most recently started working */
  followAgent: boolean
  /** the agent currently being followed by the tracking camera, if any */
  trackingAgentId: string | null
  /** active alignment guide lines (world coords), shown while moving/resizing */
  snapGuides: { vx: number | null; hy: number | null } | null
  /** frame-by-frame presentation mode */
  presenting: boolean
  /** master switch for arrow orchestration (flow edges between agents) */
  flowsEnabled: boolean

  // ----- derived -----
  active: () => Workspace | null

  // ----- tabs -----
  newTab: () => Promise<void>
  /** open a dedicated tab hosting the Claude knowledge-graph node map */
  openClaudeWorkspace: () => void
  closeTab: (id: string) => void
  switchTab: (id: string) => void
  renameTab: (id: string, name: string) => void
  setActiveDir: () => Promise<void>
  openFile: () => Promise<void>
  saveActive: (forceDialog?: boolean) => Promise<void>

  // ----- tools -----
  setTool: (t: Tool) => void
  setColor: (c: string) => void
  setStrokeWidth: (w: number) => void

  // ----- camera -----
  setCamera: (c: Camera) => void
  /** recenter (and fit) the active canvas in a viewport of vw×vh px */
  homeView: (vw: number, vh: number) => void

  // ----- elements -----
  addElement: (el: CanvasElement) => void
  addElements: (els: CanvasElement[]) => void
  updateElement: (id: string, patch: Partial<CanvasElement>) => void
  mutateElement: (id: string, fn: (el: CanvasElement) => void) => void
  removeElements: (ids: string[]) => void
  /** spawn a widget centred at (x,y); returns the new element id */
  spawnWidget: (
    kind: WidgetKind,
    x: number,
    y: number,
    init?: Partial<WidgetElement>,
  ) => string
  /** drop an image (data URL) centred at (x,y) */
  addImage: (
    src: string,
    naturalW: number,
    naturalH: number,
    x: number,
    y: number,
  ) => void
  /** wrap a widget in a labelled box (a frame + its name centred in the top gap) */
  labelAgent: (id: string) => void

  // ----- selection -----
  setSelection: (ids: string[]) => void
  /** select these ids plus their group siblings (for user clicks) */
  selectWithGroups: (ids: string[]) => void
  clearSelection: () => void
  deleteSelection: () => void
  moveSelection: (dx: number, dy: number) => void
  beginFrameDrag: () => void
  endFrameDrag: () => void
  bringToFront: (ids: string[]) => void
  sendToBack: (ids: string[]) => void
  setActiveWidget: (id: string | null) => void
  setEditingText: (id: string | null) => void

  // ----- arrange -----
  copySelection: () => void
  cutSelection: () => void
  pasteClipboard: (x?: number, y?: number) => void
  duplicateSelection: () => void
  group: () => void
  ungroup: () => void
  toggleLock: () => void
  align: (mode: AlignMode) => void
  distribute: (axis: 'h' | 'v') => void
  tidy: () => void

  // ----- templates -----
  saveTemplate: (name: string) => void
  applyTemplate: (id: string, x: number, y: number) => void
  deleteTemplate: (id: string) => void

  // ----- command palette -----
  setPaletteOpen: (open: boolean) => void

  // ----- side panels / search -----
  setOpenPanel: (p: SidePanel | null) => void
  togglePanel: (p: SidePanel) => void
  setSearchOpen: (open: boolean) => void

  // ----- prompt library -----
  savePrompt: (name: string, text: string) => void
  updatePrompt: (id: string, patch: Partial<Prompt>) => void
  deletePrompt: (id: string) => void

  // ----- agent cameras -----
  setFollowAgent: (on: boolean) => void
  startTrackingAgent: (id: string) => Promise<void>
  stopTrackingAgent: (cleanup: boolean) => void

  // ----- agent wizard -----
  openAgentWizard: (ctx: AgentWizardCtx) => void
  closeAgentWizard: () => void

  // ----- snap guides -----
  setSnapGuides: (g: { vx: number | null; hy: number | null } | null) => void

  // ----- view -----
  setPresenting: (on: boolean) => void
  /** zoom/pan to fit the current selection (or everything) in vw×vh px */
  zoomToSelection: (vw: number, vh: number) => void

  // ----- flows -----
  setFlowsEnabled: (on: boolean) => void

  // ----- history -----
  beginHistory: () => void
  undo: () => void
  redo: () => void
}

function patchActive(
  state: Store,
  fn: (ws: Workspace) => Workspace,
): Partial<Store> {
  const tabs = state.tabs.map((t) => (t.id === state.activeTabId ? fn(t) : t))
  return { tabs }
}

export const useStore = create<Store>((set, get) => ({
  tabs: [],
  activeTabId: null,
  tool: 'select',
  color: PALETTE[0],
  strokeWidth: 3,
  selection: [],
  activeWidgetId: null,
  editingTextId: null,
  templates: loadTemplates(),
  prompts: loadPrompts(),
  paletteOpen: false,
  agentWizard: null,
  openPanel: null,
  searchOpen: false,
  followAgent: false,
  trackingAgentId: null,
  snapGuides: null,
  presenting: false,
  flowsEnabled: true,

  active: () => {
    const s = get()
    return s.tabs.find((t) => t.id === s.activeTabId) ?? null
  },

  // ---------- tabs ----------
  // A new canvas is bound to a real folder (where its .ccnvs lives and the
  // working directory terminals/agents open in). If the user declines we still
  // create an unbound canvas so they're never stuck.
  newTab: async () => {
    const dir = await chooseDir()
    const realDir = dir || undefined
    const name = realDir ? baseName(realDir) : `untitled-${get().tabs.length + 1}`
    const ws = makeWorkspace(name, realDir)
    set((s) => ({
      tabs: [...s.tabs, ws],
      activeTabId: ws.id,
      selection: [],
      activeWidgetId: null,
    }))
  },

  // A special tab that hosts a single, locked "claude" widget filling the
  // canvas — the Claude knowledge-graph node map (see ClaudeBody, which renders
  // the bundled claude-graph.html). Reuses the active canvas's folder as cwd.
  openClaudeWorkspace: () => {
    // if one is already open, just switch to it
    const existing = get().tabs.find((t) =>
      t.elements.some((e) => e.type === 'widget' && (e as WidgetElement).kind === 'claude'),
    )
    if (existing) {
      set({ activeTabId: existing.id, selection: [], activeWidgetId: null })
      return
    }
    const dir = get().active()?.dir
    const ws = makeWorkspace('claude', dir)
    const { w, h } = WIDGET_SIZE.claude
    const id = newId()
    const el: WidgetElement = {
      id,
      type: 'widget',
      kind: 'claude',
      x: -w / 2,
      y: -h / 2,
      w,
      h,
      z: nextZ(),
      title: WIDGET_TITLE.claude,
      locked: true,
      ...(dir ? { cwd: dir } : {}),
    }
    ws.elements = [el]
    // frame the widget in the middle of the viewport, zoomed to fit
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
    const vh = typeof window !== 'undefined' ? window.innerHeight - 82 : 720
    const pad = 60
    const zoom = clamp(Math.min(vw / (w + pad * 2), vh / (h + pad * 2)), 0.3, 1)
    ws.camera = { zoom, x: vw / 2, y: vh / 2 }
    set((s) => ({
      tabs: [...s.tabs, ws],
      activeTabId: ws.id,
      selection: [],
      activeWidgetId: null,
    }))
  },

  setActiveDir: async () => {
    const ws = get().active()
    if (!ws) return
    const dir = await chooseDir(ws.dir)
    if (dir === null) return // cancelled
    const realDir = dir || undefined
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== ws.id) return t
        const renamable = t.name === '' || /^untitled-\d+$/.test(t.name)
        return {
          ...t,
          dir: realDir,
          name: realDir && renamable ? baseName(realDir) : t.name,
          dirty: true,
        }
      }),
    }))
  },

  closeTab: (id) => {
    // closing a tab discards its widgets for good — end their shells too
    const tab = get().tabs.find((t) => t.id === id)
    const trackId = get().trackingAgentId
    if (tab) {
      if (trackId && tab.elements.some((e) => e.id === trackId))
        get().stopTrackingAgent(false)
      for (const e of tab.elements)
        if (e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent'))
          killPty(e.id)
    }
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      let tabs = s.tabs.filter((t) => t.id !== id)
      history.delete(id)
      // never leave the app with zero tabs
      if (tabs.length === 0) {
        const fresh = makeWorkspace('untitled-1')
        return {
          tabs: [fresh],
          activeTabId: fresh.id,
          selection: [],
          activeWidgetId: null,
        }
      }
      let activeTabId = s.activeTabId
      if (s.activeTabId === id) {
        activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? tabs[0].id
      }
      return { tabs, activeTabId, selection: [], activeWidgetId: null }
    })
  },

  switchTab: (id) =>
    set({ activeTabId: id, selection: [], activeWidgetId: null, editingTextId: null }),

  renameTab: (id, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name, dirty: true } : t)),
    })),

  openFile: async () => {
    let ws: Workspace | null = null
    if (await backendOnline()) {
      const f = await pickFile()
      if (!f) return
      try {
        ws = fromFile(JSON.parse(f.content), baseName(f.path).replace(/\.ccnvs$/i, ''))
        ws.dir = dirName(f.path)
      } catch {
        return
      }
    } else {
      ws = await fsOpen()
    }
    if (!ws) return
    const opened = ws
    // bump z counter past any imported elements
    for (const el of opened.elements) zCounter = Math.max(zCounter, el.z + 1)
    set((s) => ({
      tabs: [...s.tabs, opened],
      activeTabId: opened.id,
      selection: [],
      activeWidgetId: null,
    }))
  },

  saveActive: async (forceDialog = false) => {
    const ws = get().active()
    if (!ws) return
    let ok = false
    // bound to a real folder → write <dir>/<name>.ccnvs via the backend
    if (ws.dir && !forceDialog && (await backendOnline())) {
      ok = await saveFile(
        joinPath(ws.dir, `${ws.name}.ccnvs`),
        JSON.stringify(toFile(ws), null, 2),
      )
    }
    // otherwise (or if that failed) fall back to File System Access / download
    if (!ok) ok = await fsSave(ws, forceDialog)
    if (ok) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === ws.id ? { ...t, dirty: false } : t)),
      }))
    }
  },

  // ---------- tools ----------
  setTool: (t) => set({ tool: t, activeWidgetId: null, editingTextId: null }),
  setColor: (c) => {
    set({ color: c })
    // recolor selected ink/shapes/frames live
    const { selection } = get()
    if (!selection.length) return
    const sel = new Set(selection)
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        dirty: true,
        elements: ws.elements.map((e) =>
          sel.has(e.id) && e.type !== 'widget' && 'color' in e
            ? ({ ...e, color: c } as CanvasElement)
            : e,
        ),
      })),
    )
  },
  setStrokeWidth: (w) => set({ strokeWidth: w }),

  // ---------- camera ----------
  setCamera: (c) => set((s) => patchActive(s, (ws) => ({ ...ws, camera: c }))),

  homeView: (vw, vh) => {
    const ws = get().active()
    if (!ws) return
    const b = boundsOfMany(ws.elements)
    let cam: Camera
    if (!b) {
      // empty canvas → put the world origin at the viewport centre
      cam = { x: vw / 2, y: vh / 2, zoom: 1 }
    } else {
      const pad = 90
      const zoom = clamp(
        Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2)),
        0.1,
        1,
      )
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      cam = { zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom }
    }
    get().setCamera(cam)
  },

  // ---------- elements ----------
  // New elements always render on top, so we (re)assign a fresh z on insert.
  addElement: (el) =>
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: [...ws.elements, { ...el, z: nextZ() } as CanvasElement],
        dirty: true,
      })),
    ),

  addElements: (els) =>
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: [
          ...ws.elements,
          ...els.map((el) => ({ ...el, z: nextZ() }) as CanvasElement),
        ],
        dirty: true,
      })),
    ),

  updateElement: (id, patch) =>
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: ws.elements.map((e) =>
          e.id === id ? ({ ...e, ...patch } as CanvasElement) : e,
        ),
        dirty: true,
      })),
    ),

  mutateElement: (id, fn) =>
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: ws.elements.map((e) => {
          if (e.id !== id) return e
          const copy = { ...e } as CanvasElement
          fn(copy)
          return copy
        }),
        dirty: true,
      })),
    ),

  removeElements: (ids) => {
    const set_ = new Set(ids)
    // tracking ends if the tracked agent itself is being removed
    const trackId = get().trackingAgentId
    if (trackId && set_.has(trackId)) get().stopTrackingAgent(false)
    const ws = get().active()
    // also remove any label-box parts (frame + name) attached to a removed widget
    if (ws)
      for (const e of ws.elements)
        if (e.labelFor && set_.has(e.labelFor)) set_.add(e.id)
    // tear down the real shells behind any terminal/agent widgets being removed.
    // Incidental unmounts (a dev hot-reload, a tab switch) never come through
    // here, so those sessions stay alive to be re-attached.
    if (ws)
      for (const e of ws.elements)
        if (
          set_.has(e.id) &&
          e.type === 'widget' &&
          (e.kind === 'terminal' || e.kind === 'agent')
        )
          killPty(e.id)
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        elements: w.elements.filter((e) => !set_.has(e.id)),
        dirty: true,
      })),
    )
  },

  spawnWidget: (kind, x, y, init) => {
    const { w, h } = WIDGET_SIZE[kind]
    const id = newId()
    const dir = get().active()?.dir
    const el: CanvasElement = {
      id,
      type: 'widget',
      kind,
      x: x - w / 2,
      y: y - h / 2,
      w,
      h,
      z: 0,
      title: WIDGET_TITLE[kind],
      ...(kind === 'web' || kind === 'video' ? { url: '' } : {}),
      ...(kind === 'note'
        ? { note: '# notes\n\n- [ ] a task\n- [x] done\n\nclick to edit · click a box to check' }
        : {}),
      // terminals/agents/files/diff/editor/doc/log open in the canvas folder
      ...(dir ? { cwd: dir } : {}),
      ...(dir && (kind === 'files' || kind === 'diff' || kind === 'log')
        ? { path: dir }
        : {}),
      // agents get a stable claude session id so reopening can --resume it
      ...(kind === 'agent' ? { sessionId: crypto.randomUUID() } : {}),
      ...init,
    }
    get().beginHistory()
    get().addElement(el)
    // auto-focus the new widget so notes/terminals are usable immediately
    set({ selection: [id], tool: 'select', activeWidgetId: id })
    return id
  },

  addImage: (src, naturalW, naturalH, x, y) => {
    // fit within a reasonable default box, preserving aspect ratio
    const max = 420
    const scale = Math.min(1, max / Math.max(naturalW, naturalH))
    const w = Math.max(40, Math.round(naturalW * scale))
    const h = Math.max(40, Math.round(naturalH * scale))
    const id = newId()
    get().beginHistory()
    get().addElement({
      id,
      type: 'image',
      x: x - w / 2,
      y: y - h / 2,
      w,
      h,
      src,
      naturalW,
      naturalH,
      z: 0,
    })
    set({ selection: [id], tool: 'select' })
  },

  labelAgent: (id) => {
    const ws = get().active()
    if (!ws) return
    const el = ws.elements.find((e) => e.id === id)
    if (!el || el.type !== 'widget') return
    // toggle: if this widget already has a label box, remove it instead
    const existing = ws.elements.filter((e) => e.labelFor === id)
    if (existing.length) {
      get().beginHistory()
      get().removeElements(existing.map((e) => e.id))
      return
    }
    const w = el as WidgetElement
    // a tall top gap holds the name; even padding elsewhere centres the widget
    const padX = 28
    const padBottom = 28
    const topGap = 56
    const accent = w.color || WIDGET_ACCENT[w.kind] || PALETTE[4]
    const frame: FrameElement = {
      id: newId(),
      type: 'frame',
      x: w.x - padX,
      y: w.y - topGap,
      w: w.w + padX * 2,
      h: w.h + topGap + padBottom,
      // blank title — the centred text below is the visible label
      title: '',
      color: accent,
      z: 0,
      labelFor: id,
    }
    const name = w.title || 'agent'
    const fontSize = 16
    const approxW = Math.max(20, name.length * fontSize * 0.6)
    const label: TextElement = {
      id: newId(),
      type: 'text',
      // centre over the widget, vertically mid-way in the top gap
      x: w.x + w.w / 2 - approxW / 2,
      y: w.y - topGap / 2 - (fontSize * 1.4) / 2,
      text: name,
      color: accent,
      fontSize,
      z: 0,
      labelFor: id,
    }
    get().beginHistory()
    get().addElements([frame, label])
    set({ selection: [frame.id], tool: 'select' })
  },

  // ---------- selection ----------
  setSelection: (ids) => set({ selection: ids }),
  selectWithGroups: (ids) => {
    const ws = get().active()
    set({ selection: ws ? withGroupSiblings(ws.elements, ids) : ids })
  },
  clearSelection: () =>
    set({ selection: [], activeWidgetId: null, editingTextId: null }),

  deleteSelection: () => {
    const ws = get().active()
    if (!ws) return
    const locked = new Set(
      ws.elements.filter((e) => e.locked).map((e) => e.id),
    )
    const ids = get().selection.filter((id) => !locked.has(id))
    if (!ids.length) return
    get().beginHistory()
    get().removeElements(ids)
    set({ selection: [], activeWidgetId: null })
  },

  moveSelection: (dx, dy) => {
    const base = new Set(get().selection)
    if (frameDragChildren) for (const id of frameDragChildren) base.add(id)
    if (!base.size) return
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        dirty: true,
        elements: ws.elements.map((e) =>
          base.has(e.id) && !e.locked ? translated(e, dx, dy) : e,
        ),
      })),
    )
  },

  // when a frame is in the selection, dragging it carries the elements inside
  beginFrameDrag: () => {
    const ws = get().active()
    if (!ws) {
      frameDragChildren = null
      return
    }
    const sel = new Set(get().selection)
    const frames = ws.elements.filter((e) => e.type === 'frame' && sel.has(e.id))
    if (!frames.length) {
      frameDragChildren = null
      return
    }
    const kids = new Set<string>()
    for (const f of frames) {
      const fb = elementBounds(f)
      for (const e of ws.elements) {
        if (e.id === f.id || sel.has(e.id)) continue
        const b = elementBounds(e)
        const cx = b.x + b.w / 2
        const cy = b.y + b.h / 2
        if (
          cx >= fb.x &&
          cx <= fb.x + fb.w &&
          cy >= fb.y &&
          cy <= fb.y + fb.h
        )
          kids.add(e.id)
      }
    }
    frameDragChildren = kids.size ? kids : null
  },
  endFrameDrag: () => {
    frameDragChildren = null
  },

  bringToFront: (ids) => {
    const set_ = new Set(ids)
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: ws.elements.map((e) =>
          set_.has(e.id) ? { ...e, z: nextZ() } : e,
        ),
      })),
    )
  },

  sendToBack: (ids) => {
    const set_ = new Set(ids)
    // shift everyone up, drop the selection to the bottom preserving order
    set((s) =>
      patchActive(s, (ws) => {
        const minZ = Math.min(...ws.elements.map((e) => e.z), 1)
        let base = minZ - set_.size - 1
        const order = ws.elements
          .filter((e) => set_.has(e.id))
          .sort((a, b) => a.z - b.z)
          .map((e) => e.id)
        const zOf = new Map(order.map((id, i) => [id, base + i]))
        return {
          ...ws,
          elements: ws.elements.map((e) =>
            zOf.has(e.id) ? { ...e, z: zOf.get(e.id)! } : e,
          ),
        }
      }),
    )
  },

  setActiveWidget: (id) => set({ activeWidgetId: id }),
  setEditingText: (id) => set({ editingTextId: id }),

  // ---------- arrange: clipboard ----------
  copySelection: () => {
    const ws = get().active()
    if (!ws) return
    const sel = new Set(get().selection)
    clipboard = ws.elements.filter((e) => sel.has(e.id)).map((e) => ({ ...e }))
  },

  cutSelection: () => {
    get().copySelection()
    get().deleteSelection()
  },

  pasteClipboard: (x, y) => {
    if (!clipboard.length) return
    const b = boundsOfMany(clipboard)
    // offset so the cluster lands at (x,y) if given, else nudged down-right
    let dx = 24
    let dy = 24
    if (b && x != null && y != null) {
      dx = x - (b.x + b.w / 2)
      dy = y - (b.y + b.h / 2)
    }
    // remap ids + group ids so copies are independent
    const idMap = new Map<string, string>()
    const groupMap = new Map<string, string>()
    const copies = clipboard.map((e) => {
      const ne = translated({ ...e }, dx, dy)
      ne.id = newId()
      idMap.set(e.id, ne.id)
      if (e.groupId) {
        if (!groupMap.has(e.groupId)) groupMap.set(e.groupId, newId())
        ne.groupId = groupMap.get(e.groupId)
      }
      // fresh agent sessions for pasted agents
      if (ne.type === 'widget' && ne.kind === 'agent') {
        ne.sessionId = crypto.randomUUID()
        ne.agentStarted = false
      }
      return ne
    })
    // rebind arrow endpoints that pointed at copied elements
    for (const c of copies) {
      if (c.type === 'arrow') {
        if (c.from && idMap.has(c.from.id)) c.from = { id: idMap.get(c.from.id)! }
        if (c.to && idMap.has(c.to.id)) c.to = { id: idMap.get(c.to.id)! }
      }
    }
    get().beginHistory()
    get().addElements(copies)
    set({ selection: copies.map((c) => c.id) })
  },

  duplicateSelection: () => {
    get().copySelection()
    get().pasteClipboard()
  },

  // ---------- arrange: grouping ----------
  group: () => {
    const ids = get().selection
    if (ids.length < 2) return
    const gid = newId()
    const set_ = new Set(ids)
    get().beginHistory()
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        dirty: true,
        elements: ws.elements.map((e) =>
          set_.has(e.id) ? { ...e, groupId: gid } : e,
        ),
      })),
    )
  },

  ungroup: () => {
    const set_ = new Set(get().selection)
    get().beginHistory()
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        dirty: true,
        elements: ws.elements.map((e) => {
          if (!set_.has(e.id) || !e.groupId) return e
          const copy = { ...e } as CanvasElement
          delete (copy as { groupId?: string }).groupId
          return copy
        }),
      })),
    )
  },

  toggleLock: () => {
    const ws = get().active()
    if (!ws) return
    const set_ = new Set(get().selection)
    if (!set_.size) return
    const anyUnlocked = ws.elements.some((e) => set_.has(e.id) && !e.locked)
    get().beginHistory()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) =>
          set_.has(e.id) ? { ...e, locked: anyUnlocked } : e,
        ),
      })),
    )
  },

  // ---------- arrange: align / distribute / tidy ----------
  align: (mode) => {
    const ws = get().active()
    if (!ws) return
    const sel = ws.elements.filter((e) => get().selection.includes(e.id))
    if (sel.length < 2) return
    const bounds = boundsOfMany(sel)
    if (!bounds) return
    get().beginHistory()
    const moves = new Map<string, { dx: number; dy: number }>()
    for (const e of sel) {
      const b = elementBounds(e)
      let dx = 0
      let dy = 0
      switch (mode) {
        case 'left':
          dx = bounds.x - b.x
          break
        case 'right':
          dx = bounds.x + bounds.w - (b.x + b.w)
          break
        case 'center-h':
          dx = bounds.x + bounds.w / 2 - (b.x + b.w / 2)
          break
        case 'top':
          dy = bounds.y - b.y
          break
        case 'bottom':
          dy = bounds.y + bounds.h - (b.y + b.h)
          break
        case 'center-v':
          dy = bounds.y + bounds.h / 2 - (b.y + b.h / 2)
          break
      }
      moves.set(e.id, { dx, dy })
    }
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          const m = moves.get(e.id)
          return m && !e.locked ? translated(e, m.dx, m.dy) : e
        }),
      })),
    )
  },

  distribute: (axis) => {
    const ws = get().active()
    if (!ws) return
    const sel = ws.elements.filter((e) => get().selection.includes(e.id))
    if (sel.length < 3) return
    const withB = sel.map((e) => ({ e, b: elementBounds(e) }))
    withB.sort((a, b) =>
      axis === 'h' ? a.b.x - b.b.x : a.b.y - b.b.y,
    )
    const first = withB[0].b
    const last = withB[withB.length - 1].b
    const span =
      axis === 'h'
        ? last.x + last.w - first.x
        : last.y + last.h - first.y
    const totalSize = withB.reduce(
      (acc, { b }) => acc + (axis === 'h' ? b.w : b.h),
      0,
    )
    const gap = (span - totalSize) / (withB.length - 1)
    get().beginHistory()
    const moves = new Map<string, { dx: number; dy: number }>()
    let cursor = axis === 'h' ? first.x : first.y
    for (const { e, b } of withB) {
      if (axis === 'h') {
        moves.set(e.id, { dx: cursor - b.x, dy: 0 })
        cursor += b.w + gap
      } else {
        moves.set(e.id, { dx: 0, dy: cursor - b.y })
        cursor += b.h + gap
      }
    }
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          const m = moves.get(e.id)
          return m && !e.locked ? translated(e, m.dx, m.dy) : e
        }),
      })),
    )
  },

  tidy: () => {
    const ws = get().active()
    if (!ws) return
    const sel = ws.elements.filter((e) => get().selection.includes(e.id))
    if (sel.length < 2) return
    const withB = sel.map((e) => ({ e, b: elementBounds(e) }))
    const origin = boundsOfMany(sel)!
    const cols = Math.ceil(Math.sqrt(withB.length))
    const gap = 32
    const cellW = Math.max(...withB.map(({ b }) => b.w)) + gap
    const cellH = Math.max(...withB.map(({ b }) => b.h)) + gap
    // keep reading order: sort by row then column of current position
    withB.sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x)
    get().beginHistory()
    const moves = new Map<string, { dx: number; dy: number }>()
    withB.forEach(({ e, b }, i) => {
      const r = Math.floor(i / cols)
      const c = i % cols
      const tx = origin.x + c * cellW
      const ty = origin.y + r * cellH
      moves.set(e.id, { dx: tx - b.x, dy: ty - b.y })
    })
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          const m = moves.get(e.id)
          return m && !e.locked ? translated(e, m.dx, m.dy) : e
        }),
      })),
    )
  },

  // ---------- templates ----------
  saveTemplate: (name) => {
    const ws = get().active()
    if (!ws) return
    const widgets = ws.elements.filter(
      (e): e is WidgetElement => e.type === 'widget',
    )
    if (!widgets.length) return
    const b = boundsOfMany(widgets)!
    const tpl: Template = {
      id: newId(),
      name,
      widgets: widgets.map((w) => ({
        kind: w.kind,
        dx: w.x - b.x,
        dy: w.y - b.y,
        w: w.w,
        h: w.h,
        title: w.title,
        url: w.url,
        note: w.note,
        path: w.path,
        cmd: w.cmd,
        model: w.model,
        agentPrompt: w.agentPrompt,
        skipPermissions: w.skipPermissions,
      })),
    }
    const templates = [...get().templates, tpl]
    saveTemplates(templates)
    set({ templates })
  },

  applyTemplate: (id, x, y) => {
    const tpl = get().templates.find((t) => t.id === id)
    if (!tpl || !tpl.widgets.length) return
    const dir = get().active()?.dir
    const maxDx = Math.max(...tpl.widgets.map((w) => w.dx + w.w))
    const maxDy = Math.max(...tpl.widgets.map((w) => w.dy + w.h))
    const ox = x - maxDx / 2
    const oy = y - maxDy / 2
    const els: CanvasElement[] = tpl.widgets.map((w) => ({
      id: newId(),
      type: 'widget',
      kind: w.kind,
      x: ox + w.dx,
      y: oy + w.dy,
      w: w.w,
      h: w.h,
      z: 0,
      title: w.title ?? WIDGET_TITLE[w.kind],
      ...(w.url != null ? { url: w.url } : {}),
      ...(w.note != null ? { note: w.note } : {}),
      ...(w.path != null ? { path: w.path } : dir ? { path: dir } : {}),
      ...(w.cmd != null ? { cmd: w.cmd } : {}),
      ...(w.model != null ? { model: w.model } : {}),
      ...(w.agentPrompt != null ? { agentPrompt: w.agentPrompt } : {}),
      ...(w.skipPermissions ? { skipPermissions: true } : {}),
      ...(dir ? { cwd: dir } : {}),
      ...(w.kind === 'agent' ? { sessionId: crypto.randomUUID() } : {}),
    }))
    get().beginHistory()
    get().addElements(els)
    set({ selection: els.map((e) => e.id), tool: 'select' })
  },

  deleteTemplate: (id) => {
    const templates = get().templates.filter((t) => t.id !== id)
    saveTemplates(templates)
    set({ templates })
  },

  // ---------- command palette ----------
  setPaletteOpen: (open) => set({ paletteOpen: open }),

  // ---------- side panels / search ----------
  setOpenPanel: (p) => set({ openPanel: p }),
  togglePanel: (p) => set((s) => ({ openPanel: s.openPanel === p ? null : p })),
  setSearchOpen: (open) => set({ searchOpen: open }),

  // ---------- prompt library ----------
  savePrompt: (name, text) => {
    const prompt: Prompt = { id: newId(), name: name.trim() || 'prompt', text }
    const prompts = [...get().prompts, prompt]
    savePrompts(prompts)
    set({ prompts })
  },
  updatePrompt: (id, patch) => {
    const prompts = get().prompts.map((p) => (p.id === id ? { ...p, ...patch } : p))
    savePrompts(prompts)
    set({ prompts })
  },
  deletePrompt: (id) => {
    const prompts = get().prompts.filter((p) => p.id !== id)
    savePrompts(prompts)
    set({ prompts })
  },

  // ---------- agent cameras ----------
  setFollowAgent: (on) => set({ followAgent: on }),
  startTrackingAgent: async (id) => {
    const ok = await startTracking(id)
    if (ok) set({ trackingAgentId: id })
  },
  stopTrackingAgent: (cleanup) => {
    stopTracking(cleanup)
    set({ trackingAgentId: null })
  },

  // ---------- agent wizard ----------
  openAgentWizard: (ctx) => set({ agentWizard: ctx }),
  closeAgentWizard: () => set({ agentWizard: null }),

  // ---------- snap guides ----------
  setSnapGuides: (g) => set({ snapGuides: g }),

  // ---------- view ----------
  setPresenting: (on) => set({ presenting: on }),
  zoomToSelection: (vw, vh) => {
    const ws = get().active()
    if (!ws) return
    const ids = new Set(get().selection)
    const sel = ws.elements.filter((e) => ids.has(e.id))
    const b = boundsOfMany(sel.length ? sel : ws.elements)
    if (!b) return
    const pad = 80
    const zoom = clamp(Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2)), 0.1, 2)
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    get().setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
  },

  // ---------- flows ----------
  setFlowsEnabled: (on) => {
    if (!on) resetFlowState() // drop pending satisfied/turn bookkeeping
    set({ flowsEnabled: on })
  },

  // ---------- history ----------
  beginHistory: () => {
    const ws = get().active()
    if (!ws) return
    const h = histOf(ws.id)
    h.past.push(ws.elements.map((e) => ({ ...e })))
    if (h.past.length > 100) h.past.shift()
    h.future = []
  },

  undo: () => {
    const ws = get().active()
    if (!ws) return
    const h = histOf(ws.id)
    const prev = h.past.pop()
    if (!prev) return
    h.future.push(ws.elements.map((e) => ({ ...e })))
    set((s) => patchActive(s, (w) => ({ ...w, elements: prev, dirty: true })))
    set({ selection: [] })
  },

  redo: () => {
    const ws = get().active()
    if (!ws) return
    const h = histOf(ws.id)
    const next = h.future.pop()
    if (!next) return
    h.past.push(ws.elements.map((e) => ({ ...e })))
    set((s) => patchActive(s, (w) => ({ ...w, elements: next, dirty: true })))
    set({ selection: [] })
  },
}))

/**
 * Reactive selector for the active workspace. Bootstrap guarantees at least
 * one tab exists, and closeTab refuses to drop the last one, so this always
 * resolves to a real workspace once the app has started.
 */
export const selectActive = (s: Store): Workspace =>
  s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]

// ---------- session restore + autosave ----------

export function bootstrap() {
  const session = loadSession()
  if (session && session.tabs.length) {
    for (const ws of session.tabs)
      for (const el of ws.elements) zCounter = Math.max(zCounter, el.z + 1)
    useStore.setState({
      tabs: session.tabs,
      activeTabId:
        session.activeTabId && session.tabs.some((t) => t.id === session.activeTabId)
          ? session.activeTabId
          : session.tabs[0].id,
    })
  } else {
    // start with an unbound canvas (no folder dialog on launch); the user
    // binds a folder via "New canvas", the topbar chip, or first save
    const ws = makeWorkspace('untitled-1')
    useStore.setState({ tabs: [ws], activeTabId: ws.id })
  }

  let t: ReturnType<typeof setTimeout> | null = null
  useStore.subscribe((s) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      saveSession({ tabs: s.tabs, activeTabId: s.activeTabId })
    }, 400)
  })
}
