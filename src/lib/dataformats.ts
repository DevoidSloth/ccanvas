// Unified data loader for the `data` widget. Each supported format is parsed
// into a single Table model (or a text fallback). Parsing is pure and runs in
// the browser: CSV/TSV/JSON/NDJSON are hand-parsed, parquet via hyparquet, and
// HDF5 via h5wasm (lazy-loaded). Large inputs are capped at ROW_CAP rows for
// display; `totalRows`/`truncated` report the real size.

import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'

/** Max rows materialised for display. Files larger than this are truncated. */
export const ROW_CAP = 50_000
/** How many rows to sample when inferring a column's type. */
const TYPE_SAMPLE = 200

export type ColType = 'number' | 'int' | 'bool' | 'string' | 'other'
export type Cell = string | number | bigint | boolean | null
export type Column = { name: string; type: ColType }

/** A selectable sub-part of a file (an HDF5 dataset, a future spreadsheet tab). */
export type DataPart = { key: string; label: string; detail?: string }

export type Table = {
  columns: Column[]
  rows: Cell[][]
  /** total rows available in the source (>= rows.length when truncated) */
  totalRows: number
  truncated: boolean
  format: string
  /** short human note shown in the footer (row groups, dataset shape, …) */
  info?: string
  /** selectable parts (HDF5 datasets); when present, activePart is shown */
  parts?: DataPart[]
  activePart?: string
}

export type LoadResult =
  | { kind: 'table'; table: Table }
  | { kind: 'text'; text: string; format: string; truncated?: boolean }

export type Format = 'csv' | 'tsv' | 'parquet' | 'hdf5' | 'json' | 'ndjson' | 'text'

/** File extensions the data widget claims (used to route file-tree opens). */
export const DATA_EXTENSIONS = [
  'csv', 'tsv', 'tab',
  'parquet', 'pq', 'parq',
  'h5', 'hdf5', 'hdf', 'he5',
  'json', 'ndjson', 'jsonl',
]

export function detectFormat(name: string): Format {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'csv': return 'csv'
    case 'tsv': case 'tab': return 'tsv'
    case 'parquet': case 'pq': case 'parq': return 'parquet'
    case 'h5': case 'hdf5': case 'hdf': case 'he5': return 'hdf5'
    case 'json': return 'json'
    case 'ndjson': case 'jsonl': return 'ndjson'
    default: return 'text'
  }
}

/**
 * Parse raw file bytes into a Table (or text). `datasetPath` selects a part for
 * multi-part formats (HDF5). Throws on hard parse failures so callers can show
 * the error; format mismatches fall back to a text view where sensible.
 */
export async function loadData(
  name: string,
  bytes: Uint8Array,
  datasetPath?: string,
): Promise<LoadResult> {
  const fmt = detectFormat(name)
  switch (fmt) {
    case 'csv': return loadDelimited(decodeText(bytes), 'csv')
    case 'tsv': return loadDelimited(decodeText(bytes), 'tsv')
    case 'json': return loadJson(decodeText(bytes))
    case 'ndjson': return loadNdjson(decodeText(bytes))
    case 'parquet': return loadParquet(bytes)
    case 'hdf5': return loadHdf5(bytes, datasetPath)
    default: return { kind: 'text', text: decodeText(bytes), format: 'text' }
  }
}

const decodeText = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)

// ---------- display helpers (shared with the widget) ----------

export function isNullish(v: Cell): boolean {
  return v === null || v === undefined
}

