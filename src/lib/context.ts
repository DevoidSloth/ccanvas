// Context meter: how much of an agent's context window its conversation fills,
// read from the session transcript and refreshed while the widget is mounted.

import { useEffect, useState } from 'react'
import { readTranscript, extractContext } from './transcript'

const POLL_MS = 8000
const STANDARD_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

export type AgentContext = { used: number; window: number; pct: number }

/** Context window for a session: 1M when the model was launched with the
 *  `[1m]` suffix or the conversation has already grown past 200K. */
function windowFor(modelFlag: string | undefined, model: string | undefined, peak: number) {
  if (/\[1m\]/i.test(modelFlag ?? '') || /\[1m\]/i.test(model ?? '')) return LARGE_WINDOW
  return peak > STANDARD_WINDOW ? LARGE_WINDOW : STANDARD_WINDOW
}

export function useAgentContext(
  cwd: string | undefined,
  sessionId: string | undefined,
  modelFlag: string | undefined,
): AgentContext | null {
  const [ctx, setCtx] = useState<AgentContext | null>(null)
  useEffect(() => {
    if (!cwd || !sessionId) return
    let alive = true
    const poll = async () => {
      const jsonl = await readTranscript(cwd, sessionId)
      if (!alive) return
      const c = jsonl ? extractContext(jsonl) : null
      if (!c) return setCtx(null)
      const window = windowFor(modelFlag, c.model, c.peak)
      setCtx({ used: c.used, window, pct: Math.min(100, (c.used / window) * 100) })
    }
    void poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [cwd, sessionId, modelFlag])
  return ctx
}
