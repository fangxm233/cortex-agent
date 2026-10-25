// Start at login for a server this app installed: a launchd agent on macOS, a systemd user unit
// on Linux (setup/service.rs), a Run entry that starts the app headless on Windows
// (setup/login_entry.rs). The setup wizard, the post-install page and Settings share these commands.
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::connection::ConnectionMode;
use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutostartState {
    On,
    Off,
    /// Registered by the server's own `cortex init`, not by this app: left for the user to manage.
    External,
}

/// The Windows login entry's flag: start the local daemon if needed, then exit without a window.
pub const START_SERVER_ARG: &str = "--start-server";

pub fn headless_launch() -> bool {
    std::env::args_os().any(|arg| arg == START_SERVER_ARG)
}

/// Register native-owned user autostart. Ok(false) = this platform has none.
///
/// A failure here is reported but never fatal: the install itself is complete and usable, and the
/// user can still start Cortex by opening the app.
#[tauri::command]
pub async fn setup_enable_autostart(app: AppHandle, run: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || platform::enable(&app, &run))
        .await
        .map_err(|e| format!("SETUP_TASK_FAILED: autostart: {e}"))?
}

/// The current start-at-login state. Errors when this connection is not a local install.
#[tauri::command]
pub async fn autostart_status(state: State<'_, AppState>) -> Result<AutostartState, String> {
    require_local(&state)?;
    tauri::async_runtime::spawn_blocking(platform::state)
        .await
        .map_err(|e| format!("AUTOSTART_FAILED: {e}"))
}

/// Turn start at login on or off and answer the resulting state. Turning it off only withdraws the
/// registration: the server that is running now keeps running.
#[tauri::command]
pub async fn autostart_set(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<AutostartState, String> {
    require_local(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            platform::enable(&app, "autostart")?;
        } else {
            platform::withdraw()?;
        }
        Ok(platform::state())
    })
    .await
    .map_err(|e| format!("AUTOSTART_FAILED: {e}"))?
}

fn require_local(state: &AppState) -> Result<(), String> {
    let local = state.config.lock().unwrap().mode == ConnectionMode::Local;
    if local && platform::SUPPORTED {
        Ok(())
    } else {
        Err("AUTOSTART_UNAVAILABLE".into())
    }
}

/// Remove this app's registration as part of uninstalling. Ok(true) = one was removed.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) fn remove() -> Result<bool, String> {
    platform::remove()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::super::{cortex_home, process, service};
    use super::AutostartState;
    use std::path::{Path, PathBuf};
    use tauri::AppHandle;

    pub const SUPPORTED: bool = true;

    pub fn state() -> AutostartState {
        service::user_service_state()
    }

    pub fn enable(app: &AppHandle, run: &str) -> Result<bool, String> {
        let selected =
            process::selected_runtime()?.ok_or("RUNTIME_MISSING: installation record unavailable")?;
        let server = selected.server.as_ref().ok_or("CLI_NOT_ON_PATH")?;
        let launch = service::ServiceLaunch {
            program: selected.node.clone(),
            args: vec![daemon_service_entry(&server.bin)?.into_os_string()],
            home: cortex_home().ok_or("RUNTIME_MISSING: home unavailable")?,
            path: selected.path(&process::inherited_path())?,
            npm_prefix: Some(selected.prefix.clone()),
        };
        service::enable_user_service(app, run, &launch)
    }

    pub fn withdraw() -> Result<(), String> {
        service::withdraw_user_service()
    }

    pub fn remove() -> Result<bool, String> {
        service::disable_user_service()
    }

    fn daemon_service_entry(bin: &Path) -> Result<PathBuf, String> {
        let cli = bin.canonicalize().map_err(|_| "AUTOSTART_FAILED: server entry is missing")?;
        let dir = cli.parent().ok_or("AUTOSTART_FAILED: server directory is missing")?;
        let daemon = dir.join("daemon.js");
        if !daemon.is_file() {
            return Err("AUTOSTART_FAILED: foreground daemon entry is missing".into());
        }
        Ok(daemon)
    }

    #[cfg(test)]
    mod tests {
        use super::daemon_service_entry;

        #[test]
        fn service_uses_the_foreground_entry_not_the_detaching_cli() {
            let dir = tempfile::tempdir().unwrap();
            let cli = dir.path().join("cortex-cli.js");
            let daemon = dir.path().join("daemon.js");
            std::fs::write(&cli, "fixture").unwrap();
            assert!(daemon_service_entry(&cli).is_err());
            std::fs::write(&daemon, "fixture").unwrap();
            assert_eq!(daemon_service_entry(&cli).unwrap(), daemon);
            let link = dir.path().join("cortex");
            std::os::unix::fs::symlink(&cli, &link).unwrap();
            assert_eq!(daemon_service_entry(&link).unwrap(), daemon);
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::super::login_entry;
    use super::AutostartState;
    use tauri::AppHandle;

    pub const SUPPORTED: bool = true;

    pub fn state() -> AutostartState {
        login_entry::state()
    }

    pub fn enable(_app: &AppHandle, _run: &str) -> Result<bool, String> {
        login_entry::enable().map(|()| true)
    }

    pub fn withdraw() -> Result<(), String> {
        login_entry::disable().map(drop)
    }

    pub fn remove() -> Result<bool, String> {
        login_entry::disable()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    use super::AutostartState;
    use tauri::AppHandle;

    pub const SUPPORTED: bool = false;

    pub fn state() -> AutostartState {
        AutostartState::Off
    }

    pub fn enable(_app: &AppHandle, _run: &str) -> Result<bool, String> {
        Ok(false)
    }

    pub fn withdraw() -> Result<(), String> {
        Ok(())
    }

    pub fn remove() -> Result<bool, String> {
        Ok(false)
    }
}
