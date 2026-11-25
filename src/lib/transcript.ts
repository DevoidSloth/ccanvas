// Reading + parsing Claude Code session transcripts. Claude persists each
// session as append-only JSONL under
//   <home>/.claude/projects/<cwd-with-non-alnum-→-dashes>/<sessionId>.jsonl
// Every line is one event (`user` / `assistant` / tool results …). Reading it
// gives the model's real output, free of terminal chrome, plus the files it
// touched via tool calls — the basis for the transcript widget and the
// agent-tracking camera.
//
// This module is the single home for that logic; flow.ts piping and the live
// features all share it. The one exception: on the desktop app the live
// summary (context, names, last reply) is computed by src-tauri/src/transcript.rs,
// which mirrors extractContext, extractSessionTitles and extractLastAssistant —
// keep the two in step.

import { invoke } from '@tauri-apps/api/core'
import { defaultDir, readFile, joinPath, isTauri, listDir } from './backend'
import type { ModelTokens } from './cost'

// ---------- transcript location ----------

let homeDir: string | null | undefined // cached after first lookup

/** Encode a working directory the way Claude Code names its project folder. */
function encodeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Absolute path of an agent's transcript, or null if it can't be located. */
export async function transcriptPathFor(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  if (!cwd || !sessionId) return null
  if (homeDir === undefined) homeDir = await defaultDir()
  if (!homeDir) return null
  return joinPath(
    joinPath(joinPath(joinPath(homeDir, '.claude'), 'projects'), encodeProject(cwd)),
    `${sessionId}.jsonl`,
  )
}

/** Read an agent's transcript file (null when unavailable). */
export async function readTranscript(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<string | null> {
  const path = await transcriptPathFor(cwd, sessionId)
  if (!path) return null
  return readFile(path)
}

// ---------- shared event helpers ----------

type Block = { type?: string; text?: string; name?: string; input?: unknown }
type Event = { type?: string; message?: { content?: unknown } }

/** Pull a human-meaningful target out of a tool_use block (file, command, …). */
export function toolTarget(_name: string | undefined, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return (
    pick(i.file_path) ??
    pick(i.notebook_path) ??
    pick(i.path) ??
    pick(i.command) ??
    pick(i.url) ??
    pick(i.pattern) ??
    pick(i.query) ??
    undefined
  )
}

// Tools that change a file on disk vs. just read one. Used to decide which
// transcript file ops the tracking camera should surface (and how).
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Create'])
const READ_TOOLS = new Set(['Read', 'NotebookRead'])

function fileFromTool(name: string | undefined, input: unknown): string | null {
  if (!name || (!MUTATE_TOOLS.has(name) && !READ_TOOLS.has(name))) return null
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p ? p : null
}

/** Number of complete (newline-terminated) lines — never consume a partial tail. */
function completeLines(jsonl: string): string[] {
  const arr = jsonl.split('\n')
  // a trailing chunk with no newline yet may be a half-written event — drop it
  if (arr.length && jsonl.length && !jsonl.endsWith('\n')) arr.pop()
  return arr
}

// ---------- last assistant turn (flow piping) ----------

/** Walk a transcript from the end, gathering the final turn's assistant text. */
export function extractLastAssistant(jsonl: string): string | null {
  const lines = jsonl.split('\n')
  const parts: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    // a user message or tool result marks the start of this turn — stop
    if (ev.type === 'user') break
    if (ev.type !== 'assistant') continue
    const content = ev.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content))
      text = (content as Block[])
        .filter((c): c is Block & { text: string } => !!c && c.type === 'text' && !!c.text)
        .map((c) => c.text)
        .join('\n')
    if (text.trim()) parts.unshift(text.trim())
  }
  const out = parts.join('\n\n').trim()
  return out || null
}

// ---------- context window (context meter) ----------

export type ContextUsage = {
  /** tokens in the context at the most recent reply */
  used: number
  /** model id of that reply, e.g. "claude-opus-5" */
  model?: string
  /** largest context seen in this session (hints at a 1M window) */
  peak: number
}

type UsageEvent = {
  type?: string
  isSidechain?: boolean
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens?: number
    }
  }
}

