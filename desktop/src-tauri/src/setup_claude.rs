use super::process::{npm_bin, probe_output, resolve_cli_bin, run_streaming};
use crate::{AppState, ConnectionConfig, ConnectionMode};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const INSTALL_ARGS: [&str; 3] = ["install", "-g", "@anthropic-ai/claude-code"];
const INSTALL_RUN: &str = "claude-install";
static INSTALL_LOCK: Mutex<()> = Mutex::new(());
// Errors are `code` or `code: detail`; web/src/features/provider-setup words the codes in the UI
// language and shows any detail after them.

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
}

// Do not infer locality from a URL alone: a manually entered loopback URL can
// be a tunnel to another host. Require setup's local metadata as well.
fn validate_connection(config: &ConnectionConfig, os: &str) -> Result<(), String> {
    if os == "android" {
        return Err("claude_android_unsupported".into());
    }
    let metadata = config.mode == ConnectionMode::Local
        && config
            .cortex_bin
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
        && config
            .token
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
    if !metadata || !config.server_url.as_deref().is_some_and(is_loopback_url) {
        return Err("claude_local_required".into());
    }
    Ok(())
}

fn is_loopback_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn guard_local_connection(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let config = state
        .config
        .lock()
        .map_err(|_| "claude_setup_unavailable: connection state".to_string())?;
    validate_connection(&config, std::env::consts::OS)
}

fn claude_bin() -> Option<String> {
    // Anthropic's native installer uses ~/.local/bin; npm uses its global prefix.
    resolve_cli_bin("claude").or_else(|| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()?;
        let name = if cfg!(target_os = "windows") {
            "claude.exe"
        } else {
            "claude"
        };
        let path = std::path::Path::new(&home).join(".local/bin").join(name);
        path.is_file().then(|| path.to_string_lossy().into_owned())
    })
}

fn probe_claude() -> ClaudeStatus {
    let bin = claude_bin();
    ClaudeStatus {
        installed: bin.is_some(),
        version: bin
            .as_deref()
            .and_then(|bin| probe_output(bin, &["--version"])),
    }
}

fn ensure_installed(
    mut probe: impl FnMut() -> ClaudeStatus,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<ClaudeStatus, String> {
    let before = probe();
    if before.installed {
        return Ok(before);
    }
    install()?;
    let after = probe();
    if !after.installed {
        return Err("claude_not_found_after_install".into());
    }
    Ok(after)
}

fn install_claude(app: &AppHandle) -> Result<ClaudeStatus, String> {
    // Serialize explicit requests so concurrent clicks re-probe after the first install.
    let _install = INSTALL_LOCK
        .lock()
        .map_err(|_| "claude_setup_unavailable: installer lock".to_string())?;
    guard_local_connection(app)?;
    ensure_installed(probe_claude, || {
        guard_local_connection(app)?;
        let outcome = run_streaming(app, INSTALL_RUN, npm_bin(), &INSTALL_ARGS)?;
        if outcome.ok() {
            return Ok(());
        }
        let log = outcome.combined();
        if super::is_npm_permission_error(&log) {
            return Err("claude_npm_eacces".into());
        }
        Err(format!("claude_install_failed: exit {}: {log}", outcome.code))
    })
}

#[tauri::command]
pub async fn setup_claude_status(app: AppHandle) -> Result<ClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        guard_local_connection(&app)?;
        Ok(probe_claude())
    })
    .await
    .map_err(|e| format!("claude_setup_unavailable: status task: {e}"))?
}

#[tauri::command]
pub async fn setup_install_claude(app: AppHandle) -> Result<ClaudeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || install_claude(&app))
        .await
        .map_err(|e| format!("claude_setup_unavailable: install task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(url: &str) -> ConnectionConfig {
        ConnectionConfig {
            mode: ConnectionMode::Local,
            server_url: Some(url.into()),
            token: Some("fixture".into()),
            cortex_bin: Some("/local/cortex".into()),
            ..ConnectionConfig::default()
        }
    }
    fn status(installed: bool) -> ClaudeStatus {
        ClaudeStatus {
            installed,
            version: installed.then(|| "2.1.0".into()),
        }
    }

    #[test]
    fn only_setup_local_loopback_connections_are_allowed() {
        for url in [
            "http://127.0.0.1:3004",
            "http://localhost:3004",
            "http://[::1]:3004",
        ] {
            assert!(validate_connection(&local(url), "linux").is_ok());
        }
        for url in [
            "https://remote.example",
            "http://localhost.evil",
            "http://127.0.0.1@evil",
            "file:///tmp/x",
        ] {
            assert!(validate_connection(&local(url), "linux").is_err());
        }
        let mut config = local("http://127.0.0.1:3004");
        config.mode = ConnectionMode::Remote;
        assert!(validate_connection(&config, "linux").is_err());
        config.mode = ConnectionMode::Local;
        config.cortex_bin = None;
        assert!(validate_connection(&config, "linux").is_err());
        assert!(validate_connection(&local("http://localhost:3004"), "android").is_err());
        assert!(validate_connection(&ConnectionConfig::default(), "linux").is_err());
    }

    #[test]
    fn refusals_are_stable_codes_the_web_ui_localizes() {
        assert_eq!(
            validate_connection(&local("http://localhost:3004"), "android").unwrap_err(),
            "claude_android_unsupported"
        );
        assert_eq!(
            validate_connection(&local("https://remote.example"), "linux").unwrap_err(),
            "claude_local_required"
        );
    }

    #[test]
    fn existing_cli_is_idempotent_even_without_version() {
        let result = ensure_installed(
            || ClaudeStatus {
                installed: true,
                version: None,
            },
            || panic!("must not install an existing CLI"),
        )
        .unwrap();
        assert!(result.installed);
        assert_eq!(result.version, None);
    }

    #[test]
    fn install_is_fixed_and_reprobes_before_reporting_success() {
        assert_eq!(INSTALL_ARGS, ["install", "-g", "@anthropic-ai/claude-code"]);
        assert_eq!(INSTALL_RUN, "claude-install");
        let mut probes = 0;
        let result = ensure_installed(
            || {
                probes += 1;
                status(probes == 2)
            },
            || Ok(()),
        )
        .unwrap();
        assert_eq!(result, status(true));
        assert_eq!(probes, 2);
        assert!(ensure_installed(|| status(false), || Ok(()))
            .unwrap_err()
            .starts_with("claude_not_found_after_install"));
    }

    #[test]
    fn failed_install_propagates_the_install_error() {
        assert_eq!(
            ensure_installed(|| status(false), || Err("npm failed".into())).unwrap_err(),
            "npm failed"
        );
    }
}
