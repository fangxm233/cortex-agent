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
    /// First local provider setup has not yet been explicitly finished or skipped.
    #[serde(rename = "providerSetupPending", default)]
    pub provider_setup_pending: bool,
}

/// The part of the connection the page may see: enough to reach the server. `mode` and `cortexBin`
/// describe the local install and stay in the shell.
#[derive(Debug, Clone, Serialize)]
pub struct PageConfig {
    #[serde(rename = "serverUrl")]
    pub server_url: Option<String>,
    pub token: Option<String>,
    #[serde(rename = "providerSetupPending")]
    pub provider_setup_pending: bool,
}

impl From<&ConnectionConfig> for PageConfig {
    fn from(config: &ConnectionConfig) -> Self {
        PageConfig {
            server_url: config.server_url.clone(),
            token: config.token.clone(),
            provider_setup_pending: config.mode == ConnectionMode::Local
                && config.provider_setup_pending,
        }
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
    /// Only fresh local setup may request onboarding; omitted by older frontends.
    #[serde(default)]
    pub provider_setup_pending: bool,
}

/// Persist credentials to the platform credential store and update AppState.
///
/// Called by the connect screen after the user's test-connection probe
/// succeeds. Pending local onboarding must persist before publishing the connection.
/// Legacy/nonpending and remote connections keep session-only fallback if the store
/// is unavailable (e.g. headless Linux without a secret-service daemon).
/// Backend is platform-branched (OS keychain on desktop, app-private file on
/// Android) — see `creds.rs`.
#[tauri::command]
pub async fn connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    token: String,
    local: Option<LocalInstall>,
) -> Result<PageConfig, String> {
    let _change = mobile_notifications::CONNECTION_CHANGE.lock().unwrap();
    mobile_notifications::clear(&app)?;
    connect_with_saver(&mut state.config.lock().unwrap(), server_url, token, local,
        |config| creds::save(&app, config))
}

/// Keep connection transitions testable without accessing a platform credential store.
fn connect_with_saver(
    current: &mut ConnectionConfig,
    server_url: String,
    token: String,
    local: Option<LocalInstall>,
    save: impl FnOnce(&ConnectionConfig) -> Result<(), String>,
) -> Result<PageConfig, String> {
    let pending = local.as_ref().is_some_and(|install| local_pending(current, &token, install));
    let config = ConnectionConfig {
        server_url: Some(server_url),
        token: Some(token),
        mode: if local.is_some() { ConnectionMode::Local } else { ConnectionMode::Remote },
        cortex_bin: local.map(|l| l.cortex_bin),
        provider_setup_pending: pending,
    };
    persist_connection(&config, save)?;
    *current = config;
    Ok(PageConfig::from(&*current))
}

/// CLI + token identify the local installation; its port may be explicitly repaired.
/// A stale fresh-setup payload cannot rearm intent after an explicit skip/completion.
fn local_pending(current: &ConnectionConfig, token: &str, local: &LocalInstall) -> bool {
    let same_install = current.mode == ConnectionMode::Local
        && current.cortex_bin.as_deref() == Some(local.cortex_bin.as_str())
        && current.token.as_deref() == Some(token);
    if same_install { current.provider_setup_pending } else { local.provider_setup_pending }
}

fn persist_connection(
    config: &ConnectionConfig,
    save: impl FnOnce(&ConnectionConfig) -> Result<(), String>,
) -> Result<(), String> {
    if save(config).is_ok() { return Ok(()); }
    if config.provider_setup_pending { return Err("provider_setup_save_failed".into()); }
    // Never echo store errors: a backend may include the serialized credentials.
    shell_log!("[cortex-desktop] credential store save failed; credentials are session-only (lost on restart)");
    Ok(())
}

/// Explicit skip and eligible Continue share this durable exit. Provider authentication itself
/// does not complete onboarding. Scope to the transport credentials captured by the calling page.
#[tauri::command]
pub fn finish_provider_setup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_url: String,
    token: String,
) -> Result<(), String> {
    let _change = mobile_notifications::CONNECTION_CHANGE.lock().unwrap();
    finish_with_saver(&mut state.config.lock().unwrap(), &server_url, &token,
        |config| creds::save(&app, config))
}

