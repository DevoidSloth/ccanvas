// What a desktop-app mirror's session is waiting on. A mirror is read-only, so
// questions and permission prompts are shown here and answered in the Claude
// desktop app, which a click brings up on that exact session.

import { openInClaude, useMirrorWaiting, type MirrorWaiting } from '../lib/desktopSessions'
import type { WidgetElement } from '../lib/types'

function secs(ms: number) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`
}

export function waitingTitle(w: MirrorWaiting): string {
  return w.kind === 'ask'
    ? `Claude is waiting for your answer: ${w.question}\nClick to answer in the Claude app.`
    : `${w.tool} has had no result for ${secs(w.sinceMs)}: it may need your approval, or it's still running.\nClick to open it in the Claude app.`
}

/** Header chip "<Tool>?" for a tool call that stalled. The icon slot already
 *  turns amber for any wait; this names the tool and says it's a guess
 *  (approval, or just slow). A question needs no chip: the icon says it, and
 *  the strip under the transcript (MirrorAsk) shows it with its answer button. */
export function MirrorWaitChip({ el }: { el: WidgetElement }) {
  const w = useMirrorWaiting(el)
  if (w?.kind !== 'stalled') return null
  return (
    <button
      className={`dsk-wait dsk-wait--${w.kind}`}
      title={waitingTitle(w)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        openInClaude(el)
      }}
    >
      {`${w.tool}?`}
    </button>
  )
}

/** Strip under the transcript with the question and its options (read-only). */
export function MirrorAsk({ el }: { el: WidgetElement }) {
  const w = useMirrorWaiting(el)
  if (w?.kind !== 'ask') return null
  return (
    <div className="dsk-ask" onPointerDown={(e) => e.stopPropagation()}>
      <div className="dsk-ask__q">{w.question}</div>
      {w.options.length > 0 && (
        <div className="dsk-ask__opts">
          {w.options.map((o) => (
            <span key={o} className="dsk-ask__opt">
              {o}
            </span>
          ))}
        </div>
      )}
      <button className="dsk-ask__go" onClick={() => openInClaude(el)}>
        Answer in Claude
      </button>
    </div>
  )
}
