import { useEffect, useMemo, useRef, useState } from 'react'
import { viewport, viewCenter, cycleTerminal } from '../lib/view'
import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import { elementBounds } from '../lib/geometry'
import { downloadPng, downloadSvg } from '../lib/export'
import { runCommand, joinPath } from '../lib/backend'
import { sendPrompt, isLive } from '../lib/agents'
import type { CanvasElement, WidgetKind } from '../lib/types'
import { AGENT_COLORS } from '../lib/types'

/** The focused/selected agent or terminal a prompt insert should target. */
function injectTargetId(): string | null {
  const s = useStore.getState()
  const ws = selectActive(s)
  const byId = new Map(ws.elements.map((e) => [e.id, e]))
  const ok = (id?: string | null) => {
    const el = id ? byId.get(id) : undefined
    return !!el && el.type === 'widget' && (el.kind === 'agent' || el.kind === 'terminal')
  }
  if (ok(s.activeWidgetId)) return s.activeWidgetId
  return s.selection.find((id) => ok(id)) ?? null
}

const worldCenter = () =>
  screenToWorld(
    { x: viewCenter().x, y: viewCenter().y },
    selectActive(useStore.getState()).camera,
  )

type Item = {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
  /** switch the palette into this scope instead of running + closing */
  mode?: Scope
}

// ⇧← / ⇧→ cycle through these. `notes` is also entered by typing `rnotes `.
type Scope = 'all' | 'commands' | 'go' | 'notes'
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'commands', label: 'Commands' },
  { id: 'go', label: 'Go to' },
  { id: 'notes', label: 'Notes' },
]
const NOTES_TRIGGER = /^rnotes\s/i

const scopeOf = (it: Item): Scope =>
  it.group === 'Navigate' || it.group === 'Tabs' ? 'go' : it.group === 'Notes' ? 'notes' : 'commands'

