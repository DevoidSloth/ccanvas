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
import { AGENT_COLORS, DEFAULT_CAMERA, PALETTE, WIDGET_ACCENT } from '../lib/types'
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
  listDir,
  readFile,
  baseName,
  dirName,
  joinPath,
} from '../lib/backend'
import { resetFlowState } from '../lib/flow'
import { startTracking, stopTracking } from '../lib/tracker'
import { killPty } from '../lib/terminal'
import { useSettings } from '../lib/settings'
import { addPane, equalSizes, MAX_PANES, removePane } from '../lib/focusPanes'
import {
  BASE_LAYER_ID,
  MAX_LAYERS,
  activeLayerElements,
  activeLayerId,
  findLayer,
  hasLayers,
  landingCamera,
  layerDir,
  layerOf,
  layersOf,
  newLayerId,
  normalizeLayers,
} from '../lib/layers'
import { markOpenRequest } from '../lib/layersPerf'
import {
  normalizeStacks,
  stacksOf,
  stackOfId,
  stripStack,
  withStackSiblings,
} from '../lib/stacks'

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
// New widgets only (saved ones keep their size). A terminal opens at about
// 80 columns of its default 13 px font, what full-screen programs (Claude
// Code among them) are laid out for; a Claude chat is the same size whether
// it runs in a terminal (agent) or is mirrored from the desktop app
// (transcript), so the two sit together on the canvas.
export const WIDGET_SIZE: Record<WidgetKind, { w: number; h: number }> = {
  terminal: { w: 660, h: 420 },
  agent: { w: 660, h: 480 },
  web: { w: 800, h: 560 },
  note: { w: 320, h: 240 },
  files: { w: 300, h: 420 },
  diff: { w: 680, h: 460 },
  editor: { w: 560, h: 440 },
  vscode: { w: 900, h: 620 },
  doc: { w: 420, h: 420 },
  log: { w: 520, h: 320 },
  pr: { w: 460, h: 360 },
  issues: { w: 460, h: 360 },
  runs: { w: 500, h: 360 },
  runner: { w: 520, h: 360 },
  sql: { w: 760, h: 500 },
  data: { w: 680, h: 460 },
  plot: { w: 520, h: 440 },
  transcript: { w: 660, h: 480 },
  video: { w: 560, h: 380 },
  mediainfo: { w: 340, h: 440 },
  claude: { w: 1120, h: 720 },
  nowplaying: { w: 420, h: 170 },
}
const WIDGET_TITLE: Record<WidgetKind, string> = {
  terminal: 'terminal',
  agent: 'claude agent',
  web: 'web',
  note: 'note',
  files: 'files',
  diff: 'git diff',
  editor: 'editor',
  vscode: 'vs code',
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
  nowplaying: 'Now playing',
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

/** Size of the canvas area (kept here rather than importing lib/view, which
 *  imports this store). */
function canvasSize(): { vw: number; vh: number } {
  const main = typeof document !== 'undefined' ? document.querySelector('.app__main') : null
  if (main) return { vw: main.clientWidth, vh: main.clientHeight }
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280
  const h = typeof window !== 'undefined' ? window.innerHeight - 38 : 720
  return { vw: w, vh: h }
}

/** Drop keyboard focus (no-op without a DOM, e.g. in tests). */
function blurFocus() {
  if (typeof document === 'undefined') return
  ;(document.activeElement as HTMLElement | null)?.blur?.()
}
/** The widget holding keyboard focus, if any. */
function focusedWidgetId(): string | null {
  if (typeof document === 'undefined') return null
  return (
    (document.activeElement as HTMLElement | null)?.closest?.('[data-widget-id]')?.getAttribute('data-widget-id') ??
    null
  )
}

/**
 * After an undo or redo moved widgets between layers: nothing that isn't on
 * the layer being shown may stay the active widget or keep keyboard focus
 * (the focus-leak rule, for history). Defined below the store.
 */
let dropHiddenFocus = () => {}

/** Put a new element on the active layer unless it names one. Base-layer
 *  elements carry no `layer` field, so a single-layer canvas saves as before. */
function stampLayer(ws: Workspace, el: CanvasElement): CanvasElement {
  if (el.layer === BASE_LAYER_ID) {
    // an explicit base layer (e.g. a tracked agent's satellite) is stored as none
    const copy = { ...el } as CanvasElement
    delete copy.layer
    return copy
  }
  if (el.layer !== undefined || !hasLayers(ws)) return el
  const id = activeLayerId(ws)
  return id === BASE_LAYER_ID ? el : ({ ...el, layer: id } as CanvasElement)
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

/** The special knowledge-graph tab (see openClaudeWorkspace); never written to disk. */
const isGraphTab = (t: Workspace) =>
  t.elements.some((e) => e.type === 'widget' && (e as WidgetElement).kind === 'claude')

/** Where a folder-bound canvas lives on disk. */
const canvasPath = (t: Workspace) => joinPath(t.dir!, `${t.name}.ccnvs`)

/**
 * Load the canvas a folder already holds, if any: `<folder-name>.ccnvs` when
 * present, otherwise the most recently modified `.ccnvs` in it. The tab is
 * named after the file so autosave writes back to that same file.
 */
async function loadCanvasIn(dir: string): Promise<Workspace | null> {
  if (!(await backendOnline())) return null
  const files = ((await listDir(dir)) ?? []).filter(
    (e) => !e.is_dir && /\.ccnvs$/i.test(e.name),
  )
  if (!files.length) return null
  const want = `${baseName(dir)}.ccnvs`.toLowerCase()
  const file =
    files.find((f) => f.name.toLowerCase() === want) ??
    [...files].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))[0]
  const text = await readFile(file.path)
  if (text == null) return null
  try {
    const ws = fromFile(JSON.parse(text), file.name)
    ws.name = file.name.replace(/\.ccnvs$/i, '')
    ws.dir = dir
    for (const el of ws.elements) zCounter = Math.max(zCounter, el.z + 1)
    return ws
  } catch {
    return null
  }
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

/** The stack spread view: a stack's members laid out over the dimmed canvas. */
export type SpreadState = {
  stackId: string
  /** highlighted card (index into the stack's members) */
  hi: number
  /** true while the cards fly back into the stack before the view closes */
  closing: boolean
  /** a card being dragged: the slot it would take, or null while it is being
   *  pulled out of the stack. Only a preview; the order changes on release. */
  drag?: { id: string; to: number | null }
}

/** Focus mode: one widget fills the canvas area at 100% while the board dims,
 *  or several side by side (panes, lib/focusPanes.ts). */
export type FocusState = {
  /** the pane you're working in (the only one, unless split); null while the
   *  last ones fly home */
  id: string | null
  /** every widget in focus, left to right (empty while flying home) */
  panes: string[]
  /** each pane's share of the width (sums to 1) */
  sizes: number[]
  /** widgets flying back to their spot on the canvas */
  returning: string[]
  /** the box the focused widget fills, in canvas-local screen px */
  box: { x: number; y: number; w: number; h: number }
  /** the last change swapped stack tabs in place (no flight) */
  instant?: boolean
}

/** Snap-to-stack feedback while a widget (or stack) is dragged over another. */
export type StackDrop = {
  /** widgets being dragged, the visible one first (a dragged stack brings every member) */
  sourceIds: string[]
  /** the widget it would stack onto (the front, if that is a stack) */
  targetId: string
  /** near: brackets close in as a heads-up; snap: releasing now stacks */
  phase: 'near' | 'snap'
  /** how close a 'near' drag is to snapping, 0..1 */
  progress: number
}

/** Side panels that share the right-hand dock (only one open at a time). */
export type SidePanel = 'roster' | 'desktop' | 'prompts' | 'checkpoints' | 'memory' | 'settings'

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
  /** terminal/agent whose label (name + colour) popover is open */
  labelingWidgetId: string | null
  setLabelingWidget: (id: string | null) => void
  /** colour tags (lowercase hex) to show; other widgets are dimmed. null = all */
  labelFilter: string[] | null
  setLabelFilter: (f: string[] | null) => void
  templates: Template[]
  /** reusable prompt snippets (prompt library) */
  prompts: Prompt[]
  paletteOpen: boolean
  /** emacs-style bottom bar: 'chord' = a chord prefix is pending; 'tab' = tab finder */
  minibuffer: 'chord' | 'tab' | null
  /** the chord echo ("C-x -") or the finder's prompt ("Find tab:", ":b") */
  miniText: string
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
  /** the layers overview (the tilted stack). 'entering': it's animating in
   *  over the live canvas (covered by its opaque backdrop); 'open': settled,
   *  and the live canvas is hidden (still mounted); 'closing': the live
   *  canvas shows again under the overview's last fade. Not saved. */
  layerOverview: false | 'entering' | 'open' | 'closing'
  /** the open stack spread view, if any */
  spread: SpreadState | null
  /** focus mode (session-only, never saved or undone) */
  focus: FocusState | null
  /** drag-to-stack drop target while dragging */
  stackDrop: StackDrop | null

  // ----- derived -----
  active: () => Workspace | null

  // ----- tabs -----
  newTab: () => Promise<void>
  /** open a dedicated tab hosting the Claude knowledge-graph node map */
  openClaudeWorkspace: () => void
  closeTab: (id: string) => void
  switchTab: (id: string) => void
  renameTab: (id: string, name: string) => void
  moveTab: (id: string, toIndex: number) => void
  /** pin/unpin a tab; pinned tabs are kept together at the front */
  togglePinTab: (id: string) => void
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
  /** delete the selection; `keepWidgets` leaves its widgets (the ⌫ key: a
   *  chat or panel only closes on purpose, from its own button or the menu) */
  deleteSelection: (opts?: { keepWidgets?: boolean }) => void
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
  /** lay out the tab's terminals + agents (or just the selected ones) in rows,
   *  grouped by colour tag or by working folder */
  arrangeTerminals: (by: 'label' | 'folder') => void

  // ----- templates -----
  saveTemplate: (name: string) => void
  applyTemplate: (id: string, x: number, y: number) => void
  deleteTemplate: (id: string) => void

  // ----- command palette -----
  setPaletteOpen: (open: boolean) => void
  setMinibuffer: (m: 'chord' | 'tab' | null, text?: string) => void

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

  // ----- layers -----
  setLayerOverview: (open: boolean | 'open' | 'closing') => void
  /** add a layer on top of the stack (the first call also materialises the
   *  base layer); returns its id, or null at the nine-layer cap */
  addLayer: (opts?: { name?: string; dir?: string; activate?: boolean }) => string | null
  /** "New layer…": pick its folder (cancel = a plain layer in the tab's
   *  folder), name it after the folder, add it on top */
  newLayerWithPicker: (opts?: { activate?: boolean }) => Promise<string | null>
  renameLayer: (id: string, name: string) => void
  setLayerDir: (id: string, dir: string | undefined) => void
  /** pick a folder for a layer (the folder chip and "Set folder…") */
  pickLayerDir: (id: string) => Promise<void>
  /** Show another layer. Always drops keyboard focus, the selection, the
   *  active widget and any text edit, so typing can never reach a terminal
   *  that's no longer visible. Saves the current view into the layer being
   *  left and restores the target layer's (or `cam`). */
  setActiveLayer: (id: string, cam?: Camera) => void
  /** move elements to another layer, keeping x/y. Carries group siblings,
   *  label boxes and arrows whose two ends both move. Undoable. */
  moveToLayer: (ids: string[], layerId: string) => void
  /** move a layer to `toIndex` in the stack (0 = bottom) */
  moveLayer: (id: string, toIndex: number) => void
  /** remove a layer, merging its widgets into the layer below it (above, for
   *  the bottom one). Never closes anything. The base layer stays. Returns
   *  the id of the layer the widgets went to. */
  removeLayer: (id: string) => string | null
  // ----- stacks -----
  /** apply fn to a copy of each listed element in one update */
  mutateElements: (ids: string[], fn: (el: CanvasElement) => void) => void
  /** stack `ids` (and the stacks they belong to) onto `targetId`'s spot.
   *  `front` picks the visible member (default: the first of ids). Callers
   *  take the history snapshot. Returns the stack id. */
  stackWidgets: (ids: string[], targetId: string, front?: string) => string | null
  /** stack the current selection onto its first widget */
  stackSelection: () => void
  /** show this member in front of its stack */
  setStackFront: (id: string) => void
  /** bring the next/previous member of this widget's stack to the front */
  cycleStack: (id: string, dir: 1 | -1) => void
  /** take one widget out of its stack, at `at` (world, top-left) or beside it */
  unstackWidget: (id: string, at?: { x: number; y: number }) => void
  /** dissolve a stack, laying its members out in a row */
  unstackAll: (stackId: string) => void
  reorderStack: (stackId: string, ids: string[]) => void
  renameStack: (stackId: string, title: string) => void
  openSpread: (stackId: string) => void
  /** fill the view with this widget (the front of its stack); `box` is the
   *  canvas-local screen box to fill (lib/view.ts focusBox) */
  enterFocus: (id: string, box: FocusState['box']) => void
  /** fly the focused widget home */
  exitFocus: () => void
  /** while focused: work in this pane, or fly the current one home and put
   *  this one in its place */
  swapFocus: (id: string) => void
  /** while focused: add a widget as a pane beside the current one */
  splitFocus: (id: string) => void
  /** while split: fly one pane home (the last one leaves focus) */
  closePane: (id: string) => void
  /** while split: the panes' widths after a divider drag */
  setPaneSizes: (sizes: number[]) => void
  /** collapse a widget (or its whole stack) to its title bar, or restore it */
  toggleMinimized: (id: string) => void
  /** a widget finished flying home */
  finishFocusReturn: (id: string) => void
  /** drop focus at once, no flight (tab or layer switch, widget removed) */
  clearFocus: () => void
  /** the window resized while focused */
  setFocusBox: (box: FocusState['box']) => void
  /** close the spread, optionally bringing `focusId` to the front and into focus */
  closeSpread: (focusId?: string | null) => void
  setSpreadHi: (i: number) => void
  setSpreadDrag: (d: SpreadState['drag'] | null) => void
  setStackDrop: (d: StackDrop | null) => void

  // ----- history -----
  beginHistory: () => void
  undo: () => void
  redo: () => void
}

