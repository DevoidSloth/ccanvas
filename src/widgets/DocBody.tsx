import { useCallback, useEffect, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { readFile, resolvePath, baseName, watchPath } from '../lib/backend'
import { renderMarkdown } from '../lib/markdown'
import { IconReload } from '../ui/icons'

// Live markdown view bound to a file on disk (an agent's PLAN.md, a README).
// Re-renders on filesystem changes (notify watcher, polling fallback).

export function DocBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')
  const [src, setSrc] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('')

  const load = useCallback(async () => {
    if (!abs) return
    const content = await readFile(abs)
    setSrc((prev) => (content != null && content !== prev ? content : prev))
  }, [abs])

  useEffect(() => {
    void load()
    if (!abs) return
    let dispose: (() => void) | null = null
    let cancelled = false
    void watchPath(abs, () => void load()).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [load, abs])

  if (!el.path) {
    return (
      <div className="doc doc--empty">
        <div className="editor__pick">
          <div className="editor__pick-label">Watch a markdown file (relative or absolute):</div>
          <input
            className="editor__path-input"
            placeholder="README.md"
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
    <div className="doc">
      <div className="doc__bar">
        <span className="doc__name" title={abs}>
          {baseName(el.path)}
        </span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        <button className="doc__btn" title="Refresh now" onClick={() => void load()}>
          <IconReload />
        </button>
      </div>
      <div className="doc__view note__view">
        {src == null ? (
          <p style={{ opacity: 0.6 }}>loading {abs}…</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
        )}
      </div>
    </div>
  )
}
