import { useCallback, useEffect, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { runCommand } from '../lib/backend'
import { IconReload } from '../ui/icons'

// GitHub issues widget. Lists open issues for the folder via `gh`, opens one in
// the browser on click, and creates a new one (gh issue create --web).

type Label = { name: string; color?: string }
type Issue = { number: number; title: string; labels?: Label[] }

export function IssuesBody({ el }: { el: WidgetElement }) {
  const cwd = el.path || el.cwd || ''
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(async () => {
    if (!cwd) {
      setErr('no folder bound')
      return
    }
    const r = await runCommand(
      'gh',
      ['issue', 'list', '--json', 'number,title,labels', '--limit', '40'],
      cwd,
    )
    if (!r) {
      setErr('backend offline')
      setIssues(null)
      return
    }
    if (r.code !== 0) {
      setErr(r.stderr.trim() || 'gh failed — is the GitHub CLI installed and authed?')
      setIssues(null)
      return
    }
    try {
      setIssues(JSON.parse(r.stdout || '[]'))
      setErr(null)
    } catch {
      setErr('could not parse gh output')
      setIssues(null)
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load, nonce])

  const open = (n: number) => void runCommand('gh', ['issue', 'view', String(n), '--web'], cwd)

  const create = async () => {
    setBusy(true)
    await runCommand('gh', ['issue', 'create', '--web'], cwd)
    setBusy(false)
  }

  return (
    <div className="pr">
      <div className="pr__bar">
        <span className="pr__title">issues</span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        <button
          className="diff__toggle"
          disabled={busy}
          title="New issue (opens the browser form)"
          onClick={() => void create()}
        >
          new
        </button>
        <button className="diff__btn" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <IconReload />
        </button>
      </div>
      {err ? (
        <div className="diff__empty">{err}</div>
      ) : issues == null ? (
        <div className="diff__empty">loading…</div>
      ) : issues.length === 0 ? (
        <div className="git__clean">no open issues</div>
      ) : (
        <div className="pr__list">
          {issues.map((it) => (
            <div
              key={it.number}
              className="pr__row"
              title="Open on GitHub"
              onClick={() => open(it.number)}
            >
              <span className="pr__num">#{it.number}</span>
              <span className="pr__name">{it.title}</span>
              {it.labels && it.labels.length > 0 && (
                <span className="issue__labels">
                  {it.labels.slice(0, 3).map((l) => (
                    <span
                      key={l.name}
                      className="issue__label"
                      style={l.color ? { borderColor: `#${l.color}`, color: `#${l.color}` } : undefined}
                    >
                      {l.name}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
