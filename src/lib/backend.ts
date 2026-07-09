// Backend abstraction for native capabilities the browser sandbox lacks
// (folder picker, real file IO, default dir). Two implementations:
//   • Tauri   — in-process Rust commands (the desktop app)
//   • Web     — the optional HTTP bridge (server/pty-server.mjs)
// Everything degrades gracefully when neither is available.

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const BASE = 'http://127.0.0.1:7531'

/** Running inside the Tauri desktop shell? */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function httpGet<T>(path: string, timeoutMs?: number): Promise<T> {
  const ctrl = timeoutMs ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const r = await fetch(BASE + path, { signal: ctrl?.signal })
    if (!r.ok) throw new Error(`${path} → ${r.status}`)
    return (await r.json()) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Is a native/file backend available at all? */
export async function backendOnline(): Promise<boolean> {
  if (isTauri()) return true
  try {
    await httpGet<{ ok: boolean }>('/health', 700)
    return true
  } catch {
    return false
  }
}

export async function defaultDir(): Promise<string | null> {
  if (isTauri()) {
    try {
      return await invoke<string>('home_dir')
    } catch {
      return null
    }
  }
  try {
    return (await httpGet<{ path: string }>('/default-dir', 700)).path ?? null
  } catch {
    return null
  }
}

/** Claude Code usage in the active 5h rate-limit window (from transcripts). */
export type Usage = {
  hasData: boolean
  activeTokens: number
  resetMs: number | null
  dayTokens: number
  messages: number
}

export async function getUsage(): Promise<Usage | null> {
  if (isTauri()) {
    try {
      return await invoke<Usage>('claude_usage')
    } catch {
      return null
    }
  }
  try {
    return await httpGet<Usage>('/usage', 2500)
  } catch {
    return null
  }
}

/** Native folder dialog → absolute path (null if cancelled / unavailable). */
export async function pickDir(): Promise<string | null> {
  if (isTauri()) {
    try {
      return (await invoke<string | null>('pick_dir')) ?? null
    } catch {
      return null
    }
  }
  try {
    return (await httpGet<{ path: string | null }>('/pick-dir')).path
  } catch {
    return null
  }
}

/** Native .ccnvs open dialog → absolute path + file contents. */
export async function pickFile(): Promise<{ path: string; content: string } | null> {
  if (isTauri()) {
    try {
      return (await invoke<{ path: string; content: string } | null>('pick_file')) ?? null
    } catch {
      return null
    }
  }
  try {
    const r = await httpGet<{ path: string | null; content?: string }>('/pick-file')
    return r.path ? { path: r.path, content: r.content ?? '' } : null
  } catch {
    return null
  }
}

/**
 * General native file-open dialog → absolute path (null if cancelled /
 * unavailable). Unlike pickFile() (which is .ccnvs-filtered and returns the
 * file's contents), this returns just the path so the caller can read/watch it
 * itself — used by the web widget to preview a local HTML file with live reload.
 */
export async function pickPath(filter?: {
  name: string
  extensions: string[]
}): Promise<string | null> {
  if (isTauri()) {
    try {
      return (
        (await invoke<string | null>('pick_path', {
          name: filter?.name ?? null,
          extensions: filter?.extensions ?? null,
        })) ?? null
      )
    } catch {
      return null
    }
  }
  try {
    const qs = filter
      ? `?name=${encodeURIComponent(filter.name)}&ext=${encodeURIComponent(
          filter.extensions.join(','),
        )}`
      : ''
    return (await httpGet<{ path: string | null }>(`/pick-path${qs}`)).path
  } catch {
    return null
  }
}

export async function readFile(path: string): Promise<string | null> {
  if (isTauri()) {
    try {
      return await invoke<string>('read_text', { path })
    } catch {
      return null
    }
  }
  try {
    return (await httpGet<{ content: string }>(`/read?path=${encodeURIComponent(path)}`)).content
  } catch {
    return null
  }
}

export type DirEntry = {
  name: string
  path: string
  is_dir: boolean
  /** last-modified time in ms since epoch (may be absent on older backends) */
  mtime?: number | null
}

/** Decode a standard-base64 string to bytes (used by readBytes). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Read a file's raw bytes. Carried as base64 over both backends (Tauri IPC and
 * the HTTP bridge) and decoded here. null when no backend is available or the
 * read fails — callers should degrade gracefully. Used for binary formats the
 * text reader can't handle (parquet, hdf5, images).
 */
export async function readBytes(path: string): Promise<Uint8Array | null> {
  if (isTauri()) {
    try {
      return b64ToBytes(await invoke<string>('read_bytes', { path }))
    } catch {
      return null
    }
  }
  try {
    const { b64 } = await httpGet<{ b64: string }>(`/read-bytes?path=${encodeURIComponent(path)}`)
    return b64ToBytes(b64)
  } catch {
    return null
  }
}

/** List a directory's immediate children (dirs first). null if unavailable. */
export async function listDir(path: string): Promise<DirEntry[] | null> {
  if (isTauri()) {
    try {
      return await invoke<DirEntry[]>('list_dir', { path })
    } catch {
      return null
    }
  }
  try {
    return (
      await httpGet<{ entries: DirEntry[] }>(
        `/list-dir?path=${encodeURIComponent(path)}`,
      )
    ).entries
  } catch {
    return null
  }
}

/**
 * Watch a path for changes and call `onChange` on each event. Under Tauri this
 * is a real filesystem watcher (notify); otherwise it falls back to polling
 * every `pollMs`. Returns an unsubscribe function.
 */
export async function watchPath(
  path: string,
  onChange: () => void,
  pollMs = 2000,
): Promise<() => void> {
  if (isTauri()) {
    try {
      const id = await invoke<number>('watch_start', { path })
      const un = await listen<{ id: number }>('fs:change', (e) => {
        if (e.payload.id === id) onChange()
      })
      return () => {
        un()
        void invoke('watch_stop', { id })
      }
    } catch {
      /* fall through to polling */
    }
  }
  const t = setInterval(onChange, pollMs)
  return () => clearInterval(t)
}

export type CmdResult = { code: number; stdout: string; stderr: string }

/** Run a program (no shell) in cwd, capturing output. null if unavailable. */
export async function runCommand(
  program: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult | null> {
  if (isTauri()) {
    try {
      return await invoke<CmdResult>('run_command', {
        program,
        args,
        cwd: cwd ?? null,
      })
    } catch {
      return null
    }
  }
  try {
    const r = await fetch(BASE + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program, args, cwd }),
    })
    if (!r.ok) return null
    return (await r.json()) as CmdResult
  } catch {
    return null
  }
}

