import { useRef, useState } from 'react'
import { useStore, selectActive } from '../store/workspace'
import { screenToWorld } from '../lib/geometry'
import type { Tool, WidgetKind } from '../lib/types'
import {
  IconSelect,
  IconHand,
  IconText,
  IconPen,
  IconArrow,
  IconRect,
  IconEllipse,
  IconEraser,
  IconFrame,
  IconImage,
  IconTerminal,
  IconAgent,
  IconWeb,
  IconNote,
  IconFiles,
  IconDiff,
  IconEditor,
  IconDoc,
  IconLog,
  IconPr,
  IconRun,
  IconIssue,
  IconChecks,
} from './icons'

type IconCmp = (p: { className?: string; size?: number }) => JSX.Element
type FlyItem = { key: string; Icon: IconCmp; label: string; hint?: string }

// Simple standalone tools (always visible)
const PRIMARY_TOOLS: { id: Tool; Icon: IconCmp; key: string; label: string }[] = [
  { id: 'select', Icon: IconSelect, key: 'V', label: 'Select' },
  { id: 'pan', Icon: IconHand, key: 'H', label: 'Pan' },
  { id: 'text', Icon: IconText, key: 'T', label: 'Text' },
  { id: 'pen', Icon: IconPen, key: 'P', label: 'Draw' },
  { id: 'arrow', Icon: IconArrow, key: 'A', label: 'Arrow' },
]

// Shapes collapse into one flyout (rect / ellipse / frame), GIMP-style.
const SHAPE_ITEMS: FlyItem[] = [
  { key: 'rect', Icon: IconRect, label: 'Rectangle', hint: 'R' },
  { key: 'ellipse', Icon: IconEllipse, label: 'Ellipse', hint: 'O' },
  { key: 'frame', Icon: IconFrame, label: 'Frame', hint: 'F' },
]
const SHAPE_KEYS = SHAPE_ITEMS.map((s) => s.key)

const PRIMARY_WIDGETS: { kind: WidgetKind; Icon: IconCmp; label: string }[] = [
  { kind: 'agent', Icon: IconAgent, label: 'Claude agent' },
  { kind: 'terminal', Icon: IconTerminal, label: 'Terminal' },
]
// Code panels collapse into one flyout.
const CODE_ITEMS: FlyItem[] = [
  { key: 'files', Icon: IconFiles, label: 'File tree' },
  { key: 'diff', Icon: IconDiff, label: 'Git panel' },
  { key: 'editor', Icon: IconEditor, label: 'Editor' },
  { key: 'doc', Icon: IconDoc, label: 'Live doc' },
  { key: 'log', Icon: IconLog, label: 'Log tail' },
  { key: 'runner', Icon: IconRun, label: 'Task runner' },
]
// GitHub CLI panels collapse into their own flyout.
const GITHUB_ITEMS: FlyItem[] = [
  { key: 'pr', Icon: IconPr, label: 'Pull requests' },
  { key: 'issues', Icon: IconIssue, label: 'Issues' },
  { key: 'runs', Icon: IconChecks, label: 'Actions / CI' },
]
const TRAILING_WIDGETS: { kind: WidgetKind; Icon: IconCmp; label: string }[] = [
  { kind: 'web', Icon: IconWeb, label: 'Web preview' },
  { kind: 'note', Icon: IconNote, label: 'Note' },
]

// 82px = topbar + tabs; matches CHROME_H in App.tsx
const CHROME_H = 82
const center = () => ({ x: window.innerWidth / 2, y: (window.innerHeight - CHROME_H) / 2 })

