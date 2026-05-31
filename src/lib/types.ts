// Core data model for ccanvas. Everything that lives on a canvas is a
// CanvasElement; a Workspace is one .ccnvs file (one tab).

export type Point = { x: number; y: number }

export type Tool =
  | 'select'
  | 'pan'
  | 'pen'
  | 'arrow'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'eraser'
  | 'frame'

export type WidgetKind =
  | 'terminal'
  | 'agent'
  | 'web'
  | 'note'
  | 'files'
  | 'diff'
  | 'editor'
  | 'doc'
  | 'log'
  | 'pr'
  | 'issues'
  | 'runs'
  | 'runner'

type Base = {
  id: string
  /** stacking order; higher renders on top */
  z: number
  /** elements sharing a groupId select/move together */
  groupId?: string
  /** locked elements can't be moved, resized, or deleted by normal gestures */
  locked?: boolean
}

export type DrawElement = Base & {
  type: 'draw'
  /** flat world-space coords: [x0, y0, x1, y1, ...] */
  points: number[]
  color: string
  size: number
}

/** An arrow endpoint bound to another element — it follows that element. */
export type ArrowBinding = { id: string }

export type ArrowElement = Base & {
  type: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  size: number
  /** when set, the matching endpoint tracks the bound element's edge */
  from?: ArrowBinding
  to?: ArrowBinding
  /** optional label drawn at the arrow's midpoint */
  label?: string
  /** dashed instead of solid stroke */
  dashed?: boolean
}

export type ShapeElement = Base & {
  type: 'rect' | 'ellipse'
  x: number
  y: number
  w: number
  h: number
  color: string
  size: number
}

export type TextElement = Base & {
  type: 'text'
  x: number
  y: number
  text: string
  color: string
  fontSize: number
}

/** Raster image (pasted screenshot, dropped file). src is a data URL. */
export type ImageElement = Base & {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  src: string
  /** natural pixel size, for aspect-correct resize */
  naturalW: number
  naturalH: number
}

/** A labelled container. Moving a frame moves the elements inside it. */
export type FrameElement = Base & {
  type: 'frame'
  x: number
  y: number
  w: number
  h: number
  title: string
  color: string
}

export type WidgetElement = Base & {
  type: 'widget'
  kind: WidgetKind
  x: number
  y: number
  w: number
  h: number
  title: string
  // kind-specific payload
  url?: string // web preview
  note?: string // markdown note
  cwd?: string // terminal working dir hint
  path?: string // file/folder a files/editor/doc/log widget points at
  cmd?: string // command for diff/log widgets (defaults per kind)
  color?: string // per-widget accent override (agents); drives /color too
  /** claude session id for agent widgets (persisted so reopening resumes it) */
  sessionId?: string
  /** set true after claude has been launched once for this agent's session,
   *  so subsequent opens use `claude --resume <sessionId>` */
  agentStarted?: boolean
  // agent launch config (agent widgets)
  model?: string // e.g. "opus", "sonnet"; appended as --model
  agentPrompt?: string // initial prompt typed after launch
  skipPermissions?: boolean // pass --dangerously-skip-permissions
  worktree?: string // git worktree branch this agent is isolated in
}

export type CanvasElement =
  | DrawElement
  | ArrowElement
  | ShapeElement
  | TextElement
  | ImageElement
  | FrameElement
  | WidgetElement

export type Camera = { x: number; y: number; zoom: number }

export type Workspace = {
  id: string
  name: string
  elements: CanvasElement[]
  camera: Camera
  createdAt: number
  /** absolute on-disk folder this canvas is bound to (where its .ccnvs lives
   *  and the working directory terminals/agents open in) */
  dir?: string
  /** unsaved changes since last disk write */
  dirty?: boolean
}

/** On-disk shape of a .ccnvs file */
export type CcnvsFile = {
  format: 'ccnvs'
  version: 1
  name: string
  camera: Camera
  elements: CanvasElement[]
}

/** A reusable layout of widgets spawned together onto a fresh canvas. */
export type Template = {
  id: string
  name: string
  /** widget blueprints, positioned relative to the cluster's top-left */
  widgets: Array<{
    kind: WidgetKind
    dx: number
    dy: number
    w: number
    h: number
    title?: string
    url?: string
    note?: string
    path?: string
    cmd?: string
    model?: string
    agentPrompt?: string
    skipPermissions?: boolean
  }>
}

export const WIDGET_ACCENT: Record<WidgetKind, string> = {
  terminal: '#e8795a',
  agent: '#c89bd6',
  web: '#6db5a8',
  note: '#d8a657',
  files: '#8bbf73',
  diff: '#e8795a',
  editor: '#7fc7c0',
  doc: '#d8a657',
  log: '#9a9892',
  pr: '#6d9be8',
  issues: '#8bbf73',
  runs: '#d8a657',
  runner: '#8bbf73',
}

/** Agent accent colours, each mapped to a valid Claude Code `/color` name. */
export const AGENT_COLORS: { name: string; hex: string }[] = [
  { name: 'default', hex: '#c89bd6' },
  { name: 'red', hex: '#e8795a' },
  { name: 'orange', hex: '#e8975a' },
  { name: 'yellow', hex: '#d8a657' },
  { name: 'green', hex: '#8bbf73' },
  { name: 'cyan', hex: '#7fc7c0' },
  { name: 'blue', hex: '#6d9be8' },
  { name: 'purple', hex: '#b07cd6' },
  { name: 'pink', hex: '#e89bc8' },
]

/** Map an agent accent hex back to the Claude `/color` name (default if unknown). */
export function claudeColorName(hex?: string): string {
  const m = AGENT_COLORS.find((c) => c.hex.toLowerCase() === (hex ?? '').toLowerCase())
  return m ? m.name : 'default'
}

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 }

/** Drawing/ink palette shown in the props panel. First entry is the default. */
export const PALETTE: string[] = [
  '#e8e6e1', // ink
  '#e8795a', // clay
  '#6db5a8', // teal
  '#d8a657', // amber
  '#c89bd6', // violet
  '#8bbf73', // green
]

/** Stroke widths offered in the props panel. */
export const STROKE_SIZES: number[] = [2, 4, 7]
