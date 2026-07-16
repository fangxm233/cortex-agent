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

mod creds;
// frontend (custom-scheme asset resolver) + ota (self-updating SPA) now run on BOTH desktop and
// Android: the SPA is served over the `cortexui://` scheme from an on-disk frontend directory, and
// the OTA updater (reqwest[rustls]/sha2/zip — all cross-compile cleanly for Android) stages new
// bundles for the next launch. The one platform seam is the first-run seed (see `seed` below):
// desktop reads it from `resource_dir/frontend-seed`, Android from an `include_dir!`-embedded copy.
mod frontend;
mod ota;
// Android-only: the embedded SPA seed materialized onto disk on first run (desktop uses the real
// files under resource_dir/frontend-seed instead, so this module is not compiled there).
#[cfg(target_os = "android")]
mod seed;

// ─── Frontend source (OTA) ──────────────────────────────────────────────────
/// The custom URI scheme the SPA is served under. A single origin for the SPA's whole life
/// (seed and OTA-downloaded versions alike) so browser-origin state stays stable across updates.
const FRONTEND_SCHEME: &str = "cortexui";

/// Resolve the directory the frontend is currently served from, newest wins:
///   1. `CORTEX_FRONTEND_DIR` env override (dev/testing — point straight at web/dist).
///   2. The OTA-downloaded current version: `<appDataDir>/ui/current` (populated by the updater).
///   3. The bundled seed shipped with the app: `<resourceDir>/frontend-seed` (first-run / offline).
/// A candidate counts only when it contains index.html, so a half-populated dir never wins.
///
/// Both platforms serve over `cortexui://` from disk. On Android the `resource_dir/frontend-seed`
/// fallback is never actually reached because the embedded seed is materialized into `ui/current`
/// before the window opens (see `seed::ensure_seed`); it stays here only as a harmless last resort.
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

/// Persist credentials to the platform credential store and update AppState.
///
/// Called by the connect screen after the user's test-connection probe
/// succeeds. Always returns Ok — a store failure is logged to stderr but
/// the session continues (credentials are in AppState; lost on restart if the
/// store is unavailable, e.g. headless Linux without a secret-service daemon).
/// Backend is platform-branched (OS keychain on desktop, app-private file on
/// Android) — see `creds.rs`.
#[tauri::command]
fn connect(
    app: tauri::AppHandle,
    state: State<AppState>,
    server_url: String,
    token: String,
) -> Result<(), String> {
    let config = ConnectionConfig {
        server_url: Some(server_url),
        token: Some(token),
    };
    if let Err(e) = creds::save(&app, &config) {
        eprintln!(
            "[cortex-desktop] credential store save failed ({e}); \
             credentials are session-only (lost on restart)"
        );
    }
    *state.config.lock().unwrap() = config;
    Ok(())
}

/// Clear credentials from the platform store and AppState.
///
/// Called by the always-visible "Switch server" button. After this returns the
/// JS navigates to connect.html.
#[tauri::command]
fn disconnect(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    creds::clear(&app);
    *state.config.lock().unwrap() = ConnectionConfig::default();
    Ok(())
}

// ─── Initialization script ─────────────────────────────────────────────────
// Injected into EVERY page load (connect.html and index.html). A per-platform
// PREFIX (see `init_script()`) sets the shell-detection flag first:
//   desktop → window.__CORTEX_DESKTOP__ = true   (desktop three-pane workbench)
//   Android → window.__CORTEX_MOBILE__  = true   (mobile bottom-Tab shell)
// then this shared body runs:
//
// 1. Async-fetches credentials from AppState via IPC and writes to
//    window.__CORTEX_DESKTOP_CONFIG (read by providers.tsx to switch the tRPC
//    client to absolute-URL + token-bearer mode). The IPC round-trip is
//    ~microseconds; the React bundle takes tens of milliseconds to download +
//    parse, so the global is set before providers.tsx reads it. Shared by both
//    platforms — the mobile shell reaches the same remote server the same way.
// 2. After DOMContentLoaded, injects an always-visible "Switch server" button
//    (low-contrast, bottom-right) into the workbench. Suppressed on the connect
//    screen (body id) AND on mobile (the bottom-Tab shell owns its own nav, and
//    a fixed bottom-right button would overlap the Tab bar).

