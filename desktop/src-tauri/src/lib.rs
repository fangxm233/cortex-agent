// Cortex Desktop — Tauri v2 shell
//
// Connection flow
// ───────────────
// First run (no stored credentials):
//   Tauri opens connect.html (the connection config screen).
//   User enters serverUrl + clientToken, tests, then clicks Connect.
//   JS calls the `connect` Tauri command → credentials saved to OS keychain
//   and AppState updated. Page navigates to index.html (the SPA workbench).
//
// Subsequent runs (credentials in keychain):
//   Rust loads credentials at startup, opens index.html directly.
//   initialization_script (injected into every page) runs an async Tauri IPC
//   call to get_connection_config() — resolves in microseconds, before the
//   React bundle finishes downloading/parsing. providers.tsx reads
//   window.__CORTEX_DESKTOP_CONFIG and passes it to createTrpcClient().
//
// Switch / disconnect:
//   An always-visible (low-contrast, bottom-right) button injected by
//   initialization_script calls the `disconnect` Tauri command (clears keychain
//   + AppState) then navigates to connect.html — a permanent escape hatch so a
//   stale/dead saved server is always recoverable.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

mod frontend;
mod ota;

// ─── Frontend source (OTA) ──────────────────────────────────────────────────
/// The custom URI scheme the SPA is served under. A single origin for the SPA's whole life
/// (seed and OTA-downloaded versions alike) so browser-origin state stays stable across updates.
const FRONTEND_SCHEME: &str = "cortexui";

/// Resolve the directory the frontend is currently served from, newest wins:
///   1. `CORTEX_FRONTEND_DIR` env override (dev/testing — point straight at web/dist).
///   2. The OTA-downloaded current version: `<appDataDir>/ui/current` (populated by the updater).
///   3. The bundled seed shipped with the app: `<resourceDir>/frontend-seed` (first-run / offline).
/// A candidate counts only when it contains index.html, so a half-populated dir never wins.
fn active_frontend_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("CORTEX_FRONTEND_DIR") {
        let p = PathBuf::from(dir);
        if p.join("index.html").is_file() {
            return p;
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        let current = data.join("ui").join("current");
        if current.join("index.html").is_file() {
            return current;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        return res.join("frontend-seed");
    }
    // Last resort: a path that won't exist → the resolver 404s cleanly instead of panicking.
    PathBuf::from("frontend-seed")
}

// ─── Keychain constants ────────────────────────────────────────────────────
const KEYCHAIN_SERVICE: &str = "dev.cortex.desktop";
const KEYCHAIN_ACCOUNT: &str = "connection";

// ─── Types ────────────────────────────────────────────────────────────────

/// Connection credentials shared between Rust AppState and the JS global
/// `window.__CORTEX_DESKTOP_CONFIG`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionConfig {
    /// Absolute URL of the remote Cortex server, e.g. "https://cortex.example.com".
    /// None = no server configured (shows the connect screen).
    #[serde(rename = "serverUrl")]
    pub server_url: Option<String>,
    /// Client authentication token (x-cortex-token value).
    pub token: Option<String>,
}

pub struct AppState {
    pub config: Mutex<ConnectionConfig>,
}

// ─── Keychain helpers ──────────────────────────────────────────────────────

/// Load credentials from the OS keychain. Returns None if the keychain is
/// unavailable or no entry exists.
fn load_from_keychain() -> Option<ConnectionConfig> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .and_then(|s| serde_json::from_str::<ConnectionConfig>(&s).ok())
        .filter(|c| c.server_url.is_some() && c.token.is_some())
}

/// Persist credentials to the OS keychain. Returns Err if the keychain is
/// unavailable; callers log this and continue (credentials kept in AppState).
fn save_to_keychain(config: &ConnectionConfig) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keychain open: {e}"))?;
    let data = serde_json::to_string(config)
        .map_err(|e| format!("serialize: {e}"))?;
    entry
        .set_password(&data)
        .map_err(|e| format!("keychain write: {e}"))
}

