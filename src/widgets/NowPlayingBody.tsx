import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { isTauri, openExternal } from '../lib/backend'
import {
  useNowPlaying,
  setNowPlayingDemand,
  dropNowPlayingDemand,
  control,
  showSource,
  positionNow,
  formatTime,
  nextRepeat,
  tintOf,
  SOURCE_LABEL,
  type Command,
  type NowPlaying,
  type Source,
  type Track,
} from '../lib/nowplaying'
import {
  IconMusic,
  IconPlay,
  IconPause,
  IconPrevTrack,
  IconNextTrack,
  IconShuffle,
  IconRepeat,
  IconRepeatOne,
  IconHeart,
  IconVolume,
} from '../ui/icons'

// Now playing: the track Spotify or Music is on, with its transport, a seek
// bar, volume, shuffle and repeat. Reading and polling live in
// lib/nowplaying.ts; this widget only tells it whether it's on screen. Nothing
// it shows is saved with the canvas.
//
// One tree for every size: container queries on .np (global.css) rearrange it
// into a strip, the compact default, a tall layout with the artwork on top, or
// a big focus-mode layout. Nothing is measured from JS.

const AUTOMATION_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function NowPlayingBody({
  el,
  visible,
  active,
}: {
  el: WidgetElement
  visible: boolean
  active: boolean
}) {
  useEffect(() => setNowPlayingDemand(el.id, visible), [el.id, visible])
  useEffect(() => () => dropNowPlayingDemand(el.id), [el.id])
  const np = useNowPlaying((s) => s.np)
  const others = useNowPlaying((s) => s.others)
  return np.kind === 'track' ? <Player t={np.track} others={others} active={active} /> : <Empty np={np} />
}

// ---------- artwork ----------

/** Track artwork that cross-fades to the next one once it has loaded, and
 *  reports a soft tint sampled from it (when the image isn't cross-origin
 *  tainted: Spotify's CDN allows CORS, Music's local file may not). */
function Artwork({ src, onTint }: { src: string | null; onTint?: (c: string | null) => void }) {
  const [layers, setLayers] = useState<{ cur: string | null; next: string | null }>({ cur: src, next: null })
  const [ready, setReady] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  if (src !== (layers.next ?? layers.cur)) {
    // nothing on screen to fade from: show it straight away
    setLayers((l) => (src && l.cur && l.cur !== broken ? { cur: l.cur, next: src } : { cur: src, next: null }))
  }
  const latest = useRef(src)
  latest.current = src
  useEffect(() => {
    if (!src) onTint?.(null)
  }, [src, onTint])

  const sample = (img: HTMLImageElement) => {
    if (!onTint || img.getAttribute('src') !== latest.current) return
    onTint(sampleTint(img))
  }
  const img = (s: string, next: boolean) => (
    <img
      key={s}
      src={s}
      alt=""
      draggable={false}
      crossOrigin={/^https?:/.test(s) ? 'anonymous' : undefined}
      className={next ? `np-art__next${ready === s ? ' is-in' : ''}` : undefined}
      onLoad={(e) => {
        if (next) setReady(s)
        sample(e.currentTarget)
      }}
      onError={() => {
        setBroken(s)
        if (next) setLayers({ cur: null, next: null })
        if (s === latest.current) onTint?.(null)
      }}
      onAnimationEnd={next ? () => setLayers({ cur: s, next: null }) : undefined}
    />
  )
  const cur = layers.cur && layers.cur !== broken ? layers.cur : null
  return (
    <>
      {cur ? img(cur, false) : <IconMusic />}
      {layers.next && layers.next !== broken && img(layers.next, true)}
    </>
  )
}

function sampleTint(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 12
    const g = c.getContext('2d', { willReadFrequently: true })
    if (!g) return null
    g.drawImage(img, 0, 0, 12, 12)
    return tintOf(g.getImageData(0, 0, 12, 12).data)
  } catch {
    return null // a tainted canvas: no tint
  }
}

// ---------- the player ----------

