// Maps a file path to the widget that should open it, and finds openable file
// paths inside a line of text (terminal output). Shared by the file-tree widget
// and the terminal's clickable-filename link provider so routing stays in one
// place.

import type { WidgetKind } from './types'
import { DATA_EXTENSIONS } from './dataformats'

/** Raster/vector image formats the figure (plot) widget renders. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']
/** Everything the figure widget claims for routing/file dialogs (images + pdf). */
export const PLOT_EXTENSIONS = [...IMAGE_EXTENSIONS, 'pdf']
/**
 * Video containers the video widget will try to play. The webview natively
 * decodes a subset (mp4/h264, webm, ogg); the rest are attempted and, if the
 * codec isn't supported, the widget offers to open them in the system player.
 * ('ts' is deliberately excluded — it collides with TypeScript source files.)
 */
export const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'm4p', 'webm', 'ogv', 'ogg', 'mov', 'qt', 'mkv',
  'avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'vob',
  'mts', 'm2ts', '3gp', '3g2', 'divx',
]

/**
 * Source/text/config extensions that open in the plain-text editor. The editor
 * can open *anything*, so this list isn't about capability — it's the set of
 * bare tokens in terminal output we're willing to treat as clickable filenames
 * (keeps prose like "node.js" or "v1.2.3" from lighting up everything).
 */
export const EDITOR_EXTENSIONS = [
  // web / js / ts
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // backend / systems
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'swift', 'scala', 'clj', 'ex', 'exs', 'erl', 'lua', 'r', 'jl', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // config / docs / data-as-text
  'md', 'mdx', 'txt', 'log', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'sql', 'graphql', 'gql', 'proto', 'lock', 'gitignore', 'dockerfile',
]

const extOf = (p: string): string => p.toLowerCase().split('.').pop() ?? ''

/** Route a file path to the widget kind that should open it (data/plot/editor). */
export function widgetKindForFile(path: string): WidgetKind {
  const ext = extOf(path)
  if (DATA_EXTENSIONS.includes(ext)) return 'data'
  if (PLOT_EXTENSIONS.includes(ext)) return 'plot'
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
  return 'editor'
}

const OPENABLE = new Set<string>([
  ...DATA_EXTENSIONS,
  ...PLOT_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...EDITOR_EXTENSIONS,
])

/** Does this path end in an extension one of the widgets recognises? */
export function isOpenableFile(path: string): boolean {
  return OPENABLE.has(extOf(path))
}

/** A file path located within a line of text. */
export type PathMatch = {
  /** the path itself, with any `:line:col` suffix stripped */
  path: string
  /** line number from a `file:line` / `file:line:col` suffix, if present */
  line?: number
  /** 0-based index of the path within the source line */
  index: number
  /** character length of the path within the source line */
  length: number
}

// A path-ish run: optional Windows drive ("C:\" / "C:/"), then path/word chars
// and separators, ending in a ".ext". An optional ":line(:col)" suffix follows.
const FILE_RE =
  /(?:[A-Za-z]:[\\/])?[\w.+\-@~/\\]*\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?/g

// Is `before` (the text preceding a match) the authority part of a URL? Used to
// avoid hijacking http(s) links that happen to end in an openable extension.
const URL_PREFIX = /\b[a-z][a-z0-9+.-]*:\/\/\S*$/i

/**
 * Find every openable file path in a single line of (already ANSI-stripped)
 * text. A trailing `:line` / `:line:col` marker (grep/compiler/Claude output)
 * is parsed into `line` and excluded from `index`/`length`, so only the path
 * itself is highlighted.
 */
export function findFilePaths(line: string): PathMatch[] {
  const out: PathMatch[] = []
  if (!line) return out
  FILE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_RE.exec(line)) && out.length < 64) {
    const whole = m[0]
    if (URL_PREFIX.test(line.slice(0, m.index))) continue

    // split a trailing :line(:col) off the path, but never a "C:" drive colon
    let path = whole
    let lineNo: number | undefined
    const suffix = whole.match(/^(.+?)(?::(\d+)(?::\d+)?)$/)
    if (suffix && suffix[1].length > 2) {
      path = suffix[1]
      lineNo = Number(suffix[2])
    }

    if (!isOpenableFile(path)) continue
    out.push({ path, line: lineNo, index: m.index, length: path.length })
  }
  return out
}
