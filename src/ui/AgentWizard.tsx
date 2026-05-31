import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import type { AgentWizardCtx } from '../store/workspace'
import { AGENT_COLORS, claudeColorName } from '../lib/types'
import type { WidgetElement } from '../lib/types'
import { sendTo, isLive } from '../lib/agents'
import { IconAgent } from './icons'

const MODELS = ['default', 'opus', 'sonnet', 'haiku']
const DEFAULT_COLOR = AGENT_COLORS[0].hex

// Modal shown when creating (or editing) an agent — set its name, colour,
// model, permission mode, and an optional first prompt before it launches.
export function AgentWizard() {
  const ctx = useStore((s) => s.agentWizard)
  if (!ctx) return null
  // key on the target so the form resets each time it opens
  return <Wizard key={ctx.editId ?? `${ctx.x},${ctx.y}`} ctx={ctx} />
}

function Wizard({ ctx }: { ctx: AgentWizardCtx }) {
  const close = useStore((s) => s.closeAgentWizard)
  const spawnWidget = useStore((s) => s.spawnWidget)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const ws = useStore(selectActive)

  const existing = ctx.editId
    ? (ws.elements.find((e) => e.id === ctx.editId) as WidgetElement | undefined)
    : undefined
  const editing = !!existing

  const [name, setName] = useState(existing?.title ?? ctx.title ?? '')
  const [color, setColor] = useState(existing?.color ?? DEFAULT_COLOR)
  const [model, setModel] = useState(existing?.model ?? ctx.model ?? 'default')
  const [skip, setSkip] = useState(existing?.skipPermissions ?? false)
  const [prompt, setPrompt] = useState(existing?.agentPrompt ?? ctx.agentPrompt ?? '')

  const folder = ctx.worktree
    ? `worktree · ${ctx.worktree}`
    : (ctx.cwd ?? ws.dir)?.replace(/[\\/]+$/, '').split(/[\\/]/).pop()

  const submit = () => {
    const title = name.trim() || 'claude agent'
    const cleanModel = model === 'default' ? undefined : model
    if (editing && existing) {
      beginHistory()
      mutateElement(existing.id, (w) => {
        const a = w as WidgetElement
        a.title = title
        a.color = color
        a.model = cleanModel
        a.skipPermissions = skip
        a.agentPrompt = prompt.trim() || undefined
      })
      if (isLive(existing.id)) {
        if (title !== existing.title) sendTo(existing.id, `/rename ${title}\r`)
        sendTo(existing.id, `/color ${claudeColorName(color)}\r`)
      }
    } else {
      spawnWidget('agent', ctx.x, ctx.y, {
        title,
        color,
        model: cleanModel,
        skipPermissions: skip,
        agentPrompt: prompt.trim() || undefined,
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
        ...(ctx.worktree ? { worktree: ctx.worktree } : {}),
      })
    }
    close()
  }

  return (
    <div className="wiz-backdrop" onPointerDown={close}>
      <div
        className="wiz"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') close()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
      >
        <div className="wiz__head">
          <span className="wiz__icon" style={{ color }}>
            <IconAgent />
          </span>
          <span className="wiz__title">{editing ? 'Edit agent' : 'New agent'}</span>
          {folder && <span className="wiz__folder">{folder}</span>}
        </div>

        <label className="wiz__label">Name</label>
        <input
          className="wiz__input"
          autoFocus
          placeholder="claude agent"
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />

        <label className="wiz__label">Color</label>
        <div className="wiz__swatches">
          {AGENT_COLORS.map((c) => (
            <button
              key={c.name}
              className={`wiz__swatch${color === c.hex ? ' wiz__swatch--active' : ''}`}
              style={{ background: c.hex }}
              title={c.name}
              onClick={() => setColor(c.hex)}
            />
          ))}
        </div>

        <label className="wiz__label">Model</label>
        <div className="wiz__seg">
          {MODELS.map((m) => (
            <button
              key={m}
              className={`wiz__seg-btn${model === m ? ' wiz__seg-btn--active' : ''}`}
              onClick={() => setModel(m)}
            >
              {m}
            </button>
          ))}
        </div>

        <label className="wiz__check">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          skip permission prompts <code>--dangerously-skip-permissions</code>
        </label>

        <label className="wiz__label">Initial prompt (optional)</label>
        <textarea
          className="wiz__textarea"
          placeholder="What should this agent start working on?"
          value={prompt}
          spellCheck={false}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="wiz__actions">
          <button className="wiz__btn" onClick={close}>
            Cancel
          </button>
          <button className="wiz__btn wiz__btn--primary" onClick={submit}>
            {editing ? 'Save' : 'Create agent'}
          </button>
        </div>
        <span className="wiz__hint">⌘↵ to {editing ? 'save' : 'create'} · esc to cancel</span>
      </div>
    </div>
  )
}
