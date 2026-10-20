import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/workspace'
import { useSettings } from '../lib/settings'

// Emacs-style bottom bar. A chord prefix shows as pending ("C-x -"); the finder
// shortcut (⌃X ⌃F, vim's `:`, or a custom one — see Settings) opens the tab
// finder: type part of a tab's name, Tab completes to the common prefix (and
// cycles the candidates once it can't go further), Enter jumps to it, Esc / ⌃G
// cancels. ⌃N/⌃P (and ⌃J/⌃K with vim keys on) move through the candidates.

/** Prefix matches first, then substring matches; both case-insensitive. */
function rank<T extends { name: string }>(tabs: T[], query: string): T[] {
  const q = query.toLowerCase()
  if (!q) return tabs
  const pre = tabs.filter((t) => t.name.toLowerCase().startsWith(q))
  const sub = tabs.filter((t) => !pre.includes(t) && t.name.toLowerCase().includes(q))
  return [...pre, ...sub]
}

function commonPrefix(names: string[]): string {
  if (!names.length) return ''
  let p = names[0]
  for (const n of names.slice(1)) {
    let i = 0
    while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i++
    p = p.slice(0, i)
  }
  return p
}

export function Minibuffer() {
  const mode = useStore((s) => s.minibuffer)
  const text = useStore((s) => s.miniText)
  if (mode === 'chord')
    return (
      <div className="mini">
        <span className="mini__echo">{text}</span>
      </div>
    )
  if (mode === 'tab') return <TabFinder />
  return null
}

function TabFinder() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const switchTab = useStore((s) => s.switchTab)
  const setMinibuffer = useStore((s) => s.setMinibuffer)
  const prompt = useStore((s) => s.miniText) || 'Find tab:'
  const vim = useSettings((s) => s.vimKeys)
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const prevFocus = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
  }, [])

  const shown = useMemo(() => rank(tabs, text), [tabs, text])
  const active = Math.min(index, shown.length - 1)

  useEffect(() => {
    listRef.current?.querySelector('.mini__cand--on')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const cancel = () => {
    setMinibuffer(null)
    prevFocus.current?.focus?.()
  }
  const go = (id: string) => {
    setMinibuffer(null)
    switchTab(id)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }

  const complete = () => {
    if (!shown.length) return
    if (shown.length === 1) {
      setText(shown[0].name)
      setIndex(0)
      return
    }
    // first Tab: extend to the longest common prefix of the prefix matches
    const q = text.toLowerCase()
    const pre = shown.filter((t) => t.name.toLowerCase().startsWith(q))
    const cp = pre.length === shown.length ? commonPrefix(shown.map((t) => t.name)) : ''
    if (cp.length > text.length) {
      setText(cp)
      setIndex(0)
      return
    }
    // nothing left to extend: step through the candidates
    setIndex((active + 1) % shown.length)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    const ctrl = e.ctrlKey && !e.metaKey
    if (e.key === 'Escape' || (ctrl && (e.code === 'KeyG' || (vim && e.code === 'BracketLeft')))) {
      e.preventDefault()
      cancel()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      complete()
    } else if (e.key === 'ArrowDown' || (ctrl && (e.code === 'KeyN' || (vim && e.code === 'KeyJ')))) {
      e.preventDefault()
      if (shown.length) setIndex((active + 1) % shown.length)
    } else if (e.key === 'ArrowUp' || (ctrl && (e.code === 'KeyP' || (vim && e.code === 'KeyK')))) {
      e.preventDefault()
      if (shown.length) setIndex((active - 1 + shown.length) % shown.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const exact = tabs.find((t) => t.name.toLowerCase() === text.trim().toLowerCase())
      const target = exact ?? shown[active]
      if (target) go(target.id)
    }
  }

  return (
    <div className="mini">
      {shown.length > 0 && (
        <div className="mini__cands" ref={listRef}>
          {shown.map((t, i) => (
            <button
              key={t.id}
              className={`mini__cand${i === active ? ' mini__cand--on' : ''}${
                t.id === activeTabId ? ' mini__cand--cur' : ''
              }`}
              onPointerDown={(e) => {
                e.preventDefault()
                go(t.id)
              }}
              onMouseEnter={() => setIndex(i)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="mini__row">
        <span className="mini__prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="mini__input"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setMinibuffer(null)}
        />
        {shown.length === 0 && text && <span className="mini__note">[No match]</span>}
      </div>
    </div>
  )
}
