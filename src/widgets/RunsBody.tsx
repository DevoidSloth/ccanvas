import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { runCommand } from '../lib/backend'
import { IconReload } from '../ui/icons'

// GitHub Actions widget. Lists recent workflow runs for the folder via `gh`,
// with a live poll (status changes remotely), opening a run on click.

type Run = {
  databaseId: number
  displayTitle: string
  status: string
  conclusion: string
  workflowName: string
  headBranch: string
}

function runState(r: Run): { glyph: string; cls: string; label: string } {
  if (r.status !== 'completed')
    return { glyph: '●', cls: 'run--active', label: r.status.replace(/_/g, ' ') }
  switch (r.conclusion) {
    case 'success':
      return { glyph: '✓', cls: 'run--ok', label: 'success' }
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return { glyph: '✗', cls: 'run--fail', label: r.conclusion.replace(/_/g, ' ') }
    default:
      return { glyph: '∅', cls: 'run--skip', label: r.conclusion || 'done' }
  }
}

export function RunsBody({ el }: { el: WidgetElement }) {
  const cwd = el.path || el.cwd || ''
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(async () => {
    if (!cwd) {
      setErr('no folder bound')
      return
    }
    const r = await runCommand(
      'gh',
      [
        'run',
        'list',
        '--json',
        'databaseId,displayTitle,status,conclusion,workflowName,headBranch',
        '--limit',
        '20',
      ],
      cwd,
    )
    if (!r) {
      setErr('backend offline')
      setRuns(null)
      return
    }
    if (r.code !== 0) {
      setErr(r.stderr.trim() || 'gh failed — is the GitHub CLI installed and authed?')
      setRuns(null)
      return
    }
    try {
      setRuns(JSON.parse(r.stdout || '[]'))
      setErr(null)
    } catch {
      setErr('could not parse gh output')
      setRuns(null)
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load, nonce])

  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (timer.current) clearInterval(timer.current)
    if (live) timer.current = setInterval(() => void load(), 5000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [live, load])

  const open = (id: number) => void runCommand('gh', ['run', 'view', String(id), '--web'], cwd)

  return (
    <div className="pr">
      <div className="pr__bar">
        <span className="pr__title">actions</span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        <button
          className={`diff__toggle${live ? ' diff__toggle--on' : ''}`}
          title="Refresh every 5s"
          onClick={() => setLive((a) => !a)}
        >
          live
        </button>
        <button className="diff__btn" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <IconReload />
        </button>
      </div>
      {err ? (
        <div className="diff__empty">{err}</div>
      ) : runs == null ? (
        <div className="diff__empty">loading…</div>
      ) : runs.length === 0 ? (
        <div className="git__clean">no workflow runs</div>
      ) : (
        <div className="pr__list">
          {runs.map((r) => {
            const st = runState(r)
            return (
              <div
                key={r.databaseId}
                className="pr__row"
                title={`${st.label} · open on GitHub`}
                onClick={() => open(r.databaseId)}
              >
                <span className={`run__status ${st.cls}`}>{st.glyph}</span>
                <span className="pr__name">{r.displayTitle || r.workflowName}</span>
                <span className="pr__branch" title={r.headBranch}>
                  {r.headBranch}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
