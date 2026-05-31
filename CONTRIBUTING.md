# Contributing to ccanvas

Thanks for your interest in improving ccanvas! This document explains how to get
a development environment running and how to propose changes.

## Code of Conduct

This project ships with a [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Please report unacceptable behavior to the
maintainers.

## Getting started

### Prerequisites

- **Node.js 20+** and npm (development was done on Node 24)
- **Rust toolchain** via [`rustup`](https://rustup.rs/) — required only for the
  Tauri desktop build
- On **Windows**: the WebView2 runtime (preinstalled on Windows 11)
- On **Linux**: the standard Tauri system dependencies (`libwebkit2gtk-4.1`,
  `libgtk-3`, `librsvg2`, etc. — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/))

### Install

```bash
npm install
```

### Run

```bash
npm run app     # native desktop app (Tauri) — the recommended dev loop
npm run dev     # web app only → http://127.0.0.1:5173
npm start        # web app + PTY backend (two processes) for browser terminals
npm run server   # the optional PTY/file backend on 127.0.0.1:7531
```

### Build

```bash
npm run build      # type-check + bundle the web app into dist/
npm run app:build  # produce native installers in src-tauri/target/release/bundle
```

## Project layout

| Path                     | What lives there                                                |
| ------------------------ | --------------------------------------------------------------- |
| `src/store/workspace.ts` | Single Zustand store; the active workspace serializes to `.ccnvs` |
| `src/canvas/`            | Pointer/zoom state machine, SVG vector layer, inline text       |
| `src/widgets/`           | `WidgetFrame` chrome + per-type widget bodies                   |
| `src/ui/`                | Toolbar, command palette, HUD, props, tabs, minimap             |
| `src/lib/`               | Backend abstraction, terminal transport, persistence, geometry  |
| `src-tauri/`             | The Rust desktop app (`pty.rs`, `files.rs`, `watch.rs`)         |
| `server/pty-server.mjs`  | Optional web-mode PTY + file backend                            |

See the **Architecture notes** in the [README](./README.md#architecture-notes)
for how the pieces fit together.

## Making changes

1. **Fork** the repo and create a topic branch from `main`:
   `git checkout -b feat/short-description`.
2. Keep changes focused — one logical change per pull request.
3. Match the surrounding code style. The TypeScript config is strict
   (`noUnusedLocals`, `noUnusedParameters`, `strict`); make sure
   `npm run build` passes before opening a PR.
4. If you touch Rust, run `cargo fmt` and `cargo clippy` inside `src-tauri/`.
5. Write a clear commit message describing the *why*, not just the *what*.

## Opening a pull request

- Fill in the pull request template.
- Reference any related issue (e.g. `Closes #12`).
- Describe how you tested the change (which platform, web vs desktop).
- CI must be green before a maintainer reviews.

## Reporting bugs and requesting features

Use the GitHub issue templates. For bugs, include your OS, whether you were on
the desktop or web build, and the steps to reproduce. For security issues, see
[SECURITY.md](./SECURITY.md) — please do **not** open a public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE) that covers the project.
