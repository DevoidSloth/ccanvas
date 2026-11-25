// Mirroring Claude desktop-app sessions onto the canvas. Discovery (reading the
// desktop app's metadata) is the Rust `desktop_sessions` command; this file only
// consumes its result. Mirrors are read-only 'transcript' widgets bound straight
// to a Claude Code session id — we NEVER spawn `claude --resume` on that id, as
// two writers would split the JSONL. "Fork into terminal" uses --fork-session.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, openExternal } from './backend'
import { watchTranscriptSummary, type TranscriptSummary } from './transcript'
import { useAgents, type AgentStatus } from './agents'
import { useStore, selectActive, WIDGET_SIZE } from '../store/workspace'
import { viewCenter, viewport } from './view'
import { activeLayerId, landingCamera, layerForPath } from './layers'
import { screenToWorld } from './geometry'
import type { CanvasElement, WidgetElement } from './types'

export type DesktopSession = {
  /** the desktop app's own id (`local_<uuid>`) */
  sessionId: string
  /** the Claude Code session id — names the transcript file */
  cliSessionId: string
  cwd: string
  title: string
  model: string | null
  isArchived: boolean
  createdAt: number | null
  lastActivityAt: number | null
  transcriptPath: string
  /** transcript mtime (epoch ms); null when the file is missing */
  transcriptMtime: number | null
}

/** A transcript written this recently counts as "running now". */
export const RUNNING_WINDOW_MS = 30_000

export function isRunningNow(modifiedMs: number | null | undefined, now = Date.now()): boolean {
  return modifiedMs != null && now - modifiedMs < RUNNING_WINDOW_MS
}

/** The desktop app's sessions, newest activity first (empty outside the desktop
 *  build or when the desktop app isn't installed). */
export async function listDesktopSessions(): Promise<DesktopSession[]> {
  if (!isTauri()) return []
  try {
    return await invoke<DesktopSession[]>('desktop_sessions')
  } catch {
    return []
  }
}

export const isDesktopMirror = (el: CanvasElement): el is WidgetElement =>
  el.type === 'widget' && el.kind === 'transcript' && el.mirrorOf === 'desktop'

/** Widget fields that bind a transcript widget to a desktop session. */
export function mirrorInit(s: DesktopSession): Partial<WidgetElement> {
  return {
    mirrorOf: 'desktop',
    desktopId: s.sessionId,
    cwd: s.cwd,
    sessionId: s.cliSessionId,
    title: s.title,
    // only read for the context meter's window size (a `[1m]` suffix)
    ...(s.model ? { model: s.model } : {}),
  }
}

/** Claude Code session ids already mirrored in these elements. */
export function mirroredIds(elements: CanvasElement[]): Set<string> {
  const ids = new Set<string>()
  for (const e of elements) if (isDesktopMirror(e) && e.sessionId) ids.add(e.sessionId)
  return ids
}

/** Shell command that opens an independent copy of a session. `--fork-session`
 *  gives the copy its own id, so the original transcript is never written. */
export function forkCommand(sessionId: string): string | null {
  // ids come from another app's files — never let one smuggle shell syntax in
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null
  return `claude --resume ${sessionId} --fork-session`
}

// a mirror opens at a Claude chat's own size (store WIDGET_SIZE)
const MIRROR_W = WIDGET_SIZE.transcript.w
const MIRROR_H = WIDGET_SIZE.transcript.h
const GAP = 40
const COLS = 3

/** Add one mirror per session to the active canvas, laid out in a grid around
 *  the view centre. Sessions already mirrored there are skipped. Returns how
 *  many were added. */
export function addDesktopMirrors(sessions: DesktopSession[]): number {
  const s = useStore.getState()
  const ws = selectActive(s)
  const have = mirroredIds(ws.elements)
  const todo = sessions.filter((d) => !have.has(d.cliSessionId))
  if (!todo.length) return 0
  // each mirror goes to the layer whose folder holds its session's folder,
  // else the layer you're on; each layer's batch is centred in that layer's view
  const here = activeLayerId(ws)
  const groups = new Map<string, DesktopSession[]>()
  for (const d of todo) {
    const id = layerForPath(ws, d.cwd) ?? here
    groups.set(id, [...(groups.get(id) ?? []), d])
  }
  const { vw, vh } = viewport()
  for (const [layer, batch] of groups) {
    const cam = layer === here ? ws.camera : landingCamera(ws, layer, vw, vh)
    const c = screenToWorld(viewCenter(), cam)
    const cols = Math.min(COLS, batch.length)
    const rows = Math.ceil(batch.length / cols)
    const x0 = c.x - ((cols - 1) * (MIRROR_W + GAP)) / 2
    const y0 = c.y - ((rows - 1) * (MIRROR_H + GAP)) / 2
    batch.forEach((d, i) => {
      const x = x0 + (i % cols) * (MIRROR_W + GAP)
      const y = y0 + Math.floor(i / cols) * (MIRROR_H + GAP)
      s.spawnWidget('transcript', x, y, { ...mirrorInit(d), layer })
    })
  }
  return todo.length
}

