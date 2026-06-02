import { useEffect, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { newId } from '../lib/id'
import {
  listCheckpoints,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoint,
  diffStatSince,
  type Checkpoint,
} from '../lib/checkpoints'
import { IconClose, IconPlus, IconHistory } from './icons'
import '../styles/agent-tools.css'

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// Git-backed working-tree checkpoints for the active canvas folder. Snapshot
// before letting an agent loose; restore tracked files if it makes a mess.
export function Checkpoints() {
  const dir = useStore((s) => selectActive(s).dir)
  const setOpenPanel = useStore((s) => s.setOpenPanel)

  const [list, setList] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [stat, setStat] = useState<{ id: string; text: string } | null>(null)

  const refresh = () => setList(dir ? listCheckpoints(dir) : [])
  useEffect(refresh, [dir])

  const create = async () => {
    if (!dir) return
    const label = window.prompt('Checkpoint label', `before ${new Date().toLocaleTimeString()}`)
    if (label == null) return
    setBusy(true)
    setNote('snapshotting…')
    const r = await createCheckpoint(dir, label.trim() || 'checkpoint', newId(), Date.now())
    setBusy(false)
    setNote(r.ok ? 'checkpoint saved ✓' : r.error)
    if (r.ok) refresh()
    setTimeout(() => setNote(''), 2600)
  }

  const restore = async (cp: Checkpoint) => {
    if (!dir) return
    if (
      !window.confirm(
        `Restore tracked files to “${cp.label}”?\n\nThis resets tracked files to that snapshot. ` +
          `Files created after it are left in place; untracked files aren’t affected.`,
      )
    )
      return
    setBusy(true)
    setNote('restoring…')
    const r = await restoreCheckpoint(dir, cp)
    setBusy(false)
    setNote(r.ok ? 'restored ✓' : (r.error ?? 'failed'))
    setTimeout(() => setNote(''), 2600)
  }

  const toggleStat = async (cp: Checkpoint) => {
    if (!dir) return
    if (stat?.id === cp.id) return setStat(null)
    const text = await diffStatSince(dir, cp)
    setStat({ id: cp.id, text })
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Checkpoints</span>
        <span className="panel__badge">{list.length}</span>
        <span className="panel__spacer" />
        <button
          className="panel__x"
          title="New checkpoint (snapshot the working tree)"
          disabled={!dir || busy}
          onClick={() => void create()}
        >
          <IconPlus size={14} />
        </button>
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body">
        {note && <div className="panel__note">{note}</div>}
        {!dir ? (
          <div className="panel__empty">Bind this canvas to a git folder to use checkpoints.</div>
        ) : list.length === 0 ? (
          <div className="panel__empty">
            <IconHistory size={20} />
            <div>No checkpoints yet. Click ＋ to snapshot the working tree before an agent run.</div>
          </div>
        ) : (
          list.map((cp) => (
            <div key={cp.id} className="cp__row">
              <div className="cp__main">
                <div className="cp__label">{cp.label}</div>
                <div className="cp__meta">
                  {fmtAgo(cp.ts)} · {cp.branch} · {cp.sha.slice(0, 7)}
                </div>
                {stat?.id === cp.id && <pre className="cp__stat">{stat.text}</pre>}
              </div>
              <div className="cp__actions">
                <button className="cp__btn" title="What changed since" onClick={() => void toggleStat(cp)}>
                  diff
                </button>
                <button
                  className="cp__btn cp__btn--accent"
                  title="Restore tracked files to this checkpoint"
                  disabled={busy}
                  onClick={() => void restore(cp)}
                >
                  restore
                </button>
                <button
                  className="cp__btn cp__btn--danger"
                  title="Delete checkpoint"
                  onClick={() => {
                    void deleteCheckpoint(dir, cp).then(refresh)
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
