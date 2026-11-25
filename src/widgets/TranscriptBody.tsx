import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { livePlace } from '../lib/view'
import { useStore, selectActive } from '../store/workspace'
import {
  transcriptPathFor,
  readTranscriptChunk,
  readTranscriptFiles,
  subagentLogPath,
  transcriptMarkdown,
  watchTranscriptSummary,
  TranscriptParser,
  type ActivityStep,
  type FileChange,
  type ThinkingStep,
  type ToolCall,
  type TranscriptItem,
  type TranscriptSummary,
} from '../lib/transcript'
import { sessionCost, fmtUsd, costTitle } from '../lib/cost'
import { widgetKindForFile } from '../lib/filetypes'
import { watchPath, baseName, openExternal } from '../lib/backend'
import { renderMarkdown } from '../lib/markdown'
import { IconReload } from '../ui/icons'
import { useTextScale } from '../lib/settings'
import { useMirrorStatusSync } from '../lib/desktopSessions'
import '../styles/agent-tools.css'

// Renders an agent's real conversation, read from its session JSONL transcript —
// the clean version, free of the terminal's box-drawing chrome. Bound to an
// agent widget by id (el.agentId), or — for a desktop-app mirror
// (el.mirrorOf === 'desktop') — straight to el.cwd + el.sessionId. Follows the
// session live and lets you filter. Read-only either way.

// a mirror's first read starts this far from the end of a huge transcript
const MIRROR_TAIL_BYTES = 8 * 1024 * 1024
// a subagent's log is read from at most this far from its end
const SUBAGENT_TAIL_BYTES = 2 * 1024 * 1024

/** The transcript file the widget shows, for finding its subagents' logs. */
const TxPath = createContext<string | null>(null)

/** A message body rendered as markdown. Memoised per text, so appending turns
 *  to a long conversation doesn't re-render every earlier one. */
const MdText = memo(function MdText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="tx__md"
      // renderMarkdown escapes everything, then re-allows a safe tag subset
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        // a link would navigate the whole app away: open it in the browser
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (/^https?:\/\//i.test(href)) void openExternal(href)
      }}
    />
  )
})

// ---------- tool activity ----------
// Each tool call is one compact row (status, name, target) that opens to show
// what the desktop app shows: a command and its output tail, a diff preview, a
// checklist. Rows render their body only while open, and every row, group and
// message is memoised on its object: the parser swaps in a new object only for
// what changed, so a live append re-renders the new rows, not the history.

const GLYPH: Record<ToolCall['state'], string> = {
  running: '◌',
  done: '✓',
  error: '✕',
  stopped: '–',
}
const STATE_TITLE: Record<ToolCall['state'], string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  stopped: 'no result (interrupted)',
}
const PLAN_GLYPH: Record<string, string> = { completed: '☑', in_progress: '◧' }

/** "14:02:11" for a row's tooltip; the date too when it isn't today. */
function when(ts: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString() : d.toLocaleString()
}

/** Short text at the right of a row: +3 −1, 2/5, 120 lines … */
function toolMeta(t: ToolCall): string {
  if (t.diff) return t.diff.del ? `+${t.diff.add} −${t.diff.del}` : `+${t.diff.add}`
  if (t.plan?.length) return `${t.plan.filter((p) => p.status === 'completed').length}/${t.plan.length}`
  if (t.images) return t.images > 1 ? `${t.images} images` : 'image'
  if ((t.name === 'Read' || t.name === 'Grep' || t.name === 'Glob') && t.outputLines)
    return `${t.outputLines} lines`
  return ''
}

/** The row's one-liner after the tool name. */
function toolLine(t: ToolCall): string {
  if (t.plan?.length) {
    const cur = t.plan.find((p) => p.status === 'in_progress')
    return cur?.text ?? (t.plan.every((p) => p.status === 'completed') ? 'all done' : t.plan[0].text)
  }
  if (!t.target) return ''
  // a file path: lead with the file's name, then its folder
  if (/^[/~]/.test(t.target) && !t.target.includes(' ')) {
    const cut = t.target.lastIndexOf('/')
    if (cut > 0 && cut < t.target.length - 1)
      return `${t.target.slice(cut + 1)}  ${t.target.slice(0, cut)}`
  }
  return t.target
}

