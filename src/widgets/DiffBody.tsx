import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { runCommand, watchPath, readFile, resolvePath } from '../lib/backend'
import { IconReload } from '../ui/icons'
import '../styles/git-panel.css'

// Git panel modelled on GitHub Desktop: a Changes/History sidebar with
// checkbox file selection + a commit composer, a diff pane, a branch dropdown,
// and a contextual Fetch/Pull/Push/Publish button. Runs `git`/`gh` in the
// folder (el.path or el.cwd) through the backend.

type FileEntry = { path: string; index: string; work: string; untracked: boolean }
type Commit = { hash: string; author: string; date: string; subject: string }

const US = '\x1f' // unit separator for git log fields

function classify(line: string): string {
  if (/^diff --git|^index |^--- |^\+\+\+ |^new file|^deleted file|^rename /.test(line))
    return 'diff__meta'
  if (/^@@/.test(line)) return 'diff__hunk'
  if (/^\+/.test(line)) return 'diff__add'
  if (/^-/.test(line)) return 'diff__del'
  return ''
}

// split a repo-relative path into its filename and leading directory, so the
// file list can show the name bright and the directory dimmed (GH Desktop style)
function splitPath(p: string): { name: string; dir: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? { name: p.slice(i + 1), dir: p.slice(0, i + 1) } : { name: p, dir: '' }
}

