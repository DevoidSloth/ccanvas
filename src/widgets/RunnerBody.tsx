import { useCallback, useEffect, useRef, useState } from 'react'
import type { WidgetElement } from '../lib/types'
import { useStore } from '../store/workspace'
import { runCommand } from '../lib/backend'
import { IconReload } from '../ui/icons'

// Task/test runner. Runs el.cmd (default `npm test`) in the folder, shows the
// captured output with a pass/fail badge, and re-runs on demand. Best for
// finite commands (test/build/lint) — for long-running watchers use a terminal.

export function RunnerBody({ el }: { el: WidgetElement }) {
  const mutateElement = useStore((s) => s.mutateElement)
  const cwd = el.cwd || el.path || ''
  const cmd = el.cmd || 'npm test'
  const [out, setOut] = useState('')
  const [code, setCode] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [cmdInput, setCmdInput] = useState(cmd)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => setCmdInput(cmd), [cmd])

  const run = useCallback(async () => {
    const parts = cmd.trim().split(/\s+/)
    if (!parts[0]) return
    setRunning(true)
    setCode(null)
    setOut('')
    const r = await runCommand(parts[0], parts.slice(1), cwd)
    setRunning(false)
    if (!r) {
      setOut('backend offline — run `npm run server` or use the desktop app')
      setCode(-1)
      return
    }
    setOut(((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).trim() || '(no output)')
    setCode(r.code)
  }, [cmd, cwd])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [out])

  const commitCmd = () => {
    const v = cmdInput.trim()
    if (v && v !== cmd) mutateElement(el.id, (w) => ((w as WidgetElement).cmd = v))
  }

  const badge =
    running
      ? { cls: 'runner__badge--run', label: 'running…' }
      : code == null
        ? null
        : code === 0
          ? { cls: 'runner__badge--ok', label: 'pass' }
          : { cls: 'runner__badge--fail', label: `exit ${code}` }

  return (
    <div className="runner">
      <div className="runner__bar">
        <input
          className="runner__cmd"
          value={cmdInput}
          spellCheck={false}
          placeholder="npm test"
          onChange={(e) => setCmdInput(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={commitCmd}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              commitCmd()
              void run()
            }
          }}
        />
        {badge && <span className={`runner__badge ${badge.cls}`}>{badge.label}</span>}
        <button
          className="diff__btn"
          title="Run"
          disabled={running}
          onClick={() => {
            commitCmd()
            void run()
          }}
        >
          <IconReload />
        </button>
      </div>
      <div ref={scrollRef} className="runner__scroll">
        <pre className="runner__out">{out || 'press run ▸'}</pre>
      </div>
    </div>
  )
}
