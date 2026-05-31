// Filesystem watching for ccanvas live widgets (diff / doc / log). Each
// `watch_start` registers a notify watcher keyed by id; any change emits an
// `fs:change` event carrying that id so the frontend can reload just that
// widget. Dropping the watcher (watch_stop) ends watching.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatchManager {
    watchers: Mutex<HashMap<u32, RecommendedWatcher>>,
    next_id: AtomicU32,
}

#[derive(Clone, Serialize)]
struct FsChange {
    id: u32,
}

#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    state: State<'_, WatchManager>,
    path: String,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let app2 = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = app2.emit("fs:change", FsChange { id });
        }
    })
    .map_err(|e| e.to_string())?;

    let p = Path::new(&path);
    let mode = if p.is_dir() {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher.watch(p, mode).map_err(|e| e.to_string())?;
    state.watchers.lock().unwrap().insert(id, watcher);
    Ok(id)
}

#[tauri::command]
pub fn watch_stop(state: State<'_, WatchManager>, id: u32) {
    state.watchers.lock().unwrap().remove(&id);
}
