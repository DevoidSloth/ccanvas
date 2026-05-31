// In-process pseudo-terminals for ccanvas terminal/agent widgets.
//
// Each `pty_spawn` opens a real shell via a platform PTY (ConPTY on Windows,
// openpty elsewhere). Output is streamed to the webview as `pty:data` events
// carrying raw bytes; `pty:exit` fires when the shell ends. Input, resize and
// kill are driven by commands keyed on the session id.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Output pump for one session. The reader thread starts at spawn time (so
/// ConPTY output is captured from t=0 — Windows does not buffer for a late
/// reader). Until the frontend has attached its listeners and calls
/// `pty_start`, output is buffered here; `pty_start` flushes it and flips
/// `started` so the thread emits live afterwards.
struct Pump {
    started: bool,
    buf: Vec<u8>,
}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pump: Arc<Mutex<Pump>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: u32,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: u32,
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

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
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

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    let pump = Arc::new(Mutex::new(Pump {
        started: false,
        buf: Vec::new(),
    }));

    // start reading immediately so ConPTY's initial output isn't lost; hold it
    // in `pump.buf` until pty_start flips `started`
    let pump_t = pump.clone();
    let app_t = app.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let mut p = pump_t.lock().unwrap();
                    if p.started {
                        drop(p);
                        let _ = app_t.emit(
                            "pty:data",
                            PtyData {
                                id,
                                bytes: chunk[..n].to_vec(),
                            },
                        );
                    } else {
                        p.buf.extend_from_slice(&chunk[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_t.emit("pty:exit", PtyExit { id });
    });

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            child,
            pump,
        },
    );

    Ok(id)
}

/// Flush any output buffered since spawn and switch the pump to live streaming.
/// Called once the frontend has attached its pty:data / pty:exit listeners.
#[tauri::command]
pub fn pty_start(app: AppHandle, state: State<'_, PtyManager>, id: u32) {
    let pump = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.pump.clone());
    let Some(pump) = pump else { return };

    let buffered = {
        let mut p = pump.lock().unwrap();
        p.started = true;
        std::mem::take(&mut p.buf)
    };
    if !buffered.is_empty() {
        let _ = app.emit(
            "pty:data",
            PtyData {
                id,
                bytes: buffered,
            },
        );
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: u32, data: String) -> Result<(), String> {
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
    id: u32,
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

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: u32) {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}
