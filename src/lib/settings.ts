import { create } from 'zustand'

// App preferences (keybindings + colour palette), kept in localStorage so they
// survive restarts. Everything here is per-machine, not part of a canvas file.

const KEY = 'ccanvas.settings'

/** One key press: the physical key plus the modifiers held with it. */
export interface KeyCombo {
  code: string
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}
/** A binding: one press, or a two-press chord like ⌃X ⌃F. */
export type KeySeq = KeyCombo[]

export type PaletteId = 'claude' | 'ember' | 'moss' | 'slate' | 'plum' | 'mono'

export const PALETTES: { id: PaletteId; name: string; bg: string; panel: string; ink: string; accent: string }[] = [
  { id: 'claude', name: 'Claude', bg: '#1f1e1d', panel: '#262624', ink: '#faf9f5', accent: '#d97757' },
  { id: 'ember', name: 'Ember', bg: '#1d1a19', panel: '#272220', ink: '#fbf3ec', accent: '#e8845c' },
  { id: 'moss', name: 'Moss', bg: '#1a1d1a', panel: '#212621', ink: '#f2f5ee', accent: '#8fbf7f' },
  { id: 'slate', name: 'Slate', bg: '#191c20', panel: '#20242a', ink: '#eef2f7', accent: '#7aa7d9' },
  { id: 'plum', name: 'Plum', bg: '#1d1a1f', panel: '#262129', ink: '#f6f0f8', accent: '#b98ad8' },
  { id: 'mono', name: 'Mono', bg: '#1c1c1c', panel: '#242424', ink: '#f4f4f4', accent: '#c9c9c9' },
]

export interface Settings {
  /** ⌃X ⌃F opens the tab finder */
  emacsKeys: boolean
  /** `:` opens the tab finder (as `:b`), `gt` / `gT` step through tabs — outside terminals */
  vimKeys: boolean
  /** extra user-recorded shortcuts that open the tab finder */
  customFinderKeys: KeySeq[]
  palette: PaletteId
}

const DEFAULTS: Settings = {
  emacsKeys: true,
  vimKeys: false,
  customFinderKeys: [],
  palette: 'claude',
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* storage unavailable or corrupt */
  }
  return DEFAULTS
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch)
    const { update: _, ...rest } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify(rest))
    } catch {
      /* storage unavailable */
    }
  },
}))

// ----- palette -----

export function applyPalette(id: PaletteId) {
  if (id === 'claude') delete document.documentElement.dataset.palette
  else document.documentElement.dataset.palette = id
}
applyPalette(useSettings.getState().palette)
useSettings.subscribe((s, prev) => {
  if (s.palette !== prev.palette) applyPalette(s.palette)
})

// ----- key combos -----

/** Set while Settings is recording a shortcut, so live bindings stand down. */
export const keyRecorder = { active: false }

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Fn'])
export const isModifierKey = (e: KeyboardEvent) => MODIFIER_KEYS.has(e.key)

export function comboFrom(e: KeyboardEvent): KeyCombo {
  return {
    code: e.code,
    key: e.key,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
  }
}

/** A combo with ⌃/⌘/⌥ is safe to catch everywhere; a bare key only outside text fields. */
export const hasModifier = (c: KeyCombo) => c.ctrl || c.meta || c.alt

export function matches(c: KeyCombo, e: KeyboardEvent): boolean {
  if (hasModifier(c))
    return (
      e.code === c.code &&
      e.ctrlKey === c.ctrl &&
      e.metaKey === c.meta &&
      e.altKey === c.alt &&
      e.shiftKey === c.shift
    )
  // bare keys compare the produced character, so `:` and `T` match however typed
  return !e.ctrlKey && !e.metaKey && !e.altKey && e.key === c.key
}

function keyName(c: KeyCombo, emacs: boolean): string {
  if (c.code.startsWith('Key')) {
    const k = c.code.slice(3)
    return emacs ? k.toLowerCase() : k
  }
  if (c.code.startsWith('Digit')) return c.code.slice(5)
  const named: Record<string, string> = {
    Space: 'Space',
    Enter: '↩',
    Tab: '⇥',
    Backspace: '⌫',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  }
  return named[c.code] ?? (c.key.length === 1 ? c.key : c.code)
}

/** ⌃⇧X-style label for the settings list. */
export function formatCombo(c: KeyCombo): string {
  if (!hasModifier(c)) return c.key === ' ' ? 'Space' : c.key
  return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${keyName(c, false)}`
}
export const formatSeq = (s: KeySeq) => s.map(formatCombo).join(' ')

/** Emacs-style echo for a pending chord prefix: C-x, M-x, s-x, or a bare key. */
export function echoCombo(c: KeyCombo): string {
  if (!hasModifier(c)) return c.key
  const k = keyName(c, true)
  return `${c.ctrl ? 'C-' : ''}${c.alt ? 'M-' : ''}${c.meta ? 's-' : ''}${c.shift ? 'S-' : ''}${k}`
}

// ----- bindings -----

export type KeyAction = 'finder' | 'nextTab' | 'prevTab'

export interface Binding {
  seq: KeySeq
  action: KeyAction
  /** the finder's prompt when this binding opens it */
  prompt?: string
}

const bare = (key: string, code: string, shift = false): KeyCombo => ({
  code,
  key,
  ctrl: false,
  meta: false,
  alt: false,
  shift,
})
const ctrl = (code: string): KeyCombo => ({
  code,
  key: code.slice(3).toLowerCase(),
  ctrl: true,
  meta: false,
  alt: false,
  shift: false,
})

export const EMACS_BINDINGS: Binding[] = [
  { seq: [ctrl('KeyX'), ctrl('KeyF')], action: 'finder', prompt: 'Find tab:' },
]
export const VIM_BINDINGS: Binding[] = [
  { seq: [bare(':', 'Semicolon', true)], action: 'finder', prompt: ':b' },
  { seq: [bare('g', 'KeyG'), bare('t', 'KeyT')], action: 'nextTab' },
  { seq: [bare('g', 'KeyG'), bare('T', 'KeyT', true)], action: 'prevTab' },
]

export function activeBindings(s: Settings): Binding[] {
  return [
    ...(s.emacsKeys ? EMACS_BINDINGS : []),
    ...(s.vimKeys ? VIM_BINDINGS : []),
    ...s.customFinderKeys.map((seq): Binding => ({ seq, action: 'finder', prompt: 'Find tab:' })),
  ]
}
