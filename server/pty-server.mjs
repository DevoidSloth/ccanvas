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
//   • GET  /read?path=  — read a file                   → { content }
//   • POST /save        — write a file  { path, content }
//
// The canvas needs real folders/paths (for terminal cwd + where .ccnvs
// lives) which a browser sandbox can't provide — so this process does it.
// ============================================================
import os from 'node:os'
import http from 'node:http'
import nodePath from 'node:path'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'

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
        return send(res, 200, { ok: true, platform: process.platform, home: homeDir })
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
      case '/list-dir': {
        const p = url.searchParams.get('path')
        if (!p) return send(res, 400, { error: 'missing path' })
        const dirents = await fs.readdir(p, { withFileTypes: true })
        const entries = dirents
          .map((d) => ({
            name: d.name,
            path: nodePath.join(p, d.name),
            is_dir: d.isDirectory(),
          }))
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
