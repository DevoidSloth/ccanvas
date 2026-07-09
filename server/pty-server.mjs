// ============================================================
// ccanvas — local backend (PTY bridge + filesystem)
//
// Start with:  npm run server   (or `npm start` for server + web)
//
// Provides, all on ws/http://127.0.0.1:7531:
//   • WebSocket  — a real shell per terminal widget (node-pty)
//   • GET  /health      — liveness probe
//   • GET  /default-dir — the user's home directory
//   • GET  /pick-dir    — native "choose folder" dialog → { path }
//   • GET  /pick-file   — native "open .ccnvs" dialog   → { path, content }
//   • GET  /read?path=  — read a file (utf8)             → { content }
//   • GET  /read-bytes? — read a file (base64 bytes)     → { b64 }
//   • GET  /file?path=  — stream a file with Range support (video/audio)
//   • POST /save        — write a file  { path, content }
//
// The canvas needs real folders/paths (for terminal cwd + where .ccnvs
// lives) which a browser sandbox can't provide — so this process does it.
// ============================================================
import os from 'node:os'
import http from 'node:http'
import nodePath from 'node:path'
import { promises as fs, createReadStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'

const PORT = 7531
const HOST = '127.0.0.1'

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

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
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
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return empty
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pdir = nodePath.join(root, proj.name)
    let files
    try {
      files = await fs.readdir(pdir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      const fp = nodePath.join(pdir, f.name)
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
          // new work only — cache *reads* are cheap and re-counted each turn
          const tok =
            (u.input_tokens || 0) +
            (u.output_tokens || 0) +
            (u.cache_creation_input_tokens || 0)
          if (!tok) continue
          const ts = v.timestamp ? Date.parse(v.timestamp) : NaN
          if (!Number.isNaN(ts) && ts >= cutoff) entries.push([ts, tok])
        }
      } catch {
        /* skip unreadable file */
      }
    }
  }
  if (!entries.length) return empty
  entries.sort((a, b) => a[0] - b[0])
  const FIVE_H = 5 * 3600_000
  const dayCut = now - 24 * 3600_000
  const dayTokens = entries.filter((e) => e[0] >= dayCut).reduce((s, e) => s + e[1], 0)
  let bStart = entries[0][0]
  let bTok = 0
  let bMsg = 0
  let prev = entries[0][0]
  for (const [ts, tok] of entries) {
    if (ts - bStart >= FIVE_H || ts - prev > FIVE_H) {
      bStart = ts
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
    'Access-Control-Allow-Origin': '*',
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
    'Access-Control-Allow-Origin': '*',
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }
  const url = new URL(req.url, 'http://localhost')
  try {
    switch (url.pathname) {
      case '/health':
        return send(res, 200, { ok: true, platform: process.platform, home: homeDir, ffmpeg: hasFfmpeg })
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
      case '/proxy': {
        // Fetch a URL server-side and strip framing protections so the web
        // widget can embed sites that send X-Frame-Options / CSP frame-ancestors.
        const target = url.searchParams.get('url')
        if (!target) return send(res, 400, { error: 'missing url' })
        try {
          const upstream = await fetch(target, {
            headers: { 'user-agent': req.headers['user-agent'] || 'ccanvas' },
            redirect: 'follow',
          })
          const ct = upstream.headers.get('content-type') || 'text/html; charset=utf-8'
          const buf = Buffer.from(await upstream.arrayBuffer())
          const headers = {
            'Content-Type': ct,
            'Access-Control-Allow-Origin': '*',
          }
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

// ---------- terminal bridge (WebSocket on the same server) ----------

const wss = new WebSocketServer({ server })

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
      env: process.env,
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
  console.log(`  shell      ${defaultShell}`)
  console.log(`  home       ${homeDir}`)
  console.log(`  host       ${os.hostname()} (${process.platform})`)
  console.log('  ready — open a terminal widget in ccanvas.\n')
})
