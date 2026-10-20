import { useEffect, useRef, useState } from 'react'
import { getUsage, getPlanUsage, type Usage, type PlanUsage, type PlanLimit } from '../lib/backend'

// local token-estimate budget (tokens), used only when Claude's real usage isn't
// available. 0 = no bar, just show usage + reset.
const LIMIT_KEY = 'ccanvas:usageLimit'
// Claude's usage endpoint is polled gently; the local estimate is cheap
const PLAN_POLL_MS = 120_000
const LOCAL_POLL_MS = 45_000

const LIMIT_LABEL: Record<string, string> = {
  session: 'Session (5h)',
  weekly: 'Weekly',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet',
}

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
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  return `${Math.round(m / 1440)}d`
}
function fmtTime(resetMs: number): string {
  const d = new Date(resetMs)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

const PLAN_NOTE: Record<Exclude<PlanUsage['status'], 'ok'>, string> = {
  signed_out: 'Sign in to Claude Code to see your plan usage.',
  expired: 'Your Claude Code sign-in needs a refresh. Run any claude command, then check back.',
  error: "Couldn't reach Claude for plan usage. Showing the local estimate.",
}

export function UsagePill() {
  const [u, setU] = useState<Usage | null>(null)
  const [plan, setPlan] = useState<PlanUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<number>(() => Number(localStorage.getItem(LIMIT_KEY)) || 0)
  const [, tick] = useState(0) // re-render to refresh the countdown
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const pollLocal = async () => {
      const r = await getUsage()
      if (alive) setU(r)
    }
    const pollPlan = async () => {
      const r = await getPlanUsage()
      if (alive) setPlan(r)
    }
    void pollLocal()
    void pollPlan()
    const localId = setInterval(pollLocal, LOCAL_POLL_MS)
    const planId = setInterval(pollPlan, PLAN_POLL_MS)
    const tickId = setInterval(() => tick((n) => n + 1), 30_000)
    return () => {
      alive = false
      clearInterval(localId)
      clearInterval(planId)
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

  const planOk = plan?.status === 'ok' && plan.limits.length > 0
  if (!planOk && (!u || !u.hasData)) return null

  // the pill shows the session window, unless another limit is nearly used up
  const headline: PlanLimit | null = planOk
    ? (() => {
        const worst = plan!.limits.reduce((a, b) => (b.percent > a.percent ? b : a))
        const session = plan!.limits.find((l) => l.kind === 'session')
        return worst.percent >= 85 || !session ? worst : session
      })()
    : null

  const hasLimit = limit > 0
  const localPct = u && hasLimit ? Math.min(100, (u.activeTokens / limit) * 100) : 0
  const pct = headline ? headline.percent : localPct
  const showBar = !!headline || hasLimit
  const hot = showBar && pct >= 85
  const resetMs = headline ? headline.resetMs : (u?.resetMs ?? null)

  return (
    <div className="usage" ref={ref}>
      <button
        className={`tb-btn usage__pill${hot ? ' usage__pill--hot' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          headline
            ? `Claude usage: ${LIMIT_LABEL[headline.kind] ?? headline.kind} ${Math.round(pct)}% used`
            : 'Claude Code usage (local estimate)'
        }
      >
        {showBar && (
          <span className="usage__bar">
            <span className="usage__bar-fill" style={{ width: Math.min(100, pct) + '%' }} />
          </span>
        )}
        <span className="usage__num">
          {showBar ? `${Math.round(pct)}%` : fmtTokens(u?.activeTokens ?? 0)}
        </span>
        {resetMs && <span className="usage__reset">· {fmtCountdown(resetMs)}</span>}
      </button>

      {open && (
        <div className="usage__pop">
          <div className="usage__title">
            Claude usage{planOk && plan!.plan ? ` · ${plan!.plan}` : ''}
          </div>

          {planOk &&
            plan!.limits.map((l) => (
              <div key={l.kind} className="usage__limit-row">
                <div className="usage__row">
                  <span>{LIMIT_LABEL[l.kind] ?? l.kind}</span>
                  <b>{Math.round(l.percent)}%</b>
                </div>
                <span className="usage__bar usage__bar--wide">
                  <span
                    className={`usage__bar-fill${l.percent >= 85 ? ' usage__bar-fill--hot' : ''}`}
                    style={{ width: Math.min(100, l.percent) + '%' }}
                  />
                </span>
                {l.resetMs && (
                  <div className="usage__resets">
                    resets {fmtTime(l.resetMs)} · in {fmtCountdown(l.resetMs)}
                  </div>
                )}
              </div>
            ))}

          {plan && plan.status !== 'ok' && (
            <div className="usage__hint">{PLAN_NOTE[plan.status]}</div>
          )}

          {u?.hasData && (
            <>
              {planOk && <div className="usage__sep" />}
              <div className="usage__row">
                <span>Tokens this window</span>
                <b>
                  {fmtTokens(u.activeTokens)}
                  {!planOk && hasLimit ? ` / ${fmtTokens(limit)}` : ''}
                </b>
              </div>
              <div className="usage__row">
                <span>Tokens last 24h</span>
                <b>{fmtTokens(u.dayTokens)}</b>
              </div>
            </>
          )}

          {!planOk && (
            <>
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
                Set a per-window token budget to show <b>% used</b>. Estimated from
                Claude Code's local session logs.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
