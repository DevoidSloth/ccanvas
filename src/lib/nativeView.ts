// The real browser behind a web widget (desktop app only).
//
// A native webview can't follow the board's CSS transforms: it's a plain
// rectangle drawn on top of the whole page. This hook keeps one (Rust side:
// src-tauri/src/native_view.rs) exactly over a placeholder element:
//   • it opens once the placeholder is laid out and holding still (a focus
//     flight has landed), and closes when `want` goes false;
//   • in focus mode (`follow`) it tracks the placeholder's rect every frame
//     (window resize, strip changes, pane dividers); on the canvas it hides
//     the moment the placeholder moves (pan, zoom, drag) and comes back once
//     it holds still, at a page zoom matching the camera's;
//   • it stops short of the floating toolbar along the bottom edge, and hides
//     whenever anything else in the page covers the placeholder (menus, the
//     palette, another widget: being native, it would sit on top of them),
//     while `visible` is false, and while the window isn't visible;
//   • with `snapshots`, it keeps a recent picture of the page for the widget
//     to show while the view is hidden.

import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './backend'
import { useStore } from '../store/workspace'

/** Can this build host a native child webview? (desktop app only) */
export function nativeViewSupported(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && !/Android|iPhone|iPad/i.test(navigator.userAgent)
}

type Rect = { x: number; y: number; w: number; h: number }

export type NativeViewState = 'off' | 'opening' | 'live' | 'failed'

export type NativeViewHandlers = {
  /** the page navigated (or started/stopped loading) */
  onNav?: (url: string, loading: boolean) => void
  /** the page asked for a new window (target=_blank, window.open) */
  onNewWindow?: (url: string) => void
  /** ⌘⇧↵ pressed inside the page (keys there never reach the canvas) */
  onExitFocus?: () => void
}

type NavPayload = { id: string; url: string; loading: boolean }
type IdUrl = { id: string; url: string }

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5

/** Grid spacing (px) for the "is anything covering it?" probe: fine enough to
 *  catch a small context menu, coarse enough to stay cheap. */
const PROBE_STEP = 80

/** How tall a strip along the bottom may hold floating chrome (the toolbar,
 *  the zoom controls) that the view stops short of instead of hiding. */
const CHROME_BAND = 72

/** The element that sits over `host` at a probe point: the hit's outermost
 *  ancestor that isn't also an ancestor of `host` (e.g. the whole toolbar). */
function overlayOf(hit: Element, host: HTMLElement): Element {
  let el = hit
  while (el.parentElement && !el.parentElement.contains(host)) el = el.parentElement
  return el
}

/**
 * Does anything in the page sit over `host`? Probes a grid of points; each
 * must land on the placeholder itself (or the widget's own shield or resize corners).
 * Returns null when something covers it (a menu, the palette: hide the view),
 * else how many px to trim off its bottom so it ends above the floating chrome
 * along the bottom edge (0 when nothing is there).
 */
function probe(host: HTMLElement, r: DOMRect): number | null {
  const widget = host.closest('.widget')
  const cols = Math.max(2, Math.ceil(r.width / PROBE_STEP) + 1)
  const rows = Math.max(2, Math.ceil(r.height / PROBE_STEP) + 1)
  let trim = 0
  for (let i = 0; i < cols; i++)
    for (let j = 0; j <= rows; j++) {
      const x = r.left + 2 + ((r.width - 4) * i) / (cols - 1)
      // the extra last row sits just inside the bottom band
      const y = j === rows ? r.bottom - 24 : r.top + 2 + ((r.height - 4) * j) / (rows - 1)
      const hit = document.elementFromPoint(x, y)
      if (!hit) continue // off-window
      if (host.contains(hit)) continue
      // the widget's own click shield and resize corners don't count
      if (widget?.contains(hit) && hit.closest('.widget__shield, .widget__resize')) continue
      const top = overlayOf(hit, host).getBoundingClientRect().top
      if (top < r.bottom - CHROME_BAND) return null
      trim = Math.max(trim, r.bottom - top + 8)
    }
  return trim
}