/** A note's name is its first non-empty line, minus markdown decoration. */
function noteName(el: CanvasElement): string {
  const raw = el.type === 'widget' ? (el.note ?? '') : ''
  const line = raw
    .split('\n')
    .map((l) => l.replace(/^[\s#>*+-]*(\[[ xX]?\]\s*)?/, '').trim())
    .find(Boolean)
  return line ? line.slice(0, 80) : 'Empty note'
}

const widgetName = (el: CanvasElement) =>
  el.type === 'widget' && el.kind === 'note' ? noteName(el) : el.type === 'widget' ? el.title : ''

function createNote(text: string) {
  const s = useStore.getState()
  const w = worldCenter()
  s.spawnWidget('note', w.x, w.y, text ? { note: text } : undefined)
}

const SPAWNABLE: { kind: WidgetKind; label: string }[] = [
  { kind: 'agent', label: 'Claude agent' },
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'files', label: 'File tree' },
  { kind: 'diff', label: 'Git panel' },
  { kind: 'editor', label: 'Editor' },
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'note', label: 'Note' },
]

const AGENT_MODELS = ['opus', 'sonnet', 'haiku']

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [scope, setScope] = useState<Scope>('all')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setHi(0)
      setScope('all')
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
        hint: kind === 'vscode' ? '⌘⇧V' : 'widget',
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

    // terminals: arrange, switch, filter
    const fitAll = () => s.homeView(viewport().vw, viewport().vh)
    out.push(
      {
        id: 'term-arrange-label',
        label: 'Arrange terminals by label colour',
        group: 'Terminals',
        run: () => {
          s.arrangeTerminals('label')
          fitAll()
        },
      },
      {
        id: 'term-arrange-folder',
        label: 'Arrange terminals by folder',
        group: 'Terminals',
        run: () => {
          s.arrangeTerminals('folder')
          fitAll()
        },
      },
      { id: 'term-next', label: 'Next terminal', hint: '⌘⇧]', group: 'Terminals', run: () => cycleTerminal(1) },
      { id: 'term-prev', label: 'Previous terminal', hint: '⌘⇧[', group: 'Terminals', run: () => cycleTerminal(-1) },
    )
    if (s.labelFilter)
      out.push({
        id: 'term-filter-clear',
        label: 'Show all terminals (clear label filter)',
        group: 'Terminals',
        run: () => s.setLabelFilter(null),
      })
    for (const c of AGENT_COLORS) {
      const hex = c.hex.toLowerCase()
      if (!ws.elements.some((e) => e.type === 'widget' && e.color?.toLowerCase() === hex)) continue
      out.push({
        id: `term-filter-${c.name}`,
        label: `Show only ${c.name} terminals`,
        group: 'Terminals',
        run: () => s.setLabelFilter([hex]),
      })
    }

    // canvas / file
    out.push(
      { id: 'save', label: 'Save canvas', hint: '⌘S', group: 'Canvas', run: () => void s.saveActive() },
      { id: 'save-as', label: 'Save canvas as…', group: 'Canvas', run: () => void s.saveActive(true) },
      { id: 'open', label: 'Open .ccnvs…', hint: '⌘O', group: 'Canvas', run: () => void s.openFile() },
      { id: 'new', label: 'New canvas', hint: '⌘N', group: 'Canvas', run: () => void s.newTab() },
      {
        id: 'claude-workspace',
        label: "Show Claude's memory graph",
        hint: 'panel',
        group: 'Canvas',
        run: () => s.setOpenPanel('memory'),
      },
      { id: 'folder', label: 'Set canvas folder…', group: 'Canvas', run: () => void s.setActiveDir() },
      {
        id: 'pin-tab',
        label: ws.pinned ? 'Unpin this tab' : 'Pin this tab',
        group: 'Canvas',
        run: () => s.togglePinTab(ws.id),
      },
      { id: 'png', label: 'Export as PNG', group: 'Canvas', run: () => void downloadPng(ws) },
      { id: 'svg', label: 'Export as SVG', group: 'Canvas', run: () => downloadSvg(ws) },
      {
        id: 'focus',
        label: 'Focus selection',
        hint: '\\',
        group: 'View',
        run: () => s.zoomToSelection(viewport().vw, viewport().vh),
      },
      {
        id: 'panel-roster',
        label: 'Agent roster',
        group: 'Panels',
        run: () => s.setOpenPanel('roster'),
      },
      {
        id: 'panel-prompts',
        label: 'Prompt library',
        group: 'Panels',
        run: () => s.setOpenPanel('prompts'),
      },
      {
        id: 'panel-checkpoints',
        label: 'Checkpoints',
        group: 'Panels',
        run: () => s.setOpenPanel('checkpoints'),
      },
      {
        id: 'search-canvas',
        label: 'Search this canvas',
        hint: '⌘F',
        group: 'View',
        run: () => s.setSearchOpen(true),
      },
      {
        id: 'follow-toggle',
        label: s.followAgent ? 'Stop following the active agent' : 'Follow the active agent',
        hint: s.followAgent ? 'on' : 'off',
        group: 'View',
        run: () => s.setFollowAgent(!s.followAgent),
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

    // prompt library → insert into the focused agent
    for (const p of s.prompts)
      out.push({
        id: `prompt-${p.id}`,
        label: `Insert prompt: ${p.name}`,
        hint: 'agent',
        group: 'Prompts',
        run: () => {
          const id = injectTargetId()
          if (id && isLive(id)) {
            sendPrompt(id, p.text, false)
            s.setActiveWidget(id)
          } else {
            s.setOpenPanel('prompts')
          }
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

    // jump to a widget by name
    const goTo = (el: CanvasElement) => {
      const b = elementBounds(el)
      const cam = ws.camera
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      s.setCamera({
        zoom: cam.zoom,
        x: viewCenter().x - cx * cam.zoom,
        y: viewCenter().y - cy * cam.zoom,
      })
      s.setSelection([el.id])
    }
    for (const el of ws.elements)
      if (el.type === 'widget')
        out.push({
          id: `jump-${el.id}`,
          label: `Go to: ${widgetName(el)}`,
          hint: el.kind,
          group: 'Navigate',
          run: () => goTo(el),
        })

    // notes (rnotes): open an existing note for editing
    for (const el of ws.elements)
      if (el.type === 'widget' && el.kind === 'note')
        out.push({
          id: `note-${el.id}`,
          label: noteName(el),
          hint: 'note',
          group: 'Notes',
          run: () => {
            goTo(el)
            s.setActiveWidget(el.id)
          },
        })
    out.push({
      id: 'mode-notes',
      label: 'Notes',
      hint: 'rnotes',
      group: 'Modes',
      run: () => {},
      mode: 'notes',
    })

    return out
  }, [open])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    const terms = t.split(/\s+/).filter(Boolean)
    const list = items.filter((it) => {
      const sc = scopeOf(it)
      // notes only surface inside the notes scope (`rnotes`)
      if (scope === 'all' ? sc === 'notes' : sc !== scope) return false
      const hay = (it.label + ' ' + it.group + ' ' + (it.hint ?? '')).toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
    if (scope === 'notes') {
      const text = q.trim()
      list.unshift({
        id: 'note-create',
        label: text ? `Create note: ${text}` : 'New note',
        hint: '↵',
        group: 'Notes',
        run: () => createNote(text),
      })
    }
    return list
  }, [items, q, scope])

  if (!open) return null

  const close = () => setOpen(false)
  const choose = (it: Item | undefined) => {
    if (!it) return
    if (it.mode) {
      setScope(it.mode)
      setQ('')
      setHi(0)
      inputRef.current?.focus()
      return
    }
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
          placeholder={
            scope === 'notes'
              ? 'Find a note, or type to create one…'
              : 'Type a command — spawn, arrange, export, jump…'
          }
          value={q}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value
            setHi(0)
            // `rnotes ` drops you into the notes scope and eats the trigger
            if (scope !== 'notes' && NOTES_TRIGGER.test(v)) {
              setScope('notes')
              setQ(v.replace(NOTES_TRIGGER, ''))
              return
            }
            setQ(v)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') return close()
            // ⌘K again closes the palette it opened
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
              e.preventDefault()
              return close()
            }
            // ⇧← / ⇧→ cycle the scope chips
            if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault()
              const i = SCOPES.findIndex((x) => x.id === scope)
              const d = e.key === 'ArrowRight' ? 1 : -1
              setScope(SCOPES[(i + d + SCOPES.length) % SCOPES.length].id)
              setHi(0)
              return
            }
            // backspace on an empty box leaves a scope, like Raycast
            if (e.key === 'Backspace' && q === '' && scope !== 'all') {
              e.preventDefault()
              setScope('all')
              return
            }
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
        <div className="palette__scopes">
          {SCOPES.map((sc) => (
            <button
              key={sc.id}
              className={`palette__chip${sc.id === scope ? ' palette__chip--on' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault()
                setScope(sc.id)
                setHi(0)
                inputRef.current?.focus()
              }}
            >
              {sc.label}
            </button>
          ))}
          <span className="palette__cycle">⇧← ⇧→</span>
        </div>
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
