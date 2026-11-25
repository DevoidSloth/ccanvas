import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import {
  previewProxy,
  openExternal,
  proxyUrl,
  playerUrl,
  pickPath,
  readFile,
  watchPath,
  resolvePath,
  baseName,
  isTauri,
} from '../lib/backend'
import { isHttpUrl, isLocalUrl, hostOf, videoEmbed, appOnlySite, resolveAddress, searchQuery } from '../lib/weburl'
import { nativeViewSupported, useNativeView } from '../lib/nativeView'
import { setWebPage, usePrefetchSiteIcon } from '../lib/brandIcon'
import { focusWidget } from '../lib/view'
import { useFocusSlot, stopCanvas } from '../ui/focusSlots'
import { IconReload, IconWeb, IconFile, IconBack, IconForward, IconExternal, IconLock, IconSearch } from '../ui/icons'
import { useBrand } from './widgetIcons'

// Web widget. Two modes, stored on the same widget (setting one clears the other):
//   • URL  (el.url)  — an http(s) page. On the canvas it's an <iframe>: local
//     dev servers embed directly, remote sites load through the preview proxy
//     (framing headers stripped, no cookies: a preview), and video pages
//     (YouTube, Vimeo) play in the site's own embeddable player. In focus mode
//     (each pane, when split) a real native browser takes over the body
//     (lib/nativeView.ts), with one persistent profile so logins stick.
//     A "live" widget (el.live: the tag in the bar, and on by itself for full
//     JS apps like YouTube that the preview can't run) keeps that browser on
//     the canvas too: shown while you're in the widget and the camera holds
//     still, a snapshot of it otherwise.
//   • File (el.path) — a local .html file rendered via the iframe's srcDoc from
//     its contents (read through the backend), watched on disk for live reload.

/** What a video player's frame may do (the player page passes it on). */
const PLAYER_ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture'

const SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox allow-presentation'

/** The default title, replaced by the page's host once there is one. */
const DEFAULT_TITLE = 'web'

type History = { list: string[]; at: number }