export async function saveFile(path: string, content: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke('write_text', { path, content })
      return true
    } catch {
      return false
    }
  }
  try {
    const r = await fetch(BASE + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    return r.ok
  } catch {
    return false
  }
}

/**
 * Reveal a file or folder in the OS file manager, selecting it where the
 * platform supports it (Explorer /select on Windows, Finder reveal on macOS,
 * the parent folder on Linux). No-op when no backend is available.
 */
export async function revealPath(path: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('reveal_path', { path })
      return
    } catch {
      /* fall through */
    }
  }
  try {
    await fetch(`${BASE}/reveal?path=${encodeURIComponent(path)}`)
  } catch {
    /* backend offline — nothing we can do from the sandbox */
  }
}

/** Open a URL in the OS default browser (native window, no framing limits). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('open_external', { url })
      return
    } catch {
      /* fall through */
    }
  }
  window.open(url, '_blank', 'noopener')
}

/** URL that routes through the backend proxy (strips X-Frame-Options/CSP). */
export function proxyUrl(target: string): string {
  return `${BASE}/proxy?url=${encodeURIComponent(target)}`
}

/**
 * A streamable, range-request-capable URL for a local file path — used to play
 * video/audio in a <video>/<audio> element WITHOUT loading the whole file into
 * memory (which OOM-crashes on large media). Under Tauri this is the asset
 * protocol (`convertFileSrc`); in web mode it's the backend's /file route.
 * Returns null when no backend can serve local files.
 */
export function mediaUrl(path: string): string | null {
  if (!path) return null
  if (isTauri()) {
    try {
      return convertFileSrc(path)
    } catch {
      return null
    }
  }
  return `${BASE}/file?path=${encodeURIComponent(path)}`
}

/**
 * Where the video widget streams/transcodes from, and whether ffmpeg is there.
 * `base` is the HTTP origin serving /file, /probe and /transcode:
 *   • Tauri — the in-process media server (media.rs), started on app launch, so
 *     the desktop app is fully self-contained (no `npm run server` needed).
 *   • Web   — the Node backend on port 7531.
 * Returns null when no backend can serve local media.
 */
