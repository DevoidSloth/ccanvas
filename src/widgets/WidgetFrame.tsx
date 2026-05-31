import { useEffect, useRef, useState } from 'react'
import type { WidgetElement, WidgetKind } from '../lib/types'
import { WIDGET_ACCENT } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { elementBounds, edgeLines, snapValue } from '../lib/geometry'
import {
  IconClose,
  IconNote,
  IconTerminal,
  IconWeb,
  IconAgent,
  IconFiles,
  IconDiff,
  IconEditor,
  IconDoc,
  IconLog,
  IconLock,
  IconSettings,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
} from '../ui/icons'
import { useAgents, sendTo, isLive as isSessionLive, type AgentMetrics } from '../lib/agents'
import { NoteBody } from './NoteBody'
import { WebBody } from './WebBody'
import { TerminalBody } from './TerminalBody'
import { FilesBody } from './FilesBody'
import { DiffBody } from './DiffBody'
import { EditorBody } from './EditorBody'
import { DocBody } from './DocBody'
import { LogBody } from './LogBody'
import { PrBody } from './PrBody'
import { IssuesBody } from './IssuesBody'
import { RunsBody } from './RunsBody'
import { RunnerBody } from './RunnerBody'

const KIND_ICON: Record<WidgetKind, (p: { className?: string; size?: number }) => JSX.Element> = {
  terminal: IconTerminal,
  agent: IconAgent,
  web: IconWeb,
  note: IconNote,
  files: IconFiles,
  diff: IconDiff,
  editor: IconEditor,
  doc: IconDoc,
  log: IconLog,
  pr: IconPr,
  issues: IconIssue,
  runs: IconChecks,
  runner: IconRun,
}

const MIN_W = 220
const MIN_H = 150

