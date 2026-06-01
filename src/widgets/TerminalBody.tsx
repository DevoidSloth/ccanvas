import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { WidgetElement } from '../lib/types'
import { claudeColorName } from '../lib/types'
import { connectPty, type Term } from '../lib/terminal'
import { useStore, selectActive } from '../store/workspace'
import { findFilePaths, widgetKindForFile } from '../lib/filetypes'
import { resolvePath, baseName } from '../lib/backend'
import {
  useAgents,
  registerTransport,
  unregisterTransport,
  looksLikePrompt,
  stripAnsi,
  scrapeCost,
  ensureNotifyPermission,
  notify,
} from '../lib/agents'
import { onAgentTurnComplete } from '../lib/flow'

type Mode = 'connecting' | 'pty' | 'local'

// base font size; scaled up by the supersample factor when the canvas is
// zoomed in so the terminal stays crisp under the world's CSS transform
const BASE_FONT = 12.5

// Terminal widget. Prefers a real shell — the in-process PTY under Tauri, or the
// optional WebSocket bridge in the browser. Falls back to a tiny in-browser
// shell when neither is available. Agent widgets auto-launch `claude`.
export function TerminalBody({
  el,
  active,
  visible = true,
}: {
  el: WidgetElement
  active: boolean
  /** is the tab this terminal lives on currently shown? */
  visible?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const transportRef = useRef<Term | null>(null)
  const modeRef = useRef<Mode>('connecting')
  const lineRef = useRef('')
  const localStartedRef = useRef(false)
  const kRef = useRef(1)
  // cascade offset so repeatedly opening files from the output don't stack
  const openCountRef = useRef(0)
  const [status, setStatus] = useState<Mode>('connecting')
  const [attempt, setAttempt] = useState(0)
  // supersample factor (1 at ≤100% zoom; grows with zoom-in for crisp text).
  // Tracks the live zoom EXACTLY so the inner `scale(1/k)` cancels the world's
  // `scale(zoom)` — see the zoom-tracking effect for why selection needs k===zoom.
  const [k, setK] = useState(() => {
    const b = Math.max(1, selectActive(useStore.getState()).camera.zoom)
    kRef.current = b
    return b
  })
  // connect only once the terminal has actually been shown — opening/writing an
  // xterm on a hidden tab leaves its renderer blank. Once armed it stays armed,
  // so the live shell persists when you switch away and back.
  const [armed, setArmed] = useState(visible)
  useEffect(() => {
    if (visible) setArmed(true)
  }, [visible])

  const mutateElement = useStore((s) => s.mutateElement)
  const isAgent = el.kind === 'agent'
  const cwd = el.cwd || '~'

  // command run once the shell is live. Agents launch claude bound to a stable
  // session id; a reopened agent resumes that session instead of starting fresh.
  // Build the agent launch command. The first run pins a stable session id
  // (`--session-id`); a reopened agent resumes it (`--resume`). Model and
  // skip-permission flags are appended. Reused by the resume self-heal path.
  const buildAgentLaunch = (sessionId: string | undefined, started: boolean) => {
    const base = sessionId
      ? started
        ? `claude --resume ${sessionId}`
        : `claude --session-id ${sessionId}`
      : 'claude'
    const flags: string[] = []
    // name the session at creation via the flag (deterministic, no TUI timing);
    // on resume the name already persists. Live renames go through /rename.
    if (sessionId && !started && el.title && el.title !== 'claude agent')
      flags.push(`--name "${el.title.replace(/["`$\\]/g, '')}"`)
    if (el.model) flags.push(`--model ${el.model}`)
    if (el.skipPermissions) flags.push('--dangerously-skip-permissions')
    return [base, ...flags].join(' ')
  }
  const launch = isAgent ? buildAgentLaunch(el.sessionId, !!el.agentStarted) : undefined

  // ---- terminal lifecycle + single input handler (created once shown) ----
  useEffect(() => {
    if (!armed || !innerRef.current || !hostRef.current) return
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: BASE_FONT * kRef.current,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: {
        background: '#0a0b0d',
        foreground: '#e8e6e1',
        cursor: '#e8795a',
        cursorAccent: '#0a0b0d',
        selectionBackground: 'rgba(232,121,90,0.25)',
        black: '#1a1d24',
        red: '#e8795a',
        green: '#8bbf73',
        yellow: '#d8a657',
        blue: '#6db5a8',
        magenta: '#c89bd6',
        cyan: '#7fc7c0',
        white: '#c8c6c0',
        brightBlack: '#61605b',
        brightRed: '#f08e72',
        brightGreen: '#a6d189',
        brightYellow: '#e5c07b',
        brightBlue: '#82c7bb',
        brightMagenta: '#d9b3e3',
        brightCyan: '#98d4cd',
        brightWhite: '#e8e6e1',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(innerRef.current)
    termRef.current = term
    fitRef.current = fit

    // ---- clickable filenames ----
    // Underline any openable file path in the output and, on click, open it in
    // the widget that fits its type: a data viewer (csv/parquet/…), a figure
    // viewer (png/svg/…), or the plain-text editor. The live element is read at
    // click time so a moved terminal still spawns the viewer beside itself.
    const openFileFromTerminal = (rawPath: string) => {
      const store = useStore.getState()
      const ws = store.active()
      if (!ws) return
      const self =
        (ws.elements.find((e) => e.id === el.id) as WidgetElement | undefined) ?? el
      const kind = widgetKindForFile(rawPath)
      const abs = resolvePath(self.cwd, rawPath)
      // focus an already-open viewer for this exact file rather than duplicate it
      const existing = ws.elements.find(
        (e): e is WidgetElement =>
          e.type === 'widget' &&
          e.kind === kind &&
          !!e.path &&
          resolvePath(e.cwd, e.path) === abs,
      )
      if (existing) {
        store.setSelection([existing.id])
        store.bringToFront([existing.id])
        store.setActiveWidget(existing.id)
        return
      }
      const n = openCountRef.current++
      store.spawnWidget(
        kind,
        self.x + self.w + 320 + (n % 5) * 30,
        self.y + 140 + (n % 5) * 30,
        { path: rawPath, cwd: self.cwd, title: baseName(rawPath) },
      )
    }

    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const bufLine = term.buffer.active.getLine(bufferLineNumber - 1)
        if (!bufLine) {
          callback(undefined)
          return
        }
        const matches = findFilePaths(bufLine.translateToString(true))
        if (!matches.length) {
          callback(undefined)
          return
        }
        callback(
          matches.map((mt) => ({
            text: mt.path,
            // ranges are 1-based; end.x is the last cell of the link (inclusive)
            range: {
              start: { x: mt.index + 1, y: bufferLineNumber },
              end: { x: mt.index + mt.length, y: bufferLineNumber },
            },
            activate: () => openFileFromTerminal(mt.path),
          })),
        )
      },
    })

    // standard terminal copy/paste keys: Cmd+C/V on macOS, Ctrl+Shift+C/V
    // elsewhere. Plain Ctrl+C is left alone so it still sends SIGINT.
    const isMac = /mac/i.test(navigator.userAgent)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      const k = ev.key.toLowerCase()
      const combo = isMac ? ev.metaKey && !ev.altKey : ev.ctrlKey && ev.shiftKey
      if (combo && k === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (combo && k === 'v') {
        void navigator.clipboard
          .readText()
          .then((t) => t && term.paste(t))
          .catch(() => {})
        return false
      }
      return true
    })

    const writePrompt = () => term.write(`\x1b[38;2;232;121;90m${cwd}\x1b[0m $ `)

    const runLocalLine = () => {
      term.write('\r\n')
      const raw = lineRef.current
      lineRef.current = ''
      const parts = raw.trim().split(/\s+/)
      const cmd = parts[0] ?? ''
      let out = ''
      switch (cmd) {
        case '':
          break
        case 'help':
          out =
            'commands: help, clear, echo, pwd, ls, date, whoami\r\n' +
            '  no real shell here — Tauri or `npm run server` give a live terminal'
          break
        case 'clear':
          term.write('\x1b[2J\x1b[H')
          break
        case 'pwd':
          out = cwd
          break
        case 'echo':
          out = parts.slice(1).join(' ')
          break
        case 'date':
          out = new Date().toString()
          break
        case 'whoami':
          out = 'ccanvas'
          break
        case 'ls':
          out = 'workspace.ccnvs   notes/   src/'
          break
        default:
          out = `ccanvas: command not found: ${cmd}`
      }
      if (out) term.write(out.replace(/\n/g, '\r\n') + '\r\n')
      writePrompt()
    }

    const handleLocal = (d: string) => {
      for (const ch of d) {
        const code = ch.charCodeAt(0)
        if (ch === '\r' || ch === '\n') runLocalLine()
        else if (code === 127 || code === 8) {
          if (lineRef.current.length) {
            lineRef.current = lineRef.current.slice(0, -1)
            term.write('\b \b')
          }
        } else if (code === 3) {
          term.write('^C\r\n')
          lineRef.current = ''
          writePrompt()
        } else if (code === 12) {
          term.write('\x1b[2J\x1b[H')
          writePrompt()
          term.write(lineRef.current)
        } else if (code >= 32) {
          lineRef.current += ch
          term.write(ch)
        }
      }
    }

    // exposed to the connect effect to start the local fallback shell
    ;(term as unknown as { _startLocal?: () => void })._startLocal = () => {
      if (localStartedRef.current) return
      localStartedRef.current = true
      lineRef.current = ''
      term.write('\r\n')
      term.write('  \x1b[38;2;200;155;214mccanvas local shell\x1b[0m — no live backend.\r\n')
      term.write('  type \x1b[38;2;232;121;90mhelp\x1b[0m · a real shell needs Tauri or `npm run server`\r\n\r\n')
      writePrompt()
    }

    const onData = term.onData((d) => {
      const t = transportRef.current
      if (t) t.send(d)
      else if (modeRef.current === 'local') handleLocal(d)
    })

    const ro = new ResizeObserver(() => {
      const host = hostRef.current
      // skip while hidden (e.g. on an inactive tab) so we don't resize to 0
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        if (modeRef.current === 'pty') transportRef.current?.resize(term.cols, term.rows)
      } catch {
        /* element detached */
      }
    })
    ro.observe(hostRef.current)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* noop */
      }
    })

    return () => {
      onData.dispose()
      linkProvider.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed])

  // ---- connect to a real shell, else fall back to the local shell ----
  useEffect(() => {
    if (!armed) return
    const term = termRef.current
    if (!term) return

    let disposed = false
    modeRef.current = 'connecting'
    localStartedRef.current = false
    setStatus('connecting')

    const setAgentStatus = useAgents.getState().setStatus
    setAgentStatus(el.id, 'connecting')

    const goLocal = () => {
      if (disposed || modeRef.current === 'local') return
      transportRef.current = null
      modeRef.current = 'local'
      setStatus('local')
      setAgentStatus(el.id, 'off')
      unregisterTransport(el.id)
      ;(term as unknown as { _startLocal?: () => void })._startLocal?.()
    }

    // ---- session resume resilience ----
    // attemptedResume: this launch used `claude --resume <id>`. If that id
    // doesn't exist locally (shared .ccnvs, deleted transcript, or a session
    // that never persisted) claude errors out — we detect that and self-heal
    // into a fresh session instead of leaving a dead agent.
    const watchSession = isAgent && !!el.sessionId
    const FAIL_INUSE = /already in use|already exists/i
    const FAIL_MISSING =
      /no conversation found|couldn'?t find (a |the )?(matching )?session|session .*(not found|does not exist|is invalid|was not found)/i
    let recovered = false
    let resumeWatch = false
    let ready = false // Claude has reached its prompt (output went quiet once)
    // identity + prompt to push once Claude is interactive. Driven by output
    // "settle" events, never a fixed delay, so we adapt to any boot time.
    const launchTasks: { data: string; enter: boolean }[] = []
    let taskFallback: ReturnType<typeof setTimeout> | null = null
    let readyFallback: ReturnType<typeof setTimeout> | null = null
    // flow orchestration arms only once Claude is up and its launch sequence
    // (colour + initial prompt) has drained — so boot churn and the typed-but-
    // unsubmitted first prompt never masquerade as a completed turn. Holds the
    // turn index at arm time; only later turns can fire outgoing flow edges.
    let flowArmTurn: number | null = null

    // mark the session resumable — only once Claude is actually up, so a
    // reload never tries to resume a session that never really started
    const markStarted = () => {
      if (disposed || !isAgent || !el.sessionId) return
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).agentStarted = true
      })
    }
    // send the next queued command; the rest fire on later settles (each one
    // redraws the UI), with a fallback in case a command emits no output
    const sendNextTask = () => {
      if (taskFallback) {
        clearTimeout(taskFallback)
        taskFallback = null
      }
      const task = launchTasks.shift()
      if (!task) return
      transportRef.current?.send(task.enter ? task.data + '\r' : task.data)
      if (launchTasks.length) taskFallback = setTimeout(sendNextTask, 1500)
    }
    // Claude's interactive UI renders box-drawing characters and a shortcuts
    // hint; a bare shell prompt or a still-loading binary does not. Use that to
    // tell "Claude is actually ready" apart from an early boot pause, so we
    // never fire slash commands into a dead/booting prompt.
    const looksLikeClaude = () => {
      const s = stripAnsi(tail)
      return /[╭╮╰╯┌┐└┘│─]/.test(s) || /\? for shortcuts/i.test(s)
    }
    const becomeReady = () => {
      if (ready) return
      ready = true
      if (readyFallback) {
        clearTimeout(readyFallback)
        readyFallback = null
      }
      markStarted()
      sendNextTask()
    }
    // called whenever output goes quiet
    const onSettle = () => {
      if (!isAgent || modeRef.current !== 'pty') return
      if (!ready) {
        // wait until Claude's UI is up and it isn't mid-question (trust/permission)
        if (!looksLikeClaude() || looksLikePrompt(tail)) return
        becomeReady()
        return
      }
      sendNextTask()
    }
    // self-heal a failed launch:
    //  • "already in use" → the session exists, so resume it instead
    //  • "not found"      → the session is gone, so start a fresh one
    const recoverSession = (reason: 'inuse' | 'missing') => {
      if (recovered) return
      recovered = true
      resumeWatch = false
      ready = false // re-detect readiness for the relaunched session
      const t = transportRef.current
      const relaunch = (cmd: string) => {
        if (!t) return
        t.send('\x03') // Ctrl-C to drop the erroring prompt, then relaunch
        setTimeout(() => t.send(cmd + '\r'), 150)
      }
      if (reason === 'inuse' && el.sessionId) {
        term.write('\r\n\x1b[38;2;200;155;214m· session already running — resuming it\x1b[0m\r\n')
        relaunch(buildAgentLaunch(el.sessionId, true))
      } else {
        const fresh = crypto.randomUUID()
        mutateElement(el.id, (w) => {
          ;(w as WidgetElement).sessionId = fresh
          ;(w as WidgetElement).agentStarted = false
        })
        term.write('\r\n\x1b[38;2;200;155;214m· previous session not found here — starting fresh\x1b[0m\r\n')
        relaunch(buildAgentLaunch(fresh, false))
      }
    }

    // ---- activity status: streaming → working; quiet → idle/waiting ----
    // keep a generous rolling buffer: status/cost detection only need the end,
    // but flow piping forwards this agent's last output to the next agent
    let tail = ''
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let wasWorking = false
    let workingSince: number | null = null
    const onActivity = (text: string) => {
      tail = (tail + text).slice(-12000)
      if (resumeWatch && !recovered) {
        const recent = stripAnsi(tail).slice(-400)
        if (FAIL_INUSE.test(recent)) recoverSession('inuse')
        else if (FAIL_MISSING.test(recent)) recoverSession('missing')
      }
      if (workingSince == null) workingSince = Date.now()
      setAgentStatus(el.id, 'working')
      wasWorking = true
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        const waiting = looksLikePrompt(tail)
        setAgentStatus(el.id, waiting ? 'waiting' : 'idle')
        // ping when an agent goes quiet while you're looking elsewhere
        if (
          wasWorking &&
          isAgent &&
          useStore.getState().activeWidgetId !== el.id
        ) {
          notify(
            el.title || 'claude agent',
            waiting ? 'is waiting for your input' : 'finished — back to you',
          )
        }
        wasWorking = false
        // metrics: one working→idle turn, plus any cost scraped from output
        if (isAgent && workingSince != null) {
          useAgents.getState().recordTurn(el.id, Math.max(0, Date.now() - workingSince - 700))
          workingSince = null
          const c = scrapeCost(tail)
          if (c != null) useAgents.getState().setCost(el.id, c)
          // orchestration: fire outgoing flow arrows on a genuine completion.
          // Only once ready + launch queue drained (so boot/launch settles are
          // ignored), and only for turns after the arming settle.
          const turns = useAgents.getState().metrics[el.id]?.turns ?? 0
          if (ready && launchTasks.length === 0) {
            if (flowArmTurn === null) flowArmTurn = turns
            else if (!waiting && turns > flowArmTurn)
              void onAgentTurnComplete(el.id, turns, tail)
          }
        }
        onSettle()
      }, 700)
    }

    connectPty(
      { id: el.id, cols: term.cols, rows: term.rows, cwd: el.cwd || undefined, launch },
      {
        onData: (chunk) => {
          term.write(chunk as string | Uint8Array)
          onActivity(
            typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk),
          )
        },
        onExit: () => {
          if (disposed) return
          term.write('\r\n\x1b[38;2;196;96;79m· shell session ended\x1b[0m\r\n')
          goLocal()
        },
      },
    ).then((t) => {
      if (disposed) {
        t?.close()
        return
      }
      if (t) {
        // wire the transport up BEFORE start() so the shell's cursor-position
        // reply (xterm.onData) routes back to the pty instead of being dropped
        transportRef.current = t
        modeRef.current = 'pty'
        setStatus('pty')
        setAgentStatus(el.id, 'idle')
        registerTransport(el.id, {
          send: (d) => t.send(d),
          kind: isAgent ? 'agent' : 'terminal',
          title: el.title,
        })
        if (isAgent) void ensureNotifyPermission()
        try {
          fitRef.current?.fit()
          t.resize(term.cols, term.rows)
        } catch {
          /* noop */
        }
        t.start()
        // A re-attach (the shell survived a webview reload) already has claude
        // running — start() replays its scrollback to restore the view, so we
        // must NOT relaunch or it'd stack a second claude. The activity watchers
        // below still run, so status/flows pick back up from the live output.
        if (isAgent) {
          // launch sequence runs only on a fresh spawn — a re-attach already has
          // claude running. Queue colour + first prompt to push once Claude's UI
          // is up (the name is set via the --name launch flag, so it needs no
          // timing); these fire when Claude is detected ready (see onSettle).
          if (!t.reused) {
            const cn = claudeColorName(el.color)
            if (el.color && cn !== 'default')
              launchTasks.push({ data: `/color ${cn}`, enter: true })
            // first launch only: the initial prompt (no \r so you can review it)
            if (!el.agentStarted && el.agentPrompt)
              launchTasks.push({ data: el.agentPrompt, enter: false })
          }
          // safety net: become ready even if Claude's UI is never detected, so
          // the session is marked resumable, the queue isn't stranded, and flow
          // orchestration re-arms after a re-attach
          readyFallback = setTimeout(becomeReady, 15000)
        }
        // watch briefly for a launch failure (missing or duplicate session) and
        // self-heal — only on a fresh launch; a re-attach issues no launch
        if (watchSession && !t.reused) {
          resumeWatch = true
          setTimeout(() => {
            resumeWatch = false
          }, 6000)
        }
      } else {
        goLocal()
      }
    })

    return () => {
      disposed = true
      if (idleTimer) clearTimeout(idleTimer)
      if (taskFallback) clearTimeout(taskFallback)
      if (readyFallback) clearTimeout(readyFallback)
      unregisterTransport(el.id)
      useAgents.getState().clear(el.id)
      transportRef.current?.close()
      transportRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, attempt])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  // Match the supersample factor to the live zoom (debounced so the font only
  // re-measures once the gesture settles, not every frame). xterm maps a click
  // to a cell by dividing the pointer offset from `getBoundingClientRect()` —
  // which is post-transform / visual — by the UN-scaled css cell size. That's
  // only correct when the terminal's net on-screen scale is 1, i.e. when the
  // inner `scale(1/k)` exactly cancels the world's `scale(zoom)` → k === zoom.
  // The old code bucketed k to the nearest 0.5 (and capped it at 3), so k≠zoom
  // almost always and the selection highlight drifted a line or two below the
  // cursor on zoom-in. Track zoom exactly; floor at 1 (don't shrink below the
  // base font — keeps ≤100% behaviour and avoids flaky tiny-font measurement).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = useStore.subscribe((s) => {
      const nk = Math.max(1, selectActive(s).camera.zoom)
      // ignore sub-percent drift so unrelated state churn doesn't re-measure
      if (Math.abs(nk - kRef.current) < 0.01) return
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        kRef.current = nk
        setK(nk)
      }, 150)
    })
    return () => {
      if (t) clearTimeout(t)
      unsub()
    }
  }, [])

  // apply the supersample factor: bigger font into a counter-scaled, k× sized
  // host keeps the same cols/rows (no shell reflow) but renders at k× pixels
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = BASE_FONT * k
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        if (modeRef.current === 'pty') transportRef.current?.resize(term.cols, term.rows)
      } catch {
        /* noop */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [k, armed])

  // when our tab becomes visible, force xterm to re-fit + repaint — it was
  // opened/written while hidden (kept mounted across tabs) and its renderer
  // won't paint on a visibility change on its own
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    if (!term) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        term.refresh(0, term.rows - 1)
        if (modeRef.current === 'pty') transportRef.current?.resize(term.cols, term.rows)
      } catch {
        /* noop */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible])

  const label =
    status === 'pty'
      ? 'pty · live shell'
      : status === 'local'
        ? 'local · in-browser shell'
        : 'connecting…'

  // right-click: copy the current selection, or paste the clipboard if nothing
  // is selected — the usual Windows-terminal behaviour.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const term = termRef.current
    if (!term) return
    if (term.hasSelection()) {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
      term.clearSelection()
    } else {
      void navigator.clipboard
        .readText()
        .then((t) => {
          if (t) term.paste(t)
        })
        .catch(() => {})
    }
  }

  return (
    <div className="term" onContextMenu={onContextMenu}>
      <div ref={hostRef} className="term__screen">
        <div
          ref={innerRef}
          className="term__inner"
          style={{
            width: `${k * 100}%`,
            height: `${k * 100}%`,
            transform: `scale(${1 / k})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
      <div className="term__status">
        <span
          className={`term__dot ${status === 'pty' ? 'term__dot--on' : 'term__dot--off'}`}
        />
        {label}
        {status === 'local' && (
          <button
            className="term__retry"
            style={{ marginLeft: 'auto', marginTop: 0, padding: '2px 9px' }}
            onClick={() => setAttempt((a) => a + 1)}
          >
            retry
          </button>
        )}
      </div>
    </div>
  )
}
