import { useEffect, useMemo, useState } from 'react'
import { viewCenter, revealLayerOf } from '../lib/view'
import { useStore, selectActive } from '../store/workspace'
import { useAgents, useDisplayStatus, sendPrompt } from '../lib/agents'
import { watchTranscriptSummary, type TranscriptSummary } from '../lib/transcript'
import { useAgentContext } from '../lib/context'
import { isDesktopMirror, mirrorWaiting, openInClaude } from '../lib/desktopSessions'
import { waitingTitle } from '../widgets/MirrorStatus'
import type { WidgetElement, Workspace } from '../lib/types'
import { IconClose, IconBroadcast, IconAgent } from './icons'
import { StatusGlyph, StatusIcon } from '../widgets/widgetIcons'
import '../styles/agent-tools.css'


type Row = { agent: WidgetElement; tab: Workspace }

/** One readable line of a reply: first non-empty line, markdown markers dropped. */
function firstLine(reply: string | null | undefined): string | undefined {
  return reply
    ?.split('\n')
    .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
    .find(Boolean)
    ?.slice(0, 160)
}

/** A desktop-app mirror: read-only, so its status comes from its transcript
 *  rather than a live terminal. The status itself is the one the mirror widget
 *  publishes (useMirrorStatusSync), so it matches its icon everywhere else; the
 *  summary here adds what it's waiting on and its last reply. */
function MirrorRow({ row, onFocus }: { row: Row; onFocus: () => void }) {
  const { agent: el, tab } = row
  const activeTabId = useStore((s) => s.activeTabId)
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
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  // re-check while a tool call is open: the transcript is quiet while it waits
  const open = !!summary?.pending
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [open])
  const waiting = mirrorWaiting(summary, now)
  const st = useDisplayStatus(el.id) ?? 'off'
  const last = waiting?.kind === 'ask' ? waiting.question : firstLine(summary?.lastReply)
  return (
    <div className="roster__row" onClick={onFocus}>
      <StatusGlyph
        status={st}
        icon={<IconAgent />}
        title={
          waiting
            ? waitingTitle(waiting)
            : st === 'working'
              ? 'running now'
              : st === 'done'
                ? 'just finished'
                : st === 'idle'
                  ? 'idle'
                  : 'no transcript'
        }
      />
      <div className="roster__main">
        <div className="roster__top">
          <span className="roster__name">{el.title}</span>
          <span className="dsk-badge">Desktop</span>
          {waiting && (
            <button
              className={`dsk-wait dsk-wait--${waiting.kind}`}
              title={waitingTitle(waiting)}
              onClick={(e) => {
                e.stopPropagation()
                openInClaude(el)
              }}
            >
              {waiting.kind === 'ask' ? 'Needs you' : `${waiting.tool}?`}
            </button>
          )}
          {tab.id !== activeTabId && <span className="roster__tab">{tab.name}</span>}
          {ctx && (
            <span className="roster__meter" title="context window fill">
              {Math.round(ctx.pct)}%
            </span>
          )}
        </div>
        {last && <div className="roster__last">{last}</div>}
      </div>
    </div>
  )
}

/** Each agent's latest reply, read from its session transcript. The terminal
 *  tail is full of TUI chrome (spinners, hints, box drawing), so it isn't used. */
