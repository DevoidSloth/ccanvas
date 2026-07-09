import { useEffect, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import {
  mediaEndpoint,
  probeMedia,
  resolvePath,
  baseName,
  type MediaInfo,
} from '../lib/backend'

// Media-information widget — VLC-style "Media Information" as its own resizable
// panel on the canvas. Probes its file with ffprobe (via the media backend) and
// lists container, video/audio codecs, resolution, fps, frame count, bitrates,
// colour metadata, per-track streams and container tags.

function fmtTime(t: number | null): string {
  if (t == null || !isFinite(t) || t < 0) return '—'
  const s = Math.floor(t % 60)
  const m = Math.floor(t / 60) % 60
  const h = Math.floor(t / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
function fmtBytes(n: number | null): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i > 0 && v < 100 ? 1 : 0)} ${u[i]}`
}
function fmtBitrate(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(n / 1000)} kbps`
}
const num = (n: number | null): string => (n == null ? '—' : n.toLocaleString())

function Row({ k, v }: { k: string; v: string }) {
  if (!v || v === '—') return null
  return (
    <div className="minfo__row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  )
}

const extOf = (p: string): string => p.toLowerCase().split('.').pop() ?? ''

export function MediaInfoBody({ el }: { el: WidgetElement }) {
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'nofile' | 'nobackend'>('loading')

  const isFile = !!el.path
  const abs = resolvePath(el.cwd, el.path ?? '')
  const name = baseName(el.path || el.url || el.title || 'media')

  useEffect(() => {
    if (!isFile) {
      setState('nofile')
      return
    }
    let alive = true
    setState('loading')
    void mediaEndpoint().then((ep) => {
      if (!alive) return
      if (!ep) {
        setState('nobackend')
        return
      }
      void probeMedia(ep.base, abs).then((r) => {
        if (!alive) return
        setInfo(r)
        setState('ok')
      })
    })
    return () => {
      alive = false
    }
  }, [abs, isFile])

  const v = info?.video
  const a = info?.audio
  const fmt = info?.format
  const res = v?.width && v?.height ? `${v.width} × ${v.height}` : '—'
  const fpsText = v?.fps != null ? `${v.fps.toFixed(3).replace(/\.?0+$/, '')} fps` : '—'
  const sampleText =
    a?.sampleRate != null ? `${(a.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : '—'
  const container = fmt?.name ?? (isFile ? extOf(abs) : null)

  return (
    <div className="minfo">
      <div className="minfo__file" title={el.path || el.url}>{name}</div>

      {state === 'loading' && <div className="minfo__note">reading metadata…</div>}
      {state === 'nofile' && (
        <div className="minfo__note">Open this from a video widget to inspect a file.</div>
      )}
      {state === 'nobackend' && (
        <div className="minfo__note">
          Needs the media backend (ffprobe / ffmpeg on PATH) to read metadata.
        </div>
      )}

      {state === 'ok' && info && (
        <div className="minfo__body">
          <div className="minfo__sec">General</div>
          <Row k="Container" v={container || '—'} />
          <Row k="Format" v={fmt?.longName || '—'} />
          <Row k="Duration" v={fmtTime(info.duration)} />
          <Row k="File size" v={fmtBytes(fmt?.size ?? null)} />
          <Row k="Overall bitrate" v={fmtBitrate(fmt?.bitRate ?? null)} />
          <Row k="Streams" v={num(fmt?.nbStreams ?? info.streams.length)} />

          {v && (
            <>
              <div className="minfo__sec">Video</div>
              <Row k="Codec" v={v.codec || '—'} />
              <Row k="Codec name" v={v.codecLong || '—'} />
              <Row k="Profile" v={[v.profile, v.level ? `L${v.level}` : ''].filter(Boolean).join(' · ') || '—'} />
              <Row k="Resolution" v={res} />
              <Row
                k="Coded size"
                v={v.codedWidth && v.codedHeight && (v.codedWidth !== v.width || v.codedHeight !== v.height)
                  ? `${v.codedWidth} × ${v.codedHeight}`
                  : '—'}
              />
              <Row k="Aspect ratio" v={v.aspect || '—'} />
              <Row k="Pixel aspect" v={v.sar || '—'} />
              <Row k="Frame rate" v={fpsText} />
              <Row k="Frames" v={num(v.frames)} />
              <Row k="Pixel format" v={v.pixFmt || '—'} />
              <Row k="Bit depth" v={v.bitDepth != null ? `${v.bitDepth}-bit` : '—'} />
              <Row k="Bitrate" v={fmtBitrate(v.bitRate)} />
              <Row k="Colour space" v={v.colorSpace || '—'} />
              <Row k="Colour range" v={v.colorRange || '—'} />
              <Row k="Colour primaries" v={v.colorPrimaries || '—'} />
              <Row k="Transfer" v={v.colorTransfer || '—'} />
              <Row k="Field order" v={v.fieldOrder || '—'} />
              <Row k="Language" v={v.language || '—'} />
            </>
          )}

          {a && (
            <>
              <div className="minfo__sec">Audio</div>
              <Row k="Codec" v={a.codec || '—'} />
              <Row k="Codec name" v={a.codecLong || '—'} />
              <Row k="Profile" v={a.profile || '—'} />
              <Row k="Channels" v={a.channelLayout || (a.channels != null ? String(a.channels) : '—')} />
              <Row k="Sample rate" v={sampleText} />
              <Row k="Bit depth" v={a.bitsPerSample != null ? `${a.bitsPerSample}-bit` : '—'} />
              <Row k="Bitrate" v={fmtBitrate(a.bitRate)} />
              <Row k="Language" v={a.language || '—'} />
            </>
          )}

          {info.streams.length > 1 && (
            <>
              <div className="minfo__sec">Streams ({info.streams.length})</div>
              {info.streams.map((s) => (
                <div className="minfo__stream" key={s.index ?? Math.random()}>
                  <span className="minfo__stream-idx">#{s.index}</span>
                  <span className="minfo__stream-label">{s.label || s.codec || s.type || 'stream'}</span>
                </div>
              ))}
            </>
          )}

          {fmt?.tags && Object.keys(fmt.tags).length > 0 && (
            <>
              <div className="minfo__sec">Tags</div>
              {Object.entries(fmt.tags)
                .slice(0, 20)
                .map(([k, val]) => (
                  <Row key={k} k={k} v={String(val)} />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
