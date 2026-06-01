import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import {
  readBytes,
  listDir,
  resolvePath,
  baseName,
  watchPath,
  pickPath,
  revealPath,
  type DirEntry,
} from '../lib/backend'
import { IconReload, IconExternal, IconPlot } from '../ui/icons'
import { IMAGE_EXTENSIONS, PLOT_EXTENSIONS } from '../lib/filetypes'

// Live figure viewer. Point it at an image file (png/svg/jpg/…) and it shows
// that figure, live-reloading whenever the file is rewritten — the natural fit
// for "agent runs a script that saves fig.png; watch it update on the canvas".
// Point it at a folder instead and it lists the figures inside, newest first,
// auto-following the most recent unless you pick one. Zoom with the wheel, pan
// by dragging, double-click to reset.

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
}

const extOf = (p: string) => p.toLowerCase().split('.').pop() ?? ''
const isImageExt = (p: string) => IMAGE_EXTENSIONS.includes(extOf(p))
const isPlotExt = (p: string) => PLOT_EXTENSIONS.includes(extOf(p))

type View = { scale: number; tx: number; ty: number }
const RESET: View = { scale: 1, tx: 0, ty: 0 }

export function PlotBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')
  // file mode when the path points at an image/pdf; otherwise treat as a folder
  const fileMode = !!el.path && isPlotExt(el.path)

  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [pathInput, setPathInput] = useState('')
  const urlRef = useRef<string | null>(null)

  // the path of the image actually being displayed
  const shown = fileMode ? abs : selected

  // ---- folder listing (directory mode), newest first ----
  const relist = useCallback(async () => {
    if (fileMode || !abs) return
    const list = await listDir(abs)
    if (!list) {
      setEntries(null)
      return
    }
    const imgs = list
      .filter((e) => !e.is_dir && isImageExt(e.name))
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    setEntries(imgs)
    setSelected((cur) => {
      if (auto || !cur || !imgs.some((e) => e.path === cur)) return imgs[0]?.path ?? null
      return cur
    })
  }, [abs, fileMode, auto])

  useEffect(() => {
    void relist()
  }, [relist])

  // ---- load the shown image's bytes → blob URL ----
  const loadImage = useCallback(async () => {
    if (!shown) {
      setUrl(null)
      setStatus('idle')
      return
    }
    setStatus('loading')
    const bytes = await readBytes(shown)
    if (!bytes) {
      setStatus('error')
      return
    }
    const mime = MIME[extOf(shown)] ?? 'application/octet-stream'
    // copy into a fresh ArrayBuffer so the Blob owns contiguous bytes
    const blob = new Blob([bytes.slice()], { type: mime })
    const next = URL.createObjectURL(blob)
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setUrl(next)
    setStatus('idle')
  }, [shown])

  useEffect(() => {
    void loadImage()
  }, [loadImage])

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  // ---- watch disk: a file in file mode, the folder in directory mode ----
  useEffect(() => {
    if (!abs) return
    let dispose: (() => void) | null = null
    let cancelled = false
    const onChange = () => {
      if (fileMode) void loadImage()
      else void relist()
    }
    void watchPath(abs, onChange).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [abs, fileMode, loadImage, relist])

  const setPath = (p: string) => {
    mutateElement(el.id, (w) => {
      ;(w as WidgetElement).path = p
      ;(w as WidgetElement).title = baseName(p)
    })
  }

  if (!el.path) {
    return (
      <div className="plot plot--empty">
        <div className="editor__pick">
          <div className="editor__pick-label">
            Watch a figure (png/svg/jpg/…) or a folder of figures (relative or absolute):
          </div>
          <input
            className="editor__path-input"
            placeholder="figures/loss.png"
            value={pathInput}
            spellCheck={false}
            onChange={(e) => setPathInput(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && pathInput.trim()) setPath(pathInput.trim())
            }}
          />
          <button
            className="data__browse"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async () => {
              const p = await pickPath({ name: 'Images', extensions: PLOT_EXTENSIONS })
              if (p) setPath(p)
            }}
          >
            Browse…
          </button>
        </div>
      </div>
    )
  }

  const isPdf = !!shown && extOf(shown) === 'pdf'

  return (
    <div className="plot">
      <div className="plot__bar">
        <span className="plot__icon">
          <IconPlot />
        </span>
        {fileMode ? (
          <span className="plot__name" title={abs}>
            {baseName(el.path)}
          </span>
        ) : (
          <>
            <select
              className="data__part"
              value={selected ?? ''}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                setAuto(false)
                setSelected(e.target.value)
              }}
              title="figure"
            >
              {entries?.length ? (
                entries.map((e) => (
                  <option key={e.path} value={e.path}>
                    {e.name}
                  </option>
                ))
              ) : (
                <option value="">(no figures)</option>
              )}
            </select>
            <label className="plot__auto" title="follow the newest figure" onPointerDown={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              newest
            </label>
          </>
        )}
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {status === 'loading' && <span className="data__state">loading…</span>}
        <button
          className="data__btn"
          title="Reveal in file manager"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void revealPath(shown || abs)}
        >
          <IconExternal />
        </button>
        <button
          className="data__btn"
          title="Reload"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => (fileMode ? void loadImage() : void relist())}
        >
          <IconReload />
        </button>
      </div>

      {status === 'error' ? (
        <div className="data__msg">could not read image — backend offline or file missing</div>
      ) : !shown ? (
        <div className="data__msg">
          {entries == null ? 'backend offline, or not a folder' : 'no figures in this folder yet'}
        </div>
      ) : isPdf ? (
        url && <embed className="plot__pdf" src={url} type="application/pdf" />
      ) : (
        <ImageView url={url} name={shown} />
      )}
    </div>
  )
}

function ImageView({ url, name }: { url: string | null; name: string }) {
  const [view, setView] = useState<View>(RESET)
  const portRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  // reset framing when a different image is shown
  useEffect(() => setView(RESET), [name])

  const onWheel = (e: React.WheelEvent) => {
    const port = portRef.current
    if (!port) return
    const rect = port.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const scale = Math.min(40, Math.max(0.1, v.scale * factor))
      const k = scale / v.scale
      // keep the point under the cursor fixed (transform-origin is the center)
      return { scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const transform = useMemo(
    () => `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
    [view],
  )

  return (
    <div
      className="plot__port"
      ref={portRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setView(RESET)}
    >
      {url && (
        <img
          className="plot__img"
          src={url}
          alt={baseName(name)}
          draggable={false}
          style={{ transform }}
        />
      )}
      {view.scale !== 1 && (
        <span className="plot__zoom">{Math.round(view.scale * 100)}%</span>
      )}
    </div>
  )
}