// A toolbar button that shows one item but reveals related items in a popover
// when its corner triangle is clicked (like GIMP's nested tools).
function FlyoutButton({
  id,
  items,
  currentKey,
  active,
  isItemActive,
  onChoose,
  openId,
  setOpenId,
}: {
  id: string
  items: FlyItem[]
  currentKey: string
  active?: boolean
  isItemActive?: (k: string) => boolean
  onChoose: (k: string) => void
  openId: string | null
  setOpenId: (v: string | null) => void
}) {
  const open = openId === id
  const cur = items.find((i) => i.key === currentKey) ?? items[0]
  const Cur = cur.Icon
  return (
    <div className="tool-group">
      <button
        className={`tool${active ? ' tool--active' : ''}`}
        onClick={() => onChoose(cur.key)}
      >
        <Cur />
        <span className="tool__tip">{cur.label}</span>
      </button>
      <button
        className="tool__more"
        title="More tools"
        onClick={(e) => {
          e.stopPropagation()
          setOpenId(open ? null : id)
        }}
      >
        ◢
      </button>
      {open && (
        <>
          <div className="flyout-backdrop" onPointerDown={() => setOpenId(null)} />
          <div className="flyout">
            {items.map((it) => {
              const I = it.Icon
              return (
                <button
                  key={it.key}
                  className={`tool${isItemActive?.(it.key) ? ' tool--active' : ''}`}
                  onClick={() => {
                    onChoose(it.key)
                    setOpenId(null)
                  }}
                >
                  <I />
                  {it.hint && <span className="tool__key">{it.hint}</span>}
                  <span className="tool__tip">{it.label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

export function Toolbar() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const spawnWidget = useStore((s) => s.spawnWidget)
  const openAgentWizard = useStore((s) => s.openAgentWizard)
  const addImage = useStore((s) => s.addImage)
  const fileRef = useRef<HTMLInputElement>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [lastShape, setLastShape] = useState('rect')
  const [lastCode, setLastCode] = useState('files')
  const [lastGithub, setLastGithub] = useState('pr')

  const spawn = (kind: WidgetKind) => {
    const ws = selectActive(useStore.getState())
    const world = screenToWorld(center(), ws.camera)
    // cascade each new widget down-right so repeated spawns fan out
    const step = 32
    const off = (ws.elements.length % 8) * step - step * 4
    const x = world.x + off
    const y = world.y + off
    // agents go through the wizard so they're configured before they launch
    if (kind === 'agent') {
      openAgentWizard({ x, y })
      return
    }
    spawnWidget(kind, x, y)
  }

  const onPickImage = (file: File) => {
    const ws = selectActive(useStore.getState())
    const world = screenToWorld(center(), ws.camera)
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result as string
      const img = new Image()
      img.onload = () => addImage(src, img.naturalWidth, img.naturalHeight, world.x, world.y)
      img.src = src
    }
    reader.readAsDataURL(file)
  }

  const shapeCurrent = SHAPE_KEYS.includes(tool) ? tool : lastShape

  return (
    <div className="toolbar">
      {PRIMARY_TOOLS.map(({ id, Icon, key, label }) => (
        <button
          key={id}
          className={`tool${tool === id ? ' tool--active' : ''}`}
          onClick={() => setTool(id)}
        >
          <Icon />
          <span className="tool__key">{key}</span>
          <span className="tool__tip">
            {label}
            <b>{key}</b>
          </span>
        </button>
      ))}

      <FlyoutButton
        id="shapes"
        items={SHAPE_ITEMS}
        currentKey={shapeCurrent}
        active={SHAPE_KEYS.includes(tool)}
        isItemActive={(k) => tool === k}
        onChoose={(k) => {
          setTool(k as Tool)
          setLastShape(k)
        }}
        openId={openId}
        setOpenId={setOpenId}
      />

      <button
        className={`tool${tool === 'eraser' ? ' tool--active' : ''}`}
        onClick={() => setTool('eraser')}
      >
        <IconEraser />
        <span className="tool__key">E</span>
        <span className="tool__tip">
          Eraser<b>E</b>
        </span>
      </button>

      <button className="tool" onClick={() => fileRef.current?.click()} title="Insert image">
        <IconImage />
        <span className="tool__tip">Insert image</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPickImage(f)
          e.target.value = ''
        }}
      />

      <div className="toolbar__sep" />

      {PRIMARY_WIDGETS.map(({ kind, Icon, label }) => (
        <button key={kind} className="tool" onClick={() => spawn(kind)}>
          <Icon />
          <span className="tool__tip">{label}</span>
        </button>
      ))}

      <FlyoutButton
        id="code"
        items={CODE_ITEMS}
        currentKey={lastCode}
        onChoose={(k) => {
          setLastCode(k)
          spawn(k as WidgetKind)
        }}
        openId={openId}
        setOpenId={setOpenId}
      />

      <FlyoutButton
        id="github"
        items={GITHUB_ITEMS}
        currentKey={lastGithub}
        onChoose={(k) => {
          setLastGithub(k)
          spawn(k as WidgetKind)
        }}
        openId={openId}
        setOpenId={setOpenId}
      />

      {TRAILING_WIDGETS.map(({ kind, Icon, label }) => (
        <button key={kind} className="tool" onClick={() => spawn(kind)}>
          <Icon />
          <span className="tool__tip">{label}</span>
        </button>
      ))}
    </div>
  )
}
