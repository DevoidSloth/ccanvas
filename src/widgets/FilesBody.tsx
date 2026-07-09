import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement, WidgetKind } from '../lib/types'
import { useStore } from '../store/workspace'
import { widgetKindForFile, VIDEO_EXTENSIONS } from '../lib/filetypes'
import {
  listDir,
  revealPath,
  openExternal,
  fileManagerName,
  watchPath,
  joinPath,
  type DirEntry,
} from '../lib/backend'
import {
  IconFiles,
  IconReload,
  IconExternal,
  IconSearch,
  IconClose,
  IconFolder,
  IconFile,
  IconImage,
  IconData,
  IconDoc,
  IconDatabase,
  IconWeb,
  IconEditor,
  IconSettings,
  IconArchive,
  IconVideo,
} from '../ui/icons'
import { openContextMenu, type MenuItem } from '../ui/ContextMenu'

// File-tree widget. Browses el.path (or the canvas folder) as a lazily-loaded
// tree, hot-reloading on filesystem changes (recursive notify watcher under
// Tauri, polling otherwise). A search box does a breadth-first walk of the
// subtree so you can jump to any file by name; each row carries a filetype
// icon. Clicking a file opens the right viewer widget beside this one;
// right-clicking any row opens a context menu (reveal, copy path/name, …).

const copy = (text: string) => void navigator.clipboard?.writeText(text)

// Dirs we never descend into while searching — huge and almost never the target.
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])
const MAX_RESULTS = 400
const MAX_DIRS = 2000

// ---------- filetype → icon + colour category ----------

type FileCat =
  | 'code' | 'markup' | 'data' | 'image' | 'video' | 'doc'
  | 'config' | 'archive' | 'db' | 'file'

const set = (s: string) => new Set(s.split(' '))
const CODE = set('js mjs cjs jsx ts tsx py pyw pyi rb go rs java kt kts c h cc cpp cxx hpp hh cs php swift scala clj cljs ex exs erl lua r jl dart m mm sh bash zsh fish ps1 psm1 bat cmd pl pm hs ml mli fs fsx vb groovy gradle graphql gql proto')
const MARKUP = set('html htm xhtml css scss sass less styl vue svelte astro pug')
const DATA = set('csv tsv tab json jsonc ndjson jsonl parquet pq parq h5 hdf5 hdf he5 arrow feather')
const IMAGE = set('png jpg jpeg gif webp bmp svg avif ico tif tiff')
const VIDEO = new Set(VIDEO_EXTENSIONS)
const DOCEXT = set('md markdown mdx txt text rst adoc asciidoc tex rtf pdf log')
const CONFIG = set('yaml yml toml ini cfg conf env lock editorconfig gitignore gitattributes dockerignore dockerfile npmrc nvmrc prettierrc eslintrc xml properties')
const ARCHIVE = set('zip tar gz tgz bz2 xz zst 7z rar jar war')
const DB = set('sql sqlite sqlite3 db ddl')

function fileCategory(name: string): FileCat {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'config'
  if (lower === 'makefile' || lower === 'cmakelists.txt') return 'config'
  // for dotfiles (.gitignore) the "extension" is the trailing segment
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (CODE.has(ext)) return 'code'
  if (MARKUP.has(ext)) return 'markup'
  if (DATA.has(ext)) return 'data'
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (DOCEXT.has(ext)) return 'doc'
  if (CONFIG.has(ext)) return 'config'
  if (ARCHIVE.has(ext)) return 'archive'
  if (DB.has(ext)) return 'db'
  return 'file'
}

const CAT_ICON: Record<FileCat, (p: { size?: number }) => JSX.Element> = {
  code: IconEditor,
  markup: IconWeb,
  data: IconData,
  image: IconImage,
  video: IconVideo,
  doc: IconDoc,
  config: IconSettings,
  archive: IconArchive,
  db: IconDatabase,
  file: IconFile,
}

function FileIcon({ entry }: { entry: DirEntry }) {
  if (entry.is_dir)
    return (
      <span className="ftree__icon ftree__icon--folder">
        <IconFolder />
      </span>
    )
  const cat = fileCategory(entry.name)
  const Icon = CAT_ICON[cat]
  return (
    <span className={`ftree__icon ftree__icon--${cat}`}>
      <Icon />
    </span>
  )
}

// ---------- tree model helpers ----------

type Cache = Map<string, DirEntry[]>
type VisibleRow = { entry: DirEntry; depth: number }

