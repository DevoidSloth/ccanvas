// Keeps a claude agent's CCanvas name in step with the session's own name.
// Claude records names in the session transcript, so we poll it:
//  - `/rename` typed inside the session (custom-title) is adopted whenever it
//    *changes* — never merely because it differs, which would undo a rename made
//    from CCanvas before Claude has processed it;
//  - the name Claude generates after the first prompt (ai-title) is adopted only
//    while the widget still has its default name and nobody has renamed the
//    session, so it never overrides a name someone chose.

import { useEffect } from 'react'
import { useStore } from '../store/workspace'
import type { WidgetElement } from './types'
import { readTranscript, extractSessionTitles } from './transcript'

const POLL_MS = 3000
const DEFAULT_TITLE = 'claude agent'

export function useSyncSessionTitle(el: WidgetElement) {
  const { id, kind, cwd, sessionId } = el
  useEffect(() => {
    if (kind !== 'agent' || !cwd || !sessionId) return
    let alive = true
    let seenCustom: string | null | undefined // undefined = not read yet
    const poll = async () => {
      const jsonl = await readTranscript(cwd, sessionId)
      if (!alive || jsonl == null) return
      const { custom, ai } = extractSessionTitles(jsonl)
      const renamed = seenCustom !== undefined && custom !== seenCustom
      seenCustom = custom

      const s = useStore.getState()
      const cur = s.tabs.flatMap((t) => t.elements).find((e) => e.id === id)
      if (!cur || cur.type !== 'widget') return
      let next: string | null = null
      if (renamed && custom) next = custom
      else if (!custom && ai && cur.title === DEFAULT_TITLE) next = ai
      if (!next || cur.title === next) return
      s.mutateElement(id, (w) => {
        ;(w as WidgetElement).title = next
      })
    }
    void poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, kind, cwd, sessionId])
}
