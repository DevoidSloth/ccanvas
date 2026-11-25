// Which terminals draw with WebGL instead of xterm's DOM renderer.
//
// The DOM renderer draws every character with the font. Block elements
// (▀ ▄ █ ▌ …) then cover only the font's own box, not the cell, which is taller
// with a line height above 1: TUIs that paint pixel art in half blocks (rootop,
// btop, image viewers) show a stripe of background in every row. The WebGL
// renderer draws block elements, box drawing and powerline glyphs itself, edge
// to edge, and is much faster at full-screen redraws.
//
// It costs a WebGL context and a drawing buffer sized to the terminal at its
// supersampled font, so it goes where it pays: a full-screen program (the
// alternate screen) that is on screen, within a pixel budget. Browsers keep only
// about 16 live contexts per page and silently drop the oldest past that, so a
// small pool hands them out and takes the least recently used one back.

/** Live WebGL terminals at most. */
export const GPU_POOL = 8
/** How long a hidden terminal keeps its WebGL renderer (ms): long enough
 *  that flicking between layers never rebuilds one. */
export const GPU_HIDDEN_KEEP = 30_000
/** Largest drawing buffer, in device pixels, a WebGL terminal may have. */
export const GPU_MAX_PIXELS = 4096 * 4096
/** Largest side of that buffer (WebGL canvases are capped near 16k). */
export const GPU_MAX_SIDE = 8192

/** Does a terminal of this css size, drawn k× supersampled at this device
 *  pixel ratio, fit the WebGL budget? */
export function fitsGpu(cssW: number, cssH: number, k: number, dpr: number): boolean {
  const w = cssW * k * dpr
  const h = cssH * k * dpr
  return w > 0 && h > 0 && w <= GPU_MAX_SIDE && h <= GPU_MAX_SIDE && w * h <= GPU_MAX_PIXELS
}

type Holder = { at: number; revoke: () => void }
const held = new Map<string, Holder>()
let clock = 0

/** Take (or refresh) a WebGL slot for terminal `id`. When the pool is full the
 *  least recently used holder is revoked first: `revoke` is how this terminal
 *  gives its slot back when someone else needs it. */
export function acquireGpu(id: string, revoke: () => void): void {
  const mine = held.get(id)
  if (mine) {
    mine.at = ++clock
    mine.revoke = revoke
    return
  }
  while (held.size >= GPU_POOL) {
    let oldest: string | null = null
    let at = Infinity
    for (const [k, h] of held)
      if (h.at < at) {
        at = h.at
        oldest = k
      }
    if (oldest == null) break
    const h = held.get(oldest)!
    held.delete(oldest)
    h.revoke()
  }
  held.set(id, { at: ++clock, revoke })
}

/** Give terminal `id`'s slot back (no-op when it holds none). */
export function releaseGpu(id: string): void {
  held.delete(id)
}

/** For tests. */
export function gpuHolders(): string[] {
  return [...held.keys()]
}
