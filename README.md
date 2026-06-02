<div align="center">

# ccanvas

**An infinite canvas for driving Claude Code.**
*Excalidraw, but the boxes are real terminals, agents, and live previews.*

Spawn shells, Claude agents, editors, and web previews onto a boundless dark
surface, then wire them together with arrows that actually run. Every tab is a
self-contained `.ccnvs` workspace you can save, reopen, and share.

</div>

![ccanvas: multiple agents, a live editor, a file tree, and notes on one infinite canvas](docs/screenshot.png)

---

## Why

A terminal multiplexer gives you panes; ccanvas gives you *space*. Lay out a
fleet of agents the way you'd sketch them on a whiteboard, watch each one's
status at a glance, and connect them with **logic arrows** so a diagram of
agents becomes a runnable pipeline: *"when this one succeeds, hand its output to
that one."* When the canvas gets crowded, the **agent roster**, **canvas
search**, and a **tracking camera** that orbits an agent's files keep you
oriented.

## Quick start

### Desktop app (recommended): Tauri

```bash
npm install
npm run app        # dev: launches the native window
npm run app:build  # build an installer → src-tauri/target/release/bundle
```

The desktop build is the real thing: native folder/file dialogs, native file
IO, and an **in-process PTY** per terminal, a real shell with no separate server
and no WebSocket hop. Requires the Rust toolchain (`rustup`) and, on Windows,
the WebView2 runtime (preinstalled on Windows 11).

### Web app

```bash
npm run dev        # → http://127.0.0.1:5173
```

In the browser the canvas can't reach the filesystem on its own, so real
terminals + folders come from an optional local backend (run it in a second
terminal, or `npm start` to run both at once):

```bash
npm run server     # ws + http on 127.0.0.1:7531
npm start          # runs the pty server and the web app together
```

The backend gives the browser what the sandbox can't: a real shell per terminal
widget (via `node-pty`; prebuilt binaries ship for Windows/macOS) and a native
folder picker + file IO. Each **canvas is bound to a folder**: creating a new
canvas asks where to put its `.ccnvs`, and that folder becomes the working
directory every terminal/agent opens in. A **Claude agent** widget is just a
real terminal in the canvas folder with `claude` already running.

Terminal widgets auto-connect and fall back to a small in-browser shell when the
backend isn't running; the footer pill shows `pty` (live) or `local`
(fallback). Without the backend you can still bind a folder by typing a path.

---

## What's in here

