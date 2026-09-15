import { useStore, selectActive } from '../store/workspace'
import { baseName } from '../lib/backend'
import {
  IconMark,
  IconFolder,
  IconSave,
  IconPlus,
  IconSearch,
  IconAgent,
  IconChat,
  IconHistory,
  IconFollow,
  IconClaude,
} from './icons'
import { UsagePill } from './UsagePill'

export function TopBar() {
  const ws = useStore(selectActive)
  const tabs = useStore((s) => s.tabs)
  const newTab = useStore((s) => s.newTab)
  const openFile = useStore((s) => s.openFile)
  const saveActive = useStore((s) => s.saveActive)
  const setActiveDir = useStore((s) => s.setActiveDir)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const openPanel = useStore((s) => s.openPanel)
  const togglePanel = useStore((s) => s.togglePanel)
  const followAgent = useStore((s) => s.followAgent)
  const setFollowAgent = useStore((s) => s.setFollowAgent)

  const agentCount = tabs.reduce(
    (n, t) => n + t.elements.filter((e) => e.type === 'widget' && e.kind === 'agent').length,
    0,
  )

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark">
          <IconMark />
        </span>
        <span className="brand__name">ccanvas</span>
      </div>

      <button
        className={`tb-btn topbar__folder${ws.dir ? '' : ' topbar__folder--unset'}`}
        title={ws.dir ? `Canvas folder: ${ws.dir}\nClick to change` : 'Bind this canvas to a folder'}
        onClick={() => void setActiveDir()}
      >
        <IconFolder />
        <span className="topbar__folder-name">{ws.dir ? baseName(ws.dir) : 'set folder'}</span>
      </button>

      <div className="topbar__tools">
        <button
          className={`tb-tool${openPanel === 'roster' ? ' tb-tool--on' : ''}`}
          title="Every agent across your tabs: status, last message, and a composer to message them"
          onClick={() => togglePanel('roster')}
        >
          <IconAgent />
          <span className="tb-tool__label">Agents</span>
          {agentCount > 0 && <span className="tb-tool__count">{agentCount}</span>}
        </button>
        <button
          className={`tb-tool${openPanel === 'prompts' ? ' tb-tool--on' : ''}`}
          title="Saved prompts you can send to any agent"
          onClick={() => togglePanel('prompts')}
        >
          <IconChat />
          <span className="tb-tool__label">Prompts</span>
        </button>
        <button
          className={`tb-tool${openPanel === 'checkpoints' ? ' tb-tool--on' : ''}`}
          title="Git snapshots of your project you can roll back to"
          onClick={() => togglePanel('checkpoints')}
        >
          <IconHistory />
          <span className="tb-tool__label">Checkpoints</span>
        </button>
        <button
          className={`tb-tool${followAgent ? ' tb-tool--on' : ''}`}
          title="Move the view to whichever agent starts working"
          onClick={() => setFollowAgent(!followAgent)}
        >
          <IconFollow />
          <span className="tb-tool__label">Follow agents</span>
        </button>
        <button
          className={`tb-tool${openPanel === 'memory' ? ' tb-tool--on' : ''}`}
          title="Claude's memory for this project, as a linked graph"
          onClick={() => togglePanel('memory')}
        >
          <IconClaude />
          <span className="tb-tool__label">Memory</span>
        </button>
      </div>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        <UsagePill />
        <button className="tb-btn" onClick={() => setPaletteOpen(true)} title="Commands (⌘K)">
          <IconSearch /> <span className="tb-btn__label">Commands</span> <span className="kbd">⌘K</span>
        </button>
        <button className="tb-btn" onClick={() => void openFile()} title="Open a canvas (⌘O)">
          <IconFolder /> <span className="tb-btn__label">Open</span> <span className="kbd">⌘O</span>
        </button>
        <button className="tb-btn" onClick={() => void saveActive()} title="Save this canvas (⌘S)">
          <IconSave /> <span className="tb-btn__label">Save</span> <span className="kbd">⌘S</span>
        </button>
        <button className="tb-btn tb-btn--accent" onClick={() => void newTab()} title="New canvas (⌘N)">
          <IconPlus /> <span className="tb-btn__label">New</span>
        </button>
      </div>
    </header>
  )
}
