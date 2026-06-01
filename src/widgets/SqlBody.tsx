import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { runCommand, readFile, joinPath, backendOnline } from '../lib/backend'
import { IconReload, IconRun, IconDatabase } from '../ui/icons'
import '../styles/sql-panel.css'

// SQL editor widget. Reads a Postgres connection string from the canvas
// folder's .env / .env.local (the one Supabase drops in as DATABASE_URL /
// POSTGRES_URL / SUPABASE_DB_URL), runs queries through `psql --csv` via the
// backend runCommand bridge — the same way DiffBody runs `git` — and renders
// the result set as a grid alongside a schema/tables sidebar.
//
// The connection string (and its password) is NEVER persisted: only the env
// key *name* and the SQL text are stored on the widget. The string is re-read
// from .env each time the widget mounts.

// .env keys to prefer when several connection strings are present.
const PRIORITY = [
  'DATABASE_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DATABASE_URL',
  'DIRECT_URL',
  'DATABASE_URL_UNPOOLED',
]
const PG_URL = /^postgres(ql)?:\/\//i
const MAX_ROWS = 1000

// psql command tags (printed for non-SELECT statements). A single CSV line
// matching one of these is a status message, not a one-column result.
const COMMAND_TAG =
  /^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|COPY|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|SET|RESET|SHOW|DO|CALL|EXPLAIN|ANALYZE|VACUUM|REINDEX|CLUSTER|REFRESH|LISTEN|NOTIFY|DECLARE|FETCH|CLOSE)\b/

const SCHEMA_SQL = `select n.nspname, c.relname, c.reltuples::bigint, c.relkind
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p','v','m')
  and n.nspname not in ('pg_catalog','information_schema','pg_toast')
order by n.nspname, c.relname`

type Candidate = { key: string; value: string }
type Table = { schema: string; name: string; rows: string; kind: string }
type Column = { name: string; type: string }
type Grid = { cols: string[]; rows: string[][] }
type EnvState = 'loading' | 'ok' | 'none' | 'nodir' | 'offline'

