//! Stopping the server this app installed, from the workbench. The app quits with it: the next
//! launch starts the server again (`ensure_local_daemon`).
use tauri::{AppHandle, State};

use crate::connection::ConnectionMode;
use crate::AppState;

/// Answers only when this connection is a local install, so the SPA knows to offer the stop.
#[tauri::command]
pub fn local_server_status(state: State<'_, AppState>) -> Result<(), String> {
    local_bin(&state).map(drop)
}

/// Stop the local daemon and its local client, then quit. Only a failure comes back to the page.
#[tauri::command]
pub async fn local_server_stop(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let bin = local_bin(&state)?;
    tauri::async_runtime::spawn_blocking(move || stop(&bin))
        .await
        .map_err(|e| format!("SERVER_STOP_FAILED: {e}"))??;
    // Latch the update gate so no update check or install starts while the app quits.
    if let Ok(mut operation) = crate::update_checks::OPERATIONS.begin() {
        *operation = true;
    }
    app.exit(0);
    Ok(())
}

fn local_bin(state: &AppState) -> Result<String, String> {
    let config = state.config.lock().unwrap();
    match (
        config.mode == ConnectionMode::Local,
        config.cortex_bin.as_deref(),
    ) {
        (true, Some(bin)) => Ok(bin.to_string()),
        _ => Err("SERVER_CONTROL_UNAVAILABLE".into()),
    }
}

fn stop(bin: &str) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    super::service::stop_user_service();
    let outcome = super::process::run_quiet(bin, &["daemon", "stop"])?;
    if outcome.ok() {
        Ok(())
    } else {
        Err(format!("SERVER_STOP_FAILED: {}", outcome.combined().trim()))
    }
}
