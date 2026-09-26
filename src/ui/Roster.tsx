import { useEffect, useMemo, useState } from 'react'
import { viewCenter } from '../lib/view'
import { useStore } from '../store/workspace'
import { useAgents, useDisplayStatus, sendPrompt } from '../lib/agents'
import { readTranscript, extractLastAssistant } from '../lib/transcript'
import type { WidgetElement, Workspace } from '../lib/types'
import { IconClose, IconBroadcast } from './icons'
import '../styles/agent-tools.css'


type Row = { agent: WidgetElement; tab: Workspace }

const MESSAGE_POLL_MS = 6000

/** Each agent's latest reply, read from its session transcript. The terminal
 *  tail is full of TUI chrome (spinners, hints, box drawing), so it isn't used. */
function useLastMessages(rows: Row[]): Record<string, string> {
  const [msgs, setMsgs] = useState<Record<string, string>>({})
  const key = rows.map((r) => `${r.agent.id}:${r.agent.cwd}:${r.agent.sessionId}`).join('|')
  useEffect(() => {
    let alive = true
    const poll = async () => {
      const next: Record<string, string> = {}
      await Promise.all(
        rows.map(async ({ agent }) => {
          const jsonl = await readTranscript(agent.cwd, agent.sessionId)
          const text = jsonl && extractLastAssistant(jsonl)
          if (!text) return
          // one readable line: first non-empty line, markdown markers dropped
          const line = text
            .split('\n')
            .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
            .find(Boolean)
          if (line) next[agent.id] = line.slice(0, 160)
        }),
      )
      if (alive) setMsgs(next)
    }
    void poll()
    const id = setInterval(poll, MESSAGE_POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return msgs
}

// Mission-control list of every agent across all tabs: status, cost/turns, last
// line, click-to-focus, and a composer that sends to one agent or broadcasts to
// all. The spatial canvas is great for layout but poor at "is anything stuck?" —
// this is the at-scale answer.
function RosterDot({ id }: { id: string }) {
  const st = useDisplayStatus(id) ?? 'off'
  return (
    <span
      className={`agent-dot agent-dot--${st}`}
      title={st === 'done' ? 'just finished' : st}
    />
  )
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
  const lastMessage = useLastMessages(rows)

  const focus = (row: Row) => {
    if (activeTabId !== row.tab.id) switchTab(row.tab.id)
    const cam = row.tab.camera
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
    setTarget(row.agent.id)
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
        <span className="panel__badge">{rows.length}</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body">
        {rows.length === 0 && (
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
