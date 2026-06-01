# ccanvas

An infinite canvas workspace for coding with multiple agents — *Excalidraw, but for
driving Claude Code.* Spawn terminals, agents, and live web previews onto a boundless
dark surface, then sketch the architecture around them with text, arrows, and ink.

Every tab is a self-contained `.ccnvs` workspace you can save, reopen, and share.

## Desktop app (recommended) — Tauri

```
npm install
npm run app        # dev: launches the native window
npm run app:build  # produce an installer in src-tauri/target/release/bundle
```

The desktop build is the real thing: native folder/file dialogs, native file IO,
and an **in-process PTY** per terminal — a real shell with no separate server and
no WebSocket hop. Requires the Rust toolchain (`rustup`) and, on Windows, the
WebView2 runtime (preinstalled on Windows 11).

## Web app

```
npm run dev        # → http://127.0.0.1:5173
```

In the browser the canvas can't reach the filesystem on its own, so real
terminals + folders come from an optional local backend (run it in a second
terminal, or `npm start` to run both):

```
npm run server     # ws + http on 127.0.0.1:7531
```

It gives the browser what the sandbox can't: a real shell per terminal widget
(via `node-pty`, prebuilt binaries ship for Windows/macOS) and a native folder
picker + file IO. Each **canvas is bound to a folder** — creating a new canvas
asks where to put its `.ccnvs`, and that folder becomes the working directory
every terminal/agent opens in. A **Claude agent** widget is just a real
terminal in the canvas folder with `claude` already run.

Terminal widgets auto-connect and fall back to a small in-browser shell when the
backend isn't running; the footer pill shows `pty` (live) or `local` (fallback).
Without the backend you can still bind a folder by typing a path.

---

## What's in here

| Surface            | Notes                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| Infinite canvas    | Pan (`H` / middle-mouse / two-finger scroll), smooth zoom (⌘/Ctrl-scroll), dot grid |
| Quick insert       | `Space` drops text at the cursor — `/` then `agent` `term` `files` `diff` `editor` `doc` `log` `web` `note` to spawn a widget |
| Command palette    | `⌘/Ctrl-K` — spawn widgets, arrange, switch tabs, export, jump to a widget |
| Vector ink         | Text, freehand draw, arrows (snap to widget **anchor points**, drag the midpoint to **curve**, drag an endpoint to reconnect), rectangles, ellipses, frames, images, 6-color palette |
| Widgets            | Terminal · Claude agent · File tree · Git panel · Editor · Live doc · Log tail · Task runner · Web preview (URL **or** local `.html`, live-reloading) · Markdown note |
| GitHub (gh) widgets | Pull requests · Issues · Actions/CI runs — list, open in browser, create, live status (needs the `gh` CLI) |
| Agent orchestration| Per-agent activity dot (idle/working/waiting), idle notifications, broadcast-to-many, per-agent model/prompt/flags, **logic arrows** that chain agents (run the next one when this one finishes / succeeds / fails / matches), right-click **Label box** to wrap an agent in a titled frame |
| Arrange            | Group, lock, align, distribute, tidy, copy/paste/duplicate, z-order, snapping guides, transform handles, minimap |
| Right-click menus  | Custom context menus (not the native webview one): canvas elements (duplicate, lock, z-order, delete), file-tree rows (open, **reveal in Explorer/Finder**, copy path), empty canvas (paste, select all) |
| Tabs               | Multiple `.ccnvs` workspaces open at once, each bound to a folder      |
| Persistence        | Save/Open into the canvas folder (backend) or File System Access API; reusable widget-layout templates; PNG/SVG export |

## Agent flows (logic arrows)

An arrow drawn **from one agent to another** can carry orchestration logic, so a
diagram of agents becomes a runnable pipeline. Select the connector and hit
**+ add logic** in the selection bar:

- **run when** — `on finish` (any completed turn) · `on success` · `on failure`
  (keyword match on the source agent's last output) · `on match` (your regex).
  For a reliable signal, tell the agent to end with a sentinel and match it,
  e.g. `on match` + `STATUS:\s*OK`.
- **prompt** — the text handed to the target agent (and submitted) when the edge
  fires. Multi-line prompts are pasted intact.
- **join** — when a target has several incoming edges: `all` waits for every
  source to finish (AND — *"after these agents run, run this one"*), `any` fires
  on the first (OR).

So `A —on success→ B —on finish→ C` runs B only if A reports success, then C
after B; and `A, B —all→ C` runs C once both A and B are done. Flow edges render
in the accent colour with a filled head and a condition badge. The whole thing
has a kill switch — **Pause agent flows** in the command palette (⌘K) — and it
auto-pauses if edges fire in a runaway loop.

## Keyboard

| Key                | Action                          |
| ------------------ | ------------------------------- |
| `V` `H` `T` `P` `A` `R` `O` `F` `E` | select · pan · text · draw · arrow · rect · ellipse · frame · eraser |
| `Space`            | quick-insert text or `/command` widget at the cursor |
| ⌘/Ctrl + `K`       | command palette                 |
| `H` / middle-drag  | pan                             |
| ⌘/Ctrl + scroll    | zoom to cursor                  |
| ⌘/Ctrl + `S` / `O` / `N` | save · open · new canvas  |
| ⌘/Ctrl + `Z` / `Shift Z` | undo · redo               |
| ⌘/Ctrl + `C` / `X` / `V` / `D` | copy · cut · paste · duplicate |
| ⌘/Ctrl + `G` / `Shift G` | group · ungroup           |
| ⌘/Ctrl + `L`       | lock / unlock selection         |
| ⌘/Ctrl + `[` / `]` | send to back / bring to front   |
| ⌘/Ctrl + `A`       | select all                      |
| ⌘/Ctrl + `0` `+` `-` | reset / zoom in / zoom out     |
| `Delete`           | delete selection                |
| `Esc`              | back to select                  |
| double-click       | edit text · interact with widget · rename widget/tab |

## Stack

Vite · React · TypeScript · Zustand · xterm.js · **Tauri 2** (Rust). The same
frontend runs as a native desktop app or in the browser; native capabilities are
behind a small abstraction that picks the best available backend.

## Architecture notes

- **`src/store/workspace.ts`** — single Zustand store; the active workspace is the
  source of truth and what serializes to `.ccnvs`.
- **`src/canvas/`** — pointer/zoom state machine, SVG vector layer, inline text.
- **`src/widgets/`** — `WidgetFrame` chrome (drag/resize/z-order) + per-type bodies.
- **`src/lib/backend.ts`** — native dialog/file IO: Tauri commands → HTTP bridge →
  graceful no-op, chosen by `isTauri()`.
- **`src/lib/terminal.ts`** — terminal transport: in-process Tauri PTY → WebSocket
  bridge → in-browser fallback shell.
- **`src-tauri/`** — the Rust app: `src/pty.rs` (a `portable-pty` shell per widget,
  streaming `pty:data`/`pty:exit` events) and `src/files.rs` (native dialogs + fs).
- **`server/pty-server.mjs`** — the optional web-mode backend (same protocol, over
  `ws`/`http`) for when you run in a plain browser.
