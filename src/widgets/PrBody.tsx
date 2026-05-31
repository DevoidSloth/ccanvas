import { useCallback, useEffect, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { runCommand } from '../lib/backend'
import { IconReload } from '../ui/icons'

// Pull-request widget. Lists open PRs for the folder via the GitHub CLI (`gh`),
// opens one in the browser on click, and creates a PR from the current branch.

type PR = { number: number; title: string; headRefName: string; state: string }

export function PrBody({ el }: { el: WidgetElement }) {
  const cwd = el.path || el.cwd || ''
  const [prs, setPrs] = useState<PR[] | null>(null)
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
      ['pr', 'list', '--json', 'number,title,headRefName,state', '--limit', '30'],
      cwd,
    )
    if (!r) {
      setErr('backend offline')
      setPrs(null)
      return
    }
    if (r.code !== 0) {
      setErr(r.stderr.trim() || 'gh failed — is the GitHub CLI installed and authed?')
      setPrs(null)
      return
    }
    try {
      setPrs(JSON.parse(r.stdout || '[]'))
      setErr(null)
    } catch {
      setErr('could not parse gh output')
      setPrs(null)
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load, nonce])

  const open = (n: number) => void runCommand('gh', ['pr', 'view', String(n), '--web'], cwd)

  const create = async () => {
    setBusy(true)
    const r = await runCommand('gh', ['pr', 'create', '--fill'], cwd)
    setBusy(false)
    if (r && r.code !== 0) window.alert('gh pr create failed:\n' + (r.stderr || r.stdout))
    setNonce((n) => n + 1)
  }

  return (
    <div className="pr">
      <div className="pr__bar">
        <span className="pr__title">pull requests</span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        <button
          className="diff__toggle"
          disabled={busy}
          title="Create a PR from the current branch (gh pr create --fill)"
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
      ) : prs == null ? (
        <div className="diff__empty">loading…</div>
      ) : prs.length === 0 ? (
        <div className="git__clean">no open pull requests</div>
      ) : (
        <div className="pr__list">
          {prs.map((p) => (
            <div
              key={p.number}
              className="pr__row"
              title="Open on GitHub"
              onClick={() => open(p.number)}
            >
              <span className="pr__num">#{p.number}</span>
              <span className="pr__name">{p.title}</span>
              <span className="pr__branch" title={p.headRefName}>
                {p.headRefName}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
