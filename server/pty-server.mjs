// ============================================================
// ccanvas — local backend (PTY bridge + filesystem)
//
// Start with:  npm run server   (or `npm start` for server + web)
//
// Provides, on ws/http://127.0.0.1:7531:
//   • WebSocket  — a real shell per terminal widget (node-pty)
//   • GET  /health      — liveness probe (+ the session token, app origins only)
//   • GET  /default-dir — the user's home directory
//   • GET  /pick-dir    — native "choose folder" dialog → { path }
//   • GET  /pick-file   — native "open .ccnvs" dialog   → { path, content }
//   • GET  /read?path=  — read a file (utf8)             → { content }
//   • GET  /read-bytes? — read a file (base64 bytes)     → { b64 }
//   • GET  /file?path=  — stream a file with Range support (video/audio)
//   • POST /save        — write a file  { path, content }
//   • GET  /code-serve?dir= — start/reuse `code serve-web` for a folder
//
// and, on http://127.0.0.1:7532 (a separate origin, see below):
//   • GET  /proxy?url=  — fetch a page with its framing headers stripped
//
// The canvas needs real folders/paths (for terminal cwd + where .ccnvs
// lives) which a browser sandbox can't provide — so this process does it.
//
// Access control. This server can run programs and read/write any file, so
// only the ccanvas app may use it — not other websites open in the browser,
// and not pages shown in the web widget:
//   • Requests that carry an Origin must come from an app origin (the Vite dev
//     server or the desktop webview; extend with CCANVAS_ORIGINS=a,b).
//   • Every route except /health needs the per-launch token, sent as the
//     X-Ccanvas-Token header or a `token` query param (for <video src> and the
//     WebSocket, which can't set headers). The app learns it from /health,
//     which only hands it to app origins. This covers requests that carry no
//     Origin at all (<img>/<video> tags, top-level navigations).
//   • The Host header must be our own loopback address (stops DNS rebinding).
//   • /proxy lives on its own port, so a proxied page runs on an origin that is
//     neither an app origin nor this API's.
// ============================================================
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import nodePath from 'node:path'
import crypto from 'node:crypto'
import { promises as fs, createReadStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'

const PORT = 7531
const PROXY_PORT = 7532
const HOST = '127.0.0.1'

// The origins the app itself runs on: Vite dev/preview (see vite.config.ts)
// and the Tauri webview (tauri://localhost on macOS/Linux, http(s)://tauri.localhost
// on Windows).
// This server only backs the browser build, which runs on the Vite ports, so
// those stay trusted: something else listening there is already a program
// running on this machine.
const APP_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  ...(process.env.CCANVAS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
])

// Fresh each launch; never written to disk or logged.
const TOKEN = crypto.randomBytes(32).toString('hex')

function tokenOk(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))
}

