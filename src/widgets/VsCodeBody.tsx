import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore, selectActive } from '../store/workspace'
import { codeServe, codeStop, openExternal, baseName } from '../lib/backend'
import { IconReload, IconEditor } from '../ui/icons'

// VS Code widget. `code serve-web` runs the real VS Code as a local web server
// for the widget's folder and we embed it. One server per folder is shared by
// every VS Code widget on that folder and stops when the app exits.
//
// Worth knowing: extensions come from Open VSX (Microsoft's marketplace isn't
// available to the web server), and keystrokes inside the frame belong to VS
// Code — ccanvas shortcuts like ⌘1 resume once you click back onto the canvas.

type State =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; url: string }
  | { phase: 'error'; message: string }

export function VsCodeBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const tabDir = useStore((s) => selectActive(s).dir)
  const dir = el.cwd || tabDir || ''
  const [state, setState] = useState<State>({ phase: 'idle' })
  const frameRef = useRef<HTMLIFrameElement>(null)

  const start = useCallback(async () => {
    if (!dir) {
      setState({
        phase: 'error',
        message: 'This canvas has no folder yet — set one in the top bar first.',
      })
      return
    }
    setState({ phase: 'starting' })
    try {
      const { url } = await codeServe(dir)
      setState({ phase: 'ready', url })
    } catch (err) {
      setState({ phase: 'error', message: String((err as Error)?.message ?? err) })
    }
  }, [dir])

  // start on mount / when the folder changes; a widget that never opened
  // doesn't leave a server behind
  useEffect(() => {
    void start()
  }, [start])

  const restart = async () => {
    if (dir) await codeStop(dir)
    void start()
  }

  return (
    <div className="vscode">
      <div className="vscode__bar">
        <button
          className="vscode__btn"
          title="Reload the editor"
          onClick={() => {
            if (state.phase === 'ready' && frameRef.current)
              frameRef.current.src = state.url
            else void start()
          }}
        >
          <IconReload />
        </button>
        <span className="vscode__folder" title={dir}>
          {dir ? baseName(dir) : 'no folder'}
        </span>
        <span className="vscode__spacer" />
        <button className="vscode__btn vscode__btn--text" title="Restart the VS Code server" onClick={() => void restart()}>
          restart
        </button>
        <button
          className="vscode__btn"
          title="Open in your browser"
          disabled={state.phase !== 'ready'}
          onClick={() => state.phase === 'ready' && void openExternal(state.url)}
        >
          ↗
        </button>
      </div>

      {state.phase === 'ready' ? (
        <iframe
          ref={frameRef}
          className="vscode__frame"
          src={state.url}
          title={el.title}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-popups-to-escape-sandbox"
          style={{ pointerEvents: active ? 'auto' : 'none' }}
        />
      ) : (
        <div className="vscode__empty">
          <IconEditor className="" />
          {state.phase === 'starting' ? (
            <div>
              starting VS Code for <b>{dir ? baseName(dir) : ''}</b>…
              <br />
              the first run downloads the web server, which can take a minute.
            </div>
          ) : state.phase === 'error' ? (
            <div>
              <b>Couldn't start VS Code.</b>
              <br />
              {state.message}
              <br />
              <button className="vscode__retry" onClick={() => void start()}>
                try again
              </button>
            </div>
          ) : (
            <div>waiting…</div>
          )}
        </div>
      )}
    </div>
  )
}
