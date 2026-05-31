import { useState } from 'react'
import { useStore } from '../store/workspace'
import { IconClose, IconPlus } from './icons'

export function Tabs() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const switchTab = useStore((s) => s.switchTab)
  const closeTab = useStore((s) => s.closeTab)
  const newTab = useStore((s) => s.newTab)
  const renameTab = useStore((s) => s.renameTab)

  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <div className="tabs">
      {tabs.map((ws) => {
        const active = ws.id === activeTabId
        return (
          <div
            key={ws.id}
            className={`tab${active ? ' tab--active' : ''}`}
            onPointerDown={() => switchTab(ws.id)}
            onDoubleClick={() => setEditingId(ws.id)}
            title={ws.name}
          >
            {ws.dirty && <span className="tab__dirty" />}
            {editingId === ws.id ? (
              <input
                className="tab__name-input"
                defaultValue={ws.name}
                autoFocus
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  renameTab(ws.id, e.target.value.trim() || ws.name)
                  setEditingId(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <span className="tab__name">{ws.name}</span>
            )}
            <button
              className="tab__close"
              title="Close tab"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(ws.id)
              }}
            >
              <IconClose />
            </button>
          </div>
        )
      })}
      <button className="tab-add" title="New canvas (⌘N)" onClick={() => newTab()}>
        <IconPlus />
      </button>
    </div>
  )
}