function useLastMessages(rows: Row[]): Record<string, string> {
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const key = rows.map((r) => `${r.agent.id}:${r.agent.cwd}:${r.agent.sessionId}`).join('|')
  useEffect(() => {
    const offs = rows.map(({ agent }) =>
      watchTranscriptSummary(agent.cwd, agent.sessionId, (summary) => {
        const line = firstLine(summary?.lastReply)
        setMsgs((m) => {
          if (m[agent.id] === line) return m
          const next = { ...m }
          if (line) next[agent.id] = line
          else delete next[agent.id]
          return next
        })
      }),
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return msgs
}

// Mission-control list of every agent across all tabs: status, cost/turns, last
// line, click-to-focus, and a composer that sends to one agent or broadcasts to
// all. The spatial canvas is great for layout but poor at "is anything stuck?" —
// this is the at-scale answer.
function RosterDot({ id }: { id: string }) {
  return <StatusIcon id={id} kind="agent" />
}

export function Roster() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const switchTab = useStore((s) => s.switchTab)
  const setCamera = useStore((s) => s.setCamera)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const setOpenPanel = useStore((s) => s.setOpenPanel)

  const metrics = useAgents((s) => s.metrics)

  const [text, setText] = useState('')
  const [target, setTarget] = useState<string | null>(null) // agent id, or null = all

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const tab of tabs)
      for (const e of tab.elements)
        if (e.type === 'widget' && e.kind === 'agent') out.push({ agent: e, tab })
    return out
  }, [tabs])
  // desktop-app mirrors: listed, but never message targets (they're read-only)
  const mirrors = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const tab of tabs) for (const e of tab.elements) if (isDesktopMirror(e)) out.push({ agent: e, tab })
    return out
  }, [tabs])
  const lastMessage = useLastMessages(rows)

  const focus = (row: Row, asTarget = true) => {
    if (activeTabId !== row.tab.id) switchTab(row.tab.id)
    // an agent on another layer: switch there first, then frame it in that view
    revealLayerOf(row.agent.id)
    const cam = selectActive(useStore.getState()).camera
    const cx = row.agent.x + row.agent.w / 2
    const cy = row.agent.y + row.agent.h / 2
    setCamera({
      zoom: cam.zoom,
      x: viewCenter().x - cx * cam.zoom,
      y: viewCenter().y - cy * cam.zoom,
    })
    setSelection([row.agent.id])
    setActiveWidget(row.agent.id)
    bringToFront([row.agent.id])
    if (asTarget) setTarget(row.agent.id)
  }

  const send = () => {
    const body = text.trim()
    if (!body) return
    const ids = target ? [target] : rows.map((r) => r.agent.id)
    let delivered = 0
    for (const id of ids) if (sendPrompt(id, body)) delivered++
    if (delivered) setText('')
  }

  const targetLabel =
    target && rows.find((r) => r.agent.id === target)
      ? rows.find((r) => r.agent.id === target)!.agent.title
      : 'all agents'

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Agents</span>
        <span className="panel__badge">{rows.length + mirrors.length}</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body">
        {rows.length === 0 && mirrors.length === 0 && (
          <div className="panel__empty">No agents yet. Start one with ⌘⇧T.</div>
        )}
        {rows.map((row) => {
          const m = metrics[row.agent.id]
          const ll = lastMessage[row.agent.id]
          return (
            <div
              key={row.agent.id}
              className={`roster__row${target === row.agent.id ? ' roster__row--target' : ''}`}
              onClick={() => focus(row)}
            >
              <RosterDot id={row.agent.id} />
              <div className="roster__main">
                <div className="roster__top">
                  <span className="roster__name">{row.agent.title}</span>
                  {row.tab.id !== activeTabId && (
                    <span className="roster__tab">{row.tab.name}</span>
                  )}
                  {m && (m.turns > 0 || m.costUsd != null) && (
                    <span className="roster__meter">
                      {m.turns}t{m.costUsd != null ? ` · $${m.costUsd.toFixed(2)}` : ''}
                    </span>
                  )}
                </div>
                {ll && <div className="roster__last">{ll}</div>}
              </div>
            </div>
          )
        })}
        {mirrors.map((row) => (
          <MirrorRow key={row.agent.id} row={row} onFocus={() => focus(row, false)} />
        ))}
      </div>

      <div className="panel__composer">
        <button
          className="composer__target"
          title="Toggle between the focused agent and broadcasting to all"
          onClick={() => setTarget(null)}
        >
          {target ? '→ ' : <IconBroadcast size={14} />}
          <span className="composer__target-name">{targetLabel}</span>
        </button>
        <textarea
          className="composer__input"
          placeholder={target ? 'Message this agent…' : 'Broadcast to all agents…'}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="composer__send" disabled={!text.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  )
}
