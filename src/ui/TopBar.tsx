import { useEffect, useRef, useState } from 'react'
import { useStore, selectActive, type SidePanel } from '../store/workspace'
import { baseName, isTauri } from '../lib/backend'
import { AGENT_COLORS, type WidgetElement } from '../lib/types'
import { isTermWidget } from '../lib/view'
import {
  IconMark,
  IconFolder,
  IconPlus,
  IconClose,
  IconSearch,
  IconAgent,
  IconChat,
  IconHistory,
  IconSettings,
  IconClaude,
  IconPin,
  IconMore,
} from './icons'
import { UsagePill } from './UsagePill'
import { openContextMenu } from './ContextMenu'

// On macOS the window's title bar is overlaid by this bar, so leave room for
// the traffic lights and let empty bar space drag the window.
const MAC_OVERLAY = isTauri() && /Mac/i.test(navigator.userAgent)

// One slim bar: logo · tabs · (drag space) · folder · label filter · tools.
// Open / Save / New live on ⌘O / ⌘S / ⌘N and in the command palette.
export function TopBar() {
  const ws = useStore(selectActive)
  const setActiveDir = useStore((s) => s.setActiveDir)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)

  return (
    <header
      className={`topbar${MAC_OVERLAY ? ' topbar--mac' : ''}`}
      data-tauri-drag-region
    >
      <span className="brand" title="ccanvas">
        <IconMark />
      </span>

      <Tabs />

      <div className="topbar__spacer" data-tauri-drag-region />

      <button
        className={`tb-chip${ws.dir ? '' : ' tb-chip--unset'}`}
        title={ws.dir ? `Canvas folder: ${ws.dir}\nClick to change` : 'Bind this canvas to a folder'}
        onClick={() => void setActiveDir()}
      >
        <IconFolder />
        <span className="tb-chip__name">{ws.dir ? baseName(ws.dir) : 'set folder'}</span>
      </button>

      <LabelFilter />
      <Tools />
      <UsagePill />
      <button className="tb-icon" onClick={() => setPaletteOpen(true)} title="Commands (⌘K)">
        <IconSearch />
      </button>
    </header>
  )
}