// Host must name us by a loopback address. A DNS-rebound name (evil.test
// resolving to 127.0.0.1) would otherwise make its page same-origin with us.
function hostOk(req, port) {
  const host = String(req.headers.host || '').toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

const isAppOrigin = (origin) => typeof origin === 'string' && APP_ORIGINS.has(origin)

// Why a request to the API is refused, or null if it may proceed.
function refusal(req, url) {
  if (!hostOk(req, PORT)) return [403, 'bad host']
  const origin = req.headers.origin
  if (origin !== undefined && !isAppOrigin(origin)) return [403, 'origin not allowed']
  if (req.method === 'OPTIONS' || url.pathname === '/health') return null
  if (!tokenOk(req.headers['x-ccanvas-token'] ?? url.searchParams.get('token'))) return [401, 'bad token']
  return null
}

let pty
let WebSocketServer
try {
  ;({ WebSocketServer } = await import('ws'))
  pty = await import('node-pty')
} catch (err) {
  console.error('\x1b[31m✗ PTY server dependencies are missing.\x1b[0m')
  console.error('  node-pty / ws failed to load:', err?.message ?? err)
  console.error('  Install them with:  \x1b[36mnpm install ws node-pty\x1b[0m')
  console.error('  (node-pty needs native build tools on some systems.)')
  process.exit(1)
}

const defaultShell =
  process.platform === 'win32'
    ? process.env.CCANVAS_SHELL || 'powershell.exe'
    : process.env.CCANVAS_SHELL || process.env.SHELL || 'bash'

const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd()

// The shell's environment: ours, naming the terminal it really runs in (as
// spawn_session in src-tauri/src/pty.rs does), without the identity of a
// terminal this server was started from.
const OUTER_TERMINAL = ['LC_TERMINAL', 'LC_TERMINAL_VERSION', 'ITERM_SESSION_ID', 'KITTY_WINDOW_ID', 'KITTY_PID', 'KITTY_PUBLIC_KEY', 'GHOSTTY_BIN_DIR', 'GHOSTTY_RESOURCES_DIR', 'GHOSTTY_SHELL_FEATURES', 'WEZTERM_PANE', 'WEZTERM_EXECUTABLE']
function shellEnv() {
  const env = { ...process.env }
  if (process.platform !== 'win32') {
    for (const k of OUTER_TERMINAL) delete env[k]
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ccanvas' })
    delete env.TERM_PROGRAM_VERSION
  }
  return env
}

// ffmpeg/ffprobe let us transcode any codec the webview can't decode into a
// browser-playable stream. Detected once at startup (overridable via env).
const ffmpegBin = process.env.CCANVAS_FFMPEG || 'ffmpeg'
const ffprobeBin = process.env.CCANVAS_FFPROBE || 'ffprobe'
let hasFfmpeg = false
execFile(ffmpegBin, ['-version'], (err) => {
  hasFfmpeg = !err
  console.log(
    hasFfmpeg
      ? '\x1b[32m✓ ffmpeg found — video transcoding enabled\x1b[0m'
      : '\x1b[33m! ffmpeg not found — exotic codecs will fall back to the system player (install ffmpeg to play them in-app)\x1b[0m',
  )
})

// ---------- native file/folder dialogs ----------

function runDialog(script) {
  return new Promise((resolve) => {
    let file
    let args
    if (process.platform === 'win32') {
      file = 'powershell.exe'
      args = ['-NoProfile', '-STA', '-Command', script.win]
    } else if (process.platform === 'darwin') {
      file = 'osascript'
      args = ['-e', script.mac]
    } else {
      file = script.linuxBin
      args = script.linuxArgs
    }
    execFile(file, args, { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null)
      const out = String(stdout || '').trim()
      resolve(out || null)
    })
  })
}

const pickDir = () =>
  runDialog({
    win:
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;' +
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;' +
      "$d.Description = 'Choose a folder for this canvas';" +
      '$d.ShowNewFolderButton = $true;' +
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    mac: 'POSIX path of (choose folder with prompt "Choose a folder for this canvas")',
    linuxBin: 'zenity',
    linuxArgs: ['--file-selection', '--directory', '--title=Choose a folder for this canvas'],
  })

const pickFile = () =>
  runDialog({
    win:
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;' +
      '$d = New-Object System.Windows.Forms.OpenFileDialog;' +
      "$d.Filter = 'ccanvas workspace (*.ccnvs)|*.ccnvs|All files (*.*)|*.*';" +
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    mac: 'POSIX path of (choose file with prompt "Open a .ccnvs file" of type {"ccnvs"})',
    linuxBin: 'zenity',
    linuxArgs: ['--file-selection', '--title=Open a .ccnvs file', '--file-filter=*.ccnvs'],
  })

