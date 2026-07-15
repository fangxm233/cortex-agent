// Credential store — platform-branched persistence for the connection config
// (serverUrl + token) that the SPA needs to reach the remote Cortex server.
//
// Desktop (Linux / macOS / Windows): the OS keychain via the `keyring` crate v3
//   (SecretService / Keychain / Credential Manager). Hardware/OS-protected.
//
// Android: the `keyring` crate has NO Android backend, so we persist a JSON file in
//   the app's PRIVATE data directory (`app_data_dir()`), which is sandboxed per-app
//   internal storage — not world-readable by other apps. This is comparable to how
//   many apps store session tokens. (A future hardening pass could move this to the
//   Android Keystore via a dedicated plugin; tracked as a follow-up.)
//
// All three operations take the `AppHandle` so the Android backend can resolve the
// per-app data dir; the desktop backend ignores it.

use crate::ConnectionConfig;
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
mod backend {
    use super::*;

    const KEYCHAIN_SERVICE: &str = "dev.cortex.desktop";
    const KEYCHAIN_ACCOUNT: &str = "connection";

    /// Load credentials from the OS keychain. None if unavailable or absent.
    pub fn load(_app: &AppHandle) -> Option<ConnectionConfig> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .ok()
            .and_then(|e| e.get_password().ok())
            .and_then(|s| serde_json::from_str::<ConnectionConfig>(&s).ok())
            .filter(|c| c.server_url.is_some() && c.token.is_some())
    }

    /// Persist credentials to the OS keychain. Err if the keychain is unavailable.
    pub fn save(_app: &AppHandle, config: &ConnectionConfig) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .map_err(|e| format!("keychain open: {e}"))?;
        let data = serde_json::to_string(config).map_err(|e| format!("serialize: {e}"))?;
        entry
            .set_password(&data)
            .map_err(|e| format!("keychain write: {e}"))
    }

    /// Delete credentials from the OS keychain (best-effort; errors ignored).
    pub fn clear(_app: &AppHandle) {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(target_os = "android")]
mod backend {
    use super::*;
    use std::path::PathBuf;
    use tauri::Manager;

    /// JSON credential file inside the app's private data dir.
    fn creds_path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("connection.json"))
    }

    /// Load credentials from the app-private JSON file. None if missing/unreadable.
    pub fn load(app: &AppHandle) -> Option<ConnectionConfig> {
        let path = creds_path(app)?;
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<ConnectionConfig>(&s).ok())
            .filter(|c| c.server_url.is_some() && c.token.is_some())
    }

    /// Persist credentials to the app-private JSON file (creating the dir if needed).
    pub fn save(app: &AppHandle, config: &ConnectionConfig) -> Result<(), String> {
        let path = creds_path(app).ok_or_else(|| "no app_data_dir".to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let data = serde_json::to_string(config).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&path, data).map_err(|e| format!("write: {e}"))
    }

    /// Delete the app-private credential file (best-effort; errors ignored).
    pub fn clear(app: &AppHandle) {
        if let Some(path) = creds_path(app) {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub use backend::{clear, load, save};
