// Agent-tracking camera. Bind a tracking session to one agent and, as it works,
// watch its transcript for file operations; every newly-touched file opens as a
// viewer widget arranged in an orbit around the agent with an arrow pointing
// back to it, so you can watch what the agent is doing laid out spatially. The
// camera stays framed on the agent + its satellites.
//
// Non-reactive (like flow.ts): a store flag (trackingAgentId) drives the UI and
// calls in here; this module owns the polling + element spawning.

import { useStore } from '../store/workspace'
import type { ArrowElement, WidgetElement } from './types'
import { WIDGET_ACCENT } from './types'
import { newId } from './id'
import { resolvePath, baseName } from './backend'
import { readTranscript, extractToolFiles, type ToolFile } from './transcript'
import { widgetKindForFile } from './filetypes'
import { boundsOfMany, clamp } from './geometry'
import { notify } from './agents'

type Session = {
  agentId: string
  /** transcript lines already consumed */
  cursor: number
  /** absolute file path → the widget id showing it */
  openedByPath: Map<string, string>
  /** how many satellites we've positioned (drives the orbit slot) */
  placed: number
  stopped: boolean
  dispose: (() => void) | null
  cappedNotified: boolean
}

let session: Session | null = null

const MAX_SATELLITES = 20
const SAT_W = 360
const SAT_H = 280
const POLL_MS = 1000

// topbar + tabs; matches CHROME_H elsewhere
const CHROME_H = 82
const viewport = () => ({ vw: window.innerWidth, vh: window.innerHeight - CHROME_H })

export function trackingAgentId(): string | null {
  return session?.agentId ?? null
}
export function trackedFileCount(): number {
  return session?.openedByPath.size ?? 0
}

/** Position a satellite on a ring around the agent (8 per ring, growing out). */
function orbitPos(agent: WidgetElement, index: number): { x: number; y: number } {
  const cx = agent.x + agent.w / 2
  const cy = agent.y + agent.h / 2
  const perRing = 8
  const ring = Math.floor(index / perRing)
  const slot = index % perRing
  const baseR = Math.max(agent.w, agent.h) / 2 + 280
  const r = baseR + ring * 260
  const ang = ((-90 + slot * (360 / perRing)) * Math.PI) / 180
  return { x: cx + Math.cos(ang) * r - SAT_W / 2, y: cy + Math.sin(ang) * r - SAT_H / 2 }
}

/** Build the arrow connecting the agent to one of its satellites. */
function trackArrow(agent: WidgetElement, targetId: string, f: ToolFile): ArrowElement {
  return {
    id: newId(),
    type: 'arrow',
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    color: agent.color ?? WIDGET_ACCENT.agent,
    size: 2,
    dashed: true,
    from: { id: agent.id },
    to: { id: targetId },
    label: f.mutate ? undefined : 'read',
    z: 0,
    trackOf: agent.id,
  }
}

/** Center the camera on just the agent at a comfortable zoom. */
function frameAgent(agentId: string) {
  const s = useStore.getState()
  const ws = s.active()
  const agent = ws?.elements.find((e) => e.id === agentId)
  if (!agent || agent.type !== 'widget') return
  const { vw, vh } = viewport()
  const zoom = clamp(s.active()!.camera.zoom, 0.5, 1)
  const cx = agent.x + agent.w / 2
  const cy = agent.y + agent.h / 2
  s.setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
}

/** Fit the agent + all its satellites into the viewport. */
function frameOrbit() {
  if (!session) return
  const s = useStore.getState()
  const ws = s.active()
  if (!ws) return
  const ids = new Set<string>([session.agentId, ...session.openedByPath.values()])
  const els = ws.elements.filter((e) => ids.has(e.id))
  const b = boundsOfMany(els)
  if (!b) return
  const { vw, vh } = viewport()
  const pad = 120
  const zoom = clamp(Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2)), 0.1, 1.3)
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  s.setCamera({ zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom })
}