/** Walk the cache from `root`, splicing in children of expanded dirs. */
function flatten(cache: Cache, expanded: Set<string>, root: string): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (dir: string, depth: number) => {
    const kids = cache.get(dir)
    if (!kids) return
    for (const e of kids) {
      out.push({ entry: e, depth })
      if (e.is_dir && expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** Stable signature of the cache, to skip no-op reloads under polling. */
function signature(cache: Cache): string {
  const parts: string[] = []
  for (const [dir, list] of cache) {
    parts.push(
      dir + '=' + list.map((e) => e.name + (e.is_dir ? '/' : '') + (e.mtime ?? '')).join(','),
    )
  }
  return parts.sort().join('|')
}

// ---------- rows ----------

function dragProps(path: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('application/x-ccanvas-file', path)
      e.dataTransfer.setData('text/plain', path)
      e.dataTransfer.effectAllowed = 'copy' as const
    },
  }
}

function TreeRow({
  row,
  open,
  loading,
  onToggle,
  onOpenFile,
  onMenu,
}: {
  row: VisibleRow
  open: boolean
  loading: boolean
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onMenu: (e: React.MouseEvent, entry: DirEntry) => void
}) {
  const { entry, depth } = row
  return (
    <div
      className="ftree__row"
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => (entry.is_dir ? onToggle(entry.path) : onOpenFile(entry.path))}
      onContextMenu={(e) => onMenu(e, entry)}
      title={`${entry.path}\n(drag onto an agent to add as @context)`}
      {...dragProps(entry.path)}
    >
      <span className="ftree__caret">
        {entry.is_dir ? (loading ? '∙' : open ? '▾' : '▸') : ''}
      </span>
      <FileIcon entry={entry} />
      <span className={`ftree__name${entry.is_dir ? ' ftree__name--dir' : ''}`}>
        {entry.name}
      </span>
    </div>
  )
}

/** A search hit: filetype icon, highlighted name, dimmed relative folder. */
function ResultRow({
  entry,
  root,
  query,
  onOpenFile,
  onRevealDir,
  onMenu,
}: {
  entry: DirEntry
  root: string
  query: string
  onOpenFile: (path: string) => void
  onRevealDir: (path: string) => void
  onMenu: (e: React.MouseEvent, entry: DirEntry) => void
}) {
  const rel = entry.path.slice(root.length).replace(/^[\\/]+/, '')
  const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
  const relDir = cut >= 0 ? rel.slice(0, cut) : ''
  const i = entry.name.toLowerCase().indexOf(query.toLowerCase())
  return (
    <div
      className="ftree__row ftree__result"
      onClick={() => (entry.is_dir ? onRevealDir(entry.path) : onOpenFile(entry.path))}
      onContextMenu={(e) => onMenu(e, entry)}
      title={entry.path}
      {...dragProps(entry.path)}
    >
      <FileIcon entry={entry} />
      <span className={`ftree__name${entry.is_dir ? ' ftree__name--dir' : ''}`}>
        {i < 0 ? (
          entry.name
        ) : (
          <>
            {entry.name.slice(0, i)}
            <mark className="ftree__hl">{entry.name.slice(i, i + query.length)}</mark>
            {entry.name.slice(i + query.length)}
          </>
        )}
      </span>
      {relDir && <span className="ftree__path">{relDir}</span>}
    </div>
  )
}

// ---------- main widget ----------

