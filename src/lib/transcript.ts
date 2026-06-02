// Reading + parsing Claude Code session transcripts. Claude persists each
// session as append-only JSONL under
//   <home>/.claude/projects/<cwd-with-non-alnum-→-dashes>/<sessionId>.jsonl
// Every line is one event (`user` / `assistant` / tool results …). Reading it
// gives the model's real output, free of terminal chrome, plus the files it
// touched via tool calls — the basis for the transcript widget and the
// agent-tracking camera.
//
// This module is the single home for that logic; flow.ts piping and the live
// features all share it.

import { defaultDir, readFile, joinPath } from './backend'

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

export type TranscriptTool = { name: string; target?: string }
export type TranscriptTurn = {
  role: 'user' | 'assistant'
  text: string
  tools: TranscriptTool[]
}

/** Parse a transcript into an ordered list of readable user/assistant turns. */
export function parseTranscript(jsonl: string): TranscriptTurn[] {
  const out: TranscriptTurn[] = []
  for (const raw of jsonl.split('\n')) {
    const ln = raw.trim()
    if (!ln) continue
    let ev: Event
    try {
      ev = JSON.parse(ln)
    } catch {
      continue
    }
    const content = ev.message?.content
    if (ev.type === 'assistant') {
      let text = ''
      const tools: TranscriptTool[] = []
      if (typeof content === 'string') text = content
      else if (Array.isArray(content))
        for (const c of content as Block[]) {
          if (!c) continue
          if (c.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
          else if (c.type === 'tool_use')
            tools.push({ name: c.name ?? 'tool', target: toolTarget(c.name, c.input) })
        }
      if (text.trim() || tools.length) out.push({ role: 'assistant', text: text.trim(), tools })
    } else if (ev.type === 'user') {
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content))
        text = (content as Block[])
          .filter((c): c is Block & { text: string } => !!c && c.type === 'text' && !!c.text)
          .map((c) => c.text)
          .join('\n')
      // pure tool-result turns carry no user text — skip them
      if (text.trim()) out.push({ role: 'user', text: text.trim(), tools: [] })
    }
  }
  return out
}
