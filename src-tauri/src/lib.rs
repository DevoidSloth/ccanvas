// ccanvas desktop backend (pty + native dialogs/fs)
mod files;
mod pty;
mod usage;
mod watch;

use pty::PtyManager;
use watch::WatchManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .manage(WatchManager::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::pick_dir,
            files::pick_file,
            files::pick_path,
            files::read_text,
            files::read_bytes,
            files::write_text,
            files::list_dir,
            files::run_command,
            files::open_external,
            files::reveal_path,
            files::home_dir,
            usage::claude_usage,
            pty::pty_open,
            pty::pty_start,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_detach,
            pty::pty_kill,
            watch::watch_start,
            watch::watch_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