// General file picker with an optional type filter. `extensions` is a list of
// bare extensions (e.g. ['html','htm']); empty/absent means "all files".
const pickAnyFile = (name, extensions) => {
  const exts = (Array.isArray(extensions) ? extensions : [])
    .map((e) => String(e).replace(/^\./, '').trim())
    .filter(Boolean)
  const label = (name || 'Files').replace(/['"|]/g, '')
  const hasFilter = exts.length > 0
  const winPattern = hasFilter ? exts.map((e) => `*.${e}`).join(';') : '*.*'
  const winFilter = hasFilter
    ? `${label} (${winPattern})|${winPattern}|All files (*.*)|*.*`
    : 'All files (*.*)|*.*'
  const macType = hasFilter ? ` of type {${exts.map((e) => `"${e}"`).join(', ')}}` : ''
  const linuxFilter = hasFilter ? `${label} | ${exts.map((e) => `*.${e}`).join(' ')}` : '*'
  return runDialog({
    win:
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;' +
      '$d = New-Object System.Windows.Forms.OpenFileDialog;' +
      `$d.Filter = '${winFilter}';` +
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    mac: `POSIX path of (choose file with prompt "Open a file"${macType})`,
    linuxBin: 'zenity',
    linuxArgs: ['--file-selection', '--title=Open a file', `--file-filter=${linuxFilter}`],
  })
}

// Reveal a path in the OS file manager. Directories open directly; files are
// selected within their parent where the platform allows. Fire-and-forget —
// explorer.exe in particular exits non-zero even on success, so we ignore it.
async function revealInManager(p) {
  let isDir = false
  try {
    isDir = (await fs.stat(p)).isDirectory()
  } catch {
    /* path may not exist; best-effort below */
  }
  if (process.platform === 'win32') {
    execFile('explorer.exe', isDir ? [p] : [`/select,${p}`], () => {})
  } else if (process.platform === 'darwin') {
    execFile('open', isDir ? [p] : ['-R', p], () => {})
  } else {
    execFile('xdg-open', [isDir ? p : nodePath.dirname(p)], () => {})
  }
}

// ---------- http backend ----------

// CORS for app origins only (set once per request; writeHead merges it in).
function allowApp(req, res) {
  res.setHeader('Vary', 'Origin')
  const origin = req.headers.origin
  if (!isAppOrigin(origin)) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ccanvas-Token')
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
    req.on('error', reject)
  })
}