fn finish_with_saver(
    current: &mut ConnectionConfig,
    server_url: &str,
    token: &str,
    save: impl FnOnce(&ConnectionConfig) -> Result<(), String>,
) -> Result<(), String> {
    if current.server_url.as_deref() != Some(server_url) || current.token.as_deref() != Some(token) {
        return Err("provider_setup_connection_changed".into());
    }
    if current.mode != ConnectionMode::Local || !current.provider_setup_pending { return Ok(()); }
    let mut completed = current.clone();
    completed.provider_setup_pending = false;
    save(&completed).map_err(|_| "provider_setup_save_failed".to_string())?;
    *current = completed;
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

    const LOCAL_URL: &str = "http://127.0.0.1:3004";
    const TEST_TOKEN: &str = "test-transport-token";
    const CLI: &str = "/opt/cortex/bin/cortex";

    fn local_install(pending: bool) -> Option<LocalInstall> {
        Some(LocalInstall { cortex_bin: CLI.into(), provider_setup_pending: pending })
    }

    fn local_config(pending: bool) -> ConnectionConfig {
        ConnectionConfig {
            server_url: Some(LOCAL_URL.into()),
            token: Some(TEST_TOKEN.into()),
            mode: ConnectionMode::Local,
            cortex_bin: Some(CLI.into()),
            provider_setup_pending: pending,
        }
    }

    fn snapshot(config: &ConnectionConfig) -> serde_json::Value {
        serde_json::to_value(config).unwrap()
    }

    #[test]
    fn local_install_accepts_legacy_and_fresh_payloads() {
        let legacy: LocalInstall = serde_json::from_value(serde_json::json!({
            "cortexBin": CLI
        })).unwrap();
        assert!(!legacy.provider_setup_pending);
        let fresh: LocalInstall = serde_json::from_value(serde_json::json!({
            "cortexBin": CLI, "providerSetupPending": true
        })).unwrap();
        assert!(fresh.provider_setup_pending);
    }

    #[test]
    fn fresh_local_connect_saves_pending_atomically_with_transport_and_cli() {
        let mut current = ConnectionConfig::default();
        let mut saved = Vec::new();
        let page = connect_with_saver(&mut current, LOCAL_URL.into(), TEST_TOKEN.into(),
            local_install(true), |candidate| { saved.push(snapshot(candidate)); Ok(()) }).unwrap();
        assert_eq!(saved, vec![snapshot(&local_config(true))]);
        assert_eq!(snapshot(&current), saved[0]);
        assert!(page.provider_setup_pending);
        assert_eq!(page.server_url.as_deref(), Some(LOCAL_URL));
        assert_eq!(page.token.as_deref(), Some(TEST_TOKEN));
    }

    #[test]
    fn fresh_pending_save_failure_keeps_previous_connection_and_redacts_error() {
        let mut current = ConnectionConfig::default();
        let before = snapshot(&current);
        let error = connect_with_saver(&mut current, LOCAL_URL.into(), TEST_TOKEN.into(),
            local_install(true), |_| Err(format!("store error: {TEST_TOKEN}"))).unwrap_err();
        assert_eq!(error, "provider_setup_save_failed");
        assert!(!error.contains(TEST_TOKEN));
        assert_eq!(snapshot(&current), before);
    }

    #[test]
    fn ordinary_reconnect_and_stale_fresh_payload_preserve_true_and_false_even_on_port_repair() {
        for (pending, incoming) in [(false, false), (false, true), (true, false), (true, true)] {
            for url in [LOCAL_URL, "http://127.0.0.1:3010"] {
                let mut current = local_config(pending);
                let page = connect_with_saver(&mut current, url.into(), TEST_TOKEN.into(),
                    local_install(incoming), |candidate| {
                        assert_eq!(candidate.provider_setup_pending, pending);
                        Ok(())
                    }).unwrap();
                assert_eq!(page.provider_setup_pending, pending);
                assert_eq!(current.server_url.as_deref(), Some(url));
            }
        }
    }

    #[test]
    fn pending_reconnect_save_failure_cannot_update_endpoint_or_clear_pending() {
        let mut current = local_config(true);
        let before = snapshot(&current);
        let error = connect_with_saver(&mut current, "http://127.0.0.1:3010".into(),
            TEST_TOKEN.into(), local_install(false), |_| Err(TEST_TOKEN.into())).unwrap_err();
        assert_eq!(error, "provider_setup_save_failed");
        assert_eq!(snapshot(&current), before);
    }

    #[test]
    fn only_matching_local_cli_and_token_preserve_existing_intent() {
        for changed in ["mode", "cli", "token"] {
            for incoming in [false, true] {
                let mut current = local_config(!incoming);
                match changed {
                    "mode" => current.mode = ConnectionMode::Remote,
                    "cli" => current.cortex_bin = Some("/other/cortex".into()),
                    _ => current.token = Some("other-test-token".into()),
                }
                let page = connect_with_saver(&mut current, LOCAL_URL.into(), TEST_TOKEN.into(),
                    local_install(incoming), |_| Ok(())).unwrap();
                assert_eq!(page.provider_setup_pending, incoming, "changed {changed}");
            }
        }
    }

    #[test]
    fn remote_connect_resets_pending_and_keeps_best_effort_persistence() {
        let mut current = local_config(true);
        let page = connect_with_saver(&mut current, "https://remote.example.com".into(),
            "remote-test-token".into(), None, |candidate| {
                assert_eq!(candidate.mode, ConnectionMode::Remote);
                assert!(candidate.cortex_bin.is_none());
                assert!(!candidate.provider_setup_pending);
                Err("unavailable".into())
            }).unwrap();
        assert!(!page.provider_setup_pending);
        assert_eq!(current.mode, ConnectionMode::Remote);
        assert_eq!(current.server_url, page.server_url);
        assert_eq!(current.token, page.token);
    }

    #[test]
    fn nonpending_local_connect_keeps_legacy_best_effort_persistence() {
        let mut current = ConnectionConfig::default();
        let page = connect_with_saver(&mut current, LOCAL_URL.into(), TEST_TOKEN.into(),
            local_install(false), |_| Err("unavailable".into())).unwrap();
        assert!(!page.provider_setup_pending);
        assert_eq!(snapshot(&current), snapshot(&local_config(false)));
    }

    #[test]
    fn explicit_skip_or_continue_persists_false_without_changing_transport_or_cli() {
        let mut current = local_config(true);
        let expected = snapshot(&local_config(false));
        let mut saves = 0;
        finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN, |candidate| {
            saves += 1;
            assert_eq!(snapshot(candidate), expected);
            Ok(())
        }).unwrap();
        assert_eq!(saves, 1);
        assert_eq!(snapshot(&current), expected);
        assert!(!PageConfig::from(&current).provider_setup_pending);
    }

    #[test]
    fn repeated_completion_is_idempotent_and_does_not_save_again() {
        let mut current = local_config(true);
        finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN, |_| Ok(())).unwrap();
        finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN,
            |_| panic!("completed setup must not save again")).unwrap();
        assert!(!current.provider_setup_pending);
    }

    #[test]
    fn completion_save_failure_retains_pending_and_allows_retry_without_leaking_tokens() {
        let mut current = local_config(true);
        let before = snapshot(&current);
        let error = finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN, |candidate| {
            assert!(!candidate.provider_setup_pending);
            Err(format!("backend echoed {TEST_TOKEN}"))
        }).unwrap_err();
        assert_eq!(error, "provider_setup_save_failed");
        assert!(!error.contains(TEST_TOKEN));
        assert_eq!(snapshot(&current), before);
        finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN, |_| Ok(())).unwrap();
        assert!(!current.provider_setup_pending);
    }

    #[test]
    fn stale_url_or_token_cannot_finish_a_replacement_connection() {
        for (url, token) in [("http://127.0.0.1:3010", TEST_TOKEN), (LOCAL_URL, "stale-token")] {
            let mut current = local_config(true);
            let before = snapshot(&current);
            let error = finish_with_saver(&mut current, url, token,
                |_| panic!("stale pages must never write credentials")).unwrap_err();
            assert_eq!(error, "provider_setup_connection_changed");
            assert_eq!(snapshot(&current), before);
        }
    }

    #[test]
    fn completion_is_a_noop_for_matching_remote_or_nonpending_connections() {
        let mut remote = local_config(true);
        remote.mode = ConnectionMode::Remote;
        for mut current in [remote, local_config(false)] {
            let before = snapshot(&current);
            finish_with_saver(&mut current, LOCAL_URL, TEST_TOKEN,
                |_| panic!("remote/nonpending completion must not save")).unwrap();
            assert_eq!(snapshot(&current), before);
        }
    }

    #[test]
    fn completion_scope_guard_precedes_noop_even_after_disconnect() {
        for mut current in [ConnectionConfig::default(), local_config(false)] {
            let before = snapshot(&current);
            let error = finish_with_saver(&mut current, LOCAL_URL, "stale-token",
                |_| panic!("mismatched completion must not save")).unwrap_err();
            assert_eq!(error, "provider_setup_connection_changed");
            assert_eq!(snapshot(&current), before);
        }
    }

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
            provider_setup_pending: true,
        };
        let restored: ConnectionConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert!(restored.provider_setup_pending);
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