/// Delete credentials from the OS keychain (best-effort; errors are ignored).
fn clear_keychain() {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// Return the current connection config to the webview.
/// Called by initialization_script on every page load to seed
/// window.__CORTEX_DESKTOP_CONFIG before React mounts.
#[tauri::command]
fn get_connection_config(state: State<AppState>) -> ConnectionConfig {
    state.config.lock().unwrap().clone()
}

/// Low-level in-memory update. Prefer the `connect` command for the full
/// persist-to-keychain flow.
#[tauri::command]
fn set_connection_config(
    state: State<AppState>,
    server_url: Option<String>,
    token: Option<String>,
) {
    let mut config = state.config.lock().unwrap();
    config.server_url = server_url;
    config.token = token;
}

/// Persist credentials to the OS keychain and update AppState.
///
/// Called by the connect screen after the user's test-connection probe
/// succeeds. Always returns Ok — a keychain failure is logged to stderr but
/// the session continues (credentials are in AppState; lost on restart if no
/// keychain, e.g. headless Linux without a secret-service daemon).
#[tauri::command]
fn connect(
    state: State<AppState>,
    server_url: String,
    token: String,
) -> Result<(), String> {
    let config = ConnectionConfig {
        server_url: Some(server_url),
        token: Some(token),
    };
    if let Err(e) = save_to_keychain(&config) {
        eprintln!(
            "[cortex-desktop] keychain save failed ({e}); \
             credentials are session-only (lost on restart)"
        );
    }
    *state.config.lock().unwrap() = config;
    Ok(())
}

/// Clear credentials from keychain and AppState.
///
/// Called by the always-visible "Switch server" button. After this returns the
/// JS navigates to connect.html.
#[tauri::command]
fn disconnect(state: State<AppState>) -> Result<(), String> {
    clear_keychain();
    *state.config.lock().unwrap() = ConnectionConfig::default();
    Ok(())
}

// ─── Initialization script ─────────────────────────────────────────────────
// Injected into EVERY page load (connect.html and index.html).
//
// 1. Sets window.__CORTEX_DESKTOP__ = true (desktop detection flag).
// 2. Async-fetches credentials from AppState via IPC and writes to
//    window.__CORTEX_DESKTOP_CONFIG. The IPC round-trip is ~microseconds;
//    the React bundle takes tens of milliseconds to download + parse, so
//    the global is set before providers.tsx reads it.
// 3. After DOMContentLoaded, injects an always-visible "Switch server" button
//    (low-contrast, bottom-right) into the workbench. Suppressed on the connect
//    screen (identified by body id).

const INIT_SCRIPT: &str = r#"
window.__CORTEX_DESKTOP__ = true;
window.__CORTEX_DESKTOP_CONFIG = { serverUrl: null, token: null };

// Timing assumption: this IPC call resolves in ~microseconds (in-process Rust handler,
// no network). The React bundle takes tens of milliseconds to download and parse, so
// __CORTEX_DESKTOP_CONFIG is set before providers.tsx reads it in practice.
// This is not a hard guarantee — a sufficiently fast device / cached bundle could
// theoretically race. Accepted: the fallback is a broken tRPC client that retries.
(function () {
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;
  tauri.core.invoke('get_connection_config').then(function (cfg) {
    if (cfg && cfg.serverUrl) {
      window.__CORTEX_DESKTOP_CONFIG = { serverUrl: cfg.serverUrl, token: cfg.token };
    }
  }).catch(function () {});
}());

// Inject "Switch server" hover button into the workbench.
document.addEventListener('DOMContentLoaded', function () {
  // connect.html has id="cortex-connect-screen" on <body> — skip there.
  if (document.getElementById('cortex-connect-screen')) return;
  var tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;

  var btn = document.createElement('button');
  btn.id = '__cortex-switch-btn';
  btn.title = 'Switch or disconnect server';
  btn.textContent = 'Switch';
  // ALWAYS visible (no hover fade-to-0). A stale/dead saved server leaves the SPA with a broken
  // tRPC client and no visible UI affordance; a hover-only button was effectively unreachable in
  // that state. Kept small, low-contrast, and pinned bottom-right so it stays unobtrusive while
  // remaining a permanent escape hatch back to the connect screen. It brightens on hover only.
  btn.style.cssText = [
    'position:fixed', 'bottom:12px', 'right:12px', 'z-index:9999',
    'background:rgba(70,85,212,0.12)', 'color:rgba(233,231,226,0.55)',
    'border:1px solid rgba(70,85,212,0.25)', 'border-radius:4px',
    'padding:4px 10px', 'font:11px/1.4 "IBM Plex Mono",monospace',
    'cursor:pointer', 'letter-spacing:.04em', 'opacity:0.55',
    'transition:opacity 0.2s',
  ].join(';');

  // Brighten on hover, settle back to the resting low-contrast state on leave — but never hide.
  btn.addEventListener('mouseenter', function () { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', function () { btn.style.opacity = '0.55'; });

  btn.addEventListener('click', function () {
    tauri.core.invoke('disconnect').catch(function () {}).finally(function () {
      window.location.href = 'connect.html';
    });
  });

  document.body.appendChild(btn);
});
"#;

// ─── App entry point ───────────────────────────────────────────────────────

pub fn run() {
    // Load credentials from the OS keychain synchronously before the window
    // opens. Fall back to env vars (dev convenience) if keychain is empty.
    let initial_config = load_from_keychain().unwrap_or_else(|| ConnectionConfig {
        server_url: std::env::var("CORTEX_SERVER_URL").ok(),
        token: std::env::var("CORTEX_TOKEN").ok(),
    });

    // A credential counts as PRESENT only when it is Some AND non-empty after trimming.
    // `Option::is_some()` is true for `Some("")` / `Some("   ")`, so blank or whitespace-only
    // saved creds (e.g. a half-filled keychain entry or `CORTEX_SERVER_URL=`) would wrongly
    // route to index.html and leave the user stranded with a dead tRPC client. Requiring a
    // non-empty trimmed value makes garbage creds fall through to connect.html.
    let non_blank = |v: &Option<String>| v.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
    let has_credentials =
        non_blank(&initial_config.server_url) && non_blank(&initial_config.token);

    // Open the workbench directly when credentials are available; otherwise
    // show the connection config screen.
    let initial_url: &str = if has_credentials {
        "index.html"
    } else {
        "connect.html"
    };

    // Load the SPA over the custom `cortexui://` scheme (served by the OTA-aware handler below)
    // instead of the built-in App asset protocol, so the frontend can be swapped by the updater.
    let initial_scheme_url = format!("{FRONTEND_SCHEME}://localhost/{initial_url}");

    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(initial_config),
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_config,
            set_connection_config,
            connect,
            disconnect,
        ])
        // OTA frontend transport: serve the SPA from the active frontend directory (env override →
        // OTA-downloaded current → bundled seed). resolve_asset applies the SPA fallback + traversal
        // guard + MIME. Native std::fs read — no JS fs-plugin capability needed.
        .register_uri_scheme_protocol(FRONTEND_SCHEME, |ctx, request| {
            let root = active_frontend_dir(ctx.app_handle());
            let asset = frontend::resolve_asset(&root, &request.uri().to_string());
            tauri::http::Response::builder()
                .status(asset.status)
                .header(tauri::http::header::CONTENT_TYPE, asset.mime)
                .body(asset.body)
                .expect("build custom-scheme response")
        })
        .setup(move |app| {
            // Apply any frontend update downloaded in a previous session BEFORE the window loads,
            // so this launch serves the new version and the running SPA is never swapped underneath.
            if let Ok(data) = app.path().app_data_dir() {
                match ota::UiStore::new(&data).promote_staged() {
                    Ok(Some(v)) => eprintln!("[cortex-desktop] applied staged frontend update: {v}"),
                    Ok(None) => {}
                    Err(e) => eprintln!("[cortex-desktop] promote staged frontend failed: {e}"),
                }
            }

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::CustomProtocol(
                    initial_scheme_url.parse().expect("valid cortexui:// url"),
                ),
            )
            .title("Cortex")
            .inner_size(1400.0, 900.0)
            .resizable(true)
            // Runs on every page load — seeds window.__CORTEX_DESKTOP_CONFIG
            // via async IPC and attaches the Switch-server button.
            .initialization_script(INIT_SCRIPT)
            .build()?;

            // Background OTA check: fetch the manifest, download + verify a newer bundle, and stage
            // it for the next launch. Non-blocking and offline-safe — any failure is a logged no-op,
            // and the current version keeps serving.
            if let Ok(data) = app.path().app_data_dir() {
                let cfg = app.state::<AppState>().config.lock().unwrap().clone();
                if let (Some(url), Some(token)) = (cfg.server_url, cfg.token) {
                    std::thread::spawn(move || {
                        let store = ota::UiStore::new(&data);
                        match ota::check_and_stage(&url, &token, &store) {
                            Ok(Some(v)) => eprintln!(
                                "[cortex-desktop] staged frontend update {v} (applies next launch)"
                            ),
                            Ok(None) => {}
                            Err(e) => eprintln!("[cortex-desktop] ota check skipped: {e}"),
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