/** How full the main conversation's context is, from its last assistant reply.
 *  Subagent (sidechain) turns have their own context and are skipped. */
export function extractContext(jsonl: string): ContextUsage | null {
  let last: ContextUsage | null = null
  let peak = 0
  for (const ln of completeLines(jsonl)) {
    if (!ln.includes('"usage"')) continue
    let ev: UsageEvent
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    const u = ev.message?.usage
    if (ev.type !== 'assistant' || ev.isSidechain || !u) continue
    if (ev.message?.model === '<synthetic>') continue
    const used =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.output_tokens ?? 0)
    if (!used) continue
    peak = Math.max(peak, used)
    last = { used, model: ev.message?.model, peak }
  }
  return last ? { ...last, peak } : null
}

// ---------- files touched (tracking camera) ----------

export type ToolFile = {
  /** the path as it appeared in the tool call (often absolute) */
  path: string
  /** the tool name (Edit, Write, Read, …) */
  tool: string
  /** true for tools that write to disk, false for reads */
  mutate: boolean
}

/**
 * File operations recorded in the transcript after `fromLine`. Returns the new
 * ops in order plus a cursor (line count consumed) so a watcher only processes
 * events it hasn't seen. Partial trailing lines are never consumed.
 */
export function extractToolFiles(
  jsonl: string,
  fromLine = 0,
): { files: ToolFile[]; cursor: number } {
  const lines = completeLines(jsonl)
  const out: ToolFile[] = []
  for (let idx = Math.max(0, fromLine); idx < lines.length; idx++) {
    const ln = lines[idx].trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    if (ev.type !== 'assistant') continue
    const content = ev.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content as Block[]) {
      if (!c || c.type !== 'tool_use') continue
      const p = fileFromTool(c.name, c.input)
      if (p) out.push({ path: p, tool: c.name ?? '', mutate: MUTATE_TOOLS.has(c.name ?? '') })
    }
  }
  return { files: out, cursor: lines.length }
}

// ---------- full conversation (transcript widget) ----------

// The widget shows a conversation the way the desktop app does: your prompts,
// Claude's prose, and between them an "activity" block of tool calls (each
// paired with its result) and thinking. Transcripts reach ~100 MB, so nothing
// here keeps a tool's full input or output: just what a row shows, truncated.

export type ToolState = 'running' | 'done' | 'error' | 'stopped'
export type PlanItem = { text: string; status: string }
export type DiffPreview = {
  /** first lines of the change, each prefixed with '+' or '-' */
  lines: string[]
  add: number
  del: number
}
export type ToolCall = {
  kind: 'tool'
  id: string
  /** raw tool name, e.g. "Bash" or "mcp__ccd_turn__update_plan" */
  name: string
  /** short display name ("update_plan" for an MCP tool) */
  label: string
  /** one line: the file, command, pattern, description … */
  target?: string
  state: ToolState
  ts?: string
  /** Bash: the command (truncated) */
  command?: string
  /** Edit / Write / MultiEdit: a few lines of the change */
  diff?: DiffPreview
  /** TodoWrite / update_plan: the checklist after this call */
  plan?: PlanItem[]
  /** Agent / Task: the start of the subagent's brief */
  prompt?: string
  /** Agent / Task: the subagent's id, once its result names it */
  agentId?: string
  /** the result, truncated (a tail for Bash and subagents, else a head) */
  output?: string
  /** lines in the full result */
  outputLines?: number
  /** images in the result (screenshots) */
  images?: number
}
export type ThinkingStep = { kind: 'thinking'; text: string; ts?: string }
export type ActivityStep = ToolCall | ThinkingStep

export type TranscriptItem =
  /** something you typed (images attached to it are counted) */
  | { kind: 'user'; text: string; images: number; ts?: string }
  /** Claude's prose */
  | { kind: 'text'; text: string; ts?: string }
  /** consecutive tool calls and thinking between two pieces of prose */
  | { kind: 'activity'; steps: ActivityStep[]; ts?: string }
  /** harness traffic shown as a muted one-liner: a task notification, a
   *  message from another session, a compaction, an interrupt, a slash
   *  command's output, an API error */
  | { kind: 'event'; text: string; tone?: 'warn' | 'error'; ts?: string }