export function fmtCell(v: Cell): string {
  if (isNullish(v)) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : trimFloat(v)
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function trimFloat(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  // keep it readable but lossless-ish: up to 6 significant decimals, no trailing zeros
  const s = n.toString()
  return s.length > 12 ? Number(n.toPrecision(8)).toString() : s
}

export function isNumericType(t: ColType): boolean {
  return t === 'number' || t === 'int'
}

/** Comparator for sorting a column by its inferred type. */
export function compareCells(a: Cell, b: Cell, type: ColType): number {
  const an = isNullish(a), bn = isNullish(b)
  if (an && bn) return 0
  if (an) return 1 // nulls sort last
  if (bn) return -1
  if (isNumericType(type)) {
    return Number(a) - Number(b)
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

// ---------- value normalisation + type inference ----------

function normalizeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  const t = typeof v
  if (t === 'number' || t === 'bigint' || t === 'boolean' || t === 'string') return v as Cell
  if (v instanceof Date) return v.toISOString()
  if (ArrayBuffer.isView(v)) {
    const n = (v as unknown as { length?: number }).length
    return typeof n === 'number' ? `[${n} values]` : '[binary]'
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function inferTypeFromValues(vals: Cell[]): ColType {
  let seen = false, allNum = true, allInt = true, allBool = true
  for (const v of vals) {
    if (isNullish(v)) continue
    seen = true
    const t = typeof v
    if (t === 'bigint') { allBool = false }
    else if (t === 'number') { allBool = false; allInt = allInt && Number.isInteger(v as number) }
    else if (t === 'boolean') { allNum = false; allInt = false }
    else { allNum = false; allInt = false; allBool = false }
  }
  if (!seen) return 'string'
  if (allBool) return 'bool'
  if (allInt) return 'int'
  if (allNum) return 'number'
  return 'string'
}

function inferTypeFromStrings(vals: string[]): ColType {
  let seen = false, numeric = true, integer = true, boolean = true
  for (const raw of vals) {
    if (raw === '' || raw == null) continue
    seen = true
    const s = raw.trim()
    if (numeric) {
      const n = Number(s)
      if (s === '' || !Number.isFinite(n)) { numeric = false; integer = false }
      else if (!Number.isInteger(n)) integer = false
    }
    const lc = s.toLowerCase()
    if (lc !== 'true' && lc !== 'false') boolean = false
    if (!numeric && !boolean) break
  }
  if (!seen) return 'string'
  if (boolean) return 'bool'
  if (integer) return 'int'
  if (numeric) return 'number'
  return 'string'
}

// ---------- CSV / TSV ----------

function sniffDelimiter(line: string): string {
  let best = ',', bestN = -1
  for (const d of [',', '\t', ';', '|']) {
    const n = line.split(d).length
    if (n > bestN) { bestN = n; best = d }
  }
  return best
}

/**
 * RFC4180-ish delimited parser: handles quoted fields, "" escapes, embedded
 * newlines, and CRLF/CR/LF line endings. Materialises at most ROW_CAP data
 * rows but counts the true total.
 */
function parseDelimited(text: string, delim: string) {
  const dataRows: string[][] = []
  let header: string[] = []
  let haveHeader = false
  let total = 0
  let field = ''
  let row: string[] = []
  let started = false
  let inQuotes = false

  const endField = () => { row.push(field); field = '' }
  const endRow = () => {
    endField()
    const blank = row.length === 1 && row[0] === ''
    if (!blank) {
      if (!haveHeader) { header = row; haveHeader = true }
      else { total++; if (dataRows.length < ROW_CAP) dataRows.push(row) }
    }
    row = []
    started = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') { inQuotes = true; started = true }
    else if (ch === delim) { endField(); started = true }
    else if (ch === '\n') endRow()
    else if (ch === '\r') { if (text[i + 1] !== '\n') endRow() }
    else { field += ch; started = true }
  }
  if (started || field !== '' || row.length > 0) endRow()
  return { header, dataRows, total }
}

function loadDelimited(text: string, fmt: 'csv' | 'tsv'): LoadResult {
  const firstLine = text.slice(0, text.search(/[\r\n]/) >= 0 ? text.search(/[\r\n]/) : text.length)
  const delim = fmt === 'tsv' ? '\t' : sniffDelimiter(firstLine)
  const { header, dataRows, total } = parseDelimited(text, delim)
  const ncols = Math.max(header.length, ...dataRows.map((r) => r.length), 0)
  const columns: Column[] = []
  for (let c = 0; c < ncols; c++) {
    const sample: string[] = []
    for (let r = 0; r < dataRows.length && sample.length < TYPE_SAMPLE; r++) {
      sample.push(dataRows[r][c] ?? '')
    }
    columns.push({ name: header[c]?.trim() || `col${c + 1}`, type: inferTypeFromStrings(sample) })
  }
  // normalise empty cells to null for consistent rendering/sorting
  const rows: Cell[][] = dataRows.map((r) => {
    const out: Cell[] = new Array(ncols)
    for (let c = 0; c < ncols; c++) {
      const v = r[c]
      out[c] = v === undefined || v === '' ? null : v
    }
    return out
  })
  return {
    kind: 'table',
    table: {
      columns,
      rows,
      totalRows: total,
      truncated: total > rows.length,
      format: fmt,
      info: `delimiter ${delim === '\t' ? '\\t' : delim}`,
    },
  }
}

// ---------- JSON / NDJSON ----------

function tableFromObjects(arr: unknown[], format: string): Table {
  const capped = arr.slice(0, ROW_CAP)
  let columns: Column[]
  let rows: Cell[][]

  const first = arr.find((x) => x != null)
  if (Array.isArray(first)) {
    const ncols = arr.reduce<number>((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    columns = Array.from({ length: ncols }, (_, c) => ({ name: `col${c + 1}`, type: 'string' as ColType }))
    rows = capped.map((r) => columns.map((_, c) => normalizeCell((r as unknown[])?.[c])))
  } else if (first != null && typeof first === 'object') {
    // union of keys across a sample, preserving first-seen order
    const keys: string[] = []
    const seen = new Set<string>()
    for (const o of arr.slice(0, Math.max(ROW_CAP, 1000))) {
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
      }
    }
    columns = keys.map((k) => ({ name: k, type: 'string' as ColType }))
    rows = capped.map((o) =>
      keys.map((k) => normalizeCell((o as Record<string, unknown>)?.[k])),
    )
  } else {
    columns = [{ name: 'value', type: 'string' }]
    rows = capped.map((v) => [normalizeCell(v)])
  }

  // refine column types from the materialised rows
  columns = columns.map((col, c) => ({
    ...col,
    type: inferTypeFromValues(rows.slice(0, TYPE_SAMPLE).map((r) => r[c])),
  }))

  return {
    columns,
    rows,
    totalRows: arr.length,
    truncated: arr.length > rows.length,
    format,
  }
}

function loadJson(text: string): LoadResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { kind: 'text', text, format: 'json' }
  }
  if (Array.isArray(data)) return { kind: 'table', table: tableFromObjects(data, 'json') }
  // non-array JSON (object/primitive) → pretty-printed text
  return { kind: 'text', text: JSON.stringify(data, null, 2), format: 'json' }
}

function loadNdjson(text: string): LoadResult {
  const arr: unknown[] = []
  let total = 0
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    total++
    if (arr.length >= ROW_CAP) continue
    try {
      arr.push(JSON.parse(line))
    } catch {
      bad++
      arr.push({ _raw: line })
    }
  }
  if (!total) return { kind: 'text', text, format: 'ndjson' }
  const table = tableFromObjects(arr, 'ndjson')
  table.totalRows = total
  table.truncated = total > table.rows.length
  if (bad) table.info = `${bad} unparseable line(s)`
  return { kind: 'table', table }
}

// ---------- Parquet ----------

async function loadParquet(bytes: Uint8Array): Promise<LoadResult> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const file = {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => ab.slice(start, end ?? ab.byteLength),
  }
  const metadata = parquetMetadata(ab)
  const total = Number(metadata.num_rows)
  const rowEnd = Math.min(total, ROW_CAP)
  const objs = await parquetReadObjects({ file, metadata, rowEnd, compressors, utf8: true })

  const sample = (objs[0] ?? {}) as Record<string, unknown>
  const leafNames = metadata.schema.filter((e) => e.type !== undefined).map((e) => e.name)
  let colNames = leafNames.filter((n) => n in sample)
  if (!colNames.length) colNames = Object.keys(sample)

  const rows: Cell[][] = objs.map((o) =>
    colNames.map((n) => normalizeCell((o as Record<string, unknown>)[n])),
  )
  const columns: Column[] = colNames.map((name, c) => ({
    name,
    type: inferTypeFromValues(rows.slice(0, TYPE_SAMPLE).map((r) => r[c])),
  }))

  return {
    kind: 'table',
    table: {
      columns,
      rows,
      totalRows: total,
      truncated: total > rows.length,
      format: 'parquet',
      info: `${metadata.row_groups.length} row group${metadata.row_groups.length === 1 ? '' : 's'}`,
    },
  }
}

// ---------- HDF5 (lazy h5wasm) ----------

let h5modPromise: Promise<typeof import('h5wasm')> | null = null
let h5fileCounter = 0

async function getH5() {
  if (!h5modPromise) {
    h5modPromise = (async () => {
      const h5 = await import('h5wasm')
      await h5.ready
      return h5
    })()
  }
  return h5modPromise
}

type H5DatasetInfo = { path: string; shape: number[]; dtype: string }

function walkH5(group: any, prefix: string, out: H5DatasetInfo[], h5: any, depth = 0): void {
  if (depth > 32 || out.length > 5000) return
  let keys: string[] = []
  try {
    keys = group.keys()
  } catch {
    return
  }
  for (const k of keys) {
    const path = prefix ? `${prefix}/${k}` : k
    let entity: any
    try {
      entity = group.get(k)
    } catch {
      continue
    }
    if (!entity) continue
    if (entity instanceof h5.Dataset) {
      out.push({ path, shape: entity.shape ?? [], dtype: String(entity.dtype ?? '') })
    } else if (entity instanceof h5.Group) {
      walkH5(entity, path, out, h5, depth + 1)
    }
  }
}

function datasetToTable(ds: any, target: H5DatasetInfo, parts: DataPart[]): Table {
  const shape = ds.shape ?? []
  const base: Pick<Table, 'format' | 'parts' | 'activePart'> = {
    format: 'hdf5',
    parts,
    activePart: target.path,
  }
  const leaf = target.path.split('/').pop() || target.path
  const elems = shape.reduce((a: number, b: number) => a * b, 1)

  if (!shape.length) {
    // scalar
    const v = normalizeCell(ds.value)
    return { ...base, columns: [{ name: leaf, type: inferTypeFromValues([v]) }], rows: [[v]], totalRows: 1, truncated: false, info: `scalar · ${target.dtype}` }
  }

  if (elems > 5_000_000) {
    return tooBig(base, shape, target.dtype)
  }

  if (shape.length === 1) {
    const arr = (ds.value as ArrayLike<unknown>) ?? []
    const total = arr.length
    const rows: Cell[][] = []
    for (let i = 0; i < total && rows.length < ROW_CAP; i++) rows.push([normalizeCell(arr[i])])
    return {
      ...base,
      columns: [{ name: leaf, type: inferTypeFromValues(rows.slice(0, TYPE_SAMPLE).map((r) => r[0])) }],
      rows,
      totalRows: total,
      truncated: total > rows.length,
      info: `shape ${shape.join('×')} · ${target.dtype}`,
    }
  }

  if (shape.length === 2) {
    let nested: unknown[]
    try {
      nested = ds.to_array() as unknown[]
    } catch {
      return tooBig(base, shape, target.dtype)
    }
    const ncols = shape[1]
    const rows: Cell[][] = []
    for (let i = 0; i < nested.length && rows.length < ROW_CAP; i++) {
      const r = nested[i] as unknown[]
      rows.push(Array.from({ length: ncols }, (_, c) => normalizeCell(r?.[c])))
    }
    const columns: Column[] = Array.from({ length: ncols }, (_, c) => ({
      name: `col${c}`,
      type: inferTypeFromValues(rows.slice(0, TYPE_SAMPLE).map((r) => r[c])),
    }))
    return { ...base, columns, rows, totalRows: shape[0], truncated: shape[0] > rows.length, info: `shape ${shape.join('×')} · ${target.dtype}` }
  }

  return tooBig(base, shape, target.dtype)
}

function tooBig(base: Pick<Table, 'format' | 'parts' | 'activePart'>, shape: number[], dtype: string): Table {
  return {
    ...base,
    columns: [{ name: 'info', type: 'string' }],
    rows: [[`dataset shape ${shape.join('×')} (${dtype}) is too large or high-dimensional to preview here`]],
    totalRows: 1,
    truncated: false,
    info: `shape ${shape.join('×')} · ${dtype}`,
  }
}

async function loadHdf5(bytes: Uint8Array, datasetPath?: string): Promise<LoadResult> {
  let h5: Awaited<ReturnType<typeof getH5>>
  try {
    h5 = await getH5()
  } catch (e) {
    return { kind: 'text', text: `HDF5 support failed to load (h5wasm): ${String(e)}`, format: 'hdf5' }
  }
  const fname = `/ccanvas_${h5fileCounter++}.h5`
  ;(h5.FS as any).writeFile(fname, bytes)
  let f: any
  try {
    f = new (h5 as any).File(fname, 'r')
    const datasets: H5DatasetInfo[] = []
    walkH5(f, '', datasets, h5)
    if (!datasets.length) {
      return { kind: 'text', text: '(no datasets found in this HDF5 file)', format: 'hdf5' }
    }
    const parts: DataPart[] = datasets.map((d) => ({
      key: d.path,
      label: d.path,
      detail: `${d.shape.join('×') || 'scalar'} ${d.dtype}`,
    }))
    const target = (datasetPath && datasets.find((d) => d.path === datasetPath)) || datasets[0]
    const ds = f.get(target.path)
    return { kind: 'table', table: datasetToTable(ds, target, parts) }
  } catch (e) {
    return { kind: 'text', text: `failed to read HDF5 file: ${String(e)}`, format: 'hdf5' }
  } finally {
    try { f?.close() } catch { /* ignore */ }
    try { (h5.FS as any).unlink(fname) } catch { /* ignore */ }
  }
}
