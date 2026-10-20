import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/workspace'
import {
  useSettings,
  PALETTES,
  comboFrom,
  formatSeq,
  isModifierKey,
  keyRecorder,
  type KeySeq,
} from '../lib/settings'
import { IconClose, IconPlus } from './icons'
import '../styles/agent-tools.css'

// How long to wait after the first press for a second one (a chord like ⌃X ⌃F).
const CHORD_WAIT = 900

// Preferences: which shortcuts open the tab finder, and the app's colour palette.
export function SettingsPanel() {
  const setOpenPanel = useStore((s) => s.setOpenPanel)
  const s = useSettings()

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Settings</span>
        <span className="panel__spacer" />
        <button className="panel__x" title="Close" onClick={() => setOpenPanel(null)}>
          <IconClose size={14} />
        </button>
      </div>

      <div className="panel__body set">
        <div className="set__section">Switch tabs</div>
        <Toggle
          on={s.emacsKeys}
          onChange={(v) => s.update({ emacsKeys: v })}
          title="Emacs"
          keys="⌃X ⌃F"
          hint="Opens the tab finder from anywhere, including inside a terminal."
        />
        <Toggle
          on={s.vimKeys}
          onChange={(v) => s.update({ vimKeys: v })}
          title="Vim"
          keys=": · gt · gT"
          hint=": opens the finder as :b, gt / gT go to the next / previous tab. Works on the canvas, not while typing in a terminal (⌘Esc leaves one)."
        />
        <CustomKeys />

        <div className="set__section">Colour palette</div>
        <div className="set__palettes">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              className={`set__swatch${s.palette === p.id ? ' set__swatch--on' : ''}`}
              title={p.name}
              onClick={() => s.update({ palette: p.id })}
            >
              <span className="set__chip" style={{ background: p.bg, borderColor: p.panel }}>
                <span style={{ background: p.panel }} />
                <span style={{ background: p.ink }} />
                <span style={{ background: p.accent }} />
              </span>
              <span className="set__swatch-name">{p.name}</span>
            </button>
          ))}
        </div>
        <div className="set__hint">Terminals keep the colours from your iTerm2 profile.</div>
      </div>
    </div>
  )
}

function Toggle(props: {
  on: boolean
  onChange: (v: boolean) => void
  title: string
  keys: string
  hint: string
}) {
  return (
    <label className="set__row">
      <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="set__main">
        <span className="set__label">
          {props.title} <kbd className="set__kbd">{props.keys}</kbd>
        </span>
        <span className="set__hint">{props.hint}</span>
      </span>
    </label>
  )
}

// Record a shortcut: press one combo, or two in a row for a chord. Esc cancels.
function CustomKeys() {
  const keys = useSettings((s) => s.customFinderKeys)
  const update = useSettings((s) => s.update)
  const [recording, setRecording] = useState(false)
  const [draft, setDraft] = useState<KeySeq>([])
  const draftRef = useRef<KeySeq>([])

  useEffect(() => {
    if (!recording) return
    keyRecorder.active = true
    let timer: number | undefined
    const finish = () => {
      const seq = draftRef.current
      const cur = useSettings.getState().customFinderKeys
      if (seq.length && !cur.some((k) => formatSeq(k) === formatSeq(seq)))
        update({ customFinderKeys: [...cur, seq] })
      setRecording(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (isModifierKey(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        draftRef.current = []
        setRecording(false)
        return
      }
      const seq = [...draftRef.current, comboFrom(e)]
      draftRef.current = seq
      setDraft(seq)
      window.clearTimeout(timer)
      if (seq.length >= 2) finish()
      else timer = window.setTimeout(finish, CHORD_WAIT)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      keyRecorder.active = false
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [recording, update])

  const start = () => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    draftRef.current = []
    setDraft([])
    setRecording(true)
  }

  return (
    <div className="set__row set__row--custom">
      <span className="set__main">
        <span className="set__label">Custom</span>
        {keys.map((k) => (
          <span key={formatSeq(k)} className="set__bind">
            <kbd className="set__kbd">{formatSeq(k)}</kbd>
            <button
              className="set__rm"
              title="Remove shortcut"
              onClick={() => update({ customFinderKeys: keys.filter((x) => x !== k) })}
            >
              <IconClose size={11} />
            </button>
          </span>
        ))}
        {recording ? (
          <span className="set__rec">
            {draft.length ? <kbd className="set__kbd">{formatSeq(draft)}</kbd> : 'Press a shortcut…'}
            <span className="set__hint">A second press makes a chord · Esc cancels</span>
          </span>
        ) : (
          <button className="set__add" onClick={start}>
            <IconPlus size={12} /> Add shortcut
          </button>
        )}
        <span className="set__hint">
          Opens the tab finder. Include ⌃, ⌥ or ⌘ for it to work inside terminals.
        </span>
      </span>
    </div>
  )
}