type UserEvent = Event & {
  isMeta?: boolean
  isCompactSummary?: boolean
  origin?: unknown
  timestamp?: string
  isApiErrorMessage?: boolean
}
type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

const tagBody = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text)
  return m ? m[1].trim() : null
}
const tagAttr = (text: string, tag: string, attr: string): string | null => {
  const m = new RegExp(`<${tag}\\s[^>]*\\b${attr}="([^"]*)"`).exec(text)
  return m ? m[1] : null
}
const oneLine = (s: string, max = 160): string => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s)

/** Claude Code wraps what you type (and what it injects) in harness markup.
 *  Turn one user event's text into what to show: your prompt with the markup
 *  removed, a muted event line, or nothing. */
function readUserText(raw: string, ev: UserEvent): TranscriptItem | null {
  const event = (text: string, tone?: 'warn' | 'error'): TranscriptItem => ({
    kind: 'event',
    text: oneLine(text),
    tone,
  })
  const prompt = (text: string): TranscriptItem => ({ kind: 'user', text, images: 0 })
  if (ev.isCompactSummary) return event('conversation compacted — earlier turns summarized')
  // context the harness adds to your turn: never something you typed
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!text) return null

  if (text.includes('<cross-session-message')) {
    const from = tagAttr(text, 'cross-session-message', 'from-name') ?? 'another session'
    return event(`message from ${from}: ${tagBody(text, 'cross-session-message') ?? ''}`)
  }
  if (text.startsWith('<task-notification')) {
    const summary = tagBody(text, 'summary') ?? tagBody(text, 'status') ?? 'background task update'
    return event(`task · ${summary}`)
  }
  if (text.startsWith('<side-sessions-event')) return event('side sessions updated')
  // skill instructions, command caveats and other injected context
  if (ev.isMeta || text.startsWith('<local-command-caveat')) return null

  const cmd = tagBody(text, 'command-name')
  if (cmd) {
    const args = tagBody(text, 'command-args')
    return prompt('`' + [cmd, args].filter(Boolean).join(' ') + '`')
  }
  const stdout = tagBody(text, 'local-command-stdout')
  if (stdout != null) return stdout ? event(stdout) : null
  const bash = tagBody(text, 'bash-input')
  if (bash != null) return prompt('```\n! ' + bash + '\n```')
  const bashOut = tagBody(text, 'bash-stdout') ?? tagBody(text, 'bash-stderr')
  if (bashOut != null) return bashOut ? event(bashOut) : null
  if (/^\[Request interrupted/.test(text)) return event('interrupted', 'warn')
  if (/^\[(Usage limit|Earlier usage)/.test(text)) return event(text.replace(/^\[|\]$/g, ''), 'warn')
  // the harness's note when Claude reads an image file, not a prompt
  if (/^\[Image: original \d+x\d+/.test(text)) return null

  // pasted blocks: keep a short quoted preview instead of the whole paste
  text = text.replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_m, body: string) => {
    const lines = body.trim().split('\n')
    const head = lines
      .slice(0, 4)
      .map((l) => '> ' + l)
      .join('\n')
    const more = lines.length > 4 ? `\n> … ${lines.length - 4} more lines` : ''
    return `\n\n*pasted:*\n${head}${more}\n\n`
  })
  text = text.trim()
  return text ? prompt(text) : null
}

// ----- tool calls -----

const CMD_MAX = 1200
const OUT_TAIL_LINES = 14
const OUT_HEAD_LINES = 8
const OUT_MAX = 1600
const DIFF_LINES = 14
const PROMPT_MAX = 500
const PLAN_MAX = 40
const THINK_MAX = 4000
const TARGET_MAX = 240

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** "mcp__claude-in-chrome__navigate" → "navigate" */
function toolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  return parts[parts.length - 1] || name
}

function readPlan(raw: unknown): PlanItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PlanItem[] = []
  for (const it of raw.slice(0, PLAN_MAX)) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const text = str(o.content) ?? str(o.subject) ?? str(o.text) ?? str(o.title)
    if (text) out.push({ text: oneLine(text, 140), status: str(o.status) ?? 'pending' })
  }
  return out
}

