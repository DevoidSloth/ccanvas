import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { readFile, resolvePath, baseName, watchPath } from '../lib/backend'
import { IconReload } from '../ui/icons'

// Log-tail widget: shows a file's last N lines, auto-scrolling to the bottom,
// refreshing on filesystem changes. Good for a build/test log an agent writes.

const MAX_LINES = 600

export function LogBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')
  const [lines, setLines] = useState<string[] | null>(null)
  const [paused, setPaused] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const load = useCallback(async () => {
    if (!abs) return
    const content = await readFile(abs)
    if (content == null) {
      setLines(null)
      return
    }
    const all = content.split('\n')
    setLines(all.slice(-MAX_LINES))
  }, [abs])

  useEffect(() => {
    void load()
    if (paused || !abs) return
    let dispose: (() => void) | null = null
    let cancelled = false
    void watchPath(abs, () => void load(), 1500).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [load, paused, abs])

  // keep pinned to the bottom unless the user has scrolled up
  useEffect(() => {
    const node = scrollRef.current
    if (node && stickRef.current) node.scrollTop = node.scrollHeight
  }, [lines])

  if (!el.path) {
    return (
      <div className="log log--empty">
        <div className="editor__pick">
          <div className="editor__pick-label">Tail a file (relative or absolute):</div>
          <input
            className="editor__path-input"
            placeholder="dev.log"
            value={pathInput}
            spellCheck={false}
            onChange={(e) => setPathInput(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && pathInput.trim()) {
                const p = pathInput.trim()
                mutateElement(el.id, (w) => {
                  ;(w as WidgetElement).path = p
                  ;(w as WidgetElement).title = baseName(p)
                })
              }
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="log">
      <div className="log__bar">
        <span className="log__name" title={abs}>
          {baseName(el.path)}
        </span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        <button
          className={`diff__toggle${paused ? '' : ' diff__toggle--on'}`}
          title={paused ? 'Resume tailing' : 'Pause'}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? 'paused' : 'live'}
        </button>
        <button className="log__btn" title="Refresh now" onClick={() => void load()}>
          <IconReload />
        </button>
      </div>
      <div
        ref={scrollRef}
        className="log__scroll"
        onScroll={(e) => {
          const n = e.currentTarget
          stickRef.current = n.scrollHeight - n.scrollTop - n.clientHeight < 24
        }}
      >
        {lines == null ? (
          <div className="log__hint">could not read {abs}</div>
        ) : (
          <pre className="log__body">{lines.join('\n') || '(empty)'}</pre>
        )}
      </div>
    </div>
  )
}
