import { useStore, selectActive } from '../store/workspace'
import { baseName } from '../lib/backend'
import { IconMark, IconFolder, IconSave, IconPlus, IconSearch } from './icons'
import { UsagePill } from './UsagePill'

export function TopBar() {
  const ws = useStore(selectActive)
  const newTab = useStore((s) => s.newTab)
  const openFile = useStore((s) => s.openFile)
  const saveActive = useStore((s) => s.saveActive)
  const setActiveDir = useStore((s) => s.setActiveDir)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)

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
