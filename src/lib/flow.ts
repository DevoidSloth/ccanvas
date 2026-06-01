// Arrow orchestration engine. An arrow between two agent widgets can carry an
// ArrowFlow: when the source agent finishes a turn and the edge's condition
// holds, the target agent is handed a prompt (and Enter). Multiple arrows into
// one target give join semantics — "after THESE agents run, run THIS one."
//
// This module is non-reactive: TerminalBody calls onAgentTurnComplete() when an
// agent settles to idle; we read the document from the store and drive live
// sessions through the transport registry in agents.ts.

import type { ArrowElement, CanvasElement, WidgetElement, Workspace } from './types'
import { useStore } from '../store/workspace'
import { sendTo, isLive, stripAnsi, notify } from './agents'

// Heuristic keyword sets for the success/failure conditions. An agent that
// needs a reliable signal should instead be told to end with a sentinel and
// matched with `when: 'match'` against a precise pattern.
const SUCCESS_RE =
  /\b(success(ful(ly)?)?|succeeded|done|complete[d]?|passed|✓|✔|finished|lgtm|ready)\b/i
const FAILURE_RE =
  /\b(fail(ed|ure|s)?|errored?|exception|✗|✘|cannot|could ?n'?t|denied|aborted|rejected|blocked)\b/i

/** Look only at the agent's most recent output, not the whole scrollback. */
function lastTurnText(tail: string): string {
  return stripAnsi(tail).slice(-1200)
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, 'i')
  } catch {
    return null
  }
}

/** Does the source agent's just-finished turn satisfy this edge's condition? */
export function evaluateCondition(arrow: ArrowElement, tail: string): boolean {
  const flow = arrow.flow
  if (!flow) return false
  const text = lastTurnText(tail)
  switch (flow.when) {
    case 'always':
      return true
    case 'match': {
      if (!flow.pattern) return false
      const re = safeRegex(flow.pattern)
      return re ? re.test(text) : false
    }
    case 'success': {
      const re = flow.pattern ? safeRegex(flow.pattern) : SUCCESS_RE
      return re ? re.test(text) : false
    }
    case 'failure': {
      const re = flow.pattern ? safeRegex(flow.pattern) : FAILURE_RE
      return re ? re.test(text) : false
    }
  }
}

// ---------- runtime bookkeeping (outside the reactive store) ----------

// An edge fires at most once per source-turn — remember the source turn index
// it last fired on so a single completion can't re-trigger it.
const lastFiredTurn = new Map<string, number>()
// Incoming edges that have been satisfied for a target but not yet consumed by
// a fire. Keyed by target widget id → set of arrow ids.
const satisfied = new Map<string, Set<string>>()

// Runaway guard: if flows fire faster than this within the window, pause them
// and tell the user, so a cyclic graph can't spam agents forever.
const FIRE_WINDOW_MS = 60_000
const FIRE_LIMIT = 60
let fireTimes: number[] = []

function allowFire(): boolean {
  const now = Date.now()
  fireTimes = fireTimes.filter((t) => now - t < FIRE_WINDOW_MS)
  if (fireTimes.length >= FIRE_LIMIT) {
    useStore.getState().setFlowsEnabled(false)
    notify('ccanvas flows paused', 'Too many auto-runs in a row — flows paused.')
    return false
  }
  fireTimes.push(now)
  return true
}

/** Forget all pending state — used when flows are toggled off. */
export function resetFlowState() {
  lastFiredTurn.clear()
  satisfied.clear()
  fireTimes = []
}

// ---------- graph helpers ----------

function isAgent(el: CanvasElement | undefined): el is WidgetElement {
  return !!el && el.type === 'widget' && el.kind === 'agent'
}

/** The workspace (tab) that contains a given element id. */
function tabContaining(id: string): Workspace | null {
  for (const t of useStore.getState().tabs)
    if (t.elements.some((e) => e.id === id)) return t
  return null
}

