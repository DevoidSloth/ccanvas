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
import { readTranscript, extractLastAssistant } from './transcript'

// Heuristic keyword sets for the success/failure conditions. An agent that
// needs a reliable signal should instead be told to end with a sentinel and
// matched with `when: 'match'` against a precise pattern.
const SUCCESS_RE =
  /\b(success(ful(ly)?)?|succeeded|done|complete[d]?|passed|✓|✔|finished|lgtm|ready)\b/i
const FAILURE_RE =
  /\b(fail(ed|ure|s)?|errored?|exception|✗|✘|cannot|could ?n'?t|denied|aborted|rejected|blocked)\b/i

/**
 * Text the success/failure/match conditions run against. Uses the cleaned
 * output (TUI input-box chrome stripped) so a finished agent's concluding
 * words aren't pushed out of view by the prompt box; trailing slice keeps it
 * to roughly the last turn.
 */
function lastTurnText(tail: string): string {
  return cleanAgentOutput(tail).slice(-1500)
}

// Placeholder in an edge prompt that gets replaced with the source agent's
// piped output. (Aliases for convenience.)
const OUTPUT_TOKEN = /\{\{\s*(output|out|result|prev|previous)\s*\}\}/gi

/**
 * Best-effort extraction of an agent's recent output for piping into the next
 * agent: strip ANSI, drop Claude's TUI input-box chrome and hint lines, collapse
 * blank runs, and keep the trailing slice. It's terminal scraping, so it's
 * approximate — wrap it with instructions via {{output}} when precision matters.
 */
export function cleanAgentOutput(tail: string): string {
  const lines = stripAnsi(tail).split('\n')
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/[╭╮╰╯│─┌┐└┘├┤┬┴┼]/.test(line)) continue // input-box frame
    if (/^\s*[>❯]\s*$/.test(line)) continue // empty prompt marker
    if (/\?\s*for shortcuts/i.test(line)) continue
    if (/^\s*(esc to interrupt|ctrl\+[a-z]|shift\+|tab to|⏎)/i.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(-6000)
}

// ---------- session transcript (the model's actual last message) ----------
// Reading the agent's transcript gives the model's real assistant output, free
// of terminal chrome. The location + parsing live in lib/transcript.ts.

/**
 * The text of the source agent's most recent assistant turn, pulled from its
 * session transcript: every assistant text block since the last user/tool event.
 * Returns null if the transcript can't be read (no backend, unknown path, etc.).
 */
async function readLastAssistant(source: WidgetElement): Promise<string | null> {
  const content = await readTranscript(source.cwd, source.sessionId)
  if (!content) return null
  return extractLastAssistant(content)
}

/** True if an edge's resolved text would embed the source's output. */
function wantsOutput(edge: ArrowElement): boolean {
  const p = edge.flow?.prompt?.trim() ?? ''
  if (!p) return true
  OUTPUT_TOKEN.lastIndex = 0
  const r = OUTPUT_TOKEN.test(p)
  OUTPUT_TOKEN.lastIndex = 0
  return r
}

/** Capture the source's output to pipe: real transcript message, else scrape. */
async function captureOutput(source: WidgetElement, tail: string): Promise<string> {
  const fromTranscript = await readLastAssistant(source)
  return fromTranscript ?? cleanAgentOutput(tail)
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
// Incoming edges satisfied for a target but not yet consumed by a fire. Keyed
// by target widget id → (arrow id → the source agent's piped output captured
// when that edge was satisfied).
const satisfied = new Map<string, Map<string, string>>()

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

/**
 * The text one edge contributes to its target, resolving output piping:
 *  • prompt with {{output}} → placeholder replaced by the source's output
 *  • empty prompt           → the source's output itself (pure pipe)
 *  • plain prompt           → the prompt as written (no pipe)
 */
function edgeText(edge: ArrowElement, output: string): string {
  const p = edge.flow?.prompt?.trim() ?? ''
  if (!p) return output
  if (OUTPUT_TOKEN.test(p)) {
    OUTPUT_TOKEN.lastIndex = 0 // reset the global regex after .test()
    return p.replace(OUTPUT_TOKEN, output)
  }
  return p
}

/** Fire a target: build its prompt from the satisfied edges (piping), deliver. */
function fireTarget(
  ws: Workspace,
  targetId: string,
  satisfiedEdges: ArrowElement[],
  outputs: Map<string, string>,
) {
  if (!allowFire()) return
  const target = ws.elements.find((e) => e.id === targetId)
  const title = (target && 'title' in target && target.title) || 'agent'
  // combine each contributing edge's resolved text, in stacking order
  const prompt = satisfiedEdges
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((e) => edgeText(e, outputs.get(e.id) ?? ''))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n')
  // re-arm: consume the satisfied set so the next run needs fresh completions
  satisfied.delete(targetId)
  if (!prompt) {
    notify('ccanvas flow', `${title} triggered, but there was no output or prompt to send.`)
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
export async function onAgentTurnComplete(sourceId: string, turnIndex: number, tail: string) {
  if (!useStore.getState().flowsEnabled) return
  const ws = tabContaining(sourceId)
  if (!ws) return

  const outgoing = flowEdges(ws, { from: sourceId })
  if (!outgoing.length) return

  // this agent's output (the model's last message), captured once to pipe into
  // any edge that fires — only fetched when some edge actually needs it
  const sourceEl = ws.elements.find((e) => e.id === sourceId)
  const output =
    sourceEl && sourceEl.type === 'widget' && outgoing.some(wantsOutput)
      ? await captureOutput(sourceEl, tail)
      : ''

  const touchedTargets = new Set<string>()
  for (const edge of outgoing) {
    if (lastFiredTurn.get(edge.id) === turnIndex) continue // already fired this turn
    if (!evaluateCondition(edge, tail)) continue
    lastFiredTurn.set(edge.id, turnIndex)
    const targetId = edge.to!.id
    let set = satisfied.get(targetId)
    if (!set) satisfied.set(targetId, (set = new Map()))
    set.set(edge.id, output)
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
    if (anyFires || allFire) fireTarget(ws, targetId, satEdges, sat)
  }
}