export function FilesBody({ el }: { el: WidgetElement }) {
  const spawnWidget = useStore((s) => s.spawnWidget)
  const root = el.path || el.cwd || ''

  const [cache, setCache] = useState<Cache>(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState<Set<string>>(() => new Set())
  const [offline, setOffline] = useState(false)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DirEntry[] | null>(null)
  const [searching, setSearching] = useState(false)

  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const sigRef = useRef('')

  // Re-list the root plus every directory we already have loaded, then prune
  // expanded dirs that vanished. Skips state churn when nothing changed.
  const reload = useCallback(async () => {
    if (!root) return
    const paths = new Set(cacheRef.current.keys())
    paths.add(root)
    const pairs = await Promise.all(
      Array.from(paths).map(async (p) => [p, await listDir(p)] as const),
    )
    const rootList = pairs.find(([p]) => p === root)?.[1]
    if (rootList == null) {
      setOffline(true)
      return
    }
    setOffline(false)
    const next: Cache = new Map()
    for (const [p, list] of pairs) if (list) next.set(p, list)
    const sig = signature(next)
    if (sig === sigRef.current) return
    sigRef.current = sig
    setCache(next)
    setExpanded((prev) => new Set(Array.from(prev).filter((p) => next.has(p))))
  }, [root])

  // Initial load (and whenever the bound folder changes).
  useEffect(() => {
    setCache(new Map())
    setExpanded(new Set())
    setLoading(new Set())
    sigRef.current = ''
    if (!root) return
    let cancelled = false
    void listDir(root).then((list) => {
      if (cancelled) return
      if (list == null) {
        setOffline(true)
        return
      }
      setOffline(false)
      const m: Cache = new Map([[root, list]])
      sigRef.current = signature(m)
      setCache(m)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  // Hot reload: watch the (recursive) root and refresh on change, debounced.
  useEffect(() => {
    if (!root) return
    let dispose: (() => void) | null = null
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void reload(), 300)
    }
    void watchPath(root, onChange, 2500).then((d) => (cancelled ? d() : (dispose = d)))
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
      dispose?.()
    }
  }, [root, reload])

  const toggleDir = useCallback(async (path: string) => {
    let willOpen = false
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        willOpen = true
      }
      return next
    })
    if (willOpen && !cacheRef.current.has(path)) {
      setLoading((s) => new Set(s).add(path))
      const list = await listDir(path)
      setCache((prev) => new Map(prev).set(path, list ?? []))
      setLoading((s) => {
        const n = new Set(s)
        n.delete(path)
        return n
      })
    }
  }, [])

  // Reveal a directory in the tree: load + expand it and every ancestor.
  const revealDir = useCallback(
    async (target: string) => {
      const rel = target.slice(root.length).replace(/^[\\/]+/, '')
      const parts = rel.split(/[\\/]/).filter(Boolean)
      const chain: string[] = []
      let cur = root
      for (const part of parts) {
        cur = joinPath(cur, part)
        chain.push(cur)
      }
      // load any uncached dir along the chain (root is already loaded)
      const toLoad = [root, ...chain].filter((p) => !cacheRef.current.has(p))
      const loaded = await Promise.all(
        toLoad.map(async (p) => [p, await listDir(p)] as const),
      )
      if (loaded.length) {
        setCache((prev) => {
          const next = new Map(prev)
          for (const [p, list] of loaded) if (list) next.set(p, list)
          return next
        })
      }
      setExpanded((prev) => new Set([...prev, ...chain]))
      setQuery('')
      setResults(null)
    },
    [root],
  )

  // Debounced subtree search (breadth-first, shallow hits first).
  useEffect(() => {
    const q = query.trim()
    if (!q || !root) {
      setResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      const ql = q.toLowerCase()
      const matches: DirEntry[] = []
      const queue: string[] = [root]
      let visited = 0
      while (queue.length && matches.length < MAX_RESULTS && visited < MAX_DIRS) {
        if (cancelled) return
        const dir = queue.shift() as string
        visited++
        const list = await listDir(dir)
        if (!list) continue
        for (const e of list) {
          if (e.name.toLowerCase().includes(ql)) matches.push(e)
          if (e.is_dir && !IGNORE_DIRS.has(e.name)) queue.push(e.path)
        }
      }
      if (cancelled) return
      matches.sort((a, b) => {
        const aw = a.name.toLowerCase().startsWith(ql) ? 0 : 1
        const bw = b.name.toLowerCase().startsWith(ql) ? 0 : 1
        if (aw !== bw) return aw - bw
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setResults(matches)
      setSearching(false)
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, root])

  const visible = useMemo(() => flatten(cache, expanded, root), [cache, expanded, root])

  const openIn = (kind: WidgetKind, path: string) =>
    spawnWidget(kind, el.x + el.w + 320, el.y + 160, { path, cwd: el.cwd })

  const openFile = (path: string) => openIn(widgetKindForFile(path), path)

  const rowMenu = (e: React.MouseEvent, entry: DirEntry) => {
    const fm = fileManagerName()
    const items: MenuItem[] = []
    if (entry.is_dir) {
      items.push({
        label: 'Reveal in tree',
        onClick: () => void revealDir(entry.path),
      })
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
      const kind = widgetKindForFile(entry.path)
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

  const inSearch = query.trim().length > 0

  return (
    <div className="ftree">
      <div className="ftree__bar">
        <span className="ftree__root" title={root}>
          <IconFolder />
          {root.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
        </span>
        <button
          className="ftree__btn"
          title={`Reveal folder in ${fileManagerName()}`}
          onClick={() => void revealPath(root)}
        >
          <IconExternal />
        </button>
        <button className="ftree__btn" title="Refresh" onClick={() => void reload()}>
          <IconReload />
        </button>
      </div>

      <div className="ftree__search">
        <IconSearch size={13} />
        <input
          className="ftree__input"
          placeholder="Search files…"
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
            e.stopPropagation()
          }}
        />
        {query && (
          <button className="ftree__clear" title="Clear" onClick={() => setQuery('')}>
            <IconClose size={12} />
          </button>
        )}
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
            { label: 'Refresh', onClick: () => void reload() },
          ])
        }}
      >
        {offline ? (
          <div className="ftree__hint" style={{ padding: 10 }}>
            backend offline — run <code>npm run server</code> or use the desktop app
          </div>
        ) : inSearch ? (
          results == null ? (
            <div className="ftree__hint">{searching ? 'searching…' : ''}</div>
          ) : results.length === 0 ? (
            <div className="ftree__hint">no matches for “{query.trim()}”</div>
          ) : (
            <>
              {results.map((entry) => (
                <ResultRow
                  key={entry.path}
                  entry={entry}
                  root={root}
                  query={query.trim()}
                  onOpenFile={openFile}
                  onRevealDir={revealDir}
                  onMenu={rowMenu}
                />
              ))}
              {results.length >= MAX_RESULTS && (
                <div className="ftree__hint">
                  showing first {MAX_RESULTS} matches — refine your search
                </div>
              )}
            </>
          )
        ) : (
          visible.map((row) => (
            <TreeRow
              key={row.entry.path}
              row={row}
              open={expanded.has(row.entry.path)}
              loading={loading.has(row.entry.path)}
              onToggle={toggleDir}
              onOpenFile={openFile}
              onMenu={rowMenu}
            />
          ))
        )}
      </div>
    </div>
  )
}
