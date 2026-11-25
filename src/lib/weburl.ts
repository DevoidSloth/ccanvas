// What the web widget's address bar (and quick insert / the palette) does with
// whatever was typed: a URL, a bare host, a port, or a local .html file.

import { isAbsolutePath } from './backend'

/** `example.com` → `https://example.com`, `localhost:3000` / `3000` → http. */
export function normalizeUrl(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return v
  // this machine and other local addresses are plain http, whatever follows the host
  if (/^localhost(:\d+)?([/?#]|$)/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v) || /^\[[0-9a-f:]+\]/i.test(v))
    return `http://${v}`
  if (/^\d{2,5}([/?#]|$)/.test(v)) return `http://localhost:${v}`
  return `https://${v}`
}

export const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

/** A web search for `q` (what the address bar does with anything that isn't
 *  an address). */
export const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q.trim())}`

/** The query of a search this bar made, or null for any other page. */
export function searchQuery(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/^(www\.)?google\.[a-z.]+$/i.test(u.hostname) || u.pathname !== '/search') return null
    return u.searchParams.get('q')
  } catch {
    return null
  }
}

/** Typed into an address bar: a local file, an address, or a search. */
export type Address = { kind: 'file'; path: string } | { kind: 'url'; url: string; search?: string }

/** Is `v` (no spaces, no scheme) an address rather than words to search for?
 *  `localhost:3000`, `3000`, `10.0.0.2`, `[::1]:8080`, `example.com/a`,
 *  `myhost:8080`; not `v1.2` or `hello`. */
function isAddress(v: string): boolean {
  if (/^localhost(:\d+)?([/?#]|$)/i.test(v)) return true
  if (/^\d{2,5}([/?#]|$)/.test(v)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(v)) return true
  if (/^\[[0-9a-f:]+\](:\d+)?([/?#]|$)/i.test(v)) return true
  // a host with a port (`devbox:8080`)
  if (/^[a-z0-9-]+:\d{2,5}([/?#]|$)/i.test(v)) return true
  // a dotted host whose last label is a name, not a number (`v1.2` is not)
  const host = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d+)?([/?#]|$)/i.exec(v)?.[1]
  return !!host && /\.[a-z][a-z0-9-]*[a-z0-9]$/i.test(host) && !/\.\./.test(host)
}

/** What the web widget's bar (and quick insert) does with what was typed: a
 *  local .html file, an address (scheme added), or else a Google search. */
export function resolveAddress(raw: string): Address | null {
  const v = raw.trim()
  if (!v) return null
  if (looksLikeLocalFile(v)) return { kind: 'file', path: v }
  if (isHttpUrl(v)) return { kind: 'url', url: v }
  if (!/\s/.test(v) && isAddress(v))
    // a bare one-word host with a port is a machine on this network: plain http
    return { kind: 'url', url: /^[a-z][a-z0-9-]*:\d/i.test(v) && !/^localhost/i.test(v) ? `http://${v}` : normalizeUrl(v) }
  return { kind: 'url', url: searchUrl(v), search: v }
}

/** A dev server on this machine: embeds directly, no proxy needed. */
export const isLocalUrl = (u: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)([:/?#]|$)/i.test(u)

/** Starts with a host: `localhost:8080/…`, `example.com/…`, `10.0.0.2/…`. */
const HOST_FIRST = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/|$)/i

/** A local file rather than a URL: no http(s) scheme, and either an absolute
 *  path or something ending in .htm/.html (e.g. `dist/index.html`) that
 *  doesn't start with a host (`localhost:8080/index.html` is a URL). */
export function looksLikeLocalFile(v: string): boolean {
  if (isHttpUrl(v)) return false
  if (isAbsolutePath(v)) return true
  if (!/\.html?($|[?#])/i.test(v)) return false
  // `index.html` is a file; `example.com/index.html` is a URL
  return /\.html?$/i.test(v.split(/[/?#]/)[0]) || !HOST_FIRST.test(v)
}

/** Is a palette query plausibly an address? (`example.com`, `localhost:5173`,
 *  `https://…`) — one word with a dot, a port or a scheme, no spaces. */
export function looksLikeUrl(v: string): boolean {
  const t = v.trim()
  if (!t || /\s/.test(t)) return false
  if (isHttpUrl(t)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(t) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)
}

/** The host to title a widget with, or the input when it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// ---- sites the canvas preview can't run ----
//
// The preview proxy serves a page from its own loopback origin with no
// cookies, which is fine for documents but breaks full JS apps: their API
// calls go cross-origin and fail. Video sites matter most there, and they ship
// a player that is made to be framed, so a video page shows that player
// instead; the rest of the site needs the real browser (focus mode).

const YT_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'])
const YT_ID = /^[A-Za-z0-9_-]{11}$/
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/

function parse(url: string): { u: URL; host: string } | null {
  if (!isHttpUrl(url)) return null
  try {
    const u = new URL(url)
    return { u, host: u.hostname.toLowerCase().replace(/^www\./, '') }
  } catch {
    return null
  }
}

const isYouTube = (host: string) => host === 'youtu.be' || YT_HOSTS.has(host)

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds (0 when it doesn't parse). */
export function parseStart(t: string | null): number {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (!m || !m[0]) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * The framable player for a video page, or null when `url` isn't one:
 * YouTube watch / youtu.be / shorts / live / embed links (keeping the start
 * time and playlist), YouTube playlists, and Vimeo videos.
 */
export function videoEmbed(url: string): string | null {
  const p = parse(url)
  if (!p) return null
  const { u, host } = p
  const seg = u.pathname.split('/').filter(Boolean)

  if (isYouTube(host)) {
    const q = u.searchParams
    const list = q.get('list')
    let id: string | null = null
    if (host === 'youtu.be') id = seg[0] ?? null
    else if (seg[0] === 'watch') id = q.get('v')
    else if (['shorts', 'live', 'embed', 'v'].includes(seg[0] ?? '')) id = seg[1] ?? null
    const out = new URLSearchParams()
    if (list && YT_LIST.test(list)) out.set('list', list)
    if (!id || !YT_ID.test(id)) {
      // a playlist on its own plays as a series
      if (seg[0] === 'playlist' && out.has('list')) return `https://www.youtube.com/embed/videoseries?${out}`
      return null
    }
    const start = parseStart(q.get('t') ?? q.get('start'))
    if (start > 0) out.set('start', String(start))
    const qs = out.toString()
    return `https://www.youtube.com/embed/${id}${qs ? `?${qs}` : ''}`
  }

  if (host === 'vimeo.com' && /^\d+$/.test(seg[0] ?? '')) {
    // unlisted videos carry their key as a second segment
    const h = seg[1] && /^[0-9a-f]{6,}$/i.test(seg[1]) ? `?h=${seg[1]}` : ''
    return `https://player.vimeo.com/video/${seg[0]}${h}`
  }
  if (host === 'player.vimeo.com' && seg[0] === 'video') return url

  return null
}

/** A site the preview can't run (a full JS app), by name for the widget to
 *  say so; null for everything else. Video pages aren't in here: they play
 *  through `videoEmbed`. */
export function appOnlySite(url: string): string | null {
  const p = parse(url)
  if (!p || videoEmbed(url)) return null
  if (isYouTube(p.host)) return 'YouTube'
  // Google answers a cookieless fetch of its results with a robot check
  if (searchQuery(url) != null) return 'Google Search'
  return null
}