const hasBody = (t: ToolCall) =>
  !!(t.command || t.diff?.lines.length || t.plan?.length || t.prompt || t.output)


const ToolBody = ({ t }: { t: ToolCall }) => (
  <div className="tx__tbody">
    {t.plan?.length ? (
      <ul className="tx__plan">
        {t.plan.map((p, i) => (
          <li key={i} className={`tx__plan-item tx__plan-item--${p.status}`}>
            <span className="tx__plan-box">{PLAN_GLYPH[p.status] ?? '☐'}</span>
            {p.text}
          </li>
        ))}
      </ul>
    ) : null}
    {t.prompt && <div className="tx__tprompt">{t.prompt}</div>}
    {t.diff && t.diff.lines.length > 0 && (
      <pre className="tx__diff">
        {t.diff.lines.map((l, i) => (
          <span key={i} className={l[0] === '+' ? 'tx__add' : 'tx__del'}>
            {l}
            {'\n'}
          </span>
        ))}
        {t.diff.add + t.diff.del > t.diff.lines.length && (
          <span className="tx__more">… {t.diff.add + t.diff.del - t.diff.lines.length} more lines</span>
        )}
      </pre>
    )}
    {t.command && <pre className="tx__out tx__out--cmd">$ {t.command}</pre>}
    {t.output && !t.plan?.length && (
      <pre className={`tx__out${t.state === 'error' ? ' tx__out--error' : ''}`}>{t.output}</pre>
    )}
    {(t.name === 'Task' || t.name === 'Agent') && <SubagentLog t={t} />}
  </div>
)

// ---------- subagents ----------
// A subagent's work lives in its own log. It's read only when you ask for it,
// followed only while it's shown, and dropped when you hide it.

function SubagentLog({ t }: { t: ToolCall }) {
  const main = useContext(TxPath)
  const [open, setOpen] = useState(false)
  if (!main) return null
  return (
    <div className="tx__sub">
      <button className="tx__sub-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾ Hide' : '▸ Show'} the subagent’s work
      </button>
      {open && <SubagentFeed main={main} t={t} />}
    </div>
  )
}

function SubagentFeed({ main, t }: { main: string; t: ToolCall }) {
  // undefined while looking it up; null when there's no log
  const [path, setPath] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void subagentLogPath(main, t.id, t.agentId).then((p) => alive && setPath(p))
    return () => {
      alive = false
    }
  }, [main, t.id, t.agentId])
  const feed = useTranscriptFeed(path ?? null, SUBAGENT_TAIL_BYTES)
  const boxRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const n = boxRef.current
    if (n && stick.current) n.scrollTop = n.scrollHeight
  }, [feed.items])
  if (path === undefined) return <div className="tx__sub-hint">finding its log…</div>
  if (!path || feed.offline)
    return (
      <div className="tx__sub-hint">
        {t.state === 'running' ? 'its log hasn’t been written yet' : 'no separate log for this subagent'}
      </div>
    )
  return (
    <div
      className="tx__sub-box"
      ref={boxRef}
      onScroll={(e) => {
        const n = e.currentTarget
        stick.current = n.scrollHeight - n.scrollTop - n.clientHeight < 30
      }}
    >
      {feed.truncated && <div className="tx__sub-hint">earlier steps not loaded — this log is large</div>}
      <ItemList items={feed.items} who="subagent" me="brief" />
      {!feed.items.length && <div className="tx__sub-hint">no steps yet</div>}
    </div>
  )
}