// Claude Code usage from ~/.claude/projects/**/*.jsonl (active 5h window + 24h)
async function claudeUsage() {
  const empty = { hasData: false, activeTokens: 0, resetMs: null, dayTokens: 0, messages: 0 }
  const root = nodePath.join(homeDir, '.claude', 'projects')
  const now = Date.now()
  const cutoff = now - 25 * 3600_000
  const entries = []
  const files = []
  const walk = async (dir) => {
    let ents
    try {
      ents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = nodePath.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  await walk(root)
  // one line per content block repeats the same message id + usage; count once
  const seen = new Set()
  for (const fp of files) {
    try {
      const st = await fs.stat(fp)
      if (st.mtimeMs < cutoff) continue
      const content = await fs.readFile(fp, 'utf8')
      for (const line of content.split('\n')) {
        if (!line.includes('"usage"')) continue
        let v
        try {
          v = JSON.parse(line)
        } catch {
          continue
        }
        const u = v && v.message && v.message.usage
        if (!u) continue
        if (v.message.id) {
          const key = `${v.message.id}:${v.requestId || ''}`
          if (seen.has(key)) continue
          seen.add(key)
        }
        // new work only — cache *reads* are cheap and re-counted each turn
        const tok =
          (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0)
        if (!tok) continue
        const ts = v.timestamp ? Date.parse(v.timestamp) : NaN
        if (!Number.isNaN(ts) && ts >= cutoff) entries.push([ts, tok])
      }
    } catch {
      /* skip unreadable file */
    }
  }
  if (!entries.length) return empty
  entries.sort((a, b) => a[0] - b[0])
  const FIVE_H = 5 * 3600_000
  const dayCut = now - 24 * 3600_000
  const dayTokens = entries.filter((e) => e[0] >= dayCut).reduce((s, e) => s + e[1], 0)
  // blocks begin on the hour of their first message
  const floorHour = (ts) => ts - (ts % 3600_000)
  let bStart = floorHour(entries[0][0])
  let bTok = 0
  let bMsg = 0
  let prev = entries[0][0]
  for (const [ts, tok] of entries) {
    if (ts - bStart >= FIVE_H || ts - prev > FIVE_H) {
      bStart = floorHour(ts)
      bTok = 0
      bMsg = 0
    }
    bTok += tok
    bMsg++
    prev = ts
  }
  const reset = bStart + FIVE_H
  if (now >= reset) return { hasData: true, activeTokens: 0, resetMs: null, dayTokens, messages: 0 }
  return { hasData: true, activeTokens: bTok, resetMs: reset, dayTokens, messages: bMsg }
}

// Content-Type for a media path, by extension. Unknown → octet-stream (the
// webview can still sniff many of these). Keeps the <video> src honest.
const MEDIA_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', m4p: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg', ogg: 'video/ogg',
  mov: 'video/quicktime', qt: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf',
  flv: 'video/x-flv', f4v: 'video/x-f4v',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', vob: 'video/mpeg',
  mts: 'video/mp2t', m2ts: 'video/mp2t',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
  divx: 'video/divx',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
}
function mediaType(p) {
  const ext = nodePath.extname(p).slice(1).toLowerCase()
  return MEDIA_TYPES[ext] || 'application/octet-stream'
}

// Stream a file with HTTP Range support so the browser can seek and start
// playback immediately instead of loading the whole thing into memory. This is
// what makes video open fast and stops the app from OOM-crashing on big files.
async function streamFile(req, res, p) {
  let stat
  try {
    stat = await fs.stat(p)
  } catch {
    return send(res, 404, { error: 'not found' })
  }
  if (!stat.isFile()) return send(res, 400, { error: 'not a file' })
  const total = stat.size
  const type = mediaType(p)
  const range = req.headers.range
  const baseHeaders = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  }
  let start = 0
  let end = total - 1
  let status = 200
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      if (m[1]) start = parseInt(m[1], 10)
      if (m[2]) end = parseInt(m[2], 10)
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= total) end = total - 1
      if (start > end || start >= total) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` })
        return res.end()
      }
      status = 206
      baseHeaders['Content-Range'] = `bytes ${start}-${end}/${total}`
    }
  }
  baseHeaders['Content-Length'] = end - start + 1
  res.writeHead(status, baseHeaders)
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(p, { start, end })
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  req.on('close', () => stream.destroy())
  stream.pipe(res)
}

// Distil raw ffprobe JSON into the media-info shape the widget shows (codec,
// resolution, fps, frame count, bitrate, audio, container …).
const EMPTY_PROBE = { duration: null, hasVideo: false, format: null, video: null, audio: null, streams: [] }
function summarizeProbe(j) {
  const num = (x) => {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  const fmt = j.format || {}
  const streams = j.streams || []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  const fps = (s) => {
    if (!s) return null
    const r = s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate
    if (!r || r === '0/0') return null
    const [n, d] = r.split('/').map(Number)
    return d ? n / d : null
  }
  const duration = num(fmt.duration)
  const video = v
    ? {
        codec: v.codec_name || null,
        codecLong: v.codec_long_name || null,
        profile: v.profile || null,
        level: v.level != null && v.level > 0 ? v.level : null,
        width: v.width || null,
        height: v.height || null,
        codedWidth: v.coded_width || null,
        codedHeight: v.coded_height || null,
        fps: fps(v),
        frames: num(v.nb_frames),
        pixFmt: v.pix_fmt || null,
        bitDepth: num(v.bits_per_raw_sample),
        bitRate: num(v.bit_rate),
        aspect: v.display_aspect_ratio || null,
        sar: v.sample_aspect_ratio || null,
        colorSpace: v.color_space || null,
        colorRange: v.color_range || null,
        colorPrimaries: v.color_primaries || null,
        colorTransfer: v.color_transfer || null,
        fieldOrder: v.field_order || null,
        language: v.tags?.language || null,
      }
    : null
  if (video && !video.frames && video.fps && duration)
    video.frames = Math.round(video.fps * duration)
  const audio = a
    ? {
        codec: a.codec_name || null,
        codecLong: a.codec_long_name || null,
        profile: a.profile || null,
        channels: a.channels || null,
        channelLayout: a.channel_layout || null,
        sampleRate: num(a.sample_rate),
        bitsPerSample: num(a.bits_per_sample) || null,
        bitRate: num(a.bit_rate),
        language: a.tags?.language || null,
      }
    : null
  // brief listing of every stream (mkv often has several audio/subtitle tracks)
  const trackLabel = (s) => {
    const bits = [s.codec_type, s.codec_name]
    if (s.tags?.language) bits.push(`[${s.tags.language}]`)
    if (s.tags?.title) bits.push(`"${s.tags.title}"`)
    if (s.channel_layout) bits.push(s.channel_layout)
    if (s.width) bits.push(`${s.width}×${s.height}`)
    return bits.filter(Boolean).join(' ')
  }
  const streamList = streams.map((s) => ({
    index: s.index,
    type: s.codec_type || null,
    codec: s.codec_name || null,
    label: trackLabel(s),
  }))
  return {
    duration,
    hasVideo: !!v,
    format: {
      name: fmt.format_name || null,
      longName: fmt.format_long_name || null,
      bitRate: num(fmt.bit_rate),
      size: num(fmt.size),
      nbStreams: fmt.nb_streams || streamList.length || null,
      startTime: num(fmt.start_time),
      tags: fmt.tags || null,
    },
    video,
    audio,
    streams: streamList,
  }
}

// ffprobe a media file → rich info (used for the scrubber duration in transcode
// mode and for the widget's VLC-style info panel).
function probeFile(res, p) {
  execFile(
    ffprobeBin,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', p],
    { maxBuffer: 8 << 20 },
    (err, stdout) => {
      if (err) return send(res, 200, EMPTY_PROBE)
      try {
        return send(res, 200, summarizeProbe(JSON.parse(stdout)))
      } catch {
        return send(res, 200, EMPTY_PROBE)
      }
    },
  )
}

// Transcode any input into a progressively-streamable fragmented MP4 (H.264/AAC)
// that every webview can play. `start` (seconds) seeks by fast-forwarding the
// decoder, which is how the widget scrubs a non-seekable live stream. We map
// only the first video+audio stream so extras (mkv subtitles, data) can't break
// the mp4 muxer.
function transcodeFile(req, res, p, start) {
  const args = []
  if (start > 0) args.push('-ss', String(start))
  args.push('-i', p)
  args.push('-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')
  // keep very large frames within realtime-transcode reach
  args.push('-vf', "scale='min(1920,iw)':-2")
  args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2')
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof')
  args.push('-f', 'mp4', 'pipe:1')

  let child
  try {
    child = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return send(res, 500, { error: String(e?.message ?? e) })
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
  })
  child.stdout.pipe(res)
  // surface real failures (missing binary, bad input) but don't spam decode logs
  child.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    try { res.end() } catch { /* already closed */ }
  })
  child.on('close', () => { try { res.end() } catch { /* already closed */ } })
  const kill = () => { try { child.kill('SIGKILL') } catch { /* gone */ } }
  req.on('close', kill)
  res.on('close', kill)
}

// ---------- VS Code web servers (one per folder) ----------
const codeServers = new Map()

function portFree() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, HOST, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function listening(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: '/', method: 'HEAD', timeout: 400 }, () => {
      req.destroy()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

// `code serve-web` refuses to be framed (X-Frame-Options + frame-ancestors),
// which renders as a blank widget, so the widget loads a small proxy that
// strips those headers and re-attaches VS Code's SameSite=Strict secret cookie.
const SECRET_COOKIE = 'vscode-cli-secret-half'

// Settings defaults for the embedded workbench so it matches the dark canvas —
// only defaults, a theme picked inside VS Code still wins.
const WORKBENCH_DEFAULTS = '&quot;configurationDefaults&quot;:{&quot;workbench.colorTheme&quot;:&quot;Dark 2026&quot;},'
const WORKBENCH_CONFIG = 'id="vscode-workbench-web-configuration" data-settings="{'
const withDefaults = (html) => html.replace(WORKBENCH_CONFIG, WORKBENCH_CONFIG + WORKBENCH_DEFAULTS)

function codeProxy(upstream) {
  let secret = null
  const withSecret = (headers) => {
    if (!secret) return headers
    const cookie = headers.cookie
    if (!cookie) headers.cookie = secret
    else if (!cookie.includes(SECRET_COOKIE)) headers.cookie = `${cookie}; ${secret}`
    return headers
  }
  const srv = http.createServer((req, res) => {
    const up = http.request(
      { host: HOST, port: upstream, path: req.url, method: req.method, headers: withSecret({ ...req.headers }) },
      (ur) => {
        for (let i = 0; i < ur.rawHeaders.length; i += 2) {
          const name = ur.rawHeaders[i].toLowerCase()
          const value = ur.rawHeaders[i + 1]
          if (name === 'x-frame-options') continue
          if (name === 'content-security-policy' && value.includes('frame-ancestors')) continue
          if (name === 'set-cookie' && value.startsWith(SECRET_COOKIE)) secret = value.split(';')[0]
          const prev = res.getHeader(name)
          res.setHeader(name, prev == null ? value : [].concat(prev, value))
        }
        const page = req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))
        if (!page) {
          res.writeHead(ur.statusCode ?? 502)
          ur.pipe(res)
          return
        }
        const chunks = []
        ur.on('data', (c) => chunks.push(c))
        ur.on('end', () => {
          const html = withDefaults(Buffer.concat(chunks).toString('utf8'))
          res.removeHeader('transfer-encoding')
          res.setHeader('content-length', Buffer.byteLength(html))
          res.writeHead(ur.statusCode ?? 502)
          res.end(html)
        })
      },
    )
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  srv.on('upgrade', (req, socket, head) => {
    const up = net.connect(upstream, HOST, () => {
      const headers = withSecret({ ...req.headers })
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`
      up.write(raw + '\r\n')
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const close = () => { up.destroy(); socket.destroy() }
    up.on('error', close)
    socket.on('error', close)
  })
  return new Promise((resolve, reject) => {
    srv.listen(0, HOST, () => resolve({ srv, port: srv.address().port }))
    srv.on('error', reject)
  })
}

