import { useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { renderMarkdown } from '../lib/markdown'

// Markdown note with task checkboxes. Single click on the body edits the raw
// markdown; clicking a `- [ ]` checkbox toggles it without entering edit mode.
export function NoteBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)
  const setSelection = useStore((s) => s.setSelection)
  const bringToFront = useStore((s) => s.bringToFront)
  const setActiveWidget = useStore((s) => s.setActiveWidget)

  const [draft, setDraft] = useState(el.note ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const began = useRef(false)

  useEffect(() => {
    setDraft(el.note ?? '')
  }, [el.note])

  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active])

  // toggle the checkbox on source line n. Handles `[ ]`, `[]`, `[x]`, with or
  // without a `-`/`*`/`+` list marker; normalises to `[ ]` / `[x]`.
  const toggleTask = (n: number) => {
    const lines = (el.note ?? '').replace(/\r\n/g, '\n').split('\n')
    const m = /^(\s*(?:[-*+]\s+)?\[)([ xX]?)(\].*)$/.exec(lines[n] ?? '')
    if (!m) return
    const done = /[xX]/.test(m[2])
    lines[n] = m[1] + (done ? ' ' : 'x') + m[3]
    beginHistory()
    mutateElement(el.id, (w) => {
      ;(w as WidgetElement).note = lines.join('\n')
    })
  }

  if (active) {
    return (
      <div className="note">
        <textarea
          ref={ref}
          className="note__edit"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            if (!began.current) {
              beginHistory()
              began.current = true
            }
            setDraft(e.target.value)
            mutateElement(el.id, (w) => {
              ;(w as WidgetElement).note = e.target.value
            })
          }}
          onBlur={() => {
            began.current = false
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') {
              e.preventDefault()
              setActiveWidget(null)
            }
          }}
          placeholder="# Markdown note…   use - [ ] for checkboxes"
        />
      </div>
    )
  }

  return (
    <div className="note">
      <div
        className="note__view"
        onPointerDown={(e) => {
          e.stopPropagation()
          const t = e.target as HTMLElement
          // checkboxes toggle (handled onClick) and links open — neither edits
          if (t.closest('.md-check') || t.closest('a')) return
          setSelection([el.id])
          bringToFront([el.id])
          setActiveWidget(el.id)
        }}
        onClick={(e) => {
          const check = (e.target as HTMLElement).closest('.md-check') as HTMLElement | null
          if (check?.dataset.line != null) {
            e.stopPropagation()
            toggleTask(Number(check.dataset.line))
          }
        }}
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(el.note ?? '*Empty note — click to edit.*'),
        }}
      />
    </div>
  )
}
