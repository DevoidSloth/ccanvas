import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import {
  proxyAvailable,
  openExternal,
  proxyUrl,
  pickPath,
  readFile,
  watchPath,
  resolvePath,
  baseName,
  isAbsolutePath,
} from '../lib/backend'
import { IconReload, IconWeb, IconFile } from '../ui/icons'

// Web preview widget. Two modes, stored on the same widget:
//   • URL  (el.url)  — an http(s) page in an iframe. Localhost dev servers embed
//     directly; sites that send X-Frame-Options / CSP load through the backend
//     proxy (which strips those headers) or open in a real browser.
//   • File (el.path) — a local .html file rendered via the iframe's srcDoc from
//     its contents (read through the backend), watched on disk for live reload.
// The two are mutually exclusive; setting one clears the other.

function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  if (/^localhost(:\d+)?(\/|$)/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v))
    return `http://${v}`
  if (/^\d{2,5}(\/|$)/.test(v)) return `http://localhost:${v}`
  return `https://${v}`
}

const isLocal = (u: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(u)

// Treat an input as a local file (not a URL) when it has no http(s) scheme and
// is either an absolute path or ends in .htm/.html (e.g. `dist/index.html`).
function looksLikeLocalFile(v: string): boolean {
  if (/^https?:\/\//i.test(v)) return false
  return isAbsolutePath(v) || /\.html?($|[?#])/i.test(v)
}

export function WebBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const [input, setInput] = useState(el.url ?? el.path ?? '')
  const [src, setSrc] = useState(el.url ?? '')
  const [proxied, setProxied] = useState(false)
  const [canProxy, setCanProxy] = useState(false)
  const [fileHtml, setFileHtml] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  const fileMode = !!el.path
  const abs = resolvePath(el.cwd, el.path ?? '')

  useEffect(() => {
    setInput(el.url ?? el.path ?? '')
    setSrc(el.url ?? '')
  }, [el.url, el.path])

  // the proxy lives on the Node server (port 7531); probe whether it's running
  useEffect(() => {
    let alive = true
    void proxyAvailable().then((on) => alive && setCanProxy(on))
    return () => {
      alive = false
    }
  }, [])

  // file mode: load the file's contents and re-load whenever it changes on disk
  const loadFile = useCallback(async () => {
    if (!abs) return
    const content = await readFile(abs)
    setFileHtml((prev) => (content !== prev ? content : prev))
  }, [abs])

  useEffect(() => {
    if (!el.path) {
      setFileHtml(null)
      return
    }
    void loadFile()
    let dispose: (() => void) | null = null
    let cancelled = false
    void watchPath(abs, () => void loadFile()).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [el.path, abs, loadFile])

  // navigate the bar — route to file mode or URL mode based on the input
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
    setSrc(url)
    // remote sites usually block framing — default to the proxy when available
    setProxied(canProxy && !isLocal(url))
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.url = url
      x.path = undefined
    })
  }

  // file button — native open dialog filtered to HTML, falls back to nothing
  const openLocalFile = async () => {
    const p = await pickPath({ name: 'HTML', extensions: ['html', 'htm'] })
    if (!p) return
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.path = p
      x.url = undefined
      x.title = baseName(p)
    })
  }

  const effectiveSrc = src ? (proxied && canProxy ? proxyUrl(src) : src) : ''
  const externalTarget = fileMode ? abs : src

  const reload = () => {
    if (fileMode) void loadFile()
    else if (frameRef.current) frameRef.current.src = effectiveSrc
  }

  return (
    <div className="web">
      <div className="web__bar">
        <button className="web__nav" title="Reload" onClick={reload}>
          <IconReload />
        </button>
        <button
          className={`web__nav${fileMode ? ' web__nav--on' : ''}`}
          title="Open a local HTML file (live-reloads on save)"
          onClick={() => void openLocalFile()}
        >
          <IconFile />
        </button>
        <input
          className="web__url"
          value={input}
          placeholder="localhost:3000  ·  url  ·  ./index.html…"
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') go(input)
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {fileMode && (
          <span className="web__live" title="Live-reloading on file change">
            <span className="web__live-dot" />
            live
          </span>
        )}
        {!fileMode && canProxy && (
          <button
            className={`web__nav web__toggle${proxied ? ' web__toggle--on' : ''}`}
            title={
              proxied
                ? 'Loading through the proxy (strips framing headers)'
                : 'Load through the proxy so sites that block embedding still show'
            }
            onClick={() => setProxied((p) => !p)}
          >
            proxy
          </button>
        )}
        <button
          className="web__nav"
          title="Open in your browser"
          disabled={!externalTarget}
          onClick={() => externalTarget && void openExternal(externalTarget)}
        >
          ↗
        </button>
      </div>
      {fileMode ? (
        fileHtml != null ? (
          <iframe
            ref={frameRef}
            className="web__frame"
            srcDoc={fileHtml}
            title={el.title}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox allow-presentation"
            style={{ pointerEvents: active ? 'auto' : 'none' }}
          />
        ) : (
          <div className="web__empty">
            <IconFile className="" />
            <div>
              loading <code>{baseName(el.path ?? '')}</code>…
              <br />
              if this persists, the backend is offline or the file is missing.
            </div>
          </div>
        )
      ) : effectiveSrc ? (
        <iframe
          ref={frameRef}
          className="web__frame"
          src={effectiveSrc}
          title={el.title}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox allow-presentation"
          style={{ pointerEvents: active ? 'auto' : 'none' }}
        />
      ) : (
        <div className="web__empty">
          <IconWeb className="" />
          <div>
            Enter a URL above, or open a local <b>.html</b> file with the{' '}
            <b>file</b> button — it live-reloads on save.
            <br />
            Local dev servers embed directly (e.g. localhost:5173).
            <br />
            Other sites: use <b>proxy</b> or <b>↗</b> to open in a browser.
          </div>
        </div>
      )}
    </div>
  )
}