/** If `id` is a stacked widget hidden behind another, bring it to the front. */
function frontIfHidden(get: () => Store, _set: unknown, id: string) {
  const ws = get().active()
  if (!ws) return
  const el = ws.elements.find((e) => e.id === id)
  if (!el || el.type !== 'widget' || !el.stackId || el.stackFront) return
  const st = stackOfId(ws.elements, id)
  if (st && st.front.id !== id) get().setStackFront(id)
}

/** Set by view.ts: focuses a widget once the spread has closed (avoids an
 *  import cycle between the store and the view helpers). */
let spreadFocus: ((id: string) => void) | null = null
export function setSpreadFocusHandler(fn: (id: string) => void) {
  spreadFocus = fn
}

function patchActive(
  state: Store,
  fn: (ws: Workspace) => Workspace,
): Partial<Store> {
  const tabs = state.tabs.map((t) => {
    if (t.id !== state.activeTabId) return t
    const next = fn(t)
    // whatever moved or resized a stack member (align, tidy, arrange…), every
    // member follows the front's box; returns the same array when in sync
    if (next.elements !== t.elements) {
      const fixed = normalizeStacks(next.elements)
      if (fixed !== next.elements) return { ...next, elements: fixed }
    }
    return next
  })
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
  labelingWidgetId: null,
  labelFilter: null,
  templates: loadTemplates(),
  prompts: loadPrompts(),
  paletteOpen: false,
  minibuffer: null,
  miniText: '',
  agentWizard: null,
  openPanel: null,
  searchOpen: false,
  followAgent: false,
  trackingAgentId: null,
  snapGuides: null,
  presenting: false,
  flowsEnabled: false, // connector flows were removed from the UI
  layerOverview: false,
  spread: null,
  focus: null,
  stackDrop: null,

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
    if (realDir) {
      // the folder is already open in a tab → just go there
      const open = get().tabs.find((t) => t.dir === realDir && !isGraphTab(t))
      if (open) {
        set({ activeTabId: open.id, selection: [], activeWidgetId: null })
        return
      }
    }
    // reopen the canvas saved in that folder, or start a fresh one there
    const saved = realDir ? await loadCanvasIn(realDir) : null
    const name = realDir ? baseName(realDir) : `untitled-${get().tabs.length + 1}`
    const ws = saved ?? makeWorkspace(name, realDir)
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
    const vh = typeof window !== 'undefined' ? window.innerHeight - 38 : 720
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
    // a layer with its own folder: the chip shows and sets that folder
    const layer = hasLayers(ws) ? findLayer(ws, activeLayerId(ws)) : undefined
    if (layer?.dir) return get().pickLayerDir(layer.id)
    const dir = await chooseDir(ws.dir)
    if (dir === null) return // cancelled
    const realDir = dir || undefined
    if (realDir && realDir !== ws.dir) {
      const open = get().tabs.find((t) => t.dir === realDir && !isGraphTab(t))
      if (open) {
        set({ activeTabId: open.id, selection: [], activeWidgetId: null })
        return
      }
      // the folder already has a canvas → reopen it rather than overwrite it.
      // An empty tab becomes that canvas; one with work on it is left as is
      // and the saved canvas opens beside it.
      const saved = await loadCanvasIn(realDir)
      if (saved) {
        const cur = get().active()
        if (cur && cur.id === ws.id && cur.elements.length === 0) {
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === ws.id ? { ...saved, pinned: t.pinned } : t)),
            activeTabId: saved.id,
            selection: [],
            activeWidgetId: null,
          }))
        } else {
          set((s) => ({
            tabs: [...s.tabs, saved],
            activeTabId: saved.id,
            selection: [],
            activeWidgetId: null,
          }))
        }
        return
      }
    }
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
    if (tab?.pinned) return // unpin first
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
    set({
      focus: null,
      activeTabId: id,
      selection: [],
      activeWidgetId: null,
      editingTextId: null,
      labelFilter: null,
    }),

  renameTab: (id, name) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, name, dirty: true } : t)),
    })),

  // Reorder a tab to `toIndex` (its final position). Pinned tabs stay in the
  // leading group: a tab can only move within its own pinned/unpinned section.
  moveTab: (id, toIndex) =>
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id)
      if (from === -1) return s
      const me = s.tabs[from]
      const pinnedCount = s.tabs.filter((t) => t.pinned).length
      const lo = me.pinned ? 0 : pinnedCount
      const hi = me.pinned ? pinnedCount - 1 : s.tabs.length - 1
      const to = Math.max(lo, Math.min(hi, toIndex))
      if (to === from) return s
      const tabs = s.tabs.slice()
      tabs.splice(from, 1)
      tabs.splice(to, 0, me)
      return { tabs }
    }),

  togglePinTab: (id) =>
    set((s) => {
      const me = s.tabs.find((t) => t.id === id)
      if (!me) return s
      const next = { ...me, pinned: !me.pinned }
      const pinned = s.tabs.filter((t) => t.pinned && t.id !== id)
      const rest = s.tabs.filter((t) => !t.pinned && t.id !== id)
      // pinned tabs stay together at the front: a newly pinned tab joins the
      // end of that group, an unpinned one leads the rest
      return { tabs: [...pinned, next, ...rest] }
    }),

  openFile: async () => {
    let ws: Workspace | null = null
    if (await backendOnline()) {
      // a tab with no folder yet (e.g. untitled): ⌘O picks its folder. The
      // native .ccnvs dialog greys out folders, so this is the only way in.
      if (!get().active()?.dir) return get().setActiveDir()
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
      ok = await saveFile(canvasPath(ws), JSON.stringify(toFile(ws), null, 2))
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
  setCamera: (c) => {
    // focus pins a widget to the screen against the camera: hold it still
    if (get().focus) return
    set((s) => patchActive(s, (ws) => ({ ...ws, camera: c })))
  },

  homeView: (vw, vh) => {
    const ws = get().active()
    if (!ws) return
    const b = boundsOfMany(activeLayerElements(ws))
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
        elements: [...ws.elements, stampLayer(ws, { ...el, z: nextZ() } as CanvasElement)],
        dirty: true,
      })),
    ),

  addElements: (els) =>
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: [
          ...ws.elements,
          ...els.map((el) => stampLayer(ws, { ...el, z: nextZ() } as CanvasElement)),
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
    const f = get().focus
    if (f && (f.panes.some((p) => set_.has(p)) || f.returning.some((r) => set_.has(r)))) {
      // a removed pane just goes; the rest stay in focus
      let rest = { panes: f.panes, sizes: f.sizes }
      for (const p of f.panes) if (set_.has(p)) rest = removePane(rest.panes, rest.sizes, p)
      set({
        focus: rest.panes.length
          ? {
              ...f,
              ...rest,
              id: f.id && rest.panes.includes(f.id) ? f.id : rest.panes[0],
              returning: f.returning.filter((r) => !set_.has(r)),
            }
          : null,
      })
    }
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
        // a stack that lost members picks a new front, or dissolves at one
        elements: normalizeStacks(w.elements.filter((e) => !set_.has(e.id))),
        dirty: true,
      })),
    )
  },

  spawnWidget: (kind, x, y, init) => {
    // an explicit size in `init` is centred on (x,y) like the default one
    const w = init?.w ?? WIDGET_SIZE[kind].w
    const h = init?.h ?? WIDGET_SIZE[kind].h
    const id = newId()
    const ws = get().active()
    // new widgets open in their layer's folder, falling back to the tab's
    const onLayerId = init?.layer ?? (ws ? activeLayerId(ws) : BASE_LAYER_ID)
    const dir = ws ? layerDir(ws, onLayerId) : undefined
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
      ...(kind === 'agent'
        ? { sessionId: crypto.randomUUID(), cli: useSettings.getState().agentCli }
        : {}),
      ...init,
    }
    get().beginHistory()
    get().addElement(el)
    // auto-focus the new widget so notes/terminals are usable immediately
    // (unless it was placed on a layer you can't see, e.g. a sorted mirror)
    if (!ws || onLayerId === activeLayerId(ws))
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
  setSelection: (ids) => {
    // picking one stacked widget (a tab click, the roster, search, ⌘1–9…)
    // brings it to the front of its stack
    if (ids.length === 1) frontIfHidden(get, set, ids[0])
    set({ selection: ids })
  },
  selectWithGroups: (ids) => {
    const ws = get().active()
    set({ selection: ws ? withGroupSiblings(ws.elements, ids) : ids })
  },
  clearSelection: () =>
    set({ selection: [], activeWidgetId: null, editingTextId: null }),

  deleteSelection: (opts) => {
    const ws = get().active()
    if (!ws) return
    const keep = new Set(
      ws.elements.filter((e) => e.locked || (opts?.keepWidgets && e.type === 'widget')).map((e) => e.id),
    )
    const ids = get().selection.filter((id) => !keep.has(id))
    if (!ids.length) return
    get().beginHistory()
    get().removeElements(ids)
    // what was kept stays selected
    set({ selection: get().selection.filter((id) => keep.has(id)), activeWidgetId: null })
  },

  moveSelection: (dx, dy) => {
    let base = new Set(get().selection)
    if (frameDragChildren) for (const id of frameDragChildren) base.add(id)
    if (!base.size) return
    // a stack moves as one
    const ws0 = get().active()
    if (ws0) base = withStackSiblings(ws0.elements, base)
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

  // A widget on another layer of this tab is brought into view first, so a
  // jump (roster, search, attention) never focuses something you can't see;
  // a widget stacked behind another is brought to the front of its stack.
  setActiveWidget: (id) => {
    const ws = get().active()
    if (id && ws && hasLayers(ws)) {
      const el = ws.elements.find((e) => e.id === id)
      if (el && layerOf(el) !== activeLayerId(ws)) get().setActiveLayer(layerOf(el))
    }
    if (id) frontIfHidden(get, set, id)
    // while focused, a jump to another widget (roster, search, attention bar,
    // ⌘1–9) swaps which one is focused instead of leaving focus
    const f = get().focus
    if (f?.id && id && id !== f.id) get().swapFocus(id)
    set({ activeWidgetId: id })
  },
  setEditingText: (id) => set({ editingTextId: id }),
  setLabelingWidget: (id) => set({ labelingWidgetId: id }),
  setLabelFilter: (f) => set({ labelFilter: f && f.length ? f : null }),

  // ---------- arrange: clipboard ----------
  copySelection: () => {
    const ws = get().active()
    if (!ws) return
    // a stack is copied whole
    const sel = withStackSiblings(ws.elements, get().selection)
    clipboard = ws.elements.filter((e) => sel.has(e.id)).map((e) => ({ ...e }))
  },

  // like ⌫, a cut never closes a widget (its session would end): widgets
  // are copied, everything else is cut
  cutSelection: () => {
    get().copySelection()
    get().deleteSelection({ keepWidgets: true })
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
    const stackMap = new Map<string, string>()
    let copies = clipboard.map((e) => {
      const ne = translated({ ...e }, dx, dy)
      ne.id = newId()
      idMap.set(e.id, ne.id)
      if (e.groupId) {
        if (!groupMap.has(e.groupId)) groupMap.set(e.groupId, newId())
        ne.groupId = groupMap.get(e.groupId)
      }
      if (ne.type === 'widget' && ne.stackId) {
        if (!stackMap.has(ne.stackId)) stackMap.set(ne.stackId, newId())
        ne.stackId = stackMap.get(ne.stackId)
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
    // a partial copy of a stack becomes a smaller stack, or plain widgets
    copies = normalizeStacks(copies)
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

  arrangeTerminals: (by) => {
    const ws = get().active()
    if (!ws) return
    const isTerm = (e: CanvasElement): e is WidgetElement =>
      e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent') && !e.locked
    const stacks = stacksOf(ws.elements)
    const all = ws.elements.filter(isTerm).filter((e) => !e.stackId || !stacks.has(e.stackId) || stacks.get(e.stackId)!.front.id === e.id)
    const picked = all.filter((e) => get().selection.includes(e.id))
    const terms = picked.length >= 2 ? picked : all
    if (!terms.length) return

    // group: colour tags in palette order (untagged last), or folders A→Z
    const keyOf = (t: WidgetElement) =>
      by === 'label' ? (t.color ?? '').toLowerCase() : (t.cwd ?? ws.dir ?? '')
    const rank = (k: string) => {
      if (by === 'folder') return 0
      if (!k) return AGENT_COLORS.length + 1
      const i = AGENT_COLORS.findIndex((c) => c.hex.toLowerCase() === k)
      return i < 0 ? AGENT_COLORS.length : i
    }
    const groups = new Map<string, WidgetElement[]>()
    for (const t of [...terms].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const k = keyOf(t)
      groups.set(k, [...(groups.get(k) ?? []), t])
    }
    const ordered = [...groups.entries()].sort(
      ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b),
    )

    // shelf-pack: each group starts a new row and wraps at a width that keeps
    // the whole layout roughly as wide as it is tall
    const gap = 40
    const avgW = terms.reduce((n, t) => n + t.w, 0) / terms.length
    const cols = Math.max(1, Math.ceil(Math.sqrt(terms.length * 1.4)))
    const maxRowW = cols * (avgW + gap)
    const origin = boundsOfMany(terms)!
    const moves = new Map<string, { dx: number; dy: number }>()
    let y = origin.y
    for (const [, items] of ordered) {
      let x = origin.x
      let rowH = 0
      for (const t of items) {
        if (x > origin.x && x - origin.x + t.w > maxRowW) {
          y += rowH + gap
          x = origin.x
          rowH = 0
        }
        moves.set(t.id, { dx: x - t.x, dy: y - t.y })
        x += t.w + gap
        rowH = Math.max(rowH, t.h)
      }
      y += rowH + gap * 2 // a wider gutter between groups
    }
    // label boxes (frame + name) wrapped around a widget travel with it
    for (const e of ws.elements)
      if (e.labelFor && moves.has(e.labelFor)) moves.set(e.id, moves.get(e.labelFor)!)

    get().beginHistory()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          const m = moves.get(e.id)
          return m ? translated(e, m.dx, m.dy) : e
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
        cli: w.cli,
      })),
    }
    const templates = [...get().templates, tpl]
    saveTemplates(templates)
    set({ templates })
  },

  applyTemplate: (id, x, y) => {
    const tpl = get().templates.find((t) => t.id === id)
    if (!tpl || !tpl.widgets.length) return
    const tplWs = get().active()
    const dir = tplWs ? layerDir(tplWs) : undefined
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
      ...(w.kind === 'agent'
        ? { sessionId: crypto.randomUUID(), cli: w.cli ?? useSettings.getState().agentCli }
        : {}),
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
  setMinibuffer: (m, text = '') => set({ minibuffer: m, miniText: text }),

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
  setPresenting: (on) => set(on ? { presenting: on, focus: null } : { presenting: on }),
  zoomToSelection: (vw, vh) => {
    const ws = get().active()
    if (!ws) return
    const ids = new Set(get().selection)
    const els = activeLayerElements(ws)
    const sel = els.filter((e) => ids.has(e.id))
    const b = boundsOfMany(sel.length ? sel : els)
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

  // ---------- layers ----------
  setLayerOverview: (open) => {
    if (open === true) {
      if (get().layerOverview) return
      markOpenRequest()
      // nothing typed while the stack is up may reach a widget
      blurFocus()
      set({ layerOverview: 'entering', activeWidgetId: null, editingTextId: null, spread: null, stackDrop: null, focus: null })
    } else set({ layerOverview: open })
  },

  addLayer: (opts = {}) => {
    const ws = get().active()
    if (!ws) return null
    const cur = layersOf(ws)
    if (cur.length >= MAX_LAYERS) return null
    const id = newLayerId(ws)
    const name = (opts.name?.trim() || `layer ${cur.length + 1}`).slice(0, 40)
    const layer = { id, name, ...(opts.dir ? { dir: opts.dir } : {}) }
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        // first use materialises the implicit base layer under the new one
        layers: [...layersOf(w).map((l) => ({ ...l })), layer],
        activeLayerId: activeLayerId(w),
        dirty: true,
      })),
    )
    if (opts.activate) get().setActiveLayer(id)
    return id
  },

  newLayerWithPicker: async (opts = {}) => {
    const ws = get().active()
    if (!ws || layersOf(ws).length >= MAX_LAYERS) return null
    const dir = await chooseDir(ws.dir)
    const realDir = dir || undefined
    return get().addLayer({
      dir: realDir,
      name: realDir ? baseName(realDir) : undefined,
      activate: opts.activate,
    })
  },

  renameLayer: (id, name) => {
    const n = name.trim().slice(0, 40)
    if (!n) return
    set((s) =>
      patchActive(s, (w) =>
        hasLayers(w)
          ? { ...w, dirty: true, layers: w.layers!.map((l) => (l.id === id ? { ...l, name: n } : l)) }
          : w,
      ),
    )
  },

  setLayerDir: (id, dir) =>
    set((s) =>
      patchActive(s, (w) => {
        if (!hasLayers(w)) return w
        return {
          ...w,
          dirty: true,
          layers: w.layers!.map((l) => {
            if (l.id !== id) return l
            const next = { ...l }
            if (dir) next.dir = dir
            else delete next.dir
            // a layer still called "layer N" takes its new folder's name
            if (dir && /^layer \d+$/.test(l.name)) next.name = baseName(dir)
            return next
          }),
        }
      }),
    ),

  pickLayerDir: async (id) => {
    const ws = get().active()
    if (!ws) return
    const dir = await chooseDir(findLayer(ws, id)?.dir ?? ws.dir)
    if (dir === null) return // cancelled
    get().setLayerDir(id, dir || undefined)
  },

  setActiveLayer: (id, cam) => {
    const ws = get().active()
    if (!ws) return
    if (get().focus) set({ focus: null })
    // the focus-leak rule: whatever happens next, nothing keeps keyboard focus
    blurFocus()
    // a stack spread or a pending drag-to-stack belongs to the layer being left
    set({
      selection: [],
      activeWidgetId: null,
      editingTextId: null,
      labelingWidgetId: null,
      spread: null,
      stackDrop: null,
    })
    if (!hasLayers(ws) || !findLayer(ws, id)) return
    const cur = activeLayerId(ws)
    if (cur === id && !cam) return
    const { vw, vh } = canvasSize()
    // remember where we were on the layer we're leaving
    const left = {
      ...ws,
      layers: ws.layers!.map((l) => (l.id === cur ? { ...l, camera: ws.camera } : l)),
    }
    const next = cam ?? landingCamera(left, id, vw, vh)
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        layers: left.layers,
        activeLayerId: id,
        camera: next,
      })),
    )
  },

  moveToLayer: (ids, layerId) => {
    const ws = get().active()
    if (!ws || !findLayer(ws, layerId) || !ids.length) return
    // a stack moves whole: its members share one spot, so they share a layer
    const moving = withStackSiblings(ws.elements, withGroupSiblings(ws.elements, ids))
    // label boxes travel with the widget they wrap
    for (const e of ws.elements) if (e.labelFor && moving.has(e.labelFor)) moving.add(e.id)
    // arrows go along when both of their ends do
    for (const e of ws.elements)
      if (e.type === 'arrow' && e.from && e.to && moving.has(e.from.id) && moving.has(e.to.id))
        moving.add(e.id)
    get().beginHistory()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          if (!moving.has(e.id) || layerOf(e) === layerId) return e
          const copy = { ...e } as CanvasElement
          if (layerId === BASE_LAYER_ID) delete copy.layer
          else copy.layer = layerId
          return copy
        }),
      })),
    )
    // anything that just left the layer you're on can't stay selected or focused
    if (layerId !== activeLayerId(ws)) {
      const focused = focusedWidgetId()
      if (focused && moving.has(focused)) blurFocus()
      const st = get()
      set({
        selection: st.selection.filter((x) => !moving.has(x)),
        activeWidgetId: st.activeWidgetId && moving.has(st.activeWidgetId) ? null : st.activeWidgetId,
      })
    }
  },

  moveLayer: (id, toIndex) =>
    set((s) =>
      patchActive(s, (w) => {
        if (!hasLayers(w)) return w
        const from = w.layers!.findIndex((l) => l.id === id)
        const to = clamp(toIndex, 0, w.layers!.length - 1)
        if (from < 0 || from === to) return w
        const layers = w.layers!.slice()
        const [l] = layers.splice(from, 1)
        layers.splice(to, 0, l)
        return { ...w, layers, dirty: true }
      }),
    ),

  removeLayer: (id) => {
    const ws = get().active()
    if (!ws || !hasLayers(ws) || id === BASE_LAYER_ID) return null
    const ls = ws.layers!
    const i = ls.findIndex((l) => l.id === id)
    if (i < 0) return null
    const into = ls[i > 0 ? i - 1 : 1].id
    // undoable: undo puts the widgets back on their own layer (normalizing
    // re-creates its entry; the name and folder aren't in history)
    get().beginHistory()
    // leaving the layer you're on: go to where its widgets are going
    if (activeLayerId(ws) === id) get().setActiveLayer(into)
    set((s) =>
      patchActive(s, (w) => {
        const elements = w.elements.map((e) => {
          if (layerOf(e) !== id) return e
          const copy = { ...e } as CanvasElement
          if (into === BASE_LAYER_ID) delete copy.layer
          else copy.layer = into
          return copy
        })
        // back to one layer: the tab saves exactly as a single-layer canvas
        return normalizeLayers({
          ...w,
          elements,
          layers: w.layers!.filter((l) => l.id !== id),
          dirty: true,
        })
      }),
    )
    return into
  },

  // ---------- stacks ----------
  mutateElements: (ids, fn) => {
    const set_ = new Set(ids)
    set((s) =>
      patchActive(s, (ws) => ({
        ...ws,
        elements: ws.elements.map((e) => {
          if (!set_.has(e.id)) return e
          const copy = { ...e } as CanvasElement
          fn(copy)
          return copy
        }),
        dirty: true,
      })),
    )
  },

  stackWidgets: (ids, targetId, front) => {
    const ws = get().active()
    if (!ws) return null
    const byId = new Map(ws.elements.map((e) => [e.id, e]))
    const target = byId.get(targetId)
    if (!target || target.type !== 'widget' || target.locked) return null
    const stacks = stacksOf(ws.elements)
    const targetStack = target.stackId ? stacks.get(target.stackId) : undefined
    // incoming widgets: the given ids plus every member of a stack they're in,
    // keeping each dragged stack's tab order
    const incoming: WidgetElement[] = []
    const seen = new Set<string>(targetStack ? targetStack.members.map((m) => m.id) : [targetId])
    let incomingTitle: string | undefined
    for (const id of ids) {
      const el = byId.get(id)
      if (!el || el.type !== 'widget' || el.locked || seen.has(id)) continue
      const st = el.stackId ? stacks.get(el.stackId) : undefined
      const group = st ? st.members : [el]
      if (st && !incomingTitle) incomingTitle = st.title
      for (const m of group)
        if (!seen.has(m.id) && !m.locked) {
          seen.add(m.id)
          incoming.push(m)
        }
    }
    if (!incoming.length) return null
    const base: WidgetElement[] = targetStack ? targetStack.members : [target]
    const all = [...base, ...incoming]
    const sid = targetStack?.id ?? newId()
    const title = targetStack?.title ?? incomingTitle ?? target.title
    // the dragged widget (or the dragged stack's front) shows
    const firstIn = byId.get(ids[0]) as WidgetElement | undefined
    const draggedFront =
      firstIn?.stackId && stacks.get(firstIn.stackId) ? stacks.get(firstIn.stackId)!.front.id : incoming[0].id
    const frontId = front ?? draggedFront
    const box = { x: target.x, y: target.y, w: target.w, h: target.h }
    const update = new Map<string, WidgetElement>()
    all.forEach((m, i) => {
      update.set(m.id, {
        ...m,
        stackId: sid,
        stackOrder: i,
        stackFront: m.id === frontId || undefined,
        stackTitle: title,
        stackRestore: m.stackRestore ?? { w: m.w, h: m.h },
        ...box,
      })
    })
    const z = nextZ()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: normalizeStacks(
          w.elements.map((e) => {
            const u = update.get(e.id)
            return u ? { ...u, z } : e
          }),
        ),
      })),
    )
    set({ selection: [frontId], activeWidgetId: null })
    return sid
  },

  stackSelection: () => {
    const ws = get().active()
    if (!ws) return
    const sel = get().selection
    const widgets = sel
      .map((id) => ws.elements.find((e) => e.id === id))
      .filter((e): e is WidgetElement => !!e && e.type === 'widget' && !e.locked)
    if (widgets.length < 2) return
    const [target, ...rest] = widgets
    get().beginHistory()
    get().stackWidgets(
      rest.map((w) => w.id),
      target.id,
      target.stackId ? (stackOfId(ws.elements, target.id)?.front.id ?? target.id) : target.id,
    )
  },

  setStackFront: (id) => {
    const ws = get().active()
    if (!ws) return
    const st = stackOfId(ws.elements, id)
    if (!st || st.front.id === id) return
    const ids = new Set(st.members.map((m) => m.id))
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) =>
          ids.has(e.id) && e.type === 'widget' ? { ...e, stackFront: e.id === id || undefined } : e,
        ),
      })),
    )
    // focused on this stack: the new front takes the focused spot in place
    // (unless it's already a pane of its own, when the stack is split)
    const f = get().focus
    if (f?.id && f.id !== id && !f.panes.includes(id) && st.members.some((m) => m.id === f.id))
      set({ focus: { ...f, id, panes: f.panes.map((p) => (p === f.id ? id : p)), instant: true } })
  },

  cycleStack: (id, dir) => {
    const ws = get().active()
    if (!ws) return
    const st = stackOfId(ws.elements, id)
    if (!st) return
    const i = st.members.findIndex((m) => m.id === st.front.id)
    const next = st.members[(i + dir + st.members.length) % st.members.length]
    get().setStackFront(next.id)
    const wasActive = get().activeWidgetId != null
    set({ selection: [next.id], activeWidgetId: wasActive ? next.id : null })
  },

  unstackWidget: (id, at) => {
    const ws = get().active()
    if (!ws) return
    const st = stackOfId(ws.elements, id)
    if (!st) return
    const el = st.members.find((m) => m.id === id)!
    const size = el.stackRestore ?? { w: el.w, h: el.h }
    const pos = at ?? { x: st.front.x + st.front.w + 40, y: st.front.y }
    const wasFront = st.front.id === id
    const i = st.members.findIndex((m) => m.id === id)
    const nextFront = wasFront ? st.members[i > 0 ? i - 1 : 1].id : null
    const z = nextZ()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: normalizeStacks(
          w.elements.map((e) => {
            if (e.id === id && e.type === 'widget') return { ...stripStack(e), ...size, ...pos, z }
            if (nextFront && e.id === nextFront && e.type === 'widget') return { ...e, stackFront: true }
            return e
          }),
        ),
      })),
    )
  },

  unstackAll: (stackId) => {
    const ws = get().active()
    if (!ws) return
    const st = stacksOf(ws.elements).get(stackId)
    if (!st) return
    const placed = new Map<string, { x: number; y: number; w: number; h: number }>()
    let x = st.front.x
    for (const m of st.members) {
      const size = m.stackRestore ?? { w: m.w, h: m.h }
      placed.set(m.id, { x, y: st.front.y, ...size })
      x += size.w + 32
    }
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) => {
          const p = placed.get(e.id)
          return p && e.type === 'widget' ? { ...stripStack(e), ...p } : e
        }),
      })),
    )
    set({ selection: st.members.map((m) => m.id) })
  },

  reorderStack: (stackId, ids) => {
    const order = new Map(ids.map((id, i) => [id, i]))
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) =>
          e.type === 'widget' && e.stackId === stackId && order.has(e.id)
            ? { ...e, stackOrder: order.get(e.id) }
            : e,
        ),
      })),
    )
  },

  renameStack: (stackId, title) => {
    const t = title.trim()
    if (!t) return
    get().beginHistory()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) =>
          e.type === 'widget' && e.stackId === stackId ? { ...e, stackTitle: t } : e,
        ),
      })),
    )
  },

  enterFocus: (id, box) => {
    const st = get()
    if (st.layerOverview || st.presenting) return
    const ws = st.active()
    const el = ws?.elements.find((e) => e.id === id)
    if (!ws || !el || el.type !== 'widget') return
    frontIfHidden(get, set, id)
    // a stacked widget is focused as its stack's front
    const front = (el.stackId && stackOfId(ws.elements, id)?.front.id) || id
    if (el.minimized) get().toggleMinimized(front)
    set({
      focus: {
        id: front,
        panes: [front],
        sizes: [1],
        returning: (st.focus?.returning ?? []).filter((r) => r !== front),
        box,
        instant: false,
      },
      spread: null,
      stackDrop: null,
      selection: [front],
    })
  },

  exitFocus: () => {
    const f = get().focus
    if (!f?.id) return
    set({
      focus: {
        ...f,
        id: null,
        panes: [],
        sizes: [],
        returning: [...f.returning.filter((r) => !f.panes.includes(r)), ...f.panes],
      },
    })
  },

  swapFocus: (id) => {
    const f = get().focus
    if (!f?.id || f.id === id) return
    const el = get().active()?.elements.find((e) => e.id === id)
    if (!el || el.type !== 'widget') return
    // already a pane: just work there
    if (f.panes.includes(id)) {
      set({ focus: { ...f, id, instant: false }, selection: [id] })
      return
    }
    if (el.minimized) get().toggleMinimized(id)
    set({
      focus: {
        ...f,
        id,
        panes: f.panes.map((p) => (p === f.id ? id : p)),
        returning: [...f.returning.filter((r) => r !== f.id && r !== id), f.id],
        instant: false,
      },
      selection: [id],
    })
  },

  splitFocus: (id) => {
    const f = get().focus
    if (!f?.id || f.panes.includes(id) || f.panes.length >= MAX_PANES) return
    const el = get().active()?.elements.find((e) => e.id === id)
    if (!el || el.type !== 'widget') return
    if (el.minimized) get().toggleMinimized(id)
    const panes = addPane(f.panes, f.id, id)
    set({
      focus: {
        ...f,
        id,
        panes,
        sizes: equalSizes(panes.length),
        returning: f.returning.filter((r) => r !== id),
        instant: false,
      },
      selection: [id],
    })
  },

  closePane: (id) => {
    const f = get().focus
    if (!f?.id || !f.panes.includes(id)) return
    if (f.panes.length === 1) return get().exitFocus()
    const rest = removePane(f.panes, f.sizes, id)
    const at = f.panes.indexOf(id)
    set({
      focus: {
        ...f,
        ...rest,
        id: f.id === id ? rest.panes[Math.max(0, at - 1)] : f.id,
        returning: [...f.returning.filter((r) => r !== id), id],
        instant: false,
      },
    })
  },

  setPaneSizes: (sizes) => {
    const f = get().focus
    if (f && sizes.length === f.panes.length) set({ focus: { ...f, sizes } })
  },

  toggleMinimized: (id) => {
    const ws = get().active()
    const el = ws?.elements.find((e) => e.id === id)
    if (!ws || !el || el.type !== 'widget') return
    // a stack collapses and opens as one
    const ids = el.stackId
      ? new Set(ws.elements.filter((e) => e.type === 'widget' && e.stackId === el.stackId).map((e) => e.id))
      : new Set([id])
    const on = !el.minimized
    // a pane being collapsed leaves focus first
    const f = get().focus
    if (on && f) for (const p of f.panes) if (ids.has(p)) get().closePane(p)
    get().beginHistory()
    set((s) =>
      patchActive(s, (w) => ({
        ...w,
        dirty: true,
        elements: w.elements.map((e) =>
          ids.has(e.id) && e.type === 'widget' ? { ...e, minimized: on || undefined } : e,
        ),
      })),
    )
    if (on && ids.has(get().activeWidgetId ?? '')) set({ activeWidgetId: null })
  },

  finishFocusReturn: (id) => {
    const f = get().focus
    if (!f) return
    const returning = f.returning.filter((r) => r !== id)
    set({ focus: !f.id && !returning.length ? null : { ...f, returning } })
  },

  clearFocus: () => {
    if (get().focus) set({ focus: null })
  },

  setFocusBox: (box) => {
    const f = get().focus
    if (f) set({ focus: { ...f, box } })
  },

  openSpread: (stackId) => {
    const ws = get().active()
    if (!ws || get().focus) return
    const st = stacksOf(ws.elements).get(stackId)
    if (!st) return
    set({
      spread: { stackId, hi: st.members.findIndex((m) => m.id === st.front.id), closing: false },
      activeWidgetId: null,
      selection: [st.front.id],
    })
  },

  closeSpread: (focusId) => {
    const sp = get().spread
    if (!sp || sp.closing) return
    if (focusId) get().setStackFront(focusId)
    set({ spread: { ...sp, closing: true, drag: undefined } })
    const finish = () => {
      if (get().spread?.stackId !== sp.stackId) return
      set({ spread: null })
      if (focusId) spreadFocus?.(focusId)
    }
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    setTimeout(finish, reduce ? 0 : 300)
  },

  setSpreadHi: (i) => {
    const sp = get().spread
    if (sp && sp.hi !== i) set({ spread: { ...sp, hi: i } })
  },

  setSpreadDrag: (d) => {
    const sp = get().spread
    if (!sp) return
    const cur = sp.drag
    if (cur === d || (!cur && !d) || (cur && d && cur.id === d.id && cur.to === d.to)) return
    set({ spread: { ...sp, drag: d ?? undefined } })
  },

  setStackDrop: (d) => {
    const cur = get().stackDrop
    if (
      cur === d ||
      (cur &&
        d &&
        cur.targetId === d.targetId &&
        cur.phase === d.phase &&
        Math.abs(cur.progress - d.progress) < 0.04 &&
        cur.sourceIds.join() === d.sourceIds.join())
    )
      return
    set({ stackDrop: d })
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
    // a snapshot may name a layer removed since: normalizing gives it an entry back
    set((s) => patchActive(s, (w) => normalizeLayers({ ...w, elements: prev, dirty: true })))
    set({ selection: [] })
    dropHiddenFocus()
  },

  redo: () => {
    const ws = get().active()
    if (!ws) return
    const h = histOf(ws.id)
    const next = h.future.pop()
    if (!next) return
    h.past.push(ws.elements.map((e) => ({ ...e })))
    set((s) => patchActive(s, (w) => normalizeLayers({ ...w, elements: next, dirty: true })))
    set({ selection: [] })
    dropHiddenFocus()
  },
}))