/** Apply an update_plan step ({advance}, {done, start}) to the last full plan. */
function stepPlan(prev: PlanItem[] | null, i: Record<string, unknown>): PlanItem[] | undefined {
  if (!prev) return undefined
  const next = prev.map((p) => ({ ...p }))
  if (i.advance === true) {
    const cur = next.findIndex((p) => p.status === 'in_progress')
    if (cur >= 0) next[cur].status = 'completed'
    const nxt = next.findIndex((p, k) => k > cur && p.status === 'pending')
    if (nxt >= 0) next[nxt].status = 'in_progress'
  }
  if (Array.isArray(i.done))
    for (const n of i.done) if (typeof n === 'number' && next[n - 1]) next[n - 1].status = 'completed'
  if (typeof i.start === 'number' && next[i.start - 1]) {
    for (const p of next) if (p.status === 'in_progress') p.status = 'pending'
    next[i.start - 1].status = 'in_progress'
  }
  return next
}

function diffOf(pairs: { old: string; neu: string }[]): DiffPreview {
  const lines: string[] = []
  let add = 0
  let del = 0
  for (const { old, neu } of pairs) {
    const o = old ? old.split('\n') : []
    const n = neu ? neu.split('\n') : []
    // drop the lines both sides share at the edges, so the preview shows the change
    let a = 0
    while (a < o.length && a < n.length && o[a] === n[a]) a++
    let b = 0
    while (b < o.length - a && b < n.length - a && o[o.length - 1 - b] === n[n.length - 1 - b]) b++
    const oc = o.slice(a, o.length - b)
    const nc = n.slice(a, n.length - b)
    del += oc.length
    add += nc.length
    for (const l of oc) if (lines.length < DIFF_LINES) lines.push('-' + clip(l, 200))
    for (const l of nc) if (lines.length < DIFF_LINES) lines.push('+' + clip(l, 200))
  }
  return { lines, add, del }
}

function makeTool(
  id: string,
  name: string,
  input: unknown,
  ts: string | undefined,
  lastPlan: PlanItem[] | null,
): ToolCall {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const t: ToolCall = { kind: 'tool', id, name, label: toolLabel(name), state: 'running', ts }
  const file = str(i.file_path) ?? str(i.notebook_path)
  switch (name) {
    case 'Bash': {
      const cmd = str(i.command) ?? ''
      t.command = clip(cmd, CMD_MAX)
      t.target = str(i.description) ?? cmd
      break
    }
    case 'Edit':
      t.target = file
      t.diff = diffOf([{ old: str(i.old_string) ?? '', neu: str(i.new_string) ?? '' }])
      break
    case 'MultiEdit':
      t.target = file
      if (Array.isArray(i.edits))
        t.diff = diffOf(
          i.edits.map((e: Record<string, unknown>) => ({
            old: str(e?.old_string) ?? '',
            neu: str(e?.new_string) ?? '',
          })),
        )
      break
    case 'Write':
    case 'Create':
      t.target = file
      t.diff = diffOf([{ old: '', neu: str(i.content) ?? '' }])
      break
    case 'Grep':
    case 'Glob': {
      const where = str(i.path) ?? str(i.glob)
      t.target = [str(i.pattern), where && `in ${where}`].filter(Boolean).join(' ')
      break
    }
    case 'Task':
    case 'Agent':
      t.target = str(i.description) ?? str(i.subagent_type)
      t.prompt = clip(str(i.prompt) ?? '', PROMPT_MAX)
      break
    case 'TodoWrite':
      t.plan = readPlan(i.todos)
      break
    case 'mcp__ccd_turn__update_plan':
      t.plan = Array.isArray(i.items) ? readPlan(i.items) : stepPlan(lastPlan, i)
      break
    case 'mcp__ccd_turn__wrap_up':
      t.target = str(i.recap)
      break
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? (i.questions[0] as Record<string, unknown>) : null
      t.target = str(q?.question)
      break
    }
    case 'SendUserFile':
      t.target = Array.isArray(i.files) ? i.files.filter((f) => typeof f === 'string').join(', ') : undefined
      break
    default:
      t.target =
        toolTarget(name, i) ??
        str(i.description) ??
        str(i.prompt) ??
        str(i.recap) ??
        Object.values(i).find((v): v is string => typeof v === 'string' && !!v.trim())
  }
  if (t.target) t.target = oneLine(t.target, TARGET_MAX)
  return t
}

