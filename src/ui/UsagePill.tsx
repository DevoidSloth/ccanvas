import { useEffect, useRef, useState } from 'react'
import { getUsage, type Usage } from '../lib/backend'

// per-window token budget (tokens). 0 = no bar, just show usage + reset.
const LIMIT_KEY = 'ccanvas:usageLimit'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M'
  if (n >= 1_000) return Math.round(n / 1000) + 'K'
  return String(n)
}
function fmtCountdown(resetMs: number | null): string {
  if (!resetMs) return ''
  const ms = resetMs - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
function fmtTime(resetMs: number): string {
  return new Date(resetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function UsagePill() {
  const [u, setU] = useState<Usage | null>(null)
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<number>(() => Number(localStorage.getItem(LIMIT_KEY)) || 0)
  const [, tick] = useState(0) // re-render to refresh the countdown
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      const r = await getUsage()
      if (alive) setU(r)
    }
    poll()
    const pollId = setInterval(poll, 45_000)
    const tickId = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      alive = false
      clearInterval(pollId)
      clearInterval(tickId)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!u || !u.hasData) return null

  const hasLimit = limit > 0
  const pct = hasLimit ? Math.min(100, (u.activeTokens / limit) * 100) : 0
  const hot = hasLimit && pct >= 85

  return (
    <div className="usage" ref={ref}>
      <button
        className={`tb-btn usage__pill${hot ? ' usage__pill--hot' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          hasLimit
            ? 'Claude Code usage — % of your window budget used'
            : 'Claude Code usage — set a window budget to see % used'
        }
      >
        {hasLimit && (
          <span className="usage__bar">
            <span className="usage__bar-fill" style={{ width: pct + '%' }} />
          </span>
        )}
        {/* show % of the window budget used; without a budget there's nothing to
            take a percentage of, so fall back to the raw token count */}
        <span className="usage__num">
          {hasLimit ? `${Math.round(pct)}%` : fmtTokens(u.activeTokens)}
        </span>
        {u.resetMs && <span className="usage__reset">· {fmtCountdown(u.resetMs)}</span>}
      </button>

      {open && (
        <div className="usage__pop">
          <div className="usage__title">Claude usage</div>
          {hasLimit && (
            <div className="usage__row">
              <span>Window used</span>
              <b>{Math.round(pct)}%</b>
            </div>
          )}
          <div className="usage__row">
            <span>This 5h window</span>
            <b>
              {fmtTokens(u.activeTokens)}
              {hasLimit ? ` / ${fmtTokens(limit)}` : ''} tok
            </b>
          </div>
          {u.resetMs && (
            <div className="usage__row">
              <span>Resets</span>
              <b>
                {fmtTime(u.resetMs)} · {fmtCountdown(u.resetMs)}
              </b>
            </div>
          )}
          <div className="usage__row">
            <span>Last 24h</span>
            <b>{fmtTokens(u.dayTokens)} tok</b>
          </div>
          <div className="usage__sep" />
          <label className="usage__row usage__limit">
            <span>Window limit</span>
            <input
              type="number"
              min={0}
              step={1}
              value={limit ? Math.round(limit / 1_000_000) : ''}
              placeholder="off"
              onChange={(e) => {
                const tok = Math.max(0, Number(e.target.value) || 0) * 1_000_000
                setLimit(tok)
                if (tok) localStorage.setItem(LIMIT_KEY, String(tok))
                else localStorage.removeItem(LIMIT_KEY)
              }}
            />
            <span className="usage__unit">M</span>
          </label>
          <div className="usage__hint">
            Set your plan's per-window token budget to show <b>% used</b> and a
            fill bar. Read from Claude Code's local session logs.
          </div>
        </div>
      )}
    </div>
  )
}