function Tabs() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const switchTab = useStore((s) => s.switchTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const renameTab = useStore((s) => s.renameTab)
  const togglePinTab = useStore((s) => s.togglePinTab)
  const moveTab = useStore((s) => s.moveTab)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  // When the strip overflows, fade whichever edge has more tabs past it
  // (instead of a scrollbar or a hard cut mid-name).
  const [fade, setFade] = useState({ l: false, r: false })
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const update = () => {
      const l = strip.scrollLeft > 1
      const r = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
      setFade((f) => (f.l === l && f.r === r ? f : { l, r }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(strip)
    for (const c of Array.from(strip.children)) ro.observe(c)
    strip.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      strip.removeEventListener('scroll', update)
    }
  }, [tabs])

  // keep the active tab in view when it changes (⌘1–9, the tab finder, new tab)
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('.tab--active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  // Drag a tab sideways to reorder. Pointer events (not HTML5 drag & drop) so it
  // doesn't fight the window drag region or the file-drop handler. Reordering is
  // live: the tab lands wherever its centre has crossed the neighbours' midpoints.
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || editingId === id) return
    const startX = e.clientX
    let dragging = false
    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4) return
        dragging = true
        setDragId(id)
      }
      const strip = stripRef.current
      if (!strip) return
      const els = Array.from(strip.querySelectorAll<HTMLElement>(':scope > .tab'))
      const mine = useStore.getState().tabs.findIndex((t) => t.id === id)
      let to = 0
      els.forEach((node, i) => {
        if (i === mine) return
        const r = node.getBoundingClientRect()
        if (ev.clientX > r.left + r.width / 2) to++
      })
      moveTab(id, to)
    }
    const end = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      dragCleanup.current = null
      setDragId(null)
    }
    dragCleanup.current?.()
    dragCleanup.current = end
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const tabMenu = (e: React.MouseEvent, id: string, pinned: boolean) =>
    openContextMenu(e, [
      { label: pinned ? 'Unpin tab' : 'Pin tab', icon: <IconPin />, onClick: () => togglePinTab(id) },
      { label: 'Rename', onClick: () => setEditingId(id) },
      { separator: true },
      {
        label: 'Close tab',
        danger: true,
        disabled: pinned,
        hint: pinned ? 'unpin first' : undefined,
        onClick: () => closeTab(id),
      },
    ])

  return (
    <div className="tabs-wrap">
    <div
      className={`tabs${fade.l ? ' tabs--fade-l' : ''}${fade.r ? ' tabs--fade-r' : ''}`}
      ref={stripRef}
    >
      {tabs.map((t, i) => (
        <div
          key={t.id}
          className={`tab${t.id === activeTabId ? ' tab--active' : ''}${
            t.pinned ? ' tab--pinned' : ''
          }${t.pinned && !tabs[i + 1]?.pinned ? ' tab--pinned-last' : ''}${
            t.id === dragId ? ' tab--dragging' : ''
          }`}
          onPointerDown={(e) => {
            switchTab(t.id)
            startDrag(e, t.id)
          }}
          onDoubleClick={() => setEditingId(t.id)}
          onContextMenu={(e) => tabMenu(e, t.id, !!t.pinned)}
          title={`${t.name}${t.pinned ? ' · pinned' : ''}${t.dirty ? ' — unsaved (⌘S)' : ''}`}
        >
          {t.pinned && editingId !== t.id && (
            <span className="tab__pin">
              <IconPin />
            </span>
          )}
          {editingId === t.id ? (
            <input
              className="tab__name-input"
              defaultValue={t.name}
              autoFocus
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => {
                renameTab(t.id, e.target.value.trim() || t.name)
                setEditingId(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <span className="tab__name">{t.name}</span>
          )}
          {t.dirty && <span className="tab__dirty" />}
          {!t.pinned && (
            <button
              className="tab__close"
              title="Close tab"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              <IconClose />
            </button>
          )}
        </div>
      ))}
    </div>
      <button className="tab-add" title="New canvas (⌘N)" onClick={() => void newTab()}>
        <IconPlus />
      </button>
    </div>
  )
}

// Show only terminals carrying these colour tags; the rest dim. Click a dot to
// solo that colour (click again to clear), ⇧-click to add or remove it.
function LabelFilter() {
  const elements = useStore((s) => selectActive(s).elements)
  const filter = useStore((s) => s.labelFilter)
  const setLabelFilter = useStore((s) => s.setLabelFilter)

  const present = new Set(
    elements
      .filter((e): e is WidgetElement => isTermWidget(e) && !!e.color)
      .map((e) => e.color!.toLowerCase()),
  )
  const colors = AGENT_COLORS.filter((c) => present.has(c.hex.toLowerCase()))
  // colours tagged with a hex outside the palette still get a dot
  for (const hex of present)
    if (!colors.some((c) => c.hex.toLowerCase() === hex)) colors.push({ name: hex, hex })
  if (colors.length === 0) return null

  const toggle = (hex: string, additive: boolean) => {
    const cur = filter ?? []
    if (additive)
      setLabelFilter(cur.includes(hex) ? cur.filter((h) => h !== hex) : [...cur, hex])
    else setLabelFilter(cur.length === 1 && cur[0] === hex ? null : [hex])
  }

  return (
    <div className={`lfilter${filter ? ' lfilter--on' : ''}`} title="Filter terminals by label">
      {colors.map((c) => {
        const hex = c.hex.toLowerCase()
        const on = !!filter?.includes(hex)
        return (
          <button
            key={hex}
            className={`lfilter__dot${on ? ' lfilter__dot--on' : ''}${
              filter && !on ? ' lfilter__dot--off' : ''
            }`}
            style={{ '--k': c.hex } as React.CSSProperties}
            title={`${on ? 'Hide' : 'Show only'} ${c.name} terminals (⇧-click to combine)`}
            onClick={(e) => toggle(hex, e.shiftKey)}
          />
        )
      })}
      {filter && (
        <button className="lfilter__clear" title="Show all terminals" onClick={() => setLabelFilter(null)}>
          <IconClose />
        </button>
      )}
    </div>
  )
}

const PANELS: { id: SidePanel; label: string; title: string; icon: React.ReactNode }[] = [
  { id: 'roster', label: 'Agents', title: 'Agents: every agent across your tabs, with status and a composer', icon: <IconAgent /> },
  { id: 'prompts', label: 'Prompts', title: 'Prompts: saved prompts you can send to any agent', icon: <IconChat /> },
  { id: 'checkpoints', label: 'Checkpoints', title: 'Checkpoints: git snapshots you can roll back to', icon: <IconHistory /> },
  { id: 'memory', label: 'Memory', title: "Memory: Claude's memory for this project, as a linked graph", icon: <IconClaude /> },
  { id: 'settings', label: 'Settings', title: 'Settings: shortcuts and colour palette', icon: <IconSettings /> },
]

// The panel buttons. When the window is narrow the stylesheet hides them and
// shows a single ⋯ button instead, which lists every panel in a menu.
function Tools() {
  const tabs = useStore((s) => s.tabs)
  const openPanel = useStore((s) => s.openPanel)
  const togglePanel = useStore((s) => s.togglePanel)

  const agentCount = tabs.reduce(
    (n, t) => n + t.elements.filter((e) => e.type === 'widget' && e.kind === 'agent').length,
    0,
  )
  const on = (b: boolean) => `tb-icon${b ? ' tb-icon--on' : ''}`

  const moreMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    openContextMenu({ clientX: r.right, clientY: r.bottom + 4 }, [
      ...PANELS.map((p) => ({
        label: p.id === 'roster' && agentCount > 0 ? `${p.label} (${agentCount})` : p.label,
        icon: p.icon,
        hint: openPanel === p.id ? 'open' : undefined,
        onClick: () => togglePanel(p.id),
      })),
    ])
  }

  return (
    <div className="topbar__tools">
      {PANELS.map((p) => (
        <button
          key={p.id}
          className={on(openPanel === p.id)}
          title={p.title}
          onClick={() => togglePanel(p.id)}
        >
          {p.icon}
          {p.id === 'roster' && agentCount > 0 && (
            <span className="tb-icon__badge">{agentCount}</span>
          )}
        </button>
      ))}
      <button
        className={`${on(openPanel !== null)} tb-more`}
        title="Panels: agents, prompts, checkpoints, memory, settings"
        onClick={moreMenu}
      >
        <IconMore />
        {agentCount > 0 && <span className="tb-icon__badge">{agentCount}</span>}
      </button>
    </div>
  )
}
