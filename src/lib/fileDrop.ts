// Drop files from the OS (Finder / Explorer) onto a terminal or Claude agent.
// Tauri intercepts native file drops, so the webview never sees them as HTML5
// `drop` events — we listen to the webview's drag-drop channel instead, find
// the terminal widget under the cursor, and paste the file paths in the same
// way a native terminal does. Claude Code turns a pasted image path into an
// image attachment.

import { useEffect } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri } from './backend'
import { sendTo } from './agents'
import { useStore } from '../store/workspace'

const TARGET = '[data-drop-term]'

/** Quote a path so a shell (and Claude's path detection) reads it as one token. */
function quotePath(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return `"${p}"`
  return p.replace(/([^A-Za-z0-9_./~@%+=:,-])/g, '\\$1')
}

/** Terminal/agent body under a physical-pixel point, if any. */
function termAt(x: number, y: number): HTMLElement | null {
  const dpr = window.devicePixelRatio || 1
  const hit = document.elementFromPoint(x / dpr, y / dpr)
  return (hit?.closest(TARGET) as HTMLElement | null) ?? null
}

export function useTerminalFileDrop(): void {
  useEffect(() => {
    if (!isTauri()) return
    let hot: HTMLElement | null = null
    const setHot = (el: HTMLElement | null) => {
      if (el === hot) return
      hot?.removeAttribute('data-drop-hot')
      el?.setAttribute('data-drop-hot', '')
      hot = el
    }
    const unlisten = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'leave') return setHot(null)
      const target = termAt(p.position.x, p.position.y)
      if (p.type === 'over' || p.type === 'enter') return setHot(target)
      // drop
      setHot(null)
      if (!target || p.paths.length === 0) return
      const id = target.closest<HTMLElement>('[data-widget-id]')?.dataset.widgetId
      if (!id) return
      // bracketed paste so a TUI ingests the paths as a paste (→ image attach)
      const text = p.paths.map(quotePath).join(' ') + ' '
      if (sendTo(id, `\x1b[200~${text}\x1b[201~`)) {
        const s = useStore.getState()
        s.setSelection([id])
        s.setActiveWidget(id)
      }
    })
    return () => {
      setHot(null)
      void unlisten.then((off) => off())
    }
  }, [])
}