/** Live, enabled flow arrows in a tab, optionally filtered by source/target. */
function flowEdges(
  ws: Workspace,
  opts: { from?: string; to?: string } = {},
): ArrowElement[] {
  const byId = new Map(ws.elements.map((e) => [e.id, e]))
  return ws.elements.filter((e): e is ArrowElement => {
    if (e.type !== 'arrow' || !e.flow || e.flow.enabled === false) return false
    if (!e.from || !e.to) return false
    if (opts.from && e.from.id !== opts.from) return false
    if (opts.to && e.to.id !== opts.to) return false
    // both ends must resolve to agent widgets
    return isAgent(byId.get(e.from.id)) && isAgent(byId.get(e.to.id))
  })
}

// ---------- delivery ----------

/**
 * Send a prompt to a target agent, retrying briefly if it isn't live yet.
 * Multi-line prompts are wrapped in a bracketed-paste sequence so Claude's TUI
 * ingests every line as one block (a bare \n would submit the first line); a
 * trailing \r then submits.
 */
function deliver(targetId: string, prompt: string, title: string, tries = 0) {
  const text = prompt.replace(/\r/g, '').replace(/\n+$/, '')
  const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`
  if (sendTo(targetId, payload)) return
  if (tries >= 4) {
    notify('ccanvas flow stalled', `${title} isn't running — open it to receive its prompt.`)
    return
  }
  if (!isLive(targetId)) {
    // nudge the widget to mount/connect, then retry
    useStore.getState().setActiveWidget(targetId)
  }
  setTimeout(() => deliver(targetId, prompt, title, tries + 1), 1300)
}

/** Fire a target: build the combined prompt from its satisfied edges, deliver. */
function fireTarget(ws: Workspace, targetId: string, satisfiedEdges: ArrowElement[]) {
  if (!allowFire()) return
  const target = ws.elements.find((e) => e.id === targetId)
  const title = (target && 'title' in target && target.title) || 'agent'
  // combine prompts from the contributing edges in stacking order
  const prompt = satisfiedEdges
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((e) => e.flow?.prompt?.trim())
    .filter(Boolean)
    .join('\n')
  // re-arm: consume the satisfied set so the next run needs fresh completions
  satisfied.delete(targetId)
  if (!prompt) {
    notify('ccanvas flow', `${title} triggered, but no prompt is set on the edge.`)
    return
  }
  deliver(targetId, prompt, title)
}

// ---------- entry point ----------

/**
 * Called by TerminalBody when an agent settles to idle after working.
 * `turnIndex` is the agent's monotonic turn counter (for per-turn dedupe);
 * `tail` is its recent terminal output.
 */
export function onAgentTurnComplete(sourceId: string, turnIndex: number, tail: string) {
  if (!useStore.getState().flowsEnabled) return
  const ws = tabContaining(sourceId)
  if (!ws) return

  const outgoing = flowEdges(ws, { from: sourceId })
  if (!outgoing.length) return

  const touchedTargets = new Set<string>()
  for (const edge of outgoing) {
    if (lastFiredTurn.get(edge.id) === turnIndex) continue // already fired this turn
    if (!evaluateCondition(edge, tail)) continue
    lastFiredTurn.set(edge.id, turnIndex)
    const targetId = edge.to!.id
    let set = satisfied.get(targetId)
    if (!set) satisfied.set(targetId, (set = new Set()))
    set.add(edge.id)
    touchedTargets.add(targetId)
  }

  // decide which touched targets should now fire
  for (const targetId of touchedTargets) {
    const incoming = flowEdges(ws, { to: targetId })
    const sat = satisfied.get(targetId)
    if (!sat || !incoming.length) continue
    const satEdges = incoming.filter((e) => sat.has(e.id))
    // OR: any satisfied edge marked 'any' fires immediately
    const anyFires = satEdges.some((e) => e.flow?.join === 'any')
    // AND (default): every incoming edge must be satisfied
    const allFire = incoming.every((e) => sat.has(e.id))
    if (anyFires || allFire) fireTarget(ws, targetId, satEdges)
  }
}
