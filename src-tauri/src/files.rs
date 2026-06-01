// Native file/folder access for ccanvas. The browser sandbox can't give the
// canvas a real on-disk path; these commands do, via native dialogs + std::fs.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct PickedFile {
    path: String,
    content: String,
}

/// Native "choose folder" dialog → absolute path (None if cancelled).
#[tauri::command]
pub fn pick_dir(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose a folder for this canvas")
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// Native "open .ccnvs" dialog → absolute path + contents (None if cancelled).
#[tauri::command]
pub fn pick_file(app: AppHandle) -> Result<Option<PickedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open a .ccnvs file")
        .add_filter("ccanvas workspace", &["ccnvs"])
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok());

    match picked {
        Some(path) => {
            let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(Some(PickedFile {
                path: path.to_string_lossy().to_string(),
                content,
            }))
        }
        None => Ok(None),
    }
}

/// General native file-open dialog → absolute path (None if cancelled). Unlike
/// pick_file (which is .ccnvs-only and reads the file), this returns just the
/// path so the caller can read/watch it — used by the web widget to preview a
/// local HTML file with live reload.
#[tauri::command]
pub fn pick_path(
    app: AppHandle,
    name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Option<String> {
    let mut dialog = app.dialog().file().set_title("Open a file");
    if let Some(exts) = extensions.as_ref().filter(|e| !e.is_empty()) {
        let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name.as_deref().unwrap_or("Files"), &refs);
    }
    dialog
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// last-modified time in ms since the unix epoch (None if unavailable)
    mtime: Option<u64>,
}

/// List a directory's immediate children (dirs first, then files, A→Z).
/// Hidden dotfiles are kept but sorted after visible ones within each group.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|e| {
            let p = e.path();
            let meta = e.metadata().ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            DirEntry {
                name: e.file_name().to_string_lossy().to_string(),
                path: p.to_string_lossy().to_string(),
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or_else(|| p.is_dir()),
                mtime,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| {
                let ah = a.name.starts_with('.');
                let bh = b.name.starts_with('.');
                ah.cmp(&bh)
            })
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Serialize)]
pub struct CmdOut {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Run a command (program + args) in `cwd`, capturing output. Used by the git
/// diff / log widgets. Not a shell — args are passed verbatim, no expansion.
#[tauri::command]
pub fn run_command(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CmdOut, String> {
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(CmdOut {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Read a file's raw bytes, base64-encoded for transport over the IPC bridge.
/// Used by the data widget (parquet/hdf5) and plot widget (images) which need
/// binary content that `read_text` can't carry.
#[tauri::command]
pub fn read_bytes(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Open a URL (or path) in the OS default app — used by the web widget's
/// "open externally" action so any site can be viewed even if it blocks framing.
#[tauri::command]
pub fn open_external(url: String) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

/// Reveal a file/folder in the OS file manager. Directories open directly;
/// files are selected within their parent where the platform supports it
/// (Explorer /select, Finder reveal, parent folder on Linux).
#[tauri::command]
pub fn reveal_path(path: String) {
    let is_dir = std::path::Path::new(&path).is_dir();
    #[cfg(target_os = "windows")]
    {
        if is_dir {
            let _ = std::process::Command::new("explorer").arg(&path).spawn();
        } else {
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,{path}"))
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if !is_dir {
            cmd.arg("-R");
        }
        let _ = cmd.arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if is_dir {
            path.clone()
        } else {
            std::path::Path::new(&path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        let _ = std::process::Command::new("xdg-open").arg(&target).spawn();
    }
}

#[tauri::command]
pub fn home_dir(app: AppHandle) -> String {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into())
}
