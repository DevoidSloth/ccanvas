import { useEffect, useRef, useState } from 'react'
import type { WidgetElement, WidgetKind } from '../lib/types'
import { WIDGET_ACCENT, AGENT_COLORS, claudeColorName } from '../lib/types'
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
  IconTag,
  IconSettings,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
  IconDatabase,
  IconData,
  IconPlot,
  IconChat,
  IconVideo,
  IconClaude,
  IconInfo,
} from '../ui/icons'
import { useAgents, useDisplayStatus, sendTo, sendPrompt, isLive as isSessionLive, type AgentMetrics } from '../lib/agents'
import { useAgentContext } from '../lib/context'
import { useSyncSessionTitle } from '../lib/sessionTitle'
import { FAR_ZOOM, focusWidget, passesLabelFilter } from '../lib/view'
import { NoteBody } from './NoteBody'
import { WebBody } from './WebBody'
import { TerminalBody } from './TerminalBody'
import { FilesBody } from './FilesBody'
import { DiffBody } from './DiffBody'
import { EditorBody } from './EditorBody'
import { VsCodeBody } from './VsCodeBody'
import { DocBody } from './DocBody'
import { LogBody } from './LogBody'
import { PrBody } from './PrBody'
import { IssuesBody } from './IssuesBody'
import { RunsBody } from './RunsBody'
import { RunnerBody } from './RunnerBody'
import { SqlBody } from './SqlBody'
import { DataBody } from './DataBody'
import { PlotBody } from './PlotBody'
import { TranscriptBody } from './TranscriptBody'
import { VideoBody } from './VideoBody'
import { MediaInfoBody } from './MediaInfoBody'
import { ClaudeBody } from './ClaudeBody'
import { WidgetErrorBoundary } from '../ui/WidgetErrorBoundary'

