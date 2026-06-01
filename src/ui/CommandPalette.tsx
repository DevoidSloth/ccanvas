import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import { elementBounds } from '../lib/geometry'
import { downloadPng, downloadSvg } from '../lib/export'
import { runCommand, joinPath } from '../lib/backend'
import type { WidgetKind } from '../lib/types'

const CHROME_H = 82
const worldCenter = () =>
  screenToWorld(
    { x: window.innerWidth / 2, y: (window.innerHeight - CHROME_H) / 2 },
    selectActive(useStore.getState()).camera,
  )

type Item = { id: string; label: string; hint?: string; group: string; run: () => void }

const SPAWNABLE: { kind: WidgetKind; label: string }[] = [
  { kind: 'agent', label: 'Claude agent' },
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'files', label: 'File tree' },
  { kind: 'diff', label: 'Git diff' },
  { kind: 'editor', label: 'Editor' },
  { kind: 'doc', label: 'Live doc' },
  { kind: 'log', label: 'Log tail' },
  { kind: 'runner', label: 'Task runner' },
  { kind: 'sql', label: 'SQL editor' },
  { kind: 'data', label: 'Data viewer (csv/parquet/h5/json)' },
  { kind: 'plot', label: 'Figure viewer' },
  { kind: 'pr', label: 'Pull requests' },
  { kind: 'issues', label: 'GitHub issues' },
  { kind: 'runs', label: 'GitHub Actions' },
  { kind: 'web', label: 'Web preview' },
  { kind: 'note', label: 'Note' },
]