/** Fill a tool call in from its tool_result block (keeping only a preview). */
function applyResult(t: ToolCall, r: ToolResultBlock, denied: boolean): ToolCall {
  let text = ''
  let images = 0
  if (typeof r.content === 'string') text = r.content
  else if (Array.isArray(r.content))
    for (const c of r.content as Block[]) {
      if (c?.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
      else if (c?.type === 'image') images++
    }
  const next: ToolCall = { ...t, state: r.is_error || denied ? 'error' : 'done' }
  if (images) next.images = images
  const agent = /\bagentId: ([A-Za-z0-9_-]+)/.exec(text)
  if (agent) next.agentId = agent[1]
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // a subagent's report ends with its id and token usage: not part of the report
    .replace(/\n*agentId: [\s\S]*$/, '')
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/\s+$/, '')
  if (!text) return next
  const lines = text.split('\n')
  next.outputLines = lines.length
  const failed = next.state === 'error'
  // a file's contents, or "file updated", add nothing a reader of the chat needs
  if (!failed && (READ_TOOLS.has(t.name) || MUTATE_TOOLS.has(t.name))) return next
  // Bash and subagents put the useful part (exit status, the report) last
  const tail = t.name === 'Bash' || t.name === 'Task' || t.name === 'Agent'
  const keep = tail ? lines.slice(-OUT_TAIL_LINES) : lines.slice(0, failed ? OUT_TAIL_LINES : OUT_HEAD_LINES)
  let out = keep.join('\n')
  if (out.length > OUT_MAX) out = tail ? '…' + out.slice(-OUT_MAX) : out.slice(0, OUT_MAX) + '…'
  next.output = out
  return next
}

/**
 * Incremental transcript parser. Feed it complete JSONL lines as they're
 * appended (`push`); it keeps `items` up to date. A tool result lands in a
 * later event than its call (often a later chunk), so the parser remembers
 * where each open call sits and swaps in a new object for that item: React
 * readers memoised on item identity re-render only what changed.
 */
export class TranscriptParser {
  items: TranscriptItem[] = []
  /** open tool calls by id → [item index, step index] */
  private open = new Map<string, [number, number]>()
  private lastPlan: PlanItem[] | null = null
  /** items created during the current push: safe to mutate in place */
  private fresh = new WeakSet<object>()

  /** Parse appended lines. Returns true when `items` changed. */
  push(jsonl: string): boolean {
    let changed = false
    for (const raw of jsonl.split('\n')) {
      const ln = raw.trim()
      if (!ln) continue
      let ev: UserEvent
      try {
        ev = JSON.parse(ln)
      } catch {
        continue
      }
      if (ev.type === 'assistant') changed = this.assistant(ev) || changed
      else if (ev.type === 'user') changed = this.user(ev) || changed
    }
    this.fresh = new WeakSet()
    return changed
  }

  private add(item: TranscriptItem) {
    this.fresh.add(item)
    this.items.push(item)
  }

  /** The last item if it's of `kind`, made safe to mutate. */
  private tailOf<K extends TranscriptItem['kind']>(kind: K): Extract<TranscriptItem, { kind: K }> | null {
    const at = this.items.length - 1
    const last = this.items[at]
    if (!last || last.kind !== kind) return null
    if (!this.fresh.has(last)) {
      const copy = { ...last } as TranscriptItem
      if (copy.kind === 'activity') copy.steps = copy.steps.slice()
      this.fresh.add(copy)
      this.items[at] = copy
      return copy as Extract<TranscriptItem, { kind: K }>
    }
    return last as Extract<TranscriptItem, { kind: K }>
  }

