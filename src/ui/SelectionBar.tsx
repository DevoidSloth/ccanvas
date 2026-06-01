import { useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { broadcast, isLive } from '../lib/agents'
import type { ArrowElement, ArrowFlow, CanvasElement, FlowCondition } from '../lib/types'
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

const isAgentEl = (e?: CanvasElement) =>
  !!e && e.type === 'widget' && e.kind === 'agent'

const COND_LABEL: Record<FlowCondition, string> = {
  always: 'on finish',
  success: 'on success',
  failure: 'on failure',
  match: 'on match',
}

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
  const flowsEnabled = useStore((s) => s.flowsEnabled)
  const setFlowsEnabled = useStore((s) => s.setFlowsEnabled)

  const [bc, setBc] = useState('')

  if (selection.length === 0) return null

  const selEls = ws.elements.filter((e) => selection.includes(e.id))
  const loneArrow =
    selEls.length === 1 && selEls[0].type === 'arrow' ? selEls[0] : undefined
  // a connector between two agents can carry orchestration logic
  const arrowFrom =
    loneArrow?.from && ws.elements.find((e) => e.id === loneArrow.from!.id)
  const arrowTo =
    loneArrow?.to && ws.elements.find((e) => e.id === loneArrow.to!.id)
  const isFlowEdge = !!loneArrow && isAgentEl(arrowFrom) && isAgentEl(arrowTo)
  const flow = loneArrow?.flow
  const fromTitle = (arrowFrom && 'title' in arrowFrom && arrowFrom.title) || 'source'
  const toTitle = (arrowTo && 'title' in arrowTo && arrowTo.title) || 'target'
  const multi = selection.length >= 2

  // patch the lone arrow's flow config (creating it on first edit)
  const patchFlow = (patch: Partial<ArrowFlow>, snapshot = false) => {
    if (!loneArrow) return
    if (snapshot) beginHistory()
    mutateElement(loneArrow.id, (a) => {
      const ar = a as ArrowElement
      const cur: ArrowFlow = ar.flow ?? { when: 'always', enabled: true }
      ar.flow = { ...cur, ...patch }
    })
  }
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

      {isFlowEdge && (
        <div className="selbar__flow">
          <div className="selbar__flow-head">
            <span className="selbar__flow-edge">
              {fromTitle} <span className="selbar__flow-arrow">→</span> {toTitle}
            </span>
            {!flow || flow.enabled === false ? (
              <button
                className="selbar__btn selbar__btn--accent"
                title="Make this connector run the target agent"
                onClick={() =>
                  patchFlow({ enabled: true, when: flow?.when ?? 'always' }, true)
                }
              >
                + add logic
              </button>
            ) : (
              <button
                className="selbar__btn"
                title="Keep the arrow but stop it from running the target"
                onClick={() => patchFlow({ enabled: false }, true)}
              >
                disable
              </button>
            )}
          </div>

          {flow && flow.enabled !== false && (
            <>
              <div className="selbar__flow-row">
                <span className="selbar__flow-tag">run when</span>
                {(['always', 'success', 'failure', 'match'] as FlowCondition[]).map(
                  (c) => (
                    <button
                      key={c}
                      className={`selbar__seg${flow.when === c ? ' selbar__seg--on' : ''}`}
                      title={
                        c === 'always'
                          ? `Fire every time ${fromTitle} finishes a turn`
                          : c === 'success'
                            ? `Fire when ${fromTitle}'s output reads as success`
                            : c === 'failure'
                              ? `Fire when ${fromTitle}'s output reads as failure`
                              : `Fire when ${fromTitle}'s output matches a regex`
                      }
                      onClick={() => patchFlow({ when: c }, true)}
                    >
                      {COND_LABEL[c]}
                    </button>
                  ),
                )}
              </div>

              {(flow.when === 'match' || !!flow.pattern) && (
                <input
                  className="selbar__bc-input selbar__flow-pattern"
                  placeholder={
                    flow.when === 'match'
                      ? 'regex matched against output, e.g. STATUS:\\s*OK'
                      : 'optional regex to override the keyword set…'
                  }
                  defaultValue={flow.pattern ?? ''}
                  spellCheck={false}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => patchFlow({ pattern: e.target.value || undefined })}
                />
              )}

              <textarea
                className="selbar__flow-prompt"
                placeholder={`prompt sent to ${toTitle} (then Enter) when this fires…`}
                defaultValue={flow.prompt ?? ''}
                rows={2}
                spellCheck={false}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => patchFlow({ prompt: e.target.value || undefined })}
              />

              <div className="selbar__flow-row">
                <span className="selbar__flow-tag" title="When the target has several incoming edges">
                  join
                </span>
                <button
                  className={`selbar__seg${(flow.join ?? 'all') === 'all' ? ' selbar__seg--on' : ''}`}
                  title={`Run ${toTitle} only after every incoming edge is satisfied (AND)`}
                  onClick={() => patchFlow({ join: 'all' }, true)}
                >
                  all
                </button>
                <button
                  className={`selbar__seg${flow.join === 'any' ? ' selbar__seg--on' : ''}`}
                  title={`Run ${toTitle} as soon as this edge is satisfied (OR)`}
                  onClick={() => patchFlow({ join: 'any' }, true)}
                >
                  any
                </button>
                {!flowsEnabled && (
                  <button
                    className="selbar__btn selbar__btn--accent"
                    style={{ marginLeft: 'auto' }}
                    title="Agent flows are globally paused"
                    onClick={() => setFlowsEnabled(true)}
                  >
                    flows paused — resume
                  </button>
                )}
              </div>
            </>
          )}
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