const AGENT_MODELS = ['opus', 'sonnet', 'haiku']

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setHi(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    if (!open) return []
    const s = useStore.getState()
    const ws = selectActive(s)
    const out: Item[] = []

    for (const { kind, label } of SPAWNABLE) {
      out.push({
        id: `spawn-${kind}`,
        label: `New: ${label}`,
        hint: 'widget',
        group: 'Create',
        run: () => {
          const w = worldCenter()
          if (kind === 'agent') s.openAgentWizard({ x: w.x, y: w.y })
          else s.spawnWidget(kind, w.x, w.y)
        },
      })
    }
    for (const model of AGENT_MODELS) {
      out.push({
        id: `agent-${model}`,
        label: `New agent (${model})`,
        hint: 'model',
        group: 'Create',
        run: () => {
          const w = worldCenter()
          s.openAgentWizard({ x: w.x, y: w.y, model })
        },
      })
    }
    if (ws.dir) {
      const dir = ws.dir
      const gitCmds: Array<[string, string, string[]]> = [
        ['git-init', 'git: init repository', ['init']],
        ['git-push', 'git: push', ['push']],
        ['git-pull', 'git: pull', ['pull']],
      ]
      for (const [id, label, args] of gitCmds)
        out.push({
          id,
          label,
          hint: 'git',
          group: 'Canvas',
          run: async () => {
            const r = await runCommand('git', ['-C', dir, ...args], dir)
            if (r && r.code !== 0) window.alert((r.stderr || r.stdout || 'failed').slice(0, 300))
          },
        })
      out.push({
        id: 'pr-create',
        label: 'Create PR (gh pr create --fill)',
        hint: 'gh',
        group: 'Canvas',
        run: async () => {
          const r = await runCommand('gh', ['pr', 'create', '--fill'], dir)
          if (r && r.code !== 0) window.alert('gh pr create failed:\n' + (r.stderr || r.stdout))
          else if (r) window.alert((r.stdout || 'done').trim())
        },
      })
      out.push({
        id: 'agent-worktree',
        label: 'New agent in a git worktree…',
        hint: 'isolated',
        group: 'Create',
        run: async () => {
          const branch = window.prompt('New worktree branch name')?.trim()
          if (!branch) return
          const wtPath = joinPath(joinPath(dir, '.ccanvas-worktrees'), branch)
          const res = await runCommand(
            'git',
            ['-C', dir, 'worktree', 'add', wtPath, '-b', branch],
            dir,
          )
          if (!res || res.code !== 0) {
            window.alert('git worktree failed:\n' + (res?.stderr || 'backend offline'))
            return
          }
          const w = worldCenter()
          s.openAgentWizard({
            x: w.x,
            y: w.y,
            cwd: wtPath,
            worktree: branch,
            title: `agent · ${branch}`,
          })
        },
      })
    }

    // arrange
    const arrange: Array<[string, () => void]> = [
      ['Group selection', s.group],
      ['Ungroup selection', s.ungroup],
      ['Lock / unlock selection', s.toggleLock],
      ['Duplicate selection', s.duplicateSelection],
      ['Bring to front', () => s.bringToFront(s.selection)],
      ['Send to back', () => s.sendToBack(s.selection)],
      ['Tidy into grid', s.tidy],
      ['Align left', () => s.align('left')],
      ['Align center', () => s.align('center-h')],
      ['Align right', () => s.align('right')],
      ['Distribute horizontally', () => s.distribute('h')],
      ['Distribute vertically', () => s.distribute('v')],
      ['Select all', () => s.setSelection(ws.elements.map((e) => e.id))],
    ]
    for (const [label, run] of arrange)
      out.push({ id: `arr-${label}`, label, group: 'Arrange', run })

    // canvas / file
    out.push(
      { id: 'save', label: 'Save canvas', hint: '⌘S', group: 'Canvas', run: () => void s.saveActive() },
      { id: 'save-as', label: 'Save canvas as…', group: 'Canvas', run: () => void s.saveActive(true) },
      { id: 'open', label: 'Open .ccnvs…', hint: '⌘O', group: 'Canvas', run: () => void s.openFile() },
      { id: 'new', label: 'New canvas', hint: '⌘N', group: 'Canvas', run: () => void s.newTab() },
      { id: 'folder', label: 'Set canvas folder…', group: 'Canvas', run: () => void s.setActiveDir() },
      { id: 'png', label: 'Export as PNG', group: 'Canvas', run: () => void downloadPng(ws) },
      { id: 'svg', label: 'Export as SVG', group: 'Canvas', run: () => downloadSvg(ws) },
      {
        id: 'present',
        label: 'Start presentation (step through frames)',
        group: 'View',
        run: () => s.setPresenting(true),
      },
      {
        id: 'focus',
        label: 'Focus selection',
        hint: '\\',
        group: 'View',
        run: () => s.zoomToSelection(window.innerWidth, window.innerHeight - CHROME_H),
      },
      {
        id: 'flows-toggle',
        label: s.flowsEnabled ? 'Pause agent flows' : 'Resume agent flows',
        hint: s.flowsEnabled ? 'running' : 'paused',
        group: 'View',
        run: () => s.setFlowsEnabled(!s.flowsEnabled),
      },
      {
        id: 'tpl-save',
        label: 'Save widget layout as template…',
        group: 'Templates',
        run: () => {
          const name = window.prompt('Template name')
          if (name) s.saveTemplate(name)
        },
      },
    )

    // templates
    for (const t of s.templates)
      out.push({
        id: `tpl-${t.id}`,
        label: `Spawn template: ${t.name}`,
        hint: `${t.widgets.length} widgets`,
        group: 'Templates',
        run: () => {
          const w = worldCenter()
          s.applyTemplate(t.id, w.x, w.y)
        },
      })

    // tabs
    for (const tab of s.tabs)
      if (tab.id !== s.activeTabId)
        out.push({
          id: `tab-${tab.id}`,
          label: `Switch to tab: ${tab.name}`,
          group: 'Tabs',
          run: () => s.switchTab(tab.id),
        })

    // jump to a widget by title
    for (const el of ws.elements)
      if (el.type === 'widget')
        out.push({
          id: `jump-${el.id}`,
          label: `Go to: ${el.title}`,
          hint: el.kind,
          group: 'Navigate',
          run: () => {
            const b = elementBounds(el)
            const cam = ws.camera
            const cx = b.x + b.w / 2
            const cy = b.y + b.h / 2
            s.setCamera({
              zoom: cam.zoom,
              x: window.innerWidth / 2 - cx * cam.zoom,
              y: (window.innerHeight - CHROME_H) / 2 - cy * cam.zoom,
            })
            s.setSelection([el.id])
          },
        })

    return out
  }, [open])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return items
    const terms = t.split(/\s+/)
    return items.filter((it) => {
      const hay = (it.label + ' ' + it.group + ' ' + (it.hint ?? '')).toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
  }, [items, q])

  if (!open) return null

  const close = () => setOpen(false)
  const choose = (it: Item | undefined) => {
    if (!it) return
    close()
    it.run()
  }

  const active = filtered.length ? Math.min(hi, filtered.length - 1) : 0

  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Type a command — spawn, arrange, export, jump…"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value)
            setHi(0)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') return close()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((active + 1) % Math.max(1, filtered.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((active - 1 + filtered.length) % Math.max(1, filtered.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(filtered[active])
            }
          }}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">no matches</div>}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={`palette__item${i === active ? ' palette__item--active' : ''}`}
              onMouseEnter={() => setHi(i)}
              onPointerDown={(e) => {
                e.preventDefault()
                choose(it)
              }}
            >
              <span className="palette__group">{it.group}</span>
              <span className="palette__label">{it.label}</span>
              {it.hint && <span className="palette__hint">{it.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
