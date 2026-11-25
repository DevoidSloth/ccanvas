// The real browser behind a web widget: a native child webview laid over the
// widget's body (the frontend half, which keeps it in place and hides it under
// menus, is src/lib/nativeView.ts). One per widget that shows one: each pane
// in focus mode, and a "live" widget on the canvas while you're in it.
//
// A native view is drawn on top of the whole page as a plain rectangle, so it
// can't follow the canvas's transforms. On the canvas it is only shown while
// the camera holds still, with its page zoom matched to the camera's; while
// you pan or zoom (or work elsewhere) the widget shows a snapshot of it
// instead (`native_view_snapshot`) and the view stays alive, hidden.
//
// Safety:
//   • The view shows arbitrary sites, so it gets no Tauri IPC: capabilities
//     are scoped to the main webview's label (capabilities/default.json), and
//     Tauri refuses custom commands from remote origins anyway.
//   • It only ever shows http(s) pages, and never the app's own origin (in
//     dev that's the Vite server, which Tauri would treat as trusted).
//   • Tauri serves its own schemes (asset://, tauri://) to every webview and
//     grants CORS to the origin the webview was created with. So the view is
//     created on a placeholder no real site can be (PLACEHOLDER, never loaded)
//     and only then sent to the page: no site it shows can read those schemes
//     (the asset scope is every file on disk).
//   • New windows don't open: they come back to the canvas as a new widget.
//   • Every web widget shares one persistent profile, so logins stick, kept
//     apart from the app's own storage. Nothing but the URL ends up in the
//     canvas file.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview,
    WebviewUrl,
};

/// The profile every web widget shares (a WKWebsiteDataStore identifier on
/// macOS 14+; a data directory elsewhere).
#[cfg(target_os = "macos")]
pub(crate) const PROFILE_ID: [u8; 16] = *b"ccanvas web view";
#[cfg(not(target_os = "macos"))]
const PROFILE_DIR: &str = "web-profile";

/// A page that sends you back to the canvas: ⌘⇧↵ (Ctrl⇧↵) inside the page.
/// Keys pressed in a native view never reach the canvas, and the view has no
/// IPC, so the press is passed back as a navigation that's always refused.
const KEY_SCHEME: &str = "ccanvas-key";
const KEY_BRIDGE: &str = r#"addEventListener('keydown',function(e){
if(e.key==='Enter'&&e.shiftKey&&(e.metaKey||e.ctrlKey)){e.preventDefault();e.stopPropagation();location.href='ccanvas-key:exit-focus'}
},true);"#;

/// What the view is created with (see the safety notes above). `.invalid`
/// never resolves, so no page can have this origin.
const PLACEHOLDER: &str = "https://ccanvas-native-view.invalid/";

fn is_placeholder(url: &Url) -> bool {
    url.host_str() == Some("ccanvas-native-view.invalid")
}

/// Most views alive at once (each is a whole browser engine page); opening
/// one more closes the one used least recently.
const MAX_VIEWS: usize = 8;

/// The live views by widget id, least recently opened first.
fn live() -> &'static Mutex<Vec<(String, Webview)>> {
    static L: OnceLock<Mutex<Vec<(String, Webview)>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Vec::new()))
}

/// The last page each widget's view showed, for `native_view_close` (kept
/// even when a view is closed to make room for another).
fn last_urls() -> &'static Mutex<HashMap<String, String>> {
    static U: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct Nav {
    id: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
struct IdUrl {
    id: String,
    url: String,
}

/// Events go to the canvas only, never to the view itself.
fn to_canvas<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview("main"), event, payload);
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// What the view may show: http(s), and not the app itself.
fn allowed(url: &Url, app_url: Option<&Url>) -> bool {
    matches!(url.scheme(), "http" | "https") && !app_url.is_some_and(|a| same_origin(a, url))
}

fn app_url(app: &AppHandle) -> Option<Url> {
    app.get_webview("main").and_then(|w| w.url().ok())
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    }
}

