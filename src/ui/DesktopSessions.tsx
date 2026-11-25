import { useEffect, useMemo, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { baseName, isTauri } from '../lib/backend'
import {
  addDesktopMirrors,
  isRunningNow,
  listDesktopSessions,
  mirroredIds,
  type DesktopSession,
} from '../lib/desktopSessions'
import { IconClose, IconReload } from './icons'
import { StatusGlyph } from '../widgets/widgetIcons'
import '../styles/agent-tools.css'

// Picker for the Claude desktop app's Code-tab sessions. Pick some and each
// becomes a read-only mirror (a transcript widget) on the active canvas.

const REFRESH_MS = 5000

function ago(ms: number | null, now: number): string {
  if (ms == null) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** "claude-sonnet-5-5" → "sonnet 5.5" */
function shortModel(m: string | null): string {
  if (!m) return ''
  const r = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m)
  return r ? `${r[1]} ${r[2]}${r[3] ? '.' + r[3] : ''}` : m
}

export function DesktopSessions() {
  const setOpenPanel = useStore((s) => s.setOpenPanel)
  const elements = useStore((s) => selectActive(s).elements)
  const mirrored = useMemo(() => mirroredIds(elements), [elements])

  const [sessions, setSessions] = useState<DesktopSession[] | null>(null)
  const [now, setNow] = useState(Date.now())
  const [q, setQ] = useState('')
  const [hideArchived, setHideArchived] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const refresh = async () => {
    const list = await listDesktopSessions()
    setSessions(list)
    setNow(Date.now())
  }
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(t)
  }, [])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (sessions ?? []).filter(
      (d) =>
        (!hideArchived || !d.isArchived) &&
        (!t ||
          d.title.toLowerCase().includes(t) ||
          d.cwd.toLowerCase().includes(t) ||
          (d.model ?? '').toLowerCase().includes(t)),
    )
  }, [sessions, q, hideArchived])

  const running = useMemo(
    () =>
      (sessions ?? []).filter(
        (d) => isRunningNow(d.transcriptMtime, now) && !mirrored.has(d.cliSessionId),
      ),
    [sessions, now, mirrored],
  )

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addPicked = () => {
    addDesktopMirrors((sessions ?? []).filter((d) => picked.has(d.cliSessionId)))
    setPicked(new Set())
  }

  const pickable = [...picked].filter((id) => !mirrored.has(id)).length

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Desktop sessions</span>
        {sessions && <span className="panel__badge">{shown.length}</span>}
        <span className="panel__spacer" />
        <button className="panel__x" title="Refresh" onClick={() => void refresh()}>
          <IconReload size={14} />
        </button>
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="dsk__bar">
        <input
          className="dsk__filter"
          placeholder="Filter by title, folder, model…"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') setQ('')
          }}
        />
        <label className="dsk__toggle" title="Hide sessions archived in the desktop app">
          <input
            type="checkbox"
            checked={hideArchived}
            onChange={(e) => setHideArchived(e.target.checked)}
          />
          hide archived
        </label>
      </div>

      <div className="panel__body">
        {!isTauri() ? (
          <div className="panel__empty">Desktop sessions need the ccanvas desktop app.</div>
        ) : sessions == null ? (
          <div className="panel__empty">Looking for sessions…</div>
        ) : shown.length === 0 ? (
          <div className="panel__empty">
            {sessions.length === 0
              ? 'No Claude desktop-app sessions found on this Mac.'
              : 'No sessions match.'}
          </div>
        ) : (
          shown.map((d) => {
            const on = mirrored.has(d.cliSessionId)
            const live = isRunningNow(d.transcriptMtime, now)
            return (
              <label
                key={d.sessionId}
                className={`dsk__row${on ? ' dsk__row--on' : ''}`}
                title={`${d.cwd}${d.transcriptMtime == null ? '\n(no transcript found)' : ''}`}
              >
                <input
                  type="checkbox"
                  disabled={on}
                  checked={on || picked.has(d.cliSessionId)}
                  onChange={() => toggle(d.cliSessionId)}
                />
                <StatusGlyph
                  status={live ? 'working' : 'idle'}
                  title={live ? 'running now' : 'not running'}
                />
                <div className="roster__main">
                  <div className="roster__top">
                    <span className="roster__name">{d.title}</span>
                    {on && <span className="roster__tab">on canvas</span>}
                    {d.isArchived && <span className="roster__tab">archived</span>}
                    <span className="roster__meter">
                      {ago(d.transcriptMtime ?? d.lastActivityAt, now)}
                    </span>
                  </div>
                  <div className="roster__last">
                    {baseName(d.cwd)}
                    {d.model ? ` · ${shortModel(d.model)}` : ''}
                  </div>
                </div>
              </label>
            )
          })
        )}
      </div>

      <div className="dsk__foot">
        <button
          className="dsk__btn"
          disabled={running.length === 0}
          title="Mirror every session whose transcript changed in the last 30 seconds"
          onClick={() => addDesktopMirrors(running)}
        >
          Add all running{running.length ? ` (${running.length})` : ''}
        </button>
        <span className="panel__spacer" />
        <button className="composer__send" disabled={pickable === 0} onClick={addPicked}>
          Add{pickable ? ` ${pickable}` : ''}
        </button>
      </div>
    </div>
  )
}
