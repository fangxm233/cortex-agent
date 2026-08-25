// input:  forward_* command calls on a platform with no port forward
// output: the same command surface, always refusing
// pos:    Android stand-in for src/forward.rs (whose tokio/tungstenite deps are desktop-only)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub remote_port: u16,
    pub local_port: u16,
    pub url: String,
}

/// Present so `generate_handler!` and `.manage()` stay a single list on every platform.
#[derive(Default)]
pub struct ForwardState;

const UNSUPPORTED: &str = "port forwarding is not available on this platform";

#[tauri::command]
pub async fn forward_start(
    _state: State<'_, ForwardState>,
    _app_state: State<'_, crate::AppState>,
    _port: u16,
) -> Result<ForwardInfo, String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub fn forward_stop(_state: State<'_, ForwardState>, _port: u16) -> bool {
    false
}

#[tauri::command]
pub fn forward_list(_state: State<'_, ForwardState>) -> Vec<ForwardInfo> {
    Vec::new()
}