/** Poll the transcript once and reconcile the orbit with newly-touched files. */
async function tick() {
  if (!session || session.stopped) return
  const s = useStore.getState()
  const ws = s.active()
  if (!ws) return
  // only act while the agent's own tab is showing, so we never spawn satellites
  // onto the wrong canvas or fight a tab the user switched to
  const agent = ws.elements.find(
    (e): e is WidgetElement => e.id === session!.agentId && e.type === 'widget',
  )
  if (!agent || agent.kind !== 'agent') return

  const content = await readTranscript(agent.cwd, agent.sessionId)
  if (content == null) return
  const { files, cursor } = extractToolFiles(content, session.cursor)
  session.cursor = cursor
  if (!files.length) return

  let added = false
  for (const f of files) {
    const abs = resolvePath(agent.cwd, f.path)
    const known = session.openedByPath.get(abs)
    if (known) {
      s.bringToFront([known])
      continue
    }
    // adopt a viewer the user already has open for this file (don't duplicate)
    const existing = ws.elements.find(
      (e): e is WidgetElement =>
        e.type === 'widget' && !!e.path && resolvePath(e.cwd, e.path) === abs,
    )
    if (existing) {
      session.openedByPath.set(abs, existing.id)
      s.addElement(trackArrow(agent, existing.id, f))
      s.bringToFront([existing.id])
      added = true
      continue
    }
    if (session.openedByPath.size >= MAX_SATELLITES) {
      if (!session.cappedNotified) {
        session.cappedNotified = true
        notify('ccanvas tracking', `Showing the first ${MAX_SATELLITES} files — stop & restart to reset the orbit.`)
      }
      continue
    }
    const pos = orbitPos(agent, session.placed++)
    const wid = newId()
    const widget: WidgetElement = {
      id: wid,
      type: 'widget',
      kind: widgetKindForFile(abs),
      x: pos.x,
      y: pos.y,
      w: SAT_W,
      h: SAT_H,
      z: 0,
      title: baseName(abs),
      path: abs,
      cwd: agent.cwd,
      trackOf: agent.id,
    }
    s.addElements([widget, trackArrow(agent, wid, f)])
    session.openedByPath.set(abs, wid)
    added = true
  }
  if (added && useStore.getState().trackingAgentId === session.agentId) frameOrbit()
}

/**
 * Begin tracking an agent. Switches to the agent's tab (so satellites land on
 * the right canvas) and frames it. Returns false if the agent can't be found.
 */
export async function startTracking(agentId: string): Promise<boolean> {
  stopTracking(false)
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.elements.some((e) => e.id === agentId))
  if (!tab) return false
  const agent = tab.elements.find((e) => e.id === agentId)
  if (!agent || agent.type !== 'widget' || agent.kind !== 'agent') return false
  if (s.activeTabId !== tab.id) s.switchTab(tab.id)

  // seed the cursor to the current end of the transcript so we only orbit files
  // the agent touches AFTER tracking starts — not its whole back-history
  const seed = await readTranscript(agent.cwd, agent.sessionId)
  const cursor = seed ? extractToolFiles(seed, 0).cursor : 0

  const timer = setInterval(() => void tick(), POLL_MS)
  session = {
    agentId,
    cursor,
    openedByPath: new Map(),
    placed: 0,
    stopped: false,
    dispose: () => clearInterval(timer),
    cappedNotified: false,
  }
  frameAgent(agentId)
  void tick()
  return true
}

/** Stop tracking. When `cleanup`, remove the orbit (satellites + their arrows). */
export function stopTracking(cleanup: boolean) {
  if (!session) return
  session.stopped = true
  session.dispose?.()
  const agentId = session.agentId
  session = null
  if (!cleanup) return
  const s = useStore.getState()
  // the orbit lives on the agent's tab — switch there so removeElements (which
  // acts on the active tab) actually clears it, even when stopped from elsewhere
  const tab = s.tabs.find((t) => t.elements.some((e) => e.trackOf === agentId))
  if (!tab) return
  if (s.activeTabId !== tab.id) s.switchTab(tab.id)
  const ids = tab.elements.filter((e) => e.trackOf === agentId).map((e) => e.id)
  if (ids.length) s.removeElements(ids)
}
