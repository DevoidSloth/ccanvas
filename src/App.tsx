import { useEffect } from 'react'
import { viewport, viewCenter, orderedTerminals, focusWidget, cycleTerminal, exitTerminal } from './lib/view'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './lib/backend'
import { useStore, selectActive } from './store/workspace'
import { zoomAt, screenToWorld } from './lib/geometry'
import { TopBar } from './ui/TopBar'
import { TermNumbers } from './ui/TermNumbers'
import { Canvas } from './canvas/Canvas'
import { Toolbar } from './ui/Toolbar'
import { Hud } from './ui/Hud'
import { Welcome } from './ui/Welcome'
import { SelectionBar } from './ui/SelectionBar'
import { CommandPalette } from './ui/CommandPalette'
import { AgentWizard } from './ui/AgentWizard'
import { AttentionBar } from './ui/AttentionBar'
import { Presentation } from './ui/Presentation'
import { ContextMenuHost, isEditableTarget } from './ui/ContextMenu'
import { Roster } from './ui/Roster'
import { PromptLibrary } from './ui/PromptLibrary'
import { Checkpoints } from './ui/Checkpoints'
import { MemoryPanel } from './ui/MemoryPanel'
import { CanvasSearch } from './ui/CanvasSearch'
import { TrackingBar } from './ui/TrackingBar'
import { FollowController } from './ui/FollowController'
import { useTerminalFileDrop } from './lib/fileDrop'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

// Anchor zooms at the centre of the canvas area (below the chrome).
const canvasCenter = viewCenter
function worldCenter() {
  return screenToWorld(canvasCenter(), selectActive(useStore.getState()).camera)
}

// ⌘W: close the widget you're in — the one holding keyboard focus (e.g. a
// terminal you're typing in), else the active one, else the selected widgets.
// With no widget left on any tab, quit the app.
function closeCurrentWidget() {
  const store = useStore.getState()
  const ws = store.active()
  const widgetIds = new Set(
    (ws?.elements ?? []).filter((e) => e.type === 'widget').map((e) => e.id),
  )
  const focused = (document.activeElement as HTMLElement | null)
    ?.closest?.('[data-widget-id]')
    ?.getAttribute('data-widget-id')
  let targets: string[] = []
  if (focused && widgetIds.has(focused)) targets = [focused]
  else if (store.activeWidgetId && widgetIds.has(store.activeWidgetId))
    targets = [store.activeWidgetId]
  else targets = store.selection.filter((id) => widgetIds.has(id))

  if (targets.length) {
    store.removeElements(targets)
    store.setActiveWidget(null)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return
  }
  const anyWidgets = store.tabs.some((t) => t.elements.some((e) => e.type === 'widget'))
  if (!anyWidgets) void invoke('quit_app')
}

export default function App() {
  useTerminalFileDrop()
  const tool = useStore((s) => s.tool)
  const openPanel = useStore((s) => s.openPanel)

  // Terminal navigation runs in the capture phase, ahead of xterm, so the keys
  // work while you're typing in a terminal and never reach the shell:
  //   ⌘1–9     jump to the Nth terminal (reading order) and click into it
  //   ⌘⇧] / ⌘⇧[  next / previous terminal
  //   ⌘Esc     click out of the current terminal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || (e.ctrlKey && !IS_MAC))) return
      if (e.altKey) return
      const stop = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const t = orderedTerminals()[Number(e.code.slice(5)) - 1]
        if (t) {
          stop()
          focusWidget(t.id)
        }
        return
      }
      if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        stop()
        cycleTerminal(e.code === 'BracketRight' ? 1 : -1)
        return
      }
      if (e.key === 'Escape' && useStore.getState().activeWidgetId) {
        stop()
        exitTerminal()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const editing =
        t.isContentEditable ||
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.closest('.xterm') != null
      // On macOS Ctrl belongs to the terminal (C-x, C-c, C-a…), so only ⌘
      // triggers canvas shortcuts there; elsewhere Ctrl is the modifier.
      const mod = e.metaKey || (e.ctrlKey && !IS_MAC)
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
      // ⌘T new terminal, ⌘⇧T new Claude agent — dropped at the centre of the
      // view and focused so you can type right away (works from inside a terminal)
      if (mod && key === 't' && !e.altKey) {
        e.preventDefault()
        const w = worldCenter()
        const id = store.spawnWidget(e.shiftKey ? 'agent' : 'terminal', w.x, w.y)
        store.setSelection([id])
        store.setActiveWidget(id)
        return
      }
      // ⌘⇧V opens a VS Code widget for this canvas's folder
      if (mod && e.shiftKey && key === 'v' && !e.altKey) {
        e.preventDefault()
        const w = worldCenter()
        const id = store.spawnWidget('vscode', w.x, w.y)
        store.setSelection([id])
        store.setActiveWidget(id)
        return
      }
      if (mod && key === 'k') {
        e.preventDefault()
        store.setPaletteOpen(!store.paletteOpen)
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
        store.zoomToSelection(viewport().vw, viewport().vh)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // the desktop menu's ⌘W item routes here instead of closing the window
  useEffect(() => {
    if (!isTauri()) return
    const unlisten = listen('menu:close-widget', closeCurrentWidget)
    return () => {
      void unlisten.then((off) => off())
    }
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
      <main className="app__main">
        <Canvas />
        <TermNumbers />
        <Welcome />
        <Toolbar />
        <SelectionBar />
        <AttentionBar />
        <TrackingBar />
        <Hud />
        <CommandPalette />
        <CanvasSearch />
        <AgentWizard />
        <Presentation />
        {openPanel === 'roster' && <Roster />}
        {openPanel === 'prompts' && <PromptLibrary />}
        {openPanel === 'checkpoints' && <Checkpoints />}
        {openPanel === 'memory' && <MemoryPanel />}
      </main>
      <ContextMenuHost />
      <FollowController />
    </div>
  )
}