export type MediaEndpoint = { base: string; ffmpeg: boolean }

export async function mediaEndpoint(): Promise<MediaEndpoint | null> {
  if (isTauri()) {
    try {
      const info = await invoke<{ url: string | null; ffmpeg: boolean }>('media_info')
      return info?.url ? { base: info.url, ffmpeg: !!info.ffmpeg } : null
    } catch {
      return null
    }
  }
  try {
    const r = await httpGet<{ ok: boolean; ffmpeg?: boolean }>('/health', 800)
    return r.ok ? { base: BASE, ffmpeg: !!r.ffmpeg } : null
  } catch {
    return null
  }
}

/**
 * Range-streaming URL for a local file on the media backend. Preferred over
 * mediaUrl() when an endpoint is known, since it goes through the same
 * (tested) server as transcode/probe rather than the asset protocol.
 */
export function fileStreamUrl(base: string, path: string): string {
  return `${base}/file?path=${encodeURIComponent(path)}`
}

/**
 * URL that transcodes a local file to browser-playable fMP4 (H.264/AAC) on the
 * backend. `start` (seconds) seeks by fast-forwarding the decode.
 */
export function transcodeUrl(base: string, path: string, start = 0): string {
  const q = start > 0 ? `&start=${Math.floor(start)}` : ''
  return `${base}/transcode?path=${encodeURIComponent(path)}${q}`
}

/** Rich media metadata from ffprobe (drives the media-info widget). */
export type MediaStream = {
  index: number | null
  type: string | null
  codec: string | null
  label: string
}
export type MediaInfo = {
  duration: number | null
  hasVideo: boolean
  format: {
    name: string | null
    longName: string | null
    bitRate: number | null
    size: number | null
    nbStreams: number | null
    startTime: number | null
    tags: Record<string, string> | null
  } | null
  video: {
    codec: string | null
    codecLong: string | null
    profile: string | null
    level: number | null
    width: number | null
    height: number | null
    codedWidth: number | null
    codedHeight: number | null
    fps: number | null
    frames: number | null
    pixFmt: string | null
    bitDepth: number | null
    bitRate: number | null
    aspect: string | null
    sar: string | null
    colorSpace: string | null
    colorRange: string | null
    colorPrimaries: string | null
    colorTransfer: string | null
    fieldOrder: string | null
    language: string | null
  } | null
  audio: {
    codec: string | null
    codecLong: string | null
    profile: string | null
    channels: number | null
    channelLayout: string | null
    sampleRate: number | null
    bitsPerSample: number | null
    bitRate: number | null
    language: string | null
  } | null
  streams: MediaStream[]
}

const EMPTY_MEDIA_INFO: MediaInfo = {
  duration: null,
  hasVideo: false,
  format: null,
  video: null,
  audio: null,
  streams: [],
}

/** ffprobe a media file for duration, codecs, resolution, frames, bitrate, … */
export async function probeMedia(base: string, path: string): Promise<MediaInfo> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(`${base}/probe?path=${encodeURIComponent(path)}`, {
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!r.ok) return EMPTY_MEDIA_INFO
    return { ...EMPTY_MEDIA_INFO, ...((await r.json()) as MediaInfo) }
  } catch {
    return EMPTY_MEDIA_INFO
  }
}

/**
 * Is the HTTP proxy reachable? The proxy lives on the Node server (port 7531),
 * so unlike backendOnline() this always probes HTTP — the desktop app only has
 * it when `npm run server` is also running.
 */
export async function proxyAvailable(): Promise<boolean> {
  try {
    await httpGet<{ ok: boolean }>('/health', 700)
    return true
  } catch {
    return false
  }
}

/** Display name of the OS file manager, for menu labels ("Reveal in …"). */
export function fileManagerName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'Explorer'
  if (/Mac/i.test(ua)) return 'Finder'
  return 'file manager'
}

// ---------- path helpers (browser-side, handle / and \) ----------

export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}

export function dirName(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(0, i) : s
}

export function joinPath(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + file
}

/** Absolute path? Handles POSIX (/…), Windows (C:\…), and UNC (\\…). */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/** Resolve a possibly-relative path against a base dir. */
export function resolvePath(base: string | undefined, p: string): string {
  if (!p) return ''
  if (!base || isAbsolutePath(p)) return p
  return joinPath(base, p)
}
