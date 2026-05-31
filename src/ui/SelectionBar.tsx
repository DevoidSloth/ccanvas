import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { broadcast, isLive } from '../lib/agents'
import {
  IconCopy,
  IconLock,
  IconUnlock,
  IconLayers,
  IconSendBack,
  IconGroup,
  IconTidy,
  IconClose,
  IconBroadcast,
} from './icons'

// Floating contextual toolbar for the current selection: arrange, align,
// group, lock, z-order, duplicate, delete — plus broadcast input when several
// live terminals/agents are selected.

export function SelectionBar() {
  const selection = useStore((s) => s.selection)
  const ws = useStore(selectActive)
  const align = useStore((s) => s.align)
  const distribute = useStore((s) => s.distribute)
  const tidy = useStore((s) => s.tidy)
  const group = useStore((s) => s.group)
  const ungroup = useStore((s) => s.ungroup)
  const toggleLock = useStore((s) => s.toggleLock)
  const bringToFront = useStore((s) => s.bringToFront)
  const sendToBack = useStore((s) => s.sendToBack)
  const duplicateSelection = useStore((s) => s.duplicateSelection)
  const deleteSelection = useStore((s) => s.deleteSelection)
  const mutateElement = useStore((s) => s.mutateElement)
  const beginHistory = useStore((s) => s.beginHistory)

  const [bc, setBc] = useState('')

  if (selection.length === 0) return null

  const selEls = ws.elements.filter((e) => selection.includes(e.id))
  const loneArrow =
    selEls.length === 1 && selEls[0].type === 'arrow' ? selEls[0] : undefined
  const multi = selection.length >= 2
  const anyLocked = selEls.some((e) => e.locked)
  const grouped = selEls.some((e) => e.groupId)
  // live shells among the selection → broadcast targets
  const liveTargets = selEls
    .filter((e) => e.type === 'widget' && (e.kind === 'terminal' || e.kind === 'agent'))
    .map((e) => e.id)
    .filter(isLive)

  const sendBroadcast = (submit: boolean) => {
    if (!liveTargets.length) return
    broadcast(liveTargets, bc + (submit ? '\r' : ''))
    if (submit) setBc('')
  }

  return (
    <div className="selbar">
      <div className="selbar__row">
        <span className="selbar__count">{selection.length} selected</span>
        <span className="selbar__sep" />

        {multi && (
          <>
            <div className="selbar__cluster" title="Align">
              <button className="selbar__mini" title="Align left" onClick={() => align('left')}>
                ⇤
              </button>
              <button className="selbar__mini" title="Align center (h)" onClick={() => align('center-h')}>
                ⇔
              </button>
              <button className="selbar__mini" title="Align right" onClick={() => align('right')}>
                ⇥
              </button>
              <button className="selbar__mini" title="Align top" onClick={() => align('top')}>
                ⤒
              </button>
              <button className="selbar__mini" title="Align middle (v)" onClick={() => align('center-v')}>
                ↕
              </button>
              <button className="selbar__mini" title="Align bottom" onClick={() => align('bottom')}>
                ⤓
              </button>
            </div>
            <button className="selbar__btn" title="Distribute horizontally" onClick={() => distribute('h')}>
              ⇿
            </button>
            <button className="selbar__btn" title="Distribute vertically" onClick={() => distribute('v')}>
              ⇳
            </button>
            <button className="selbar__btn" title="Tidy into a grid" onClick={tidy}>
              <IconTidy />
            </button>
            <button
              className="selbar__btn"
              title={grouped ? 'Ungroup (⌘⇧G)' : 'Group (⌘G)'}
              onClick={() => (grouped ? ungroup() : group())}
            >
              <IconGroup />
            </button>
            <span className="selbar__sep" />
          </>
        )}

        <button className="selbar__btn" title="Duplicate (⌘D)" onClick={duplicateSelection}>
          <IconCopy />
        </button>
        <button
          className="selbar__btn"
          title={anyLocked ? 'Unlock (⌘L)' : 'Lock (⌘L)'}
          onClick={toggleLock}
        >
          {anyLocked ? <IconUnlock /> : <IconLock />}
        </button>
        <button className="selbar__btn" title="Bring to front (⌘])" onClick={() => bringToFront(selection)}>
          <IconLayers />
        </button>
        <button className="selbar__btn" title="Send to back (⌘[)" onClick={() => sendToBack(selection)}>
          <IconSendBack />
        </button>
        <button className="selbar__btn selbar__btn--danger" title="Delete (⌫)" onClick={deleteSelection}>
          <IconClose />
        </button>
      </div>

      {loneArrow && (
        <div className="selbar__row selbar__broadcast">
          <input
            className="selbar__bc-input"
            placeholder="connector label…"
            defaultValue={loneArrow.label ?? ''}
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = e.target.value
              mutateElement(loneArrow.id, (a) => {
                ;(a as typeof loneArrow).label = v || undefined
              })
            }}
          />
          <button
            className={`selbar__btn${loneArrow.dashed ? ' selbar__btn--accent' : ''}`}
            title="Toggle dashed line"
            onClick={() => {
              beginHistory()
              mutateElement(loneArrow.id, (a) => {
                ;(a as typeof loneArrow).dashed = !loneArrow.dashed
              })
            }}
          >
            dashed
          </button>
        </div>
      )}

      {liveTargets.length >= 2 && (
        <div className="selbar__row selbar__broadcast">
          <IconBroadcast />
          <input
            className="selbar__bc-input"
            placeholder={`broadcast to ${liveTargets.length} sessions…`}
            value={bc}
            spellCheck={false}
            onChange={(e) => setBc(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') sendBroadcast(true)
            }}
          />
          <button className="selbar__btn" title="Send (no newline)" onClick={() => sendBroadcast(false)}>
            type
          </button>
          <button className="selbar__btn selbar__btn--accent" title="Send + Enter" onClick={() => sendBroadcast(true)}>
            ⏎
          </button>
        </div>
      )}
    </div>
  )
}
