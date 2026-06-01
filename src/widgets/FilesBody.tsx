import { useCallback, useEffect, useState } from 'react'
import type { WidgetElement, WidgetKind } from '../lib/types'
import { useStore } from '../store/workspace'
import { DATA_EXTENSIONS } from '../lib/dataformats'
import { PLOT_EXTENSIONS } from './PlotBody'
import {
  listDir,
  revealPath,
  openExternal,
  fileManagerName,
  type DirEntry,
} from '../lib/backend'
import { IconFiles, IconReload, IconExternal } from '../ui/icons'
import { openContextMenu, type MenuItem } from '../ui/ContextMenu'

// File-tree widget. Browses el.path (or the canvas folder), lazily loading each
// directory on expand. Clicking a file opens an editor widget beside this one;
// right-clicking any row opens a context menu (reveal in the OS file manager,
// copy path/name, …).

const copy = (text: string) => void navigator.clipboard?.writeText(text)

function Row({
  entry,
  depth,
  onOpenFile,
  onMenu,
}: {
  entry: DirEntry
  depth: number
  onOpenFile: (path: string) => void
  onMenu: (e: React.MouseEvent, entry: DirEntry) => void
}) {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const toggle = async () => {
    if (!entry.is_dir) {
      onOpenFile(entry.path)
      return
    }
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (!kids) {
      setLoading(true)
      const list = await listDir(entry.path)
      setKids(list ?? [])
      setLoading(false)
    }
  }

  return (
    <>
      <div
        className="ftree__row"
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={toggle}
        onContextMenu={(e) => onMenu(e, entry)}
        title={`${entry.path}\n(drag onto an agent to add as @context)`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-ccanvas-file', entry.path)
          e.dataTransfer.setData('text/plain', entry.path)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <span className={`ftree__caret${entry.is_dir ? '' : ' ftree__caret--file'}`}>
          {entry.is_dir ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className={`ftree__name${entry.is_dir ? ' ftree__name--dir' : ''}`}>
          {entry.name}
        </span>
      </div>
      {open && (
        <>
          {loading && (
            <div className="ftree__hint" style={{ paddingLeft: 8 + (depth + 1) * 13 }}>
              …
            </div>
          )}
          {kids?.map((k) => (
            <Row
              key={k.path}
              entry={k}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              onMenu={onMenu}
            />
          ))}
          {kids && kids.length === 0 && !loading && (
            <div className="ftree__hint" style={{ paddingLeft: 8 + (depth + 1) * 13 }}>
              empty
            </div>
          )}
        </>
      )}
    </>
  )
}

export function FilesBody({ el }: { el: WidgetElement }) {
  const spawnWidget = useStore((s) => s.spawnWidget)
  const root = el.path || el.cwd || ''
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(async () => {
    if (!root) {
      setEntries(null)
      return
    }
    const list = await listDir(root)
    setEntries(list)
  }, [root, nonce])

  useEffect(() => {
    void load()
  }, [load])

  const openIn = (kind: WidgetKind, path: string) =>
    spawnWidget(kind, el.x + el.w + 320, el.y + 160, { path, cwd: el.cwd })

  // route by extension: data files → data viewer, images → figure viewer, else editor
  const kindForFile = (path: string): WidgetKind => {
    const ext = path.toLowerCase().split('.').pop() ?? ''
    if (DATA_EXTENSIONS.includes(ext)) return 'data'
    if (PLOT_EXTENSIONS.includes(ext)) return 'plot'
    return 'editor'
  }

  const openFile = (path: string) => openIn(kindForFile(path), path)

  const rowMenu = (e: React.MouseEvent, entry: DirEntry) => {
    const fm = fileManagerName()
    const items: MenuItem[] = []
    if (entry.is_dir) {
      items.push({
        label: 'Open as file tree',
        onClick: () =>
          spawnWidget('files', el.x + el.w + 320, el.y + 160, {
            path: entry.path,
            cwd: el.cwd,
            title: entry.name,
          }),
      })
    } else {
      const kind = kindForFile(entry.path)
      if (kind === 'data')
        items.push({ label: 'Open in data viewer', onClick: () => openIn('data', entry.path) })
      else if (kind === 'plot')
        items.push({ label: 'Open in figure viewer', onClick: () => openIn('plot', entry.path) })
      items.push({ label: 'Open in editor', onClick: () => openIn('editor', entry.path) })
      items.push({
        label: 'Open with default app',
        onClick: () => void openExternal(entry.path),
      })
    }
    items.push({
      label: `Reveal in ${fm}`,
      icon: <IconExternal />,
      onClick: () => void revealPath(entry.path),
    })
    items.push({ separator: true })
    items.push({ label: 'Copy path', onClick: () => copy(entry.path) })
    items.push({ label: 'Copy name', onClick: () => copy(entry.name) })
    openContextMenu(e, items)
  }

  if (!root) {
    return (
      <div className="ftree">
        <div className="ftree__empty">
          <IconFiles />
          <div>Bind this canvas to a folder to browse files.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="ftree">
      <div className="ftree__bar">
        <span className="ftree__root" title={root}>
          {root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
        </span>
        <button
          className="ftree__btn"
          title={`Reveal folder in ${fileManagerName()}`}
          onClick={() => void revealPath(root)}
        >
          <IconExternal />
        </button>
        <button
          className="ftree__btn"
          title="Refresh"
          onClick={() => setNonce((n) => n + 1)}
        >
          <IconReload />
        </button>
      </div>
      <div
        className="ftree__list"
        onContextMenu={(e) => {
          // empty-area right-click → act on the root folder
          if (e.target !== e.currentTarget) return
          openContextMenu(e, [
            {
              label: `Reveal folder in ${fileManagerName()}`,
              icon: <IconExternal />,
              onClick: () => void revealPath(root),
            },
            { label: 'Copy folder path', onClick: () => copy(root) },
            { separator: true },
            { label: 'Refresh', onClick: () => setNonce((n) => n + 1) },
          ])
        }}
      >
        {entries == null ? (
          <div className="ftree__hint" style={{ padding: 10 }}>
            backend offline — run <code>npm run server</code> or use the desktop app
          </div>
        ) : (
          entries.map((e) => (
            <Row key={e.path} entry={e} depth={0} onOpenFile={openFile} onMenu={rowMenu} />
          ))
        )}
      </div>
    </div>
  )
}
