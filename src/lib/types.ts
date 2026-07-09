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
  | 'sql'
  | 'data'
  | 'plot'
  | 'transcript'
  | 'video'
  | 'mediainfo'
  | 'claude'

type Base = {
  id: string
  /** stacking order; higher renders on top */
  z: number
  /** elements sharing a groupId select/move together */
  groupId?: string
  /** locked elements can't be moved, resized, or deleted by normal gestures */
  locked?: boolean
  /** label-box parts (the frame + name text) carry the widget id they wrap, so
   *  the box can be toggled off and is cleaned up when that widget is deleted */
  labelFor?: string
  /** elements spawned by the agent-tracking camera carry the tracked agent's id,
   *  so "stop & clear" can remove the orbit (satellite widgets + their arrows) */
  trackOf?: string
}

export type DrawElement = Base & {
  type: 'draw'
  /** flat world-space coords: [x0, y0, x1, y1, ...] */
  points: number[]
  color: string
  size: number
}

/**
 * An arrow endpoint bound to another element — it follows that element.
 * `anchor` pins the endpoint to a specific connection point (normalized 0..1
 * within the element's bounds); without it the endpoint auto-docks to the edge
 * nearest the other end.
 */
export type ArrowBinding = { id: string; anchor?: { nx: number; ny: number } }

/**
 * When the SOURCE agent finishes a turn, how do we decide whether this edge
 * fires? Evaluated against the source's just-finished turn output.
 *  • always   — fire on any turn completion
 *  • success  — output matches the success keywords (or `pattern` if set)
 *  • failure  — output matches the failure keywords (or `pattern` if set)
 *  • match    — output matches `pattern` (a regex)
 */
export type FlowCondition = 'always' | 'success' | 'failure' | 'match'

/**
 * Orchestration logic carried by a connector between two agent widgets. The
 * arrow's `from` is the source agent, `to` is the target. When the source
 * finishes a turn and `when` holds, the target receives `prompt` (and Enter).
 */
export type ArrowFlow = {
  /** disabled edges are decorative only (default: enabled) */
  enabled?: boolean
  /** condition on the source agent's just-finished turn */
  when: FlowCondition
  /** regex source for `match`, or an override for success/failure keywords */
  pattern?: string
  /** prompt delivered to the target agent when this edge fires */
  prompt?: string
  /**
   * For a target with several incoming flow edges:
   *  • all — fire only once every incoming edge is satisfied (AND, default)
   *  • any — fire as soon as this edge is satisfied (OR)
   */
  join?: 'all' | 'any'
}

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
  /** logic edge between two agents — see ArrowFlow */
  flow?: ArrowFlow
  /** signed perpendicular offset of the curve's apex from the chord midpoint,
   *  in world units. 0 / undefined = a straight line; ± bows either way. */
  bend?: number
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
  // sql widget — both safe to persist (a key *name* and the query text; the
  // connection string itself is never stored, it's read from .env at runtime)
  envKey?: string // which .env key holds the Postgres connection string
  query?: string // last SQL text, so reopening the canvas restores it
  /** transcript widget: the agent widget whose conversation it mirrors */
  agentId?: string
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

/** A reusable prompt snippet kept in the prompt library (localStorage). */
export type Prompt = {
  id: string
  name: string
  text: string
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
  sql: '#3ecf8e', // Supabase green
  data: '#7fc7c0',
  plot: '#e89bc8',
  transcript: '#b9a8e0',
  video: '#e0708a',
  mediainfo: '#e0899b',
  claude: '#d98a5a',
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
