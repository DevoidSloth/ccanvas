import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TextElement as TextEl } from '../lib/types'
import { useStore } from '../store/workspace'

// HTML-rendered text element. Single-click (select tool) selects + drags;
// double-click enters edit mode with an inline textarea.

export function TextElement({
  el,
  selected,
  onPointerDown,
}: {
  el: TextEl
  selected: boolean
  onPointerDown: (e: React.PointerEvent, id: string) => void
}) {
  const editingId = useStore((s) => s.editingTextId)
  const tool = useStore((s) => s.tool)
  const setEditingText = useStore((s) => s.setEditingText)
  const mutateElement = useStore((s) => s.mutateElement)
  const removeElements = useStore((s) => s.removeElements)
  const beginHistory = useStore((s) => s.beginHistory)
  const editing = editingId === el.id

  const [draft, setDraft] = useState(el.text)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDraft(el.text)
  }, [el.text, editing])

  useLayoutEffect(() => {
    if (editing && ref.current) {
      const t = ref.current
      t.focus()
      t.select()
      autosize(t)
    }
  }, [editing])

  const commit = () => {
    const text = draft.trim()
    if (!text) {
      removeElements([el.id])
    } else if (text !== el.text) {
      beginHistory()
      mutateElement(el.id, (e) => {
        ;(e as TextEl).text = text
      })
    }
    setEditingText(null)
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="text-input"
        style={{
          left: el.x,
          top: el.y,
          color: el.color,
          fontSize: el.fontSize,
          minWidth: 40,
        }}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          autosize(e.target)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            setEditingText(null)
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          }
        }}
      />
    )
  }

  return (
    <div
      className={`text-el${selected ? ' text-el--editing' : ''}`}
      style={{ left: el.x, top: el.y, color: el.color, fontSize: el.fontSize }}
      onPointerDown={(e) => {
        if (tool === 'select') onPointerDown(e, el.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setEditingText(el.id)
      }}
    >
      {el.text || ' '}
    </div>
  )
}

function autosize(t: HTMLTextAreaElement) {
  t.style.height = 'auto'
  t.style.height = t.scrollHeight + 'px'
  t.style.width = 'auto'
  t.style.width = Math.max(40, t.scrollWidth + 4) + 'px'
}
