import type { CcnvsFile, Template, Workspace } from './types'
import { DEFAULT_CAMERA } from './types'
import { newId } from './id'

const SESSION_KEY = 'ccanvas:session:v1'
const TEMPLATES_KEY = 'ccanvas:templates:v1'

// File System Access API handles are not serializable; keep them in memory
// keyed by workspace id so "Save" can write back to the same file.
const handles = new Map<string, FileSystemFileHandle>()

export const hasFsAccess = () =>
  typeof (window as any).showOpenFilePicker === 'function'

export function toFile(ws: Workspace): CcnvsFile {
  return {
    format: 'ccnvs',
    version: 1,
    name: ws.name,
    camera: ws.camera,
    elements: ws.elements,
  }
}

export function fromFile(data: CcnvsFile, name: string): Workspace {
  return {
    id: newId(),
    name: data.name || name,
    elements: Array.isArray(data.elements) ? data.elements : [],
    camera: data.camera ?? { ...DEFAULT_CAMERA },
    createdAt: Date.now(),
    dirty: false,
  }
}

function serialize(ws: Workspace): string {
  return JSON.stringify(toFile(ws), null, 2)
}

// ---------- open ----------

export async function openWorkspace(): Promise<Workspace | null> {
  if (hasFsAccess()) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          { description: 'ccanvas workspace', accept: { 'application/json': ['.ccnvs'] } },
        ],
      })
      const file = await handle.getFile()
      const text = await file.text()
      const ws = fromFile(JSON.parse(text), file.name.replace(/\.ccnvs$/, ''))
      handles.set(ws.id, handle)
      return ws
    } catch (e) {
      // user cancelled
      return null
    }
  }
  // fallback: <input type=file>
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.ccnvs,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const text = await file.text()
      try {
        resolve(fromFile(JSON.parse(text), file.name.replace(/\.ccnvs$/, '')))
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}

// ---------- save ----------

export async function saveWorkspace(
  ws: Workspace,
  forceDialog = false,
): Promise<boolean> {
  const text = serialize(ws)

  if (hasFsAccess()) {
    try {
      let handle = handles.get(ws.id)
      if (!handle || forceDialog) {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: `${ws.name}.ccnvs`,
          types: [
            {
              description: 'ccanvas workspace',
              accept: { 'application/json': ['.ccnvs'] },
            },
          ],
        })
        if (handle) handles.set(ws.id, handle)
      }
      if (!handle) return false
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      return true
    } catch {
      return false
    }
  }

  // fallback: trigger a download
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${ws.name}.ccnvs`
  a.click()
  URL.revokeObjectURL(url)
  return true
}

// ---------- session autosave (localStorage) ----------

type SessionShape = {
  tabs: Workspace[]
  activeTabId: string | null
}

export function saveSession(s: SessionShape) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s))
  } catch {
    /* quota / private mode: ignore */
  }
}

export function loadSession(): SessionShape | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SessionShape
    if (!parsed.tabs?.length) return null
    return parsed
  } catch {
    return null
  }
}

// ---------- widget-layout templates (localStorage) ----------

export function loadTemplates(): Template[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Template[]) : []
  } catch {
    return []
  }
}

export function saveTemplates(templates: Template[]) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates))
  } catch {
    /* quota / private mode: ignore */
  }
}