// `code` is a shell script → CLI → node; kill the whole process group
function killServer(s) {
  try { process.kill(-s.child.pid, 'SIGTERM') } catch { try { s.child.kill() } catch { /* gone */ } }
  s.proxy?.close()
}

async function codeServe(dir) {
  const existing = codeServers.get(dir)
  if (existing) {
    if (existing.child.exitCode == null && (await listening(existing.upstream)))
      return { url: codeUrl(existing.port, dir), port: existing.port, started: false }
    killServer(existing)
    codeServers.delete(dir)
  }

  const upstream = await portFree()
  const child = spawn(
    'code',
    [
      'serve-web',
      '--host', HOST,
      '--port', String(upstream),
      '--without-connection-token',
      '--accept-server-license-terms',
    ],
    { cwd: dir, stdio: 'ignore', shell: true, detached: true },
  )
  let exited = null
  child.on('exit', (code) => {
    exited = code
  })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (exited != null) throw new Error(`code serve-web exited (${exited})`)
    if (await listening(upstream)) {
      const { srv, port } = await codeProxy(upstream)
      codeServers.set(dir, { upstream, port, proxy: srv, child })
      return { url: codeUrl(port, dir), port, started: true }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  killServer({ child })
  throw new Error("code serve-web didn't start listening in time")
}

const codeUrl = (port, dir) => `http://${HOST}:${port}/?folder=${encodeURIComponent(dir)}`

process.on('exit', () => codeServers.forEach(killServer))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  // CORS first (app origins only), so the app can read a 401 and re-fetch the
  // token after a backend restart
  allowApp(req, res)
  const refused = refusal(req, url)
  if (refused) return send(res, refused[0], { error: refused[1] })
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
  try {
    switch (url.pathname) {
      case '/health': {
        const health = { ok: true, platform: process.platform, ffmpeg: hasFfmpeg }
        // only a page on an app origin gets the token (and the home dir)
        if (isAppOrigin(req.headers.origin)) Object.assign(health, { home: homeDir, token: TOKEN })
        return send(res, 200, health)
      }
      case '/default-dir':
        return send(res, 200, { path: homeDir })
      case '/usage':
        return send(res, 200, await claudeUsage())
      case '/pick-dir':
        return send(res, 200, { path: await pickDir() })
      case '/pick-file': {
        const path = await pickFile()
        if (!path) return send(res, 200, { path: null })
        const content = await fs.readFile(path, 'utf8')
        return send(res, 200, { path, content })
      }
      case '/pick-path': {
        const name = url.searchParams.get('name') || ''
        const ext = (url.searchParams.get('ext') || '').split(',').filter(Boolean)
        return send(res, 200, { path: await pickAnyFile(name, ext) })
      }
      case '/reveal': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        await revealInManager(p)
        return send(res, 200, { ok: true })
      }
      case '/read': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        return send(res, 200, { content: await fs.readFile(p, 'utf8') })
      }
      case '/file': {
        // stream a local file (video/audio) with Range support — see streamFile
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        return streamFile(req, res, p)
      }
      case '/probe': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        return probeFile(res, p)
      }
      case '/transcode': {
        // pipe an ffmpeg transcode so any codec plays in the webview
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        if (!hasFfmpeg) return send(res, 501, { error: 'ffmpeg not installed' })
        const start = Number(url.searchParams.get('start')) || 0
        return transcodeFile(req, res, p, start)
      }
      case '/read-bytes': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        const buf = await fs.readFile(p)
        return send(res, 200, { b64: buf.toString('base64') })
      }
      case '/list-dir': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        const dirents = await fs.readdir(p, { withFileTypes: true })
        const entries = (
          await Promise.all(
            dirents.map(async (d) => {
              const full = nodePath.join(p, d.name)
              let mtime = null
              try {
                mtime = Math.floor((await fs.stat(full)).mtimeMs)
              } catch {
                /* unreadable entry — leave mtime null */
              }
              return { name: d.name, path: full, is_dir: d.isDirectory(), mtime }
            }),
          )
        )
          .sort(
            (a, b) =>
              Number(b.is_dir) - Number(a.is_dir) ||
              Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) ||
              a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
          )
        return send(res, 200, { entries })
      }
      case '/run': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        const { program, args, cwd } = JSON.parse(await readBody(req))
        if (!program) return send(res, 400, { error: 'missing program' })
        const out = await new Promise((resolve) => {
          execFile(
            program,
            Array.isArray(args) ? args : [],
            { cwd: cwd || homeDir, maxBuffer: 8 << 20 },
            (err, stdout, stderr) =>
              resolve({
                code: err?.code ?? 0,
                stdout: String(stdout || ''),
                stderr: String(stderr || (err && !stdout ? err.message : '')),
              }),
          )
        })
        return send(res, 200, out)
      }
      // VS Code widget: one `code serve-web` per folder, reused while alive.
      case '/code-serve': {
        const dir = url.searchParams.get('dir') || ''
        if (!dir) return send(res, 400, { error: 'missing dir' })
        try {
          return send(res, 200, await codeServe(dir))
        } catch (err) {
          return send(res, 500, { error: String(err?.message ?? err) })
        }
      }
      case '/code-stop': {
        const dir = url.searchParams.get('dir') || ''
        const s = codeServers.get(dir)
        if (s) {
          killServer(s)
          codeServers.delete(dir)
        }
        return send(res, 200, { ok: true })
      }
      case '/save': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
        const { path, content } = JSON.parse(await readBody(req))
        if (!path) return send(res, 400, { error: 'missing path' })
        await fs.writeFile(path, content, 'utf8')
        return send(res, 200, { ok: true, path })
      }
      default:
        return send(res, 404, { error: 'not found' })
    }
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) })
  }
})

