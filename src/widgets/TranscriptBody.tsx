import { useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { transcriptPathFor, parseTranscript, type TranscriptTurn } from '../lib/transcript'
import { readFile, watchPath, baseName } from '../lib/backend'
import { IconReload } from '../ui/icons'
import '../styles/agent-tools.css'

// Renders an agent's real conversation, read from its session JSONL transcript —
// the clean version, free of the terminal's box-drawing chrome. Bound to an
// agent widget by id (el.agentId); follows its session live and lets you filter.

function ToolChip({ name, target }: { name: string; target?: string }) {
  const short = target
    ? target.length > 48
      ? '…' + target.slice(-46)
      : target
    : ''
  return (
    <span className="tx__tool" title={`${name}${target ? ' · ' + target : ''}`}>
      <span className="tx__tool-name">{name}</span>
      {short && <span className="tx__tool-target">{short}</span>}
    </span>
  )
}

export function TranscriptBody({ el }: { el: WidgetElement }) {
  // resolve the agent we mirror (live, so a self-healed session id is picked up)
  const agent = useStore((s) =>
    selectActive(s).elements.find(
      (e): e is WidgetElement => e.type === 'widget' && e.id === el.agentId,
    ),
  )
  const cwd = agent?.cwd ?? el.cwd
  const sessionId = agent?.sessionId

  const [turns, setTurns] = useState<TranscriptTurn[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [q, setQ] = useState('')
  const [autoscroll, setAutoscroll] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // resolve the transcript path whenever the bound session changes
  useEffect(() => {
    let alive = true
    void transcriptPathFor(cwd, sessionId).then((p) => {
      if (alive) setPath(p)
    })
    return () => {
      alive = false
    }
  }, [cwd, sessionId])

  const reload = useMemo(
    () => async () => {
      if (!path) return
      const content = await readFile(path)
      if (content == null) {
        setOffline(true)
        return
      }
      setOffline(false)
      setTurns(parseTranscript(content))
    },
    [path],
  )

  // initial load + live refresh on transcript writes
  useEffect(() => {
    if (!path) return
    void reload()
    let dispose: (() => void) | null = null
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void reload(), 350)
    }
    void watchPath(path, onChange, 1500).then((d) => (cancelled ? d() : (dispose = d)))
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
      dispose?.()
    }
  }, [path, reload])

  // keep pinned to the newest turn unless the user scrolls up
  useEffect(() => {
    if (autoscroll && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, autoscroll])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return turns
    return turns.filter(
      (m) =>
        m.text.toLowerCase().includes(t) ||
        m.tools.some((tool) => (tool.target ?? '').toLowerCase().includes(t)),
    )
  }, [turns, q])

  if (!el.agentId) {
    return (
      <div className="tx tx--empty">
        Open this from an agent’s menu — “Open transcript” — to mirror its conversation.
      </div>
    )
  }

  return (
    <div className="tx">
      <div className="tx__bar">
        <input
          className="tx__search"
          placeholder="Filter conversation…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setQ('')
          }}
        />
        <span className="tx__count">{turns.length} msgs</span>
        <button
          className={`tx__btn${autoscroll ? ' tx__btn--on' : ''}`}
          title="Stick to newest"
          onClick={() => setAutoscroll((a) => !a)}
        >
          ↓
        </button>
        <button className="tx__btn" title="Reload" onClick={() => void reload()}>
          <IconReload />
        </button>
      </div>

      <div
        className="tx__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const n = e.currentTarget
          const atBottom = n.scrollHeight - n.scrollTop - n.clientHeight < 40
          setAutoscroll(atBottom)
        }}
      >
        {offline ? (
          <div className="tx__hint">
            backend offline, or no transcript yet — run <code>npm run server</code> or use the
            desktop app
          </div>
        ) : filtered.length === 0 ? (
          <div className="tx__hint">{q ? 'no matching messages' : 'no messages yet'}</div>
        ) : (
          filtered.map((m, i) => (
            <div key={i} className={`tx__msg tx__msg--${m.role}`}>
              <div className="tx__role">{m.role === 'user' ? 'you' : baseName(agent?.title ?? 'agent')}</div>
              {m.text && <div className="tx__text">{m.text}</div>}
              {m.tools.length > 0 && (
                <div className="tx__tools">
                  {m.tools.map((tool, j) => (
                    <ToolChip key={j} name={tool.name} target={tool.target} />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
