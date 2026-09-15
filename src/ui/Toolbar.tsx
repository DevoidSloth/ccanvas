import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import type { WidgetKind } from '../lib/types'
import {
  IconTerminal,
  IconAgent,
  IconNote,
  IconFiles,
  IconDiff,
  IconEditor,
} from './icons'

type IconCmp = (p: { className?: string; size?: number }) => JSX.Element

// The two things ccanvas is for, as labelled buttons.
const LAUNCHERS: { kind: WidgetKind; Icon: IconCmp; label: string; keys: string }[] = [
  { kind: 'agent', Icon: IconAgent, label: 'Claude', keys: '⌘⇧T' },
  { kind: 'terminal', Icon: IconTerminal, label: 'Terminal', keys: '⌘T' },
]

// Panels that support an agent's work.
const PANELS: { kind: WidgetKind; Icon: IconCmp; label: string }[] = [
  { kind: 'files', Icon: IconFiles, label: 'File tree' },
  { kind: 'diff', Icon: IconDiff, label: 'Git panel' },
  { kind: 'editor', Icon: IconEditor, label: 'Editor' },
  { kind: 'note', Icon: IconNote, label: 'Note' },
]

// 82px = topbar + tabs; matches CHROME_H in App.tsx
const CHROME_H = 82
const center = () => ({ x: window.innerWidth / 2, y: (window.innerHeight - CHROME_H) / 2 })

export function Toolbar() {
  const spawnWidget = useStore((s) => s.spawnWidget)
  const openAgentWizard = useStore((s) => s.openAgentWizard)

  const spawn = (kind: WidgetKind) => {
    const ws = selectActive(useStore.getState())
    const world = screenToWorld(center(), ws.camera)
    // cascade each new widget down-right so repeated spawns fan out
    const step = 32
    const off = (ws.elements.length % 8) * step - step * 4
    const x = world.x + off
    const y = world.y + off
    // agents go through the wizard so they're configured before they launch
    if (kind === 'agent') {
      openAgentWizard({ x, y })
      return
    }
    spawnWidget(kind, x, y)
  }

  return (
    <div className="toolbar">
      {LAUNCHERS.map(({ kind, Icon, label, keys }) => (
        <button
          key={kind}
          className={`launcher launcher--${kind}`}
          onClick={() => spawn(kind)}
          title={`New ${kind === 'agent' ? 'Claude agent' : 'terminal'} (${keys})`}
        >
          <Icon />
          <span className="launcher__label">{label}</span>
          <span className="launcher__keys">{keys}</span>
        </button>
      ))}

      <div className="toolbar__sep" />

      {PANELS.map(({ kind, Icon, label }) => (
        <button key={kind} className="tool" onClick={() => spawn(kind)}>
          <Icon />
          <span className="tool__tip">{label}</span>
        </button>
      ))}

    </div>
  )
}