// ---------- web widget proxy (its own port = its own origin) ----------
// Fetch a URL server-side and strip framing protections so the web widget can
// embed sites that send X-Frame-Options / CSP frame-ancestors. The page's own
// scripts run on http://127.0.0.1:7532, which the API above refuses, so a
// proxied site can't reach the shell, file or command routes. Nothing but
// /proxy is served here, and it sends no CORS headers.

/** Is `target` (an http(s) URL) on this machine or a private network, by its
 *  host as written? */
function localTarget(target) {
  let host
  try {
    host = new URL(target).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return true
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a >= 224
  }
  if (net.isIPv6(host)) {
    if (host.startsWith('::ffff:')) return localTarget(`http://${host.slice(7)}/`) || !net.isIPv4(host.slice(7))
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  }
  return false
}

const proxyServer = http.createServer(async (req, res) => {
  if (!hostOk(req, PROXY_PORT)) return send(res, 403, { error: 'bad host' })
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/proxy' || req.method !== 'GET') return send(res, 404, { error: 'not found' })
  const target = url.searchParams.get('url')
  if (!target || !/^https?:\/\//i.test(target)) return send(res, 400, { error: 'need an http(s) url' })
  // a proxied page can read what this returns, so never fetch this machine or
  // the local network for it (local dev servers are framed directly anyway)
  if (localTarget(target)) return send(res, 400, { error: 'refusing a local address' })
  try {
    const upstream = await fetch(target, {
      headers: { 'user-agent': req.headers['user-agent'] || 'ccanvas' },
      redirect: 'follow',
    })
    const ct = upstream.headers.get('content-type') || 'text/html; charset=utf-8'
    const buf = Buffer.from(await upstream.arrayBuffer())
    const headers = { 'Content-Type': ct }
    if (ct.includes('text/html')) {
      let html = buf.toString('utf8')
      // a <base> makes relative + root-relative asset URLs resolve upstream
      if (!/<base\s/i.test(html)) {
        html = /<head[^>]*>/i.test(html)
          ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${target}">`)
          : `<base href="${target}">` + html
      }
      res.writeHead(upstream.status, headers)
      return res.end(html)
    }
    res.writeHead(upstream.status, headers)
    return res.end(buf)
  } catch (err) {
    return send(res, 502, { error: String(err?.message ?? err) })
  }
})

// ---------- terminal bridge (WebSocket on the same server) ----------
// Same checks as the HTTP routes, before the upgrade: browsers let any page
// open a WebSocket to any host (no CORS), so without this any site could get
// a shell.

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const refused = refusal(req, new URL(req.url, 'http://localhost'))
  if (refused) {
    socket.end(`HTTP/1.1 ${refused[0]} ${http.STATUS_CODES[refused[0]]}\r\nConnection: close\r\n\r\n`)
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost')
  const cols = Number(url.searchParams.get('cols')) || 80
  const rows = Number(url.searchParams.get('rows')) || 24
  const reqCwd = url.searchParams.get('cwd')

  let term
  try {
    term = pty.spawn(defaultShell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: reqCwd || homeDir,
      env: shellEnv(),
    })
  } catch (err) {
    socket.send(`\r\n\x1b[31mfailed to spawn ${defaultShell}: ${err?.message}\x1b[0m\r\n`)
    socket.close()
    return
  }

  console.log(`+ session  ${defaultShell}  (${cols}x${rows})  cwd=${reqCwd || homeDir}`)

  term.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(data)
  })

  socket.on('message', (raw) => {
    const msg = raw.toString()
    if (msg.startsWith('{')) {
      try {
        const ctl = JSON.parse(msg)
        if (ctl.__ctl === 'resize') {
          term.resize(Math.max(2, ctl.cols | 0), Math.max(2, ctl.rows | 0))
          return
        }
      } catch {
        /* not control json — fall through as input */
      }
    }
    term.write(msg)
  })

  const cleanup = () => {
    try {
      term.kill()
    } catch {
      /* already gone */
    }
  }
  socket.on('close', () => {
    console.log('- session closed')
    cleanup()
  })
  term.onExit(() => socket.readyState === socket.OPEN && socket.close())
})

server.listen(PORT, HOST, () => {
  console.log('\x1b[38;2;217;120;90m✦ ccanvas backend\x1b[0m')
  console.log(`  listening  ws + http://${HOST}:${PORT}`)
  console.log(`  proxy      http://${HOST}:${PROXY_PORT}`)
  console.log(`  shell      ${defaultShell}`)
  console.log(`  home       ${homeDir}`)
  console.log(`  host       ${os.hostname()} (${process.platform})`)
  console.log('  ready — open a terminal widget in ccanvas.\n')
})
proxyServer.listen(PROXY_PORT, HOST)