export function WidgetFrame({
  el,
  selected,
  onStartMove,
  visible = true,
}: {
  el: WidgetElement
  selected: boolean
  onStartMove: (e: React.PointerEvent, id: string) => void
  /** is this widget's tab currently shown? */
  visible?: boolean
}) {
  const tool = useStore((s) => s.tool)
  const activeWidgetId = useStore((s) => s.activeWidgetId)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)
  const removeElements = useStore((s) => s.removeElements)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const openAgentWizard = useStore((s) => s.openAgentWizard)

  const active = activeWidgetId === el.id
  const Icon = KIND_ICON[el.kind]
  const accent = el.color ?? WIDGET_ACCENT[el.kind]
  // terminals/agents are live — interact on a single click, drag by the title bar
  const isTerminal = el.kind === 'terminal' || el.kind === 'agent'
  // app-like panels also interact on a single click (no double-click shield)
  const isLive =
    isTerminal ||
    el.kind === 'files' ||
    el.kind === 'diff' ||
    el.kind === 'editor' ||
    el.kind === 'doc' ||
    el.kind === 'log' ||
    el.kind === 'pr' ||
    el.kind === 'issues' ||
    el.kind === 'runs' ||
    el.kind === 'runner'
  // notes are also single-click, but manage their own pointer handling
  // (toggle a checkbox vs. enter edit) so they don't use the generic capture
  const isNote = el.kind === 'note'
  const folder = el.cwd
    ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    : null

  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(el.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => setName(el.title), [el.title])
  useEffect(() => {
    if (renaming) {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [renaming])

  const select = () => {
    setSelection([el.id])
    bringToFront([el.id])
  }

  const grab = (e: React.PointerEvent) => {
    e.stopPropagation()
    select()
    onStartMove(e, el.id)
  }

  // only widgets that aren't live or self-managed (i.e. web) keep the shield
  const shielded = !isLive && !isNote && (!active || tool !== 'select')

  // live bodies: a single click selects + focuses the widget and keeps the
  // event from reaching the canvas (which would deselect / start a marquee)
  const onLiveBodyCapture = () => {
    if (tool !== 'select') return
    select()
    setActiveWidget(el.id)
  }
  const onLiveBodyDown = (e: React.PointerEvent) => {
    if (tool === 'select') e.stopPropagation()
  }

  // drop a file (dragged from a file-tree widget) onto an agent/terminal to
  // inject it as an @-mention context reference
  const onBodyDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-ccanvas-file')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onBodyDrop = (e: React.DragEvent) => {
    const path = e.dataTransfer.getData('application/x-ccanvas-file')
    if (!path) return
    e.preventDefault()
    e.stopPropagation()
    const base = el.cwd ? el.cwd.replace(/[\\/]+$/, '') : ''
    let rel = base && path.startsWith(base) ? path.slice(base.length + 1) : path
    rel = rel.replace(/\\/g, '/')
    sendTo(el.id, `@${rel} `)
    select()
    setActiveWidget(el.id)
  }

  const commitName = () => {
    const t = name.trim() || el.title
    if (t !== el.title) {
      beginHistory()
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).title = t
      })
      // tell a live claude agent its new name
      if (el.kind === 'agent' && isSessionLive(el.id)) sendTo(el.id, `/rename ${t}\r`)
    }
    setRenaming(false)
  }

  // ---- resize (bottom-right grip) ----
  const resizeRef = useRef<{
    px: number
    py: number
    w: number
    h: number
    zoom: number
  } | null>(null)

  const onResizeDown = (e: React.PointerEvent) => {
    if (el.locked) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    select()
    beginHistory()
    const zoom = selectActive(useStore.getState()).camera.zoom
    resizeRef.current = { px: e.clientX, py: e.clientY, w: el.w, h: el.h, zoom }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const dw = (e.clientX - r.px) / r.zoom
    const dh = (e.clientY - r.py) / r.zoom
    let w = Math.max(MIN_W, r.w + dw)
    let h = Math.max(MIN_H, r.h + dh)
    // snap the dragged right/bottom edges to other elements' edges/centers
    const st = useStore.getState()
    const others = selectActive(st)
      .elements.filter((o) => o.id !== el.id)
      .map(elementBounds)
    const { xs, ys } = edgeLines(others)
    const tol = 6 / r.zoom
    const sx = snapValue(el.x + w, xs, tol)
    const sy = snapValue(el.y + h, ys, tol)
    if (sx != null) w = Math.max(MIN_W, sx - el.x)
    if (sy != null) h = Math.max(MIN_H, sy - el.y)
    st.setSnapGuides({ vx: sx, hy: sy })
    mutateElement(el.id, (wd) => {
      const ww = wd as WidgetElement
      ww.w = w
      ww.h = h
    })
  }
  const onResizeUp = (e: React.PointerEvent) => {
    resizeRef.current = null
    useStore.getState().setSnapGuides(null)
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={`widget${selected ? ' widget--selected' : ''}${
        active ? ' widget--active' : ''
      }`}
      style={
        {
          left: el.x,
          top: el.y,
          width: el.w,
          height: el.h,
          '--k': accent,
        } as React.CSSProperties
      }
    >
      <div className="widget__bar" onPointerDown={grab}>
        <span className="widget__icon">
          <Icon />
        </span>
        {isTerminal && <AgentDot id={el.id} />}
        {renaming ? (
          <input
            ref={titleRef}
            className="widget__title"
            style={{ background: 'transparent', border: 'none' }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') {
                setName(el.title)
                setRenaming(false)
              }
            }}
          />
        ) : (
          <span
            className="widget__title"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenaming(true)
            }}
          >
            {el.title}
          </span>
        )}
        {!renaming && folder && (
          <span className="widget__cwd" title={el.cwd}>
            {folder}
          </span>
        )}
        {el.kind === 'agent' && <AgentMeter id={el.id} />}
        <span className="widget__bar-spacer" />
        <div className="widget__actions">
          {el.kind === 'agent' && (
            <button
              className="widget__btn"
              title="Agent settings"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() =>
                openAgentWizard({ x: el.x + el.w / 2, y: el.y + el.h / 2, editId: el.id })
              }
            >
              <IconSettings />
            </button>
          )}
          <button
            className={`widget__btn${el.locked ? ' widget__btn--on' : ''}`}
            title={el.locked ? 'Unlock' : 'Lock position'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              beginHistory()
              mutateElement(el.id, (w) => {
                w.locked = !w.locked
              })
            }}
          >
            <IconLock />
          </button>
          <button
            className="widget__btn widget__btn--danger"
            title="Close widget"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              beginHistory()
              removeElements([el.id])
            }}
          >
            <IconClose />
          </button>
        </div>
      </div>

      <div
        className="widget__body"
        style={
          isLive || isNote
            ? { pointerEvents: tool === 'select' ? 'auto' : 'none' }
            : undefined
        }
        onPointerDownCapture={isLive ? onLiveBodyCapture : undefined}
        onPointerDown={isLive ? onLiveBodyDown : undefined}
        onDragOver={isTerminal ? onBodyDragOver : undefined}
        onDrop={isTerminal ? onBodyDrop : undefined}
      >
        {el.kind === 'note' && <NoteBody el={el} active={active} />}
        {el.kind === 'web' && <WebBody el={el} active={active} />}
        {isTerminal && <TerminalBody el={el} active={active} visible={visible} />}
        {el.kind === 'files' && <FilesBody el={el} />}
        {el.kind === 'diff' && <DiffBody el={el} />}
        {el.kind === 'editor' && <EditorBody el={el} active={active} />}
        {el.kind === 'doc' && <DocBody el={el} />}
        {el.kind === 'log' && <LogBody el={el} />}
        {el.kind === 'pr' && <PrBody el={el} />}
        {el.kind === 'issues' && <IssuesBody el={el} />}
        {el.kind === 'runs' && <RunsBody el={el} />}
        {el.kind === 'runner' && <RunnerBody el={el} />}

        {shielded && (
          <div
            className="widget__shield"
            onPointerDown={grab}
            onDoubleClick={(e) => {
              e.stopPropagation()
              select()
              setActiveWidget(el.id)
            }}
          >
            <span className="widget__shield-hint">double-click to interact</span>
          </div>
        )}
      </div>

      {!el.locked && (
        <div
          className="widget__resize"
          title="Resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      )}
    </div>
  )
}

// Activity dot for terminal/agent widgets: reflects whether the session is
// idle, streaming output, or appears to be waiting on a prompt.
function AgentDot({ id }: { id: string }) {
  const status = useAgents((s) => s.status[id])
  if (!status || status === 'off') return null
  const title =
    status === 'working'
      ? 'working…'
      : status === 'waiting'
        ? 'waiting for input'
        : status === 'connecting'
          ? 'connecting…'
          : 'idle'
  return <span className={`agent-dot agent-dot--${status}`} title={title} />
}

// Compact activity meter: turns · active time · scraped cost (run /cost to fill).
function fmtMeter(m: AgentMetrics): string {
  const time =
    m.activeMs >= 60000
      ? `${Math.round(m.activeMs / 60000)}m`
      : `${Math.round(m.activeMs / 1000)}s`
  const parts = [`${m.turns}t`, time]
  if (m.costUsd != null) parts.push(`$${m.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}
function AgentMeter({ id }: { id: string }) {
  const m = useAgents((s) => s.metrics[id])
  if (!m || (m.turns === 0 && m.costUsd == null)) return null
  return (
    <span className="widget__meter" title="turns · active time · cost (run /cost)">
      {fmtMeter(m)}
    </span>
  )
}
