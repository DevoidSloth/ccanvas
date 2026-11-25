/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' builds the desktop app without update checks (see CONTRIBUTING.md) */
  readonly VITE_NO_UPDATE_CHECK?: string
  /** '1' keeps the layers overview's perf tools (P, ⇧P) in a production build */
  readonly VITE_PERF_TOOLS?: string
}
