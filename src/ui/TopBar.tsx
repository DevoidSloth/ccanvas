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
        <span className="brand__name">
          c<b>canvas</b>
        </span>
        <span className="brand__dot" />
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
          className={`tb-icon${openPanel === 'roster' ? ' tb-icon--on' : ''}`}
          title="Agent roster"
          onClick={() => togglePanel('roster')}
        >
          <IconAgent />
          {agentCount > 0 && <span className="tb-icon__badge">{agentCount}</span>}
        </button>
        <button
          className={`tb-icon${openPanel === 'prompts' ? ' tb-icon--on' : ''}`}
          title="Prompt library"
          onClick={() => togglePanel('prompts')}
        >
          <IconChat />
        </button>
        <button
          className={`tb-icon${openPanel === 'checkpoints' ? ' tb-icon--on' : ''}`}
          title="Checkpoints"
          onClick={() => togglePanel('checkpoints')}
        >
          <IconHistory />
        </button>
        <button
          className={`tb-icon${followAgent ? ' tb-icon--on' : ''}`}
          title="Follow the active agent (auto-pan the camera)"
          onClick={() => setFollowAgent(!followAgent)}
        >
          <IconFollow />
        </button>
      </div>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        <UsagePill />
        <button className="tb-btn" onClick={() => setPaletteOpen(true)} title="Command palette">
          <IconSearch /> Commands <span className="kbd">⌘K</span>
        </button>
        <button className="tb-btn" onClick={() => void openFile()}>
          <IconFolder /> Open <span className="kbd">⌘O</span>
        </button>
        <button className="tb-btn" onClick={() => void saveActive()}>
          <IconSave /> Save <span className="kbd">⌘S</span>
        </button>
        <button className="tb-btn tb-btn--accent" onClick={() => void newTab()}>
          <IconPlus /> New
        </button>
      </div>
    </header>
  )
}
