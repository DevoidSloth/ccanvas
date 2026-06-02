// Git-backed working-tree checkpoints — a safety net for "save a point before
// letting an agent loose, restore it if the agent makes a mess."
//
// A checkpoint is a real git object created with `git stash create`, which
// snapshots tracked changes WITHOUT touching the working tree or the stash list.
// We pin it under refs/ccanvas/cp/<id> so git's gc never collects it, and keep a
// little metadata (label, time, branch) in localStorage keyed by the folder.
//
// Limitation worth knowing: `stash create` captures tracked files only, so a
// restore won't bring back files that were untracked when the checkpoint was
// made (it also won't delete files the agent created afterwards — restore is
// deliberately non-destructive, it only resets tracked content).

import { runCommand } from './backend'

export type Checkpoint = {
  id: string
  label: string
  /** the git commit object that holds the snapshot */
  sha: string
  /** branch HEAD was on when the checkpoint was taken */
  branch: string
  /** ms since epoch */
  ts: number
}

const KEY = 'ccanvas:checkpoints:v1'

type Store = Record<string, Checkpoint[]>

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Store) : {}
  } catch {
    return {}
  }
}

function writeStore(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* quota / private mode: ignore */
  }
}

export function listCheckpoints(dir: string): Checkpoint[] {
  return (readStore()[dir] ?? []).slice().sort((a, b) => b.ts - a.ts)
}

function setCheckpoints(dir: string, list: Checkpoint[]) {
  const s = readStore()
  s[dir] = list
  writeStore(s)
}

const git = (dir: string, args: string[]) => runCommand('git', ['-C', dir, ...args], dir)

/** True when `dir` is inside a git work tree. */
async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  return !!r && r.code === 0 && /true/.test(r.stdout)
}

export type CreateResult =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; error: string }

/**
 * Snapshot the current working tree. `ts` is supplied by the caller (the store
 * is the source of "now" — this module has no clock) so results stay pure.
 */
export async function createCheckpoint(
  dir: string,
  label: string,
  id: string,
  ts: number,
): Promise<CreateResult> {
  if (!dir) return { ok: false, error: 'this canvas has no folder bound' }
  if (!(await isRepo(dir))) return { ok: false, error: 'folder is not a git repository' }

  const branchR = await git(dir, ['branch', '--show-current'])
  const branch = branchR?.stdout.trim() || 'HEAD'

  // `stash create` returns a commit sha for the tracked changes, or empty when
  // the tree is clean — in which case the checkpoint is just the current HEAD.
  const stash = await git(dir, ['stash', 'create', label])
  let sha = stash?.stdout.trim() ?? ''
  if (!sha) {
    const head = await git(dir, ['rev-parse', 'HEAD'])
    sha = head?.stdout.trim() ?? ''
    if (!sha) return { ok: false, error: 'no commits yet — make an initial commit first' }
  }

  // pin the object so gc keeps it
  const ref = await git(dir, ['update-ref', `refs/ccanvas/cp/${id}`, sha])
  if (!ref || ref.code !== 0)
    return { ok: false, error: (ref?.stderr || 'could not pin checkpoint').slice(0, 200) }

  const checkpoint: Checkpoint = { id, label, sha, branch, ts }
  setCheckpoints(dir, [checkpoint, ...listCheckpoints(dir)])
  return { ok: true, checkpoint }
}

/**
 * Restore tracked files to a checkpoint's state via `git checkout <sha> -- .`.
 * Non-destructive: it resets tracked content but never deletes files created
 * after the checkpoint.
 */
export async function restoreCheckpoint(
  dir: string,
  cp: Checkpoint,
): Promise<{ ok: boolean; error?: string }> {
  const r = await git(dir, ['checkout', cp.sha, '--', '.'])
  if (!r) return { ok: false, error: 'backend offline' }
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).slice(0, 200) }
  return { ok: true }
}

/** A `--stat` summary of what changed since a checkpoint (cheap overview). */
export async function diffStatSince(dir: string, cp: Checkpoint): Promise<string> {
  const r = await git(dir, ['diff', '--stat', cp.sha])
  if (!r) return 'backend offline'
  return r.stdout.trim() || 'no changes since this checkpoint'
}

export async function deleteCheckpoint(dir: string, cp: Checkpoint) {
  await git(dir, ['update-ref', '-d', `refs/ccanvas/cp/${cp.id}`])
  setCheckpoints(
    dir,
    listCheckpoints(dir).filter((c) => c.id !== cp.id),
  )
}