/** Open a terminal next to a mirror running a fork of its session. */
export function forkIntoTerminal(mirror: WidgetElement): boolean {
  const cmd = mirror.sessionId ? forkCommand(mirror.sessionId) : null
  if (!cmd || !mirror.cwd) return false
  useStore.getState().spawnWidget('terminal', mirror.x + mirror.w + 380, mirror.y + mirror.h / 2, {
    cwd: mirror.cwd,
    title: `${mirror.title} · fork`,
    startCmd: cmd,
  })
  return true
}

// ---------- what a mirrored session is waiting on ----------

/** Deep link that opens one session in the Claude desktop app, where it can be
 *  answered, approved or replied to. The app looks the id up among its
 *  unarchived sessions. */
export function claudeAppUrl(desktopId: string | undefined): string | null {
  if (!desktopId || !/^local_[A-Za-z0-9-]+$/.test(desktopId)) return null
  return `claude://code/continue?session=${desktopId}`
}

/** Bring the mirrored session up in the Claude desktop app. */
export function openInClaude(mirror: WidgetElement): boolean {
  const url = claudeAppUrl(mirror.desktopId)
  if (!url) return false
  void openExternal(url)
  return true
}

/** A tool call with no result for this long is flagged: it's waiting for
 *  approval or still running. The transcript can't tell those apart. */
export const STALL_MS = 10_000

export type MirrorWaiting =
  /** Claude asked the user something (AskUserQuestion, plan approval) */
  | { kind: 'ask'; question: string; options: string[] }
  /** a tool call has had no result for a while: a permission prompt, or slow */
  | { kind: 'stalled'; tool: string; sinceMs: number }

export function mirrorWaiting(s: TranscriptSummary | null, now = Date.now()): MirrorWaiting | null {
  const p = s?.pending
  if (!p) return null
  if (p.question) return { kind: 'ask', question: p.question, options: p.options }
  const since = s.modified ?? now
  return now - since >= STALL_MS ? { kind: 'stalled', tool: p.tool, sinceMs: now - since } : null
}

export type MirrorStatus = Extract<AgentStatus, 'off' | 'idle' | 'working' | 'waiting'>

/** A mirror's activity, read off its transcript: waiting while Claude asks
 *  something or a tool call has stalled, working while the file is being
 *  written, else idle ('off' when there's no transcript to read). */
export function mirrorStatus(s: TranscriptSummary | null, now = Date.now()): MirrorStatus {
  if (!s) return 'off'
  if (mirrorWaiting(s, now)) return 'waiting'
  return isRunningNow(s.modified, now) ? 'working' : 'idle'
}

/**
 * Publish a mirror's status to the agents store, under the widget's id, so it
 * shows wherever a terminal's does (icon slot, stack tabs and edges, focus
 * strip, attention bar, layer chip) with no per-place code. Called once per
 * mirror widget (from its body). Rides the shared transcript poll, which calls
 * back every few seconds even when nothing changed: that is what ages
 * 'working' into idle and a quiet tool call into 'waiting'. Going from working
 * to idle stamps the turn as finished, so the icon shows 'done' for a while.
 */
export function useMirrorStatusSync(el: WidgetElement | null) {
  const id = el?.id
  const cwd = el?.cwd
  const sessionId = el?.sessionId
  useEffect(() => {
    if (!id) return
    let prev: MirrorStatus | null = null
    const publish = (s: TranscriptSummary | null) => {
      const next = mirrorStatus(s)
      const agents = useAgents.getState()
      agents.setStatus(id, next)
      if (prev === 'working' && next === 'idle') agents.markFinished(id)
      prev = next
    }
    publish(null)
    const off = watchTranscriptSummary(cwd, sessionId, publish)
    return () => {
      off()
      useAgents.getState().clear(id)
    }
  }, [id, cwd, sessionId])
}

/** What a mirror's session is waiting on, re-checked every few seconds while a
 *  tool call is open (the transcript stays quiet while it waits). */
export function useMirrorWaiting(el: WidgetElement): MirrorWaiting | null {
  const [summary, setSummary] = useState<TranscriptSummary | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(
    () =>
      watchTranscriptSummary(el.cwd, el.sessionId, (s) => {
        setSummary(s)
        setNow(Date.now())
      }),
    [el.cwd, el.sessionId],
  )
  const open = !!summary?.pending
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [open])
  return mirrorWaiting(summary, now)
}
