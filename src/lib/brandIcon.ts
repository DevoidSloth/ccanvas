// The real icon for a widget, where there is one: a web page's own site icon
// (of the page it is on now, not the one it was made with), or the icon of
// the app it stands for (Spotify or Music for Now playing, VS Code, Claude).
// Shown in the title bar, on the zoomed-out card and on the layers overview's
// tiles; until it has loaded (or where there is none) the kind's own glyph
// stands in.
//
// Icons are fetched by the desktop app (site_icon.rs: from the site itself,
// never an icon service) and cached there per host or app, on disk; here they
// are cached in memory too, so every card asks once per host.

import { create } from 'zustand'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { WidgetElement } from './types'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './backend'
import { isHttpUrl, isLocalUrl, searchQuery } from './weburl'

// ---- where each web widget is now ----

/** The page each web widget shows right now (it can move on from el.url:
 *  links, back and forward), by widget id. WebBody keeps it. */
export const useWebPages = create<{ at: Record<string, string> }>(() => ({ at: {} }))

export function setWebPage(id: string, url: string) {
  const at = useWebPages.getState().at
  if (at[id] !== url) useWebPages.setState({ at: { ...at, [id]: url } })
}

// ---- the caches ----
// One entry per site or app; a widget subscribes to its own entry only, so an
// icon arriving re-renders just the widgets that show it.

type Entry = string | null | Promise<string | null>
const cache = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()

function subscribeKey(key: string, l: () => void) {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(l)
  return () => {
    set.delete(l)
  }
}

/** The icon for `key` (data: URL), or null while it loads or where there's
 *  none. */
const snapshot = (key: string): string | null => {
  const v = cache.get(key)
  return typeof v === 'string' ? v : null
}

function load(key: string, get: () => Promise<string | null>) {
  if (cache.has(key)) return
  cache.set(
    key,
    get()
      .catch(() => null)
      .then((r) => {
        cache.set(key, r)
        listeners.get(key)?.forEach((l) => l())
        return r
      }),
  )
}

const hostKey = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

/** The cache key and fetch for a source (null: nothing to fetch). */
function request(src: BrandSource): { key: string; get: () => Promise<string | null> } | null {
  if (!src || src.kind === 'github' || !isTauri()) return null
  if (src.kind === 'app') {
    const bundleId = src.bundleId
    return { key: `app:${bundleId}`, get: () => invoke<string | null>('app_icon', { bundleId }) }
  }
  const url = src.url
  if (!isHttpUrl(url) || isLocalUrl(url)) return null
  const host = hostKey(url)
  return host ? { key: `site:${host}`, get: () => invoke<string | null>('site_icon', { url }) } : null
}

// ---- which icon a widget gets ----

const NOW_PLAYING_APP: Record<string, string> = {
  spotify: 'com.spotify.client',
  music: 'com.apple.Music',
}
const VSCODE_APP = 'com.microsoft.VSCode'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'

/** What a widget's icon comes from: a site, an app, GitHub's mark (drawn
 *  inline, widgetIcons.tsx), or nothing (its kind's glyph). */
export type BrandSource =
  | { kind: 'site'; url: string }
  | { kind: 'app'; bundleId: string; fallback?: 'claude' }
  | { kind: 'github' }
  | null

export function brandSource(el: WidgetElement, page?: string, npSource?: string | null): BrandSource {
  switch (el.kind) {
    case 'web': {
      if (el.path) return null
      const url = page ?? el.url
      if (!url || isLocalUrl(url)) return null
      // a search shows the search engine's icon
      return { kind: 'site', url: searchQuery(url) != null ? 'https://www.google.com/' : url }
    }
    case 'nowplaying':
      return npSource && NOW_PLAYING_APP[npSource] ? { kind: 'app', bundleId: NOW_PLAYING_APP[npSource] } : null
    case 'vscode':
      return { kind: 'app', bundleId: VSCODE_APP }
    case 'agent':
      // Claude Code (the CLI) wears Claude's icon; Codex keeps the glyph
      return el.cli === 'codex' ? null : { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' }
    case 'claude':
      return { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' }
    case 'transcript':
      return el.mirrorOf === 'desktop' ? { kind: 'app', bundleId: CLAUDE_APP, fallback: 'claude' } : null
    case 'pr':
    case 'issues':
    case 'runs':
      return { kind: 'github' }
    default:
      return null
  }
}

/** The image for a source: a data: URL once loaded, else null. Re-renders
 *  only when this source's icon arrives. */
export function useBrandImage(src: BrandSource): string | null {
  const req = request(src)
  const key = req?.key ?? null
  const subscribe = useCallback((l: () => void) => (key ? subscribeKey(key, l) : () => {}), [key])
  const img = useSyncExternalStore(subscribe, () => (key ? snapshot(key) : null))
  useEffect(() => {
    if (req) load(req.key, req.get)
    // the key names the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return img
}

/** The page a web widget is on now (el.url until it has moved on). */
export function useWebPage(el: WidgetElement): string | undefined {
  const at = useWebPages((s) => (el.kind === 'web' ? s.at[el.id] : undefined))
  return at ?? el.url
}

/** Ask for an icon ahead of time (a web widget as soon as its page changes),
 *  so cards and tiles have it by the time they show. */
export function usePrefetchSiteIcon(url: string | undefined) {
  useEffect(() => {
    const req = url ? request({ kind: 'site', url }) : null
    if (req) load(req.key, req.get)
  }, [url])
}