/** The scale the placeholder is drawn at on screen (the canvas zoom). */
const drawnScale = (host: HTMLElement, r: DOMRect) => (host.offsetWidth ? r.width / host.offsetWidth : 1)

/** Laid out at its final size, no flight transform or clip in progress? */
function settled(host: HTMLElement, r: DOMRect): boolean {
  if (Math.abs(r.width - host.offsetWidth) > 0.5 || Math.abs(r.height - host.offsetHeight) > 0.5) return false
  const widget = host.closest<HTMLElement>('.widget')
  return !widget?.style.clipPath
}

export type NativeViewOptions = {
  /** may it show right now? (it stays alive, hidden, while false) */
  visible?: boolean
  /** track the placeholder while it moves (focus) instead of hiding (canvas) */
  follow?: boolean
  /** keep a recent snapshot of the page for while it's hidden */
  snapshots?: boolean
}

/** Frames the placeholder must hold still before the view (re)appears. */
const STILL_FRAMES = { follow: 2, canvas: 8 }
/** How often a shown view's snapshot is refreshed. */
const SNAPSHOT_MS = 1500

/**
 * Keep a native view over `hostRef` while `want` is true. `url` is where it
 * opens; later changes to `url` don't reload it (drive it with the returned
 * controls). When it closes, `onClose` gets the last URL it showed.
 */
