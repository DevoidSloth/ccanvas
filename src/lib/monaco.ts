// Monaco (VS Code's editor engine) — the heavy bits live here so the whole
// module can be pulled in lazily via a single dynamic import() from EditorBody.
// Nothing in the app's initial bundle references this file, so Monaco's weight
// only lands the first time a code-editor widget is actually opened.
//
// Workers are wired through Vite's `?worker` imports (emitted as their own
// chunks, fetched on demand), so IntelliSense for TS/JS/JSON/CSS/HTML works
// offline in the Tauri shell with no CDN and no CSP changes.

import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Set up exactly once even if this module is imported from several widgets.
let configured = false

function configure() {
  if (configured) return
  configured = true

  self.MonacoEnvironment = {
    getWorker(_id, label) {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    },
  }

  // A single file opened off disk has no tsconfig and no node_modules, so TS's
  // *semantic* pass would flood the gutter with bogus "cannot find module"
  // errors. Keep syntax validation (always correct) and rich completions/hover
  // (the language service still runs), but suppress the noisy semantic squiggles.
  // monaco-editor ≥0.52 moved the language-service defaults off the deprecated
  // `monaco.languages.typescript` stub to top-level `monaco.typescript` / `.json`.
  const ts = monaco.typescript
  for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    d.setEagerModelSync(true)
    d.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.React,
      allowJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
    })
  }

  // JSON / CSS / HTML are self-contained, so their full validation is genuinely
  // useful — leave it on.
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemas: [],
  })

  monaco.editor.defineTheme('ccanvas', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e8e6e1' },
      { token: 'comment', foreground: '61605b', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c89bd6' },
      { token: 'string', foreground: '8bbf73' },
      { token: 'number', foreground: 'd8a657' },
      { token: 'regexp', foreground: '6db5a8' },
      { token: 'type', foreground: '7fc7c0' },
      { token: 'type.identifier', foreground: '7fc7c0' },
      { token: 'constant', foreground: 'd8a657' },
      { token: 'function', foreground: '6db5a8' },
      { token: 'variable', foreground: 'e8e6e1' },
      { token: 'variable.predefined', foreground: 'e8975a' },
      { token: 'tag', foreground: 'e8795a' },
      { token: 'attribute.name', foreground: 'd8a657' },
      { token: 'attribute.value', foreground: '8bbf73' },
      { token: 'delimiter', foreground: '9a9892' },
      { token: 'key', foreground: '7fc7c0' },
    ],
    colors: {
      'editor.background': '#0a0b0d',
      'editor.foreground': '#e8e6e1',
      'editorLineNumber.foreground': '#3a3a38',
      'editorLineNumber.activeForeground': '#9a9892',
      'editorCursor.foreground': '#e8795a',
      'editor.selectionBackground': '#e8795a33',
      'editor.inactiveSelectionBackground': '#e8795a1f',
      'editor.selectionHighlightBackground': '#6db5a826',
      'editor.lineHighlightBackground': '#15171d66',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': '#1d2027',
      'editorIndentGuide.activeBackground1': '#2c3038',
      'editorWhitespace.foreground': '#23262e',
      'editorGutter.background': '#0a0b0d',
      'editorBracketMatch.background': '#6db5a81f',
      'editorBracketMatch.border': '#6db5a866',
      'editorWidget.background': '#121419',
      'editorWidget.border': '#23262e',
      'editorSuggestWidget.background': '#121419',
      'editorSuggestWidget.border': '#23262e',
      'editorSuggestWidget.selectedBackground': '#1c1f27',
      'editorSuggestWidget.highlightForeground': '#e8795a',
      'editorHoverWidget.background': '#121419',
      'editorHoverWidget.border': '#23262e',
      'editorError.foreground': '#e8795a',
      'editorWarning.foreground': '#d8a657',
      'input.background': '#0a0b0d',
      'input.border': '#23262e',
      'focusBorder': '#e8795a66',
      'list.hoverBackground': '#1c1f27',
      'list.focusBackground': '#1c1f27',
      'scrollbarSlider.background': '#2c303877',
      'scrollbarSlider.hoverBackground': '#2c3038aa',
      'scrollbarSlider.activeBackground': '#3a3f48',
      'minimap.background': '#0a0b0d',
    },
  })
}

/** Extension/filename → Monaco language id, built from Monaco's own registry. */
let extIndex: Map<string, string> | null = null
let fileIndex: Map<string, string> | null = null

function buildIndex() {
  extIndex = new Map()
  fileIndex = new Map()
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) {
      extIndex.set(ext.toLowerCase(), lang.id)
    }
    for (const fn of lang.filenames ?? []) {
      fileIndex.set(fn.toLowerCase(), lang.id)
    }
  }
}

/** Best-effort language id for a path (e.g. "src/App.tsx" → "typescript"). */
export function detectLanguage(path: string): string {
  if (!extIndex || !fileIndex) buildIndex()
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const byName = fileIndex!.get(base)
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  if (dot > 0) {
    const ext = base.slice(dot) // includes leading "."
    const byExt = extIndex!.get(ext)
    if (byExt) return byExt
  }
  return 'plaintext'
}

/**
 * Load (and one-time configure) Monaco. Returns a small facade so callers can
 * stay on type-only static imports — importing `detectLanguage` as a value
 * would statically pull this whole module (and Monaco) into the main bundle and
 * defeat the lazy split.
 */
export async function loadMonaco(): Promise<{ monaco: typeof monaco; detectLanguage: typeof detectLanguage }> {
  configure()
  return { monaco, detectLanguage }
}
