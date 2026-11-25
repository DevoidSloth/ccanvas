// In focus mode the focus strip is the only bar above a widget: the widget's
// title bar is hidden, and its parts render into the strip instead, through
// these slots (React portals). The strip owns the elements; the focused widget
// (WidgetFrame, and a web widget's address bar in WebBody) fills them.
//   • title   — the widget's icon, name and meters (or its stack's tabs)
//   • tools   — widget-specific controls that take the free space (web: the
//               address bar)
//   • actions — the widget's own buttons (lock, close, …)

import { useSyncExternalStore } from 'react'

export type FocusSlot = 'title' | 'tools' | 'actions'

const slots: Record<FocusSlot, HTMLElement | null> = { title: null, tools: null, actions: null }
const listeners = new Set<() => void>()

/** Ref callback for the strip: `ref={slotRef('title')}`. */
const refs = {} as Record<FocusSlot, (el: HTMLElement | null) => void>
export function slotRef(name: FocusSlot) {
  refs[name] ??= (el) => {
    if (slots[name] === el) return
    slots[name] = el
    listeners.forEach((l) => l())
  }
  return refs[name]
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The strip's element for `name`, or null while there's no strip. */
export function useFocusSlot(name: FocusSlot): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slots[name])
}

/** Portaled content keeps React's event bubbling (to the widget and the
 *  canvas), so its wrapper stops the presses the canvas would act on. */
export const stopCanvas = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
  onWheel: (e: React.WheelEvent) => e.stopPropagation(),
}
