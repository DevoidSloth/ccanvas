// Runtime state for terminal/agent widgets that lives outside the document
// model: which sessions are live (for broadcast), and each one's activity
// status (for the dot on the widget bar + idle notifications).
//
// Kept in its own tiny zustand store so high-frequency status churn only
// re-renders the status dots, not the whole canvas.

import { create } from 'zustand'

export type AgentStatus =
  | 'off' // no live shell (local fallback / not connected)
  | 'connecting'
  | 'idle' // connected, quiet — waiting for you
  | 'working' // actively streaming output
  | 'waiting' // appears to be asking a question / permission prompt

/** Observable activity metrics per agent (turns + active time + scraped cost). */
export type AgentMetrics = { turns: number; activeMs: number; costUsd?: number }

type StatusState = {
  status: Record<string, AgentStatus>
  metrics: Record<string, AgentMetrics>
  /** the most recent meaningful line of each agent's output (for the roster) */
  lastLine: Record<string, string>
  setStatus: (id: string, s: AgentStatus) => void
  /** record one working→idle turn that lasted `ms` */
  recordTurn: (id: string, ms: number) => void
  /** latest cost (USD) scraped from `/cost` output */
  setCost: (id: string, usd: number) => void
  /** stash the latest output line shown next to the agent in the roster */
  setLastLine: (id: string, line: string) => void
  clear: (id: string) => void
}

export const useAgents = create<StatusState>((set) => ({
  status: {},
  metrics: {},
  lastLine: {},
  setStatus: (id, s) =>
    set((st) =>
      st.status[id] === s ? st : { status: { ...st.status, [id]: s } },
    ),
  recordTurn: (id, ms) =>
    set((st) => {
      const m = st.metrics[id] ?? { turns: 0, activeMs: 0 }
      return {
        metrics: {
          ...st.metrics,
          [id]: { ...m, turns: m.turns + 1, activeMs: m.activeMs + ms },
        },
      }
    }),
  setCost: (id, usd) =>
    set((st) => {
      const m = st.metrics[id] ?? { turns: 0, activeMs: 0 }
      if (m.costUsd === usd) return st
      return { metrics: { ...st.metrics, [id]: { ...m, costUsd: usd } } }
    }),
  setLastLine: (id, line) =>
    set((st) =>
      st.lastLine[id] === line ? st : { lastLine: { ...st.lastLine, [id]: line } },
    ),
  clear: (id) =>
    set((st) => {
      if (!(id in st.status) && !(id in st.metrics) && !(id in st.lastLine)) return st
      const status = { ...st.status }
      const metrics = { ...st.metrics }
      const lastLine = { ...st.lastLine }
      delete status[id]
      delete metrics[id]
      delete lastLine[id]
      return { status, metrics, lastLine }
    }),
}))

/** Best-effort scrape of a USD cost from `/cost` output. null if none found. */
export function scrapeCost(text: string): number | null {
  const m = /(?:total|session)\s+cost:?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(stripAnsi(text))
  return m ? parseFloat(m[1]) : null
}

// ---------- transport registry (non-reactive) ----------
type Live = { send: (d: string) => void; kind: 'terminal' | 'agent'; title: string }
const transports = new Map<string, Live>()

export function registerTransport(id: string, live: Live) {
  transports.set(id, live)
}
export function unregisterTransport(id: string) {
  transports.delete(id)
}
export function isLive(id: string): boolean {
  return transports.has(id)
}
export function liveSessions(): Array<{ id: string } & Live> {
  return [...transports.entries()].map(([id, l]) => ({ id, ...l }))
}

/** Write the same data to many live sessions (the broadcast feature). */
export function broadcast(ids: string[], data: string) {
  for (const id of ids) transports.get(id)?.send(data)
}

/** Write data to a single live session, if it's connected. */
export function sendTo(id: string, data: string): boolean {
  const t = transports.get(id)
  if (!t) return false
  t.send(data)
  return true
}

/**
 * Deliver a prompt to a live agent/terminal. Multi-line text is wrapped in a
 * bracketed-paste sequence so Claude's TUI ingests every line as one block
 * (a bare \n would submit the first line early). `submit` appends Enter.
 * Returns false if the session isn't connected.
 */
export function sendPrompt(id: string, text: string, submit = true): boolean {
  const body = text.replace(/\r/g, '').replace(/\n+$/, '')
  const wrapped = body.includes('\n') ? `\x1b[200~${body}\x1b[201~` : body
  return sendTo(id, submit ? `${wrapped}\r` : wrapped)
}

// ---------- status classification from terminal output ----------

const PROMPT_HINTS = [
  /\bdo you want\b/i,
  /\bproceed\?\b/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /❯\s*1\./, // claude's numbered choice menu
  /press enter to continue/i,
  /\bcontinue\?/i,
  /overwrite\?/i,
]

/** Strip ANSI escapes so the tail can be pattern-matched. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

/** Does this recent output look like the agent is waiting for an answer? */
export function looksLikePrompt(tail: string): boolean {
  const recent = stripAnsi(tail).slice(-400)
  return PROMPT_HINTS.some((re) => re.test(recent))
}

// ---------- desktop notifications ----------
let notifyReady = false
export async function ensureNotifyPermission() {
  if (notifyReady) return
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default')
      await Notification.requestPermission()
  } catch {
    /* unsupported */
  }
  notifyReady = true
}

export function notify(title: string, body: string) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted')
      new Notification(title, { body })
  } catch {
    /* unsupported */
  }
}
