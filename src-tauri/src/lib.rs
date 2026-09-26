// ccanvas desktop backend (pty + native dialogs/fs)
mod editor;
mod files;
mod media;
mod plan_usage;
mod pty;
mod term_profile;
mod usage;
mod watch;

use pty::PtyManager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use watch::WatchManager;

/// The signed-in user's first name for the welcome greeting: the account's full
/// name on macOS (`id -F`), else the login name. None if neither is available.
#[tauri::command]
fn user_first_name() -> Option<String> {
    let full = std::process::Command::new("id")
        .arg("-F")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USER").ok())?;
    let first = full.split_whitespace().next()?.to_string();
    let mut chars = first.chars();
    let cap = chars.next()?.to_uppercase().collect::<String>() + chars.as_str();
    Some(cap)
}

/// Frontend asks to quit once ⌘W finds no widget left to close.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// The stock menu binds ⌘W to "Close Window", which closes the whole app. Swap
/// it for an item that lets the canvas close the widget you're in instead.
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let close = MenuItemBuilder::with_id("close-widget", "Close")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let name = app.package_info().name.clone();
        let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        menu = menu.item(
            &SubmenuBuilder::new(app, name)
                .about(None)
                .separator()
                .item(&settings)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?,
        );
    }
    let menu = menu
        .item(
            &SubmenuBuilder::new(app, "File")
                .item(&close)
                .build()?,
        )
        .item(
            &SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?,
        )
        .item(
            &SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .fullscreen()
                .build()?,
        )
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == "close-widget" {
            let _ = app.emit("menu:close-widget", ());
        } else if event.id() == "open-settings" {
            let _ = app.emit("menu:open-settings", ());
        }
    });
    Ok(())
}

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
            // start the embedded media server (range streaming + ffmpeg
            // transcode) so the desktop app plays video with no external backend
            media::start();
            install_menu(app)?;
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
            editor::code_serve,
            editor::code_stop,
            files::open_external,
            files::reveal_path,
            files::home_dir,
            media::media_info,
            usage::claude_usage,
            plan_usage::claude_plan_usage,
            pty::pty_open,
            pty::pty_start,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_detach,
            pty::pty_kill,
            term_profile::terminal_profile,
            quit_app,
            user_first_name,
            watch::watch_start,
            watch::watch_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // don't leave `code serve-web` servers running after we quit
            if let tauri::RunEvent::Exit = event {
                editor::stop_all();
            }
        });
}
