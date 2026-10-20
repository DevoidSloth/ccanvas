<div align="center">

<img src="docs/banner.svg" alt="ccanvas — an infinite canvas for driving Claude Code" width="100%" />

<p></p>

[![Release](https://img.shields.io/badge/release-v2.0.0-d97757?style=flat-square&labelColor=1f1e1d)](https://github.com/DevoidSloth/ccanvas/releases/tag/v2.0.0)
[![Desktop](https://img.shields.io/badge/desktop-Tauri%202-e5e0d8?style=flat-square&labelColor=1f1e1d)](https://tauri.app)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20TypeScript-e5e0d8?style=flat-square&labelColor=1f1e1d)](#stack)
[![Core](https://img.shields.io/badge/core-Rust-e5e0d8?style=flat-square&labelColor=1f1e1d)](src-tauri)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-e5e0d8?style=flat-square&labelColor=1f1e1d)](#quick-start)
[![License](https://img.shields.io/badge/license-Apache--2.0-e5e0d8?style=flat-square&labelColor=1f1e1d)](LICENSE)

*Excalidraw, but the boxes are real terminals, Claude agents, and editors.*

Spawn shells, Claude agents, editors, and VS Code onto a boundless dark
surface, then arrange them the way you'd sketch a whiteboard. Every tab is a
self-contained `.ccnvs` workspace you can save, reopen, and share.

**[Download ccanvas 2.0.0](https://github.com/DevoidSloth/ccanvas/releases/tag/v2.0.0)** for macOS, Windows, and Linux · [What's new](#whats-new-in-20)

</div>

<p align="center">
  <img src="docs/screenshot.png" alt="ccanvas 2.0: two Claude agents, an editor, a file tree, a terminal, and a note on one canvas" width="100%" />
</p>
<p align="center">
  <sub>Two Claude agents — one just finished, one mid-build — beside an editor, a file tree, a terminal, and a note.</sub>
</p>

<img src="docs/divider.svg" alt="" width="100%" height="20" />

## Why

A terminal multiplexer gives you panes; ccanvas gives you *space*. Lay out a
fleet of agents the way you'd sketch them on a whiteboard, watch each one's
status at a glance, and see how full each one's context is. When the canvas
gets crowded, the **agent roster**, **canvas search**, the **tab finder**, and
a **tracking camera** that orbits an agent's files keep you oriented.

This branch trims the toolbox down to what actually gets used driving
Claude day to day — agents, terminals, files, diffs, and editors — and
spends that space on making each of those sharper: a real VS Code, terminal
fidelity that matches your own shell, and drag‑and‑drop straight into a
running agent.

## What's new in 2.0

| | |
| --- | --- |
| ⚡ **Fast with many agents** | Scrolling, typing, switching tabs, and clicking stay responsive with lots of tabs and agents open. Each agent's session transcript is now read a little at a time as it grows, instead of in full every few seconds, and file reads, `git`, and the usage scan no longer hold up the window |
| ⌨️ **Emacs keeps its keys** | When emacs is running in the focused terminal, shortcuts like `⌃X ⌃F` go to emacs instead of ccanvas |
| 💬 **A more accurate waiting dot** | An agent shows as waiting only when Claude is actually asking you something, such as a permission prompt or a choice menu, not when a reply merely ends with a question |

**Also new since 1.0**

| | |
| --- | --- |
| 🎨 **Settings and colour palettes** | A Settings panel (the gear in the top bar, or `⌘,` on macOS) with six palettes — Claude, Ember, Moss, Slate, Plum, and Mono — and the keys that open the tab finder |
| 🔎 **Tab finder** | `⌃X ⌃F` opens a bar at the bottom of the window to jump to any tab by name, with Tab completion. Vim keys (`:`, `gt`, `gT`) or a shortcut of your own can be switched on in Settings |
| 🗂️ **Tabs you can arrange** | Drag tabs to reorder them; a crowded strip squeezes its tabs before it scrolls and keeps the active one in view |
| 🟣 **A just-finished dot** | An agent's dot turns purple for two minutes after it finishes a turn, in its title bar, the roster, and its zoomed-out card |
| 📂 **Path autocomplete in the editor** | The editor's file box lists matching files and folders as you type: arrows to move, Tab to complete, Enter to open |

## What this branch adds

| | |
| --- | --- |
| 🖥️ **VS Code, embedded** | `⌘⇧V` opens the real VS Code (`code serve-web`) as a widget, scoped to the canvas folder, with extensions from Open VSX — no separate window to manage. Needs the `code` CLI on PATH (VS Code → *Shell Command: Install 'code' command*); works in both the desktop app and the browser build |
| 🖼️ **Drag & drop into agents** | Drag a file — an image, a screenshot, anything — from Finder/Explorer straight onto a terminal or agent widget; it's pasted in as a path Claude Code reads as an attachment. The widget outlines while you're hovering over it. Desktop app only |
| 🎨 **Your terminal, not a generic one** | On macOS, terminal widgets pick up your default iTerm2 profile — font, cursor, ANSI palette — so a ccanvas terminal looks like the one you already live in; anything it can't read falls back to the built-in theme, as does every other platform today |
| 🧠 **Memory panel** | A side dock renders Claude's own cross-session memory for the bound folder as a force-directed graph — nodes, links, and types, read straight from `~/.claude/projects/…/memory/` each time you open it |
| 🔢 **Hold ⌘ to see terminal numbers** | Hold `⌘` for a beat and every terminal shows the digit that `⌘1`–`⌘9` jumps to; let go and they're gone again |
| 📛 **Agent titles that stay in sync** | A Claude agent widget adopts the name you `/rename` inside the session, or the title Claude generates after the first prompt, instead of sitting at "claude agent" forever |
| 🪶 **A slimmer toolbar** | Fewer buttons, same power — the vector-drawing tools and GitHub-issue widgets from upstream are gone from the chrome; the surface is just Claude, a shell, and the files between them |

<img src="docs/divider.svg" alt="" width="100%" height="20" />

## Quick start

### Download

Prebuilt installers for **2.0.0** are on the
[release page](https://github.com/DevoidSloth/ccanvas/releases/tag/v2.0.0):

| Platform | File |
| --- | --- |
| macOS (Apple silicon and Intel) | `ccanvas_2.0.0_universal.dmg` |
| Windows | `ccanvas_2.0.0_x64-setup.exe` or `ccanvas_2.0.0_x64_en-US.msi` |
| Linux | `ccanvas_2.0.0_amd64.AppImage`, `.deb`, or `ccanvas-2.0.0-1.x86_64.rpm` |

**Opening it on macOS:** the app isn't notarized (that needs a paid Apple
Developer account), so Gatekeeper will flag it as being from an unidentified
developer the first time you open it. Either right-click `ccanvas.app` →
*Open* → confirm *Open* in the dialog, or strip the quarantine flag from the
Terminal:

```bash
xattr -cr /Applications/ccanvas.app
```

You only need to do this once per download.

### Build the desktop app (Tauri)

```bash
npm install
npm run app        # dev: launches the native window
npm run app:build  # build an installer → src-tauri/target/release/bundle
npm run app:install  # macOS: build just the .app and replace /Applications/ccanvas.app
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
File drag-and-drop needs the desktop app; the VS Code widget works here too.

<img src="docs/divider.svg" alt="" width="100%" height="20" />

## What's in here

| Surface | Notes |
| --- | --- |
| **Infinite canvas** | Pan by dragging empty canvas, middle-dragging, or scrolling with two fingers; smooth zoom with ⌘/Ctrl-scroll or a pinch; dot grid; minimap (toggle it in the bottom-right controls) |
| **Quick insert** | `Space` opens a command box at the cursor: type a widget name (`agent` `term` `files` `diff` `editor` `note`), optionally followed by an agent's first prompt, a file path, or a note's text |
| **Command palette** | ⌘/Ctrl-K to spawn widgets, arrange, switch tabs, open panels, insert prompts, run git, export, or jump to a widget |
| **Widgets** | Claude agent · Terminal · File tree · Git panel · Editor (Monaco) · **VS Code** · Markdown note, plus the Transcript (right-click an agent) and data, figure, and video viewers that open from the file tree or a path clicked in a terminal |
| **Drag & drop** | Drop a file from the OS onto a terminal or agent to paste its path in — the way you'd hand Claude a screenshot |
| **Agent orchestration** | Per-agent status dot (idle, working, waiting, just finished), an *N waiting* inbox, idle notifications, broadcast to many, per-agent model/prompt/flags, and colour labels you can filter the canvas by |
| **Context meter** | Each agent's bar shows how full its context window is (read from its session transcript), with a one-click **compact** past 70% |
| **Plan usage** | The top-bar pill shows Claude's own session and weekly limit % with reset times, using your Claude Code sign-in (desktop app); falls back to a local token estimate |
| **Memory panel** | Claude's cross-session memory for the bound folder, rendered as a graph you can pan, zoom, and click into |
| **Agent roster** | Mission-control list of every agent across all tabs: status, cost/turns, latest reply, click-to-focus, and a composer to message one or broadcast to all |
| **Tracking camera** | Follow an agent and watch every file it touches spawn as a viewer in an **orbit** around it, arrows pointing back; the camera stays framed on the action |
| **Transcript widget** | An agent's *real* conversation rendered from its session JSONL: clean text + tool chips, free of terminal box-drawing chrome, following the session live |
| **Checkpoints** | Git-backed working-tree snapshots: save a point before letting an agent loose, restore tracked files if it makes a mess |
| **Prompt library** | Reusable prompt snippets you can insert into the focused agent, drag onto any agent, or manage; persisted like layout templates |
| **Canvas search** | ⌘/Ctrl-F to search every element's text (titles, notes, paths, URLs, prompts, frame names) and jump to it |
| **Follow active agent** | A headless camera mode that pans to whichever agent most recently started working |
| **Settings** | Six colour palettes and the keys that open the tab finder (Emacs on by default; Vim and your own shortcuts are opt-in) |
| **Arrange** | Group, lock, align, distribute, tidy, copy/paste/duplicate, z-order, snapping guides; arrange terminals by label colour or by folder |
| **Right-click menus** | Canvas elements (duplicate, copy, lock, group, z-order, delete), agents (track, open transcript, label), file-tree rows (open in the editor or a viewer, open with the default app, **reveal in Explorer/Finder**, copy path), tabs (pin, rename, close), empty canvas (paste, select all, reveal folder) |
| **Tabs** | Multiple `.ccnvs` workspaces open at once, each bound to its own folder; drag to reorder, pin the ones you keep, jump with the tab finder |
| **Persistence** | Save/Open into the canvas folder (backend) or File System Access API; reusable widget-layout templates; PNG/SVG export |

<img src="docs/divider.svg" alt="" width="100%" height="20" />

## Watching agents work

The canvas is great for layout but poor at *"is anything stuck?"*, so these
three features are the answer at scale:

- **Agent roster** (the **Agents** button in the top bar, or command palette →
  *Agent roster*): every agent across every tab in one list, with live status,
  cost and turn count, and its latest reply. Click a row to fly the camera to
  that agent; type in the composer to message one agent or broadcast to all.
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

<img src="docs/divider.svg" alt="" width="100%" height="20" />

## Keyboard

On macOS the canvas shortcuts use ⌘ only, so Ctrl combinations reach your
terminal untouched; on Windows and Linux they use Ctrl.

| Key | Action |
| --- | --- |
| drag empty canvas / middle-drag / two-finger scroll | pan |
| `Shift`-drag | box-select |
| ⌘/Ctrl + scroll, or pinch | zoom to cursor |
| `Space` | command box at the cursor (`agent`, `term`, `files`, `diff`, `editor`, `note`) |
| ⌘/Ctrl + `K` | open / close the command palette |
| ⌘/Ctrl + `F` | search this canvas |
| `⌃X ⌃F` | tab finder (Vim `:` / `gt` / `gT` can be switched on in Settings) |
| ⌘ + `,` | Settings (macOS desktop app) |
| ⌘/Ctrl + `S` / `O` / `N` | save · open · new canvas |
| ⌘/Ctrl + `T` / `Shift T` | new terminal · new Claude agent |
| ⌘/Ctrl + `Shift V` | new VS Code widget for this canvas's folder |
| hold ⌘ | show the jump-number on every terminal |
| ⌘/Ctrl + `1`–`9` | jump to and focus the Nth terminal or agent |
| ⌘/Ctrl + `Shift ]` / `[` | next · previous terminal |
| ⌘/Ctrl + `Esc` | leave the focused terminal |
| ⌘/Ctrl + `W` | close the focused widget (desktop app; quits when no tab has a widget left) |
| ⌘/Ctrl + `Z` / `Shift Z` | undo · redo |
| ⌘/Ctrl + `C` / `X` / `V` / `D` | copy · cut · paste · duplicate |
| ⌘/Ctrl + `G` / `Shift G` | group · ungroup |
| ⌘/Ctrl + `L` | lock / unlock selection |
| ⌘/Ctrl + `[` / `]` | send to back / bring to front |
| ⌘/Ctrl + `A` | select all |
| ⌘/Ctrl + `0` `+` `-` | 100% / zoom in / zoom out |
| `\` | zoom to the selection, or fit everything |
| `Delete` / `Backspace` | delete selection |
| `Esc` | clear the selection |
| click | use a terminal, agent, editor, or other live widget |
| double-click | rename a widget or tab · edit text |

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
  bodies (terminal, transcript, editor, `VsCodeBody`, diff, data, plot, …).
- **`src/lib/backend.ts`**: native dialog/file IO, choosing Tauri commands → HTTP
  bridge → graceful no-op by `isTauri()`.
- **`src/lib/terminal.ts`**: terminal transport, choosing in-process Tauri PTY →
  WebSocket bridge → in-browser fallback shell.
- **`src/lib/termProfile.ts`**: reads the user's own terminal look (font, cursor,
  palette) from the machine and feeds it to xterm as the widget's theme.
- **`src/lib/fileDrop.ts`**: listens for the OS drag-drop the webview otherwise
  swallows, finds the terminal/agent under the cursor, and pastes the dropped
  paths in as a bracketed paste.
- **`src/lib/transcript.ts`**: reads and parses Claude Code session JSONL (last
  turn for flow piping, touched files for the tracking camera, full conversation
  for the transcript widget), and runs one shared poller per agent that feeds
  its context meter, title sync, and roster entry.
- **`src/lib/tracker.ts`**: the tracking camera, which polls a transcript, spawns
  satellite viewers in an orbit, and keeps the camera framed.
- **`src/lib/checkpoints.ts`**: git-backed working-tree checkpoints.
- **`src/lib/settings.ts`** and **`src/ui/Minibuffer.tsx`**: colour palettes,
  tab-finder keys, and the tab finder itself.
- **`src-tauri/`**: the Rust app: `src/pty.rs` (a `portable-pty` shell per widget,
  streaming `pty:data`/`pty:exit` events), `src/transcript.rs` (per-agent
  transcript summaries that parse only what was appended since the last poll),
  `src/usage.rs` and `src/plan_usage.rs` (the usage pill), `src/editor.rs` (the
  VS Code `serve-web` process + local proxy), `src/term_profile.rs` (reads the
  host terminal's theme), and `src/files.rs` (native dialogs + fs; reads, `git`,
  and directory listings run off the main thread).
- **`server/pty-server.mjs`**: the optional web-mode backend (same protocol, over
  `ws`/`http`) for when you run in a plain browser.

<img src="docs/divider.svg" alt="" width="100%" height="20" />

<div align="center">
<sub>ccanvas 2.0.0 · See <a href="CONTRIBUTING.md">CONTRIBUTING.md</a> to hack on it · <a href="LICENSE">LICENSE</a></sub>
</div>
