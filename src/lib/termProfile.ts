// The user's own terminal look (font, cursor, palette), read from the machine by
// the desktop backend — currently the default iTerm2 profile on macOS. Anything
// it can't supply falls back to ccanvas's built-in theme below.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ITheme } from '@xterm/xterm'
import { isTauri } from './backend'

export interface TermProfile {
  source: string
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorBlink?: boolean
  boldIsBright?: boolean
  theme: Partial<ITheme>
}

export const DEFAULT_FONT_FAMILY = "'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace"
export const DEFAULT_FONT_SIZE = 12.5

export const DEFAULT_THEME: ITheme = {
  background: '#1f1e1d',
  foreground: '#faf9f5',
  cursor: '#d97757',
  cursorAccent: '#1f1e1d',
  selectionBackground: 'rgba(217, 119, 87, 0.25)',
  black: '#2e2d2a',
  red: '#e56b6f',
  green: '#5ab977',
  yellow: '#deb566',
  blue: '#58b4c9',
  magenta: '#b99ad6',
  cyan: '#6cc3d1',
  white: '#c8c6c0',
  brightBlack: '#8f8c83',
  brightRed: '#f08488',
  brightGreen: '#a6d189',
  brightYellow: '#e5c07b',
  brightBlue: '#82c7bb',
  brightMagenta: '#d9b3e3',
  brightCyan: '#98d4cd',
  brightWhite: '#faf9f5',
}

/** The user's font first, the built-in stack behind it for missing glyphs/fonts. */
export function terminalFontFamily(p: TermProfile | null | undefined): string {
  return p?.fontFamily ? `'${p.fontFamily.replace(/'/g, '')}', ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY
}

export function fontBase(p: TermProfile | null | undefined): number {
  return p?.fontSize && p.fontSize > 0 ? p.fontSize : DEFAULT_FONT_SIZE
}

// read once per app session; don't hold terminals hostage to a slow backend
let pending: Promise<TermProfile | null> | null = null
let resolved: TermProfile | null | undefined

export function loadTerminalProfile(): Promise<TermProfile | null> {
  if (!pending) {
    const read = isTauri()
      ? invoke<TermProfile | null>('terminal_profile').catch(() => null)
      : Promise.resolve(null)
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500))
    pending = Promise.race([read, timeout]).then((p) => (resolved = p ?? null))
  }
  return pending
}

/** `undefined` while loading, `null` when there's nothing to use (built-in theme). */
export function useTerminalProfile(): TermProfile | null | undefined {
  const [profile, setProfile] = useState(resolved)
  useEffect(() => {
    if (resolved !== undefined) return
    let live = true
    loadTerminalProfile().then((p) => live && setProfile(p))
    return () => {
      live = false
    }
  }, [])
  return profile
}
