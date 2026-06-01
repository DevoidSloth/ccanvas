// Terminal transport: connects an xterm to a real shell.
//   • Tauri — in-process PTY (Rust commands + pty:data / pty:exit events)
//   • Web   — the optional WebSocket bridge (server/pty-server.mjs)
// Resolves to null when no real backend is reachable, so the caller can fall
// back to the in-browser shell.
//
// Sessions are keyed by the widget id (stable across a webview reload), so the
// Tauri backend can re-attach a terminal to its still-running shell after a dev
// hot-reload instead of spawning a fresh one — see src-tauri/src/pty.rs. The
// shell is only torn down by `killPty`, which the store calls on real deletion.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri } from './backend'

export type Term = {
  /** true when we re-attached to an already-running shell (it survived a
   *  reload). The caller must NOT relaunch into it — its process is intact. */
  reused: boolean
  /** begin streaming output + run the launch command. Call only after the
   *  caller has wired this Term up, so the shell's cursor-position query
   *  (\x1b[6n) gets its reply routed back instead of dropped. */
  start: () => void
  send: (data: string) => void
  resize: (cols: number, rows: number) => void
  /** detach: stop streaming but leave the shell running so a later mount can
   *  re-attach. (In web mode there's no persistence, so this closes the socket
   *  and the server ends the shell.) */
  close: () => void
}

export type PtyOpts = {
  /** stable session key — the widget id; survives webview reloads */
  id: string
  cols: number
  rows: number
  cwd?: string
  /** command to run once the shell is live (e.g. `claude --resume <id>`) */
  launch?: string
}
export type PtyHandlers = {
  onData: (chunk: Uint8Array | string) => void
  /** fired when the shell exits or the connection drops after being live */
  onExit: () => void
}

const WS_URL = 'ws://127.0.0.1:7531'

export async function connectPty(opts: PtyOpts, h: PtyHandlers): Promise<Term | null> {
  return isTauri() ? connectTauri(opts, h) : connectWebSocket(opts, h)
}

/** Tear a shell down for good. Called when the widget is actually deleted, not
 *  on the incidental unmounts (reload / tab switch) where we want it to live. */
export function killPty(id: string): void {
  // Tauri owns persistent sessions; in web mode the shell already dies when its
  // socket closes on unmount, so there's nothing to kill out of band.
  if (isTauri()) void invoke('pty_kill', { id })
}

async function connectTauri(opts: PtyOpts, h: PtyHandlers): Promise<Term | null> {
  try {
    const reused = await invoke<boolean>('pty_open', {
      id: opts.id,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? null,
    })
    console.debug(
      `[pty] open id=${opts.id} reused=${reused} launch=${opts.launch ?? ''} cwd=${opts.cwd ?? ''}`,
    )
    let gotData = false
    const offData: UnlistenFn = await listen<{ id: string; bytes: number[] }>(
      'pty:data',
      (e) => {
        if (e.payload.id !== opts.id) return
        if (!gotData) {
          gotData = true
          console.debug(`[pty] id=${opts.id} first data (${e.payload.bytes.length}b)`)
        }
        h.onData(new Uint8Array(e.payload.bytes))
      },
    )
    const offExit: UnlistenFn = await listen<{ id: string }>('pty:exit', (e) => {
      if (e.payload.id === opts.id) {
        console.debug(`[pty] id=${opts.id} exit`)
        h.onExit()
      }
    })
    return {
      reused,
      start: () => {
        // flush buffered/replayed output + launch only now — transportRef is
        // wired, so xterm's reply to the shell's \x1b[6n query routes back to
        // the pty instead of being dropped. Skip launch on a re-attach: the
        // shell (and any claude in it) is already running.
        void invoke('pty_start', { id: opts.id })
        if (opts.launch && !reused) void invoke('pty_write', { id: opts.id, data: opts.launch + '\r' })
      },
      send: (data) => void invoke('pty_write', { id: opts.id, data }),
      resize: (cols, rows) => void invoke('pty_resize', { id: opts.id, cols, rows }),
      close: () => {
        offData()
        offExit()
        void invoke('pty_detach', { id: opts.id })
      },
    }
  } catch (err) {
    console.error('[pty] connect failed', err)
    return null
  }
}

function connectWebSocket(opts: PtyOpts, h: PtyHandlers): Promise<Term | null> {
  return new Promise((resolve) => {
    let ws: WebSocket
    const query =
      `?id=${encodeURIComponent(opts.id)}&cols=${opts.cols}&rows=${opts.rows}` +
      (opts.cwd ? `&cwd=${encodeURIComponent(opts.cwd)}` : '')
    try {
      ws = new WebSocket(WS_URL + query)
    } catch {
      resolve(null)
      return
    }
    let opened = false
    ws.onopen = () => {
      opened = true
      ws.send(JSON.stringify({ __ctl: 'resize', cols: opts.cols, rows: opts.rows }))
      resolve({
        // the web bridge has no cross-reload persistence: every connection is a
        // fresh shell, so the launch sequence always runs
        reused: false,
        start: () => {
          if (opts.launch && ws.readyState === WebSocket.OPEN) ws.send(opts.launch + '\r')
        },
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data)
        },
        resize: (cols, rows) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ __ctl: 'resize', cols, rows }))
        },
        close: () => {
          ws.onclose = null
          ws.close()
        },
      })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') h.onData(ev.data)
    }
    ws.onerror = () => {
      if (!opened) resolve(null)
    }
    ws.onclose = () => {
      if (!opened) resolve(null)
      else h.onExit()
    }
  })
}
