import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { readFile, saveFile, resolvePath, baseName } from '../lib/backend'
import { IconReload, IconSave } from '../ui/icons'

// Plain-text file editor. Loads el.path, edits in a textarea, ⌘/Ctrl-S writes
// back to disk. Dependency-free (no syntax highlighting) but a real round-trip.

export function EditorBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pathInput, setPathInput] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    if (!abs) {
      setLoaded(false)
      return
    }
    const content = await readFile(abs)
    setText(content ?? '')
    setLoaded(content != null)
    setDirty(false)
  }, [abs])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    if (!abs) return
    setSaving('saving')
    const ok = await saveFile(abs, text)
    setSaving(ok ? 'saved' : 'error')
    if (ok) setDirty(false)
    setTimeout(() => setSaving('idle'), 1400)
  }, [abs, text])

  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active])

  if (!el.path) {
    return (
      <div className="editor editor--empty">
        <div className="editor__pick">
          <div className="editor__pick-label">
            Open a file (path relative to the canvas folder, or absolute):
          </div>
          <input
            className="editor__path-input"
            placeholder="src/App.tsx"
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
    <div className="editor">
      <div className="editor__bar">
        <span className="editor__name" title={abs}>
          {baseName(el.path)}
          {dirty && <span className="editor__dot" />}
        </span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {saving !== 'idle' && (
          <span className={`editor__state editor__state--${saving}`}>
            {saving === 'saving' ? 'saving…' : saving === 'saved' ? 'saved' : 'error'}
          </span>
        )}
        <button className="editor__btn" title="Reload from disk" onClick={() => void load()}>
          <IconReload />
        </button>
        <button className="editor__btn" title="Save (⌘S)" onClick={() => void save()}>
          <IconSave />
        </button>
      </div>
      {loaded ? (
        <textarea
          ref={ref}
          className="editor__text"
          value={text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setDirty(true)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault()
              void save()
            }
          }}
        />
      ) : (
        <div className="editor__empty">
          could not read <code>{abs}</code> — backend offline or file missing
        </div>
      )}
    </div>
  )
}
