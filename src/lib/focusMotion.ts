// The focus-mode flight. A focused widget is laid out once at its final size
// (the focus box, at 100% scale), so a terminal reflows a single time; this
// module only animates *how it gets there*, FLIP-style: an even scale plus a
// moving position, and a clip on the bottom so the frame appears to grow from
// the widget's spot on the canvas without the text ever stretching. Nothing
// here touches the store; `onDone` is called when the flight lands.

type Rect = { x: number; y: number; w: number; h: number }

const IN_MS = 280
const OUT_MS = 240

const running = new Map<string, number>()

const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

// the spread's curve: quick out, long soft landing
const ease = (t: number) => 1 - Math.pow(1 - t, 4)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Stop a flight in progress (the widget left focus some other way). */
export function cancelFlight(id: string) {
  const raf = running.get(id)
  if (raf) cancelAnimationFrame(raf)
  running.delete(id)
}

/**
 * Fly a widget between its spot on the canvas (`home`, screen px) and the
 * focus `box` (screen px). The node must already be laid out at the box with
 * `transform: scale(1 / zoom)` (WidgetFrame does that while focused).
 */
export function flyFocus(
  id: string,
  dir: 'in' | 'out',
  node: HTMLElement,
  home: Rect,
  box: Rect,
  zoom: number,
  onDone?: () => void,
) {
  cancelFlight(id)
  const base = `scale(${1 / zoom})`
  const finish = () => {
    running.delete(id)
    node.style.clipPath = ''
    node.style.transform = dir === 'in' ? base : node.style.transform
    onDone?.()
  }
  if (reduceMotion()) {
    if (dir === 'out') apply(1)
    finish()
    return
  }
  const kHome = home.w / box.w
  // the widget's own height at its home scale, in box px
  const homeH = home.h / kHome
  function apply(p: number) {
    // p: 0 = home, 1 = focus box
    const k = lerp(kHome, 1, p)
    const x = lerp(home.x, box.x, p)
    const y = lerp(home.y, box.y, p)
    const visible = lerp(Math.min(homeH, box.h), box.h, p)
    node.style.transform = `translate(${(x - box.x) / zoom}px, ${(y - box.y) / zoom}px) scale(${k / zoom})`
    const clip = Math.max(0, box.h - visible)
    node.style.clipPath = clip > 0.5 ? `inset(0 0 ${clip}px 0 round 8px)` : ''
  }
  const dur = dir === 'in' ? IN_MS : OUT_MS
  const t0 = performance.now()
  apply(dir === 'in' ? 0 : 1)
  const tick = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    const e = ease(t)
    apply(dir === 'in' ? e : 1 - e)
    if (t < 1) running.set(id, requestAnimationFrame(tick))
    else finish()
  }
  running.set(id, requestAnimationFrame(tick))
}