/// Widget `id`'s live view.
fn view_of(id: &str) -> Option<Webview> {
    live()
        .lock()
        .unwrap()
        .iter()
        .find(|(k, _)| k == id)
        .map(|(_, v)| v.clone())
}

fn remember(id: &str, url: &Url) {
    if matches!(url.scheme(), "http" | "https") && !is_placeholder(url) {
        last_urls()
            .lock()
            .unwrap()
            .insert(id.to_string(), url.to_string());
    }
}

fn close_view(id: &str, view: Webview) {
    if let Ok(url) = view.url() {
        remember(id, &url);
    }
    let _ = view.close();
}

/// Open (or move and show) the native view for widget `id` at a canvas-local
/// rect, in logical px. Async so it runs off the main thread (building a
/// webview waits on it).
#[tauri::command]
pub async fn native_view_open(
    app: AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let app_url = app_url(&app);
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&target, app_url.as_ref()) {
        return Err("only http(s) pages open here".into());
    }
    let window = app.get_window("main").ok_or("no main window")?;

    // held throughout, so two opens can't race into two views
    let mut views = live().lock().unwrap();
    if let Some((_, v)) = views.iter().find(|(k, _)| *k == id) {
        let _ = v.set_bounds(rect(x, y, w, h));
        let _ = v.show();
        return Ok(());
    }
    while views.len() >= MAX_VIEWS {
        let (old_id, old) = views.remove(0);
        close_view(&old_id, old);
    }
    last_urls().lock().unwrap().remove(&id);

    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let label = format!(
        "web-view-{}",
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let (nav_app, nav_id) = (app.clone(), id.clone());
    let (win_app, win_id) = (app.clone(), id.clone());
    let (load_app, load_id) = (app.clone(), id.clone());
    let placeholder = Url::parse(PLACEHOLDER).map_err(|e| e.to_string())?;
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(placeholder))
        .on_navigation(move |u| {
            if is_placeholder(u) {
                return false;
            }
            if u.scheme() == KEY_SCHEME {
                if u.path() == "exit-focus" {
                    to_canvas(
                        &nav_app,
                        "native-view:exit-focus",
                        IdUrl {
                            id: nav_id.clone(),
                            url: String::new(),
                        },
                    );
                }
                return false;
            }
            allowed(u, app_url.as_ref())
        })
        .on_new_window(move |u, _features| {
            if matches!(u.scheme(), "http" | "https") {
                to_canvas(
                    &win_app,
                    "native-view:new-window",
                    IdUrl {
                        id: win_id.clone(),
                        url: u.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_view, payload| {
            if is_placeholder(payload.url()) {
                return;
            }
            remember(&load_id, payload.url());
            to_canvas(
                &load_app,
                "native-view:nav",
                Nav {
                    id: load_id.clone(),
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                },
            );
        })
        .initialization_script(KEY_BRIDGE)
        .devtools(cfg!(debug_assertions));
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(PROFILE_ID);
    #[cfg(not(target_os = "macos"))]
    let builder = match app.path().app_data_dir() {
        Ok(dir) => builder.data_directory(dir.join(PROFILE_DIR)),
        Err(_) => builder,
    };

    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    if let Err(e) = view.navigate(target) {
        let _ = view.close();
        return Err(e.to_string());
    }
    views.push((id, view));
    Ok(())
}

/// Move/resize the view (canvas-local logical px).
#[tauri::command]
pub async fn native_view_bounds(id: String, x: f64, y: f64, w: f64, h: f64) {
    if let Some(v) = view_of(&id) {
        let _ = v.set_bounds(rect(x, y, w, h));
    }
}

/// Hide it (something in the page is over it, or the window is hidden) or show it again.
#[tauri::command]
pub async fn native_view_visible(id: String, visible: bool) {
    if let Some(v) = view_of(&id) {
        let _ = if visible { v.show() } else { v.hide() };
    }
}

/// Load a URL typed into the widget's address bar.
#[tauri::command]
pub async fn native_view_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed(&target, app_url(&app).as_ref()) {
        return Err("only http(s) pages open here".into());
    }
    if let Some(v) = view_of(&id) {
        v.navigate(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reload every open view (after signing out of all sites, so none keeps
/// showing a signed-in page).
#[cfg(target_os = "macos")]
pub(crate) fn reload_all(_app: &AppHandle) {
    for (_, v) in live().lock().unwrap().iter() {
        let _ = v.reload();
    }
}

/// The address bar's back / forward / reload.
#[tauri::command]
pub async fn native_view_go(id: String, action: String) {
    let Some(v) = view_of(&id) else {
        return;
    };
    let _ = match action.as_str() {
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        "reload" => v.reload(),
        _ => Ok(()),
    };
}

/// Match the page's zoom to the canvas camera (1 in focus mode).
#[tauri::command]
pub async fn native_view_zoom(id: String, zoom: f64) {
    if let Some(v) = view_of(&id) {
        let _ = v.set_zoom(zoom.clamp(0.25, 3.0));
    }
}

/// A JPEG of what the view shows right now, as a data URL, for the widget to
/// stand in with while the view is hidden. None where it can't be taken.
#[tauri::command]
pub async fn native_view_snapshot(id: String) -> Option<String> {
    let view = view_of(&id)?;
    snapshot::take(&view).await
}

/// Close widget `id`'s view and return the last page it showed, so the
/// widget can keep it.
#[tauri::command]
pub async fn native_view_close(id: String) -> Option<String> {
    let taken = {
        let mut views = live().lock().unwrap();
        views
            .iter()
            .position(|(k, _)| *k == id)
            .map(|i| views.remove(i))
    };
    if let Some((id, view)) = taken {
        close_view(&id, view);
    }
    last_urls().lock().unwrap().remove(&id)
}

#[cfg(target_os = "macos")]
mod snapshot {
    use base64::Engine;
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Webview;

    /// JPEG of a native view (WKWebView's own snapshot), as a data URL.
    pub async fn take(view: &Webview) -> Option<String> {
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        view.with_webview(move |pv| {
            // runs on the main thread, where WebKit must be called
            let wk = pv.inner() as *const WKWebView;
            if wk.is_null() {
                let _ = tx.send(None);
                return;
            }
            let tx = std::sync::Mutex::new(Some(tx));
            let done = RcBlock::new(move |img: *mut NSImage, _err: *mut NSError| {
                // SAFETY: WebKit hands back a valid image or null
                let jpeg = unsafe { img.as_ref() }.and_then(encode);
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(jpeg);
                }
            });
            // SAFETY: `wk` is this webview's live WKWebView, used on the main thread
            unsafe { (*wk).takeSnapshotWithConfiguration_completionHandler(None, &done) };
        })
        .ok()?;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(3)).ok().flatten()
        })
        .await
        .ok()??;
        Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    fn encode(img: &NSImage) -> Option<Vec<u8>> {
        let tiff = img.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        // SAFETY: an empty properties dictionary is valid (default quality)
        let data = unsafe {
            rep.representationUsingType_properties(
                NSBitmapImageFileType::JPEG,
                &NSDictionary::new(),
            )
        }?;
        Some(data.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod snapshot {
    pub async fn take(_view: &tauri::Webview) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_pages_and_never_the_app() {
        let app = Url::parse("http://127.0.0.1:5173/").unwrap();
        let ok = |s: &str| allowed(&Url::parse(s).unwrap(), Some(&app));
        assert!(ok("https://example.com/login"));
        assert!(ok("http://localhost:3000/"));
        assert!(ok("http://127.0.0.1:8080/"));
        assert!(!ok("http://127.0.0.1:5173/"));
        assert!(!ok("http://127.0.0.1:5173/anything"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("file:///etc/hosts"));
        assert!(!ok("javascript:alert(1)"));
    }
}