const ToolRow = memo(function ToolRow({ t }: { t: ToolCall }) {
  const [open, setOpen] = useState(false)
  const body = hasBody(t)
  const meta = toolMeta(t)
  const line = toolLine(t)
  return (
    <div className={`tx__trow tx__trow--${t.state}${open ? ' tx__trow--open' : ''}`}>
      <button
        className="tx__thead"
        disabled={!body}
        title={[t.name, t.target, when(t.ts), STATE_TITLE[t.state]].filter(Boolean).join('\n')}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tx__glyph">{GLYPH[t.state]}</span>
        <span className="tx__tname">{t.label}</span>
        {line && <span className="tx__ttarget">{line}</span>}
        {meta && <span className="tx__tmeta">{meta}</span>}
        {body && <span className="tx__caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && <ToolBody t={t} />}
    </div>
  )
})

const ThinkingRow = memo(function ThinkingRow({ s }: { s: ThinkingStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tx__trow tx__trow--thinking${open ? ' tx__trow--open' : ''}`}>
      <button className="tx__thead" title={when(s.ts)} onClick={() => setOpen((o) => !o)}>
        <span className="tx__glyph">∴</span>
        <span className="tx__tname">thinking</span>
        {!open && <span className="tx__ttarget">{s.text.slice(0, 160)}</span>}
        <span className="tx__caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="tx__think">{s.text}</div>}
    </div>
  )
})

const Step = ({ s }: { s: ActivityStep }) =>
  s.kind === 'tool' ? <ToolRow t={s} /> : <ThinkingRow s={s} />

// groups of more tool calls than this fold into one "ran N tools" line
const GROUP_MIN = 4

/** "Bash 4 · Edit 2 · Read 1" */
function toolCounts(steps: ActivityStep[]): string {
  const n = new Map<string, number>()
  for (const s of steps) if (s.kind === 'tool') n.set(s.label, (n.get(s.label) ?? 0) + 1)
  return [...n]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => (v > 1 ? `${k} ${v}` : k))
    .join(' · ')
}

const Activity = memo(function Activity({
  steps,
  live,
}: {
  steps: ActivityStep[]
  /** the newest item of the conversation: open while it's still running */
  live: boolean
}) {
  const [open, setOpen] = useState<boolean | null>(null)
  const tools = steps.filter((s): s is ToolCall => s.kind === 'tool')
  if (tools.length < GROUP_MIN)
    return (
      <div className="tx__activity">
        {steps.map((s, i) => (
          <Step key={i} s={s} />
        ))}
      </div>
    )
  const running = tools.some((t) => t.state === 'running')
  const failed = tools.filter((t) => t.state === 'error').length
  const shown = open ?? (live && running)
  return (
    <div className="tx__activity">
      <button className="tx__group" onClick={() => setOpen(!shown)}>
        <span className="tx__glyph">{running ? GLYPH.running : shown ? '▾' : '▸'}</span>
        <span className="tx__tname">
          {running ? 'running' : 'ran'} {tools.length} tools
        </span>
        <span className="tx__ttarget">{toolCounts(steps)}</span>
        {failed > 0 && <span className="tx__tmeta tx__tmeta--error">{failed} failed</span>}
      </button>
      {shown && (
        <div className="tx__group-body">
          {steps.map((s, i) => (
            <Step key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  )
})

const Item = memo(function Item({
  m,
  who,
  head,
  live,
  me = 'you',
}: {
  m: TranscriptItem
  who: string
  /** first assistant item after a prompt: show the speaker */
  head: boolean
  live: boolean
  /** label on your prompts */
  me?: string
}) {
  if (m.kind === 'event')
    return (
      <div className={`tx__event${m.tone ? ' tx__event--' + m.tone : ''}`} title={[m.text, when(m.ts)].join('\n')}>
        {m.text}
      </div>
    )
  if (m.kind === 'user')
    return (
      <div className="tx__msg tx__msg--user">
        <div className="tx__role" title={when(m.ts)}>{me}</div>
        {m.text && <MdText text={m.text} />}
        {m.images > 0 && (
          <div className="tx__tools">
            <span className="tx__tool">
              <span className="tx__tool-name">▣ {m.images > 1 ? `${m.images} images` : 'image'}</span>
            </span>
          </div>
        )}
      </div>
    )
  return (
    <div className="tx__msg tx__msg--assistant">
      {head && <div className="tx__role" title={when(m.ts)}>{who}</div>}
      {m.kind === 'text' ? <MdText text={m.text} /> : <Activity steps={m.steps} live={live} />}
    </div>
  )
})

/** Does a filter query match this item (prose, or a tool's target/command)? */
function itemMatches(m: TranscriptItem, q: string): boolean {
  if (m.kind !== 'activity') return m.text.toLowerCase().includes(q)
  return m.steps.some((s) =>
    s.kind === 'thinking'
      ? s.text.toLowerCase().includes(q)
      : s.label.toLowerCase().includes(q) ||
        (s.target ?? '').toLowerCase().includes(q) ||
        (s.command ?? '').toLowerCase().includes(q),
  )
}

/** Items in order, with the speaker shown on the first reply after a prompt. */
function ItemList({ items, who, keys, me }: { items: TranscriptItem[]; who: string; keys?: number[]; me?: string }) {
  return (
    <>
      {items.map((m, k) => {
        const prev = items[k - 1]
        const head =
          m.kind !== 'user' && m.kind !== 'event' && (!prev || prev.kind === 'user' || prev.kind === 'event')
        const key = keys ? keys[k] : k
        return <Item key={key} m={m} who={who} me={me} head={head} live={k === items.length - 1} />
      })}
    </>
  )
}

/** A transcript file parsed into items, kept current as it's appended to.
 *  Reads incrementally: the byte offset parsed so far is kept and only what
 *  was appended is parsed (each line is one event). Desktop transcripts reach
 *  ~100 MB; re-reading them per write was too heavy. */
function useTranscriptFeed(path: string | null, tail: number | undefined) {
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [offline, setOffline] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const offsetRef = useRef(0)
  // keeps tool calls open across chunks so their results can be paired later
  const parserRef = useRef(new TranscriptParser())
  const busyRef = useRef(false)
  // a change that arrives mid-read re-runs once that read finishes
  const pendingRef = useRef<'none' | 'more' | 'fresh'>('none')
  const pathRef = useRef(path)
  pathRef.current = path

  const read = useCallback(
    async (fresh = false) => {
      if (busyRef.current) {
        if (fresh) pendingRef.current = 'fresh'
        else if (pendingRef.current === 'none') pendingRef.current = 'more'
        return
      }
      busyRef.current = true
      try {
        let mode: 'none' | 'more' | 'fresh' = fresh ? 'fresh' : 'more'
        while (mode !== 'none') {
          const p = pathRef.current
          if (!p) break
          const from = mode === 'fresh' ? 0 : offsetRef.current
          const chunk = await readTranscriptChunk(p, from, tail)
          if (pathRef.current === p) {
            if (!chunk) setOffline(true)
            else {
              setOffline(false)
              const restart = from === 0 || chunk.reset
              offsetRef.current = chunk.next
              if (restart) parserRef.current = new TranscriptParser()
              const parser = parserRef.current
              const changed = chunk.text ? parser.push(chunk.text) : false
              if (restart) {
                setTruncated(chunk.truncated)
                setItems(parser.items.slice())
              } else if (changed) setItems(parser.items.slice())
            }
          }
          mode = pendingRef.current
          pendingRef.current = 'none'
        }
      } finally {
        busyRef.current = false
      }
    },
    [tail],
  )
  const reload = useCallback(() => read(true), [read])

  // initial load + live refresh on writes
  useEffect(() => {
    if (!path) return
    void reload()
    let dispose: (() => void) | null = null
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void read(), 350)
    }
    void watchPath(path, onChange, 1500).then((d) => (cancelled ? d() : (dispose = d)))
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
      dispose?.()
    }
  }, [path, reload, read])

  return { items, offline, truncated, reload }
}

const copyText = (text: string) => navigator.clipboard?.writeText(text).then(
  () => true,
  () => false,
) ?? Promise.resolve(false)

/** "src/App.tsx" for a file under cwd, else the path as is. */
function shortPath(p: string, cwd: string | undefined): string {
  if (cwd && p.startsWith(cwd.replace(/\/$/, '') + '/')) return p.slice(cwd.replace(/\/$/, '').length + 1)
  return p
}

export function TranscriptBody({ el }: { el: WidgetElement }) {
  // resolve the agent we mirror (live, so a self-healed session id is picked up)
  const agent = useStore((s) =>
    selectActive(s).elements.find(
      (e): e is WidgetElement => e.type === 'widget' && e.id === el.agentId,
    ),
  )
  const mirror = el.mirrorOf === 'desktop'
  const cwd = mirror ? el.cwd : (agent?.cwd ?? el.cwd)
  const sessionId = mirror ? el.sessionId : agent?.sessionId
  // a mirror's working / needs-you / done status, for every place that shows one
  useMirrorStatusSync(mirror ? el : null)

  const [path, setPath] = useState<string | null>(null)
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

  const { items, offline, truncated, reload } = useTranscriptFeed(path, mirror ? MIRROR_TAIL_BYTES : undefined)

  // cost and changed files come from the backend's running summary
  const [summary, setSummary] = useState<TranscriptSummary | null>(null)
  useEffect(() => watchTranscriptSummary(cwd, sessionId, setSummary), [cwd, sessionId])
  const cost = useMemo(() => sessionCost(summary?.tokens), [summary?.tokens])

  const [pop, setPop] = useState<'files' | 'menu' | null>(null)
  const closePop = useCallback(() => setPop(null), [])
  const [flash, setFlash] = useState<string | null>(null)
  const say = (text: string) => {
    setFlash(text)
    setTimeout(() => setFlash((f) => (f === text ? null : f)), 1400)
  }

  // keep pinned to the newest turn unless the user scrolls up
  useEffect(() => {
    if (autoscroll && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [items, autoscroll])

  // ...and when the layout changes under it: the widget is resized, or the
  // Settings text size reflows every message (no scroll event fires for either)
  const textScale = useTextScale()
  const autoscrollRef = useRef(autoscroll)
  autoscrollRef.current = autoscroll
  useEffect(() => {
    const n = scrollRef.current
    if (!n) return
    const pin = () => {
      if (autoscrollRef.current) n.scrollTop = n.scrollHeight
    }
    pin()
    const ro = new ResizeObserver(pin)
    ro.observe(n)
    return () => ro.disconnect()
  }, [textScale])

  // keep each item's index in the full list as its key, so a row's open
  // state stays with that row while filtering
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    const all = items.map((m, i) => ({ m, i }))
    return t ? all.filter(({ m }) => itemMatches(m, t)) : all
  }, [items, q])
  const filteredItems = useMemo(() => filtered.map((f) => f.m), [filtered])
  const filteredKeys = useMemo(() => filtered.map((f) => f.i), [filtered])
  const msgCount = useMemo(
    () => items.reduce((n, m) => (m.kind === 'user' || m.kind === 'text' ? n + 1 : n), 0),
    [items],
  )
  const who = mirror ? 'claude' : baseName(agent?.title ?? 'agent')
  const jumpToLatest = () => {
    setAutoscroll(true)
    const n = scrollRef.current
    if (n) n.scrollTop = n.scrollHeight
  }

  /** Scroll to the previous (-1) or next (1) prompt you typed. */
  const jumpPrompt = (dir: -1 | 1) => {
    const n = scrollRef.current
    if (!n) return
    const base = n.getBoundingClientRect().top - n.scrollTop
    const tops = Array.from(n.querySelectorAll<HTMLElement>(':scope > .tx__msg--user')).map(
      (e) => e.getBoundingClientRect().top - base - 8,
    )
    const at = n.scrollTop
    const to = dir < 0 ? tops.filter((y) => y < at - 4).pop() : tops.find((y) => y > at + 4)
    if (to == null) {
      if (dir > 0) jumpToLatest()
      return
    }
    setAutoscroll(false)
    n.scrollTop = to
  }

  // Claude's final message: the last prose after your latest prompt
  const copyLastReply = async () => {
    const at = items.map((m) => m.kind).lastIndexOf('user')
    const last = items.slice(at + 1).filter((m) => m.kind === 'text').pop()
    const text = last?.kind === 'text' ? last.text : ''
    say(text ? ((await copyText(text)) ? 'copied' : 'copy failed') : 'no reply yet')
  }
  const copyChat = async (whole: boolean) => {
    let list = items
    if (whole && path) {
      // the widget holds only the end of a huge transcript: read it all once
      say('reading…')
      const chunk = await readTranscriptChunk(path, 0)
      if (!chunk) return say('could not read it')
      const p = new TranscriptParser()
      p.push(chunk.text)
      list = p.items
    }
    say((await copyText(transcriptMarkdown(list, mirror ? 'Claude' : who))) ? 'copied' : 'copy failed')
  }

  if (!el.agentId && !mirror) {
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
        <span className="tx__count">{flash ?? `${msgCount} msgs`}</span>
        {cost && summary?.tokens && (
          <span className="tx__cost" title={costTitle(summary.tokens, cost)}>
            {cost.unpriced.length && !cost.usd ? '—' : '≈' + fmtUsd(cost.usd)}
          </span>
        )}
        {!!summary?.fileCount && (
          <button
            className={`tx__chip${pop === 'files' ? ' tx__chip--on' : ''}`}
            title="Files this session changed"
            onClick={() => setPop((p) => (p === 'files' ? null : 'files'))}
          >
            ✎ {summary.fileCount}
          </button>
        )}
        <span className="tx__nav">
          <button className="tx__btn tx__btn--half" title="Previous prompt (⌥↑)" onClick={() => jumpPrompt(-1)}>
            <Chevron up />
          </button>
          <button className="tx__btn tx__btn--half" title="Next prompt (⌥↓)" onClick={() => jumpPrompt(1)}>
            <Chevron />
          </button>
        </span>
        <button
          className={`tx__btn${autoscroll ? ' tx__btn--on' : ''}`}
          title="Stick to newest"
          onClick={() => setAutoscroll((a) => !a)}
        >
          ↓
        </button>
        <button
          className={`tx__btn${pop === 'menu' ? ' tx__btn--on' : ''}`}
          title="Copy, reload"
          onClick={() => setPop((p) => (p === 'menu' ? null : 'menu'))}
        >
          ⋯
        </button>
      </div>
      {pop === 'files' && (
        <FilesPop el={el} cwd={cwd} sessionId={sessionId} count={summary?.fileCount ?? 0} onClose={closePop} />
      )}
      {pop === 'menu' && (
        <Pop onClose={closePop} className="tx__pop--menu">
          <button className="tx__pop-item" onClick={() => (setPop(null), void copyLastReply())}>
            Copy last reply
          </button>
          <button className="tx__pop-item" onClick={() => (setPop(null), void copyChat(false))}>
            {truncated ? 'Copy loaded chat as Markdown' : 'Copy chat as Markdown'}
          </button>
          {truncated && (
            <button className="tx__pop-item" onClick={() => (setPop(null), void copyChat(true))}>
              Copy whole chat as Markdown <span className="tx__pop-note">reads the full file</span>
            </button>
          )}
          <button className="tx__pop-item" onClick={() => (setPop(null), void reload())}>
            <IconReload /> Reload
          </button>
        </Pop>
      )}

      <div
        className="tx__scroll"
        ref={scrollRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
          e.preventDefault()
          e.stopPropagation()
          jumpPrompt(e.key === 'ArrowUp' ? -1 : 1)
        }}
        onScroll={(e) => {
          const n = e.currentTarget
          const atBottom = n.scrollHeight - n.scrollTop - n.clientHeight < 40
          setAutoscroll(atBottom)
        }}
      >
        {offline && mirror ? (
          <div className="tx__hint">
            transcript not found — the desktop session may have been deleted, or its folder
            moved
          </div>
        ) : offline ? (
          <div className="tx__hint">
            backend offline, or no transcript yet — run <code>npm run server</code> or use the
            desktop app
          </div>
        ) : filtered.length === 0 && !truncated ? (
          <div className="tx__hint">{q ? 'no matching messages' : 'no messages yet'}</div>
        ) : (
          <>
          {truncated && (
            <div className="tx__hint">earlier messages not loaded — this transcript is very large</div>
          )}
          <TxPath.Provider value={path}>
            <ItemList items={filteredItems} keys={filteredKeys} who={who} />
          </TxPath.Provider>
          </>
        )}
      </div>
      {!autoscroll && items.length > 0 && (
        <button className="tx__jump" title="Jump to the newest message" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
    </div>
  )
}

/** A small panel under the bar that closes on a click elsewhere. */
function Pop({ onClose, className, children }: { onClose: () => void; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // a frame late, so the click that opened it doesn't close it
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true))
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', down, true)
    }
  }, [onClose])
  return (
    <div ref={ref} className={`tx__pop${className ? ' ' + className : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

/** The files a session changed; a click opens one beside the transcript. */
function FilesPop({
  el,
  cwd,
  sessionId,
  count,
  onClose,
}: {
  el: WidgetElement
  cwd: string | undefined
  sessionId: string | undefined
  count: number
  onClose: () => void
}) {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  // re-read when the session changes another file while this is open
  useEffect(() => {
    let alive = true
    void readTranscriptFiles(cwd, sessionId).then((f) => alive && setFiles(f ?? []))
    return () => {
      alive = false
    }
  }, [cwd, sessionId, count])
  const spawnWidget = useStore((s) => s.spawnWidget)
  const open = (path: string) => {
    onClose()
    const at = livePlace(el)
    spawnWidget(widgetKindForFile(path), at.x + at.w + 340, at.y + 220, { path, cwd, title: baseName(path) })
  }
  const openGit = () => {
    onClose()
    const at = livePlace(el)
    spawnWidget('diff', at.x + at.w + 340, at.y + 220, { path: cwd, cwd })
  }
  return (
    <Pop onClose={onClose} className="tx__pop--files">
      <div className="tx__pop-head">
        <span>{count === 1 ? '1 file changed' : `${count} files changed`}</span>
        {cwd && (
          <button className="tx__pop-link" title={`git panel for ${cwd}`} onClick={openGit}>
            Open git panel
          </button>
        )}
      </div>
      <div className="tx__pop-list">
        {files == null ? (
          <div className="tx__sub-hint">loading…</div>
        ) : (
          files.map((f) => {
            const rel = shortPath(f.path, cwd)
            const cut = rel.lastIndexOf('/')
            return (
              <button key={f.path} className="tx__file" title={`${f.path}\n${f.edits}× · last: ${f.tool}`} onClick={() => open(f.path)}>
                <span className="tx__file-name">{rel.slice(cut + 1)}</span>
                {cut > 0 && <span className="tx__file-dir">{'\u200e' + rel.slice(0, cut) + '\u200e'}</span>}
                {f.edits > 1 && <span className="tx__file-n">×{f.edits}</span>}
              </button>
            )
          })
        )}
      </div>
    </Pop>
  )
}

const Chevron = ({ up }: { up?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path
      d={up ? 'M2 6.5 5 3.5 8 6.5' : 'M2 3.5 5 6.5 8 3.5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
