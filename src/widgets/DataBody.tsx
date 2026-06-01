import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { readBytes, resolvePath, baseName, watchPath, pickPath, revealPath } from '../lib/backend'
import {
  loadData,
  fmtCell,
  isNumericType,
  isNullish,
  compareCells,
  DATA_EXTENSIONS,
  type LoadResult,
  type Table,
  type ColType,
} from '../lib/dataformats'
import { IconReload, IconExternal, IconData } from '../ui/icons'

// Universal data viewer. Reads any file the data layer understands (CSV/TSV,
// Parquet, HDF5, JSON/NDJSON, text fallback), parses it in-browser, and renders
// a virtualized, sortable table. Live-reloads on disk changes; HDF5 files expose
// a dataset picker. Binary content arrives via backend.readBytes.

const ROWH = 26
const OVERSCAN = 8

type Sort = { col: number; dir: 'asc' | 'desc' } | null

export function DataBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const abs = resolvePath(el.cwd, el.path ?? '')

  const [result, setResult] = useState<LoadResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [datasetPath, setDatasetPath] = useState<string | undefined>(undefined)
  const bytesRef = useRef<{ abs: string; bytes: Uint8Array } | null>(null)

  const ensureBytes = useCallback(
    async (force: boolean): Promise<Uint8Array | null> => {
      if (!force && bytesRef.current?.abs === abs) return bytesRef.current.bytes
      const bytes = await readBytes(abs)
      if (bytes) bytesRef.current = { abs, bytes }
      return bytes
    },
    [abs],
  )

  const load = useCallback(
    async (force: boolean) => {
      if (!abs) {
        setStatus('idle')
        setResult(null)
        return
      }
      setStatus('loading')
      try {
        const bytes = await ensureBytes(force)
        if (!bytes) {
          setError('could not read file — backend offline or file missing')
          setStatus('error')
          return
        }
        const res = await loadData(baseName(abs), bytes, datasetPath)
        setResult(res)
        setStatus('idle')
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
        setStatus('error')
      }
    },
    [abs, datasetPath, ensureBytes],
  )

  // reload on path/dataset change; reset dataset selection when the file changes
  useEffect(() => {
    setDatasetPath(undefined)
  }, [abs])
  useEffect(() => {
    void load(false)
  }, [load])

  // live reload on disk changes (force a fresh byte read)
  useEffect(() => {
    if (!abs) return
    let dispose: (() => void) | null = null
    let cancelled = false
    void watchPath(abs, () => void load(true)).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [abs, load])

  const setPath = (p: string) => {
    mutateElement(el.id, (w) => {
      ;(w as WidgetElement).path = p
      ;(w as WidgetElement).title = baseName(p)
    })
  }

  if (!el.path) {
    return (
      <div className="data data--empty">
        <div className="editor__pick">
          <div className="editor__pick-label">
            Open a data file — csv, tsv, parquet, h5/hdf5, json, ndjson (relative or absolute):
          </div>
          <input
            className="editor__path-input"
            placeholder="data/frame.parquet"
            value={pathInput}
            spellCheck={false}
            onChange={(e) => setPathInput(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && pathInput.trim()) setPath(pathInput.trim())
            }}
          />
          <button
            className="data__browse"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async () => {
              const p = await pickPath({ name: 'Data files', extensions: DATA_EXTENSIONS })
              if (p) setPath(p)
            }}
          >
            Browse…
          </button>
        </div>
      </div>
    )
  }

  const table = result?.kind === 'table' ? result.table : null

  return (
    <div className="data">
      <div className="data__bar">
        <span className="data__icon">
          <IconData />
        </span>
        <span className="data__name" title={abs}>
          {baseName(el.path)}
        </span>
        {table && (
          <select
            className="data__part"
            style={{ display: table.parts ? '' : 'none' }}
            value={table.activePart ?? ''}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDatasetPath(e.target.value)}
            title="HDF5 dataset"
          >
            {table.parts?.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label} {p.detail ? `· ${p.detail}` : ''}
              </option>
            ))}
          </select>
        )}
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {status === 'loading' && <span className="data__state">parsing…</span>}
        <button
          className="data__btn"
          title="Reveal in file manager"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void revealPath(abs)}
        >
          <IconExternal />
        </button>
        <button
          className="data__btn"
          title="Reload from disk"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void load(true)}
        >
          <IconReload />
        </button>
      </div>

      {status === 'error' ? (
        <div className="data__msg">{error}</div>
      ) : result?.kind === 'text' ? (
        <TextView text={result.text} format={result.format} />
      ) : table ? (
        <DataTable table={table} />
      ) : (
        <div className="data__msg">{status === 'loading' ? 'parsing…' : 'no data'}</div>
      )}
    </div>
  )
}

