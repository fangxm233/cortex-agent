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

/// A local install whose daemon did not come up goes back to setup when its runtime record is
/// unusable, names no server, or the server it or the connection points at is gone. Setup
/// reinstalls the server and reconnects; an initialized home is not initialized again.
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub(super) fn needs_repair(
    selected: Result<Option<super::runtime::Selection>, String>,
    cortex_bin: &std::path::Path,
) -> bool {
    if !cortex_bin.is_file() {
        return true;
    }
    match selected {
        Ok(selected) => {
            selected.is_some_and(|s| s.server.is_none_or(|server| !server.bin.is_file()))
        }
        Err(_) => true,
    }
}

#[cfg(all(
    test,
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
mod tests {
    use super::super::runtime::{Selection, Server};
    use super::needs_repair;
    use std::path::Path;

    fn record(server: Option<&Path>) -> Result<Option<Selection>, String> {
        let mut selected = Selection::new("/node".into(), "/npm".into(), "/prefix".into());
        selected.server = server.map(|bin| Server {
            bin: bin.to_path_buf(),
            managed: true,
            node_entry: None,
        });
        Ok(Some(selected))
    }

    #[test]
    fn a_local_install_whose_server_is_gone_goes_to_repair() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("cortex-cli.js");
        std::fs::write(&cli, "fixture").unwrap();
        let gone = dir.path().join("prefix/cortex-cli.js");
        assert!(!needs_repair(record(Some(&cli)), &cli));
        // The runtime directory was removed and restored without its server.
        assert!(needs_repair(record(None), &gone));
        assert!(needs_repair(record(None), &cli));
        assert!(needs_repair(record(Some(&gone)), &cli));
        assert!(needs_repair(record(Some(&cli)), &gone));
        assert!(needs_repair(
            Err("RUNTIME_MISSING: runtime files were removed".into()),
            &cli
        ));
        // Without a runtime record, the connection's own entry decides.
        assert!(!needs_repair(Ok(None), &cli));
        assert!(needs_repair(Ok(None), &gone));
    }
}
