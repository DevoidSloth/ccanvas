import { useEffect } from 'react'
import { useStore, selectActive } from './store/workspace'
import type { Tool } from './lib/types'
import { zoomAt, screenToWorld } from './lib/geometry'
import { TopBar } from './ui/TopBar'
import { Tabs } from './ui/Tabs'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './ui/Toolbar'
import { Props } from './ui/Props'
import { Hud } from './ui/Hud'
import { Welcome } from './ui/Welcome'
import { SelectionBar } from './ui/SelectionBar'
import { CommandPalette } from './ui/CommandPalette'
import { Minimap } from './ui/Minimap'
import { AgentWizard } from './ui/AgentWizard'
import { AttentionBar } from './ui/AttentionBar'
import { Presentation } from './ui/Presentation'
import { ContextMenuHost, isEditableTarget } from './ui/ContextMenu'
import { Roster } from './ui/Roster'
import { PromptLibrary } from './ui/PromptLibrary'
import { Checkpoints } from './ui/Checkpoints'
import { CanvasSearch } from './ui/CanvasSearch'
import { TrackingBar } from './ui/TrackingBar'
import { FollowController } from './ui/FollowController'

// topbar (44) + tabs (38); keep in sync with --topbar-h / --tabs-h in global.css
const CHROME_H = 82

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'pan',
  t: 'text',
  p: 'pen',
  d: 'pen',
  a: 'arrow',
  r: 'rect',
  o: 'ellipse',
  f: 'frame',
  e: 'eraser',
}

// Anchor zooms at the centre of the canvas area (below the chrome).
function canvasCenter() {
  return { x: window.innerWidth / 2, y: (window.innerHeight - CHROME_H) / 2 }
}
function worldCenter() {
  return screenToWorld(canvasCenter(), selectActive(useStore.getState()).camera)
}

export default function App() {
  const tool = useStore((s) => s.tool)
  const openPanel = useStore((s) => s.openPanel)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const editing =
        t.isContentEditable ||
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.closest('.xterm') != null
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const store = useStore.getState()

      if (mod && key === 's') {
        e.preventDefault()
        void store.saveActive()
        return
      }
      if (mod && key === 'o') {
        e.preventDefault()
        void store.openFile()
        return
      }
      if (mod && key === 'n') {
        e.preventDefault()
        store.newTab()
        return
      }
      if (mod && key === 'k') {
        e.preventDefault()
        store.setPaletteOpen(true)
        return
      }
      // ⌘F opens canvas search — but only when not typing into a field or a
      // widget that owns find itself (Monaco editor, the terminal)
      if (mod && key === 'f' && !editing) {
        e.preventDefault()
        store.setSearchOpen(true)
        return
      }
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault()
        const cam = selectActive(store).camera
        const z = e.key === '0' ? 1 : e.key === '-' ? cam.zoom / 1.2 : cam.zoom * 1.2
        store.setCamera(zoomAt(cam, canvasCenter(), z))
        return
      }

      // clipboard / arrange — only when not typing into a field
      if (mod && !editing) {
        if (key === 'c') {
          store.copySelection()
          return
        }
        if (key === 'x') {
          e.preventDefault()
          store.cutSelection()
          return
        }
        if (key === 'v') {
          const w = worldCenter()
          store.pasteClipboard(w.x, w.y)
          return
        }
        if (key === 'd') {
          e.preventDefault()
          store.duplicateSelection()
          return
        }
        if (key === 'g') {
          e.preventDefault()
          if (e.shiftKey) store.ungroup()
          else store.group()
          return
        }
        if (key === 'l') {
          e.preventDefault()
          store.toggleLock()
          return
        }
        if (e.key === ']') {
          e.preventDefault()
          store.bringToFront(store.selection)
          return
        }
        if (e.key === '[') {
          e.preventDefault()
          store.sendToBack(store.selection)
          return
        }
        if (key === 'a') {
          e.preventDefault()
          store.setSelection(selectActive(store).elements.map((el) => el.id))
          return
        }
      }

      if (editing || mod) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        store.deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        if (store.presenting) store.setPresenting(false)
        store.setTool('select')
        store.clearSelection()
        return
      }
      // focus / zoom to the current selection
      if (e.key === '\\') {
        e.preventDefault()
        store.zoomToSelection(window.innerWidth, window.innerHeight - CHROME_H)
        return
      }
      const mapped = TOOL_KEYS[key]
      if (mapped) store.setTool(mapped)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // paste an image from the clipboard onto the canvas
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const editing =
        el?.isContentEditable ||
        el?.tagName === 'INPUT' ||
        el?.tagName === 'TEXTAREA' ||
        el?.closest?.('.xterm') != null
      if (editing) return
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/'),
      )
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      const reader = new FileReader()
      reader.onload = () => {
        const src = reader.result as string
        const img = new Image()
        img.onload = () => {
          const w = worldCenter()
          useStore.getState().addImage(src, img.naturalWidth, img.naturalHeight, w.x, w.y)
        }
        img.src = src
      }
      reader.readAsDataURL(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // suppress the webview's native context menu everywhere, so the app's own
  // right-click menus take over. Editable fields + the terminal keep the native
  // menu (for copy/paste); components that want a custom menu open one via an
  // onContextMenu handler, which has already run by the time this fires.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (isEditableTarget(e.target)) return
      e.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // warn before discarding unsaved work
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().tabs.some((w) => w.dirty)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div className="app" data-tool={tool}>
      <TopBar />
      <Tabs />
      <main className="app__main">
        <Canvas />
        <Welcome />
        <Toolbar />
        <Props />
        <SelectionBar />
        <AttentionBar />
        <TrackingBar />
        <Minimap />
        <Hud />
        <CommandPalette />
        <CanvasSearch />
        <AgentWizard />
        <Presentation />
        {openPanel === 'roster' && <Roster />}
        {openPanel === 'prompts' && <PromptLibrary />}
        {openPanel === 'checkpoints' && <Checkpoints />}
      </main>
      <ContextMenuHost />
      <FollowController />
    </div>
  )
}
