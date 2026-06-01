// In-process pseudo-terminals for ccanvas terminal/agent widgets.
//
// Each session is a real shell behind a platform PTY (ConPTY on Windows,
// openpty elsewhere). Output streams to the webview as `pty:data` events
// carrying raw bytes; `pty:exit` fires when the shell ends.
//
// Sessions are keyed by the *widget id*, which is stable across a webview
// reload (the workspace is restored from the autosaved session). That's what
// lets a terminal survive ccanvas's own dev hot-reload: when the webview
// reloads, the new frontend calls `pty_open` with the same id and re-attaches
// to the still-running shell — replaying its scrollback — instead of spawning a
// fresh one. So a build or a `claude` agent running inside ccanvas keeps going
// while you edit ccanvas's source. The shell is only torn down by `pty_kill`,
// which the store calls when the widget is actually deleted.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Recent output retained per session and replayed when a webview (re)attaches.
/// Caps the memory a long-lived, chatty shell can hold; older output is dropped.
const SCROLLBACK_CAP: usize = 1024 * 1024; // 1 MiB

/// Output pump for one session. The reader thread starts at spawn time (so
/// ConPTY output is captured from t=0 — Windows does not buffer for a late
/// reader) and always appends to `scrollback`. It only emits `pty:data` while
/// `live` is set; `pty_open` clears `live` and `pty_start` sets it after
/// replaying the buffer, so a (re)attaching webview gets every byte exactly
/// once with no gap and no duplication.
struct Pump {
    live: bool,
    scrollback: Vec<u8>,
}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pump: Arc<Mutex<Pump>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        let shell = std::env::var("CCANVAS_SHELL").unwrap_or_else(|_| "powershell.exe".into());
        CommandBuilder::new(shell)
    } else {
        let shell = std::env::var("CCANVAS_SHELL")
            .or_else(|_| std::env::var("SHELL"))
            .unwrap_or_else(|_| "bash".into());
        CommandBuilder::new(shell)
    }
}

/// Drop the oldest output once scrollback exceeds the cap, advancing to the
/// next line boundary so a replay never starts mid-escape-sequence.
fn trim_scrollback(buf: &mut Vec<u8>) {
    let mut cut = buf.len() - SCROLLBACK_CAP;
    if let Some(nl) = buf[cut..].iter().position(|&b| b == b'\n') {
        cut += nl + 1;
    }
    buf.drain(..cut.min(buf.len()));
}

/// Open (or re-attach to) the terminal session for `id`.
///
/// Returns `true` when an existing live shell was re-attached — e.g. the
/// webview reloaded during dev, or the user switched tabs and came back. In
/// that case the running shell, and whatever build or agent it holds, is left
/// untouched; the caller replays scrollback via `pty_start` and must NOT
/// relaunch anything. Returns `false` when a fresh shell was spawned.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<bool, String> {
    {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(s) = sessions.get_mut(&id) {
            // re-attach only if the shell is still alive; a dead one is dropped
            // so we spawn fresh below (e.g. the user hit "retry" after it exited)
            if matches!(s.child.try_wait(), Ok(None)) {
                let _ = s.master.resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                });
                // pause emitting until pty_start replays the buffer, so output
                // arriving between now and then is replayed once, not twice
                s.pump.lock().unwrap().live = false;
                return Ok(true);
            }
            sessions.remove(&id);
        }
    }
    spawn_session(app, state, id, cols, rows, cwd)?;
    Ok(false)
}

fn spawn_session(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell();
    // inherit the full environment (PowerShell needs SystemRoot/PATH/etc.)
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // slave is no longer needed once the child owns it
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let pump = Arc::new(Mutex::new(Pump {
        live: false,
        scrollback: Vec::new(),
    }));

    // insert before starting the reader so the exit cleanup below can never race
    // ahead of the insert and leave a dead session in the map
    state.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
            pump: pump.clone(),
        },
    );

    // start reading immediately so ConPTY's initial output isn't lost; it's held
    // in `scrollback` until pty_start flips `live`
    let app_t = app.clone();
    let id_t = id.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let emit = {
                        let mut p = pump.lock().unwrap();
                        p.scrollback.extend_from_slice(&chunk[..n]);
                        if p.scrollback.len() > SCROLLBACK_CAP {
                            trim_scrollback(&mut p.scrollback);
                        }
                        p.live
                    };
                    if emit {
                        let _ = app_t.emit(
                            "pty:data",
                            PtyData {
                                id: id_t.clone(),
                                bytes: chunk[..n].to_vec(),
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        // shell exited — tell the frontend (it falls back to its local shell) and
        // drop the session so a retry/relaunch spawns fresh, not a dead reattach
        let _ = app_t.emit("pty:exit", PtyExit { id: id_t.clone() });
        if let Some(mgr) = app_t.try_state::<PtyManager>() {
            mgr.sessions.lock().unwrap().remove(&id_t);
        }
    });

    Ok(())
}

/// Replay the session's scrollback to the webview and switch the pump to live
/// streaming. Called once the frontend has attached its pty:data / pty:exit
/// listeners — for both a fresh spawn (replays the shell's startup banner) and a
/// re-attach (replays the full retained history).
#[tauri::command]
pub fn pty_start(app: AppHandle, state: State<'_, PtyManager>, id: String) {
    let pump = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.pump.clone());
    let Some(pump) = pump else { return };

    let replay = {
        let mut p = pump.lock().unwrap();
        p.live = true;
        p.scrollback.clone()
    };
    if !replay.is_empty() {
        let _ = app.emit("pty:data", PtyData { id, bytes: replay });
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Stop streaming to the webview but keep the shell running. Called when a
/// terminal widget unmounts for a reason that isn't deletion (a webview reload
/// or React remount) so the session survives to be re-attached by `pty_open`.
#[tauri::command]
pub fn pty_detach(state: State<'_, PtyManager>, id: String) {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        s.pump.lock().unwrap().live = false;
    }
}

/// Tear the shell down for good. Called when the widget is actually deleted.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}
