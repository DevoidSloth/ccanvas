// The web views' own website data (macOS; elsewhere web_data_stub.rs). The
// native views (native_view.rs) keep cookies and storage in one persistent
// store of their own, apart from the app's, so a site you sign in to stays
// signed in across widgets and relaunches. This clears it.

/// The web views have a store of their own only from macOS 14.
fn own_store_available() -> bool {
    objc2::available!(macos = 14.0)
}

/// Sign out of every site in the web views: remove all of their website
/// data (cookies, storage, caches).
#[tauri::command]
pub async fn web_sign_out_all(app: tauri::AppHandle) -> Result<(), String> {
    {
        if !own_store_available() {
            return Err("Needs macOS 14 or later.".into());
        }
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_foundation::{NSDate, NSUUID};
            use objc2_web_kit::WKWebsiteDataStore;
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            unsafe {
                let store = WKWebsiteDataStore::dataStoreForIdentifier(
                    &NSUUID::from_bytes(crate::native_view::PROFILE_ID),
                    mtm,
                );
                let done = block2::RcBlock::new(move || {
                    let _ = tx.send(());
                });
                store.removeDataOfTypes_modifiedSince_completionHandler(
                    &WKWebsiteDataStore::allWebsiteDataTypes(mtm),
                    &NSDate::distantPast(),
                    &done,
                );
            }
        })
        .map_err(|_| "Couldn't reach the browser's data store.".to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "The browser's data store didn't answer.".to_string())?;
        crate::native_view::reload_all(&app);
        Ok(())
    }
}