| Surface | Notes |
| --- | --- |
| **Infinite canvas** | Pan (`H` / middle-mouse / two-finger scroll), smooth zoom (⌘/Ctrl-scroll), dot grid, minimap |
| **Quick insert** | `Space` drops text at the cursor; press `/` then a widget name (`agent` `term` `files` `diff` `editor` `doc` `log` `runner` `data` `plot` `pr` `issues` `actions` `web` `note`) to spawn one |
| **Command palette** | ⌘/Ctrl-K to spawn widgets, arrange, switch tabs, open panels, insert prompts, export, or jump to a widget |
| **Vector ink** | Text, freehand draw, arrows (snap to widget **anchor points**, drag the midpoint to **curve**, drag an endpoint to reconnect), rectangles, ellipses, frames, images, 6-color palette |
| **Widgets** | Terminal · Claude agent · Transcript · File tree · Git diff · Editor (Monaco) · Live doc · Log tail · Task runner · Data viewer (CSV/Parquet) · Figure viewer · SQL · Web preview (URL **or** local `.html`, live-reloading) · Markdown note |
| **GitHub (`gh`) widgets** | Pull requests · Issues · Actions/CI runs: list, open in browser, create, live status (needs the `gh` CLI) |
| **Agent orchestration** | Per-agent activity dot (idle/working/waiting), idle notifications, broadcast-to-many, per-agent model/prompt/flags, **logic arrows** that chain agents, right-click **Label box** to wrap an agent in a titled frame |
| **Agent roster** | Mission-control list of every agent across all tabs: status, cost/turns, last line, click-to-focus, and a composer to message one or broadcast to all |
| **Tracking camera** | Follow an agent and watch every file it touches spawn as a viewer in an **orbit** around it, arrows pointing back; the camera stays framed on the action |
| **Transcript widget** | An agent's *real* conversation rendered from its session JSONL: clean text + tool chips, free of terminal box-drawing chrome, following the session live |
| **Checkpoints** | Git-backed working-tree snapshots: save a point before letting an agent loose, restore tracked files if it makes a mess |
| **Prompt library** | Reusable prompt snippets you can insert into the focused agent, drag onto any agent, or manage; persisted like layout templates |
| **Canvas search** | ⌘/Ctrl-F to fuzzy-search every element's text (titles, notes, paths, URLs, prompts, queries, frame names) and jump to it |
| **Follow active agent** | A headless camera mode that pans to whichever agent most recently started working |
| **Arrange** | Group, lock, align, distribute, tidy, copy/paste/duplicate, z-order, snapping guides, transform handles, minimap |
| **Right-click menus** | Custom context menus: canvas elements (duplicate, lock, z-order, delete), agents (track, transcript, label box), file-tree rows (open, **reveal in Explorer/Finder**, copy path), empty canvas (paste, select all) |
| **Tabs** | Multiple `.ccnvs` workspaces open at once, each bound to its own folder |
| **Persistence** | Save/Open into the canvas folder (backend) or File System Access API; reusable widget-layout templates; PNG/SVG export |

## Agent flows (logic arrows)

An arrow drawn **from one agent to another** can carry orchestration logic, so a
diagram of agents becomes a runnable pipeline. Select the connector and hit
**+ add logic** in the selection bar:

- **run when:** `on finish` (any completed turn) · `on success` · `on failure`
  (keyword match on the source agent's last output) · `on match` (your regex).
  For a reliable signal, tell the agent to end with a sentinel and match it,
  e.g. `on match` + `STATUS:\s*OK`.
- **prompt / pipe:** the text handed to the target agent (and submitted) when
  the edge fires. **Leave it empty to pipe the source agent's output straight
  into the target**, or embed that output inside a prompt with `{{output}}`
  (e.g. `Review this and fix any bugs:\n\n{{output}}`). Multi-line text is pasted
  intact. The piped output is the model's **actual last message**, read from the
  Claude Code session transcript (`~/.claude/projects/…/<session>.jsonl`); if
  that file isn't reachable it falls back to scraping the terminal.
- **join:** when a target has several incoming edges, `all` waits for every
  source to finish (AND, *"after these agents run, run this one"*) and `any`
  fires on the first (OR).

So a chain `A → B → C` with B set to *on success* and C to *on finish* runs B
only if A reports success, then C after B; and a join `A, B → C` set to *all*
runs C once both A and B are done. Flow edges render in the accent colour with a
filled head and a condition badge. The whole thing has a kill switch (**Pause
agent flows** in the command palette, ⌘K), and it auto-pauses if edges fire in a
runaway loop.

## Watching agents work

The canvas is great for layout but poor at *"is anything stuck?"*, so these
three features are the answer at scale:

- **Agent roster** (command palette → *Agent roster*): every agent across every
  tab in one list, with live status, cost and turn count, and its last line of
  output. Click a row to fly the camera to that agent; type in the composer to
  message one agent or broadcast to all.
- **Tracking camera** (right-click an agent → *Track this agent*): as the agent
  reads and writes files, each one opens as a viewer widget arranged in an orbit
  around it with a dashed arrow pointing back (`read` arrows are labelled). The
  camera reframes to keep the agent and its satellites in view. Stop keeps the
  files; **Stop & clear** removes the orbit. Driven entirely by the agent's
  session transcript, so it sees the real tool calls.
- **Follow the active agent** (command palette → *Follow the active agent*): a
  lightweight mode that just pans to whichever agent most recently started
  working. It stands down while the tracking camera is active.

## Safety net: checkpoints

Before turning an agent loose on your working tree, drop a **checkpoint**
(command palette → *Checkpoints*). Each one is a real git object created with
`git stash create` and pinned under `refs/ccanvas/cp/<id>` so gc never collects
it, and it snapshots tracked changes **without** touching your working tree or
the stash list. Restore is deliberately non-destructive: it resets tracked
content to the snapshot but never deletes files the agent created afterwards.
(Untracked files at checkpoint time aren't captured.) Requires the canvas folder
to be a git repo.

## Keyboard

| Key | Action |
| --- | --- |
| `V` `H` `T` `P` `A` `R` `O` `F` `E` | select · pan · text · draw · arrow · rect · ellipse · frame · eraser |
| `Space` | quick-insert text or `/command` widget at the cursor |
| ⌘/Ctrl + `K` | command palette |
| ⌘/Ctrl + `F` | search this canvas |
| `H` / middle-drag | pan |
| ⌘/Ctrl + scroll | zoom to cursor |
| ⌘/Ctrl + `S` / `O` / `N` | save · open · new canvas |
| ⌘/Ctrl + `Z` / `Shift Z` | undo · redo |
| ⌘/Ctrl + `C` / `X` / `V` / `D` | copy · cut · paste · duplicate |
| ⌘/Ctrl + `G` / `Shift G` | group · ungroup |
| ⌘/Ctrl + `L` | lock / unlock selection |
| ⌘/Ctrl + `[` / `]` | send to back / bring to front |
| ⌘/Ctrl + `A` | select all |
| ⌘/Ctrl + `0` `+` `-` | reset / zoom in / zoom out |
| `Delete` | delete selection |
| `Esc` | back to select |
| double-click | edit text · interact with widget · rename widget/tab |

## Stack

Vite · React · TypeScript · Zustand · xterm.js · Monaco · **Tauri 2** (Rust). The
same frontend runs as a native desktop app or in the browser; native
capabilities sit behind a small abstraction that picks the best available
backend.

## Architecture notes

- **`src/store/workspace.ts`**: single Zustand store; the active workspace is the
  source of truth and what serializes to `.ccnvs`.
- **`src/canvas/`**: pointer/zoom state machine, SVG vector layer, inline text.
- **`src/widgets/`**: `WidgetFrame` chrome (drag/resize/z-order) plus per-type
  bodies (terminal, transcript, editor, diff, data, plot, …).
- **`src/lib/backend.ts`**: native dialog/file IO, choosing Tauri commands → HTTP
  bridge → graceful no-op by `isTauri()`.
- **`src/lib/terminal.ts`**: terminal transport, choosing in-process Tauri PTY →
  WebSocket bridge → in-browser fallback shell.
- **`src/lib/flow.ts`**: the agent-flow engine that fires logic arrows.
- **`src/lib/transcript.ts`**: reads and parses Claude Code session JSONL (last
  turn for flow piping, touched files for the tracking camera, full conversation
  for the transcript widget).
- **`src/lib/tracker.ts`**: the tracking camera, which polls a transcript, spawns
  satellite viewers in an orbit, and keeps the camera framed.
- **`src/lib/checkpoints.ts`**: git-backed working-tree checkpoints.
- **`src-tauri/`**: the Rust app: `src/pty.rs` (a `portable-pty` shell per widget,
  streaming `pty:data`/`pty:exit` events) and `src/files.rs` (native dialogs +
  fs).
- **`server/pty-server.mjs`**: the optional web-mode backend (same protocol, over
  `ws`/`http`) for when you run in a plain browser.

---

<div align="center">
<sub>See <a href="CONTRIBUTING.md">CONTRIBUTING.md</a> to hack on it · <a href="LICENSE">LICENSE</a></sub>
</div>
