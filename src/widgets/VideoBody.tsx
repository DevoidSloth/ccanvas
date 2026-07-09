import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import {
  pickPath,
  mediaUrl,
  fileStreamUrl,
  transcodeUrl,
  probeMedia,
  mediaEndpoint,
  openExternal,
  resolvePath,
  baseName,
  isAbsolutePath,
  type MediaEndpoint,
  type MediaInfo,
} from '../lib/backend'
import { VIDEO_EXTENSIONS } from '../lib/filetypes'
import { IconReload, IconVideo, IconFile, IconExternal } from '../ui/icons'

// A VLC-style video player. Local files STREAM (HTTP Range under the web
// backend, the asset protocol under Tauri) so large files open fast and never
// OOM-crash the app. If the webview can't decode the codec/container (mkv, avi,
// HEVC, …), we automatically fall back to an on-the-fly ffmpeg TRANSCODE served
// by the backend — so essentially any format plays. If neither works (e.g. no
// backend / ffmpeg), we offer to open it in the system player.

const extOf = (p: string): string => p.toLowerCase().split('.').pop() ?? ''

function looksLikeLocalFile(v: string): boolean {
  if (/^https?:\/\//i.test(v)) return false
  return isAbsolutePath(v) || VIDEO_EXTENSIONS.includes(extOf(v))
}
function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  return `https://${v}`
}
function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const s = Math.floor(t % 60)
  const m = Math.floor(t / 60) % 60
  const h = Math.floor(t / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
// YouTube-style speed ladder
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

// --- inline control-bar glyphs (kept local; the shared icon set has none) ---
const G = (p: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor" style={{ display: 'block' }}>
    {p.children}
  </svg>
)
const PlayGlyph = () => <G><path d="M7 5l12 7-12 7V5z" /></G>
const PauseGlyph = () => <G><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></G>
const VolGlyph = () => <G><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 8.5a4 4 0 010 7M18.5 6a7 7 0 010 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></G>
const MuteGlyph = () => <G><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></G>
const FullGlyph = () => <G><path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></G>
const PipGlyph = () => <G><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><rect x="12" y="11" width="7" height="5" rx="1" /></G>
const ConvertGlyph = () => <G><path d="M4 8h11l-2.5-2.5M20 16H9l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></G>
const InfoGlyph = () => <G><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 11v5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /><circle cx="12" cy="7.7" r="1.15" /></G>
const LoopGlyph = () => <G><path d="M4 9a5 5 0 015-5h7l-2.5-2.5M20 15a5 5 0 01-5 5H8l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></G>
const SnapGlyph = () => <G><rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M8 6l1.2-2h5.6L16 6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></G>
const PrevFrameGlyph = () => <G><path d="M17 6v12L9 12l8-6z" /><rect x="5" y="5" width="2" height="14" rx="0.5" /></G>
const NextFrameGlyph = () => <G><path d="M7 6v12l8-6-8-6z" /><rect x="17" y="5" width="2" height="14" rx="0.5" /></G>

type Mode = 'native' | 'transcode'

export function VideoBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const addImage = useStore((s) => s.addImage)
  const spawnWidget = useStore((s) => s.spawnWidget)
  const [input, setInput] = useState(el.url ?? el.path ?? '')

  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wantPlay = useRef(false)

  const [endpoint, setEndpoint] = useState<MediaEndpoint | null>(null)
  const [endpointReady, setEndpointReady] = useState(false)
  const [mode, setMode] = useState<Mode>('native')
  const [baseOffset, setBaseOffset] = useState(0) // transcode seek anchor (s)
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null)

  const [loopOn, setLoopOn] = useState(false)
  const [speedMenu, setSpeedMenu] = useState(false)

  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0) // video.currentTime (relative)
  const [nativeDuration, setNativeDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [showBar, setShowBar] = useState(true)
  const [loading, setLoading] = useState(false)
  const [showSpinner, setShowSpinner] = useState(false) // debounced loading
  const [error, setError] = useState(false)

  const fileMode = !!el.path
  const abs = resolvePath(el.cwd, el.path ?? '')
  const hasSource = fileMode || !!(el.url && el.url.trim())
  const canTranscode = fileMode && !!endpoint?.ffmpeg
  // Prefer the media server's /file (tested range streaming) over the asset
  // protocol. Wait until the endpoint probe settles before committing a file
  // src, so we don't load once via one URL then reload via the other (flash).
  const nativeSrc = !fileMode
    ? el.url || null
    : !endpointReady
      ? null
      : endpoint
        ? fileStreamUrl(endpoint.base, abs)
        : mediaUrl(abs)
  const src =
    fileMode && mode === 'transcode' && endpoint
      ? transcodeUrl(endpoint.base, abs, baseOffset)
      : nativeSrc
  const externalTarget = fileMode ? abs : el.url || ''
  const probedDuration = mediaInfo?.duration ?? null
  const fps = mediaInfo?.video?.fps ?? null

  // effective (real) duration + timeline position, accounting for transcode
  // mode where the streamed fMP4 has no duration and restarts at each seek
  const effDuration =
    mode === 'transcode'
      ? probedDuration ?? nativeDuration
      : nativeDuration || probedDuration || 0
  const displayCurrent = (mode === 'transcode' ? baseOffset : 0) + current
  const displayBuffered = (mode === 'transcode' ? baseOffset : 0) + buffered

  useEffect(() => {
    setInput(el.url ?? el.path ?? '')
  }, [el.url, el.path])

  // resolve the media backend once (embedded server under Tauri, Node in web)
  useEffect(() => {
    let alive = true
    void mediaEndpoint().then((e) => {
      if (!alive) return
      setEndpoint(e)
      setEndpointReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // debounce the buffering spinner: streaming/transcoding fires waiting↔playing
  // in bursts, so only show it if loading actually persists (kills the flicker)
  useEffect(() => {
    if (!loading) {
      setShowSpinner(false)
      return
    }
    const t = setTimeout(() => setShowSpinner(true), 400)
    return () => clearTimeout(t)
  }, [loading])

  // a new file → default back to native and ffprobe it for duration + info
  useEffect(() => {
    setMode('native')
    setBaseOffset(0)
    setMediaInfo(null)
    if (fileMode && endpoint) {
      let alive = true
      void probeMedia(endpoint.base, abs).then((r) => alive && setMediaInfo(r))
      return () => {
        alive = false
      }
    }
  }, [abs, fileMode, endpoint])

  // reset transport state whenever the effective source changes
  useEffect(() => {
    setPlaying(false)
    setCurrent(0)
    setNativeDuration(0)
    setBuffered(0)
    setError(false)
    setLoading(!!src)
  }, [src])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted, src])
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate, src])

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // close the speed menu on any outside click
  useEffect(() => {
    if (!speedMenu) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.('.video__speed')) setSpeedMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [speedMenu])

  useEffect(() => {
    if (active) wrapRef.current?.focus?.()
  }, [active])

  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setShowBar(true)
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowBar(false)
    }, 2600)
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => setError(true))
    else v.pause()
  }, [])

  const seekTo = (t: number) => {
    const v = videoRef.current
    const dur = effDuration || 0
    const target = Math.max(0, dur ? Math.min(dur - 0.2, t) : t)
    if (mode === 'transcode') {
      // non-seekable live stream → re-issue the transcode from the new offset
      wantPlay.current = true
      setCurrent(0)
      setBaseOffset(target)
    } else if (v) {
      v.currentTime = target
      setCurrent(target)
    }
    armHide()
  }
  const seekBy = (dt: number) => seekTo(displayCurrent + dt)

  const onProgress = () => {
    const v = videoRef.current
    if (!v) return
    try {
      const b = v.buffered
      let end = 0
      for (let i = 0; i < b.length; i++)
        if (b.start(i) <= v.currentTime + 0.01) end = Math.max(end, b.end(i))
      setBuffered(end)
    } catch {
      /* buffered can throw before metadata */
    }
  }

  const onVideoError = () => {
    // codec/container the webview can't decode → try the ffmpeg transcode once
    if (mode !== 'transcode' && canTranscode) {
      wantPlay.current = true
      setBaseOffset(0)
      setMode('transcode')
      return
    }
    setError(true)
    setLoading(false)
  }

  const maybeAutoplay = () => {
    if (wantPlay.current) {
      wantPlay.current = false
      void videoRef.current?.play().catch(() => {})
    }
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapRef.current?.requestFullscreen?.().catch(() => {})
  }
  const togglePip = async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await v.requestPictureInPicture()
    } catch {
      /* PiP unsupported / blocked */
    }
  }
  // step one frame (paused). Native only — a transcode stream isn't frame-exact.
  const frameStep = (dir: 1 | -1) => {
    const v = videoRef.current
    if (!v || mode === 'transcode') return
    v.pause()
    const dt = 1 / (fps && fps > 0 ? fps : 30)
    v.currentTime = Math.max(0, Math.min((effDuration || v.duration || 0) - 0.001, v.currentTime + dir * dt))
    setCurrent(v.currentTime)
  }

  // VLC-style snapshot → drop the current frame onto the canvas as an image
  const snapshot = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    try {
      const c = document.createElement('canvas')
      c.width = v.videoWidth
      c.height = v.videoHeight
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(v, 0, 0, c.width, c.height)
      const url = c.toDataURL('image/png')
      addImage(url, v.videoWidth, v.videoHeight, el.x + el.w + 60 + v.videoWidth / 4, el.y + el.h / 2)
    } catch {
      /* tainted canvas (cross-origin remote without CORS) — can't snapshot */
    }
  }

  const toggleTranscode = () => {
    if (mode === 'transcode') {
      setMode('native')
      setBaseOffset(0)
    } else {
      wantPlay.current = playing
      setBaseOffset(displayCurrent)
      setMode('transcode')
    }
  }

  // ---- source bar (URL / open local file) ----
  const go = (raw: string) => {
    const v = raw.trim()
    if (!v) return
    if (looksLikeLocalFile(v)) {
      setInput(v)
      mutateElement(el.id, (w) => {
        const x = w as WidgetElement
        x.path = v
        x.url = undefined
        x.title = baseName(v)
      })
      return
    }
    const url = normalizeUrl(v)
    setInput(url)
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.url = url
      x.path = undefined
    })
  }
  const openLocalFile = async () => {
    const p = await pickPath({ name: 'Video', extensions: VIDEO_EXTENSIONS })
    if (!p) return
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.path = p
      x.url = undefined
      x.title = baseName(p)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!src || error) return
    const k = e.key
    if (k === ' ' || k === 'k') {
      e.preventDefault(); e.stopPropagation(); togglePlay()
    } else if (k === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation(); seekBy(-5)
    } else if (k === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation(); seekBy(5)
    } else if (k === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation(); setVolume((v) => Math.min(1, v + 0.1)); setMuted(false)
    } else if (k === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation(); setVolume((v) => Math.max(0, v - 0.1))
    } else if (k === 'm') {
      e.stopPropagation(); setMuted((m) => !m)
    } else if (k === 'f') {
      e.stopPropagation(); toggleFullscreen()
    }
  }

  const pct = effDuration ? (displayCurrent / effDuration) * 100 : 0
  const bufPct = effDuration ? (displayBuffered / effDuration) * 100 : 0
  const seekable = mode === 'native' || effDuration > 0

  return (
    <div className="video">
      <div className="video__bar">
        <button className="video__nav" title="Reload" onClick={() => videoRef.current?.load()}>
          <IconReload />
        </button>
        <button
          className={`video__nav${fileMode ? ' video__nav--on' : ''}`}
          title="Open a local video file"
          onClick={() => void openLocalFile()}
        >
          <IconFile />
        </button>
        <input
          className="video__url"
          value={input}
          placeholder="https://…/clip.mp4  ·  ./demo.webm  ·  open a local file…"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') go(input)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {canTranscode && (
          <button
            className={`video__nav${mode === 'transcode' ? ' video__nav--on' : ''}`}
            title={
              mode === 'transcode'
                ? 'Transcoding with ffmpeg (any codec) — click for direct play'
                : 'Force ffmpeg transcode (use if playback fails)'
            }
            onClick={toggleTranscode}
          >
            <ConvertGlyph />
          </button>
        )}
        <button
          className="video__nav"
          title="Open in system player"
          disabled={!externalTarget}
          onClick={() => externalTarget && void openExternal(externalTarget)}
        >
          <IconExternal />
        </button>
      </div>

      {hasSource ? (
        <div
          ref={wrapRef}
          className={`video__stage${showBar ? '' : ' video__stage--hidebar'}`}
          tabIndex={active ? 0 : -1}
          onKeyDown={onKeyDown}
          onPointerMove={armHide}
          onPointerLeave={() => {
            if (videoRef.current && !videoRef.current.paused) setShowBar(false)
          }}
        >
          <video
            ref={videoRef}
            className="video__player"
            src={src ?? undefined}
            playsInline
            crossOrigin={fileMode ? 'anonymous' : undefined}
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onPlay={() => { setPlaying(true); armHide() }}
            onPause={() => { setPlaying(false); setShowBar(true) }}
            onLoadedMetadata={() => {
              const v = videoRef.current
              if (v) { setNativeDuration(v.duration || 0); v.volume = volume; v.playbackRate = rate }
              setLoading(false)
              maybeAutoplay()
            }}
            onLoadedData={maybeAutoplay}
            onTimeUpdate={() => setCurrent(videoRef.current?.currentTime ?? 0)}
            onProgress={onProgress}
            onWaiting={() => setLoading(true)}
            onPlaying={() => setLoading(false)}
            onCanPlay={() => { setLoading(false); maybeAutoplay() }}
            onVolumeChange={() => {
              const v = videoRef.current
              if (v) { setVolume(v.volume); setMuted(v.muted) }
            }}
            onEnded={() => {
              if (loopOn) {
                const v = videoRef.current
                if (mode === 'native' && v) {
                  v.currentTime = 0
                  void v.play().catch(() => {})
                } else if (v) {
                  // transcode stream can't seek back → re-fetch it from the start
                  wantPlay.current = true
                  if (baseOffset !== 0) setBaseOffset(0)
                  else v.load()
                }
                return
              }
              setPlaying(false)
              setShowBar(true)
            }}
            onError={onVideoError}
          />

          {error ? (
            <div className="video__overlay video__overlay--error">
              <IconVideo className="" />
              <div>
                {endpoint && !endpoint.ffmpeg
                  ? 'This codec needs transcoding — install ffmpeg (on PATH) to play it in-app.'
                  : 'This player can’t decode this file.'}
                <div className="video__err-sub">{baseName(externalTarget || 'video')}</div>
              </div>
              {externalTarget && (
                <button className="video__open-ext" onClick={() => void openExternal(externalTarget)}>
                  Open in system player
                </button>
              )}
            </div>
          ) : showSpinner || !src ? (
            <div className="video__overlay">
              <span className="video__spinner" />
              {mode === 'transcode' && <span className="video__badge">transcoding…</span>}
            </div>
          ) : !playing && !loading ? (
            <button className="video__big-play" onClick={togglePlay} aria-label="Play">
              <PlayGlyph />
            </button>
          ) : null}

          {mode === 'transcode' && !error && (
            <span className="video__mode-tag" title="Playing via ffmpeg transcode">ffmpeg</span>
          )}

          {!error && (
            <div className="video__controls">
              <div className={`video__scrub${seekable ? '' : ' video__scrub--disabled'}`}>
                <div className="video__scrub-buf" style={{ width: bufPct + '%' }} />
                <div className="video__scrub-played" style={{ width: pct + '%' }} />
                <input
                  className="video__scrub-input"
                  type="range"
                  min={0}
                  max={effDuration || 0}
                  step={0.1}
                  value={Math.min(displayCurrent, effDuration || 0)}
                  disabled={!seekable}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              </div>
              <div className="video__ctl-row">
                <button className="video__ctl" onClick={togglePlay} title="Play / pause (space)">
                  {playing ? <PauseGlyph /> : <PlayGlyph />}
                </button>
                {!playing && mode === 'native' && (
                  <>
                    <button className="video__ctl" onClick={() => frameStep(-1)} title="Previous frame">
                      <PrevFrameGlyph />
                    </button>
                    <button className="video__ctl" onClick={() => frameStep(1)} title="Next frame">
                      <NextFrameGlyph />
                    </button>
                  </>
                )}
                <div className="video__vol">
                  <button className="video__ctl" onClick={() => setMuted((m) => !m)} title="Mute (m)">
                    {muted || volume === 0 ? <MuteGlyph /> : <VolGlyph />}
                  </button>
                  <input
                    className="video__vol-input"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    onChange={(e) => { const v = Number(e.target.value); setVolume(v); setMuted(v === 0) }}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                </div>
                <span className="video__time">
                  {fmtTime(displayCurrent)} <span className="video__time-sep">/</span> {fmtTime(effDuration)}
                </span>
                <span className="video__ctl-spacer" />
                <div className="video__speed">
                  <button
                    className={`video__ctl video__ctl--text${speedMenu ? ' video__ctl--on' : ''}`}
                    onClick={() => setSpeedMenu((v) => !v)}
                    title="Playback speed"
                  >
                    {rate}×
                  </button>
                  {speedMenu && (
                    <div className="video__speed-menu" onPointerDown={(e) => e.stopPropagation()}>
                      <div className="video__speed-title">Speed</div>
                      {RATES.map((r) => (
                        <button
                          key={r}
                          className={`video__speed-item${r === rate ? ' video__speed-item--on' : ''}`}
                          onClick={() => { setRate(r); setSpeedMenu(false) }}
                        >
                          {r === 1 ? 'Normal' : `${r}×`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  className={`video__ctl${loopOn ? ' video__ctl--on' : ''}`}
                  onClick={() => setLoopOn((v) => !v)}
                  title="Loop"
                >
                  <LoopGlyph />
                </button>
                <button className="video__ctl" onClick={snapshot} title="Snapshot frame to canvas">
                  <SnapGlyph />
                </button>
                <button
                  className="video__ctl"
                  onClick={() =>
                    spawnWidget('mediainfo', el.x + el.w + 210, el.y + 200, {
                      path: el.path,
                      url: el.url,
                      cwd: el.cwd,
                      title: `${baseName(externalTarget || el.title || 'media')} · info`,
                    })
                  }
                  title="Media info (opens a panel)"
                >
                  <InfoGlyph />
                </button>
                <button className="video__ctl" onClick={() => void togglePip()} title="Picture in picture">
                  <PipGlyph />
                </button>
                <button
                  className="video__ctl"
                  onClick={toggleFullscreen}
                  title={fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
                >
                  <FullGlyph />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="video__empty">
          <IconVideo className="" />
          <div>
            Paste a video <b>URL</b> above, or open a local file with the{' '}
            <b>file</b> button.
            <br />
            Files stream (no full load) and, if the codec isn’t supported, are
            <b> transcoded</b> so almost any format plays.
          </div>
        </div>
      )}
    </div>
  )
}
