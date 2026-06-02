import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { elementBounds } from '../lib/geometry'
import type { CanvasElement } from '../lib/types'
import '../styles/agent-tools.css'

const CHROME_H = 82

type Hit = { id: string; kind: string; title: string; snippet: string; field: string }

// Searchable text carried by an element, paired with a label for where it came
// from. Covers the document model (titles, notes, paths, urls, queries, text,
// frame names) — everything persisted, searched synchronously.
function searchableFields(el: CanvasElement): { field: string; value: string }[] {
  if (el.type === 'widget') {
    const out: { field: string; value: string }[] = [{ field: 'title', value: el.title }]
    if (el.note) out.push({ field: 'note', value: el.note })
    if (el.path) out.push({ field: 'path', value: el.path })
    if (el.url) out.push({ field: 'url', value: el.url })
    if (el.cmd) out.push({ field: 'cmd', value: el.cmd })
    if (el.query) out.push({ field: 'query', value: el.query })
    if (el.agentPrompt) out.push({ field: 'prompt', value: el.agentPrompt })
    return out
  }
  if (el.type === 'text') return [{ field: 'text', value: el.text }]
  if (el.type === 'frame') return el.title ? [{ field: 'frame', value: el.title }] : []
  return []
}

function snippetAround(value: string, q: string): string {
  const i = value.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return value.slice(0, 80)
  const start = Math.max(0, i - 24)
  const end = Math.min(value.length, i + q.length + 48)
  return (start > 0 ? '…' : '') + value.slice(start, end).replace(/\s+/g, ' ') + (end < value.length ? '…' : '')
}

export function CanvasSearch() {
  const open = useStore((s) => s.searchOpen)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const ws = useStore(selectActive)
  const setCamera = useStore((s) => s.setCamera)
  const setSelection = useStore((s) => s.setSelection)
  const setActiveWidget = useStore((s) => s.setActiveWidget)
  const bringToFront = useStore((s) => s.bringToFront)

  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setHi(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const hits = useMemo<Hit[]>(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    const out: Hit[] = []
    for (const el of ws.elements) {
      for (const { field, value } of searchableFields(el)) {
        if (value.toLowerCase().includes(t)) {
          out.push({
            id: el.id,
            kind: el.type === 'widget' ? el.kind : el.type,
            title: el.type === 'widget' ? el.title : el.type === 'frame' ? el.title : 'text',
            snippet: snippetAround(value, t),
            field,
          })
          break // one hit per element keeps the list scannable
        }
      }
    }
    return out
  }, [q, ws])

  if (!open) return null

  const close = () => setSearchOpen(false)
  const jump = (hit: Hit | undefined) => {
    if (!hit) return
    const el = ws.elements.find((e) => e.id === hit.id)
    if (el) {
      const b = elementBounds(el)
      const cam = ws.camera
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      setCamera({
        zoom: cam.zoom,
        x: window.innerWidth / 2 - cx * cam.zoom,
        y: (window.innerHeight - CHROME_H) / 2 - cy * cam.zoom,
      })
      setSelection([hit.id])
      if (el.type === 'widget') {
        bringToFront([hit.id])
        setActiveWidget(hit.id)
      }
    }
    close()
  }

  const active = hits.length ? Math.min(hi, hits.length - 1) : 0

  return (
    <div className="palette-backdrop" onPointerDown={close}>
      <div className="palette csearch" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Search this canvas — notes, titles, paths, text…"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value)
            setHi(0)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') return close()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHi((active + 1) % Math.max(1, hits.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((active - 1 + hits.length) % Math.max(1, hits.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              jump(hits[active])
            }
          }}
        />
        <div className="palette__list">
          {q.trim() && hits.length === 0 && <div className="palette__empty">no matches</div>}
          {hits.map((hit, i) => (
            <div
              key={hit.id}
              className={`palette__item${i === active ? ' palette__item--active' : ''}`}
              onMouseEnter={() => setHi(i)}
              onPointerDown={(e) => {
                e.preventDefault()
                jump(hit)
              }}
            >
              <span className="palette__group">{hit.kind}</span>
              <span className="palette__label csearch__label">
                <span className="csearch__title">{hit.title}</span>
                <span className="csearch__snippet">{hit.snippet}</span>
              </span>
              <span className="palette__hint">{hit.field}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
