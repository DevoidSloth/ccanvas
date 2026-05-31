import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

// A single, app-wide custom right-click menu — replaces the webview's native
// context menu. Components call openContextMenu(event, items) from an
// onContextMenu handler; <ContextMenuHost /> (mounted once in App) renders it.
// State lives in a tiny module-level store so any component can open a menu
// without threading props or context through the tree.

export type MenuItem =
  | { separator: true }
  | {
      label: string
      onClick?: () => void
      icon?: ReactNode
      /** right-aligned shortcut/hint text */
      hint?: string
      danger?: boolean
      disabled?: boolean
    }

type MenuState = { x: number; y: number; items: MenuItem[] } | null

let state: MenuState = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const getSnapshot = () => state

type Mouseish = {
  clientX: number
  clientY: number
  preventDefault?: () => void
  stopPropagation?: () => void
}

/** Open the context menu at the event's position with the given items. */
export function openContextMenu(e: Mouseish, items: MenuItem[]) {
  e.preventDefault?.()
  e.stopPropagation?.()
  const usable = items.filter((i) => 'separator' in i || i.label)
  if (!usable.length) return
  state = { x: e.clientX, y: e.clientY, items: usable }
  emit()
}

export function closeContextMenu() {
  if (state) {
    state = null
    emit()
  }
}

/** Targets that should keep the native menu (text editing / terminal paste). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el?.closest?.(
    'input, textarea, [contenteditable=""], [contenteditable="true"], .xterm',
  )
}

export function ContextMenuHost() {
  const snap = useSyncExternalStore(subscribe, getSnapshot)
  const menuRef = useRef<HTMLDivElement>(null)

  // Position is set straight from the click, then nudged in-place (before paint)
  // so the menu never spills past the viewport edge.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!snap || !el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    const x =
      snap.x + r.width + pad > window.innerWidth
        ? Math.max(pad, window.innerWidth - r.width - pad)
        : snap.x
    const y =
      snap.y + r.height + pad > window.innerHeight
        ? Math.max(pad, window.innerHeight - r.height - pad)
        : snap.y
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }, [snap])

  // Close on any interaction outside the menu.
  useEffect(() => {
    if (!snap) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    window.addEventListener('wheel', closeContextMenu, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
      window.removeEventListener('wheel', closeContextMenu)
    }
  }, [snap])

  if (!snap) return null

  return (
    <div
      ref={menuRef}
      className="ctxmenu"
      style={{ left: snap.x, top: snap.y }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {snap.items.map((item, i) =>
        'separator' in item ? (
          <div key={i} className="ctxmenu__sep" />
        ) : (
          <button
            key={i}
            className={`ctxmenu__item${item.danger ? ' ctxmenu__item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu()
              item.onClick?.()
            }}
          >
            <span className="ctxmenu__icon">{item.icon}</span>
            <span className="ctxmenu__label">{item.label}</span>
            {item.hint && <span className="ctxmenu__hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  )
}