/// Per-platform flag prefix prepended to `INIT_SCRIPT`.
#[cfg(target_os = "android")]
const SHELL_FLAG: &str = "window.__CORTEX_MOBILE__ = true;\n";
#[cfg(not(target_os = "android"))]
const SHELL_FLAG: &str = "window.__CORTEX_DESKTOP__ = true;\n";

/// The full initialization script: platform flag + **synchronously baked** credentials + shared body.
///
/// The credentials known at window-build time (loaded from the credential store) are serialized
/// straight into the injected script as the initial `window.__CORTEX_DESKTOP_CONFIG` value, so the
/// SPA sees them synchronously — BEFORE any bundle code runs — with no dependency on the async IPC.
/// This closes a race that surfaced on Android: on the second launch the WebView serves a
/// code-cached bundle that mounts React faster than the `get_connection_config` IPC round-trip could
/// resolve, so `providers.tsx` (which reads the config exactly once at mount) captured the stale
/// `{serverUrl:null}` and built a broken tRPC client — the mobile shell rendered (bottom Tab bar)
/// but every data screen failed, leaving "only the bottom bar". Baking removes the race entirely.
///
/// The async IPC in `INIT_SCRIPT` is kept as a REFRESH path: on the first-run connect flow the
/// window was built with empty creds (baked null), then the user saves creds on connect.html and
/// navigates to index.html within the same session — the re-injected script's baked value is still
/// null there, so the async `get_connection_config` fills in the freshly-saved creds.
fn init_script(config: &ConnectionConfig) -> String {
    // Serialize via serde so serverUrl/token are correctly JSON-escaped (quotes, backslashes, etc.),
    // never string-interpolated raw. `ConnectionConfig` serializes to {"serverUrl":…,"token":…},
    // exactly the shape readDesktopConfig() expects. A serialize failure (unreachable for two
    // Option<String>) falls back to the null literal, i.e. the async-IPC-only behaviour.
    let baked = serde_json::to_string(config)
        .unwrap_or_else(|_| r#"{"serverUrl":null,"token":null}"#.to_string());
    format!("{SHELL_FLAG}window.__CORTEX_DESKTOP_CONFIG = {baked};\n{INIT_SCRIPT}")
}

const INIT_SCRIPT: &str = r#"
// Refresh path: re-read the current credentials via IPC and overwrite the baked value. Normally a
// no-op (baked value is already correct); it matters on the first-run connect flow, where the window
// was built before the user saved creds, so the baked value is null and this async call fills it in.
// The baked value already covers the common (subsequent-launch) case synchronously, so this no longer
// races the bundle — a stale read just keeps the correct baked creds.
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
  // Mobile shell owns its own navigation (bottom Tab bar) — no desktop switch button.
  if (window.__CORTEX_MOBILE__) return;
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

/// A credential counts as PRESENT only when it is Some AND non-empty after trimming.
/// `Option::is_some()` is true for `Some("")` / `Some("   ")`, so blank or whitespace-only
/// saved creds (e.g. a half-filled store entry or `CORTEX_SERVER_URL=`) would wrongly route
/// to index.html and leave the user stranded with a dead tRPC client. Requiring a non-empty
/// trimmed value makes garbage creds fall through to connect.html.
fn has_credentials(config: &ConnectionConfig) -> bool {
    let non_blank = |v: &Option<String>| v.as_deref().map(str::trim).is_some_and(|s| !s.is_empty());
    non_blank(&config.server_url) && non_blank(&config.token)
}

/// Load initial credentials: platform credential store first, then env-var fallback
/// (`CORTEX_SERVER_URL` / `CORTEX_TOKEN`, dev convenience). Loaded inside `setup` because the
/// Android store backend needs the `AppHandle` to resolve the app-private data dir.
fn load_initial_config(app: &tauri::AppHandle) -> ConnectionConfig {
    creds::load(app).unwrap_or_else(|| ConnectionConfig {
        server_url: std::env::var("CORTEX_SERVER_URL").ok(),
        token: std::env::var("CORTEX_TOKEN").ok(),
    })
}

// ─── App entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install ring as the process-wide rustls crypto provider before any OTA request builds a TLS
    // client (reqwest is compiled with `rustls-no-provider`, so it relies on this default). Idempotent
    // — a second call would Err, which we ignore. Must run before the background OTA thread starts.
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(ConnectionConfig::default()),
        })
        .invoke_handler(tauri::generate_handler![
            get_connection_config,
            set_connection_config,
            connect,
            disconnect,
        ]);

    // Both platforms: serve the SPA over the custom `cortexui://` scheme from the active frontend
    // directory (env override → OTA-downloaded current → bundled seed), so the frontend can be
    // swapped by the updater. resolve_asset applies the SPA fallback + traversal guard + MIME. On
    // Android `ui/current` is seeded from the embedded copy before the window opens (see setup).
    builder = builder.register_uri_scheme_protocol(FRONTEND_SCHEME, |ctx, request| {
        let root = active_frontend_dir(ctx.app_handle());
        let asset = frontend::resolve_asset(&root, &request.uri().to_string());
        tauri::http::Response::builder()
            .status(asset.status)
            .header(tauri::http::header::CONTENT_TYPE, asset.mime)
            .body(asset.body)
            .expect("build custom-scheme response")
    });

    builder
        .setup(move |app| {
            // Load credentials (platform store → env fallback) and seed AppState.
            let initial_config = load_initial_config(&app.handle());
            let open_workbench = has_credentials(&initial_config);
            // Keep a copy to bake synchronously into the window's initialization_script (below), so
            // the SPA sees the credentials before any bundle code runs (no async-IPC race).
            let baked_config = initial_config.clone();
            *app.state::<AppState>().config.lock().unwrap() = initial_config;

            // Open the workbench directly when credentials are available; otherwise the connect screen.
            let initial_file = if open_workbench { "index.html" } else { "connect.html" };

            // ── Pre-window: apply any staged update, then guarantee a servable frontend on disk ──
            // Promote first so this launch serves a bundle downloaded in a previous session, and the
            // running SPA is never swapped underneath itself. On Android, if `ui/current` is still
            // empty afterwards (first run / offline), materialize the embedded seed into it so the
            // cortexui:// resolver has something to serve (desktop falls back to resource_dir instead).
            if let Ok(data) = app.path().app_data_dir() {
                let store = ota::UiStore::new(&data);
                match store.promote_staged() {
                    Ok(Some(v)) => eprintln!("[cortex-desktop] applied staged frontend update: {v}"),
                    Ok(None) => {}
                    Err(e) => eprintln!("[cortex-desktop] promote staged frontend failed: {e}"),
                }
                #[cfg(target_os = "android")]
                {
                    match seed::ensure_seed(&store.current_dir()) {
                        Ok(true) => eprintln!("[cortex-desktop] extracted embedded frontend seed"),
                        Ok(false) => {}
                        Err(e) => eprintln!("[cortex-desktop] seed extract failed: {e}"),
                    }
                }
            }

            // ── Open the window against the cortexui:// scheme (both platforms) ──
            let url = format!("{FRONTEND_SCHEME}://localhost/{initial_file}");
            #[allow(unused_mut)]
            let mut win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::CustomProtocol(url.parse().expect("valid cortexui:// url")),
            )
            .initialization_script(&init_script(&baked_config));
            // Desktop-only window chrome (Android manages its own full-screen activity).
            #[cfg(not(target_os = "android"))]
            {
                win = win.title("Cortex").inner_size(1400.0, 900.0).resizable(true);
            }
            win.build()?;

            // ── Background OTA check (both platforms) ──
            // Fetch the manifest, download + verify a newer bundle, and stage it for the next launch.
            // Non-blocking and offline-safe — any failure is a logged no-op and the current version
            // keeps serving.
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