// The diff can be thousands of lines; isolating it behind memo() means typing in
// the commit composer (or any unrelated state change) no longer re-splits the
// text and re-reconciles every line div — the main source of the panel's lag.
const DiffView = memo(function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n'), [text])
  return (
    <pre className="diff__body">
      {lines.map((line, i) => (
        <div key={i} className={classify(line)}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
})

function parseStatus(out: string): FileEntry[] {
  const files: FileEntry[] = []
  for (const line of out.split('\n')) {
    if (line.length < 4 || line.startsWith('##')) continue
    const index = line[0]
    const work = line[1]
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    files.push({ path, index, work, untracked: index === '?' })
  }
  return files
}

function parseBranchLine(out: string): { ahead: number; behind: number; hasUpstream: boolean } {
  const line = out.split('\n').find((l) => l.startsWith('##')) ?? ''
  const a = /ahead (\d+)/.exec(line)
  const b = /behind (\d+)/.exec(line)
  return { ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, hasUpstream: line.includes('...') }
}

function fileLabel(f: FileEntry): { glyph: string; cls: string } {
  if (f.untracked) return { glyph: 'U', cls: 'ghd__badge--new' }
  const c = f.index !== ' ' ? f.index : f.work
  if (c === 'A') return { glyph: 'A', cls: 'ghd__badge--new' }
  if (c === 'D') return { glyph: 'D', cls: 'ghd__badge--del' }
  if (c === 'R') return { glyph: 'R', cls: 'ghd__badge--mod' }
  return { glyph: 'M', cls: 'ghd__badge--mod' }
}

export function DiffBody({ el }: { el: WidgetElement }) {
  const cwd = el.path || el.cwd || ''
  const dirBase = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'repo'

  const [isRepo, setIsRepo] = useState(true)
  const [branch, setBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [remotes, setRemotes] = useState<string[]>([])
  const [ahead, setAhead] = useState(0)
  const [behind, setBehind] = useState(0)
  const [hasUpstream, setHasUpstream] = useState(false)

  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<string | null>(null) // selected file path
  const [fileDiff, setFileDiff] = useState('')
  const [commits, setCommits] = useState<Commit[]>([])
  const [selCommit, setSelCommit] = useState<string | null>(null)
  const [commitDiff, setCommitDiff] = useState('')

  const [summary, setSummary] = useState('')
  const [desc, setDesc] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const [nonce, setNonce] = useState(0)

  const prevPaths = useRef<Set<string>>(new Set())

  const git = useCallback(
    (args: string[]) => runCommand('git', ['-C', cwd, ...args], cwd),
    [cwd],
  )

  const load = useCallback(async () => {
    if (!cwd) {
      setErr('no folder bound')
      return
    }
    const inside = await runCommand('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], cwd)
    if (!inside) {
      setErr('backend offline')
      return
    }
    if (inside.code !== 0) {
      setIsRepo(false)
      setErr(null)
      return
    }
    setIsRepo(true)
    setErr(null)
    const [sb, rem, cur, brs, log] = await Promise.all([
      git(['status', '--porcelain=v1', '--branch']),
      git(['remote']),
      git(['branch', '--show-current']),
      git(['branch', '--format=%(refname:short)']),
      git(['log', `--pretty=format:%H${US}%an${US}%ar${US}%s`, '-n', '80']),
    ])
    const nextFiles = parseStatus(sb?.stdout ?? '')
    setFiles(nextFiles)
    // keep checkbox state for known files, auto-check new ones (GH Desktop style)
    const curPaths = new Set(nextFiles.map((f) => f.path))
    setChecked((prev) => {
      const next = new Set<string>()
      for (const f of nextFiles) {
        if (!prevPaths.current.has(f.path) || prev.has(f.path)) next.add(f.path)
      }
      return next
    })
    prevPaths.current = curPaths
    const bl = parseBranchLine(sb?.stdout ?? '')
    setAhead(bl.ahead)
    setBehind(bl.behind)
    setHasUpstream(bl.hasUpstream)
    setBranch(cur?.stdout?.trim() ?? '')
    setRemotes((rem?.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean))
    setBranches((brs?.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean))
    const cs: Commit[] = (log?.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, subject] = l.split(US)
        return { hash, author, date, subject }
      })
    setCommits(cs)
    // keep a sensible selection
    setSel((s) => (s && curPaths.has(s) ? s : nextFiles[0]?.path ?? null))
  }, [cwd, git])

  useEffect(() => {
    void load()
  }, [load, nonce])

  // diff of the selected changed file (untracked → show the file as additions)
  useEffect(() => {
    let alive = true
    ;(async () => {
      if (tab !== 'changes' || !sel) {
        setFileDiff('')
        return
      }
      const entry = files.find((f) => f.path === sel)
      if (entry?.untracked) {
        const content = await readFile(resolvePath(cwd, sel))
        if (alive)
          setFileDiff(
            content == null
              ? '(new file)'
              : content.split('\n').map((l) => '+' + l).join('\n'),
          )
        return
      }
      const r = await git(['diff', 'HEAD', '--', sel])
      if (alive) setFileDiff(r?.stdout?.trim() || '(no textual diff)')
    })()
    return () => {
      alive = false
    }
  }, [sel, tab, files, git, cwd])

  // diff of the selected history commit
  useEffect(() => {
    let alive = true
    ;(async () => {
      if (tab !== 'history' || !selCommit) {
        setCommitDiff('')
        return
      }
      const r = await git(['show', '--stat', '--patch', selCommit])
      if (alive) setCommitDiff(r?.stdout?.trim() || '(empty)')
    })()
    return () => {
      alive = false
    }
  }, [selCommit, tab, git])

  // live refresh on filesystem changes
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!live || !cwd) return
    let dispose: (() => void) | null = null
    let cancelled = false
    let t: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(), 400)
    }
    void watchPath(cwd, debounced, 3000).then((d) => (cancelled ? d() : (dispose = d)))
    return () => {
      cancelled = true
      if (t) clearTimeout(t)
      dispose?.()
    }
  }, [live, cwd, load])

  const exec = async (program: string, args: string[], label: string) => {
    setBusy(true)
    setNote(`${label}…`)
    const r = await runCommand(program, args, cwd)
    setBusy(false)
    if (!r) setNote('backend offline')
    else if (r.code !== 0) setNote((r.stderr || r.stdout || 'failed').split('\n')[0].slice(0, 90))
    else setNote(`${label} ✓`)
    setNonce((n) => n + 1)
  }
  const run = (args: string[], label = 'git') => exec('git', ['-C', cwd, ...args], label)

  const toggleAll = (on: boolean) =>
    setChecked(on ? new Set(files.map((f) => f.path)) : new Set())

  const commit = async () => {
    if (!summary.trim() || checked.size === 0) return
    const paths = [...checked]
    setBusy(true)
    setNote('commit…')
    await runCommand('git', ['-C', cwd, 'reset', '-q'], cwd) // exact-checked semantics
    await runCommand('git', ['-C', cwd, 'add', '-A', '--', ...paths], cwd)
    const args = ['-C', cwd, 'commit', '-m', summary.trim()]
    if (desc.trim()) args.push('-m', desc.trim())
    const r = await runCommand('git', args, cwd)
    setBusy(false)
    setNote(r && r.code === 0 ? 'committed ✓' : (r?.stderr || 'commit failed').split('\n')[0].slice(0, 90))
    if (r && r.code === 0) {
      setSummary('')
      setDesc('')
    }
    setNonce((n) => n + 1)
  }

  // contextual sync action (GitHub Desktop's single button)
  const sync = (() => {
    if (remotes.length === 0)
      return {
        label: 'Publish repository',
        sub: 'create on GitHub',
        act: async () => {
          const name = window.prompt('Create a GitHub repo named:', dirBase)
          if (!name) return
          const pub = window.confirm('Make it public?  (Cancel = private)')
          await exec(
            'gh',
            ['repo', 'create', name, '--source=.', '--remote=origin', '--push', pub ? '--public' : '--private'],
            'publish',
          )
        },
      }
    if (!hasUpstream)
      return {
        label: 'Publish branch',
        sub: `push ${branch}`,
        act: () => run(['push', '-u', 'origin', branch || 'HEAD'], 'publish branch'),
      }
    if (behind > 0)
      return { label: 'Pull origin', sub: `↓${behind}`, act: () => run(['pull'], 'pull') }
    if (ahead > 0)
      return { label: 'Push origin', sub: `↑${ahead}`, act: () => run(['push'], 'push') }
    return { label: 'Fetch origin', sub: '', act: () => run(['fetch'], 'fetch') }
  })()

  const diffText = tab === 'changes' ? fileDiff : commitDiff
  const allChecked = files.length > 0 && checked.size === files.length

  // ---------- not a repo ----------
  if (!err && !isRepo) {
    return (
      <div className="ghd">
        <div className="ghd__head">
          <span className="ghd__repo">{dirBase}</span>
        </div>
        <div className="git__init">
          <div>This folder isn’t a git repository yet.</div>
          <div className="git__init-row">
            <button className="git__commit-btn" disabled={busy} onClick={() => void run(['init'], 'git init')}>
              Initialize repository
            </button>
            <button
              className="git__stageall"
              disabled={busy}
              title="git init, commit everything, create a GitHub repo and push"
              onClick={async () => {
                const name = window.prompt('Create a GitHub repo named:', dirBase)
                if (!name) return
                const pub = window.confirm('Make it public?  (Cancel = private)')
                setBusy(true)
                setNote('creating…')
                await runCommand('git', ['-C', cwd, 'init'], cwd)
                await runCommand('git', ['-C', cwd, 'add', '-A'], cwd)
                await runCommand('git', ['-C', cwd, 'commit', '-m', 'initial commit'], cwd)
                const r = await runCommand(
                  'gh',
                  ['repo', 'create', name, '--source=.', '--remote=origin', '--push', pub ? '--public' : '--private'],
                  cwd,
                )
                setBusy(false)
                setNote(r && r.code === 0 ? 'published ✓' : (r?.stderr || 'failed').split('\n')[0].slice(0, 90))
                setNonce((n) => n + 1)
              }}
            >
              Create + publish to GitHub
            </button>
          </div>
          {note && <div className="git__note">{note}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="ghd">
      {/* header: branch dropdown + contextual sync */}
      <div className="ghd__head">
        <div className="git__branchwrap">
          <button className="ghd__branch" title="Current branch — switch / create" onClick={() => setMenu((m) => !m)}>
            <span className="ghd__branch-ico">⎇</span>
            <span className="ghd__branch-name">{branch || 'HEAD'}</span>
            <span className="ghd__caret">▾</span>
          </button>
          {menu && (
            <>
              <div className="git__menu-backdrop" onPointerDown={() => setMenu(false)} />
              <div className="git__menu">
                {branches.map((b) => (
                  <button
                    key={b}
                    className={`git__menu-item${b === branch ? ' git__menu-item--on' : ''}`}
                    onClick={() => {
                      setMenu(false)
                      if (b !== branch) void run(['checkout', b], `checkout ${b}`)
                    }}
                  >
                    {b}
                  </button>
                ))}
                <button
                  className="git__menu-item git__menu-item--new"
                  onClick={() => {
                    setMenu(false)
                    const name = window.prompt('New branch name:')
                    if (name?.trim()) void run(['checkout', '-b', name.trim()], `branch ${name.trim()}`)
                  }}
                >
                  ＋ new branch…
                </button>
              </div>
            </>
          )}
        </div>
        <button className="ghd__sync" disabled={busy} title={`${sync.label} ${sync.sub}`} onClick={() => void sync.act()}>
          <span className="ghd__sync-label">{sync.label}</span>
          {sync.sub && <span className="ghd__sync-sub">{sync.sub}</span>}
        </button>
        <button className="diff__btn" title="Refresh" onClick={() => setNonce((n) => n + 1)}>
          <IconReload />
        </button>
        <button
          className={`diff__toggle${live ? ' diff__toggle--on' : ''}`}
          title="Refresh on file changes"
          onClick={() => setLive((a) => !a)}
        >
          live
        </button>
      </div>

      {note && <div className="git__note">{note}</div>}

      <div className="ghd__body">
        {/* sidebar */}
        <div className="ghd__side">
          <div className="ghd__tabs">
            <button
              className={`ghd__tab${tab === 'changes' ? ' ghd__tab--on' : ''}`}
              onClick={() => setTab('changes')}
            >
              Changes {files.length > 0 && <span className="ghd__count">{files.length}</span>}
            </button>
            <button
              className={`ghd__tab${tab === 'history' ? ' ghd__tab--on' : ''}`}
              onClick={() => setTab('history')}
            >
              History
            </button>
          </div>

          {tab === 'changes' ? (
            <>
              {files.length > 0 && (
                <label className="ghd__selectall">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                  {checked.size} of {files.length} changed
                </label>
              )}
              <div className="ghd__files">
                {files.length === 0 && <div className="git__clean">No local changes</div>}
                {files.map((f) => {
                  const lbl = fileLabel(f)
                  const { name, dir } = splitPath(f.path)
                  return (
                    <div
                      key={f.path}
                      className={`ghd__file${sel === f.path ? ' ghd__file--sel' : ''}`}
                      onClick={() => setSel(f.path)}
                      draggable
                      title={`${f.path}\n(drag onto an agent to add as @context)`}
                      onDragStart={(e) => {
                        const abs = resolvePath(cwd, f.path)
                        e.dataTransfer.setData('application/x-ccanvas-file', abs)
                        e.dataTransfer.setData('text/plain', abs)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked.has(f.path)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          setChecked((prev) => {
                            const n = new Set(prev)
                            if (e.target.checked) n.add(f.path)
                            else n.delete(f.path)
                            return n
                          })
                        }
                      />
                      <span className="ghd__fname" title={f.path}>
                        <span className="ghd__fname-name">{name}</span>
                        {dir && <span className="ghd__fname-dir">{dir}</span>}
                      </span>
                      <span className={`ghd__badge ${lbl.cls}`} title={lbl.glyph}>
                        {lbl.glyph}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="ghd__composer">
                <input
                  className="ghd__summary"
                  placeholder={`Summary (required)`}
                  value={summary}
                  spellCheck={false}
                  onChange={(e) => setSummary(e.target.value)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit()
                  }}
                />
                <textarea
                  className="ghd__desc"
                  placeholder="Description"
                  value={desc}
                  spellCheck={false}
                  onChange={(e) => setDesc(e.target.value)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <button
                  className="ghd__commit"
                  disabled={busy || !summary.trim() || checked.size === 0}
                  title={checked.size === 0 ? 'Check at least one file' : `Commit to ${branch}`}
                  onClick={() => void commit()}
                >
                  Commit {checked.size > 0 ? `${checked.size} ` : ''}to {branch || 'HEAD'}
                </button>
              </div>
            </>
          ) : (
            <div className="ghd__commits">
              {commits.length === 0 && <div className="git__clean">No commits yet</div>}
              {commits.map((c) => (
                <div
                  key={c.hash}
                  className={`ghd__commit-row${selCommit === c.hash ? ' ghd__file--sel' : ''}`}
                  onClick={() => setSelCommit(c.hash)}
                >
                  <span className="ghd__commit-subj" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="ghd__commit-meta">
                    {c.author} · {c.date} · {c.hash.slice(0, 7)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* diff pane */}
        <div className="ghd__diff">
          {diffText ? (
            <DiffView text={diffText} />
          ) : (
            <div className="ghd__diff-empty">
              {tab === 'changes' ? 'Select a file to see its changes' : 'Select a commit'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