export function WebBody({ el, active, onScreen }: { el: WidgetElement; active: boolean; onScreen: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  // in focus mode: one of the panes, and (unsplit) the one the strip is for
  const inPane = useStore((s) => !!s.focus?.panes.includes(el.id))
  const focused = useStore((s) => inPane && s.focus?.panes.length === 1)
  const [input, setInput] = useState(el.url ?? el.path ?? '')
  // where the page is now (the bar shows it unless you're typing)
  const [current, setCurrent] = useState(el.url ?? '')
  const [hist, setHist] = useState<History>(() => ({ list: el.url ? [el.url] : [], at: 0 }))
  const [loading, setLoading] = useState(false)
  const [proxyBase, setProxyBase] = useState<string | null>(null)
  const [fileHtml, setFileHtml] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const editing = useRef(false)

  // where it is now, for its icon on the card, the tile and the title bar
  useEffect(() => {
    if (current) setWebPage(el.id, current)
  }, [el.id, current])
  usePrefetchSiteIcon(current || undefined)

  const toolsSlot = useFocusSlot('tools')
  const inStrip = focused && !!toolsSlot
  const fileMode = !!el.path
  const abs = resolvePath(el.cwd, el.path ?? '')

  useEffect(() => {
    setInput(el.url ?? el.path ?? '')
    setCurrent(el.url ?? '')
    setHist((h) => (el.url && h.list[h.at] !== el.url ? push(h, el.url) : h))
  }, [el.url, el.path])

  // a fresh widget opens with its address bar ready to type into
  useEffect(() => {
    if (!el.url && !el.path) requestAnimationFrame(() => urlRef.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    void previewProxy().then((base) => alive && setProxyBase(base))
    return () => {
      alive = false
    }
  }, [])

  // ---- the native browser (focus panes, and live widgets on the canvas) ----
  const canNative = !fileMode && isHttpUrl(current) && nativeViewSupported()
  // a site the preview can't run turns live by itself
  useEffect(() => {
    if (el.live === undefined && el.url && appOnlySite(el.url) && nativeViewSupported())
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).live = true
      })
  }, [el.id, el.url, el.live, mutateElement])
  const liveOnCanvas = canNative && !!el.live && onScreen && !isLocalUrl(current)
  const nativeWanted = canNative && (inPane || liveOnCanvas)
  // on the canvas the view shows while you're in the widget; before that it
  // shows once by itself, just long enough to take a first snapshot
  const [warm, setWarm] = useState(false)
  const native = useNativeView(
    el.id,
    current,
    nativeWanted,
    hostRef,
    (last) => {
      // keep where you left off; only the URL is ever saved (and not once
      // the widget has switched to showing a local file)
      const now = stored(el.id)
      if (now && !now.path && last && isHttpUrl(last) && last !== now.url)
        mutateElement(el.id, (w) => {
          ;(w as WidgetElement).url = last
        })
    },
    {
      onNav: (url, isLoading) => {
        setLoading(isLoading)
        setCurrent(url)
        if (!editing.current) setInput(url)
      },
      onNewWindow: (url) => openBeside(el.id, url),
      onExitFocus: () => useStore.getState().exitFocus(),
    },
    // (a live widget keeps its picture fresh in focus too, for its way home)
    inPane
      ? { follow: true, snapshots: !!el.live }
      : { follow: false, visible: active || !warm, snapshots: true },
  )
  useEffect(() => {
    if (native.state !== 'live' || warm) return
    const t = window.setTimeout(() => setWarm(true), 2500)
    return () => window.clearTimeout(t)
  }, [native.state, warm])
  const nativeLive = native.state === 'live' || native.state === 'opening'

  // the preview proxy reports in-page link clicks so the bar and history follow
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      const d = e.data as { type?: unknown; url?: unknown } | null
      if (!d || d.type !== 'ccanvas-web-nav' || typeof d.url !== 'string' || !isHttpUrl(d.url)) return
      const url = d.url
      setCurrent(url)
      if (!editing.current) setInput(url)
      setHist((h) => (h.list[h.at] === url ? h : push(h, url)))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
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

  const setFile = (p: string) =>
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.path = p
      x.url = undefined
      x.title = baseName(p)
    })

  // navigate the bar: route to file mode or URL mode based on the input
  const go = (raw: string) => {
    // an address, a local file, or else a Google search (lib/weburl.ts)
    const a = resolveAddress(raw)
    if (!a) return
    if (a.kind === 'file') {
      setInput(a.path)
      setFile(a.path)
      return
    }
    const url = a.url
    setInput(url)
    if (native.state === 'live') {
      native.navigate(url)
      return
    }
    setCurrent(url)
    setHist((h) => push(h, url))
    mutateElement(el.id, (w) => {
      const x = w as WidgetElement
      x.url = url
      x.path = undefined
      if (!x.title || x.title === DEFAULT_TITLE || x.title === 'web preview') x.title = a.search ?? hostOf(url)
    })
  }

  // file button: native open dialog filtered to HTML
  const openLocalFile = async () => {
    const p = await pickPath({ name: 'HTML', extensions: ['html', 'htm'] })
    if (p) setFile(p)
  }

  const proxied = !!proxyBase && isHttpUrl(current) && !isLocalUrl(current)
  // a video plays in its site's player: in the desktop app through the proxy's
  // player page (it needs a referrer), in a browser framed directly
  const embed = fileMode ? null : videoEmbed(current)
  const appOnly = fileMode ? null : appOnlySite(current)
  const frameSrc = !current
    ? ''
    : embed
      ? isTauri() && proxyBase
        ? playerUrl(proxyBase, embed)
        : embed
      : proxied
        ? proxyUrl(proxyBase!, current)
        : current
  const externalTarget = fileMode ? abs : current
  // the preview frame loads too: from a new address until its load event
  // (only when a frame is actually shown: a placeholder never loads)
  const framed = !!frameSrc && !nativeWanted && !appOnly
  useEffect(() => {
    if (!nativeWanted) setLoading(framed)
  }, [frameSrc, framed, nativeWanted])
  const [editingBar, setEditingBar] = useState(false)
  const brand = useBrand(el)

  const step = (d: 1 | -1) => {
    if (native.state === 'live') return d < 0 ? native.back() : native.forward()
    const at = hist.at + d
    if (at < 0 || at >= hist.list.length) return
    setHist({ ...hist, at })
    setCurrent(hist.list[at])
    setInput(hist.list[at])
  }
  const reload = () => {
    if (fileMode) void loadFile()
    else if (native.state === 'live') native.reload()
    else if (frameRef.current) frameRef.current.src = frameSrc
  }
  const canBack = nativeLive || (!fileMode && hist.at > 0)
  const canForward = nativeLive || (!fileMode && hist.at < hist.list.length - 1)

  // quietly say what you're looking at: a preview on the canvas, the real
  // browser in focus mode, or a preview in focus when no browser is available
  const remote = !fileMode && isHttpUrl(current) && !isLocalUrl(current)
  const fallback = focused && !fileMode && isHttpUrl(current) && !nativeLive
  const fallbackNote = !isTauri()
    ? 'Preview only. The full browser is in the desktop app.'
    : native.state === 'failed'
      ? "Couldn't open the browser view here, so this is the preview."
      : null

  // in focus mode the bar moves into the focus strip, the one bar there
  // (focusSlots.ts), and the page sits flush under it
  // the address as a modern browser shows it while you're not typing: the
  // site's icon (or a lock, or a magnifier for a search), the host, then the
  // rest of the path, quieter
  const query = !fileMode && current ? searchQuery(current) : null
  const shown = (() => {
    if (fileMode) return { host: baseName(el.path ?? ''), rest: '' }
    if (!current) return null
    if (query != null) return { host: query, rest: '' }
    try {
      const u = new URL(current)
      const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash
      return { host: u.host.replace(/^www\./, ''), rest }
    } catch {
      return { host: current, rest: '' }
    }
  })()
  const secure = /^https:/i.test(current)
  const addrIcon = fileMode ? (
    <IconFile />
  ) : query != null ? (
    <IconSearch />
  ) : brand && !editingBar ? (
    brand
  ) : secure ? (
    <IconLock />
  ) : (
    <IconWeb />
  )

  // in focus mode the bar moves into the focus strip, the one bar there
  // (focusSlots.ts), and the page sits flush under it
  const bar = (
    <div className={`web__bar${inStrip ? ' web__bar--strip' : ''}`} {...(inStrip ? stopCanvas : {})}>
      <div className="web__navs">
        <button className="web__nav" title="Back" disabled={!canBack} onClick={() => step(-1)}>
          <IconBack />
        </button>
        <button className="web__nav" title="Forward" disabled={!canForward} onClick={() => step(1)}>
          <IconForward />
        </button>
        <button className={`web__nav${loading ? ' web__nav--busy' : ''}`} title="Reload" onClick={reload}>
          <IconReload />
        </button>
      </div>
      <label className={`web__addr${editingBar ? ' web__addr--editing' : ''}${shown && !editingBar ? ' web__addr--shown' : ''}`}>
        <span className={`web__addr-ic${secure && !query && !fileMode && !brand ? ' web__addr-ic--lock' : ''}`}>{addrIcon}</span>
        <span className="web__addr-field">
          <input
            ref={urlRef}
            className="web__url"
            value={input}
            placeholder="Search Google or type an address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onFocus={(e) => {
              editing.current = true
              setEditingBar(true)
              e.currentTarget.select()
            }}
            onBlur={() => {
              editing.current = false
              setEditingBar(false)
            }}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                go(input)
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setInput(fileMode ? (el.path ?? '') : current)
                e.currentTarget.blur()
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
          {shown && !editingBar && (
            <span className="web__addr-show" aria-hidden>
              <span className="web__addr-host">{shown.host}</span>
              {shown.rest && <span className="web__addr-rest">{shown.rest}</span>}
            </span>
          )}
        </span>
        {fileMode && (
          <span className="web__tag web__tag--live" title="Live-reloading on file change">
            <span className="web__live-dot" />
            live
          </span>
        )}
        {remote && !inPane && (
          <button
            className={`web__tag${el.live && nativeViewSupported() ? ' web__tag--on' : ''}`}
            title={
              !nativeViewSupported()
                ? 'A preview: no logins, and some pages won’t work.'
                : el.live
                  ? 'Full browser, with your logins. Click for the lighter preview.'
                  : 'A preview: no logins. Click for the full browser here.'
            }
            onClick={(e) => {
              e.preventDefault()
              if (!nativeViewSupported()) return
              useStore.getState().beginHistory()
              mutateElement(el.id, (w) => {
                ;(w as WidgetElement).live = !el.live
              })
            }}
          >
            {el.live && nativeViewSupported() ? 'live' : 'preview'}
          </button>
        )}
      </label>
      <div className="web__navs">
        {!inStrip && (
          <button
            className={`web__nav${fileMode ? ' web__nav--on' : ''}`}
            title="Open a local HTML file (live-reloads on save)"
            onClick={() => void openLocalFile()}
          >
            <IconFile />
          </button>
        )}
        <button
          className="web__nav"
          title="Open in your browser"
          disabled={!externalTarget}
          onClick={() => externalTarget && void openExternal(externalTarget)}
        >
          <IconExternal />
        </button>
      </div>
      {loading && <span className="web__progress" aria-hidden />}
    </div>
  )

  return (
    <div className="web">
      {inStrip ? createPortal(bar, toolsSlot!) : bar}
      {fallback && fallbackNote && <div className="web__note">{fallbackNote}</div>}
      {fileMode ? (
        fileHtml != null ? (
          <iframe
            ref={frameRef}
            className="web__frame"
            srcDoc={fileHtml}
            title={el.title}
            sandbox={SANDBOX}
            onLoad={() => setLoading(false)}
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
      ) : nativeWanted && native.state !== 'failed' ? (
        // the native view is drawn over this box; it shows through while the
        // view is hidden under a menu or still opening
        <div ref={hostRef} className="web__native" style={{ pointerEvents: 'auto' }}>
          {!native.shown &&
            (native.snapshot ? (
              <img className="web__snap" src={native.snapshot} alt="" draggable={false} />
            ) : (
              <span>{hostOf(current)}</span>
            ))}
        </div>
      ) : appOnly ? (
        <div className="web__empty web__apponly">
          <IconWeb className="" />
          <div>{appOnly} doesn't run in the preview.</div>
          <button className="web__cta" onClick={() => void openExternal(current)}>
            Open in your browser
          </button>
        </div>
      ) : frameSrc ? (
        <iframe
          ref={frameRef}
          className="web__frame"
          src={frameSrc}
          title={el.title}
          sandbox={SANDBOX}
          allow={embed ? PLAYER_ALLOW : undefined}
          allowFullScreen={!!embed}
          onLoad={() => setLoading(false)}
          style={{ pointerEvents: active || focused ? 'auto' : 'none' }}
        />
      ) : (
        <div className="web__empty">
          <IconWeb className="" />
          <div>
            Type an address above, or open a local <b>.html</b> file with the file button (it
            live-reloads on save).
            <br />
            Local dev servers embed directly. Other sites show as a preview
            {nativeViewSupported() ? '; focus the widget for the full browser.' : '.'}
          </div>
        </div>
      )}
    </div>
  )
}

function push(h: History, url: string): History {
  const list = [...h.list.slice(0, h.at + 1), url]
  return { list, at: list.length - 1 }
}

/** The widget as stored right now (it may have moved on since render). */
function stored(id: string): WidgetElement | undefined {
  const w = useStore.getState().active()?.elements.find((e) => e.id === id)
  return w && w.type === 'widget' ? w : undefined
}

/** A page asked for a new window: open it in a new web widget beside this one
 *  and focus that (focus swaps; the old one flies home). */
function openBeside(fromId: string, url: string) {
  if (!isHttpUrl(url)) return
  const st = useStore.getState()
  const from = st.active()?.elements.find((e) => e.id === fromId)
  if (!from || from.type !== 'widget') return
  const w = Math.max(from.w, 640)
  const h = Math.max(from.h, 480)
  const id = st.spawnWidget('web', from.x + from.w + 40 + w / 2, from.y + h / 2, {
    url,
    title: hostOf(url),
    w,
    h,
  })
  focusWidget(id)
}
