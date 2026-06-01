import { useCallback, useEffect, useRef, useState } from 'react'
// Type-only import: erased at build, so it does NOT pull Monaco into the bundle.
// Monaco itself is loaded lazily below via dynamic import('../lib/monaco').
import type * as Monaco from 'monaco-editor'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { readFile, saveFile, resolvePath, baseName } from '../lib/backend'
import { IconReload, IconSave } from '../ui/icons'

// File editor backed by Monaco — VS Code's editor engine. Syntax highlighting,
// IntelliSense/completions, find & replace (⌘/Ctrl-F), multi-cursor, folding,
// bracket matching, etc. come for free. Loads el.path off disk, edits in a real
// model, ⌘/Ctrl-S writes back. Monaco is code-split into its own chunk and only
// fetched the first time an editor widget mounts, so the app's initial load is
// untouched.

export function EditorBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')
  const hasPath = !!el.path

  const [ready, setReady] = useState(false)
  const [loaded, setLoaded] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [pathInput, setPathInput] = useState('')

  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Awaited<ReturnType<typeof import('../lib/monaco').loadMonaco>> | null>(null)
  const loadToken = useRef(0)
  // Keep save reachable from Monaco's (one-time-bound) ⌘S command without stale
  // closures over `abs`.
  const saveRef = useRef<() => Promise<void>>(async () => {})

  // ---- read the file into a fresh model with the right language ----
  const load = useCallback(async () => {
    const editor = editorRef.current
    const m = monacoRef.current
    if (!editor || !m || !abs) return
    const token = ++loadToken.current
    setSaving('idle')
    const content = await readFile(abs)
    // a newer load (path changed) or a disposed editor won out — drop this one
    if (token !== loadToken.current || editorRef.current !== editor) return
    setLoaded(content != null)
    const next = m.monaco.editor.createModel(content ?? '', m.detectLanguage(abs))
    const prev = editor.getModel()
    editor.setModel(next)
    prev?.dispose()
    setDirty(false)
  }, [abs])

  const save = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !abs) return
    setSaving('saving')
    const ok = await saveFile(abs, editor.getValue())
    setSaving(ok ? 'saved' : 'error')
    if (ok) setDirty(false)
    setTimeout(() => setSaving('idle'), 1400)
  }, [abs])
  useEffect(() => {
    saveRef.current = save
  }, [save])

  // ---- create the editor once the host div exists (and a path is set) ----
  useEffect(() => {
    if (!hasPath) return
    let disposed = false
    void (async () => {
      const { loadMonaco } = await import('../lib/monaco')
      const m = await loadMonaco()
      if (disposed || !hostRef.current || editorRef.current) return
      monacoRef.current = m
      const editor = m.monaco.editor.create(hostRef.current, {
        value: '',
        language: 'plaintext',
        theme: 'ccanvas',
        automaticLayout: true, // re-layout when the widget is resized
        minimap: { enabled: false }, // kept lean — core editing surface only
        fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 12.5,
        lineHeight: 19,
        fontLigatures: true,
        letterSpacing: 0.2,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        renderWhitespace: 'selection',
        renderLineHighlight: 'all',
        roundedSelection: false,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        tabSize: 2,
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        fixedOverflowWidgets: false,
      })
      editorRef.current = editor
      editor.onDidChangeModelContent(() => setDirty(true))
      editor.addCommand(m.monaco.KeyMod.CtrlCmd | m.monaco.KeyCode.KeyS, () => {
        void saveRef.current()
      })
      // flipping `ready` triggers the load effect below — no need to read here too
      setReady(true)
    })()
    return () => {
      disposed = true
      const editor = editorRef.current
      editorRef.current = null
      editor?.getModel()?.dispose()
      editor?.dispose()
      setReady(false)
    }
    // create exactly once per widget; switching files is handled by `load`, not
    // by tearing the editor down. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPath])

  // reload whenever the editor becomes ready or the target path changes
  useEffect(() => {
    if (ready) void load()
  }, [ready, load])

  useEffect(() => {
    if (active && ready) editorRef.current?.focus()
  }, [active, ready])

  if (!hasPath) {
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
    // Stop key events here so the editor owns the keyboard (⌘S saves the file,
    // not the canvas; Delete edits text, not the selection). Monaco's own
    // handlers have already run by the time the event bubbles to this div.
    <div className="editor" onKeyDown={(e) => e.stopPropagation()}>
      <div className="editor__bar">
        <span className="editor__name" title={abs}>
          {baseName(el.path!)}
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
      <div className="editor__stage">
        <div className="editor__host" ref={hostRef} />
        {!ready && <div className="editor__overlay">loading editor…</div>}
        {ready && !loaded && (
          <div className="editor__overlay editor__overlay--soft">
            could not read <code>{abs}</code> — backend offline or file missing
          </div>
        )}
      </div>
    </div>
  )
}