function Player({ t, others, active }: { t: Track; others: Source[]; active: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const [tint, setTint] = useState<string | null>(null)
  const send = (c: Command) => void control(t.source, c)
  const label = SOURCE_LABEL[t.source]

  // the active widget takes the keys, like the video player
  useEffect(() => {
    if (active && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // a focused button handles its own Space and Enter
    if ((e.key === ' ' || e.key === 'Enter') && (e.target as HTMLElement).closest('button')) return
    const k = e.key
    let c: Command | null = null
    if (k === 'ArrowLeft' || k === 'ArrowRight')
      c = { do: 'seek', ms: positionNow(t) + (k === 'ArrowLeft' ? -5000 : 5000) }
    else if (k === ' ') c = { do: 'playpause' }
    else if (k === 'ArrowUp' || k === 'ArrowDown')
      c = { do: 'volume', value: (t.muted ? 0 : t.volume) + (k === 'ArrowUp' ? 5 : -5) }
    else if (k === 'm' || k === 'M') c = { do: 'mute', on: !(t.muted || t.volume === 0) }
    if (!c) return
    e.preventDefault()
    e.stopPropagation()
    send(c)
  }

  return (
    <div
      ref={root}
      className={`np np--track${t.playing ? ' is-playing' : ''}${tint ? ' has-tint' : ''}`}
      style={tint ? ({ ['--np-tint' as string]: tint } as React.CSSProperties) : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="np__grid">
        <div className="np__art-slot">
          <div className="np__art">
            <Artwork src={t.artwork} onTint={setTint} />
          </div>
        </div>
        <div className="np__meta">
          <div className="np__swap" key={`${t.source}:${t.id || t.title}`}>
            <div className="np__track" title={t.title}>
              {t.title || 'Untitled'}
            </div>
            {t.artist && (
              <div className="np__artist" title={t.artist}>
                {t.artist}
              </div>
            )}
          </div>
          <div className="np__source">
            <span className="np__source-name" title={t.album || undefined}>
              {label}
              {!t.playing && ' · paused'}
            </span>
            {others.map((o) => (
              <button key={o} className="np__switch" title={`Show ${SOURCE_LABEL[o]} instead`} onClick={() => showSource(o)}>
                {SOURCE_LABEL[o]}
              </button>
            ))}
          </div>
        </div>
        <Scrubber t={t} />
        <div className="np__row">
          {t.liked === null ? (
            <span className="np__like np__like--none" aria-hidden />
          ) : (
            <button
              className={`np__btn np__like${t.liked ? ' is-on' : ''}`}
              title={t.liked ? 'Remove from favourites' : 'Favourite'}
              aria-pressed={t.liked}
              onClick={() => send({ do: 'like', on: !t.liked })}
            >
              <IconHeart filled={t.liked} />
            </button>
          )}
          <div className="np__transport">
            <button
              className={`np__btn np__mode${t.shuffle ? ' is-on' : ''}`}
              title={t.shuffle ? 'Shuffle is on' : 'Shuffle'}
              aria-pressed={t.shuffle}
              onClick={() => send({ do: 'shuffle', on: !t.shuffle })}
            >
              <IconShuffle />
            </button>
            <Transport t={t} />
            <button
              className={`np__btn np__mode${t.repeat !== 'off' ? ' is-on' : ''}`}
              title={t.repeat === 'one' ? 'Repeating this track' : t.repeat === 'all' ? 'Repeat is on' : 'Repeat'}
              aria-pressed={t.repeat !== 'off'}
              onClick={() => send({ do: 'repeat', mode: nextRepeat(t.source, t.repeat) })}
            >
              {t.repeat === 'one' ? <IconRepeatOne /> : <IconRepeat />}
            </button>
          </div>
          <Volume t={t} />
        </div>
      </div>
    </div>
  )
}

function Transport({ t }: { t: Track }) {
  return (
    <>
      <button className="np__btn np__prev" title="Previous" onClick={() => void control(t.source, { do: 'previous' })}>
        <IconPrevTrack />
      </button>
      <button
        className="np__btn np__btn--main"
        title={t.playing ? 'Pause' : 'Play'}
        onClick={() => void control(t.source, { do: 'playpause' })}
      >
        {t.playing ? <IconPause /> : <IconPlay />}
      </button>
      <button className="np__btn np__next" title="Next" onClick={() => void control(t.source, { do: 'next' })}>
        <IconNextTrack />
      </button>
    </>
  )
}

/** Drag along a horizontal bar: the fraction under the pointer as it moves,
 *  and where it was let go. Pointer capture keeps it working off the bar. */
function useDrag(onMove: (f: number) => void, onEnd: (f: number | null) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  const fracAt = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return r.width > 0 ? clamp01((x - r.left) / r.width) : 0
  }
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      ref.current!.setPointerCapture(e.pointerId)
      drag.current = e.pointerId
      ref.current!.classList.add('is-dragging')
      onMove(fracAt(e.clientX))
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (drag.current === e.pointerId) onMove(fracAt(e.clientX))
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (drag.current !== e.pointerId) return
      drag.current = null
      ref.current!.classList.remove('is-dragging')
      onEnd(fracAt(e.clientX))
    },
    onLostPointerCapture: () => {
      if (drag.current === null) return
      drag.current = null
      ref.current?.classList.remove('is-dragging')
      onEnd(null)
    },
  }
  return { ref, dragging: () => drag.current !== null, handlers }
}

/** Put the progress line at the track's position and let it run on its own
 *  (a linear WAAPI animation to the end) while the track plays. */
function anchor(run: HTMLElement, t: Track, at = positionNow(t)) {
  for (const a of run.getAnimations()) a.cancel()
  const d = t.durationMs
  const p = d > 0 ? clamp01(at / d) : 0
  const from = `translateX(${(p - 1) * 100}%)`
  run.style.transform = from
  if (!t.playing || d <= 0 || p >= 1) return
  run.animate([{ transform: from }, { transform: 'translateX(0%)' }], {
    duration: d - at,
    easing: 'linear',
    fill: 'forwards',
  })
}

function Scrubber({ t }: { t: Track }) {
  const run = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const d = t.durationMs
  const paint = (f: number) => {
    if (!run.current || !time.current) return
    for (const a of run.current.getAnimations()) a.cancel()
    run.current.style.transform = `translateX(${(f - 1) * 100}%)`
    time.current.textContent = formatTime(f * d)
  }
  const { ref, dragging, handlers } = useDrag(paint, (f) => {
    if (f !== null && d > 0) void control(t.source, { do: 'seek', ms: f * d })
    else if (run.current) anchor(run.current, t)
  })

  // each change of track state re-anchors the line; between them it runs alone
  useLayoutEffect(() => {
    if (run.current && !dragging()) anchor(run.current, t)
  }, [t]) // eslint-disable-line react-hooks/exhaustive-deps

  // the elapsed time is written into its text node on each new second, not
  // through React
  useEffect(() => {
    const node = time.current
    if (!node) return
    const write = () => {
      if (!dragging()) node.textContent = formatTime(positionNow(t))
    }
    write()
    if (!t.playing) return
    let every: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(
      () => {
        write()
        every = setInterval(write, 1000)
      },
      1000 - (positionNow(t) % 1000) + 15,
    )
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [t]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="np__scrub">
      <span className="np__time" ref={time}>
        {formatTime(positionNow(t))}
      </span>
      <div
        ref={ref}
        className={`np__bar${d > 0 ? '' : ' is-off'}`}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(d / 1000)}
        aria-valuenow={Math.round(positionNow(t) / 1000)}
        title={d > 0 ? 'Seek (← and → skip 5 seconds)' : undefined}
        {...(d > 0 ? handlers : {})}
      >
        <div className="np__rail">
          <div className="np__run" ref={run} />
        </div>
      </div>
      <span className="np__time np__time--total">{d > 0 ? formatTime(d) : ''}</span>
    </div>
  )
}

function Volume({ t }: { t: Track }) {
  const muted = t.muted || t.volume === 0
  const shown = muted ? 0 : t.volume
  const set = (v: number) => void control(t.source, { do: 'volume', value: v })
  const { ref, handlers } = useDrag(
    (f) => set(Math.round(f * 100)),
    () => {},
  )
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 20, PageDown: -20 }[e.key]
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? 100 : step !== undefined ? shown + step : null
    if (to === null) return
    e.preventDefault()
    e.stopPropagation()
    set(to)
  }
  return (
    <div className={`np__vol${muted ? ' is-muted' : ''}`}>
      <button
        className="np__btn"
        title={muted ? 'Unmute' : `Mute (volume ${t.volume})`}
        onClick={() => void control(t.source, { do: 'mute', on: !muted })}
      >
        <IconVolume level={muted ? 0 : t.volume < 50 ? 1 : 2} />
      </button>
      <div className="np__vol-pop">
        <div
          ref={ref}
          className="np__vbar"
          role="slider"
          tabIndex={0}
          aria-label={`${SOURCE_LABEL[t.source]} volume`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          title={`Volume ${shown}`}
          onKeyDown={onKeyDown}
          {...handlers}
        >
          <div className="np__vrail">
            <div className="np__vfill" style={{ transform: `scaleX(${shown / 100})` }} />
          </div>
          <div className="np__vknob" style={{ left: `${shown}%` }} />
        </div>
      </div>
    </div>
  )
}

// ---------- the other states ----------

function Empty({ np }: { np: NowPlaying }) {
  let head = ''
  let sub = ''
  let action: React.ReactNode = null
  if (np.kind === 'idle') {
    head = 'Nothing playing'
    sub = 'Play something in Spotify or Music.'
  } else if (np.kind === 'denied') {
    head = `ccanvas can't see ${SOURCE_LABEL[np.source]}`
    sub = 'Allow it under Privacy & Security › Automation in System Settings.'
    action = (
      <button className="np__link" onClick={() => void openExternal(AUTOMATION_SETTINGS)}>
        Open System Settings
      </button>
    )
  } else if (np.kind === 'unsupported') {
    head = 'Now playing works on macOS for now'
    sub = isTauri() ? '' : 'Open this canvas in the desktop app to see what Spotify or Music is playing.'
  }
  return (
    <div className={`np np--empty np--${np.kind}`}>
      <div className="np__grid">
        <div className="np__art-slot">
          <div className="np__art">
            <IconMusic />
          </div>
        </div>
        <div className="np__meta">
          {head && <div className="np__track">{head}</div>}
          {sub && <div className="np__hint">{sub}</div>}
          {action}
        </div>
      </div>
    </div>
  )
}
