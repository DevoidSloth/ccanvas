// The web views' website data is only managed on macOS for now (web_data.rs).

#[tauri::command]
pub async fn web_sign_out_all() -> Result<(), String> {
    Err("Only on macOS for now.".into())
}