/**
 * Reactive selector for the active workspace. Bootstrap guarantees at least
 * one tab exists, and closeTab refuses to drop the last one, so this always
 * resolves to a real workspace once the app has started.
 */
dropHiddenFocus = () => {
  const st = useStore.getState()
  const ws = st.active()
  if (!ws || !hasLayers(ws)) return
  const here = activeLayerId(ws)
  const hidden = (id: string | null) => {
    const el = id ? ws.elements.find((e) => e.id === id) : undefined
    return !!el && layerOf(el) !== here
  }
  if (hidden(focusedWidgetId())) blurFocus()
  if (hidden(st.activeWidgetId)) useStore.setState({ activeWidgetId: null })
}

export const selectActive = (s: Store): Workspace =>
  s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]

// ---------- session restore + autosave ----------

export function bootstrap() {
  const session = loadSession()
  if (session && session.tabs.length) {
    for (const ws of session.tabs)
      for (const el of ws.elements) zCounter = Math.max(zCounter, el.z + 1)
    useStore.setState({
      tabs: session.tabs.map(normalizeLayers),
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
  let disk: ReturnType<typeof setTimeout> | null = null
  useStore.subscribe((s) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => {
      saveSession({ tabs: s.tabs, activeTabId: s.activeTabId })
    }, 400)
    if (disk) clearTimeout(disk)
    disk = setTimeout(() => void autosaveToDisk(), 1500)
  })
}

// Write every folder-bound canvas with unsaved changes to <dir>/<name>.ccnvs,
// so the folder always holds its canvas and reopening the folder restores it.
let autosaving = false
async function autosaveToDisk() {
  if (autosaving) return
  const pending = useStore
    .getState()
    .tabs.filter((t) => t.dir && t.dirty && !isGraphTab(t))
  if (!pending.length || !(await backendOnline())) return
  autosaving = true
  try {
    for (const tab of pending) {
      const ok = await saveFile(canvasPath(tab), JSON.stringify(toFile(tab), null, 2))
      // clear dirty only if nothing changed while writing (tabs are replaced
      // on every edit, so identity tells us); otherwise the next pass saves it
      if (ok)
        useStore.setState((s) => ({
          tabs: s.tabs.map((x) => (x === tab ? { ...x, dirty: false } : x)),
        }))
    }
  } finally {
    autosaving = false
  }
}