const KIND_ICON: Record<WidgetKind, (p: { className?: string; size?: number }) => JSX.Element> = {
  terminal: IconTerminal,
  agent: IconAgent,
  web: IconWeb,
  note: IconNote,
  files: IconFiles,
  diff: IconDiff,
  editor: IconEditor,
  vscode: IconEditor,
  doc: IconDoc,
  log: IconLog,
  pr: IconPr,
  issues: IconIssue,
  runs: IconChecks,
  runner: IconRun,
  sql: IconDatabase,
  data: IconData,
  plot: IconPlot,
  transcript: IconChat,
  video: IconVideo,
  mediainfo: IconInfo,
  claude: IconClaude,
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

  const setLabelingWidget = useStore((s) => s.setLabelingWidget)
  const labeling = useStore((s) => s.labelingWidgetId === el.id)
  // zoomed far out, terminals swap their unreadable text for a summary card
  const far = useStore((s) => selectActive(s).camera.zoom < FAR_ZOOM)
  const dimmed = useStore((s) => !passesLabelFilter(el, s.labelFilter))
  useSyncSessionTitle(el)

  const active = activeWidgetId === el.id
  const Icon = KIND_ICON[el.kind]
  // untagged terminals/agents follow the palette's accent
  const accent =
    el.color ?? (el.kind === 'terminal' || el.kind === 'agent' ? 'var(--accent)' : WIDGET_ACCENT[el.kind])
  // terminals/agents are live — interact on a single click, drag by the title bar
  const isTerminal = el.kind === 'terminal' || el.kind === 'agent'
  // a user-chosen colour tints the whole faceplate so it reads when zoomed out
  const tagged = isTerminal && !!el.color
  // app-like panels also interact on a single click (no double-click shield)
  const isLive =
    isTerminal ||
    el.kind === 'files' ||
    el.kind === 'diff' ||
    el.kind === 'editor' ||
    el.kind === 'vscode' ||
    el.kind === 'doc' ||
    el.kind === 'log' ||
    el.kind === 'pr' ||
    el.kind === 'issues' ||
    el.kind === 'runs' ||
    el.kind === 'runner' ||
    el.kind === 'sql' ||
    el.kind === 'data' ||
    el.kind === 'plot' ||
    el.kind === 'transcript' ||
    el.kind === 'claude' ||
    el.kind === 'video' ||
    el.kind === 'mediainfo'
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

  // Start a move. If this widget is already part of a (multi) selection, keep
  // that selection so everything drags together; shift toggles membership;
  // otherwise select just this one. Mirrors the canvas vector-drag behaviour.
  const grab = (e: React.PointerEvent) => {
    e.stopPropagation()
    const cur = useStore.getState().selection
    if (e.shiftKey) {
      setSelection(cur.includes(el.id) ? cur.filter((x) => x !== el.id) : [...cur, el.id])
    } else if (!cur.includes(el.id)) {
      setSelection([el.id])
    }
    bringToFront([el.id])
    // grabbing another widget's title bar counts as clicking out of a terminal
    if (useStore.getState().activeWidgetId !== el.id) setActiveWidget(null)
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

  // Terminals you haven't clicked into don't take the pointer: dragging across
  // one moves the canvas, and a click (no drag) enters it. Once entered it gets
  // every event — text selection, scrollback, typing — until you click
  // somewhere else (the canvas, another widget, another terminal).
  const onTerminalBodyCapture = (e: React.PointerEvent) => {
    if (tool !== 'select') return
    if (active || e.button !== 0) return onLiveBodyCapture()
    // keep xterm from seeing this press (preventDefault also suppresses the
    // compatibility mousedown/move/up it selects with)
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY }
    const cam0 = selectActive(useStore.getState()).camera
    let panning = false
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!panning && Math.hypot(dx, dy) < 4) return
      panning = true
      document.body.classList.add('is-panning')
      useStore.getState().setCamera({ ...cam0, x: cam0.x + dx, y: cam0.y + dy })
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('is-panning')
      if (panning || ev.type !== 'pointerup') return
      // from far out, a click flies in to the terminal instead of typing blind
      if (selectActive(useStore.getState()).camera.zoom < FAR_ZOOM) focusWidget(el.id)
      else onLiveBodyCapture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  // belt-and-braces for engines that still fire mousedown after a prevented
  // pointerdown: an inactive terminal must not start a text selection
  const onTerminalMouseCapture = (e: React.MouseEvent) => {
    if (tool === 'select' && !active && e.button === 0) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // drop onto an agent/terminal to feed it context: a file (dragged from a
  // file-tree or diff widget) becomes an @-mention; a prompt (from the prompt
  // library) is pasted in as text. Both ride the same native DnD channel.
  const onBodyDragOver = (e: React.DragEvent) => {
    const t = e.dataTransfer.types
    if (
      t.includes('application/x-ccanvas-file') ||
      t.includes('application/x-ccanvas-prompt')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onBodyDrop = (e: React.DragEvent) => {
    const path = e.dataTransfer.getData('application/x-ccanvas-file')
    const prompt = e.dataTransfer.getData('application/x-ccanvas-prompt')
    if (!path && !prompt) return
    e.preventDefault()
    e.stopPropagation()
    if (path) {
      const base = el.cwd ? el.cwd.replace(/[\\/]+$/, '') : ''
      let rel = base && path.startsWith(base) ? path.slice(base.length + 1) : path
      rel = rel.replace(/\\/g, '/')
      sendTo(el.id, `@${rel} `)
    } else {
      // paste the snippet without auto-submitting, so it can be reviewed/edited
      sendPrompt(el.id, prompt, false)
    }
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
      }${tagged ? ' widget--tagged' : ''}${isTerminal ? ' widget--term' : ''}${
        dimmed ? ' widget--dimmed' : ''
      }`}
      data-widget-id={el.id}
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
        {el.kind === 'agent' && <ContextMeter el={el} />}
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
          {isTerminal && (
            <button
              className={`widget__btn${labeling ? ' widget__btn--on' : ''}`}
              title="Label"
              data-label-toggle
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setLabelingWidget(labeling ? null : el.id)}
            >
              <IconTag />
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
      {labeling && <LabelPopover el={el} onClose={() => setLabelingWidget(null)} />}

      <div
        className="widget__body"
        style={
          isLive || isNote
            ? { pointerEvents: tool === 'select' ? 'auto' : 'none' }
            : undefined
        }
        onPointerDownCapture={
          isTerminal ? onTerminalBodyCapture : isLive ? onLiveBodyCapture : undefined
        }
        onMouseDownCapture={isTerminal ? onTerminalMouseCapture : undefined}
        onPointerDown={isLive ? onLiveBodyDown : undefined}
        data-drop-term={isTerminal ? '' : undefined}
        onDragOver={isTerminal ? onBodyDragOver : undefined}
        onDrop={isTerminal ? onBodyDrop : undefined}
      >
        <WidgetErrorBoundary>
          {el.kind === 'note' && <NoteBody el={el} active={active} />}
          {el.kind === 'web' && <WebBody el={el} active={active} />}
          {el.kind === 'video' && <VideoBody el={el} active={active} />}
          {el.kind === 'mediainfo' && <MediaInfoBody el={el} />}
          {el.kind === 'claude' && <ClaudeBody el={el} />}
          {isTerminal && <TerminalBody el={el} active={active} visible={visible} />}
          {isTerminal && far && visible && <TermCard el={el} />}
          {el.kind === 'files' && <FilesBody el={el} />}
          {el.kind === 'diff' && <DiffBody el={el} />}
          {el.kind === 'editor' && <EditorBody el={el} active={active} />}
          {el.kind === 'vscode' && <VsCodeBody el={el} active={active} />}
          {el.kind === 'doc' && <DocBody el={el} />}
          {el.kind === 'log' && <LogBody el={el} />}
          {el.kind === 'pr' && <PrBody el={el} />}
          {el.kind === 'issues' && <IssuesBody el={el} />}
          {el.kind === 'runs' && <RunsBody el={el} />}
          {el.kind === 'runner' && <RunnerBody el={el} />}
          {el.kind === 'sql' && <SqlBody el={el} active={active} />}
          {el.kind === 'data' && <DataBody el={el} />}
          {el.kind === 'plot' && <PlotBody el={el} />}
          {el.kind === 'transcript' && <TranscriptBody el={el} />}
        </WidgetErrorBoundary>

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
// Label popover: name + colour tag for a terminal/agent. Colour applies live;
// the name commits on Enter / click-away and reverts on Escape. A live claude
// agent is told its new name and colour, same as the agent wizard does.
function LabelPopover({ el, onClose }: { el: WidgetElement; onClose: () => void }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const [name, setName] = useState(el.title)
  const startColor = useRef(el.color)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const isAgent = el.kind === 'agent'

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // one undo step for the whole edit, taken only once something changes
  const dirty = useRef(false)
  const edit = (fn: (w: WidgetElement) => void) => {
    if (!dirty.current) beginHistory()
    dirty.current = true
    mutateElement(el.id, (w) => fn(w as WidgetElement))
  }
  const setColor = (hex: string | undefined) =>
    edit((w) => {
      w.color = hex
    })

  const commit = () => {
    const t = name.trim() || el.title
    if (t !== el.title)
      edit((w) => {
        w.title = t
      })
    if (isAgent && isSessionLive(el.id)) {
      if (t !== el.title) sendTo(el.id, `/rename ${t}\r`)
      if (el.color !== startColor.current) sendTo(el.id, `/color ${claudeColorName(el.color)}\r`)
    }
    onClose()
  }
  const cancel = () => {
    if (el.color !== startColor.current) setColor(startColor.current)
    onClose()
  }

  // click-away commits (the tag button toggles the popover itself)
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (boxRef.current?.contains(t) || t.closest?.('[data-label-toggle]')) return
      commitRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  return (
    <div
      ref={boxRef}
      className="label-pop"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') cancel()
      }}
    >
      <input
        ref={inputRef}
        className="label-pop__input"
        value={name}
        placeholder="Label"
        onChange={(e) => setName(e.target.value)}
      />
      <div className="label-pop__swatches">
        {!isAgent && (
          <button
            className={`label-pop__swatch label-pop__swatch--none${
              !el.color ? ' label-pop__swatch--on' : ''
            }`}
            title="No colour"
            onClick={() => setColor(undefined)}
          />
        )}
        {AGENT_COLORS.map((c) => (
          <button
            key={c.name}
            className={`label-pop__swatch${
              el.color?.toLowerCase() === c.hex.toLowerCase() ? ' label-pop__swatch--on' : ''
            }`}
            style={{ background: c.hex }}
            title={c.name}
            onClick={() => setColor(c.hex)}
          />
        ))}
      </div>
    </div>
  )
}

// Zoomed-out summary of a terminal/agent: name, colour, status, context use and
// the latest line of output, sized in screen pixels (via the world's --z) so it
// stays readable however far out you are. Sits over the live terminal, which
// keeps running underneath.
const STATUS_LABEL: Record<string, string> = {
  working: 'working',
  waiting: 'needs input',
  idle: 'idle',
  done: 'just finished',
  connecting: 'connecting',
  off: 'offline',
}
function TermCard({ el }: { el: WidgetElement }) {
  const status = useDisplayStatus(el.id) ?? 'off'
  const lastLine = useAgents((s) => s.lastLine[el.id])
  const folder = el.cwd ? el.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null
  return (
    <div className={`term-card term-card--${status}`}>
      <div className="term-card__name">{el.title}</div>
      <div className="term-card__meta">
        <span className="term-card__status">
          <span className="term-card__dot" />
          {STATUS_LABEL[status] ?? status}
        </span>
        {el.kind === 'agent' && <CardContext el={el} />}
        {folder && <span className="term-card__folder">{folder}</span>}
      </div>
      {lastLine && <div className="term-card__line">{lastLine}</div>}
    </div>
  )
}
function CardContext({ el }: { el: WidgetElement }) {
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  if (!ctx) return null
  const pct = Math.round(ctx.pct)
  return (
    <span className={`term-card__ctx${pct >= 85 ? ' term-card__ctx--hot' : ''}`}>
      {pct}% context
    </span>
  )
}

function AgentDot({ id }: { id: string }) {
  const status = useDisplayStatus(id)
  if (!status || status === 'off') return null
  const title =
    status === 'working'
      ? 'working…'
      : status === 'waiting'
        ? 'waiting for input'
        : status === 'connecting'
          ? 'connecting…'
          : status === 'done'
            ? 'just finished'
            : 'idle'
  return <span className={`agent-dot agent-dot--${status}`} title={title} />
}

// Context meter: a short fill bar + % of the context window, with a one-click
// /compact once the conversation is getting full.
const COMPACT_AT = 70
function fmtK(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}
function ContextMeter({ el }: { el: WidgetElement }) {
  const ctx = useAgentContext(el.cwd, el.sessionId, el.model)
  if (!ctx) return null
  const pct = Math.round(ctx.pct)
  const level = pct >= 85 ? 'hot' : pct >= COMPACT_AT ? 'warm' : 'ok'
  return (
    <span
      className={`ctx ctx--${level}`}
      title={`Context: ${fmtK(ctx.used)} of ${fmtK(ctx.window)} tokens (${pct}%)`}
    >
      <span className="ctx__bar">
        <span className="ctx__fill" style={{ width: `${ctx.pct}%` }} />
      </span>
      <span className="ctx__pct">{pct}%</span>
      {pct >= COMPACT_AT && (
        <button
          className="ctx__compact"
          title="Summarize the conversation to free up context (/compact)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            sendPrompt(el.id, '/compact')
          }}
        >
          compact
        </button>
      )}
    </span>
  )
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
