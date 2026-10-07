use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{creds, mobile_notifications, AppState};

/// Where the server this app talks to lives.
///
/// `Remote` is the default on purpose: credential entries written before local installs existed have
/// no `mode` key, and reading them as remote is exactly right — they *are* remote servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode {
    /// A server installed and started by this app on this machine.
    Local,
    /// A server the user points us at. The original behaviour.
    #[default]
    Remote,
}

/// The saved connection: AppState and the platform credential store hold this; the page sees only
/// its `PageConfig` projection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionConfig {
    /// Absolute URL of the remote Cortex server, e.g. "https://cortex.example.com".
    /// None = no server configured (shows the connect screen).
    #[serde(rename = "serverUrl")]
    pub server_url: Option<String>,
    /// Client authentication token (x-cortex-token value).
    pub token: Option<String>,
    /// Local or remote. Local means this app is responsible for the daemon being up.
    #[serde(default)]
    pub mode: ConnectionMode,
    /// Absolute path of the `cortex` executable driving a local install — kept so later launches can
    /// start the daemon without re-resolving it through a PATH the GUI may not have.
    #[serde(rename = "cortexBin", default, skip_serializing_if = "Option::is_none")]
    pub cortex_bin: Option<String>,
}

/// The part of the connection the page may see: enough to reach the server. `mode` and `cortexBin`
/// describe the local install and stay in the shell.
#[derive(Debug, Clone, Serialize)]
pub struct PageConfig {
    #[serde(rename = "serverUrl")]
    pub server_url: Option<String>,
    pub token: Option<String>,
}

impl From<&ConnectionConfig> for PageConfig {
    fn from(config: &ConnectionConfig) -> Self {
        PageConfig { server_url: config.server_url.clone(), token: config.token.clone() }
    }
}

/// Return the current connection to the webview. Called by the initialization script on every page
/// load to refresh window.__CORTEX_DESKTOP_CONFIG.
#[tauri::command]
pub fn get_connection_config(state: State<AppState>) -> PageConfig {
    PageConfig::from(&*state.config.lock().unwrap())
}

/// The local install a `connect` call comes from, when setup installed the server on this machine.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstall {
    /// Absolute path of the `cortex` executable that owns this install.
    pub cortex_bin: String,
}

/// Persist credentials to the platform credential store and update AppState.
///
/// Called by the connect screen after the user's test-connection probe
/// succeeds. Always returns Ok — a store failure is logged to stderr but
/// the session continues (credentials are in AppState; lost on restart if the
/// store is unavailable, e.g. headless Linux without a secret-service daemon).
/// Backend is platform-branched (OS keychain on desktop, app-private file on
/// Android) — see `creds.rs`.
#[tauri::command]
pub async fn connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    token: String,
    local: Option<LocalInstall>,
) -> Result<(), String> {
    let _change = mobile_notifications::CONNECTION_CHANGE.lock().unwrap();
    mobile_notifications::clear(&app)?;
    let config = ConnectionConfig {
        server_url: Some(server_url),
        token: Some(token),
        mode: if local.is_some() { ConnectionMode::Local } else { ConnectionMode::Remote },
        cortex_bin: local.map(|l| l.cortex_bin),
    };
    if let Err(e) = creds::save(&app, &config) {
        shell_log!(
            "[cortex-desktop] credential store save failed ({e}); \
             credentials are session-only (lost on restart)"
        );
    }
    *state.config.lock().unwrap() = config;
    Ok(())
}

/// Clear credentials from the platform store and AppState.
///
/// Called by the SPA daemon interface's Disconnect action (web/src/lib/shell-connection.ts).
/// After this returns the SPA navigates to connect.html.
#[tauri::command]
pub async fn disconnect(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _change = mobile_notifications::CONNECTION_CHANGE.lock().unwrap();
    mobile_notifications::clear(&app)?;
    creds::clear(&app);
    *state.config.lock().unwrap() = ConnectionConfig::default();
    Ok(())
}

/// A credential counts as PRESENT only when it is Some AND non-empty after trimming.
/// `Option::is_some()` is true for `Some("")` / `Some("   ")`, so blank or whitespace-only
/// saved creds (e.g. a half-filled store entry or `CORTEX_SERVER_URL=`) would wrongly route
/// to index.html and leave the user stranded with a dead tRPC client. Requiring a non-empty
/// trimmed value makes garbage creds fall through to connect.html.
pub fn has_credentials(config: &ConnectionConfig) -> bool {
    let non_blank = |v: &Option<String>| v.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
    non_blank(&config.server_url) && non_blank(&config.token)
}

/// Load initial credentials: platform credential store first, then env-var fallback
/// (`CORTEX_SERVER_URL` / `CORTEX_TOKEN`, dev convenience). Loaded inside `setup` because the
/// Android store backend needs the `AppHandle` to resolve the app-private data dir.
pub fn load_initial_config(app: &tauri::AppHandle) -> ConnectionConfig {
    creds::load(app).unwrap_or_else(|| ConnectionConfig {
        server_url: std::env::var("CORTEX_SERVER_URL").ok(),
        token: std::env::var("CORTEX_TOKEN").ok(),
        ..ConnectionConfig::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_connections_serialize_provider_setup_pending_as_false() {
        for mode in ["local", "remote"] {
            let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
                "serverUrl": "http://127.0.0.1:3004", "token": "test-token", "mode": mode
            })).unwrap();
            assert_eq!(serde_json::to_value(&config).unwrap()["providerSetupPending"], false);
        }
    }

    #[test]
    fn page_config_exposes_pending_only_for_local_connections() {
        for (mode, expected) in [("local", true), ("remote", false)] {
            let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
                "serverUrl": "http://127.0.0.1:3004", "token": "test-token",
                "mode": mode, "providerSetupPending": true
            })).unwrap();
            let page = serde_json::to_value(PageConfig::from(&config)).unwrap();
            assert_eq!(page["providerSetupPending"], expected);
            assert!(page.get("mode").is_none());
            assert!(page.get("cortexBin").is_none());
        }
    }

    #[test]
    fn a_credential_entry_written_before_local_mode_existed_loads_as_remote() {
        // Existing keychain entries have no `mode` key; they must keep working, as remote.
        let config: ConnectionConfig =
            serde_json::from_str(r#"{"serverUrl":"https://cortex.example.com","token":"t"}"#)
                .expect("legacy entry must still parse");
        assert_eq!(config.mode, ConnectionMode::Remote);
        assert!(config.cortex_bin.is_none());
    }

    #[test]
    fn a_local_install_round_trips_through_the_credential_store() {
        let config = ConnectionConfig {
            server_url: Some("http://127.0.0.1:3004".into()),
            token: Some("t".into()),
            mode: ConnectionMode::Local,
            cortex_bin: Some("/usr/local/bin/cortex".into()),
        };
        let restored: ConnectionConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(restored.mode, ConnectionMode::Local);
        assert_eq!(restored.cortex_bin.as_deref(), Some("/usr/local/bin/cortex"));
    }

    #[test]
    fn a_default_config_is_remote_with_no_credentials() {
        let config = ConnectionConfig::default();
        assert_eq!(config.mode, ConnectionMode::Remote);
        assert!(!has_credentials(&config));
    }
}
