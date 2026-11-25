// Focus mode split into panes: two or more widgets side by side, each filling
// a column of the focus box. Pure geometry and list edits; the store keeps the
// pane list and sizes (FocusState), WidgetFrame lays each pane out.

export type Box = { x: number; y: number; w: number; h: number }

/** Width of the draggable gap between two panes. */
export const PANE_GAP = 8
/** Narrowest a pane may be dragged to, in px. */
export const MIN_PANE_W = 220
/** Most panes side by side. */
export const MAX_PANES = 4

export const equalSizes = (n: number): number[] => Array.from({ length: n }, () => 1 / n)

/** Each pane's box: the focus box cut into columns by `sizes` (fractions
 *  summing to 1), with a gap between neighbours. */
export function paneBoxes(box: Box, sizes: number[]): Box[] {
  const n = sizes.length
  if (n <= 1) return [box]
  const free = box.w - PANE_GAP * (n - 1)
  const out: Box[] = []
  let x = box.x
  sizes.forEach((s, i) => {
    // the last pane takes what's left, so rounding never leaves a sliver
    const w = i === n - 1 ? box.x + box.w - x : free * s
    out.push({ x, y: box.y, w, h: box.h })
    x += w + PANE_GAP
  })
  return out
}

/** Drag the divider after pane `i` by `dx` px: the two panes either side
 *  trade width, neither going under MIN_PANE_W. */
export function dragDivider(sizes: number[], i: number, dx: number, boxW: number): number[] {
  if (i < 0 || i >= sizes.length - 1) return sizes
  const free = boxW - PANE_GAP * (sizes.length - 1)
  if (free <= 0) return sizes
  const min = Math.min(MIN_PANE_W / free, (sizes[i] + sizes[i + 1]) / 2)
  const pair = sizes[i] + sizes[i + 1]
  const left = Math.max(min, Math.min(pair - min, sizes[i] + dx / free))
  const out = [...sizes]
  out[i] = left
  out[i + 1] = pair - left
  return out
}

/** Add `id` as a pane right after `after` (or at the end); sizes even out. */
export function addPane(panes: string[], after: string | null, id: string): string[] {
  if (panes.includes(id)) return panes
  const at = after ? panes.indexOf(after) : -1
  const out = [...panes]
  out.splice(at < 0 ? out.length : at + 1, 0, id)
  return out
}

/** Drop pane `id`; its width goes to its neighbours in proportion. */
export function removePane(panes: string[], sizes: number[], id: string): { panes: string[]; sizes: number[] } {
  const i = panes.indexOf(id)
  if (i < 0) return { panes, sizes }
  const rest = sizes.filter((_, j) => j !== i)
  const sum = rest.reduce((a, b) => a + b, 0) || 1
  return { panes: panes.filter((p) => p !== id), sizes: rest.map((s) => s / sum) }
}