  private addStep(step: ActivityStep, ts?: string): number {
    let act = this.tailOf('activity')
    if (!act) {
      act = { kind: 'activity', steps: [], ts }
      this.add(act)
    }
    act.steps.push(step)
    return act.steps.length - 1
  }

  /** Replace an open tool call (in place when its item is fresh). */
  private updateTool(id: string, f: (t: ToolCall) => ToolCall): boolean {
    const at = this.open.get(id)
    if (!at) return false
    this.open.delete(id)
    const [ii, si] = at
    let item = this.items[ii]
    if (item?.kind !== 'activity' || item.steps[si]?.kind !== 'tool') return false
    if (!this.fresh.has(item)) {
      item = { ...item, steps: item.steps.slice() }
      this.fresh.add(item)
      this.items[ii] = item
    }
    item.steps[si] = f(item.steps[si] as ToolCall)
    return true
  }

  /** A new prompt or an interrupt: calls still open will never finish. */
  private closeOpen() {
    for (const id of [...this.open.keys()])
      this.updateTool(id, (t) => (t.state === 'running' ? { ...t, state: 'stopped' } : t))
  }

  private assistant(ev: UserEvent): boolean {
    const content = ev.message?.content
    const ts = ev.timestamp
    // harness-made replies (API errors, usage limits) aren't the model talking
    const synthetic = (ev.message as { model?: string } | undefined)?.model === '<synthetic>'
    let changed = false
    const blocks: Block[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    for (const c of blocks) {
      if (!c) continue
      if (c.type === 'text' && c.text?.trim()) {
        if (synthetic) {
          this.add({ kind: 'event', text: oneLine(c.text), tone: 'error', ts })
        } else {
          const last = this.tailOf('text')
          if (last) last.text += '\n\n' + c.text.trim()
          else this.add({ kind: 'text', text: c.text.trim(), ts })
        }
        changed = true
      } else if (c.type === 'tool_use') {
        const id = (c as { id?: string }).id ?? ''
        const tool = makeTool(id, c.name ?? 'tool', c.input, ts, this.lastPlan)
        if (tool.plan?.length) this.lastPlan = tool.plan
        const si = this.addStep(tool, ts)
        if (id) this.open.set(id, [this.items.length - 1, si])
        changed = true
      } else if (c.type === 'thinking') {
        // most thinking is redacted to an empty block with a signature: skip it
        const text = (c as { thinking?: string }).thinking?.trim()
        if (text) {
          this.addStep({ kind: 'thinking', text: clip(text, THINK_MAX), ts }, ts)
          changed = true
        }
      }
    }
    return changed
  }

  private user(ev: UserEvent): boolean {
    const content = ev.message?.content
    let changed = false
    let text = ''
    let images = 0
    if (typeof content === 'string') text = content
    else if (Array.isArray(content))
      for (const c of content as Block[]) {
        if (!c) continue
        if (c.type === 'tool_result') {
          const r = c as unknown as ToolResultBlock
          const denied = !!(ev as { toolDenialKind?: unknown }).toolDenialKind
          if (r.tool_use_id && this.updateTool(r.tool_use_id, (t) => applyResult(t, r, denied)))
            changed = true
        } else if (c.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
        else if (c.type === 'image') images++
      }
    const item = text.trim()
      ? readUserText(text, ev)
      : images && !ev.isMeta
        ? ({ kind: 'user', text: '', images: 0 } as TranscriptItem)
        : null
    if (!item) return changed
    if (item.kind === 'user') {
      item.images = images
      this.closeOpen()
    } else if (item.kind === 'event' && item.text === 'interrupted') this.closeOpen()
    item.ts = ev.timestamp
    this.add(item)
    return true
  }
}

/** Parse a whole transcript into readable items. */
export function parseTranscript(jsonl: string): TranscriptItem[] {
  const p = new TranscriptParser()
  p.push(jsonl)
  return p.items
}

export type TranscriptChunk = {
  /** complete lines read since the offset */
  text: string
  /** offset to pass next time */
  next: number
  /** the file was rewritten: drop what was parsed before */
  reset: boolean
  /** earlier lines were skipped to honour `tail` */
  truncated: boolean
}

/** What was appended to a transcript since `offset` (null when unreadable). On
 *  the desktop app only the new bytes are read; the web bridge has no such
 *  command, so the browser build re-reads the whole file and reports a reset.
 *  `tail` caps a first read of a huge file to roughly its last `tail` bytes. */
export async function readTranscriptChunk(
  path: string,
  offset: number,
  tail?: number,
): Promise<TranscriptChunk | null> {
  if (isTauri()) {
    try {
      return await invoke<TranscriptChunk | null>('transcript_chunk', { path, offset, tail })
    } catch {
      return null
    }
  }
  const text = await readFile(path)
  if (text == null) return null
  return { text, next: text.length, reset: true, truncated: false }
}

function lastStringField(jsonl: string, type: string, field: string): string | null {
  const at = jsonl.lastIndexOf(`"type":"${type}"`)
  if (at < 0) return null
  const start = jsonl.lastIndexOf('\n', at) + 1
  const end = jsonl.indexOf('\n', at)
  try {
    const ev = JSON.parse(jsonl.slice(start, end < 0 ? undefined : end)) as Record<string, unknown>
    const v = ev[field]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** The session's names. `custom` is the newest `/rename` (a `custom-title`
 *  record); `ai` is the name Claude generates itself after the first prompt
 *  (an `ai-title` record). */
export function extractSessionTitles(jsonl: string): { custom: string | null; ai: string | null } {
  return {
    custom: lastStringField(jsonl, 'custom-title', 'customTitle'),
    ai: lastStringField(jsonl, 'ai-title', 'aiTitle'),
  }
}

// ---------- live summary (context meter, names, last reply) ----------

export type TranscriptSummary = {
  /** how much of the transcript has been read; changes when new events land */
  version: number
  context: ContextUsage | null
  /** newest `/rename` (custom-title) */
  customTitle: string | null
  /** the name Claude generated for the session (ai-title) */
  aiTitle: string | null
  /** text of the latest turn's assistant replies */
  lastReply: string | null
  /** when the transcript file was last written (epoch ms). Desktop only. */
  modified?: number | null
  /** the tool call still waiting for its result, if any. Desktop only. */
  pending?: TranscriptPending | null
  /** tokens per model, each reply counted once. Desktop only. */
  tokens?: ModelTokens[]
  /** how many files Edit / Write calls changed (list: readTranscriptFiles). Desktop only. */
  fileCount?: number
}

export type FileChange = { path: string; edits: number; tool: string }

/** Files a session changed, most recently changed first (desktop only). */
export async function readTranscriptFiles(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<FileChange[] | null> {
  const path = await transcriptPathFor(cwd, sessionId)
  if (!path || !isTauri()) return null
  try {
    return await invoke<FileChange[] | null>('transcript_files', { path })
  } catch {
    return null
  }
}

// ---------- subagent logs ----------
// A subagent (Task / Agent call) logs to its own file beside the session's:
//   <session>.jsonl  →  <session>/subagents/agent-<agentId>.jsonl
// with an agent-<agentId>.meta.json naming the tool call that started it.

/** The log of the subagent a Task / Agent call started, or null. */
export async function subagentLogPath(
  transcriptPath: string,
  toolUseId: string,
  agentId?: string,
): Promise<string | null> {
  const dir = transcriptPath.replace(/\.jsonl$/, '') + '/subagents'
  if (agentId && /^[A-Za-z0-9_-]+$/.test(agentId)) return `${dir}/agent-${agentId}.jsonl`
  // still running: no result names it yet, so match the call id in the metadata
  const entries = await listDir(dir)
  if (!entries) return null
  for (const e of entries) {
    if (!e.name.endsWith('.meta.json')) continue
    const raw = await readFile(e.path)
    if (!raw) continue
    try {
      if ((JSON.parse(raw) as { toolUseId?: string }).toolUseId === toolUseId)
        return e.path.replace(/\.meta\.json$/, '.jsonl')
    } catch {
      /* unreadable metadata: skip it */
    }
  }
  return null
}

// ---------- Markdown export ----------

const STEP_GLYPH: Record<ToolState, string> = { running: '…', done: '✓', error: '✕', stopped: '–' }

/** A conversation as Markdown: prompts, replies, and each tool call as a
 *  one-line bullet. */
export function transcriptMarkdown(items: TranscriptItem[], who = 'Claude'): string {
  const out: string[] = []
  let speaker = ''
  const say = (name: string) => {
    if (speaker !== name) out.push(`**${name}:**`)
    speaker = name
  }
  for (const m of items) {
    if (m.kind === 'user') {
      say('You')
      out.push(m.text + (m.images ? `\n\n_(${m.images} image${m.images > 1 ? 's' : ''})_` : ''))
    } else if (m.kind === 'text') {
      say(who)
      out.push(m.text)
    } else if (m.kind === 'event') {
      out.push(`_${m.text}_`)
      speaker = ''
    } else {
      say(who)
      const lines = m.steps
        .filter((s): s is ToolCall => s.kind === 'tool')
        .map((t) => `- ${STEP_GLYPH[t.state]} ${t.label}${t.target ? ': ' + t.target.replace(/\n/g, ' ') : ''}`)
      if (lines.length) out.push(lines.join('\n'))
    }
  }
  return out.join('\n\n') + '\n'
}

export type TranscriptPending = {
  /** tool name, e.g. `AskUserQuestion`, `Bash` */
  tool: string
  /** for AskUserQuestion / ExitPlanMode: what the user is being asked */
  question: string | null
  /** for AskUserQuestion: the first question's option labels */
  options: string[]
  /** how many tool calls are open */
  count: number
}

/** Summarize an agent's transcript (null when unavailable). The desktop
 *  backend keeps its place in each file and parses only what was appended
 *  since the last call; the web bridge has no such command, so the browser
 *  build reads and parses the whole file. */
export async function readTranscriptSummary(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<TranscriptSummary | null> {
  const path = await transcriptPathFor(cwd, sessionId)
  if (!path) return null
  if (isTauri()) {
    try {
      return await invoke<TranscriptSummary | null>('transcript_summary', { path })
    } catch {
      return null
    }
  }
  const jsonl = await readFile(path)
  if (jsonl == null) return null
  const { custom, ai } = extractSessionTitles(jsonl)
  return {
    version: jsonl.length,
    context: extractContext(jsonl),
    customTitle: custom,
    aiTitle: ai,
    lastReply: extractLastAssistant(jsonl),
  }
}

// Every agent widget keeps its title in sync and shows a context meter, and the
// roster shows each agent's last reply. They all subscribe here, so each
// transcript is polled once however many readers it has.

const SUMMARY_POLL_MS = 3000

type SummaryWatch = {
  subs: Set<(s: TranscriptSummary | null) => void>
  last: TranscriptSummary | null
  timer: ReturnType<typeof setInterval>
}
const summaryWatches = new Map<string, SummaryWatch>()

/** Call `cb` with the transcript's summary as soon as it's known and again on
 *  every poll. The object is reused while nothing new was written, so readers
 *  can compare by identity. Returns an unsubscribe function. */
export function watchTranscriptSummary(
  cwd: string | undefined,
  sessionId: string | undefined,
  cb: (s: TranscriptSummary | null) => void,
): () => void {
  if (!cwd || !sessionId) return () => {}
  const key = `${cwd}\n${sessionId}`
  let w = summaryWatches.get(key)
  if (w) {
    if (w.last) cb(w.last)
  } else {
    let busy = false
    const poll = async () => {
      if (busy) return
      busy = true
      const next = await readTranscriptSummary(cwd, sessionId).finally(() => (busy = false))
      const cur = summaryWatches.get(key)
      if (!cur || cur.timer !== timer) return // stopped while reading
      if (!next || !cur.last || next.version !== cur.last.version) cur.last = next
      for (const f of cur.subs) f(cur.last)
    }
    const timer = setInterval(poll, SUMMARY_POLL_MS)
    w = { subs: new Set(), last: null, timer }
    summaryWatches.set(key, w)
    void poll()
  }
  const watch = w
  watch.subs.add(cb)
  return () => {
    watch.subs.delete(cb)
    if (watch.subs.size) return
    clearInterval(watch.timer)
    summaryWatches.delete(key)
  }
}