export function useNativeView(
  id: string,
  url: string,
  want: boolean,
  hostRef: React.RefObject<HTMLElement | null>,
  onClose: (lastUrl: string | null) => void,
  handlers: NativeViewHandlers,
  opts: NativeViewOptions = {},
) {
  const [state, setState] = useState<NativeViewState>('off')
  const [shown, setShown] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const latest = useRef({ url, onClose, handlers, opts })
  latest.current = { url, onClose, handlers, opts }

  // events from the native side, for this widget only
  useEffect(() => {
    if (!want || !nativeViewSupported()) return
    const offs = [
      listen<NavPayload>('native-view:nav', (e) => {
        if (e.payload.id === id) latest.current.handlers.onNav?.(e.payload.url, e.payload.loading)
      }),
      listen<IdUrl>('native-view:new-window', (e) => {
        if (e.payload.id === id) latest.current.handlers.onNewWindow?.(e.payload.url)
      }),
      listen<{ id: string }>('native-view:exit-focus', (e) => {
        if (e.payload.id === id) latest.current.handlers.onExitFocus?.()
      }),
    ]
    return () => offs.forEach((p) => void p.then((off) => off()))
  }, [want, id])

  useEffect(() => {
    if (!want || !nativeViewSupported()) {
      setState('off')
      return
    }
    let alive = true
    // calls to the view go out in order (a zoom lands before the show)
    let chain: Promise<unknown> = Promise.resolve()
    const call = <T,>(cmd: string, args: Record<string, unknown>) => {
      const p = chain.then(() => invoke<T>(cmd, { id, ...args }))
      chain = p.catch(() => {})
      return p
    }
    let zoomSent = 1
    let snapTimer = 0
    const snap = () =>
      call<string | null>('native_view_snapshot', {}).then((s) => {
        if (alive && s) setSnapshot(s)
      })
    const setSnapping = (on: boolean) => {
      window.clearInterval(snapTimer)
      snapTimer = on && latest.current.opts.snapshots ? window.setInterval(() => void snap(), SNAPSHOT_MS) : 0
    }
    let opened = false
    let opening = false
    let sentRect: Rect | null = null
    let visible = false
    // px trimmed off the bottom for floating chrome; null: covered, keep hidden
    let trim: number | null = 0
    let stillFrames = 0
    let lastBox: Rect | null = null
    let frame = 0
    let raf = 0

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const host = hostRef.current
      if (!host) return
      const dr = host.getBoundingClientRect()
      const box = { x: dr.left, y: dr.top, w: dr.width, h: dr.height }
      const moved = !sameRect(lastBox, box)
      stillFrames = moved ? 0 : stillFrames + 1
      lastBox = box
      frame++
      // the probe costs a grid of hit tests: run it a few times a second, and
      // straight away whenever the box moved
      if (moved || frame % 8 === 0) trim = probe(host, dr)
      const rect = { ...box, h: box.h - (trim ?? 0) }
      const o = latest.current.opts
      const follow = o.follow ?? true
      // focus: wait for the flight in to land, at 100%. Canvas: any zoom (the
      // page zooms to match), as long as it holds still
      const scale = follow ? 1 : drawnScale(host, dr)
      const still = stillFrames >= (follow ? STILL_FRAMES.follow : STILL_FRAMES.canvas)
      const ready =
        (follow ? settled(host, dr) : scale >= 0.3) && rect.w > 40 && rect.h > 40
      // the layers overview covers the canvas from its very first frame: a view
      // drawn above the page must not wait for the next probe to hide
      const covered = !!useStore.getState().layerOverview && !follow
      const show =
        ready &&
        !covered &&
        !document.hidden &&
        trim !== null &&
        (o.visible ?? true) &&
        (still || (opened && follow && visible))
      if (!opened) {
        if (!show || opening) return
        opening = true
        setState('opening')
        void invoke('native_view_open', { id, url: latest.current.url, ...rect })
          .then(() => {
            if (!alive) {
              void invoke('native_view_close', { id })
              return
            }
            opened = true
            visible = true
            sentRect = rect
            setState('live')
            setShown(true)
            if (scale !== 1) {
              zoomSent = scale
              void call('native_view_zoom', { zoom: scale })
            }
            setSnapping(true)
            window.setTimeout(() => alive && visible && void snap(), 800)
          })
          .catch(() => {
            if (alive) setState('failed')
            cancelAnimationFrame(raf)
          })
        return
      }
      if (show && Math.abs(scale - zoomSent) > 0.001) {
        zoomSent = scale
        void call('native_view_zoom', { zoom: scale })
      }
      if (show && !sameRect(sentRect, rect)) {
        sentRect = rect
        void call('native_view_bounds', rect)
      }
      if (show !== visible) {
        visible = show
        setShown(show)
        setSnapping(show)
        // leaving because you worked elsewhere (not a move): picture it first
        if (!show && !moved && o.snapshots && !document.hidden)
          void snap().finally(() => !visible && void call('native_view_visible', { visible: false }))
        else void call('native_view_visible', { visible: show })
      }
    }
    raf = requestAnimationFrame(tick)

    // hide at once when the window goes away, without waiting for a frame
    // (hidden windows get no animation frames)
    const onVis = () => {
      if (document.hidden && opened && visible) {
        visible = false
        setShown(false)
        setSnapping(false)
        void call('native_view_visible', { visible: false })
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.clearInterval(snapTimer)
      setSnapshot(null)
      document.removeEventListener('visibilitychange', onVis)
      setShown(false)
      if (opened || opening)
        void invoke<string | null>('native_view_close', { id })
          .then((last) => latest.current.onClose(last ?? null))
          .catch(() => latest.current.onClose(null))
    }
    // `url` is only where the view opens; later navigation goes through the controls
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, id])

  const live = state === 'live'
  return {
    state,
    /** the native view is on screen right now (not hidden under a menu) */
    shown: live && shown,
    /** a recent picture of the page (with `snapshots`), for while it's hidden */
    snapshot,
    navigate: (to: string) => live && void invoke('native_view_navigate', { id, url: to }),
    back: () => live && void invoke('native_view_go', { id, action: 'back' }),
    forward: () => live && void invoke('native_view_go', { id, action: 'forward' }),
    reload: () => live && void invoke('native_view_go', { id, action: 'reload' }),
  }
}