function TextView({ text, format }: { text: string; format: string }) {
  return (
    <>
      <pre className="data__text" onPointerDown={(e) => e.stopPropagation()}>
        {text.slice(0, 2_000_000)}
      </pre>
      <div className="data__foot">
        <span>{format}</span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {text.length > 2_000_000 && <span>showing first 2 MB</span>}
      </div>
    </>
  )
}

function colTypeLabel(t: ColType): string {
  return t === 'int' ? '#' : t === 'number' ? '#.#' : t === 'bool' ? 'T/F' : t === 'string' ? 'abc' : '{}'
}

function DataTable({ table }: { table: Table }) {
  const { columns, rows } = table
  const [sort, setSort] = useState<Sort>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  const rafRef = useRef<number | null>(null)

  // reset sort when the underlying table changes (new file/dataset)
  useEffect(() => setSort(null), [table])

  const gutterW = useMemo(() => 28 + String(table.totalRows).length * 8, [table.totalRows])

  const colWidths = useMemo(
    () =>
      columns.map((col, c) => {
        let max = col.name.length + 4 // room for the type chip
        const lim = Math.min(rows.length, 80)
        for (let r = 0; r < lim; r++) max = Math.max(max, fmtCell(rows[r][c]).length)
        return Math.min(360, Math.max(64, Math.round(max * 7.6 + 22)))
      }),
    [columns, rows],
  )
  const totalW = useMemo(() => gutterW + colWidths.reduce((a, b) => a + b, 0), [gutterW, colWidths])

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const { col, dir } = sort
    const type = columns[col]?.type ?? 'string'
    const sign = dir === 'asc' ? 1 : -1
    // stable sort over index array
    const idx = rows.map((_, i) => i)
    idx.sort((a, b) => {
      const c = compareCells(rows[a][col], rows[b][col], type)
      return c !== 0 ? c * sign : a - b
    })
    return idx.map((i) => rows[i])
  }, [rows, sort, columns])

  const onScroll = () => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const el = scrollRef.current
      if (!el) return
      setScrollTop(el.scrollTop)
      setViewH(el.clientHeight)
    })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / ROWH) - OVERSCAN)
  const end = Math.min(sortedRows.length, Math.ceil((scrollTop + viewH) / ROWH) + OVERSCAN)
  const rowsWindow: JSX.Element[] = []
  for (let i = start; i < end; i++) {
    const row = sortedRows[i]
    rowsWindow.push(
      <div className="data__row" key={i} style={{ top: i * ROWH, width: totalW }}>
        <div className="data__gutter" style={{ width: gutterW }}>
          {i + 1}
        </div>
        {columns.map((col, c) => {
          const v = row[c]
          return (
            <div
              key={c}
              className={`data__cell${isNumericType(col.type) ? ' data__cell--num' : ''}${
                isNullish(v) ? ' data__cell--null' : ''
              }`}
              style={{ width: colWidths[c] }}
              title={isNullish(v) ? 'null' : fmtCell(v)}
            >
              {isNullish(v) ? '·' : fmtCell(v)}
            </div>
          )
        })}
      </div>,
    )
  }

  const toggleSort = (c: number) =>
    setSort((s) =>
      !s || s.col !== c ? { col: c, dir: 'asc' } : s.dir === 'asc' ? { col: c, dir: 'desc' } : null,
    )

  return (
    <>
      <div
        className="data__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="data__grid" style={{ width: totalW }}>
          <div className="data__head" style={{ width: totalW }}>
            <div className="data__gutter data__gutter--head" style={{ width: gutterW }} />
            {columns.map((col, c) => (
              <div
                key={c}
                className={`data__th${isNumericType(col.type) ? ' data__th--num' : ''}`}
                style={{ width: colWidths[c] }}
                onClick={() => toggleSort(c)}
                title={`${col.name} · ${col.type}`}
              >
                <span className="data__th-name">{col.name}</span>
                <span className="data__th-type">{colTypeLabel(col.type)}</span>
                {sort?.col === c && (
                  <span className="data__th-sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                )}
              </div>
            ))}
          </div>
          <div className="data__rows" style={{ height: sortedRows.length * ROWH, width: totalW }}>
            {rowsWindow}
          </div>
        </div>
      </div>
      <div className="data__foot">
        <span>
          {rows.length.toLocaleString()}
          {table.truncated ? ` of ${table.totalRows.toLocaleString()}` : ''} rows · {columns.length}{' '}
          cols · {table.format}
        </span>
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {table.info && <span className="data__info">{table.info}</span>}
        {table.truncated && <span className="data__trunc">first {rows.length.toLocaleString()}</span>}
      </div>
    </>
  )
}