const qIdent = (s: string) => '"' + s.replace(/"/g, '""') + '"'
const qLit = (s: string) => "'" + s.replace(/'/g, "''") + "'"

/** Minimal dotenv parser — KEY=value, optional `export `, quotes, comments. */
function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const rhs = m[2].trim()
    const quoted =
      (rhs.startsWith('"') && rhs.endsWith('"')) ||
      (rhs.startsWith("'") && rhs.endsWith("'"))
    const val = quoted ? rhs.slice(1, -1) : rhs.replace(/\s+#.*$/, '')
    out.set(m[1], val)
  }
  return out
}

/** RFC4180-ish CSV parser (handles quoted fields, "" escapes, embedded \n). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
      continue
    }
    if (c === '"') inQ = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') {
      /* skip */
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** "host/db" for the connection chip — never shows the password. */
function connLabel(url: string): string {
  try {
    const u = new URL(url)
    const db = u.pathname.replace(/^\//, '')
    return u.hostname + (db ? '/' + db : '')
  } catch {
    return ''
  }
}

function fmtCount(raw: string, kind: string): string {
  if (kind === 'v') return 'view'
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return '~?'
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function SqlBody({ el, active }: { el: WidgetElement; active: boolean }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const dir = el.cwd || el.path || ''

  // ---- connection (read from .env) ----
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [envState, setEnvState] = useState<EnvState>('loading')
  const [keyName, setKeyName] = useState(el.envKey ?? '')
  const [manualConn, setManualConn] = useState('') // session-only override, never persisted

  // ---- query + results ----
  const [sql, setSql] = useState(el.query ?? '')
  const [grid, setGrid] = useState<Grid | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // ---- schema sidebar ----
  const [tables, setTables] = useState<Table[] | null>(null)
  const [schemaErr, setSchemaErr] = useState<string | null>(null)
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())
  const [cols, setCols] = useState<Record<string, Column[] | 'loading'>>({})
  const [selected, setSelected] = useState<string | null>(null)

  const chosen = candidates.find((c) => c.key === keyName)
  const conn = manualConn.trim() || chosen?.value || ''

  // discover connection strings in .env / .env.local
  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!dir) {
        setEnvState('nodir')
        setCandidates([])
        return
      }
      setEnvState('loading')
      const [envText, localText] = await Promise.all([
        readFile(joinPath(dir, '.env')),
        readFile(joinPath(dir, '.env.local')),
      ])
      if (!alive) return
      if (envText == null && localText == null) {
        setCandidates([])
        setEnvState((await backendOnline()) ? 'none' : 'offline')
        return
      }
      const merged = parseEnv(envText ?? '')
      for (const [k, v] of parseEnv(localText ?? '')) merged.set(k, v) // .env.local wins
      const cands = [...merged.entries()]
        .filter(([, v]) => PG_URL.test(v))
        .map(([key, value]) => ({ key, value }))
      const rank = (k: string) => {
        const i = PRIORITY.indexOf(k)
        return i < 0 ? PRIORITY.length : i
      }
      cands.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
      setCandidates(cands)
      setEnvState(cands.length ? 'ok' : 'none')
      setKeyName((prev) => {
        if (prev && cands.some((c) => c.key === prev)) return prev
        if (el.envKey && cands.some((c) => c.key === el.envKey)) return el.envKey
        return cands[0]?.key ?? ''
      })
    })()
    return () => {
      alive = false
    }
  }, [dir, el.envKey])

  const psql = useCallback(
    (text: string) =>
      runCommand(
        'psql',
        ['-X', '--csv', '-v', 'ON_ERROR_STOP=1', '-c', text, conn],
        dir || undefined,
      ),
    [conn, dir],
  )

  const runText = useCallback(
    async (text: string) => {
      if (!conn || !text.trim()) return
      setRunning(true)
      setError(null)
      const r = await psql(text)
      setRunning(false)
      if (!r) {
        setGrid(null)
        setStatus(null)
        setError('psql unavailable — is psql installed on PATH and the backend running?')
        return
      }
      if (r.code !== 0) {
        setGrid(null)
        setStatus(null)
        setError((r.stderr || r.stdout || 'query failed').trim())
        return
      }
      const rows2d = parseCsv(r.stdout)
      if (rows2d.length === 0) {
        setGrid(null)
        setStatus('OK')
      } else if (
        rows2d.length === 1 &&
        rows2d[0].length === 1 &&
        COMMAND_TAG.test(rows2d[0][0])
      ) {
        setGrid(null)
        setStatus(rows2d[0][0])
      } else {
        const rows = rows2d.slice(1)
        setGrid({ cols: rows2d[0], rows })
        setStatus(`${rows.length} row${rows.length === 1 ? '' : 's'}`)
      }
    },
    [conn, psql],
  )

  const persistQuery = useCallback(
    (text: string) => {
      if (text === (el.query ?? '')) return
      mutateElement(el.id, (w) => {
        ;(w as WidgetElement).query = text
      })
    },
    [el.id, el.query, mutateElement],
  )

  const runQuery = useCallback(() => {
    persistQuery(sql)
    void runText(sql)
  }, [sql, persistQuery, runText])

  // ---- schema ----
  const loadSchema = useCallback(async () => {
    if (!conn) return
    setSchemaErr(null)
    const r = await psql(SCHEMA_SQL)
    if (!r) {
      setTables(null)
      setSchemaErr('backend offline')
      return
    }
    if (r.code !== 0) {
      setTables(null)
      setSchemaErr((r.stderr || 'could not read schema').trim().split('\n')[0])
      return
    }
    const body = parseCsv(r.stdout).slice(1)
    const t: Table[] = body
      .filter((c) => c.length >= 4)
      .map((c) => ({ schema: c[0], name: c[1], rows: c[2], kind: c[3] }))
    setTables(t)
    setExpandedSchemas((prev) => {
      if (prev.size) return prev
      const first = t.some((x) => x.schema === 'public') ? 'public' : t[0]?.schema
      return first ? new Set([first]) : new Set()
    })
  }, [conn, psql])

  useEffect(() => {
    void loadSchema()
  }, [loadSchema])

  useEffect(() => {
    if (active) editorRef.current?.focus()
  }, [active])

  const toggleSchema = (schema: string) =>
    setExpandedSchemas((prev) => {
      const n = new Set(prev)
      n.has(schema) ? n.delete(schema) : n.add(schema)
      return n
    })

  const toggleTable = async (schema: string, name: string) => {
    const k = `${schema}.${name}`
    setExpandedTables((prev) => {
      const n = new Set(prev)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })
    if (cols[k]) return
    setCols((c) => ({ ...c, [k]: 'loading' }))
    const r = await psql(
      `select column_name, data_type from information_schema.columns ` +
        `where table_schema = ${qLit(schema)} and table_name = ${qLit(name)} ` +
        `order by ordinal_position`,
    )
    const rows = r && r.code === 0 ? parseCsv(r.stdout).slice(1) : []
    setCols((c) => ({ ...c, [k]: rows.map((x) => ({ name: x[0], type: x[1] })) }))
  }

  const selectTable = (schema: string, name: string) => {
    const text = `select * from ${qIdent(schema)}.${qIdent(name)} limit 100;`
    setSelected(`${schema}.${name}`)
    setSql(text)
    persistQuery(text)
    void runText(text)
  }

  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      runQuery()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const { selectionStart: s, selectionEnd: en } = ta
      const next = sql.slice(0, s) + '  ' + sql.slice(en)
      setSql(next)
      requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2))
    }
  }

  const groups = useMemo(() => {
    const m = new Map<string, Table[]>()
    for (const t of tables ?? []) {
      if (!m.has(t.schema)) m.set(t.schema, [])
      m.get(t.schema)!.push(t)
    }
    return [...m.entries()]
  }, [tables])

  return (
    <div className="sql">
      <div className="sql__head">
        <span className="sql__db">
          <IconDatabase />
        </span>
        {candidates.length > 1 ? (
          <select
            className="sql__conn-select"
            value={keyName}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const k = e.target.value
              setKeyName(k)
              setManualConn('')
              mutateElement(el.id, (w) => {
                ;(w as WidgetElement).envKey = k
              })
            }}
            title="Connection string from .env"
          >
            {candidates.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key}
              </option>
            ))}
          </select>
        ) : (
          conn && <span className="sql__conn-key">{manualConn ? 'manual' : keyName}</span>
        )}
        {conn && <span className="sql__conn-host">{connLabel(conn)}</span>}
        <span className="widget__bar-spacer" style={{ flex: 1 }} />
        {status && !error && <span className="sql__status-pill">{status}</span>}
        <button
          className="sql__btn"
          title="Reload schema"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void loadSchema()}
        >
          <IconReload />
        </button>
        <button
          className="sql__run"
          disabled={!conn || running || !sql.trim()}
          title="Run (⌘/Ctrl-Enter)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={runQuery}
        >
          <IconRun />
          {running ? 'running…' : 'Run'}
        </button>
      </div>

      <div className="sql__body">
        <div className="sql__side">
          <div className="sql__side-head">
            <span>Tables</span>
            {tables && <span className="sql__count">{tables.length}</span>}
          </div>
          <div className="sql__tree">
            {schemaErr && <div className="sql__tree-hint">{schemaErr}</div>}
            {!schemaErr && !conn && <div className="sql__tree-hint">not connected</div>}
            {!schemaErr && conn && tables == null && (
              <div className="sql__tree-hint">loading…</div>
            )}
            {!schemaErr && conn && tables?.length === 0 && (
              <div className="sql__tree-hint">no tables</div>
            )}
            {groups.map(([schema, tbls]) => {
              const open = expandedSchemas.has(schema)
              return (
                <div key={schema}>
                  <div className="sql__schema" onClick={() => toggleSchema(schema)}>
                    <span className="sql__caret">{open ? '▾' : '▸'}</span>
                    <span className="sql__schema-name">{schema}</span>
                    <span className="sql__schema-count">{tbls.length}</span>
                  </div>
                  {open &&
                    tbls.map((t) => {
                      const k = `${t.schema}.${t.name}`
                      const topen = expandedTables.has(k)
                      const tcols = cols[k]
                      return (
                        <div key={k}>
                          <div className={`sql__table${selected === k ? ' sql__table--sel' : ''}`}>
                            <span
                              className="sql__caret sql__caret--tbl"
                              title="Show columns"
                              onClick={(e) => {
                                e.stopPropagation()
                                void toggleTable(t.schema, t.name)
                              }}
                            >
                              {topen ? '▾' : '▸'}
                            </span>
                            <span
                              className="sql__table-name"
                              title="Click to SELECT * (limit 100)"
                              onClick={() => selectTable(t.schema, t.name)}
                            >
                              {t.name}
                            </span>
                            <span className="sql__table-rows">{fmtCount(t.rows, t.kind)}</span>
                          </div>
                          {topen && (
                            <div className="sql__cols">
                              {tcols === 'loading' ? (
                                <div className="sql__col sql__col--hint">loading…</div>
                              ) : tcols && tcols.length > 0 ? (
                                tcols.map((c) => (
                                  <div key={c.name} className="sql__col">
                                    <span className="sql__col-name">{c.name}</span>
                                    <span className="sql__col-type">{c.type}</span>
                                  </div>
                                ))
                              ) : (
                                <div className="sql__col sql__col--hint">no columns</div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                </div>
              )
            })}
          </div>
        </div>

        <div className="sql__main">
          <textarea
            ref={editorRef}
            className="sql__editor"
            value={sql}
            spellCheck={false}
            placeholder={
              conn
                ? 'select * from … ;\n\n⌘/Ctrl-Enter to run · click a table on the left'
                : 'No database connected'
            }
            onChange={(e) => setSql(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={() => persistQuery(sql)}
            onKeyDown={onEditorKey}
          />
          <div className="sql__results">
            {!conn ? (
              <div className="sql__empty">{connectionHint(envState, dir)}</div>
            ) : error ? (
              <pre className="sql__error">{error}</pre>
            ) : grid ? (
              <ResultGrid grid={grid} />
            ) : status ? (
              <div className="sql__empty sql__empty--ok">{status}</div>
            ) : (
              <div className="sql__empty">Run a query to see results</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function connectionHint(state: EnvState, dir: string): string {
  switch (state) {
    case 'nodir':
      return 'Bind this canvas to a folder (top bar) so it can read the project .env.'
    case 'loading':
      return 'reading .env…'
    case 'offline':
      return 'Backend offline — launch the desktop app or run `npm run server` to read .env and run psql.'
    case 'none':
      return `No Postgres connection string found in .env / .env.local under ${dir}. Looked for a value starting with "postgres://" (e.g. DATABASE_URL, POSTGRES_URL, SUPABASE_DB_URL).`
    default:
      return 'not connected'
  }
}

function ResultGrid({ grid }: { grid: Grid }) {
  const shown = grid.rows.slice(0, MAX_ROWS)
  const truncated = grid.rows.length - shown.length
  return (
    <div className="sql__grid-wrap">
      <table className="sql__grid">
        <thead>
          <tr>
            <th className="sql__grid-idx" />
            {grid.cols.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              <td className="sql__grid-idx">{r + 1}</td>
              {grid.cols.map((_, c) => (
                <td key={c} title={row[c]}>
                  {row[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated > 0 && (
        <div className="sql__grid-more">… {truncated} more rows not shown</div>
      )}
    </div>
  )
}
