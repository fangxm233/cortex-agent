// input:  Shell credentials and native notification plugin state
// output: Device notification configuration and disconnect cleanup
// pos:    Credential-owning Android notification commands
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

use serde_json::{json, Value};
use tauri::{Manager, State};
use tauri_plugin_cortex_notifications::CortexNotifications;
use crate::AppState;

// Serialize credential snapshots with connect/disconnect and native configuration.
pub static CONNECTION_CHANGE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn mobile_notifications_configure(
    app: tauri::AppHandle, state: State<'_, AppState>, enabled: bool, locale: String,
) -> Result<Value, String> {
    let _change = CONNECTION_CHANGE.lock().unwrap();
    let config = state.config.lock().unwrap().clone();
    app.state::<CortexNotifications<tauri::Wry>>().call("configure", json!({
        "serverUrl": config.server_url.unwrap_or_default(),
        "token": config.token.unwrap_or_default(),
        "enabled": enabled,
        "locale": locale,
    }))
}

#[tauri::command]
pub async fn mobile_notifications_status(app: tauri::AppHandle) -> Result<Value, String> {
    app.state::<CortexNotifications<tauri::Wry>>().call("status", json!({}))
}

pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    app.state::<CortexNotifications<tauri::Wry>>().call("clear", json!({}))?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}
